// Custom regions: a server admin builds a region out of places and uses it as the server's region.
// A custom region is a row in `regions` with owner_guild_id set; its places are rows in region_places
// (migration 015). Every query here is filtered by the calling server's id: a server never sees, changes or
// uses another server's region. Replies from these functions show no TopDeck data (names of places only).
// Places are added and removed in bulk (several picked options and a typed list in one command), and a place
// can be a radius around a city center (migration 016). Name matching is in ./place-matching.
import { randomBytes } from "node:crypto";
import type { Sql } from "../../scripts/lib/db";
import { CUSTOM_REGION_NAME_MAX, sanitizeOrganizerText } from "../../scripts/lib/post";
import {
  asResolved, emptyAddOutcome, matchName, norm, parseRadius, resolveList,
  type AddOutcome, type Candidate, type Lookup, type RemoveOutcome,
} from "./place-matching";

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
  /** A radius place: "within N km of a center". One radius is one place. Bounds and the value used when km is
   *  left out. Observed November 2026 around Seattle: 40 km just misses Tacoma, 50 km is reportable on its own,
   *  100 km stays inside Washington, 200 km reaches Vancouver, British Columbia. */
  radiusMinKm: 10,
  radiusMaxKm: 200,
  radiusDefaultKm: 50,
  /** Option names on /region add and /region remove that each take one picked place. */
  placeOptionNames: ["place", "place2", "place3", "place4", "place5"],
  /** Items read from one typed list; the rest are reported, not processed. */
  listItemsMax: 60,
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

export type PlaceOption = Candidate & { plain: string; search: string; rank: number; events: number };
type PlaceCache = { at: number; rows: PlaceOption[] };
let placeCache: PlaceCache | null = null;
let centerCache: { at: number; rows: CenterOption[] } | null = null;
export const resetPlaceCache = () => { placeCache = null; centerCache = null; };

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
/** Other ways people write a country. */
const COUNTRY_ALIASES: Record<string, string[]> = {
  US: ["usa", "united states of america"],
  GB: ["uk", "great britain", "britain"],
};
const countryQuals = (code: string | null, name: string | null) =>
  [name, code, ...(code ? (COUNTRY_ALIASES[code] ?? []) : [])].filter((x): x is string => !!x).map(norm);
/** What may follow a city's name: its state by name or code ("Washington", "WA", "US-WA") and its country. */
const cityQuals = (cc: string | null, a1Code: string | null, a1Name: string | null, countryName: string | null) =>
  [...[a1Name, a1Code, a1Code?.split("-")[1]].filter((x): x is string => !!x).map(norm), ...countryQuals(cc, countryName)];

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
 * qualifying event in the last cityMonths months, labelled with state, country and event count. Each option
 * also carries the names and qualifiers a typed list is matched on. Cached per instance.
 */
