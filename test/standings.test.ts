// Official standings: pure parsing (no DB), and the idempotent fetch loop against Postgres when
// TEST_DATABASE_URL is set (fake fetcher, test rows cleaned up).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";
import { pickStandingOne, playerId, playerName, type StandingOne } from "../scripts/lib/topdeck";

// TopDeck account ids are 28 characters; shorter ids are per-event guest ids and are not kept.
const P1 = "acct100000000000000000000000";
const P2 = "acct200000000000000000000000";
const P9 = "acct900000000000000000000000";
const GUEST = "gggggggggggggggggggg";

test("pickStandingOne returns only the standing-1 commander and player", () => {
  const rows = [
    { name: "Player Two", id: P2, standing: 2, leader: "Kinnan, Bonder Prodigy", decklist: "secret" },
    { name: "Player One", id: P1, standing: 1, leader: "Kraum, Ludevic's Opus / Tymna the Weaver", decklist: "secret", deckObj: { a: 1 }, discord: "x" },
  ];
  const one = pickStandingOne(rows);
  assert.deepEqual(one, { status: "found", leader: "Kraum, Ludevic's Opus / Tymna the Weaver", playerId: P1, playerName: "Player One" });
  assert.deepEqual(Object.keys(one).sort(), ["leader", "playerId", "playerName", "status"]);
  assert.doesNotMatch(JSON.stringify(one), /secret|Player Two|acct2/);
});

test("pickStandingOne: no standing 1, no commander, string standings, removed players, junk input", () => {
  const none = { playerId: null, playerName: null };
  assert.deepEqual(pickStandingOne([{ standing: 2, leader: "X", id: P2, name: "Two" }]), { status: "no_standing_1", leader: null, ...none });
  assert.deepEqual(pickStandingOne([{ standing: 1, leader: "  ", id: P1, name: "One" }]), { status: "no_commander", leader: null, playerId: P1, playerName: "One" });
  assert.deepEqual(pickStandingOne([{ standing: "1", leader: "Kinnan, Bonder Prodigy" }]), { status: "found", leader: "Kinnan, Bonder Prodigy", ...none });
  assert.deepEqual(pickStandingOne([{ standing: 1, leader: "Kinnan, Bonder Prodigy", id: P9, name: "Deleted User" }]),
    { status: "found", leader: "Kinnan, Bonder Prodigy", playerId: P9, playerName: null });
  // A per-event guest id is not an account: neither the id nor the name is kept.
  assert.deepEqual(pickStandingOne([{ standing: 1, leader: "Kinnan, Bonder Prodigy", id: GUEST, name: "Guest" }]), { status: "found", leader: "Kinnan, Bonder Prodigy", ...none });
  // A name without an id is not kept: there is nothing to key an opt-out on.
  assert.deepEqual(pickStandingOne([{ standing: 1, leader: "Kinnan, Bonder Prodigy", name: "No Id" }]), { status: "found", leader: "Kinnan, Bonder Prodigy", ...none });
  assert.deepEqual(pickStandingOne({ error: "nope" }), { status: "no_standing_1", leader: null, ...none });
});

test("playerId keeps 28-character account ids only; playerName drops blanks and Deleted User", () => {
  assert.equal(playerId(` ${P1} `), P1);
  assert.equal(playerId(GUEST), null);
  assert.equal(playerId("abc"), null);
  assert.equal(playerId(123), null);
  assert.equal(playerId(""), null);
  assert.equal(playerId(null), null);
  assert.equal(playerName(" Mara Ellison "), "Mara Ellison");
  assert.equal(playerName("Deleted User"), null);
  assert.equal(playerName("deleted user"), null);
  assert.equal(playerName("  "), null);
  assert.equal(playerName(undefined), null);
});

