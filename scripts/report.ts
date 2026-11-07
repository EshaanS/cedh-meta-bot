// Prints the v1 stats for a region and month as plain text, for review. Uses resolve_region to fall back
// to a reportable parent, then prints every stat for the resolved region.
// Usage: report --region <id> --month YYYY-MM
// Data provided by TopDeck.gg — https://topdeck.gg
import { parseArgs } from "node:util";
import { connect } from "./lib/db.js";
import { exitWithError } from "./lib/errors.js";
import { renderTable } from "./lib/table.js";

const pct = (x: number | null, digits = 1) => (x === null ? "" : `${(100 * x).toFixed(digits)}%`);
const signedPct = (x: number | null) => (x === null ? "" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`);
const fixed = (x: number | null, digits = 3) => (x === null ? "" : x.toFixed(digits));

function section(title: string, columns: string[], rows: Record<string, unknown>[], note?: string) {
  console.log(`\n== ${title} ==`);
  if (note) console.log(note);
  console.log(rows.length === 0 ? "(none)" : renderTable(columns, rows));
}

async function main() {
  const { values } = parseArgs({ options: { region: { type: "string" }, month: { type: "string" } } });
  if (!values.region || !values.month || !/^\d{4}-\d{2}$/.test(values.month)) {
    throw new Error("usage: report --region <id> --month YYYY-MM");
  }
  const month = `${values.month}-01`;
  const sql = connect();
  try {
    const [region] = await sql<{ id: string; display_name: string; type: string }[]>`
      select id, display_name, type from regions where id = ${values.region}`;
    if (!region) throw new Error(`unknown region id: ${values.region}`);

    console.log("Data provided by TopDeck.gg (https://topdeck.gg)");
    console.log(`Report for ${region.display_name} [${region.id}, ${region.type}], window ending ${values.month}`);

    const chain = await sql<{ id: string; display_name: string; steps: number; entries: string; entries_with_leader: string; commanders_10plus: string; reportable: boolean }[]>`
      with recursive chain (id, parent, steps) as (
        select id, parent_region_id, 0 from regions where id = ${region.id}
        union all
        select r.id, r.parent_region_id, c.steps + 1 from regions r join chain c on r.id = c.parent where c.steps < 10
      )
      select c.id, r.display_name, c.steps, rr.entries, rr.entries_with_leader, rr.commanders_10plus, rr.reportable
      from chain c
      join regions r on r.id = c.id
      cross join lateral region_reportability(c.id, ${month}::date) rr
      order by c.steps`;
    section(
      "Reportability along the fallback chain (6 months; needs >= 10 commanders with >= 10 leader entries)",
      ["steps", "region", "entries", "entries_with_leader", "commanders_10plus", "reportable"],
      chain.map((c) => ({ ...c, region: `${c.display_name} [${c.id}]`, reportable: c.reportable ? "yes" : "no" })),
    );

    const [resolved] = await sql<{ region_id: string; steps_up: number; reportable: boolean }[]>`
      select * from resolve_region(${region.id}, ${month}::date)`;
    if (!resolved) throw new Error("resolve_region returned no row");
    const [target] = await sql<{ display_name: string }[]>`select display_name from regions where id = ${resolved.region_id}`;
    console.log(
      `\nresolve_region -> ${target?.display_name} [${resolved.region_id}], ${resolved.steps_up} step(s) up` +
        (resolved.reportable ? "" : " (NOT reportable: no region in the chain meets the threshold)"),
    );
    const r = resolved.region_id;

    const [cov] = await sql<{ events_16plus: string; qualifying_events: string; pct_geocoded: number | null; qualifying_entries: string; pct_entries_with_leader: number | null }[]>`
      select * from stat_coverage(${r}, ${month}::date)`;
    section("Coverage (6 months)", ["events_16plus", "qualifying_events", "pct_geocoded", "qualifying_entries", "pct_entries_with_leader"], [
      {
        ...cov,
        pct_geocoded: cov?.pct_geocoded == null ? "" : `${Number(cov.pct_geocoded).toFixed(1)}%`,
        pct_entries_with_leader: cov?.pct_entries_with_leader == null ? "" : `${Number(cov.pct_entries_with_leader).toFixed(1)}%`,
      },
    ]);

    const meta = await sql<{ commander: string; entries: string; meta_share: number }[]>`
      select * from stat_meta_share(${r}, ${month}::date) limit 25`;
    section("Meta share, top 25 (6 months; floor 0.2%)", ["commander", "entries", "meta_share"],
      meta.map((m) => ({ ...m, meta_share: pct(m.meta_share, 2) })));

    const ppg = await sql<{ commander: string; entries: string; wins: string; draws: string; losses: string; ppg: number; shrunk_ppg: number; field_draw_rate: number; neutral_baseline: number }[]>`
      select * from stat_ppg(${r}, ${month}::date) limit 25`;
    section("PPG, top 25 by shrunk PPG (6 months)", ["commander", "entries", "wins", "draws", "losses", "ppg", "shrunk_ppg"],
      ppg.map((p) => ({ ...p, ppg: fixed(p.ppg), shrunk_ppg: fixed(p.shrunk_ppg) })),
      ppg[0] ? `Field draw rate ${pct(ppg[0].field_draw_rate)}; neutral baseline ${fixed(ppg[0].neutral_baseline)}; shrinkage target 1.250, n = entries.` : undefined);

    const conv = await sql<{ commander: string; entries_in_cut_events: string; top_cut_entries: string; conversion: number; baseline_conversion: number }[]>`
      select * from stat_conversion(${r}, ${month}::date) limit 25`;
    section("Top-cut conversion, top 25 (6 months; top cut = played bracket games)", ["commander", "entries_in_cut_events", "top_cut_entries", "conversion"],
      conv.map((c) => ({ ...c, conversion: pct(c.conversion) })),
      conv[0] ? `Baseline conversion (all leader entries in cut events): ${pct(conv[0].baseline_conversion)}` : undefined);

    const growth = await sql<{ commander: string; last_month_entries: string; prior3_avg_entries: number; entry_growth: number | null; last_month_share: number; prior3_share: number | null; share_growth: number | null; is_new: boolean }[]>`
      select * from stat_growth(${r}, ${month}::date) limit 15`;
    section("Growth, top 15 by share growth (end month vs prior 3 months; >= 5 entries)",
      ["commander", "last_month_entries", "prior3_avg_entries", "entry_growth", "last_month_share", "prior3_share", "share_growth"],
      growth.map((g) => ({
        ...g,
        prior3_avg_entries: fixed(g.prior3_avg_entries, 1),
        entry_growth: g.is_new ? "new" : signedPct(g.entry_growth),
        last_month_share: pct(g.last_month_share, 2),
        prior3_share: pct(g.prior3_share, 2),
        share_growth: g.is_new ? "new" : signedPct(g.share_growth),
      })));

    const notable = await sql<{ event_name: string | null; participant_count: number; location: string | null; result: string; result_commanders: string | null; top_cut_commanders: string | null }[]>`
      select * from stat_notable_results(${r}, ${month}::date)`;
    section(`Notable results in ${values.month} (qualifying events with 32+ players)`, ["participant_count", "event_name", "location", "result", "result_commanders", "top_cut_commanders"], notable,
      "result: winner = the single top-cut entry with the most bracket wins and no bracket losses; final drawn = 2+ such entries tied.");
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("report", err));
