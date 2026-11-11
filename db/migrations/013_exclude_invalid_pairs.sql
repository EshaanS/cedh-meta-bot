-- Partner validation, step 2: commander stats exclude invalid partner pairs, as cedhstats does, and leader
-- names are normalized so a typographic apostrophe doesn't split one commander into two.
--
-- qualifying_entries.leader is now the commander used for stats:
--   * typographic apostrophes are made straight ("Kraum, Ludevic’s Opus" = "Kraum, Ludevic's Opus"), for
--     single commanders and for both halves of a pair;
--   * null when the leader is an invalid pair (is_valid_pair is false), so every stat that groups or filters
--     on leader drops those entries exactly as it drops entries with no commander.
-- registered_leader is what the player registered (apostrophes normalized, never nulled). It is used where
-- the registered deck should still show: Top players' most-played commander and the share of entries with a
-- decklist. Winners and event results read entries directly and are unchanged.
-- When pair_commanders is empty, is_valid_pair is null and nothing is excluded.

-- Same characters as card_name_key (U+2018, U+2019, U+02BC, backtick, U+00B4), but keeps case and spacing:
-- the result is shown in posts.
create function normalize_leader(p_leader text)
returns text
language sql immutable parallel safe as $$
  select translate(p_leader, U&'\2018\2019\02BC\0060\00B4', '''''''''''')
$$;

-- Column names, order and types are unchanged; leader's expression changes and registered_leader is appended.
create or replace view qualifying_entries as
select
  e.tid,
  e.standing_index,
  case
    when position(' / ' in e.leader) > 0
     and exists (select 1 from pair_commanders)
     and not (p1.name_key is not null and p2.name_key is not null and split_part(e.leader, ' / ', 3) = '')
    then null
    else normalize_leader(e.leader)
  end as leader,
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
  e.player_id,
  case
    when e.leader is null or position(' / ' in e.leader) = 0 then null
    when not exists (select 1 from pair_commanders) then null
    else p1.name_key is not null and p2.name_key is not null and split_part(e.leader, ' / ', 3) = ''
  end as is_valid_pair,
  normalize_leader(e.leader) as registered_leader
from entries e
join tournaments t on t.tid = e.tid
-- The name key is only computed for pair leaders: single commanders and empty leaders join on null.
-- Cost, observed November 2026 with SELECTs emulating this view on Supabase (global, May-October 2026,
-- 59,289 qualifying entries): grouping by commander goes from about 0.06 s to about 0.18 s of server time.
left join pair_commanders p1
  on p1.name_key = case when position(' / ' in e.leader) > 0 then card_name_key(split_part(e.leader, ' / ', 1)) end
left join pair_commanders p2
  on p2.name_key = case when position(' / ' in e.leader) > 0 then card_name_key(split_part(e.leader, ' / ', 2)) end
where t.participant_count >= 16
  and t.event_class in ('cedh', 'unlabeled_competitive');

-- "Entries with decklists" counts every entry that registered a commander, valid pair or not.
create or replace function stat_coverage(p_region text, p_end_month date, p_months int default 6)
returns table (
  events_16plus bigint, qualifying_events bigint, pct_geocoded double precision,
  qualifying_entries bigint, pct_entries_with_leader double precision
)
language sql stable as $$
  with ev as (
    select t.*
    from tournaments t
    where t.participant_count >= 16
      and t.tid in (select r.tid from region_tournament_ids(p_region) as r(tid))
      and date_trunc('month', t.start_date at time zone 'UTC')::date
          between (date_trunc('month', p_end_month) - make_interval(months => p_months - 1))::date
              and date_trunc('month', p_end_month)::date
  ),
  q as (select registered_leader from region_qualifying_entries(p_region, p_end_month, p_months))
  select
    (select count(*) from ev),
    (select count(*) from ev where event_class in ('cedh', 'unlabeled_competitive')),
    (select 100.0 * count(*) filter (where geo_country_code is not null) / nullif(count(*), 0) from ev),
    (select count(*) from q),
    (select 100.0 * count(registered_leader) / nullif(count(*), 0) from q)
$$;

-- Same as migration 011, with the most-played commander taken from registered_leader: a player's deck is
-- shown as registered even when the pairing is invalid.
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
    select distinct on (x.player_id) x.player_id, x.registered_leader
    from (
      select player_id, registered_leader, count(distinct tid) as n, max(participant_count) as biggest
      from q
      where registered_leader is not null
      group by player_id, registered_leader
    ) x
    order by x.player_id, x.n desc, x.biggest desc, x.registered_leader
  )
  select pn.display_name, p.wins, p.top_cuts, p.largest_event, c.registered_leader
  from perf p
  join player_names pn on pn.player_id = p.player_id and pn.display_name is not null
  left join cmd c on c.player_id = p.player_id
  order by p.wins desc, p.top_cuts desc, p.largest_event desc, pn.display_name
  limit p_limit
$$;
