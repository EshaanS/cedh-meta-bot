// Monthly post composer: turns one region and month into a Discord embed object and a plain-text preview.
// loadPostData reads the database; composePost is pure and works on the saved data (test fixtures use it).
// No Discord HTTP here. Every post carries "Data provided by TopDeck.gg" with a link (CLAUDE.md hard rule).
import type { Sql } from "./db.js";

export const POST_CONFIG = {
  bestResultsMinEntries: 30,
  risingMinLastMonthEntries: 10,
  winnersMax: 3,
  mostPlayedMax: 3,
  bestResultsMax: 3,
  risingMax: 2,
  eventNameMax: 50,
  contentBudget: 1000,
} as const;
export type PostConfig = { [K in keyof typeof POST_CONFIG]: number };

/** Discord embed limits (characters). */
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, fields: 25, total: 6000 } as const;

export type PostData = {
  month: string; // YYYY-MM
  requested: { id: string; displayName: string };
  resolved: { id: string; displayName: string; stepsUp: number; reportable: boolean };
  coverage: { qualifyingEvents: number; pctEntriesWithLeader: number | null };
  results: { eventName: string | null; participantCount: number; location: string | null; result: string; resultCommanders: string | null }[];
  metaShare: { commander: string; entries: number; metaShare: number }[];
  ppg: { commander: string; entries: number; ppg: number; shrunkPpg: number }[];
  growth: { commander: string; lastMonthEntries: number; shareGrowth: number | null; isNew: boolean }[];
};

export type EmbedField = { name: string; value: string; inline?: boolean };
export type Embed = { title: string; description: string; fields: EmbedField[]; footer: { text: string } };

const ATTRIBUTION_MD = "Data provided by [TopDeck.gg](https://topdeck.gg) · Methods: [cedhstats.org](https://cedhstats.org/about)";
const ATTRIBUTION_TEXT = "Data provided by TopDeck.gg · Methods: cedhstats.org";
const ATTRIBUTION_PREVIEW = "Data provided by TopDeck.gg (https://topdeck.gg) · Methods: cedhstats.org (https://cedhstats.org/about)";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Organizer-written text (event names, locations): removes URLs and Discord mention/markdown characters,
 * collapses whitespace, and truncates with an ellipsis.
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

