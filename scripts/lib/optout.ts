// The player opt-out list (players who asked not to be named), keyed by TopDeck player id. Used by
// scripts/optout.ts. Nothing here returns or prints a player's name.
import type { Sql } from "./db";

/**
 * Records the opt-out and blanks the stored name, in one transaction. Safe to repeat; a new note replaces the
 * old one, and no note keeps it. `known` is false when no player with this id is stored yet: the opt-out then
 * applies from the moment one is ingested.
 */
export async function addOptOut(sql: Sql, playerId: string, note: string | null = null): Promise<{ known: boolean }> {
  return sql.begin(async (tx) => {
    await tx`
      insert into player_optouts (player_id, note) values (${playerId}, ${note})
      on conflict (player_id) do update set note = coalesce(excluded.note, player_optouts.note)`;
    const updated = await tx`update players set display_name = null, updated_at = now() where player_id = ${playerId}`;
    return { known: updated.count > 0 };
  });
}

/** Deletes the opt-out. The name comes back the next time the player is ingested. False when there was none. */
export async function removeOptOut(sql: Sql, playerId: string): Promise<boolean> {
  const deleted = await sql`delete from player_optouts where player_id = ${playerId}`;
  return deleted.count > 0;
}

export type OptOut = { playerId: string; requestedAt: Date; note: string | null };

export async function listOptOuts(sql: Sql): Promise<OptOut[]> {
  const rows = await sql<{ player_id: string; requested_at: Date; note: string | null }[]>`
    select player_id, requested_at, note from player_optouts order by requested_at, player_id`;
  return rows.map((r) => ({ playerId: r.player_id, requestedAt: r.requested_at, note: r.note }));
}

/** What tells two players with the same name apart, without showing a name: how much and where they played. */
export type PlayerMatch = {
  playerId: string;
  events: number;
  firstEvent: string | null; // YYYY-MM-DD
  lastEvent: string | null;
  lastEventName: string | null;
  lastEventPlace: string | null;
};

/**
 * Players whose current name is `name`, most recently active first. The name is matched whole, ignoring case,
 * extra spaces and the characters a post removes from names (@ < > * _ ~ ` | [ ]), so a name copied from a
 * post finds its player. A name a post cut short ends in "…" and is matched as a beginning. Names are read
 * through player_names, so a player who is already opted out or removed is not found.
 */
export async function findPlayersByName(sql: Sql, name: string): Promise<PlayerMatch[]> {
  const cut = name.trim().endsWith("…");
  const wanted = name.trim().replace(/…$/, "");
  if (wanted.trim() === "") return [];
  const rows = await sql<{ player_id: string; events: string; first_event: string | null; last_event: string | null; last_event_name: string | null; last_event_place: string | null }[]>`
    with wanted as (
      select lower(btrim(regexp_replace(regexp_replace(${wanted}::text, '[@<>*_~\`|\\[\\]]', '', 'g'), '\\s+', ' ', 'g'))) as key
    ),
    named as (
      select pn.player_id
      from player_names pn, wanted w
      where pn.display_name is not null
        and case when ${cut}
              then left(lower(btrim(regexp_replace(regexp_replace(pn.display_name, '[@<>*_~\`|\\[\\]]', '', 'g'), '\\s+', ' ', 'g'))), length(w.key)) = w.key
              else lower(btrim(regexp_replace(regexp_replace(pn.display_name, '[@<>*_~\`|\\[\\]]', '', 'g'), '\\s+', ' ', 'g'))) = w.key
            end
    )
    select n.player_id,
           count(distinct e.tid) as events,
           min(t.start_date)::date::text as first_event,
           max(t.start_date)::date::text as last_event,
           (array_agg(t.name order by t.start_date desc, t.tid))[1] as last_event_name,
           (array_agg(nullif(concat_ws(', ', t.city, t.geo_country_name), '') order by t.start_date desc, t.tid))[1] as last_event_place
    from named n
    left join entries e on e.player_id = n.player_id
    left join tournaments t on t.tid = e.tid
    group by n.player_id
    order by max(t.start_date) desc nulls last, n.player_id`;
  return rows.map((r) => ({
    playerId: r.player_id, events: Number(r.events), firstEvent: r.first_event, lastEvent: r.last_event,
    lastEventName: r.last_event_name, lastEventPlace: r.last_event_place,
  }));
}
