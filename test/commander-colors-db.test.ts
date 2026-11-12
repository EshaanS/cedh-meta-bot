// commander_colors and commander_color_identity (migration 017) against a real Postgres with a fake Scryfall
// search. Skipped unless TEST_DATABASE_URL is set. The test files share one database and run in parallel, and
// test/pair-commanders-db.test.ts rewrites pair_commanders while it runs, so this file shadows both tables
// with temporary ones on its own connection: it never touches the real rows and never sees another file's.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";
import type { ScryfallCard, SearchResult } from "../scripts/lib/scryfall";

const url = process.env.TEST_DATABASE_URL;

describe("commander colors against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const c = (name: string, colorIdentity: string, faceNames: string[] = []): ScryfallCard =>
    ({ name, faceNames, altNames: [], typeLine: "", keywords: [], oracleText: "", colorIdentity });
  const filler = Array.from({ length: 1000 }, (_, i) => c(`Filler Commander ${i}`, "R"));
  const cards = [
    ...filler,
    c("Kinnan, Bonder Prodigy", "UG"),
    c("Kraum, Ludevic's Opus", "UR"),
    c("Tymna the Weaver", "WB"),
    c("Wernog, Rider's Chaplain", "WB"),
    c("Thrasios, Triton Hero", "UG"),
    c("Kozilek, the Great Distortion", ""),
    c("Sisay, Weatherlight Captain", "WUBRG"),
    c("Tamiyo, Inquisitive Student // Tamiyo, Seasoned Scholar", "U", ["Tamiyo, Inquisitive Student", "Tamiyo, Seasoned Scholar"]),
  ];
  const result = (list: ScryfallCard[], total = list.length): SearchResult => ({ cards: list, totalCards: total, pages: 1, complete: list.length === total });
  const store = async (list: ScryfallCard[], total?: number) => {
    const { refreshCommanderColors } = await import("../scripts/lib/commander-colors");
    return refreshCommanderColors(sql, { force: true, search: async () => result(list, total) });
  };
  const identity = async (leader: string | null) => (await sql<{ v: string | null }[]>`select commander_color_identity(${leader}) as v`)[0]!.v;
  const count = async () => Number((await sql<{ n: string }[]>`select count(*) as n from commander_colors`)[0]!.n);

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await sql`create temporary table commander_colors (like public.commander_colors including all)`;
    await sql`create temporary table pair_commanders (like public.pair_commanders including all)`;
  });

  after(async () => {
    await sql?.end();
  });

  test("an empty table: every leader is unknown, and a post gets no colors", async () => {
    const { loadCommanderColors } = await import("../scripts/lib/post");
    assert.equal(await count(), 0);
    assert.equal(await identity("Kinnan, Bonder Prodigy"), null);
    assert.deepEqual(await loadCommanderColors(sql, ["Kinnan, Bonder Prodigy", "Kraum, Ludevic's Opus / Tymna the Weaver"]), {});
    assert.deepEqual(await loadCommanderColors(sql, []), {});
  });

  test("refresh stores one row per name, in one go, and reports what it did", async () => {
    const r = await store(cards);
    assert.deepEqual(r, { status: "stored", names: cards.length + 2, cards: cards.length, removed: 0 });
    assert.equal(await count(), cards.length + 2, "the two faces of Tamiyo are names too");
    const [row] = await sql<{ name: string; card_name: string; colors: string }[]>`
      select name, card_name, colors from commander_colors where name_key = 'tamiyo, inquisitive student'`;
    assert.deepEqual({ ...row }, { name: "Tamiyo, Inquisitive Student", card_name: "Tamiyo, Inquisitive Student // Tamiyo, Seasoned Scholar", colors: "U" });
    // Only names, the color letters and a timestamp are stored.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'commander_colors' order by 1`;
    assert.deepEqual(columns.map((x) => x.column_name), ["card_name", "colors", "fetched_at", "name", "name_key"]);
  });

  test("commander_color_identity: singles, pairs as a union in WUBRG order, apostrophes, faces, colorless, unknown", async () => {
    assert.equal(await identity("Kinnan, Bonder Prodigy"), "UG");
    assert.equal(await identity("Kraum, Ludevic's Opus / Tymna the Weaver"), "WUBR");
    assert.equal(await identity("Kraum, Ludevic’s Opus / Tymna the Weaver"), "WUBR", "a typographic apostrophe matches");
    assert.equal(await identity("KINNAN, bonder prodigy"), "UG", "case is ignored");
    assert.equal(await identity("Thrasios, Triton Hero / Tymna the Weaver"), "WUBG", "letters come out in WUBRG order whatever the halves' order");
    assert.equal(await identity("Tamiyo, Inquisitive Student"), "U", "the front face of a double-faced card");
    assert.equal(await identity("Kozilek, the Great Distortion"), "", "colorless is an empty string, not unknown");
    assert.equal(await identity("Sisay, Weatherlight Captain"), "WUBRG");
    assert.equal(await identity("Not A Card"), null);
    assert.equal(await identity("Kinnan, Bonder Prodigy / Not A Card"), null, "one unknown half makes the pair unknown");
    assert.equal(await identity(""), null);
    assert.equal(await identity(null), null);
  });

  test("a printed name of a pair card is found through pair_commanders", async () => {
    assert.equal(await identity("Tymna the Weaver / Will the Wise"), null, "not known before the pair list has it");
    await sql`insert into pair_commanders (name_key, name, card_name) values ('will the wise', 'Will the Wise', 'Wernog, Rider''s Chaplain')`;
    assert.equal(await identity("Tymna the Weaver / Will the Wise"), "WB");
    assert.equal(await identity("Will the Wise"), "WB");
    // The JavaScript twin used by color-report gives the same answers.
    const { leaderColors } = await import("../scripts/lib/commander-colors");
    const rows = await sql<{ name_key: string; colors: string }[]>`select name_key, colors from commander_colors`;
    const colors = new Map(rows.map((r) => [r.name_key, r.colors]));
    const pairKeys = new Map([["will the wise", "wernog, rider's chaplain"]]);
    for (const leader of ["Kinnan, Bonder Prodigy", "Kraum, Ludevic’s Opus / Tymna the Weaver", "Thrasios, Triton Hero / Tymna the Weaver", "Kozilek, the Great Distortion",
      "Tymna the Weaver / Will the Wise", "Not A Card", "Kinnan, Bonder Prodigy / Not A Card"]) {
      assert.equal(leaderColors(leader, colors, pairKeys), await identity(leader), leader);
    }
  });

  test("loadCommanderColors returns the known commanders only, keyed as asked", async () => {
    const { loadCommanderColors } = await import("../scripts/lib/post");
    const names = ["Kraum, Ludevic’s Opus / Tymna the Weaver", "Not A Card", "Kozilek, the Great Distortion", "Kinnan, Bonder Prodigy"];
    assert.deepEqual(await loadCommanderColors(sql, names), {
      "Kraum, Ludevic’s Opus / Tymna the Weaver": "WUBR", "Kozilek, the Great Distortion": "", "Kinnan, Bonder Prodigy": "UG",
    });
  });

  test("a bad response writes nothing; a fresh list is not fetched again; a card that left the list is removed", async () => {
    const { refreshCommanderColors } = await import("../scripts/lib/commander-colors");
    const before = await count();
    await assert.rejects(store(cards, cards.length + 5), /incomplete/);
    await assert.rejects(store(cards.slice(0, 200)), /only 200 cards/);
    assert.equal(await count(), before);
    let called = 0;
    const fresh = await refreshCommanderColors(sql, { search: async () => (called++, result(cards)) });
    assert.equal(fresh.status, "fresh");
    assert.equal(called, 0, "under 24 hours old: Scryfall is not asked");
    // Kinnan leaves the list and Sisay's colors change: one row removed, one updated.
    const next = cards.filter((x) => x.name !== "Kinnan, Bonder Prodigy").map((x) => (x.name === "Sisay, Weatherlight Captain" ? { ...x, colorIdentity: "WG" } : x));
    const r = await store(next);
    assert.equal(r.status === "stored" && r.removed, 1);
    assert.equal(await identity("Kinnan, Bonder Prodigy"), null);
    assert.equal(await identity("Sisay, Weatherlight Captain"), "WG");
    // Letters out of order, or anything but WUBRG, can't be stored.
    await assert.rejects(sql`insert into commander_colors (name_key, name, card_name, colors) values ('x', 'X', 'X', 'GW')`, /commander_colors_wubrg/);
    await assert.rejects(sql`insert into commander_colors (name_key, name, card_name, colors) values ('y', 'Y', 'Y', 'C')`, /commander_colors_wubrg/);
  });
});
