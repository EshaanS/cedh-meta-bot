// Prints the monthly post for a region: the plain-text preview, the embeds as JSON, and the size against budget.
// Usage: preview --region <id> --month YYYY-MM [--save-fixture path.json]
// Data provided by TopDeck.gg — https://topdeck.gg
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { placeholderColorEmoji } from "./lib/color-emoji";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { composePost, contentLength, embedLength, loadPostData, POST_CONFIG } from "./lib/post";

async function main() {
  const { values } = parseArgs({ options: { region: { type: "string" }, month: { type: "string" }, "save-fixture": { type: "string" } } });
  if (!values.region || !values.month) throw new Error("usage: preview --region <id> --month YYYY-MM [--save-fixture path.json]");
  const sql = connect();
  try {
    const data = await loadPostData(sql, values.region, values.month);
    if (values["save-fixture"]) {
      await writeFile(values["save-fixture"], `${JSON.stringify(data, null, 2)}\n`, "utf8");
      process.stderr.write(`saved fixture to ${values["save-fixture"]}\n`);
    }
    const { embeds, text } = composePost(data);
    console.log(text);
    console.log("\n--- embeds JSON (one message) ---");
    console.log(JSON.stringify(embeds, null, 2));
    const longest = embeds.flatMap((e) => e.fields).reduce((a, b) => (b.value.length > a.value.length ? b : a));
    console.log(`\n--- content: ${contentLength(embeds)} / ${POST_CONFIG.contentBudget} characters in ${embeds.length} embeds (${embeds.map(embedLength).join(" + ")}); ` +
      `longest field: ${longest.value.length} (${longest.name.trim() || "continued"}) ---`);
    // What Discord receives when the application has every pie emoji (made-up ids of today's length).
    const sent = composePost(data, POST_CONFIG, { colorEmoji: placeholderColorEmoji() }).embeds;
    const pies = (JSON.stringify(sent).match(/<:ci_/g) ?? []).length;
    console.log(`--- as sent with pie emoji: ${contentLength(sent)} / ${POST_CONFIG.messageMax} characters, ${pies} pies` +
      `${pies === 0 && /[⚪🔵⚫🔴🟢🔘]/u.test(JSON.stringify(sent)) ? " (too long with pies: circles are sent)" : ""} ---`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("preview", err));
