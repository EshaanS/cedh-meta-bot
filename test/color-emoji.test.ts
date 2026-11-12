// Color identity pies: the drawing, the emoji names, how a post uses them, and the Discord calls. No database
// and no network: Discord is a fake fetch.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { COLOR_IDENTITIES, colorEmojiMarkup, colorEmojiName, placeholderColorEmoji } from "../scripts/lib/color-emoji";
import { contactSheet, PIE_CONFIG, piePng, renderPie } from "../scripts/lib/color-pie";
import { composePost, contentLength, DISCORD_LIMITS, discordLimitViolations, POST_CONFIG, type Embed, type PostData } from "../scripts/lib/post";
import { loadColorEmoji, resetColorEmojiCache } from "../src/server/color-emoji";
import { discordClient } from "../src/server/discord";

const ALL = ["pacific-northwest-2026-10", "global-2026-10", "si-2026-10", "custom-seattle-metro-2026-10"];
const loadFixture = (name: string): PostData => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8")) as PostData;
const CIRCLES = /[⚪🔵⚫🔴🟢🔘]/u;
const PIE = /<:ci_[a-z]+:\d+>/g;
const values = (embeds: Embed[]) => embeds.flatMap((e) => e.fields.map((f) => f.value));
const pieCount = (embeds: Embed[]) => (JSON.stringify(embeds).match(PIE) ?? []).length;
const ALL_PIES = placeholderColorEmoji();
/** Each pie written as the circles it stands for. */
const asCircles = (embeds: Embed[]): Embed[] => {
  const circles = (identity: string) => (identity === "" ? POST_CONFIG.colorSymbols.colorless : [...identity].map((l) => POST_CONFIG.colorSymbols[l as "W"]).join(POST_CONFIG.colorSymbols.separator));
  const back = (text: string) => Object.entries(ALL_PIES).reduce((t, [identity, markup]) => t.replaceAll(markup, circles(identity)), text);
  return embeds.map((e) => ({ ...e, fields: e.fields.map((f) => ({ ...f, value: back(f.value) })) }));
};

// ---------- the drawing ----------

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
const solid = (color: readonly number[]) => [...color, 255];
/** The pixel `r` pixels from the center, `degrees` clockwise from the top. */
const at = (rgba: Uint8Array, degrees: number, r: number, size = 128) => {
  const a = (degrees * Math.PI) / 180;
  return pixel(rgba, size, Math.round(size / 2 + r * Math.sin(a) - 0.5), Math.round(size / 2 - r * Math.cos(a) - 0.5));
};

test("pie images: a 128x128 RGBA PNG per color identity, small, and all different", () => {
  const seen = new Set<string>();
  for (const colors of COLOR_IDENTITIES) {
    const png = piePng(colors);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(png.subarray(12, 16).toString("latin1"), "IHDR");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [128, 128, 8, 6], "128x128, 8 bits, RGBA");
    // One IDAT chunk follows the header; its data inflates to one filter byte and four bytes per pixel per row.
    const length = png.readUInt32BE(33);
    assert.equal(png.subarray(37, 41).toString("latin1"), "IDAT");
    const rows = inflateSync(png.subarray(41, 41 + length));
    assert.equal(rows.length, 128 * (128 * 4 + 1));
    assert.deepEqual([...rows.subarray(1, 129 * 4 + 1)].filter((_, i) => i < 128 * 4), [...renderPie(colors).subarray(0, 128 * 4)], "first row is the rendered pixels");
    assert.equal(png.subarray(png.length - 8, png.length - 4).toString("latin1"), "IEND");
    assert.ok(png.length < 256 * 1024, "under Discord's 256 KiB");
    seen.add(png.toString("base64"));
  }
  assert.equal(seen.size, 32);
});

