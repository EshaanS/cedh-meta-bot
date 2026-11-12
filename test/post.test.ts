// Tests for the v4 monthly post composer: one region, one month, top-5 lists, two-line items. Runs on
// committed fixtures (no database). Snapshots: test/__snapshots__/<name>.txt; set UPDATE_SNAPSHOTS=1 to
// rewrite them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changeVs,
  commandersShown,
  composePost,
  contentLength,
  DISCORD_LIMITS,
  discordLimitViolations,
  monthlyAvg,
  POST_CONFIG,
  sanitizeOrganizerText,
  shortDate,
  shortenCommander,
  type Embed,
  type PostConfig,
  type PostData,
} from "../scripts/lib/post";

/** Global and Pacific Northwest are full posts; Slovenia has no events in the month; Seattle Metro is one event. */
const FULL = ["pacific-northwest-2026-10", "global-2026-10"];
const ALL = [...FULL, "si-2026-10", "custom-seattle-metro-2026-10"];
/** Every player name in a committed fixture or snapshot is one of these invented names. */
const INVENTED = [
  "Mara Ellison", "Tobias Quill", "Ines Varga", "Devon Okafor", "Lena Marchetti", "Soren Blake", "Priya Nandakumar", "Hugo Lindqvist",
  "Camille Rousseau", "Jonah Whitlock", "Aiko Tanabe", "Rafael Montoya", "Noor Haddad", "Felix Brandt", "Greta Solberg", "Mateus Carvalho",
  "Wren Castellan", "Dmitri Volkov", "Sana Qureshi", "Callum Reyes", "Yuki Hoshino", "Bram Verhoeven", "Zofia Kaminska", "Elias Thornbury",
  "Anika Raman", "Otis Ferreira", "Maren Holt", "Luca Bianchi", "Tamsin Oyelaran", "Viktor Sandoval", "Halima Djalo", "Emil Lindahl",
  "Rosalind Achterberg", "Kenji Morales", "Iris Vanterpool", "Stellan Navarro", "Odalys Brenner", "Piotr Halvorsen", "Nadia Castellano", "Jasper Okonkwo",
  "Mireille Dufresne", "Tavish Arroyo", "Linnea Abernathy", "Cosmo Varela", "Beatrix Nkemelu", "Anselm Kowalczyk", "Paloma Ferrant", "Idris Whitcombe",
];
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const snapshotPath = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}.txt`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(fixturePath(name), "utf8")) as PostData;
/** A field name without its emoji prefix. */
const plain = (name: string) => name.replace(/^[^A-Za-z]+/, "");
const fields = (embeds: Embed[]) => embeds.flatMap((e) => e.fields);
const field = (embeds: Embed[], prefix: string) => fields(embeds).find((f) => plain(f.name).startsWith(prefix));
const lines = (embeds: Embed[], prefix: string) => field(embeds, prefix)?.value.split("\n") ?? [];
/** The items of a list, each as its lines (items are separated by a blank line). */
const items = (embeds: Embed[], prefix: string) => (field(embeds, prefix)?.value.split("\n\n") ?? []).map((item) => item.split("\n"));
const LISTS = ["Winners", "Top players", "Rising players", "Top-cut appearances", "Most played", "Best results", "Top-cut conversion", "Rising commanders", "Cooling commanders"];
const OFF = Object.fromEntries(Object.keys(POST_CONFIG.spacing).map((k) => [k, 0])) as PostConfig["spacing"];
/** Every look switch off: one plain line per item. */
const PLAIN: PostConfig = {
  ...POST_CONFIG, headline: 0, medals: 0, boldNames: 0, winnersTwoLines: 0, detailOnSecondLine: 0, shareBars: 0, colorSquares: 0, spacing: OFF,
  lineIcons: { win: "", topCut: "", newCommander: "", rising: "", cooling: "" },
};
const CIRCLES = /[⚪🔵⚫🔴🟢🔘]/u;

function matchSnapshot(name: string, actual: string) {
  const path = snapshotPath(name);
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(fileURLToPath(new URL("./__snapshots__/", import.meta.url)), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `snapshot ${name} changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
}

function assertWithinLimits(embeds: Embed[], budget: number = POST_CONFIG.contentBudget) {
  assert.deepEqual(discordLimitViolations(embeds), []);
  assert.ok(embeds.length >= 1 && embeds.length <= DISCORD_LIMITS.embeds);
  for (const e of embeds) {
    assert.ok((e.title?.length ?? 0) <= DISCORD_LIMITS.title);
    assert.ok((e.description?.length ?? 0) <= DISCORD_LIMITS.description);
    assert.ok(e.fields.length <= DISCORD_LIMITS.fields);
    for (const f of e.fields) {
      assert.ok(f.name.length > 0 && f.name.length <= DISCORD_LIMITS.fieldName, `field name ${f.name}`);
      assert.ok(f.value.length > 0 && f.value.length <= DISCORD_LIMITS.fieldValue, `field ${f.name}`);
    }
    assert.equal("footer" in e, false);
  }
  assert.ok(contentLength(embeds) <= DISCORD_LIMITS.total);
  assert.ok(contentLength(embeds) <= budget, `content ${contentLength(embeds)} > ${budget}`);
}

for (const name of ALL) {
  test(`snapshot: ${name}`, () => matchSnapshot(name, composePost(loadFixture(name)).text));
  test(`limits (budget ${POST_CONFIG.contentBudget} and Discord): ${name}`, () => assertWithinLimits(composePost(loadFixture(name)).embeds));

  test(`single attribution in a linked Sources field of the last embed, no footer: ${name}`, () => {
    const { embeds, text } = composePost(loadFixture(name));
    const sources = embeds.at(-1)!.fields.at(-1)!;
    assert.equal(sources.name, "🔗 Sources");
    assert.match(sources.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);
    assert.equal(fields(embeds).filter((f) => f.value.includes("Data provided by")).length, 1);
    assert.ok(embeds.every((e) => !(e.description ?? "").includes("Data provided by")));
    assert.match(text, /Data provided by TopDeck\.gg \(https:\/\/topdeck\.gg\)/);
  });

  test(`one region, one month: no six-month wording, no other region, no fallback note: ${name}`, () => {
    const data = loadFixture(name);
    const { embeds, text } = composePost(data);
    assert.equal(embeds[0]!.title, `${data.region.label} — cEDH meta, October 2026`);
    assert.doesNotMatch(text, /6 months|six months|6-month|Showing |Commander stats:|Not enough decklists|didn't have enough data|too few entries/);
    assert.doesNotMatch(JSON.stringify(embeds), /6 months|Commander stats:/);
    // Nothing names a region other than the post's own.
    for (const f of fields(embeds)) assert.doesNotMatch(f.name, / — (?!October)/, f.name);
    assert.doesNotMatch(embeds.map((e) => `${e.title ?? ""} ${e.description ?? ""}`).join(" "), /admin1|admin1_group|macro|custom region|\(continent\)|\(country\)/);
  });

  test(`fixture holds only invented player names and no player ids: ${name}`, () => {
    const raw = readFileSync(fixturePath(name), "utf8");
    const data = JSON.parse(raw) as PostData;
    const names = [...data.results.map((r) => r.winnerName), ...data.topPlayers.map((p) => p.name), ...data.risingPlayers.map((p) => p.name)].filter((n): n is string => n !== null);
    for (const n of names) assert.ok(INVENTED.includes(n), `not an invented name: ${n}`);
    // TopDeck account ids are 28 letters and digits and per-event ids are 20: no value anywhere looks like one.
    const values: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") values.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(data);
    for (const v of values) assert.doesNotMatch(v, /^[A-Za-z0-9]{20}$|^[A-Za-z0-9]{28}$/, v);
    assert.doesNotMatch(raw, /player_?id/i);
    // The copy the fixtures were made from names players "P00001"; none may be left.
    assert.doesNotMatch(raw, /"P\d{5}"/);
    assert.deepEqual(Object.keys(data).sort(), ["baselineConversion", "colors", "conversion", "coverage", "metaShare", "month", "ppg", "region", "results", "risingPlayers", "scene", "topCutAppearances", "topPlayers", "trend"]);
  });
}

for (const name of FULL) {
  test(`section order: ${name}`, () => {
    const { embeds } = composePost(loadFixture(name));
    const order = ["Events", "Players", "Draw rate", "Largest event", "Winners", "Top players", "Rising players", "Top-cut appearances",
      "Most played", "Best results", "Top-cut conversion", "Rising commanders", "Cooling commanders", "Coverage", "Sources"];
    const seen = fields(embeds).map((f) => order.findIndex((o) => plain(f.name).startsWith(o)));
    assert.ok(seen.every((i) => i >= 0), "unknown section");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "sections out of order");
    assert.equal(embeds[0]!.fields.filter((f) => f.inline).length, 3);
  });

  test(`every list: at most 5 items (3 for the rising kinds), two lines per item, a blank line between items: ${name}`, () => {
    const { embeds } = composePost(loadFixture(name));
    for (const list of LISTS) {
      const f = field(embeds, list);
      if (!f) continue;
      const its = items(embeds, list);
      assert.ok(its.length >= 1 && its.length <= (/^(Rising|Cooling)/.test(list) ? 3 : 5), `${list}: ${its.length} items`);
      for (const it of its) assert.equal(it.length, 2, `${list}: ${it.join(" | ")}`);
      // Lines only ever break as "item, blank line, item": no two emoji rows touch.
      assert.equal(f.value.split("\n").filter((l) => l === "").length, its.length - 1, list);
      assert.doesNotMatch(f.value, /\n\n\n/);
    }
    assert.equal(items(embeds, "Winners").length, 5);
    assert.equal(items(embeds, "Most played").length, 5);
    assert.equal(items(embeds, "Top-cut appearances").length, 5);
  });
}

