// Fills pair_commanders from Scryfall's pair-commander list. The fetch and the write are separate so tests can
// inject a fake search. Only names are stored.
import type { Sql } from "./db";
import { cardNameKey, leaderNames, PAIR_QUERY, searchCards, type ScryfallCard, type SearchResult } from "./scryfall";

/** Below this many cards the response is treated as wrong and nothing is written (the tag has 228 cards). */
export const MIN_PAIR_CARDS = 50;
const FRESH_HOURS = 24;

export type PairName = { name_key: string; name: string; card_name: string };

/** One row per distinct name key. A card's own Oracle name wins over another card's printed name for the same key. */
export function pairNames(cards: ScryfallCard[]): PairName[] {
  const byKey = new Map<string, PairName>();
  const add = (name: string, cardName: string, replace: boolean) => {
    const key = cardNameKey(name);
    if (key && (replace || !byKey.has(key))) byKey.set(key, { name_key: key, name, card_name: cardName });
  };
  for (const c of cards) for (const n of leaderNames(c)) add(n, c.name, false);
  for (const c of cards) add(c.name, c.name, true);
  return [...byKey.values()].sort((a, b) => a.name_key.localeCompare(b.name_key));
}

export type PairRefresh =
  | { status: "fresh"; names: number; fetchedAt: Date }
  | { status: "stored"; names: number; cards: number; printings: number; removed: number };

/**
 * Replaces pair_commanders with the current list, in one transaction. Skips the fetch when the stored list is
 * under 24 hours old (unless `force`). Throws, writing nothing, when the search is incomplete or implausibly
 * small, so a bad response can never empty the table.
 */
export async function refreshPairCommanders(
  sql: Sql,
  opts: { force?: boolean; search?: (query: string) => Promise<SearchResult> } = {},
): Promise<PairRefresh> {
  const [stored] = await sql<{ n: string; newest: Date | null }[]>`select count(*) as n, max(fetched_at) as newest from pair_commanders`;
  if (!opts.force && stored?.newest && Date.now() - stored.newest.getTime() < FRESH_HOURS * 3_600_000) {
    return { status: "fresh", names: Number(stored.n), fetchedAt: stored.newest };
  }
  // One row per printing, because alternate names (printed_name, flavor_name) belong to printings.
  const search = opts.search ?? ((q: string) => searchCards(q, { unique: "prints" }));
  const result = await search(PAIR_QUERY);
  const cards = new Set(result.cards.map((c) => c.name)).size;
  if (!result.complete) throw new Error(`Scryfall list incomplete: read ${result.cards.length} of ${result.totalCards}; nothing written`);
  if (cards < MIN_PAIR_CARDS) throw new Error(`Scryfall list has only ${cards} cards (expected at least ${MIN_PAIR_CARDS}); nothing written`);

  const rows = pairNames(result.cards);
  const removed = await sql.begin(async (tx) => {
    await tx`
      insert into pair_commanders ${tx(rows.map((r) => ({ ...r, fetched_at: new Date() })))}
      on conflict (name_key) do update set name = excluded.name, card_name = excluded.card_name, fetched_at = excluded.fetched_at`;
    // A card can lose the tag; names not in this fetch are no longer valid halves.
    const gone = await tx`delete from pair_commanders where name_key <> all(${tx.array(rows.map((r) => r.name_key), 1009)}::text[])`;
    return gone.count;
  });
  return { status: "stored", names: rows.length, cards, printings: result.cards.length, removed };
}
