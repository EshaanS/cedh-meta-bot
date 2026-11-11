-- Stat performance after the 36-month backfill. No stat changes its result.
-- Observed November 2026 on Supabase (20,800 tournaments, 390,000 entries), global region, October 2026:
-- stat_conversion ran past the 2-minute statement timeout and stat_month_results took 21 s. The planner
-- could not see into `tid in (select region_tournament_ids(...))` (it assumed 1,000 rows) and chose nested
-- loops, and stat_month_results computed the result of every event to show ten.

-- Same rows as before. The global test is a scalar subquery, evaluated once.
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
$$;

-- Same rows as before. Calling region_tournament_ids in FROM lets the planner inline it, and the month
-- window is a plain range on start_date (UTC month bounds, as before).
create or replace function region_qualifying_entries(p_region text, p_end_month date, p_months int default 6)
returns setof qualifying_entries
language sql stable as $$
  select q.*
  from qualifying_entries q
  where q.tid in (select r.tid from region_tournament_ids(p_region) as r(tid))
    and q.start_date >= ((date_trunc('month', p_end_month) - make_interval(months => p_months - 1))::timestamp at time zone 'UTC')
    and q.start_date <  ((date_trunc('month', p_end_month) + interval '1 month')::timestamp at time zone 'UTC')
$$;

-- Top-cut rows are a small share of entries; results and player stats read only these.
create index entries_cut_idx on entries (tid) where wins_bracket + losses_bracket > 0;

-- The tournament_results rule (migration 005, plus winner_player_id from 008) for the given events, or for
-- every event when p_tids is null. The view below keeps the rule in one place.
create function tournament_results_for(p_tids text[])
returns table (tid text, result text, result_commanders text, winner_player_id text)
language sql stable as $$
  with cut as (
    select e.tid, e.leader, e.standing_index, e.wins_bracket, e.losses_bracket, e.player_id,
           max(e.wins_bracket) over (partition by e.tid) as max_wins
    from entries e
    join tournaments t on t.tid = e.tid
    where t.top_cut > 0 and e.wins_bracket + e.losses_bracket > 0
      and (p_tids is null or e.tid = any (p_tids))
  ),
  undefeated_at_max as (
    select c.tid, count(*) as n, string_agg(coalesce(c.leader, 'unknown'), '; ' order by c.standing_index) as commanders,
           min(c.player_id) as player_id
    from cut c
    where c.max_wins > 0 and c.wins_bracket = c.max_wins and c.losses_bracket = 0
    group by c.tid
  )
  select
    t.tid,
    case when u.n = 1 then 'winner' when u.n >= 2 then 'final drawn' else 'no single winner' end,
    u.commanders,
    case when u.n = 1 then u.player_id end
  from tournaments t
  left join undefeated_at_max u on u.tid = t.tid
  where t.top_cut > 0
    and (p_tids is null or t.tid = any (p_tids))
$$;

create or replace view tournament_results as
select tid, result, result_commanders, winner_player_id from tournament_results_for(null);

-- Same output as migration 008. Picks the month's events first, then computes results for those only.
create or replace function stat_month_results(p_region text, p_end_month date, p_limit int default 10)
returns table (
  tid text, event_name text, participant_count int, result text, result_commanders text,
  winner_name text, winner_hidden boolean
)
language sql stable as $$
  with ev as materialized (
    select t.tid, t.name, t.participant_count, coalesce(t.top_cut, 0) as top_cut
    from tournaments t
    where t.tid in (select r.tid from region_tournament_ids(p_region) as r(tid))
      and t.participant_count >= 32
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and date_trunc('month', t.start_date at time zone 'UTC')::date = date_trunc('month', p_end_month)::date
    order by t.participant_count desc, t.name
    limit p_limit
  ),
  base as (
    select
      ev.tid, ev.name, ev.participant_count,
      case
        when ev.top_cut > 0 then tr.result
        when ew.status = 'found' then 'winner'
        else 'winner not recorded'
      end as result,
      case when ev.top_cut > 0 then tr.result_commanders else ew.winner_commander end as result_commanders,
      case
        when ev.top_cut > 0 then tr.winner_player_id
        when ew.status = 'found' then ew.winner_player_id
      end as winner_player_id
    from ev
    left join tournament_results_for((select array_agg(ev2.tid) from ev ev2)) tr on tr.tid = ev.tid
    left join event_winners ew on ew.tid = ev.tid
  )
  select
    b.tid, b.name, b.participant_count, b.result, b.result_commanders,
    case when b.result = 'winner' then pn.display_name end,
    b.result = 'winner' and coalesce(pn.opted_out, false)
  from base b
  left join player_names pn on pn.player_id = b.winner_player_id
  order by b.participant_count desc, b.name
$$;
