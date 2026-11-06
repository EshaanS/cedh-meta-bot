-- Data-quality tabulation for Milestone 1.
-- All queries cover tournaments with participant_count >= 16.
-- Month is the UTC calendar month of start_date.
-- Country is coalesce(country, info_country); info_country is filled only by /info enrichment.
-- Run with `npm run quality`, psql, or the Supabase SQL editor.
-- Each query starts with a "-- name:" line, which `npm run quality` uses as its title.

-- name: Per country per month (participant_count >= 16)
select
  to_char(t.start_date at time zone 'UTC', 'YYYY-MM') as month,
  coalesce(t.country, t.info_country, '(none)') as country,
  count(distinct t.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader,
  round(100.0 * count(e.leader) / nullif(count(e.tid), 0), 1) as pct_with_leader
from tournaments t
left join entries e on e.tid = t.tid
where t.participant_count >= 16
group by 1, 2
order by 1, 3 desc, 2;

-- name: Per country and state per month (participant_count >= 16)
select
  to_char(t.start_date at time zone 'UTC', 'YYYY-MM') as month,
  coalesce(t.country, t.info_country, '(none)') as country,
  coalesce(t.state, '(none)') as state,
  count(distinct t.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader,
  round(100.0 * count(e.leader) / nullif(count(e.tid), 0), 1) as pct_with_leader
from tournaments t
left join entries e on e.tid = t.tid
where t.participant_count >= 16
group by 1, 2, 3
order by 1, 2, 4 desc, 3;

-- name: Rows with both leader and country, per month (participant_count >= 16)
select
  to_char(t.start_date at time zone 'UTC', 'YYYY-MM') as month,
  count(*) as rows,
  count(*) filter (where e.leader is not null and coalesce(t.country, t.info_country) is not null) as rows_with_leader_and_country,
  round(
    100.0 * count(*) filter (where e.leader is not null and coalesce(t.country, t.info_country) is not null)
      / nullif(count(*), 0),
    1
  ) as pct_with_leader_and_country
from tournaments t
join entries e on e.tid = t.tid
where t.participant_count >= 16
group by 1
order by 1;

-- name: Events with no country: how recoverable, per month and total (participant_count >= 16)
-- with_lat_lng: could be reverse-geocoded. state_no_lat_lng: country could be inferred from state.
-- neither: no lat/lng and no state.
select
  coalesce(to_char(t.start_date at time zone 'UTC', 'YYYY-MM'), 'total') as month,
  count(*) as no_country_events,
  count(*) filter (where t.lat is not null and t.lng is not null) as with_lat_lng,
  count(*) filter (where (t.lat is null or t.lng is null) and t.state is not null) as state_no_lat_lng,
  count(*) filter (where (t.lat is null or t.lng is null) and t.state is null) as neither
from tournaments t
where t.participant_count >= 16
  and coalesce(t.country, t.info_country) is null
group by grouping sets ((to_char(t.start_date at time zone 'UTC', 'YYYY-MM')), ())
order by grouping(to_char(t.start_date at time zone 'UTC', 'YYYY-MM')), 1;

-- name: Top 40 countries by rows with leader, full window (participant_count >= 16)
-- Full window = every month ingested. Events with no country are excluded here; see the query above.
select
  coalesce(t.country, t.info_country) as country,
  count(distinct t.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader,
  count(distinct e.leader) as distinct_leaders
from tournaments t
join entries e on e.tid = t.tid
where t.participant_count >= 16
  and coalesce(t.country, t.info_country) is not null
group by 1
order by rows_with_leader desc, country
limit 40;

-- name: Top 40 US states by rows with leader, full window (participant_count >= 16)
-- US events with no state are excluded.
select
  coalesce(t.country, t.info_country) as country,
  t.state,
  count(distinct t.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader,
  count(distinct e.leader) as distinct_leaders
from tournaments t
join entries e on e.tid = t.tid
where t.participant_count >= 16
  and coalesce(t.country, t.info_country) = 'United States'
  and t.state is not null
group by 1, 2
order by rows_with_leader desc, t.state
limit 40;

-- name: Rolling 3- and 6-month leader coverage, top 15 countries and top 15 US states (participant_count >= 16)
-- Windows end at the latest month with data before the current UTC month.
-- Top 15 is ranked by rows with leader over the full window, as in the two queries above.
-- leaders_10plus counts distinct leaders with at least 10 entries in that region and window.
with bounds as (
  select date_trunc('month', max(start_date at time zone 'UTC')) as last_month
  from tournaments
  where participant_count >= 16
    and start_date < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
),
base as (
  select
    coalesce(t.country, t.info_country) as country,
    t.state,
    date_trunc('month', t.start_date at time zone 'UTC') as month,
    e.leader
  from tournaments t
  join entries e on e.tid = t.tid
  where t.participant_count >= 16
),
labeled as (
  select 'country' as region_type, country as region, month, leader from base where country is not null
  union all
  select 'US state', state, month, leader from base where country = 'United States' and state is not null
),
top_regions as (
  select region_type, region
  from (
    select region_type, region,
           row_number() over (partition by region_type order by count(leader) desc, region) as rn
    from labeled
    group by region_type, region
  ) ranked
  where rn <= 15
),
leader_counts as (
  select l.region_type, l.region, w.months, l.leader, count(*) as n
  from labeled l
  join top_regions using (region_type, region)
  cross join bounds b
  cross join (values (3), (6)) as w(months)
  where l.leader is not null
    and l.month <= b.last_month
    and l.month > b.last_month - make_interval(months => w.months)
  group by 1, 2, 3, 4
),
per_window as (
  select region_type, region, months,
         sum(n) as rows_with_leader,
         count(*) filter (where n >= 10) as leaders_10plus
  from leader_counts
  group by 1, 2, 3
)
select
  tr.region_type,
  tr.region,
  to_char(b.last_month, 'YYYY-MM') as window_end,
  coalesce(p3.rows_with_leader, 0) as rows_with_leader_3m,
  coalesce(p3.leaders_10plus, 0) as leaders_10plus_3m,
  coalesce(p6.rows_with_leader, 0) as rows_with_leader_6m,
  coalesce(p6.leaders_10plus, 0) as leaders_10plus_6m
from top_regions tr
cross join bounds b
left join per_window p3 on p3.region_type = tr.region_type and p3.region = tr.region and p3.months = 3
left join per_window p6 on p6.region_type = tr.region_type and p6.region = tr.region and p6.months = 6
order by case tr.region_type when 'country' then 0 else 1 end, rows_with_leader_6m desc, tr.region;

-- name: Lat/lng presence among events that have a country, per month (participant_count >= 16)
select
  to_char(t.start_date at time zone 'UTC', 'YYYY-MM') as month,
  count(*) as events_with_country,
  count(*) filter (where t.lat is not null and t.lng is not null) as with_lat_lng,
  round(100.0 * count(*) filter (where t.lat is not null and t.lng is not null) / count(*), 1) as pct_with_lat_lng
from tournaments t
where t.participant_count >= 16
  and coalesce(t.country, t.info_country) is not null
group by 1
order by 1;

-- name: Location signals for all events, per month and total (participant_count >= 16)
-- The first five pct_ columns are exclusive buckets, checked in this order, and sum to ~100 (rounding):
--   lat_lng: lat and lng present.
--   us_state_no_lat_lng: no lat/lng; state matches a US state name or USPS code, and country is null or United States.
--   other_state_no_lat_lng: no lat/lng; any other non-null state.
--   country_only: no lat/lng, no state, country present.
--   nothing: no lat/lng, no state, no country. City alone is not counted as a location.
-- pct_us_state_any: state matches the US map regardless of lat/lng, so it overlaps the buckets.
-- The map covers the 50 states only (no DC or territories), matched case-insensitively.
with us_states(code, name) as (
  values
    ('AL', 'Alabama'), ('AK', 'Alaska'), ('AZ', 'Arizona'), ('AR', 'Arkansas'), ('CA', 'California'),
    ('CO', 'Colorado'), ('CT', 'Connecticut'), ('DE', 'Delaware'), ('FL', 'Florida'), ('GA', 'Georgia'),
    ('HI', 'Hawaii'), ('ID', 'Idaho'), ('IL', 'Illinois'), ('IN', 'Indiana'), ('IA', 'Iowa'),
    ('KS', 'Kansas'), ('KY', 'Kentucky'), ('LA', 'Louisiana'), ('ME', 'Maine'), ('MD', 'Maryland'),
    ('MA', 'Massachusetts'), ('MI', 'Michigan'), ('MN', 'Minnesota'), ('MS', 'Mississippi'), ('MO', 'Missouri'),
    ('MT', 'Montana'), ('NE', 'Nebraska'), ('NV', 'Nevada'), ('NH', 'New Hampshire'), ('NJ', 'New Jersey'),
    ('NM', 'New Mexico'), ('NY', 'New York'), ('NC', 'North Carolina'), ('ND', 'North Dakota'), ('OH', 'Ohio'),
    ('OK', 'Oklahoma'), ('OR', 'Oregon'), ('PA', 'Pennsylvania'), ('RI', 'Rhode Island'), ('SC', 'South Carolina'),
    ('SD', 'South Dakota'), ('TN', 'Tennessee'), ('TX', 'Texas'), ('UT', 'Utah'), ('VT', 'Vermont'),
    ('VA', 'Virginia'), ('WA', 'Washington'), ('WV', 'West Virginia'), ('WI', 'Wisconsin'), ('WY', 'Wyoming')
),
flags as (
  select
    to_char(t.start_date at time zone 'UTC', 'YYYY-MM') as month,
    (t.lat is not null and t.lng is not null) as has_lat_lng,
    (t.state is not null) as has_state,
    (coalesce(t.country, t.info_country) is not null) as has_country,
    (coalesce(t.country, t.info_country, 'United States') = 'United States'
      and exists (select 1 from us_states s where upper(t.state) = s.code or lower(t.state) = lower(s.name))) as us_state
  from tournaments t
  where t.participant_count >= 16
)
select
  coalesce(month, 'total') as month,
  count(*) as events,
  round(100.0 * count(*) filter (where has_lat_lng) / count(*), 1) as pct_lat_lng,
  round(100.0 * count(*) filter (where not has_lat_lng and us_state) / count(*), 1) as pct_us_state_no_lat_lng,
  round(100.0 * count(*) filter (where not has_lat_lng and has_state and not us_state) / count(*), 1) as pct_other_state_no_lat_lng,
  round(100.0 * count(*) filter (where not has_lat_lng and not has_state and has_country) / count(*), 1) as pct_country_only,
  round(100.0 * count(*) filter (where not has_lat_lng and not has_state and not has_country) / count(*), 1) as pct_nothing,
  round(100.0 * count(*) filter (where us_state) / count(*), 1) as pct_us_state_any
from flags
group by grouping sets ((month), ())
order by grouping(month), 1;

-- Name classification used by the next four queries (keep the CASE identical in all four).
-- Precedence: test, then cedh, then casual, else unlabeled. Postgres regex uses \y for word
-- boundaries (\b means backspace), so /\btest\b/i is written '\ytest\y'.
--   test:   \ytest\y
--   cedh:   cedh|c-edh|competitive
--   casual: casual|fnm|bracket ?[1-4]|precon|budget

-- name: Tournament name classes, full window (participant_count >= 16)
with classified as (
  select t.*,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
)
select
  c.name_class,
  count(distinct c.tid) as tournaments,
  count(e.tid) as rows,
  round(100.0 * count(e.leader) / nullif(count(e.tid), 0), 1) as pct_rows_with_leader,
  round(100.0 * count(distinct c.tid) filter (
    where (c.lat is not null and c.lng is not null) or c.city is not null or c.state is not null
       or coalesce(c.country, c.info_country) is not null
  ) / count(distinct c.tid), 1) as pct_events_with_location
from classified c
join entries e on e.tid = c.tid
group by 1
order by tournaments desc;

-- name: 30 most common unlabeled names, normalized (participant_count >= 16)
-- Normalized = lowercased, digits removed, whitespace collapsed and trimmed.
with classified as (
  select t.*,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
)
select
  btrim(regexp_replace(regexp_replace(lower(coalesce(c.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
  count(distinct c.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader
from classified c
join entries e on e.tid = c.tid
where c.name_class = 'unlabeled'
group by 1
order by tournaments desc, rows desc, 1
limit 30;

-- name: British Columbia, Illinois, Nevada leader coverage with and without casual events (participant_count >= 16)
-- State matches the full name or the postal code, case-insensitive, and country must be null or the
-- expected country (pre-February 2026 events have no country).
with regions(region, country, pattern) as (
  values
    ('British Columbia', 'Canada', '^(british columbia|bc)$'),
    ('Illinois', 'United States', '^(illinois|il)$'),
    ('Nevada', 'United States', '^(nevada|nv)$')
),
classified as (
  select t.*, r.region,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  join regions r
    on t.state ~* r.pattern
   and coalesce(t.country, t.info_country, r.country) = r.country
  where t.participant_count >= 16
),
scoped as (
  select region, 'all classes' as scope, 1 as scope_order, tid, name_class from classified
  union all
  select region, 'excluding casual', 2, tid, name_class from classified where name_class <> 'casual'
  union all
  select region, 'casual only', 3, tid, name_class from classified where name_class = 'casual'
)
select
  s.region,
  s.scope,
  count(distinct s.tid) as tournaments,
  count(e.tid) as rows,
  count(e.leader) as rows_with_leader,
  round(100.0 * count(e.leader) / nullif(count(e.tid), 0), 1) as pct_rows_with_leader
from scoped s
join entries e on e.tid = s.tid
group by s.region, s.scope, s.scope_order
order by s.region, s.scope_order;
