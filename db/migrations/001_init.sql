-- Milestone 1 schema.
-- No player names, player IDs, Discord fields, decklists, or event addresses are stored.

create table tournaments (
  tid               text primary key,
  name              text,
  start_date        timestamptz not null,
  participant_count integer not null,             -- length of the API standings array
  swiss_num         integer,
  top_cut           integer,
  average_elo       double precision,
  median_elo        double precision,
  mode_elo          double precision,
  top_elo           double precision,
  lat               double precision,
  lng               double precision,
  city              text,
  state             text,
  country           text,                         -- from bulk eventData; written by backfill
  info_country      text,                         -- from /info; written only by enrichment, never by backfill
  info_checked_at   timestamptz,
  ingested_at       timestamptz not null default now()
);

create index tournaments_country_start_date_idx on tournaments (country, start_date);
create index tournaments_country_state_start_date_idx on tournaments (country, state, start_date);

create table entries (
  tid            text not null references tournaments (tid) on delete cascade,
  standing_index integer not null,                -- position in the API standings array; not verified as rank
  leader         text,
  wins           integer not null,
  draws          integer not null,
  losses         integer not null,
  byes           integer not null,
  wins_swiss     integer not null,
  wins_bracket   integer not null,
  losses_swiss   integer not null,
  losses_bracket integer not null,
  primary key (tid, standing_index)
);

create index entries_leader_idx on entries (leader);

-- One row per bulk window that is old enough to be treated as final.
create table ingest_log (
  window_start        timestamptz primary key,
  window_end          timestamptz not null,
  tournaments         integer not null,
  entries             integer not null,
  team_events_skipped integer not null,
  invalid_skipped     integer not null,
  completed_at        timestamptz not null default now()
);
