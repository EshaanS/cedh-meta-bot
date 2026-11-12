-- Top players: players with the same wins and top cuts are now ordered by the points they earned in the month,
-- and only then by the largest event they won or cut (which used to be the third key), then by name.
--
-- Points are what PPG counts: 5 per win and 1 per draw, over every game the player played in the region's
-- qualifying events that month (all of their events, not only the ones they won or cut). They are computed
-- from the win and draw counts, whatever scoring the event itself used. As with wins and top cuts, each
-- (event, player) pair counts once: when a player has two standings rows in one event, the row with more
-- points is taken.
--
-- The function returns one more column (points), so it is dropped and created again; nothing else changes.

drop function stat_top_players(text, date, int);

create function stat_top_players(p_region text, p_end_month date, p_limit int default 5)
returns table (player_name text, wins bigint, top_cuts bigint, points bigint, largest_event int, top_commander text)
language sql stable as $$
  with q as (
    select * from region_qualifying_entries(p_region, p_end_month, 1) where player_id is not null
  ),
  pe as (
    select q.tid, q.player_id, min(q.participant_count) as participant_count,
           bool_or(q.wins_bracket + q.losses_bracket > 0) as cut,
           max(5 * q.wins + q.draws) as points
    from q
    group by q.tid, q.player_id
  ),
  perf as (
    select
      pe.player_id,
      count(*) filter (where w.tid is not null) as wins,
      count(*) filter (where pe.cut) as top_cuts,
      coalesce(sum(pe.points), 0)::bigint as points,
      max(pe.participant_count) filter (where w.tid is not null or pe.cut) as largest_event
    from pe
    left join event_winner_players w on w.tid = pe.tid and w.player_id = pe.player_id
    group by pe.player_id
    having count(*) filter (where w.tid is not null or pe.cut) > 0
  ),
  cmd as (
    select distinct on (x.player_id) x.player_id, x.registered_leader
    from (
      select player_id, registered_leader, count(distinct tid) as n, max(participant_count) as biggest
      from q
      where registered_leader is not null
      group by player_id, registered_leader
    ) x
    order by x.player_id, x.n desc, x.biggest desc, x.registered_leader
  )
  select pn.display_name, p.wins, p.top_cuts, p.points, p.largest_event, c.registered_leader
  from perf p
  join player_names pn on pn.player_id = p.player_id and pn.display_name is not null
  left join cmd c on c.player_id = p.player_id
  order by p.wins desc, p.top_cuts desc, p.points desc, p.largest_event desc, pn.display_name
  limit p_limit
$$;
