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

-- Per-event leader coverage = entries with a leader / all entries in the event. The next five
-- queries share the name classification above and these buckets: 0%, 1-24% (above 0, below 25),
-- 25-49%, 50-74%, 75-99% (75 or more, below 100), 100%.

-- name: Per-event leader coverage histogram by name class, event counts (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
),
bucketed as (
  select p.*,
    case
      when p.leader_rows = 0 then '0%'
      when p.leader_rows = p.rows then '100%'
      when p.coverage < 0.25 then '1-24%'
      when p.coverage < 0.50 then '25-49%'
      when p.coverage < 0.75 then '50-74%'
      else '75-99%'
    end as bucket
  from per_event p
),
buckets(bucket, ord) as (
  values ('0%', 1), ('1-24%', 2), ('25-49%', 3), ('50-74%', 4), ('75-99%', 5), ('100%', 6)
)
select
  b.bucket,
  count(x.tid) filter (where x.name_class = 'cedh') as cedh,
  count(x.tid) filter (where x.name_class = 'casual') as casual,
  count(x.tid) filter (where x.name_class = 'unlabeled') as unlabeled
from buckets b
left join bucketed x on x.bucket = b.bucket
group by b.bucket, b.ord
order by b.ord;

-- name: Unlabeled events: per-event leader coverage histogram (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
),
bucketed as (
  select p.*,
    case
      when p.leader_rows = 0 then '0%'
      when p.leader_rows = p.rows then '100%'
      when p.coverage < 0.25 then '1-24%'
      when p.coverage < 0.50 then '25-49%'
      when p.coverage < 0.75 then '50-74%'
      else '75-99%'
    end as bucket
  from per_event p
),
buckets(bucket, ord) as (
  values ('0%', 1), ('1-24%', 2), ('25-49%', 3), ('50-74%', 4), ('75-99%', 5), ('100%', 6)
)
select
  b.bucket,
  count(x.tid) as events,
  round(100.0 * count(x.tid) / nullif(sum(count(x.tid)) over (), 0), 1) as pct_events,
  coalesce(sum(x.rows), 0) as rows
from buckets b
left join bucketed x on x.bucket = b.bucket and x.name_class = 'unlabeled'
group by b.bucket, b.ord
order by b.ord;

-- name: Unlabeled events: 15 most common normalized names at 0% and at 75%+ leader coverage (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
),
bucketed as (
  select p.*,
    case
      when p.leader_rows = 0 then '0%'
      when p.leader_rows = p.rows then '100%'
      when p.coverage < 0.25 then '1-24%'
      when p.coverage < 0.50 then '25-49%'
      when p.coverage < 0.75 then '50-74%'
      else '75-99%'
    end as bucket
  from per_event p
),
buckets(bucket, ord) as (
  values ('0%', 1), ('1-24%', 2), ('25-49%', 3), ('50-74%', 4), ('75-99%', 5), ('100%', 6)
),
grouped as (
  select
    case when bucket = '0%' then '0%' else '75%+' end as coverage_group,
    normalized_name,
    count(*) as events,
    sum(rows) as rows
  from bucketed
  where name_class = 'unlabeled' and bucket in ('0%', '75-99%', '100%')
  group by 1, 2
)
select coverage_group, normalized_name, events, rows
from (
  select g.*, row_number() over (partition by coverage_group order by events desc, rows desc, normalized_name) as rn
  from grouped g
) ranked
where rn <= 15
order by coverage_group, rn;

-- name: cedh-class events excluded by a "leader coverage >= 50%" rule (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
),
bucketed as (
  select p.*,
    case
      when p.leader_rows = 0 then '0%'
      when p.leader_rows = p.rows then '100%'
      when p.coverage < 0.25 then '1-24%'
      when p.coverage < 0.50 then '25-49%'
      when p.coverage < 0.75 then '50-74%'
      else '75-99%'
    end as bucket
  from per_event p
),
buckets(bucket, ord) as (
  values ('0%', 1), ('1-24%', 2), ('25-49%', 3), ('50-74%', 4), ('75-99%', 5), ('100%', 6)
)
select
  count(*) as cedh_events,
  count(*) filter (where coverage < 0.5) as excluded_events,
  round(100.0 * count(*) filter (where coverage < 0.5) / nullif(count(*), 0), 1) as pct_events_excluded,
  coalesce(sum(rows) filter (where coverage < 0.5), 0) as excluded_rows,
  coalesce(sum(leader_rows) filter (where coverage < 0.5), 0) as excluded_rows_with_leader,
  round(100.0 * coalesce(sum(leader_rows) filter (where coverage < 0.5), 0) / nullif(sum(leader_rows), 0), 1) as pct_of_cedh_rows_with_leader
