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