export async function placeOptions(sql: Sql, now: number): Promise<PlaceOption[]> {
  if (placeCache && now - placeCache.at < REGION_CONFIG.placeCacheMs) return placeCache.rows;
  const regions = await sql<{ id: string; name: string; label: string; type: string; country_code: string | null; country_name: string | null }[]>`
    select r.id, r.display_name as name, region_label(r.id) as label, r.type,
           case when r.type in ('admin1', 'admin1_group') then upper(split_part(r.id, '-', 1)) end as country_code,
           c.display_name as country_name
    from regions r
    left join regions c on r.type in ('admin1', 'admin1_group') and c.type = 'country' and c.id = split_part(r.id, '-', 1)
    where r.selectable and r.owner_guild_id is null and r.type <> 'global'`;
  const cities = await sql<{ country_code: string; country_name: string | null; admin1_code: string | null; admin1_name: string | null; city_key: string; city_name: string; events: string }[]>`
    select * from region_city_options(${since(now)})`;
  const countries = await regionlessCountries(sql);
  const rows: PlaceOption[] = [
    ...regions.map((r) => {
      const code = r.id.toUpperCase();
      // A state answers to its code too ("WA" for us-wa), a country to its code and aliases ("US", "USA").
      const names = r.type === "country" ? countryQuals(code, r.name) : r.type === "admin1" || r.type === "admin1_group" ? [norm(r.name), norm(r.id.split("-").slice(1).join("-"))] : [norm(r.name)];
      return {
        value: `r:${r.id}`, label: r.label, plain: r.label, search: fold(`${r.label} ${r.id}`), rank: PLACE_RANK[r.type] ?? 9, events: 0,
        names: [...new Set(names)], quals: countryQuals(r.country_code, r.country_name),
      };
    }),
    ...countries.map((c) => ({
      value: `k:${c.code}`, label: c.name, plain: c.name, search: fold(`${c.name} ${c.code}`), rank: PLACE_RANK.country!, events: 0,
      names: countryQuals(c.code, c.name), quals: [],
    })),
    ...cities.map((c) => {
      const plain = cityPlain(c.city_name, c.admin1_name, c.country_name);
      return {
        value: cityValue(c.country_code, c.admin1_code, c.city_key),
        label: `${plain} (${plural(Number(c.events), "event", "events")})`,
        plain,
        search: fold(plain),
        rank: CITY_RANK,
        events: Number(c.events),
        names: [norm(c.city_name)],
        quals: cityQuals(c.country_code, c.admin1_code, c.admin1_name, c.country_name),
      };
    }),
  ].filter((o) => o.value.length <= REGION_CONFIG.choiceTextMax)
    .map((o) => ({ ...o, label: o.label.slice(0, REGION_CONFIG.choiceTextMax) }));
  placeCache = { at: now, rows };
  return rows;
}

// ---------- centers a radius can be drawn around (autocomplete) ----------

export type CenterOption = Candidate & { plain: string; search: string; population: number; events: number };

/**
 * Every Natural Earth populated place (table populated_places, loaded by `npm run places`) and every city with
 * events in our data, as one list (region_center_options). Labels carry the state and country, and the metro
 * population or the number of events where known, so same-named cities can be told apart. If the table has
 * not been loaded, only cities with events are offered. Cached per instance.
 */
export async function centerOptions(sql: Sql, now: number): Promise<CenterOption[]> {
  if (centerCache && now - centerCache.at < REGION_CONFIG.placeCacheMs) return centerCache.rows;
  const rows = await sql<{ id: string; name: string; admin1_name: string | null; country_name: string | null; country_code: string; admin1_code: string | null; population: string | null; events: string }[]>`
    select id, name, admin1_name, country_name, country_code, admin1_code, population, events from region_center_options()`;
  const options = rows.map((r) => {
    const plain = cityPlain(r.name, r.admin1_name, r.country_name);
    const population = Number(r.population ?? 0), events = Number(r.events);
    const facts = [population > 0 ? `metro pop. ${population.toLocaleString("en-US")}` : "", events > 0 ? plural(events, "event", "events") : ""].filter(Boolean).join(", ");
    return {
      value: r.id, label: (facts ? `${plain} (${facts})` : plain).slice(0, REGION_CONFIG.choiceTextMax), plain, search: fold(plain), population, events,
      names: [norm(r.name)], quals: cityQuals(r.country_code, r.admin1_code, r.admin1_name, r.country_name),
    };
  }).filter((o) => o.value.length <= REGION_CONFIG.choiceTextMax);
  centerCache = { at: now, rows: options };
  return options;
}

