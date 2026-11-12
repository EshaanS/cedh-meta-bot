// Tests for the v3 monthly post composer (several embeds in one message). Runs on committed fixtures (no
// database). Snapshots: test/__snapshots__/<name>.txt; set UPDATE_SNAPSHOTS=1 to rewrite them.
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

const FIXTURES = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10"];
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const snapshotPath = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}.txt`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(fixturePath(name), "utf8")) as PostData;
/** A field name without its emoji prefix; the continued Winners field becomes "". */
const plain = (name: string) => name.replace(/^[^A-Za-z]+/, "");
const fields = (embeds: Embed[]) => embeds.flatMap((e) => e.fields);
const field = (embeds: Embed[], prefix: string) => fields(embeds).find((f) => plain(f.name).startsWith(prefix));
const lines = (embeds: Embed[], prefix: string) => field(embeds, prefix)?.value.split("\n") ?? [];
/** All Winners lines: the field and, when it was split, the one that continues it. */
const winnerLines = (embeds: Embed[]) => {
  const all = fields(embeds);
  const at = all.findIndex((f) => plain(f.name).startsWith("Winners"));
  if (at < 0) return [];
  const next = all[at + 1];
  return [all[at]!, ...(next && next.name === POST_CONFIG.continuedFieldName ? [next] : [])].flatMap((f) => f.value.split("\n")).filter((l) => l !== "");
};
const OFF = Object.fromEntries(Object.keys(POST_CONFIG.spacing).map((k) => [k, 0])) as PostConfig["spacing"];
/** Every look switch off: one plain line per item, as the post read before the redesign. */
const PLAIN: PostConfig = {
  ...POST_CONFIG, headline: 0, medals: 0, boldNames: 0, winnersTwoLines: 0, detailOnSecondLine: 0, shareBars: 0, colorSquares: 0, spacing: OFF,
  lineIcons: { win: "", topCut: "", newCommander: "", rising: "", cooling: "" },
};

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
    for (const f of e.fields) assert.ok(f.value.length > 0 && f.value.length <= DISCORD_LIMITS.fieldValue, `field ${f.name}`);
    assert.equal("footer" in e, false);
  }
  assert.ok(contentLength(embeds) <= DISCORD_LIMITS.total);
  assert.ok(contentLength(embeds) <= budget, `content ${contentLength(embeds)} > ${budget}`);
}

for (const name of FIXTURES) {
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

  test(`section order and no region types shown: ${name}`, () => {
    const { embeds } = composePost(loadFixture(name));
    const order = ["Events", "Players", "Draw rate", "Largest event", "Winners", "Top players", "Rising players", "Top-cut appearances",
      "Most played", "Best results", "Top-cut conversion", "Rising commanders", "Cooling commanders", "Coverage", "Sources"];
    const seen = fields(embeds).filter((f) => plain(f.name) !== "").map((f) => order.findIndex((o) => plain(f.name).startsWith(o)));
    assert.ok(seen.every((i) => i >= 0), "unknown section");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "sections out of order");
    const all = embeds.map((e) => `${e.title ?? ""} ${e.description ?? ""}`).join(" ");
    assert.doesNotMatch(all, /admin1|admin1_group|macro|custom region|\(continent\)|\(country\)/);
    assert.equal(embeds[0]!.fields.filter((f) => f.inline).length, 3);
  });
}

test("embeds: four in one message, each with a title and its own color; an empty block is left out", () => {
  const { embeds, text } = composePost(loadFixture("global-2026-10"));
  assert.deepEqual(embeds.map((e) => e.title), ["Global — cEDH meta, October 2026", "👥 Players — October", "🃏 Commanders — October", "ℹ️ About this report"]);
  assert.deepEqual(embeds.map((e) => e.color), [0xc9a84c, 0x4a90d9, 0x4caf7a, 0x8a8f98]);
  assert.equal(new Set(embeds.map((e) => e.color)).size, 4);
  assert.deepEqual(embeds.map((e) => e.fields.map((f) => f.name)), [
    ["📍 Events — October", "Players", "Draw rate", "Largest event"],
    ["🏆 Winners (largest events)", "​", "👑 Top players", "🌱 Rising players (first win or top cut in 3 years of data)"],
    ["🎯 Top-cut appearances — October", "📊 Most played (6 months)", "⭐ Best results (adjusted PPG, 30+ entries)", "🔀 Top-cut conversion (baseline 26%)",
      "📈 Rising commanders (by share growth vs prior 3 months)", "📉 Cooling commanders (by share drop vs prior 3 months)"],
    ["ℹ️ Coverage", "🔗 Sources"],
  ]);
  // Only the first embed has a description; nothing is a divider any more.
  assert.deepEqual(embeds.map((e) => e.description !== undefined), [true, false, false, false]);
  assert.ok(!fields(embeds).some((f) => /^[━─]+$/.test(f.name)));
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

  // No people: that embed is left out. No decks either: overview and about only.
  const quiet = loadFixture("global-2026-10");
  quiet.results = [];
  quiet.topPlayers = [];
  quiet.risingPlayers = [];
  assert.deepEqual(composePost(quiet).embeds.map((e) => e.title), ["Global — cEDH meta, October 2026", "🃏 Commanders — October", "ℹ️ About this report"]);
  quiet.resolved = { ...quiet.resolved, reportable: false };
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

test("headline: biggest event and winner, top-cut leader or most played, rising commander or player", () => {
  const global = composePost(loadFixture("global-2026-10")).embeds[0]!;
  assert.deepEqual(global.description!.split("\n"), [
    "🏆 **MBG Commanderpalooza #3 (TimeTwister event)** (150 players) went to **Mara Ellison** on Kraum / Tymna the Weaver",
    "🎯 **Kraum / Tymna the Weaver** made the most top cuts: 157",
    "📈 **Dack Fayden, Helping Hand** is the commander to watch: 93 entries in October, new since Sep 26",
  ]);
  // Europe: two commanders tie for the most top cuts, so the second line is the most played one. The fallback
  // note stays first, with a blank line before the headline.
  const europe = composePost(loadFixture("si-2026-10")).embeds[0]!.description!.split("\n");
  assert.equal(europe[0], "Showing Europe: Slovenia didn't have enough data.");
  assert.equal(europe[1], "");
  assert.equal(europe[3], "📊 **Kraum / Tymna the Weaver** is the most played commander: 9.5% of entries over 6 months");
  assert.equal(europe.length, 5);

  const data = loadFixture("global-2026-10");
  const head = (d: PostData, cfg: PostConfig = POST_CONFIG) => composePost(d, cfg).embeds[0]!.description?.split("\n") ?? [];
  // Too few cuts for a leader: most played. No rising commander: the first rising player.
  assert.match(head(data, { ...POST_CONFIG, headlineMinCuts: 500 })[1]!, /^📊 \*\*Kraum \/ Tymna the Weaver\*\* is the most played commander: 7\.7%/);
  data.trend = [];
  assert.equal(head(data)[2], "🌱 **Noor Haddad** is the player to watch: first top cut at MBG Commanderpalooza #3 (TimeTwister event) (150 players)");
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
  // Switched off: no description at all when there is no note. The copy is config.
  assert.equal(composePost(loadFixture("global-2026-10"), { ...POST_CONFIG, headline: 0 }).embeds[0]!.description, undefined);
  const copy = { ...POST_CONFIG.headlineCopy, topCut: "{commander} leads with {cuts} cuts" };
  assert.equal(head(loadFixture("global-2026-10"), { ...POST_CONFIG, headlineCopy: copy })[1], "Kraum / Tymna the Weaver leads with 157 cuts");
  // The headline is never trimmed.
  const tight = composePost(loadFixture("global-2026-10"), { ...POST_CONFIG, contentBudget: 1500 }).embeds;
  assert.equal(tight[0]!.description, global.description);
});

test("winners: two lines each, labels for every result type, no '+N more'", () => {
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
  const old = lines(composePost(data, PLAIN).embeds, "Winners");
  assert.equal(old.length, POST_CONFIG.winnersMax);
  assert.match(old[0]!, /^• 150p · .* · Kraum \/ Tymna the Weaver$/);
  assert.match(old[1]!, /· drawn final: Kinnan, Bonder Prodigy, unknown commander$/);
  assert.match(old[2]!, /· no single winner$/);
  assert.match(old[3]!, /· winner not recorded$/);
  assert.match(old[4]!, /· Mara Ellison on Kinnan, Bonder Prodigy$/);
  assert.match(old[5]!, /· a player on Kinnan, Bonder Prodigy$/);
  assert.match(old[6]!, /· Mara Ellison on unknown commander$/);
  assert.ok(!old.some((l) => /more$/.test(l)));

  // Redesigned: the event and its size, then the outcome; a trophy only where there is a winner.
  const now = winnerLines(composePost(data).embeds);
  assert.equal(now.length, 2 * POST_CONFIG.winnersMax);
  const event = "**MBG Commanderpalooza #3 (TimeTwister event)** · 150 players";
  assert.deepEqual(now.slice(0, 14), [
    event, "🏆 Kraum / Tymna the Weaver 🟨🟦🟪🟥",
    event, "drawn final: Kinnan, Bonder Prodigy 🟦🟩, unknown commander",
    event, "no single winner",
    event, "winner not recorded",
    event, "🏆 Mara Ellison on Kinnan, Bonder Prodigy 🟦🟩",
    event, "🏆 a player on Kinnan, Bonder Prodigy 🟦🟩",
    event, "🏆 Mara Ellison on unknown commander",
  ]);
  // A blank line between winners (the spacing switch), none when it is off.
  assert.match(field(composePost(data).embeds, "Winners")!.value, /players\n.+\n\n\*\*/);
  assert.doesNotMatch(field(composePost(data, { ...POST_CONFIG, spacing: OFF }).embeds, "Winners")!.value, /\n\n/);
});

test("winners past 1,024 characters become two fields and every winner still shows", () => {
  const data = loadFixture("global-2026-10");
  data.results = Array.from({ length: 10 }, (_, i) => ({
    eventName: `Very long organizer event name number ${i} ${"Z".repeat(80)}`,
    participantCount: 200 - i,
    result: "winner",
    resultCommanders: `Commanderwithaveryveryverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner Name ${i}, Subtitle`,
    winnerName: `Player With A Remarkably Long Display Name ${i}`,
    winnerHidden: false,
  }));
  const { embeds, text } = composePost(data);
  assertWithinLimits(embeds);
  const people = embeds[1]!.fields;
  assert.deepEqual(people.slice(0, 2).map((f) => f.name), ["🏆 Winners (largest events)", POST_CONFIG.continuedFieldName]);
  // The post is over budget with names this long, so the blank lines between winners are already gone.
  const events = (f: { value: string }) => f.value.split("\n").filter((l) => l.startsWith("**")).length;
  assert.equal(events(people[0]!), POST_CONFIG.winnersSplitAt, "the first five");
  assert.equal(events(people[1]!), 10 - POST_CONFIG.winnersSplitAt, "the next five");
  assert.equal(winnerLines(embeds).filter((l) => l.startsWith("🏆 ")).length, 10);
  assert.equal(text.split("\n").filter((l) => l.startsWith("🏆 Player With")).length, 10);
  // A short list stays one field.
  const pnw = composePost(loadFixture("pacific-northwest-2026-10")).embeds[1]!.fields;
  assert.deepEqual(pnw.map((f) => plain(f.name)).slice(0, 2), ["Winners (largest events)", "Top players"]);
  assert.equal(events(pnw[0]!), 6);
  assert.equal(pnw[0]!.value.split("\n\n").length, 6, "with a blank line between winners");
  // Last resort: when a half still doesn't fit, lines are dropped and the field stays within the limit.
  const wide = composePost(data, { ...POST_CONFIG, winnersSplitAt: 8 }).embeds;
  assertWithinLimits(wide);
  const first = events(wide[1]!.fields[0]!);
  assert.ok(first < 8 && first >= 4, `kept ${first} of 8`);
  assert.equal(events(wide[1]!.fields[1]!), 2);
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
  const winners = winnerLines(embeds);
  assert.equal(winners[3], "🏆 a player on Kinnan, Bonder Prodigy 🟦🟩");
  assert.match(winners[1]!, /^🏆 everyone Mallory 42 free\( x y… on Kinnan, Bonder Prodigy 🟦🟩$/);
  const top = lines(embeds, "Top players");
  assert.equal(top.length, 2, "one player on two lines: a name that sanitizes to nothing is dropped");
  assert.ok(/^🥇 \*\*(.+)\*\* — /.exec(top[0]!)![1]!.length <= POST_CONFIG.playerNameMax);
  for (const line of winners.filter((l) => l.startsWith("**"))) {
    assert.ok(/^\*\*(.+)\*\* · \d+ players$/.exec(line)![1]!.length <= POST_CONFIG.eventNameMax, line);
  }
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
});

test("the default budget keeps every section of the global post", () => {
  const { embeds } = composePost(loadFixture("global-2026-10"));
  assert.equal(POST_CONFIG.contentBudget, 5300);
  for (const name of ["Winners", "Top players", "Rising players", "Top-cut conversion", "Rising commanders", "Cooling commanders"]) {
    assert.ok(field(embeds, name), `${name} is present`);
  }
  assert.equal(winnerLines(embeds).length, 20, "ten winners on two lines each");
  assert.equal(lines(embeds, "Most played").length, 10);
  assert.match(field(embeds, "Top-cut appearances")!.value, /% of cuts vs \d+\.\d% of field/);
  assert.match(field(embeds, "Most played")!.value, /▰/);
  assert.match(field(embeds, "Most played")!.value, /🟦/);
});

test("budget trimming drops bottom sections first and keeps the post within budget", () => {
  const tight = { ...POST_CONFIG, contentBudget: 3400 };
  const data = loadFixture("global-2026-10");
  const long = (s: string) => `${s}, ${"Q".repeat(60)} / Partner ${s}, ${"R".repeat(60)}`;
  data.metaShare = data.metaShare.map((m) => ({ ...m, commander: long(m.commander) }));
  data.ppg = data.ppg.map((p) => ({ ...p, commander: `${p.commander} ${"Z".repeat(80)}` }));
  const before = composePost(loadFixture("global-2026-10")).embeds;
  const { embeds } = composePost(data, tight);
  assertWithinLimits(embeds, tight.contentBudget);
  if (field(before, "Cooling commanders")) assert.equal(field(embeds, "Cooling commanders"), undefined, "Cooling commanders should be trimmed first");
  assert.equal(winnerLines(embeds).length, winnerLines(before).length, "Winners are the last to be trimmed");
  assert.ok(field(embeds, "Top players"), "Top players trims after the commander sections");
});

test("rising and cooling: count display, eligibility and matching counts", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const top = data.metaShare.map((m) => m.commander);
  const old = "2024-01-13";
  data.trend = [
    // No entries here in the prior 3 months, but an old commander: plain "new".
    { commander: "Jace, Multiverse Architect", lastMonthEntries: 11, prior3AvgEntries: 0, shareChange: null, isNew: true, firstSeen: "2025-03-08" },
    { commander: top[1]!, lastMonthEntries: 12, prior3AvgEntries: 0.4, shareChange: 0.5, isNew: false, firstSeen: old },
    { commander: top[2]!, lastMonthEntries: 25, prior3AvgEntries: 22, shareChange: -0.06, isNew: false, firstSeen: old }, // entries up: not cooling
    { commander: top[3]!, lastMonthEntries: 4, prior3AvgEntries: 12, shareChange: -0.6, isNew: false, firstSeen: old }, // qualifies via prior avg
    { commander: "Not In Top 15", lastMonthEntries: 3, prior3AvgEntries: 30, shareChange: -0.9, isNew: false, firstSeen: old },
  ];
  const plainPost = composePost(data, PLAIN).embeds;
  const rising = lines(plainPost, "Rising commanders");
  assert.equal(rising[0], "Jace, Multiverse Architect — 11 entries in October, new");
  assert.match(rising[1]!, /— 12 entries in October \(avg <1\/month\)$/);
  assert.deepEqual(lines(plainPost, "Cooling commanders"), [`${shortenCommander(top[3]!)} — 4 entries in October (avg 12/month)`]);

  // Redesigned: an icon and the bold name on one line, the counts on the next. 🆕 new, 🔥 rising, 🧊 cooling.
  data.colors = {};
  const { embeds } = composePost(data);
  assert.deepEqual(lines(embeds, "Rising commanders"), [
    "🆕 **Jace, Multiverse Architect**", "11 entries in October, new",
    `🔥 **${shortenCommander(top[1]!)}**`, "12 entries in October (avg <1/month)",
  ]);
  assert.deepEqual(lines(embeds, "Cooling commanders"), [`🧊 **${shortenCommander(top[3]!)}**`, "4 entries in October (avg 12/month)"]);
});

test("sections with no qualifying rows are omitted", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.trend = [];
  data.conversion = [];
  data.topPlayers = [];
  data.risingPlayers = [];
  const { embeds } = composePost(data);
  assert.equal(field(embeds, "Rising commanders"), undefined);
  assert.equal(field(embeds, "Cooling commanders"), undefined);
  assert.equal(field(embeds, "Top players"), undefined);
  assert.equal(field(embeds, "Rising players"), undefined);
  assert.equal(field(embeds, "Top-cut conversion"), undefined);
});

test("fallback note names both regions; non-reportable regions show only scene, winners, player sections, coverage and sources", () => {
  const si = composePost(loadFixture("si-2026-10"));
  assert.match(si.embeds[0]!.description ?? "", /^Showing Europe: Slovenia didn't have enough data\./);
  const data = loadFixture("pacific-northwest-2026-10");
  data.resolved = { ...data.resolved, reportable: false };
  const { embeds } = composePost(data);
  assert.match(embeds[0]!.description ?? "", /^Not enough decklists yet for commander stats\./);
  for (const f of fields(embeds)) {
    assert.match(plain(f.name), /^(Events|Players|Draw rate|Largest event|Winners|Top players|Rising players|Coverage|Sources)/);
  }
  assert.deepEqual(embeds.map((e) => e.title), ["Pacific Northwest — cEDH meta, October 2026", "👥 Players — October", "ℹ️ About this report"]);
  // The headline has no commander line: nothing about commanders is in the post.
  assert.doesNotMatch(embeds[0]!.description!, /top cuts|most played|commander to watch/);
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
  assert.deepEqual(lines(embeds, "Top players"), [
    "🥇 **Mara Ellison** — 🏆 2 wins · 🎯 3 top cuts", "Kraum / Tymna the Weaver",
    "🥈 **Tobias Quill** — 🏆 1 win · 🎯 1 top cut", "Kinnan, Bonder Prodigy 🟦🟩",
    "🥉 **Ines Varga** — 🏆 1 win",
    "4️⃣ **Aiko Tanabe** — 🎯 2 top cuts",
    "5️⃣ **Extra 0** — 🎯 1 top cut",
  ]);
  // The month is in the embed's title, so the field names don't repeat it.
  assert.equal(field(embeds, "Top players")!.name, "👑 Top players");
  assert.equal(field(embeds, "Rising players")!.name, "🌱 Rising players (first win or top cut in 3 years of data)");
  assert.deepEqual(lines(embeds, "Rising players"), [
    "🏆 **Noor Haddad** — first win", "64 players · Big Event",
    "🎯 **Felix Brandt** — first top cut", "40 players · Unnamed event",
    "🎯 **Third** — top cut in first 5 events", "20 players · C",
  ]);
});

test("scene change wording and entry counts", () => {
  assert.equal(changeVs(354, 325, "September"), "+9% vs September");
  assert.equal(changeVs(90, 100, "September"), "-10% vs September");
  assert.equal(changeVs(1002, 1000, "September"), "same as September");
  assert.equal(changeVs(19, 19, "September"), "same as September");
  assert.equal(changeVs(5, 0, "September"), null);
  const pnw = composePost(loadFixture("pacific-northwest-2026-10"));
  assert.equal(field(pnw.embeds, "Events")!.value, "19 (same as September)");
  assert.equal(field(pnw.embeds, "Players")!.value, "534 (+5% vs September)");
  for (const name of ["Best results", "Top-cut conversion"]) {
    for (const line of lines(pnw.embeds, name)) {
      assert.match(line, / \(\d[\d,]* entries\)$/);
      assert.doesNotMatch(line, /n = /);
    }
  }
});

test("coverage line: share of the month's entries with a linked player, omitted when unknown", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.coverage = { qualifyingEvents: 114, pctEntriesWithLeader: 76.3, pctEntriesWithPlayer: 72.6 };
  assert.equal(field(composePost(data).embeds, "Coverage")!.value,
    "114 qualifying events over 6 months · 76% of entries with decklists · 73% of October entries have a linked player");
  data.coverage.pctEntriesWithPlayer = null;
  assert.equal(field(composePost(data).embeds, "Coverage")!.value, "114 qualifying events over 6 months · 76% of entries with decklists");
});

test("medals: 🥇🥈🥉 then keycaps to 🔟, a number after that or when switched off", () => {
  const data = loadFixture("global-2026-10");
  const twelve = lines(composePost(data, { ...POST_CONFIG, mostPlayedMax: 12 }).embeds, "Most played");
  assert.deepEqual(twelve.map((l) => l.split(" ")[0]), ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟", "11\\.", "12\\."]);
  const off = composePost(data, { ...POST_CONFIG, medals: 0 });
  assert.match(field(off.embeds, "Most played")!.value, /^1\\\. .+\n2\\\. /);
  assert.match(field(off.embeds, "Top players")!.value, /^1\\\. \*\*Mara Ellison\*\*/);
  // The preview shows plain numbers.
  assert.match(off.text, /\n1\. Kraum \/ Tymna the Weaver 🟨🟦🟪🟥\n157 cuts · 9\.2% of cuts vs 8\.5% of field\n/);
  // Unranked sections never get one.
  for (const name of ["Winners", "Rising players", "Rising commanders", "Cooling commanders"]) {
    assert.doesNotMatch(field(composePost(data).embeds, name)!.value, /🥇|^1\\\./m, name);
  }
});

test("share bars: scaled to the top commander, at least one cell, glyphs and width from the config", () => {
  const data = loadFixture("global-2026-10");
  data.colors = {};
  data.metaShare = [
    { commander: "Top", entries: 100, metaShare: 0.2 },
    { commander: "Half", entries: 50, metaShare: 0.1 },
    { commander: "Third", entries: 33, metaShare: 0.066 },
    { commander: "Tiny", entries: 1, metaShare: 0.002 },
  ];
  assert.deepEqual(lines(composePost(data).embeds, "Most played"), [
    "🥇 ▰▰▰▰▰▰▰▰▰▰ 20.0% · **Top**",
    "🥈 ▰▰▰▰▰▱▱▱▱▱ 10.0% · **Half**",
    "🥉 ▰▰▰▱▱▱▱▱▱▱ 6.6% · **Third**",
    "4️⃣ ▰▱▱▱▱▱▱▱▱▱ 0.2% · **Tiny**",
  ]);
  assert.deepEqual(lines(composePost(data, { ...POST_CONFIG, barWidth: 4, barFilled: "#", barEmpty: "." }).embeds, "Most played").map((l) => l.split(" ")[1]), ["####", "##..", "#...", "#..."]);
  assert.deepEqual(lines(composePost(data, { ...POST_CONFIG, shareBars: 0 }).embeds, "Most played"), [
    "🥇 **Top** — 20.0%", "🥈 **Half** — 10.0%", "🥉 **Third** — 6.6%", "4️⃣ **Tiny** — 0.2%",
  ]);
  // The scale is the 6-month leader even when trimming shortens the list.
  for (const name of FIXTURES) {
    const most = lines(composePost(loadFixture(name)).embeds, "Most played");
    assert.equal(most.length, 10);
    assert.match(most[0]!, /^🥇 ▰{10} \d+\.\d% · \*\*.+\*\*( \S+)?$/, most[0]);
    for (const l of most) assert.match(l, /^\S+ [▰▱]{10} \d+\.\d% · \*\*.+\*\*( \S+)?$/, l);
  }
});

test("color squares: WUBRG order after the name, a pair's union, colorless, none without a match", () => {
  const data = loadFixture("global-2026-10");
  data.metaShare = [
    { commander: "Sisay, Weatherlight Captain", entries: 50, metaShare: 0.1 },
    { commander: "Kraum, Ludevic's Opus / Tymna the Weaver", entries: 40, metaShare: 0.08 },
    { commander: "Kinnan, Bonder Prodigy", entries: 30, metaShare: 0.06 },
    { commander: "Kozilek, the Great Distortion", entries: 20, metaShare: 0.04 },
    { commander: "Not A Card", entries: 10, metaShare: 0.02 },
  ];
  // The map is keyed on the full registered text; the name shown is the short one.
  data.colors = { "Sisay, Weatherlight Captain": "WUBRG", "Kraum, Ludevic's Opus / Tymna the Weaver": "WUBR", "Kinnan, Bonder Prodigy": "UG", "Kozilek, the Great Distortion": "" };
  const cfg = { ...POST_CONFIG, shareBars: 0 };
  assert.deepEqual(lines(composePost(data, cfg).embeds, "Most played"), [
    "🥇 **Sisay, Weatherlight Captain** 🟨🟦🟪🟥🟩 — 10.0%",
    "🥈 **Kraum / Tymna the Weaver** 🟨🟦🟪🟥 — 8.0%",
    "🥉 **Kinnan, Bonder Prodigy** 🟦🟩 — 6.0%",
    "4️⃣ **Kozilek, the Great Distortion** 🔘 — 4.0%",
    "5️⃣ **Not A Card** — 2.0%",
  ]);
  // The symbols are config: the literal white and black squares, for example.
  const literal = { ...cfg, colorSymbols: { ...POST_CONFIG.colorSymbols, W: "⬜", B: "⬛" } };
  assert.equal(lines(composePost(data, literal).embeds, "Most played")[0], "🥇 **Sisay, Weatherlight Captain** ⬜🟦⬛🟥🟩 — 10.0%");
  // Switched off, or a fixture from before colors existed: no squares anywhere.
  const squares = /[🟨🟦🟪🟥🟩🔘]/u;
  assert.doesNotMatch(JSON.stringify(composePost(data, { ...POST_CONFIG, colorSquares: 0 }).embeds), squares);
  delete data.colors;
  assert.doesNotMatch(JSON.stringify(composePost(data).embeds), squares);
  // Every commander the fixtures show has a color entry, and the squares never appear in the headline.
  for (const name of FIXTURES) {
    const d = loadFixture(name);
    assert.deepEqual(Object.keys(d.colors!), commandersShown(d), name);
    for (const v of Object.values(d.colors!)) assert.match(v, /^W?U?B?R?G?$/);
    assert.doesNotMatch(composePost(d).embeds[0]!.description!, squares);
  }
});

test("commandersShown: winners, top players, deck stats and listable trend rows; no placeholder", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.results = [{ ...data.results[0]!, result: "final drawn", resultCommanders: "Only In Results; unknown" }];
  data.topPlayers = [{ name: "X", wins: 1, topCuts: 1, commander: "Only A Top Player's" }, { name: "Y", wins: 0, topCuts: 1, commander: null }];
  data.trend = [
    { commander: "Trend Ten", lastMonthEntries: 10, prior3AvgEntries: 1, shareChange: 1, isNew: false, firstSeen: null },
    { commander: "Trend Nine", lastMonthEntries: 9, prior3AvgEntries: 1, shareChange: 1, isNew: false, firstSeen: null },
  ];
  const shown = commandersShown(data);
  for (const name of ["Only In Results", "Only A Top Player's", "Trend Ten", data.metaShare[0]!.commander, data.ppg[0]!.commander, data.topCutAppearances[0]!.commander]) {
    assert.ok(shown.includes(name), name);
  }
  assert.ok(!shown.includes("unknown") && !shown.includes("Trend Nine"));
  assert.deepEqual(shown, [...shown].sort());
  assert.equal(new Set(shown).size, shown.length);
});

test("every look switch off: plain lines inside the new embeds", () => {
  for (const name of FIXTURES) {
    const { embeds } = composePost(loadFixture(name), PLAIN);
    assert.equal(embeds[0]!.description, loadFixture(name).resolved.stepsUp > 0 ? "Showing Europe: Slovenia didn't have enough data." : undefined);
    const body = fields(embeds).filter((f) => !f.value.includes("TopDeck.gg")).map((f) => f.value).join("\n");
    assert.doesNotMatch(body, /\*\*|🥇|🏆|🎯|🆕|🔥|🧊|▰|▱|🟨|🟦|🟪|🟥|🟩|\n\n/u, name);
    for (const l of lines(embeds, "Most played")) assert.match(l, /^\d+\\\. .+ — \d+\.\d%$/, l);
    for (const l of lines(embeds, "Winners")) assert.match(l, /^• \d+p · /, l);
    assert.ok(contentLength(embeds) < contentLength(composePost(loadFixture(name)).embeds));
  }
});

test("trim order: decoration first, then decks bottom-up, then the player sections, Winners last", () => {
  const data = loadFixture("global-2026-10");
  const full = composePost(data).embeds;
  const value = (e: Embed[], name: string) => field(e, name)?.value ?? "";
  const at = (budget: number) => composePost(data, { ...POST_CONFIG, contentBudget: budget }).embeds;
  const others = (e: Embed[], except: string) => fields(e).filter((f) => !plain(f.name).startsWith(except)).map((f) => f.value).join("\n");

  // 1 and 2: the top-cut lines lose detail (both shares, the ratio, the count alone); nothing else moves.
  const ratio = at(contentLength(full) - 1);
  assert.match(value(ratio, "Top-cut appearances"), /× its field share/);
  assert.equal(others(ratio, "Top-cut"), others(full, "Top-cut"));
  const countOnly = at(contentLength(ratio) - 1);
  assert.doesNotMatch(value(countOnly, "Top-cut appearances"), /field/);
  assert.equal(lines(countOnly, "Top-cut appearances").length, 5, "the count fits on the name's line");
  assert.equal(others(countOnly, "Top-cut"), others(full, "Top-cut"));
  // 3: blank spacing goes; every winner stays.
  const tight = at(contentLength(countOnly) - 1);
  assert.doesNotMatch(value(tight, "Winners"), /\n\n/);
  assert.equal(winnerLines(tight).length, 20);
  assert.match(value(tight, "Most played"), /▰/);
  // 4: share bars go.
  const noBars = at(contentLength(tight) - 1);
  assert.doesNotMatch(value(noBars, "Most played"), /▰|▱/);
  assert.match(value(noBars, "Most played"), /🟦/);
  // 5: color squares go. Up to here no item has been dropped anywhere.
  const noSquares = at(contentLength(noBars) - 1);
  assert.doesNotMatch(JSON.stringify(noSquares), /[🟨🟦🟪🟥🟩]/u);
  const items = (e: Embed[]) => ["Top players", "Rising players", "Top-cut appearances", "Most played", "Best results", "Top-cut conversion", "Rising commanders", "Cooling commanders"]
    .map((n) => lines(e, n).filter((l) => /\*\*/.test(l)).length);
  assert.deepEqual(items(noSquares), items(full));
  assert.deepEqual(items(full), [5, 3, 5, 10, 5, 5, 3, 3]);
  // 6: only now a line goes, from the bottom of the decks block.
  const firstCut = at(contentLength(noSquares) - 1);
  assert.deepEqual(items(firstCut), [5, 3, 5, 10, 5, 5, 3, 2]);

  // From there down: the player sections are untouched until the decks block is at its floor, and Winners
  // until the player sections are gone.
  let sawPlayersTrim = false;
  let sawWinnersTrim = false;
  for (let budget = contentLength(firstCut); budget >= 700; budget -= 40) {
    const e = at(budget);
    const [topPlayers, risingPlayers, topCut, most, best, conv, rising, cooling] = items(e) as [number, number, number, number, number, number, number, number];
    const winners = winnerLines(e).filter((l) => l.startsWith("**")).length;
    if (topPlayers < 5 || risingPlayers < 3) {
      sawPlayersTrim = true;
      assert.deepEqual([topCut, most, best, conv, rising, cooling], [0, 3, 0, 0, 0, 0], `budget ${budget}: players trimmed while decks still had room to give`);
    }
    if (winners < 10) {
      sawWinnersTrim = true;
      assert.deepEqual([topPlayers, risingPlayers], [0, 0], `budget ${budget}: winners trimmed before the player sections`);
      assert.ok(winners >= 3);
    }
    assert.ok(e[0]!.description === full[0]!.description && value(e, "Coverage") === value(full, "Coverage") && value(e, "Events") === value(full, "Events"), "headline, scene and coverage never trim");
    assert.deepEqual(discordLimitViolations(e), []);
  }
  assert.ok(sawPlayersTrim && sawWinnersTrim, "the loop reached the people block and then Winners");
});

test("rising commanders: 'new since' for a commander first seen in the last 2 months", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const top = data.metaShare.map((m) => m.commander);
  const row = (commander: string, lastMonthEntries: number, prior3AvgEntries: number, shareChange: number | null, firstSeen: string | null) =>
    ({ commander, lastMonthEntries, prior3AvgEntries, shareChange, isNew: prior3AvgEntries === 0, firstSeen });
  data.trend = [
    row("Dack Fayden, Helping Hand", 93, 4 / 3, 60, "2026-09-26"), // has prior entries, but first seen last month
    row("Brand New, This Month", 14, 0, null, "2026-10-03"),
    row("First Of Last Month", 12, 1, 5, "2026-09-01"), // the boundary is the first day of the month before
    row("Just Too Old", 20, 2, 4, "2026-08-31"), // one day before the boundary: an ordinary riser
    row("Back After A Break", 11, 0, null, "2024-05-18"), // nothing in the prior 3 months, but an old card
    row("Date Unknown", 13, 0, null, null),
    row(top[0]!, 30, 60, -0.5, "2026-09-10"), // falling, but new: never listed as cooling
    row(top[1]!, 8, 40, -0.8, "2024-01-01"),
  ];
  const all = composePost(data, { ...PLAIN, risingMax: 10 }).embeds;
  assert.deepEqual(lines(all, "Rising commanders"), [
    "Dack Fayden, Helping Hand — 93 entries in October, new since Sep 26",
    `${shortenCommander(top[0]!)} — 30 entries in October, new since Sep 10`,
    "Brand New, This Month — 14 entries in October, new since Oct 3",
    "Date Unknown — 13 entries in October, new",
    "First Of Last Month — 12 entries in October, new since Sep 1",
    "Back After A Break — 11 entries in October, new",
    "Just Too Old — 20 entries in October (avg 2/month)",
  ]);
  assert.deepEqual(lines(all, "Cooling commanders"), [`${shortenCommander(top[1]!)} — 8 entries in October (avg 40/month)`]);
  // 🆕 marks both kinds of new commander; 🔥 the ordinary riser.
  const marked = lines(composePost(data, { ...POST_CONFIG, risingMax: 10 }).embeds, "Rising commanders").filter((l) => l.includes("**")).map((l) => l.split(" ")[0]);
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
    { commander: "One Cut", topCutEntries: 1, fieldEntries: 1, ...t },
    { commander: "No Field Numbers", topCutEntries: 3, fieldEntries: 0, totalTopCutEntries: 0, totalFieldEntries: 0 },
  ];
  const old = (detail: number) => lines(composePost(data, { ...PLAIN, topCutDetail: detail }).embeds, "Top-cut appearances");
  assert.deepEqual(old(2), [
    "1\\. Kraum / Tymna the Weaver — 20 cuts · 10.0% of cuts vs 8.0% of field",
    "2\\. Kinnan, Bonder Prodigy — 10 cuts · 5.0% of cuts vs 10.0% of field",
    "3\\. One Cut — 1 cut · 0.5% of cuts vs 0.1% of field",
    "4\\. No Field Numbers — 3 cuts",
  ]);
  assert.deepEqual(old(1), [
    "1\\. Kraum / Tymna the Weaver — 20 cuts · 1.25× its field share",
    "2\\. Kinnan, Bonder Prodigy — 10 cuts · 0.50× its field share",
    "3\\. One Cut — 1 cut · 5.00× its field share",
    "4\\. No Field Numbers — 3 cuts",
  ]);
  assert.deepEqual(old(0), ["1\\. Kraum / Tymna the Weaver — 20 cuts", "2\\. Kinnan, Bonder Prodigy — 10 cuts", "3\\. One Cut — 1 cut", "4\\. No Field Numbers — 3 cuts"]);

  // Redesigned: the name, then the numbers on their own line; a count alone stays on the name's line.
  data.colors = { "Kinnan, Bonder Prodigy": "UG" };
  assert.deepEqual(lines(composePost(data).embeds, "Top-cut appearances"), [
    "🥇 **Kraum / Tymna the Weaver**", "20 cuts · 10.0% of cuts vs 8.0% of field",
    "🥈 **Kinnan, Bonder Prodigy** 🟦🟩", "10 cuts · 5.0% of cuts vs 10.0% of field",
    "🥉 **One Cut**", "1 cut · 0.5% of cuts vs 0.1% of field",
    "4️⃣ **No Field Numbers** — 3 cuts",
  ]);
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
  assert.equal(field(composePost(data).embeds, "Top players")!.value, "🥇 **Hooligan Riley Atkinson Crucible of…** — 🏆 1 win · 🎯 2 top cuts");
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

test("most played is a snapshot: share only, no movement markers", () => {
  for (const name of FIXTURES) {
    for (const l of lines(composePost(loadFixture(name), PLAIN).embeds, "Most played")) assert.match(l, /^\d+\\\. .+ — \d+\.\d%$/, l);
    for (const l of lines(composePost(loadFixture(name)).embeds, "Most played")) assert.doesNotMatch(l, /[▲▼↑↓+]|new/, l);
  }
});
