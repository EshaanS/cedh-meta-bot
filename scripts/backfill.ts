// Backfills EDH tournaments from the TopDeck bulk endpoint in one-month UTC windows, oldest first.
// Usage: backfill --months N [--force]
//   --months N  the N most recent full calendar months (never the current month)
//   --force     re-fetch windows already recorded in ingest_log
// A window is recorded in ingest_log only once its end is at least 14 days in the past, so recent
// windows are re-fetched on every run. Windows logged before player ids were stored (has_players = false)
// are fetched again. All writes are upserts, so reruns leave row counts unchanged.
// Player data: only the TopDeck player id and display name are stored, and names are refreshed on every
// ingest. "Deleted User" or a missing name is stored as null, and opted-out players keep a null name.
// Data provided by TopDeck.gg — https://topdeck.gg
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { ingestWindow } from "./lib/ingest";
import { fullMonthWindows, log, sleep } from "./lib/topdeck";

const DAY_MS = 86_400_000;
const LOG_MIN_AGE_DAYS = 14;
const BULK_PAUSE_MS = 10_000;

async function main() {
  const { values } = parseArgs({
    options: {
      months: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const months = Number(values.months);
  if (!Number.isInteger(months) || months < 1 || months > 120) {
    throw new Error("usage: backfill --months N [--force]   (N from 1 to 120)");
  }

  const now = new Date();
  const sql = connect();
  try {
    const logged = new Set(
      (await sql<{ window_start: Date }[]>`select window_start from ingest_log where has_players`).map((r) => r.window_start.getTime()),
    );
    console.log("Data provided by TopDeck.gg (https://topdeck.gg)");
    let fetchedAny = false;
    for (const w of fullMonthWindows(months, now)) {
      if (logged.has(w.start.getTime()) && !values.force) {
        console.log(`${w.label}: skipped, already in ingest_log (use --force to re-fetch)`);
        continue;
      }
      if (fetchedAny) await sleep(BULK_PAUSE_MS);
      fetchedAny = true;

      const ageDays = (now.getTime() - w.end.getTime()) / DAY_MS;
      const shouldLog = ageDays >= LOG_MIN_AGE_DAYS;
      log(`${w.label}: fetching bulk EDH`);
      const r = await ingestWindow(sql, w, shouldLog);
      const logNote =
        r.tournaments === 0
          ? "not logged: no tournaments to store"
          : shouldLog
            ? "logged in ingest_log"
            : `not logged: ended ${ageDays.toFixed(1)} days ago (< ${LOG_MIN_AGE_DAYS}), will be re-fetched next run`;
      console.log(
        `${w.label}: ${r.fetched} fetched; ${r.tournaments} tournaments and ${r.entries} entries upserted; ` +
          `${r.players} players, ${r.entriesWithPlayer} entries with a player id; ` +
          `${r.team} team events skipped; ${r.invalid} invalid skipped; ${r.duplicates} duplicate TIDs; ` +
          `${r.staleDeleted} stale entries deleted; ${logNote}`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("backfill", err));
