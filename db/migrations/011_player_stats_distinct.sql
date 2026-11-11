-- Player stats count each (event, player) pair once. Observed November 2026: 19 (event, account id) pairs
-- appear on two standings rows, which counted a top cut twice. Also adds the share of a month's qualifying
-- entries that carry an account id, shown on the post's coverage line.

-- One row per (event, player) among qualifying entries: cut if any of the player's rows played bracket games.
create view qualifying_player_events as
select
  q.tid,
  q.player_id,
  min(q.start_date) as start_date,
  min(q.participant_count) as participant_count,
  bool_or(q.wins_bracket + q.losses_bracket > 0) as cut
from qualifying_entries q
where q.player_id is not null
group by q.tid, q.player_id;

create or replace function stat_top_players(p_region text, p_end_month date, p_limit int default 5)
returns table (player_name text, wins bigint, top_cuts bigint, largest_event int, top_commander text)
language sql stable as $$
  with q as (
    select * from region_qualifying_entries(p_region, p_end_month, 1) where player_id is not null
  ),
  pe as (
    select q.tid, q.player_id, min(q.participant_count) as participant_count,
           bool_or(q.wins_bracket + q.losses_bracket > 0) as cut
    from q
    group by q.tid, q.player_id
  ),
  perf as (
    select
      pe.player_id,
      count(*) filter (where w.tid is not null) as wins,
      count(*) filter (where pe.cut) as top_cuts,
      max(pe.participant_count) filter (where w.tid is not null or pe.cut) as largest_event
    from pe
    left join event_winner_players w on w.tid = pe.tid and w.player_id = pe.player_id
    group by pe.player_id
    having count(*) filter (where w.tid is not null or pe.cut) > 0
  ),
  cmd as (
    select distinct on (x.player_id) x.player_id, x.leader
    from (
      select player_id, leader, count(distinct tid) as n, max(participant_count) as biggest
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

create or replace function stat_rising_players(p_region text, p_end_month date, p_limit int default 3)
returns table (player_name text, reason text, event_name text, participant_count int)
language sql stable as $$
  with month_events as (
    select distinct q.tid, q.player_id
    from region_qualifying_entries(p_region, p_end_month, 1) q
    where q.player_id is not null
  ),
  hist as (
    select
      h.player_id, h.tid, h.participant_count, h.cut,
      w.tid is not null as won,
      row_number() over pl as event_no,
      count(*) filter (where h.cut) over (pl rows between unbounded preceding and 1 preceding) as prior_cuts,
      count(*) filter (where w.tid is not null) over (pl rows between unbounded preceding and 1 preceding) as prior_wins
    from qualifying_player_events h
    left join event_winner_players w on w.tid = h.tid and w.player_id = h.player_id
    where h.player_id in (select player_id from month_events)
      and h.start_date < ((date_trunc('month', p_end_month) + interval '1 month')::timestamp at time zone 'UTC')
    window pl as (partition by h.player_id order by h.start_date, h.tid)
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
    join month_events m on m.player_id = h.player_id and m.tid = h.tid
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

-- Share (0-100) of the end month's qualifying entries in the region that carry a TopDeck account id.
-- Players without one can't be named or counted in player stats.
create function stat_player_coverage(p_region text, p_end_month date)
returns table (month_entries bigint, entries_with_player bigint, pct_entries_with_player double precision)
language sql stable as $$
  select count(*), count(player_id), 100.0 * count(player_id) / nullif(count(*), 0)
  from region_qualifying_entries(p_region, p_end_month, 1)
$$;
