// Daily cron: on or after the 15th, post the previous month's report to every allowed guild with a channel
// that hasn't had it yet. At most once per guild and month: each guild is claimed atomically before posting,
// and the claim is reverted only when Discord rejects the post. A crash between claim and post skips that
// guild's month rather than risking a double post.
import type { Sql } from "../../scripts/lib/db";
import { redact } from "../../scripts/lib/errors";
import { composePost, loadPostData, type Embed } from "../../scripts/lib/post";
import { isGuildAllowed, POST_FROM_DAY, previousMonth } from "./config";
import { DISCORD_ERRORS, DiscordError, type DiscordClient } from "./discord";

export type CronOptions = { dryRun?: boolean; monthOverride?: string; timeBudgetMs?: number };
export type CronDeps = { sql: Sql; discord: DiscordClient; allowlist: Set<string> | "all"; now: Date };
export type CronSummary = {
  status: "before_post_day" | "data_not_ready" | "ok";
  target: string;
  dryRun: boolean;
  pruned: string[];
  pruneError?: string;
  posted: string[];
  wouldPost: string[];
  alreadyClaimed: string[];
  failed: { guildId: string; error: string }[];
  deferred: string[];
};

const errorText = (err: unknown) => redact(err instanceof Error ? err.message : String(err));

export async function runCron(deps: CronDeps, opts: CronOptions = {}): Promise<CronSummary> {
  const { sql, discord, allowlist, now } = deps;
  const started = Date.now();
  const budget = opts.timeBudgetMs ?? 45_000;
  if (opts.monthOverride && !/^\d{4}-\d{2}$/.test(opts.monthOverride)) throw new Error("month must be YYYY-MM");
  const target = opts.monthOverride ?? previousMonth(now);
  const targetDate = `${target}-01`;
  const summary: CronSummary = {
    status: "ok", target, dryRun: !!opts.dryRun, pruned: [], posted: [], wouldPost: [], alreadyClaimed: [], failed: [], deferred: [],
  };

  if (!opts.monthOverride && now.getUTCDate() < POST_FROM_DAY) return { ...summary, status: "before_post_day" };

  // Data guard: ingest_log only records a month once it ended at least 14 days before it was fetched.
  const [logged] = await sql<{ ok: number }[]>`
    select 1 as ok from ingest_log where window_start = (${targetDate}::date)::timestamp at time zone 'UTC'`;
  if (!logged) return { ...summary, status: "data_not_ready" };

  // Prune configs for guilds the bot is no longer in (no HTTP event exists for bot removal).
  try {
    const ids = await discord.listGuildIds();
    const gone = await sql<{ guild_id: string }[]>`
      select guild_id from guild_configs where not (guild_id = any(${sql.array(ids, 1009)}::text[]))`;
    summary.pruned = gone.map((g) => g.guild_id);
    if (!opts.dryRun && summary.pruned.length > 0) {
      await sql`delete from guild_configs where guild_id = any(${sql.array(summary.pruned, 1009)}::text[])`;
    }
  } catch (err) {
    summary.pruneError = errorText(err);
  }

  const candidates = (
    await sql<{ guild_id: string; region_id: string }[]>`
      select guild_id, region_id from guild_configs
      where channel_id is not null and (last_posted_month is null or last_posted_month < ${targetDate}::date)
      order by guild_id`
  ).filter((c) => isGuildAllowed(allowlist, c.guild_id) && !summary.pruned.includes(c.guild_id));

  const composed = new Map<string, Promise<Embed>>();
  const embedFor = (regionId: string) => {
    let p = composed.get(regionId);
    if (!p) {
      p = loadPostData(sql, regionId, target).then((data) => composePost(data).embed);
      composed.set(regionId, p);
    }
    return p;
  };

  if (opts.dryRun) {
    for (const c of candidates) {
      try {
        await embedFor(c.region_id);
        summary.wouldPost.push(c.guild_id);
      } catch (err) {
        summary.failed.push({ guildId: c.guild_id, error: errorText(err) });
      }
    }
    return summary;
  }

  for (const [index, c] of candidates.entries()) {
    if (Date.now() - started > budget) {
      summary.deferred = candidates.slice(index).map((x) => x.guild_id);
      break;
    }
    const claim = await sql<{ previous: string | null; channel_id: string; region_id: string }[]>`
      with prev as (
        select guild_id, last_posted_month from guild_configs where guild_id = ${c.guild_id} for update
      )
      update guild_configs g set last_posted_month = ${targetDate}::date, updated_at = now()
      from prev
      where g.guild_id = prev.guild_id
        and g.channel_id is not null
        and (prev.last_posted_month is null or prev.last_posted_month < ${targetDate}::date)
      returning prev.last_posted_month::text as previous, g.channel_id, g.region_id`;
    if (claim.length === 0) {
      summary.alreadyClaimed.push(c.guild_id);
      continue;
    }
    const { previous, channel_id: channelId, region_id: regionId } = claim[0]!;
    try {
      await discord.createMessage(channelId, { embeds: [await embedFor(regionId)] });
      summary.posted.push(c.guild_id);
    } catch (err) {
      const code = err instanceof DiscordError ? err.code : undefined;
      if (code === DISCORD_ERRORS.unknownGuild) {
        await sql`delete from guild_configs where guild_id = ${c.guild_id}`;
      } else if (code === DISCORD_ERRORS.unknownChannel) {
        await sql`
          update guild_configs set channel_id = null, last_posted_month = ${previous}::date, updated_at = now()
          where guild_id = ${c.guild_id} and last_posted_month = ${targetDate}::date`;
      } else {
        await sql`
          update guild_configs set last_posted_month = ${previous}::date, updated_at = now()
          where guild_id = ${c.guild_id} and last_posted_month = ${targetDate}::date`;
      }
      summary.failed.push({ guildId: c.guild_id, error: errorText(err) });
    }
  }
  return summary;
}