test("embeds: four in one message, each with a title and its own color; an empty block is left out", () => {
  const { embeds, text } = composePost(loadFixture("global-2026-10"));
  assert.deepEqual(embeds.map((e) => e.title), ["Global — cEDH meta, October 2026", "👥 Players — October", "🃏 Commanders — October", "ℹ️ About this report"]);
  assert.deepEqual(embeds.map((e) => e.color), [0xc9a84c, 0x4a90d9, 0x4caf7a, 0x8a8f98]);
  assert.deepEqual(embeds.map((e) => e.fields.map((f) => f.name)), [
    ["📍 Events — October", "Players", "Draw rate", "Largest event"],
    ["🏆 Winners (largest events)", "👑 Top players", "🌱 Rising players (first win or top cut in 3 years of data)"],
    ["🎯 Top-cut appearances", "📊 Most played", "⭐ Best results (adjusted PPG, 10+ entries)", "🔀 Top-cut conversion (baseline 26%, 10+ entries)",
      "📈 Rising commanders (by share growth vs prior 3 months)", "📉 Cooling commanders (by share drop vs prior 3 months)"],
    ["ℹ️ Coverage", "🔗 Sources"],
  ]);
  assert.deepEqual(embeds.map((e) => e.description !== undefined), [true, false, false, false]);
  // Scene: one row of three inline fields (Discord's maximum per row), then Largest event at full width.
  assert.deepEqual(embeds[0]!.fields.map((f) => f.inline === true), [true, true, true, false]);
  const fourInline = composePost(loadFixture("global-2026-10"), { ...POST_CONFIG, largestEventInline: 1 }).embeds;
  assert.deepEqual(fourInline[0]!.fields.map((f) => f.inline === true), [true, true, true, true]);
  // No line may start a markdown list ("1. x", "- x", "* x"): Discord would restyle it.
  for (const f of fields(embeds)) for (const line of f.value.split("\n")) assert.doesNotMatch(line, /^\s*(\d+\.|[-*+])\s/, `${f.name}: ${line}`);
  // The preview has one block per embed, with the markup removed.
  assert.match(text, /\n── 👥 Players — October ──\n/);
  assert.match(text, /\n── 🃏 Commanders — October ──\n/);
  assert.match(text, /\n── ℹ️ About this report ──\n/);
  assert.doesNotMatch(text, /\*\*|\\\./);

  // No people: that embed is left out. No commanders either: overview and about only.
  const quiet = loadFixture("global-2026-10");
  quiet.results = [];
  quiet.topPlayers = [];
  quiet.risingPlayers = [];
  assert.deepEqual(composePost(quiet).embeds.map((e) => e.title), ["Global — cEDH meta, October 2026", "🃏 Commanders — October", "ℹ️ About this report"]);
  Object.assign(quiet, { topCutAppearances: [], metaShare: [], ppg: [], conversion: [], trend: [] });
  const two = composePost(quiet).embeds;
  assert.equal(two.length, 2);
  assertWithinLimits(two);

  // Titles, colors and section emoji come from the config; emoji count against the content.
  const bare = composePost(loadFixture("global-2026-10"), {
    ...POST_CONFIG,
    embeds: { overview: { color: 1 }, people: { title: "People of {month}", color: 2 }, decks: { title: "", color: 3 }, about: { title: "About", color: 4 } },
    sectionEmoji: Object.fromEntries(Object.keys(POST_CONFIG.sectionEmoji).map((k) => [k, ""])) as PostConfig["sectionEmoji"],
  }).embeds;
  assert.deepEqual(bare.map((e) => e.title), ["Global — cEDH meta, October 2026", "People of October", undefined, "About"]);
  assert.deepEqual(bare.map((e) => e.color), [1, 2, 3, 4]);
  assert.equal(bare.at(-1)!.fields.at(-1)!.name, "Sources");
  assert.ok(contentLength(embeds) > contentLength(bare));
  assert.deepEqual(discordLimitViolations(bare), []);
});

test("discordLimitViolations: embed count, per-embed limits and the total across embeds", () => {
  const ok: Embed = { title: "t", fields: [{ name: "n", value: "v" }] };
  assert.deepEqual(discordLimitViolations([ok]), []);
  assert.match(discordLimitViolations([]).join(), /no embeds/);
  assert.match(discordLimitViolations(Array.from({ length: 11 }, () => ok)).join(), /embeds 11 > 10/);
  assert.match(discordLimitViolations([{ fields: [] }]).join(), /nothing in it/);
  assert.match(discordLimitViolations([{ title: "x".repeat(257), fields: [] }]).join(), /embed 1: title 257 > 256/);
  assert.match(discordLimitViolations([ok, { title: "t", fields: [{ name: "n", value: "x".repeat(1025) }] }]).join(), /embed 2: field "n" value length 1025/);
  assert.match(discordLimitViolations([{ title: "t", fields: Array.from({ length: 26 }, () => ({ name: "n", value: "v" })) }]).join(), /fields 26 > 25/);
  // Each embed is fine by itself; together they pass 6,000.
  const big: Embed = { title: "t", description: "d".repeat(3500), fields: [] };
  assert.deepEqual(discordLimitViolations([big]), []);
  assert.match(discordLimitViolations([big, big]).join(), /total 7002 > 6000/);
  assert.equal(contentLength([big, ok]), 3501 + 3);
});

test("a month with no qualifying events is one line under the title, with the attribution", () => {
  const { embeds, text } = composePost(loadFixture("si-2026-10"));
  assert.deepEqual(embeds, [{
    title: "Slovenia — cEDH meta, October 2026",
    description: "No qualifying events in Slovenia in October.",
    color: 0xc9a84c,
    fields: [{ name: "🔗 Sources", value: "Data provided by [TopDeck.gg](https://topdeck.gg) · Methods: [cedhstats.org](https://cedhstats.org/about)" }],
  }]);
  assert.equal(text, [
    "Slovenia — cEDH meta, October 2026",
    "No qualifying events in Slovenia in October.",
    "",
    "🔗 Sources: Data provided by TopDeck.gg (https://topdeck.gg) · Methods: cedhstats.org (https://cedhstats.org/about)",
  ].join("\n"));
  // The fixture still carries earlier months' trend rows; none of them may show.
  assert.ok(loadFixture("si-2026-10").trend.length > 0);
  // The same for any region, whatever else the data holds; the line is config.
  const global = loadFixture("global-2026-10");
  global.scene = { ...global.scene, events: 0 };
  const empty = composePost(global, { ...POST_CONFIG, noEventsCopy: "Nothing in {region} for {month}." }).embeds;
  assert.equal(empty.length, 1);
  assert.equal(empty[0]!.description, "Nothing in Global for October.");
  assert.deepEqual(empty[0]!.fields.map((f) => f.name), ["🔗 Sources"]);
});

test("a small region shows its own data only: what has rows is listed, the rest is left out", () => {
  const data = loadFixture("custom-seattle-metro-2026-10");
  const { embeds } = composePost(data);
  assert.deepEqual(embeds.map((e) => e.title), ["Seattle Metro — cEDH meta, October 2026", "👥 Players — October", "🃏 Commanders — October", "ℹ️ About this report"]);
  assert.deepEqual(fields(embeds).map((f) => plain(f.name)), [
    "Events — October", "Players", "Draw rate", "Largest event",
    "Winners (largest events)", "Top players", "Rising players (first win or top cut in 3 years of data)",
    "Top-cut appearances", "Most played", "Coverage", "Sources",
  ]);
  // No commander reaches the stat functions' 10 entries in a 43-player month, so there is no Best results
  // and no Top-cut conversion, and nothing is borrowed to fill them.
  assert.equal(data.ppg.length, 0);
  assert.equal(data.conversion.length, 0);
  assert.equal(field(embeds, "Events")!.value, "1 (-67% vs September)");
  // Counts are on every line: these are four, three and two entries, not a meta.
  assert.deepEqual(items(embeds, "Most played").map((it) => /· (\d+) entr(y|ies)/.exec(it[1]!)![1]), ["4", "3", "3", "3", "2"]);
  assert.equal(field(embeds, "Coverage")!.value, "1 qualifying event in October · 100% of entries with decklists · 100% of entries have a linked player");
  assert.deepEqual(embeds[0]!.description!.split("\n"), [
    "🏆 **Mind Full Games: October's Monthly 1k Event** (43 players) went to **Felix Brandt** on Francisco / Rograkh",
    "📊 **Rograkh / Thrasios** is the most played commander: 9.3% of October entries",
    "🌱 **Felix Brandt** is the player to watch: first win at Mind Full Games: October's Monthly 1k Event (43 players)",
  ]);
});

