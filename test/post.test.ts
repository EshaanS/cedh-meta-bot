// Tests for the v2 monthly post composer. Runs on committed fixtures (no database).
// Snapshots: test/__snapshots__/<name>.txt; set UPDATE_SNAPSHOTS=1 to rewrite them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changeVs,
  composePost,
  contentLength,
  DISCORD_LIMITS,
  discordLimitViolations,
  monthlyAvg,
  POST_CONFIG,
  sanitizeOrganizerText,
  shortenCommander,
  type PostData,
} from "../scripts/lib/post";

const FIXTURES = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10"];
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const snapshotPath = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}.txt`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(fixturePath(name), "utf8")) as PostData;
const field = (embed: ReturnType<typeof composePost>["embed"], prefix: string) => embed.fields.find((f) => f.name.startsWith(prefix));

function matchSnapshot(name: string, actual: string) {
  const path = snapshotPath(name);
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(fileURLToPath(new URL("./__snapshots__/", import.meta.url)), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `snapshot ${name} changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
}

function assertWithinLimits(embed: ReturnType<typeof composePost>["embed"]) {
  assert.deepEqual(discordLimitViolations(embed), []);
  assert.ok(embed.title.length <= DISCORD_LIMITS.title);
  assert.ok(embed.fields.length <= DISCORD_LIMITS.fields);
  for (const f of embed.fields) assert.ok(f.value.length <= DISCORD_LIMITS.fieldValue, `field ${f.name}`);
  assert.ok(contentLength(embed) <= DISCORD_LIMITS.total);
  assert.ok(contentLength(embed) <= POST_CONFIG.contentBudget, `content ${contentLength(embed)} > ${POST_CONFIG.contentBudget}`);
}

for (const name of FIXTURES) {
  test(`snapshot: ${name}`, () => matchSnapshot(name, composePost(loadFixture(name)).text));
  test(`limits (budget ${POST_CONFIG.contentBudget} and Discord): ${name}`, () => assertWithinLimits(composePost(loadFixture(name)).embed));

  test(`single attribution in a linked Sources field, no footer: ${name}`, () => {
    const { embed, text } = composePost(loadFixture(name));
    const sources = embed.fields.at(-1)!;
    assert.equal(sources.name, "Sources");
    assert.match(sources.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);
    assert.equal("footer" in embed, false);
    assert.equal(embed.fields.filter((f) => f.value.includes("Data provided by")).length, 1);
    assert.match(text, /Data provided by TopDeck\.gg \(https:\/\/topdeck\.gg\)/);
  });

  test(`section order and no region types shown: ${name}`, () => {
    const { embed } = composePost(loadFixture(name));
    const order = ["Events", "Players", "Draw rate", "Largest event", "Winners", "Top players", "Rising players", "Top-cut appearances",
      "Most played", "Best results", "Top-cut conversion", "Rising commanders", "Cooling commanders", "Coverage", "Sources"];
    const seen = embed.fields.map((f) => order.findIndex((o) => f.name.startsWith(o)));
    assert.ok(seen.every((i) => i >= 0), "unknown section");
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "sections out of order");
    const all = `${embed.title} ${embed.description ?? ""}`;
    assert.doesNotMatch(all, /admin1|admin1_group|macro|custom region|\(continent\)|\(country\)/);
    assert.equal(embed.fields.filter((f) => f.inline).length >= 3, true);
  });
}

test("winners: up to 10 lines, labels for every result type, no '+N more'", () => {
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
  const lines = field(composePost(data).embed, "Winners")!.value.split("\n");
  assert.ok(lines.length <= POST_CONFIG.winnersMax);
  assert.match(lines[0]!, /· Kraum \/ Tymna the Weaver$/);
  assert.match(lines[1]!, /· drawn final: Kinnan, Bonder Prodigy, unknown commander$/);
  assert.match(lines[2]!, /· no single winner$/);
  assert.match(lines[3]!, /· winner not recorded$/);
  assert.match(lines[4]!, /· Mara Ellison on Kinnan, Bonder Prodigy$/);
  assert.match(lines[5]!, /· a player on Kinnan, Bonder Prodigy$/);
  assert.match(lines[6]!, /· Mara Ellison on unknown commander$/);
  assert.ok(!lines.some((l) => /more$/.test(l)));
});

