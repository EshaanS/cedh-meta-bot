-- Post polish: when a commander was first seen, top-cut share against field share, and one rising player per
-- event. No other stat changes.

-- stat_share_trend gains first_seen: the UTC date of the commander's first qualifying entry anywhere in our
-- data (not only in the region), up to the end month. The post calls a commander "new since <date>" when that
-- date is recent, even if it already had a few entries in the prior 3 months.
-- first_seen reads entries directly rather than qualifying_entries: it needs no pair validation (commanders
-- in the trend are valid already), and skipping the pair-list joins takes the pass over all qualifying entries
-- from about 1.0 s to about 0.36 s of server time (observed November 2026 on Supabase, 190,000 entries).
drop function stat_share_trend(text, date);

create function stat_share_trend(p_region text, p_end_month date)
returns table (
  commander text, last_month_entries bigint, prior3_avg_entries double precision,
  last_month_share double precision, prior3_share double precision, share_change double precision, is_new boolean,
  first_seen date
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
  prior as (select leader, count(*) as n from q where m < date_trunc('month', p_end_month)::date group by leader),
  trend as (
    select
      leader,
      coalesce(l.n, 0) as last_month_entries,
      coalesce(p.n, 0) / 3.0 as prior3_avg_entries,
      coalesce(l.n, 0)::double precision / nullif(t.last_total, 0) as last_month_share,
      coalesce(p.n, 0)::double precision / nullif(t.prior_total, 0) as prior3_share,
      case when p.n is null or l.n is null or t.prior_total = 0 or t.last_total = 0 then null
           else (l.n::double precision / t.last_total) / (p.n::double precision / t.prior_total) - 1 end as share_change,
      p.n is null as is_new
    from last_m l
    full join prior p using (leader)
    cross join totals t
  ),
  seen as (
    select normalize_leader(e.leader) as leader, min(t.start_date at time zone 'UTC')::date as first_seen
    from entries e
    join tournaments t on t.tid = e.tid
    where e.leader is not null
      and t.participant_count >= 16
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and t.start_date < ((date_trunc('month', p_end_month) + interval '1 month')::timestamp at time zone 'UTC')
    group by 1
  )
  select tr.leader, tr.last_month_entries, tr.prior3_avg_entries, tr.last_month_share, tr.prior3_share,
         tr.share_change, tr.is_new, s.first_seen
  from trend tr
  left join seen s on s.leader = tr.leader
  order by tr.last_month_entries desc, tr.leader
$$;

-- stat_top_cut_appearances gains the numbers for "share of cuts vs share of field":
--   field_entries          the commander's entries in the month's events that had a top cut;
--   total_top_cut_entries  all top-cut entries with a commander in those events;
--   total_field_entries    all entries with a commander in those events.
-- An event "had a top cut" when any of its entries played bracket games (the top-cut definition used
-- everywhere, deviation 3), not when top_cut > 0: two older events record bracket games with top_cut = 0.
-- Entries in events with no recorded cut are left out of the field, or a commander popular there would look
-- as if it underperformed. Commanders and cut counts are the same as before; order is unchanged.
drop function stat_top_cut_appearances(text, date);

create function stat_top_cut_appearances(p_region text, p_end_month date)
returns table (
  commander text, top_cut_entries bigint, field_entries bigint,
  total_top_cut_entries bigint, total_field_entries bigint
)
language sql stable as $$
  with m as (
    select leader, (wins_bracket + losses_bracket > 0) as cut,
           bool_or(wins_bracket + losses_bracket > 0) over (partition by tid) as event_has_cut
    from region_qualifying_entries(p_region, p_end_month, 1)
  ),
  q as (select leader, cut from m where event_has_cut and leader is not null),
  totals as (select count(*) filter (where cut) as cuts, count(*) as field from q)
  select q.leader, count(*) filter (where q.cut), count(*), t.cuts, t.field
  from q
  cross join totals t
  group by q.leader, t.cuts, t.field
  having count(*) filter (where q.cut) > 0
  order by 2 desc, 1
$$;

-- Rising players: at most one player per event, so the list covers several tournaments. Each player's best
-- qualifying event is chosen first (as before), players with no visible name are dropped, and then within an
-- event the pick is by reason (first win, first top cut, early top cut), then most bracket wins, then name.
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
  ),
  named as (
    select b.player_id, b.tid, b.participant_count, b.reason_rank, pn.display_name,
           (select coalesce(max(e.wins_bracket), 0) from entries e where e.tid = b.tid and e.player_id = b.player_id) as bracket_wins
    from best b
    join player_names pn on pn.player_id = b.player_id and pn.display_name is not null
  ),
  per_event as (
    select distinct on (tid) tid, participant_count, reason_rank, display_name
    from named
    order by tid, reason_rank, bracket_wins desc, display_name
  )
  select
    pe.display_name,
    case pe.reason_rank when 1 then 'first win' when 2 then 'first top cut' else 'early top cut' end,
    t.name,
    pe.participant_count
  from per_event pe
  join tournaments t on t.tid = pe.tid
  order by pe.participant_count desc, pe.reason_rank, pe.display_name
  limit p_limit
$$;
