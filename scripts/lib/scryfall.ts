// Scryfall card search, used only to list the cards that can share the command zone (CLAUDE.md data-source
// exception). Only scripts/fetch-pair-commanders.ts and scripts/pair-report.ts call this; the bot and the
// Vercel app never do. Requests are sequential and paced, and 429 responses are retried after Retry-After.
// The TopDeck API key is never sent here.
import { isObj, log, sleep, text } from "./topdeck";

const SEARCH_URL = "https://api.scryfall.com/cards/search";
/** Scryfall asks every client for an identifying User-Agent and an Accept header. */
const DEFAULT_USER_AGENT = "FieldReport/1.0 (https://github.com/EshaanS/cedh-meta-bot)";
const MAX_RETRIES = 5;
const MAX_PAGES = 50;

/**
 * The search whose results make up pair_commanders. A pair leader ("A / B") is valid when both halves are in
 * the list. Observed November 2026: the tag covers both sides of every pairing, including all 30 Backgrounds
 * and all 17 Doctors (scripts/pair-report.ts re-checks this with the two queries below).
 */
export const PAIR_QUERY = "oracletag:pair-commander";
/** Used only by the report, to check the tag still includes the cards that have no pairing ability themselves. */
export const BACKGROUND_QUERY = "type:background";
export const DOCTOR_QUERY = 'type:"time lord" type:doctor';

/** The fields we read from a Scryfall card. Everything else in the card object is dropped. */
export type ScryfallCard = {
  name: string;
  faceNames: string[];
  /** Names printed on this printing instead of the Oracle name: `printed_name` (the Stranger Things cards,
   *  e.g. "Will the Wise" for Wernog, Rider's Chaplain) and `flavor_name` (e.g. "Cecil Harvey" for Tymna). */
  altNames: string[];
  typeLine: string;
  keywords: string[];
  oracleText: string;
};
export type SearchPage = { cards: ScryfallCard[]; totalCards: number | null; nextPage: string | null };
export type PageFetcher = (url: string) => Promise<unknown>;

function pickCard(raw: unknown): ScryfallCard | null {
  if (!isObj(raw)) return null;
  const name = text(raw.name);
  if (!name) return null;
  const faces = (Array.isArray(raw.card_faces) ? raw.card_faces : []).filter(isObj);
  const strings = (xs: unknown[]) => xs.map(text).filter((n): n is string => n !== null);
  return {
    name,
    faceNames: strings(faces.map((f) => f.name)),
    altNames: strings([raw.printed_name, raw.flavor_name, ...faces.flatMap((f) => [f.printed_name, f.flavor_name])]),
    typeLine: text(raw.type_line) ?? "",
    keywords: Array.isArray(raw.keywords) ? raw.keywords.filter((k): k is string => typeof k === "string") : [],
    oracleText: text(raw.oracle_text) ?? "",
  };
}

/** Whitelists one search response. A "not_found" error object (no card matches) is an empty page. */
export function parseSearchPage(raw: unknown): SearchPage {
  if (!isObj(raw)) throw new Error("Scryfall: response is not an object");
  if (raw.object === "error") {
    if (raw.code === "not_found") return { cards: [], totalCards: 0, nextPage: null };
    throw new Error(`Scryfall error: ${text(raw.code) ?? "unknown"} ${text(raw.details) ?? ""}`.trim());
  }
  if (raw.object !== "list" || !Array.isArray(raw.data)) throw new Error("Scryfall: expected a list object");
  const next = raw.has_more === true ? text(raw.next_page) : null;
  if (raw.has_more === true && !next) throw new Error("Scryfall: has_more without next_page");
  return {
    cards: raw.data.map(pickCard).filter((c): c is ScryfallCard => c !== null),
    totalCards: typeof raw.total_cards === "number" ? raw.total_cards : null,
    nextPage: next,
  };
}

/** The Oracle names of a card: its name, and for a card written "Front // Back" each face name as well. */
export function oracleNames(card: ScryfallCard): string[] {
  const parts = card.name.includes(" // ") ? card.name.split(" // ").map((p) => p.trim()) : [];
  return [...new Set([card.name, ...parts, ...card.faceNames])].filter(Boolean);
}

/** Every name a card can appear under in a TopDeck leader: its Oracle names and this printing's own names. */
export function leaderNames(card: ScryfallCard): string[] {
  return [...new Set([...oracleNames(card), ...card.altNames.flatMap((n) => [n, ...n.split(" // ").map((p) => p.trim())])])].filter(Boolean);
}

/**
 * The key names are compared on: lower case, with typographic apostrophes made straight. Observed November
 * 2026: TopDeck writes "Kraum, Ludevic’s Opus" with a curly apostrophe in older events (211 entries).
 * Must match the SQL function card_name_key (migration 012).
 */
export const cardNameKey = (name: string): string => name.replace(/[‘’ʼ`´]/g, "'").trim().toLowerCase();

function retryAfterMs(header: string | null): number {
  const secs = Number(header);
  return header && Number.isFinite(secs) ? Math.max(0, secs * 1000) : 60_000;
}

async function fetchPage(url: string): Promise<unknown> {
  if (!url.startsWith("https://api.scryfall.com/")) throw new Error("Scryfall: refusing a next_page outside api.scryfall.com");
  const headers = { Accept: "application/json", "User-Agent": process.env.SCRYFALL_USER_AGENT || DEFAULT_USER_AGENT };
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      log(`Scryfall 429; waiting ${Math.ceil(wait / 1000)}s (retry ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }
    // Scryfall answers a search with no matches with 404 and an error object.
    if (!res.ok && res.status !== 404) throw new Error(`Scryfall search failed with HTTP ${res.status}`);
    return JSON.parse(await res.text());
  }
}

export type SearchResult = { cards: ScryfallCard[]; totalCards: number | null; pages: number; complete: boolean };

/**
 * Every result for `query`, following next_page with `pauseMs` between requests: one row per card, or with
 * `unique: "prints"` one row per printing (needed to see printed and flavor names). `complete` is true when the
 * number of rows read equals Scryfall's total_cards.
 */
export async function searchCards(
  query: string,
  opts: { fetcher?: PageFetcher; pauseMs?: number; unique?: "cards" | "prints" } = {},
): Promise<SearchResult> {
  const fetcher = opts.fetcher ?? fetchPage;
  const pauseMs = opts.pauseMs ?? 1000;
  const cards: ScryfallCard[] = [];
  let totalCards: number | null = null;
  let pages = 0;
  let url: string | null = `${SEARCH_URL}?${new URLSearchParams({ q: query, unique: opts.unique ?? "cards" })}`;
  while (url) {
    if (pages >= MAX_PAGES) throw new Error(`Scryfall: more than ${MAX_PAGES} pages for one query`);
    if (pages > 0 && pauseMs > 0) await sleep(pauseMs);
    const page = parseSearchPage(await fetcher(url));
    pages++;
    cards.push(...page.cards);
    totalCards = page.totalCards ?? totalCards;
    url = page.nextPage;
  }
  return { cards, totalCards, pages, complete: totalCards !== null && cards.length === totalCards };
}
