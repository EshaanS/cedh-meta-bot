// Reverse-geocodes tournaments from lat/lng against Natural Earth 1:10m admin-1 boundaries (public domain,
// tag v5.1.2), stored locally in gitignored data/. Writes country, admin-1, and admin-1 group on tournaments.
// Processes only rows with lat/lng whose geo_checked_at is null; backfill clears it when lat/lng change.
// The boundary file is never downloaded by this script.
// Usage: geocode [--file path/to/ne_10m_admin_1_states_provinces.geojson]
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import whichPolygon from "which-polygon";
import { connect } from "./lib/db.js";
import { exitWithError } from "./lib/errors.js";
import { log } from "./lib/topdeck.js";

const DEFAULT_FILE = fileURLToPath(new URL("../data/ne_10m_admin_1_states_provinces.geojson", import.meta.url));
const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_1_states_provinces.geojson";
const EXPECTED_SHA256 = "22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5";
/** Nearby search for points just outside a polygon (e.g. waterfront venues at 1:10m): rings of 8 points. */
const NEARBY_RINGS_DEG = [0.02, 0.05];
const UPDATE_CHUNK = 1000;

type NeProps = Record<string, unknown>;
type Geo = {
  countryCode: string | null;
  countryName: string | null;
  admin1Code: string | null;
  admin1Name: string | null;
  groupCode: string | null;
  groupName: string | null;
};

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

async function main() {
  const { values } = parseArgs({ options: { file: { type: "string", default: DEFAULT_FILE } } });
  const file = values.file!;

  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch {
    throw new Error(`boundary file not found at ${file}; download it once with:\n  curl -o ${file} ${SOURCE_URL}`);
  }
  const sha = createHash("sha256").update(raw).digest("hex");
  if (sha !== EXPECTED_SHA256) throw new Error(`boundary file SHA-256 mismatch: got ${sha}, expected ${EXPECTED_SHA256}`);

  const collection = JSON.parse(raw.toString("utf8")) as { features: { properties: NeProps; geometry: unknown }[] };
  const sources = groupSources(collection.features.map((f) => f.properties));
  const indexed = {
    type: "FeatureCollection" as const,
    features: collection.features.map((f) => ({ type: "Feature" as const, geometry: f.geometry, properties: toGeo(f.properties, sources) })),
  };
  const query = whichPolygon<Geo>(indexed as unknown as whichPolygon.GeoJson<Geo>);
  log(`indexed ${indexed.features.length} admin-1 polygons`);

  const lookup = (lng: number, lat: number): { geo: Geo | null; source: "exact" | "nearby" | "unmatched" } => {
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

  const sql = connect();
  try {
    const todo = await sql<{ tid: string; lat: number; lng: number }[]>`
      select tid, lat, lng from tournaments
      where geo_checked_at is null and lat is not null and lng is not null`;
    const counts = { exact: 0, nearby: 0, unmatched: 0 };
    const rows = todo.map((t) => {
      const { geo, source } = lookup(t.lng, t.lat);
      counts[source]++;
      return { tid: t.tid, source, ...(geo ?? { countryCode: null, countryName: null, admin1Code: null, admin1Name: null, groupCode: null, groupName: null }) };
    });

    for (let i = 0; i < rows.length; i += UPDATE_CHUNK) {
      const c = rows.slice(i, i + UPDATE_CHUNK);
      const col = <K extends keyof (typeof c)[number]>(k: K) => c.map((r) => r[k] as string | null);
      await sql`
        update tournaments t set
          geo_country_code = u.cc,
          geo_country_name = u.cn,
          geo_admin1_code = u.a1,
          geo_admin1_name = u.a1n,
          geo_admin1_group_code = u.g,
          geo_admin1_group_name = u.gn,
          geo_source = u.src,
          geo_checked_at = now()
        from unnest(
          ${sql.array(col("tid"))}::text[], ${sql.array(col("countryCode"))}::text[], ${sql.array(col("countryName"))}::text[],
          ${sql.array(col("admin1Code"))}::text[], ${sql.array(col("admin1Name"))}::text[],
          ${sql.array(col("groupCode"))}::text[], ${sql.array(col("groupName"))}::text[], ${sql.array(col("source"))}::text[]
        ) as u(tid, cc, cn, a1, a1n, g, gn, src)
        where t.tid = u.tid`;
    }
    console.log(
      `Geocoded ${rows.length} tournament(s): ${counts.exact} exact, ${counts.nearby} nearby, ${counts.unmatched} unmatched.` +
        (rows.length === 0 ? " Nothing to do." : ""),
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("geocode", err));