test("pie drawing: equal wedges clockwise from the top in WUBRG order, a grey ring and grey lines, transparent outside", () => {
  const { W, U, B, R, G, ring } = PIE_CONFIG.colors;
  const five = renderPie("WUBRG");
  assert.deepEqual([0, 72, 144, 216, 288].map((deg) => at(five, deg, 30)), [W, U, B, R, G].map(solid), "each wedge is centered on its fifth of the circle");
  assert.deepEqual(at(five, 36, 30), solid(ring), "the line between two wedges");
  assert.deepEqual(at(five, 0, 56), solid(ring), "the ring around the pie");
  for (const [x, y] of [[0, 0], [127, 0], [0, 127], [127, 127], [64, 1]] as const) assert.equal(pixel(five, 128, x, y)[3], 0, "outside the pie is transparent");

  const two = renderPie("WU");
  assert.deepEqual([at(two, 270, 30), at(two, 90, 30), at(two, 0, 30), at(two, 180, 30)], [solid(W), solid(U), solid(ring), solid(ring)], "two colors: left and right halves, the first color on the left");
  for (const pair of COLOR_IDENTITIES.filter((x) => x.length === 2)) {
    const [left, right] = [...pair].map((l) => solid(PIE_CONFIG.colors[l as "W"]));
    const pie = renderPie(pair);
    assert.deepEqual([at(pie, 270, 30), at(pie, 315, 30), at(pie, 225, 30), at(pie, 90, 30), at(pie, 45, 30), at(pie, 135, 30)], [left, left, left, right, right, right], pair);
  }
  const one = renderPie("B");
  assert.deepEqual([at(one, 0, 0), at(one, 45, 40), at(one, 200, 20)], [solid(B), solid(B), solid(B)], "one color: a full disc with no lines");
  const four = renderPie("UBRG");
  assert.deepEqual([0, 90, 180, 270].map((deg) => at(four, deg, 30)), [U, B, R, G].map(solid));
  // Colorless is a ring with nothing in it.
  const none = renderPie("");
  assert.equal(at(none, 0, 0)[3], 0);
  assert.equal(at(none, 90, 30)[3], 0);
  assert.deepEqual(at(none, 0, 52), solid(ring));

  // Any size renders (the review sheet uses small ones), edges are smoothed, and a letter that is no color is refused.
  assert.equal(renderPie("WUBRG", 22).length, 22 * 22 * 4);
  assert.ok(new Set(Array.from({ length: 128 }, (_, x) => pixel(one, 128, x, 10)[3])).size > 2, "partly transparent pixels on the edge");
  assert.throws(() => renderPie("WX"), /not a color/);
  assert.throws(() => renderPie("ring"), /not a color/);
  const sheet = contactSheet(["", "W", "WUBRG"]);
  assert.deepEqual([sheet.readUInt32BE(16), sheet.readUInt32BE(20)], [3 * 72 + 8, 2 * (80 + 60 + 38)]);
});

// ---------- names ----------

test("emoji names: 32 identities, colorless first, valid and unique Discord names", () => {
  assert.equal(COLOR_IDENTITIES.length, 32);
  assert.deepEqual(COLOR_IDENTITIES.slice(0, 9), ["", "W", "U", "B", "R", "G", "WU", "WB", "WR"]);
  assert.deepEqual(COLOR_IDENTITIES.slice(-6), ["WUBR", "WUBG", "WURG", "WBRG", "UBRG", "WUBRG"]);
  for (const colors of COLOR_IDENTITIES) assert.match(colors, /^W?U?B?R?G?$/);
  const names = COLOR_IDENTITIES.map(colorEmojiName);
  assert.equal(new Set(names).size, 32);
  for (const name of names) assert.match(name, /^[a-z0-9_]{2,32}$/);
  assert.deepEqual([colorEmojiName(""), colorEmojiName("W"), colorEmojiName("WUBRG")], ["ci_c", "ci_w", "ci_wubrg"]);
});

