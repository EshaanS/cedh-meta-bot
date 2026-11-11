// Fills event_winners with the official standing-1 commander and player for qualifying 32+ events whose cut
// isn't recorded as bracket rounds (topCut = 0). Each event is fetched once; failures are retried on the next
// run. Rows fetched before player ids were stored (player_checked_at is null) are fetched once more.
import type { Sql } from "./db";
import { log, sleep, type StandingOne } from "./topdeck";

export type StandingsFetcher = (tid: string) => Promise<StandingOne>;
export type StandingsResult = { candidates: number; found: number; noStanding1: number; noCommander: number; errors: number };

/** `opts.tids` limits the run to those events (used by tests so they never touch other rows). */
export async function fetchMissingStandings(sql: Sql, fetcher: StandingsFetcher, opts: { pauseMs?: number; tids?: string[] } = {}): Promise<StandingsResult> {
  const pauseMs = opts.pauseMs ?? 1000;
  const only = opts.tids ?? null;
  const todo = await sql<{ tid: string }[]>`
    select t.tid
    from tournaments t
    left join event_winners w on w.tid = t.tid
    where (w.tid is null or w.player_checked_at is null)
      and t.participant_count >= 32
      and t.event_class in ('cedh', 'unlabeled_competitive')
      and coalesce(t.top_cut, 0) = 0
      and (${only}::text[] is null or t.tid = any(${only}::text[]))
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
    await sql.begin(async (tx) => {
      if (one.playerId !== null) {
        // The name stays null while the player is on the opt-out list.
        await tx`
          insert into players (player_id, display_name)
          select ${one.playerId}::text,
                 case when exists (select 1 from player_optouts o where o.player_id = ${one.playerId}::text) then null else ${one.playerName}::text end
          on conflict (player_id) do update set display_name = excluded.display_name, updated_at = now()`;
      }
      await tx`
        insert into event_winners (tid, winner_commander, status, winner_player_id, player_checked_at)
        values (${tid}, ${one.leader}, ${one.status}, ${one.playerId}, now())
        on conflict (tid) do update set
          winner_commander = excluded.winner_commander,
          status = excluded.status,
          winner_player_id = excluded.winner_player_id,
          player_checked_at = excluded.player_checked_at,
          fetched_at = now()`;
    });
    if (one.status === "found") result.found++;
    else if (one.status === "no_standing_1") result.noStanding1++;
    else result.noCommander++;
  }
  return result;
}
