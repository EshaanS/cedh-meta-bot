-- Milestone 3: region catalog with fallback parents, reportability, and v1 stat functions.
-- Stat definitions follow CLAUDE.md "Stat definitions" (cedhstats.org/about, with listed deviations).
-- Month arguments are any date in the month (normalized to its first day); months are UTC calendar months.

alter table regions
  add column parent_region_id text references regions (id),
  add column source text not null default 'seed' check (source in ('seed', 'auto')),
  add constraint regions_parent_not_self check (parent_region_id is distinct from id);

alter table regions drop constraint regions_type_check;
alter table regions add constraint regions_type_check
  check (type in ('global', 'macro', 'country', 'admin1', 'admin1_group', 'custom'));

update regions set parent_region_id = 'global' where type = 'macro';
update regions set parent_region_id = 'north-america' where id = 'pacific-northwest';

-- Tournaments in a region. global matches every tournament; other regions match a member's geocoded
-- country plus, when set, its admin-1 code or admin-1 group code. Unknown region ids match nothing.
create function region_tournament_ids(p_region text)
returns setof text
language sql stable as $$
  select t.tid
  from tournaments t
  where exists (select 1 from regions r where r.id = p_region and r.type = 'global')
     or exists (
       select 1 from region_members m
       where m.region_id = p_region
         and m.country_code = t.geo_country_code
         and (m.admin1_code is null or m.admin1_code = t.geo_admin1_code)
         and (m.admin1_group_code is null or m.admin1_group_code = t.geo_admin1_group_code)
     )
$$;

-- Qualifying entries in a region over the p_months months ending at p_end_month.
create function region_qualifying_entries(p_region text, p_end_month date, p_months int default 6)
returns setof qualifying_entries
language sql stable as $$
  select q.*
  from qualifying_entries q
  where q.tid in (select region_tournament_ids(p_region))
    and date_trunc('month', q.start_date at time zone 'UTC')::date
        between (date_trunc('month', p_end_month) - make_interval(months => p_months - 1))::date
            and date_trunc('month', p_end_month)::date
$$;

-- Reportable for commander stats: >= 10 commanders each with >= 10 qualifying entries with a leader,
-- over the 6 months ending at p_end_month.
create function region_reportability(p_region text, p_end_month date)
returns table (entries bigint, entries_with_leader bigint, commanders_10plus bigint, reportable boolean)
language sql stable as $$
  with q as (select * from region_qualifying_entries(p_region, p_end_month, 6)),
  per_commander as (select leader, count(*) as n from q where leader is not null group by leader)
  select
    (select count(*) from q),
    (select count(*) from q where leader is not null),
    (select count(*) from per_commander where n >= 10),
    (select count(*) from per_commander where n >= 10) >= 10
$$;

-- Walks parent_region_id from p_region and returns the first reportable region. If none is reportable,
-- returns the top of the chain (normally global) with reportable = false.
create function resolve_region(p_region text, p_end_month date)
returns table (region_id text, steps_up int, reportable boolean)
language sql stable as $$
  with recursive chain (id, parent, steps) as (
    select id, parent_region_id, 0 from regions where id = p_region
    union all
    select r.id, r.parent_region_id, c.steps + 1
    from regions r
    join chain c on r.id = c.parent
    where c.steps < 10
  ),
  scored as (
    select c.id, c.steps, (select rr.reportable from region_reportability(c.id, p_end_month) rr) as ok
    from chain c
  )
  (select id, steps, true from scored where ok order by steps limit 1)
  union all
  (select id, steps, false from scored where not exists (select 1 from scored where ok) order by steps desc limit 1)
$$;

-- Every commander's entries and meta share (entries / entries with a leader), before the 0.2% floor.
create function commander_shares(p_region text, p_end_month date, p_months int default 6)
returns table (commander text, entries bigint, meta_share double precision)
language sql stable as $$
  with q as (select leader from region_qualifying_entries(p_region, p_end_month, p_months) where leader is not null)
  select leader, count(*), count(*)::double precision / sum(count(*)) over ()
  from q
  group by leader
$$;

-- Meta share, commanders at or above the 0.2% floor.
create function stat_meta_share(p_region text, p_end_month date, p_months int default 6)
returns table (commander text, entries bigint, meta_share double precision)
language sql stable as $$
  select commander, entries, meta_share
  from commander_shares(p_region, p_end_month, p_months)
  where meta_share >= 0.002
  order by entries desc, commander
$$;

-- PPG = (5W + D) / (W + L + D); shrunk PPG = (n x PPG + 20 x 1.25) / (n + 20), n = entries.
-- Byes are not games and are not in wins. Draw rate and neutral baseline (1.25 - 0.25 x draw rate) are
-- for the whole field in the region and window. Commanders at or above the 0.2% floor only.
create function stat_ppg(p_region text, p_end_month date, p_months int default 6)
returns table (
  commander text, entries bigint, wins bigint, draws bigint, losses bigint,
  ppg double precision, shrunk_ppg double precision, field_draw_rate double precision, neutral_baseline double precision
)
language sql stable as $$
  with q as (select * from region_qualifying_entries(p_region, p_end_month, p_months)),
  field as (
    select sum(draws)::double precision / nullif(sum(wins + losses + draws), 0) as draw_rate from q
  ),
  per_commander as (
    select leader, count(*) as n, sum(wins) as w, sum(draws) as d, sum(losses) as l,
           (5 * sum(wins) + sum(draws))::double precision / nullif(sum(wins + losses + draws), 0) as ppg
    from q
    where leader is not null
      and leader in (select commander from commander_shares(p_region, p_end_month, p_months) where meta_share >= 0.002)
    group by leader
  )
  select c.leader, c.n, c.w, c.d, c.l, c.ppg,
         (c.n * c.ppg + 20 * 1.25) / (c.n + 20),
         f.draw_rate, 1.25 - 0.25 * f.draw_rate
  from per_commander c cross join field f
  order by 7 desc, c.leader
