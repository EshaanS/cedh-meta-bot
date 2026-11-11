// Fetches the official standing-1 commander and player for qualifying 32+ events with no recorded bracket
// (topCut = 0), one request per second, each event once. Stores the commander, status and player id in
// event_winners and the player's id and display name in players; nothing else from the response is kept.
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
