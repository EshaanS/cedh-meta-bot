// Discord interaction handling: PING, autocomplete (regions, places, a server's custom regions), and the admin
// slash commands. Commands that touch the database are deferred (ephemeral); the work runs afterwards and edits
// the reply.
import type { Sql } from "../../scripts/lib/db";
import { redact } from "../../scripts/lib/errors";
import { composePost, loadPostData } from "../../scripts/lib/post";
import { isGuildAllowed, monthName, POST_FROM_DAY, previousMonth } from "./config";
import {
  addPlaces, centerOptions, createRegion, deleteRegion, findGuildRegion, fold, listGuildRegions, matchCenters, matchPlaces, placeOptions,
  REGION_CONFIG, RegionError, regionPlaces, removePlaces, resolveAddRequest, targetRegion, type GuildRegion,
} from "./custom-regions";
import { addSummary, removeSummary } from "./place-matching";
import { DISCORD_ERRORS, DiscordError, type DiscordClient, type MessagePayload } from "./discord";

const PING = 1;
const APPLICATION_COMMAND = 2;
const AUTOCOMPLETE = 4;
const RESPONSE_PONG = 1;
const RESPONSE_MESSAGE = 4;
const RESPONSE_DEFERRED = 5;
const RESPONSE_AUTOCOMPLETE = 8;
const EPHEMERAL = 64;

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
type Choice = { name: string; value: string };

// Config replies show no TopDeck data, so they carry no attribution; /preview's last embed has the Sources field.
const ephemeral = (content: string) => ({ type: RESPONSE_MESSAGE, data: { content, flags: EPHEMERAL } });
const reply = (content: string): MessagePayload => ({ content });

// ---------- region search (autocomplete) ----------

type RegionChoice = { id: string; label: string; search: string; rank: number };
let regionCache: { at: number; rows: RegionChoice[] } | null = null;
const TYPE_RANK: Record<string, number> = { global: 0, macro: 1, country: 2, custom: 3, admin1_group: 4, admin1: 5 };

/** Standard regions only: a server's own custom regions are read separately and never cached across servers. */
async function selectableRegions(sql: Sql, now: number): Promise<RegionChoice[]> {
  if (regionCache && now - regionCache.at < REGION_CACHE_MS) return regionCache.rows;
  // region_label never shows the region type; sub-national regions carry their country.
  const rows = await sql<{ id: string; label: string; display_name: string; type: string }[]>`
    select id, region_label(id) as label, display_name, type from regions where selectable and owner_guild_id is null`;
  regionCache = {
    at: now,
    rows: rows.map((r) => ({ id: r.id, label: r.label.slice(0, 100), search: fold(`${r.label} ${r.id}`), rank: TYPE_RANK[r.type] ?? 9 })),
  };
  return regionCache.rows;
}

export function matchRegions(rows: RegionChoice[], query: string, limit = 25): Choice[] {
  const q = fold(query.trim());
  return rows
    .map((r) => ({ r, starts: q === "" || r.search.startsWith(q) || r.search.includes(` ${q}`), hit: q === "" || r.search.includes(q) }))
    .filter((x) => x.hit)
    .sort((a, b) => Number(b.starts) - Number(a.starts) || a.r.rank - b.r.rank || a.r.label.localeCompare(b.r.label))
    .slice(0, limit)
    .map((x) => ({ name: x.r.label, value: x.r.id }));
}

/** This server's custom regions matching what was typed. `suffix` marks them in the /region set list. */
export function matchGuildRegions(rows: GuildRegion[], query: string, suffix = ""): Choice[] {
  const q = fold(query.trim());
  return rows
    .filter((r) => q === "" || fold(r.name).includes(q))
    .slice(0, REGION_CONFIG.choiceMax)
    .map((r) => ({ name: `${r.name}${suffix}`.slice(0, REGION_CONFIG.choiceTextMax), value: r.id }));
}

const OWN_SUFFIX = " — this server";

