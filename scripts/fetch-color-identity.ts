// Stores the color identity of every card that can be a commander (Scryfall: is:commander, plus the
// pair-commander tag for the Backgrounds) in commander_colors, for the color circles in the monthly post.
// Usage: color-identity [--force]
//   --force  fetch even when the stored list is under 24 hours old
// One Scryfall search, about 20 pages, 1 request per second (CLAUDE.md data-source exception). Only names and
// color identity are stored: no images, no image URLs. Idempotent: the list is replaced as a whole.
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { refreshCommanderColors } from "./lib/commander-colors";

async function main() {
  const { values } = parseArgs({ options: { force: { type: "boolean", default: false } } });
  const sql = connect();
  try {
    const r = await refreshCommanderColors(sql, { force: values.force });
    console.log(
      r.status === "fresh"
        ? `Commander colors: ${r.names} names, fetched ${r.fetchedAt.toISOString()} (under 24 hours ago); skipped. Use --force to fetch again.`
        : `Commander colors: ${r.cards} cards from Scryfall; ${r.names} names stored, ${r.removed} removed.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("color-identity", err));