test("colorEmojiMarkup: only emoji with our names and a numeric id, the first of two with one name", () => {
  const markup = colorEmojiMarkup([
    { id: "1300000000000000001", name: "ci_wu" },
    { id: "1300000000000000002", name: "ci_c" },
    { id: "1300000000000000003", name: "ci_wu" }, // a second one with the same name
    { id: "1300000000000000004", name: "party_parrot" }, // someone else's emoji
    { id: "1300000000000000005", name: "ci_uw" }, // not WUBRG order: not one of ours
    { id: "12> @everyone <:x:1", name: "ci_b" }, // not an id
    { id: "", name: "ci_r" },
    { id: 1300000000000000006 as unknown as string, name: "ci_g" },
  ]);
  assert.deepEqual(markup, { "": "<:ci_c:1300000000000000002>", WU: "<:ci_wu:1300000000000000001>" });
  assert.deepEqual(colorEmojiMarkup([]), {});
  assert.deepEqual(Object.keys(ALL_PIES), [...COLOR_IDENTITIES]);
  assert.equal(ALL_PIES.WUBRG, "<:ci_wubrg:1300000000000000031>");
});

// ---------- in a post ----------

test("a post with pies: one emoji where the circles were, the same lines, and the text preview unchanged", () => {
  for (const name of ALL) {
    const data = loadFixture(name);
    const circles = composePost(data);
    const pies = composePost(data, POST_CONFIG, { colorEmoji: ALL_PIES });
    assert.deepEqual(discordLimitViolations(pies.embeds), [], name);
    assert.equal(pies.text, circles.text, `${name}: the preview shows circles`);
    assert.deepEqual(asCircles(pies.embeds), circles.embeds, `${name}: nothing else changes`);
    for (const v of values(pies.embeds)) assert.doesNotMatch(v, CIRCLES, `${name}: no circles left`);
    assert.ok(contentLength(pies.embeds) <= POST_CONFIG.messageMax, name);
  }
  const global = composePost(loadFixture("global-2026-10"), POST_CONFIG, { colorEmoji: ALL_PIES }).embeds;
  assert.equal(pieCount(global), 35);
  assert.equal(pieCount(composePost(loadFixture("si-2026-10"), POST_CONFIG, { colorEmoji: ALL_PIES }).embeds), 0);
  const mostPlayed = global.flatMap((e) => e.fields).find((f) => f.name.endsWith("Most played"))!.value.split("\n\n");
  assert.equal(mostPlayed[0], "🥇 **Kraum / Tymna the Weaver**\n▰▰▰▰▰▰▰▰▰▰ 8.3% · 595 entries · <:ci_wubr:1300000000000000026>");
  assert.equal(mostPlayed[1], "🥈 **Kinnan, Bonder Prodigy**\n▰▰▰▰▰▰▰▰▰▱ 7.5% · 536 entries · <:ci_ug:1300000000000000012>");
  // The headline never shows colors.
  assert.doesNotMatch(global[0]!.description!, /<:ci_|[⚪🔵⚫🔴🟢🔘]/u);
});

test("pies cost no line: the budget counts a pie as its circles", () => {
  // The global post is over the budget as sent (4,969) and under it as read (4,187): it keeps every pie.
  const data = loadFixture("global-2026-10");
  const sent = composePost(data, POST_CONFIG, { colorEmoji: ALL_PIES }).embeds;
  assert.equal(contentLength(composePost(data).embeds), 4187);
  assert.equal(contentLength(sent), 4969);
  assert.ok(contentLength(sent) > POST_CONFIG.contentBudget && contentLength(asCircles(sent)) <= POST_CONFIG.contentBudget);
  // Under budget pressure the same things are trimmed with pies as without.
  for (const contentBudget of [4000, 3500, 3000, 2000, 1000]) {
    const cfg = { ...POST_CONFIG, contentBudget };
    assert.deepEqual(asCircles(composePost(data, cfg, { colorEmoji: ALL_PIES }).embeds), composePost(data, cfg).embeds, `budget ${contentBudget}`);
  }
});

