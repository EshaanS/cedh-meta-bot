# Field Report

Discord bot that posts weekly or monthly cEDH meta reports, filtered to a region each server configures. The only data source is the TopDeck.gg API v2.

## Current milestone

Milestone 1: ingestion and data-quality tabulation. Do not write Discord code, scaffold Next.js, or compute meta stats until explicitly told.

## Stack

- TypeScript, Node 20+, scripts run with tsx
- Postgres on Supabase, accessed with postgres.js. No ORM, no Prisma, no supabase-js.
- Migrations are numbered plain SQL files in db/migrations, applied by a small script
- Later, not now: Vercel, with Next.js route handlers for Discord interactions and a daily cron

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

## TopDeck API facts (from docs; verify against real responses)

- Base URL: https://topdeck.gg/api. Header: `Authorization: <key>` with no "Bearer" prefix.
- Bulk search: POST /v2/tournaments with `{ game: "Magic: The Gathering", format: "EDH", start, end, columns }`. Dates are unix seconds. Returns completed events only. League events are excluded unless `leagues: true`.
- Bulk `eventData` is documented as lat, lng, city, state, address, headerImage. It has no country field. `address` is organizer free text and can be "Online".
- Standings rows include `leader` (the commander name; partners appear as "A / B", alphabetical) when a deck was submitted. Otherwise it is absent. Expect roughly 40% of entries to have no commander.
- The bulk response has no rank/standing column. Preserve the array index, but do not treat it as rank until verified.
- GET /v2/tournaments/{TID}/info returns `location` with name, city, state, country, lat, lng. Every subfield is nullable, and the whole object can be null.
- State values are inconsistent ("WA" vs "Washington" vs "Lombardia"). Never key regions on raw strings.