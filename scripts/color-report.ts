// Read-only report on color identity: how many of the commanders registered in qualifying events match a card
// in Scryfall's commander list, and which don't. It writes nothing. The list is fetched from Scryfall into
// memory (one search, about 20 pages, 1 request per second), so it can run before commander_colors exists.
// Usage: color-report [--months 6]
// Leaders are card names, so they are printed. Data provided by TopDeck.gg (https://topdeck.gg); card data from
// Scryfall (names and color identity only).
import { parseArgs } from "node:util";
import { colorRows, leaderColors } from "./lib/commander-colors";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { cardNameKey, COMMANDER_QUERY, searchCards } from "./lib/scryfall";
import { renderTable } from "./lib/table";

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(2)}%`);
const section = (title: string) => console.log(`\n== ${title} ==`);

async function main() {
  const { values } = parseArgs({ options: { months: { type: "string", default: "6" } } });
  const months = Number(values.months);
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error("usage: color-report [--months N]   (N from 1 to 36)");

  const r = await searchCards(COMMANDER_QUERY, { unique: "cards" });
  console.log(`Scryfall "${COMMANDER_QUERY}" (cards): ${r.cards.length} rows in ${r.pages} page(s), total_cards ${r.totalCards}, complete ${r.complete}`);
  const rows = colorRows(r.cards);
  const colors = new Map(rows.map((x) => [x.name_key, x.colors]));
  const byCount = new Map<number, number>();
  for (const c of r.cards) byCount.set(c.colorIdentity.length, (byCount.get(c.colorIdentity.length) ?? 0) + 1);
  console.log(`Names stored per run: ${rows.length}. Cards by number of colors: ${[0, 1, 2, 3, 4, 5].map((n) => `${n}: ${byCount.get(n) ?? 0}`).join(", ")}`);

  const sql = connect();
  let leaders: { leader: string; entries: number }[];
  let pairCardKey = new Map<string, string>();
  let windowLabel: string;
  try {
    const [w] = await sql<{ last_month: Date | null }[]>`
      select date_trunc('month', max(start_date at time zone 'UTC'))::date as last_month
      from tournaments where start_date < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`;
    if (!w?.last_month) throw new Error("no tournaments before the current month");
    const last = w.last_month.toISOString().slice(0, 10);
    const from = new Date(Date.UTC(w.last_month.getUTCFullYear(), w.last_month.getUTCMonth() - (months - 1), 1)).toISOString().slice(0, 10);
    windowLabel = `${from.slice(0, 7)} to ${last.slice(0, 7)} (${months} months), qualifying entries with a registered commander`;
    leaders = (await sql<{ leader: string; entries: string }[]>`
      select e.leader, count(*) as entries
      from entries e join tournaments t on t.tid = e.tid
      where e.leader is not null and t.participant_count >= 16 and t.event_class in ('cedh', 'unlabeled_competitive')
        and date_trunc('month', t.start_date at time zone 'UTC')::date between ${from}::date and ${last}::date
      group by e.leader`).map((x) => ({ leader: x.leader, entries: Number(x.entries) }));
    // Printed and flavor names of pair cards, as commander_color_identity uses them.
    const pairs = await sql<{ name_key: string; card_name: string }[]>`select name_key, card_name from pair_commanders`;
    pairCardKey = new Map(pairs.map((p) => [p.name_key, cardNameKey(p.card_name)]));
  } finally {
    await sql.end();
  }

  console.log("Data provided by TopDeck.gg (https://topdeck.gg); card list from Scryfall.");
  const sum = (xs: { entries: number }[]) => xs.reduce((n, x) => n + x.entries, 0);
  const total = sum(leaders);
  const rate = (label: string, match: (leader: string) => boolean) => {
    const hit = leaders.filter((l) => match(l.leader));
    return { rule: label, distinct_matched: `${hit.length} of ${leaders.length}`, distinct_pct: pct(hit.length, leaders.length), entries_matched: `${sum(hit)} of ${total}`, entries_pct: pct(sum(hit), total) };
  };
  const exact = new Map(rows.map((x) => [x.name, x.colors]));
  const halvesOf = (leader: string) => leader.split(" / ");
  section(`Match rates (window: ${windowLabel})`);
  console.log(renderTable(["rule", "distinct_matched", "distinct_pct", "entries_matched", "entries_pct"], [
    rate("Oracle and face names, exact", (l) => halvesOf(l).every((h) => exact.has(h))),
    rate("+ apostrophes and case (card_name_key)", (l) => leaderColors(l, colors) !== null),
    rate("+ printed names of pair cards (as stored)", (l) => leaderColors(l, colors, pairCardKey) !== null),
  ]));

  const viaKey = leaders.filter((l) => !halvesOf(l.leader).every((h) => exact.has(h)) && leaderColors(l.leader, colors) !== null);
  const viaPair = leaders.filter((l) => leaderColors(l.leader, colors) === null && leaderColors(l.leader, colors, pairCardKey) !== null);
  const table = (xs: typeof leaders) => renderTable(["leader", "entries", "colors"],
    xs.sort((a, b) => b.entries - a.entries || a.leader.localeCompare(b.leader)).map((l) => ({ leader: l.leader, entries: l.entries, colors: leaderColors(l.leader, colors, pairCardKey) || "(colorless)" })));
  section(`Matched only through the apostrophe/case key: ${viaKey.length} distinct, ${sum(viaKey)} entries`);
  console.log(viaKey.length ? table(viaKey) : "(none)");
  section(`Matched only through a printed name in pair_commanders: ${viaPair.length} distinct, ${sum(viaPair)} entries`);
  console.log(viaPair.length ? table(viaPair) : "(none)");

  const unmatched = leaders.filter((l) => leaderColors(l.leader, colors, pairCardKey) === null).sort((a, b) => b.entries - a.entries || a.leader.localeCompare(b.leader));
  section(`Not matched (no squares shown): ${unmatched.length} distinct, ${sum(unmatched)} entries`);
  console.log(unmatched.length ? renderTable(["leader", "entries", "unmatched_names"], unmatched.map((l) => ({
    leader: l.leader, entries: l.entries,
    unmatched_names: halvesOf(l.leader).filter((h) => leaderColors(h, colors, pairCardKey) === null).join("; "),
  }))) : "(none)");
}

main().catch((err: unknown) => exitWithError("color-report", err));
