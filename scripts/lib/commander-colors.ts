// Fills commander_colors from Scryfall: the color identity of every card that can be a commander. The fetch
// and the write are separate so tests can inject a fake search. Only names and color identity are stored; no
// images and no image URLs are read.
import type { Sql } from "./db";
import { cardNameKey, COMMANDER_QUERY, leaderNames, searchCards, type ScryfallCard, type SearchResult } from "./scryfall";

/** Below this many cards the response is treated as wrong and nothing is written. */
export const MIN_COMMANDER_CARDS = 1000;
const FRESH_HOURS = 24;
const INSERT_ROWS = 1000;

export type ColorRow = { name_key: string; name: string; card_name: string; colors: string };

/** One row per distinct name key. A card's own Oracle name wins over another card's face or printed name. */
export function colorRows(cards: ScryfallCard[]): ColorRow[] {
  const byKey = new Map<string, ColorRow>();
  const add = (name: string, card: ScryfallCard, replace: boolean) => {
    const key = cardNameKey(name);
    if (key && (replace || !byKey.has(key))) byKey.set(key, { name_key: key, name, card_name: card.name, colors: card.colorIdentity });
  };
  for (const c of cards) for (const n of leaderNames(c)) add(n, c, false);
  for (const c of cards) add(c.name, c, true);
  return [...byKey.values()].sort((a, b) => a.name_key.localeCompare(b.name_key));
}

/**
 * What commander_color_identity does in SQL, for the report and the tests: the union of both halves of a
 * leader, null when a half has no match. `pairCardKey` maps a printed or flavor name of a pair card to the
 * key of its Oracle name (pair_commanders).
 */
export function leaderColors(leader: string, colors: Map<string, string>, pairCardKey: Map<string, string> = new Map()): string | null {
  const halves = leader.split(" / ");
  const found = halves.map((h) => {
    const key = cardNameKey(h);
    return colors.get(key) ?? colors.get(pairCardKey.get(key) ?? "") ?? null;
  });
  if (found.some((c) => c === null)) return null;
  return [..."WUBRG"].filter((l) => found.some((c) => c!.includes(l))).join("");
}

export type ColorRefresh =
  | { status: "fresh"; names: number; fetchedAt: Date }
  | { status: "stored"; names: number; cards: number; removed: number };

/**
 * Replaces commander_colors with the current list, in one transaction. Skips the fetch when the stored list
 * is under 24 hours old (unless `force`). Throws, writing nothing, when the search is incomplete or
 * implausibly small, so a bad response can never empty the table.
 */
export async function refreshCommanderColors(
  sql: Sql,
  opts: { force?: boolean; search?: (query: string) => Promise<SearchResult> } = {},
): Promise<ColorRefresh> {
  const [stored] = await sql<{ n: string; newest: Date | null }[]>`select count(*) as n, max(fetched_at) as newest from commander_colors`;
  if (!opts.force && stored?.newest && Date.now() - stored.newest.getTime() < FRESH_HOURS * 3_600_000) {
    return { status: "fresh", names: Number(stored.n), fetchedAt: stored.newest };
  }
  // One row per card: color identity is the same on every printing.
  const search = opts.search ?? ((q: string) => searchCards(q, { unique: "cards" }));
  const result = await search(COMMANDER_QUERY);
  const cards = new Set(result.cards.map((c) => c.name)).size;
  if (!result.complete) throw new Error(`Scryfall list incomplete: read ${result.cards.length} of ${result.totalCards}; nothing written`);
  if (cards < MIN_COMMANDER_CARDS) throw new Error(`Scryfall list has only ${cards} cards (expected at least ${MIN_COMMANDER_CARDS}); nothing written`);

  const rows = colorRows(result.cards);
  const fetchedAt = new Date();
  const removed = await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += INSERT_ROWS) {
      await tx`
        insert into commander_colors ${tx(rows.slice(i, i + INSERT_ROWS).map((r) => ({ ...r, fetched_at: fetchedAt })))}
        on conflict (name_key) do update
          set name = excluded.name, card_name = excluded.card_name, colors = excluded.colors, fetched_at = excluded.fetched_at`;
    }
    // Names not in this fetch are no longer in Scryfall's list.
    const gone = await tx`delete from commander_colors where name_key <> all(${tx.array(rows.map((r) => r.name_key), 1009)}::text[])`;
    return gone.count;
  });
  return { status: "stored", names: rows.length, cards, removed };
}
