// Loads Natural Earth's populated places (1:10m, public domain, tag v5.1.2) into populated_places: the city
// centers a custom region's radius can use when the city has no events of its own (Seattle has none).
// The file is downloaded once, by hand, into gitignored data/ and verified by SHA-256 here; this script never
// downloads it, and the bot and the Vercel app never read the file: they read the table (CLAUDE.md
// data-source exception). Each point is geocoded with the admin-1 boundaries already in data/, so both files
// must be present. Idempotent: the table is replaced as a whole.
// Usage: places [--file path/to/ne_10m_populated_places_simple.geojson]
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { loadAdmin1Lookup, readPinnedFile } from "./lib/geo";
import { parsePlaces, storePlaces } from "./lib/places";
import { log } from "./lib/topdeck";

const DEFAULT_FILE = fileURLToPath(new URL("../data/ne_10m_populated_places_simple.geojson", import.meta.url));
const SOURCE_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_populated_places_simple.geojson";
const EXPECTED_SHA256 = "fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f";

async function main() {
  const { values } = parseArgs({ options: { file: { type: "string", default: DEFAULT_FILE } } });
  const raw = await readPinnedFile(values.file!, EXPECTED_SHA256, "populated places file", SOURCE_URL);
  const { lookup, polygons } = await loadAdmin1Lookup();
  log(`indexed ${polygons} admin-1 polygons`);
  const parsed = parsePlaces(raw.toString("utf8"), lookup);

  const sql = connect();
  try {
    const r = await storePlaces(sql, parsed.rows);
    const g = parsed.geocoded;
    console.log(
      `Populated places: ${r.stored} stored, ${r.removed} removed, ${parsed.skipped} skipped; ` +
        `geocoded ${g.exact} exact, ${g.nearby} nearby, ${g.unmatched} without a country.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("places", err));
