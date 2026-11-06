// Data-quality probe for the TopDeck.gg API v2 (Milestone 1).
// Reads one calendar month of EDH tournaments and prints aggregates as markdown to stdout.
// No database access. Never prints player-identifying values.
// Data provided by TopDeck.gg — https://topdeck.gg
import { exitWithError } from "./lib/errors.js";

const BASE = "https://topdeck.gg/api";
const COLUMNS = ["wins", "draws", "losses", "winsSwiss", "winsBracket", "lossesSwiss", "lossesBracket", "byes"];
const SENSITIVE = new Set(["name", "id", "discord", "discordid", "decklist", "players"]);
const INVITE_RE = /(https?:\/\/)?(www\.)?(discord\.gg|discord(app)?\.com\/invite)\/[\w-]+/gi;
const redact = (s: string) => s.replace(INVITE_RE, "[discord invite redacted]");
const ONLINE_RE = /online|webcam|spelltable|discord|convoke/i;
const MAX_RETRIES = 5;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const log = (msg: string) => process.stderr.write(`${msg}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

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

function previousMonthUtc(now: Date): { start: number; end: number; label: string } {
  const startD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const nextD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const label = `${startD.getUTCFullYear()}-${String(startD.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start: startD.getTime() / 1000, end: nextD.getTime() / 1000 - 1, label };
}

class KeyStats {
  objects = 0;
  present = new Map<string, number>();
  nonNull = new Map<string, number>();
  add(o: Obj) {
    this.objects++;
    for (const [k, v] of Object.entries(o)) {
      this.present.set(k, (this.present.get(k) ?? 0) + 1);
      if (v !== null && v !== undefined) this.nonNull.set(k, (this.nonNull.get(k) ?? 0) + 1);
    }
  }
  table(title: string): string[] {
    const out = [`### ${title} (${this.objects} objects)`, "", "| key | objects containing | non-null share | note |", "|---|---:|---:|---|"];
    const keys = [...this.present.keys()].sort((a, b) => (this.present.get(b)! - this.present.get(a)!) || a.localeCompare(b));
    for (const k of keys) {
      const p = this.present.get(k)!;
      const note = SENSITIVE.has(k.toLowerCase()) ? "⚠ player-identifying key present; values not printed" : "";
      out.push(`| \`${k}\` | ${p} (${pct(p, this.objects)}) | ${pct(this.nonNull.get(k) ?? 0, p)} | ${note} |`);
    }
    out.push("");
    return out;
  }
}

function topN(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Index of the first value greater than the one before it, or -1 if non-increasing (ties allowed). */
const firstRise = (xs: number[]) => xs.findIndex((x, i) => i > 0 && x > xs[i - 1]!);

const BUCKETS = ["<16", "16-31", "32-63", "64+"] as const;
type Bucket = (typeof BUCKETS)[number];
const bucketOf = (n: number): Bucket => (n < 16 ? "<16" : n < 32 ? "16-31" : n < 64 ? "32-63" : "64+");

const THIRDS = ["first third (top)", "middle third", "last third (bottom)"] as const;
type Third = (typeof THIRDS)[number];
const thirdOf = (fraction: number): Third => THIRDS[Math.min(2, Math.floor(fraction * 3))]!;

const LOC_FIELDS = ["lat", "lng", "city", "state", "address", "country"];
/** A finite number or a non-blank string. */
const usable = (v: unknown) => num(v) !== undefined || (typeof v === "string" && v.trim() !== "");
const hasLeader = (r: Obj) => typeof r.leader === "string" && r.leader.trim() !== "";

type OrderTally = {
  checked: number;
  skipped: number;
  fail5: number;
  fail3: number;
  failBoth: number;
  firstViolation: Record<Third, number>;
};
const newTally = (): OrderTally => ({
  checked: 0,
  skipped: 0,
  fail5: 0,
  fail3: 0,
  failBoth: 0,
  firstViolation: { "first third (top)": 0, "middle third": 0, "last third (bottom)": 0 },
});

/**
 * Check (a) on one tournament's Swiss rows, which start at index `offset` of a standings array of
 * length `total`. Tallies violations under 5/1/0 and 3/1/0. For tournaments that fail under both,
 * also tallies which third of the full standings holds the first 5/1/0 violation.
 */
function checkSwissOrder(t: OrderTally, wins: (number | undefined)[], draws: (number | undefined)[], offset: number, total: number): void {
  if (wins.some((v) => v === undefined) || draws.some((v) => v === undefined)) {
    t.skipped++;
    return;
  }
  t.checked++;
  const rise5 = firstRise(wins.map((w, i) => 5 * w! + draws[i]!));
  const rise3 = firstRise(wins.map((w, i) => 3 * w! + draws[i]!));
  if (rise5 >= 0) t.fail5++;
  if (rise3 >= 0) t.fail3++;
  if (rise5 >= 0 && rise3 >= 0) {
    t.failBoth++;
    t.firstViolation[thirdOf((offset + rise5) / total)]++;
  }
}

async function main() {
  const now = new Date();
  const win = previousMonthUtc(now);
  const out: string[] = [];
  const p = (...lines: string[]) => out.push(...lines);

  log(`Bulk request for ${win.label} (${win.start}..${win.end})`);
  const raw = await request("/v2/tournaments", {
    method: "POST",
    body: { game: "Magic: The Gathering", format: "EDH", start: win.start, end: win.end, columns: COLUMNS },
  });
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`Expected an array from bulk endpoint, got ${typeof parsed}`);
  const tournaments = parsed.filter(isObj);

  // 1. Header
  p(
    `# TopDeck EDH data-quality probe — ${win.label}`,
    "",
    "Data provided by [TopDeck.gg](https://topdeck.gg).",
    "",
    `- Window (UTC): ${new Date(win.start * 1000).toISOString()} to ${new Date(win.end * 1000).toISOString()} (unix ${win.start}..${win.end})`,
    `- Run at: ${now.toISOString()}`,
    `- Columns requested: \`${JSON.stringify(COLUMNS)}\``,
    "- Aggregates only. Values of player-identifying keys are never printed.",
    "",
  );

  // 2. Size
  const bytes = Buffer.byteLength(raw, "utf8");
  p("## 1. Volume", "", `- Tournaments returned: **${tournaments.length}** (non-object array elements: ${parsed.length - tournaments.length})`, `- Response size: **${(bytes / 1024).toFixed(1)} KB**`, "");

  // 3. Key inventory
  const tStats = new KeyStats();
  const eStats = new KeyStats();
  const sStats = new KeyStats();
  let eventDataMissing = 0;
  for (const t of tournaments) {
    tStats.add(t);
    if (isObj(t.eventData)) eStats.add(t.eventData);
    else eventDataMissing++;
    if (Array.isArray(t.standings)) for (const row of t.standings) if (isObj(row)) sStats.add(row);
  }
  p("## 2. Key inventory", "", "Non-null share is among objects that contain the key.", "");
  p(...tStats.table("Tournament level"));
  p(`Tournaments with no \`eventData\` object: ${eventDataMissing}`, "");
  p(...eStats.table("eventData"));
  p(...sStats.table("Standings rows"));

  // 4. eventData quality
  p("## 3. eventData quality", "", `Denominator: all ${tournaments.length} tournaments. A missing \`eventData\` object counts as a missing key.`, "");
  p("| field | missing key | null | empty string | usable |", "|---|---:|---:|---:|---:|");
  const N = tournaments.length;
  for (const f of ["lat", "lng", "city", "state", "address"]) {
    let missing = 0, nul = 0, empty = 0;
    for (const t of tournaments) {
      const e = t.eventData;
      if (!isObj(e) || !(f in e)) missing++;
      else if (e[f] === null) nul++;
      else if (typeof e[f] === "string" && (e[f] as string).trim() === "") empty++;
    }
    const usable = N - missing - nul - empty;
    p(`| \`${f}\` | ${missing} (${pct(missing, N)}) | ${nul} (${pct(nul, N)}) | ${empty} (${pct(empty, N)}) | ${usable} (${pct(usable, N)}) |`);
  }
  p("");

  let exactOnline = 0;
  const onlineMatches = new Map<string, number>();
  const states = new Map<string, number>();
  for (const t of tournaments) {
    const e = t.eventData;
    if (!isObj(e)) continue;
    if (typeof e.address === "string") {
      if (e.address.trim().toLowerCase() === "online") exactOnline++;
      if (ONLINE_RE.test(e.address)) onlineMatches.set(e.address, (onlineMatches.get(e.address) ?? 0) + 1);
    }
    if (typeof e.state === "string") states.set(e.state, (states.get(e.state) ?? 0) + 1);
  }
  const regexOnline = [...onlineMatches.values()].reduce((a, b) => a + b, 0);
  p(
    `- \`address\` exactly "online" (trimmed, case-insensitive): **${exactOnline}** (${pct(exactOnline, N)})`,
    `- \`address\` matching \`${ONLINE_RE}\`: **${regexOnline}** (${pct(regexOnline, N)}), ${onlineMatches.size} distinct strings`,
    "",
    "Top 15 matched address strings (Discord invite links redacted):",
    "",
    "| address | count |",
    "|---|---:|",
    ...topN(onlineMatches, 15).map(([a, c]) => `| ${JSON.stringify(redact(a)).replace(/\|/g, "\\|")} | ${c} |`),
    "",
    `Distinct raw \`state\` values: **${states.size}**. Top 30, JSON-quoted to show whitespace and case:`,
    "",
    "| state | count |",
    "|---|---:|",
    ...topN(states, 30).map(([s, c]) => `| ${JSON.stringify(s).replace(/\|/g, "\\|")} | ${c} |`),
    "",
  );

  // 5. /info location samples
  const tids = tournaments.map((t) => t.TID).filter((v): v is string => typeof v === "string" && v.length > 0);
  const sample = shuffle(tids).slice(0, 10);
  p("## 4. `/info` location samples", "", `10 TIDs sampled at random from ${tids.length}; fetched sequentially, 1s apart. Only \`location\` is printed.`, "");
  for (let i = 0; i < sample.length; i++) {
    if (i > 0) await sleep(1000);
    const tid = sample[i]!;
    log(`GET /info ${i + 1}/${sample.length}`);
    try {
      const info: unknown = JSON.parse(await request(`/v2/tournaments/${encodeURIComponent(tid)}/info`, { method: "GET" }));
      const loc = isObj(info) ? (info.location === undefined ? "(key absent)" : info.location) : "(non-object response)";
      p(`**${tid}**`, "", "```json", JSON.stringify(loc, null, 2), "```", "");
    } catch (err) {
      p(`**${tid}**: ${(err as Error).message}`, "");
    }
  }

  // 6. leader share + size buckets
  let rows = 0, withLeader = 0;
  const buckets: Record<Bucket, number> = { "<16": 0, "16-31": 0, "32-63": 0, "64+": 0 };
  for (const t of tournaments) {
    const st = (Array.isArray(t.standings) ? t.standings : []).filter(isObj);
    buckets[bucketOf(st.length)]++;
    rows += st.length;
    withLeader += st.filter(hasLeader).length;
  }
  p(
    "## 5. Commanders and event size",
    "",
    `- Standings rows with a non-empty \`leader\`: **${withLeader} / ${rows}** (${pct(withLeader, rows)})`,
    "",
    "| standings length | tournaments |",
    "|---|---:|",
    ...BUCKETS.map((b) => `| ${b} | ${buckets[b]} (${pct(buckets[b], N)}) |`),
    "",
  );

  // 7. Order checks
  let topCutMissing = 0, topCutZero = 0, topCutPositive = 0, topCutExceeds = 0;
  let bChecked = 0, bSkippedFields = 0, bFail = 0;
  let orderRows = 0, byesRows = 0;
  const plain = newTally();
  const withByes = newTally();
  for (const t of tournaments) {
    const st = (Array.isArray(t.standings) ? t.standings : []).filter(isObj);
    orderRows += st.length;
    byesRows += st.filter((r) => num(r.byes) !== undefined).length;
    const topCut = num(t.topCut);
    if (topCut === undefined) {
      topCutMissing++;
      continue;
    }
    if (topCut === 0) topCutZero++;
    else topCutPositive++;
    if (topCut > st.length) topCutExceeds++;
    const k = Math.min(Math.max(0, topCut), st.length);

    // (a) Swiss rows ordered by points under 5/1/0 and 3/1/0, without and with byes counted as wins
    const swiss = st.slice(k);
    const ws = swiss.map((r) => num(r.winsSwiss));
    const ds = swiss.map((r) => num(r.draws));
    const bs = swiss.map((r) => num(r.byes));
    const wsb = ws.map((w, i) => (w === undefined || bs[i] === undefined ? undefined : w + bs[i]!));
    checkSwissOrder(plain, ws, ds, k, st.length);
    checkSwissOrder(withByes, wsb, ds, k, st.length);

    // (b) Top-cut rows actually played in the cut
    if (topCut > 0) {
      const cut = st.slice(0, k);
      const wb = cut.map((r) => num(r.winsBracket));
      const lb = cut.map((r) => num(r.lossesBracket));
      if (wb.some((v) => v === undefined) || lb.some((v) => v === undefined)) bSkippedFields++;
      else {
        bChecked++;
        if (!cut.every((_, i) => wb[i]! > 0 || lb[i]! > 0)) bFail++;
      }
    }
  }
  const byesReturned = byesRows > 0;
  const remaining = byesReturned ? withByes : plain;
  const vs = (n: number, d: number) => `${n} (${pct(n, d)})`;
  const byesCell = (s: string) => (byesReturned ? s : "n/a");
  p(
    "## 6. Standings order",
    "",
    "Tests whether array order is final standing: top-cut rows first, then Swiss rows by points. `k = min(topCut, standings.length)`.",
    "",
    `- \`topCut\` missing/non-numeric (skipped): ${topCutMissing}`,
    `- \`topCut\` = 0 (check (a) over all rows, no check (b)): **${topCutZero}**`,
    `- \`topCut\` > 0: ${topCutPositive}`,
    `- \`topCut\` > standings length: ${topCutExceeds}`,
    "",
    "**(a)** Rows from index k onward non-increasing in Swiss points, ties allowed. Points are `5×W + draws` (5/1/0) or `3×W + draws` (3/1/0), where W is `winsSwiss` without byes, or `winsSwiss + byes` with each bye counted as a win.",
    "",
    byesReturned
      ? `- Standings rows with a numeric \`byes\`: ${vs(byesRows, orderRows)}`
      : "- `byes` was not returned for any row, so the with-byes column is n/a.",
    "",
    "| tournaments | without byes | with byes |",
    "|---|---:|---:|",
    `| checked | ${plain.checked} | ${byesCell(String(withByes.checked))} |`,
    `| skipped (missing numeric fields) | ${plain.skipped} | ${byesCell(String(withByes.skipped))} |`,
    `| violations under 5/1/0 | ${vs(plain.fail5, plain.checked)} | ${byesCell(vs(withByes.fail5, withByes.checked))} |`,
    `| violations under 3/1/0 | ${vs(plain.fail3, plain.checked)} | ${byesCell(vs(withByes.fail3, withByes.checked))} |`,
    `| violations under both | **${vs(plain.failBoth, plain.checked)}** | **${byesCell(vs(withByes.failBoth, withByes.checked))}** |`,
    "",
    `Remaining violators: the ${remaining.failBoth} tournaments that fail under both systems ${byesReturned ? "with byes counted" : "(without byes, since byes were not returned)"}. Position of the first violation, measured under 5/1/0, is the index of the first row with more points than the row above it, divided by standings length.`,
    "",
    "| first violation in | tournaments |",
    "|---|---:|",
    ...THIRDS.map((third) => `| ${third} | ${vs(remaining.firstViolation[third], remaining.failBoth)} |`),
    "",
    "**(b)** First k rows all have `winsBracket > 0 || lossesBracket > 0`:",
    "",
    `- Checked: ${bChecked}; skipped for missing numeric bracket fields: ${bSkippedFields}`,
    `- Failures: **${bFail}** (${pct(bFail, bChecked)})`,
    "- Caveat: byes or drawn cut pods may leave both bracket counts at 0 for a player who did make the cut.",
    "",
  );

  // 8. Coverage by event size, team events excluded
  type Cell = { events: number; rows: number; leaderRows: number; locEvents: number; countryEvents: number; leaderCountryRows: number };
  const zeroCell = (): Cell => ({ events: 0, rows: 0, leaderRows: 0, locEvents: 0, countryEvents: 0, leaderCountryRows: 0 });
  const cells: Record<Bucket | "All", Cell> = { "<16": zeroCell(), "16-31": zeroCell(), "32-63": zeroCell(), "64+": zeroCell(), All: zeroCell() };
  let teamEvents = 0, playersRows = 0, playersRowsInTeamEvents = 0;
  for (const t of tournaments) {
    const st = (Array.isArray(t.standings) ? t.standings : []).filter(isObj);
    const withPlayers = st.filter((r) => "players" in r).length;
    playersRows += withPlayers;
    if (t.isTeamEvent === true) {
      teamEvents++;
      playersRowsInTeamEvents += withPlayers;
      continue;
    }
    const e: Obj = isObj(t.eventData) ? t.eventData : {};
    const hasLoc = LOC_FIELDS.some((f) => usable(e[f]));
    const hasCountry = usable(e.country);
    const leaderRows = st.filter(hasLeader).length;
    for (const c of [cells[bucketOf(st.length)], cells.All]) {
      c.events++;
      c.rows += st.length;
      c.leaderRows += leaderRows;
      if (hasLoc) c.locEvents++;
      if (hasCountry) {
        c.countryEvents++;
        c.leaderCountryRows += leaderRows;
      }
    }
  }
  p(
    "## 7. Coverage by event size (team events excluded)",
    "",
    `- Team events excluded (\`isTeamEvent: true\`): ${teamEvents}`,
    `- Standings rows carrying a \`players\` key: ${playersRows}, of which in team events: ${playersRowsInTeamEvents}`,
    `- "Any location field" means a non-blank ${LOC_FIELDS.join(", ")}. Leader shares are of rows; location and country shares are of events. "Leader and country" is the share of rows that have a leader and belong to an event with a country.`,
    "",
    "| size bucket | events | rows | rows with leader | events with any location field | events with country | rows with leader and country |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...([...BUCKETS, "All"] as const).map((b) => {
      const c = cells[b];
      const label = b === "All" ? "**All**" : b;
      return `| ${label} | ${c.events} | ${c.rows} | ${pct(c.leaderRows, c.rows)} | ${pct(c.locEvents, c.events)} | ${pct(c.countryEvents, c.events)} | ${pct(c.leaderCountryRows, c.rows)} |`;
    }),
    "",
  );

  process.stdout.write(out.join("\n"));
  log("Done.");
}

main().catch((err: unknown) => exitWithError("probe", err));
