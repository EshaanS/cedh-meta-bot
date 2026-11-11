-- Custom regions: radius places ("within 50 km of Seattle") and the table of city centers they can use.
-- Standard regions and the existing kinds of place are unchanged.

-- Great-circle distance in kilometres (haversine, mean Earth radius). No PostGIS or earthdistance.
-- Null when any coordinate is null: least() skips nulls, so without the guard a missing coordinate would read
-- as half the Earth's circumference. Not declared strict, so the planner can still inline it.
create function haversine_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable parallel safe as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null else
    2 * 6371.0088 * asin(least(1.0, sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2))))
  end
$$;

-- City centers for radius places that have no events of their own (Seattle has none). Natural Earth 1:10m
-- populated places, v5.1.2, public domain; loaded by scripts/load-populated-places.ts from a pinned,
-- hash-verified file in data/ (CLAUDE.md data-source exception). The app reads this table and never the file.
-- country_code, admin1_code and admin1_name come from geocoding the point against the same admin-1 boundaries
-- used for events, so they match the codes on tournaments. pop_max is Natural Earth's metro-area population.
create table populated_places (
  ne_id          bigint primary key,
  name           text not null,
  name_ascii     text,
  country_code   text,
  country_name   text,
  admin1_code    text,
  admin1_name    text,
  lat            double precision not null check (lat between -90 and 90),
  lng            double precision not null check (lng between -180 and 180),
  pop_max        bigint,
  source_version text not null,
  loaded_at      timestamptz not null default now()
);
create index populated_places_key_idx on populated_places (country_code, admin1_code, city_key(name));

-- A radius place: every event whose stored coordinates are within radius_km of the center. country_code and
-- admin1_code are the center's (for the fallback anchor); label is "within 50 km of Seattle, Washington,
-- United States". The center is stored and never moves. The bounding box is derived, for the prefilter:
-- one degree of latitude is 111.045 km, and a degree of longitude shrinks with cos(latitude).
alter table region_places
  add column center_lat double precision,
  add column center_lng double precision,
  add column radius_km  integer,
  add column min_lat double precision generated always as (center_lat - radius_km / 111.045) stored,
  add column max_lat double precision generated always as (center_lat + radius_km / 111.045) stored,
  add column min_lng double precision generated always as (center_lng - radius_km / (111.045 * greatest(cos(radians(center_lat)), 0.000001))) stored,
  add column max_lng double precision generated always as (center_lng + radius_km / (111.045 * greatest(cos(radians(center_lat)), 0.000001))) stored;

alter table region_places drop constraint region_places_check;
alter table region_places add constraint region_places_shape check (
  -- a standard region
  (member_region_id is not null and country_code is null and admin1_code is null and city_key is null and label is null
   and radius_km is null and center_lat is null and center_lng is null)
  -- a city, or a whole country by code
  or (member_region_id is null and radius_km is null and center_lat is null and center_lng is null
      and country_code is not null and label is not null and (city_key is not null or admin1_code is null))
  -- a radius around a center (the "is not null" tests matter: a check that evaluates to null passes)
  or (member_region_id is null and radius_km is not null and center_lat is not null and center_lng is not null
      and radius_km between 1 and 1000 and center_lat between -90 and 90 and center_lng between -180 and 180
      and country_code is not null and label is not null and city_key is null)
);

drop index region_places_city_idx;
create unique index region_places_city_idx
  on region_places (region_id, country_code, coalesce(admin1_code, ''), coalesce(city_key, ''))
  where member_region_id is null and radius_km is null;
-- The same center and distance twice is a duplicate (centers are compared to about 100 m).
create unique index region_places_radius_idx
  on region_places (region_id, round(center_lat::numeric, 3), round(center_lng::numeric, 3), radius_km)
  where radius_km is not null;

-- For queries that start from a center: the fallback anchor below, and looking a city's center up. Stats don't
-- need it. Observed November 2026 on Supabase: the radius test over all 20,800 tournaments takes about 9 ms
-- with no index at all.
create index tournaments_lat_lng_idx on tournaments (lat, lng) where lat is not null;

