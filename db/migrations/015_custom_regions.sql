-- Custom regions: a server admin builds a region out of places (cities, states and groups, countries,
-- continents, seeded regions) and uses it as the server's region.
--
-- Guild-owned regions live in `regions` with owner_guild_id set, so every stat function, region_label,
-- resolve_region and guild_configs.region_id keep taking a region id unchanged. Standard regions
-- (owner_guild_id null), their ids and their results are not touched.

alter table regions add column owner_guild_id text;
alter table regions drop constraint regions_source_check;
alter table regions add constraint regions_source_check check (source in ('seed', 'auto', 'guild'));
-- An owned region is a 'custom' region that only its server can see: never selectable, no stored parent
-- (its commander-stat fallback is computed from its places, see custom_region_anchor).
alter table regions add constraint regions_owner_shape check (
  (owner_guild_id is null and source <> 'guild')
  or (owner_guild_id is not null and source = 'guild' and type = 'custom' and not selectable and parent_region_id is null)
);
-- Names are unique per server, not globally. Also serves lookups by owner.
create unique index regions_owner_name_idx on regions (owner_guild_id, lower(display_name)) where owner_guild_id is not null;

-- City names are matched on this key: trimmed, lower case, whitespace collapsed. Observed November 2026: no
-- two raw spellings of a city collapse under it (0 of 819 triples), so TopDeck's values are already clean.
create function city_key(p_city text)
returns text
language sql immutable parallel safe as $$
  select nullif(lower(btrim(regexp_replace(p_city, '\s+', ' ', 'g'))), '')
$$;

create index tournaments_city_idx on tournaments (geo_country_code, geo_admin1_code, city_key(city)) where city is not null;

-- The places of an owned region, one row per place the admin added:
--   a standard region (member_region_id): a state or province, a group, a country, a continent or a seeded
--     region. It is resolved through that region's region_members when stats run, so "Europe" stays one place;
--   or a city (country_code, admin1_code, city_key), scoped by the event's geocoded country and admin-1 so
--     Vancouver, British Columbia and Vancouver, Washington stay separate;
--   or a whole country by its code alone (country_code, no city_key), for a country that has no region row
--     because it has had no qualifying event yet. Observed November 2026: Luxembourg, so "Benelux" needs this.
-- label is how a city or country row is shown; a member region is shown with region_label.
create table region_places (
  id               bigint generated always as identity primary key,
  region_id        text not null references regions (id) on delete cascade,
  member_region_id text references regions (id) on delete cascade,
  country_code     text check (country_code ~ '^[A-Z]{2}$'),
  admin1_code      text,
  city_key         text,
  label            text,
  added_at         timestamptz not null default now(),
  check (
    (member_region_id is not null and country_code is null and admin1_code is null and city_key is null and label is null)
    or (member_region_id is null and country_code is not null and label is not null and (city_key is not null or admin1_code is null))
  )
);
create unique index region_places_member_idx on region_places (region_id, member_region_id) where member_region_id is not null;
create unique index region_places_city_idx
  on region_places (region_id, country_code, coalesce(admin1_code, ''), coalesce(city_key, '')) where member_region_id is null;
create index region_places_member_region_idx on region_places (member_region_id) where member_region_id is not null;

-- Places belong to owned regions only, and a member is a standard region other than global (no nesting of
-- custom regions, and never another server's region).
create function region_places_check()
returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from regions r where r.id = new.region_id and r.owner_guild_id is not null) then
    raise exception 'region % is not a custom region', new.region_id using errcode = '23514';
  end if;
  if new.member_region_id is not null and not exists (
    select 1 from regions r where r.id = new.member_region_id and r.owner_guild_id is null and r.type <> 'global'
  ) then
    raise exception 'region % cannot be a member', new.member_region_id using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger region_places_check before insert or update on region_places
  for each row execute function region_places_check();

