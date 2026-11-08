// Tests for the monthly post composer. Runs on committed fixtures (no database).
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
  shortenCommander,
  type PostData,
} from "../scripts/lib/post";

const FIXTURES = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10"];
const fixturePath = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url));
const snapshotPath = (name: string) => fileURLToPath(new URL(`./__snapshots__/${name}.txt`, import.meta.url));
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(fixturePath(name), "utf8")) as PostData;

function matchSnapshot(name: string, actual: string) {
  const path = snapshotPath(name);
  if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(path)) {
    mkdirSync(fileURLToPath(new URL("./__snapshots__/", import.meta.url)), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `snapshot ${name} changed; rerun with UPDATE_SNAPSHOTS=1 if intended`);
}

for (const name of FIXTURES) {
  test(`snapshot: ${name}`, () => {
    matchSnapshot(name, composePost(loadFixture(name)).text);
  });

  test(`limits: ${name}`, () => {
    const { embed } = composePost(loadFixture(name));
    assert.deepEqual(discordLimitViolations(embed), []);
    assert.ok(embed.title.length <= DISCORD_LIMITS.title);
    assert.ok(embed.description.length <= DISCORD_LIMITS.description);
    for (const f of embed.fields) assert.ok(f.value.length <= DISCORD_LIMITS.fieldValue, `field ${f.name}`);
    assert.ok(contentLength(embed) <= DISCORD_LIMITS.total);
    assert.ok(contentLength(embed) <= POST_CONFIG.contentBudget, `content ${contentLength(embed)} > budget`);
  });

  test(`attribution: ${name}`, () => {
    const { embed, text } = composePost(loadFixture(name));
    const sources = embed.fields.at(-1)!;
    assert.equal(sources.name, "Sources");
    assert.match(sources.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);
    assert.match(embed.footer.text, /^Data provided by TopDeck\.gg/);
    assert.match(text, /Data provided by TopDeck\.gg \(https:\/\/topdeck\.gg\)/);
  });
}

test("hostile organizer text is neutralized and the post still fits", () => {
  const data = loadFixture("global-2026-10");
  const nasty = [
    "@everyone **FREE** <@123456789> __big__ ~~sale~~ `code` |spoiler| " + "x".repeat(200),
    "[click me](https://evil.example/phish) join discord.gg/abc123 now",
    "<@&987654321> @here " + "y".repeat(300),
  ];
  data.results = nasty.map((eventName, i) => ({
    eventName,
    participantCount: 500 - i,
    location: "@here <#1>",
    result: "winner",
    resultCommanders: "Aaaaaaaaaaaaaaaaaaaaaaa, The Very Long Title Of Doom / Bbbbbbbbbbbbbbbbbbb, Another Long Title",
  }));
  const { embed, text } = composePost(data);
  assert.deepEqual(discordLimitViolations(embed), []);
  assert.ok(contentLength(embed) <= POST_CONFIG.contentBudget);
  const winners = embed.fields.find((f) => f.name.startsWith("Winners"))!.value;
  for (const bad of ["@everyone", "@here", "<@", "**", "__", "~~", "`", "|", "[click", "](", "https://evil", "discord.gg"]) {
    assert.ok(!winners.includes(bad), `winners field contains ${bad}`);
    assert.ok(!text.split("\n").filter((l) => l.startsWith("•")).some((l) => l.includes(bad)), `preview contains ${bad}`);
  }
  for (const line of winners.split("\n").filter((l) => l.startsWith("•"))) {
    const eventName = line.split(" · ")[1]!;
    assert.ok(eventName.length <= POST_CONFIG.eventNameMax, `event name too long: ${eventName.length}`);
  }
});

test("budget trimming keeps oversized posts within 1,000 characters", () => {
  const data = loadFixture("global-2026-10");
  const long = (s: string) => `${s}, ${"Q".repeat(60)} / Partner ${s}, ${"R".repeat(60)}`;
  data.metaShare = data.metaShare.map((m) => ({ ...m, commander: long(m.commander) }));
  data.ppg = data.ppg.map((p) => ({ ...p, commander: `${p.commander} ${"Z".repeat(80)}` }));
  const { embed } = composePost(data);
  assert.ok(contentLength(embed) <= POST_CONFIG.contentBudget, `content ${contentLength(embed)}`);
  assert.deepEqual(discordLimitViolations(embed), []);
});

test("shortenCommander: pairs cut at the first comma, singles unchanged", () => {
  assert.equal(shortenCommander("Kraum, Ludevic's Opus / Tymna the Weaver"), "Kraum / Tymna the Weaver");
  assert.equal(shortenCommander("Rograkh, Son of Rohgahh / Thrasios, Triton Hero"), "Rograkh / Thrasios");
  assert.equal(shortenCommander("Kinnan, Bonder Prodigy"), "Kinnan, Bonder Prodigy");
  assert.equal(shortenCommander("Thalia and The Gitrog Monster"), "Thalia and The Gitrog Monster");
});

test("sanitizeOrganizerText strips mentions, markdown, links and truncates", () => {
  assert.equal(sanitizeOrganizerText("  **Big** <@1> @everyone  event  ", 50), "Big 1 everyone event");
  assert.equal(sanitizeOrganizerText("see https://x.example/y and discord.gg/zz", 50), "see and");
  const t = sanitizeOrganizerText("a".repeat(80), 50);
  assert.equal(t.length, 50);
  assert.ok(t.endsWith("…"));
});

test("fallback header names both regions", () => {
  const { text, embed } = composePost(loadFixture("si-2026-10"));
  assert.match(embed.description, /^Showing Europe: Slovenia didn't have enough data\./);
  assert.match(text, /Showing Europe: Slovenia didn't have enough data\./);
});

test("rising section is omitted when nothing qualifies", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.growth = data.growth.map((g) => ({ ...g, lastMonthEntries: 1 }));
  const { embed } = composePost(data);
  assert.ok(!embed.fields.some((f) => f.name.startsWith("Rising")));
});

test("non-reportable region shows the coverage note and no commander sections", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.resolved = { ...data.resolved, reportable: false };
  const { embed } = composePost(data);
  assert.match(embed.description, /Not enough decklists yet for commander stats\./);
  assert.deepEqual(embed.fields.map((f) => f.name.split(" ")[0]), ["Winners", "Sources"]);
});

test("monthlyAvg rounds to whole numbers and shows <1 below 1", () => {
  assert.equal(monthlyAvg(0), "<1");
  assert.equal(monthlyAvg(0.67), "<1");
  assert.equal(monthlyAvg(1), "1");
  assert.equal(monthlyAvg(2.5), "3");
  assert.equal(monthlyAvg(7.33), "7");
});

test("rising lines show entry counts: growing and new decks", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  data.growth = [
    { commander: "Kinnan, Bonder Prodigy", lastMonthEntries: 12, prior3AvgEntries: 0.33, shareGrowth: 0.5, isNew: false },
    { commander: "Jace, Multiverse Architect", lastMonthEntries: 11, prior3AvgEntries: 0, shareGrowth: null, isNew: true },
  ];
  const rising = composePost(data).embed.fields.find((f) => f.name.startsWith("Rising"))!.value.split("\n");
  assert.deepEqual(rising, [
    "Jace, Multiverse Architect — 11 entries in October, new",
    "Kinnan, Bonder Prodigy — 12 entries in October (avg <1/month)",
  ]);
});
