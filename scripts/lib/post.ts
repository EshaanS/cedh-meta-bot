// Monthly post composer (v3 newsletter): turns one region and month into the embeds of one Discord message
// and a text preview. loadPostData reads the database; composePost is pure and works on the saved data (test
// fixtures use it). No Discord HTTP here. The Sources field of the last embed carries "Data provided by
// TopDeck.gg" with a link (CLAUDE.md rule).
import type { Sql } from "./db";

export const POST_CONFIG = {
  /** Characters across all embeds of the message. Discord's hard limit for one message's embeds is 6,000. */
  contentBudget: 5300,
  /** Years of player history ingested; shown on Rising players so "first" isn't read as "new to the game". */
  playerHistoryYears: 3,
  eventNameMax: 50,
  winnersMax: 10,
  /** Longer player names are cut at the last whole word that fits, with an ellipsis. */
  playerNameMax: 40,
  topPlayersMax: 5,
  risingPlayersMax: 3,
  topCutMax: 5,
  /** Top-cut appearances line: 2 = "157 cuts · 9.1% of cuts vs 7.9% of field", 1 = "157 cuts · 1.15× its field
   *  share", 0 = "157 cuts". When the post is over budget the level steps down before any line is trimmed. */
  topCutDetail: 2,
  /** In a mixed-scope post (a small custom region) the two shares are shown only when the month has at least
   *  this many top cuts; below it "1 cut · 10.0% of cuts vs 2.3% of field" is noise. Standard regions are not
   *  affected. */
  topCutShareMinCuts: 30,
  mostPlayedMax: 10,
  bestResultsMax: 5,
  bestResultsMinEntries: 30,
  conversionMax: 5,
  conversionMinCutEntries: 30,
  risingMax: 3,
  risingMinLastMonthEntries: 10,
  /** A commander first seen (anywhere in our data) in the report month or the newCommanderMonths - 1 months
   *  before it is "new since <date>", even if it already has entries in the prior 3 months. */
  newCommanderMonths: 2,
  coolingMax: 3,
  coolingTopN: 15,
  coolingMinEntries: 10,
  /** Rising needs entries above the prior-3-month average and Cooling off below it, so counts never contradict. */
  trendNeedsMatchingCounts: 1,

  // Look. Every switch below is 1 (on) or 0 (off); emoji and markup count against contentBudget like any text.
  /** One embed per block, all in one message: the month in numbers, people, decks, and coverage with Sources.
   *  "{month}" in a title is the report month's name. The first embed's title is the region and month. */
  embeds: {
    overview: { color: 0xc9a84c },
    people: { title: "👥 Players — {month}", color: 0x4a90d9 },
    decks: { title: "🃏 Commanders — {month}", color: 0x4caf7a },
    about: { title: "ℹ️ About this report", color: 0x8a8f98 },
  },
  /** Discord shows at most three inline fields per row, so a fourth scene field would sit alone on a second row.
   *  0 puts Largest event on its own full-width line under Events / Players / Draw rate; 1 makes it inline. */
  largestEventInline: 0,
  /** Prefix of each section's field name ("" for none). "scene" goes on the first scene field only. */
  sectionEmoji: {
    scene: "📍", winners: "🏆", topPlayers: "👑", risingPlayers: "🌱", topCut: "🎯", mostPlayed: "📊", best: "⭐",
    conversion: "🔀", risingCommanders: "📈", coolingCommanders: "📉", coverage: "ℹ️", sources: "🔗",
  },

  /** Up to three lines at the top of the first embed, for someone who only skims. Each line is left out when
   *  its data is missing. */
  headline: 1,
  /** The second line names the month's top-cut leader when one commander has strictly the most top cuts and at
   *  least this many; otherwise the most played commander. */
  headlineMinCuts: 5,
  /** Copy of the headline lines. Tokens in braces are filled in; "{icon}" is the section's emoji. */
  headlineCopy: {
    eventWon: "{icon} **{event}** ({players} players) went to {winner}",
    event: "{icon} **{event}** ({players} players) was the biggest event",
    topCut: "{icon} **{commander}** made the most top cuts: {cuts}",
    mostPlayed: "{icon} **{commander}** is the most played commander: {share} of entries over 6 months",
    mostPlayedIn: "{icon} **{commander}** is the most played commander in {region}: {share} of entries over 6 months",
    risingCommander: "{icon} **{commander}** is the commander to watch: {detail}",
    risingPlayer: "{icon} **{player}** is the player to watch: {reason} at {event} ({players} players)",
  },

  /** Ranked lines start with these, separated by spaces; a rank past the last one, or medals off, shows the
   *  number instead. */
  medals: 1,
  rankSymbols: "🥇 🥈 🥉 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟",
  /** Put after the number on ranked lines without a medal. "\\." shows as "1." but stops Discord from turning
   *  the lines into a markdown list, which adds its own indent and spacing. The text preview shows "1.". */
  listNumberSuffix: "\\.",
  /** Icons on lines ("" for none): wins, top cuts, a new commander, a rising one, a cooling one. */
  lineIcons: { win: "🏆", topCut: "🎯", newCommander: "🆕", rising: "🔥", cooling: "🧊" },
  /** Bold event names in Winners, player names in the player sections and commander names in the deck sections. */
  boldNames: 1,
  /** Winners: the event and its size on one line, the winner on the next. 0 is the single "• 150p · event ·
   *  winner" line. */
  winnersTwoLines: 1,
  /** When the Winners field would pass Discord's 1,024 characters it becomes two fields: this many winners,
   *  then the rest under continuedFieldName (a zero-width space, so it reads as one list). */
  winnersSplitAt: 5,
  continuedFieldName: "​",
  /** Items whose detail is a phrase put it on a second line: top players, rising players, top-cut appearances,
   *  rising and cooling commanders. 0 keeps each item on one line. */
  detailOnSecondLine: 1,
  /** A blank line between the items of a section. */
  spacing: { winners: 1, topPlayers: 0, risingPlayers: 0, topCut: 0, mostPlayed: 0, best: 0, conversion: 0, risingCommanders: 0, coolingCommanders: 0 },
  /** Most played: a bar scaled to the top commander's share, barWidth cells wide, at least one cell filled.
   *  The glyphs take the text color, so they read on light and dark themes and can't be mistaken for mana. */
  shareBars: 1,
  barWidth: 10,
  barFilled: "▰",
  barEmpty: "▱",
  /** Color identity squares after a commander's name, in WUBRG order, from PostData.colors (Scryfall's color
   *  identity; a pair is the union of both halves). A commander with no match shows none. Yellow stands for
   *  white and purple for black: Discord draws ⬜ and ⬛ in almost the color of its light and dark embed
   *  backgrounds, so they would disappear on one theme each. */
  colorSquares: 1,
  colorSymbols: { W: "🟨", U: "🟦", B: "🟪", R: "🟥", G: "🟩", colorless: "🔘" },
} as const;
type Widen<T> = T extends number ? number : T extends string ? string : { -readonly [K in keyof T]: Widen<T[K]> };
export type PostConfig = Widen<typeof POST_CONFIG>;
type SectionKey = keyof PostConfig["sectionEmoji"];

