# Deploying Field Report to one private test server

Nothing here posts outside your test server. The guild gate fails closed: with no `ALLOWED_GUILD_IDS` and no
`ALLOW_ALL_GUILDS=true`, the bot answers no commands and posts nothing.

## 1. Discord application (Discord Developer Portal)
1. Create an application named Field Report.
2. **General Information:** copy the Application ID and the Public Key.
3. **Bot:** reset and copy the token. Leave every privileged gateway intent off; the bot uses none.
4. **Installation:** set the install link to None. We use our own link on the site's home page.

## 2. Vercel project (dashboard)
1. Import this GitHub repo. The framework preset is Next.js, and the build command is `npm run build`.
2. Under Settings → Environment Variables, add these for Production (and Preview if you test there):

   | name | value |
   |---|---|
   | `DISCORD_APP_ID` | Application ID |
   | `DISCORD_PUBLIC_KEY` | Public Key (64 hex characters) |
   | `DISCORD_BOT_TOKEN` | bot token |
   | `DATABASE_URL` | Supabase **transaction pooler** URI, port **6543**, plus `?sslmode=require` |
   | `CRON_SECRET` | a long random string |
   | `ALLOWED_GUILD_IDS` | your test server's ID (right-click the server → Copy Server ID, with Developer Mode on) |
   | `CONTACT_EMAIL` | shown on the privacy page; players write here to ask not to be named, so set it before posting |

3. Deploy, then open `https://<your-app>.vercel.app/`. The page should show an "Add Field Report to a server" link.
4. `vercel.json` schedules `/api/cron` daily at 15:17 UTC. Vercel sends `Authorization: Bearer $CRON_SECRET` itself.

## 3. Point Discord at the app
In the Developer Portal, under General Information → Interactions Endpoint URL, enter
`https://<your-app>.vercel.app/api/interactions` and save. Discord checks it with a PING and a request with a
bad signature; saving only succeeds if the app answers both correctly.

## 4. Register commands in your test server only (from your machine)
Add these to `.env`: `DISCORD_APP_ID=…` and `DISCORD_BOT_TOKEN=…`.
```
npm run register-commands -- --guild <test server id>
```

## 5. Install and try it
1. Open the install link from the home page and add the bot to your test server. It asks for View Channel,
   Send Messages and Embed Links only.
2. In the server, as someone with Manage Server:
   - `/region set` → type "pacific" and pick Pacific Northwest. It replies ephemerally.
   - `/channel set` → pick a text channel. A confirmation message appears in that channel.
   - `/region show` → shows the region, the channel, and when the next report is due.
   - `/preview` → shows last month's report, visible only to you.

## 6. Trigger the cron by hand
A month can only be posted once `ingest_log` has it. That happens when `npm run refresh` runs at least 14
days after the month ends.
```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-app>.vercel.app/api/cron?month=2026-09&dry_run=1"
```
```
curl -H "Authorization: Bearer <CRON_SECRET>" "https://<your-app>.vercel.app/api/cron?month=2026-09"
```
The second call posts once to your test channel. Run it again: `posted` is empty and nothing new appears.

## 7. Removal
Kick the bot from the test server. The next cron run lists the bot's guilds and deletes that server's settings.

## Custom regions
A server admin can build a region from places and use it as the server's region. Needs migration 015; after
deploying it, register the commands again (`npm run register-commands -- --guild <id>`) so Discord learns the
new subcommands.

- `/region create name:Seattle Metro`, then `/region add`. Start typing in `place` and pick from the list:
  cities appear only when they have events in the data, labelled with state, country and event count.
  States, countries, continents and Pacific Northwest can be added too.
- Several places in one command: `place`, `place2` … `place5` each take one pick, and `list` takes typed text,
  for example `list:Tacoma, Issaquah, Lacey, Vancouver BC`. A name that fits more than one place ("Vancouver")
  is never guessed: the reply lists the options. If a place is written with a comma ("Portland, Oregon"), put
  semicolons between places. The reply says what was added, what was already there, and what was not added
  and why. `/region remove` takes the same options.
