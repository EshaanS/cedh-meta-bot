// Official standings: pure parsing (no DB), and the idempotent fetch loop against Postgres when
// TEST_DATABASE_URL is set (fake fetcher, test rows cleaned up).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";
import { pickStandingOne } from "../scripts/lib/topdeck";

test("pickStandingOne returns only the standing-1 commander", () => {
  const rows = [
    { name: "Player Two", id: "p2", standing: 2, leader: "Kinnan, Bonder Prodigy", decklist: "secret" },
    { name: "Player One", id: "p1", standing: 1, leader: "Kraum, Ludevic's Opus / Tymna the Weaver", decklist: "secret" },
  ];
  const one = pickStandingOne(rows);
  assert.deepEqual(one, { status: "found", leader: "Kraum, Ludevic's Opus / Tymna the Weaver" });
  assert.deepEqual(Object.keys(one).sort(), ["leader", "status"]);
});

test("pickStandingOne: no standing 1, no commander, string standings, junk input", () => {
  assert.deepEqual(pickStandingOne([{ standing: 2, leader: "X" }]), { status: "no_standing_1", leader: null });
  assert.deepEqual(pickStandingOne([{ standing: 1, leader: "  " }]), { status: "no_commander", leader: null });
  assert.deepEqual(pickStandingOne([{ standing: "1", leader: "Kinnan, Bonder Prodigy" }]), { status: "found", leader: "Kinnan, Bonder Prodigy" });
  assert.deepEqual(pickStandingOne({ error: "nope" }), { status: "no_standing_1", leader: null });
});

const url = process.env.TEST_DATABASE_URL;
describe("fetchMissingStandings against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const tids = ["test-std-found", "test-std-nocommander", "test-std-error", "test-std-hascut"];
  const cleanup = async () => {
    await sql`delete from event_winners where tid = any(${sql.array(tids, 1009)}::text[])`;
    await sql`delete from tournaments where tid = any(${sql.array(tids, 1009)}::text[])`;
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
  });
  after(async () => {
    await cleanup();
    await sql.end();
  });

  test("stores found / no_commander, retries errors, skips events with a recorded cut, never refetches", async () => {
    const { fetchMissingStandings } = await import("../scripts/lib/standings");
    const calls: string[] = [];
    const fetcher = async (tid: string) => {
      calls.push(tid);
      if (tid === "test-std-error") throw new Error("HTTP 500");
      if (tid === "test-std-found") return { status: "found" as const, leader: "Sisay, Weatherlight Captain" };
      if (tid.startsWith("test-std-")) return { status: "no_commander" as const, leader: null };
      throw new Error(`unexpected fetch for a non-test event: ${tid}`);
    };
    // Only test rows are candidates if every other event already has an event_winners row; skip others.
    const onlyTest = async (tid: string) => (tid.startsWith("test-std-") ? fetcher(tid) : { status: "no_standing_1" as const, leader: null });
    const preexisting = (await sql<{ tid: string }[]>`select tid from event_winners`).map((r) => r.tid);
    await fetchMissingStandings(sql, onlyTest, { pauseMs: 0 });
    const rows = await sql<{ tid: string; status: string; winner_commander: string | null }[]>`
      select tid, status, winner_commander from event_winners where tid = any(${sql.array(tids, 1009)}::text[]) order by tid`;
    assert.deepEqual([...rows].map((r) => ({ ...r })), [
      { tid: "test-std-found", status: "found", winner_commander: "Sisay, Weatherlight Captain" },
      { tid: "test-std-nocommander", status: "no_commander", winner_commander: null },
    ]);
    assert.ok(!calls.includes("test-std-hascut"), "events with a recorded cut are not fetched");

    calls.length = 0;
    await fetchMissingStandings(sql, onlyTest, { pauseMs: 0 });
    assert.deepEqual(calls, ["test-std-error"], "only the failed event is retried");
    // remove any non-test rows this test created
    await sql`delete from event_winners where tid <> all(${sql.array([...preexisting, ...tids], 1009)}::text[])`;
  });
});