test("pies go back to circles when the message as sent would be too long or a field would pass 1,024", () => {
  const data = loadFixture("global-2026-10");
  const circles = composePost(data).embeds;
  assert.equal(POST_CONFIG.messageMax, 5900);
  assert.ok(POST_CONFIG.messageMax < DISCORD_LIMITS.total);
  // As sent the post is 4,969: with a lower ceiling the circles are sent, and nothing else is given up.
  assert.deepEqual(composePost(data, { ...POST_CONFIG, messageMax: 4968 }, { colorEmoji: ALL_PIES }).embeds, circles);
  assert.equal(pieCount(composePost(data, { ...POST_CONFIG, messageMax: 4969 }, { colorEmoji: ALL_PIES }).embeds), 35);
  // Markup so long that five Winners lines pass 1,024 characters: circles again, and Winners keeps its five lines.
  const huge = Object.fromEntries(Object.keys(ALL_PIES).map((k) => [k, `<:ci_${"x".repeat(150)}:1>`]));
  assert.deepEqual(composePost(data, { ...POST_CONFIG, messageMax: 100_000 }, { colorEmoji: huge }).embeds, circles);

  // Every name at its longest: over the budget, trimmed to it, and still within Discord's limits with pies.
  const worst = loadFixture("global-2026-10");
  const long = (i: number) => `Commanderwithaverylongname${i}, Extremely Long Subtitle Of Doom / Another Extremely Long Partner ${i}, Subtitle`;
  const player = "Player With A Remarkably Long Display Name Here";
  worst.results = worst.results.map((r, i) => ({ ...r, eventName: "E".repeat(60), winnerName: player, resultCommanders: long(i) }));
  worst.topPlayers = worst.topPlayers.map((p, i) => ({ ...p, name: player, commander: long(i) }));
  worst.topCutAppearances = worst.topCutAppearances.map((x, i) => ({ ...x, commander: long(i) }));
  worst.metaShare = worst.metaShare.map((x, i) => ({ ...x, commander: long(i) }));
  worst.ppg = worst.ppg.map((x, i) => ({ ...x, commander: long(i) }));
  worst.conversion = worst.conversion.map((x, i) => ({ ...x, commander: long(i) }));
  worst.trend = worst.trend.map((x, i) => ({ ...x, commander: long(i) }));
  worst.colors = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [long(i), "WUBRG"]));
  const trimmed = composePost(worst, POST_CONFIG, { colorEmoji: ALL_PIES }).embeds;
  assert.deepEqual(discordLimitViolations(trimmed), []);
  assert.ok(contentLength(trimmed) <= POST_CONFIG.messageMax);
  assert.ok(contentLength(asCircles(trimmed)) <= POST_CONFIG.contentBudget);
  assert.deepEqual(asCircles(trimmed), composePost(worst).embeds, "the same trimming as without pies");
});

test("pies: an identity without one keeps its circles; the switches turn them off", () => {
  const data = loadFixture("pacific-northwest-2026-10");
  const some = { WUBR: ALL_PIES.WUBR!, "": ALL_PIES[""]! };
  const { embeds, text } = composePost(data, POST_CONFIG, { colorEmoji: some });
  const winners = embeds.flatMap((e) => e.fields).find((f) => f.name.endsWith("Winners (largest events)"))!.value.split("\n\n");
  assert.equal(winners[0], "**Guardian Games CEDH Monthly PDX** · 66 players\n🏆 Rafael Montoya on Kraum / Tymna the Weaver · <:ci_wubr:1300000000000000026>");
  assert.equal(winners[1], "**Gem State CEDH Ad Naus for a Cause!** · 44 players\n🏆 Noor Haddad on Tasigur, the Golden Fang · 🔵 ⚫ 🟢");
  assert.equal(text, composePost(data).text);
  // colorPies off: the map is ignored. colorSquares off: no colors of either kind.
  assert.deepEqual(composePost(data, { ...POST_CONFIG, colorPies: 0 }, { colorEmoji: ALL_PIES }).embeds, composePost(data).embeds);
  const off = composePost(data, { ...POST_CONFIG, colorSquares: 0 }, { colorEmoji: ALL_PIES }).embeds;
  assert.equal(pieCount(off), 0);
  assert.doesNotMatch(JSON.stringify(off), CIRCLES);
  // No map, or an empty one: exactly the post without pies.
  assert.deepEqual(composePost(data, POST_CONFIG, {}).embeds, composePost(data).embeds);
  assert.deepEqual(composePost(data, POST_CONFIG, { colorEmoji: {} }).embeds, composePost(data).embeds);
});

