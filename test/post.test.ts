// Tests for the v2 monthly post composer. Runs on committed fixtures (no database).
// Snapshots: test/__snapshots__/<name>.txt; set UPDATE_SNAPSHOTS=1 to rewrite them.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  composePost,
  contentLength,
  DISCORD_LIMITS,
  discordLimitViolations,
  monthlyAvg,
  POST_CONFIG,
  sanitizeOrganizerText,
  shareArrow,
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
    const order = ["Events", "Players", "Draw rate", "Largest event", "Winners", "Top-cut appearances", "Most played", "Best results",
      "Top-cut conversion", "Rising", "Cooling off", "Coverage", "Sources"];
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
  data.results = [
    { ...base, result: "winner", resultCommanders: "Kraum, Ludevic's Opus / Tymna the Weaver" },
    { ...base, result: "final drawn", resultCommanders: "Kinnan, Bonder Prodigy; unknown" },
    { ...base, result: "no single winner", resultCommanders: null },
    { ...base, result: "winner not recorded", resultCommanders: null },
    ...Array.from({ length: 8 }, () => ({ ...base })),
  ];
  const lines = field(composePost(data).embed, "Winners")!.value.split("\n");
  assert.ok(lines.length <= POST_CONFIG.winnersMax);
  assert.match(lines[0]!, /· Kraum \/ Tymna the Weaver$/);
  assert.match(lines[1]!, /· drawn final: Kinnan, Bonder Prodigy, unknown commander$/);
  assert.match(lines[2]!, /· no single winner$/);
  assert.match(lines[3]!, /· winner not recorded$/);
  assert.ok(!lines.some((l) => /more$/.test(l)));
});

test("winners field stays within 1,024 characters with 10 long lines", () => {
  const data = loadFixture("global-2026-10");
  data.results = Array.from({ length: 10 }, (_, i) => ({
    eventName: `Very long organizer event name number ${i} ${"Z".repeat(80)}`,
    participantCount: 200 - i,
    result: "winner",
    resultCommanders: `Commanderwithaveryveryverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner Name ${i}, Subtitle`,
  }));
  const { embed } = composePost(data);
  assert.ok(field(embed, "Winners")!.value.length <= DISCORD_LIMITS.fieldValue);
  assertWithinLimits(embed);
});

test("hostile organizer text is neutralized in Winners and Largest event, and the post still fits", () => {
  const data = loadFixture("global-2026-10");
  const nasty = [
    "@everyone **FREE** <@123456789> __big__ ~~sale~~ `code` |spoiler| " + "x".repeat(200),
    "[click me](https://evil.example/phish) join discord.gg/abc123 now",
    "<@&987654321> @here " + "y".repeat(300),
  ];
  data.results = nasty.map((eventName, i) => ({ eventName, participantCount: 500 - i, result: "winner", resultCommanders: "Kinnan, Bonder Prodigy" }));
  data.scene = { ...data.scene, largestEventName: nasty[0]!, largestEventPlayers: 500 };
  const { embed, text } = composePost(data);
  assertWithinLimits(embed);
  const organizerText = [field(embed, "Winners")!.value, field(embed, "Largest event")!.value];
  for (const bad of ["@everyone", "@here", "<@", "**", "__", "~~", "`", "|", "[click", "](", "https://evil", "discord.gg"]) {
    for (const v of organizerText) assert.ok(!v.includes(bad), `organizer text contains ${bad}`);
    assert.ok(!text.split("\n").filter((l) => l.startsWith("•") || l.startsWith("Largest event")).some((l) => l.includes(bad)), `preview contains ${bad}`);
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
  if (field(before, "Cooling off")) assert.equal(field(embed, "Cooling off"), undefined, "Cooling off should be trimmed first");
  assert.ok(field(embed, "Winners"), "Winners must survive trimming");
});

test("shareArrow: up, down, flat within ±0.3 pp, none without a previous window", () => {
  const t = POST_CONFIG.arrowThreshold;
  assert.equal(shareArrow(0.05, 0.04, 1000, t), "↑");
  assert.equal(shareArrow(0.04, 0.05, 1000, t), "↓");
  assert.equal(shareArrow(0.0502, 0.05, 1000, t), "–");
  assert.equal(shareArrow(0.01, null, 1000, t), "↑");
  assert.equal(shareArrow(0.05, 0.04, 0, t), null);
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
  const rising = field(embed, "Rising")!.value.split("\n");
  assert.equal(rising[0], "Jace, Multiverse Architect — 11 entries in October, new");
  assert.match(rising[1]!, /— 12 entries in October \(avg <1\/month\)$/);
  const cooling = field(embed, "Cooling off")!.value.split("\n");
  assert.deepEqual(cooling, [`${shortenCommander(top[3]!)} — 4 entries in October (avg 12/month)`]);
});

test("sections with no qualifying rows are omitted", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.trend = [];
  data.conversion = [];
  const { embed } = composePost(data);
  assert.equal(field(embed, "Rising"), undefined);
  assert.equal(field(embed, "Cooling off"), undefined);
  assert.equal(field(embed, "Top-cut conversion"), undefined);
});

test("fallback note names both regions; non-reportable regions show only scene, winners, coverage and sources", () => {
  const si = composePost(loadFixture("si-2026-10"));
  assert.match(si.embed.description ?? "", /^Showing Europe: Slovenia didn't have enough data\./);
  const data = loadFixture("pacific-northwest-2026-10");
  data.resolved = { ...data.resolved, reportable: false };
  const { embed } = composePost(data);
  assert.match(embed.description ?? "", /Not enough decklists yet for commander stats\./);
  for (const f of embed.fields) assert.match(f.name, /^(Events|Players|Draw rate|Largest event|Winners|Coverage|Sources)/);
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