-- Tournaments in a region (see migration 015). The first two conditions are unchanged, so standard regions
-- behave exactly as before; the owned-region branch behind the one-time check is rewritten as two tests:
--   1. member regions: one lookup in region_members for all of the region's member regions at once (their
--      ids are collected once into an array);
--   2. every other place, in one pass over the region's rows: a radius matches by distance (bounding box
--      first, then haversine; the longitude box is skipped when it runs past the antimeridian), and a city or
--      country matches as before. A radius row carries its center's country, so it must never reach the
--      country test. An event with no coordinates can't match a radius.
-- Observed November 2026 on a local copy of the Supabase data (20,800 tournaments): same tournaments as the
-- three separate tests of migration 015 for every kind of place, and faster: a single city 0.64 s to 0.35 s,
-- three states and a city 3.0 s to 0.58 s (local timings; Supabase is several times quicker).
create or replace function region_tournament_ids(p_region text)
returns setof text
language sql stable as $$
  select t.tid
  from tournaments t
  where (select r.type = 'global' from regions r where r.id = p_region)
     or exists (
       select 1 from region_members m
       where m.region_id = p_region
         and m.country_code = t.geo_country_code
         and (m.admin1_code is null or m.admin1_code = t.geo_admin1_code)
         and (m.admin1_group_code is null or m.admin1_group_code = t.geo_admin1_group_code)
     )
     or ((select r.owner_guild_id is not null from regions r where r.id = p_region)
    and (
      exists (
        select 1 from region_members m
        where m.region_id = any ((select array_agg(p.member_region_id) from region_places p
                                  where p.region_id = p_region and p.member_region_id is not null)::text[])
          and m.country_code = t.geo_country_code
          and (m.admin1_code is null or m.admin1_code = t.geo_admin1_code)
          and (m.admin1_group_code is null or m.admin1_group_code = t.geo_admin1_group_code)
      )
      or exists (
        select 1 from region_places p
        where p.region_id = p_region
          and p.member_region_id is null
          and case
            when p.radius_km is not null then
              t.lat between p.min_lat and p.max_lat
              and (p.min_lng < -180 or p.max_lng > 180 or t.lng between p.min_lng and p.max_lng)
              and haversine_km(p.center_lat, p.center_lng, t.lat, t.lng) <= p.radius_km
            else
              p.country_code = t.geo_country_code
              and (p.city_key is null
                   or (p.admin1_code is not distinct from t.geo_admin1_code and p.city_key = city_key(t.city)))
          end
      )
    ))
$$;

-- The standard region a point's country and admin-1 belong to, for the fallback anchor: the admin-1 region,
-- else the country, else the continent that lists the country, else global.
create function standard_region_for(p_country text, p_admin1 text)
returns text
language sql stable as $$
  select coalesce(
    (select r.id from regions r where r.id = lower(p_admin1) and r.owner_guild_id is null),
    (select r.id from regions r where r.id = lower(p_country) and r.owner_guild_id is null),
    (select m.region_id from region_members m join regions r on r.id = m.region_id
     where r.type = 'macro' and m.country_code = p_country and m.admin1_code is null and m.admin1_group_code is null
     order by m.region_id limit 1),
    'global')
$$;

-- The fallback anchor (see migration 015), now with radius places. A radius contributes the region of its
-- center and the region of every qualifying event inside the circle, so the anchor always contains every
-- event the region can show: Seattle at 50 km stays in Washington; at 200 km it reaches Vancouver, British
-- Columbia and the anchor becomes North America. A circle that crosses a border on the map but has no events
-- across it keeps the center's state, and moves up by itself when an event appears there.
create or replace function custom_region_anchor(p_region text)
returns text
language sql stable as $$
  with recursive starts (key, start) as (
    select p.id::text,
           case when p.member_region_id is not null then p.member_region_id
                else standard_region_for(p.country_code, case when p.city_key is not null then p.admin1_code end) end
    from region_places p
    where p.region_id = p_region and p.radius_km is null
    union
    select p.id::text || ':center', standard_region_for(p.country_code, p.admin1_code)
    from region_places p
    where p.region_id = p_region and p.radius_km is not null
    union
    select p.id::text || ':' || coalesce(t.geo_admin1_code, t.geo_country_code), standard_region_for(t.geo_country_code, t.geo_admin1_code)
    from region_places p
    join tournaments t
      on t.lat between p.min_lat and p.max_lat
     and (p.min_lng < -180 or p.max_lng > 180 or t.lng between p.min_lng and p.max_lng)
     and haversine_km(p.center_lat, p.center_lng, t.lat, t.lng) <= p.radius_km
    where p.region_id = p_region and p.radius_km is not null
      and t.geo_country_code is not null
      and t.participant_count >= 16
      and t.event_class in ('cedh', 'unlabeled_competitive')
  ),
  chain (key, id, depth) as (
    select key, start, 0 from starts
    union all
    select c.key, r.parent_region_id, c.depth + 1
    from chain c
    join regions r on r.id = c.id
    where r.parent_region_id is not null and c.depth < 10
  ),
  common as (
    select c.id, sum(c.depth) as distance
    from chain c
    join regions r on r.id = c.id
    where r.owner_guild_id is null and (r.selectable or r.id = 'global')
    group by c.id
    having count(distinct c.key) = (select count(*) from starts)
  )
  select coalesce((select id from common order by distance, id limit 1), 'global')