async function autocomplete(deps: InteractionDeps, i: Interaction, guildId: string): Promise<Choice[]> {
  const sub = subcommand(i);
  const focused = sub?.options?.find((o) => o.focused);
  if (i.data?.name !== "region" || !sub || !focused) return [];
  const sql = deps.sql();
  const now = deps.now().getTime();
  const typed = String(focused.value ?? "");

  if (sub.name === "set") {
    // The server's own regions first, then the standard ones.
    const own = matchGuildRegions(await listGuildRegions(sql, guildId), typed, OWN_SUFFIX);
    return [...own, ...matchRegions(await selectableRegions(sql, now), typed)].slice(0, REGION_CONFIG.choiceMax);
  }
  if (focused.name === "region") return matchGuildRegions(await listGuildRegions(sql, guildId), typed);
  if (sub.name === "add" && focused.name === "around") return matchCenters(await centerOptions(sql, now), typed);
  if (!isPlaceOption(focused.name)) return [];
  // Each place option has its own list; a place already picked in another option of this command is left out.
  const picked = new Set(placeValues(sub.options).filter((_, n) => REGION_CONFIG.placeOptionNames[n] !== focused.name).map(String));
  if (sub.name === "add") {
    const rows = (await placeOptions(sql, now)).filter((o) => !picked.has(o.value));
    return matchPlaces(rows, typed);
  }
  if (sub.name === "remove") {
    const region = await targetRegion(sql, guildId, optionValue(sub.options, "region")).catch(() => null);
    if (!region) return [];
    const q = fold(typed.trim());
    return (await regionPlaces(sql, region.id))
      .filter((p) => !picked.has(`p:${p.id}`) && (q === "" || fold(p.label).includes(q)))
      .slice(0, REGION_CONFIG.choiceMax)
      .map((p) => ({ name: p.label.slice(0, REGION_CONFIG.choiceTextMax), value: `p:${p.id}` }));
  }
  return [];
}

// ---------- commands ----------

const subcommand = (i: Interaction) => i.data?.options?.[0];
const optionValue = (opts: Option[] | undefined, name: string) => opts?.find((o) => o.name === name)?.value;
const currentMonth = (now: Date) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const isPlaceOption = (name: string) => (REGION_CONFIG.placeOptionNames as readonly string[]).includes(name);
/** The values of place, place2 … place5, in that order (undefined where the option was left out). */
const placeValues = (opts: Option[] | undefined) => REGION_CONFIG.placeOptionNames.map((name) => optionValue(opts, name));
const given = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

async function regionSet(deps: InteractionDeps, guildId: string, value: unknown): Promise<MessagePayload> {
  const sql = deps.sql();

  // One of this server's own regions (by the id a choice carries, or by name with or without the list suffix).
  const typed = String(value ?? "").trim();
  const own = await findGuildRegion(sql, guildId, typed.endsWith(OWN_SUFFIX) ? typed.slice(0, -OWN_SUFFIX.length) : typed);
  if (own) {
    if (own.places === 0) return reply(`${own.name} has no places yet. Add some with /region add, then run /region set again.`);
    await sql`
      insert into guild_configs (guild_id, region_id) values (${guildId}, ${own.id})
      on conflict (guild_id) do update set region_id = excluded.region_id, updated_at = now()`;
    return reply(`Region set to ${own.name}.`);
  }

  const id = typed.toLowerCase();
  const [region] = await sql<{ id: string; display_name: string }[]>`
    select id, region_label(id) as display_name from regions where id = ${id} and selectable and owner_guild_id is null`;
  if (!region) return reply("That isn't a region I can report on. Start typing and pick one from the list.");
  await sql`
    insert into guild_configs (guild_id, region_id) values (${guildId}, ${region.id})
    on conflict (guild_id) do update set region_id = excluded.region_id, updated_at = now()`;
  // A report is always about the chosen region and uses only its own data, so there is nothing more to say.
  return reply(`Region set to ${region.display_name}.`);
}