test("headline: biggest event and winner, top-cut leader or most played, rising commander or player", () => {
  const global = composePost(loadFixture("global-2026-10")).embeds[0]!;
  assert.deepEqual(global.description!.split("\n"), [
    "🏆 **MBG Commanderpalooza #3 (TimeTwister event)** (150 players) went to **Mara Ellison** on Kraum / Tymna the Weaver",
    "🎯 **Kraum / Tymna the Weaver** made the most top cuts: 157",
    "📈 **Dack Fayden, Helping Hand** is the commander to watch: 93 entries in October, new since Sep 26",
  ]);
  const data = loadFixture("global-2026-10");
  const head = (d: PostData, cfg: PostConfig = POST_CONFIG) => composePost(d, cfg).embeds[0]!.description?.split("\n") ?? [];
  // Too few cuts for a leader, or a tie for the most: the most played commander, with the month named.
  assert.equal(head(data, { ...POST_CONFIG, headlineMinCuts: 500 })[1], "📊 **Kraum / Tymna the Weaver** is the most played commander: 8.3% of October entries");
  const tied = loadFixture("global-2026-10");
  tied.topCutAppearances[1] = { ...tied.topCutAppearances[1]!, topCutEntries: tied.topCutAppearances[0]!.topCutEntries };
  assert.match(head(tied)[1]!, /^📊 .* is the most played commander: 8\.3% of October entries$/);
  // No rising commander: the first rising player.
  data.trend = [];
  assert.equal(head(data)[2], "🌱 **Jonah Whitlock** is the player to watch: first top cut at BAKED ZITI 4: Goldsabertooth’s NY cEDH (119 players)");
  // Winner variants: an opted-out winner, a commander alone, no single winner.
  data.results[0] = { ...data.results[0]!, winnerName: null, winnerHidden: true };
  assert.match(head(data)[0]!, /went to a player on Kraum \/ Tymna the Weaver$/);
  data.results[0] = { ...data.results[0]!, winnerHidden: false };
  assert.match(head(data)[0]!, /went to Kraum \/ Tymna the Weaver$/);
  data.results[0] = { ...data.results[0]!, result: "no single winner", resultCommanders: null };
  assert.equal(head(data)[0], "🏆 **MBG Commanderpalooza #3 (TimeTwister event)** (150 players) was the biggest event");
  // No 32+ event: the scene's largest event. Nothing at all: the line is left out.
  data.results = [];
  assert.equal(head(data)[0], "🏆 **MBG Commanderpalooza #3 (TimeTwister event)** (150 players) was the biggest event");
  data.scene = { ...data.scene, largestEventName: null };
  data.risingPlayers = [];
  assert.deepEqual(head(data), ["🎯 **Kraum / Tymna the Weaver** made the most top cuts: 157"]);
  // Switched off: no description at all. The copy is config. The headline shows no color symbols.
  assert.equal(composePost(loadFixture("global-2026-10"), { ...POST_CONFIG, headline: 0 }).embeds[0]!.description, undefined);
  const copy = { ...POST_CONFIG.headlineCopy, topCut: "{commander} leads with {cuts} cuts" };
  assert.equal(head(loadFixture("global-2026-10"), { ...POST_CONFIG, headlineCopy: copy })[1], "Kraum / Tymna the Weaver leads with 157 cuts");
  assert.doesNotMatch(global.description!, CIRCLES);
  // The headline is never trimmed.
  const tight = composePost(loadFixture("global-2026-10"), { ...POST_CONFIG, contentBudget: 1500 }).embeds;
  assert.equal(tight[0]!.description, global.description);
});

test("winners: two lines each, labels for every result type, at most five", () => {
  const data = loadFixture("global-2026-10");
  const base = data.results[0]!;
  const none = { winnerName: null, winnerHidden: false };
  data.results = [
    { ...base, ...none, result: "winner", resultCommanders: "Kraum, Ludevic's Opus / Tymna the Weaver" },
    { ...base, ...none, result: "final drawn", resultCommanders: "Kinnan, Bonder Prodigy; unknown" },
    { ...base, ...none, result: "no single winner", resultCommanders: null },
    { ...base, ...none, result: "winner not recorded", resultCommanders: null },
    { ...base, result: "winner", resultCommanders: "Kinnan, Bonder Prodigy", winnerName: "Mara Ellison", winnerHidden: false },
    { ...base, result: "winner", resultCommanders: "Kinnan, Bonder Prodigy", winnerName: null, winnerHidden: true },
    { ...base, result: "winner", resultCommanders: "unknown", winnerName: "Mara Ellison", winnerHidden: false },
    ...Array.from({ length: 5 }, () => ({ ...base })),
  ];
  assert.equal(items(composePost(data).embeds, "Winners").length, 5, "the default cap");
  const ten = { winnersMax: 10 };
  const old = lines(composePost(data, { ...PLAIN, ...ten }).embeds, "Winners");
  assert.equal(old.length, 10);
  assert.match(old[0]!, /^• 150p · .* · Kraum \/ Tymna the Weaver$/);
  assert.match(old[1]!, /· drawn final: Kinnan, Bonder Prodigy, unknown commander$/);
  assert.match(old[2]!, /· no single winner$/);
  assert.match(old[3]!, /· winner not recorded$/);
  assert.match(old[4]!, /· Mara Ellison on Kinnan, Bonder Prodigy$/);
  assert.match(old[5]!, /· a player on Kinnan, Bonder Prodigy$/);
  assert.match(old[6]!, /· Mara Ellison on unknown commander$/);
  assert.ok(!old.some((l) => /more$/.test(l)));

  // The event and its size, then the outcome with the colors last; a trophy only where there is a winner.
  const event = "**MBG Commanderpalooza #3 (TimeTwister event)** · 150 players";
  assert.deepEqual(items(composePost(data, { ...POST_CONFIG, ...ten }).embeds, "Winners").slice(0, 7), [
    [event, "🏆 Kraum / Tymna the Weaver · ⚪ 🔵 ⚫ 🔴"],
    [event, "drawn final: Kinnan, Bonder Prodigy · 🔵 🟢, unknown commander"],
    [event, "no single winner"],
    [event, "winner not recorded"],
    [event, "🏆 Mara Ellison on Kinnan, Bonder Prodigy · 🔵 🟢"],
    [event, "🏆 a player on Kinnan, Bonder Prodigy · 🔵 🟢"],
    [event, "🏆 Mara Ellison on unknown commander"],
  ]);
  assert.doesNotMatch(field(composePost(data, { ...POST_CONFIG, spacing: OFF }).embeds, "Winners")!.value, /\n\n/);
});

test("the 1,024-character field guard: lines are dropped, never a second field", () => {
  const data = loadFixture("global-2026-10");
  data.results = Array.from({ length: 10 }, (_, i) => ({
    eventName: `Very long organizer event name number ${i} ${"Z".repeat(80)}`,
    participantCount: 200 - i,
    result: "winner",
    resultCommanders: `Commanderwithaveryveryverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner Name ${i}, Subtitle`,
    winnerName: `Player With A Remarkably Long Display Name ${i}`,
    winnerHidden: false,
  }));
  // Five long winners fit one field.
  const five = composePost(data).embeds;
  assertWithinLimits(five);
  assert.deepEqual(five[1]!.fields.map((f) => plain(f.name)), ["Winners (largest events)", "Top players", "Rising players (first win or top cut in 3 years of data)"]);
  assert.equal(items(five, "Winners").length, 5);
  // Ten do not: the field keeps as many as fit, from the top, and stays one field.
  const ten = composePost(data, { ...POST_CONFIG, winnersMax: 10, contentBudget: 6000 }).embeds;
  assert.deepEqual(discordLimitViolations(ten), []);
  assert.equal(fields(ten).filter((f) => plain(f.name).startsWith("Winners")).length, 1);
  const kept = items(ten, "Winners");
  assert.ok(kept.length < 10 && kept.length >= 5, `kept ${kept.length}`);
  assert.match(kept[0]![1]!, /^🏆 Player With A Remarkably Long Display… on /);
  assert.ok(field(ten, "Winners")!.value.length <= DISCORD_LIMITS.fieldValue);
  assert.equal("winnersSplitAt" in POST_CONFIG, false);
});

