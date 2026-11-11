// pair_commanders, is_valid_pair, the exclusion of invalid pairs from commander stats and apostrophe
// normalization, against a real Postgres with a fake Scryfall search. Skipped unless TEST_DATABASE_URL is set.
// The test database's pair_commanders is saved first and restored afterwards; tournaments use ids starting
// with "test-pc-" in a month far from real data (2031-04).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";
import type { ScryfallCard, SearchResult } from "../scripts/lib/scryfall";

const url = process.env.TEST_DATABASE_URL;

describe("pair commanders against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let saved: { name_key: string; name: string; card_name: string; fetched_at: Date }[] = [];
  const MONTH = "2031-04-01";
  const PLAYER = "testpcplayer".padEnd(28, "0");
  const c = (name: string, alt: string[] = []): ScryfallCard => ({ name, faceNames: [], altNames: alt, typeLine: "", keywords: [], oracleText: "" });
  const filler = Array.from({ length: 60 }, (_, i) => c(`Filler Partner ${i}`));
  const result = (cards: ScryfallCard[], total = cards.length): SearchResult => ({ cards, totalCards: total, pages: 1, complete: cards.length === total });
  const fullList = [...filler, c("Kraum, Ludevic's Opus"), c("Tymna the Weaver"), c("Wernog, Rider's Chaplain", ["Will the Wise"]), c("Wernog, Rider's Chaplain")];
  const KRAUM_TYMNA = "Kraum, Ludevic's Opus / Tymna the Weaver";
  const leaders: [string, string | null][] = [
    ["a", KRAUM_TYMNA],
    ["b", "Kraum, Ludevic’s Opus / Tymna the Weaver"], // curly apostrophe
    ["c", "Tymna the Weaver / Will the Wise"], // printed name of Wernog
    ["d", "Kinnan, Bonder Prodigy / Tymna the Weaver"], // Kinnan can't pair
    ["e", "Kinnan, Bonder Prodigy"],
    ["f", null],
    ["g", "Kraum, Ludevic's Opus / Tymna the Weaver / Wernog, Rider's Chaplain"], // three names
    ["h", "K’rrik, Son of Yawgmoth"], // single commander, curly apostrophe
    ["i", "K'rrik, Son of Yawgmoth"],
  ];
  const column = async (name: "is_valid_pair" | "leader" | "registered_leader") =>
    Object.fromEntries((await sql.unsafe(`select tid, ${name} as v from qualifying_entries where tid like 'test-pc-%' order by tid`)).map((r) => [String(r.tid).slice(8), r.v]));
  const shares = async () =>
    [...await sql<{ commander: string; entries: string }[]>`
      select commander, entries from commander_shares('global', ${MONTH}::date, 1) order by entries desc, commander`].map((r) => `${r.commander}: ${r.entries}`);
  const cleanup = async () => {
    await sql`delete from tournaments where tid like 'test-pc-%'`;
    await sql`delete from players where player_id = ${PLAYER}`;
  };
  const store = async (cards: ScryfallCard[]) => {
    const { refreshPairCommanders } = await import("../scripts/lib/pair-commanders");
    return refreshPairCommanders(sql, { force: true, search: async () => result(cards) });
  };

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    saved = [...await sql<typeof saved>`select name_key, name, card_name, fetched_at from pair_commanders`];
    await cleanup();
    await sql`insert into players (player_id, display_name) values (${PLAYER}, 'Test Pair Player')`;
    for (const [id, leader] of leaders) {
      await sql`insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class)
                values (${`test-pc-${id}`}, 'pair test', '2031-04-10T12:00:00Z', 20, 4, 'cedh')`;
      // The invalid pair (d) belongs to a player who made the cut, for the Top players check.
      await sql`insert into entries (tid, standing_index, leader, player_id, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
                values (${`test-pc-${id}`}, 0, ${leader}, ${id === "d" ? PLAYER : null}, 3, 1, 1, 0, 3, ${id === "d" ? 1 : 0}, 1, 0)`;
    }
  });
  after(async () => {
    await cleanup();
    await sql`delete from pair_commanders`;
    if (saved.length) await sql`insert into pair_commanders ${sql(saved)}`;
    await sql.end();
  });

  test("an empty list excludes nothing: validity is unknown, pairs keep their leader, apostrophes are still normalized", async () => {
    await sql`delete from pair_commanders`;
    assert.deepEqual(await column("is_valid_pair"), { a: null, b: null, c: null, d: null, e: null, f: null, g: null, h: null, i: null });
    const leader = await column("leader");
    assert.equal(leader.d, "Kinnan, Bonder Prodigy / Tymna the Weaver");
    assert.equal(leader.b, KRAUM_TYMNA);
    assert.equal(leader.h, "K'rrik, Son of Yawgmoth");
    assert.deepEqual(await column("registered_leader"), leader);
  });

  test("stores names, validates pairs on the name key, and is idempotent", async () => {
    const { refreshPairCommanders } = await import("../scripts/lib/pair-commanders");
    const queries: string[] = [];
    const search = async (q: string) => (queries.push(q), result(fullList));
    const first = await refreshPairCommanders(sql, { force: true, search });
    assert.deepEqual(first, { status: "stored", names: 64, cards: 63, printings: 64, removed: 0 });
    assert.deepEqual(queries, ["oracletag:pair-commander"]);
    assert.deepEqual(await column("is_valid_pair"), { a: true, b: true, c: true, d: false, e: null, f: null, g: false, h: null, i: null });
    const [alias] = await sql<{ name: string; card_name: string }[]>`select name, card_name from pair_commanders where name_key = 'will the wise'`;
    assert.deepEqual({ ...alias }, { name: "Will the Wise", card_name: "Wernog, Rider's Chaplain" });

    // Under 24 hours old: no fetch at all.
    const again = await refreshPairCommanders(sql, { search: async () => { throw new Error("should not fetch"); } });
    assert.equal(again.status, "fresh");
    // Forced: same rows, nothing removed.
    assert.deepEqual(await refreshPairCommanders(sql, { force: true, search }), { status: "stored", names: 64, cards: 63, printings: 64, removed: 0 });
  });

  test("leader is null for invalid pairs and apostrophes are straight; registered_leader keeps what was registered", async () => {
    await store(fullList);
    assert.deepEqual(await column("leader"), {
      a: KRAUM_TYMNA,
      b: KRAUM_TYMNA,
      c: "Tymna the Weaver / Will the Wise",
      d: null,
      e: "Kinnan, Bonder Prodigy",
      f: null,
      g: null,
      h: "K'rrik, Son of Yawgmoth",
      i: "K'rrik, Son of Yawgmoth",
    });
    assert.deepEqual(await column("registered_leader"), {
      a: KRAUM_TYMNA,
      b: KRAUM_TYMNA,
      c: "Tymna the Weaver / Will the Wise",
      d: "Kinnan, Bonder Prodigy / Tymna the Weaver",
      e: "Kinnan, Bonder Prodigy",
      f: null,
      g: "Kraum, Ludevic's Opus / Tymna the Weaver / Wernog, Rider's Chaplain",
      h: "K'rrik, Son of Yawgmoth",
      i: "K'rrik, Son of Yawgmoth",
    });
  });

  test("commander stats drop invalid pairs and merge apostrophe variants; decklist coverage and Top players use the registered deck", async () => {
    await store(fullList);
    assert.deepEqual(await shares(), [
      "K'rrik, Son of Yawgmoth: 2",
      `${KRAUM_TYMNA}: 2`,
      "Kinnan, Bonder Prodigy: 1",
      "Tymna the Weaver / Will the Wise: 1",
    ]);
    const [rep] = await sql<{ entries: string; entries_with_leader: string }[]>`select entries, entries_with_leader from region_reportability('global', ${MONTH}::date)`;
    assert.deepEqual({ ...rep }, { entries: "9", entries_with_leader: "6" }, "commander stats count 6 entries: 9 minus no leader, minus two invalid pairs");
    const [cov] = await sql<{ qualifying_entries: string; pct_entries_with_leader: number }[]>`
      select qualifying_entries, pct_entries_with_leader from stat_coverage('global', ${MONTH}::date, 1)`;
    assert.equal(cov!.qualifying_entries, "9");
    assert.equal(Number(cov!.pct_entries_with_leader).toFixed(3), ((100 * 8) / 9).toFixed(3), "8 of 9 entries registered a deck");
    const top = await sql<{ player_name: string; top_cuts: string; top_commander: string | null }[]>`
      select player_name, top_cuts, top_commander from stat_top_players('global', ${MONTH}::date, 5)`;
    assert.deepEqual([...top].map((r) => ({ ...r })), [
      { player_name: "Test Pair Player", top_cuts: "1", top_commander: "Kinnan, Bonder Prodigy / Tymna the Weaver" },
    ]);
    const cut = await sql<{ commander: string }[]>`select commander from stat_top_cut_appearances('global', ${MONTH}::date)`;
    assert.equal(cut.length, 0, "the invalid pair's top cut counts for no commander");
    // Event results read entries directly: the registered pair still shows as the winner's deck.
    const [res] = await sql<{ result: string; result_commanders: string }[]>`select result, result_commanders from tournament_results where tid = 'test-pc-d'`;
    assert.deepEqual({ ...res }, { result: "winner", result_commanders: "Kinnan, Bonder Prodigy / Tymna the Weaver" });
  });

  test("a card that left the list is removed and its pairs become invalid", async () => {
    const cards = [...filler, c("Tymna the Weaver"), c("Wernog, Rider's Chaplain", ["Will the Wise"])];
    assert.deepEqual(await store(cards), { status: "stored", names: 63, cards: 62, printings: 62, removed: 1 });
    assert.deepEqual(await column("is_valid_pair"), { a: false, b: false, c: true, d: false, e: null, f: null, g: false, h: null, i: null });
    assert.deepEqual(await shares(), ["K'rrik, Son of Yawgmoth: 2", "Kinnan, Bonder Prodigy: 1", "Tymna the Weaver / Will the Wise: 1"]);
  });

  test("an incomplete or tiny response writes nothing", async () => {
    const { refreshPairCommanders } = await import("../scripts/lib/pair-commanders");
    const count = async () => Number((await sql<{ n: string }[]>`select count(*) as n from pair_commanders`)[0]!.n);
    const before_ = await count();
    await assert.rejects(refreshPairCommanders(sql, { force: true, search: async () => result(filler, 500) }), /incomplete/);
    await assert.rejects(refreshPairCommanders(sql, { force: true, search: async () => result([c("Tymna the Weaver")]) }), /only 1 cards/);
    await assert.rejects(refreshPairCommanders(sql, { force: true, search: async () => result([]) }), /only 0 cards/);
    assert.equal(await count(), before_);
  });

  test("the SQL name key matches the script's, and normalize_leader only changes apostrophes", async () => {
    const { cardNameKey } = await import("../scripts/lib/scryfall");
    for (const name of ["Kraum, Ludevic’s Opus", "  Tymna the Weaver ", "Fang, Fearless lʼCie", "A`B´C‘D"]) {
      const [r] = await sql<{ k: string }[]>`select card_name_key(${name}) as k`;
      assert.equal(r!.k, cardNameKey(name), name);
    }
    const [n] = await sql<{ a: string; b: string; c: string | null }[]>`
      select normalize_leader(${"Kraum, Ludevic’s Opus / Tymna the Weaver"}) as a, normalize_leader(${"  Lim-Dûl‘s  Vault "}) as b, normalize_leader(null) as c`;
    assert.deepEqual({ ...n }, { a: KRAUM_TYMNA, b: "  Lim-Dûl's  Vault ", c: null });
  });
});
