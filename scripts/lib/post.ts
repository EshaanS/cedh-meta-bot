// Monthly post composer (v2 newsletter): turns one region and month into a Discord embed and a text preview.
// loadPostData reads the database; composePost is pure and works on the saved data (test fixtures use it).
// No Discord HTTP here. The Sources field carries "Data provided by TopDeck.gg" with a link (CLAUDE.md rule).
import type { Sql } from "./db";

export const POST_CONFIG = {
  contentBudget: 4500, // Discord's hard limit for an embed is 6,000
  /** Years of player history ingested; shown on Rising players so "first" isn't read as "new to the game". */
  playerHistoryYears: 3,
  eventNameMax: 50,
  winnersMax: 10,
  /** Longer player names are cut at the last whole word that fits, with an ellipsis. */
  playerNameMax: 40,
  topPlayersMax: 5,
  risingPlayersMax: 3,
  topCutMax: 5,
  mostPlayedMax: 10,
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

  // Look. Dividers and emoji count against contentBudget like any other text.
  /** Embed accent color (gold). */
  embedColor: 0xc9a84c,
  /** Field placed between the scene, people and decks blocks. An empty dividerName turns dividers off. */
  dividerName: "━━━━━━━━━━━━━━━━━━━━",
  /** Discord rejects an empty field value, so the divider's value is a zero-width space. */
  dividerValue: "\u200b",
  /** Put after the number on ranked lines. "\\." shows as "1." but stops Discord from turning the lines into a
   *  markdown list, which adds its own indent and spacing. The text preview always shows a plain "1.". */
  listNumberSuffix: "\\.",
  /** Prefix of each section's field name ("" for none). "scene" goes on the first scene field only. */
  sectionEmoji: {
    scene: "📍", winners: "🏆", topPlayers: "👑", risingPlayers: "🌱", topCut: "🎯", mostPlayed: "📊", best: "⭐",
    conversion: "🔀", risingCommanders: "📈", coolingCommanders: "📉", coverage: "ℹ️", sources: "🔗",
  },
} as const;
type Widen<T> = T extends number ? number : T extends string ? string : { -readonly [K in keyof T]: Widen<T[K]> };
export type PostConfig = Widen<typeof POST_CONFIG>;
type SectionKey = keyof PostConfig["sectionEmoji"];

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
  /** pctEntriesWithPlayer: share (0-100) of the month's qualifying entries with a TopDeck account id. */
  coverage: { qualifyingEvents: number; pctEntriesWithLeader: number | null; pctEntriesWithPlayer: number | null };
  /** winnerName is null when there is no single winner, the player is unknown or removed, or opted out (winnerHidden). */
  results: {
    eventName: string | null; participantCount: number; result: string; resultCommanders: string | null;
    winnerName: string | null; winnerHidden: boolean;
  }[];
  /** Opted-out and removed players never appear in these two lists (filtered in SQL). */
  topPlayers: { name: string; wins: number; topCuts: number; commander: string | null }[];
  risingPlayers: { name: string; reason: string; eventName: string | null; participantCount: number }[];
  topCutAppearances: { commander: string; topCutEntries: number }[];
  metaShare: { commander: string; entries: number; metaShare: number }[];
  ppg: { commander: string; entries: number; ppg: number; shrunkPpg: number }[];
  conversion: { commander: string; entriesInCutEvents: number; topCutEntries: number; conversion: number }[];
  baselineConversion: number | null;
  trend: { commander: string; lastMonthEntries: number; prior3AvgEntries: number; shareChange: number | null; isNew: boolean }[];
};

export type EmbedField = { name: string; value: string; inline?: boolean };
export type Embed = { title: string; description?: string; color?: number; fields: EmbedField[] };

const ATTRIBUTION_MD = "Data provided by [TopDeck.gg](https://topdeck.gg) · Methods: [cedhstats.org](https://cedhstats.org/about)";
const ATTRIBUTION_PREVIEW = "Data provided by TopDeck.gg (https://topdeck.gg) · Methods: cedhstats.org (https://cedhstats.org/about)";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Organizer-written text (event names): removes URLs and Discord mention/markdown characters, collapses
 * whitespace, and truncates with an ellipsis. With `wholeWords` (used for player names) the cut falls at the
 * last space before the limit instead of mid-word, unless that would drop more than half of the allowed length
 * (a single very long word is still cut mid-word).
 */
