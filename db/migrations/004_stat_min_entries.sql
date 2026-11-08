-- Deck stats (PPG, top-cut conversion) require a commander to have >= 10 qualifying entries with a leader in
-- the window, in addition to the 0.2% meta-share floor. Deviation from cedhstats, recorded in CLAUDE.md:
-- the 0.2% floor is calibrated at global scale and admits 2-entry commanders in small regions; 10 matches
-- the reportability threshold, so the stats and the reportable test cover the same commanders.

create function stat_eligible_commanders(p_region text, p_end_month date, p_months int default 6)
returns setof text
language sql stable as $$
  select commander
  from commander_shares(p_region, p_end_month, p_months)
  where meta_share >= 0.002 and entries >= 10
$$;

create or replace function stat_ppg(p_region text, p_end_month date, p_months int default 6)
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
      and leader in (select stat_eligible_commanders(p_region, p_end_month, p_months))
    group by leader
  )
  select c.leader, c.n, c.w, c.d, c.l, c.ppg,
         (c.n * c.ppg + 20 * 1.25) / (c.n + 20),
         f.draw_rate, 1.25 - 0.25 * f.draw_rate
  from per_commander c cross join field f
  order by 7 desc, c.leader
$$;

create or replace function stat_conversion(p_region text, p_end_month date, p_months int default 6)
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
  where q.leader in (select stat_eligible_commanders(p_region, p_end_month, p_months))
  group by q.leader, b.rate
  order by 4 desc, 2 desc, q.leader
$$;
