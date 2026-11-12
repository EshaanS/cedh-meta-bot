// The opt-out, end to end, against a real Postgres: a player is ingested from (fake) TopDeck responses, shows
// in every output, asks not to be named, and then appears nowhere: not in the stored row, the post, /preview,
// the cron's message, the fixture data, or what the report, preview and optout scripts print. Ingesting again
// keeps the name out; removing the opt-out and ingesting again brings it back. TopDeck's permission
// (docs/permissions.md) depends on this and on names staying current, which is checked along the way.
//
// Skipped unless TEST_DATABASE_URL is set. The test files share one database and run in parallel: this one
// uses tournament ids "test-oo-…", player ids "testoo…", names starting "Oo ", the months 2040-03 and 2040-05,
// and the server "oo-guild" (not "test-…", which test/discord-db.test.ts deletes).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Sql } from "../scripts/lib/db";
import type { MonthWindow } from "../scripts/lib/topdeck";

const url = process.env.TEST_DATABASE_URL;

describe("opt-out end to end against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const MONTH = "2040-05";
  const WINDOW: MonthWindow = { start: new Date("2040-05-01T00:00:00Z"), end: new Date("2040-06-01T00:00:00Z"), label: MONTH };
  const GUILD = "oo-guild";
  const now = new Date(Date.UTC(2040, 5, 20)); // 20 June 2040: the report month is May
  const pid = (name: string) => `testoo${name}`.padEnd(28, "0");
  const [ALICE, BOB, CAROL, DANA, GONE, NAMESAKE] = ["alice", "bob", "carol", "dana", "gone", "alicetwo"].map(pid) as [string, string, string, string, string, string];
  const NAMES = { alice: "Oo Alice Example", bob: "Oo Bob Example", bobby: "Oo Bobby Example", carol: "Oo Carol Example", dana: "Oo Dana Example" };

  // ---------- fake TopDeck ----------

  type ApiRow = Record<string, unknown>;
  /** A standings row as the bulk endpoint returns it, with fields we must never store. */
  const row = (id: string, name: string, leader: string | null, winsBracket = 0, lossesBracket = 0): ApiRow => ({
    id, name, ...(leader ? { leader } : {}),
    wins: 3 + winsBracket, draws: 1, losses: 1 + lossesBracket, byes: 0, winsSwiss: 3, winsBracket, lossesSwiss: 1, lossesBracket,
    decklist: "https://example.invalid/deck", discord: "someone#0001",
  });
  /** Players without a TopDeck account: a 20-character id that exists for one event only. */
  const fillers = (tag: string, count: number): ApiRow[] =>
    Array.from({ length: count }, (_, i) => row(`oo${tag}${i}`.padEnd(20, "x"), `Oo Filler ${tag}${i}`, null));
  const event = (tid: string, name: string, date: string, topCut: number, standings: ApiRow[]) => ({
    TID: tid, tournamentName: name, startDate: Date.parse(date) / 1000, swissNum: 4, topCut, standings,
    game: "Magic: The Gathering", format: "EDH", eventData: { address: "1 Example Street", headerImage: "https://example.invalid/x.png" },
  });
  const KINNAN = "Kinnan, Bonder Prodigy";
  /** What TopDeck returns for May 2040; the tests change it between ingests. */
  const api = {
    aliceName: NAMES.alice,
    bobName: NAMES.bob,
    danaName: NAMES.dana,
    withC: false,
    withD: false,
  };
  const fetchMay = async (): Promise<unknown[]> => [
    // A: 40 players. Alice wins; Bob and a removed player also make the cut.
    event("test-oo-a", "Oo Spring Open", "2040-05-10T12:00:00Z", 4, [
      row(ALICE, api.aliceName, KINNAN, 2, 0), row(BOB, api.bobName, "Sisay, Weatherlight Captain", 1, 1), row(GONE, "Deleted User", "Tivit, Seller of Secrets", 0, 1),
      ...fillers("a", 37),
    ]),
    // B: 20 players, too small for Winners. Dana wins.
    event("test-oo-b", "Oo Weeknight Pods", "2040-05-12T12:00:00Z", 4, [row(DANA, api.danaName, "Magda, Brazen Outlaw", 2, 0), ...fillers("b", 19)]),
    // C: 36 players and no recorded bracket; its winner comes from the standings endpoint.
    ...(api.withC ? [event("test-oo-c", "Oo Points Championship", "2040-05-20T12:00:00Z", 0, [row(ALICE, api.aliceName, KINNAN), ...fillers("c", 35)])] : []),
    // D: 32 players. Carol wins.
    ...(api.withD ? [event("test-oo-d", "Oo Late May Cup", "2040-05-25T12:00:00Z", 4, [row(CAROL, NAMES.carol, "Etali, Primal Conqueror", 2, 0), ...fillers("d", 31)])] : []),
  ];
  /** One ingest of the month, as `npm run backfill` does it, then the event class `npm run classify` would set. */
  const ingest = async () => {
    const { ingestWindow } = await import("../scripts/lib/ingest");
    const result = await ingestWindow(sql, WINDOW, true, fetchMay);
    await sql`update tournaments set event_class = 'cedh' where tid like 'test-oo-%'`;
    return result;
  };

  // ---------- everything a name could come out of ----------

  type Shown = { title?: string; description?: string; fields: { name: string; value: string }[] }[];
  const sent: Shown[] = [];
  const edits: Shown[] = [];
  const discord = {
    createMessage: async (_channel: string, payload: { embeds?: unknown[] }) => { sent.push(payload.embeds as Shown); },
    editOriginal: async (_app: string, _token: string, payload: { embeds?: unknown[] }) => { edits.push(payload.embeds as Shown); },
    // No list of servers: the cron then skips its prune step, so this file never deletes another file's servers.
    listGuildIds: async () => { throw new Error("not listed in this test"); },
    putCommands: async () => null,
    listAppEmojis: async () => [],
    createAppEmoji: async () => assert.fail("should not upload"),
    deleteAppEmoji: async () => assert.fail("should not delete"),
  };
  const section = (embeds: Shown, name: string) => embeds.flatMap((e) => e.fields).find((f) => f.name.includes(name))?.value.split("\n\n") ?? [];

  /** The post, the fixture data behind it, the /preview reply and the cron's message for May, as one text. */
  const outputs = async () => {
    const { composePost, loadPostData } = await import("../scripts/lib/post");
    const { handleInteraction } = await import("../src/server/interactions");
    const { runCron } = await import("../src/server/cron");
    const data = await loadPostData(sql, "global", MONTH);
    const post = composePost(data);

    const r = await handleInteraction(
      { type: 2, token: "tok", guild_id: GUILD, data: { name: "preview" } },
      { sql: () => sql, discord, appId: "1", allowlist: new Set([GUILD]), now: () => now },
    );
    await r.background?.();
    const preview = edits.at(-1)!;

    // Another file's cron can prune this server's row in the instant between listing servers and pruning, so
    // the row is put back and the run repeated if nothing was posted.
    const before = sent.length;
    for (let attempt = 0; attempt < 3 && sent.length === before; attempt++) {
      await sql`
        insert into guild_configs (guild_id, region_id, channel_id) values (${GUILD}, 'global', 'oo-chan')
        on conflict (guild_id) do update set last_posted_month = null, channel_id = 'oo-chan', region_id = 'global'`;
      const summary = await runCron({ sql, discord, allowlist: new Set([GUILD]), now }, { monthOverride: MONTH });
      assert.deepEqual(summary.failed, []);
    }
    assert.equal(sent.length, before + 1, "the cron posted");
    const posted = sent.at(-1)!;
    assert.deepEqual(preview, post.embeds, "/preview shows the same embeds");
    assert.deepEqual(posted, post.embeds, "the cron posts the same embeds");
    return { data, embeds: post.embeds, text: [post.text, JSON.stringify(post.embeds), JSON.stringify(preview), JSON.stringify(posted), JSON.stringify(data)].join("\n") };
  };

  /** Runs one of the project's scripts as `npm run` does and returns everything it printed. */
  const cli = (script: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", `scripts/${script}.ts`, ...args], {
      cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, encoding: "utf8",
    });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  };
  const scriptOutputs = () => {
    const report = cli("report", "--region", "global", "--month", MONTH);
    const preview = cli("preview", "--region", "global", "--month", MONTH);
    assert.equal(report.status, 0, report.out);
    assert.equal(preview.status, 0, preview.out);
    return `${report.out}\n${preview.out}`;
  };
  const storedName = async (id: string) => (await sql<{ display_name: string | null }[]>`select display_name from players where player_id = ${id}`)[0]?.display_name;

  const cleanup = async () => {
    await sql`delete from tournaments where tid like 'test-oo-%'`; // entries and event_winners cascade
    await sql`delete from player_optouts where player_id like 'testoo%'`;
    await sql`delete from players where player_id like 'testoo%'`;
    await sql`delete from ingest_log where window_start = '2040-05-01T00:00:00Z'`;
    await sql`delete from guild_configs where guild_id = ${GUILD}`;
  };

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await cleanup();
    // Another player with Alice's name, known from one event in March. Opting Alice out must not touch them.
    await sql`insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class, city, geo_country_name)
              values ('test-oo-old', 'Oo March Meetup', '2040-03-15T12:00:00Z', 20, 4, 'cedh', 'Oo Town', 'Ooland')`;
    await sql`insert into players (player_id, display_name) values (${NAMESAKE}, ${NAMES.alice})`;
    await sql`insert into entries (tid, standing_index, leader, player_id, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
              values ('test-oo-old', 0, null, ${NAMESAKE}, 3, 1, 1, 0, 3, 0, 1, 0)`;
  });
  after(async () => {
    if (!sql) return;
    await cleanup();
    await sql.end();
  });

  test("ingest stores ids and names only, for players with an account; a named player shows in every output", async () => {
    const result = await ingest();
    assert.deepEqual([result.tournaments, result.entries, result.players, result.entriesWithPlayer], [2, 60, 4, 4]);
    // Four accounts are stored. The removed player has no name; the 56 players without an account are not stored at all.
    const players = await sql<{ player_id: string; display_name: string | null }[]>`select player_id, display_name from players where player_id like 'testoo%' order by player_id`;
    assert.deepEqual(players.map((p) => [p.player_id, p.display_name]), [
      [ALICE, NAMES.alice], [NAMESAKE, NAMES.alice], [BOB, NAMES.bob], [DANA, NAMES.dana], [GONE, null],
    ]);
    assert.equal((await sql`select 1 from players where display_name like 'Oo Filler%' or display_name ilike 'deleted user'`).length, 0);
    assert.equal((await sql`select 1 from entries where tid like 'test-oo-%' and player_id is not null and player_id !~ '^[A-Za-z0-9]{28}$'`).length, 0);
    // The table has room for nothing else: no decklist and no Discord field can be stored.
    const columns = await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'players' and table_schema = current_schema() order by 1`;
    assert.deepEqual(columns.map((c) => c.column_name), ["display_name", "player_id", "updated_at"]);

    const { embeds, text } = await outputs();
    assert.equal(embeds[0]!.description!.split("\n")[0], `🏆 **Oo Spring Open** (40 players) went to **${NAMES.alice}** on ${KINNAN}`);
    assert.deepEqual(section(embeds, "Winners"), [`**Oo Spring Open** · 40 players\n🏆 ${NAMES.alice} on ${KINNAN}`]);
    assert.deepEqual(section(embeds, "Top players").map((item) => item.split("\n")[0]), [`🥇 **${NAMES.alice}**`, `🥈 **${NAMES.dana}**`, `🥉 **${NAMES.bob}**`]);
    assert.deepEqual(section(embeds, "Rising players").map((item) => item.split("\n")[0]), [`**${NAMES.alice}**`, `**${NAMES.dana}**`]);
    for (const hidden of ["Filler", "Deleted User", "example.invalid", "someone#0001", "Example Street"]) assert.ok(!text.includes(hidden), hidden);
  });

  test("optout find: the id for a name as a post shows it, without printing a name", async () => {
    const { findPlayersByName } = await import("../scripts/lib/optout");
    // Two players have this name: most recently active first, with what tells them apart.
    assert.deepEqual(await findPlayersByName(sql, "  oo ALICE   example "), [
      { playerId: ALICE, events: 1, firstEvent: "2040-05-10", lastEvent: "2040-05-10", lastEventName: "Oo Spring Open", lastEventPlace: null },
      { playerId: NAMESAKE, events: 1, firstEvent: "2040-03-15", lastEvent: "2040-03-15", lastEventName: "Oo March Meetup", lastEventPlace: "Oo Town, Ooland" },
    ]);
    // The characters a post strips from names don't matter, and a name a post cut short matches as a beginning.
    assert.deepEqual((await findPlayersByName(sql, "*Oo_ Alice* [Example]")).map((m) => m.playerId), [ALICE, NAMESAKE]);
    assert.deepEqual((await findPlayersByName(sql, "Oo Alice Exa…")).map((m) => m.playerId), [ALICE, NAMESAKE]);
    assert.deepEqual((await findPlayersByName(sql, "Oo Bob Exa…")).map((m) => m.playerId), [BOB]);
    // Part of a name is not a match, and neither is nothing.
    assert.deepEqual(await findPlayersByName(sql, "Oo Alice"), []);
    assert.deepEqual(await findPlayersByName(sql, "Oo Nobody Example"), []);
    assert.deepEqual(await findPlayersByName(sql, "  "), []);
    assert.deepEqual(await findPlayersByName(sql, "…"), []);

    const found = cli("optout", "find", "oo alice example");
    assert.equal(found.status, 0, found.out);
    assert.match(found.out, new RegExp(`^${ALICE}\\t1 event\\(s\\), 2040-05-10 to 2040-05-10\\tlast: Oo Spring Open$`, "m"));
    assert.match(found.out, new RegExp(`^${NAMESAKE}\\t1 event\\(s\\), 2040-03-15 to 2040-03-15\\tlast: Oo March Meetup \\(Oo Town, Ooland\\)$`, "m"));
    assert.match(found.out, /2 player\(s\) with this name/);
    assert.doesNotMatch(found.out, /alice example/i, "the script prints ids, never names");
    assert.match(cli("optout", "find", "Oo Nobody Example").out, /No player is stored under this name/);
  });

  test("optout add: the name is gone from the stored row and from every output, and the results still count", async () => {
    const before = await outputs();
    const added = cli("optout", "add", ALICE, "--note", "asked by email");
    assert.equal(added.status, 0, added.out);
    assert.match(added.out, new RegExp(`^Opted out ${ALICE}\\.$`, "m"));
    assert.doesNotMatch(added.out, /Alice/);

    assert.equal(await storedName(ALICE), null, "the stored name is blanked, not only hidden");
    assert.equal(await storedName(NAMESAKE), NAMES.alice, "another player with the same name is untouched");
    assert.deepEqual([...(await sql`select display_name from player_names where player_id = ${ALICE}`)].map((r) => r.display_name), [null]);

    const { data, embeds, text } = await outputs();
    assert.ok(!text.includes("Alice"), "no output names the player");
    // Winners and the headline keep the event and the deck; the winner is "a player".
    assert.equal(embeds[0]!.description!.split("\n")[0], `🏆 **Oo Spring Open** (40 players) went to a player on ${KINNAN}`);
    assert.deepEqual(section(embeds, "Winners"), [`**Oo Spring Open** · 40 players\n🏆 a player on ${KINNAN}`]);
    // The player sections skip them, and the event's Rising players line goes to the next player.
    assert.deepEqual(section(embeds, "Top players").map((item) => item.split("\n")[0]), [`🥇 **${NAMES.dana}**`, `🥈 **${NAMES.bob}**`]);
    assert.deepEqual(section(embeds, "Rising players").map((item) => item.split("\n")[0]), [`**${NAMES.bob}**`, `**${NAMES.dana}**`]);
    assert.deepEqual(data.results.map((r) => [r.winnerName, r.winnerHidden]), [[null, true]]);
    // Nothing else moves: the same events, entries, commanders and top cuts.
    for (const key of ["scene", "coverage", "topCutAppearances", "metaShare", "ppg", "conversion", "trend"] as const) {
      assert.deepEqual(data[key], before.data[key], key);
    }

    // What the scripts print: the report, the preview and the list itself.
    const printed = scriptOutputs();
    assert.ok(!printed.includes("Alice"), "no script prints the name");
    assert.match(printed, /\(opted out\)/, "the report marks the winner as opted out");
    assert.ok(printed.includes(NAMES.bob) && printed.includes(NAMES.dana), "other players are still named");
    const list = cli("optout", "list");
    assert.match(list.out, new RegExp(`^${ALICE}\\t\\d{4}-\\d{2}-\\d{2}\\tasked by email$`, "m"));
    assert.doesNotMatch(list.out, /Alice/);
    // Found by name no longer; the other player with that name still is.
    const { findPlayersByName } = await import("../scripts/lib/optout");
    assert.deepEqual((await findPlayersByName(sql, NAMES.alice)).map((m) => m.playerId), [NAMESAKE]);
  });

  test("ingesting again keeps the name out, by both routes, while other names follow TopDeck", async () => {
    // TopDeck still sends Alice's name. Bob has renamed himself, Dana has deleted her account, and a new event
    // with no recorded bracket has Alice as its official winner.
    api.bobName = NAMES.bobby;
    api.danaName = "Deleted User";
    api.withC = true;
    await ingest();
    // Checked before the standings fetch, which would blank the name again and hide a leak in the bulk route.
    assert.equal(await storedName(ALICE), null, "the bulk ingest wrote the name and blanked it in the same transaction");
    const { fetchMissingStandings } = await import("../scripts/lib/standings");
    const standings = await fetchMissingStandings(
      sql,
      async () => ({ status: "found", leader: KINNAN, playerId: ALICE, playerName: NAMES.alice }),
      { pauseMs: 0, tids: ["test-oo-c"] },
    );
    assert.equal(standings.found, 1);

    assert.equal(await storedName(ALICE), null, "the standings fetch leaves the name blank too");
    assert.equal(await storedName(BOB), NAMES.bobby, "a changed name replaces the old one");
    assert.equal(await storedName(DANA), null, "a deleted account loses its name");

    const { embeds, text } = await outputs();
    for (const gone of ["Alice", NAMES.bob, "Dana", "Deleted User"]) assert.ok(!text.includes(gone), gone);
    assert.deepEqual(section(embeds, "Winners"), [
      `**Oo Spring Open** · 40 players\n🏆 a player on ${KINNAN}`,
      `**Oo Points Championship** · 36 players\n🏆 a player on ${KINNAN}`,
    ]);
    assert.deepEqual(section(embeds, "Top players").map((item) => item.split("\n")[0]), [`🥇 **${NAMES.bobby}**`]);
    assert.deepEqual(section(embeds, "Rising players").map((item) => item.split("\n")[0]), [`**${NAMES.bobby}**`]);
  });

  test("an opt-out recorded before the player is ever ingested applies from their first event", async () => {
    const { addOptOut } = await import("../scripts/lib/optout");
    assert.deepEqual(await addOptOut(sql, CAROL, "asked before playing"), { known: false });
    assert.deepEqual(await addOptOut(sql, CAROL), { known: false }, "safe to repeat");
    assert.equal((await sql<{ note: string }[]>`select note from player_optouts where player_id = ${CAROL}`)[0]!.note, "asked before playing", "a repeat without a note keeps the note");
    api.withD = true;
    await ingest();
    assert.equal(await storedName(CAROL), null);
    const { embeds, text } = await outputs();
    assert.ok(!text.includes("Carol"));
    assert.equal(section(embeds, "Winners")[2], `**Oo Late May Cup** · 32 players\n🏆 a player on Etali, Primal Conqueror`);
  });

  test("optout remove: the name returns only when the player is ingested again", async () => {
    const removed = cli("optout", "remove", ALICE);
    assert.equal(removed.status, 0, removed.out);
    assert.match(removed.out, new RegExp(`^Removed the opt-out for ${ALICE}\\. The name returns on the next ingest\\.$`, "m"));
    assert.match(cli("optout", "remove", ALICE).out, new RegExp(`^No opt-out found for ${ALICE}\\.$`, "m"));

    // Not hidden any more, but no name is stored yet: the winner line shows the deck alone.
    assert.equal(await storedName(ALICE), null);
    let shown = await outputs();
    assert.ok(!shown.text.includes("Alice"));
    assert.equal(section(shown.embeds, "Winners")[0], `**Oo Spring Open** · 40 players\n🏆 ${KINNAN}`);

    await ingest();
    assert.equal(await storedName(ALICE), NAMES.alice);
    shown = await outputs();
    assert.deepEqual(section(shown.embeds, "Winners"), [
      `**Oo Spring Open** · 40 players\n🏆 ${NAMES.alice} on ${KINNAN}`,
      `**Oo Points Championship** · 36 players\n🏆 ${NAMES.alice} on ${KINNAN}`,
      `**Oo Late May Cup** · 32 players\n🏆 a player on Etali, Primal Conqueror`,
    ]);
    assert.deepEqual(section(shown.embeds, "Top players").map((item) => item.split("\n")[0]), [`🥇 **${NAMES.alice}**`, `🥈 **${NAMES.bobby}**`]);
    // The scripts name her again, which also shows that the earlier "no script prints the name" check could fail.
    const printed = scriptOutputs();
    assert.ok(printed.includes(NAMES.alice));
    for (const gone of ["Carol", NAMES.bob, "Dana"]) assert.ok(!printed.includes(gone) && !shown.text.includes(gone), gone);
    const list = cli("optout", "list");
    assert.match(list.out, new RegExp(`^${CAROL}\\t\\d{4}-\\d{2}-\\d{2}\\tasked before playing$`, "m"));
    assert.ok(!list.out.includes(ALICE));
  });

  test("optout refuses anything that is not an account id", () => {
    for (const bad of ["short", "x".repeat(20), `${"y".repeat(27)}!`]) {
      const r = cli("optout", "add", bad);
      assert.equal(r.status, 1, bad);
      assert.match(r.out, /28-character TopDeck account id/);
    }
    assert.equal(cli("optout").status, 1);
    assert.equal(cli("optout", "find").status, 1);
  });
});
