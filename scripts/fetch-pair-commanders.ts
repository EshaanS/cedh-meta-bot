// Stores Scryfall's list of cards that can share the command zone (oracletag:pair-commander: Partner,
// Partner with, Friends forever, Choose a Background and the Backgrounds, Doctor's companion and the Doctors,
// and whatever else the tag covers) in pair_commanders, for partner validation (is_valid_pair).
// Usage: pair-commanders [--force]
//   --force  fetch even when the stored list is under 24 hours old
// This is the only script that writes Scryfall data, and the only Scryfall call in the pipeline (CLAUDE.md
// data-source exception). A handful of requests, 1 per second. Idempotent: the list is replaced as a whole.
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { refreshPairCommanders } from "./lib/pair-commanders";

async function main() {
  const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
  const sql = connect();
  try {
    const r = await refreshPairCommanders(sql, { force: values.force });
    console.log(
      r.status === "fresh"
        ? `Pair commanders: ${r.names} names, fetched ${r.fetchedAt.toISOString()} (under 24 hours ago); skipped. Use --force to fetch again.`
        : `Pair commanders: ${r.cards} cards (${r.printings} printings) from Scryfall; ${r.names} names stored, ${r.removed} removed.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("pair-commanders", err));
