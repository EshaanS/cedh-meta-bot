-- Milestone 6: player data. TopDeck permits showing player names in event results and cross-event
-- highlights (docs/permissions.md) on condition that names stay current and privacy requests are honored.
-- Stored per player: TopDeck player id and display name only. No decklists, no Discord fields.

-- display_name is null when the player is removed ("Deleted User" or no name) or has opted out.
create table players (
  player_id    text primary key,
  display_name text,
  updated_at   timestamptz not null default now()
);

-- Players who asked not to be named. Managed with scripts/optout.ts. Every output reads names through
-- player_names, which hides these players.
create table player_optouts (
  player_id    text primary key,
  requested_at timestamptz not null default now(),
  note         text
);

alter table entries add column player_id text;
create index entries_player_id_idx on entries (player_id) where player_id is not null;

-- player_checked_at is null on rows fetched before player ids were stored; those are fetched once more.
alter table event_winners
  add column winner_player_id  text,
  add column player_checked_at timestamptz;

-- Windows ingested before player ids were stored are fetched again by backfill.
alter table ingest_log add column has_players boolean not null default false;

-- Same view as before with player_id appended (a replaced view can only gain columns at the end).
create or replace view qualifying_entries as
select
  e.tid,
  e.standing_index,
  e.leader,
  e.wins,
  e.draws,
  e.losses,
  e.byes,
  e.wins_swiss,
  e.wins_bracket,
  e.losses_swiss,
  e.losses_bracket,
  t.start_date,
  t.participant_count,
  t.top_cut,
  t.event_class,
  t.series_key,
  t.leader_coverage,
  t.geo_country_code,
  t.geo_admin1_code,
  t.geo_admin1_group_code,
  e.player_id
from entries e
join tournaments t on t.tid = e.tid
where t.participant_count >= 16
  and t.event_class in ('cedh', 'unlabeled_competitive');

-- The only place outputs read names from. display_name is null for opted-out players (also when the
-- opt-out exists before the player was ever ingested) and for removed players.
create view player_names as
select
  coalesce(p.player_id, o.player_id) as player_id,
  case when o.player_id is null then p.display_name end as display_name,
  o.player_id is not null as opted_out
from players p
full join player_optouts o on o.player_id = p.player_id;

-- Same results as before, plus the winner's player id (set only when result = 'winner').
create or replace view tournament_results as
with cut as (
  select e.tid, e.leader, e.standing_index, e.wins_bracket, e.losses_bracket, e.player_id,
         max(e.wins_bracket) over (partition by e.tid) as max_wins
  from entries e
  join tournaments t on t.tid = e.tid
  where t.top_cut > 0 and e.wins_bracket + e.losses_bracket > 0
),
undefeated_at_max as (
  select tid, count(*) as n, string_agg(coalesce(leader, 'unknown'), '; ' order by standing_index) as commanders,
         min(player_id) as player_id
  from cut
  where max_wins > 0 and wins_bracket = max_wins and losses_bracket = 0
  group by tid
)
select
  t.tid,
  case when u.n = 1 then 'winner' when u.n >= 2 then 'final drawn' else 'no single winner' end as result,
  u.commanders as result_commanders,
  case when u.n = 1 then u.player_id end as winner_player_id
from tournaments t
left join undefeated_at_max u on u.tid = t.tid
where t.top_cut > 0;

-- One row per event with a known winning player: the bracket-derived winner, or for events with no
-- recorded bracket the official standing-1 player when their commander is recorded (status 'found').
-- This matches the events whose result is shown as 'winner'.
create view event_winner_players as
select tr.tid, tr.winner_player_id as player_id
from tournament_results tr
where tr.result = 'winner' and tr.winner_player_id is not null
union all
select ew.tid, ew.winner_player_id
from event_winners ew
join tournaments t on t.tid = ew.tid
where coalesce(t.top_cut, 0) = 0 and ew.status = 'found' and ew.winner_player_id is not null;

-- stat_month_results gains the winner's name. winner_name is null when the result is not 'winner', the
-- player is unknown or removed, or the player opted out; winner_hidden is true only for an opt-out.
drop function stat_month_results(text, date, int);

create function stat_month_results(p_region text, p_end_month date, p_limit int default 10)
returns table (
  tid text, event_name text, participant_count int, result text, result_commanders text,
  winner_name text, winner_hidden boolean
)
language sql stable as $$
  with base as (
    select
      t.tid,
      t.name,
      t.participant_count,
      case
        when coalesce(t.top_cut, 0) > 0 then tr.result
        when ew.status = 'found' then 'winner'
        else 'winner not recorded'
      end as result,
      case when coalesce(t.top_cut, 0) > 0 then tr.result_commanders else ew.winner_commander end as result_commanders,
      case
        when coalesce(t.top_cut, 0) > 0 then tr.winner_player_id
        when ew.status = 'found' then ew.winner_player_id
      end as winner_player_id
    from tournaments t
    left join tournament_results tr on tr.tid = t.tid
    left join event_winners ew on ew.tid = t.tid
    where t.tid in (select region_tournament_ids(p_region))
      and t.participant_count >= 32
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and date_trunc('month', t.start_date at time zone 'UTC')::date = date_trunc('month', p_end_month)::date
  )
  select
    b.tid, b.name, b.participant_count, b.result, b.result_commanders,
    case when b.result = 'winner' then pn.display_name end,
    b.result = 'winner' and coalesce(pn.opted_out, false)
  from base b
  left join player_names pn on pn.player_id = b.winner_player_id
  order by b.participant_count desc, b.name
  limit p_limit
