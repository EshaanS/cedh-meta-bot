// One postgres.js client per warm serverless instance. DATABASE_URL should be the Supabase transaction
// pooler (port 6543); connect() already sets prepare: false and max: 1.
import { connect, type Sql } from "../../scripts/lib/db";

let client: Sql | null = null;

export function getSql(): Sql {
  client ??= connect();
  return client;
}
