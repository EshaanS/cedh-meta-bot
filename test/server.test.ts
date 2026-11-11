// Discord app tests that need no database: signatures, routing and the guild gate, command definitions.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { COMMANDS } from "../src/server/commands";
import { guildAllowlist, isGuildAllowed, previousMonth } from "../src/server/config";
import type { DiscordClient } from "../src/server/discord";
import { handleInteraction, matchRegions, type InteractionDeps } from "../src/server/interactions";
import { verifyDiscordRequest } from "../src/server/verify";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_HEX = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
const signed = (body: string, ts: string) => sign(null, Buffer.from(ts + body), privateKey).toString("hex");

test("verify: accepts a valid signature", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"type":1}';
  assert.equal(verifyDiscordRequest(body, signed(body, ts), ts, PUBLIC_HEX), true);
});

test("verify: rejects tampered body, bad hex, missing headers and stale timestamps", () => {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signed('{"type":1}', ts);
  assert.equal(verifyDiscordRequest('{"type":2}', sig, ts, PUBLIC_HEX), false);
  assert.equal(verifyDiscordRequest('{"type":1}', "zz".repeat(64), ts, PUBLIC_HEX), false);
  assert.equal(verifyDiscordRequest('{"type":1}', null, ts, PUBLIC_HEX), false);
  const old = String(Math.floor(Date.now() / 1000) - 3600);
  assert.equal(verifyDiscordRequest('{"type":1}', signed('{"type":1}', old), old, PUBLIC_HEX), false);
});

test("guild gate fails closed", () => {
  assert.deepEqual([...(guildAllowlist({}) as Set<string>)], []);
  assert.equal(isGuildAllowed(guildAllowlist({}), "123"), false);
  assert.equal(isGuildAllowed(guildAllowlist({ ALLOWED_GUILD_IDS: " 123 , 456" }), "456"), true);
  assert.equal(isGuildAllowed(guildAllowlist({ ALLOWED_GUILD_IDS: "123" }), "999"), false);
  assert.equal(guildAllowlist({ ALLOW_ALL_GUILDS: "true", ALLOWED_GUILD_IDS: "1" }), "all");
  assert.equal(guildAllowlist({ ALLOW_ALL_GUILDS: "yes" }) === "all", false);
});

test("previousMonth handles year boundaries", () => {
  assert.equal(previousMonth(new Date(Date.UTC(2026, 10, 8))), "2026-10");
  assert.equal(previousMonth(new Date(Date.UTC(2027, 0, 20))), "2026-12");
});

const noDiscord: DiscordClient = {
  createMessage: async () => assert.fail("should not post"),
  editOriginal: async () => assert.fail("should not edit"),
  listGuildIds: async () => [],
  putCommands: async () => null,
};
const deps = (allowlist: Set<string> | "all"): InteractionDeps => ({
  sql: () => assert.fail("should not query"),
  discord: noDiscord,
  appId: "1",
  allowlist,
  now: () => new Date(Date.UTC(2026, 10, 8)),
});

test("interactions: PING gets PONG", async () => {
  assert.deepEqual((await handleInteraction({ type: 1, token: "t" }, deps(new Set()))).response, { type: 1 });
});

test("interactions: commands outside the allowlist get an ephemeral 'not open yet'", async () => {
  const r = await handleInteraction({ type: 2, token: "t", guild_id: "999", data: { name: "preview" } }, deps(new Set(["123"])));
  const res = r.response as { type: number; data: { content: string; flags: number } };
  assert.equal(res.type, 4);
  assert.equal(res.data.flags, 64);
  assert.match(res.data.content, /isn't open yet/);
  assert.doesNotMatch(res.data.content, /Data provided by/, "config replies carry no attribution");
  assert.equal(r.background, undefined);
});

test("interactions: commands without a guild are refused", async () => {
  const r = await handleInteraction({ type: 2, token: "t", data: { name: "preview" } }, deps("all"));
  assert.match((r.response as { data: { content: string } }).data.content, /servers only/);
});

test("interactions: autocomplete outside the allowlist returns no choices", async () => {
  const r = await handleInteraction({ type: 4, token: "t", guild_id: "999", data: { name: "region" } }, deps(new Set()));
  assert.deepEqual(r.response, { type: 8, data: { choices: [] } });
});

test("interactions: allowed commands are deferred ephemerally with background work", async () => {
  const r = await handleInteraction({ type: 2, token: "t", guild_id: "123", data: { name: "preview" } }, deps(new Set(["123"])));
  assert.deepEqual(r.response, { type: 5, data: { flags: 64 } });
  assert.equal(typeof r.background, "function");
});

test("commands stay within Discord's definition limits and are admin-only", () => {
  const names = new Set<string>();
  const check = (o: { name: string; description: string; options?: readonly unknown[] }) => {
    assert.match(o.name, /^[-_\p{Ll}\p{N}]{1,32}$/u);
    assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
    assert.ok((o.options?.length ?? 0) <= 25);
    for (const sub of (o.options ?? []) as { name: string; description: string; options?: readonly unknown[] }[]) check(sub);
  };
  for (const c of COMMANDS) {
    check(c);
    assert.equal(c.default_member_permissions, "32");
    assert.deepEqual(c.contexts, [0]);
    assert.ok(!names.has(c.name));
    names.add(c.name);
  }
});

test("matchRegions: prefix matches first, accent-insensitive, at most 25", () => {
  const rows = [
    { id: "es-cataluna", label: "Cataluña, Spain", search: "cataluna es-cataluna", rank: 4 },
    { id: "global", label: "Global", search: "global global", rank: 0 },
    { id: "us-wa", label: "Washington, United States", search: "washington us-wa", rank: 5 },
    ...Array.from({ length: 40 }, (_, k) => ({ id: `x${k}`, label: `Region ${k}`, search: `region ${k}`, rank: 2 })),
  ];
  assert.deepEqual(matchRegions(rows, "Cataluña").map((c) => c.value), ["es-cataluna"]);
  assert.deepEqual(matchRegions(rows, "wash")[0], { name: "Washington, United States", value: "us-wa" });
  assert.equal(matchRegions(rows, "").length, 25);
  assert.equal(matchRegions(rows, "")[0]!.value, "global");
});
