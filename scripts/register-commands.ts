// Registers the slash commands (bulk overwrite). Guild-scoped for testing; global needs --confirm-global.
// Usage: register-commands --guild <id> | register-commands --global --confirm-global
// Needs DISCORD_APP_ID and DISCORD_BOT_TOKEN in env (the token is never printed).
import { parseArgs } from "node:util";
import { COMMANDS } from "../src/server/commands";
import { requireEnv } from "../src/server/config";
import { discordClient } from "../src/server/discord";
import { exitWithError } from "./lib/errors";

async function main() {
  const { values } = parseArgs({
    options: { guild: { type: "string" }, global: { type: "boolean", default: false }, "confirm-global": { type: "boolean", default: false } },
  });
  if (!values.guild && !values.global) throw new Error("usage: register-commands --guild <id> | --global --confirm-global");
  if (values.global && !values["confirm-global"]) throw new Error("global registration makes commands visible in every server; add --confirm-global");
  const appId = requireEnv("DISCORD_APP_ID");
  const discord = discordClient({ token: requireEnv("DISCORD_BOT_TOKEN") });
  await discord.putCommands(appId, values.global ? null : values.guild!, [...COMMANDS]);
  console.log(`Registered ${COMMANDS.map((c) => `/${c.name}`).join(", ")} ${values.global ? "globally" : `in guild ${values.guild}`}.`);
}

main().catch((err: unknown) => exitWithError("register-commands", err));
