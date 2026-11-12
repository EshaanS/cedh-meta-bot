// Uploads the color identity pies to the Discord application as application emoji: one per color identity,
// 32 in all, named ci_c (colorless), ci_w … ci_wubrg. The images are drawn in memory (scripts/lib/color-pie.ts)
// and no image file is kept in the repository. The app reads the emoji list from Discord when it posts, so
// nothing has to be deployed or stored after this runs.
//
// Usage:
//   color-emoji --out <dir>   write the 32 PNGs and sheet.png (all of them on light and dark) to look at; no Discord call
//   color-emoji               upload the pies the application doesn't have yet (safe to run again)
//   color-emoji --replace     delete our pies and upload them again (after the drawing changed)
//   color-emoji --remove      delete our pies; posts go back to the color circles
// Needs DISCORD_APP_ID and DISCORD_BOT_TOKEN in env (the token is never printed). Emoji with other names are
// never touched.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { requireEnv } from "../src/server/config";
import { discordClient } from "../src/server/discord";
import { COLOR_IDENTITIES, colorEmojiName } from "./lib/color-emoji";
import { contactSheet, piePng } from "./lib/color-pie";
import { exitWithError } from "./lib/errors";

async function main() {
  const { values } = parseArgs({ options: { out: { type: "string" }, replace: { type: "boolean", default: false }, remove: { type: "boolean", default: false } } });
  if (values.replace && values.remove) throw new Error("use --replace or --remove, not both");

  if (values.out) {
    await mkdir(values.out, { recursive: true });
    for (const colors of COLOR_IDENTITIES) await writeFile(join(values.out, `${colorEmojiName(colors)}.png`), piePng(colors));
    await writeFile(join(values.out, "sheet.png"), contactSheet(COLOR_IDENTITIES));
    console.log(`Wrote ${COLOR_IDENTITIES.length} pies and sheet.png to ${values.out}. Nothing was sent to Discord.`);
    return;
  }

  const appId = requireEnv("DISCORD_APP_ID");
  const discord = discordClient({ token: requireEnv("DISCORD_BOT_TOKEN") });
  const ours = new Set(COLOR_IDENTITIES.map(colorEmojiName));
  const existing = (await discord.listAppEmojis(appId)).filter((e) => ours.has(e.name));

  let deleted = 0;
  if (values.replace || values.remove) {
    for (const e of existing) {
      await discord.deleteAppEmoji(appId, e.id);
      deleted++;
    }
  }
  if (values.remove) {
    console.log(`Deleted ${deleted} pie emoji. Posts show the color circles again (within ten minutes).`);
    return;
  }

  const have = new Set(values.replace ? [] : existing.map((e) => e.name));
  let created = 0;
  for (const colors of COLOR_IDENTITIES) {
    const name = colorEmojiName(colors);
    if (have.has(name)) continue;
    await discord.createAppEmoji(appId, name, piePng(colors));
    created++;
  }
  console.log(`${values.replace ? `Deleted ${deleted}, uploaded` : "Uploaded"} ${created} pie emoji; ${have.size} were already there. ` +
    `The application has ${have.size + created} of ${COLOR_IDENTITIES.length}. Posts pick them up within ten minutes.`);
}

main().catch((err: unknown) => exitWithError("color-emoji", err));