export function sanitizeOrganizerText(text: string, max: number, opts: { wholeWords?: boolean } = {}): string {
  const cleaned = text
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\b(discord\.gg|discord(app)?\.com\/invite)\/\S+/gi, "")
    .replace(/[@<>*_~`|[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const midWord = cleaned[max - 1] !== " ";
  if (opts.wholeWords && (!midWord || lastSpace >= max / 2)) {
    // Also drop a separator left dangling at the end ("Name //", "Name -").
    return `${(midWord ? cut.slice(0, lastSpace) : cut).replace(/[\s/\-–—,.:;·(]+$/, "")}…`;
  }
  return `${cut.trimEnd()}…`;
}

/** Wording for stat_rising_players reasons that read better spelled out (the 5 is that function's cutoff). */
const RISING_REASON_TEXT: Record<string, string> = { "early top cut": "top cut in first 5 events" };

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

const pct = (x: number, digits = 1) => `${(100 * x).toFixed(digits)}%`;
const int = (n: number) => n.toLocaleString("en-US");
/** "+9% vs September", "-4% vs September", or "same as September" when the change rounds to 0%. */
export const changeVs = (cur: number, prev: number, prevMonth: string) => {
  if (prev <= 0) return null;
  const c = Math.round((100 * (cur - prev)) / prev);
  return c === 0 ? `same as ${prevMonth}` : `${c > 0 ? "+" : ""}${c}% vs ${prevMonth}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
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

type Caps = { winners: number; topPlayers: number; risingPlayers: number; topCut: number; mostPlayed: number; best: number; conversion: number; rising: number; cooling: number };
/** The post's three visual blocks, in order: scene (inline fields), people (players), decks (commanders). */
type Block = "scene" | "people" | "decks";
/** `numbered` sections hold their lines without the rank; it is added when the embed and the preview are built. */
type Section = { key: SectionKey; block: Block; name: string; lines: string[]; inline?: boolean; numbered?: boolean };
const withEmoji = (emoji: string, name: string) => (emoji ? `${emoji} ${name}` : name);

function buildSections(data: PostData, c: PostConfig, caps: Caps): Section[] {
  const s: Section[] = [];
  // Player names are user-written, so they get the same cleaning as organizer text.
  const playerText = (name: string) => sanitizeOrganizerText(name, c.playerNameMax, { wholeWords: true });
  const mon = monthOf(data.month);
  const prevMon = monthOf(data.month, -1);

  // Scene this month (inline)
  const sc = data.scene;
  if (sc.events > 0) {
    const evChange = changeVs(sc.events, sc.prevEvents, prevMon);
    const plChange = changeVs(sc.players, sc.prevPlayers, prevMon);
    s.push({ key: "scene", block: "scene", name: `Events — ${mon}`, lines: [`${int(sc.events)}${evChange ? ` (${evChange})` : ""}`], inline: true });
    s.push({ key: "scene", block: "scene", name: "Players", lines: [`${int(sc.players)}${plChange ? ` (${plChange})` : ""}`], inline: true });
    if (sc.drawRate !== null) s.push({ key: "scene", block: "scene", name: "Draw rate", lines: [pct(sc.drawRate, 0)], inline: true });
    if (sc.largestEventName && sc.largestEventPlayers) {
      const name = sanitizeOrganizerText(sc.largestEventName, c.eventNameMax) || "Unnamed event";
      s.push({ key: "scene", block: "scene", name: "Largest event", lines: [`${sc.largestEventPlayers} players · ${name}`], inline: true });
    }
  }

  // Winners
  const winnerLines = data.results.slice(0, caps.winners).map((r) => {
    const name = sanitizeOrganizerText(r.eventName ?? "Unnamed event", c.eventNameMax) || "Unnamed event";
    const commanders = (r.resultCommanders ?? "").split("; ").filter(Boolean).map((x) => (x === "unknown" ? "unknown commander" : shortenCommander(x)));
    // An opted-out winner is "a player"; a winner with no known name shows the commander alone.
    const who = r.winnerHidden ? "a player" : r.winnerName ? playerText(r.winnerName) : "";
    const winner = commanders[0] ? (who ? `${who} on ${commanders[0]}` : commanders[0]) : who || "winner not recorded";
    const outcome =
      r.result === "winner" ? winner
      : r.result === "final drawn" ? `drawn final: ${commanders.join(", ")}`
      : r.result;
    return `• ${r.participantCount}p · ${name} · ${outcome}`;
  });
  if (winnerLines.length) s.push({ key: "winners", block: "people", name: `Winners — ${mon} (largest events)`, lines: fitLines(winnerLines) });

  // Player sections need no decklists, so they show for non-reportable regions too.
  const topPlayers = data.topPlayers
    .map((p) => ({ ...p, name: playerText(p.name) }))
    .filter((p) => p.name)
    .slice(0, caps.topPlayers);
  if (topPlayers.length) {
    s.push({
      key: "topPlayers", block: "people", numbered: true,
      name: `Top players — ${mon}`,
      lines: topPlayers.map((p) => {
        const record = [p.wins > 0 ? plural(p.wins, "win", "wins") : "", p.topCuts > 0 ? plural(p.topCuts, "top cut", "top cuts") : ""].filter(Boolean).join(", ");
        return `${p.name} — ${record}${p.commander ? ` · ${shortenCommander(p.commander)}` : ""}`;
      }),
    });
  }

  const risingPlayers = data.risingPlayers
    .map((p) => ({ ...p, name: playerText(p.name) }))
    .filter((p) => p.name)
    .slice(0, caps.risingPlayers);
  if (risingPlayers.length) {
    s.push({
      key: "risingPlayers", block: "people",
      name: `Rising players — ${mon} (first win or top cut in ${c.playerHistoryYears} years of data)`,
      lines: risingPlayers.map((p) => {
        const event = sanitizeOrganizerText(p.eventName ?? "Unnamed event", c.eventNameMax) || "Unnamed event";
        return `${p.name} — ${RISING_REASON_TEXT[p.reason] ?? p.reason} · ${p.participantCount}p ${event}`;
      }),
    });
  }

  if (!data.resolved.reportable) return s;

  const top = data.topCutAppearances.slice(0, caps.topCut);
  if (top.length) {
    s.push({
      key: "topCut", block: "decks", numbered: true,
      name: `Top-cut appearances — ${mon}`,
      lines: top.map((t) => `${shortenCommander(t.commander)} — ${t.topCutEntries}`),
    });
  }

  const most = data.metaShare.slice(0, caps.mostPlayed);
  if (most.length) {
    // A snapshot of the 6-month window; movement is shown by Rising and Cooling commanders.
    s.push({
      key: "mostPlayed", block: "decks", numbered: true,
      name: "Most played (6 months)",
      lines: most.map((m) => `${shortenCommander(m.commander)} — ${pct(m.metaShare)}`),
    });
  }

  const best = data.ppg.filter((p) => p.entries >= c.bestResultsMinEntries).sort((a, b) => b.shrunkPpg - a.shrunkPpg).slice(0, caps.best);
  if (best.length) {
    s.push({
      key: "best", block: "decks", numbered: true,
      name: `Best results (adjusted PPG, ${c.bestResultsMinEntries}+ entries)`,
      lines: best.map((p) => `${shortenCommander(p.commander)} — ${p.shrunkPpg.toFixed(2)} (${int(p.entries)} entries)`),
    });
  }

  const conv = data.conversion
    .filter((x) => x.entriesInCutEvents >= c.conversionMinCutEntries)
    .sort((a, b) => b.conversion - a.conversion || b.entriesInCutEvents - a.entriesInCutEvents)
    .slice(0, caps.conversion);
  if (conv.length) {
    const base = data.baselineConversion === null ? "" : ` (baseline ${pct(data.baselineConversion, 0)})`;
    s.push({
      key: "conversion", block: "decks", numbered: true,
      name: `Top-cut conversion${base}`,
      lines: conv.map((x) => `${shortenCommander(x.commander)} — ${pct(x.conversion, 0)} (${int(x.entriesInCutEvents)} entries)`),
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
  if (rising.length) s.push({ key: "risingCommanders", block: "decks", name: "Rising commanders (by share growth vs prior 3 months)", lines: rising.map(countLine) });

  const topCommanders = new Set(data.metaShare.slice(0, c.coolingTopN).map((m) => m.commander));
  const cooling = data.trend
    .filter((t) => topCommanders.has(t.commander) && !t.isNew && t.shareChange !== null && t.shareChange < 0)
    .filter((t) => t.lastMonthEntries >= c.coolingMinEntries || t.prior3AvgEntries >= c.coolingMinEntries)
    .filter((t) => !matching || t.lastMonthEntries < t.prior3AvgEntries)
    .sort((a, b) => a.shareChange! - b.shareChange!)
    .slice(0, caps.cooling);
  if (cooling.length) s.push({ key: "coolingCommanders", block: "decks", name: "Cooling commanders (by share drop vs prior 3 months)", lines: cooling.map(countLine) });

  return s;
}

function coverageLine(data: PostData): string {
  const leaderPct = data.coverage.pctEntriesWithLeader === null ? "n/a" : `${data.coverage.pctEntriesWithLeader.toFixed(0)}%`;
  const p = data.coverage.pctEntriesWithPlayer;
  // Players without a TopDeck account can't be named, so say how much of the month the player sections cover.
  const players = p === null ? "" : ` · ${p.toFixed(0)}% of ${monthOf(data.month)} entries have a linked player`;
  return `${int(data.coverage.qualifyingEvents)} qualifying events over 6 months · ${leaderPct} of entries with decklists${players}`;
}

/** Pure: builds the embed and the plain-text preview, trimming bottom sections first until the budget fits. */
export function composePost(data: PostData, config: PostConfig = POST_CONFIG): { embed: Embed; text: string } {
  const caps: Caps = {
    winners: config.winnersMax, topPlayers: config.topPlayersMax, risingPlayers: config.risingPlayersMax, topCut: config.topCutMax, mostPlayed: config.mostPlayedMax, best: config.bestResultsMax,
    conversion: config.conversionMax, rising: config.risingMax, cooling: config.coolingMax,
  };
  // Trim order: the decks block first, bottom-up (each section to a floor, then deeper), and only then the
  // people block, bottom-up in the same way. The scene, coverage and Sources are never trimmed.
  const step = (k: keyof Caps, floor: number) => () => caps[k] > floor && (caps[k]--, true);
  const trims = [
    step("cooling", 0), step("rising", 0), step("conversion", 3), step("best", 3), step("mostPlayed", 5), step("topCut", 3),
    step("conversion", 0), step("best", 0), step("mostPlayed", 3), step("topCut", 0),
    step("risingPlayers", 1), step("topPlayers", 3), step("winners", 5),
    step("risingPlayers", 0), step("topPlayers", 0), step("winners", 3),
  ];
  const emoji = config.sectionEmoji;
  const coverageName = withEmoji(emoji.coverage, "Coverage");
  const sourcesName = withEmoji(emoji.sources, "Sources");
  // The emoji goes on a section's first field (the scene is several inline fields under one emoji).
  const named = (list: Section[]) => list.map((x, i) => ({ ...x, name: list.findIndex((y) => y.key === x.key) === i ? withEmoji(emoji[x.key], x.name) : x.name }));
  const startsBlock = (list: Section[], i: number) => config.dividerName !== "" && i > 0 && list[i - 1]!.block !== list[i]!.block;
  const ranked = (x: Section, suffix: string) => (x.numbered ? x.lines.map((l, i) => `${i + 1}${suffix} ${l}`) : x.lines);

  const title = `${data.resolved.label} — cEDH meta, ${monthOf(data.month)} ${data.month.slice(0, 4)}`;
  const notes: string[] = [];
  if (data.resolved.stepsUp > 0) notes.push(`Showing ${data.resolved.label}: ${data.requested.label} didn't have enough data.`);
  if (!data.resolved.reportable) notes.push("Not enough decklists yet for commander stats.");

  let embed: Embed;
  let sections: Section[];
  for (;;) {
    sections = named(buildSections(data, config, caps));
    const list = sections;
    embed = {
      title,
      ...(notes.length ? { description: notes.join("\n") } : {}),
      color: config.embedColor,
      fields: [
        ...list.flatMap((x, i) => [
          ...(startsBlock(list, i) ? [{ name: config.dividerName, value: config.dividerValue }] : []),
          { name: x.name, value: ranked(x, config.listNumberSuffix).join("\n"), ...(x.inline ? { inline: true } : {}) },
        ]),
        { name: coverageName, value: coverageLine(data) },
        { name: sourcesName, value: ATTRIBUTION_MD },
      ],
    };
    if (contentLength(embed) <= config.contentBudget) break;
    if (!trims.find((t) => t())) break;
  }

  const violations = discordLimitViolations(embed);
  if (violations.length) throw new Error(`embed exceeds Discord limits: ${violations.join("; ")}`);

  const final = sections;
  const inline = final.filter((x) => x.inline).map((x) => `${x.name}: ${x.lines.join(" ")}`);
  const blocks = final.flatMap((x, i) => (x.inline ? [] : [...(startsBlock(final, i) ? ["", config.dividerName] : []), "", x.name, ...ranked(x, ".")]));
  const text = [
    title, ...notes, ...(inline.length ? ["", ...inline] : []), ...blocks,
    "", `${coverageName}: ${coverageLine(data)}`, `${sourcesName}: ${ATTRIBUTION_PREVIEW}`,
  ].join("\n");
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

  const [scene] = await sql<{ events: string; players: string; prev_events: string; prev_players: string; largest_event_name: string | null; largest_event_players: number | null; draw_rate: number | null }[]>`
    select * from stat_scene(${r}, ${end}::date)`;
  const [cov] = await sql<{ qualifying_events: string; pct_entries_with_leader: number | null }[]>`
    select qualifying_events, pct_entries_with_leader from stat_coverage(${r}, ${end}::date)`;
  const results = await sql<{ event_name: string | null; participant_count: number; result: string; result_commanders: string | null; winner_name: string | null; winner_hidden: boolean }[]>`
    select event_name, participant_count, result, result_commanders, winner_name, winner_hidden from stat_month_results(${r}, ${end}::date, 10)`;
  const [playerCov] = await sql<{ pct_entries_with_player: number | null }[]>`
    select pct_entries_with_player from stat_player_coverage(${r}, ${end}::date)`;
  const topPlayers = await sql<{ player_name: string; wins: string; top_cuts: string; top_commander: string | null }[]>`
    select player_name, wins, top_cuts, top_commander from stat_top_players(${r}, ${end}::date, 5)`;
  const risingPlayers = await sql<{ player_name: string; reason: string; event_name: string | null; participant_count: number }[]>`
    select player_name, reason, event_name, participant_count from stat_rising_players(${r}, ${end}::date, 3)`;
  const topCut = await sql<{ commander: string; top_cut_entries: string }[]>`
    select * from stat_top_cut_appearances(${r}, ${end}::date) limit 10`;
  const meta = await sql<{ commander: string; entries: string; meta_share: number }[]>`
    select commander, entries, meta_share from stat_meta_share(${r}, ${end}::date) limit 20`;
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
      pctEntriesWithPlayer: playerCov?.pct_entries_with_player == null ? null : Number(playerCov.pct_entries_with_player),
    },
    results: results.map((x) => ({
      eventName: x.event_name, participantCount: x.participant_count, result: x.result, resultCommanders: x.result_commanders,
      winnerName: x.winner_name, winnerHidden: x.winner_hidden,
    })),
    topPlayers: topPlayers.map((p) => ({ name: p.player_name, wins: Number(p.wins), topCuts: Number(p.top_cuts), commander: p.top_commander })),
    risingPlayers: risingPlayers.map((p) => ({ name: p.player_name, reason: p.reason, eventName: p.event_name, participantCount: p.participant_count })),
    topCutAppearances: topCut.map((t) => ({ commander: t.commander, topCutEntries: Number(t.top_cut_entries) })),
    metaShare: meta.map((m) => ({ commander: m.commander, entries: Number(m.entries), metaShare: m.meta_share })),
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
