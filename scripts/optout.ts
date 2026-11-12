// Manages the player opt-out list (players who asked not to be named), by TopDeck player id.
// Usage: optout find "<name>" | optout add <player_id> [--note "text"] | optout remove <player_id> | optout list
// find   looks up the player id for a name as it appears in a post. It prints ids with how many events each
//        player has and where they last played, so two players with one name can be told apart.
// add    records the opt-out and blanks the stored name. The player then shows as "a player" in Winners and
//        is left out of the player sections; ingest keeps the name blank while the opt-out exists.
// remove deletes the opt-out. The name comes back the next time the player is ingested.
// Output shows player ids only, never names. add, remove and list are safe to repeat.
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { addOptOut, findPlayersByName, listOptOuts, removeOptOut } from "./lib/optout";
import { playerId } from "./lib/topdeck";

const USAGE = 'usage: optout find "<name>" | optout add <player_id> [--note "text"] | optout remove <player_id> | optout list';

async function main() {
  const { values, positionals } = parseArgs({ options: { note: { type: "string" } }, allowPositionals: true });
  const [command, rawArg] = positionals;
  const arg = rawArg?.trim();
  if (!command || !["find", "add", "remove", "list"].includes(command) || (command !== "list" && !arg) || positionals.length > 2) {
    throw new Error(USAGE);
  }
  // Only account ids are stored (see playerId in lib/topdeck.ts), so only they can be opted out.
  if ((command === "add" || command === "remove") && playerId(arg) === null) {
    throw new Error("player_id must be a 28-character TopDeck account id. Players without an account are never named.");
  }

  const sql = connect();
  try {
    if (command === "list") {
      const rows = await listOptOuts(sql);
      for (const r of rows) console.log(`${r.playerId}\t${r.requestedAt.toISOString().slice(0, 10)}\t${r.note ?? ""}`);
      console.log(`${rows.length} opt-out(s).`);
    } else if (command === "find") {
      const matches = await findPlayersByName(sql, arg!);
      for (const m of matches) {
        const played = m.events === 0 ? "no events stored" : `${m.events} event(s), ${m.firstEvent} to ${m.lastEvent}`;
        const last = m.lastEventName ? `last: ${m.lastEventName}${m.lastEventPlace ? ` (${m.lastEventPlace})` : ""}` : "";
        console.log([m.playerId, played, last].filter(Boolean).join("\t"));
      }
      console.log(matches.length === 0
        ? "No player is stored under this name. The whole name has to match (case, extra spaces and @ < > * _ ~ ` | [ ] are ignored); a player who is already opted out or removed can't be found by name."
        : `${matches.length} player(s) with this name. To opt one out: npm run optout -- add <player_id> --note "..."`);
    } else if (command === "add") {
      const { known } = await addOptOut(sql, arg!, values.note ?? null);
      console.log(`Opted out ${arg}.${known ? "" : " No player with this id is stored yet; the opt-out applies if one is ingested."}`);
    } else {
      console.log((await removeOptOut(sql, arg!)) ? `Removed the opt-out for ${arg}. The name returns on the next ingest.` : `No opt-out found for ${arg}.`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("optout", err));
