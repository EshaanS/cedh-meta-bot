// Manages the player opt-out list (players who asked not to be named), by TopDeck player id.
// Usage: optout add <player_id> [--note "text"] | optout remove <player_id> | optout list
// add    records the opt-out and blanks the stored name. The player then shows as "a player" in Winners and
//        is left out of the player sections; ingest keeps the name blank while the opt-out exists.
// remove deletes the opt-out. The name comes back the next time the player is ingested.
// Output shows player ids only, never names. Both commands are safe to repeat.
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";

const USAGE = 'usage: optout add <player_id> [--note "text"] | optout remove <player_id> | optout list';

async function main() {
  const { values, positionals } = parseArgs({ options: { note: { type: "string" } }, allowPositionals: true });
  const [command, rawId] = positionals;
  const id = rawId?.trim();
  if (!command || !["add", "remove", "list"].includes(command) || (command !== "list" && !id) || positionals.length > 2) {
    throw new Error(USAGE);
  }

  const sql = connect();
  try {
    if (command === "list") {
      const rows = await sql<{ player_id: string; requested_at: Date; note: string | null }[]>`
        select player_id, requested_at, note from player_optouts order by requested_at, player_id`;
      for (const r of rows) console.log(`${r.player_id}\t${r.requested_at.toISOString().slice(0, 10)}\t${r.note ?? ""}`);
      console.log(`${rows.length} opt-out(s).`);
    } else if (command === "add") {
      const known = await sql.begin(async (tx) => {
        await tx`
          insert into player_optouts (player_id, note) values (${id!}, ${values.note ?? null})
          on conflict (player_id) do update set note = coalesce(excluded.note, player_optouts.note)`;
        const updated = await tx`update players set display_name = null, updated_at = now() where player_id = ${id!}`;
        return updated.count > 0;
      });
      console.log(`Opted out ${id}.${known ? "" : " No player with this id is stored yet; the opt-out applies if one is ingested."}`);
    } else {
      const deleted = await sql`delete from player_optouts where player_id = ${id!}`;
      console.log(deleted.count > 0 ? `Removed the opt-out for ${id}. The name returns on the next ingest.` : `No opt-out found for ${id}.`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("optout", err));
