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
import { pool } from "./db.js";

export async function ensureCurrentExternalOccurrence(schedule) {
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
export async function ensureCurrentExternalOccurrencesForAthlete(athleteId) {
  const schedulesResult = await pool.query(
    `select distinct s.*
     from training_load.external_schedules s
     join training_load.external_schedule_targets t on t.schedule_id = s.id
     left join public.athlete_memberships m
       on (t.target_kind = 'team' and m.team_id = t.target_team_id and m.athlete_id = $1 and m.membership_type = 'team' and m.status = 'active')
       or (t.target_kind = 'club' and m.club_id = t.target_club_id and m.athlete_id = $1 and m.membership_type = 'club' and m.status = 'active')
     where s.status = 'active'
       and (
         (t.target_kind = 'athlete' and t.target_athlete_id = $1)
         or (t.target_kind in ('team','club') and m.id is not null)
       )`,
    [athleteId],
  );
  for (const schedule of schedulesResult.rows) {
    await ensureCurrentExternalOccurrence(schedule);
  }
}

// Runs ensureCurrentExternalOccurrence for every schedule a given coach
// (identified by their manageable club/team ids, or null for "no scope
// filter" - platform admin) may currently manage - called right before a
// coach-facing route reads schedule/occurrence/assignment state, mirroring
// the athlete-side helper above.
export async function ensureCurrentExternalOccurrencesForCoach({ userId, clubIds, teamIds, isPlatformAdmin }) {
  let conditions = ["s.owner_scope = 'user' and s.created_by_user_id = $1"];
  let params = [userId];
  if (isPlatformAdmin) {
    conditions = ["true"];
    params = [];
  } else {
    if (clubIds?.length) {
      params.push(clubIds);
      conditions.push(`(s.owner_scope = 'club' and s.owner_club_id = any($${params.length}::uuid[]))`);
    }
    if (teamIds?.length) {
      params.push(teamIds);
      conditions.push(`(s.owner_scope = 'team' and s.owner_team_id = any($${params.length}::uuid[]))`);
    }
  }
  const schedulesResult = await pool.query(
    `select * from training_load.external_schedules s where s.status = 'active' and (${conditions.join(" or ")})`,
    params,
  );
  for (const schedule of schedulesResult.rows) {
    await ensureCurrentExternalOccurrence(schedule);
  }
}