$$;

-- Top-cut conversion: entries that played bracket games / entries in events with topCut > 0.
-- The baseline uses entries with a leader, the same population as the per-commander rates.
create function stat_conversion(p_region text, p_end_month date, p_months int default 6)
returns table (commander text, entries_in_cut_events bigint, top_cut_entries bigint, conversion double precision, baseline_conversion double precision)
language sql stable as $$
  with q as (
    select leader, (wins_bracket + losses_bracket > 0) as in_cut
    from region_qualifying_entries(p_region, p_end_month, p_months)
    where top_cut > 0 and leader is not null
  ),
  base as (select count(*) filter (where in_cut)::double precision / nullif(count(*), 0) as rate from q)
  select q.leader, count(*), count(*) filter (where q.in_cut),
         count(*) filter (where q.in_cut)::double precision / count(*), b.rate
  from q cross join base b
  where q.leader in (select commander from commander_shares(p_region, p_end_month, p_months) where meta_share >= 0.002)
  group by q.leader, b.rate
  order by 4 desc, 2 desc, q.leader
$$;

-- Growth: the end month against the 3 months before it. Commanders with >= 5 entries in the end month.
-- entry_growth compares counts (moves with total volume); share_growth compares meta shares.
-- Both are null when the commander had no entries in the prior 3 months (is_new).
create function stat_growth(p_region text, p_end_month date)
returns table (
  commander text, last_month_entries bigint, prior3_avg_entries double precision, entry_growth double precision,
  last_month_share double precision, prior3_share double precision, share_growth double precision, is_new boolean
)
language sql stable as $$
  with q as (
    select leader, date_trunc('month', start_date at time zone 'UTC')::date as m
    from region_qualifying_entries(p_region, p_end_month, 4)
    where leader is not null
  ),
  totals as (
    select count(*) filter (where m = date_trunc('month', p_end_month)::date) as last_total,
           count(*) filter (where m < date_trunc('month', p_end_month)::date) as prior_total
    from q
  ),
  last_m as (select leader, count(*) as n from q where m = date_trunc('month', p_end_month)::date group by leader),
  prior as (select leader, count(*) as n from q where m < date_trunc('month', p_end_month)::date group by leader)
  select
    l.leader,
    l.n,
    coalesce(p.n, 0) / 3.0,
    case when p.n is null then null else l.n / (p.n / 3.0) - 1 end,
    l.n::double precision / t.last_total,
    coalesce(p.n, 0)::double precision / nullif(t.prior_total, 0),
    case when p.n is null or t.prior_total = 0 then null
         else (l.n::double precision / t.last_total) / (p.n::double precision / t.prior_total) - 1 end,
    p.n is null
  from last_m l
  left join prior p on p.leader = l.leader
  cross join totals t
  where l.n >= 5
  order by 7 desc nulls last, l.n desc, l.leader
$$;

-- Notable results: qualifying events in the end month with 32+ players, with the commanders of the
-- entries that played in the top cut (bracket games played). No player names.
create function stat_notable_results(p_region text, p_end_month date)
returns table (tid text, event_name text, participant_count int, location text, top_cut_commanders text)
language sql stable as $$
  select
    t.tid,
    t.name,
    t.participant_count,
    nullif(concat_ws(', ', t.geo_admin1_name, coalesce(cr.display_name, t.geo_country_name)), ''),
    (
      select concat_ws('; ',
        string_agg(e.leader, '; ' order by e.wins_bracket desc, e.standing_index) filter (where e.leader is not null),
        case when count(*) filter (where e.leader is null) > 0
             then 'unknown x' || count(*) filter (where e.leader is null) end)
      from entries e
      where e.tid = t.tid and e.wins_bracket + e.losses_bracket > 0
    )
  from tournaments t
  left join regions cr on cr.id = lower(t.geo_country_code) and cr.type = 'country'
  where t.tid in (select region_tournament_ids(p_region))
    and t.participant_count >= 32
    and t.event_class in ('cedh', 'unlabeled_competitive')
    and date_trunc('month', t.start_date at time zone 'UTC')::date = date_trunc('month', p_end_month)::date
  order by t.participant_count desc, t.name
$$;

-- Coverage line inputs for 16+ events in the region and window. pct_geocoded can only be below 100 for
-- global, because every other region requires a geocode.
create function stat_coverage(p_region text, p_end_month date, p_months int default 6)
returns table (
  events_16plus bigint, qualifying_events bigint, pct_geocoded double precision,
  qualifying_entries bigint, pct_entries_with_leader double precision
)
language sql stable as $$
  with ev as (
    select t.*
    from tournaments t
    where t.participant_count >= 16
      and t.tid in (select region_tournament_ids(p_region))
      and date_trunc('month', t.start_date at time zone 'UTC')::date
          between (date_trunc('month', p_end_month) - make_interval(months => p_months - 1))::date
              and date_trunc('month', p_end_month)::date
  ),
  q as (select leader from region_qualifying_entries(p_region, p_end_month, p_months))
  select
    (select count(*) from ev),
    (select count(*) from ev where event_class in ('cedh', 'unlabeled_competitive')),
    (select 100.0 * count(*) filter (where geo_country_code is not null) / nullif(count(*), 0) from ev),
    (select count(*) from q),
    (select 100.0 * count(leader) / nullif(count(*), 0) from q)
$$;