test("winners field stays within 1,024 characters with 10 long lines", () => {
  const data = loadFixture("global-2026-10");
  data.results = Array.from({ length: 10 }, (_, i) => ({
    eventName: `Very long organizer event name number ${i} ${"Z".repeat(80)}`,
    participantCount: 200 - i,
    result: "winner",
    resultCommanders: `Commanderwithaveryveryverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner Name ${i}, Subtitle`,
    winnerName: `Player With A Remarkably Long Display Name ${i}`,
    winnerHidden: false,
  }));
  const { embed } = composePost(data);
  assert.ok(field(embed, "Winners")!.value.length <= DISCORD_LIMITS.fieldValue);
  assertWithinLimits(embed);
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
  const { embed, text } = composePost(data);
  assertWithinLimits(embed);
  const winners = field(embed, "Winners")!.value.split("\n");
  assert.match(winners[1]!, /· a player on Kinnan, Bonder Prodigy$/);
  assert.match(winners[0]!, /· everyone Mallory 42 free\( x y n+… on Kinnan, Bonder Prodigy$/);
  const topLines = field(embed, "Top players")!.value.split("\n");
  assert.equal(topLines.length, 1, "a name that sanitizes to nothing is dropped");
  assert.ok(topLines[0]!.split(" — ")[0]!.length <= 3 + POST_CONFIG.playerNameMax);
  const organizerText = [field(embed, "Winners")!.value, field(embed, "Largest event")!.value, field(embed, "Top players")!.value, field(embed, "Rising players")!.value];
  for (const bad of ["@everyone", "@here", "<@", "**", "__", "~~", "`", "|", "[click", "](", "https://evil", "discord.gg"]) {
    for (const v of organizerText) assert.ok(!v.includes(bad), `organizer text contains ${bad}`);
    assert.ok(!text.split("\n").filter((l) => l.startsWith("•") || l.startsWith("Largest event") || l.includes("Mallory")).some((l) => l.includes(bad)), `preview contains ${bad}`);
  }
  for (const line of field(embed, "Winners")!.value.split("\n")) {
    assert.ok(line.split(" · ")[1]!.length <= POST_CONFIG.eventNameMax);
  }
});

test("budget trimming drops bottom sections first and keeps the post within budget", () => {
  const data = loadFixture("global-2026-10");
  const long = (s: string) => `${s}, ${"Q".repeat(60)} / Partner ${s}, ${"R".repeat(60)}`;
  data.metaShare = data.metaShare.map((m) => ({ ...m, commander: long(m.commander) }));
  data.ppg = data.ppg.map((p) => ({ ...p, commander: `${p.commander} ${"Z".repeat(80)}` }));
  const before = composePost(loadFixture("global-2026-10")).embed;
  const { embed } = composePost(data);
  assertWithinLimits(embed);
  if (field(before, "Cooling commanders")) assert.equal(field(embed, "Cooling commanders"), undefined, "Cooling commanders should be trimmed first");
  assert.ok(field(embed, "Winners"), "Winners must survive trimming");
  assert.ok(field(embed, "Top players"), "Top players trims after the commander sections");
  assert.ok(field(embed, "Top players")!.value.split("\n").length >= 3);
});

test("rising and cooling: count display, eligibility and matching counts", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const top = data.metaShare.map((m) => m.commander);
  data.trend = [
    { commander: "Jace, Multiverse Architect", lastMonthEntries: 11, prior3AvgEntries: 0, shareChange: null, isNew: true },
    { commander: top[1]!, lastMonthEntries: 12, prior3AvgEntries: 0.4, shareChange: 0.5, isNew: false },
    { commander: top[2]!, lastMonthEntries: 25, prior3AvgEntries: 22, shareChange: -0.06, isNew: false }, // entries up: not cooling
    { commander: top[3]!, lastMonthEntries: 4, prior3AvgEntries: 12, shareChange: -0.6, isNew: false }, // qualifies via prior avg
    { commander: "Not In Top 15", lastMonthEntries: 3, prior3AvgEntries: 30, shareChange: -0.9, isNew: false },
  ];
  const { embed } = composePost(data);
  const rising = field(embed, "Rising commanders")!.value.split("\n");
  assert.equal(rising[0], "Jace, Multiverse Architect — 11 entries in October, new");
  assert.match(rising[1]!, /— 12 entries in October \(avg <1\/month\)$/);
  const cooling = field(embed, "Cooling commanders")!.value.split("\n");
  assert.deepEqual(cooling, [`${shortenCommander(top[3]!)} — 4 entries in October (avg 12/month)`]);
});

