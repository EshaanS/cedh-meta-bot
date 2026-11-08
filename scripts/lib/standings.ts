// Fills event_winners with the official standing-1 commander for qualifying 32+ events whose cut isn't
// recorded as bracket rounds (topCut = 0). Each event is fetched once; failures are retried on the next run.
import type { Sql } from "./db";
import { log, sleep, type StandingOne } from "./topdeck";

export type StandingsFetcher = (tid: string) => Promise<StandingOne>;
export type StandingsResult = { candidates: number; found: number; noStanding1: number; noCommander: number; errors: number };

export async function fetchMissingStandings(sql: Sql, fetcher: StandingsFetcher, opts: { pauseMs?: number } = {}): Promise<StandingsResult> {
  const pauseMs = opts.pauseMs ?? 1000;
  const todo = await sql<{ tid: string }[]>`
    select t.tid
    from tournaments t
    left join event_winners w on w.tid = t.tid
    where w.tid is null
      and t.participant_count >= 32
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and coalesce(t.top_cut, 0) = 0
    order by t.start_date desc, t.tid`;
  const result: StandingsResult = { candidates: todo.length, found: 0, noStanding1: 0, noCommander: 0, errors: 0 };
  for (const [i, { tid }] of todo.entries()) {
    if (i > 0 && pauseMs > 0) await sleep(pauseMs);
    let one: StandingOne;
    try {
      one = await fetcher(tid);
    } catch (err) {
      result.errors++;
      log(`standings ${tid}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    await sql`
      insert into event_winners (tid, winner_commander, status) values (${tid}, ${one.leader}, ${one.status})
      on conflict (tid) do nothing`;
    if (one.status === "found") result.found++;
    else if (one.status === "no_standing_1") result.noStanding1++;
    else result.noCommander++;
  }
  return result;
}
