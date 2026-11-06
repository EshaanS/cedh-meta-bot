// Applies db/migrations/NNN_*.sql in filename order and records each one in schema_migrations.
// Each migration runs in its own transaction together with its schema_migrations row.
// Rerunning is a no-op.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./lib/db.js";
import { exitWithError } from "./lib/errors.js";

const DIR = fileURLToPath(new URL("../db/migrations/", import.meta.url));
const NAME = /^\d{3}_[\w-]+\.sql$/;

async function main() {
  const sql = connect();
  try {
    await sql`
      create table if not exists schema_migrations (
        filename   text primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Set((await sql<{ filename: string }[]>`select filename from schema_migrations`).map((r) => r.filename));
    const files = (await readdir(DIR)).filter((f) => NAME.test(f)).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(join(DIR, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx.unsafe("insert into schema_migrations (filename) values ($1)", [file]);
      });
      console.log(`applied ${file}`);
      count++;
    }
    console.log(count === 0 ? `Up to date: ${files.length} migration(s) already applied.` : `Applied ${count} migration(s).`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("migrate", err));