$$;

-- Top players of the end month in the region's qualifying events: event wins, then top cuts (bracket games
-- played), then the largest event they won or cut. top_commander is their most-played commander that month
-- (ties go to the larger event). Players with no visible name (opted out, removed, no id) are left out.
create function stat_top_players(p_region text, p_end_month date, p_limit int default 5)
returns table (player_name text, wins bigint, top_cuts bigint, largest_event int, top_commander text)
language sql stable as $$
  with q as (
    select * from region_qualifying_entries(p_region, p_end_month, 1) where player_id is not null
  ),
  perf as (
    select
      q.player_id,
      count(*) filter (where w.tid is not null) as wins,
      count(*) filter (where q.wins_bracket + q.losses_bracket > 0) as top_cuts,
      max(q.participant_count) filter (where w.tid is not null or q.wins_bracket + q.losses_bracket > 0) as largest_event
    from q
    left join event_winner_players w on w.tid = q.tid and w.player_id = q.player_id
    group by q.player_id
    having count(*) filter (where w.tid is not null or q.wins_bracket + q.losses_bracket > 0) > 0
  ),
  cmd as (
    select distinct on (x.player_id) x.player_id, x.leader
    from (
      select player_id, leader, count(*) as n, max(participant_count) as biggest
      from q
      where leader is not null
      group by player_id, leader
    ) x
    order by x.player_id, x.n desc, x.biggest desc, x.leader
  )
  select pn.display_name, p.wins, p.top_cuts, p.largest_event, c.leader
  from perf p
  join player_names pn on pn.player_id = p.player_id and pn.display_name is not null
  left join cmd c on c.player_id = p.player_id
  order by p.wins desc, p.top_cuts desc, p.largest_event desc, pn.display_name
  limit p_limit
$$;

-- Rising players of the end month: a top cut or win in the region that month that is the player's first
-- event win in our data, their first top cut in our data, or a top cut within their first 5 recorded
-- events. History is the player's qualifying events everywhere, not only in the region. One row per player
-- (first win before first top cut before early top cut), largest event first. Players with no visible name
-- are left out.
create function stat_rising_players(p_region text, p_end_month date, p_limit int default 3)
returns table (player_name text, reason text, event_name text, participant_count int)
language sql stable as $$
  with month_entries as (
    select q.tid, q.player_id
    from region_qualifying_entries(p_region, p_end_month, 1) q
    where q.player_id is not null
  ),
  hist as (
    select
      h.player_id, h.tid, h.participant_count,
      h.wins_bracket + h.losses_bracket > 0 as cut,
      w.tid is not null as won,
      row_number() over pl as event_no,
      count(*) filter (where h.wins_bracket + h.losses_bracket > 0)
        over (pl rows between unbounded preceding and 1 preceding) as prior_cuts,
      count(*) filter (where w.tid is not null)
        over (pl rows between unbounded preceding and 1 preceding) as prior_wins
    from qualifying_entries h
    left join event_winner_players w on w.tid = h.tid and w.player_id = h.player_id
    where h.player_id in (select player_id from month_entries)
      and date_trunc('month', h.start_date at time zone 'UTC')::date <= date_trunc('month', p_end_month)::date
    window pl as (partition by h.player_id order by h.start_date, h.tid, h.standing_index)
  ),
  cand as (
    select
      h.player_id, h.tid, h.participant_count,
      case
        when h.won and h.prior_wins = 0 then 1
        when h.cut and h.prior_cuts = 0 then 2
        when h.cut and h.event_no <= 5 then 3
      end as reason_rank
    from hist h
    join month_entries m on m.player_id = h.player_id and m.tid = h.tid
  ),
  best as (
    select distinct on (player_id) player_id, tid, participant_count, reason_rank
    from cand
    where reason_rank is not null
    order by player_id, reason_rank, participant_count desc, tid
  )
  select
    pn.display_name,
    case b.reason_rank when 1 then 'first win' when 2 then 'first top cut' else 'early top cut' end,
    t.name,
    b.participant_count
  from best b
  join player_names pn on pn.player_id = b.player_id and pn.display_name is not null
  join tournaments t on t.tid = b.tid
  order by b.participant_count desc, b.reason_rank, pn.display_name
  limit p_limit
$$;
