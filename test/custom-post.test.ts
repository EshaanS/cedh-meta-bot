// Composer tests for a server's custom region: facts from the custom region, statistical commander sections
// from a standard region when the custom one isn't reportable. Runs on committed fixtures (no database).
// Snapshot: test/__snapshots__/custom-seattle-metro-2026-10.txt; set UPDATE_SNAPSHOTS=1 to rewrite it.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { composePost, contentLength, discordLimitViolations, POST_CONFIG, type PostData } from "../scripts/lib/post";

const CUSTOM = "custom-seattle-metro-2026-10";
const STANDARD = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10"];
const path = (dir: string, name: string, ext: string) => fileURLToPath(new URL(`./${dir}/${name}.${ext}`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(path("fixtures", name, "json"), "utf8")) as PostData;
const plain = (name: string) => name.replace(/^[^A-Za-z]+/, "");
type Embed = ReturnType<typeof composePost>["embed"];
const field = (embed: Embed, prefix: string) => embed.fields.find((f) => plain(f.name).startsWith(prefix));
const names = (embed: Embed) => embed.fields.map((f) => (f.name === POST_CONFIG.dividerName ? "---" : plain(f.name)));

test(`snapshot: ${CUSTOM}`, () => {
  const actual = composePost(loadFixture(CUSTOM)).text;
  const file = path("__snapshots__", CUSTOM, "txt");
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(file)) return writeFileSync(file, actual, "utf8");
  assert.equal(actual, readFileSync(file, "utf8"), `snapshot ${CUSTOM} changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
});

test("mixed scope: note, region named in the three statistical headers, three blocks, within limits", () => {
  const data = loadFixture(CUSTOM);
  const { embed, text } = composePost(data);
  assert.deepEqual(discordLimitViolations(embed), []);
  assert.ok(contentLength(embed) <= POST_CONFIG.contentBudget);
  assert.equal(embed.title, "Seattle Metro — cEDH meta, October 2026");
  assert.equal(embed.description, "Commander stats: Washington (United States), because Seattle Metro had too few entries.");
  // Scene, people and the month's top cuts are the custom region's own; the divider before Most played now
  // also separates them from the borrowed 6-month stats. No rising or cooling commanders.
  assert.deepEqual(names(embed), [
    "Events — October", "Players", "Draw rate", "Largest event",
    "---", "Winners — October (largest events)", "Top players — October", "Rising players — October (first win or top cut in 3 years of data)",
    "---", "Top-cut appearances — October",
    "---", "Most played — Washington (6 months)", "Best results — Washington (adjusted PPG, 30+ entries)", "Top-cut conversion — Washington (baseline 28%)",
    "Coverage", "Sources",
  ]);
  assert.equal(field(embed, "Events")!.value, "1 (-67% vs September)");
  assert.match(field(embed, "Winners")!.value, /^• 43p · .* · Mara Ellison on Francisco \/ Rograkh$/);
  // Ten top cuts in the month: counts only, no shares.
  for (const line of field(embed, "Top-cut appearances")!.value.split("\n")) assert.match(line, /— \d+ cuts?$/);
  assert.match(text, /Data provided by TopDeck\.gg \(https:\/\/topdeck\.gg\)/);
  assert.equal(embed.fields.at(-1)!.name, "🔗 Sources");
});

test("mixed scope: shares return once the month has enough top cuts", () => {
  const data = loadFixture(CUSTOM);
  data.topCutAppearances = data.topCutAppearances.map((t) => ({ ...t, totalTopCutEntries: POST_CONFIG.topCutShareMinCuts, totalFieldEntries: 120 }));
  for (const line of field(composePost(data).embed, "Top-cut appearances")!.value.split("\n")) assert.match(line, /% of cuts vs \d+\.\d% of field$/);
});

test("mixed scope: when the fallback isn't reportable either, only the facts show", () => {
  const data = loadFixture(CUSTOM);
  data.statsRegion = { id: "global", label: "Global", shortLabel: "Global", reportable: false };
  const { embed } = composePost(data);
  assert.equal(embed.description, "Not enough decklists yet for commander stats.");
  assert.deepEqual(names(embed).filter((n) => n !== "---").slice(4), [
    "Winners — October (largest events)", "Top players — October", "Rising players — October (first win or top cut in 3 years of data)",
    "Top-cut appearances — October", "Coverage", "Sources",
  ]);
});

test("mixed scope: a month with no events says so and still shows the borrowed stats", () => {
  const data = loadFixture(CUSTOM);
  data.scene = { ...data.scene, events: 0, players: 0, largestEventName: null, largestEventPlayers: null, drawRate: null };
  data.results = [];
  data.topPlayers = [];
  data.risingPlayers = [];
  data.topCutAppearances = [];
  const { embed } = composePost(data);
  assert.equal(embed.description, "No qualifying events in Seattle Metro in October.\nCommander stats: Washington (United States), because Seattle Metro had too few entries.");
  assert.deepEqual(names(embed), ["Most played — Washington (6 months)", "Best results — Washington (adjusted PPG, 30+ entries)", "Top-cut conversion — Washington (baseline 28%)", "Coverage", "Sources"]);
  assert.deepEqual(discordLimitViolations(embed), []);
});

test("a reportable custom region reads like a standard one: no note, no region in the headers, trends shown", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.requested = { id: "g:1:abcd", label: "Puget Sound" };
  data.resolved = { id: "g:1:abcd", label: "Puget Sound", stepsUp: 0, reportable: true };
  const { embed } = composePost(data);
  assert.equal(embed.title, "Puget Sound — cEDH meta, October 2026");
  assert.equal(embed.description, undefined);
  const standard = composePost(loadFixture("pacific-northwest-2026-10")).embed;
  assert.deepEqual(names(embed), names(standard));
  assert.ok(field(embed, "Rising commanders"));
  assert.equal(field(embed, "Most played")!.name, "📊 Most played (6 months)");
});

test("trimming a mixed-scope post follows the same order: borrowed stats first, the region's own facts last", () => {
  const data = loadFixture(CUSTOM);
  const full = composePost(data).embed;
  const tight = composePost(data, { ...POST_CONFIG, contentBudget: 1100 }).embed;
  assert.ok(contentLength(tight) <= 1100);
  assert.equal(field(tight, "Winners")!.value, field(full, "Winners")!.value);
  assert.ok(field(tight, "Most played")!.value.split("\n").length < field(full, "Most played")!.value.split("\n").length);
  assert.equal(tight.description, full.description, "the note is never trimmed");
});

test("standard fixtures carry no statsRegion, so their posts cannot change", () => {
  for (const name of STANDARD) {
    const data = loadFixture(name);
    assert.equal("statsRegion" in data, false, name);
    const { embed, text } = composePost(data);
    assert.doesNotMatch(text, /Commander stats:/);
    for (const f of embed.fields) assert.doesNotMatch(f.name, /^(📊 Most played|⭐ Best results|🔀 Top-cut conversion) — /u);
  }
});
