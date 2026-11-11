-- Partner validation, step 1: the list of cards that can share the command zone, and an is_valid_pair
-- column on qualifying_entries. No stat reads the column yet, so no stat changes its result.
-- cedhstats excludes invalid partner pairs using Scryfall's oracletag:pair-commander; this is our copy of that
-- list (CLAUDE.md data-source exception). Filled by scripts/fetch-pair-commanders.ts.

-- The key names are compared on: lower case, with typographic apostrophes made straight. TopDeck writes
-- "Kraum, Ludevic’s Opus" with a curly apostrophe in older events. Must match cardNameKey in
-- scripts/lib/scryfall.ts.
create function card_name_key(p_name text)
returns text
language sql immutable parallel safe as $$
  select lower(btrim(translate(p_name, U&'\2018\2019\02BC\0060\00B4', '''''''''''')))
$$;

-- One row per name a pair half can be written as: the card's Oracle name, each face of a "Front // Back"
-- card, and names printed on particular printings (printed_name such as "Will the Wise" for Wernog, Rider's
-- Chaplain; flavor_name such as "Cecil Harvey" for Tymna the Weaver). card_name is the Oracle name.
create table pair_commanders (
  name_key   text primary key,
  name       text not null,
  card_name  text not null,
  fetched_at timestamptz not null default now(),
  constraint pair_commanders_key_matches check (name_key = card_name_key(name))
);

-- Same view as before with is_valid_pair appended (a replaced view can only gain columns at the end):
--   null  the leader is not a pair (no " / "), or pair_commanders has never been filled;
--   true  the leader is exactly two names and both are in pair_commanders;
--   false otherwise.
-- This is membership only. It does not check that the two cards' abilities go together.
-- The joins are on the primary key, so the planner drops them when the column isn't read.
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
  e.player_id,
  case
    when e.leader is null or position(' / ' in e.leader) = 0 then null
    when not exists (select 1 from pair_commanders) then null
    else p1.name_key is not null and p2.name_key is not null and split_part(e.leader, ' / ', 3) = ''
  end as is_valid_pair
from entries e
join tournaments t on t.tid = e.tid
left join pair_commanders p1 on p1.name_key = card_name_key(split_part(e.leader, ' / ', 1))
left join pair_commanders p2 on p2.name_key = card_name_key(split_part(e.leader, ' / ', 2))
where t.participant_count >= 16
  and t.event_class in ('cedh', 'unlabeled_competitive');