test("hostile organizer text and player names are neutralized, an opted-out winner is 'a player', and the post still fits", () => {
  const data = loadFixture("global-2026-10");
  const nasty = [
    "@everyone **FREE** <@123456789> __big__ ~~sale~~ `code` |spoiler| " + "x".repeat(200),
    "[click me](https://evil.example/phish) join discord.gg/abc123 now",
    "<@&987654321> @here " + "y".repeat(300),
  ];
  const nastyPlayer = "@everyone **Mallory** <@42> [free](https://evil.example/x) discord.gg/zzz `x` |y| " + "n".repeat(100);
  data.results = nasty.map((eventName, i) => ({
    eventName, participantCount: 500 - i, result: "winner", resultCommanders: "Kinnan, Bonder Prodigy",
    // The opted-out winner arrives from SQL with no name; only the flag is left.
    winnerName: i === 1 ? null : nastyPlayer, winnerHidden: i === 1,
  }));
  data.scene = { ...data.scene, largestEventName: nasty[0]!, largestEventPlayers: 500 };
  data.topPlayers = [{ name: nastyPlayer, wins: 2, topCuts: 3, commander: "Kinnan, Bonder Prodigy" }, { name: "@<>*_~`|[]", wins: 1, topCuts: 1, commander: null }];
  data.risingPlayers = [{ name: nastyPlayer, reason: "first win", eventName: nasty[1]!, participantCount: 499 }];
  const { embeds, text } = composePost(data);
  assertWithinLimits(embeds);
  const winners = items(embeds, "Winners");
  assert.equal(winners[1]![1], "🏆 a player on Kinnan, Bonder Prodigy · 🔵 🟢");
  assert.match(winners[0]![1]!, /^🏆 everyone Mallory 42 free\( x y… on Kinnan, Bonder Prodigy · 🔵 🟢$/);
  const top = items(embeds, "Top players");
  assert.equal(top.length, 1, "a name that sanitizes to nothing is dropped");
  assert.ok(/^🥇 \*\*(.+)\*\*$/.exec(top[0]![0]!)![1]!.length <= POST_CONFIG.playerNameMax);
  for (const it of winners) assert.ok(/^\*\*(.+)\*\* · \d+ players$/.exec(it[0]!)![1]!.length <= POST_CONFIG.eventNameMax, it[0]);
  // Our own bold markers aside, nothing the organizer or player wrote can act as markup, a mention or a link.
  const written = [embeds[0]!.description!, ...["Winners", "Largest event", "Top players", "Rising players"].map((n) => field(embeds, n)!.value)];
  for (const v of written) {
    const withoutBold = v.replace(/\*\*([^*\n]+)\*\*/g, "$1");
    for (const bad of ["@everyone", "@here", "<@", "*", "__", "~~", "`", "|", "[click", "](", "https://evil", "discord.gg"]) {
      assert.ok(!withoutBold.includes(bad), `organizer text contains ${bad}: ${v}`);
    }
  }
  for (const bad of ["@everyone", "@here", "<@", "**", "__", "~~", "`", "|", "[click", "](", "https://evil", "discord.gg"]) {
    assert.ok(!text.split("\n").filter((l) => l.includes("players") || l.includes("Mallory")).some((l) => l.includes(bad)), `preview contains ${bad}`);
  }
  // A hostile region name can't reach a post unsanitized either: the loader cleans it, and the composer only prints it.
  data.region = { id: "g:1:abcd", label: sanitizeOrganizerText("**Evil** @everyone <@1> https://evil.example", 40) };
  assert.equal(composePost(data).embeds[0]!.title, "Evil everyone 1 — cEDH meta, October 2026");
});

test("caps: five items per list and three for the rising kinds, whatever the data holds", () => {
  const data = loadFixture("global-2026-10");
  const many = (n: number) => Array.from({ length: n }, (_, i) => i);
  data.results = many(12).map((i) => ({ ...data.results[0]!, eventName: `Event ${i}`, participantCount: 200 - i }));
  data.topPlayers = many(12).map((i) => ({ name: `Player ${i}`, wins: 12 - i, topCuts: 12, commander: null }));
  data.risingPlayers = many(12).map((i) => ({ name: `Riser ${i}`, reason: "first win", eventName: `Event ${i}`, participantCount: 200 - i }));
  data.trend = [
    ...many(8).map((i) => ({ commander: `Up ${i}`, lastMonthEntries: 40 - i, prior3AvgEntries: 5, shareChange: 2 - i / 10, isNew: false, firstSeen: "2024-01-01" })),
    ...many(8).map((i) => ({ commander: `Down ${i}`, lastMonthEntries: 20, prior3AvgEntries: 400 - i, shareChange: -0.5 - i / 10, isNew: false, firstSeen: "2024-01-01" })),
  ];
  const { embeds } = composePost(data);
  assert.ok(data.metaShare.length >= 20 && data.ppg.length > 5 && data.conversion.length > 5 && data.topCutAppearances.length >= 10);
  const counts = Object.fromEntries(LISTS.map((l) => [l, items(embeds, l).length]));
  assert.deepEqual(counts, {
    "Winners": 5, "Top players": 5, "Rising players": 3, "Top-cut appearances": 5, "Most played": 5, "Best results": 5, "Top-cut conversion": 5,
    "Rising commanders": 3, "Cooling commanders": 3,
  });
  assert.deepEqual([POST_CONFIG.winnersMax, POST_CONFIG.topPlayersMax, POST_CONFIG.risingPlayersMax, POST_CONFIG.topCutMax, POST_CONFIG.mostPlayedMax,
    POST_CONFIG.bestResultsMax, POST_CONFIG.conversionMax, POST_CONFIG.risingMax, POST_CONFIG.coolingMax], [5, 5, 3, 5, 5, 5, 5, 3, 3]);
  assertWithinLimits(embeds);
});

test("no display minimum: Best results and conversion list whatever the stat functions return, with the counts", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.colors = {};
  // The functions' floor is 10 entries in the month; a commander at exactly 10 is listed like any other.
  data.ppg = [
    { commander: "Ten Entries", entries: 10, ppg: 2.4, shrunkPpg: 1.63 },
    { commander: "Many Entries", entries: 300, ppg: 1.5, shrunkPpg: 1.48 },
  ];
  data.conversion = [
    { commander: "One In A Cut Event", entriesInCutEvents: 1, topCutEntries: 1, conversion: 1 },
    { commander: "Ten Entries", entriesInCutEvents: 10, topCutEntries: 6, conversion: 0.6 },
    { commander: "Many Entries", entriesInCutEvents: 280, topCutEntries: 84, conversion: 0.3 },
  ];
  const { embeds } = composePost(data);
  assert.deepEqual(items(embeds, "Best results"), [["🥇 **Ten Entries**", "1.63 · 10 entries"], ["🥈 **Many Entries**", "1.48 · 300 entries"]]);
  assert.deepEqual(items(embeds, "Top-cut conversion"), [
    ["🥇 **One In A Cut Event**", "100% · 1 of 1 entry"],
    ["🥈 **Ten Entries**", "60% · 6 of 10 entries"],
    ["🥉 **Many Entries**", "30% · 84 of 280 entries"],
  ]);
  assert.equal(field(embeds, "Best results")!.name, "⭐ Best results (adjusted PPG, 10+ entries)");
  assert.equal(field(embeds, "Top-cut conversion")!.name, "🔀 Top-cut conversion (baseline 25%, 10+ entries)");
  for (const key of ["bestResultsMinEntries", "conversionMinCutEntries", "bestResultsMinShare", "smallSampleBelow", "monthReportMinEntries", "monthReportMinCommanders", "topCutShareMinCuts"]) {
    assert.equal(key in POST_CONFIG, false, key);
  }
  // Nothing qualifies: the two sections are left out, and nothing else changes.
  data.ppg = [];
  data.conversion = [];
  const none = composePost(data).embeds;
  assert.equal(field(none, "Best results"), undefined);
  assert.equal(field(none, "Top-cut conversion"), undefined);
  assert.equal(field(none, "Most played")!.value, field(embeds, "Most played")!.value);
});

