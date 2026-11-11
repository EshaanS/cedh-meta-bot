-- Keep TopDeck account ids only. Observed November 2026 (36-month backfill): ids are either 28 characters
-- (accounts, 6.1 events each on average) or 20 characters, and every one of the 82,394 20-character ids
-- appears in exactly one event: they are per-event ids for players without an account. Such an id can't
-- link a player across events and can't carry an opt-out, so those players are not stored or named.
-- Ingestion applies the same rule (playerId in scripts/lib/topdeck.ts).

update entries set player_id = null where player_id is not null and player_id !~ '^[A-Za-z0-9]{28}$';
update event_winners set winner_player_id = null where winner_player_id is not null and winner_player_id !~ '^[A-Za-z0-9]{28}$';
delete from players where player_id !~ '^[A-Za-z0-9]{28}$';

alter table entries add constraint entries_player_id_account check (player_id ~ '^[A-Za-z0-9]{28}$');
alter table event_winners add constraint event_winners_player_id_account check (winner_player_id ~ '^[A-Za-z0-9]{28}$');
alter table players add constraint players_player_id_account check (player_id ~ '^[A-Za-z0-9]{28}$');
