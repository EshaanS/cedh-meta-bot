// The monthly post against a real Postgres: every stat is the report month only, ties are broken before lists
// are cut, a month without events is one line, and the 6-month stat calls that `npm run report` makes return
// what they did. Skipped unless TEST_DATABASE_URL is set. The test files share one database and run in
// parallel: this one uses tournament ids starting with "test-mo-", commanders named "Mo …", and its own
// months (2038-07 to 2038-10), and it creates no servers or regions.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe("monthly post against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const AUGUST = "2038-08";
  const cleanup = () => sql`delete from tournaments where tid like 'test-mo-%'`;
  /** `count` entries of one commander in an event, the first `cut` of them with bracket games. */
  const entries = (tid: string, from: number, leader: string, count: number, cut = 0) => sql`
    insert into entries (tid, standing_index, leader, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
    select ${tid}, ${from}::int + g, ${leader}, 3, 1, 1, 0, 3, case when g < ${cut}::int then 1 else 0 end, 1, 0
    from generate_series(0, ${count}::int - 1) g`;

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await cleanup();
    await sql`
      insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class) values
        ('test-mo-august', 'Mo August Open', '2038-08-14T12:00:00Z', 52, 4, 'cedh'),
        ('test-mo-july', 'Mo July Open', '2038-07-10T12:00:00Z', 50, 4, 'cedh'),
        ('test-mo-casual', 'Mo August Precon Night', '2038-08-20T12:00:00Z', 60, 0, 'casual')`;
    // August: two commanders at 12 entries (the one with more top cuts ranks first), one at 6, and 22 played
    // once. "Mo Single 00" played once and made the cut.
    await entries("test-mo-august", 0, "Mo Alpha", 12, 2);
    await entries("test-mo-august", 12, "Mo Beta", 12, 1);
    await entries("test-mo-august", 24, "Mo Gamma", 6, 1);
    for (let i = 0; i < 22; i++) await entries("test-mo-august", 30 + i, `Mo Single ${String(i).padStart(2, "0")}`, 1, i === 0 ? 1 : 0);
    // July: a commander that only exists there, and most of Mo Gamma's entries.
    await entries("test-mo-july", 0, "Mo July Only", 30, 3);
    await entries("test-mo-july", 30, "Mo Gamma", 20, 1);
    // A casual event in August: the event filter (deviation 1) keeps it out of every number.
    await entries("test-mo-casual", 0, "Mo Casual", 60);
  });

  after(async () => {
    if (!sql) return;
    await cleanup();
    await sql.end();
  });

  test("every stat is the report month only: July's entries count for nothing but the trend", async () => {
    const { loadPostData, composePost } = await import("../scripts/lib/post");
    const data = await loadPostData(sql, "global", AUGUST);
    assert.deepEqual(data.region, { id: "global", label: "Global" });
    assert.equal(data.scene.events, 1);
    assert.equal(data.scene.players, 52);
    assert.equal(data.coverage.qualifyingEvents, 1, "the month's events, not six months'");
    assert.equal(data.coverage.pctEntriesWithLeader, 100);
    const commanders = [...data.metaShare, ...data.ppg, ...data.conversion, ...data.topCutAppearances].map((x) => x.commander);
    assert.ok(!commanders.includes("Mo July Only") && !commanders.includes("Mo Casual"), "nothing from July, nothing from the casual event");
    assert.deepEqual(data.metaShare.slice(0, 3), [
      { commander: "Mo Alpha", entries: 12, metaShare: 12 / 52, topCuts: 2 },
      { commander: "Mo Beta", entries: 12, metaShare: 12 / 52, topCuts: 1 },
      { commander: "Mo Gamma", entries: 6, metaShare: 6 / 52, topCuts: 1 },
    ]);
    // Mo Gamma has 26 entries over six months and 6 in August: under the functions' floor of 10 for the month.
    assert.deepEqual(data.ppg.map((p) => [p.commander, p.entries]), [["Mo Alpha", 12], ["Mo Beta", 12]]);
    assert.deepEqual(data.conversion.map((x) => [x.commander, x.topCutEntries, x.entriesInCutEvents]).sort(), [["Mo Alpha", 2, 12], ["Mo Beta", 1, 12]]);
    assert.equal(data.baselineConversion, 5 / 52);
    // The trend still looks back: that is what it is for.
    const gamma = data.trend.find((t) => t.commander === "Mo Gamma")!;
    assert.deepEqual([gamma.lastMonthEntries, Math.round(gamma.prior3AvgEntries * 3)], [6, 20]);

    const { text, embeds } = composePost(data);
    assert.doesNotMatch(text, /Mo July Only|Mo Casual|6 months|Showing |Commander stats/);
    assert.match(text, /\nℹ️ Coverage: 1 qualifying event in August · 100% of entries with decklists · 0% of entries have a linked player\n/);
    assert.match(text, /\n⭐ Best results \(adjusted PPG, 10\+ entries\)\n🥇 Mo Alpha\n[\d.]+ · 12 entries\n\n🥈 Mo Beta\n[\d.]+ · 12 entries\n\n🔀 /);
    // No player ids in this test: the people embed holds Winners alone, with the August event and not the
    // larger casual one.
    assert.equal(embeds.length, 4);
    assert.deepEqual(embeds[1]!.fields.map((f) => f.name), ["🏆 Winners (largest events)"]);
    assert.match(embeds[1]!.fields[0]!.value, /^\*\*Mo August Open\*\* · 52 players\n/);
    assert.doesNotMatch(embeds[1]!.fields[0]!.value, /Precon/);
  });

  test("ties are broken before lists are cut: more entries, then more top cuts, then the name", async () => {
    const { loadPostData, composePost } = await import("../scripts/lib/post");
    const data = await loadPostData(sql, "global", AUGUST);
    // 25 commanders, 20 rows kept: the three leaders, then the commanders that played once, the one with a
    // top cut first and the rest by name.
    assert.equal(data.metaShare.length, 20);
    assert.deepEqual(data.metaShare.slice(3).map((m) => m.commander), ["Mo Single 00", ...Array.from({ length: 16 }, (_, i) => `Mo Single ${String(i + 1).padStart(2, "0")}`)]);
    assert.deepEqual(data.metaShare[3], { commander: "Mo Single 00", entries: 1, metaShare: 1 / 52, topCuts: 1 });
    // Top-cut appearances: two cuts first, then the three with one cut by their entries. A commander that
    // played once and made the cut is listed.
    assert.deepEqual(data.topCutAppearances.map((t) => [t.commander, t.topCutEntries, t.fieldEntries]), [["Mo Alpha", 2, 12], ["Mo Beta", 1, 12], ["Mo Gamma", 1, 6], ["Mo Single 00", 1, 1]]);
    const { text } = composePost(data);
    assert.match(text, /\n🎯 Top-cut appearances\n🥇 Mo Alpha\n2 cuts · .*\n\n🥈 Mo Beta\n1 cut · .*\n\n🥉 Mo Gamma\n1 cut · .*\n\n4️⃣ Mo Single 00\n1 cut · 20\.0% of cuts vs 1\.9% of field\n/);
    assert.match(text, /\n📊 Most played\n🥇 Mo Alpha\n▰{10} 23\.1% · 12 entries\n\n🥈 Mo Beta\n▰{10} 23\.1% · 12 entries\n\n🥉 Mo Gamma\n▰{5}▱{5} 11\.5% · 6 entries\n\n4️⃣ Mo Single 00\n▰▱{9} 1\.9% · 1 entry\n\n5️⃣ Mo Single 01\n▰▱{9} 1\.9% · 1 entry\n/);
  });

  test("a month with no qualifying events: one line about the chosen region", async () => {
    const { loadPostData, composePost } = await import("../scripts/lib/post");
    const data = await loadPostData(sql, "global", "2038-10");
    assert.equal(data.scene.events, 0);
    const { embeds, text } = composePost(data);
    assert.equal(embeds.length, 1);
    assert.equal(embeds[0]!.description, "No qualifying events in Global in October.");
    assert.deepEqual(embeds[0]!.fields.map((f) => f.name), ["🔗 Sources"]);
    assert.equal(text.split("\n").length, 4);
  });

  test("the 6-month calls are what they were: defaults, reportability and resolve_region still answer", async () => {
    // What `npm run report` asks for: the default window, six months ending in August.
    const meta = await sql<{ commander: string; entries: string }[]>`select commander, entries from stat_meta_share('global', '2038-08-01'::date) limit 3`;
    assert.deepEqual(meta.map((m) => [m.commander, Number(m.entries)]), [["Mo July Only", 30], ["Mo Gamma", 26], ["Mo Alpha", 12]]);
    const ppg = await sql<{ commander: string }[]>`select commander from stat_ppg('global', '2038-08-01'::date)`;
    assert.deepEqual(ppg.map((p) => p.commander).sort(), ["Mo Alpha", "Mo Beta", "Mo Gamma", "Mo July Only"]);
    const [cov] = await sql<{ qualifying_events: string }[]>`select qualifying_events from stat_coverage('global', '2038-08-01'::date)`;
    assert.equal(Number(cov!.qualifying_events), 2);
    // Still in the database and still callable, though no post or command uses them any more.
    const [rep] = await sql<{ commanders_10plus: string; reportable: boolean }[]>`select commanders_10plus, reportable from region_reportability('global', '2038-08-01'::date)`;
    assert.deepEqual([Number(rep!.commanders_10plus), rep!.reportable], [4, false]);
    const [res] = await sql<{ region_id: string; steps_up: number; reportable: boolean }[]>`select * from resolve_region('global', '2038-08-01'::date)`;
    assert.deepEqual({ ...res }, { region_id: "global", steps_up: 0, reportable: false });
  });
});