-- A server can only point at a standard region or one of its own. The handlers already check this; the
-- trigger makes it a database guarantee.
create function guild_config_region_check()
returns trigger
language plpgsql as $$
begin
  if exists (
    select 1 from regions r
    where r.id = new.region_id and r.owner_guild_id is not null and r.owner_guild_id <> new.guild_id
  ) then
    raise exception 'region % belongs to another server', new.region_id using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger guild_configs_region_owner before insert or update on guild_configs
  for each row execute function guild_config_region_check();

-- Tournaments in a region. The first two conditions are the query from migration 010, unchanged: global
-- matches every tournament, and a standard region matches its region_members. The third is for owned regions
-- and sits behind a one-time check, so it is never evaluated for any other region: a tournament matches when
-- one of the region's places is its city, or is a standard region whose members contain it. Unknown ids match
-- nothing.
-- It is one query on purpose. Observed November 2026 on a local copy of the Supabase data: writing the owned
-- case as a second branch with UNION ALL kept every result identical but stopped the planner from driving
-- from the region's tournaments, and each standard-region stat took 0.2-0.4 s longer.
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
        select 1 from region_places p
        where p.region_id = p_region
          and p.member_region_id is null
          and p.country_code = t.geo_country_code
          and (p.city_key is null
               or (p.admin1_code is not distinct from t.geo_admin1_code and p.city_key = city_key(t.city)))
      )
      or exists (
        select 1
        from region_places p
        join region_members m on m.region_id = p.member_region_id
        where p.region_id = p_region
          and m.country_code = t.geo_country_code
          and (m.admin1_code is null or m.admin1_code = t.geo_admin1_code)
          and (m.admin1_group_code is null or m.admin1_group_code = t.geo_admin1_group_code)
      )
    ))
$$;

-- The smallest selectable standard region that contains every place of an owned region; 'global' when there
-- is none or the region has no places. Each place starts at its own region (a city starts at its admin-1
-- region, then its country, then the continent that lists the country) and walks up parent_region_id; the answer is the
-- deepest region on every place's path. Levels a server can't select itself (US census regions, Spanish
-- provinces) are skipped. This is where commander stats come from when the custom region is not reportable.
-- It is computed on demand, never stored.
create function custom_region_anchor(p_region text)
returns text
language sql stable as $$
  with recursive places as (
    select
      p.id,
      case
        when p.member_region_id is not null then p.member_region_id
        else coalesce(
          (select r.id from regions r where r.id = lower(p.admin1_code) and r.owner_guild_id is null and p.city_key is not null),
          (select r.id from regions r where r.id = lower(p.country_code) and r.owner_guild_id is null),
          (select m.region_id from region_members m join regions r on r.id = m.region_id
           where r.type = 'macro' and m.country_code = p.country_code and m.admin1_code is null and m.admin1_group_code is null
           order by m.region_id limit 1),
          'global')
      end as start
    from region_places p
    where p.region_id = p_region
  ),
  chain (place, id, depth) as (
    select id, start, 0 from places
    union all
    select c.place, r.parent_region_id, c.depth + 1
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
    having count(distinct c.place) = (select count(*) from places)
  )
  select coalesce((select id from common order by distance, id limit 1), 'global')
$$;

-- Cities an admin can add: every (country, admin-1, city) with a qualifying event since p_since, with its
-- event count and names for the label. city_name is the most common raw spelling.
create function region_city_options(p_since timestamptz)
returns table (
  country_code text, country_name text, admin1_code text, admin1_name text,
  city_key text, city_name text, events bigint
)
language sql stable as $$
  select
    t.geo_country_code,
    coalesce((select r.display_name from regions r where r.id = lower(t.geo_country_code) and r.type = 'country'), max(t.geo_country_name)),
    t.geo_admin1_code,
    max(t.geo_admin1_name),
    city_key(t.city),
    mode() within group (order by btrim(regexp_replace(t.city, '\s+', ' ', 'g'))),
    count(*)
  from tournaments t
  where t.participant_count >= 16
    and t.event_class in ('cedh', 'unlabeled_competitive')
    and t.geo_country_code is not null
    and city_key(t.city) is not null
    and t.start_date >= p_since
  group by t.geo_country_code, t.geo_admin1_code, city_key(t.city)
$$;