test("ties break the same way every time: more entries, then more top cuts, then the name", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.colors = {};
  const t = { totalTopCutEntries: 20, totalFieldEntries: 100 };
  data.metaShare = [
    { commander: "Zed", entries: 6, metaShare: 0.06, topCuts: 0 },
    { commander: "Alpha", entries: 6, metaShare: 0.06, topCuts: 0 },
    { commander: "More Cuts", entries: 6, metaShare: 0.06, topCuts: 2 },
    { commander: "More Entries", entries: 7, metaShare: 0.07, topCuts: 0 },
    { commander: "alpha lower", entries: 6, metaShare: 0.06, topCuts: 0 },
    { commander: "Sixth", entries: 5, metaShare: 0.05, topCuts: 5 },
  ];
  data.topCutAppearances = [
    { commander: "Played Once And Won", topCutEntries: 1, fieldEntries: 1, ...t },
    { commander: "B Two Entries", topCutEntries: 1, fieldEntries: 2, ...t },
    { commander: "A Two Entries", topCutEntries: 1, fieldEntries: 2, ...t },
    { commander: "Three Cuts", topCutEntries: 3, fieldEntries: 3, ...t },
    { commander: "Five Entries", topCutEntries: 1, fieldEntries: 5, ...t },
  ];
  data.ppg = [
    { commander: "Fewer Entries", entries: 12, ppg: 1.5, shrunkPpg: 1.4 },
    { commander: "B Same", entries: 20, ppg: 1.5, shrunkPpg: 1.4 },
    { commander: "A Same", entries: 20, ppg: 1.5, shrunkPpg: 1.4 },
    { commander: "Same With Cuts", entries: 20, ppg: 1.5, shrunkPpg: 1.4 },
    { commander: "Best", entries: 10, ppg: 2, shrunkPpg: 1.5 },
  ];
  data.conversion = [
    { commander: "Same With Cuts", entriesInCutEvents: 20, topCutEntries: 5, conversion: 0.25 },
    { commander: "B Half Of Four", entriesInCutEvents: 4, topCutEntries: 2, conversion: 0.5 },
    { commander: "A Half Of Four", entriesInCutEvents: 4, topCutEntries: 2, conversion: 0.5 },
    { commander: "Half Of Ten", entriesInCutEvents: 10, topCutEntries: 5, conversion: 0.5 },
    { commander: "All Of Two", entriesInCutEvents: 2, topCutEntries: 2, conversion: 1 },
  ];
  const names = (d: PostData, list: string) => items(composePost(d).embeds, list).map((it) => it[0]!.replace(/^\S+ \*\*(.+)\*\*$/, "$1"));
  const expected = {
    "Most played": ["More Entries", "More Cuts", "Alpha", "Zed", "alpha lower"],
    "Top-cut appearances": ["Three Cuts", "Five Entries", "A Two Entries", "B Two Entries", "Played Once And Won"],
    "Best results": ["Best", "Same With Cuts", "A Same", "B Same", "Fewer Entries"],
    "Top-cut conversion": ["All Of Two", "Half Of Ten", "A Half Of Four", "B Half Of Four", "Same With Cuts"],
  };
  for (const [list, order] of Object.entries(expected)) assert.deepEqual(names(data, list), order, list);
  // The order of the rows in the data makes no difference.
  const shuffled: PostData = {
    ...data, metaShare: [...data.metaShare].reverse(), topCutAppearances: [...data.topCutAppearances].reverse(),
    ppg: [...data.ppg].reverse(), conversion: [...data.conversion].reverse(),
  };
  for (const [list, order] of Object.entries(expected)) assert.deepEqual(names(shuffled, list), order, `${list}, rows reversed`);
  // A commander that played once and made the cut is listed, with its counts.
  assert.deepEqual(items(composePost(data).embeds, "Top-cut appearances").at(-1), ["5️⃣ **Played Once And Won**", "1 cut · 5.0% of cuts vs 1.0% of field"]);
  // Every fixture's lists are already in this order.
  for (const name of FULL) {
    const d = loadFixture(name);
    const reversed: PostData = { ...d, metaShare: [...d.metaShare].reverse(), topCutAppearances: [...d.topCutAppearances].reverse(), ppg: [...d.ppg].reverse(), conversion: [...d.conversion].reverse() };
    assert.equal(composePost(reversed).text, composePost(d).text, name);
  }
});

test("rising and cooling: count display, eligibility and matching counts", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const old = "2024-01-13";
  const row = (commander: string, n: number, avg: number, change: number | null, isNew = false, firstSeen: string | null = old) =>
    ({ commander, lastMonthEntries: n, prior3AvgEntries: avg, shareChange: change, isNew, firstSeen });
  data.trend = [
    // No entries here in the prior 3 months, but an old commander: plain "new".
    row("Jace, Multiverse Architect", 11, 0, null, true, "2025-03-08"),
    row("Up From Little", 12, 0.4, 0.5),
    row("Entries Up Share Down", 25, 22, -0.06), // entries up: not cooling
    row("Cooling Via Prior Average", 4, 12, -0.6), // qualifies via the prior average
    row("Too Small Before", 3, 9, -0.9), // under 10 both in the month and before
    row("One Entry", 1, 0, null, true, "2025-01-01"), // new, but under the 10 entries a riser needs
  ];
  const plainPost = composePost(data, PLAIN).embeds;
  assert.deepEqual(lines(plainPost, "Rising commanders"), [
    "Jace, Multiverse Architect — 11 entries in October, new",
    "Up From Little — 12 entries in October (avg <1/month)",
  ]);
  assert.deepEqual(lines(plainPost, "Cooling commanders"), ["Cooling Via Prior Average — 4 entries in October (avg 12/month)"]);

  // An icon and the bold name on line 1, the counts on line 2. 🆕 new, 🔥 rising, 🧊 cooling.
  data.colors = { "Up From Little": "UG" };
  const { embeds } = composePost(data);
  assert.deepEqual(items(embeds, "Rising commanders"), [
    ["🆕 **Jace, Multiverse Architect**", "11 entries in October, new"],
    ["🔥 **Up From Little**", "12 entries in October (avg <1/month) · 🔵 🟢"],
  ]);
  assert.deepEqual(items(embeds, "Cooling commanders"), [["🧊 **Cooling Via Prior Average**", "4 entries in October (avg 12/month)"]]);

  // "A top commander" is one of the 15 most played of the prior 3 months, not of this month: one that fell
  // out of the month's list is still cooling, and the sixteenth by prior average is not.
  data.trend = [
    ...Array.from({ length: 15 }, (_, i) => row(`Steady ${String(i).padStart(2, "0")}`, 100, 100 - i, 0.01)),
    row("Sixteenth Before", 5, 50, -0.9),
  ];
  assert.equal(field(composePost(data).embeds, "Cooling commanders"), undefined);
  data.trend[14] = row("Fell Out Of The Month", 2, 86, -0.95);
  assert.ok(!data.metaShare.some((m) => m.commander === "Fell Out Of The Month"));
  assert.deepEqual(items(composePost(data).embeds, "Cooling commanders"), [["🧊 **Fell Out Of The Month**", "2 entries in October (avg 86/month)"]]);
  assert.equal(items(composePost(data, { ...POST_CONFIG, coolingTopN: 16 }).embeds, "Cooling commanders").length, 2);
});

test("sections with no rows are omitted", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.trend = [];
  data.conversion = [];
  data.topPlayers = [];
  data.risingPlayers = [];
  const { embeds } = composePost(data);
  for (const name of ["Rising commanders", "Cooling commanders", "Top players", "Rising players", "Top-cut conversion"]) assert.equal(field(embeds, name), undefined, name);
  assert.ok(field(embeds, "Winners") && field(embeds, "Most played") && field(embeds, "Best results"));
});

test("top players and rising players: line formats and caps", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.colors = { "Kinnan, Bonder Prodigy": "UG" };
  data.topPlayers = [
    { name: "Mara Ellison", wins: 2, topCuts: 3, commander: "Kraum, Ludevic's Opus / Tymna the Weaver" },
    { name: "Tobias Quill", wins: 1, topCuts: 1, commander: "Kinnan, Bonder Prodigy" },
    { name: "Ines Varga", wins: 1, topCuts: 0, commander: null },
    { name: "Aiko Tanabe", wins: 0, topCuts: 2, commander: null },
    ...Array.from({ length: 4 }, (_, i) => ({ name: `Extra ${i}`, wins: 0, topCuts: 1, commander: null })),
  ];
  data.risingPlayers = [
    { name: "Noor Haddad", reason: "first win", eventName: "Big **Event**", participantCount: 64 },
    { name: "Felix Brandt", reason: "first top cut", eventName: null, participantCount: 40 },
    { name: "Third", reason: "early top cut", eventName: "C", participantCount: 20 },
    { name: "Fourth", reason: "early top cut", eventName: "D", participantCount: 18 },
  ];
  const old = composePost(data, PLAIN).embeds;
  assert.deepEqual(lines(old, "Top players"), [
    "1\\. Mara Ellison — 2 wins, 3 top cuts · Kraum / Tymna the Weaver",
    "2\\. Tobias Quill — 1 win, 1 top cut · Kinnan, Bonder Prodigy",
    "3\\. Ines Varga — 1 win",
    "4\\. Aiko Tanabe — 2 top cuts",
    "5\\. Extra 0 — 1 top cut",
  ]);
  assert.deepEqual(lines(old, "Rising players"), [
    "Noor Haddad — first win · 64p Big Event",
    "Felix Brandt — first top cut · 40p Unnamed event",
    "Third — top cut in first 5 events · 20p C",
  ]);

  const { embeds } = composePost(data);
  assert.deepEqual(items(embeds, "Top players"), [
    ["🥇 **Mara Ellison**", "🏆 2 wins · 🎯 3 top cuts · Kraum / Tymna the Weaver"],
    ["🥈 **Tobias Quill**", "🏆 1 win · 🎯 1 top cut · Kinnan, Bonder Prodigy · 🔵 🟢"],
    ["🥉 **Ines Varga**", "🏆 1 win"],
    ["4️⃣ **Aiko Tanabe**", "🎯 2 top cuts"],
    ["5️⃣ **Extra 0**", "🎯 1 top cut"],
  ]);
  // The month is in the embed's title, so the field names don't repeat it.
  assert.equal(field(embeds, "Top players")!.name, "👑 Top players");
  assert.equal(field(embeds, "Rising players")!.name, "🌱 Rising players (first win or top cut in 3 years of data)");
  assert.deepEqual(items(embeds, "Rising players"), [
    ["**Noor Haddad**", "🏆 first win · 64 players · Big Event"],
    ["**Felix Brandt**", "🎯 first top cut · 40 players · Unnamed event"],
    ["**Third**", "🎯 top cut in first 5 events · 20 players · C"],
  ]);
});

