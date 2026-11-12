// Composer tests for a server's custom region: facts from the custom region, statistical commander sections
// from a standard region when the custom one isn't reportable. Runs on committed fixtures (no database).
// Snapshot: test/__snapshots__/custom-seattle-metro-2026-10.txt; set UPDATE_SNAPSHOTS=1 to rewrite it.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composePost, contentLength, discordLimitViolations, POST_CONFIG, type Embed, type PostData } from "../scripts/lib/post";

const CUSTOM = "custom-seattle-metro-2026-10";
const STANDARD = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10"];
const path = (dir: string, name: string, ext: string) => fileURLToPath(new URL(`./${dir}/${name}.${ext}`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(path("fixtures", name, "json"), "utf8")) as PostData;
const plain = (name: string) => name.replace(/^[^A-Za-z]+/, "");
const fields = (embeds: Embed[]) => embeds.flatMap((e) => e.fields);
const field = (embeds: Embed[], prefix: string) => fields(embeds).find((f) => plain(f.name).startsWith(prefix));
/** Field names per embed, without emoji. */
const names = (embeds: Embed[]) => embeds.map((e) => e.fields.map((f) => plain(f.name)));

test(`snapshot: ${CUSTOM}`, () => {
  const actual = composePost(loadFixture(CUSTOM)).text;
  const file = path("__snapshots__", CUSTOM, "txt");
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(file)) return writeFileSync(file, actual, "utf8");
  assert.equal(actual, readFileSync(file, "utf8"), `snapshot ${CUSTOM} changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
});

test("mixed scope: note, region named in the three statistical headers and the headline, four embeds, within limits", () => {
  const data = loadFixture(CUSTOM);
  const { embeds, text } = composePost(data);
  assert.deepEqual(discordLimitViolations(embeds), []);
  assert.ok(contentLength(embeds) <= POST_CONFIG.contentBudget);
  assert.deepEqual(embeds.map((e) => e.title), ["Seattle Metro — cEDH meta, October 2026", "👥 Players — October", "🃏 Commanders — October", "ℹ️ About this report"]);
  // The note comes first; the headline's commander line says whose numbers it shows; with one cut each there
  // is no top-cut leader, and with no trend of its own the third line is a rising player.
  assert.deepEqual(embeds[0]!.description!.split("\n"), [
    "Commander stats: Washington (United States), because Seattle Metro had too few entries.",
    "",
    "🏆 **Mind Full Games: October's Monthly 1k Event** (43 players) went to **Mara Ellison** on Francisco / Rograkh",
    "📊 **Kraum / Tymna the Weaver** is the most played commander in Washington: 7.3% of entries over 6 months",
    "🌱 **Noor Haddad** is the player to watch: first top cut at Mind Full Games: October's Monthly 1k Event (43 players)",
  ]);
  // Scene, people and the month's top cuts are the custom region's own; the three 6-month sections are
  // borrowed and say so. No rising or cooling commanders.
  assert.deepEqual(names(embeds), [
    ["Events — October", "Players", "Draw rate", "Largest event"],
    ["Winners (largest events)", "Top players", "Rising players (first win or top cut in 3 years of data)"],
    ["Top-cut appearances — October", "Most played — Washington (6 months)", "Best results — Washington (adjusted PPG, 30+ entries)", "Top-cut conversion — Washington (baseline 28%)"],
    ["Coverage", "Sources"],
  ]);
  assert.equal(field(embeds, "Events")!.value, "1 (-67% vs September)");
  assert.match(field(embeds, "Winners")!.value, /^\*\*Mind Full Games: October's Monthly 1k Event\*\* · 43 players\n🏆 Mara Ellison on Francisco \/ Rograkh \S+$/);
  // Ten top cuts in the month: counts only, no shares, so each commander stays on one line.
  for (const line of field(embeds, "Top-cut appearances")!.value.split("\n")) assert.match(line, /— \d+ cuts?$/);
  assert.match(text, /Data provided by TopDeck\.gg \(https:\/\/topdeck\.gg\)/);
  assert.equal(embeds.at(-1)!.fields.at(-1)!.name, "🔗 Sources");
});

test("mixed scope: shares return once the month has enough top cuts", () => {
  const data = loadFixture(CUSTOM);
  data.topCutAppearances = data.topCutAppearances.map((t) => ({ ...t, totalTopCutEntries: POST_CONFIG.topCutShareMinCuts, totalFieldEntries: 120 }));
  const lines = field(composePost(data).embeds, "Top-cut appearances")!.value.split("\n");
  assert.equal(lines.length, 10);
  for (const line of lines.filter((_, i) => i % 2 === 1)) assert.match(line, /^\d+ cuts? · \d+\.\d% of cuts vs \d+\.\d% of field$/);
});

test("mixed scope: when the fallback isn't reportable either, only the facts show", () => {
  const data = loadFixture(CUSTOM);
  data.statsRegion = { id: "global", label: "Global", shortLabel: "Global", reportable: false };
  const { embeds } = composePost(data);
  assert.equal(embeds[0]!.description!.split("\n")[0], "Not enough decklists yet for commander stats.");
  assert.doesNotMatch(embeds[0]!.description!, /most played/);
  assert.deepEqual(names(embeds).slice(1), [
    ["Winners (largest events)", "Top players", "Rising players (first win or top cut in 3 years of data)"],
    ["Top-cut appearances — October"],
    ["Coverage", "Sources"],
  ]);
});

test("mixed scope: a month with no events says so and still shows the borrowed stats", () => {
  const data = loadFixture(CUSTOM);
  data.scene = { ...data.scene, events: 0, players: 0, largestEventName: null, largestEventPlayers: null, drawRate: null };
  data.results = [];
  data.topPlayers = [];
  data.risingPlayers = [];
  data.topCutAppearances = [];
  const { embeds } = composePost(data);
  assert.equal(embeds[0]!.description, [
    "No qualifying events in Seattle Metro in October.",
    "Commander stats: Washington (United States), because Seattle Metro had too few entries.",
    "",
    "📊 **Kraum / Tymna the Weaver** is the most played commander in Washington: 7.3% of entries over 6 months",
  ].join("\n"));
  // No scene fields and no people embed: the overview is its title and description alone.
  assert.deepEqual(names(embeds), [[], ["Most played — Washington (6 months)", "Best results — Washington (adjusted PPG, 30+ entries)", "Top-cut conversion — Washington (baseline 28%)"], ["Coverage", "Sources"]]);
  assert.deepEqual(discordLimitViolations(embeds), []);
});

test("a reportable custom region reads like a standard one: no note, no region in the headers, trends shown", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.requested = { id: "g:1:abcd", label: "Puget Sound" };
  data.resolved = { id: "g:1:abcd", label: "Puget Sound", stepsUp: 0, reportable: true };
  const { embeds } = composePost(data);
  assert.equal(embeds[0]!.title, "Puget Sound — cEDH meta, October 2026");
  const standard = composePost(loadFixture("pacific-northwest-2026-10")).embeds;
  assert.equal(embeds[0]!.description, standard[0]!.description, "the headline alone, no note");
  assert.doesNotMatch(embeds[0]!.description!, /Commander stats|most played commander in/);
  assert.deepEqual(names(embeds), names(standard));
  assert.ok(field(embeds, "Rising commanders"));
  assert.equal(field(embeds, "Most played")!.name, "📊 Most played (6 months)");
});

test("trimming a mixed-scope post follows the same order: borrowed stats first, the region's own facts last", () => {
  const data = loadFixture(CUSTOM);
  const full = composePost(data).embeds;
  const tight = composePost(data, { ...POST_CONFIG, contentBudget: 1500 }).embeds;
  assert.ok(contentLength(tight) <= 1500);
  // Decoration went first (squares), then lines of the borrowed sections; the winner is still there.
  assert.equal(field(tight, "Winners")!.value, field(full, "Winners")!.value.replace(/ [🟨🟦🟪🟥🟩]+$/u, ""));
  assert.ok(field(tight, "Most played")!.value.split("\n").length < field(full, "Most played")!.value.split("\n").length);
  assert.equal(tight[0]!.description, full[0]!.description, "the note and the headline are never trimmed");
});

test("standard fixtures carry no statsRegion, so their posts name no other region", () => {
  for (const name of STANDARD) {
    const data = loadFixture(name);
    assert.equal("statsRegion" in data, false, name);
    const { embeds, text } = composePost(data);
    assert.doesNotMatch(text, /Commander stats:|most played commander in /);
    for (const f of fields(embeds)) assert.doesNotMatch(f.name, /^(📊 Most played|⭐ Best results|🔀 Top-cut conversion) — /u);
  }
});
