// Monthly post composer (v2 newsletter): turns one region and month into a Discord embed and a text preview.
// loadPostData reads the database; composePost is pure and works on the saved data (test fixtures use it).
// No Discord HTTP here. The Sources field carries "Data provided by TopDeck.gg" with a link (CLAUDE.md rule).
import type { Sql } from "./db";

export const POST_CONFIG = {
  contentBudget: 3000,
  eventNameMax: 50,
  winnersMax: 10,
  topCutMax: 5,
  mostPlayedMax: 10,
  arrowThreshold: 0.003, // ±0.3 percentage points of meta share
  bestResultsMax: 5,
  bestResultsMinEntries: 30,
  conversionMax: 5,
  conversionMinCutEntries: 30,
  risingMax: 3,
  risingMinLastMonthEntries: 10,
  coolingMax: 3,
  coolingTopN: 15,
  coolingMinEntries: 10,
  /** Rising needs entries above the prior-3-month average and Cooling off below it, so counts never contradict. */
  trendNeedsMatchingCounts: 1,
} as const;
export type PostConfig = { [K in keyof typeof POST_CONFIG]: number };

/** Discord embed limits (characters). */
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, fields: 25, total: 6000 } as const;

export type PostData = {
  month: string; // YYYY-MM
  requested: { id: string; label: string };
  resolved: { id: string; label: string; stepsUp: number; reportable: boolean };
  scene: {
    events: number; players: number; prevEvents: number; prevPlayers: number;
    largestEventName: string | null; largestEventPlayers: number | null; drawRate: number | null;
  };
  coverage: { qualifyingEvents: number; pctEntriesWithLeader: number | null };
  results: { eventName: string | null; participantCount: number; result: string; resultCommanders: string | null }[];
  topCutAppearances: { commander: string; topCutEntries: number }[];
  metaShare: { commander: string; entries: number; metaShare: number; priorShare: number | null }[];
  priorWindowEntries: number;
  ppg: { commander: string; entries: number; ppg: number; shrunkPpg: number }[];
  conversion: { commander: string; entriesInCutEvents: number; topCutEntries: number; conversion: number }[];
  baselineConversion: number | null;
  trend: { commander: string; lastMonthEntries: number; prior3AvgEntries: number; shareChange: number | null; isNew: boolean }[];
};

export type EmbedField = { name: string; value: string; inline?: boolean };
export type Embed = { title: string; description?: string; fields: EmbedField[] };

const ATTRIBUTION_MD = "Data provided by [TopDeck.gg](https://topdeck.gg) · Methods: [cedhstats.org](https://cedhstats.org/about)";
const ATTRIBUTION_PREVIEW = "Data provided by TopDeck.gg (https://topdeck.gg) · Methods: cedhstats.org (https://cedhstats.org/about)";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Organizer-written text (event names): removes URLs and Discord mention/markdown characters, collapses
 * whitespace, and truncates with an ellipsis.
 */
