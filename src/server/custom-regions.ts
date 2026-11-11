// Custom regions: a server admin builds a region out of places and uses it as the server's region.
// A custom region is a row in `regions` with owner_guild_id set; its places are rows in region_places
// (migration 015). Every query here is filtered by the calling server's id: a server never sees, changes or
// uses another server's region. Replies from these functions show no TopDeck data (names of places only).
import { randomBytes } from "node:crypto";
import type { Sql } from "../../scripts/lib/db";
import { CUSTOM_REGION_NAME_MAX, customStatsRegion, sanitizeOrganizerText } from "../../scripts/lib/post";

export const REGION_CONFIG = {
  /** Custom regions one server may have. */
  maxRegionsPerGuild: 5,
  /** Places in one custom region. A continent or a country is one place. */
  maxPlacesPerRegion: 25,
  /** Longest name, after cleaning. Names appear in post titles. */
  nameMax: CUSTOM_REGION_NAME_MAX,
  /** Cities offered are those with a qualifying event in this many months (as the region catalog does). */
  cityMonths: 12,
  /** How long one serverless instance keeps the list of places for autocomplete. */
  placeCacheMs: 10 * 60 * 1000,
  /** Discord shows at most 25 autocomplete choices, each up to 100 characters. */
  choiceMax: 25,
  choiceTextMax: 100,
} as const;

export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A reply for the admin when something can't be done. Never contains data from another server. */
export class RegionError extends Error {}

// ---------- names ----------

/**
 * Cleans an admin-written region name the way event names are cleaned (no links, invites, mentions or
 * markdown; whitespace collapsed). Rejects a name that is empty afterwards or longer than the limit.
 */
export function cleanRegionName(raw: unknown): string {
  const cleaned = sanitizeOrganizerText(typeof raw === "string" ? raw : "", 1000);
  if (!cleaned) throw new RegionError("Give the region a name using letters or numbers.");
  if (cleaned.length > REGION_CONFIG.nameMax) throw new RegionError(`Region names can be up to ${REGION_CONFIG.nameMax} characters.`);
  return cleaned;
}

// ---------- places an admin can add (autocomplete) ----------

export type PlaceOption = { value: string; label: string; plain: string; search: string; rank: number; events: number };
type PlaceCache = { at: number; rows: PlaceOption[] };
let placeCache: PlaceCache | null = null;
export const resetPlaceCache = () => { placeCache = null; };

const PLACE_RANK: Record<string, number> = { macro: 1, country: 2, custom: 3, admin1_group: 4, admin1: 5 };
const CITY_RANK = 6;
const cityValue = (cc: string, a1: string | null, key: string) => `c:${cc}:${a1 ?? ""}:${key}`;
const cityPlain = (city: string, admin1: string | null, country: string | null) => [city, admin1, country].filter(Boolean).join(", ");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const since = (now: number) => {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - REGION_CONFIG.cityMonths, 1));
};

const englishCountryNames = new Intl.DisplayNames(["en"], { type: "region" });

/**
 * Countries a continent lists that have no region row yet, because they have had no qualifying event (observed
 * November 2026: Luxembourg). They can still be members, by country code, so "Benelux" is complete and picks
 * up events when they come.
 */