from per_event
where name_class = 'cedh';

-- name: 10 most common normalized names among cedh-class events below 50% leader coverage (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
),
bucketed as (
  select p.*,
    case
      when p.leader_rows = 0 then '0%'
      when p.leader_rows = p.rows then '100%'
      when p.coverage < 0.25 then '1-24%'
      when p.coverage < 0.50 then '25-49%'
      when p.coverage < 0.75 then '50-74%'
      else '75-99%'
    end as bucket
  from per_event p
),
buckets(bucket, ord) as (
  values ('0%', 1), ('1-24%', 2), ('25-49%', 3), ('50-74%', 4), ('75-99%', 5), ('100%', 6)
)
select normalized_name, count(*) as events, sum(rows) as rows, sum(leader_rows) as rows_with_leader
from per_event
where name_class = 'cedh' and coverage < 0.5
group by normalized_name
order by events desc, rows desc, normalized_name
limit 10;

-- name: Reporting bias: leader share in top-cut rows vs other rows, by event coverage (participant_count >= 16, topCut > 0)
-- A top-cut row is one that played in the bracket (wins_bracket + losses_bracket > 0), so this does not
-- rely on array order. A player whose cut pod drew may have both at 0 and count as non-top-cut.
-- ratio = top-cut leader share / other leader share; well above 1 means top finishers report more.
with per_event as (
  select t.tid, count(*) as rows, count(e.leader) as leader_rows
  from tournaments t
  join entries e on e.tid = t.tid
  where t.participant_count >= 16 and t.top_cut > 0
  group by t.tid
),
grouped as (
  select tid,
    case
      when leader_rows::numeric / rows >= 0.75 then '75%+ (baseline)'
      when leader_rows > 0 then '1-74%'
    end as coverage_group
  from per_event
),
rows_flagged as (
  select g.coverage_group, e.tid, e.leader is not null as has_leader,
         (e.wins_bracket + e.losses_bracket > 0) as top_cut_row
  from grouped g
  join entries e on e.tid = g.tid
  where g.coverage_group is not null
)
select
  coverage_group,
  count(distinct tid) as events,
  count(*) filter (where top_cut_row) as top_cut_rows,
  round(100.0 * count(*) filter (where top_cut_row and has_leader) / nullif(count(*) filter (where top_cut_row), 0), 1) as pct_top_cut_with_leader,
  count(*) filter (where not top_cut_row) as other_rows,
  round(100.0 * count(*) filter (where not top_cut_row and has_leader) / nullif(count(*) filter (where not top_cut_row), 0), 1) as pct_other_with_leader,
  round(
    (count(*) filter (where top_cut_row and has_leader)::numeric / nullif(count(*) filter (where top_cut_row), 0))
    / nullif(count(*) filter (where not top_cut_row and has_leader)::numeric / nullif(count(*) filter (where not top_cut_row), 0), 0),
    2
  ) as ratio
from rows_flagged
group by coverage_group
order by coverage_group;

-- name: Share of leader rows from high-coverage events, by name class (participant_count >= 16)
-- Uses the name classification defined above the class queries.
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
)
select
  coalesce(name_class, 'all') as name_class,
  sum(leader_rows) as rows_with_leader,
  round(100.0 * coalesce(sum(leader_rows) filter (where coverage >= 0.75), 0) / nullif(sum(leader_rows), 0), 1) as pct_from_75_plus_events,
  round(100.0 * coalesce(sum(leader_rows) filter (where coverage >= 0.50), 0) / nullif(sum(leader_rows), 0), 1) as pct_from_50_plus_events
from per_event
group by grouping sets ((name_class), ())
order by grouping(name_class), rows_with_leader desc;

-- name: Unlabeled events at 1-74% leader coverage: 20 most common normalized names (participant_count >= 16)
with classified as (
  select t.tid,
    btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\s+', ' ', 'g')) as normalized_name,
    case
      when coalesce(t.name, '') ~* '\ytest\y' then 'test'
      when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
      when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
      else 'unlabeled'
    end as name_class
  from tournaments t
  where t.participant_count >= 16
),
per_event as (
  select c.tid, c.normalized_name, c.name_class,
    count(*) as rows,
    count(e.leader) as leader_rows,
    count(e.leader)::numeric / count(*) as coverage
  from classified c
  join entries e on e.tid = c.tid
  group by c.tid, c.normalized_name, c.name_class
)
select
  normalized_name,
  count(*) as events,
  sum(rows) as rows,
  round(100.0 * avg(coverage), 1) as avg_coverage_pct
from per_event
where name_class = 'unlabeled' and leader_rows > 0 and coverage < 0.75
group by normalized_name
order by events desc, rows desc, normalized_name
limit 20;
