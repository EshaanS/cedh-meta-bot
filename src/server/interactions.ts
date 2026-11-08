// Discord interaction handling: PING, region autocomplete, and the admin slash commands.
// Commands that touch the database are deferred (ephemeral); the work runs afterwards and edits the reply.
import type { Sql } from "../../scripts/lib/db";
import { redact } from "../../scripts/lib/errors";
import { composePost, loadPostData } from "../../scripts/lib/post";
import { isGuildAllowed, monthName, POST_FROM_DAY, previousMonth } from "./config";
import { DISCORD_ERRORS, DiscordError, type DiscordClient, type MessagePayload } from "./discord";

const PING = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;
const RESPONSE_PONG = 1;
const RESPONSE_MESSAGE = 4;
const RESPONSE_DEFERRED = 5;
const RESPONSE_AUTOCOMPLETE = 8;
const EPHEMERAL = 64;

const ATTRIBUTION = "Data provided by [TopDeck.gg](<https://topdeck.gg>)";
const REGION_CACHE_MS = 10 * 60 * 1000;

type Option = { name: string; type: number; value?: string | number | boolean; focused?: boolean; options?: Option[] };
export type Interaction = {
  type: number;
  token: string;
  guild_id?: string;
  data?: { name: string; options?: Option[]; resolved?: { channels?: Record<string, { id: string; type: number }> } };
};
export type InteractionDeps = {
  sql: () => Sql;
  discord: DiscordClient;
  appId: string;
  allowlist: Set<string> | "all";
  now: () => Date;
};
export type InteractionResult = { response: unknown; background?: () => Promise<void> };

const ephemeral = (content: string) => ({ type: RESPONSE_MESSAGE, data: { content: `${content}\n${ATTRIBUTION}`, flags: EPHEMERAL } });
const reply = (content: string): MessagePayload => ({ content: `${content}\n${ATTRIBUTION}` });

// ---------- region search (autocomplete) ----------

type RegionChoice = { id: string; label: string; search: string; rank: number };
let regionCache: { at: number; rows: RegionChoice[] } | null = null;
const TYPE_RANK: Record<string, number> = { global: 0, macro: 1, country: 2, custom: 3, admin1_group: 4, admin1: 5 };
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

async function selectableRegions(sql: Sql, now: number): Promise<RegionChoice[]> {
  if (regionCache && now - regionCache.at < REGION_CACHE_MS) return regionCache.rows;
  const rows = await sql<{ id: string; display_name: string; type: string; country_name: string | null }[]>`
    select r.id, r.display_name, r.type, c.display_name as country_name
    from regions r
    left join regions c on c.type = 'country' and c.id = split_part(r.id, '-', 1) and r.type in ('admin1', 'admin1_group')
    where r.selectable`;
  const label = (r: (typeof rows)[number]) => {
    if (r.type === "macro") return `${r.display_name} (continent)`;
    if (r.type === "country") return `${r.display_name} (country)`;
    if (r.type === "custom") return `${r.display_name} (custom region)`;
    if (r.country_name) return `${r.display_name}, ${r.country_name}`;
    return r.display_name;
  };
  regionCache = {
    at: now,
    rows: rows.map((r) => ({ id: r.id, label: label(r).slice(0, 100), search: fold(`${r.display_name} ${r.id}`), rank: TYPE_RANK[r.type] ?? 9 })),
  };
  return regionCache.rows;
}

export function matchRegions(rows: RegionChoice[], query: string, limit = 25): { name: string; value: string }[] {
  const q = fold(query.trim());
  return rows
    .map((r) => ({ r, starts: q === "" || r.search.startsWith(q) || r.search.includes(` ${q}`), hit: q === "" || r.search.includes(q) }))
    .filter((x) => x.hit)
    .sort((a, b) => Number(b.starts) - Number(a.starts) || a.r.rank - b.r.rank || a.r.label.localeCompare(b.r.label))
    .slice(0, limit)
    .map((x) => ({ name: x.r.label, value: x.r.id }));
}

// ---------- commands ----------

const subcommand = (i: Interaction) => i.data?.options?.[0];
const optionValue = (opts: Option[] | undefined, name: string) => opts?.find((o) => o.name === name)?.value;
const monthStart = (yyyyMm: string) => `${yyyyMm}-01`;
const currentMonth = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

async function regionSet(deps: InteractionDeps, guildId: string, value: unknown): Promise<MessagePayload> {
  const sql = deps.sql();
  const id = String(value ?? "").trim().toLowerCase();
  const [region] = await sql<{ id: string; display_name: string }[]>`
    select id, display_name from regions where id = ${id} and selectable`;
  if (!region) return reply("That isn't a region I can report on. Start typing and pick one from the list.");
  await sql`
    insert into guild_configs (guild_id, region_id) values (${guildId}, ${region.id})
    on conflict (guild_id) do update set region_id = excluded.region_id, updated_at = now()`;
  const month = previousMonth(deps.now());
  const [resolved] = await sql<{ steps_up: number; display_name: string }[]>`
    select rr.steps_up, r.display_name from resolve_region(${region.id}, ${monthStart(month)}::date) rr join regions r on r.id = rr.region_id`;
  const lines = [`Region set to ${region.display_name}.`];
  if (resolved && resolved.steps_up > 0) {
    lines.push(`There isn't enough data for ${region.display_name} yet, so reports will show ${resolved.display_name} until there is.`);
  }
  return reply(lines.join("\n"));
}

