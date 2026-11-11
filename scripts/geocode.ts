// Reverse-geocodes tournaments from lat/lng against Natural Earth 1:10m admin-1 boundaries (public domain,
// tag v5.1.2), stored locally in gitignored data/. Writes country, admin-1, and admin-1 group on tournaments.
// Processes only rows with lat/lng whose geo_checked_at is null; backfill clears it when lat/lng change.
// The boundary file is never downloaded by this script. The lookup itself is in scripts/lib/geo.ts.
// Usage: geocode [--file path/to/ne_10m_admin_1_states_provinces.geojson]
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { ADMIN1_FILE, loadAdmin1Lookup, NO_GEO } from "./lib/geo";
import { log } from "./lib/topdeck";

const UPDATE_CHUNK = 1000;

async function main() {
  const { values } = parseArgs({ options: { file: { type: "string", default: ADMIN1_FILE } } });
  const { lookup, polygons } = await loadAdmin1Lookup(values.file!);
  log(`indexed ${polygons} admin-1 polygons`);

  const sql = connect();
  try {
    const todo = await sql<{ tid: string; lat: number; lng: number }[]>`
      select tid, lat, lng from tournaments
      where geo_checked_at is null and lat is not null and lng is not null`;
    const counts = { exact: 0, nearby: 0, unmatched: 0 };
    const rows = todo.map((t) => {
      const { geo, source } = lookup(t.lng, t.lat);
      counts[source]++;
      return { tid: t.tid, source, ...(geo ?? NO_GEO) };
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
          ${sql.array(col("tid"), 1009)}::text[], ${sql.array(col("countryCode"), 1009)}::text[], ${sql.array(col("countryName"), 1009)}::text[],
          ${sql.array(col("admin1Code"), 1009)}::text[], ${sql.array(col("admin1Name"), 1009)}::text[],
          ${sql.array(col("groupCode"), 1009)}::text[], ${sql.array(col("groupName"), 1009)}::text[], ${sql.array(col("source"), 1009)}::text[]
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
