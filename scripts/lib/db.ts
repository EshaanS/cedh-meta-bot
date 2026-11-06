import postgres from "postgres";

/**
 * Connects to DATABASE_URL with postgres.js. Logs only host, port and database, taken from
 * postgres.js's own parsed options, so the URL is parsed once, by postgres.js, and never printed.
 * prepare: false keeps Supabase's transaction pooler working; it is harmless elsewhere.
 */
export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  const { host, port, database } = sql.options;
  process.stderr.write(`DB target: ${host.join(",")}:${port.join(",")}/${database}\n`);
  return sql;
}

export type Sql = ReturnType<typeof connect>;
