// Builds the region catalog from geocoded data: every country, admin-1 group and admin-1 unit with at
// least one qualifying event in the 12 months ending at the latest month with data before the current
// UTC month. Idempotent; never deletes regions (server configs may reference them) and never changes
// hand-seeded rows. Parents: admin-1 -> its group (if any) -> country -> macro (if any) -> global.
// Also sets `selectable` on auto rows (see SELECTABLE_*_COUNTRIES).
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";

type RegionRow = { id: string; display_name: string; type: "country" | "admin1_group" | "admin1"; parent_region_id: string; selectable: boolean };

/** Which auto regions a server may pick in /region set. Every country is selectable. */
const SELECTABLE_GROUP_COUNTRIES = new Set(["ES", "IT", "GB", "FR", "PT"]);
const SELECTABLE_ADMIN1_COUNTRIES = new Set(["US", "CA", "DE", "AU"]);
type MemberRow = { region_id: string; country_code: string; admin1_code: string | null; admin1_group_code: string | null };

const englishRegionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryDisplayName(code: string, fallback: string | null): string {
  try {
    const name = englishRegionNames.of(code);
    if (name && name !== code) return name;
  } catch {
    // Not a code Intl knows; use the Natural Earth name.
  }
  return fallback ?? code;
}

async function main() {
  const sql = connect();
  try {
    const [bounds] = await sql<{ last_month: Date | null }[]>`
      select date_trunc('month', max(start_date at time zone 'UTC'))::date as last_month
      from tournaments
      where start_date < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`;
    if (!bounds?.last_month) {
      console.log("No tournaments before the current month; nothing to do.");
      return;
    }
    const lastMonth = bounds.last_month;

    const units = await sql<
      { cc: string; cn: string | null; a1: string | null; a1n: string | null; g: string | null; gn: string | null }[]
    >`
      select distinct
        geo_country_code as cc, geo_country_name as cn,
        geo_admin1_code as a1, geo_admin1_name as a1n,
        geo_admin1_group_code as g, geo_admin1_group_name as gn
      from tournaments
      where participant_count >= 16
        and event_class in ('cedh', 'unlabeled_competitive')
        and geo_country_code is not null
        and date_trunc('month', start_date at time zone 'UTC')::date
            between (${lastMonth}::date - interval '11 months')::date and ${lastMonth}::date`;

    const macroOf = new Map(
      (
        await sql<{ country_code: string; region_id: string }[]>`
          select m.country_code, m.region_id
          from region_members m join regions r on r.id = m.region_id
          where r.type = 'macro' and m.admin1_code is null and m.admin1_group_code is null`
      ).map((r) => [r.country_code, r.region_id]),
    );

    const regions = new Map<string, RegionRow>();
    const members: MemberRow[] = [];
    const collisions: string[] = [];
    const add = (r: RegionRow, m: MemberRow) => {
      const existing = regions.get(r.id);
      if (existing && existing.type !== r.type) {
        collisions.push(`${r.id} (${existing.type} vs ${r.type})`);
        return;
      }
      if (!existing) {
        regions.set(r.id, r);
        members.push(m);
      }
    };

    for (const u of units) {
      const country = u.cc.toLowerCase();
      add(
        { id: country, display_name: countryDisplayName(u.cc, u.cn), type: "country", parent_region_id: macroOf.get(u.cc) ?? "global", selectable: true },
        { region_id: country, country_code: u.cc, admin1_code: null, admin1_group_code: null },
      );
    }
    for (const u of units) {
      if (!u.g || !u.gn) continue;
      add(
        { id: u.g.toLowerCase(), display_name: u.gn, type: "admin1_group", parent_region_id: u.cc.toLowerCase(), selectable: SELECTABLE_GROUP_COUNTRIES.has(u.cc) },
        { region_id: u.g.toLowerCase(), country_code: u.cc, admin1_code: null, admin1_group_code: u.g },
      );
    }
    for (const u of units) {
      if (!u.a1 || !u.a1n) continue;
      add(
        { id: u.a1.toLowerCase(), display_name: u.a1n, type: "admin1", parent_region_id: (u.g ?? u.cc).toLowerCase(), selectable: SELECTABLE_ADMIN1_COUNTRIES.has(u.cc) },
        { region_id: u.a1.toLowerCase(), country_code: u.cc, admin1_code: u.a1, admin1_group_code: null },
      );
    }

    // Ids already taken by hand-seeded regions, or by an auto region of another type, are collisions.
    const existing = await sql<{ id: string; type: string; source: string }[]>`select id, type, source from regions`;
    for (const e of existing) {
      const planned = regions.get(e.id);
      if (planned && (e.source !== "auto" || e.type !== planned.type)) {
        collisions.push(`${e.id} (existing ${e.source} ${e.type} vs ${planned.type})`);
        regions.delete(e.id);
      }
    }
    const keptMembers = members.filter((m) => regions.has(m.region_id));

    const order: RegionRow["type"][] = ["country", "admin1_group", "admin1"];
    const counts = { inserted: 0, updated: 0, membersAdded: 0 };
    await sql.begin(async (tx) => {
      for (const type of order) {
        for (const r of [...regions.values()].filter((x) => x.type === type)) {
          const res = await tx`
            insert into regions (id, display_name, type, parent_region_id, source, selectable)
            values (${r.id}, ${r.display_name}, ${r.type}, ${r.parent_region_id}, 'auto', ${r.selectable})
            on conflict (id) do update set
              display_name = excluded.display_name,
              parent_region_id = excluded.parent_region_id,
              selectable = excluded.selectable
            where regions.source = 'auto'
              and (regions.display_name, regions.parent_region_id, regions.selectable)
                  is distinct from (excluded.display_name, excluded.parent_region_id, excluded.selectable)
            returning (xmax = 0) as inserted`;
          if (res.length > 0) {
            if (res[0]!.inserted) counts.inserted++;
            else counts.updated++;
          }
        }
      }
      for (const m of keptMembers) {
        const res = await tx`
          insert into region_members (region_id, country_code, admin1_code, admin1_group_code)
          values (${m.region_id}, ${m.country_code}, ${m.admin1_code}, ${m.admin1_group_code})
          on conflict do nothing`;
        counts.membersAdded += res.count;
      }
    });

    const byType = order.map((t) => `${[...regions.values()].filter((r) => r.type === t).length} ${t}`).join(", ");
    console.log(
      `Region catalog (12 months to ${lastMonth.toISOString().slice(0, 7)}): ${byType} eligible; ` +
        `${counts.inserted} inserted, ${counts.updated} updated, ${counts.membersAdded} members added.`,
    );
    if (collisions.length > 0) {
      throw new Error(`id collisions, skipped: ${collisions.join("; ")}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("regions", err));
