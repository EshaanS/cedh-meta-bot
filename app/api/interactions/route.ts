// Discord interactions endpoint: verifies the Ed25519 signature, then dispatches. Deferred work runs in after().
import { after } from "next/server";
import { guildAllowlist, requireEnv } from "../../../src/server/config";
import { discordClient } from "../../../src/server/discord";
import { handleInteraction, type Interaction } from "../../../src/server/interactions";
import { getSql } from "../../../src/server/sql";
import { verifyDiscordRequest } from "../../../src/server/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  const ok = verifyDiscordRequest(
    raw,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    requireEnv("DISCORD_PUBLIC_KEY"),
  );
  if (!ok) return new Response("invalid request signature", { status: 401 });

  const { response, background } = await handleInteraction(JSON.parse(raw) as Interaction, {
    sql: getSql,
    discord: discordClient({ token: requireEnv("DISCORD_BOT_TOKEN") }),
    appId: requireEnv("DISCORD_APP_ID"),
    allowlist: guildAllowlist(),
    now: () => new Date(),
  });
  if (background) after(background);
  return Response.json(response);
}
