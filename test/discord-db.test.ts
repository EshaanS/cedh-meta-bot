// Discord app tests against a real Postgres (local test data), with a fake Discord client.
// Skipped unless TEST_DATABASE_URL is set. Uses guild ids starting with "test-" and removes them afterwards.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Sql } from "../scripts/lib/db";

const url = process.env.TEST_DATABASE_URL;

describe("discord app against Postgres", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let sql: Sql;
  let realGuilds: string[] = [];
  const POSTED_MONTH = "2026-09"; // logged in ingest_log in the local test data
  const now = new Date(Date.UTC(2026, 10, 20)); // after the 15th

  type Sent = { channelId: string; payload: { content?: string; embeds?: unknown[] } };
  async function fakeDiscord(opts: { failChannels?: Record<string, { status: number; code: number }>; guilds?: string[] } = {}) {
    const { DiscordError } = await import("../src/server/discord");
    const sent: Sent[] = [];
    const edits: { content?: string; embeds?: unknown[] }[] = [];
    return {
      sent,
      edits,
      client: {
        createMessage: async (channelId: string, payload: Sent["payload"]) => {
          const f = opts.failChannels?.[channelId];
          if (f) throw new DiscordError(f.status, f.code, `fake ${f.code}`);
          sent.push({ channelId, payload });
        },
        editOriginal: async (_app: string, _token: string, payload: { content?: string; embeds?: unknown[] }) => {
          edits.push(payload);
        },
        listGuildIds: async () => {
          // The bot is still in every server this file doesn't own: real ones, and other test files' servers
          // (test/custom-regions-db.test.ts runs at the same time and its servers own custom regions, which
          // the prune step would otherwise delete).
          const others = await sql<{ id: string }[]>`
            select guild_id as id from guild_configs where guild_id not like 'test-%'
            union
            select owner_guild_id from regions where owner_guild_id is not null and owner_guild_id not like 'test-%'`;
          // test/bulk-radius-db.test.ts creates its servers' regions throughout its run, so they are named here.
          return [...new Set([...realGuilds, ...(opts.guilds ?? []), ...others.map((o) => o.id), "brtest-a", "brtest-b", "brtest-limit"])];
        },
        putCommands: async () => null,
        listAppEmojis: async () => [],
        createAppEmoji: async () => assert.fail("should not upload"),
        deleteAppEmoji: async () => assert.fail("should not delete"),
      },
    };
  }

  const resetTestRows = () => sql`delete from guild_configs where guild_id like 'test-%'`;
  const insert = (guild: string, channel: string | null, region = "pacific-northwest", last: string | null = null) =>
    sql`insert into guild_configs (guild_id, region_id, channel_id, last_posted_month)
        values (${guild}, ${region}, ${channel}, ${last}::date)`;
  const row = async (guild: string) =>
    (await sql<{ channel_id: string | null; last: string | null; region_id: string }[]>`
      select channel_id, last_posted_month::text as last, region_id from guild_configs where guild_id = ${guild}`)[0];

  before(async () => {
    process.env.DATABASE_URL = url;
    const { connect } = await import("../scripts/lib/db");
    sql = connect();
    realGuilds = (await sql<{ guild_id: string }[]>`select guild_id from guild_configs where guild_id not like 'test-%'`).map((r) => r.guild_id);
    await resetTestRows();
  });
  after(async () => {
    await resetTestRows();
    await sql.end();
  });

  test("cron posts once per guild and month, respects the allowlist, and prunes departed guilds", async () => {
    const { runCron } = await import("../src/server/cron");
    await resetTestRows();
    await insert("test-g1", "chan-1");
    await insert("test-g2", "chan-2", "si");
    await insert("test-outside", "chan-3"); // not allowlisted
    await insert("test-gone", "chan-4"); // bot no longer in this guild
    await insert("test-nochannel", null);
    const d = await fakeDiscord({ guilds: ["test-g1", "test-g2", "test-outside", "test-nochannel"] });
    const allowlist = new Set(["test-g1", "test-g2", "test-gone", "test-nochannel"]);

    const dry = await runCron({ sql, discord: d.client, allowlist, now }, { dryRun: true, monthOverride: POSTED_MONTH });
    assert.deepEqual(dry.wouldPost, ["test-g1", "test-g2"]);
    assert.equal(d.sent.length, 0);
    assert.ok(await row("test-gone"), "dry run must not prune");

    const first = await runCron({ sql, discord: d.client, allowlist, now }, { monthOverride: POSTED_MONTH });
    assert.equal(first.status, "ok");
    assert.deepEqual(first.posted, ["test-g1", "test-g2"]);
    assert.deepEqual(first.pruned, ["test-gone"]);
    assert.equal(await row("test-gone"), undefined);
    assert.equal((await row("test-g1"))!.last, `${POSTED_MONTH}-01`);
    assert.equal((await row("test-outside"))!.last, null);
    assert.equal(d.sent.length, 2);
    // One message per server carries every embed of the post; the last one ends with the Sources field.
    for (const s of d.sent) {
      const posted = s.payload.embeds as { title?: string; fields: { name: string; value: string }[] }[];
      assert.ok(posted.length >= 2 && posted.length <= 10, `${posted.length} embeds in one message`);
      assert.match(posted[0]!.title ?? "", / — cEDH meta, /);
      assert.match(posted.at(-1)!.fields.at(-1)!.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);
      assert.equal(s.payload.content, undefined);
    }

    const second = await runCron({ sql, discord: d.client, allowlist, now }, { monthOverride: POSTED_MONTH });
    assert.deepEqual(second.posted, []);
    assert.equal(d.sent.length, 2, "second run must not post again");
  });

  test("two concurrent cron runs post exactly once", async () => {
    const { runCron } = await import("../src/server/cron");
    await resetTestRows();
    await insert("test-c1", "chan-c1");
    const d = await fakeDiscord({ guilds: ["test-c1"] });
    const deps = { sql, discord: d.client, allowlist: new Set(["test-c1"]), now };
    const [a, b] = await Promise.all([
      runCron(deps, { monthOverride: POSTED_MONTH }),
      runCron(deps, { monthOverride: POSTED_MONTH }),
    ]);
    assert.equal(a.posted.length + b.posted.length, 1);
    assert.equal(d.sent.length, 1);
  });

  test("cron handles Discord errors: unknown channel, unknown guild, missing permissions", async () => {
    const { runCron } = await import("../src/server/cron");
    await resetTestRows();
    await insert("test-e1", "chan-deleted", "pacific-northwest", "2026-08-01");
    await insert("test-e2", "chan-guildgone");
    await insert("test-e3", "chan-noperm", "pacific-northwest", "2026-08-01");
    const d = await fakeDiscord({
      guilds: ["test-e1", "test-e2", "test-e3"],
      failChannels: {
        "chan-deleted": { status: 404, code: 10003 },
        "chan-guildgone": { status: 404, code: 10004 },
        "chan-noperm": { status: 403, code: 50013 },
      },
    });
    const summary = await runCron(
      { sql, discord: d.client, allowlist: new Set(["test-e1", "test-e2", "test-e3"]), now },
      { monthOverride: POSTED_MONTH },
    );
    assert.equal(summary.failed.length, 3);
    assert.deepEqual(await row("test-e1"), { channel_id: null, last: "2026-08-01", region_id: "pacific-northwest" });
    assert.equal(await row("test-e2"), undefined);
    assert.deepEqual(await row("test-e3"), { channel_id: "chan-noperm", last: "2026-08-01", region_id: "pacific-northwest" });
  });

  test("cron data guard and post-day gate", async () => {
    const { runCron } = await import("../src/server/cron");
    const d = await fakeDiscord();
    const deps = { sql, discord: d.client, allowlist: "all" as const, now };
    assert.equal((await runCron(deps, { monthOverride: "2030-01" })).status, "data_not_ready");
    assert.equal((await runCron({ ...deps, now: new Date(Date.UTC(2026, 10, 8)) })).status, "before_post_day");
  });

  test("interactions: /region set, /region show, /channel set, /preview and autocomplete", async () => {
    const { handleInteraction } = await import("../src/server/interactions");
    await resetTestRows();
    const d = await fakeDiscord({ failChannels: { "chan-noperm": { status: 403, code: 50013 } } });
    const deps = { sql: () => sql, discord: d.client, appId: "1", allowlist: new Set(["test-i1"]), now: () => now };
    const run = async (i: Parameters<typeof handleInteraction>[0]) => {
      const r = await handleInteraction(i, deps);
      await r.background?.();
      return r;
    };
    const cmd = (name: string, sub?: string, options?: { name: string; type: number; value: string }[], resolved?: object) => ({
      type: 2,
      token: "tok",
      guild_id: "test-i1",
      data: { name, options: sub ? [{ name: sub, type: 1, options }] : undefined, resolved },
    });

    const ac = await run({ type: 4, token: "tok", guild_id: "test-i1", data: { name: "region", options: [{ name: "set", type: 1, options: [{ name: "region", type: 3, value: "catal", focused: true }] }] } });
    const choices = (ac.response as { data: { choices: { name: string; value: string }[] } }).data.choices;
    assert.ok(choices.some((c) => c.value === "es-cataluna" && c.name === "Cataluña (Spain)"), JSON.stringify(choices));

    await run(cmd("region", "set", [{ name: "region", type: 3, value: "es-b" }]));
    assert.match(d.edits.at(-1)!.content!, /isn't a region I can report on/);

    await run(cmd("region", "set", [{ name: "region", type: 3, value: "si" }]));
    // No fallback line: a report is always about the chosen region.
    assert.equal(d.edits.at(-1)!.content, "Region set to Slovenia.");
    assert.equal((await row("test-i1"))!.region_id, "si");

    const textChannel = (id: string) => ({ channels: { [id]: { id, type: 0 } } });
    await run(cmd("channel", "set", [{ name: "channel", type: 7, value: "chan-noperm" }], textChannel("chan-noperm")));
    assert.match(d.edits.at(-1)!.content!, /can't post in <#chan-noperm>/);
    assert.equal((await row("test-i1"))!.channel_id, null);

    await run(cmd("channel", "set", [{ name: "channel", type: 7, value: "chan-ok" }], textChannel("chan-ok")));
    assert.equal(d.sent.at(-1)!.channelId, "chan-ok");
    assert.doesNotMatch(d.sent.at(-1)!.payload.content!, /Data provided by/, "confirmation shows no TopDeck data");
    assert.equal((await row("test-i1"))!.channel_id, "chan-ok");

    await run(cmd("region", "show"));
    assert.match(d.edits.at(-1)!.content!, /^Region: Slovenia\nChannel: <#chan-ok>/);
    assert.doesNotMatch(d.edits.at(-1)!.content!, /Europe|not enough data/);

    await run(cmd("preview"));
    // Slovenia has no qualifying event in October 2026: the report is that one line about Slovenia, not
    // Europe's report, in one reply, with the attribution as the last field.
    const shown = d.edits.at(-1)!.embeds as { title?: string; description?: string; fields: { name: string; value: string }[] }[];
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.title, "Slovenia — cEDH meta, October 2026");
    assert.equal(shown[0]!.description, "No qualifying events in Slovenia in October.");
    assert.equal(shown[0]!.fields.length, 1);
    assert.match(d.edits.at(-1)!.content!, /Preview of the October report/);
    assert.match(shown.at(-1)!.fields.at(-1)!.name, /Sources$/);
    assert.match(shown.at(-1)!.fields.at(-1)!.value, /Data provided by \[TopDeck\.gg\]\(https:\/\/topdeck\.gg\)/);
    for (const e of d.edits.slice(0, -1)) assert.doesNotMatch(e.content ?? "", /Data provided by/);
    for (const c of choices) assert.doesNotMatch(c.name, /\((continent|country|custom region)\)/);
  });
});