/** Discord limits (characters; `total` is across all embeds of one message). */
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, fields: 25, embeds: 10, total: 6000 } as const;

export type PostData = {
  month: string; // YYYY-MM
  requested: { id: string; label: string };
  resolved: { id: string; label: string; stepsUp: number; reportable: boolean };
  /**
   * Only for a server's custom region that is not reportable itself. Then `resolved` is the custom region and
   * the fact sections (scene, winners, players, top-cut appearances, coverage) describe it, while metaShare,
   * ppg, conversion and baselineConversion come from this region: the smallest standard region containing every
   * place of the custom one, or the first reportable region above that. Absent for every standard region.
   */
  statsRegion?: StatsRegion;
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
  /** fieldEntries and the totals count entries with a commander in the month's events that had a top cut. */
  topCutAppearances: { commander: string; topCutEntries: number; fieldEntries: number; totalTopCutEntries: number; totalFieldEntries: number }[];
  metaShare: { commander: string; entries: number; metaShare: number }[];
  ppg: { commander: string; entries: number; ppg: number; shrunkPpg: number }[];
  conversion: { commander: string; entriesInCutEvents: number; topCutEntries: number; conversion: number }[];
  baselineConversion: number | null;
  /** isNew: no entries in the region in the prior 3 months. firstSeen: UTC date (YYYY-MM-DD) of the commander's
   *  first qualifying entry anywhere in our data, or null when unknown. */
  trend: { commander: string; lastMonthEntries: number; prior3AvgEntries: number; shareChange: number | null; isNew: boolean; firstSeen: string | null }[];
  /**
   * Color identity by commander, keyed on the commander text as it appears in the rows above: a subset of
   * "WUBRG" in that order, "" for colorless. A commander with no matching card is absent. Decoration only.
   */
  colors?: Record<string, string>;
};

/** `label` is the full region label ("Washington (United States)"); `shortLabel` is the bare name for headers. */
export type StatsRegion = { id: string; label: string; shortLabel: string; reportable: boolean };

export type EmbedField = { name: string; value: string; inline?: boolean };
export type Embed = { title?: string; description?: string; color?: number; fields: EmbedField[] };

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
/** First day (YYYY-MM-DD) of the month `offset` months from `yyyyMm`. */
const monthStart = (yyyyMm: string, offset = 0) =>
  new Date(Date.UTC(Number(yyyyMm.slice(0, 4)), Number(yyyyMm.slice(5, 7)) - 1 + offset, 1)).toISOString().slice(0, 10);
/** "2026-09-26" -> "Sep 26". */
export const shortDate = (yyyyMmDd: string) => `${MONTHS[Number(yyyyMmDd.slice(5, 7)) - 1]!.slice(0, 3)} ${Number(yyyyMmDd.slice(8, 10))}`;
const monthOf = (yyyyMm: string, offset = 0) => {
  const d = new Date(Date.UTC(Number(yyyyMm.slice(0, 4)), Number(yyyyMm.slice(5, 7)) - 1 + offset, 1));
  return MONTHS[d.getUTCMonth()]!;
};
/** Fills "{token}" places in a copy template; an unknown token becomes nothing. */
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "").replace(/\s+/g, " ").trim();