test("sections with no qualifying rows are omitted", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.trend = [];
  data.conversion = [];
  data.topPlayers = [];
  data.risingPlayers = [];
  const { embed } = composePost(data);
  assert.equal(field(embed, "Rising commanders"), undefined);
  assert.equal(field(embed, "Cooling commanders"), undefined);
  assert.equal(field(embed, "Top players"), undefined);
  assert.equal(field(embed, "Rising players"), undefined);
  assert.equal(field(embed, "Top-cut conversion"), undefined);
});

test("fallback note names both regions; non-reportable regions show only scene, winners, player sections, coverage and sources", () => {
  const si = composePost(loadFixture("si-2026-10"));
  assert.match(si.embed.description ?? "", /^Showing Europe: Slovenia didn't have enough data\./);
  const data = loadFixture("pacific-northwest-2026-10");
  data.resolved = { ...data.resolved, reportable: false };
  const { embed } = composePost(data);
  assert.match(embed.description ?? "", /Not enough decklists yet for commander stats\./);
  for (const f of embed.fields) assert.match(f.name, /^(Events|Players|Draw rate|Largest event|Winners|Top players|Rising players|Coverage|Sources)/);
});

test("top players and rising players: line formats and caps", () => {
  const data = loadFixture("pacific-northwest-2026-10");
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
  const { embed } = composePost(data);
  assert.deepEqual(field(embed, "Top players")!.value.split("\n"), [
    "1. Mara Ellison — 2 wins, 3 top cuts · Kraum / Tymna the Weaver",
    "2. Tobias Quill — 1 win, 1 top cut · Kinnan, Bonder Prodigy",
    "3. Ines Varga — 1 win",
    "4. Aiko Tanabe — 2 top cuts",
    "5. Extra 0 — 1 top cut",
  ]);
  assert.deepEqual(field(embed, "Rising players")!.value.split("\n"), [
    "Noor Haddad — first win · 64p Big Event",
    "Felix Brandt — first top cut · 40p Unnamed event",
    "Third — early top cut · 20p C",
  ]);
});

test("scene change wording and entry counts", () => {
  assert.equal(changeVs(354, 325, "September"), "+9% vs September");
  assert.equal(changeVs(90, 100, "September"), "-10% vs September");
  assert.equal(changeVs(1002, 1000, "September"), "same as September");
  assert.equal(changeVs(19, 19, "September"), "same as September");
  assert.equal(changeVs(5, 0, "September"), null);
  const pnw = composePost(loadFixture("pacific-northwest-2026-10"));
  assert.equal(field(pnw.embed, "Events")!.value, "19 (same as September)");
  assert.equal(field(pnw.embed, "Players")!.value, "534 (+5% vs September)");
  for (const name of ["Best results", "Top-cut conversion"]) {
    for (const line of field(pnw.embed, name)!.value.split("\n")) {
      assert.match(line, / \(\d[\d,]* entries\)$/);
      assert.doesNotMatch(line, /n = /);
    }
  }
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
    const lines = field(composePost(loadFixture(name)).embed, "Most played")!.value.split("\n");
    for (const l of lines) assert.match(l, /^\d+\. .+ — \d+\.\d%$/, l);
  }
});