// ---------- reading the application's emoji ----------

beforeEach(() => resetColorEmojiCache());

test("loadColorEmoji: the application's pies, cached ten minutes per application, and none without an application id", async () => {
  let calls = 0;
  const discord = {
    listAppEmojis: async (appId: string) => {
      calls++;
      return [{ id: appId === "1" ? "1300000000000000001" : "1300000000000000002", name: "ci_wu" }, { id: "1300000000000000009", name: "other" }];
    },
  };
  const t0 = 1_000_000;
  assert.deepEqual(await loadColorEmoji(discord, "1", t0), { WU: "<:ci_wu:1300000000000000001>" });
  assert.deepEqual(await loadColorEmoji(discord, "1", t0 + 9 * 60_000), { WU: "<:ci_wu:1300000000000000001>" });
  assert.equal(calls, 1, "served from the cache");
  await loadColorEmoji(discord, "1", t0 + 10 * 60_000);
  assert.equal(calls, 2, "read again after ten minutes");
  assert.deepEqual(await loadColorEmoji(discord, "2", t0), { WU: "<:ci_wu:1300000000000000002>" }, "another application is never served the first one's list");
  // No application id: no call and no pies.
  assert.deepEqual(await loadColorEmoji(discord, undefined, t0), {});
  assert.deepEqual(await loadColorEmoji(discord, "", t0), {});
  assert.equal(calls, 3);
});

test("loadColorEmoji: a Discord failure means circles, is not cached, and is logged without throwing", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: string) => { warnings.push(line); });
  let fail = true;
  const discord = { listAppEmojis: async () => { if (fail) throw new Error("GET /applications/1/emojis -> HTTP 500"); return [{ id: "1300000000000000001", name: "ci_g" }]; } };
  assert.deepEqual(await loadColorEmoji(discord, "1", 0), {});
  assert.deepEqual(warnings, ["color emoji: GET /applications/1/emojis -> HTTP 500; using circles"]);
  fail = false;
  assert.deepEqual(await loadColorEmoji(discord, "1", 1), { G: "<:ci_g:1300000000000000001>" }, "the next call asks again");
});

test("discord client: list, create and delete application emoji", async () => {
  const seen: { method: string; url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    seen.push({ method, url: String(url), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return Response.json({ items: [{ id: "11", name: "ci_w", user: { id: "9" }, animated: false }, { id: "12", name: "other" }] });
    if (method === "POST") return Response.json({ id: "13", name: "ci_wu", animated: false }, { status: 201 });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const discord = discordClient({ token: "secret-token", base: "https://discord.test/api", fetchImpl });

  assert.deepEqual(await discord.listAppEmojis("42"), [{ id: "11", name: "ci_w" }, { id: "12", name: "other" }]);
  const png = piePng("WU");
  assert.deepEqual(await discord.createAppEmoji("42", "ci_wu", png), { id: "13", name: "ci_wu" });
  await discord.deleteAppEmoji("42", "13");

  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), [
    "GET https://discord.test/api/applications/42/emojis",
    "POST https://discord.test/api/applications/42/emojis",
    "DELETE https://discord.test/api/applications/42/emojis/13",
  ]);
  for (const s of seen) assert.equal(s.auth, "Bot secret-token");
  const body = seen[1]!.body as { name: string; image: string };
  assert.deepEqual(Object.keys(body), ["name", "image"]);
  assert.equal(body.name, "ci_wu");
  assert.ok(body.image.startsWith("data:image/png;base64,"));
  assert.deepEqual(Buffer.from(body.image.slice("data:image/png;base64,".length), "base64"), png);
  // An application with no emoji, or an unexpected body, is an empty list.
  const empty = discordClient({ token: "t", base: "https://discord.test/api", fetchImpl: (async () => Response.json({})) as typeof fetch });
  assert.deepEqual(await empty.listAppEmojis("42"), []);
});
