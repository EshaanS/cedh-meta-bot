# Field Report

Discord bot that posts weekly or monthly cEDH meta reports, filtered to a region each server configures. The only data source is the TopDeck.gg API v2.

## Current milestone

Milestone 2: data model for event classification and regions. Milestone 1 (ingestion and data-quality tabulation) is done. Do not write Discord code, scaffold Next.js, or compute meta stats until explicitly told.

## Pipeline

- `npm run migrate`, then `npm run refresh` (backfill the last 2 full months, then classify, then geocode; stops on the first failure). Use `npm run backfill -- --months N` for longer history.
- `classify` recomputes `event_class`, `series_key` and `leader_coverage` for all tournaments and must run after every backfill: new events change series averages. `series_overrides` wins over the computed class.
- `geocode` derives country, admin-1 and admin-1 group from lat/lng only; location strings are never used for regions. It needs the boundary file in `data/` (see Hard rules). Backfill clears the geo fields when a tournament's lat/lng change.
- Stats read from the `qualifying_entries` view (16+ players, `event_class` in cedh or unlabeled_competitive).

## Stack

- TypeScript, Node 22.21+, scripts run with tsx
- Postgres on Supabase, accessed with postgres.js. No ORM, no Prisma, no supabase-js.
- Migrations are numbered plain SQL files in db/migrations, applied by a small script
- Later, not now: Vercel, with Next.js route handlers for Discord interactions and a daily cron

## Environments

- Cloud sessions: Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (needs Node >= 22.21). Set it in the cloud environment's variables. Node then prints an experimental-feature warning (`EnvHttpProxyAgent`) to stderr, which is harmless.

## Hard rules

- The bot and scripts never access cedhstats.org, topdeck.gg HTML pages, or anything other than the documented TopDeck API. Two exceptions:
  - Claude Code may read https://cedhstats.org/about as documentation for stat definitions. Code never fetches cedhstats.org.
  - The Natural Earth boundary file is downloaded once, by hand, into gitignored `data/`, pinned to tag v5.1.2 and verified by SHA-256 in `scripts/geocode.ts`: `curl -o data/ne_10m_admin_1_states_provinces.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson`. Scripts never download it.
- Never request or store player names, player IDs, Discord fields, or decklists. Always pass `columns` explicitly. Whitelist fields before any DB write and drop everything else.
- Every user-facing output, including every future Discord embed, shows "Data provided by TopDeck.gg" with a link to https://topdeck.gg.
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
- Shrinkage: adj = (n x PPG + 20 x 1.25) / (n + 20), with n = games played (W + L + D). Note: the prior is the fixed 1.25, not the draw-adjusted baseline, so in high-draw fields shrunk scores sit slightly above neutral.
- Deck stats only for commanders with at least 0.2% meta share.
- Entries with an unknown commander (no `leader`) are excluded from commander stats.

### Deviations, each with its reason
1. Event filter. cedhstats includes all 16+ events; we also exclude `event_class` casual, unlabeled_casual and test. Reason: casual and bracket nights are ~14% of 16+ events (user's 12-month run) and would otherwise appear in winners and highlights. Counting unlabeled_casual and test too, the filter removed 38.8% of 16+ events in local May–October 2026 data.
2. Region. cedhstats uses normalized location strings; we reverse-geocode lat/lng with Natural Earth admin-1. Reason: every located event has coordinates, while the strings are inconsistent (Cataluña/Catalunya/Catalonia, CA/California).
3. Top-cut membership. cedhstats uses standing <= top_cut; we use bracket games played (wins_bracket + losses_bracket > 0). Reason: the bulk endpoint has no standing field, and array order is not verified as rank. Known gap: a player whose top-cut pod drew counts as not top cut.
4. Partner validation. cedhstats excludes invalid partner pairs using Scryfall `oracletag:pair-commander`; ours is pending (TODO in the `qualifying_entries` view). Fetching Scryfall would need its own exception to the data-source rule.
5. Not implemented: player rating, entry points, Deck of the Month, Rising Star, Floor/Veterans/Ceiling, and all pod and seat stats. Reason: they need player identity (pending TopDeck's answer on its terms) and/or round data, which we don't ingest.
6. Recency. cedhstats refreshes the previous month during the first week of the new month; we re-fetch every month that ended less than 14 days ago on each run.
