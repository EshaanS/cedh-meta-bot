-- Event results from bracket records. The bulk endpoint has no standing field, so the winner is derived:
--   winner           = the single top-cut row (bracket games played) with the most bracket wins and zero
--                      bracket losses;
--   final drawn      = no such single row, but 2+ top-cut rows share the most bracket wins with zero losses;
--   no single winner = anything else, including events where nobody won a bracket game. A top-4 pod that
--                      drew records no bracket wins or losses, so it lands here, not in 'final drawn'.
-- result_commanders is the winner's commander, or the drawn finalists' commanders ('unknown' when absent).

create view tournament_results as
with cut as (
  select e.tid, e.leader, e.standing_index, e.wins_bracket, e.losses_bracket,
         max(e.wins_bracket) over (partition by e.tid) as max_wins
  from entries e
  join tournaments t on t.tid = e.tid
  where t.top_cut > 0 and e.wins_bracket + e.losses_bracket > 0
),
undefeated_at_max as (
  select tid, count(*) as n, string_agg(coalesce(leader, 'unknown'), '; ' order by standing_index) as commanders
  from cut
  where max_wins > 0 and wins_bracket = max_wins and losses_bracket = 0
  group by tid
)
select
  t.tid,
  case when u.n = 1 then 'winner' when u.n >= 2 then 'final drawn' else 'no single winner' end as result,
  u.commanders as result_commanders
from tournaments t
left join undefeated_at_max u on u.tid = t.tid
where t.top_cut > 0;

drop function stat_notable_results(text, date);

-- Notable results: qualifying events in the end month with 32+ players, with the derived result and the
-- commanders of every entry that played in the top cut. No player names.
create function stat_notable_results(p_region text, p_end_month date)
returns table (
  tid text, event_name text, participant_count int, location text,
  result text, result_commanders text, top_cut_commanders text
)
language sql stable as $$
  select
    t.tid,
    t.name,
    t.participant_count,
    nullif(concat_ws(', ', t.geo_admin1_name, coalesce(cr.display_name, t.geo_country_name)), ''),
    coalesce(tr.result, 'no top cut'),
    tr.result_commanders,
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
  left join tournament_results tr on tr.tid = t.tid
  where t.tid in (select region_tournament_ids(p_region))
    and t.participant_count >= 32
    and t.event_class in ('cedh', 'unlabeled_competitive')
    and date_trunc('month', t.start_date at time zone 'UTC')::date = date_trunc('month', p_end_month)::date
  order by t.participant_count desc, t.name
$$;