const url = process.env.TEST_DATABASE_URL;
describe("fetchMissingStandings against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const tids = ["test-std-found", "test-std-nocommander", "test-std-error", "test-std-hascut", "test-std-old", "test-std-optout"];
  const players = ["teststdp10000000000000000000", "teststdp20000000000000000000", "teststdp30000000000000000000"];
  const cleanup = async () => {
    await sql`delete from event_winners where tid = any(${sql.array(tids, 1009)}::text[])`;
    await sql`delete from tournaments where tid = any(${sql.array(tids, 1009)}::text[])`;
    await sql`delete from player_optouts where player_id = any(${sql.array(players, 1009)}::text[])`;
    await sql`delete from players where player_id = any(${sql.array(players, 1009)}::text[])`;
  };
  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await cleanup();
    for (const tid of tids) {
      await sql`insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class)
                values (${tid}, ${tid}, '2026-10-15T12:00:00Z', 40, ${tid === "test-std-hascut" ? 16 : 0}, 'cedh')`;
    }
    // A row fetched before player ids were stored: no player_checked_at.
    await sql`insert into event_winners (tid, winner_commander, status) values ('test-std-old', 'Sisay, Weatherlight Captain', 'found')`;
    await sql`insert into player_optouts (player_id, note) values ('teststdp30000000000000000000', 'test')`;
  });
  after(async () => {
    await cleanup();
    await sql.end();
  });

  test("stores winners and players, retries errors, skips recorded cuts, re-fetches old rows once, keeps opted-out names blank", async () => {
    const { fetchMissingStandings } = await import("../scripts/lib/standings");
    const calls: string[] = [];
    const fetcher = async (tid: string): Promise<StandingOne> => {
      calls.push(tid);
      if (tid === "test-std-error") throw new Error("HTTP 500");
      if (tid === "test-std-found") return { status: "found", leader: "Sisay, Weatherlight Captain", playerId: "teststdp10000000000000000000", playerName: "Test Winner One" };
      if (tid === "test-std-old") return { status: "found", leader: "Sisay, Weatherlight Captain", playerId: "teststdp20000000000000000000", playerName: "Test Winner Two" };
      if (tid === "test-std-optout") return { status: "found", leader: "Kinnan, Bonder Prodigy", playerId: "teststdp30000000000000000000", playerName: "Test Opted Out" };
      return { status: "no_commander", leader: null, playerId: null, playerName: null };
    };
    await fetchMissingStandings(sql, fetcher, { pauseMs: 0, tids });
    const rows = await sql<{ tid: string; status: string; winner_commander: string | null; winner_player_id: string | null; checked: boolean }[]>`
      select tid, status, winner_commander, winner_player_id, player_checked_at is not null as checked
      from event_winners where tid = any(${sql.array(tids, 1009)}::text[]) order by tid`;
    assert.deepEqual([...rows].map((r) => ({ ...r })), [
      { tid: "test-std-found", status: "found", winner_commander: "Sisay, Weatherlight Captain", winner_player_id: "teststdp10000000000000000000", checked: true },
      { tid: "test-std-nocommander", status: "no_commander", winner_commander: null, winner_player_id: null, checked: true },
      { tid: "test-std-old", status: "found", winner_commander: "Sisay, Weatherlight Captain", winner_player_id: "teststdp20000000000000000000", checked: true },
      { tid: "test-std-optout", status: "found", winner_commander: "Kinnan, Bonder Prodigy", winner_player_id: "teststdp30000000000000000000", checked: true },
    ]);
    assert.ok(!calls.includes("test-std-hascut"), "events with a recorded cut are not fetched");
    assert.ok(calls.includes("test-std-old"), "a row without player_checked_at is fetched once more");

    const stored = await sql<{ player_id: string; display_name: string | null }[]>`
      select player_id, display_name from players where player_id = any(${sql.array(players, 1009)}::text[]) order by player_id`;
    assert.deepEqual([...stored].map((r) => ({ ...r })), [
      { player_id: "teststdp10000000000000000000", display_name: "Test Winner One" },
      { player_id: "teststdp20000000000000000000", display_name: "Test Winner Two" },
      { player_id: "teststdp30000000000000000000", display_name: null },
    ]);

    calls.length = 0;
    await fetchMissingStandings(sql, fetcher, { pauseMs: 0, tids });
    assert.deepEqual(calls, ["test-std-error"], "only the failed event is retried");
  });
});