async function regionShow(deps: InteractionDeps, guildId: string): Promise<MessagePayload> {
  const sql = deps.sql();
  const now = deps.now();
  const [cfg] = await sql<{ region_id: string; display_name: string; channel_id: string | null; last_posted: string | null }[]>`
    select g.region_id, region_label(g.region_id) as display_name, g.channel_id, g.last_posted_month::text as last_posted
    from guild_configs g where g.guild_id = ${guildId}`;
  const regionId = cfg?.region_id ?? "global";
  const target = previousMonth(now);
  const lines = [`Region: ${cfg?.display_name ?? "Global"}${cfg ? "" : " (default)"}`];
  const own = (await listGuildRegions(sql, guildId)).find((r) => r.id === regionId);
  if (own) {
    const list = await regionPlaces(sql, own.id);
    lines.push(list.length ? `Places (${list.length}): ${list.map((p) => p.label).join("; ")}` : "Places: none yet (use /region add)");
  }
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

// ---------- custom regions ----------

async function regionCreate(deps: InteractionDeps, guildId: string, name: unknown): Promise<MessagePayload> {
  const region = await createRegion(deps.sql(), guildId, name);
  return reply(`Created ${region.name}. Add places with /region add, then choose it with /region set.`);
}

const ADD_HINT = [
  "Nothing to add yet. Use one or more of these options:",
  "• place, place2 … place5: start typing and pick a city, state, country or continent from the list.",
  "• list: several places in one go, for example `Tacoma, Issaquah, Lacey, Vancouver BC`.",
  `• around and km: everything within a distance of a city, for example around Seattle, km ${REGION_CONFIG.radiusDefaultKm}.`,
].join("\n");
const REMOVE_HINT = "Nothing to remove yet. Pick places in the place options, or type several in the list option.";

/** One /region add: every picked place, the typed list and the radius, with one summary of what happened. */
async function regionAdd(deps: InteractionDeps, guildId: string, opts: Option[] | undefined): Promise<MessagePayload> {
  const request = { picks: placeValues(opts), list: optionValue(opts, "list"), around: optionValue(opts, "around"), km: optionValue(opts, "km") };
  if (![...request.picks, request.list, request.around, request.km].some(given)) return reply(ADD_HINT);
  const sql = deps.sql();
  const region = await targetRegion(sql, guildId, optionValue(opts, "region"));
  const { places, outcome } = await resolveAddRequest(sql, deps.now().getTime(), request);
  const total = places.length > 0 ? await addPlaces(sql, guildId, region, places, outcome) : region.places;
  return reply(addSummary(region.name, outcome, total, REGION_CONFIG.maxPlacesPerRegion));
}

async function regionRemove(deps: InteractionDeps, guildId: string, opts: Option[] | undefined): Promise<MessagePayload> {
  const picks = placeValues(opts);
  const list = optionValue(opts, "list");
  if (![...picks, list].some(given)) return reply(REMOVE_HINT);
  const sql = deps.sql();
  const region = await targetRegion(sql, guildId, optionValue(opts, "region"));
  const { outcome, left } = await removePlaces(sql, guildId, region, picks, list);
  return reply(removeSummary(region.name, outcome, left));
}

async function regionDelete(deps: InteractionDeps, guildId: string, regionValue: unknown): Promise<MessagePayload> {
  const sql = deps.sql();
  const region = await findGuildRegion(sql, guildId, regionValue);
  if (!region) return reply("This server has no custom region with that name. Use /region list to see them.");
  const wasCurrent = await deleteRegion(sql, guildId, region);
  const lines = [`Deleted ${region.name}.`];
  if (wasCurrent) lines.push("It was this server's region, so the region is now Global. Use /region set to choose another.");
  return reply(lines.join("\n"));
}

async function regionList(deps: InteractionDeps, guildId: string): Promise<MessagePayload> {
  const sql = deps.sql();
  const all = await listGuildRegions(sql, guildId);
  if (all.length === 0) return reply("This server has no custom regions. Create one with /region create, then add places with /region add.");
  const [cfg] = await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${guildId}`;
  const lines = [`Custom regions (${all.length} of ${REGION_CONFIG.maxRegionsPerGuild}):`];
  for (const r of all) {
    const list = await regionPlaces(sql, r.id);
    const current = r.id === cfg?.region_id ? " (this server's region)" : "";
    lines.push(`• ${r.name}${current}: ${list.length ? list.map((p) => p.label).join("; ") : "no places yet"}`);
  }
  return reply(lines.join("\n").slice(0, 1900));
}

async function channelSet(deps: InteractionDeps, i: Interaction, guildId: string, value: unknown): Promise<MessagePayload> {
  const channelId = String(value ?? "");
  const channel = i.data?.resolved?.channels?.[channelId];
  if (!channel || ![0, 5].includes(channel.type)) return reply("Pick a text or announcement channel.");
  try {
    await deps.discord.createMessage(channelId, {
      content: "Field Report will post the monthly cEDH meta report in this channel.",
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
  const { embeds } = composePost(await loadPostData(sql, cfg?.region_id ?? "global", month));
  const lines = [`Preview of the ${monthName(month)} report (only you can see this).`];
  if (now.getUTCDate() < POST_FROM_DAY) {
    lines.push(`${monthName(month)} data is still settling; the posted version goes out on or after ${POST_FROM_DAY} ${monthName(currentMonth(now))}.`);
  }
  return { content: lines.join("\n"), embeds };
}

// ---------- dispatch ----------

export async function handleInteraction(i: Interaction, deps: InteractionDeps): Promise<InteractionResult> {
  if (i.type === PING) return { response: { type: RESPONSE_PONG } };

  if (i.type === AUTOCOMPLETE) {
    let choices: Choice[] = [];
    if (i.guild_id && isGuildAllowed(deps.allowlist, i.guild_id)) {
      try {
        choices = await autocomplete(deps, i, i.guild_id);
      } catch (err) {
        // Autocomplete has 3 seconds and no way to show an error: log it and offer nothing.
        console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
      }
    }
    return { response: { type: RESPONSE_AUTOCOMPLETE, data: { choices } } };
  }

  if (i.type !== APPLICATION_COMMAND || !i.data) return { response: ephemeral("Unsupported interaction.") };
  if (!i.guild_id) return { response: ephemeral("Field Report commands work in servers only.") };
  if (!isGuildAllowed(deps.allowlist, i.guild_id)) return { response: ephemeral("Field Report isn't open yet.") };

  const guildId = i.guild_id;
  const sub = subcommand(i);
  const opt = (name: string) => optionValue(sub?.options, name);
  let work: (() => Promise<MessagePayload>) | null = null;
  if (i.data.name === "region") {
    if (sub?.name === "set") work = () => regionSet(deps, guildId, opt("region"));
    else if (sub?.name === "show") work = () => regionShow(deps, guildId);
    else if (sub?.name === "create") work = () => regionCreate(deps, guildId, opt("name"));
    else if (sub?.name === "add") work = () => regionAdd(deps, guildId, sub.options);
    else if (sub?.name === "remove") work = () => regionRemove(deps, guildId, sub.options);
    else if (sub?.name === "delete") work = () => regionDelete(deps, guildId, opt("region"));
    else if (sub?.name === "list") work = () => regionList(deps, guildId);
  } else if (i.data.name === "channel" && sub?.name === "set") work = () => channelSet(deps, i, guildId, opt("channel"));
  else if (i.data.name === "preview") work = () => preview(deps, guildId);
  if (!work) return { response: ephemeral("Unknown command.") };

  const run = work;
  return {
    response: { type: RESPONSE_DEFERRED, data: { flags: EPHEMERAL } },
    background: async () => {
      try {
        await deps.discord.editOriginal(deps.appId, i.token, await run());
      } catch (err) {
        // A RegionError is a message for the admin (a limit, a name clash, a place that isn't in the data).
        if (err instanceof RegionError) {
          await deps.discord.editOriginal(deps.appId, i.token, reply(err.message)).catch(() => {});
          return;
        }
        console.error(redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
        await deps.discord.editOriginal(deps.appId, i.token, reply("Something went wrong. Please try again later.")).catch(() => {});
      }
    },
  };
}