test("scene change wording and the coverage line for the month", () => {
  assert.equal(changeVs(354, 325, "September"), "+9% vs September");
  assert.equal(changeVs(90, 100, "September"), "-10% vs September");
  assert.equal(changeVs(1002, 1000, "September"), "same as September");
  assert.equal(changeVs(19, 19, "September"), "same as September");
  assert.equal(changeVs(5, 0, "September"), null);
  const pnw = composePost(loadFixture("pacific-northwest-2026-10"));
  assert.equal(field(pnw.embeds, "Events")!.value, "19 (same as September)");
  assert.equal(field(pnw.embeds, "Players")!.value, "534 (+5% vs September)");
  // Coverage counts the month's qualifying events, the same number as the scene shows.
  const data = loadFixture("pacific-northwest-2026-10");
  assert.equal(data.coverage.qualifyingEvents, data.scene.events);
  data.coverage = { qualifyingEvents: 19, pctEntriesWithLeader: 78.3, pctEntriesWithPlayer: 98.6 };
  assert.equal(field(composePost(data).embeds, "Coverage")!.value, "19 qualifying events in October · 78% of entries with decklists · 99% of entries have a linked player");
  data.coverage.pctEntriesWithPlayer = null;
  assert.equal(field(composePost(data).embeds, "Coverage")!.value, "19 qualifying events in October · 78% of entries with decklists");
});

test("medals: 🥇🥈🥉 then keycaps to 🔟, a number after that or when switched off", () => {
  const data = loadFixture("global-2026-10");
  const twelve = items(composePost(data, { ...POST_CONFIG, mostPlayedMax: 12 }).embeds, "Most played");
  assert.deepEqual(twelve.map((it) => it[0]!.split(" ")[0]), ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "11\\.", "12\\."]);
  const off = composePost(data, { ...POST_CONFIG, medals: 0 });
  assert.match(field(off.embeds, "Most played")!.value, /^1\\\. \*\*Kraum \/ Tymna the Weaver\*\*\n.+\n\n2\\\. /);
  // The preview shows plain numbers.
  assert.match(off.text, /\n1\. Kraum \/ Tymna the Weaver\n157 cuts · 9\.2% of cuts vs 8\.5% of field · ⚪ 🔵 ⚫ 🔴\n/);
  // Unranked sections never get one.
  for (const name of ["Winners", "Rising players", "Rising commanders", "Cooling commanders"]) {
    assert.doesNotMatch(field(composePost(data).embeds, name)!.value, /🥇|^1\\\./m, name);
  }
});

test("share bars: scaled to the month's most played commander, at least one cell, glyphs and width from the config", () => {
  const data = loadFixture("global-2026-10");
  data.colors = {};
  data.metaShare = [
    { commander: "Top", entries: 100, metaShare: 0.2, topCuts: 0 },
    { commander: "Half", entries: 50, metaShare: 0.1, topCuts: 0 },
    { commander: "Third", entries: 33, metaShare: 0.066, topCuts: 0 },
    { commander: "Tiny", entries: 1, metaShare: 0.002, topCuts: 0 },
  ];
  assert.deepEqual(items(composePost(data).embeds, "Most played"), [
    ["🥇 **Top**", "▰▰▰▰▰▰▰▰▰▰ 20.0% · 100 entries"],
    ["🥈 **Half**", "▰▰▰▰▰▱▱▱▱▱ 10.0% · 50 entries"],
    ["🥉 **Third**", "▰▰▰▱▱▱▱▱▱▱ 6.6% · 33 entries"],
    ["4️⃣ **Tiny**", "▰▱▱▱▱▱▱▱▱▱ 0.2% · 1 entry"],
  ]);
  const custom = items(composePost(data, { ...POST_CONFIG, barWidth: 4, barFilled: "#", barEmpty: "." }).embeds, "Most played");
  assert.deepEqual(custom.map((it) => it[1]!.split(" ")[0]), ["####", "##..", "#...", "#..."]);
  assert.deepEqual(items(composePost(data, { ...POST_CONFIG, shareBars: 0 }).embeds, "Most played").map((it) => it[1]), ["20.0% · 100 entries", "10.0% · 50 entries", "6.6% · 33 entries", "0.2% · 1 entry"]);
  for (const name of FULL) {
    const most = items(composePost(loadFixture(name)).embeds, "Most played");
    assert.match(most[0]![1]!, /^▰{10} \d+\.\d% · [\d,]+ entries/, most[0]![1]);
    for (const it of most) assert.match(it[1]!, /^[▰▱]{10} \d+\.\d% · [\d,]+ entr(y|ies)( · \S.*)?$/, it[1]);
  }
});

test("color identity: circles in WUBRG order with a space between, a pair's union, colorless, none without a match", () => {
  const data = loadFixture("global-2026-10");
  data.metaShare = [
    { commander: "Sisay, Weatherlight Captain", entries: 50, metaShare: 0.1, topCuts: 0 },
    { commander: "Kraum, Ludevic's Opus / Tymna the Weaver", entries: 40, metaShare: 0.08, topCuts: 0 },
    { commander: "Kinnan, Bonder Prodigy", entries: 30, metaShare: 0.06, topCuts: 0 },
    { commander: "Kozilek, the Great Distortion", entries: 20, metaShare: 0.04, topCuts: 0 },
    { commander: "Not A Card", entries: 10, metaShare: 0.02, topCuts: 0 },
  ];
  // The map is keyed on the full registered text; the name shown is the short one.
  data.colors = { "Sisay, Weatherlight Captain": "WUBRG", "Kraum, Ludevic's Opus / Tymna the Weaver": "WUBR", "Kinnan, Bonder Prodigy": "UG", "Kozilek, the Great Distortion": "" };
  const cfg = { ...POST_CONFIG, shareBars: 0 };
  assert.deepEqual(items(composePost(data, cfg).embeds, "Most played"), [
    ["🥇 **Sisay, Weatherlight Captain**", "10.0% · 50 entries · ⚪ 🔵 ⚫ 🔴 🟢"],
    ["🥈 **Kraum / Tymna the Weaver**", "8.0% · 40 entries · ⚪ 🔵 ⚫ 🔴"],
    ["🥉 **Kinnan, Bonder Prodigy**", "6.0% · 30 entries · 🔵 🟢"],
    ["4️⃣ **Kozilek, the Great Distortion**", "4.0% · 20 entries · 🔘"],
    ["5️⃣ **Not A Card**", "2.0% · 10 entries"],
  ]);
  assert.deepEqual(POST_CONFIG.colorSymbols, { W: "⚪", U: "🔵", B: "⚫", R: "🔴", G: "🟢", colorless: "🔘", separator: " " });
  // Symbols and the separator are one config entry.
  const squares = { ...cfg, colorSymbols: { W: "🟨", U: "🟦", B: "🟪", R: "🟥", G: "🟩", colorless: "◇", separator: "" } };
  assert.deepEqual(items(composePost(data, squares).embeds, "Most played").map((it) => it[1]!.split(" · ").at(-1)), ["🟨🟦🟪🟥🟩", "🟨🟦🟪🟥", "🟦🟩", "◇", "10 entries"]);
  // Circles never touch each other: exactly one space between two of them, everywhere in a real post.
  for (const name of ALL) {
    for (const f of fields(composePost(loadFixture(name)).embeds)) {
      assert.doesNotMatch(f.value, /[⚪🔵⚫🔴🟢🔘][⚪🔵⚫🔴🟢🔘]/u, f.name);
      assert.doesNotMatch(f.value, /[⚪🔵⚫🔴🟢🔘] {2,}[⚪🔵⚫🔴🟢🔘]/u, f.name);
      assert.doesNotMatch(f.value, /[🟨🟦🟪🟥🟩]/u, `${f.name}: no squares`);
    }
  }
  // Switched off, or data without colors: none anywhere.
  assert.doesNotMatch(JSON.stringify(composePost(data, { ...POST_CONFIG, colorSquares: 0 }).embeds), CIRCLES);
  delete data.colors;
  assert.doesNotMatch(JSON.stringify(composePost(data).embeds), CIRCLES);
  // Every commander the fixtures can show has a color entry.
  for (const name of ALL) {
    const d = loadFixture(name);
    assert.deepEqual(Object.keys(d.colors!), commandersShown(d), name);
    for (const v of Object.values(d.colors!)) assert.match(v, /^W?U?B?R?G?$/);
  }
});

