// Player stats and the opt-out list against a real Postgres. Skipped unless TEST_DATABASE_URL is set.
// Uses event ids starting with "test-pl-" and 28-character player ids starting with "testpl", in a month far
// from real data (2031-03), and removes them afterwards.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe("player stats and opt-outs against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const MONTH = "2031-03-01";
  const pid = (name: string) => `testpl${name.toLowerCase()}`.padEnd(28, "0");
  const cleanup = async () => {
    await sql`delete from tournaments where tid like 'test-pl-%'`; // entries and event_winners cascade
    await sql`delete from player_optouts where player_id like 'testpl%'`;
    await sql`delete from players where player_id like 'testpl%'`;
  };
  const event = (tid: string, date: string, players: number, topCut: number) =>
    sql`insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class)
        values (${tid}, ${`Event ${tid}`}, ${date}, ${players}, ${topCut}, 'cedh')`;
  const entry = (tid: string, index: number, player: string | null, leader: string | null, winsBracket: number, lossesBracket: number) =>
    sql`insert into entries (tid, standing_index, leader, player_id, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
        values (${tid}, ${index}, ${leader}, ${player}, ${3 + winsBracket}, 1, ${1 + lossesBracket}, 0, 3, ${winsBracket}, 1, ${lossesBracket})`;

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await cleanup();
    await sql`insert into players (player_id, display_name) values
      ('testplone0000000000000000000', 'Test Player One'), ('testpltwo0000000000000000000', 'Test Player Two'), ('testplthree00000000000000000', 'Test Player Three'),
      ('testplgone000000000000000000', null), ('testplvet0000000000000000000', 'Test Veteran')`;
    for (const n of ["Four", "Five", "Six", "Seven", "Eight", "Nine"]) {
      await sql`insert into players (player_id, display_name) values (${pid(n)}, ${`Test Player ${n}`})`;
    }
    // The stored name is left in place on purpose: the view alone must hide an opted-out player.
    await sql`insert into player_optouts (player_id, note) values ('testpltwo0000000000000000000', 'test')`;

    // History before the month: the veteran already has a win and six events; player three has five events.
    for (let i = 0; i < 6; i++) {
      await event(`test-pl-h${i}`, `2031-01-${String(10 + i).padStart(2, "0")}T12:00:00Z`, 20, 4);
      await entry(`test-pl-h${i}`, 0, "testplvet0000000000000000000", "Sisay, Weatherlight Captain", 2, 0);
      if (i < 5) await entry(`test-pl-h${i}`, 1, "testplthree00000000000000000", null, 0, 0);
    }

    // A: one wins; two (opted out) and the veteran also cut.
    await event("test-pl-a", "2031-03-10T12:00:00Z", 40, 4);
    await entry("test-pl-a", 0, "testplone0000000000000000000", "Kinnan, Bonder Prodigy", 2, 0);
    await entry("test-pl-a", 1, "testpltwo0000000000000000000", "Kinnan, Bonder Prodigy", 1, 1);
    await entry("test-pl-a", 2, "testplvet0000000000000000000", "Sisay, Weatherlight Captain", 0, 1);
    await entry("test-pl-a", 3, "testplthree00000000000000000", null, 0, 0);
    // The same player on a second standings row of the same event: must not count as a second top cut.
    await entry("test-pl-a", 4, "testplone0000000000000000000", "Kinnan, Bonder Prodigy", 1, 0);
    // B: two (opted out) wins; one cuts again; three's first cut comes in their 7th event.
    await event("test-pl-b", "2031-03-20T12:00:00Z", 36, 4);
    await entry("test-pl-b", 0, "testpltwo0000000000000000000", "Kinnan, Bonder Prodigy", 2, 0);
    await entry("test-pl-b", 1, "testplone0000000000000000000", "Kinnan, Bonder Prodigy", 0, 1);
    await entry("test-pl-b", 2, "testplthree00000000000000000", "Tivit, Seller of Secrets", 0, 1);
    // C: no recorded bracket; the official winner is a removed player (no name).
    await event("test-pl-c", "2031-03-25T12:00:00Z", 33, 0);
    await entry("test-pl-c", 0, "testplgone000000000000000000", "Tivit, Seller of Secrets", 0, 0);
    await entry("test-pl-c", 1, null, null, 0, 0); // a player without an account
    // D: four first-timers in one event. Four wins; Five and Six make their first top cut; Seven misses it.
    await event("test-pl-d", "2031-03-27T12:00:00Z", 30, 4);
    await entry("test-pl-d", 0, pid("Four"), null, 2, 0);
    await entry("test-pl-d", 1, pid("Five"), null, 1, 1);
    await entry("test-pl-d", 2, pid("Six"), null, 0, 1);
    await entry("test-pl-d", 3, pid("Seven"), null, 0, 0);
    // E: two first top cuts and no winner. Nine won a bracket game, Eight didn't.
    await event("test-pl-e", "2031-03-28T12:00:00Z", 28, 4);
    await entry("test-pl-e", 0, pid("Eight"), null, 0, 1);
    await entry("test-pl-e", 1, pid("Nine"), null, 1, 1);
    await sql`insert into event_winners (tid, winner_commander, status, winner_player_id, player_checked_at)
              values ('test-pl-c', 'Tivit, Seller of Secrets', 'found', 'testplgone000000000000000000', now())`;
  });
  after(async () => {
    await cleanup();
    await sql.end();
  });

  test("winners: a named winner, an opted-out winner (hidden, no name) and a removed winner (no name)", async () => {
    const rows = await sql<{ tid: string; result: string; winner_name: string | null; winner_hidden: boolean }[]>`
      select tid, result, winner_name, winner_hidden from stat_month_results('global', ${MONTH}::date, 10)`;
    assert.deepEqual([...rows].map((r) => ({ ...r })), [
      { tid: "test-pl-a", result: "winner", winner_name: "Test Player One", winner_hidden: false },
      { tid: "test-pl-b", result: "winner", winner_name: null, winner_hidden: true },
      { tid: "test-pl-c", result: "winner", winner_name: null, winner_hidden: false },
    ]);
  });

  test("top players: ordered by wins then top cuts, one count per event; opted-out and removed players are absent", async () => {
    const rows = await sql<{ player_name: string; wins: string; top_cuts: string; largest_event: number; top_commander: string | null }[]>`
      select * from stat_top_players('global', ${MONTH}::date, 10)`;
    assert.deepEqual([...rows].map((r) => ({ ...r, wins: Number(r.wins), top_cuts: Number(r.top_cuts) })), [
      { player_name: "Test Player One", wins: 1, top_cuts: 2, largest_event: 40, top_commander: "Kinnan, Bonder Prodigy" },
      { player_name: "Test Player Four", wins: 1, top_cuts: 1, largest_event: 30, top_commander: null },
      { player_name: "Test Veteran", wins: 0, top_cuts: 1, largest_event: 40, top_commander: "Sisay, Weatherlight Captain" },
      { player_name: "Test Player Three", wins: 0, top_cuts: 1, largest_event: 36, top_commander: "Tivit, Seller of Secrets" },
      { player_name: "Test Player Five", wins: 0, top_cuts: 1, largest_event: 30, top_commander: null },
      { player_name: "Test Player Six", wins: 0, top_cuts: 1, largest_event: 30, top_commander: null },
      { player_name: "Test Player Eight", wins: 0, top_cuts: 1, largest_event: 28, top_commander: null },
      { player_name: "Test Player Nine", wins: 0, top_cuts: 1, largest_event: 28, top_commander: null },
    ]);
  });

  test("rising players: one per event, largest event first; a veteran and an opted-out player don't qualify", async () => {
    const rows = await sql<{ player_name: string; reason: string; event_name: string; participant_count: number }[]>`
      select * from stat_rising_players('global', ${MONTH}::date, 10)`;
    // Seven visible players qualify (One, Three, Four, Five, Six, Eight, Nine) in four events: four lines.
    assert.deepEqual([...rows].map((r) => ({ ...r })), [
      { player_name: "Test Player One", reason: "first win", event_name: "Event test-pl-a", participant_count: 40 },
      // B: the opted-out winner (Two) doesn't take the event's line; Three's first top cut shows.
      { player_name: "Test Player Three", reason: "first top cut", event_name: "Event test-pl-b", participant_count: 36 },
      // D: the first win beats the two first top cuts.
      { player_name: "Test Player Four", reason: "first win", event_name: "Event test-pl-d", participant_count: 30 },
      // E: same reason for both, so the one with more bracket wins (Nine), not the first by name (Eight).
      { player_name: "Test Player Nine", reason: "first top cut", event_name: "Event test-pl-e", participant_count: 28 },
    ]);
    const top3 = await sql<{ player_name: string }[]>`select player_name from stat_rising_players('global', ${MONTH}::date, 3)`;
    assert.deepEqual(top3.map((r) => r.player_name), ["Test Player One", "Test Player Three", "Test Player Four"]);
  });

  test("player coverage: share of the month's qualifying entries with an account id", async () => {
    const [r] = await sql<{ month_entries: string; entries_with_player: string; pct_entries_with_player: number }[]>`
      select * from stat_player_coverage('global', ${MONTH}::date)`;
    assert.deepEqual({ ...r, month_entries: Number(r!.month_entries), entries_with_player: Number(r!.entries_with_player) },
      { month_entries: 16, entries_with_player: 15, pct_entries_with_player: 93.75 });
  });

  test("removing the opt-out shows the player again", async () => {
    await sql`delete from player_optouts where player_id = 'testpltwo0000000000000000000'`;
    try {
      const [b] = await sql<{ winner_name: string | null; winner_hidden: boolean }[]>`
        select winner_name, winner_hidden from stat_month_results('global', ${MONTH}::date, 10) where tid = 'test-pl-b'`;
      assert.deepEqual({ ...b }, { winner_name: "Test Player Two", winner_hidden: false });
      const top = await sql<{ player_name: string }[]>`select player_name from stat_top_players('global', ${MONTH}::date, 10)`;
      assert.ok(top.some((p) => p.player_name === "Test Player Two"));
    } finally {
      await sql`insert into player_optouts (player_id, note) values ('testpltwo0000000000000000000', 'test')`;
    }
  });
});
