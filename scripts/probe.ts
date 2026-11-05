// Data-quality probe for the TopDeck.gg API v2 (Milestone 1).
// Reads one calendar month of EDH tournaments and prints aggregates as markdown to stdout.
// No database access. Never prints player-identifying values.
// Data provided by TopDeck.gg — https://topdeck.gg

const BASE = "https://topdeck.gg/api";
const COLUMNS = ["wins", "draws", "losses", "winsSwiss", "winsBracket", "lossesSwiss", "lossesBracket"];
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

/** True if values are non-increasing (ties allowed). */
const nonIncreasing = (xs: number[]) => xs.every((x, i) => i === 0 || xs[i - 1]! >= x);

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
  const buckets = { "<16": 0, "16-31": 0, "32-63": 0, "64+": 0 };
  for (const t of tournaments) {
    const st = Array.isArray(t.standings) ? t.standings : [];
    const n = st.length;
    if (n < 16) buckets["<16"]++;
    else if (n < 32) buckets["16-31"]++;
    else if (n < 64) buckets["32-63"]++;
    else buckets["64+"]++;
    for (const r of st) {
      if (!isObj(r)) continue;
      rows++;
      if (typeof r.leader === "string" && r.leader.trim() !== "") withLeader++;
    }
  }
  p(
    "## 5. Commanders and event size",
    "",
    `- Standings rows with a non-empty \`leader\`: **${withLeader} / ${rows}** (${pct(withLeader, rows)})`,
    "",
    "| standings length | tournaments |",
    "|---|---:|",
    ...Object.entries(buckets).map(([b, c]) => `| ${b} | ${c} (${pct(c, N)}) |`),
    "",
  );

  // 7. Order checks
  let topCutMissing = 0, topCutZero = 0, topCutPositive = 0, topCutExceeds = 0;
  let aChecked = 0, aSkippedFields = 0, aFail5 = 0, aFail3 = 0, aFailBoth = 0;
  let bChecked = 0, bSkippedFields = 0, bFail = 0;
  for (const t of tournaments) {
    const st = (Array.isArray(t.standings) ? t.standings : []).filter(isObj);
    const topCut = num(t.topCut);
    if (topCut === undefined) {
      topCutMissing++;
      continue;
    }
    if (topCut === 0) topCutZero++;
    else topCutPositive++;
    if (topCut > st.length) topCutExceeds++;
    const k = Math.min(Math.max(0, topCut), st.length);

    // (a) Swiss rows ordered by points, under 5/1/0 and 3/1/0
    const swiss = st.slice(k);
    const ws = swiss.map((r) => num(r.winsSwiss));
    const ds = swiss.map((r) => num(r.draws));
    if (ws.some((v) => v === undefined) || ds.some((v) => v === undefined)) aSkippedFields++;
    else {
      aChecked++;
      const ok5 = nonIncreasing(ws.map((w, i) => 5 * w! + ds[i]!));
      const ok3 = nonIncreasing(ws.map((w, i) => 3 * w! + ds[i]!));
      if (!ok5) aFail5++;
      if (!ok3) aFail3++;
      if (!ok5 && !ok3) aFailBoth++;
    }

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
    "**(a)** Rows from index k onward non-increasing in Swiss points, ties allowed:",
    "",
    `- Checked: ${aChecked}; skipped for missing numeric \`winsSwiss\`/\`draws\`: ${aSkippedFields}`,
    `- Violations under 5/1/0 (\`5×winsSwiss + draws\`): **${aFail5}** (${pct(aFail5, aChecked)})`,
    `- Violations under 3/1/0 (\`3×winsSwiss + draws\`): **${aFail3}** (${pct(aFail3, aChecked)})`,
    `- Violations under both (not in points order under either system): **${aFailBoth}** (${pct(aFailBoth, aChecked)})`,
    "",
    "**(b)** First k rows all have `winsBracket > 0 || lossesBracket > 0`:",
    "",
    `- Checked: ${bChecked}; skipped for missing numeric bracket fields: ${bSkippedFields}`,
    `- Failures: **${bFail}** (${pct(bFail, bChecked)})`,
    "- Caveat: byes or drawn cut pods may leave both bracket counts at 0 for a player who did make the cut.",
    "",
  );

  process.stdout.write(out.join("\n"));
  log("Done.");
}

main().catch((err: unknown) => {
  log(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
