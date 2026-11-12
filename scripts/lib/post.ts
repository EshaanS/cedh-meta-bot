// Monthly post composer (v4): one region, one month. Turns the region a server chose and the report month into
// the embeds of one Discord message and a text preview. Every stat describes the report month only, and only
// the chosen region's own data is shown: nothing is borrowed from a larger region. loadPostData reads the
// database; composePost is pure and works on the saved data (test fixtures use it). No Discord HTTP here. The
// Sources field of the last embed carries "Data provided by TopDeck.gg" with a link (CLAUDE.md rule).
import type { Sql } from "./db";

export const POST_CONFIG = {
  /** Characters across all embeds of the message. Discord's hard limit for one message's embeds is 6,000. */
  contentBudget: 4800,
  /** Years of player history ingested; shown on Rising players so "first" isn't read as "new to the game". */
  playerHistoryYears: 3,
  eventNameMax: 50,
  /** Longer player names are cut at the last whole word that fits, with an ellipsis. */
  playerNameMax: 40,
  // Lists: a top 5, or a top 3 for the three "rising" kinds. There is no display minimum: a list shows the
  // first rows of whatever the month's calculation returns, with the counts on every line.
  winnersMax: 5,
  topPlayersMax: 5,
  risingPlayersMax: 3,
  topCutMax: 5,
  mostPlayedMax: 5,
  bestResultsMax: 5,
  conversionMax: 5,
  risingMax: 3,
  coolingMax: 3,
  /** Top-cut appearances line: 2 = "157 cuts · 9.1% of cuts vs 7.9% of field", 1 = "157 cuts · 1.15× its field
   *  share", 0 = "157 cuts". When the post is over budget the level steps down before any line is trimmed. */
  topCutDetail: 2,
  /** The stat functions give PPG and conversion only for commanders with this many entries in the month
   *  (stat_eligible_commanders, deviation 7). It is named in the two headers; changing it here changes the
   *  header text only, not the functions. */
  deckStatMinEntries: 10,
  /** What "rising" and "cooling" mean, not display minimums: a riser needs this many entries in the month. */
  risingMinLastMonthEntries: 10,
  /** A commander first seen (anywhere in our data) in the report month or the newCommanderMonths - 1 months
   *  before it is "new since <date>", even if it already has entries in the prior 3 months. */
  newCommanderMonths: 2,
  /** A cooling commander is one of the coolingTopN most played of the prior 3 months, with at least
   *  coolingMinEntries in the month or in the prior monthly average. */
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
  /** The whole post for a region with no qualifying events in the month: this line, under the usual title. */
  noEventsCopy: "No qualifying events in {region} in {month}.",
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
    mostPlayed: "{icon} **{commander}** is the most played commander: {share} of {month} entries",
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
  /** Every other list: the name on line 1 (with its medal), the details and the color circles on line 2.
   *  0 keeps each item on one line. */
  detailOnSecondLine: 1,
  /** A blank line between the items of a section, so rows of emoji never touch. */
  spacing: { winners: 1, topPlayers: 1, risingPlayers: 1, topCut: 1, mostPlayed: 1, best: 1, conversion: 1, risingCommanders: 1, coolingCommanders: 1 },
  /** Most played: a bar scaled to the top commander's share, barWidth cells wide, at least one cell filled.
   *  The glyphs take the text color, so they read on light and dark themes and can't be mistaken for mana. */
  shareBars: 1,
  barWidth: 10,
  barFilled: "▰",
  barEmpty: "▱",
  /** Color identity after a commander's details, in WUBRG order with `separator` between symbols, from
   *  PostData.colors (Scryfall's color identity; a pair is the union of both halves). A commander with no match
   *  shows none. ⚪ and ⚫ can fade into Discord's light and dark backgrounds; all symbols are set here. */
  colorSquares: 1,
  colorSymbols: { W: "⚪", U: "🔵", B: "⚫", R: "🔴", G: "🟢", colorless: "🔘", separator: " " },
} as const;
type Widen<T> = T extends number ? number : T extends string ? string : { -readonly [K in keyof T]: Widen<T[K]> };
export type PostConfig = Widen<typeof POST_CONFIG>;
type SectionKey = keyof PostConfig["sectionEmoji"];