const pct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`;
const monthLabel = (month: string) => {
  const [y, m] = month.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};

export function contentLength(embed: Embed): number {
  return embed.title.length + embed.description.length + embed.footer.text.length +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

export function discordLimitViolations(embed: Embed): string[] {
  const v: string[] = [];
  if (embed.title.length > DISCORD_LIMITS.title) v.push(`title ${embed.title.length} > ${DISCORD_LIMITS.title}`);
  if (embed.description.length > DISCORD_LIMITS.description) v.push(`description ${embed.description.length} > ${DISCORD_LIMITS.description}`);
  if (embed.footer.text.length > DISCORD_LIMITS.footer) v.push(`footer ${embed.footer.text.length} > ${DISCORD_LIMITS.footer}`);
  if (embed.fields.length > DISCORD_LIMITS.fields) v.push(`fields ${embed.fields.length} > ${DISCORD_LIMITS.fields}`);
  for (const f of embed.fields) {
    if (f.name.length === 0 || f.name.length > DISCORD_LIMITS.fieldName) v.push(`field name "${f.name}" length ${f.name.length}`);
    if (f.value.length === 0 || f.value.length > DISCORD_LIMITS.fieldValue) v.push(`field "${f.name}" value length ${f.value.length}`);
  }
  const total = contentLength(embed);
  if (total > DISCORD_LIMITS.total) v.push(`total ${total} > ${DISCORD_LIMITS.total}`);
  return v;
}

type Section = { name: string; lines: string[] };

function buildSections(data: PostData, c: PostConfig, caps: { winners: number; mostPlayed: number; best: number; rising: number }): Section[] {
  const sections: Section[] = [];
  const mon = MONTHS[Number(data.month.split("-")[1]) - 1];

  const decided = data.results
    .filter((r) => r.result === "winner" || r.result === "final drawn")
    .sort((a, b) => b.participantCount - a.participantCount);
  const winnerLines = decided.slice(0, caps.winners).map((r) => {
    const name = sanitizeOrganizerText(r.eventName ?? "Unnamed event", c.eventNameMax) || "Unnamed event";
    const commanders = (r.resultCommanders ?? "unknown").split("; ").map((x) => (x === "unknown" ? "unknown commander" : shortenCommander(x)));
    const outcome = r.result === "winner" ? commanders[0]! : `Drawn final: ${commanders.join(", ")}`;
    return `• ${r.participantCount}p · ${name} · ${outcome}`;
  });
  if (decided.length > caps.winners) winnerLines.push(`+${decided.length - caps.winners} more`);
  sections.push({ name: `Winners — ${mon} (32+ players)`, lines: winnerLines.length ? winnerLines : ["None this month."] });

  if (!data.resolved.reportable) return sections;

  const most = data.metaShare.slice(0, caps.mostPlayed);
  if (most.length) {
    sections.push({ name: "Most played (6 months)", lines: most.map((m, i) => `${i + 1}. ${shortenCommander(m.commander)} — ${pct(m.metaShare)}`) });
  }

  const best = [...data.ppg].filter((p) => p.entries >= c.bestResultsMinEntries).sort((a, b) => b.shrunkPpg - a.shrunkPpg).slice(0, caps.best);
  if (best.length) {
    sections.push({
      name: `Best results (adjusted PPG, ${c.bestResultsMinEntries}+ entries)`,
      lines: best.map((p, i) => `${i + 1}. ${shortenCommander(p.commander)} — ${p.shrunkPpg.toFixed(2)} (n = ${p.entries})`),
    });
  }

  const rising = data.growth
    .filter((g) => g.lastMonthEntries >= c.risingMinLastMonthEntries && (g.isNew || (g.shareGrowth ?? 0) > 0))
    .sort((a, b) => Number(b.isNew) - Number(a.isNew) || (b.shareGrowth ?? 0) - (a.shareGrowth ?? 0))
    .slice(0, caps.rising);
  if (rising.length) {
    sections.push({
      name: "Rising (share vs prior 3 months)",
      lines: rising.map((g) => `${shortenCommander(g.commander)} — ${g.isNew ? "new" : `+${(100 * g.shareGrowth!).toFixed(0)}% share`}`),
    });
  }
  return sections;
}

function header(data: PostData): { title: string; lines: string[] } {
  const title = `${data.resolved.displayName} — cEDH meta, ${monthLabel(data.month)}`;
  const lines: string[] = [];
  if (data.resolved.stepsUp > 0) lines.push(`Showing ${data.resolved.displayName}: ${data.requested.displayName} didn't have enough data.`);
  if (!data.resolved.reportable) lines.push("Not enough decklists yet for commander stats.");
  const leaderPct = data.coverage.pctEntriesWithLeader === null ? "n/a" : `${data.coverage.pctEntriesWithLeader.toFixed(0)}%`;
  lines.push(`${data.coverage.qualifyingEvents} qualifying events (6 months) · ${leaderPct} of entries with decklists`);
  return { title, lines };
}

