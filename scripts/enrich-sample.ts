// Samples tournaments that have no bulk country and checks whether /info supplies one.
// Read-only: prints the yield to stdout and writes nothing to the database.
// Usage: enrich-sample [--limit 50]
// Data provided by TopDeck.gg — https://topdeck.gg
import { parseArgs } from "node:util";
import { connect } from "./lib/db.js";
import { fetchInfo, isObj, log, sleep, text } from "./lib/topdeck.js";

const INFO_PAUSE_MS = 1000;
const OUTCOMES = ["country found", "location without country", "location null or absent", "request error"] as const;
type Outcome = (typeof OUTCOMES)[number];

/** Wilson score interval for k successes in n trials, 95%. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function main() {
  const { values } = parseArgs({ options: { limit: { type: "string", default: "50" } } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("usage: enrich-sample [--limit N]   (N from 1 to 1000)");
  }

  const sql = connect();
  try {
    const [counted] = await sql<{ population: number }[]>`
      select count(*)::int as population from tournaments where country is null`;
    const population = counted?.population ?? 0;
    const sample = await sql<{ tid: string; participant_count: number }[]>`
      select tid, participant_count from tournaments where country is null order by random() limit ${limit}`;

    const outcomes: Record<Outcome, number> = {
      "country found": 0,
      "location without country": 0,
      "location null or absent": 0,
      "request error": 0,
    };
    const bySize = { small: { n: 0, k: 0 }, large: { n: 0, k: 0 } };
    const countries = new Map<string, number>();

    for (const [i, row] of sample.entries()) {
      if (i > 0) await sleep(INFO_PAUSE_MS);
      log(`GET /info ${i + 1}/${sample.length}`);
      let outcome: Outcome;
      try {
        const info = await fetchInfo(row.tid);
        const loc = isObj(info) ? info.location : undefined;
        if (!isObj(loc)) outcome = "location null or absent";
        else {
          const country = text(loc.country);
          if (country) {
            outcome = "country found";
            countries.set(country, (countries.get(country) ?? 0) + 1);
          } else outcome = "location without country";
        }
      } catch (err) {
        log(`  ${err instanceof Error ? err.message : String(err)}`);
        outcome = "request error";
      }
      outcomes[outcome]++;
      const size = row.participant_count >= 16 ? bySize.large : bySize.small;
      size.n++;
      if (outcome === "country found") size.k++;
    }

    const n = sample.length;
    const k = outcomes["country found"];
    const [lo, hi] = wilson(k, n);
    const lines = [
      "/info enrichment sample (read-only; nothing written)",
      "Data provided by TopDeck.gg (https://topdeck.gg)",
      "",
      `Population: ${population} tournaments with no bulk country`,
      `Sample: ${n}, chosen at random`,
      `Non-null country from /info: ${k} / ${n} = ${n ? pct(k / n) : "n/a"} (95% Wilson interval ${pct(lo)} to ${pct(hi)})`,
      `  participant_count < 16:  ${bySize.small.k} / ${bySize.small.n}`,
      `  participant_count >= 16: ${bySize.large.k} / ${bySize.large.n}`,
      "",
      "Outcomes:",
      ...OUTCOMES.map((o) => `  ${o}: ${outcomes[o]}`),
      "",
      `Country values returned: ${
        countries.size === 0
          ? "none"
          : [...countries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c, x]) => `${JSON.stringify(c)} x${x}`).join(", ")
      }`,
    ];
    console.log(lines.join("\n"));
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`enrich-sample failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