test("commandersShown: winners, top players, deck stats and trend rows that can be listed; no placeholder", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.results = [{ ...data.results[0]!, result: "final drawn", resultCommanders: "Only In Results; unknown" }];
  data.topPlayers = [{ name: "X", wins: 1, topCuts: 1, commander: "Only A Top Player's" }, { name: "Y", wins: 0, topCuts: 1, commander: null }];
  data.trend = [
    { commander: "Trend Ten", lastMonthEntries: 10, prior3AvgEntries: 1, shareChange: 1, isNew: false, firstSeen: null },
    { commander: "Trend Nine", lastMonthEntries: 9, prior3AvgEntries: 1, shareChange: 1, isNew: false, firstSeen: null },
    { commander: "Was Big Before", lastMonthEntries: 0, prior3AvgEntries: 12, shareChange: -1, isNew: false, firstSeen: null },
  ];
  const shown = commandersShown(data);
  for (const name of ["Only In Results", "Only A Top Player's", "Trend Ten", "Was Big Before", data.metaShare[0]!.commander, data.ppg[0]!.commander, data.topCutAppearances[0]!.commander]) {
    assert.ok(shown.includes(name), name);
  }
  assert.ok(!shown.includes("unknown") && !shown.includes("Trend Nine"));
  assert.deepEqual(shown, [...shown].sort());
  assert.equal(new Set(shown).size, shown.length);
});

test("every look switch off: one plain line per item inside the same embeds", () => {
  for (const name of FULL) {
    const { embeds } = composePost(loadFixture(name), PLAIN);
    assert.equal(embeds[0]!.description, undefined);
    const body = fields(embeds).filter((f) => !f.value.includes("TopDeck.gg")).map((f) => f.value).join("\n");
    assert.doesNotMatch(body, /\*\*|🥇|🏆|🎯|🆕|🔥|🧊|▰|▱|⚪|🔵|⚫|🔴|🟢|\n\n/u, name);
    for (const l of lines(embeds, "Winners")) assert.match(l, /^• \d+p · /, l);
    for (const l of lines(embeds, "Most played")) assert.match(l, /^\d+\\\. .+ — \d+\.\d% · [\d,]+ entries$/, l);
    for (const l of lines(embeds, "Best results")) assert.match(l, /^\d+\\\. .+ — \d\.\d\d · [\d,]+ entries$/, l);
    for (const l of lines(embeds, "Top-cut conversion")) assert.match(l, /^\d+\\\. .+ — \d+% · [\d,]+ of [\d,]+ entr(y|ies)$/, l);
    assert.ok(contentLength(embeds) < contentLength(composePost(loadFixture(name)).embeds));
    // Each switch still exists.
    for (const key of ["headline", "medals", "lineIcons", "boldNames", "winnersTwoLines", "detailOnSecondLine", "spacing", "shareBars", "colorSquares", "embeds", "sectionEmoji", "largestEventInline"]) {
      assert.ok(key in POST_CONFIG, key);
    }
  }
});

test("trim order: decoration first, then commanders bottom-up, then the player sections, Winners last", () => {
  const data = loadFixture("global-2026-10");
  const full = composePost(data).embeds;
  const value = (e: Embed[], name: string) => field(e, name)?.value ?? "";
  const at = (budget: number) => composePost(data, { ...POST_CONFIG, contentBudget: budget }).embeds;
  const others = (e: Embed[], except: string) => fields(e).filter((f) => !plain(f.name).startsWith(except)).map((f) => f.value).join("\n");
  const count = (e: Embed[]) => LISTS.map((l) => lines(e, l).filter((x) => /\*\*/.test(x)).length);
  assert.deepEqual(count(full), [5, 5, 3, 5, 5, 5, 5, 3, 3]);

  // 1 and 2: the top-cut lines lose detail (both shares, the ratio, the count alone); nothing else moves.
  const ratio = at(contentLength(full) - 1);
  assert.match(value(ratio, "Top-cut appearances"), /× its field share/);
  assert.equal(others(ratio, "Top-cut"), others(full, "Top-cut"));
  const countOnly = at(contentLength(ratio) - 1);
  assert.doesNotMatch(value(countOnly, "Top-cut appearances"), /field/);
  assert.match(value(countOnly, "Top-cut appearances"), /^🥇 \*\*Kraum \/ Tymna the Weaver\*\*\n157 cuts · ⚪ 🔵 ⚫ 🔴\n\n/);
  assert.equal(others(countOnly, "Top-cut"), others(full, "Top-cut"));
  // 3: the blank lines go. 4: the share bars. 5: the color symbols. No item has been dropped yet.
  const tight = at(contentLength(countOnly) - 1);
  assert.ok(!fields(tight).some((f) => f.value.includes("\n\n")));
  assert.match(value(tight, "Most played"), /▰/);
  const noBars = at(contentLength(tight) - 1);
  assert.doesNotMatch(value(noBars, "Most played"), /▰|▱/);
  assert.match(value(noBars, "Most played"), CIRCLES);
  const noColors = at(contentLength(noBars) - 1);
  assert.doesNotMatch(JSON.stringify(noColors), CIRCLES);
  assert.deepEqual(count(noColors), count(full));
  // 6: only now a line goes, from the bottom of the commanders block.
  const firstCut = at(contentLength(noColors) - 1);
  assert.deepEqual(count(firstCut), [5, 5, 3, 5, 5, 5, 5, 3, 2]);

  // From there down: the player sections are untouched until the commanders are at their floor (Most played
  // keeps three), and Winners until the player sections are gone.
  let sawPlayersTrim = false;
  let sawWinnersTrim = false;
  for (let budget = contentLength(firstCut); budget >= 600; budget -= 40) {
    const e = at(budget);
    const [winners, topPlayers, risingPlayers, topCut, most, best, conv, rising, cooling] = count(e) as [number, number, number, number, number, number, number, number, number];
    if (topPlayers < 5 || risingPlayers < 3) {
      sawPlayersTrim = true;
      assert.deepEqual([topCut, most, best, conv, rising, cooling], [0, 3, 0, 0, 0, 0], `budget ${budget}: players trimmed while commanders still had room to give`);
    }
    if (winners < 5) {
      sawWinnersTrim = true;
      assert.deepEqual([topPlayers, risingPlayers], [0, 0], `budget ${budget}: winners trimmed before the player sections`);
      assert.ok(winners >= 3);
    }
    assert.ok(e[0]!.description === full[0]!.description && value(e, "Coverage") === value(full, "Coverage") && value(e, "Events") === value(full, "Events"), "headline, scene and coverage never trim");
    assert.deepEqual(discordLimitViolations(e), []);
  }
  assert.ok(sawPlayersTrim && sawWinnersTrim, "the loop reached the player sections and then Winners");
});

test("rising commanders: 'new since' for a commander first seen in the last 2 months", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const row = (commander: string, lastMonthEntries: number, prior3AvgEntries: number, shareChange: number | null, firstSeen: string | null) =>
    ({ commander, lastMonthEntries, prior3AvgEntries, shareChange, isNew: prior3AvgEntries === 0, firstSeen });
  data.trend = [
    row("Dack Fayden, Helping Hand", 93, 4 / 3, 60, "2026-09-26"), // has prior entries, but first seen last month
    row("Brand New, This Month", 14, 0, null, "2026-10-03"),
    row("First Of Last Month", 12, 1, 5, "2026-09-01"), // the boundary is the first day of the month before
    row("Just Too Old", 20, 2, 4, "2026-08-31"), // one day before the boundary: an ordinary riser
    row("Back After A Break", 11, 0, null, "2024-05-18"), // nothing in the prior 3 months, but an old card
    row("Date Unknown", 13, 0, null, null),
    row("Falling But New", 30, 60, -0.5, "2026-09-10"), // falling, but new: never listed as cooling
    row("Falling And Old", 8, 40, -0.8, "2024-01-01"),
  ];
  const all = composePost(data, { ...PLAIN, risingMax: 10 }).embeds;
  assert.deepEqual(lines(all, "Rising commanders"), [
    "Dack Fayden, Helping Hand — 93 entries in October, new since Sep 26",
    "Falling But New — 30 entries in October, new since Sep 10",
    "Brand New, This Month — 14 entries in October, new since Oct 3",
    "Date Unknown — 13 entries in October, new",
    "First Of Last Month — 12 entries in October, new since Sep 1",
    "Back After A Break — 11 entries in October, new",
    "Just Too Old — 20 entries in October (avg 2/month)",
  ]);
  assert.deepEqual(lines(all, "Cooling commanders"), ["Falling And Old — 8 entries in October (avg 40/month)"]);
  // 🆕 marks both kinds of new commander; 🔥 the ordinary riser.
  const marked = items(composePost(data, { ...POST_CONFIG, risingMax: 10 }).embeds, "Rising commanders").map((it) => it[0]!.split(" ")[0]);
  assert.deepEqual(marked, ["🆕", "🆕", "🆕", "🆕", "🆕", "🆕", "🔥"]);
  // Three months: August now counts as recent. Zero: the date is never used.
  const three = field(composePost(data, { ...PLAIN, risingMax: 10, newCommanderMonths: 3 }).embeds, "Rising commanders")!.value;
  assert.match(three, /Just Too Old — 20 entries in October, new since Aug 31/);
  const off = field(composePost(data, { ...PLAIN, risingMax: 10, newCommanderMonths: 0 }).embeds, "Rising commanders")!.value;
  assert.doesNotMatch(off, /new since/);
  assert.match(off, /Dack Fayden, Helping Hand — 93 entries in October \(avg 1\/month\)/);
  assert.equal(shortDate("2026-01-05"), "Jan 5");
  // January report: the month before is December of the previous year.
  const jan = loadFixture("pacific-northwest-2026-10");
  jan.month = "2027-01";
  jan.trend = [row("Year Boundary", 15, 0, null, "2026-12-02"), row("Too Old", 15, 0, null, "2026-11-30")];
  assert.deepEqual(lines(composePost(jan, PLAIN).embeds, "Rising commanders"),
    ["Too Old — 15 entries in January, new", "Year Boundary — 15 entries in January, new since Dec 2"]);
});

