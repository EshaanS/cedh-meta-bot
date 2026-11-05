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
