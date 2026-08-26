// On-demand occurrence/materialization for the Tests module (Phase 2).
// There is no cron/worker yet for THIS specific service (see
// testsNotificationWorker.js for the periodic job that also drives it
// proactively) - Today/athlete/check-in endpoints call
// ensureCurrentOccurrence() themselves, right before they need "today's"
// (or an adjacent day's - see below) occurrence(s) to exist. Safe for
// repeated/parallel calls: it only ever calls the real Phase 1/4 functions
// (tests.generate_test_schedule_occurrence,
// tests.materialize_test_assignments_for_occurrence), which are themselves
// already idempotent/lock-protected - no new locking or state is invented
// here.
//
// Date math is always done IN POSTGRES, never in JS with the server's local
// clock.
//
// Round 2 correction (item 1): candidate dates are no longer guessed from
// the SCHEDULE's own reference timezone at all - not even "today plus one
// adjacent day". That approach (this function's own previous version) was a
// real bug, not a theoretical edge case: a schedule in Pacific/Kiritimati
// (UTC+14) targeting an athlete in America/Adak (UTC-12, ~26h behind) needs
// an occurrence for a date that, at the athlete's own 06:00 on that date,
// the SCHEDULE's own reference clock has already rolled a FULL DAY PAST it
// - checking only the schedule's own "today" and "tomorrow" can never reach
// a date a full day BEHIND the schedule's own current date, so that
// occurrence would never be generated at all. Any fixed, hardcoded
// direction guessed from the schedule's own timezone has the same flaw for
// some real pair of target timezones.
//
// tests.resolve_current_target_dates(p_schedule_id) (migrations_v2/
// 202608300900_..._phase4_assignment_timezone_window.sql) is now the single
// source of candidate dates: it resolves the schedule's REAL current
// targets, reads each one's own effective timezone (device_timezone, or the
// schedule's timezone as a fallback - the schedule's timezone never
// determines candidate dates on its own anymore), computes each one's real
// current local date, and returns the distinct dates that are both
// currently relevant (a one_time schedule only ever returns start_date
// itself, and only once at least one real target is actually on it; daily/
// recurring returns every distinct date its real targets currently occupy)
// and inside [start_date, end_date]. testsNotificationWorker.js's own
// occurrence-generation phase calls this exact same function for this exact
// same decision (item 3) - there is exactly one place this logic lives, so
// the on-demand and worker-driven paths can never disagree, and neither can
// ever generate an occurrence for a date nobody is actually on yet.

// Round 3 hardening (item 2): this used to read `schedule.status` (a value
// the CALLER fetched at some earlier, now-stale point) and query
// resolve_current_target_dates() BEFORE opening any transaction/lock at
// all - a concurrent PATCH/DELETE (both take `for update` on the schedule
// row, see backend/src/routes/tests.js) could commit ANYWHERE in that
// window: after status/dates were read here but before generate/materialize
// ran below. Depending on exactly when, that could mean generating an
// occurrence for a date the schedule's NEW range no longer includes (a
// controlled exception from tests.generate_test_schedule_occurrence turning
// into an uncontrolled 500 at the caller), or creating one under a schedule
// that had JUST been paused/cancelled, or a snapshot frozen from the OLD
// target configuration.
//
// The fix: lock the schedule row FIRST, with `select ... for share`, as the
// very first statement of ONE transaction that covers the ENTIRE call - the
// status check, resolve_current_target_dates() (which itself re-reads
// tests.test_schedules internally, and now sees this SAME already-locked,
// necessarily-fresh row), and every generate+materialize call below, all
// commit or roll back together. A concurrent PATCH/DELETE's own `for
// update` simply queues behind our `for share` until we commit - nothing
// about this schedule (status, start/end date, targets) can change out from
// under this call anymore, so a stale-candidate-date exception is no longer
// reachable, and there is no unmaterialized in-between state where an
// occurrence could be created against a configuration this call never
// actually saw. Lock order stays schedule -> occurrence -> assignment:
// tests.generate_test_schedule_occurrence()/tests.materialize_test_
// assignments_for_occurrence() only ever take their own occurrence-level
// `for update` AFTER this schedule-level `for share` is already held.
//
// pool: the real pg Pool (every call site passes the module-level `pool`
// from db.js, never an already-open transaction client - this call gets its
// OWN single connection/transaction here, borrowed and released within this
// one call).
// schedule: a row from tests.test_schedules - only `.id` is actually read
// now (status is re-read fresh, under lock, below); callers may still pass
// whatever row shape they already have on hand.
// Returns an array of occurrence ids actually ensured to exist this call
// (empty if the schedule isn't active or no real target currently needs a
// date) - never a single nullable id, since more than one date can
// genuinely be "current" at once (see header).
export async function ensureCurrentOccurrence(pool, schedule) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const scheduleResult = await client.query(`select * from tests.test_schedules where id = $1 for share`, [schedule.id]);
      const freshSchedule = scheduleResult.rows[0];
      if (!freshSchedule || freshSchedule.status !== "active") {
        await client.query("commit");
        return [];
      }

      const datesResult = await client.query(
        `select local_date from tests.resolve_current_target_dates($1) order by local_date`,
        [schedule.id],
      );
      const candidateDates = datesResult.rows.map((row) => row.local_date);
      if (!candidateDates.length) {
        await client.query("commit");
        return [];
      }

      const occurrenceIds = [];
      for (const targetDate of candidateDates) {
        const occurrenceResult = await client.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [schedule.id, targetDate]);
        const occurrenceId = occurrenceResult.rows[0].id;
        await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrenceId]);
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

// Phase 4 (per-athlete timezone-correct windows): the ONLY "is this open"
// check left in the app - every reader gates on THIS assignment's own
// opens_at/closes_at (computed at materialization time in the athlete's own
// effective timezone), never a shared occurrence-level reference window.
// The old occurrence-level equivalent (occurrenceIsOpen) has been removed:
// once the coach Today group header (the one remaining caller) stopped
// treating the occurrence's own window as if it applied to everyone (see
// backend/src/routes/tests.js's loadScheduleGroup), nothing in the app
// needed it anymore.
export function assignmentIsOpen(assignment, now = new Date()) {
  if (assignment.status === "cancelled") return false;
  const opensAt = new Date(assignment.opens_at);
  const closesAt = new Date(assignment.closes_at);
  return now >= opensAt && now <= closesAt;
}
