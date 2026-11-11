// Custom regions, the parts that need no database: command definitions against Discord's limits, name
// cleaning, and autocomplete matching.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "../src/server/commands";
import { cleanRegionName, matchPlaces, REGION_CONFIG, RegionError, type PlaceOption } from "../src/server/custom-regions";
import { matchGuildRegions } from "../src/server/interactions";

type Def = { type?: number; name: string; description: string; required?: boolean; autocomplete?: boolean; choices?: unknown; options?: readonly Def[] };

test("/region has the custom-region subcommands, within Discord's limits", () => {
  const region = COMMANDS.find((c) => c.name === "region") as unknown as Def;
  assert.deepEqual(region.options!.map((o) => o.name), ["set", "show", "create", "add", "remove", "delete", "list"]);
  const optionNames = (sub: string) => region.options!.find((o) => o.name === sub)!.options?.map((o) => `${o.name}${o.required ? "" : "?"}`) ?? [];
  assert.deepEqual(optionNames("create"), ["name"]);
  assert.deepEqual(optionNames("add"), ["place", "region?"]);
  assert.deepEqual(optionNames("remove"), ["place", "region?"]);
  assert.deepEqual(optionNames("delete"), ["region"]);
  assert.deepEqual(optionNames("list"), []);

  // Discord: names 1-32 lower-case characters, descriptions 1-100, at most 25 options, required options
  // first, unique names per level, no choices on an autocomplete option, and at most 8,000 characters of
  // names, descriptions and values per command.
  for (const command of COMMANDS as unknown as Def[]) {
    let size = 0;
    const check = (o: Def, depth: number) => {
      assert.match(o.name, /^[-_\p{Ll}\p{N}]{1,32}$/u, o.name);
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${o.name}: ${o.description.length} characters`);
      size += o.name.length + o.description.length;
      const options = o.options ?? [];
      assert.ok(options.length <= 25, o.name);
      assert.equal(new Set(options.map((x) => x.name)).size, options.length, `${o.name}: duplicate option names`);
      const firstOptional = options.findIndex((x) => x.type !== 1 && !x.required);
      if (firstOptional >= 0) assert.ok(options.slice(firstOptional).every((x) => !x.required), `${o.name}: required option after an optional one`);
      if (o.autocomplete) assert.equal(o.choices, undefined);
      assert.ok(depth <= 2);
      for (const x of options) check(x, depth + 1);
    };
    check(command, 0);
    assert.ok(size <= 8000, `${command.name}: ${size} characters`);
  }
  assert.equal(REGION_CONFIG.choiceMax, 25);
});

test("cleanRegionName: cleaned like event names, and rejected when empty or too long", () => {
  assert.equal(cleanRegionName("  Seattle   Metro "), "Seattle Metro");
  assert.equal(cleanRegionName("Pacific Northwest+"), "Pacific Northwest+");
  assert.equal(cleanRegionName("@everyone **Big** <@&123> __Metro__ ~~x~~ `y` |z| [a](https://evil.example/b)"), "everyone Big &123 Metro x y z a(");
  assert.equal(cleanRegionName("join discord.gg/abc123 Metro"), "join Metro");
  assert.equal(cleanRegionName("x".repeat(REGION_CONFIG.nameMax)), "x".repeat(40));
  for (const bad of ["", "   ", "***", "<@1>".replace(/1/, ""), "https://only.a.link", null, 42, undefined]) {
    assert.throws(() => cleanRegionName(bad), RegionError, String(bad));
  }
  assert.throws(() => cleanRegionName("x".repeat(REGION_CONFIG.nameMax + 1)), /up to 40 characters/);
  // Nothing that could mention, link or format survives.
  for (const ch of ["@", "<", ">", "*", "_", "~", "`", "|", "[", "]"]) assert.ok(!cleanRegionName(`a${ch}b ${ch}c${ch}`).includes(ch), ch);
});

test("matchPlaces: prefix first, regions before cities, busier cities first, accent-insensitive, at most 25", () => {
  const city = (plain: string, events: number, value: string): PlaceOption =>
    ({ value, label: `${plain} (${events} events)`, plain, search: plain.toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""), rank: 6, events });
  const rows: PlaceOption[] = [
    city("Vancouver, Washington, United States", 3, "c:US:US-WA:vancouver"),
    city("Vancouver, British Columbia, Canada", 48, "c:CA:CA-BC:vancouver"),
    city("North Vancouver, British Columbia, Canada", 60, "c:CA:CA-BC:north vancouver"),
    city("Barberà del Vallès, Barcelona, Spain", 32, "c:ES:ES-B:barberà del vallès"),
    { value: "r:us-wa", label: "Washington (United States)", plain: "Washington (United States)", search: "washington (united states) us-wa", rank: 5, events: 0 },
    { value: "r:europe", label: "Europe", plain: "Europe", search: "europe europe", rank: 1, events: 0 },
    ...Array.from({ length: 40 }, (_, k) => city(`Filler ${k}, Somewhere`, k, `c:XX::filler ${k}`)),
  ];
  assert.deepEqual(matchPlaces(rows, "vanc").map((c) => c.name), [
    "North Vancouver, British Columbia, Canada (60 events)",
    "Vancouver, British Columbia, Canada (48 events)",
    "Vancouver, Washington, United States (3 events)",
  ]);
  // The state comes before cities that merely are in it.
  assert.deepEqual(matchPlaces(rows, "washington").map((c) => c.value), ["r:us-wa", "c:US:US-WA:vancouver"]);
  assert.deepEqual(matchPlaces(rows, "barbera").map((c) => c.value), ["c:ES:ES-B:barberà del vallès"]);
  assert.deepEqual(matchPlaces(rows, "seattle"), [], "a city with no events isn't offered");
  assert.equal(matchPlaces(rows, "").length, 25);
  assert.equal(matchPlaces(rows, "")[0]!.value, "r:europe");
  for (const c of matchPlaces(rows, "")) assert.ok(c.name.length <= 100 && c.value.length <= 100);
});

test("matchGuildRegions: a server's own regions, marked in the /region set list", () => {
  const rows = [{ id: "g:1:aa", name: "Seattle Metro", places: 2 }, { id: "g:1:bb", name: "Benelux", places: 3 }];
  assert.deepEqual(matchGuildRegions(rows, "sea", " — this server"), [{ name: "Seattle Metro — this server", value: "g:1:aa" }]);
  assert.deepEqual(matchGuildRegions(rows, "").map((c) => c.name), ["Seattle Metro", "Benelux"]);
  assert.deepEqual(matchGuildRegions(rows, "zzz"), []);
  // No internal type words in any label.
  for (const c of matchGuildRegions(rows, "", " — this server")) assert.doesNotMatch(c.name, /custom|admin1|macro|guild/i);
});
