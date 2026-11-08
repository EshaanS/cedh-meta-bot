-- Composer v2: official winners for events whose cut isn't recorded as bracket rounds, user-facing region
-- labels, and the month-level stats the newsletter needs. Existing functions keep their outputs.

-- Standing-1 commander from TopDeck's single-tournament standings endpoint, for qualifying 32+ events with
-- topCut = 0 (no bracket recorded; the event may still have had a cut). Filled by scripts/fetch-standings.ts.
-- No player data: the endpoint returns names, IDs and decklists, which are discarded before storage.
create table event_winners (
  tid              text primary key references tournaments (tid) on delete cascade,
  winner_commander text,
  status           text not null check (status in ('found', 'no_standing_1', 'no_commander')),
  fetched_at       timestamptz not null default now()
);

-- User-facing region label; never shows the region type. Sub-national regions get their country:
-- "Washington (United States)". A group named like its country becomes "Portugal (mainland)"; an admin-1 unit
-- named like its country shows the name alone.
create function region_label(p_region text)
returns text
language sql stable as $$
  select case
    when r.type in ('admin1', 'admin1_group') and c.display_name is not null then
      case
        when r.display_name = c.display_name and r.type = 'admin1_group' then r.display_name || ' (mainland)'
        when r.display_name = c.display_name then r.display_name
        else r.display_name || ' (' || c.display_name || ')'
      end
    else r.display_name
  end
  from regions r
  left join regions c on c.type = 'country' and c.id = split_part(r.id, '-', 1)
  where r.id = p_region
$$;

-- The month's scene for qualifying events (16+, cedh or unlabeled_competitive) in the region: event and
-- player counts for the month and the month before, the largest event, and the draw rate.
create function stat_scene(p_region text, p_end_month date)
returns table (
  events bigint, players bigint, prev_events bigint, prev_players bigint,
  largest_event_name text, largest_event_players int, draw_rate double precision
)
language sql stable as $$
  with ev as (
    select t.tid, t.name, t.participant_count, date_trunc('month', t.start_date at time zone 'UTC')::date as m
    from tournaments t
    where t.participant_count >= 16
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and t.tid in (select region_tournament_ids(p_region))
      and date_trunc('month', t.start_date at time zone 'UTC')::date
          in (date_trunc('month', p_end_month)::date, (date_trunc('month', p_end_month) - interval '1 month')::date)
  ),
  cur as (select * from ev where m = date_trunc('month', p_end_month)::date),
  prev as (select * from ev where m < date_trunc('month', p_end_month)::date),
  largest as (select name, participant_count from cur order by participant_count desc, name limit 1)
  select
    (select count(*) from cur),
    (select coalesce(sum(participant_count), 0) from cur),
    (select count(*) from prev),
    (select coalesce(sum(participant_count), 0) from prev),
    (select name from largest),
    (select participant_count from largest),
    (select sum(e.draws)::double precision / nullif(sum(e.wins + e.losses + e.draws), 0)
     from entries e where e.tid in (select tid from cur))
$$;

-- Commanders by top-cut entries (played bracket games) in the end month.
create function stat_top_cut_appearances(p_region text, p_end_month date)
returns table (commander text, top_cut_entries bigint)
language sql stable as $$
  select leader, count(*)
  from region_qualifying_entries(p_region, p_end_month, 1)
  where leader is not null and wins_bracket + losses_bracket > 0
  group by leader
  order by 2 desc, 1
$$;

-- Share trend for every commander seen in the end month or the 3 months before it (no minimum entries).
-- share_change = last share / prior share - 1; null when the commander had no prior entries (is_new) or a
-- side has no entries at all.
create function stat_share_trend(p_region text, p_end_month date)
returns table (
  commander text, last_month_entries bigint, prior3_avg_entries double precision,
  last_month_share double precision, prior3_share double precision, share_change double precision, is_new boolean
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
    leader,
    coalesce(l.n, 0),
    coalesce(p.n, 0) / 3.0,
    coalesce(l.n, 0)::double precision / nullif(t.last_total, 0),
    coalesce(p.n, 0)::double precision / nullif(t.prior_total, 0),
    case when p.n is null or l.n is null or t.prior_total = 0 or t.last_total = 0 then null
         else (l.n::double precision / t.last_total) / (p.n::double precision / t.prior_total) - 1 end,
    p.n is null
  from last_m l
  full join prior p using (leader)
  cross join totals t
  order by 2 desc, 1
$$;

-- The end month's largest qualifying 32+ events with their result. Events with a recorded bracket use
-- tournament_results; topCut = 0 events use the official standing-1 commander from event_winners.
create function stat_month_results(p_region text, p_end_month date, p_limit int default 10)
returns table (tid text, event_name text, participant_count int, result text, result_commanders text)
language sql stable as $$
  select
    t.tid,
    t.name,
    t.participant_count,
    case
      when coalesce(t.top_cut, 0) > 0 then tr.result
      when ew.status = 'found' then 'winner'
      else 'winner not recorded'
    end,
    case when coalesce(t.top_cut, 0) > 0 then tr.result_commanders else ew.winner_commander end
  from tournaments t
  left join tournament_results tr on tr.tid = t.tid
  left join event_winners ew on ew.tid = t.tid
  where t.tid in (select region_tournament_ids(p_region))
    and t.participant_count >= 32
    and t.event_class in ('cedh', 'unlabeled_competitive')
    and date_trunc('month', t.start_date at time zone 'UTC')::date = date_trunc('month', p_end_month)::date
  order by t.participant_count desc, t.name
  limit p_limit
$$;