/** Pure: builds the embed and the plain-text preview, trimming sections until the content budget fits. */
export function composePost(data: PostData, config: PostConfig = POST_CONFIG): { embed: Embed; text: string } {
  const caps = { winners: config.winnersMax, mostPlayed: config.mostPlayedMax, best: config.bestResultsMax, rising: config.risingMax };
  // Trim order when over budget: Winners lines (to 1), Rising (to 1), Best results (to 2), Most played (to 2).
  const trims: (() => boolean)[] = [
    () => caps.winners > 1 && (caps.winners--, true),
    () => caps.rising > 1 && (caps.rising--, true),
    () => caps.best > 2 && (caps.best--, true),
    () => caps.mostPlayed > 2 && (caps.mostPlayed--, true),
  ];

  const { title, lines: headLines } = header(data);
  let embed: Embed;
  let sections: Section[];
  for (;;) {
    sections = buildSections(data, config, caps);
    embed = {
      title,
      description: headLines.join("\n"),
      fields: [...sections.map((s) => ({ name: s.name, value: s.lines.join("\n") })), { name: "Sources", value: ATTRIBUTION_MD }],
      footer: { text: ATTRIBUTION_TEXT },
    };
    if (contentLength(embed) <= config.contentBudget) break;
    const trimmed = trims.find((t) => t());
    if (!trimmed) break;
  }

  const violations = discordLimitViolations(embed);
  if (violations.length) throw new Error(`embed exceeds Discord limits: ${violations.join("; ")}`);

  const text = [
    title,
    ...headLines,
    ...sections.flatMap((s) => ["", s.name, ...s.lines]),
    "",
    ATTRIBUTION_PREVIEW,
  ].join("\n");
  return { embed, text };
}

/** Reads everything composePost needs from the stat functions. The result is JSON-serializable. */
export async function loadPostData(sql: Sql, regionId: string, month: string): Promise<PostData> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const end = `${month}-01`;
  const [requested] = await sql<{ id: string; display_name: string }[]>`select id, display_name from regions where id = ${regionId}`;
  if (!requested) throw new Error(`unknown region id: ${regionId}`);
  const [res] = await sql<{ region_id: string; steps_up: number; reportable: boolean; display_name: string }[]>`
    select rr.region_id, rr.steps_up, rr.reportable, r.display_name
    from resolve_region(${regionId}, ${end}::date) rr join regions r on r.id = rr.region_id`;
  if (!res) throw new Error("resolve_region returned no row");
  const r = res.region_id;

  const [cov] = await sql<{ qualifying_events: string; pct_entries_with_leader: number | null }[]>`
    select qualifying_events, pct_entries_with_leader from stat_coverage(${r}, ${end}::date)`;
  const results = await sql<{ event_name: string | null; participant_count: number; location: string | null; result: string; result_commanders: string | null }[]>`
    select event_name, participant_count, location, result, result_commanders
    from stat_notable_results(${r}, ${end}::date)
    where result in ('winner', 'final drawn')`;
  const meta = await sql<{ commander: string; entries: string; meta_share: number }[]>`
    select commander, entries, meta_share from stat_meta_share(${r}, ${end}::date) limit 20`;
  const ppg = await sql<{ commander: string; entries: string; ppg: number; shrunk_ppg: number }[]>`
    select commander, entries, ppg, shrunk_ppg from stat_ppg(${r}, ${end}::date)`;
  const growth = await sql<{ commander: string; last_month_entries: string; share_growth: number | null; is_new: boolean }[]>`
    select commander, last_month_entries, share_growth, is_new from stat_growth(${r}, ${end}::date)`;

  return {
    month,
    requested: { id: requested.id, displayName: requested.display_name },
    resolved: { id: r, displayName: res.display_name, stepsUp: res.steps_up, reportable: res.reportable },
    coverage: {
      qualifyingEvents: Number(cov?.qualifying_events ?? 0),
      pctEntriesWithLeader: cov?.pct_entries_with_leader == null ? null : Number(cov.pct_entries_with_leader),
    },
    results: results.map((x) => ({
      eventName: x.event_name, participantCount: x.participant_count, location: x.location,
      result: x.result, resultCommanders: x.result_commanders,
    })),
    metaShare: meta.map((m) => ({ commander: m.commander, entries: Number(m.entries), metaShare: m.meta_share })),
    ppg: ppg.map((p) => ({ commander: p.commander, entries: Number(p.entries), ppg: p.ppg, shrunkPpg: p.shrunk_ppg })),
    growth: growth.map((g) => ({
      commander: g.commander, lastMonthEntries: Number(g.last_month_entries), shareGrowth: g.share_growth, isNew: g.is_new,
    })),
  };
}
