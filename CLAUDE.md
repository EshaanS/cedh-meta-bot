# Field Report

Discord bot that posts weekly or monthly cEDH meta reports, filtered to a region each server configures. The only data source is the TopDeck.gg API v2.

## Current milestone

Milestone 1: ingestion and data-quality tabulation. Do not write Discord code, scaffold Next.js, or compute meta stats until explicitly told.

## Stack

- TypeScript, Node 22.21+, scripts run with tsx
- Postgres on Supabase, accessed with postgres.js. No ORM, no Prisma, no supabase-js.
- Migrations are numbered plain SQL files in db/migrations, applied by a small script
- Later, not now: Vercel, with Next.js route handlers for Discord interactions and a daily cron

## Environments

- Cloud sessions: Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (needs Node >= 22.21). Set it in the cloud environment's variables. Node then prints an experimental-feature warning (`EnvHttpProxyAgent`) to stderr, which is harmless.

## Hard rules

- Never access cedhstats.org, topdeck.gg HTML pages, or anything other than the documented TopDeck API.
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
  - Observed in the 12-month Supabase backfill (November 2026, reported by the user; the local Sep–Oct 2026 test data cannot confirm it): bulk `eventData.country` is absent on all events before February 2026 and appears from February–March 2026 onward. Older events have `state` and often `lat`/`lng`. So country coverage figures above describe post-February events only.
  - Observed in October 2026 data: there is no "Online" address convention. No address was "Online", and only 3 matched online-sounding terms, 2 of them Discord invite links. ~40% of events have no location field at all (no non-blank lat, lng, city, state, address, or country). Whether those are online events is unverified.
- Standings rows include `leader` (the commander name; partners appear as "A / B", alphabetical) when a deck was submitted. Otherwise it is absent. Expect roughly 40% of entries to have no commander.
  - Observed in October 2026 data: `leader` is present on ~34% of standings rows overall, so ~66% have no commander. Coverage rises with event size: ~12% of rows in events under 16 players, ~30% at 16–31, ~69% at 32–63, ~88% at 64+.
  - Observed in October 2026 data: standings rows carry a `players` key only in team events (`isTeamEvent: true`; 1 event and 6 rows that month). Ingestion drops team events.
- The bulk response has no rank/standing column. Preserve the array index, but do not treat it as rank until verified.
- GET /v2/tournaments/{TID}/info returns `location` with name, city, state, country, lat, lng. Every subfield is nullable, and the whole object can be null.
  - Observed in October 2026 data: `location` was never null in 30 sampled calls. Events with no location returned an object with every field null. Keep handling null anyway.
  - Observed in September–October 2026 data: for tournaments with no bulk country, `/info` returned a non-null country 0 of 50 times (95% upper bound 7.1%). Decision: we are not building country enrichment from `/info`.
- State values are inconsistent ("WA" vs "Washington" vs "Lombardia"). Never key regions on raw strings.