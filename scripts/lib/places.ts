// Natural Earth populated places -> populated_places: the city centers a radius place can use when the city
// has no events of its own (Seattle). Parsing and storing are separate from the file so tests can run them on
// a small fixture with a fake lookup.
import type { Sql } from "./db";
import type { GeoLookup, GeoSource } from "./geo";

/** The pinned release the file comes from. Stored on every row. */
export const PLACES_VERSION = "natural-earth-vector v5.1.2 ne_10m_populated_places_simple";

export type PlaceRow = {
  ne_id: number;
  name: string;
  name_ascii: string | null;
  country_code: string | null;
  country_name: string | null;
  admin1_code: string | null;
  admin1_name: string | null;
  lat: number;
  lng: number;
  pop_max: number | null;
  source_version: string;
};
export type ParsedPlaces = { rows: PlaceRow[]; skipped: number; geocoded: Record<GeoSource, number> };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whitelists the fields we keep from the GeoJSON (id, names, point, population) and geocodes each point with
 * the admin-1 boundaries, so country and admin-1 codes are the same ones events carry. Natural Earth's own
 * iso_a2 is not used: 12 places have a placeholder there. Features without an id, a name or a valid point are
 * skipped; a point that matches no polygon keeps its Natural Earth names with null codes.
 */
export function parsePlaces(raw: string, lookup: GeoLookup): ParsedPlaces {
  const doc: unknown = JSON.parse(raw);
  const features = isObj(doc) && Array.isArray(doc.features) ? doc.features : null;
  if (!features) throw new Error("populated places: expected a GeoJSON FeatureCollection");
  const byId = new Map<number, PlaceRow>();
  const geocoded: Record<GeoSource, number> = { exact: 0, nearby: 0, unmatched: 0 };
  let skipped = 0;
  for (const f of features) {
    const p = isObj(f) && isObj(f.properties) ? f.properties : null;
    const g = isObj(f) && isObj(f.geometry) ? f.geometry : null;
    const c = g && g.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates : null;
    const [lng, lat] = [Number(c?.[0]), Number(c?.[1])];
    const id = Number(p?.ne_id);
    const name = str(p?.name);
    if (!p || !name || !Number.isSafeInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      skipped++;
      continue;
    }
    const { geo, source } = lookup(lng, lat);
    geocoded[source]++;
    const pop = Number(p.pop_max);
    byId.set(id, {
      ne_id: id,
      name,
      name_ascii: str(p.nameascii),
      country_code: geo?.countryCode ?? null,
      country_name: geo?.countryName ?? str(p.adm0name),
      admin1_code: geo?.admin1Code ?? null,
      admin1_name: geo?.admin1Name ?? str(p.adm1name),
      lat,
      lng,
      pop_max: Number.isFinite(pop) && pop > 0 ? Math.round(pop) : null,
      source_version: PLACES_VERSION,
    });
  }
  return { rows: [...byId.values()], skipped, geocoded };
}

/** Below this many places the file is treated as wrong and nothing is written (the real file has 7,342). */
export const MIN_PLACES = 1000;

/**
 * Replaces populated_places with the given rows in one transaction: upserts every row and deletes the ones no
 * longer in the file. Running it again changes nothing. `minRows` guards against emptying the table from a
 * truncated file.
 */
export async function storePlaces(sql: Sql, rows: PlaceRow[], minRows: number = MIN_PLACES): Promise<{ stored: number; removed: number }> {
  if (rows.length < minRows) throw new Error(`populated places: only ${rows.length} rows (expected at least ${minRows}); nothing written`);
  const removed = await sql.begin(async (tx) => {
    for (let i = 0; i < rows.length; i += 1000) {
      await tx`
        insert into populated_places ${tx(rows.slice(i, i + 1000))}
        on conflict (ne_id) do update set
          name = excluded.name, name_ascii = excluded.name_ascii,
          country_code = excluded.country_code, country_name = excluded.country_name,
          admin1_code = excluded.admin1_code, admin1_name = excluded.admin1_name,
          lat = excluded.lat, lng = excluded.lng, pop_max = excluded.pop_max,
          source_version = excluded.source_version, loaded_at = now()`;
    }
    const gone = await tx`delete from populated_places where ne_id <> all(${tx.array(rows.map((r) => r.ne_id), 20)}::bigint[])`;
    return gone.count;
  });
  return { stored: rows.length, removed: removed as number };
}