- `/region set` lists the server's own regions first. `/region show` lists the places. `/region remove`,
  `/region delete` and `/region list` do what they say.
- A city is where the venue is, not the metro area around it: there are no events in Seattle itself, but there
  are in Tacoma, Issaquah and Lacey. For a metro, use a radius: `/region add around:Seattle km:50` adds
  everything within 50 km of Seattle as one place (10 to 200 km; 50 if `km` is left out). It can also be
  written in the list: `50 km of Seattle`.
- A region's report uses only that region's events in the report month. A small region therefore shows short
  lists, Best results and Top-cut conversion only when a commander has 10 or more entries in the month, and
  the single line "No qualifying events in <region> in <Month>." when the month had none. Nothing is borrowed
  from a larger region.
- Limits: 5 custom regions per server, 25 places per region (a radius is one place), names up to 40 characters
  (`REGION_CONFIG` in `src/server/custom-regions.ts`).

### Radius centers (migration 016, once)
The `around` option offers every city with events in the data, plus the cities in Natural Earth's populated
places (so Seattle can be a center although it has no events). The second list is loaded once from a pinned
file; the bot reads the table and never the file. Without it, only cities with events are offered.

```
curl -o data/ne_10m_populated_places_simple.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_populated_places_simple.geojson
npm run migrate
npm run places
npm run register-commands -- --guild <test server id>
```

`npm run places` checks the file's SHA-256, needs the admin-1 boundary file in `data/` as `geocode` does, and
prints how many places it stored (7,342). It is not part of `refresh`: the file is pinned and does not change.
Running it again changes nothing. Register the commands after deploying, because `/region add` and
`/region remove` have new options.

## Post look and color circles (migration 017)
The monthly post is one message with up to four embeds: the month in numbers with a three-line headline,
players, commanders, and a last one with coverage and the TopDeck attribution. Everything in it describes the
report month and the server's own region: lists are a top 5 (top 3 for rising players and rising and cooling
commanders), every item takes two lines, and a blank line separates items. Every visual element (headline,
medals, line icons, bold names, two-line items, blank lines, share bars, color circles, embed titles and
colors) is a switch in `POST_CONFIG` in `scripts/lib/post.ts`.

The color circles after a commander's details (⚪ 🔵 ⚫ 🔴 🟢, 🔘 for colorless) come from Scryfall's color
identity, stored in `commander_colors`. The bot reads the table and never calls Scryfall. Until the table is
filled the post simply shows no circles. ⚪ and ⚫ can fade into Discord's light and dark backgrounds; the
symbols are one `POST_CONFIG` entry (`colorSymbols`).

```
npm run migrate
npm run color-identity
```

`npm run color-identity` makes one Scryfall search (about 23 pages, 1 request per second), stores names and
color identity only (no images), and prints how many names it stored (about 4,200). It skips the fetch when
the list is under 24 hours old (`--force` overrides) and is the last step of `npm run refresh`, so new
commanders get their colors every month. `npm run color-report` is read-only and shows which registered
commanders have no match. The commands didn't change, so `register-commands` is not needed.

After deploying, run `/preview` and look at it on a light and a dark theme, on desktop and on a phone.

## Color identity pies (no migration)

A commander's colors can show as one pie emoji in place of the row of circles: a small circle cut into equal
wedges, one per color. The pies are application emoji, which the bot can use in every server without any extra
permission. There are 32 (one per color identity), drawn by the project itself; no image is stored in the
repository or the database.

```
npm run color-emoji -- --out pies     # optional: writes the 32 PNGs and pies/sheet.png to look at; no Discord call
npm run color-emoji                   # uploads the pies the application doesn't have yet
```

