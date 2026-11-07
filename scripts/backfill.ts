// Backfills EDH tournaments from the TopDeck bulk endpoint in one-month UTC windows, oldest first.
// Usage: backfill --months N [--force]
//   --months N  the N most recent full calendar months (never the current month)
//   --force     re-fetch windows already recorded in ingest_log
// A window is recorded in ingest_log only once its end is at least 14 days in the past, so recent
// windows are re-fetched on every run. All writes are upserts, so reruns leave row counts unchanged.
// Data provided by TopDeck.gg — https://topdeck.gg
import { parseArgs } from "node:util";
import { connect, type Sql } from "./lib/db.js";
import { fetchBulkEdh, fullMonthWindows, isObj, log, num, sleep, text, type MonthWindow, type Obj } from "./lib/topdeck.js";
import { exitWithError } from "./lib/errors.js";

const DAY_MS = 86_400_000;
const LOG_MIN_AGE_DAYS = 14;
const BULK_PAUSE_MS = 10_000;
const TOURNAMENT_CHUNK = 500;
const ENTRY_CHUNK = 2000;

type TournamentRow = {
  tid: string;
  name: string | null;
  start_date: Date;
  participant_count: number;
  swiss_num: number | null;
  top_cut: number | null;
  average_elo: number | null;
  median_elo: number | null;
  mode_elo: number | null;
  top_elo: number | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
};

/** Entry count columns and the API standings keys they come from. */
const COUNTS = {
  wins: "wins",
  draws: "draws",
  losses: "losses",
  byes: "byes",
  wins_swiss: "winsSwiss",
  wins_bracket: "winsBracket",
  losses_swiss: "lossesSwiss",
  losses_bracket: "lossesBracket",
} as const;
type CountColumn = keyof typeof COUNTS;
type EntryRow = { tid: string; standing_index: number; leader: string | null } & Record<CountColumn, number>;

type Mapped = { kind: "ok"; tournament: TournamentRow; entries: EntryRow[] } | { kind: "team" } | { kind: "invalid" };

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const float = (v: unknown): number | null => num(v) ?? null;

/**
 * Whitelists the fields we store. Everything else in the API object (address, headerImage, game,
 * format, and any player fields) is dropped here, before any database write.
 */
function mapTournament(t: Obj): Mapped {
  if (t.isTeamEvent === true) return { kind: "team" };
  const tid = text(t.TID ?? t.tid);
  const startSecs = num(t.startDate);
  if (!tid || startSecs === undefined || !Array.isArray(t.standings)) return { kind: "invalid" };

  const entries: EntryRow[] = [];
  for (const [i, r] of t.standings.entries()) {
    if (!isObj(r)) return { kind: "invalid" };
    const counts = {} as Record<CountColumn, number>;
    for (const [column, key] of Object.entries(COUNTS) as [CountColumn, string][]) {
      const v = int(r[key]);
      if (v === null) return { kind: "invalid" };
      counts[column] = v;
    }
    entries.push({ tid, standing_index: i, leader: text(r.leader), ...counts });
  }

  const e: Obj = isObj(t.eventData) ? t.eventData : {};
  return {
    kind: "ok",
    tournament: {
      tid,
      name: text(t.tournamentName),
      start_date: new Date(startSecs * 1000),
      participant_count: entries.length,
      swiss_num: int(t.swissNum),
      top_cut: int(t.topCut),
      average_elo: float(t.averageElo),
      median_elo: float(t.medianElo),
      mode_elo: float(t.modeElo),
      top_elo: float(t.topElo),
      lat: float(e.lat),
      lng: float(e.lng),
      city: text(e.city),
      state: text(e.state),
      country: text(e.country),
    },
    entries,
  };
}

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

type WindowResult = {
  fetched: number;
  tournaments: number;
  entries: number;
  team: number;
  invalid: number;
  duplicates: number;
  staleDeleted: number;
};