async function regionlessCountries(sql: Sql): Promise<{ code: string; name: string }[]> {
  const rows = await sql<{ code: string }[]>`
    select distinct m.country_code as code
    from region_members m
    join regions r on r.id = m.region_id
    where r.type = 'macro' and r.owner_guild_id is null and m.admin1_code is null and m.admin1_group_code is null
      and not exists (select 1 from regions c where c.id = lower(m.country_code))`;
  return rows.flatMap((r) => {
    try {
      const name = englishCountryNames.of(r.code);
      return name && name !== r.code ? [{ code: r.code, name }] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Everything that can be a member: selectable standard regions other than Global (states and provinces,
 * groups, countries, continents, seeded regions), countries with no events yet, and every city with a
 * qualifying event in the last cityMonths months, labelled with state, country and event count. Cached per
 * instance.
 */
export async function placeOptions(sql: Sql, now: number): Promise<PlaceOption[]> {
  if (placeCache && now - placeCache.at < REGION_CONFIG.placeCacheMs) return placeCache.rows;
  const regions = await sql<{ id: string; label: string; type: string }[]>`
    select id, region_label(id) as label, type from regions
    where selectable and owner_guild_id is null and type <> 'global'`;
  const cities = await sql<{ country_code: string; country_name: string | null; admin1_code: string | null; admin1_name: string | null; city_key: string; city_name: string; events: string }[]>`
    select * from region_city_options(${since(now)})`;
  const countries = await regionlessCountries(sql);
  const rows: PlaceOption[] = [
    ...regions.map((r) => ({ value: `r:${r.id}`, label: r.label, plain: r.label, search: fold(`${r.label} ${r.id}`), rank: PLACE_RANK[r.type] ?? 9, events: 0 })),
    ...countries.map((c) => ({ value: `k:${c.code}`, label: c.name, plain: c.name, search: fold(`${c.name} ${c.code}`), rank: PLACE_RANK.country!, events: 0 })),
    ...cities.map((c) => {
      const plain = cityPlain(c.city_name, c.admin1_name, c.country_name);
      return {
        value: cityValue(c.country_code, c.admin1_code, c.city_key),
        label: `${plain} (${plural(Number(c.events), "event", "events")})`,
        plain,
        search: fold(plain),
        rank: CITY_RANK,
        events: Number(c.events),
      };
    }),
  ].filter((o) => o.value.length <= REGION_CONFIG.choiceTextMax)
    .map((o) => ({ ...o, label: o.label.slice(0, REGION_CONFIG.choiceTextMax) }));
  placeCache = { at: now, rows };
  return rows;
}

/** Prefix matches first, then regions before cities, busier cities first. At most 25. */
export function matchPlaces(rows: PlaceOption[], query: string, limit: number = REGION_CONFIG.choiceMax): { name: string; value: string }[] {
  const q = fold(query.trim());
  return rows
    .map((r) => ({ r, starts: q === "" || r.search.startsWith(q) || r.search.includes(` ${q}`), hit: q === "" || r.search.includes(q) }))
    .filter((x) => x.hit)
    .sort((a, b) => Number(b.starts) - Number(a.starts) || a.r.rank - b.r.rank || b.r.events - a.r.events || a.r.label.localeCompare(b.r.label))
    .slice(0, limit)
    .map((x) => ({ name: x.r.label, value: x.r.value }));
}

// ---------- reading a server's regions ----------

export type GuildRegion = { id: string; name: string; places: number };
export type RegionPlace = { id: string; label: string };

export async function listGuildRegions(sql: Sql, guildId: string): Promise<GuildRegion[]> {
  return [...await sql<GuildRegion[]>`
    select r.id, r.display_name as name, (select count(*) from region_places p where p.region_id = r.id)::int as places
    from regions r
    where r.owner_guild_id = ${guildId}
    order by lower(r.display_name)`];
}

/** One of this server's regions, by the id an autocomplete choice carries or by its name. */
export async function findGuildRegion(sql: Sql, guildId: string, value: unknown): Promise<GuildRegion | null> {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const [row] = await sql<GuildRegion[]>`
    select r.id, r.display_name as name, (select count(*) from region_places p where p.region_id = r.id)::int as places
    from regions r
    where r.owner_guild_id = ${guildId} and (r.id = ${v} or lower(r.display_name) = lower(${v}))
    order by (r.id = ${v}) desc
    limit 1`;
  return row ?? null;
}

/**
 * The region a command works on: the one named, or when none is named the server's only custom region, or
 * its current region when that is a custom one.
 */
export async function targetRegion(sql: Sql, guildId: string, value: unknown): Promise<GuildRegion> {
  if (String(value ?? "").trim()) {
    const named = await findGuildRegion(sql, guildId, value);
    if (!named) throw new RegionError("This server has no custom region with that name. Use /region list to see them.");
    return named;
  }
  const all = await listGuildRegions(sql, guildId);
  if (all.length === 0) throw new RegionError("This server has no custom regions yet. Create one with /region create.");
  if (all.length === 1) return all[0]!;
  const [cfg] = await sql<{ region_id: string }[]>`select region_id from guild_configs where guild_id = ${guildId}`;
  const current = all.find((r) => r.id === cfg?.region_id);
  if (current) return current;
  throw new RegionError(`Which region? Add the region option. This server has: ${all.map((r) => r.name).join(", ")}.`);
}

export async function regionPlaces(sql: Sql, regionId: string): Promise<RegionPlace[]> {
  return [...await sql<RegionPlace[]>`
    select p.id::text as id, coalesce(region_label(p.member_region_id), p.label) as label
    from region_places p
    where p.region_id = ${regionId}
    order by (p.member_region_id is null), 2`];
}

// ---------- changing a server's regions ----------

/** Serializes changes to one server's regions, so two commands at once can't pass a limit together. */
const lockGuild = (tx: Sql, guildId: string) => tx`select pg_advisory_xact_lock(hashtext(${`field-report-regions:${guildId}`}))`;

export async function createRegion(sql: Sql, guildId: string, rawName: unknown): Promise<GuildRegion> {
  const name = cleanRegionName(rawName);
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await lockGuild(tx, guildId);
    const existing = await listGuildRegions(tx, guildId);
    if (existing.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new RegionError(`This server already has a region called ${name}.`);
    if (existing.length >= REGION_CONFIG.maxRegionsPerGuild) {
      throw new RegionError(`A server can have up to ${REGION_CONFIG.maxRegionsPerGuild} custom regions. Delete one with /region delete first.`);
    }
    // A custom region can't take a standard region's name or id, or the two couldn't be told apart in /region set.
    const [taken] = await tx<{ label: string }[]>`
      select region_label(id) as label from regions
      where owner_guild_id is null
        and (id = lower(${name}) or (selectable and (lower(display_name) = lower(${name}) or lower(region_label(id)) = lower(${name}))))
      limit 1`;
    if (taken) throw new RegionError(`${taken.label} is already a standard region. Pick a different name.`);
    const id = `g:${guildId}:${randomBytes(4).toString("hex")}`;
    await tx`
      insert into regions (id, display_name, type, source, selectable, owner_guild_id)
      values (${id}, ${name}, 'custom', 'guild', false, ${guildId})`;
    return { id, name, places: 0 };
  }) as Promise<GuildRegion>;
}

type Place =
  | { kind: "region"; regionId: string; label: string }
  | { kind: "country"; countryCode: string; label: string }
  | { kind: "city"; countryCode: string; admin1Code: string | null; cityKey: string; label: string };

/**
 * Turns what the admin picked (or typed) into a place, checked against the database: a member region must be a
 * selectable standard region other than Global, and a city must occur in the data.
 */
export async function resolvePlace(sql: Sql, now: number, value: unknown): Promise<Place> {
  const v = String(value ?? "").trim();
  const pick = new RegionError("Pick a place from the list that appears as you type. Cities are listed only when they have events in the data.");
  if (!v) throw pick;
  if (v.startsWith("r:")) {
    const [r] = await sql<{ id: string; label: string }[]>`
      select id, region_label(id) as label from regions
      where id = ${v.slice(2)} and selectable and owner_guild_id is null and type <> 'global'`;
    if (!r) throw pick;
    return { kind: "region", regionId: r.id, label: r.label };
  }
  if (v.startsWith("k:")) {
    const code = v.slice(2).toUpperCase();
    // If the country has gained a region since the list was built, use the region.
    const [r] = await sql<{ id: string; label: string }[]>`
      select id, region_label(id) as label from regions where id = ${code.toLowerCase()} and selectable and owner_guild_id is null and type = 'country'`;
    if (r) return { kind: "region", regionId: r.id, label: r.label };
    const country = (await regionlessCountries(sql)).find((c) => c.code === code);
    if (!country) throw pick;
    return { kind: "country", countryCode: country.code, label: country.name };
  }
  if (v.startsWith("c:")) {
    const [, cc = "", a1 = "", ...rest] = v.split(":");
    const key = rest.join(":");
    const admin1 = a1 === "" ? null : a1;
    const [c] = await sql<{ city_name: string; admin1_name: string | null; country_name: string | null }[]>`
      select
        mode() within group (order by btrim(regexp_replace(t.city, '\\s+', ' ', 'g'))) as city_name,
        max(t.geo_admin1_name) as admin1_name,
        coalesce((select r.display_name from regions r where r.id = lower(${cc}) and r.type = 'country'), max(t.geo_country_name)) as country_name
      from tournaments t
      where t.geo_country_code = ${cc}
        and t.geo_admin1_code is not distinct from ${admin1}
        and city_key(t.city) = ${key}
        and t.participant_count >= 16
        and t.event_class in ('cedh', 'unlabeled_competitive')
      having count(*) > 0`;
    if (!c) throw pick;
    return { kind: "city", countryCode: cc, admin1Code: admin1, cityKey: key, label: cityPlain(c.city_name, c.admin1_name, c.country_name) };
  }
  // Typed without picking: accept only an exact name from the list.
  const typed = fold(v);
  const exact = (await placeOptions(sql, now)).filter((o) => fold(o.plain) === typed || fold(o.label) === typed);
  if (exact.length !== 1) throw pick;
  return resolvePlace(sql, now, exact[0]!.value);
}

export async function addPlace(sql: Sql, guildId: string, region: GuildRegion, place: Place): Promise<void> {
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await lockGuild(tx, guildId);
    // Re-read inside the lock: the region must still be this server's, and the count must be current.
    const [own] = await tx<{ places: number }[]>`
      select (select count(*) from region_places p where p.region_id = r.id)::int as places
      from regions r where r.id = ${region.id} and r.owner_guild_id = ${guildId}`;
    if (!own) throw new RegionError("That region no longer exists.");
    const admin1 = place.kind === "city" ? place.admin1Code : null;
    const cityKey = place.kind === "city" ? place.cityKey : null;
    const dup = place.kind === "region"
      ? await tx`select 1 from region_places where region_id = ${region.id} and member_region_id = ${place.regionId}`
      : await tx`
          select 1 from region_places
          where region_id = ${region.id} and member_region_id is null and country_code = ${place.countryCode}
            and admin1_code is not distinct from ${admin1} and city_key is not distinct from ${cityKey}`;
    if (dup.length > 0) throw new RegionError(`${place.label} is already in ${region.name}.`);
    if (own.places >= REGION_CONFIG.maxPlacesPerRegion) {
      throw new RegionError(`A region can have up to ${REGION_CONFIG.maxPlacesPerRegion} places. Remove one with /region remove first.`);
    }
    if (place.kind === "region") {
      await tx`insert into region_places (region_id, member_region_id) values (${region.id}, ${place.regionId})`;
    } else {
      await tx`
        insert into region_places (region_id, country_code, admin1_code, city_key, label)
        values (${region.id}, ${place.countryCode}, ${admin1}, ${cityKey}, ${place.label})`;
    }
  });
}

/** Removes a place by the id an autocomplete choice carries ("p:<id>") or by its exact label. */
export async function removePlace(sql: Sql, guildId: string, region: GuildRegion, value: unknown): Promise<string> {
  const v = String(value ?? "").trim();
  const places = await regionPlaces(sql, region.id);
  const place = v.startsWith("p:") ? places.find((p) => p.id === v.slice(2)) : places.find((p) => fold(p.label) === fold(v));
  if (!place) throw new RegionError(`That place isn't in ${region.name}. Pick one from the list that appears as you type.`);
  await sql`
    delete from region_places p using regions r
    where p.id = ${place.id}::bigint and p.region_id = r.id and r.id = ${region.id} and r.owner_guild_id = ${guildId}`;
  return place.label;
}

/** Deletes a custom region. If it was the server's region, the server goes back to Global (returned as true). */
export async function deleteRegion(sql: Sql, guildId: string, region: GuildRegion): Promise<boolean> {
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await lockGuild(tx, guildId);
    const reset = await tx`
      update guild_configs set region_id = 'global', updated_at = now()
      where guild_id = ${guildId} and region_id = ${region.id}`;
    await tx`delete from regions where id = ${region.id} and owner_guild_id = ${guildId}`;
    return reset.count > 0;
  }) as Promise<boolean>;
}

