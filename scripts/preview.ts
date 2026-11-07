// Prints the monthly post for a region: the plain-text preview, the embed JSON, and the size against budget.
// Usage: preview --region <id> --month YYYY-MM [--save-fixture path.json]
// Data provided by TopDeck.gg — https://topdeck.gg
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { connect } from "./lib/db.js";
import { exitWithError } from "./lib/errors.js";
import { composePost, contentLength, loadPostData, POST_CONFIG } from "./lib/post.js";

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
    const { embed, text } = composePost(data);
    console.log(text);
    console.log("\n--- embed JSON ---");
    console.log(JSON.stringify(embed, null, 2));
    console.log(`\n--- content: ${contentLength(embed)} / ${POST_CONFIG.contentBudget} characters ---`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("preview", err));