/** Fetches one window and writes it in a single transaction. Logs the window only if `shouldLog`. */
async function ingestWindow(sql: Sql, w: MonthWindow, shouldLog: boolean): Promise<WindowResult> {
  const raw = await fetchBulkEdh(w);
  const byTid = new Map<string, { tournament: TournamentRow; entries: EntryRow[] }>();
  let team = 0, invalid = 0, duplicates = 0;
  for (const item of raw) {
    const m: Mapped = isObj(item) ? mapTournament(item) : { kind: "invalid" };
    if (m.kind === "team") team++;
    else if (m.kind === "invalid") invalid++;
    else {
      if (byTid.has(m.tournament.tid)) duplicates++;
      byTid.set(m.tournament.tid, { tournament: m.tournament, entries: m.entries });
    }
  }
  const tournaments = [...byTid.values()].map((k) => k.tournament);
  const entries = [...byTid.values()].flatMap((k) => k.entries);
  const result: WindowResult = {
    fetched: raw.length,
    tournaments: tournaments.length,
    entries: entries.length,
    team,
    invalid,
    duplicates,
    staleDeleted: 0,
  };
  if (tournaments.length === 0) return result;

  await sql.begin(async (tx) => {
    for (const chunk of chunks(tournaments, TOURNAMENT_CHUNK)) {
      await tx`
        insert into tournaments ${tx(chunk)}
        on conflict (tid) do update set
          name = excluded.name,
          start_date = excluded.start_date,
          participant_count = excluded.participant_count,
          swiss_num = excluded.swiss_num,
          top_cut = excluded.top_cut,
          average_elo = excluded.average_elo,
          median_elo = excluded.median_elo,
          mode_elo = excluded.mode_elo,
          top_elo = excluded.top_elo,
          lat = excluded.lat,
          lng = excluded.lng,
          city = excluded.city,
          state = excluded.state,
          country = excluded.country,
          -- A moved venue must be geocoded again: clear the geo fields when lat/lng change.
          -- (Right-hand sides here read the row as it was before this update.)
          geo_country_code      = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_country_code end,
          geo_country_name      = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_country_name end,
          geo_admin1_code       = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_admin1_code end,
          geo_admin1_name       = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_admin1_name end,
          geo_admin1_group_code = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_admin1_group_code end,
          geo_admin1_group_name = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_admin1_group_name end,
          geo_source            = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_source end,
          geo_checked_at        = case when (tournaments.lat, tournaments.lng) is distinct from (excluded.lat, excluded.lng) then null else tournaments.geo_checked_at end,
          ingested_at = now()`;
    }
    for (const chunk of chunks(entries, ENTRY_CHUNK)) {
      await tx`
        insert into entries ${tx(chunk)}
        on conflict (tid, standing_index) do update set
          leader = excluded.leader,
          wins = excluded.wins,
          draws = excluded.draws,
          losses = excluded.losses,
          byes = excluded.byes,
          wins_swiss = excluded.wins_swiss,
          wins_bracket = excluded.wins_bracket,
          losses_swiss = excluded.losses_swiss,
          losses_bracket = excluded.losses_bracket`;
    }
    // A re-ingested tournament whose standings shrank would otherwise keep rows past its new length.
    for (const chunk of chunks(tournaments.map((t) => t.tid), TOURNAMENT_CHUNK)) {
      const deleted = await tx`
        delete from entries e
        using tournaments t
        where e.tid = t.tid
          and t.tid in ${tx(chunk)}
          and e.standing_index >= t.participant_count`;
      result.staleDeleted += deleted.count;
    }
    if (shouldLog) {
      await tx`
        insert into ingest_log (window_start, window_end, tournaments, entries, team_events_skipped, invalid_skipped)
        values (${w.start}, ${w.end}, ${tournaments.length}, ${entries.length}, ${team}, ${invalid})
        on conflict (window_start) do update set
          window_end = excluded.window_end,
          tournaments = excluded.tournaments,
          entries = excluded.entries,
          team_events_skipped = excluded.team_events_skipped,
          invalid_skipped = excluded.invalid_skipped,
          completed_at = now()`;
    }
  });
  return result;
}

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
      (await sql<{ window_start: Date }[]>`select window_start from ingest_log`).map((r) => r.window_start.getTime()),
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
          `${r.team} team events skipped; ${r.invalid} invalid skipped; ${r.duplicates} duplicate TIDs; ` +
          `${r.staleDeleted} stale entries deleted; ${logNote}`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("backfill", err));