/** Prefix matches first, then cities with events, then the larger city. At most 25. */
export function matchCenters(rows: CenterOption[], query: string, limit: number = REGION_CONFIG.choiceMax): { name: string; value: string }[] {
  const q = fold(query.trim());
  return rows
    .map((r) => ({ r, starts: q === "" || r.search.startsWith(q), hit: q === "" || r.search.includes(q) }))
    .filter((x) => x.hit)
    .sort((a, b) => Number(b.starts) - Number(a.starts) || b.r.events - a.r.events || b.r.population - a.r.population || a.r.label.localeCompare(b.r.label))
    .slice(0, limit)
    .map((x) => ({ name: x.r.label, value: x.r.value }));
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
export type RegionPlace = { id: string; label: string; memberRegionId: string | null; countryCode: string | null; admin1Code: string | null };

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
    select p.id::text as id, coalesce(region_label(p.member_region_id), p.label) as label,
           p.member_region_id as "memberRegionId", p.country_code as "countryCode", p.admin1_code as "admin1Code"
    from region_places p
    where p.region_id = ${regionId}
    order by (p.member_region_id is null), (p.radius_km is not null), 2`];
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

export type Place =
  | { kind: "region"; regionId: string; label: string }
  | { kind: "country"; countryCode: string; label: string }
  | { kind: "city"; countryCode: string; admin1Code: string | null; cityKey: string; label: string }
  | { kind: "radius"; lat: number; lng: number; km: number; countryCode: string; admin1Code: string | null; label: string };

/**
 * Turns the value of a place choice ("r:<region id>", "k:<country code>", "c:<country>:<admin-1>:<city key>")
 * into a place, checked against the database: a member region must be a selectable standard region other than
 * Global, and a city must occur in the data. Typed names are matched to such a value first (resolveAddRequest).
 */
export async function resolvePlace(sql: Sql, value: unknown): Promise<Place> {
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
  throw pick;
}

type Center = { lat: number; lng: number; countryCode: string; admin1Code: string | null; plain: string };

/** A center by the id an autocomplete choice carries, read fresh from the database; null when it doesn't exist. */
async function resolveCenter(sql: Sql, value: string): Promise<Center | null> {
  if (value.startsWith("n:") && /^\d+$/.test(value.slice(2))) {
    const [p] = await sql<{ name: string; admin1_name: string | null; admin1_code: string | null; country_code: string; country_name: string | null; lat: number; lng: number }[]>`
      select p.name, p.admin1_name, p.admin1_code, p.country_code, p.lat, p.lng,
             coalesce((select r.display_name from regions r where r.id = lower(p.country_code) and r.type = 'country'), p.country_name) as country_name
      from populated_places p where p.ne_id = ${value.slice(2)}::bigint and p.country_code is not null`;
    return p ? { lat: p.lat, lng: p.lng, countryCode: p.country_code, admin1Code: p.admin1_code, plain: cityPlain(p.name, p.admin1_name, p.country_name) } : null;
  }
  if (value.startsWith("e:")) {
    const [, cc = "", a1 = "", ...rest] = value.split(":");
    const admin1 = a1 === "" ? null : a1;
    const [c] = await sql<{ city_name: string; admin1_name: string | null; country_name: string | null; lat: number; lng: number }[]>`
      select
        mode() within group (order by btrim(regexp_replace(t.city, '\\s+', ' ', 'g'))) as city_name,
        max(t.geo_admin1_name) as admin1_name,
        coalesce((select r.display_name from regions r where r.id = lower(${cc}) and r.type = 'country'), max(t.geo_country_name)) as country_name,
        avg(t.lat) as lat, avg(t.lng) as lng
      from tournaments t
      where t.geo_country_code = ${cc}
        and t.geo_admin1_code is not distinct from ${admin1}
        and city_key(t.city) = ${rest.join(":")}
        and t.lat is not null and t.lng is not null
        and t.participant_count >= 16
        and t.event_class in ('cedh', 'unlabeled_competitive')
      having count(*) > 0`;
    return c ? { lat: c.lat, lng: c.lng, countryCode: cc, admin1Code: admin1, plain: cityPlain(c.city_name, c.admin1_name, c.country_name) } : null;
  }
  return null;
}

const radiusPlace = (c: Center, km: number): Place =>
  ({ kind: "radius", lat: c.lat, lng: c.lng, km, countryCode: c.countryCode, admin1Code: c.admin1Code, label: `within ${km} km of ${c.plain}` });

/** The reason a distance can't be used, or null when it is a whole number inside the allowed range. */
export function radiusProblem(km: number): string | null {
  return Number.isInteger(km) && km >= REGION_CONFIG.radiusMinKm && km <= REGION_CONFIG.radiusMaxKm
    ? null
    : `a radius must be ${REGION_CONFIG.radiusMinKm} to ${REGION_CONFIG.radiusMaxKm} km`;
}

/** What a typed item refers to, before it is read from the database. */
type Ref = { kind: "place"; value: string } | { kind: "radius"; center: string; km: number };
export type AddRequest = { picks: unknown[]; list?: unknown; around?: unknown; km?: unknown };

/**
 * Turns one /region add command into places, without touching the region: every picked option, every item of
 * the typed list, and the radius. Nothing is guessed: an item with several candidates, an item that could be
 * one place or several, an unknown name and a radius outside the range are each reported in the outcome.
 */
export async function resolveAddRequest(sql: Sql, now: number, req: AddRequest): Promise<{ places: Place[]; outcome: AddOutcome }> {
  const outcome = emptyAddOutcome();
  const places: Place[] = [];
  const options = await placeOptions(sql, now);
  const centers = await centerOptions(sql, now);
  const codes = new Set([...options, ...centers].flatMap((o) => o.quals).filter((q) => /^[a-z]{2,3}$/.test(q)));

  const lookup = (item: string): Lookup<Ref> => {
    const radius = parseRadius(item);
    if (radius) {
      const m = matchName(centers, radius.center);
      if (m.kind === "none") return { kind: "none" };
      if (m.kind === "many") return { kind: "many", options: m.options.map((c) => c.label) };
      const problem = radiusProblem(radius.km);
      if (problem) return { kind: "invalid", reason: problem };
      return { kind: "one", value: { kind: "radius", center: m.candidate.value, km: radius.km }, label: `within ${radius.km} km of ${(m.candidate as CenterOption).plain}` };
    }
    const m = matchName(options, item);
    if (m.kind === "one") return { kind: "one", value: { kind: "place", value: m.candidate.value }, label: (m.candidate as PlaceOption).plain };
    if (m.kind === "many") return { kind: "many", options: m.options.map((c) => (c as PlaceOption).plain) };
    return { kind: "none" };
  };
  const NO_CENTER = "no city by that name to put a radius around; start typing in the around option to see which exist";
  /** A radius whose center we don't know; or a name we know as a city, but with no events to make it a place. */
  const hintFor = (input: string) =>
    parseRadius(input) ? NO_CENTER
    : matchName(centers, input).kind !== "none" ? "no events there in the last 12 months; for the area around it use the around option"
    : undefined;

  const refs: { input: string; ref: Ref }[] = [];
  const take = (resolved: ReturnType<typeof resolveList<Ref>>) => {
    for (const r of resolved) {
      if (r.kind === "one") refs.push({ input: r.input, ref: r.value });
      else if (r.kind === "many") outcome.ambiguous.push({ input: r.input, options: r.options });
      else if (r.kind === "split") outcome.split.push({ input: r.input, options: r.options });
      else if (r.kind === "invalid") outcome.invalid.push({ input: r.input, reason: r.reason });
      else outcome.notFound.push({ input: r.input, hint: hintFor(r.input) });
    }
  };

  // Picked options carry an exact value. Text typed into one without picking is a single place, commas and all.
  for (const pick of req.picks) {
    const v = String(pick ?? "").trim();
    if (!v) continue;
    if (/^[rkc]:/.test(v)) refs.push({ input: v, ref: { kind: "place", value: v } });
    else take([asResolved(v, lookup(v))]);
  }
  const list = String(req.list ?? "").trim();
  if (list) {
    const exact = (text: string) => options.filter((o) => norm(o.label) === norm(text) || norm(o.plain) === norm(text)).length === 1;
    const resolved = resolveList(list, lookup, (token) => codes.has(norm(token)), exact);
    take(resolved.slice(0, REGION_CONFIG.listItemsMax));
    if (resolved.length > REGION_CONFIG.listItemsMax) {
      outcome.invalid.push({ input: `${resolved.length - REGION_CONFIG.listItemsMax} more items`, reason: `only the first ${REGION_CONFIG.listItemsMax} are read` });
    }
  }
  const around = String(req.around ?? "").trim();
  if (around) {
    const km = req.km === undefined || req.km === null || req.km === "" ? REGION_CONFIG.radiusDefaultKm : Number(req.km);
    // A picked center arrives as its id; show its name, never the id.
    const picked = /^[ne]:/.test(around);
    const shown = `${km} km of ${picked ? (centers.find((c) => c.value === around)?.plain ?? "the chosen city") : around}`;
    const problem = radiusProblem(km);
    if (problem) outcome.invalid.push({ input: shown, reason: problem });
    else if (picked) refs.push({ input: shown, ref: { kind: "radius", center: around, km } });
    else {
      const m = matchName(centers, around);
      if (m.kind === "one") refs.push({ input: shown, ref: { kind: "radius", center: m.candidate.value, km } });
      else if (m.kind === "many") outcome.ambiguous.push({ input: around, options: m.options.map((c) => c.label) });
      else outcome.notFound.push({ input: around, hint: NO_CENTER });
    }
  } else if (req.km !== undefined && req.km !== null && req.km !== "") {
    outcome.invalid.push({ input: `${String(req.km)} km`, reason: "choose a city in the around option to put the radius around" });
  }

  // Read each reference from the database; a value that doesn't exist there is "not found", whatever sent it.
  for (const { input, ref } of refs) {
    if (ref.kind === "radius") {
      const center = await resolveCenter(sql, ref.center);
      if (center) places.push(radiusPlace(center, ref.km));
      else outcome.notFound.push({ input });
    } else {
      try {
        places.push(await resolvePlace(sql, ref.value));
      } catch (err) {
        if (!(err instanceof RegionError)) throw err;
        outcome.notFound.push({ input, hint: hintFor(input) });
      }
    }
  }
  return { places, outcome };
}

const placeKey = (p: Place) =>
  p.kind === "region" ? `r:${p.regionId}`
  : p.kind === "radius" ? `x:${p.lat.toFixed(3)}:${p.lng.toFixed(3)}:${p.km}`
  : `c:${p.countryCode}:${p.kind === "city" ? `${p.admin1Code ?? ""}:${p.cityKey}` : ""}`;

/**
 * Adds places to a region in the order given, in one transaction under the server's lock. Each place ends up in
 * exactly one list: added, already present (in the region, or twice in the same command), or not added because
 * the region is full. Returns the region's number of places afterwards.
 */
export async function addPlaces(sql: Sql, guildId: string, region: GuildRegion, places: Place[], outcome: AddOutcome): Promise<number> {
  return sql.begin(async (t) => {
    const tx = t as unknown as Sql;
    await lockGuild(tx, guildId);
    // Re-read inside the lock: the region must still be this server's, and the count must be current.
    const [own] = await tx<{ places: number }[]>`
      select (select count(*) from region_places p where p.region_id = r.id)::int as places
      from regions r where r.id = ${region.id} and r.owner_guild_id = ${guildId}`;
    if (!own) throw new RegionError("That region no longer exists.");
    let total = own.places;
    const seen = new Set<string>();
    for (const place of places) {
      const key = placeKey(place);
      const admin1 = place.kind === "city" || place.kind === "radius" ? place.admin1Code : null;
      const cityKey = place.kind === "city" ? place.cityKey : null;
      const dup = seen.has(key) ? [1]
        : place.kind === "region" ? await tx`select 1 from region_places where region_id = ${region.id} and member_region_id = ${place.regionId}`
        : place.kind === "radius" ? await tx`
            select 1 from region_places
            where region_id = ${region.id} and radius_km = ${place.km}
              and round(center_lat::numeric, 3) = round(${place.lat}::numeric, 3) and round(center_lng::numeric, 3) = round(${place.lng}::numeric, 3)`
        : await tx`
            select 1 from region_places
            where region_id = ${region.id} and member_region_id is null and radius_km is null and country_code = ${place.countryCode}
              and admin1_code is not distinct from ${admin1} and city_key is not distinct from ${cityKey}`;
      seen.add(key);
      if (dup.length > 0) {
        if (!outcome.present.includes(place.label)) outcome.present.push(place.label);
        continue;
      }
      if (total >= REGION_CONFIG.maxPlacesPerRegion) {
        outcome.full.push(place.label);
        continue;
      }
      if (place.kind === "region") {
        await tx`insert into region_places (region_id, member_region_id) values (${region.id}, ${place.regionId})`;
      } else if (place.kind === "radius") {
        await tx`
          insert into region_places (region_id, country_code, admin1_code, label, center_lat, center_lng, radius_km)
          values (${region.id}, ${place.countryCode}, ${admin1}, ${place.label}, ${place.lat}, ${place.lng}, ${place.km})`;
      } else {
        await tx`
          insert into region_places (region_id, country_code, admin1_code, city_key, label)
          values (${region.id}, ${place.countryCode}, ${admin1}, ${cityKey}, ${place.label})`;
      }
      total++;
      outcome.added.push(place.label);
    }
    return total;
  }) as Promise<number>;
}

/** How a place already in a region can be named when removing it: its label, its name, and its qualifiers. */
function memberCandidate(p: RegionPlace): Candidate {
  const parts = p.label.replace(/\s*\(([^)]*)\)\s*$/, ", $1").split(",").map((x) => norm(x)).filter(Boolean);
  const name = parts[0] ?? "";
  // A state or group id is "<country>-<code>" ("us-wa"); continents, countries and seeded regions are not.
  const sub = p.memberRegionId && /^[a-z]{2}-/.test(p.memberRegionId) ? p.memberRegionId : null;
  const cc = p.countryCode ?? (sub ? sub.slice(0, 2).toUpperCase() : null);
  return {
    value: p.id,
    label: p.label,
    // "within 50 km of seattle" also answers to "50 km of seattle"; a state to its code ("wa").
    names: [...new Set([name, name.replace(/^within /, ""), sub ? norm(sub.slice(3)) : ""].filter(Boolean))],
    quals: [...parts.slice(1), ...cityQuals(cc, p.admin1Code, null, null)],
  };
}

/**
 * Removes places from a region: by the id an autocomplete choice carries ("p:<id>"), and by name with the same
 * tolerant matching as adding, against the places the region has. Reports what was removed, what matched more
 * than one place, and what isn't in the region. Returns the number of places left.
 */
export async function removePlaces(sql: Sql, guildId: string, region: GuildRegion, picks: unknown[], list: unknown): Promise<{ outcome: RemoveOutcome; left: number }> {
  const members = await regionPlaces(sql, region.id);
  const candidates = members.map(memberCandidate);
  const codes = new Set(candidates.flatMap((c) => c.quals).filter((q) => /^[a-z]{2,3}$/.test(q)));
  const outcome: RemoveOutcome = { removed: [], ambiguous: [], notFound: [] };
  const ids = new Set<string>();
  const lookup = (item: string): Lookup<string> => {
    const m = matchName(candidates, item);
    if (m.kind === "one") return { kind: "one", value: m.candidate.value, label: m.candidate.label };
    if (m.kind === "many") return { kind: "many", options: m.options.map((c) => c.label) };
    return { kind: "none" };
  };
  const take = (resolved: ReturnType<typeof resolveList<string>>) => {
    for (const r of resolved) {
      if (r.kind === "one") ids.add(r.value);
      else if (r.kind === "many" || r.kind === "split") outcome.ambiguous.push({ input: r.input, options: r.options });
      else outcome.notFound.push(r.input);
    }
  };
  for (const pick of picks) {
    const v = String(pick ?? "").trim();
    if (!v) continue;
    if (v.startsWith("p:")) {
      if (members.some((m) => m.id === v.slice(2))) ids.add(v.slice(2));
      else outcome.notFound.push(v);
    } else take([asResolved(v, lookup(v))]);
  }
  const text = String(list ?? "").trim();
  if (text) take(resolveList(text, lookup, (token) => codes.has(norm(token)), (t) => candidates.filter((c) => norm(c.label) === norm(t)).length === 1));

  const chosen = members.filter((m) => ids.has(m.id));
  if (chosen.length > 0) {
    await sql`
      delete from region_places p using regions r
      where p.id = any(${sql.array(chosen.map((m) => m.id), 1009)}::text[]::bigint[])
        and p.region_id = r.id and r.id = ${region.id} and r.owner_guild_id = ${guildId}`;
  }
  outcome.removed = chosen.map((m) => m.label);
  return { outcome, left: members.length - chosen.length };
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