/** Discord limits (characters; `total` is across all embeds of one message). */
export const DISCORD_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, fields: 25, embeds: 10, total: 6000 } as const;

/** Everything in it describes `region` in `month`, except `trend`, which compares the month with earlier ones. */
export type PostData = {
  month: string; // YYYY-MM
  /** The region the server chose. A post never shows another region's data. */
  region: { id: string; label: string };
  scene: {
    events: number; players: number; prevEvents: number; prevPlayers: number;
    largestEventName: string | null; largestEventPlayers: number | null; drawRate: number | null;
  };
  /** Qualifying events in the month, and shares (0-100) of the month's qualifying entries: with a registered
   *  commander, and with a TopDeck account id. */
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
  /** topCuts: the commander's top-cut entries in the month, used to order commanders with equal entries. */
  metaShare: { commander: string; entries: number; metaShare: number; topCuts: number }[];
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
const plural = (n: number, one: string, many: string) => `${int(n)} ${n === 1 ? one : many}`;
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
/** Names in code-unit order: the last word of every tie rule, the same on every machine. */
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

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
  const head = `${plural(t.lastMonthEntries, "entry", "entries")} in ${monthOf(data.month)}`;
  if (trendKinds(data, c).recent(t)) return `${head}, new since ${shortDate(t.firstSeen!)}`;
  return t.isNew ? `${head}, new` : `${head} (avg ${monthlyAvg(t.prior3AvgEntries)}/month)`;
}

/**
 * The rows each section shows, in order, before any formatting. The headline reads the same lists. There is
 * no display minimum; every order ends in the commander's or player's name, so equal rows always come out the
 * same way: more entries first, then more top cuts, then the name.
 */
