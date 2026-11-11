// Shared TopDeck.gg API v2 helpers. Data provided by TopDeck.gg — https://topdeck.gg
// Requests are sequential; 429 responses are retried after Retry-After.
// The Authorization header is sent only when TOPDECK_API_KEY is set, and the key is never logged.

const BASE = "https://topdeck.gg/api";
const MAX_RETRIES = 5;

/**
 * Standings columns requested from the bulk endpoint. `leader` comes back without being requested.
 * `name` and `id` are the player's display name and TopDeck player id (permitted, see docs/permissions.md).
 * Decklists and Discord fields are never requested.
 */
export const COLUMNS = ["name", "id", "wins", "draws", "losses", "winsSwiss", "winsBracket", "lossesSwiss", "lossesBracket", "byes"];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = { [k: string]: Json };

export const log = (msg: string) => process.stderr.write(`${msg}\n`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Trimmed string, or null when the value is not a string or is blank. */
export const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
/** TopDeck player id as text, or null when absent. */
export const playerId = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? String(v) : text(v));
/** Player display name, or null when missing or "Deleted User" (a removed player). */
export const playerName = (v: unknown): string | null => {
  const name = text(v);
  return name === null || /^deleted user$/i.test(name) ? null : name;
};

function retryAfterMs(header: string | null): number {
  if (!header) return 60_000;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? 60_000 : Math.max(0, date - Date.now());
}

async function request(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const key = process.env.TOPDECK_API_KEY;
  if (key) headers.Authorization = key;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      log(`429 on ${init.method} ${path}; waiting ${Math.ceil(wait / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${init.method} ${path} failed with HTTP ${res.status}`);
    return res.text();
  }
}

export type MonthWindow = { start: Date; end: Date; label: string };

/**
 * The `n` most recent full UTC calendar months before `now`, oldest first.
 * Never includes the current month. `end` is the last second of the month.
 */
export function fullMonthWindows(n: number, now: Date): MonthWindow[] {
  const out: MonthWindow[] = [];
  for (let i = n; i >= 1; i--) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ start, end: new Date(next.getTime() - 1000), label });
  }
  return out;
}

/** Completed EDH tournaments starting inside the window, as returned by the bulk endpoint. */
export async function fetchBulkEdh(w: MonthWindow): Promise<unknown[]> {
  const raw = await request("/v2/tournaments", {
    method: "POST",
    body: {
      game: "Magic: The Gathering",
      format: "EDH",
      start: w.start.getTime() / 1000,
      end: w.end.getTime() / 1000,
      columns: COLUMNS,
    },
  });
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`bulk ${w.label}: expected an array, got ${typeof parsed}`);
  return parsed;
}

/** GET /v2/tournaments/{tid}/info, parsed. */
export async function fetchInfo(tid: string): Promise<unknown> {
  return JSON.parse(await request(`/v2/tournaments/${encodeURIComponent(tid)}/info`, { method: "GET" }));
}

export type StandingOne = {
  status: "found" | "no_standing_1" | "no_commander";
  leader: string | null;
  playerId: string | null;
  playerName: string | null;
};

/**
 * Reads only the standing-1 row's `leader`, `id` and `name` from a standings response. Everything else in
 * the response (other players, decklists, deck objects) is ignored and never returned.
 */
export function pickStandingOne(rows: unknown): StandingOne {
  const list = Array.isArray(rows) ? rows : [];
  const first = list.find((r) => isObj(r) && Number(r.standing) === 1);
  if (!first || !isObj(first)) return { status: "no_standing_1", leader: null, playerId: null, playerName: null };
  const leader = text(first.leader);
  const id = playerId(first.id);
  const player = { playerId: id, playerName: id === null ? null : playerName(first.name) };
  return leader ? { status: "found", leader, ...player } : { status: "no_commander", leader: null, ...player };
}

/**
 * GET /v2/tournaments/{tid}/standings, reduced to the standing-1 commander and player. The endpoint ignores
 * `columns` and returns every player's name, ID and decklist; only the standing-1 row's `standing`, `leader`,
 * `id` and `name` are read, and the parsed response goes out of scope here.
 */
export async function fetchStandingOne(tid: string): Promise<StandingOne> {
  return pickStandingOne(JSON.parse(await request(`/v2/tournaments/${encodeURIComponent(tid)}/standings`, { method: "GET" })));
}
