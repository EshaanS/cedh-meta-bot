// Bulk add and remove, and radius places, against a real Postgres with a fake Discord client. Skipped unless
// TEST_DATABASE_URL is set. Self-contained and separate from test/custom-regions-db.test.ts, which runs at the
// same time: tournaments here use ids starting with "test-br-" in June 2036, servers are "brtest-*", and the
// geography is southern Germany and Salzburg, so the standard regions this file inserts when missing (de, at,
// de-by, de-bw) are not the ones the other file inserts and removes.
// populated_places is shadowed by a temporary table of the same name for this file's connection (there is one
// connection, and a temporary table is found first), so the centers are the few rows below whether or not the
// real file has been loaded, and the loader test can replace the whole table.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe("bulk add, bulk remove and radius places against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  const A = "brtest-a", B = "brtest-b", L = "brtest-limit";
  const now = new Date(Date.UTC(2036, 6, 20)); // 20 July 2036: the previous month is June
  const MONTH = "2036-06-01";
  let insertedRegions: string[] = [];

  type Sent = { content?: string; embeds?: { title: string; description?: string; fields: { name: string; value: string }[] }[] };
  const edits: Sent[] = [];
  const discord = {
    createMessage: async () => {},
    editOriginal: async (_app: string, _token: string, payload: Sent) => { edits.push(payload); },
    listGuildIds: async () => [],
    putCommands: async () => null,
  };
  const deps = () => ({ sql: () => sql, discord, appId: "1", allowlist: "all" as const, now: () => now });
  type Opt = { name: string; type: number; value: string | number; focused?: boolean };
  const opt = (name: string, value: string | number): Opt => ({ name, type: typeof value === "number" ? 4 : 3, value });
  const run = async (guild: string, name: string, sub?: string, options: Opt[] = []): Promise<Sent> => {
    const { handleInteraction } = await import("../src/server/interactions");
    const r = await handleInteraction({ type: 2, token: "tok", guild_id: guild, data: { name, options: sub ? [{ name: sub, type: 1, options }] : undefined } }, deps());
    await r.background?.();
    return edits.at(-1)!;
  };
  const say = async (guild: string, sub: string, options: Record<string, string | number> = {}) =>
    (await run(guild, "region", sub, Object.entries(options).map(([name, value]) => opt(name, value)))).content ?? "";
  const complete = async (guild: string, sub: string, focused: string, typed: string, other: Record<string, string | number> = {}) => {
    const { handleInteraction } = await import("../src/server/interactions");
    const options: Opt[] = [...Object.entries(other).map(([name, value]) => opt(name, value)), { name: focused, type: 3, value: typed, focused: true }];
    const r = await handleInteraction({ type: 4, token: "tok", guild_id: guild, data: { name: "region", options: [{ name: sub, type: 1, options }] } }, deps());
    return (r.response as { data: { choices: { name: string; value: string }[] } }).data.choices;
  };
  /** The value Discord would send after picking the choice whose label matches. */
  const pick = async (guild: string, sub: string, focused: string, typed: string, label: string | RegExp, other: Record<string, string | number> = {}) => {
    const choices = await complete(guild, sub, focused, typed, other);
    const hit = choices.find((c) => (typeof label === "string" ? c.name === label : label.test(c.name)));
    assert.ok(hit, `no choice ${String(label)} for "${typed}" in ${JSON.stringify(choices.map((c) => c.name))}`);
    return hit.value;
  };
  const regionId = async (guild: string, name: string) =>
    (await sql<{ id: string }[]>`select id from regions where owner_guild_id = ${guild} and display_name = ${name}`)[0]?.id ?? "";
  const tids = async (id: string) =>
    (await sql<{ tid: string }[]>`select r.tid from region_tournament_ids(${id}) as r(tid) where r.tid like 'test-br-%' order by 1`).map((r) => r.tid.slice(8));
  const anchor = async (id: string) => (await sql<{ a: string }[]>`select custom_region_anchor(${id}) as a`)[0]!.a;
  const placeCount = async (id: string) => Number((await sql<{ n: string }[]>`select count(*) as n from region_places where region_id = ${id}`)[0]!.n);
  const MUNICH = "Munich, Bayern, Germany (metro pop. 1,275,000)";
  // Real data, when present, can add events to a city that is also a center; this file's own count is 1.
  const SALZBURG = /^Salzburg, Salzburg, Austria \(metro pop\. 206,279, \d+ events?\)$/;
  const ULM = /^Ulm, Baden-Württemberg, Germany \(\d+ events?\)$/;

  const seedCenters = async () => {
    await sql`delete from populated_places`;
    await sql`
      insert into populated_places (ne_id, name, name_ascii, country_code, country_name, admin1_code, admin1_name, lat, lng, pop_max, source_version) values
        (990001, 'Munich', 'Munich', 'DE', 'Germany', 'DE-BY', 'Bayern', 48.137, 11.575, 1275000, 'test'),
        (990002, 'Salzburg', 'Salzburg', 'AT', 'Austria', 'AT-5', 'Salzburg', 47.811, 13.055, 206279, 'test'),
        (990003, 'Frankfurt', 'Frankfurt', 'DE', 'Germany', 'DE-HE', 'Hessen', 50.11, 8.68, 2895000, 'test'),
        (990004, 'Frankfurt', 'Frankfurt', 'DE', 'Germany', 'DE-BB', 'Brandenburg', 52.34, 14.55, 58000, 'test'),
        (990005, 'Nowhere Rock', 'Nowhere Rock', null, null, null, null, 0, 0, 10, 'test')`;
    (await import("../src/server/custom-regions")).resetPlaceCache();
  };

  const cleanup = async () => {
    await sql`delete from guild_configs where guild_id like 'brtest-%'`;
    await sql`delete from regions where owner_guild_id like 'brtest-%'`;
    await sql`delete from tournaments where tid like 'test-br-%'`;
  };

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    await sql`create temporary table populated_places (like public.populated_places including all)`;
    await cleanup();
    await seedCenters();

    const standard: [id: string, name: string, type: string, parent: string, cc: string, a1: string | null][] = [
      ["de", "Germany", "country", "europe", "DE", null],
      ["at", "Austria", "country", "europe", "AT", null],
      ["de-by", "Bayern", "admin1", "de", "DE", "DE-BY"],
      ["de-bw", "Baden-Württemberg", "admin1", "de", "DE", "DE-BW"],
    ];
    for (const [id, name, type, parent, cc, a1] of standard) {
      const ins = await sql`
        insert into regions (id, display_name, type, parent_region_id, source, selectable)
        values (${id}, ${name}, ${type}, ${parent}, 'auto', true) on conflict (id) do nothing returning id`;
      if (ins.length === 0) continue;
      insertedRegions.push(id);
      await sql`insert into region_members (region_id, country_code, admin1_code) values (${id}, ${cc}, ${a1})`;
    }

    const BY = ["DE", "Germany", "DE-BY", "Bayern"] as const, BW = ["DE", "Germany", "DE-BW", "Baden-Württemberg"] as const;
    const event = (id: string, geo: readonly [string | null, string | null, string | null, string | null], city: string | null, lat: number | null, lng: number | null) => sql`
      insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class, city, lat, lng,
                               geo_country_code, geo_country_name, geo_admin1_code, geo_admin1_name)
      values (${`test-br-${id}`}, ${`Event ${id}`}, '2036-06-10T12:00:00Z', 20, 0, 'cedh', ${city}, ${lat}, ${lng}, ${geo[0]}, ${geo[1]}, ${geo[2]}, ${geo[3]})`;
    // Distances from Munich (48.137, 11.575): Garching 14 km, Freising 32 km, Augsburg 57 km.
    await event("garching", BY, "Garching", 48.249, 11.651);
    await event("freising", BY, "Freising", 48.403, 11.749);
    await event("augsburg", BY, "Augsburg", 48.371, 10.898);
    await event("big", BY, "  Garching ", null, null); // in Garching, but with no coordinates
    await event("neuulm", BY, "Neu-Ulm", 48.393, 10.011); // 2 km from Ulm, across the state line
    await event("ulm", BW, "Ulm", 48.401, 9.988);
    await event("stuttgart", BW, "Stuttgart", 48.775, 9.182);
    await event("neustadt-by", BY, "Neustadt", 48.81, 11.77);
    await event("neustadt-bw", BW, "Neustadt", 47.91, 8.21);
    await event("salzburg", ["AT", "Austria", "AT-5", "Salzburg"], "Salzburg", 47.811, 13.055);
    await event("freilassing", BY, "Freilassing", 47.84, 12.981); // 6 km from Salzburg, across the border
    await event("nowhere", [null, null, null, null], null, null, null);
    // Either side of the 180th meridian (Taveuni, Fiji), and one 100 km east. Not geocoded.
    await event("fiji-west", [null, null, null, null], null, -16.8, 179.9);
    await event("fiji-east", [null, null, null, null], null, -16.8, -179.95);
    await event("fiji-far", [null, null, null, null], null, -16.8, -179.0);
    // Two entries everywhere, and enough in the Garching event without coordinates (10 commanders x 10 entries)
    // to make Bayern and Germany reportable.
    await sql`
      insert into entries (tid, standing_index, leader, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
      select t.tid, g, 'Radius Commander ' || (g % 2), 3, 1, 1, 0, 3, 0, 1, 0
      from tournaments t cross join generate_series(0, 1) g where t.tid like 'test-br-%'`;
    await sql`
      insert into entries (tid, standing_index, leader, wins, draws, losses, byes, wins_swiss, wins_bracket, losses_swiss, losses_bracket)
      select 'test-br-big', 2 + g, 'Radius Commander ' || (g % 10), 3, 1, 1, 0, 3, 0, 1, 0 from generate_series(0, 99) g`;
  });

  after(async () => {
    await cleanup();
    for (const id of [...insertedRegions].reverse()) await sql`delete from regions where id = ${id}`;
    await sql.end();
  });

  test("haversine_km at known city pairs", async () => {
    const km = async (a: number | null, b: number, c: number, d: number) =>
      (await sql<{ km: number | null }[]>`select haversine_km(${a}::float8, ${b}::float8, ${c}::float8, ${d}::float8) as km`)[0]!.km;
    const near = (actual: number | null, expected: number, tolerance: number, what: string) =>
      assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} km, expected ${expected} ± ${tolerance}`);
    near(await km(47.6062, -122.3321, 47.2529, -122.4443), 40.2, 0.5, "Seattle to Tacoma");
    near(await km(47.6062, -122.3321, 49.2827, -123.1207), 195.3, 1, "Seattle to Vancouver, British Columbia");
    near(await km(40.7128, -74.006, 51.5074, -0.1278), 5570, 10, "New York to London");
    near(await km(48.137, 11.575, 48.137, 11.575), 0, 0.001, "the same point");
    near(await km(0, 179.5, 0, -179.5), 111.2, 0.2, "one degree across the antimeridian");
    near(await km(90, 0, -90, 0), 20015, 1, "pole to pole");
    near(await km(-16.8, 179.98, -16.8, -179.95), 7.5, 0.5, "across the antimeridian at Fiji's latitude");
    assert.equal(await km(null, 0, 0, 0), null);
  });

  test("centers: populated places and cities with events in one list, labelled with state, country, population or events", async () => {
    const names = async (typed: string) => (await complete(A, "add", "around", typed)).map((c) => c.name);
    assert.deepEqual((await names("munich")).filter((n) => n.startsWith("Munich,")), [MUNICH], "a city with no events of its own");
    assert.deepEqual((await names("frankfurt")).filter((n) => /metro pop/.test(n)).sort(), [
      "Frankfurt, Brandenburg, Germany (metro pop. 58,000)",
      "Frankfurt, Hessen, Germany (metro pop. 2,895,000)",
    ]);
    assert.ok((await names("garching")).some((n) => /^Garching, Bayern, Germany \(\d+ events?\)$/.test(n)), "a city known only from its events");
    assert.equal((await names("salzburg")).filter((n) => n.startsWith("Salzburg,")).length, 1, "the same city from both sources is one center");
    assert.match((await names("salzburg")).find((n) => n.startsWith("Salzburg,"))!, SALZBURG);
    assert.deepEqual(await names("nowhere rock"), [], "a place without a country can't be a center");
    assert.equal(await pick(A, "add", "around", "munich", MUNICH), "n:990001");
    assert.equal(await pick(A, "add", "around", "garching", /^Garching, Bayern, Germany/), "e:DE:DE-BY:garching");
    const all = await complete(A, "add", "around", "");
    assert.ok(all.length > 0 && all.length <= 25);
    for (const c of all) assert.ok(c.name.length <= 100 && c.value.length <= 100);
    // The place options still list only cities with events: Munich can be a center, not a place.
    assert.deepEqual((await complete(A, "add", "place", "munich")).filter((c) => c.name.startsWith("Munich")), []);
  });

  test("a radius is one place; events belong by distance, and events without coordinates never do", async () => {
    assert.match(await say(A, "create", { name: "Munich area" }), /^Created Munich area\./);
    const munich = await pick(A, "add", "around", "mun", MUNICH);
    assert.equal(await say(A, "add", { around: munich, km: 30 }), "Munich area: added 1 place (1 of 25).\nAdded: within 30 km of Munich, Bayern, Germany");
    const id = await regionId(A, "Munich area");
    assert.deepEqual(await tids(id), ["garching"], "Freising is 32 km away, and the other Garching event has no coordinates");
    // Left out, the distance is the default.
    assert.equal(await say(A, "add", { around: munich }), "Munich area: added 1 place (2 of 25).\nAdded: within 50 km of Munich, Bayern, Germany");
    assert.deepEqual(await tids(id), ["freising", "garching"]);
    // Written in the list, with the center typed.
    assert.equal(await say(A, "add", { list: "within 60km of munich BY" }), "Munich area: added 1 place (3 of 25).\nAdded: within 60 km of Munich, Bayern, Germany");
    assert.deepEqual(await tids(id), ["augsburg", "freising", "garching"], "three overlapping circles, each event once");
    assert.equal(await placeCount(id), 3);
    assert.equal(await say(A, "add", { around: munich, km: 30 }), "Munich area: nothing added (3 of 25 places).\nAlready in the region: within 30 km of Munich, Bayern, Germany");
    // Discord enforces the range on the km option; the server checks again.
    for (const km of [5, 201, 12.5]) {
      assert.equal(await say(A, "add", { around: munich, km }), `Munich area: nothing added (3 of 25 places).\nCan't be used: "${km} km of Munich, Bayern, Germany" (a radius must be 10 to 200 km)`);
    }
    assert.equal(await say(A, "add", { list: "500 km of Munich" }), 'Munich area: nothing added (3 of 25 places).\nCan\'t be used: "500 km of Munich" (a radius must be 10 to 200 km)');
    assert.equal(await say(A, "add", { km: 40 }), 'Munich area: nothing added (3 of 25 places).\nCan\'t be used: "40 km" (choose a city in the around option to put the radius around)');
    // A typed center is matched like a typed place: never guessed.
    const frankfurt = await say(A, "add", { around: "Frankfurt", km: 20 });
    assert.match(frankfurt, /^Munich area: nothing added \(3 of 25 places\)\.\nMore than one match, not added:\n• "Frankfurt" could be Frankfurt, Brandenburg, Germany \(metro pop\. 58,000\) or Frankfurt, Hessen, Germany \(metro pop\. 2,895,000\)\./);
    assert.equal(
      await say(A, "add", { around: "Qqqville" }),
      'Munich area: nothing added (3 of 25 places).\nNot found: "Qqqville" (no city by that name to put a radius around; start typing in the around option to see which exist)',
    );
    assert.match(await say(A, "add", { list: "30 km of Qqqville" }), /\nNot found: "30 km of Qqqville" \(no city by that name to put a radius around/);
    assert.match(await say(A, "add", { around: "n:123456789" }), /^Munich area: nothing added \(3 of 25 places\)\.\nNot found: "50 km of the chosen city"/);
    assert.equal(await placeCount(id), 3);

    // /region list and /region show describe a radius in words.
    assert.equal(await say(A, "list"), [
      "Custom regions (1 of 5):",
      "• Munich area: within 30 km of Munich, Bayern, Germany; within 50 km of Munich, Bayern, Germany; within 60 km of Munich, Bayern, Germany",
    ].join("\n"));
    await say(A, "set", { region: "Munich area" });
    const show = await say(A, "show");
    assert.match(show, /^Region: Munich area\nPlaces \(3\): within 30 km of Munich, Bayern, Germany; within 50 km of Munich, Bayern, Germany; within 60 km of Munich, Bayern, Germany\nChannel: /);
    assert.doesNotMatch(show, /Data provided by/, "configuration replies show no TopDeck data");

    // The stored center never moves, and the database refuses a malformed radius.
    const [row] = await sql<{ center_lat: number; center_lng: number; radius_km: number; country_code: string; admin1_code: string; min_lat: number; max_lat: number }[]>`
      select center_lat, center_lng, radius_km, country_code, admin1_code, min_lat, max_lat from region_places where region_id = ${id} and radius_km = 30`;
    assert.deepEqual({ ...row, min_lat: Math.round(row!.min_lat * 100) / 100, max_lat: Math.round(row!.max_lat * 100) / 100 },
      { center_lat: 48.137, center_lng: 11.575, radius_km: 30, country_code: "DE", admin1_code: "DE-BY", min_lat: 47.87, max_lat: 48.41 });
    await assert.rejects(sql`insert into region_places (region_id, country_code, label, center_lat, center_lng, radius_km) values (${id}, 'DE', 'x', 48, 11, 5000)`, /region_places_shape/);
    await assert.rejects(sql`insert into region_places (region_id, country_code, label, center_lat, radius_km) values (${id}, 'DE', 'x', 48, 30)`, /region_places_shape/);
    await assert.rejects(sql`insert into region_places (region_id, country_code, label, center_lat, center_lng, radius_km) values (${id}, 'DE', 'x', 48.137, 11.575, 30)`, /region_places_radius_idx/);
  });

  test("a radius across a border takes the events on both sides", async () => {
    assert.match(await say(A, "create", { name: "Salzburg area" }), /^Created/);
    const reply = await say(A, "add", { around: await pick(A, "add", "around", "salz", SALZBURG), km: 20, region: "Salzburg area" });
    assert.equal(reply, "Salzburg area: added 1 place (1 of 25).\nAdded: within 20 km of Salzburg, Salzburg, Austria");
    assert.deepEqual(await tids(await regionId(A, "Salzburg area")), ["freilassing", "salzburg"], "Freilassing is in Germany");
  });

  test("a radius with a state and a city: every event counted once", async () => {
    assert.match(await say(A, "create", { name: "Bayern plus" }), /^Created/);
    const reply = await say(A, "add", {
      place: await pick(A, "add", "place", "bayern", "Bayern (Germany)"),
      place2: await pick(A, "add", "place2", "garch", "Garching, Bayern, Germany (2 events)"),
      around: "Munich",
      km: 60,
      region: "Bayern plus",
    });
    assert.equal(reply, "Bayern plus: added 3 places (3 of 25).\nAdded: Bayern (Germany); Garching, Bayern, Germany; within 60 km of Munich, Bayern, Germany");
    const id = await regionId(A, "Bayern plus");
    assert.deepEqual(await tids(id), ["augsburg", "big", "freilassing", "freising", "garching", "neustadt-by", "neuulm"]);
    const [n] = await sql<{ rows: string; distinct_rows: string }[]>`
      select count(*) as rows, count(distinct r.tid) as distinct_rows from region_tournament_ids(${id}) as r(tid)`;
    assert.equal(n!.rows, n!.distinct_rows, "no tournament twice");
    // The city alone includes its event without coordinates; the radius alone doesn't.
    assert.equal(await say(A, "remove", { list: "Bayern; 60 km of Munich", region: "Bayern plus" }), "Bayern plus: removed 2 places (1 left).\nRemoved: Bayern (Germany); within 60 km of Munich, Bayern, Germany");
    assert.deepEqual(await tids(id), ["big", "garching"]);
    assert.equal(await say(A, "delete", { region: "Bayern plus" }), "Deleted Bayern plus.");
  });

  test("the bounding box doesn't cut a circle at the antimeridian", async () => {
    assert.match(await say(A, "create", { name: "Taveuni" }), /^Created/);
    const id = await regionId(A, "Taveuni");
    await sql`insert into region_places (region_id, country_code, label, center_lat, center_lng, radius_km) values (${id}, 'FJ', 'within 20 km of Taveuni', -16.8, 179.98, 20)`;
    const [box] = await sql<{ min_lng: number; max_lng: number }[]>`select min_lng, max_lng from region_places where region_id = ${id}`;
    assert.ok(box!.min_lng < 179.9 && box!.max_lng > 180, JSON.stringify(box));
    assert.deepEqual(await tids(id), ["fiji-east", "fiji-west"], "both sides of 180°, and not the event 100 km away");
    assert.equal(await say(A, "delete", { region: "Taveuni" }), "Deleted Taveuni.");
  });

  test("bulk add: added, already present, ambiguous, could be one or several, not found, invalid and full, in one reply each", async () => {
    assert.match(await say(A, "create", { name: "Bulk" }), /^Created Bulk\./);
    const garching = await pick(A, "add", "place", "garch", "Garching, Bayern, Germany (2 events)", { region: "Bulk" });
    // A place picked in one option isn't offered in the next.
    assert.deepEqual((await complete(A, "add", "place2", "garch", { place: garching, region: "Bulk" })).filter((c) => c.name.startsWith("Garching")), []);
    assert.equal((await complete(A, "add", "place5", "garch", { region: "Bulk" })).filter((c) => c.name.startsWith("Garching")).length, 1);

    const reply = await say(A, "add", {
      place: garching,
      place2: "Ulm BW",
      place3: garching,
      list: "Augsburg, garching, Neustadt, Neustadt BY, Qqqville, Munich, 40 km of Munich, 500 km of Munich, Salzburg, AT",
      region: "Bulk",
    });
    assert.equal(reply, [
      "Bulk: added 6 places (6 of 25).",
      "Added: Garching, Bayern, Germany; Ulm, Baden-Württemberg, Germany; Augsburg, Bayern, Germany; Neustadt, Bayern, Germany; within 40 km of Munich, Bayern, Germany; Salzburg, Salzburg, Austria",
      "Already in the region: Garching, Bayern, Germany",
      "More than one match, not added:",
      '• "Neustadt" could be Neustadt, Baden-Württemberg, Germany or Neustadt, Bayern, Germany.',
      'Add the state or country, for example "Vancouver BC", or pick from the list that appears as you type.',
      'Not found: "Qqqville"; "Munich" (no events there in the last 12 months; for the area around it use the around option)',
      "Cities are listed only when they have events in the data. Start typing in a place option to see what exists.",
      'Can\'t be used: "500 km of Munich" (a radius must be 10 to 200 km)',
    ].join("\n"));
    const id = await regionId(A, "Bulk");
    assert.equal(await placeCount(id), 6);
    assert.deepEqual(await tids(id), ["augsburg", "big", "freising", "garching", "neustadt-by", "salzburg", "ulm"]);

    // In a comma list a full state name after a city could be a second place: reported, nothing added.
    assert.equal(await say(A, "add", { list: "Stuttgart, Baden-Württemberg", region: "Bulk" }), [
      "Bulk: nothing added (6 of 25 places).",
      "Could be one place or several, not added:",
      '• "Stuttgart, Baden-Württemberg" could be Stuttgart, Baden-Württemberg, Germany, or separate places.',
      'Put semicolons between places, for example "Portland, Oregon; Tacoma, Washington".',
    ].join("\n"));
    // With semicolons, or with the state's code, or typed into a place option, it is one place. Accents are optional.
    assert.equal(
      await say(A, "add", { list: "Stuttgart, Baden-Wurttemberg; ULM, bw", region: "Bulk" }),
      "Bulk: added 1 place (7 of 25).\nAdded: Stuttgart, Baden-Württemberg, Germany\nAlready in the region: Ulm, Baden-Württemberg, Germany",
    );
    assert.equal(await say(A, "add", { place: "Neustadt, Baden-Württemberg", region: "Bulk" }), "Bulk: added 1 place (8 of 25).\nAdded: Neustadt, Baden-Württemberg, Germany");
    assert.equal(await say(A, "add", { list: "Neustadt, Baden-Württemberg, Germany", region: "Bulk" }), "Bulk: nothing added (8 of 25 places).\nAlready in the region: Neustadt, Baden-Württemberg, Germany", "a label pasted from the list");

    // The limit: what fits is added in order, the rest is named.
    await sql`
      insert into region_places (region_id, country_code, label)
      select ${id}, 'X' || chr(65 + g), 'Filler ' || g from generate_series(1, 16) g`;
    assert.equal(await say(A, "add", { list: "Freising, Neu-Ulm, Austria", region: "Bulk" }), [
      "Bulk: added 1 place (25 of 25).",
      "Added: Freising, Bayern, Germany",
      "Not added, the region is full (25 places): Neu-Ulm, Bayern, Germany; Austria. Remove a place with /region remove first.",
    ].join("\n"));
    assert.equal(await placeCount(id), 25);
    // A place already there is still reported as present when the region is full.
    assert.equal(await say(A, "add", { list: "Freising; Freilassing", region: "Bulk" }), [
      "Bulk: nothing added (25 of 25 places).",
      "Already in the region: Freising, Bayern, Germany",
      "Not added, the region is full (25 places): Freilassing, Bayern, Germany. Remove a place with /region remove first.",
    ].join("\n"));
    assert.match(await say(A, "add", { region: "Bulk" }), /^Nothing to add yet\. Use one or more of these options:/);
    await sql`delete from region_places where region_id = ${id} and label like 'Filler %'`;
  });

  test("bulk remove: several places by pick and by name, with the same matching", async () => {
    const id = await regionId(A, "Bulk");
    const choices = await complete(A, "remove", "place", "", { region: "Bulk" });
    assert.deepEqual(choices.map((c) => c.name), [
      "Augsburg, Bayern, Germany", "Freising, Bayern, Germany", "Garching, Bayern, Germany", "Neustadt, Baden-Württemberg, Germany", "Neustadt, Bayern, Germany",
      "Salzburg, Salzburg, Austria", "Stuttgart, Baden-Württemberg, Germany", "Ulm, Baden-Württemberg, Germany", "within 40 km of Munich, Bayern, Germany",
    ]);
    const garching = choices.find((c) => c.name.startsWith("Garching"))!.value;
    assert.ok(!(await complete(A, "remove", "place2", "", { place: garching, region: "Bulk" })).some((c) => c.value === garching), "not offered twice");

    assert.equal(await say(A, "remove", { place: garching, place2: "Ulm", list: "Augsburg, 40 km of Munich, Qqqville, Neustadt, Salzburg AT", region: "Bulk" }), [
      "Bulk: removed 5 places (4 left).",
      "Removed: Augsburg, Bayern, Germany; Garching, Bayern, Germany; Salzburg, Salzburg, Austria; Ulm, Baden-Württemberg, Germany; within 40 km of Munich, Bayern, Germany",
      "More than one match, not removed:",
      '• "Neustadt" could be Neustadt, Baden-Württemberg, Germany or Neustadt, Bayern, Germany.',
      'Not in Bulk: "Qqqville". Pick from the list that appears as you type.',
    ].join("\n"));
    assert.equal(await placeCount(id), 4);
    assert.equal(
      await say(A, "remove", { list: "Neustadt, Baden-Württemberg, Neustadt BY", region: "Bulk" }),
      "Bulk: removed 2 places (2 left).\nRemoved: Neustadt, Baden-Württemberg, Germany; Neustadt, Bayern, Germany",
    );
    assert.equal(await say(A, "remove", { place: garching, region: "Bulk" }), `Bulk: nothing removed (2 places).\nNot in Bulk: "${garching}". Pick from the list that appears as you type.`);
    assert.equal(await say(A, "remove", { list: "Freising; Stuttgart, BW", region: "Bulk" }), [
      "Bulk: removed 2 places (0 left).",
      "Removed: Freising, Bayern, Germany; Stuttgart, Baden-Württemberg, Germany",
      "Bulk has no places left, so its reports will have no events until you add some.",
    ].join("\n"));
    assert.equal(await say(A, "remove", { region: "Bulk" }), "Nothing to remove yet. Pick places in the place options, or type several in the list option.");
    assert.equal(await say(A, "delete", { region: "Bulk" }), "Deleted Bulk.");
  });

  // Posts no longer borrow from a larger region, so the app doesn't call custom_region_anchor any more. The
  // function stays in the database and must keep returning what it did; a radius post shows the circle only.
  test("a radius: custom_region_anchor is unchanged, and the post is about the events inside the circle only", async () => {
    // Every event within 60 km of Munich is in Bayern.
    const munich = await regionId(A, "Munich area");
    assert.equal(await anchor(munich), "de-by");

    // Ulm is in Baden-Württemberg; Neu-Ulm, 2 km away, is in Bayern. The stats can't be labelled with either state.
    assert.match(await say(A, "create", { name: "Donau" }), /^Created/);
    assert.equal(
      await say(A, "add", { around: await pick(A, "add", "around", "ulm", ULM), km: 30, region: "Donau" }),
      "Donau: added 1 place (1 of 25).\nAdded: within 30 km of Ulm, Baden-Württemberg, Germany",
    );
    const donau = await regionId(A, "Donau");
    assert.deepEqual(await tids(donau), ["neuulm", "ulm"]);
    assert.equal(await anchor(donau), "de");
    assert.equal(await say(A, "set", { region: "Donau" }), "Region set to Donau.");
    assert.doesNotMatch(await say(A, "show"), /Commander stats|not enough data|Reports currently show/);
    const preview = (await run(A, "preview")).embeds!;
    const embed = preview[0]!;
    const all = preview.flatMap((e) => e.fields);
    assert.equal(embed.title, "Donau — cEDH meta, June 2036");
    const field = (prefix: string) => all.find((f) => f.name.replace(/^[^A-Za-z]+/, "").startsWith(prefix));
    assert.equal(field("Events")?.value, "2", "the two events inside the circle");
    assert.equal(field("Coverage")?.value.split(" · ")[0], "2 qualifying events in June");
    // Nothing from Germany or from anywhere outside the circle: no note, no region in a header, one month only.
    assert.doesNotMatch(JSON.stringify(preview), /Commander stats|Germany|6 months|Showing /);
    for (const f of all) assert.doesNotMatch(f.name, / — (?!June)/, f.name);
    assert.match(all.at(-1)!.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);

    // Salzburg is in Austria; Freilassing, inside the circle, is in Germany.
    assert.equal(await anchor(await regionId(A, "Salzburg area")), "europe");
    // A radius with other places: the smallest region that holds all of them.
    assert.equal(await say(A, "add", { list: "Stuttgart", region: "Munich area" }), "Munich area: added 1 place (4 of 25).\nAdded: Stuttgart, Baden-Württemberg, Germany");
    assert.equal(await anchor(munich), "de");
    assert.equal(await say(A, "remove", { list: "Stuttgart", region: "Munich area" }), "Munich area: removed 1 place (3 left).\nRemoved: Stuttgart, Baden-Württemberg, Germany");
    assert.equal(await anchor(munich), "de-by");
    // The anchor follows the data: an event across the state line, inside the 60 km circle, moves it up.
    await sql`
      insert into tournaments (tid, name, start_date, participant_count, top_cut, event_class, city, lat, lng, geo_country_code, geo_country_name, geo_admin1_code, geo_admin1_name)
      values ('test-br-moved', 'Event moved', '2036-06-11T12:00:00Z', 20, 0, 'cedh', 'Elsewhere', 48.2, 11.3, 'DE', 'Germany', 'DE-BW', 'Baden-Württemberg')`;
    assert.equal(await anchor(munich), "de");
    await sql`delete from tournaments where tid = 'test-br-moved'`;
    assert.equal(await anchor(munich), "de-by");
  });

  test("isolation and limits still hold with bulk commands", async () => {
    const { REGION_CONFIG } = await import("../src/server/custom-regions");
    const mine = await regionId(A, "Munich area");
    const [place] = await sql<{ id: string }[]>`select id::text as id from region_places where region_id = ${mine} order by id limit 1`;
    // Another server can't reach the region by id, by name, or through a place id.
    assert.equal(await say(B, "add", { list: "Garching, Augsburg", region: mine }), "This server has no custom region with that name. Use /region list to see them.");
    assert.equal(await say(B, "remove", { list: "30 km of Munich", region: "Munich area" }), "This server has no custom region with that name. Use /region list to see them.");
    assert.deepEqual(await complete(B, "remove", "place3", "", { region: mine }), []);
    assert.match(await say(B, "create", { name: "Munich area" }), /^Created Munich area\./);
    assert.equal(await say(B, "remove", { place: `p:${place!.id}`, list: "30 km of Munich" }), `Munich area: nothing removed (0 places).\nNot in Munich area: "p:${place!.id}"; "30 km of Munich". Pick from the list that appears as you type.`);
    assert.equal(await placeCount(mine), 3, "server A's places are untouched");
    assert.equal(await say(B, "add", { list: "Garching; 30 km of Munich", place: `r:${mine}` }).then((r) => r.split("\n")[0]), "Munich area: added 2 places (2 of 25).");
    assert.deepEqual(await tids(await regionId(B, "Munich area")), ["big", "garching"]);
    assert.equal(await placeCount(mine), 3);
    await assert.rejects(sql`insert into region_places (region_id, member_region_id) values (${await regionId(B, "Munich area")}, ${mine})`, /cannot be a member/);

    // 25 places per region: one command can't pass it, and a radius counts as one place.
    assert.match(await say(L, "create", { name: "Full" }), /^Created/);
    const full = await regionId(L, "Full");
    await sql`
      insert into region_places (region_id, country_code, label)
      select ${full}, 'X' || chr(65 + g), 'Filler ' || g from generate_series(1, ${REGION_CONFIG.maxPlacesPerRegion - 2}) g`;
    assert.equal(await say(L, "add", { place: "Garching", place2: "Augsburg", place3: "Freising", place4: "Ulm", place5: "Stuttgart", list: "Salzburg; Austria", around: "Munich", km: 100 }), [
      "Full: added 2 places (25 of 25).",
      "Added: Garching, Bayern, Germany; Augsburg, Bayern, Germany",
      "Not added, the region is full (25 places): Freising, Bayern, Germany; Ulm, Baden-Württemberg, Germany; Stuttgart, Baden-Württemberg, Germany; Salzburg, Salzburg, Austria; Austria; within 100 km of Munich, Bayern, Germany. Remove a place with /region remove first.",
    ].join("\n"));
    assert.equal(await placeCount(full), REGION_CONFIG.maxPlacesPerRegion);
    // 5 regions per server.
    for (let k = 2; k <= REGION_CONFIG.maxRegionsPerGuild; k++) assert.match(await say(L, "create", { name: `Region ${k}` }), /^Created/);
    assert.equal(await say(L, "create", { name: "One too many" }), "A server can have up to 5 custom regions. Delete one with /region delete first.");
  });

  test("standard regions and a region without a radius behave as before", async () => {
    assert.deepEqual(await tids("de-by"), ["augsburg", "big", "freilassing", "freising", "garching", "neustadt-by", "neuulm"]);
    assert.deepEqual(await tids("de-bw"), ["neustadt-bw", "stuttgart", "ulm"]);
    assert.deepEqual(await tids("at"), ["salzburg"]);
    assert.deepEqual(await tids("no-such-region"), []);
    assert.equal(await anchor("no-such-region"), "global");
    const [std] = await sql<{ a: string; b: string; c: string; d: string }[]>`
      select standard_region_for('DE', 'DE-BY') as a, standard_region_for('DE', 'DE-XX') as b, standard_region_for('AT', 'AT-5') as c, standard_region_for('ZZ', null) as d`;
    assert.deepEqual({ ...std }, { a: "de-by", b: "de", c: "at", d: "global" });
  });

  test("loading populated places: whitelisted fields, replaced as a whole, idempotent, and never emptied by a bad file", async () => {
    const { parsePlaces, storePlaces, PLACES_VERSION } = await import("../scripts/lib/places");
    const { NO_GEO } = await import("../scripts/lib/geo");
    const feature = (ne_id: unknown, name: unknown, lng: unknown, lat: unknown, extra: Record<string, unknown> = {}) =>
      ({ type: "Feature", properties: { ne_id, name, nameascii: name, pop_max: 1000, adm0name: "NE country", adm1name: "NE state", iso_a2: "-99", ...extra }, geometry: { type: "Point", coordinates: [lng, lat] } });
    const raw = JSON.stringify({ type: "FeatureCollection", features: [
      feature(990101, "Passau", 13.43, 48.57, { pop_max: 50000, wikidataid: "Q4190", note: "dropped" }),
      feature(990102, "Linz", 14.29, 48.31, { pop_max: 349161 }),
      feature(990103, "Qqqville", -30, 30, { pop_max: -99 }),
      feature(990104, "", 1, 1),
      feature("x", "No id", 1, 1),
      feature(990105, "Off the map", 500, 1),
      { type: "Feature", properties: { ne_id: 990106, name: "No point" }, geometry: null },
    ] });
    // A stand-in for the admin-1 lookup: east of 14° is Austria, the Atlantic matches nothing.
    const lookup = (lng: number, _lat: number) =>
      lng < 0 ? { geo: null, source: "unmatched" as const }
      : lng > 14 ? { geo: { ...NO_GEO, countryCode: "AT", countryName: "Austria", admin1Code: "AT-4", admin1Name: "Oberösterreich" }, source: "nearby" as const }
      : { geo: { ...NO_GEO, countryCode: "DE", countryName: "Germany", admin1Code: "DE-BY", admin1Name: "Bayern" }, source: "exact" as const };
    const parsed = parsePlaces(raw, lookup);
    assert.deepEqual({ rows: parsed.rows.length, skipped: parsed.skipped, geocoded: parsed.geocoded }, { rows: 3, skipped: 4, geocoded: { exact: 1, nearby: 1, unmatched: 1 } });
    assert.deepEqual(parsed.rows[0], {
      ne_id: 990101, name: "Passau", name_ascii: "Passau", country_code: "DE", country_name: "Germany", admin1_code: "DE-BY", admin1_name: "Bayern",
      lat: 48.57, lng: 13.43, pop_max: 50000, source_version: PLACES_VERSION,
    }, "only the whitelisted fields, with our own codes");
    assert.deepEqual([parsed.rows[2]!.country_code, parsed.rows[2]!.country_name, parsed.rows[2]!.pop_max], [null, "NE country", null], "no polygon: Natural Earth's names, no codes");
    assert.throws(() => parsePlaces("{}", lookup), /FeatureCollection/);

    // The guard: a short file writes nothing (the table still has this file's centers).
    await assert.rejects(storePlaces(sql, parsed.rows), /only 3 rows/);
    assert.equal(Number((await sql<{ n: string }[]>`select count(*) as n from populated_places`)[0]!.n), 5);
    assert.deepEqual(await storePlaces(sql, parsed.rows, 1), { stored: 3, removed: 5 });
    assert.deepEqual(await storePlaces(sql, parsed.rows, 1), { stored: 3, removed: 0 }, "running it again changes nothing");
    assert.deepEqual(await storePlaces(sql, parsed.rows.slice(0, 2), 1), { stored: 2, removed: 1 });
    assert.deepEqual((await sql<{ name: string }[]>`select name from populated_places order by ne_id`).map((r) => r.name), ["Passau", "Linz"]);

    // The app reads the table, never the file: the new centers are offered, the old ones are gone.
    const { resetPlaceCache } = await import("../src/server/custom-regions");
    resetPlaceCache();
    const names = async (typed: string) => (await complete(A, "add", "around", typed)).map((c) => c.name);
    assert.deepEqual((await names("passau")).filter((n) => n.startsWith("Passau,")), ["Passau, Bayern, Germany (metro pop. 50,000)"]);
    assert.deepEqual((await names("munich")).filter((n) => n.startsWith("Munich,")), []);
    // With an empty table only cities with events are centers.
    await sql`delete from populated_places`;
    resetPlaceCache();
    assert.deepEqual((await names("passau")).filter((n) => n.startsWith("Passau,")), []);
    assert.match((await names("salzburg")).find((n) => n.startsWith("Salzburg,"))!, /^Salzburg, Salzburg, Austria \(\d+ events?\)$/);
    await seedCenters();
  });
});