async function regionShow(deps: InteractionDeps, guildId: string): Promise<MessagePayload> {
  const sql = deps.sql();
  const now = deps.now();
  const [cfg] = await sql<{ region_id: string; display_name: string; channel_id: string | null; last_posted: string | null }[]>`
    select g.region_id, r.display_name, g.channel_id, g.last_posted_month::text as last_posted
    from guild_configs g join regions r on r.id = g.region_id where g.guild_id = ${guildId}`;
  const regionId = cfg?.region_id ?? "global";
  const target = previousMonth(now);
  const [resolved] = await sql<{ steps_up: number; display_name: string }[]>`
    select rr.steps_up, r.display_name from resolve_region(${regionId}, ${monthStart(target)}::date) rr join regions r on r.id = rr.region_id`;
  const lines = [`Region: ${cfg?.display_name ?? "Global"}${cfg ? "" : " (default)"}`];
  if (resolved && resolved.steps_up > 0) lines.push(`Reports currently show ${resolved.display_name} (not enough data for the region yet).`);
  lines.push(`Channel: ${cfg?.channel_id ? `<#${cfg.channel_id}>` : "not set (use /channel set)"}`);
  lines.push(`Last report posted: ${cfg?.last_posted ? monthName(cfg.last_posted.slice(0, 7)) + " " + cfg.last_posted.slice(0, 4) : "none yet"}`);
  if (cfg?.channel_id) {
    const cur = currentMonth(now);
    if (cfg.last_posted && cfg.last_posted.slice(0, 7) >= target) {
      const next = previousMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)));
      lines.push(`Next report: ${monthName(cur)}, on or after ${POST_FROM_DAY} ${monthName(next)}.`);
    } else if (now.getUTCDate() < POST_FROM_DAY) {
      lines.push(`Next report: ${monthName(target)}, on or after ${POST_FROM_DAY} ${monthName(cur)}.`);
    } else {
      lines.push(`Next report: ${monthName(target)}, with the next daily run once the data is final.`);
    }
  }
  return reply(lines.join("\n"));
}

async function channelSet(deps: InteractionDeps, i: Interaction, guildId: string, value: unknown): Promise<MessagePayload> {
  const channelId = String(value ?? "");
  const channel = i.data?.resolved?.channels?.[channelId];
  if (!channel || ![0, 5].includes(channel.type)) return reply("Pick a text or announcement channel.");
  try {
    await deps.discord.createMessage(channelId, {
      content: `Field Report will post the monthly cEDH meta report in this channel.\n${ATTRIBUTION}`,
    });
  } catch (err) {
    if (err instanceof DiscordError && (err.code === DISCORD_ERRORS.missingAccess || err.code === DISCORD_ERRORS.missingPermissions || err.status === 403)) {
      return reply(`I can't post in <#${channelId}>. Give Field Report the View Channel, Send Messages and Embed Links permissions there, then run /channel set again.`);
    }
    throw err;
  }
  await deps.sql()`
    insert into guild_configs (guild_id, channel_id) values (${guildId}, ${channelId})
    on conflict (guild_id) do update set channel_id = excluded.channel_id, updated_at = now()`;
  return reply(`Reports will be posted in <#${channelId}>. I sent a confirmation message there.`);
}

async function preview(deps: InteractionDeps, guildId: string): Promise<MessagePayload> {
  const sql = deps.sql();
  const now = deps.now();
  const [cfg] = await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${guildId}`;
  const month = previousMonth(now);
  const { embed } = composePost(await loadPostData(sql, cfg?.region_id ?? "global", month));
  const lines = [`Preview of the ${monthName(month)} report (only you can see this).`];
  if (now.getUTCDate() < POST_FROM_DAY) {
    lines.push(`${monthName(month)} data is still settling; the posted version goes out on or after ${POST_FROM_DAY} ${monthName(currentMonth(now))}.`);
  }
  return { content: lines.join("\n"), embeds: [embed] };
}

// ---------- dispatch ----------

export async function handleInteraction(i: Interaction, deps: InteractionDeps): Promise<InteractionResult> {
  if (i.type === PING) return { response: { type: RESPONSE_PONG } };

  if (i.type === AUTOCOMPLETE) {
    if (!isGuildAllowed(deps.allowlist, i.guild_id)) return { response: { type: RESPONSE_AUTOCOMPLETE, data: { choices: [] } } };
    const focused = subcommand(i)?.options?.find((o) => o.focused);
    const rows = await selectableRegions(deps.sql(), deps.now().getTime());
    return { response: { type: RESPONSE_AUTOCOMPLETE, data: { choices: matchRegions(rows, String(focused?.value ?? "")) } } };
  }

  if (i.type !== APPLICATION_COMMAND || !i.data) return { response: ephemeral("Unsupported interaction.") };
  if (!i.guild_id) return { response: ephemeral("Field Report commands work in servers only.") };
  if (!isGuildAllowed(deps.allowlist, i.guild_id)) return { response: ephemeral("Field Report isn't open yet.") };

  const guildId = i.guild_id;
  const sub = subcommand(i);
  let work: (() => Promise<MessagePayload>) | null = null;
  if (i.data.name === "region" && sub?.name === "set") work = () => regionSet(deps, guildId, optionValue(sub.options, "region"));
  else if (i.data.name === "region" && sub?.name === "show") work = () => regionShow(deps, guildId);
  else if (i.data.name === "channel" && sub?.name === "set") work = () => channelSet(deps, i, guildId, optionValue(sub.options, "channel"));
  else if (i.data.name === "preview") work = () => preview(deps, guildId);
  if (!work) return { response: ephemeral("Unknown command.") };

  const run = work;
  return {
    response: { type: RESPONSE_DEFERRED, data: { flags: EPHEMERAL } },
    background: async () => {
      try {
        await deps.discord.editOriginal(deps.appId, i.token, await run());
      } catch (err) {
        console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
        await deps.discord.editOriginal(deps.appId, i.token, reply("Something went wrong. Please try again later.")).catch(() => {});
      }
    },
  };
}