export function sanitizeOrganizerText(text: string, max: number): string {
  const cleaned = text
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\b(discord\.gg|discord(app)?\.com\/invite)\/\S+/gi, "")
    .replace(/[@<>*_~`|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** Partner pairs become "Kraum / Tymna the Weaver" (each half cut at its first comma); singles stay whole. */
export function shortenCommander(name: string): string {
  if (!name.includes(" / ")) return name;
  return name
    .split(" / ")
    .map((half) => half.split(",")[0]!.trim())
    .join(" / ");
}

/** Prior-3-month average entries: nearest whole number, or "<1" below 1. */
export const monthlyAvg = (avg: number) => (avg < 1 ? "<1" : String(Math.round(avg)));

/** ↑ / ↓ / – against the previous window; null when there is no previous window to compare with. */
export function shareArrow(share: number, priorShare: number | null, priorWindowEntries: number, threshold: number): string | null {
  if (priorWindowEntries <= 0) return null;
  const diff = share - (priorShare ?? 0);
  if (diff > threshold) return "↑";
  if (diff < -threshold) return "↓";
  return "–";
}

const pct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`;
const int = (n: number) => n.toLocaleString("en-US");
const signedPctChange = (cur: number, prev: number) => {
  if (prev <= 0) return null;
  const c = Math.round((100 * (cur - prev)) / prev);
  return `${c >= 0 ? "+" : ""}${c}%`;
};
const monthOf = (yyyyMm: string, offset = 0) => {
  const d = new Date(Date.UTC(Number(yyyyMm.slice(0, 4)), Number(yyyyMm.slice(5, 7)) - 1 + offset, 1));
  return MONTHS[d.getUTCMonth()]!;
};

export function contentLength(embed: Embed): number {
  return embed.title.length + (embed.description?.length ?? 0) + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function discordLimitViolations(embed: Embed): string[] {
  const v: string[] = [];
  if (embed.title.length > DISCORD_LIMITS.title) v.push(`title ${embed.title.length} > ${DISCORD_LIMITS.title}`);
  if ((embed.description?.length ?? 0) > DISCORD_LIMITS.description) v.push(`description too long`);
  if (embed.description === "") v.push("description is empty (omit it instead)");
  if (embed.fields.length > DISCORD_LIMITS.fields) v.push(`fields ${embed.fields.length} > ${DISCORD_LIMITS.fields}`);
  for (const f of embed.fields) {
    if (f.name.length === 0 || f.name.length > DISCORD_LIMITS.fieldName) v.push(`field name "${f.name}" length ${f.name.length}`);
    if (f.value.length === 0 || f.value.length > DISCORD_LIMITS.fieldValue) v.push(`field "${f.name}" value length ${f.value.length}`);
  }
  const total = contentLength(embed);
  if (total > DISCORD_LIMITS.total) v.push(`total ${total} > ${DISCORD_LIMITS.total}`);
  return v;
}

/** Keeps lines from the top while the joined value fits Discord's field limit. */
function fitLines(lines: string[], max = DISCORD_LIMITS.fieldValue): string[] {
  const out: string[] = [];
  let len = 0;
  for (const l of lines) {
    const add = (out.length ? 1 : 0) + l.length;
    if (len + add > max) break;
    out.push(l);
    len += add;
  }
  return out;
}

type Caps = { winners: number; topCut: number; mostPlayed: number; best: number; conversion: number; rising: number; cooling: number };
type Section = { name: string; lines: string[]; inline?: boolean };

function buildSections(data: PostData, c: PostConfig, caps: Caps): Section[] {
  const s: Section[] = [];
  const mon = monthOf(data.month);
  const prevMon = monthOf(data.month, -1);

  // Scene this month (inline)
  const sc = data.scene;
  if (sc.events > 0) {
    const evChange = signedPctChange(sc.events, sc.prevEvents);
    const plChange = signedPctChange(sc.players, sc.prevPlayers);
    s.push({ name: `Events — ${mon}`, lines: [`${int(sc.events)}${evChange ? ` (${evChange} vs ${prevMon})` : ""}`], inline: true });
    s.push({ name: "Players", lines: [`${int(sc.players)}${plChange ? ` (${plChange})` : ""}`], inline: true });
    if (sc.drawRate !== null) s.push({ name: "Draw rate", lines: [pct(sc.drawRate, 0)], inline: true });
    if (sc.largestEventName && sc.largestEventPlayers) {
      const name = sanitizeOrganizerText(sc.largestEventName, c.eventNameMax) || "Unnamed event";
      s.push({ name: "Largest event", lines: [`${sc.largestEventPlayers} players · ${name}`], inline: true });
    }
  }

  // Winners
  const winnerLines = data.results.slice(0, caps.winners).map((r) => {
    const name = sanitizeOrganizerText(r.eventName ?? "Unnamed event", c.eventNameMax) || "Unnamed event";
    const commanders = (r.resultCommanders ?? "").split("; ").filter(Boolean).map((x) => (x === "unknown" ? "unknown commander" : shortenCommander(x)));
    const outcome =
      r.result === "winner" ? (commanders[0] ?? "winner not recorded")
      : r.result === "final drawn" ? `drawn final: ${commanders.join(", ")}`
      : r.result;
    return `• ${r.participantCount}p · ${name} · ${outcome}`;
  });
  if (winnerLines.length) s.push({ name: `Winners — ${mon} (largest events)`, lines: fitLines(winnerLines) });

  if (!data.resolved.reportable) return s;

  const top = data.topCutAppearances.slice(0, caps.topCut);
  if (top.length) s.push({ name: `Top-cut appearances — ${mon}`, lines: top.map((t, i) => `${i + 1}. ${shortenCommander(t.commander)} — ${t.topCutEntries}`) });

  const most = data.metaShare.slice(0, caps.mostPlayed);
  if (most.length) {
    s.push({
      name: "Most played (6 months)",
      lines: most.map((m, i) => {
        const arrow = shareArrow(m.metaShare, m.priorShare, data.priorWindowEntries, c.arrowThreshold);
        return `${i + 1}. ${shortenCommander(m.commander)} — ${pct(m.metaShare)}${arrow ? ` ${arrow}` : ""}`;
      }),
    });
  }

  const best = data.ppg.filter((p) => p.entries >= c.bestResultsMinEntries).sort((a, b) => b.shrunkPpg - a.shrunkPpg).slice(0, caps.best);
  if (best.length) {
    s.push({
      name: `Best results (adjusted PPG, ${c.bestResultsMinEntries}+ entries)`,
      lines: best.map((p, i) => `${i + 1}. ${shortenCommander(p.commander)} — ${p.shrunkPpg.toFixed(2)} (n = ${p.entries})`),
    });
  }

  const conv = data.conversion
    .filter((x) => x.entriesInCutEvents >= c.conversionMinCutEntries)
    .sort((a, b) => b.conversion - a.conversion || b.entriesInCutEvents - a.entriesInCutEvents)
    .slice(0, caps.conversion);
  if (conv.length) {
    const base = data.baselineConversion === null ? "" : ` (baseline ${pct(data.baselineConversion, 0)})`;
    s.push({
      name: `Top-cut conversion${base}`,
      lines: conv.map((x, i) => `${i + 1}. ${shortenCommander(x.commander)} — ${pct(x.conversion, 0)} (n = ${x.entriesInCutEvents})`),
    });
  }

  const matching = c.trendNeedsMatchingCounts > 0;
  const countLine = (t: PostData["trend"][number]) =>
    t.isNew
      ? `${shortenCommander(t.commander)} — ${t.lastMonthEntries} entries in ${mon}, new`
      : `${shortenCommander(t.commander)} — ${t.lastMonthEntries} entries in ${mon} (avg ${monthlyAvg(t.prior3AvgEntries)}/month)`;

  const rising = data.trend
    .filter((t) => t.lastMonthEntries >= c.risingMinLastMonthEntries)
    .filter((t) => t.isNew || ((t.shareChange ?? 0) > 0 && (!matching || t.lastMonthEntries > t.prior3AvgEntries)))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || (b.shareChange ?? 0) - (a.shareChange ?? 0))
    .slice(0, caps.rising);
  if (rising.length) s.push({ name: "Rising (by share growth vs prior 3 months)", lines: rising.map(countLine) });

  const topCommanders = new Set(data.metaShare.slice(0, c.coolingTopN).map((m) => m.commander));
  const cooling = data.trend
    .filter((t) => topCommanders.has(t.commander) && !t.isNew && t.shareChange !== null && t.shareChange < 0)
    .filter((t) => t.lastMonthEntries >= c.coolingMinEntries || t.prior3AvgEntries >= c.coolingMinEntries)
    .filter((t) => !matching || t.lastMonthEntries < t.prior3AvgEntries)
    .sort((a, b) => a.shareChange! - b.shareChange!)
    .slice(0, caps.cooling);
  if (cooling.length) s.push({ name: "Cooling off (by share drop vs prior 3 months)", lines: cooling.map(countLine) });

  return s;
}

function coverageLine(data: PostData): string {
  const leaderPct = data.coverage.pctEntriesWithLeader === null ? "n/a" : `${data.coverage.pctEntriesWithLeader.toFixed(0)}%`;
  return `${int(data.coverage.qualifyingEvents)} qualifying events over 6 months · ${leaderPct} of entries with decklists`;
}

/** Pure: builds the embed and the plain-text preview, trimming bottom sections first until the budget fits. */
export function composePost(data: PostData, config: PostConfig = POST_CONFIG): { embed: Embed; text: string } {
  const caps: Caps = {
    winners: config.winnersMax, topCut: config.topCutMax, mostPlayed: config.mostPlayedMax, best: config.bestResultsMax,
    conversion: config.conversionMax, rising: config.risingMax, cooling: config.coolingMax,
  };
  // Trim order, bottom sections first, each to a floor; then deeper cuts in the same order.
  const step = (k: keyof Caps, floor: number) => () => caps[k] > floor && (caps[k]--, true);
  const trims = [
    step("cooling", 0), step("rising", 0), step("conversion", 3), step("best", 3), step("mostPlayed", 5), step("topCut", 3), step("winners", 5),
    step("conversion", 0), step("best", 0), step("topCut", 0), step("mostPlayed", 3), step("winners", 3),
  ];

  const title = `${data.resolved.label} — cEDH meta, ${monthOf(data.month)} ${data.month.slice(0, 4)}`;
  const notes: string[] = [];
  if (data.resolved.stepsUp > 0) notes.push(`Showing ${data.resolved.label}: ${data.requested.label} didn't have enough data.`);
  if (!data.resolved.reportable) notes.push("Not enough decklists yet for commander stats.");

  let embed: Embed;
  let sections: Section[];
  for (;;) {
    sections = buildSections(data, config, caps);
    embed = {
      title,
      ...(notes.length ? { description: notes.join("\n") } : {}),
      fields: [
        ...sections.map((x) => ({ name: x.name, value: x.lines.join("\n"), ...(x.inline ? { inline: true } : {}) })),
        { name: "Coverage", value: coverageLine(data) },
        { name: "Sources", value: ATTRIBUTION_MD },
      ],
    };
    if (contentLength(embed) <= config.contentBudget) break;
    if (!trims.find((t) => t())) break;
  }

  const violations = discordLimitViolations(embed);
  if (violations.length) throw new Error(`embed exceeds Discord limits: ${violations.join("; ")}`);

  const inline = sections.filter((x) => x.inline).map((x) => `${x.name}: ${x.lines.join(" ")}`);
  const blocks = sections.filter((x) => !x.inline).flatMap((x) => ["", x.name, ...x.lines]);
  const text = [title, ...notes, ...(inline.length ? ["", ...inline] : []), ...blocks, "", coverageLine(data), ATTRIBUTION_PREVIEW].join("\n");
  return { embed, text };
}

/** Reads everything composePost needs. The result is JSON-serializable (it is the fixture format). */
export async function loadPostData(sql: Sql, regionId: string, month: string): Promise<PostData> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const end = `${month}-01`;
  const [requested] = await sql<{ id: string; label: string }[]>`select id, region_label(id) as label from regions where id = ${regionId}`;
  if (!requested) throw new Error(`unknown region id: ${regionId}`);
  const [res] = await sql<{ region_id: string; steps_up: number; reportable: boolean; label: string }[]>`
    select rr.region_id, rr.steps_up, rr.reportable, region_label(rr.region_id) as label from resolve_region(${regionId}, ${end}::date) rr`;
  if (!res) throw new Error("resolve_region returned no row");
  const r = res.region_id;
  const prevEnd = `${month}-01`;

  const [scene] = await sql<{ events: string; players: string; prev_events: string; prev_players: string; largest_event_name: string | null; largest_event_players: number | null; draw_rate: number | null }[]>`
    select * from stat_scene(${r}, ${end}::date)`;
  const [cov] = await sql<{ qualifying_events: string; pct_entries_with_leader: number | null }[]>`
    select qualifying_events, pct_entries_with_leader from stat_coverage(${r}, ${end}::date)`;
  const results = await sql<{ event_name: string | null; participant_count: number; result: string; result_commanders: string | null }[]>`
    select event_name, participant_count, result, result_commanders from stat_month_results(${r}, ${end}::date, 10)`;
  const topCut = await sql<{ commander: string; top_cut_entries: string }[]>`
    select * from stat_top_cut_appearances(${r}, ${end}::date) limit 10`;
  const meta = await sql<{ commander: string; entries: string; meta_share: number; prior_share: number | null }[]>`
    select m.commander, m.entries, m.meta_share, p.meta_share as prior_share
    from stat_meta_share(${r}, ${end}::date) m
    left join commander_shares(${r}, (${prevEnd}::date - interval '1 month')::date) p on p.commander = m.commander
    order by m.entries desc, m.commander
    limit 20`;
  const [prior] = await sql<{ n: string | null }[]>`
    select sum(entries) as n from commander_shares(${r}, (${prevEnd}::date - interval '1 month')::date)`;
  const ppg = await sql<{ commander: string; entries: string; ppg: number; shrunk_ppg: number }[]>`
    select commander, entries, ppg, shrunk_ppg from stat_ppg(${r}, ${end}::date)`;
  const conv = await sql<{ commander: string; entries_in_cut_events: string; top_cut_entries: string; conversion: number; baseline_conversion: number }[]>`
    select * from stat_conversion(${r}, ${end}::date)`;
  const trend = await sql<{ commander: string; last_month_entries: string; prior3_avg_entries: number; share_change: number | null; is_new: boolean }[]>`
    select commander, last_month_entries, prior3_avg_entries, share_change, is_new from stat_share_trend(${r}, ${end}::date)`;

  return {
    month,
    requested: { id: requested.id, label: requested.label },
    resolved: { id: r, label: res.label, stepsUp: res.steps_up, reportable: res.reportable },
    scene: {
      events: Number(scene?.events ?? 0), players: Number(scene?.players ?? 0),
      prevEvents: Number(scene?.prev_events ?? 0), prevPlayers: Number(scene?.prev_players ?? 0),
      largestEventName: scene?.largest_event_name ?? null, largestEventPlayers: scene?.largest_event_players ?? null,
      drawRate: scene?.draw_rate ?? null,
    },
    coverage: {
      qualifyingEvents: Number(cov?.qualifying_events ?? 0),
      pctEntriesWithLeader: cov?.pct_entries_with_leader == null ? null : Number(cov.pct_entries_with_leader),
    },
    results: results.map((x) => ({ eventName: x.event_name, participantCount: x.participant_count, result: x.result, resultCommanders: x.result_commanders })),
    topCutAppearances: topCut.map((t) => ({ commander: t.commander, topCutEntries: Number(t.top_cut_entries) })),
    metaShare: meta.map((m) => ({ commander: m.commander, entries: Number(m.entries), metaShare: m.meta_share, priorShare: m.prior_share })),
    priorWindowEntries: Number(prior?.n ?? 0),
    ppg: ppg.map((p) => ({ commander: p.commander, entries: Number(p.entries), ppg: p.ppg, shrunkPpg: p.shrunk_ppg })),
    conversion: conv.map((x) => ({
      commander: x.commander, entriesInCutEvents: Number(x.entries_in_cut_events), topCutEntries: Number(x.top_cut_entries), conversion: x.conversion,
    })),
    baselineConversion: conv[0]?.baseline_conversion ?? null,
    trend: trend.map((t) => ({
      commander: t.commander, lastMonthEntries: Number(t.last_month_entries), prior3AvgEntries: Number(t.prior3_avg_entries),
      shareChange: t.share_change, isNew: t.is_new,
    })),
  };
}