/** Characters of one embed that count toward Discord's limit: title, description, field names and values. */
export function embedLength(embed: Embed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/** Characters across all embeds of the message. String lengths count an emoji as 2 or 3, never less than Discord does. */
export function contentLength(embeds: Embed[]): number {
  return embeds.reduce((n, e) => n + embedLength(e), 0);
}

export function discordLimitViolations(embeds: Embed[]): string[] {
  const v: string[] = [];
  if (embeds.length === 0) v.push("no embeds");
  if (embeds.length > DISCORD_LIMITS.embeds) v.push(`embeds ${embeds.length} > ${DISCORD_LIMITS.embeds}`);
  embeds.forEach((embed, i) => {
    const at = `embed ${i + 1}`;
    if ((embed.title?.length ?? 0) > DISCORD_LIMITS.title) v.push(`${at}: title ${embed.title!.length} > ${DISCORD_LIMITS.title}`);
    if (embed.title === "") v.push(`${at}: title is empty (omit it instead)`);
    if ((embed.description?.length ?? 0) > DISCORD_LIMITS.description) v.push(`${at}: description too long`);
    if (embed.description === "") v.push(`${at}: description is empty (omit it instead)`);
    if (!embed.title && !embed.description && embed.fields.length === 0) v.push(`${at}: nothing in it`);
    if (embed.fields.length > DISCORD_LIMITS.fields) v.push(`${at}: fields ${embed.fields.length} > ${DISCORD_LIMITS.fields}`);
    for (const f of embed.fields) {
      if (f.name.length === 0 || f.name.length > DISCORD_LIMITS.fieldName) v.push(`${at}: field name "${f.name}" length ${f.name.length}`);
      if (f.value.length === 0 || f.value.length > DISCORD_LIMITS.fieldValue) v.push(`${at}: field "${f.name}" value length ${f.value.length}`);
    }
  });
  const total = contentLength(embeds);
  if (total > DISCORD_LIMITS.total) v.push(`total ${total} > ${DISCORD_LIMITS.total}`);
  return v;
}

/** What trimming can change. The first block are line caps; detail, spacing, bars and squares are levels. */
type Caps = {
  winners: number; topPlayers: number; risingPlayers: number; topCut: number; mostPlayed: number; best: number; conversion: number; rising: number; cooling: number;
  topCutDetail: number; spacing: number; bars: number; squares: number;
};
/** The post's blocks, one embed each: scene (the month in numbers), people (players), decks (commanders). */
type Block = "scene" | "people" | "decks";
/**
 * One field of the post. Each item is one or two lines; `ranked` sections get a medal or number in front of
 * every item when the embed and the preview are built.
 */
type Section = { key: SectionKey; block: Block; name: string; items: string[][]; inline?: boolean; ranked?: boolean };
const withEmoji = (emoji: string, name: string) => (emoji ? `${emoji} ${name}` : name);
type Trend = PostData["trend"][number];
type Result = PostData["results"][number];

/** "New since": first seen anywhere in the report month or the months just before it (newCommanderMonths). */
function trendKinds(data: PostData, c: PostConfig) {
  const newSince = monthStart(data.month, -(c.newCommanderMonths - 1));
  const recent = (t: Trend) => c.newCommanderMonths > 0 && t.firstSeen !== null && t.firstSeen >= newSince;
  return { recent, isNew: (t: Trend) => t.isNew || recent(t) };
}

/** "93 entries in October, new since Sep 26", "… , new", or "… (avg 2/month)". */
function trendDetail(data: PostData, c: PostConfig, t: Trend): string {
  const head = `${t.lastMonthEntries} entries in ${monthOf(data.month)}`;
  if (trendKinds(data, c).recent(t)) return `${head}, new since ${shortDate(t.firstSeen!)}`;
  return t.isNew ? `${head}, new` : `${head} (avg ${monthlyAvg(t.prior3AvgEntries)}/month)`;
}

/** The rows each section shows, in order, before any formatting. The headline reads the same lists. */
function selectRows(data: PostData, c: PostConfig, caps: Caps) {
  // Player names are user-written, so they get the same cleaning as organizer text.
  const playerText = (name: string) => sanitizeOrganizerText(name, c.playerNameMax, { wholeWords: true });
  const topPlayers = data.topPlayers.map((p) => ({ ...p, name: playerText(p.name) })).filter((p) => p.name).slice(0, caps.topPlayers);
  const risingPlayers = data.risingPlayers.map((p) => ({ ...p, name: playerText(p.name) })).filter((p) => p.name).slice(0, caps.risingPlayers);

  // Mixed scope (a custom region that isn't reportable): top-cut appearances are facts about its own events
  // and still show; the three statistical sections come from statsRegion and name it in their headers; rising
  // and cooling commanders need the region's own trend, so they are left out.
  const stats = data.statsRegion;
  const decks = data.resolved.reportable || stats !== undefined;
  const statsOk = decks && (stats ? stats.reportable : true);
  const topCut = decks ? data.topCutAppearances.slice(0, caps.topCut) : [];
  const most = statsOk ? data.metaShare.slice(0, caps.mostPlayed) : [];
  const best = statsOk ? data.ppg.filter((p) => p.entries >= c.bestResultsMinEntries).sort((a, b) => b.shrunkPpg - a.shrunkPpg).slice(0, caps.best) : [];
  const conv = (statsOk ? data.conversion : [])
    .filter((x) => x.entriesInCutEvents >= c.conversionMinCutEntries)
    .sort((a, b) => b.conversion - a.conversion || b.entriesInCutEvents - a.entriesInCutEvents)
    .slice(0, caps.conversion);

  const matching = c.trendNeedsMatchingCounts > 0;
  const { isNew } = trendKinds(data, c);
  const trends = data.resolved.reportable ? data.trend : [];
  const rising = trends
    .filter((t) => t.lastMonthEntries >= c.risingMinLastMonthEntries)
    .filter((t) => isNew(t) || ((t.shareChange ?? 0) > 0 && (!matching || t.lastMonthEntries > t.prior3AvgEntries)))
    // New commanders first, most entries first; then the others by share growth.
    .sort((a, b) =>
      Number(isNew(b)) - Number(isNew(a))
      || (isNew(a) ? b.lastMonthEntries - a.lastMonthEntries || a.commander.localeCompare(b.commander) : (b.shareChange ?? 0) - (a.shareChange ?? 0)))
    .slice(0, caps.rising);
  const topCommanders = new Set(data.metaShare.slice(0, c.coolingTopN).map((m) => m.commander));
  const cooling = trends
    .filter((t) => topCommanders.has(t.commander) && !isNew(t) && t.shareChange !== null && t.shareChange < 0)
    .filter((t) => t.lastMonthEntries >= c.coolingMinEntries || t.prior3AvgEntries >= c.coolingMinEntries)
    .filter((t) => !matching || t.lastMonthEntries < t.prior3AvgEntries)
    .sort((a, b) => a.shareChange! - b.shareChange!)
    .slice(0, caps.cooling);

  return { winners: data.results.slice(0, caps.winners), topPlayers, risingPlayers, topCut, most, best, conv, rising, cooling, isNew, playerText };
}
type Rows = ReturnType<typeof selectRows>;

const eventText = (name: string | null, c: PostConfig) => sanitizeOrganizerText(name ?? "Unnamed event", c.eventNameMax) || "Unnamed event";

/**
 * How an event ended, as text: "Mara Ellison on Kraum / Tymna the Weaver", a commander alone when the winner
 * has no known name, "a player on …" for an opted-out winner, "drawn final: A, B", or the result itself.
 * `deck` formats a commander; `who` formats a player's name.
 */
function outcomeText(r: Result, playerText: (name: string) => string, deck: (commander: string) => string, who: (name: string) => string): string {
  const commanders = (r.resultCommanders ?? "").split("; ").filter(Boolean).map((x) => (x === "unknown" ? "unknown commander" : deck(x)));
  // An opted-out winner is "a player"; a winner with no known name shows the commander alone.
  const name = r.winnerHidden ? "a player" : r.winnerName ? who(playerText(r.winnerName)) : "";
  const winner = commanders[0] ? (name ? `${name} on ${commanders[0]}` : commanders[0]) : name || "winner not recorded";
  return r.result === "winner" ? winner : r.result === "final drawn" ? `drawn final: ${commanders.join(", ")}` : r.result;
}

function buildSections(data: PostData, c: PostConfig, caps: Caps, rows: Rows): Section[] {
  const s: Section[] = [];
  const mon = monthOf(data.month);
  const prevMon = monthOf(data.month, -1);
  const bold = (text: string) => (c.boldNames > 0 && text ? `**${text}**` : text);
  const icon = (key: keyof PostConfig["lineIcons"]) => (c.lineIcons[key] ? `${c.lineIcons[key]} ` : "");
  const two = c.detailOnSecondLine > 0;
  /** Color identity squares of a commander ("" when unknown or switched off). */
  const squares = (commander: string) => {
    const id = caps.squares > 0 ? data.colors?.[commander] : undefined;
    if (id === undefined) return "";
    return id === "" ? c.colorSymbols.colorless : [...id].map((l) => (l in c.colorSymbols ? c.colorSymbols[l as "W" | "U" | "B" | "R" | "G"] : "")).join("");
  };
  /** A commander as shown: short name (bold with `strong`), then its squares. */
  const deck = (commander: string, strong = false) => {
    const name = shortenCommander(commander);
    const sq = squares(commander);
    return `${strong ? bold(name) : name}${sq ? ` ${sq}` : ""}`;
  };

  // Scene this month (inline)
  const sc = data.scene;
  if (sc.events > 0) {
    const evChange = changeVs(sc.events, sc.prevEvents, prevMon);
    const plChange = changeVs(sc.players, sc.prevPlayers, prevMon);
    s.push({ key: "scene", block: "scene", name: `Events — ${mon}`, items: [[`${int(sc.events)}${evChange ? ` (${evChange})` : ""}`]], inline: true });
    s.push({ key: "scene", block: "scene", name: "Players", items: [[`${int(sc.players)}${plChange ? ` (${plChange})` : ""}`]], inline: true });
    if (sc.drawRate !== null) s.push({ key: "scene", block: "scene", name: "Draw rate", items: [[pct(sc.drawRate, 0)]], inline: true });
    if (sc.largestEventName && sc.largestEventPlayers) {
      s.push({ key: "scene", block: "scene", name: "Largest event", items: [[`${sc.largestEventPlayers} players · ${eventText(sc.largestEventName, c)}`]], ...(c.largestEventInline > 0 ? { inline: true } : {}) });
    }
  }

  // People. The embed's title carries the month, so these names don't repeat it.
  const winners = rows.winners.map((r) => {
    const outcome = outcomeText(r, rows.playerText, (x) => deck(x), (name) => name);
    if (c.winnersTwoLines < 1) return [`• ${r.participantCount}p · ${eventText(r.eventName, c)} · ${outcome}`];
    return [`${bold(eventText(r.eventName, c))} · ${plural(r.participantCount, "player", "players")}`, `${r.result === "winner" ? icon("win") : ""}${outcome}`];
  });
  if (winners.length) s.push({ key: "winners", block: "people", name: "Winners (largest events)", items: winners });

  // Player sections need no decklists, so they show for non-reportable regions too.
  if (rows.topPlayers.length) {
    const iconsOn = c.lineIcons.win !== "" || c.lineIcons.topCut !== "";
    s.push({
      key: "topPlayers", block: "people", ranked: true, name: "Top players",
      items: rows.topPlayers.map((p) => {
        const record = [p.wins > 0 ? `${icon("win")}${plural(p.wins, "win", "wins")}` : "", p.topCuts > 0 ? `${icon("topCut")}${plural(p.topCuts, "top cut", "top cuts")}` : ""]
          .filter(Boolean).join(iconsOn ? " · " : ", ");
        const head = `${bold(p.name)} — ${record}`;
        if (!p.commander) return [head];
        return two ? [head, deck(p.commander)] : [`${head} · ${deck(p.commander)}`];
      }),
    });
  }
  if (rows.risingPlayers.length) {
    s.push({
      key: "risingPlayers", block: "people",
      name: `Rising players (first win or top cut in ${c.playerHistoryYears} years of data)`,
      items: rows.risingPlayers.map((p) => {
        const head = `${icon(p.reason === "first win" ? "win" : "topCut")}${bold(p.name)} — ${RISING_REASON_TEXT[p.reason] ?? p.reason}`;
        const event = eventText(p.eventName, c);
        return two ? [head, `${plural(p.participantCount, "player", "players")} · ${event}`] : [`${head} · ${p.participantCount}p ${event}`];
      }),
    });
  }

  // Decks
  const stats = data.statsRegion;
  const from = stats ? ` — ${stats.shortLabel}` : "";
  if (rows.topCut.length) {
    s.push({
      key: "topCut", block: "decks", ranked: true,
      name: `Top-cut appearances — ${mon}`,
      items: rows.topCut.map((t) => {
        const head = deck(t.commander, true);
        const cuts = plural(t.topCutEntries, "cut", "cuts");
        // Share of the month's top cuts against share of the field in the events that had a cut.
        const noShares = caps.topCutDetail < 1 || t.totalTopCutEntries <= 0 || t.totalFieldEntries <= 0 || t.fieldEntries <= 0
          || (stats !== undefined && t.totalTopCutEntries < c.topCutShareMinCuts);
        if (noShares) return [`${head} — ${cuts}`];
        const cutShare = t.topCutEntries / t.totalTopCutEntries;
        const fieldShare = t.fieldEntries / t.totalFieldEntries;
        const detail = caps.topCutDetail >= 2 ? `${pct(cutShare)} of cuts vs ${pct(fieldShare)} of field` : `${(cutShare / fieldShare).toFixed(2)}× its field share`;
        return two ? [head, `${cuts} · ${detail}`] : [`${head} — ${cuts} · ${detail}`];
      }),
    });
  }
  if (rows.most.length) {
    // A snapshot of the 6-month window; movement is shown by Rising and Cooling commanders.
    const topShare = data.metaShare[0]?.metaShare ?? 0;
    const width = Math.max(1, Math.round(c.barWidth));
    const bar = (share: number) => {
      const filled = topShare > 0 ? Math.min(width, Math.max(1, Math.round((share / topShare) * width))) : 1;
      return `${c.barFilled.repeat(filled)}${c.barEmpty.repeat(width - filled)}`;
    };
    s.push({
      key: "mostPlayed", block: "decks", ranked: true,
      name: `Most played${from} (6 months)`,
      items: rows.most.map((m) => [caps.bars > 0 ? `${bar(m.metaShare)} ${pct(m.metaShare)} · ${deck(m.commander, true)}` : `${deck(m.commander, true)} — ${pct(m.metaShare)}`]),
    });
  }
  if (rows.best.length) {
    s.push({
      key: "best", block: "decks", ranked: true,
      name: `Best results${from} (adjusted PPG, ${c.bestResultsMinEntries}+ entries)`,
      items: rows.best.map((p) => [`${deck(p.commander, true)} — ${p.shrunkPpg.toFixed(2)} (${int(p.entries)} entries)`]),
    });
  }
  if (rows.conv.length) {
    const base = data.baselineConversion === null ? "" : ` (baseline ${pct(data.baselineConversion, 0)})`;
    s.push({
      key: "conversion", block: "decks", ranked: true,
      name: `Top-cut conversion${from}${base}`,
      items: rows.conv.map((x) => [`${deck(x.commander, true)} — ${pct(x.conversion, 0)} (${int(x.entriesInCutEvents)} entries)`]),
    });
  }
  const trendItem = (t: Trend, lead: string) => {
    const head = `${lead}${deck(t.commander, true)}`;
    const detail = trendDetail(data, c, t);
    return two ? [head, detail] : [`${head} — ${detail}`];
  };
  if (rows.rising.length) {
    s.push({
      key: "risingCommanders", block: "decks", name: "Rising commanders (by share growth vs prior 3 months)",
      items: rows.rising.map((t) => trendItem(t, icon(rows.isNew(t) ? "newCommander" : "rising"))),
    });
  }
  if (rows.cooling.length) {
    s.push({
      key: "coolingCommanders", block: "decks", name: "Cooling commanders (by share drop vs prior 3 months)",
      items: rows.cooling.map((t) => trendItem(t, icon("cooling"))),
    });
  }
  return s;
}

/**
 * The lines at the top of the first embed: the biggest event and its winner, the month's top-cut leader (or
 * the most played commander), and the first rising commander (or rising player). Only data the sections show.
 */
function headlineLines(data: PostData, c: PostConfig, rows: Rows): string[] {
  if (c.headline < 1) return [];
  const out: string[] = [];
  const copy = c.headlineCopy;
  const emoji = c.sectionEmoji;
  const strong = (text: string) => (c.boldNames > 0 ? `**${text}**` : text);

  const first = rows.winners[0];
  if (first) {
    const base = { icon: emoji.winners, event: eventText(first.eventName, c), players: String(first.participantCount) };
    out.push(first.result === "winner"
      ? fill(copy.eventWon, { ...base, winner: outcomeText(first, rows.playerText, shortenCommander, strong) })
      : fill(copy.event, base));
  } else if (data.scene.events > 0 && data.scene.largestEventName && data.scene.largestEventPlayers) {
    out.push(fill(copy.event, { icon: emoji.winners, event: eventText(data.scene.largestEventName, c), players: String(data.scene.largestEventPlayers) }));
  }

  const [lead, next] = rows.topCut;
  const mostPlayed = rows.most[0];
  if (lead && lead.topCutEntries >= c.headlineMinCuts && (!next || lead.topCutEntries > next.topCutEntries)) {
    out.push(fill(copy.topCut, { icon: emoji.topCut, commander: shortenCommander(lead.commander), cuts: String(lead.topCutEntries) }));
  } else if (mostPlayed) {
    const values = { icon: emoji.mostPlayed, commander: shortenCommander(mostPlayed.commander), share: pct(mostPlayed.metaShare) };
    out.push(data.statsRegion ? fill(copy.mostPlayedIn, { ...values, region: data.statsRegion.shortLabel }) : fill(copy.mostPlayed, values));
  }

  const risingCommander = rows.rising[0];
  const risingPlayer = rows.risingPlayers[0];
  if (risingCommander) {
    out.push(fill(copy.risingCommander, { icon: emoji.risingCommanders, commander: shortenCommander(risingCommander.commander), detail: trendDetail(data, c, risingCommander) }));
  } else if (risingPlayer) {
    out.push(fill(copy.risingPlayer, {
      icon: emoji.risingPlayers, player: risingPlayer.name, reason: RISING_REASON_TEXT[risingPlayer.reason] ?? risingPlayer.reason,
      event: eventText(risingPlayer.eventName, c), players: String(risingPlayer.participantCount),
    }));
  }
  return out.filter(Boolean);
}

function coverageLine(data: PostData): string {
  const leaderPct = data.coverage.pctEntriesWithLeader === null ? "n/a" : `${data.coverage.pctEntriesWithLeader.toFixed(0)}%`;
  const p = data.coverage.pctEntriesWithPlayer;
  // Players without a TopDeck account can't be named, so say how much of the month the player sections cover.
  const players = p === null ? "" : ` · ${p.toFixed(0)}% of ${monthOf(data.month)} entries have a linked player`;
  return `${int(data.coverage.qualifyingEvents)} qualifying events over 6 months · ${leaderPct} of entries with decklists${players}`;
}

/** How a field is written in the text preview: "name: value", name over its lines, or lines alone. */
type FieldStyle = "pair" | "block" | "continued";
type StyledField = EmbedField & { style: FieldStyle };

/**
 * Pure: builds the message's embeds and the plain-text preview, trimming until the content budget fits.
 * Trim order: the top-cut lines lose detail (both shares, then the ratio, then the count alone); decoration
 * goes (blank spacing, share bars, color squares); the decks block is cut bottom-up (each section to a floor,
 * then deeper); then the player sections; and Winners last. The headline, the scene, Coverage and Sources are
 * never trimmed.
 */
export function composePost(data: PostData, config: PostConfig = POST_CONFIG): { embeds: Embed[]; text: string } {
  const fullCaps: Caps = {
    winners: config.winnersMax, topPlayers: config.topPlayersMax, risingPlayers: config.risingPlayersMax, topCut: config.topCutMax,
    mostPlayed: config.mostPlayedMax, best: config.bestResultsMax, conversion: config.conversionMax, rising: config.risingMax, cooling: config.coolingMax,
    topCutDetail: config.topCutDetail, spacing: 1, bars: config.shareBars > 0 ? 1 : 0, squares: config.colorSquares > 0 ? 1 : 0,
  };
  const caps: Caps = { ...fullCaps };
  const step = (k: keyof Caps, floor: number) => () => caps[k] > floor && (caps[k]--, true);
  const trims = [
    step("topCutDetail", 1), step("topCutDetail", 0),
    step("spacing", 0), step("bars", 0), step("squares", 0),
    step("cooling", 0), step("rising", 0), step("conversion", 3), step("best", 3), step("mostPlayed", 5), step("topCut", 3),
    step("conversion", 0), step("best", 0), step("mostPlayed", 3), step("topCut", 0),
    step("risingPlayers", 1), step("topPlayers", 3), step("risingPlayers", 0), step("topPlayers", 0),
    step("winners", 5), step("winners", 3),
  ];
  const emoji = config.sectionEmoji;
  const mon = monthOf(data.month);
  // The emoji goes on a section's first field (the scene is several inline fields under one emoji).
  const named = (list: Section[]) => list.map((x, i) => ({ ...x, name: list.findIndex((y) => y.key === x.key) === i ? withEmoji(emoji[x.key], x.name) : x.name }));
  const marks = config.medals > 0 ? config.rankSymbols.split(" ").filter(Boolean) : [];
  const mark = (i: number) => marks[i] ?? `${i + 1}${config.listNumberSuffix}`;
  const spaced = (x: Section) => caps.spacing > 0 && x.key in config.spacing && config.spacing[x.key as keyof PostConfig["spacing"]] > 0;
  const render = (x: Section, items: string[][], rankFrom = 0) =>
    items.map((it, i) => (x.ranked ? [`${mark(rankFrom + i)} ${it[0]!}`, ...it.slice(1)] : it).join("\n")).join(spaced(x) ? "\n\n" : "\n");
  /** Keeps items from the top while the field value fits Discord's limit. */
  const fit = (x: Section, items: string[][]) => {
    let kept = items;
    while (kept.length > 0 && render(x, kept).length > DISCORD_LIMITS.fieldValue) kept = kept.slice(0, -1);
    return kept;
  };
  const fieldsOf = (x: Section): StyledField[] => {
    const style: FieldStyle = x.block === "scene" ? "pair" : "block";
    const inline = x.inline ? { inline: true } : {};
    // Winners past Discord's field limit become two fields, so every winner still shows.
    const splitAt = Math.max(1, Math.round(config.winnersSplitAt));
    if (x.key === "winners" && render(x, x.items).length > DISCORD_LIMITS.fieldValue && x.items.length > splitAt) {
      return [x.items.slice(0, splitAt), x.items.slice(splitAt)]
        .map((group) => fit(x, group))
        .filter((group) => group.length > 0)
        .map((group, i) => ({ name: i === 0 || !config.continuedFieldName ? x.name : config.continuedFieldName, value: render(x, group), style: i === 0 ? "block" as const : "continued" as const }));
    }
    const items = fit(x, x.items);
    return items.length ? [{ name: x.name, value: render(x, items), ...inline, style }] : [];
  };

  const title = `${data.resolved.label} — cEDH meta, ${mon} ${data.month.slice(0, 4)}`;
  const notes: string[] = [];
  if (data.resolved.stepsUp > 0) notes.push(`Showing ${data.resolved.label}: ${data.requested.label} didn't have enough data.`);
  if (data.statsRegion && data.scene.events === 0) notes.push(`No qualifying events in ${data.resolved.label} in ${mon}.`);
  if (data.statsRegion?.reportable) notes.push(`Commander stats: ${data.statsRegion.label}, because ${data.resolved.label} had too few entries.`);
  else if (!data.resolved.reportable) notes.push("Not enough decklists yet for commander stats.");
  // The headline reads the untrimmed lists, so it says the same thing however much the sections are cut.
  const headline = headlineLines(data, config, selectRows(data, config, fullCaps));
  const description = [...notes, ...(notes.length && headline.length ? [""] : []), ...headline].join("\n");
  const about: StyledField[] = [
    { name: withEmoji(emoji.coverage, "Coverage"), value: coverageLine(data), style: "pair" },
    { name: withEmoji(emoji.sources, "Sources"), value: ATTRIBUTION_MD, style: "pair" },
  ];
  const look = config.embeds;
  const blockTitle = (template: string) => fill(template, { month: mon });

  let parts: { title?: string; description?: string; color: number; fields: StyledField[] }[];
  let embeds: Embed[];
  for (;;) {
    const sections = named(buildSections(data, config, caps, selectRows(data, config, caps)));
    const of = (block: Block) => sections.filter((x) => x.block === block).flatMap(fieldsOf);
    const people = of("people");
    const decks = of("decks");
    parts = [
      { title, ...(description ? { description } : {}), color: look.overview.color, fields: of("scene") },
      ...(people.length ? [{ ...(look.people.title ? { title: blockTitle(look.people.title) } : {}), color: look.people.color, fields: people }] : []),
      ...(decks.length ? [{ ...(look.decks.title ? { title: blockTitle(look.decks.title) } : {}), color: look.decks.color, fields: decks }] : []),
      { ...(look.about.title ? { title: blockTitle(look.about.title) } : {}), color: look.about.color, fields: about },
    ];
    embeds = parts.map((p) => ({ ...p, fields: p.fields.map(({ style: _style, ...f }) => f) }));
    if (contentLength(embeds) <= config.contentBudget) break;
    if (!trims.find((t) => t())) break;
  }

  const violations = discordLimitViolations(embeds);
  if (violations.length) throw new Error(`post exceeds Discord limits: ${violations.join("; ")}`);

  // Text preview: one block per embed, markup removed, the Sources link written out.
  const lines: string[] = [];
  parts.forEach((p, i) => {
    if (i === 0) lines.push(p.title ?? "");
    else lines.push("", p.title ? `── ${p.title} ──` : "──");
    if (p.description) lines.push(...p.description.split("\n"));
    let previous: FieldStyle | null = null;
    for (const f of p.fields) {
      const value = f.value === ATTRIBUTION_MD ? ATTRIBUTION_PREVIEW : f.value;
      if (f.style === "pair") lines.push(...(previous === "pair" ? [] : [""]), `${f.name}: ${value}`);
      else lines.push("", ...(f.style === "block" ? [f.name] : []), ...value.split("\n"));
      previous = f.style;
    }
  });
  const text = lines.join("\n").replace(/\*\*/g, "").replace(/\\\./g, ".");
  return { embeds, text };
}

/** Longest custom region name; names are cleaned and limited when created (src/server/custom-regions.ts). */
export const CUSTOM_REGION_NAME_MAX = 40;

/**
 * Where a non-reportable custom region's statistical commander sections come from: its anchor (the smallest
 * selectable standard region containing every place, see custom_region_anchor) or the first reportable region
 * above it. Walks up one level at a time and stops at the first reportable one, because resolve_region scores
 * every level up to global (observed November 2026: 1.7 s for Washington, where one check takes 0.5 s).
 * Nothing is stored: the answer follows the region's places and the data.
 */
export async function customStatsRegion(sql: Sql, regionId: string, end: string): Promise<StatsRegion> {
  const [a] = await sql<{ id: string }[]>`select custom_region_anchor(${regionId}) as id`;
  let id = a?.id ?? "global";
  for (let steps = 0; ; steps++) {
    const [row] = await sql<{ label: string; name: string; parent: string | null; reportable: boolean }[]>`
      select region_label(r.id) as label, r.display_name as name, r.parent_region_id as parent,
             (select rr.reportable from region_reportability(r.id, ${end}::date) rr) as reportable
      from regions r where r.id = ${id}`;
    if (!row) throw new Error(`unknown region in the fallback chain: ${id}`);
    if (row.reportable || row.parent === null || steps >= 10) return { id, label: row.label, shortLabel: row.name, reportable: row.reportable };
    id = row.parent;
  }
}

/**
 * The commanders a section can show, as written in the data: winners' commanders, top players' commanders,
 * every row of the deck stats, and trend rows with enough entries to be listed. Sorted, so fixtures are stable.
 */
export function commandersShown(data: Omit<PostData, "colors">, config: PostConfig = POST_CONFIG): string[] {
  const names = new Set<string>();
  for (const r of data.results) for (const x of (r.resultCommanders ?? "").split("; ")) if (x && x !== "unknown") names.add(x);
  for (const p of data.topPlayers) if (p.commander) names.add(p.commander);
  for (const t of data.topCutAppearances) names.add(t.commander);
  for (const m of data.metaShare) names.add(m.commander);
  for (const p of data.ppg) names.add(p.commander);
  for (const x of data.conversion) names.add(x.commander);
  for (const t of data.trend) if (t.lastMonthEntries >= config.risingMinLastMonthEntries) names.add(t.commander);
  return [...names].sort();
}

/**
 * Color identity for each name, from commander_colors (commander_color_identity, migration 017). Names with no
 * matching card are left out. An empty table gives an empty map, and the post then shows no squares.
 */
export async function loadCommanderColors(sql: Sql, names: string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const rows = await sql<{ commander: string; colors: string | null }[]>`
    select n as commander, commander_color_identity(n) as colors from unnest(${sql.array(names, 1009)}::text[]) as n`;
  const found = new Map(rows.map((r) => [r.commander, r.colors]));
  return Object.fromEntries(names.flatMap((n) => {
    const colors = found.get(n);
    return typeof colors === "string" ? [[n, colors] as const] : [];
  }));
}

/** Reads everything composePost needs. The result is JSON-serializable (it is the fixture format). */
export async function loadPostData(sql: Sql, regionId: string, month: string): Promise<PostData> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const end = `${month}-01`;
  const [found] = await sql<{ id: string; label: string; owned: boolean }[]>`
    select id, region_label(id) as label, owner_guild_id is not null as owned from regions where id = ${regionId}`;
  if (!found) throw new Error(`unknown region id: ${regionId}`);
  // A custom region's name is admin-written; it is cleaned when created and again here before it is shown.
  const requested = { id: found.id, label: found.owned ? sanitizeOrganizerText(found.label, CUSTOM_REGION_NAME_MAX) || "Custom region" : found.label };

  // A standard region falls back as a whole to its first reportable parent (resolve_region). A custom region
  // never does: its facts are its own, and only the statistical commander sections borrow another region.
  let res: { region_id: string; steps_up: number; reportable: boolean; label: string };
  let statsRegion: PostData["statsRegion"];
  if (found.owned) {
    const [rep] = await sql<{ reportable: boolean }[]>`select reportable from region_reportability(${regionId}, ${end}::date)`;
    res = { region_id: regionId, steps_up: 0, reportable: rep?.reportable ?? false, label: requested.label };
    if (!res.reportable) statsRegion = await customStatsRegion(sql, regionId, end);
  } else {
    const [row] = await sql<{ region_id: string; steps_up: number; reportable: boolean; label: string }[]>`
      select rr.region_id, rr.steps_up, rr.reportable, region_label(rr.region_id) as label from resolve_region(${regionId}, ${end}::date) rr`;
    if (!row) throw new Error("resolve_region returned no row");
    res = row;
  }
  const r = res.region_id;
  /** Where metaShare, ppg and conversion are read from. */
  const s = statsRegion?.id ?? r;

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
  const topCut = await sql<{ commander: string; top_cut_entries: string; field_entries: string; total_top_cut_entries: string; total_field_entries: string }[]>`
    select commander, top_cut_entries, field_entries, total_top_cut_entries, total_field_entries
    from stat_top_cut_appearances(${r}, ${end}::date) limit 10`;
  const meta = await sql<{ commander: string; entries: string; meta_share: number }[]>`
    select commander, entries, meta_share from stat_meta_share(${s}, ${end}::date) limit 20`;
  const ppg = await sql<{ commander: string; entries: string; ppg: number; shrunk_ppg: number }[]>`
    select commander, entries, ppg, shrunk_ppg from stat_ppg(${s}, ${end}::date)`;
  const conv = await sql<{ commander: string; entries_in_cut_events: string; top_cut_entries: string; conversion: number; baseline_conversion: number }[]>`
    select * from stat_conversion(${s}, ${end}::date)`;
  // Rising and cooling commanders need the region's own trend, so a mixed-scope post skips the query.
  const trend = statsRegion ? [] : await sql<{ commander: string; last_month_entries: string; prior3_avg_entries: number; share_change: number | null; is_new: boolean; first_seen: string | null }[]>`
    select commander, last_month_entries, prior3_avg_entries, share_change, is_new, first_seen::text as first_seen
    from stat_share_trend(${r}, ${end}::date)`;

  const data: Omit<PostData, "colors"> = {
    month,
    requested: { id: requested.id, label: requested.label },
    resolved: { id: r, label: res.label, stepsUp: res.steps_up, reportable: res.reportable },
    ...(statsRegion ? { statsRegion } : {}),
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
    topCutAppearances: topCut.map((t) => ({
      commander: t.commander, topCutEntries: Number(t.top_cut_entries), fieldEntries: Number(t.field_entries),
      totalTopCutEntries: Number(t.total_top_cut_entries), totalFieldEntries: Number(t.total_field_entries),
    })),
    metaShare: meta.map((m) => ({ commander: m.commander, entries: Number(m.entries), metaShare: m.meta_share })),
    ppg: ppg.map((p) => ({ commander: p.commander, entries: Number(p.entries), ppg: p.ppg, shrunkPpg: p.shrunk_ppg })),
    conversion: conv.map((x) => ({
      commander: x.commander, entriesInCutEvents: Number(x.entries_in_cut_events), topCutEntries: Number(x.top_cut_entries), conversion: x.conversion,
    })),
    baselineConversion: conv[0]?.baseline_conversion ?? null,
    trend: trend.map((t) => ({
      commander: t.commander, lastMonthEntries: Number(t.last_month_entries), prior3AvgEntries: Number(t.prior3_avg_entries),
      shareChange: t.share_change, isNew: t.is_new, firstSeen: t.first_seen,
    })),
  };
  // Decoration: color identity of the commanders the post can show. No stat reads it.
  return { ...data, colors: await loadCommanderColors(sql, commandersShown(data)) };
}
