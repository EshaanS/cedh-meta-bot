// Scryfall pair-commander list: parsing, paging and name handling (no network, no database).
import assert from "node:assert/strict";
import { test } from "node:test";
import { pairNames } from "../scripts/lib/pair-commanders";
import { cardNameKey, leaderNames, oracleNames, parseSearchPage, searchCards } from "../scripts/lib/scryfall";

const card = (over: Record<string, unknown>) => ({
  object: "card", name: "Tymna the Weaver", type_line: "Legendary Creature — Human Cleric", keywords: ["Partner", "Lifelink"],
  oracle_text: "Lifelink\nPartner", prices: { usd: "30.00" }, artist: "Someone", image_uris: { normal: "https://example.invalid/x.jpg" }, ...over,
});
const page = (data: unknown[], more: string | null = null, total = data.length) => ({
  object: "list", total_cards: total, has_more: more !== null, ...(more ? { next_page: more } : {}), data,
});

test("parseSearchPage keeps only the whitelisted card fields", () => {
  const p = parseSearchPage(page([card({}), { object: "card" }, "junk"]));
  assert.equal(p.cards.length, 1, "rows without a name are dropped");
  assert.deepEqual(Object.keys(p.cards[0]!).sort(), ["altNames", "faceNames", "keywords", "name", "oracleText", "typeLine"]);
  assert.doesNotMatch(JSON.stringify(p), /usd|artist|image/);
  assert.equal(p.totalCards, 3);
  assert.equal(p.nextPage, null);
});

test("parseSearchPage: no matches is an empty page; other errors and malformed pages throw", () => {
  assert.deepEqual(parseSearchPage({ object: "error", code: "not_found", status: 404, details: "none" }), { cards: [], totalCards: 0, nextPage: null });
  assert.throws(() => parseSearchPage({ object: "error", code: "bad_request", details: "nope" }), /bad_request/);
  assert.throws(() => parseSearchPage({ object: "list", has_more: true, data: [] }), /next_page/);
  assert.throws(() => parseSearchPage([]), /not an object|expected a list/);
});

test("names: Oracle name, faces of a 'Front // Back' card, printed and flavor names", () => {
  const p = parseSearchPage(page([
    card({ name: "Wernog, Rider's Chaplain", printed_name: "Will the Wise" }),
    card({ name: "Tymna the Weaver", flavor_name: "Cecil Harvey" }),
    card({ name: "Krark, the Thumbless // Krark, the Thumbless", card_faces: [{ name: "Krark, the Thumbless" }, { name: "Krark, the Thumbless" }] }),
    card({ name: "Front Half // Back Half", card_faces: [{ name: "Front Half", flavor_name: "Other Front" }, { name: "Back Half" }] }),
  ]));
  assert.deepEqual(leaderNames(p.cards[0]!), ["Wernog, Rider's Chaplain", "Will the Wise"]);
  assert.deepEqual(oracleNames(p.cards[0]!), ["Wernog, Rider's Chaplain"]);
  assert.deepEqual(leaderNames(p.cards[1]!), ["Tymna the Weaver", "Cecil Harvey"]);
  assert.deepEqual(leaderNames(p.cards[2]!), ["Krark, the Thumbless // Krark, the Thumbless", "Krark, the Thumbless"]);
  assert.deepEqual(leaderNames(p.cards[3]!), ["Front Half // Back Half", "Front Half", "Back Half", "Other Front"]);
});

test("cardNameKey: straight apostrophes and lower case, nothing else", () => {
  assert.equal(cardNameKey("Kraum, Ludevic’s Opus"), "kraum, ludevic's opus");
  assert.equal(cardNameKey("Kraum, Ludevic's Opus"), "kraum, ludevic's opus");
  assert.equal(cardNameKey("  Tymna the Weaver "), "tymna the weaver");
  assert.notEqual(cardNameKey("Lim-Dûl's Vault"), cardNameKey("Lim-Dul's Vault"));
});

test("pairNames: one row per key, and a card's own name wins over another card's printed name", () => {
  const p = parseSearchPage(page([
    card({ name: "Wernog, Rider's Chaplain", printed_name: "Will the Wise" }),
    card({ name: "Wernog, Rider's Chaplain" }),
    card({ name: "Some Card", flavor_name: "Tymna the Weaver" }),
    card({ name: "Tymna the Weaver" }),
  ]));
  assert.deepEqual(pairNames(p.cards), [
    { name_key: "some card", name: "Some Card", card_name: "Some Card" },
    { name_key: "tymna the weaver", name: "Tymna the Weaver", card_name: "Tymna the Weaver" },
    { name_key: "wernog, rider's chaplain", name: "Wernog, Rider's Chaplain", card_name: "Wernog, Rider's Chaplain" },
    { name_key: "will the wise", name: "Will the Wise", card_name: "Wernog, Rider's Chaplain" },
  ]);
});

test("searchCards follows next_page, asks for printings when told to, and reports completeness", async () => {
  const urls: string[] = [];
  const pages: Record<string, unknown> = {
    first: page([card({ name: "A" }), card({ name: "B" })], "https://api.scryfall.com/cards/search?page=2", 3),
    "https://api.scryfall.com/cards/search?page=2": page([card({ name: "C" })], null, 3),
  };
  const fetcher = async (url: string) => {
    urls.push(url);
    return pages[urls.length === 1 ? "first" : url];
  };
  const r = await searchCards("oracletag:pair-commander", { fetcher, pauseMs: 0, unique: "prints" });
  assert.deepEqual(r.cards.map((c) => c.name), ["A", "B", "C"]);
  assert.deepEqual({ pages: r.pages, total: r.totalCards, complete: r.complete }, { pages: 2, total: 3, complete: true });
  assert.equal(urls[0], "https://api.scryfall.com/cards/search?q=oracletag%3Apair-commander&unique=prints");
  assert.equal(urls[1], "https://api.scryfall.com/cards/search?page=2");

  const short = await searchCards("x", { fetcher: async () => page([card({ name: "A" })], null, 5), pauseMs: 0 });
  assert.equal(short.complete, false, "fewer rows than total_cards is not complete");
  const none = await searchCards("x", { fetcher: async () => ({ object: "error", code: "not_found" }), pauseMs: 0 });
  assert.deepEqual({ n: none.cards.length, complete: none.complete }, { n: 0, complete: true });
});
