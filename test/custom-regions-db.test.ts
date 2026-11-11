// Custom regions against a real Postgres, with a fake Discord client. Skipped unless TEST_DATABASE_URL is set.
// Self-contained: tournaments use ids starting with "test-cr-" in March 2034 (far from real data and from the
// other test files' months), guild ids start with "crtest-" (the Discord test file clears every guild id starting with "test-"), and the standard regions the tests need are
// inserted only when missing and removed again afterwards.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe("custom regions against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const A = "crtest-a", B = "crtest-b", L = "crtest-limit", ORPHAN = "crtest-orphan";
  const now = new Date(Date.UTC(2034, 3, 20)); // 20 April 2034: the previous month is March, after the 15th
  const MONTH = "2034-03-01";
  let insertedRegions: string[] = [];
  let insertedLog = false;
  let regionless = { code: "", name: "" }; // a country a continent lists that has no region row (Luxembourg on real data)

  type Sent = { content?: string; embeds?: { title: string; description?: string; fields: { name: string; value: string }[] }[] };
  const edits: Sent[] = [];
  let guildIds: string[] = [];
  const discord = {
    createMessage: async () => {},
    editOriginal: async (_app: string, _token: string, payload: Sent) => { edits.push(payload); },
    listGuildIds: async () => guildIds,
    putCommands: async () => null,
  };
  const deps = () => ({ sql: () => sql, discord, appId: "1", allowlist: "all" as const, now: () => now });
  type Opt = { name: string; type: number; value: string; focused?: boolean };
  /** Runs a slash command to completion and returns the reply. */
  const run = async (guild: string, name: string, sub?: string, options: Opt[] = []): Promise<Sent> => {
    const { handleInteraction } = await import("../src/server/interactions");
    const r = await handleInteraction({ type: 2, token: "tok", guild_id: guild, data: { name, options: sub ? [{ name: sub, type: 1, options }] : undefined } }, deps());
    await r.background?.();
    return edits.at(-1)!;
  };
  const say = async (guild: string, sub: string, options: Record<string, string> = {}) =>
    (await run(guild, "region", sub, Object.entries(options).map(([name, value]) => ({ name, type: 3, value })))).content ?? "";
  /** Autocomplete choices for one focused option. */
  const complete = async (guild: string, sub: string, focused: string, typed: string, other: Record<string, string> = {}) => {
    const { handleInteraction } = await import("../src/server/interactions");
    const options: Opt[] = [...Object.entries(other).map(([name, value]) => ({ name, type: 3, value })), { name: focused, type: 3, value: typed, focused: true }];
    const r = await handleInteraction({ type: 4, token: "tok", guild_id: guild, data: { name: "region", options: [{ name: sub, type: 1, options }] } }, deps());
    return (r.response as { data: { choices: { name: string; value: string }[] } }).data.choices;
  };
  /** The value Discord would send after picking the choice with this exact label. */
  const pick = async (guild: string, sub: string, focused: string, typed: string, label: string, other: Record<string, string> = {}) => {
    const choices = await complete(guild, sub, focused, typed, other);
    const hit = choices.find((c) => c.name === label);
    assert.ok(hit, `no choice "${label}" for "${typed}" in ${JSON.stringify(choices.map((c) => c.name))}`);
    return hit.value;
  };
  const regionId = async (guild: string, name: string) =>
    (await sql<{ id: string }[]>`select id from regions where owner_guild_id = ${guild} and display_name = ${name}`)[0]?.id ?? "";
  const tids = async (id: string) =>
    (await sql<{ tid: string }[]>`select r.tid from region_tournament_ids(${id}) as r(tid) where r.tid like 'test-cr-%' order by 1`).map((r) => r.tid.slice(8));
  /** Creates a region for guild A and adds the given picked places. */
  const build = async (guild: string, name: string, places: [typed: string, label: string][]) => {
    assert.match(await say(guild, "create", { name }), new RegExp(`^Created ${name.replace(/[+]/g, "\\+")}\\.`));
    for (const [typed, label] of places) {
      const reply = await say(guild, "add", { place: await pick(guild, "add", "place", typed, label), region: name });
      assert.match(reply, /: added 1 place \(\d+ of 25\)\.\nAdded: /, reply);
    }
    return regionId(guild, name);
  };

  const cleanup = async () => {
    await sql`delete from guild_configs where guild_id like 'crtest-%'`;
    await sql`delete from regions where owner_guild_id like 'crtest-%'`;
    await sql`delete from tournaments where tid like 'test-cr-%'`;
  };

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    const { resetPlaceCache } = await import("../src/server/custom-regions");
    sql = connect();
    resetPlaceCache();
    await cleanup();

    // Standard regions, shaped as scripts/regions.ts makes them. Inserted only when the database lacks them.
    const standard: [id: string, name: string, type: string, parent: string, selectable: boolean, cc: string, a1: string | null, group: string | null][] = [
      ["us", "United States", "country", "north-america", true, "US", null, null],
      ["ca", "Canada", "country", "north-america", true, "CA", null, null],
      ["es", "Spain", "country", "europe", true, "ES", null, null],
      ["be", "Belgium", "country", "europe", true, "BE", null, null],
      ["nl", "Netherlands", "country", "europe", true, "NL", null, null],
      ["jp", "Japan", "country", "asia", true, "JP", null, null],
      ["us-west", "West", "admin1_group", "us", false, "US", null, "US-WEST"],
      ["es-cataluna", "Cataluña", "admin1_group", "es", true, "ES", null, "ES-CATALUNA"],
      ["us-wa", "Washington", "admin1", "us-west", true, "US", "US-WA", null],
      ["us-or", "Oregon", "admin1", "us-west", true, "US", "US-OR", null],
      ["ca-bc", "British Columbia", "admin1", "ca", true, "CA", "CA-BC", null],
      ["es-b", "Barcelona", "admin1", "es-cataluna", false, "ES", "ES-B", null],
    ];
    for (const [id, name, type, parent, selectable, cc, a1, group] of standard) {
      const ins = await sql`
        insert into regions (id, display_name, type, parent_region_id, source, selectable)
        values (${id}, ${name}, ${type}, ${parent}, 'auto', ${selectable}) on conflict (id) do nothing returning id`;
      if (ins.length === 0) continue;
      insertedRegions.push(id);
      await sql`insert into region_members (region_id, country_code, admin1_code, admin1_group_code) values (${id}, ${cc}, ${a1}, ${group})`;
    }
    const [free] = await sql<{ code: string }[]>`
      select m.country_code as code from region_members m
      where m.region_id = 'europe' and not exists (select 1 from regions c where c.id = lower(m.country_code))
      order by (m.country_code = 'LU') desc, m.country_code limit 1`;
    regionless = { code: free!.code, name: new Intl.DisplayNames(["en"], { type: "region" }).of(free!.code)! };

    const event = (id: string, cc: string | null, cn: string | null, a1: string | null, a1n: string | null, group: string | null, city: string | null) => sql`
      insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class, city,
                               geo_country_code, geo_country_name, geo_admin1_code, geo_admin1_name, geo_admin1_group_code)
      values (${`test-cr-${id}`}, ${`Event ${id}`}, '2034-03-10T12:00:00Z', 20, 0, 'cedh', ${city}, ${cc}, ${cn}, ${a1}, ${a1n}, ${group})`;
    await event("tacoma1", "US", "United States of America", "US-WA", "Washington", "US-WEST", "Tacoma");
    await event("tacoma2", "US", "United States of America", "US-WA", "Washington", "US-WEST", "Tacoma");
    await event("tacoma3", "US", "United States of America", "US-WA", "Washington", "US-WEST", "  TACOMA ");
    await event("spokane", "US", "United States of America", "US-WA", "Washington", "US-WEST", "Spokane");
    await event("vanwa", "US", "United States of America", "US-WA", "Washington", "US-WEST", "Vancouver");
    await event("wa-nocity", "US", "United States of America", "US-WA", "Washington", "US-WEST", null);
    await event("portland", "US", "United States of America", "US-OR", "Oregon", "US-WEST", "Portland");
    await event("vanbc", "CA", "Canada", "CA-BC", "British Columbia", null, "Vancouver");
    await event("bcn", "ES", "Spain", "ES-B", "Barcelona", "ES-CATALUNA", "Barcelona");
    await event("gent", "BE", "Belgium", "BE-VOV", "Oost-Vlaanderen", null, "Gent");
    await event("utrecht", "NL", "Netherlands", "NL-UT", "Utrecht", null, "Utrecht");
    await event("regionless", regionless.code, regionless.name, null, null, null, "Somewhere");
    await event("tokyo", "JP", "Japan", "JP-13", "Tokyo", null, "Shinjuku");
    await event("nowhere", null, null, null, null, null, null);
    // Two entries everywhere, and enough in Spokane (10 commanders x 10 entries) to make Washington reportable.
    await sql`
      insert into entries (tid, standing_index, leader, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
      select t.tid, g, 'Test Commander ' || (g % 2), 3, 1, 1, 0, 3, 0, 1, 0
      from tournaments t cross join generate_series(0, 1) g where t.tid like 'test-cr-%'`;
    await sql`
      insert into entries (tid, standing_index, leader, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
      select 'test-cr-spokane', 2 + g, 'Test Commander ' || (g % 10), 3, 1, 1, 0, 3, 0, 1, 0 from generate_series(0, 99) g`;
    const log = await sql`
      insert into ingest_log (window_start, window_end, tournaments, entries, team_events_skipped, invalid_skipped)
      values ('2034-03-01T00:00:00Z', '2034-03-31T23:59:59Z', 0, 0, 0, 0) on conflict (window_start) do nothing returning window_start`;
    insertedLog = log.length > 0;
  });

  after(async () => {
    await cleanup();
    for (const id of [...insertedRegions].reverse()) await sql`delete from regions where id = ${id}`;
    if (insertedLog) await sql`delete from ingest_log where window_start = '2034-03-01T00:00:00Z'`;
    await sql.end();
  });

  test("create: names are cleaned, must be non-empty, short, unique per server and not a standard region's", async () => {
    assert.equal(await say(A, "create", { name: "  @everyone **Seattle**  <@123> Metro https://evil.example/x discord.gg/abc " }), "Created everyone Seattle 123 Metro. Add places with /region add, then choose it with /region set.");
    assert.equal(await say(A, "create", { name: "*_~`|[]<> https://only.a.link" }), "Give the region a name using letters or numbers.");
    assert.equal(await say(A, "create", { name: "x".repeat(41) }), "Region names can be up to 40 characters.");
    assert.equal(await say(A, "create", { name: "EVERYONE seattle 123 metro" }), "This server already has a region called EVERYONE seattle 123 metro.");
    assert.equal(await say(A, "create", { name: "global" }), "Global is already a standard region. Pick a different name.");
    assert.equal(await say(A, "create", { name: "Pacific Northwest" }), "Pacific Northwest is already a standard region. Pick a different name.");
    assert.equal(await say(A, "create", { name: "us-wa" }), "Washington (United States) is already a standard region. Pick a different name.");
    const rows = await sql<{ display_name: string; type: string; source: string; selectable: boolean; id: string }[]>`
      select display_name, type, source, selectable, id from regions where owner_guild_id = ${A}`;
    assert.equal(rows.length, 1);
    assert.deepEqual({ ...rows[0], id: rows[0]!.id.startsWith(`g:${A}:`) }, { display_name: "everyone Seattle 123 Metro", type: "custom", source: "guild", selectable: false, id: true });
    assert.equal(await say(A, "delete", { region: "everyone Seattle 123 Metro" }), "Deleted everyone Seattle 123 Metro.");
  });

  test("cities: listed from the data with state, country and count; matched on the normalized name within country and state", async () => {
    const tacoma = await complete(A, "add", "place", "tac");
    assert.deepEqual(tacoma.filter((c) => c.name.startsWith("Tacoma")).map((c) => c.name), ["Tacoma, Washington, United States (3 events)"]);
    const vancouver = (await complete(A, "add", "place", "vancouver")).map((c) => c.name).filter((n) => n.startsWith("Vancouver, "));
    assert.deepEqual(vancouver.filter((n) => /\(1 event\)$/.test(n)).sort(), ["Vancouver, British Columbia, Canada (1 event)", "Vancouver, Washington, United States (1 event)"]);
    assert.deepEqual((await complete(A, "add", "place", "zzz-no-such-city")), []);
    assert.ok((await complete(A, "add", "place", "")).length <= 25);

    const metro = await build(A, "Seattle Metro", [["tac", "Tacoma, Washington, United States (3 events)"]]);
    assert.deepEqual(await tids(metro), ["tacoma1", "tacoma2", "tacoma3"], "three spellings of Tacoma, and nothing else in Washington");
    const bc = await build(A, "Vancouver BC", [["vancouver", "Vancouver, British Columbia, Canada (1 event)"]]);
    assert.deepEqual(await tids(bc), ["vanbc"], "Vancouver, Washington stays out");
    // Typed in full without picking is accepted; a city with no events, Global, a hidden level and junk are not.
    assert.equal(await say(A, "add", { place: "Spokane, Washington, United States", region: "Seattle Metro" }), "Seattle Metro: added 1 place (2 of 25).\nAdded: Spokane, Washington, United States");
    for (const place of ["Seattle", "r:global", "r:es-b", "c:US:US-WA:seattle", "k:ZZ", "p:1"]) {
      const reply = await say(A, "add", { place, region: "Seattle Metro" });
      assert.ok(reply.startsWith(`Seattle Metro: nothing added (2 of 25 places).\nNot found: "${place}"`), reply);
    }
    assert.match(await say(A, "add", { place: "", region: "Seattle Metro" }), /^Nothing to add yet\./);
    assert.equal(await say(A, "add", { place: "Spokane, Washington, United States", region: "Seattle Metro" }), "Seattle Metro: nothing added (2 of 25 places).\nAlready in the region: Spokane, Washington, United States");
    assert.deepEqual(await tids(metro), ["spokane", "tacoma1", "tacoma2", "tacoma3"]);
  });

  test("states, groups, countries, continents and seeded regions as members; overlap counts once", async () => {
    const wa = await build(A, "Washington plus", [["washington", "Washington (United States)"], ["tac", "Tacoma, Washington, United States (3 events)"]]);
    assert.deepEqual(await tids(wa), ["spokane", "tacoma1", "tacoma2", "tacoma3", "vanwa", "wa-nocity"], "every Washington event once, including the one without a city");
    await say(A, "delete", { region: "Washington plus" });

    const mixed = await build(A, "Mixed", [["catal", "Cataluña (Spain)"], ["canada", "Canada"]]);
    assert.deepEqual(await tids(mixed), ["bcn", "vanbc"]);
    await say(A, "delete", { region: "Mixed" });

    const europe = await build(A, "Old World", [["europe", "Europe"]]);
    assert.deepEqual(await tids(europe), ["bcn", "gent", "regionless", "utrecht"], "a continent expands to its member countries");
    assert.deepEqual((await sql`select 1 from region_places where region_id = ${europe}`).length, 1, "and is still one place");
    await say(A, "delete", { region: "Old World" });

    const pnw = await build(A, "PNW and Tokyo", [["pacific north", "Pacific Northwest"]]);
    assert.deepEqual(await tids(pnw), ["portland", "spokane", "tacoma1", "tacoma2", "tacoma3", "vanbc", "vanwa", "wa-nocity"]);
    await say(A, "delete", { region: "PNW and Tokyo" });

    // A country with no events has no region row, but can still be a member (Benelux needs Luxembourg).
    const benelux = await build(A, "Benelux", [["belg", "Belgium"], ["nether", "Netherlands"], [regionless.name.slice(0, 5), regionless.name]]);
    assert.deepEqual(await tids(benelux), ["gent", "regionless", "utrecht"]);
    assert.equal(await sql<{ a: string }[]>`select custom_region_anchor(${benelux}) as a`.then((r) => r[0]!.a), "europe");
    await say(A, "delete", { region: "Benelux" });
  });

  test("remove, list, and the optional region option", async () => {
    // Guild A has Seattle Metro (Tacoma, Spokane) and Vancouver BC from the earlier test.
    assert.match(await say(A, "add", { place: "Portland, Oregon, United States" }), /^Which region\? Add the region option\. This server has: Seattle Metro, Vancouver BC\.$/);
    const list = await say(A, "list");
    assert.equal(list, [
      "Custom regions (2 of 5):",
      "• Seattle Metro: Spokane, Washington, United States; Tacoma, Washington, United States",
      "• Vancouver BC: Vancouver, British Columbia, Canada",
    ].join("\n"));
    const choices = await complete(A, "remove", "place", "", { region: "Seattle Metro" });
    assert.deepEqual(choices.map((c) => c.name), ["Spokane, Washington, United States", "Tacoma, Washington, United States"]);
    assert.equal(await say(A, "remove", { place: choices[0]!.value, region: "Seattle Metro" }), "Seattle Metro: removed 1 place (1 left).\nRemoved: Spokane, Washington, United States");
    assert.equal(
      await say(A, "remove", { place: "Spokane, Washington, United States", region: "Seattle Metro" }),
      'Seattle Metro: nothing removed (1 place).\nNot in Seattle Metro: "Spokane, Washington, United States". Pick from the list that appears as you type.',
    );
    assert.equal(await say(A, "remove", { region: "Seattle Metro" }), "Nothing to remove yet. Pick places in the place options, or type several in the list option.");
    assert.deepEqual((await complete(A, "delete", "region", "van")).map((c) => c.name), ["Vancouver BC"]);
    assert.equal(await say(A, "delete", { region: "Vancouver BC" }), "Deleted Vancouver BC.");
    // With one region left, the option isn't needed.
    assert.equal(await say(A, "add", { place: "Portland, Oregon, United States" }), "Seattle Metro: added 1 place (2 of 25).\nAdded: Portland, Oregon, United States");
    assert.equal(await say(A, "remove", { place: "Portland, Oregon, United States" }), "Seattle Metro: removed 1 place (1 left).\nRemoved: Portland, Oregon, United States");
    assert.equal(await say(B, "list"), "This server has no custom regions. Create one with /region create, then add places with /region add.");
  });

  test("anchor and fallback: same state, same country, across countries, across continents, a hidden level, an empty region", async () => {
    const { customStatsRegion } = await import("../scripts/lib/post");
    const anchor = async (id: string) => (await sql<{ a: string }[]>`select custom_region_anchor(${id}) as a`)[0]!.a;
    const metro = await regionId(A, "Seattle Metro"); // Tacoma
    assert.equal(await anchor(metro), "us-wa");
    assert.deepEqual(await customStatsRegion(sql, metro, MONTH), { id: "us-wa", label: "Washington (United States)", shortLabel: "Washington", reportable: true });

    const sameCountry = await build(B, "Two states", [["tac", "Tacoma, Washington, United States (3 events)"], ["portland", "Portland, Oregon, United States (1 event)"]]);
    assert.equal(await anchor(sameCountry), "us", "the census region between state and country can't be selected, so it is skipped");
    const twoCountries = await build(B, "Cascadia", [["tac", "Tacoma, Washington, United States (3 events)"], ["vancouver", "Vancouver, British Columbia, Canada (1 event)"]]);
    assert.equal(await anchor(twoCountries), "north-america");
    const twoContinents = await build(B, "Pacific Rim", [["tac", "Tacoma, Washington, United States (3 events)"], ["japan", "Japan"]]);
    assert.equal(await anchor(twoContinents), "global");
    // Barcelona's province isn't selectable, so the anchor is Cataluña. Nothing in Spain or Europe is reportable
    // in this window, so the walk goes on until it reaches a region that is.
    const bcn = await build(B, "Barcelona area", [["barcelona", "Barcelona, Barcelona, Spain (1 event)"]]);
    assert.equal(await anchor(bcn), "es-cataluna");
    const walked = await customStatsRegion(sql, bcn, MONTH);
    assert.ok(walked.reportable && !["es-cataluna", "es"].includes(walked.id), JSON.stringify(walked));
    assert.match(await say(B, "create", { name: "Empty" }), /^Created Empty\./);
    assert.equal(await anchor(await regionId(B, "Empty")), "global");
    assert.equal(await anchor("no-such-region"), "global");
    for (const name of ["Two states", "Cascadia", "Pacific Rim", "Barcelona area", "Empty"]) await say(B, "delete", { region: name });
  });

  test("/region set, /region show and /preview for a custom region: its own facts, Washington's commander stats", async () => {
    assert.match(await say(A, "create", { name: "Nothing yet" }), /^Created/);
    assert.equal(await say(A, "set", { region: "Nothing yet" }), "Nothing yet has no places yet. Add some with /region add, then run /region set again.");
    await say(A, "delete", { region: "Nothing yet" });

    const own = await complete(A, "set", "region", "seat");
    assert.deepEqual(own[0], { name: "Seattle Metro — this server", value: await regionId(A, "Seattle Metro") });
    assert.equal(await say(A, "set", { region: own[0]!.value }), [
      "Region set to Seattle Metro.",
      "Commander stats (most played, best results, conversion): Washington (United States), because Seattle Metro has too few entries with decklists. Events, winners and players are Seattle Metro's own.",
    ].join("\n"));
    const show = await say(A, "show");
    assert.match(show, /^Region: Seattle Metro\nPlaces \(1\): Tacoma, Washington, United States\nCommander stats \(most played, best results, conversion\): Washington \(United States\)/);
    assert.doesNotMatch(show, /Data provided by/, "configuration replies show no TopDeck data");

    const reply = await run(A, "preview");
    const embed = reply.embeds![0]!;
    assert.equal(embed.title, "Seattle Metro — cEDH meta, March 2034");
    assert.equal(embed.description, "Commander stats: Washington (United States), because Seattle Metro had too few entries.");
    const value = (prefix: string) => embed.fields.find((f) => f.name.replace(/^[^A-Za-z]+/, "").startsWith(prefix))?.value;
    assert.equal(value("Events"), "3", "three Tacoma events, not Washington's six");
    assert.equal(value("Most played — Washington (6 months)")!.split("\n").length, 10, "ten commanders from Washington");
    assert.equal(embed.fields.some((f) => /Rising commanders|Cooling commanders/.test(f.name)), false);
    assert.match(embed.fields.at(-1)!.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);

    // A custom region that is reportable itself uses its own entries everywhere.
    assert.equal(await say(A, "add", { place: "r:us-wa", region: "Seattle Metro" }), "Seattle Metro: added 1 place (2 of 25).\nAdded: Washington (United States)");
    assert.equal(await say(A, "set", { region: "Seattle Metro" }), "Region set to Seattle Metro.\nCommander stats: Seattle Metro's own entries.");
    const full = (await run(A, "preview")).embeds![0]!;
    assert.equal(full.description, undefined);
    assert.ok(full.fields.some((f) => f.name === "📊 Most played (6 months)"));
    assert.equal(await say(A, "remove", { place: "Washington (United States)", region: "Seattle Metro" }), "Seattle Metro: removed 1 place (1 left).\nRemoved: Washington (United States)");
  });

  test("isolation: another server can't see, set, change or delete a region, even with its id", async () => {
    const id = await regionId(A, "Seattle Metro");
    assert.deepEqual(await complete(B, "set", "region", "seattle"), [], "not offered in /region set");
    assert.deepEqual(await complete(B, "delete", "region", ""), []);
    assert.deepEqual(await complete(B, "remove", "place", "", { region: id }), []);
    assert.equal(await say(B, "set", { region: id }), "That isn't a region I can report on. Start typing and pick one from the list.");
    assert.equal(await say(B, "set", { region: "Seattle Metro" }), "That isn't a region I can report on. Start typing and pick one from the list.");
    assert.equal(await say(B, "add", { place: "r:us-or", region: id }), "This server has no custom region with that name. Use /region list to see them.");
    assert.equal(await say(B, "remove", { place: "p:1", region: id }), "This server has no custom region with that name. Use /region list to see them.");
    assert.equal(await say(B, "delete", { region: id }), "This server has no custom region with that name. Use /region list to see them.");
    assert.match(await say(B, "add", { place: `r:${id}` }), /^This server has no custom regions yet/);
    assert.equal((await sql`select 1 from guild_configs where guild_id = ${B}`).length, 0);
    // The database refuses too, whatever the application does.
    await assert.rejects(sql`insert into guild_configs (guild_id, region_id) values (${B}, ${id})`, /belongs to another server/);
    // Another server's region can't be a place either, and the same name is free on another server.
    assert.match(await say(B, "create", { name: "Seattle Metro" }), /^Created Seattle Metro\./);
    assert.ok((await say(B, "add", { place: `r:${id}` })).startsWith("Seattle Metro: nothing added (0 of 25 places).\nNot found: "));
    await assert.rejects(sql`insert into region_places (region_id, member_region_id) values (${await regionId(B, "Seattle Metro")}, ${id})`, /cannot be a member/);
    assert.deepEqual(await tids(await regionId(B, "Seattle Metro")), []);
    assert.deepEqual(await tids(id), ["tacoma1", "tacoma2", "tacoma3"], "server A's region is untouched");
    assert.equal(await say(B, "delete", { region: "Seattle Metro" }), "Deleted Seattle Metro.");
    assert.equal((await sql`select 1 from regions where id = ${id}`).length, 1);
  });

  test("limits: 5 regions per server, 25 places per region", async () => {
    const { REGION_CONFIG } = await import("../src/server/custom-regions");
    for (let i = 1; i <= REGION_CONFIG.maxRegionsPerGuild; i++) assert.match(await say(L, "create", { name: `Region ${i}` }), /^Created/);
    assert.equal(await say(L, "create", { name: "One too many" }), "A server can have up to 5 custom regions. Delete one with /region delete first.");
    // Fill Region 1 to one below the limit with made-up country codes, then add the last place and one more.
    const id = await regionId(L, "Region 1");
    await sql`
      insert into region_places (region_id, country_code, label)
      select ${id}, 'X' || chr(65 + g), 'Filler ' || g from generate_series(0, ${REGION_CONFIG.maxPlacesPerRegion - 2}) g`;
    assert.equal(await say(L, "add", { place: "r:us-wa", region: "Region 1" }), "Region 1: added 1 place (25 of 25).\nAdded: Washington (United States)");
    assert.equal(
      await say(L, "add", { place: "r:us-or", region: "Region 1" }),
      "Region 1: nothing added (25 of 25 places).\nNot added, the region is full (25 places): Oregon (United States). Remove a place with /region remove first.",
    );
    assert.equal(Number((await sql<{ n: string }[]>`select count(*) as n from region_places where region_id = ${id}`)[0]!.n), 25);
  });

  test("deleting the server's current region resets it to Global and says so", async () => {
    const id = await regionId(A, "Seattle Metro");
    assert.equal((await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${A}`)[0]!.region_id, id);
    assert.equal(await say(A, "delete", { region: "Seattle Metro" }), "Deleted Seattle Metro.\nIt was this server's region, so the region is now Global. Use /region set to choose another.");
    assert.equal((await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${A}`)[0]!.region_id, "global");
    assert.equal((await sql`select 1 from regions where id = ${id}`).length, 0);
    assert.equal((await sql`select 1 from region_places where region_id = ${id}`).length, 0);
    assert.match(await say(A, "show"), /^Region: Global\n/);
  });

  test("prune: when the bot leaves a server, its config and custom regions go; other servers keep theirs", async () => {
    const { runCron } = await import("../src/server/cron");
    await build(A, "Leaving", [["tac", "Tacoma, Washington, United States (3 events)"]]);
    await say(A, "set", { region: "Leaving" });
    await build(B, "Staying", [["tac", "Tacoma, Washington, United States (3 events)"]]);
    await say(B, "set", { region: "Staying" });
    // A server that created a region but never set a region or channel has no config row at all.
    await sql`insert into regions (id, display_name, type, source, selectable, owner_guild_id) values (${`g:${ORPHAN}:1`}, 'Orphan', 'custom', 'guild', false, ${ORPHAN})`;
    // The bot is still in B, in the limits-test server, and in every non-test server this database knows.
    const real = await sql<{ id: string }[]>`
      select guild_id as id from guild_configs where guild_id not like 'crtest-%'
      union select owner_guild_id from regions where owner_guild_id is not null and owner_guild_id not like 'crtest-%'`;
    guildIds = [B, L, "brtest-a", "brtest-b", "brtest-limit", ...real.map((r) => r.id)];
    const dry = await runCron({ sql, discord, allowlist: new Set<string>(), now }, { dryRun: true });
    assert.deepEqual(dry.pruned.filter((g) => g.startsWith("crtest-")), [A, ORPHAN]);
    assert.equal((await sql`select 1 from regions where owner_guild_id in (${A}, ${ORPHAN})`).length, 2, "a dry run deletes nothing");
    const summary = await runCron({ sql, discord, allowlist: new Set<string>(), now });
    assert.equal(summary.status, "ok");
    assert.equal(summary.pruneError, undefined);
    assert.deepEqual(summary.pruned.filter((g) => g.startsWith("crtest-")), [A, ORPHAN]);
    assert.equal((await sql`select 1 from guild_configs where guild_id = ${A}`).length, 0);
    assert.equal((await sql`select 1 from regions where owner_guild_id in (${A}, ${ORPHAN})`).length, 0);
    assert.equal((await sql`select 1 from region_places p join regions r on r.id = p.region_id where r.owner_guild_id = ${A}`).length, 0);
    assert.equal((await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${B}`)[0]!.region_id, await regionId(B, "Staying"));
    assert.equal((await sql`select 1 from regions where owner_guild_id = ${L}`).length, 5);
  });

  test("standard regions are untouched: the same tournaments as their members, and unknown ids match nothing", async () => {
    assert.deepEqual(await tids("us-wa"), ["spokane", "tacoma1", "tacoma2", "tacoma3", "vanwa", "wa-nocity"]);
    assert.deepEqual(await tids("europe"), ["bcn", "gent", "regionless", "utrecht"]);
    assert.equal((await tids("global")).length, 14);
    assert.deepEqual(await tids("no-such-region"), []);
    const [k] = await sql<{ a: string | null; b: string | null; c: string | null }[]>`select city_key('  New   York ') as a, city_key('   ') as b, city_key(null) as c`;
    assert.deepEqual({ ...k }, { a: "new york", b: null, c: null });
  });
});
