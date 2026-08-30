// Occurrence/assignment generation for training_load.external_schedules -
// a structural copy of testsOccurrenceService.js's own ensureCurrentOccurrence
// shape, rebound to the training_load.* functions (migrations_v2/
// 202609011000_training_load_v4_external_scheduling.sql). Called from
// exactly two places - an on-demand path (routes/trainingLoad.js, right
// before reading assignments) and the background notification worker
// (trainingLoadNotificationWorker.js) - both always through THIS function,
// never re-deriving candidate dates themselves, so the two paths can never
// disagree about which occurrences should exist.
//
// Date math is always done IN POSTGRES (training_load.resolve_current_
// external_target_dates), never in JS with the server's own local clock -
// same rule testsOccurrenceService.js itself documents.
//
// Every export here takes `pool` as an explicit parameter, defaulting to
// the shared web-server pool (./db.js) so route call sites don't need to
// pass it - but the standalone background worker (a separate process with
// its OWN pg.Pool, matching testsNotificationWorkerCli.js's own
// convention) passes its own pool explicitly instead.
import { pool as defaultPool } from "./db.js";

export async function ensureCurrentExternalOccurrence(schedule, pool = defaultPool) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      // FOR SHARE first, matching generate_external_schedule_occurrence's
      // own lock order - a schedule PATCH/cancel taking FOR UPDATE on this
      // same row can never race underneath an in-flight generation here.
      const scheduleResult = await client.query(`select * from training_load.external_schedules where id = $1 for share`, [schedule.id]);
      const fresh = scheduleResult.rows[0];
      if (!fresh || fresh.status !== "active") {
        await client.query("commit");
        return [];
      }

      const datesResult = await client.query(
        `select local_date from training_load.resolve_current_external_target_dates($1) order by local_date`,
        [schedule.id],
      );
      const candidateDates = datesResult.rows.map((row) => row.local_date);
      if (!candidateDates.length) {
        await client.query("commit");
        return [];
      }

      const occurrenceIds = [];
      for (const targetDate of candidateDates) {
        const occurrenceResult = await client.query(
          `select training_load.generate_external_schedule_occurrence($1, $2) as id`,
          [schedule.id, targetDate],
        );
        const occurrenceId = occurrenceResult.rows[0].id;
        await client.query(`select training_load.materialize_external_assignments_for_occurrence($1)`, [occurrenceId]);
        occurrenceIds.push(occurrenceId);
      }
      await client.query("commit");
      return occurrenceIds;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

// Runs ensureCurrentExternalOccurrence for every currently-active schedule
// this athlete could plausibly be targeted by (directly, or via any club/
// team) - called right before the athlete-facing routes read their own
// pending assignments, so a freshly-eligible occurrence/assignment always
// exists by the time it's read, without waiting for the background worker's
// own cycle.
//
// Hardening correction: current targeting alone misses a real "frozen
// membership" scenario - resolve_current_external_target_dates() already
// keeps an OUTSTANDING snapshot date live once an athlete has been
// snapshotted into an occurrence but not yet materialized (their own
// local date hadn't arrived yet when someone else's on-demand call/the
// worker took that snapshot), but this function only ever discovered a
// schedule via CURRENT membership - if that membership is removed before
// the athlete's own local date arrives, their schedule silently drops out
// of this query entirely, and with no scheduled worker run in between,
// the assignment this athlete is already snapshotted for would never
// materialize at all. The second branch below closes that gap: any
// active schedule where this athlete already has a snapshot row for some
// occurrence but no assignment yet, regardless of their CURRENT
// targeting. A genuine late joiner (no snapshot row at all for that
// occurrence) is still correctly excluded - this only ever re-discovers
// an athlete who was already snapshotted.
export async function ensureCurrentExternalOccurrencesForAthlete(athleteId, pool = defaultPool) {
  const schedulesResult = await pool.query(
    `select s.* from training_load.external_schedules s
     join training_load.external_schedule_targets t on t.schedule_id = s.id
     left join public.athlete_memberships m
       on (t.target_kind = 'team' and m.team_id = t.target_team_id and m.athlete_id = $1 and m.membership_type = 'team' and m.status = 'active')
       or (t.target_kind = 'club' and m.club_id = t.target_club_id and m.athlete_id = $1 and m.membership_type = 'club' and m.status = 'active')
     where s.status = 'active'
       and (
         (t.target_kind = 'athlete' and t.target_athlete_id = $1)
         or (t.target_kind in ('team','club') and m.id is not null)
       )
     union
     select s.* from training_load.external_schedules s
     join training_load.external_schedule_occurrences o on o.schedule_id = s.id
     join training_load.external_occurrence_target_snapshot snap on snap.occurrence_id = o.id and snap.athlete_id = $1
     where s.status = 'active'
       and not exists (
         select 1 from training_load.external_assignments a
         where a.occurrence_id = o.id and a.athlete_id = $1
       )`,
    [athleteId],
  );
  for (const schedule of schedulesResult.rows) {
    await ensureCurrentExternalOccurrence(schedule, pool);
  }
}

// Runs ensureCurrentExternalOccurrence for every schedule owned by the
// coach's CURRENTLY ACTIVE workspace only - `scope` is the discriminated
// object trainingLoadAccess.js's own resolveExternalScheduleWorkspaceScope
// produces ({type: 'platform'|'club'|'team'|'private_coach'|null, ...}).
// Hardening correction: this used to take the account's full manageable
// club/team id sets regardless of which workspace was active, so a
// dual-role coach's on-demand generation silently ran for BOTH clubs even
// while presenting as just one of them. Called right before a coach-
// facing route reads schedule/occurrence/assignment state, mirroring the
// athlete-side helper above.
export async function ensureCurrentExternalOccurrencesForCoach(scope, pool = defaultPool) {
  let condition = "false";
  let params = [];
  if (scope.type === "platform") {
    condition = "true";
  } else if (scope.type === "club") {
    condition = "s.owner_scope = 'club' and s.owner_club_id = $1";
    params = [scope.clubId];
  } else if (scope.type === "team") {
    condition = "s.owner_scope = 'team' and s.owner_team_id = $1";
    params = [scope.teamId];
  } else if (scope.type === "private_coach") {
    condition = "s.owner_scope = 'user' and s.owner_user_id = $1";
    params = [scope.userId];
  }
  const schedulesResult = await pool.query(
    `select * from training_load.external_schedules s where s.status = 'active' and (${condition})`,
    params,
  );
  for (const schedule of schedulesResult.rows) {
    await ensureCurrentExternalOccurrence(schedule, pool);
  }
}