/** Removes everything the given servers own: their config first (it references regions), then their regions. */
export async function deleteGuildData(sql: Sql, guildIds: string[]): Promise<void> {
  if (guildIds.length === 0) return;
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await tx`delete from guild_configs where guild_id = any(${tx.array(guildIds, 1009)}::text[])`;
    await tx`delete from regions where owner_guild_id = any(${tx.array(guildIds, 1009)}::text[])`;
  });
}

// ---------- where a custom region's commander stats come from ----------

/**
 * One line for /region set and /region show: a reportable custom region uses its own entries; otherwise the
 * statistical commander sections come from the standard region around it (see customStatsRegion).
 */
export async function statsSourceLine(sql: Sql, region: GuildRegion, month: string): Promise<string> {
  const end = `${month}-01`;
  const [rep] = await sql<{ reportable: boolean }[]>`select reportable from region_reportability(${region.id}, ${end}::date)`;
  if (rep?.reportable) return `Commander stats: ${region.name}'s own entries.`;
  const from = await customStatsRegion(sql, region.id, end);
  return from.reportable
    ? `Commander stats (most played, best results, conversion): ${from.label}, because ${region.name} has too few entries with decklists. Events, winners and players are ${region.name}'s own.`
    : "Commander stats: not enough decklists yet.";
}