$$;

-- Centers an admin can put a radius around: every populated place with a country, and every city with a
-- qualifying event that has coordinates (center = the average of its events' coordinates; observed November
-- 2026: the farthest event is at most 23.5 km from that point, median 0). Where both describe the same city
-- (same country, admin-1 and name) it is one row, at the populated place's point, with both counts.
-- id is 'n:<ne_id>' or 'e:<country>:<admin-1>:<city key>'.
create function region_center_options()
returns table (
  id text, name text, admin1_name text, country_name text, country_code text, admin1_code text,
  lat double precision, lng double precision, population bigint, events bigint
)
language sql stable as $$
  with ev as materialized (
    select
      t.geo_country_code as cc, coalesce(t.geo_admin1_code, '') as a1, city_key(t.city) as k,
      mode() within group (order by btrim(regexp_replace(t.city, '\s+', ' ', 'g'))) as city_name,
      max(t.geo_admin1_name) as a1n, max(t.geo_country_name) as cn,
      avg(t.lat) as lat, avg(t.lng) as lng, count(*) as events
    from tournaments t
    where t.participant_count >= 16
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and t.geo_country_code is not null
      and city_key(t.city) is not null
      and t.lat is not null and t.lng is not null
    group by 1, 2, 3
  ),
  pp as materialized (
    select p.*, city_key(p.name) as k, city_key(p.name_ascii) as ka
    from populated_places p
    where p.country_code is not null
  ),
  -- The names a populated place answers to (its name and its ASCII name), once each.
  keys as (
    select pp.ne_id, pp.country_code as cc, coalesce(pp.admin1_code, '') as a1, pp.k from pp where pp.k is not null
    union
    select pp.ne_id, pp.country_code, coalesce(pp.admin1_code, ''), pp.ka from pp where pp.ka is not null
  ),
  -- Country names as the region catalog shows them ("United States", not "United States of America").
  countries as materialized (
    select upper(r.id) as cc, r.display_name from regions r where r.type = 'country' and r.owner_guild_id is null
  ),
  matched as materialized (
    select keys.ne_id, ev.cc, ev.a1, ev.k, ev.events
    from keys
    join ev on ev.cc = keys.cc and ev.a1 = keys.a1 and ev.k = keys.k
  )
  select
    'n:' || pp.ne_id,
    pp.name,
    pp.admin1_name,
    coalesce(c.display_name, pp.country_name),
    pp.country_code,
    pp.admin1_code,
    pp.lat,
    pp.lng,
    pp.pop_max,
    coalesce(m.events, 0)::bigint
  from pp
  left join (select matched.ne_id, sum(matched.events) as events from matched group by matched.ne_id) m on m.ne_id = pp.ne_id
  left join countries c on c.cc = pp.country_code
  union all
  select
    'e:' || ev.cc || ':' || ev.a1 || ':' || ev.k,
    ev.city_name,
    ev.a1n,
    coalesce(c.display_name, ev.cn),
    ev.cc,
    nullif(ev.a1, ''),
    ev.lat,
    ev.lng,
    null::bigint,
    ev.events
  from ev
  left join countries c on c.cc = ev.cc
  where not exists (select 1 from matched where matched.cc = ev.cc and matched.a1 = ev.a1 and matched.k = ev.k)
$$;