function selectRows(data: PostData, c: PostConfig, caps: Caps) {
  // Player names are user-written, so they get the same cleaning as organizer text.
  const playerText = (name: string) => sanitizeOrganizerText(name, c.playerNameMax, { wholeWords: true });
  const topPlayers = data.topPlayers.map((p) => ({ ...p, name: playerText(p.name) })).filter((p) => p.name).slice(0, caps.topPlayers);
  const risingPlayers = data.risingPlayers.map((p) => ({ ...p, name: playerText(p.name) })).filter((p) => p.name).slice(0, caps.risingPlayers);

  const topCut = [...data.topCutAppearances]
    .sort((a, b) => b.topCutEntries - a.topCutEntries || b.fieldEntries - a.fieldEntries || byName(a.commander, b.commander))
    .slice(0, caps.topCut);
  const most = [...data.metaShare]
    .sort((a, b) => b.entries - a.entries || b.topCuts - a.topCuts || byName(a.commander, b.commander))
    .slice(0, caps.mostPlayed);
  const cutsOf = new Map(data.conversion.map((x) => [x.commander, x.topCutEntries]));
  const cuts = (commander: string) => cutsOf.get(commander) ?? 0;
  const best = [...data.ppg]
    .sort((a, b) => b.shrunkPpg - a.shrunkPpg || b.entries - a.entries || cuts(b.commander) - cuts(a.commander) || byName(a.commander, b.commander))
    .slice(0, caps.best);
  const conv = [...data.conversion]
    .sort((a, b) => b.conversion - a.conversion || b.entriesInCutEvents - a.entriesInCutEvents || b.topCutEntries - a.topCutEntries || byName(a.commander, b.commander))
    .slice(0, caps.conversion);

  const matching = c.trendNeedsMatchingCounts > 0;
  const { isNew } = trendKinds(data, c);
  const rising = data.trend
    .filter((t) => t.lastMonthEntries >= c.risingMinLastMonthEntries)
    .filter((t) => isNew(t) || ((t.shareChange ?? 0) > 0 && (!matching || t.lastMonthEntries > t.prior3AvgEntries)))
    // New commanders first, most entries first; then the others by share growth.
    .sort((a, b) =>
      Number(isNew(b)) - Number(isNew(a))
      || (isNew(a) ? 0 : (b.shareChange ?? 0) - (a.shareChange ?? 0))
      || b.lastMonthEntries - a.lastMonthEntries || byName(a.commander, b.commander))
    .slice(0, caps.rising);
  // "A top commander" is one of the most played of the prior 3 months, so one that fell out of this month's
  // top can still be listed as cooling.
  const topBefore = new Set([...data.trend]
    .sort((a, b) => b.prior3AvgEntries - a.prior3AvgEntries || byName(a.commander, b.commander))
    .slice(0, c.coolingTopN).map((t) => t.commander));
  const cooling = data.trend
    .filter((t) => topBefore.has(t.commander) && !isNew(t) && t.shareChange !== null && t.shareChange < 0)
    .filter((t) => t.lastMonthEntries >= c.coolingMinEntries || t.prior3AvgEntries >= c.coolingMinEntries)
    .filter((t) => !matching || t.lastMonthEntries < t.prior3AvgEntries)
    .sort((a, b) => a.shareChange! - b.shareChange! || b.prior3AvgEntries - a.prior3AvgEntries || byName(a.commander, b.commander))
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
  const entries = (n: number) => plural(n, "entry", "entries");
  /** Color identity symbols of a commander ("" when unknown or switched off). */
  const colors = (commander: string) => {
    const id = caps.squares > 0 ? data.colors?.[commander] : undefined;
    if (id === undefined) return "";
    if (id === "") return c.colorSymbols.colorless;
    return [...id].map((l) => (l in c.colorSymbols ? c.colorSymbols[l as "W" | "U" | "B" | "R" | "G"] : "")).filter(Boolean).join(c.colorSymbols.separator);
  };
  /** " · ⚪ 🔵" to end a line of details, or nothing. */
  const withColors = (commander: string) => (colors(commander) ? ` · ${colors(commander)}` : "");
  const name = (commander: string) => bold(shortenCommander(commander));
  /** A commander item: its name on line 1 and the details with the colors on line 2, or all on one line. */
  const deckItem = (commander: string, detail: string, lead = "") =>
    two ? [`${lead}${name(commander)}`, `${detail}${withColors(commander)}`] : [`${lead}${name(commander)} — ${detail}${withColors(commander)}`];

  // Scene this month (inline)
  const sc = data.scene;
  const evChange = changeVs(sc.events, sc.prevEvents, prevMon);
  const plChange = changeVs(sc.players, sc.prevPlayers, prevMon);
  s.push({ key: "scene", block: "scene", name: `Events — ${mon}`, items: [[`${int(sc.events)}${evChange ? ` (${evChange})` : ""}`]], inline: true });
  s.push({ key: "scene", block: "scene", name: "Players", items: [[`${int(sc.players)}${plChange ? ` (${plChange})` : ""}`]], inline: true });
  if (sc.drawRate !== null) s.push({ key: "scene", block: "scene", name: "Draw rate", items: [[pct(sc.drawRate, 0)]], inline: true });
  if (sc.largestEventName && sc.largestEventPlayers) {
    s.push({ key: "scene", block: "scene", name: "Largest event", items: [[`${int(sc.largestEventPlayers)} players · ${eventText(sc.largestEventName, c)}`]], ...(c.largestEventInline > 0 ? { inline: true } : {}) });
  }

  // People. The embed's title carries the month, so these names don't repeat it.
  const winners = rows.winners.map((r) => {
    const outcome = outcomeText(r, rows.playerText, (x) => `${shortenCommander(x)}${withColors(x)}`, (who) => who);
    if (c.winnersTwoLines < 1) return [`• ${r.participantCount}p · ${eventText(r.eventName, c)} · ${outcome}`];
    return [`${bold(eventText(r.eventName, c))} · ${plural(r.participantCount, "player", "players")}`, `${r.result === "winner" ? icon("win") : ""}${outcome}`];
  });
  if (winners.length) s.push({ key: "winners", block: "people", name: "Winners (largest events)", items: winners });

  if (rows.topPlayers.length) {
    const iconsOn = c.lineIcons.win !== "" || c.lineIcons.topCut !== "";
    s.push({
      key: "topPlayers", block: "people", ranked: true, name: "Top players",
      items: rows.topPlayers.map((p) => {
        const record = [p.wins > 0 ? `${icon("win")}${plural(p.wins, "win", "wins")}` : "", p.topCuts > 0 ? `${icon("topCut")}${plural(p.topCuts, "top cut", "top cuts")}` : ""]
          .filter(Boolean).join(iconsOn ? " · " : ", ");
        const deck = p.commander ? ` · ${shortenCommander(p.commander)}${withColors(p.commander)}` : "";
        return two ? [bold(p.name), `${record}${deck}`] : [`${bold(p.name)} — ${record}${deck}`];
      }),
    });
  }
  if (rows.risingPlayers.length) {
    s.push({
      key: "risingPlayers", block: "people",
      name: `Rising players (first win or top cut in ${c.playerHistoryYears} years of data)`,
      items: rows.risingPlayers.map((p) => {
        const mark = icon(p.reason === "first win" ? "win" : "topCut");
        const reason = RISING_REASON_TEXT[p.reason] ?? p.reason;
        const event = eventText(p.eventName, c);
        return two
          ? [bold(p.name), `${mark}${reason} · ${plural(p.participantCount, "player", "players")} · ${event}`]
          : [`${mark}${bold(p.name)} — ${reason} · ${p.participantCount}p ${event}`];
      }),
    });
  }

  // Decks. All of them describe the report month, which the embed's title names.
  if (rows.topCut.length) {
    s.push({
      key: "topCut", block: "decks", ranked: true, name: "Top-cut appearances",
      items: rows.topCut.map((t) => {
        const cutCount = plural(t.topCutEntries, "cut", "cuts");
        // Share of the month's top cuts against share of the field in the events that had a cut.
        if (caps.topCutDetail < 1 || t.totalTopCutEntries <= 0 || t.totalFieldEntries <= 0 || t.fieldEntries <= 0) return deckItem(t.commander, cutCount);
        const cutShare = t.topCutEntries / t.totalTopCutEntries;
        const fieldShare = t.fieldEntries / t.totalFieldEntries;
        const detail = caps.topCutDetail >= 2 ? `${pct(cutShare)} of cuts vs ${pct(fieldShare)} of field` : `${(cutShare / fieldShare).toFixed(2)}× its field share`;
        return deckItem(t.commander, `${cutCount} · ${detail}`);
      }),
    });
  }
  if (rows.most.length) {
    // The bar is scaled to the month's most played commander, whatever the list is trimmed to.
    const topShare = Math.max(0, ...data.metaShare.map((m) => m.metaShare));
    const width = Math.max(1, Math.round(c.barWidth));
    const bar = (share: number) => {
      const filled = topShare > 0 ? Math.min(width, Math.max(1, Math.round((share / topShare) * width))) : 1;
      return `${c.barFilled.repeat(filled)}${c.barEmpty.repeat(width - filled)} `;
    };
    s.push({
      key: "mostPlayed", block: "decks", ranked: true, name: "Most played",
      items: rows.most.map((m) => deckItem(m.commander, `${caps.bars > 0 ? bar(m.metaShare) : ""}${pct(m.metaShare)} · ${entries(m.entries)}`)),
    });
  }
  if (rows.best.length) {
    s.push({
      key: "best", block: "decks", ranked: true,
      name: `Best results (adjusted PPG, ${c.deckStatMinEntries}+ entries)`,
      items: rows.best.map((p) => deckItem(p.commander, `${p.shrunkPpg.toFixed(2)} · ${entries(p.entries)}`)),
    });
  }
  if (rows.conv.length) {
    const base = data.baselineConversion === null ? "" : `baseline ${pct(data.baselineConversion, 0)}, `;
    s.push({
      key: "conversion", block: "decks", ranked: true,
      name: `Top-cut conversion (${base}${c.deckStatMinEntries}+ entries)`,
      items: rows.conv.map((x) => deckItem(x.commander, `${pct(x.conversion, 0)} · ${int(x.topCutEntries)} of ${entries(x.entriesInCutEvents)}`)),
    });
  }
  if (rows.rising.length) {
    s.push({
      key: "risingCommanders", block: "decks", name: "Rising commanders (by share growth vs prior 3 months)",
      items: rows.rising.map((t) => deckItem(t.commander, trendDetail(data, c, t), icon(rows.isNew(t) ? "newCommander" : "rising"))),
    });
  }
  if (rows.cooling.length) {
    s.push({
      key: "coolingCommanders", block: "decks", name: "Cooling commanders (by share drop vs prior 3 months)",
      items: rows.cooling.map((t) => deckItem(t.commander, trendDetail(data, c, t), icon("cooling"))),
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
  } else if (data.scene.largestEventName && data.scene.largestEventPlayers) {
    out.push(fill(copy.event, { icon: emoji.winners, event: eventText(data.scene.largestEventName, c), players: String(data.scene.largestEventPlayers) }));
  }

  const [lead, next] = rows.topCut;
  const mostPlayed = rows.most[0];
  if (lead && lead.topCutEntries >= c.headlineMinCuts && (!next || lead.topCutEntries > next.topCutEntries)) {
    out.push(fill(copy.topCut, { icon: emoji.topCut, commander: shortenCommander(lead.commander), cuts: String(lead.topCutEntries) }));
  } else if (mostPlayed) {
    out.push(fill(copy.mostPlayed, { icon: emoji.mostPlayed, commander: shortenCommander(mostPlayed.commander), share: pct(mostPlayed.metaShare), month: monthOf(data.month) }));
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
  const players = p === null ? "" : ` · ${p.toFixed(0)}% of entries have a linked player`;
  return `${plural(data.coverage.qualifyingEvents, "qualifying event", "qualifying events")} in ${monthOf(data.month)} · ${leaderPct} of entries with decklists${players}`;
}

/** How a field is written in the text preview: "name: value", or the name over its lines. */
type FieldStyle = "pair" | "block";
type StyledField = EmbedField & { style: FieldStyle };
type Part = { title?: string; description?: string; color: number; fields: StyledField[] };

/** One block per embed, markup removed, the Sources link written out. */
function previewText(parts: Part[]): string {
  const lines: string[] = [];
  parts.forEach((p, i) => {
    if (i === 0) lines.push(p.title ?? "");
    else lines.push("", p.title ? `── ${p.title} ──` : "──");
    if (p.description) lines.push(...p.description.split("\n"));
    let previous: FieldStyle | null = null;
    for (const f of p.fields) {
      const value = f.value === ATTRIBUTION_MD ? ATTRIBUTION_PREVIEW : f.value;
      if (f.style === "pair") lines.push(...(previous === "pair" ? [] : [""]), `${f.name}: ${value}`);
      else lines.push("", f.name, ...value.split("\n"));
      previous = f.style;
    }
  });
  return lines.join("\n").replace(/\*\*/g, "").replace(/\\\./g, ".");
}

/**
 * Pure: builds the message's embeds and the plain-text preview, trimming until the content budget fits.
 * A month with no qualifying events is one embed with one line (and the Sources field). Otherwise, trim
 * order: the top-cut lines lose detail (both shares, then the ratio, then the count alone); decoration goes
 * (blank spacing, share bars, color symbols); the decks block is cut bottom-up (each section to a floor, then
 * deeper); then the player sections; and Winners last. The headline, the scene, Coverage and Sources are
 * never trimmed.
 */
export function composePost(data: PostData, config: PostConfig = POST_CONFIG): { embeds: Embed[]; text: string } {
  const emoji = config.sectionEmoji;
  const mon = monthOf(data.month);
  const look = config.embeds;
  const title = `${data.region.label} — cEDH meta, ${mon} ${data.month.slice(0, 4)}`;
  const sources: StyledField = { name: withEmoji(emoji.sources, "Sources"), value: ATTRIBUTION_MD, style: "pair" };
  const strip = (parts: Part[]): Embed[] => parts.map((p) => ({ ...p, fields: p.fields.map(({ style: _style, ...f }) => f) }));
  const finish = (parts: Part[]) => {
    const embeds = strip(parts);
    const violations = discordLimitViolations(embeds);
    if (violations.length) throw new Error(`post exceeds Discord limits: ${violations.join("; ")}`);
    return { embeds, text: previewText(parts) };
  };

  if (data.scene.events === 0) {
    return finish([{ title, description: fill(config.noEventsCopy, { region: data.region.label, month: mon }), color: look.overview.color, fields: [sources] }]);
  }

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
    step("cooling", 0), step("rising", 0), step("conversion", 3), step("best", 3), step("mostPlayed", 3), step("topCut", 3),
    step("conversion", 0), step("best", 0), step("topCut", 0),
    step("risingPlayers", 1), step("topPlayers", 3), step("risingPlayers", 0), step("topPlayers", 0),
    step("winners", 3),
  ];
  // The emoji goes on a section's first field (the scene is several inline fields under one emoji).
  const named = (list: Section[]) => list.map((x, i) => ({ ...x, name: list.findIndex((y) => y.key === x.key) === i ? withEmoji(emoji[x.key], x.name) : x.name }));
  const marks = config.medals > 0 ? config.rankSymbols.split(" ").filter(Boolean) : [];
  const mark = (i: number) => marks[i] ?? `${i + 1}${config.listNumberSuffix}`;
  const spaced = (x: Section) => caps.spacing > 0 && x.key in config.spacing && config.spacing[x.key as keyof PostConfig["spacing"]] > 0;
  const render = (x: Section, items: string[][]) =>
    items.map((it, i) => (x.ranked ? [`${mark(i)} ${it[0]!}`, ...it.slice(1)] : it).join("\n")).join(spaced(x) ? "\n\n" : "\n");
  /** Safety net: keeps items from the top while the field value fits Discord's limit. */
  const fit = (x: Section, items: string[][]) => {
    let kept = items;
    while (kept.length > 0 && render(x, kept).length > DISCORD_LIMITS.fieldValue) kept = kept.slice(0, -1);
    return kept;
  };
  const fieldsOf = (x: Section): StyledField[] => {
    const items = fit(x, x.items);
    return items.length ? [{ name: x.name, value: render(x, items), ...(x.inline ? { inline: true } : {}), style: x.block === "scene" ? "pair" : "block" }] : [];
  };

  // The headline reads the untrimmed lists, so it says the same thing however much the sections are cut.
  const headline = headlineLines(data, config, selectRows(data, config, fullCaps));
  const about: StyledField[] = [{ name: withEmoji(emoji.coverage, "Coverage"), value: coverageLine(data), style: "pair" }, sources];
  const blockTitle = (template: string) => (template ? { title: fill(template, { month: mon }) } : {});

  let parts: Part[];
  for (;;) {
    const sections = named(buildSections(data, config, caps, selectRows(data, config, caps)));
    const of = (block: Block) => sections.filter((x) => x.block === block).flatMap(fieldsOf);
    const people = of("people");
    const decks = of("decks");
    parts = [
      { title, ...(headline.length ? { description: headline.join("\n") } : {}), color: look.overview.color, fields: of("scene") },
      ...(people.length ? [{ ...blockTitle(look.people.title), color: look.people.color, fields: people }] : []),
      ...(decks.length ? [{ ...blockTitle(look.decks.title), color: look.decks.color, fields: decks }] : []),
      { ...blockTitle(look.about.title), color: look.about.color, fields: about },
    ];
    if (contentLength(strip(parts)) <= config.contentBudget) break;
    if (!trims.find((t) => t())) break;
  }
  return finish(parts);
}

/** Longest custom region name; names are cleaned and limited when created (src/server/custom-regions.ts). */
export const CUSTOM_REGION_NAME_MAX = 40;

/**
 * The commanders a section can show, as written in the data: winners' commanders, top players' commanders,
 * every row of the deck stats, and trend rows that can be listed as rising or cooling. Sorted, so fixtures are
 * stable.
 */
export function commandersShown(data: Omit<PostData, "colors">, config: PostConfig = POST_CONFIG): string[] {
  const names = new Set<string>();
  for (const r of data.results) for (const x of (r.resultCommanders ?? "").split("; ")) if (x && x !== "unknown") names.add(x);
  for (const p of data.topPlayers) if (p.commander) names.add(p.commander);
  for (const t of data.topCutAppearances) names.add(t.commander);
  for (const m of data.metaShare) names.add(m.commander);
  for (const p of data.ppg) names.add(p.commander);
  for (const x of data.conversion) names.add(x.commander);
  for (const t of data.trend) {
    if (t.lastMonthEntries >= config.risingMinLastMonthEntries || t.prior3AvgEntries >= config.coolingMinEntries) names.add(t.commander);
  }
  return [...names].sort();
}

/**
 * Color identity for each name, from commander_colors (commander_color_identity, migration 017). Names with no
 * matching card are left out. An empty table gives an empty map, and the post then shows no color symbols.
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

/**
 * Reads everything composePost needs: the chosen region, the report month. Every stat function that takes a
 * window is called with 1 month; the functions themselves are unchanged (their default is still 6 months, which
 * `npm run report` uses). Rows are ordered here as the composer orders them (more entries, then more top cuts,
 * then name), so a tie is broken before the lists are cut to their limits. The result is JSON-serializable (it
 * is the fixture format).
 */
export async function loadPostData(sql: Sql, regionId: string, month: string): Promise<PostData> {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`month must be YYYY-MM, got ${month}`);
  const end = `${month}-01`;
  const [found] = await sql<{ id: string; label: string; owned: boolean }[]>`
    select id, region_label(id) as label, owner_guild_id is not null as owned from regions where id = ${regionId}`;
  if (!found) throw new Error(`unknown region id: ${regionId}`);
  // A custom region's name is admin-written; it is cleaned when created and again here before it is shown.
  const label = found.owned ? sanitizeOrganizerText(found.label, CUSTOM_REGION_NAME_MAX) || "Custom region" : found.label;
  const r = found.id;
  const c = POST_CONFIG;

  const [scene] = await sql<{ events: string; players: string; prev_events: string; prev_players: string; largest_event_name: string | null; largest_event_players: number | null; draw_rate: number | null }[]>`
    select * from stat_scene(${r}, ${end}::date)`;
  const [cov] = await sql<{ qualifying_events: string; pct_entries_with_leader: number | null }[]>`
    select qualifying_events, pct_entries_with_leader from stat_coverage(${r}, ${end}::date, 1)`;
  const results = await sql<{ event_name: string | null; participant_count: number; result: string; result_commanders: string | null; winner_name: string | null; winner_hidden: boolean }[]>`
    select event_name, participant_count, result, result_commanders, winner_name, winner_hidden from stat_month_results(${r}, ${end}::date, ${c.winnersMax}::int)`;
  const [playerCov] = await sql<{ pct_entries_with_player: number | null }[]>`
    select pct_entries_with_player from stat_player_coverage(${r}, ${end}::date)`;
  const topPlayers = await sql<{ player_name: string; wins: string; top_cuts: string; top_commander: string | null }[]>`
    select player_name, wins, top_cuts, top_commander from stat_top_players(${r}, ${end}::date, ${c.topPlayersMax}::int)`;
  const risingPlayers = await sql<{ player_name: string; reason: string; event_name: string | null; participant_count: number }[]>`
    select player_name, reason, event_name, participant_count from stat_rising_players(${r}, ${end}::date, ${c.risingPlayersMax}::int)`;
  const topCut = await sql<{ commander: string; top_cut_entries: string; field_entries: string; total_top_cut_entries: string; total_field_entries: string }[]>`
    select commander, top_cut_entries, field_entries, total_top_cut_entries, total_field_entries
    from stat_top_cut_appearances(${r}, ${end}::date)
    order by top_cut_entries desc, field_entries desc, commander collate "C" limit 10`;
  const meta = await sql<{ commander: string; entries: string; meta_share: number; top_cuts: string }[]>`
    select m.commander, m.entries, m.meta_share, coalesce(t.top_cut_entries, 0) as top_cuts
    from stat_meta_share(${r}, ${end}::date, 1) m
    left join stat_top_cut_appearances(${r}, ${end}::date) t on t.commander = m.commander
    order by m.entries desc, top_cuts desc, m.commander collate "C" limit 20`;
  const ppg = await sql<{ commander: string; entries: string; ppg: number; shrunk_ppg: number }[]>`
    select commander, entries, ppg, shrunk_ppg from stat_ppg(${r}, ${end}::date, 1)`;
  const conv = await sql<{ commander: string; entries_in_cut_events: string; top_cut_entries: string; conversion: number; baseline_conversion: number }[]>`
    select * from stat_conversion(${r}, ${end}::date, 1)`;
  const trend = await sql<{ commander: string; last_month_entries: string; prior3_avg_entries: number; share_change: number | null; is_new: boolean; first_seen: string | null }[]>`
    select commander, last_month_entries, prior3_avg_entries, share_change, is_new, first_seen::text as first_seen
    from stat_share_trend(${r}, ${end}::date)`;

  const data: Omit<PostData, "colors"> = {
    month,
    region: { id: r, label },
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
    metaShare: meta.map((m) => ({ commander: m.commander, entries: Number(m.entries), metaShare: m.meta_share, topCuts: Number(m.top_cuts) })),
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
