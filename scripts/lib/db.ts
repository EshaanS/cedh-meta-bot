import postgres from "postgres";

/**
 * Connects to DATABASE_URL with postgres.js. Logs only host, port and database, never credentials.
 * prepare: false keeps Supabase's transaction pooler working; it is harmless elsewhere.
 */
export function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const u = new URL(url);
  process.stderr.write(`DB target: ${u.hostname}:${u.port || "5432"}${u.pathname}\n`);
  return postgres(url, { prepare: false, max: 1, onnotice: () => {} });
}

export type Sql = ReturnType<typeof connect>;
