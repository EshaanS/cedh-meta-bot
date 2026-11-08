// Fetches the official standing-1 commander for qualifying 32+ events with no recorded bracket (topCut = 0),
// one request per second, each event once. Stores only (tid, commander, status, fetched_at).
// Data provided by TopDeck.gg — https://topdeck.gg
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { fetchMissingStandings } from "./lib/standings";
import { fetchStandingOne } from "./lib/topdeck";

async function main() {
  const sql = connect();
  try {
    const r = await fetchMissingStandings(sql, fetchStandingOne);
    console.log(
      `Standings: ${r.candidates} event(s) to fetch; ${r.found} winners found, ${r.noStanding1} without a standing 1, ` +
        `${r.noCommander} without a commander, ${r.errors} errors (retried next run).`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("fetch-standings", err));
