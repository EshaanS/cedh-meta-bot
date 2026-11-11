# Field Report

Discord bot that posts weekly or monthly cEDH meta reports, filtered to a region each server configures. The only data source is the TopDeck.gg API v2.

## Current milestone

Milestone 6: player data and player sections (winner names, Top players, Rising players), permitted by TopDeck (`docs/permissions.md`). Milestones 1–5 (ingestion, classification and geocoding, region catalog and stats, post composer, the Discord app on Vercel) are done. The bot is still gated to one private test server: do not open the bot to other servers (ALLOW_ALL_GUILDS, global command registration) until the user approves.

## Pipeline

- `npm run migrate`, then `npm run refresh` (backfill the last 2 full months, then classify, standings, geocode, and regions; stops on the first failure). Use `npm run backfill -- --months N` for longer history; player history uses 36 months.
- Players: backfill stores each standings row's TopDeck player id in `entries.player_id` and upserts `players (player_id, display_name)`, refreshing the name on every ingest (the window's latest event wins). "Deleted User" or a missing name is stored as a null name. Windows logged before player ids existed (`ingest_log.has_players = false`) are fetched again, so `backfill --months 36` is resumable without `--force`.
- Opt-outs: `npm run optout -- add <player_id> [--note "..."] | remove <player_id> | list` manages `player_optouts`. Adding blanks the stored name, and ingest keeps it blank while the opt-out exists. Every output reads names through the `player_names` view, which returns a null name for opted-out players. Never read `players.display_name` directly in a stat, script or post.
- `classify` recomputes `event_class`, `series_key` and `leader_coverage` for all tournaments and must run after every backfill: new events change series averages. `series_overrides` wins over the computed class.
- `geocode` derives country, admin-1 and admin-1 group from lat/lng only; location strings are never used for regions. It needs the boundary file in `data/` (see Hard rules). Backfill clears the geo fields when a tournament's lat/lng change.
- Stats read from the `qualifying_entries` view (16+ players, `event_class` in cedh or unlabeled_competitive).
- `regions` adds every country, admin-1 group and admin-1 unit with a qualifying event in the last 12 months (ids like `us`, `es-cataluna`, `us-wa`). It never deletes regions or changes seeded ones. Fallback parents: admin-1 -> group -> country -> macro -> global.
- Stats are SQL functions taking `(region_id, end_month)`: `region_reportability`, `resolve_region`, `stat_meta_share`, `stat_ppg`, `stat_conversion`, `stat_growth`, `stat_notable_results`, `stat_coverage`, plus the player stats `stat_top_players` and `stat_rising_players` (see Player stats below). `npm run report -- --region <id> --month YYYY-MM` prints them for review.
- `scripts/lib/post.ts` composes the monthly post (v2 newsletter): `loadPostData` reads the stat functions, `composePost` (pure) returns a Discord embed and a text preview. Sections: scene this month, winners (up to 10 largest qualifying 32+ events, with the winner's name), top players, rising players, top-cut appearances, most played (6-month snapshot, no movement markers; Rising commanders and Cooling commanders show movement), best results, top-cut conversion, rising commanders, cooling commanders, coverage, Sources. The two player sections need no decklists, so they also show for non-reportable regions. In Winners an opted-out winner is "a player" and a winner with no known name shows the commander alone; opted-out and removed players never appear in the player sections. Thresholds and caps are in `POST_CONFIG`; posts stay under a 3,000-character content budget and Discord's embed limits (bottom sections trim first; the player sections trim after the commander sections and before Winners), and organizer text and player names are sanitized. With all sections full the global post exceeds the budget, so its rising and cooling commanders sections are usually trimmed. Region labels come from `region_label` and never show the region type. `npm run preview -- --region <id> --month YYYY-MM` prints a post; `npm test` runs the composer tests on fixtures in `test/fixtures` (no database).
- `standings` (scripts/fetch-standings.ts) fills `event_winners` with the official standing-1 commander and player id for qualifying 32+ events with topCut = 0, once per event, 1 request per second, and upserts that player into `players`. Rows fetched before player ids were stored (`player_checked_at` is null) are fetched once more.
- Discord app: `guild_configs` holds each server's region (default global), channel and last posted month. `regions.selectable` controls what `/region set` offers (every country; groups in ES, IT, GB, FR, PT; admin-1 in US, CA, DE, AU). Commands: `/region set|show`, `/channel set`, `/preview`, admin-only (Manage Server), deferred when they touch the DB. The cron posts the previous month's report on or after the 15th, only when `ingest_log` has that month, claims each guild atomically (at most one post per month), sends every message with `allowed_mentions: { parse: [] }`, and prunes configs for guilds the bot has left (there is no HTTP event for removal).
- Guild gate: `ALLOWED_GUILD_IDS` (comma-separated) fails closed; only `ALLOW_ALL_GUILDS=true` opens the bot to every server. Register commands with `npm run register-commands -- --guild <id>`; `--global` needs `--confirm-global`. Setup steps: `docs/deploy.md`.
- Tests: `npm test`. The Postgres-backed tests in `test/discord-db.test.ts` run only when `TEST_DATABASE_URL` is set.

## Stack

- TypeScript, Node 22.21+, scripts run with tsx
- Postgres on Supabase, accessed with postgres.js. No ORM, no Prisma, no supabase-js.
- Migrations are numbered plain SQL files in db/migrations, applied by a small script
- Next.js 16 (app router, pinned 16.4.3) on Vercel: `app/api/interactions` (signed Discord interactions), `app/api/cron` (daily, `vercel.json`), and an install/privacy page. Server code is in `src/server/`. No discord.js: plain REST over fetch; Ed25519 via Node crypto.
- Relative imports have no file extension (`./lib/db`): Next's Turbopack does not map `.js` imports to `.ts` files; `tsx` and `moduleResolution: bundler` handle extensionless imports.
- On Vercel, `DATABASE_URL` is the Supabase transaction pooler (port 6543); `connect()` already sets `prepare: false`.

## Environments

- Cloud sessions: Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (needs Node >= 22.21). Set it in the cloud environment's variables. Node then prints an experimental-feature warning (`EnvHttpProxyAgent`) to stderr, which is harmless.

## Hard rules

- Data comes only from the documented TopDeck API. The bot also calls the Discord API to answer commands and deliver posts, and uses Supabase as its database. The bot and scripts never access cedhstats.org, topdeck.gg HTML pages, or any other data source. Two exceptions:
  - Claude Code may read https://cedhstats.org/about as documentation for stat definitions. Code never fetches cedhstats.org.
  - The Natural Earth boundary file is downloaded once, by hand, into gitignored `data/`, pinned to tag v5.1.2 and verified by SHA-256 in `scripts/geocode.ts`: `curl -o data/ne_10m_admin_1_states_provinces.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson`. Scripts never download it.
- Player data (permitted by TopDeck, `docs/permissions.md`, on condition that we keep attribution, keep names current and honor privacy requests):
  - Store the TopDeck player id and display name only. Never request or store decklists or Discord fields.
  - Refresh names on every ingest.
  - Treat "Deleted User" or a missing name as removed: store a null name and never show the player.
  - Honor the opt-out list (`player_optouts`) in every output: posts, `/preview`, `report`, logs and fixtures. Read names only through the `player_names` view.
  - Scripts and logs print player ids or counts, never names, except the outputs that exist to show them (posts, `/preview`, `preview`, `report`). Committed fixtures use invented names.
- Always pass `columns` explicitly. Whitelist fields before any DB write and drop everything else. Exception: the single-tournament standings endpoint (GET /v2/tournaments/{TID}/standings) ignores `columns` and always returns every player's name, ID and decklist. Only the standing-1 row's `standing`, `leader`, `id` and `name` are read (`pickStandingOne`); every other row and field, including decklists, is discarded in memory and never printed, logged or stored.
- Every message that displays TopDeck-derived data (monthly posts, `/preview`) shows "Data provided by TopDeck.gg" with a link to https://topdeck.gg. Pure configuration replies that show no TopDeck data (`/region set`, `/channel set`, `/region show` without stats) don't carry it.
- The API key comes from env only and is never logged or printed.
- Make requests sequentially. Honor 429 responses and the Retry-After header. The default limit is 100 req/min, but the bulk endpoint has a lower, unpublished limit, so pace bulk calls conservatively.
- Every script must be idempotent and resumable: use upserts, and skip work that is already done.
- Explain why before adding any dependency.
- Do not expand scope beyond the task given.
- Supabase Data API is disabled; access is only via postgres.js as the table owner. Automatic RLS is on with no policies. If queries ever return unexpectedly empty, check which role is connected.

## TopDeck API facts (from docs unless labeled "Observed"; verify against real responses)

- Base URL: https://topdeck.gg/api. Header: `Authorization: <key>` with no "Bearer" prefix.
- Bulk search: POST /v2/tournaments with `{ game: "Magic: The Gathering", format: "EDH", start, end, columns }`. Dates are unix seconds. Returns completed events only. League events are excluded unless `leagues: true`.
  - Observed in November 2026 testing: a bulk call made a few seconds after the previous one returned 429 with `Retry-After: 8`. Seen once so far. Keep pacing bulk calls (backfill waits 10 s between them) and always honor Retry-After.
- Bulk `eventData` is documented as lat, lng, city, state, address, headerImage. It has no country field. `address` is organizer free text and can be "Online".
  - Observed in October 2026 data: bulk `eventData` does include `country`, present on ~56% of events (912 of 1632) and non-blank on ~55%. This contradicts the docs.
  - Observed in the 12-month Supabase backfill (November 2026, reported by the user; the local Sep–Oct 2026 test data cannot confirm it): bulk `eventData.country` is absent on all events before February 2026 and appears from February–March 2026 onward. So country coverage figures above describe post-February events only.
  - Observed in the 12-month Supabase backfill (November 2026, reported by the user): every event with a country also has lat/lng (100%, every month), and no event has a state or country string without lat/lng. About 26.5% of 16+ events have no location at all. This supersedes an earlier note that older events "have state and often lat/lng": lat/lng is the most complete location field.
  - Observed in October 2026 data: there is no "Online" address convention. No address was "Online", and only 3 matched online-sounding terms, 2 of them Discord invite links. ~40% of events have no location field at all (no non-blank lat, lng, city, state, address, or country). Whether those are online events is unverified.
- Standings rows include `leader` (the commander name; partners appear as "A / B", alphabetical) when a deck was submitted. Otherwise it is absent. Expect roughly 40% of entries to have no commander.
  - Observed in October 2026 data: `leader` is present on ~34% of standings rows overall, so ~66% have no commander. Coverage rises with event size: ~12% of rows in events under 16 players, ~30% at 16–31, ~69% at 32–63, ~88% at 64+.
  - Observed in the 12-month Supabase backfill (November 2026, reported by the user): per-event leader coverage of unlabeled events is bimodal, 38% at 0% and 38% at 75% or more. This is why unlabeled events are classified by their series' average coverage.
  - Observed in October 2026 data: standings rows carry a `players` key only in team events (`isTeamEvent: true`; 1 event and 6 rows that month). Ingestion drops team events.
- The bulk response has no rank/standing column. Preserve the array index, but do not treat it as rank until verified.
  - Observed in November 2026 (user's check of Breach the Bay 2 on TopDeck): topCut = 0 means no bracket was recorded, not that there was no cut. That event had a top 16 that isn't recorded as bracket rounds, used Japanese point-pool scoring instead of 5/1/0, and TopDeck names its winner. Swiss points therefore cannot rank these events.
- GET /v2/tournaments/{TID}/standings (observed November 2026) returns one row per player with name, id, leader, decklist, deckObj, standing, points, winRate, opponentWinRate. It ignores `columns`. Standing 1's `leader` for Breach the Bay 2 matched the winner TopDeck shows. Of 38 local qualifying 32+ events with topCut = 0, 28 had a standing-1 commander and 10 had a standing 1 without one.
- GET /v2/tournaments/{TID}/info returns `location` with name, city, state, country, lat, lng. Every subfield is nullable, and the whole object can be null.
  - Observed in October 2026 data: `location` was never null in 30 sampled calls. Events with no location returned an object with every field null. Keep handling null anyway.
  - Observed in September–October 2026 data: for tournaments with no bulk country, `/info` returned a non-null country 0 of 50 times (95% upper bound 7.1%). Decision: we are not building country enrichment from `/info`.
- State values are inconsistent ("WA" vs "Washington" vs "Lombardia"). Never key regions on raw strings.
## Geocoding facts (Natural Earth 1:10m admin-1, v5.1.2)

- Observed in November 2026: admin-1 granularity differs by country. US and Canada are states and provinces; Germany has 16 states; Spain has 52 provinces; Italy has 110 provinces; France has 101 departments; the UK has 232 counties and unitary authorities. Check a country's level before defining admin-1 regions there.
- `geo_admin1_group_code` / `geo_admin1_group_name` hold one grouping level per country, chosen in `scripts/geocode.ts`: Natural Earth `region` where at least 90% of the country's features have a `region_cod` (Spain's autonomous communities, Italy's regions, France's regions); else `geonunit` where the country has 2+ (UK nations, Belgian regions); else `region` where at least 90% have one (US census regions, e.g. US-WEST); else none (Germany). Group codes are `<ISO2>-<SLUG of the group name>`, e.g. ES-CATALUNA, GB-SCOTLAND, because Natural Earth's `region_cod` values are inconsistent (13 formats, duplicates such as Ceuta and Melilla both `ES.CE`).
- `iso_a2` is a real code for every country we have seen; only 12 disputed or special features use -1/-99 (e.g. Northern Cyprus, Somaliland), and those geocode with a null country code.
- Observed in November 2026 testing: 1:10m borders are coarse at border cities. One Detroit riverfront venue geocoded to Ontario; that was the only country mismatch against the bulk country string in 3,763 events.

## Stat definitions

- Stat definitions follow https://cedhstats.org/about. Any deviation must be listed below with its reason.
- Comparison source: the user's reading of cedhstats.org/about, given to Claude Code on 2026-11-07 (Claude Code could not fetch the page from the cloud session).

### Same as cedhstats
- Points per game: PPG = (5W + 1D) / (W + L + D).
- Neutral baseline: 1.25 - 0.25 x draw rate (a random seat in a 4-player pod).
- Shrinkage: adj = (n x PPG + 20 x 1.25) / (n + 20). The target is the fixed 1.25, confirmed from cedhstats' Sleeper Pick and Meta Trap definitions. Note: 1.25 is not the draw-adjusted baseline, so in high-draw fields shrunk scores sit slightly above neutral.
  - n = entries (inferred, not stated): cedhstats does not define n, but every other sample size on its page is counted in entries (75+ entries, 16 decklists, 0.2% meta share).
- Deck stats only for commanders with at least 0.2% meta share.
- Entries with an unknown commander (no `leader`) are excluded from commander stats.

### Deviations, each with its reason
1. Event filter. cedhstats includes all 16+ events; we also exclude `event_class` casual, unlabeled_casual and test. Reason: casual and bracket nights are ~14% of 16+ events (user's 12-month run) and would otherwise appear in winners and highlights. Counting unlabeled_casual and test too, the filter removed 38.8% of 16+ events in local May–October 2026 data, but only 5.2% of their entries with a leader (2,256 of 43,565; 31.3% of all entries), because the removed events rarely record commanders.
2. Region. cedhstats uses normalized location strings; we reverse-geocode lat/lng with Natural Earth admin-1. Reason: every located event has coordinates, while the strings are inconsistent (Cataluña/Catalunya/Catalonia, CA/California).
3. Top-cut membership. cedhstats uses standing <= top_cut; we use bracket games played (wins_bracket + losses_bracket > 0). Reason: the bulk endpoint has no standing field, and array order is not verified as rank. Known gap: a player whose top-cut pod drew counts as not top cut. Events with topCut = 0 can still have had an unrecorded cut; their entries count toward no top-cut stats (conversion, top-cut appearances).
4. Partner validation. cedhstats excludes invalid partner pairs using Scryfall `oracletag:pair-commander`; ours is pending (TODO in the `qualifying_entries` view). Fetching Scryfall would need its own exception to the data-source rule.
5. Not implemented: player rating, entry points, Deck of the Month, Rising Star, Floor/Veterans/Ceiling, and all pod and seat stats. Reason: they need round data, which we don't ingest, or rating models we haven't built. Our Top players and Rising players sections are our own definitions (Player stats below), not cedhstats'.
6. Recency. cedhstats refreshes the previous month during the first week of the new month; we re-fetch every month that ended less than 14 days ago on each run.
7. Deck-stat minimum. cedhstats shows deck stats for commanders at 0.2%+ meta share; we also require at least 10 qualifying entries with a leader in the window, for PPG and top-cut conversion (`stat_eligible_commanders`). Reason: the 0.2% floor is calibrated at global scale (0.2% is about 86 entries locally); in a region it admits 2-entry commanders (Washington: 70 of 89 PPG rows were under 10 entries). 10 matches the reportability threshold, so the stats and the reportable test cover the same commanders.
8. Event winner. cedhstats takes the winner from standings (rank 1); we derive it from bracket records in the `tournament_results` view, because the bulk endpoint has no standing field. Winner = the single top-cut entry with the most bracket wins and zero bracket losses. If none: 'final drawn' when 2+ top-cut entries share the most bracket wins with zero losses, else 'no single winner'; events with topCut = 0 (no bracket recorded) use the official standing-1 commander from TopDeck's standings endpoint (`event_winners`), shown as 'winner', or 'winner not recorded' when it has none. Observed in local May–October 2026 data (qualifying events with topCut > 0): the rule finds a winner in 1,248 of 1,396 events (89.4%), and every one of them is standings array index 0; 146 are 'no single winner' and 2 'final drawn'. Index 0 alone is not a safe winner: it has strictly the most bracket wins in only 67.8% of these events. A top-4 pod that drew records no bracket games, so it shows as 'no single winner', not 'final drawn'. The winning player comes from the same row (`tournament_results.winner_player_id`), or from the standing-1 row for topCut = 0 events (`event_winners.winner_player_id`).

### Player stats (our own definitions, not from cedhstats)
- Events: the region's qualifying events (16+, cedh or unlabeled_competitive) in the end month. Winners stays 32+.
- Event win: an event whose result is 'winner' (`event_winner_players`). A standing-1 player with no recorded commander is 'winner not recorded' and counts as no win.
- Top cut: bracket games played, as in deviation 3, so topCut = 0 events give no top cuts.
- Top players (`stat_top_players`): up to 5 players with at least one win or top cut, ordered by wins, then top cuts, then the largest event they won or cut; shown with their most-played commander that month.
- Rising players (`stat_rising_players`): up to 3 players, largest event first, whose win or top cut in the region that month is their first event win in our data, their first top cut in our data, or a top cut within their first 5 recorded events. History is the player's qualifying events worldwide, not only in the region, and goes back only as far as the backfill (36 months), so "first" means first in that window.
- Entries with no player id count for no player. Players with a null name (removed or opted out) are left out of both lists.