The upload needs `DISCORD_APP_ID` and `DISCORD_BOT_TOKEN` in `.env`, makes 33 Discord calls (one list, 32
uploads), and is safe to run again. The uploaded emoji appear in the Developer Portal under the application's
Emojis tab. Nothing has to be deployed afterwards beyond the code itself: the app reads its emoji list from
Discord when it posts (kept for ten minutes), so `/preview` shows pies within ten minutes of the upload. Run it
once per Discord application (a test application and a production one each need their own).

- `npm run color-emoji -- --replace` deletes the pies and uploads them again; use it after changing the
  drawing (`PIE_CONFIG` in `scripts/lib/color-pie.ts`).
- `npm run color-emoji -- --remove` deletes them; posts show circles again. Setting `colorPies: 0` in
  `POST_CONFIG` does the same without touching Discord.
- A color identity with no pie, a failed call to Discord, or a missing `DISCORD_APP_ID` on Vercel all mean
  circles; the post is never held back for a pie.
- `pies/` is not in `.gitignore`; write the review images outside the repository or delete them afterwards.

Then run `/preview` and check the pies on a light and a dark theme, on desktop and on a phone: the white wedge
on light, the black wedge on dark, and whether four and five colors can be told apart at message size.

## Top players by points (migration 018)

Players with the same wins and top cuts are ordered by the points they earned that month (5 per win, 1 per
draw, over all their games in the region's qualifying events), then by the largest event they won or cut, then
by name. The header says so and every line shows the points. Partner pairs also use short names for halves
that have no comma to cut at (Kraum / Tymna in place of Kraum / Tymna the Weaver); the list is
`pairNicknames` in `POST_CONFIG`.

```
npm run migrate
```

Run it **before** deploying this version. The new code reads a `points` column that only the new function
returns, so the new code on the old function fails (`/preview` answers "Something went wrong" and the cron
posts nothing). The old code on the new function keeps working, so there is no gap in between. The commands
didn't change, so `register-commands` is not needed.

## Player data and opt-outs
Reports name event winners and top players. TopDeck permits this on condition that we keep the attribution,
keep names current, and honor privacy requests (`docs/permissions.md`).

- First run after migration 008: `npm run migrate`, then `npm run backfill -- --months 36` (player history; it
  re-fetches months that were ingested before player ids were stored), then `npm run classify`,
  `npm run standings`, `npm run geocode`, `npm run regions`. After that, `npm run refresh` as before.
- When a player asks not to be named:
  1. `npm run optout -- find "<their name as a post shows it>"` prints the TopDeck player id of every player with
     that name, with how many events each has and where they last played. The whole name has to match (case and
     extra spaces don't matter). It never prints a name.
  2. If more than one player has the name, pick by the last event and its place, or ask the player which
     events they played.
  3. `npm run optout -- add <player_id> --note "requested by email 2026-11-10"`.

  They show as "a player" in Winners and are left out of the player sections from the next post or `/preview`
  on, and their name is removed from the database at once. Other players with the same name are not affected.
  Posts already sent are not edited.
- `npm run optout -- remove <player_id>` undoes it (the name returns on the next refresh, not before), and
  `npm run optout -- list` shows the list (ids, dates and notes).
- Requests reach you through the address in `CONTACT_EMAIL`, which the privacy page shows. While it is unset
  the page says "not yet published" and players have no way to ask, so set it in Vercel before the bot is
  opened to other servers.

## Going public (needs your explicit approval)
0. Check that `CONTACT_EMAIL` is set in Vercel and that the install page shows it: it is how a player asks not
   to be named, which TopDeck's permission depends on.
1. In Vercel, set `ALLOW_ALL_GUILDS=true`, or add servers to `ALLOWED_GUILD_IDS`, and redeploy.
2. Run `npm run register-commands -- --global --confirm-global`. Global commands can take up to an hour to appear.
3. Keep running `npm run refresh` after the 14th of each month. The cron refuses to post a month whose data isn't final.
