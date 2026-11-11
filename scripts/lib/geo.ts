// Offline reverse geocoding against Natural Earth 1:10m admin-1 boundaries (public domain, tag v5.1.2),
// stored locally in gitignored data/. Shared by scripts/geocode.ts (tournaments) and
// scripts/load-populated-places.ts (city centers), so both get the same country and admin-1 codes.
// The boundary file is never downloaded by code (CLAUDE.md data-source rule).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import whichPolygon from "which-polygon";

export const ADMIN1_FILE = fileURLToPath(new URL("../../data/ne_10m_admin_1_states_provinces.geojson", import.meta.url));
const ADMIN1_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson";
const ADMIN1_SHA256 = "22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5";
/** Nearby search for points just outside a polygon (e.g. waterfront venues at 1:10m): rings of 8 points. */
const NEARBY_RINGS_DEG = [0.02, 0.05];

type NeProps = Record<string, unknown>;
export type Geo = {
  countryCode: string | null;
  countryName: string | null;
  admin1Code: string | null;
  admin1Name: string | null;
  groupCode: string | null;
  groupName: string | null;
};
export type GeoSource = "exact" | "nearby" | "unmatched";
export type GeoLookup = (lng: number, lat: number) => { geo: Geo | null; source: GeoSource };
export const NO_GEO: Geo = { countryCode: null, countryName: null, admin1Code: null, admin1Name: null, groupCode: null, groupName: null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const slug = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** ISO alpha-2 from iso_a2; for Natural Earth's -1/-99 placeholders, falls back to the ISO 3166-2 prefix. */
function countryCode(p: NeProps): string | null {
  const a2 = str(p.iso_a2);
  if (a2 && /^[A-Z]{2}$/.test(a2)) return a2;
  const m = /^([A-Z]{2})-/.exec(str(p.iso_3166_2) ?? "");
  return m ? m[1]! : null;
}

type GroupSource = "region" | "geonunit" | null;

/**
 * Picks one grouping field per country so a country is never split two ways:
 * region when >= 90% of its features carry a region_cod (Spain, Italy, France); else geonunit when the
 * country has 2+ geonunits (UK nations, Belgian regions); else region when >= 90% carry one (US census
 * regions); else no group (Germany).
 */
function groupSources(features: NeProps[]): Map<string, GroupSource> {
  const byCountry = new Map<string, NeProps[]>();
  for (const p of features) {
    const key = str(p.admin) ?? "";
    byCountry.set(key, [...(byCountry.get(key) ?? []), p]);
  }
  const out = new Map<string, GroupSource>();
  for (const [admin, ps] of byCountry) {
    const share = (f: (p: NeProps) => boolean) => ps.filter(f).length / ps.length;
    const geonunits = new Set(ps.map((p) => str(p.geonunit)).filter((g) => g !== null));
    let source: GroupSource = null;
    if (share((p) => str(p.region_cod) !== null && str(p.region) !== null) >= 0.9) source = "region";
    else if (geonunits.size >= 2) source = "geonunit";
    else if (share((p) => str(p.region) !== null) >= 0.9) source = "region";
    out.set(admin, source);
  }
  return out;
}

function toGeo(p: NeProps, sources: Map<string, GroupSource>): Geo {
  const cc = countryCode(p);
  const iso2 = str(p.iso_3166_2);
  const source = sources.get(str(p.admin) ?? "") ?? null;
  const groupName = source ? str(p[source]) : null;
  return {
    countryCode: cc,
    countryName: str(p.admin),
    admin1Code: iso2 && /^[A-Z]{2}-/.test(iso2) ? iso2 : null,
    admin1Name: str(p.name),
    groupCode: cc && groupName ? `${cc}-${slug(groupName)}` : null,
    groupName,
  };
}

/** Reads a pinned data file and refuses it unless its SHA-256 is the expected one. */
export async function readPinnedFile(file: string, sha256: string, what: string, url: string): Promise<Buffer> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    throw new Error(`${what} not found at ${file}; download it once with:\n  curl -o ${file} ${url}`);
  }
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== sha256) throw new Error(`${what} SHA-256 mismatch: got ${sha}, expected ${sha256}`);
  return raw;
}

/**
 * Loads the admin-1 boundaries (checking the file's SHA-256) and returns a point lookup: the polygon that
 * contains the point, or one found on a small ring around it, or nothing.
 */
export async function loadAdmin1Lookup(file: string = ADMIN1_FILE): Promise<{ lookup: GeoLookup; polygons: number }> {
  const raw = await readPinnedFile(file, ADMIN1_SHA256, "boundary file", ADMIN1_URL);
  const collection = JSON.parse(raw.toString("utf8")) as { features: { properties: NeProps; geometry: unknown }[] };
  const sources = groupSources(collection.features.map((f) => f.properties));
  const indexed = {
    type: "FeatureCollection" as const,
    features: collection.features.map((f) => ({ type: "Feature" as const, geometry: f.geometry, properties: toGeo(f.properties, sources) })),
  };
  const query = whichPolygon<Geo>(indexed as unknown as whichPolygon.GeoJson<Geo>);
  const lookup: GeoLookup = (lng, lat) => {
    const exact = query([lng, lat]);
    if (exact) return { geo: exact, source: "exact" };
    for (const r of NEARBY_RINGS_DEG) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const hit = query([lng + r * Math.cos(a), lat + r * Math.sin(a)]);
        if (hit) return { geo: hit, source: "nearby" };
      }
    }
    return { geo: null, source: "unmatched" };
  };
  return { lookup, polygons: indexed.features.length };
}
