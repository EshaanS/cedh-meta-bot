// Read-only report on partner pairings: how many pair leaders ("A / B") would be invalid against Scryfall's
// pair-commander list, how many entries that touches, and how well TopDeck leader names match Scryfall's.
// It writes nothing. The lists are fetched from Scryfall into memory (three searches, 1 request per second),
// so it can run before pair_commanders exists.
// Usage: pair-report [--months 6]
// Leaders are card names, so they are printed. Data provided by TopDeck.gg (https://topdeck.gg); card data from
// Scryfall.
import { parseArgs } from "node:util";
import { connect } from "./lib/db";
import { exitWithError } from "./lib/errors";
import { renderTable } from "./lib/table";
import { BACKGROUND_QUERY, cardNameKey, DOCTOR_QUERY, leaderNames, oracleNames, PAIR_QUERY, searchCards, type ScryfallCard } from "./lib/scryfall";
import { sleep } from "./lib/topdeck";

type LeaderRow = { leader: string; all_entries: number; window_entries: number };

/** Candidate name fixes, each applied to both sides before comparing. */
const FIXES: Record<string, (s: string) => string> = {
  "letter case": (s) => s.toLowerCase(),
  "apostrophes and quotes": (s) => s.replace(/[‘’ʼ`´]/g, "'").replace(/[“”]/g, '"'),
  accents: (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, ""),
  "punctuation and spacing": (s) => s.replace(/[^\p{L}\p{N}]+/gu, " ").trim(),
};
const allFixes = (s: string) => Object.values(FIXES).reduce((v, f) => f(v), s);

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(2)}%`);
const section = (title: string) => console.log(`\n== ${title} ==`);

async function main() {
  const { values } = parseArgs({ options: { months: { type: "string", default: "6" } } });
  const months = Number(values.months);
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error("usage: pair-report [--months N]   (N from 1 to 36)");

  // Scryfall lists, in memory only.
  const lists: { query: string; cards: ScryfallCard[] }[] = [];
  for (const [query, unique] of [[PAIR_QUERY, "prints"], [DOCTOR_QUERY, "cards"], [BACKGROUND_QUERY, "cards"]] as const) {
    if (lists.length) await sleep(1000);
    const r = await searchCards(query, { unique });
    console.log(`Scryfall "${query}" (${unique}): ${r.cards.length} rows in ${r.pages} page(s), total_cards ${r.totalCards}, complete ${r.complete}`);
    lists.push({ query, cards: r.cards });
  }
  const tagged = lists[0]!.cards; // one row per printing
  const doctors = lists[1]!.cards;
  const backgrounds = lists[2]!.cards;
  const tagNames = new Set(tagged.flatMap(oracleNames)); // Oracle names only
  const doctorNames = new Set(doctors.flatMap(oracleNames));
  const backgroundNames = new Set(backgrounds.flatMap(oracleNames));
  const withAlt = new Set(tagged.flatMap(leaderNames)); // plus printed and flavor names
  /** What pair_commanders does: every name of the tagged cards, compared on cardNameKey. */
  const storedKeys = new Set([...withAlt].map(cardNameKey));
  const inList = (half: string) => storedKeys.has(cardNameKey(half));
  console.log(`Tagged cards: ${new Set(tagged.map((c) => c.name)).size}; Oracle names ${tagNames.size}; with printed and flavor names ${withAlt.size}; distinct keys ${storedKeys.size}`);

  const sql = connect();
  let rows: LeaderRow[];
  let windowLabel: string;
  let windowLeaderEntries: number;
  try {
    const [w] = await sql<{ last_month: Date | null }[]>`
      select date_trunc('month', max(start_date at time zone 'UTC'))::date as last_month
      from tournaments where start_date < date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`;
    if (!w?.last_month) throw new Error("no tournaments before the current month");
    const last = w.last_month.toISOString().slice(0, 10);
    const from = new Date(Date.UTC(w.last_month.getUTCFullYear(), w.last_month.getUTCMonth() - (months - 1), 1)).toISOString().slice(0, 10);
    windowLabel = `${from.slice(0, 7)} to ${last.slice(0, 7)} (${months} months), qualifying entries`;
    rows = (await sql<{ leader: string; all_entries: string; window_entries: string }[]>`
      select e.leader, count(*) as all_entries,
             count(*) filter (
               where t.participant_count >= 16 and t.event_class in ('cedh', 'unlabeled_competitive')
                 and date_trunc('month', t.start_date at time zone 'UTC')::date between ${from}::date and ${last}::date
             ) as window_entries
      from entries e join tournaments t on t.tid = e.tid
      where e.leader like '% / %'
      group by e.leader`).map((r) => ({ leader: r.leader, all_entries: Number(r.all_entries), window_entries: Number(r.window_entries) }));
    const [tot] = await sql<{ n: string }[]>`
      select count(*) as n from entries e join tournaments t on t.tid = e.tid
      where e.leader is not null and t.participant_count >= 16 and t.event_class in ('cedh', 'unlabeled_competitive')
        and date_trunc('month', t.start_date at time zone 'UTC')::date between ${from}::date and ${last}::date`;
    windowLeaderEntries = Number(tot!.n);
  } finally {
    await sql.end();
  }

  console.log("Data provided by TopDeck.gg (https://topdeck.gg); card lists from Scryfall.");
  const pairs = rows.map((r) => ({ ...r, halves: r.leader.split(" / ").map((h) => h.trim()) }));
  const valid = (names: Set<string>, key: (s: string) => string = (s) => s) => {
    const keys = new Set([...names].map(key));
    return (p: (typeof pairs)[number]) => p.halves.length === 2 && p.halves.every((h) => keys.has(key(h)));
  };
  const sum = (xs: typeof pairs, f: (p: (typeof pairs)[number]) => number) => xs.reduce((n, p) => n + f(p), 0);
  const inWindow = pairs.filter((p) => p.window_entries > 0);

  // ---- Item 4: impact ----
  const report = (label: string, names: Set<string>, key: (s: string) => string = (s) => s) => {
    const ok = valid(names, key);
    const bad = pairs.filter((p) => !ok(p));
    const badW = inWindow.filter((p) => !ok(p));
    console.log(
      `${label}: ${bad.length} of ${pairs.length} distinct pair leaders invalid in all data (${sum(bad, (p) => p.all_entries)} of ${sum(pairs, (p) => p.all_entries)} pair entries); ` +
        `window: ${badW.length} of ${inWindow.length} distinct, ${sum(badW, (p) => p.window_entries)} entries = ` +
        `${pct(sum(badW, (p) => p.window_entries), sum(inWindow, (p) => p.window_entries))} of pair entries, ${pct(sum(badW, (p) => p.window_entries), windowLeaderEntries)} of all entries with a leader`,
    );
    return bad;
  };
  section(`Impact (window: ${windowLabel}; ${windowLeaderEntries} entries with a leader, ${sum(inWindow, (p) => p.window_entries)} of them pairs)`);
  report("Oracle names, exact match", tagNames);
  report("Oracle names, apostrophe- and case-insensitive", tagNames, cardNameKey);
  const bad = report("As pair_commanders stores it (plus printed and flavor names)", withAlt, cardNameKey);

  const missingHalves = (p: (typeof pairs)[number]) => (p.halves.length !== 2 ? [`${p.halves.length} names`] : p.halves.filter((h) => !inList(h)));
  section("20 most common invalid pairs in the window (as pair_commanders stores it)");
  const top = bad.filter((p) => p.window_entries > 0).sort((a, b) => b.window_entries - a.window_entries || a.leader.localeCompare(b.leader)).slice(0, 20);
  console.log(top.length ? renderTable(["leader", "window_entries", "all_entries", "not_in_list"],
    top.map((p) => ({ leader: p.leader, window_entries: p.window_entries, all_entries: p.all_entries, not_in_list: missingHalves(p).join("; ") }))) : "(none)");

  // ---- Backgrounds and Doctors: is the other side of a pairing in the tag? ----
  section("Backgrounds and Doctors: are they in the tag?");
  for (const [label, set] of [["Backgrounds (type:background)", backgroundNames], ['Doctors (type:"time lord" type:doctor)', doctorNames]] as const) {
    const inTag = [...set].filter((n) => tagNames.has(n)).length;
    const used = pairs.filter((p) => p.halves.some((h) => set.has(h)));
    const usedMissing = used.filter((p) => p.halves.some((h) => set.has(h) && !tagNames.has(h)));
    console.log(
      `${label}: ${set.size} names on Scryfall, ${inTag} in the tag, ${set.size - inTag} not. ` +
        `Pair leaders using one: ${used.length} distinct, ${sum(used, (p) => p.all_entries)} entries (${sum(used, (p) => p.window_entries)} in window). ` +
        `Of those, with a half missing from the tag: ${usedMissing.length} distinct, ${sum(usedMissing, (p) => p.all_entries)} entries (${sum(usedMissing, (p) => p.window_entries)} in window).`,
    );
  }

  // ---- Item 5: name matching ----
  section("Name matching of pair halves against the tagged cards");
  const halfCounts = new Map<string, { all: number; window: number }>();
  for (const p of pairs) for (const h of p.halves) {
    const c = halfCounts.get(h) ?? { all: 0, window: 0 };
    c.all += p.all_entries;
    c.window += p.window_entries;
    halfCounts.set(h, c);
  }
  const halves = [...halfCounts.entries()].map(([name, c]) => ({ name, ...c }));
  const totalAll = halves.reduce((n, h) => n + h.all, 0);
  const matchRate = (label: string, key: (s: string) => string, names: Set<string> = tagNames) => {
    const keys = new Set([...names].map(key));
    const hit = halves.filter((h) => keys.has(key(h.name)));
    return { rule: label, distinct_matched: `${hit.length} of ${halves.length}`, distinct_pct: pct(hit.length, halves.length), entries_pct: pct(hit.reduce((n, h) => n + h.all, 0), totalAll) };
  };
  console.log(renderTable(["rule", "distinct_matched", "distinct_pct", "entries_pct"], [
    matchRate("Oracle names, exact", (s) => s),
    ...Object.entries(FIXES).map(([label, f]) => matchRate(`Oracle names + ${label}`, f)),
    matchRate("Oracle names + all four fixes", allFixes),
    matchRate("Oracle + printed and flavor names, exact", (s) => s, withAlt),
    matchRate("as stored: all names, apostrophes and case", cardNameKey, withAlt),
    matchRate("all names + all four fixes", allFixes, withAlt),
  ]));
  console.log("A half that matches nothing is usually a real card that simply cannot pair; see the next table.");

  const viaAlt = halves.filter((h) => !tagNames.has(h.name) && withAlt.has(h.name)).sort((a, b) => b.all - a.all);
  const cardOf = new Map(tagged.flatMap((c) => leaderNames(c).map((n) => [n, c.name] as const)));
  section(`Halves matched only through a printed or flavor name: ${viaAlt.length} distinct, ${viaAlt.reduce((n, h) => n + h.all, 0)} half-entries`);
  console.log(viaAlt.length ? renderTable(["half", "all_entries", "window_entries", "oracle_name"], viaAlt.map((h) => ({ half: h.name, all_entries: h.all, window_entries: h.window, oracle_name: cardOf.get(h.name) }))) : "(none)");
  const viaKey = halves.filter((h) => !withAlt.has(h.name) && inList(h.name)).sort((a, b) => b.all - a.all);
  section(`Halves matched only through the apostrophe/case key: ${viaKey.length} distinct, ${viaKey.reduce((n, h) => n + h.all, 0)} half-entries`);
  console.log(viaKey.length ? renderTable(["half", "all_entries", "window_entries"], viaKey.map((h) => ({ half: h.name, all_entries: h.all, window_entries: h.window }))) : "(none)");

  const unmatched = halves.filter((h) => !inList(h.name)).sort((a, b) => b.all - a.all || a.name.localeCompare(b.name));
  const listArr = [...withAlt];
  const listByKey = new Map(listArr.map((n) => [allFixes(n), n]));
  const nearest = (name: string) => {
    const k = allFixes(name);
    const same = listByKey.get(k);
    if (same) return `${same} (same after fixes)`;
    let best = "", bestD = Infinity;
    for (const n of listArr) {
      const d = levenshtein(k, allFixes(n));
      if (d < bestD) { bestD = d; best = n; }
    }
    return bestD <= 3 ? `${best} (${bestD} edit${bestD === 1 ? "" : "s"})` : "";
  };
  const kind = (name: string) => (backgroundNames.has(name) ? "Background" : doctorNames.has(name) ? "Doctor" : "");
  section(`Halves still not in the list: ${unmatched.length} distinct, ${unmatched.reduce((n, h) => n + h.all, 0)} half-entries (top 40 by entries)`);
  console.log(unmatched.length ? renderTable(["half", "all_entries", "window_entries", "is", "closest_list_name"],
    unmatched.slice(0, 40).map((h) => ({ half: h.name, all_entries: h.all, window_entries: h.window, is: kind(h.name), closest_list_name: nearest(h.name) }))) : "(none)");
  const fixable = unmatched.filter((h) => listByKey.has(allFixes(h.name)));
  console.log(`Of those, halves that accents or punctuation fixes would still match: ${fixable.length} distinct, ${fixable.reduce((n, h) => n + h.all, 0)} half-entries.`);

  // ---- Order and compatibility ----
  section("Order and ability checks");
  const two = pairs.filter((p) => p.halves.length === 2);
  const notAlpha = two.filter((p) => p.halves[0]! > p.halves[1]!);
  console.log(`Leaders with other than 2 names: ${pairs.length - two.length}. Pairs not in alphabetical order: ${notAlpha.length} of ${two.length} distinct (${sum(notAlpha, (p) => p.all_entries)} entries).`);
  const both = new Set(two.map((p) => p.leader));
  const mirrored = two.filter((p) => p.halves[0]! < p.halves[1]! && both.has(`${p.halves[1]} / ${p.halves[0]}`));
  console.log(`Pairs that appear in both orders (A / B and B / A): ${mirrored.length}.`);

  const cardByName = new Map<string, ScryfallCard>();
  for (const c of tagged) for (const n of leaderNames(c)) cardByName.set(cardNameKey(n), c);
  const ability = (c: ScryfallCard): string => {
    const with_ = /Partner with ([^\n(]+?)(?: \(|\n|$)/.exec(c.oracleText)?.[1]?.trim();
    if (with_) return `partner-with:${with_}`;
    if (/Friends forever/i.test(c.oracleText)) return "friends-forever";
    if (c.keywords.includes("Choose a background")) return "choose-background";
    if (/\bBackground\b/.test(c.typeLine)) return "background";
    if (c.keywords.includes("Doctor's companion")) return "doctors-companion";
    if (/Time Lord Doctor/.test(c.typeLine)) return "doctor";
    if (c.keywords.includes("Partner")) return /Partner—|Partner —/.test(c.oracleText) ? "partner-variant" : "partner";
    return "other";
  };
  const compatible = (a: ScryfallCard, b: ScryfallCard): boolean => {
    const [x, y] = [ability(a), ability(b)];
    const set = new Set([x, y]);
    if (x.startsWith("partner-with:") || y.startsWith("partner-with:")) {
      return oracleNames(b).some((n) => x === `partner-with:${n}`) || oracleNames(a).some((n) => y === `partner-with:${n}`);
    }
    if (x === y) return ["partner", "friends-forever", "partner-variant", "other"].includes(x);
    return (set.has("choose-background") && set.has("background")) || (set.has("doctors-companion") && set.has("doctor"));
  };
  const card = (half: string) => cardByName.get(cardNameKey(half));
  const listed = two.filter((p) => p.halves.every((h) => card(h)));
  const mismatched = listed.filter((p) => !compatible(card(p.halves[0]!)!, card(p.halves[1]!)!));
  console.log(
    `Pairs with both halves in the list whose abilities don't go together (membership alone calls these valid): ` +
      `${mismatched.length} of ${listed.length} distinct, ${sum(mismatched, (p) => p.all_entries)} entries (${sum(mismatched, (p) => p.window_entries)} in window).`,
  );
  const kinds = new Map<string, number>();
  for (const c of new Set(cardByName.values())) kinds.set(ability(c).replace(/:.*/, ""), (kinds.get(ability(c).replace(/:.*/, "")) ?? 0) + 1);
  console.log(`List by ability: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (mismatched.length) {
    console.log(renderTable(["leader", "all_entries", "window_entries", "abilities"], mismatched.sort((a, b) => b.all_entries - a.all_entries).slice(0, 15).map((p) => ({
      leader: p.leader, all_entries: p.all_entries, window_entries: p.window_entries,
      abilities: p.halves.map((h) => ability(card(h)!).replace(/:.*/, "")).join(" + "),
    }))));
  }
}

main().catch((err: unknown) => exitWithError("pair-report", err));
