// Ingestion of one month window from the TopDeck bulk endpoint: maps the API objects to the rows we store and
// writes them in one transaction. Used by scripts/backfill.ts. All writes are upserts.
// Player data: only the TopDeck player id and display name are stored, and names are refreshed on every
// ingest. "Deleted User" or a missing name is stored as null, and opted-out players keep a null name.
// Data provided by TopDeck.gg — https://topdeck.gg
import type { Sql } from "./db";
import { fetchBulkEdh, isObj, num, playerId, playerName, text, type MonthWindow, type Obj } from "./topdeck";

const TOURNAMENT_CHUNK = 500;
const ENTRY_CHUNK = 2000;
const PLAYER_CHUNK = 5000;

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
type EntryRow = { tid: string; standing_index: number; leader: string | null; player_id: string | null } & Record<CountColumn, number>;
type PlayerRow = { player_id: string; display_name: string | null };
type Kept = { tournament: TournamentRow; entries: EntryRow[]; players: PlayerRow[] };

type Mapped = ({ kind: "ok" } & Kept) | { kind: "team" } | { kind: "invalid" };

const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const float = (v: unknown): number | null => num(v) ?? null;

/**
 * Whitelists the fields we store. Everything else in the API object (address, headerImage, game,
 * format, and any player field other than id and name) is dropped here, before any database write.
 */
export function mapTournament(t: Obj): Mapped {
  if (t.isTeamEvent === true) return { kind: "team" };
  const tid = text(t.TID ?? t.tid);
  const startSecs = num(t.startDate);
  if (!tid || startSecs === undefined || !Array.isArray(t.standings)) return { kind: "invalid" };

  const entries: EntryRow[] = [];
  const players: PlayerRow[] = [];
  for (const [i, r] of t.standings.entries()) {
    if (!isObj(r)) return { kind: "invalid" };
    const counts = {} as Record<CountColumn, number>;
    for (const [column, key] of Object.entries(COUNTS) as [CountColumn, string][]) {
      const v = int(r[key]);
      if (v === null) return { kind: "invalid" };
      counts[column] = v;
    }
    const pid = playerId(r.id);
    if (pid !== null) players.push({ player_id: pid, display_name: playerName(r.name) });
    entries.push({ tid, standing_index: i, leader: text(r.leader), player_id: pid, ...counts });
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
    players,
  };
}

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

export type WindowResult = {
  fetched: number;
  tournaments: number;
  entries: number;
  players: number;
  entriesWithPlayer: number;
  team: number;
  invalid: number;
  duplicates: number;
  staleDeleted: number;
};

/**
 * Fetches one window and writes it in a single transaction. Logs the window only if `shouldLog`.
 * `fetchWindow` is the TopDeck bulk call; tests pass their own.
 */
export async function ingestWindow(
  sql: Sql,
  w: MonthWindow,
  shouldLog: boolean,
  fetchWindow: (w: MonthWindow) => Promise<unknown[]> = fetchBulkEdh,
): Promise<WindowResult> {
  const raw = await fetchWindow(w);
  const byTid = new Map<string, Kept>();
  let team = 0, invalid = 0, duplicates = 0;
  for (const item of raw) {
    const m: Mapped = isObj(item) ? mapTournament(item) : { kind: "invalid" };
    if (m.kind === "team") team++;
    else if (m.kind === "invalid") invalid++;
    else {
      if (byTid.has(m.tournament.tid)) duplicates++;
      byTid.set(m.tournament.tid, { tournament: m.tournament, entries: m.entries, players: m.players });
    }
  }
  const tournaments = [...byTid.values()].map((k) => k.tournament);
  const entries = [...byTid.values()].flatMap((k) => k.entries);
  // One row per player; the name from the window's latest event wins.
  const playerById = new Map<string, PlayerRow>();
  for (const k of [...byTid.values()].sort((a, b) => a.tournament.start_date.getTime() - b.tournament.start_date.getTime())) {
    for (const p of k.players) playerById.set(p.player_id, p);
  }
  const players = [...playerById.values()];
  const result: WindowResult = {
    fetched: raw.length,
    tournaments: tournaments.length,
    entries: entries.length,
    players: players.length,
    entriesWithPlayer: entries.filter((e) => e.player_id !== null).length,
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
    for (const chunk of chunks(players, PLAYER_CHUNK)) {
      await tx`
        insert into players ${tx(chunk)}
        on conflict (player_id) do update set display_name = excluded.display_name, updated_at = now()`;
    }
    // Opted-out players keep no stored name (same transaction, so the name is never visible).
    await tx`
      update players set display_name = null
      where display_name is not null and player_id in (select player_id from player_optouts)`;
    for (const chunk of chunks(entries, ENTRY_CHUNK)) {
      await tx`
        insert into entries ${tx(chunk)}
        on conflict (tid, standing_index) do update set
          leader = excluded.leader,
          player_id = excluded.player_id,
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
        insert into ingest_log (window_start, window_end, tournaments, entries, team_events_skipped, invalid_skipped, has_players)
        values (${w.start}, ${w.end}, ${tournaments.length}, ${entries.length}, ${team}, ${invalid}, true)
        on conflict (window_start) do update set
          has_players = true,
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
