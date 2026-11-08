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
   | `CONTACT_EMAIL` | optional, shown on the privacy page |

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

## Going public (needs your explicit approval)
1. In Vercel, set `ALLOW_ALL_GUILDS=true`, or add servers to `ALLOWED_GUILD_IDS`, and redeploy.
2. Run `npm run register-commands -- --global --confirm-global`. Global commands can take up to an hour to appear.
3. Keep running `npm run refresh` after the 14th of each month. The cron refuses to post a month whose data isn't final.
