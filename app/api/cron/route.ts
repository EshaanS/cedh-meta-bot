// Daily cron (Vercel sends Authorization: Bearer $CRON_SECRET). Query: ?dry_run=1, ?month=YYYY-MM.
import { guildAllowlist, requireEnv } from "../../../src/server/config";
import { runCron } from "../../../src/server/cron";
import { discordClient } from "../../../src/server/discord";
import { getSql } from "../../../src/server/sql";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Bearer ${requireEnv("CRON_SECRET")}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const summary = await runCron(
    { sql: getSql(), discord: discordClient({ token: requireEnv("DISCORD_BOT_TOKEN") }), allowlist: guildAllowlist(), now: new Date() },
    { dryRun: url.searchParams.get("dry_run") === "1", monthOverride: url.searchParams.get("month") ?? undefined },
  );
  console.log(JSON.stringify(summary));
  return Response.json(summary);
}