test("top-cut appearances: share of cuts against share of field, with shorter forms under budget pressure", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const t = { totalTopCutEntries: 200, totalFieldEntries: 1000 };
  data.topCutAppearances = [
    { commander: "Kraum, Ludevic's Opus / Tymna the Weaver", topCutEntries: 20, fieldEntries: 80, ...t }, // 10.0% of cuts vs 8.0% of field
    { commander: "Kinnan, Bonder Prodigy", topCutEntries: 10, fieldEntries: 100, ...t }, // 5.0% vs 10.0%
    { commander: "No Field Numbers", topCutEntries: 3, fieldEntries: 0, totalTopCutEntries: 0, totalFieldEntries: 0 },
    { commander: "One Cut", topCutEntries: 1, fieldEntries: 1, ...t },
  ];
  const old = (detail: number) => lines(composePost(data, { ...PLAIN, topCutDetail: detail }).embeds, "Top-cut appearances");
  assert.deepEqual(old(2), [
    "1\\. Kraum / Tymna the Weaver — 20 cuts · 10.0% of cuts vs 8.0% of field",
    "2\\. Kinnan, Bonder Prodigy — 10 cuts · 5.0% of cuts vs 10.0% of field",
    "3\\. No Field Numbers — 3 cuts",
    "4\\. One Cut — 1 cut · 0.5% of cuts vs 0.1% of field",
  ]);
  assert.deepEqual(old(1), [
    "1\\. Kraum / Tymna the Weaver — 20 cuts · 1.25× its field share",
    "2\\. Kinnan, Bonder Prodigy — 10 cuts · 0.50× its field share",
    "3\\. No Field Numbers — 3 cuts",
    "4\\. One Cut — 1 cut · 5.00× its field share",
  ]);
  assert.deepEqual(old(0), ["1\\. Kraum / Tymna the Weaver — 20 cuts", "2\\. Kinnan, Bonder Prodigy — 10 cuts", "3\\. No Field Numbers — 3 cuts", "4\\. One Cut — 1 cut"]);

  // The name, then the numbers and the colors on their own line.
  data.colors = { "Kinnan, Bonder Prodigy": "UG" };
  assert.deepEqual(items(composePost(data).embeds, "Top-cut appearances"), [
    ["🥇 **Kraum / Tymna the Weaver**", "20 cuts · 10.0% of cuts vs 8.0% of field"],
    ["🥈 **Kinnan, Bonder Prodigy**", "10 cuts · 5.0% of cuts vs 10.0% of field · 🔵 🟢"],
    ["🥉 **No Field Numbers**", "3 cuts"],
    ["4️⃣ **One Cut**", "1 cut · 0.5% of cuts vs 0.1% of field"],
  ]);
  assert.equal(field(composePost(data).embeds, "Top-cut appearances")!.name, "🎯 Top-cut appearances");
});

test("player names are cut at a word boundary, not mid-word", () => {
  const max = POST_CONFIG.playerNameMax;
  const words = (s: string) => sanitizeOrganizerText(s, max, { wholeWords: true });
  assert.equal(max, 40);
  assert.equal(words("Hooligan Riley Atkinson Crucible"), "Hooligan Riley Atkinson Crucible"); // fits now
  assert.equal(words("Hooligan Riley Atkinson Crucible of Worlds Podcast"), "Hooligan Riley Atkinson Crucible of…");
  assert.equal(words("Jonathan Fitzgerald Montgomery-Smith // PodcastName"), "Jonathan Fitzgerald Montgomery-Smith…"); // dangling "//" dropped
  assert.equal(words("Exactly forty characters long name here!"), "Exactly forty characters long name here!");
  // The cut already falls between words: nothing more is dropped.
  assert.equal(words("Exactly thirty-nine characters in name! and more"), "Exactly thirty-nine characters in name!…");
  // One very long word (or a short first word) is still cut mid-word instead of vanishing.
  assert.equal(words("X".repeat(60)), `${"X".repeat(39)}…`);
  assert.equal(words(`Al ${"y".repeat(60)}`), `Al ${"y".repeat(36)}…`);
  for (const s of ["Hooligan Riley Atkinson Crucible of Worlds Podcast", "X".repeat(60), `Al ${"y".repeat(60)}`]) assert.ok(words(s).length <= max);
  // Event names keep the plain cut.
  assert.equal(sanitizeOrganizerText("Hooligan Riley Atkinson Crucible of Worlds Podcast", 32), "Hooligan Riley Atkinson Crucibl…");
  const data = loadFixture("pacific-northwest-2026-10");
  data.topPlayers = [{ name: "Hooligan Riley Atkinson Crucible of Worlds Podcast", wins: 1, topCuts: 2, commander: null }];
  assert.equal(field(composePost(data, PLAIN).embeds, "Top players")!.value, "1\\. Hooligan Riley Atkinson Crucible of… — 1 win, 2 top cuts");
  assert.equal(field(composePost(data).embeds, "Top players")!.value, "🥇 **Hooligan Riley Atkinson Crucible of…**\n🏆 1 win · 🎯 2 top cuts");
});

test("shortenCommander, sanitizeOrganizerText and monthlyAvg", () => {
  assert.equal(shortenCommander("Kraum, Ludevic's Opus / Tymna the Weaver"), "Kraum / Tymna the Weaver");
  assert.equal(shortenCommander("Kinnan, Bonder Prodigy"), "Kinnan, Bonder Prodigy");
  assert.equal(sanitizeOrganizerText("  **Big** <@1> @everyone  event  ", 50), "Big 1 everyone event");
  assert.equal(sanitizeOrganizerText("see https://x.example/y and discord.gg/zz", 50), "see and");
  const t = sanitizeOrganizerText("a".repeat(80), 50);
  assert.equal(t.length, 50);
  assert.ok(t.endsWith("…"));
  assert.equal(monthlyAvg(0.67), "<1");
  assert.equal(monthlyAvg(2.5), "3");
});

test("the default budget leaves every fixture untrimmed, and a post with the longest names still fits Discord", () => {
  assert.equal(POST_CONFIG.contentBudget, 4800);
  for (const name of ALL) {
    const d = loadFixture(name);
    assert.equal(composePost(d).text, composePost(d, { ...POST_CONFIG, contentBudget: DISCORD_LIMITS.total }).text, name);
    assert.ok(contentLength(composePost(d).embeds) <= 4300, `${name}: room under the budget`);
  }
  // Every name at its longest and five colors everywhere: over the budget untrimmed, within it after trimming.
  const worst = loadFixture("global-2026-10");
  const long = (i: number) => `Commanderwithaverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner ${i}, Subtitle`;
  const player = "Player With A Remarkably Long Display Name Here";
  worst.results = worst.results.map((r, i) => ({ ...r, eventName: "E".repeat(60), winnerName: player, resultCommanders: long(i) }));
  worst.topPlayers = worst.topPlayers.map((p, i) => ({ ...p, name: player, commander: long(i) }));
  worst.risingPlayers = worst.risingPlayers.map((p) => ({ ...p, name: player, eventName: "E".repeat(60) }));
  worst.topCutAppearances = worst.topCutAppearances.map((x, i) => ({ ...x, commander: long(i) }));
  worst.metaShare = worst.metaShare.map((x, i) => ({ ...x, commander: long(i) }));
  worst.ppg = worst.ppg.map((x, i) => ({ ...x, commander: long(i) }));
  worst.conversion = worst.conversion.map((x, i) => ({ ...x, commander: long(i) }));
  worst.trend = worst.trend.map((x, i) => ({ ...x, commander: long(i) }));
  worst.colors = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [long(i), "WUBRG"]));
  assert.ok(contentLength(composePost(worst, { ...POST_CONFIG, contentBudget: DISCORD_LIMITS.total }).embeds) > POST_CONFIG.contentBudget);
  assertWithinLimits(composePost(worst).embeds);
});
