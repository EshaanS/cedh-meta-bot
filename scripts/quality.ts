// Runs db/queries/data_quality.sql and prints each result as a plain-text table.
// The file is split at "-- name: <title>" comment lines; each block is one query.
// Data provided by TopDeck.gg — https://topdeck.gg
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connect } from "./lib/db.js";
import { renderTable } from "./lib/table.js";
import { exitWithError } from "./lib/errors.js";

const FILE = fileURLToPath(new URL("../db/queries/data_quality.sql", import.meta.url));

/** Splits the SQL file into titled queries. Handles CRLF line endings. */
function splitQueries(source: string): { title: string; query: string }[] {
  const parts = source.split(/^--\s*name:\s*(.+)$/m);
  const out: { title: string; query: string }[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const title = parts[i]!.trim();
    const query = parts[i + 1]!.trim();
    if (query) out.push({ title, query });
  }
  return out;
}

async function main() {
  const queries = splitQueries(await readFile(FILE, "utf8"));
  if (queries.length === 0) throw new Error(`no "-- name:" queries found in ${FILE}`);
  const sql = connect();
  try {
    console.log("Data provided by TopDeck.gg (https://topdeck.gg)");
    for (const { title, query } of queries) {
      const result = await sql.unsafe(query);
      const columns = result.columns?.map((c) => c.name) ?? Object.keys(result[0] ?? {});
      console.log(`\n== ${title} ==\n`);
      console.log(renderTable(columns, result as unknown as Record<string, unknown>[]));
      console.log(`(${result.length} row${result.length === 1 ? "" : "s"})`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("quality", err));
