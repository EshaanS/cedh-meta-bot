// Recomputes series_key, leader_coverage and event_class for every tournament. Idempotent: only rows whose
// values change are updated. Run after every backfill: new events change series averages, which can move
// older unlabeled events between unlabeled_competitive and unlabeled_casual.
//
// Precedence: series_overrides, then test, then cedh label, then casual label, then unlabeled by series
// coverage. Word boundaries use Postgres \y (\b means backspace in Postgres regex).
// Series coverage is the unweighted mean of event leader coverage over the series' events with 16+ players,
// falling back to all of its events when it has none.
import { connect } from "./lib/db.js";
import { exitWithError } from "./lib/errors.js";

const UNLABELED_COMPETITIVE_MIN_COVERAGE = 0.25;

async function main() {
  const sql = connect();
  try {
    const result = await sql`
      with coverage as (
        select tid, count(leader)::double precision / count(*) as leader_coverage
        from entries
        group by tid
      ),
      events as (
        select
          t.tid,
          t.participant_count,
          btrim(regexp_replace(regexp_replace(lower(coalesce(t.name, '')), '[0-9]+', '', 'g'), '\\s+', ' ', 'g')) as series_key,
          coalesce(c.leader_coverage, 0) as leader_coverage,
          case
            when coalesce(t.name, '') ~* '\\ytest\\y' then 'test'
            when coalesce(t.name, '') ~* 'cedh|c-edh|competitive' then 'cedh'
            when coalesce(t.name, '') ~* 'casual|fnm|bracket ?[1-4]|precon|budget' then 'casual'
          end as label_class
        from tournaments t
        left join coverage c on c.tid = t.tid
      ),
      series as (
        select
          series_key,
          coalesce(avg(leader_coverage) filter (where participant_count >= 16), avg(leader_coverage)) as series_coverage
        from events
        group by series_key
      ),
      computed as (
        select
          e.tid,
          e.series_key,
          e.leader_coverage,
          coalesce(
            o.event_class,
            e.label_class,
            case when s.series_coverage >= ${UNLABELED_COMPETITIVE_MIN_COVERAGE}
              then 'unlabeled_competitive' else 'unlabeled_casual' end
          ) as event_class
        from events e
        join series s on s.series_key = e.series_key
        left join series_overrides o on o.series_key = e.series_key
      )
      update tournaments t set
        series_key = c.series_key,
        leader_coverage = c.leader_coverage,
        event_class = c.event_class
      from computed c
      where t.tid = c.tid
        and (t.series_key, t.leader_coverage, t.event_class) is distinct from (c.series_key, c.leader_coverage, c.event_class)`;
    console.log(`Classified: ${result.count} tournament(s) updated.`);
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => exitWithError("classify", err));
