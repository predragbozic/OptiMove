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
// Date math is always done IN POSTGRES, in the schedule's own IANA timezone
// (`now() at time zone $1`), never in JS with the server's local clock -
// this is what makes "today" mean the same calendar date for the schedule's
// timezone regardless of which timezone the backend process itself runs in.
//
// Phase 4 correction: this used to compute exactly ONE "current" date
// (today, in the schedule's own timezone) and generate/materialize a single
// occurrence for it. That is not enough - an athlete significantly AHEAD of
// the schedule's own reference timezone (e.g. a Europe/Belgrade schedule,
// an athlete on Pacific/Kiritimati, UTC+14) can already be on their own
// correct calendar date while the schedule's own reference clock is still
// on the PREVIOUS day, so no occurrence (and therefore no assignment) would
// exist for them at all. This function now always considers the adjacent
// day too (one_time: the day BEFORE start_date; daily: the day AFTER
// today), for every call, unconditionally (no time-of-day gating here -
// that stays exclusively in testsNotificationWorker.js's own Phase 1 SQL
// pre-filter, which decides WHETHER to bother calling this function on a
// given cycle at all; once called, this function has always tried
// whatever "today" needed regardless of opens_time, and that is preserved
// unchanged for the interactive/on-demand callers below). The realistic
// worldwide timezone spread (UTC-12..UTC+14, ~26h) never needs more than
// one adjacent day of lookahead - see migrations_v2/202608300900_..._
// phase4_assignment_timezone_window.sql for the full reasoning, and
// tests.materialize_test_assignments_for_occurrence() for how each
// snapshotted athlete only actually gets assigned once THEIR OWN local day
// reaches whichever occurrence's scheduled_date is correct for them (never
// creating one occurrence per athlete - still exactly per (schedule,
// date)).

// pool: the real pg Pool (every call site passes the module-level `pool`
// from db.js, never an already-open transaction client - generate +
// materialize get their OWN single connection/transaction here, borrowed
// and released within this one call).
// schedule: a full row from tests.test_schedules (needs id, status,
// schedule_kind, timezone, start_date, end_date, opens_time - opens_time
// is not read here, only by the worker's own pre-filter).
// Returns an array of occurrence ids actually ensured to exist this call
// (empty if the schedule isn't active or no candidate date currently
// applies) - never a single nullable id, since more than one date can
// genuinely be "current" at once (see header).
export async function ensureCurrentOccurrence(pool, schedule) {
  if (schedule.status !== "active") return [];

  const client = await pool.connect();
  try {
    const localDateResult = await client.query(
      `select (now() at time zone $1)::date as local_today,
              (now() at time zone $1)::date + 1 as local_tomorrow`,
      [schedule.timezone],
    );
    const { local_today: localToday, local_tomorrow: localTomorrow } = localDateResult.rows[0];

    // One-time: only ever the ONE fixed date (start_date === end_date,
    // enforced at the schema level). Triggers when the schedule's own zone
    // is EITHER exactly on start_date (the normal case) OR its own
    // TOMORROW already equals start_date (equivalently: the schedule's own
    // zone is currently one day BEFORE start_date) - this second case is
    // what an athlete significantly AHEAD of the schedule's own timezone
    // needs: per this file's own worked example (Europe/Belgrade schedule,
    // Pacific/Kiritimati athlete, opens 06:00), the exact instant the
    // athlete's own start_date-06:00 arrives, the SCHEDULE's own zone is
    // still one full day behind (start_date - 1) - "local_tomorrow ===
    // start_date" is the correct, direct way to detect that, not "local_
    // yesterday === start_date" (an earlier draft of this function had
    // that backwards - caught by a real cross-timezone test, see
    // backend/tests/tests-athlete-device-timezone.test.mjs). No day-AFTER
    // catch-up branch is needed: an athlete BEHIND the schedule's own
    // timezone still has their own start_date-labeled day arrive later
    // ON THE SAME schedule-zone calendar day the normal "today" trigger
    // already covers, never crossing into the day after.
    // Daily/recurring: today and tomorrow, each clamped to [start_date,
    // end_date] - "svaki lokalni kalendarski dan sportiste od start_date do
    // end_date" applies per-athlete inside materialize_test_assignments_
    // for_occurrence(), not here; this only decides which OCCURRENCE rows
    // (dates) could possibly be needed by anyone right now.
    const candidateDates = [];
    if (schedule.schedule_kind === "one_time") {
      if (localToday === schedule.start_date || localTomorrow === schedule.start_date) candidateDates.push(schedule.start_date);
    } else {
      const inRange = (d) => d >= schedule.start_date && (!schedule.end_date || d <= schedule.end_date);
      if (inRange(localToday)) candidateDates.push(localToday);
      if (inRange(localTomorrow)) candidateDates.push(localTomorrow);
    }
    if (!candidateDates.length) return [];

    const occurrenceIds = [];
    for (const targetDate of candidateDates) {
      // Generate + materialize share ONE transaction on ONE connection, and
      // tests.generate_test_schedule_occurrence() (see
      // migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql)
      // now takes `for share` on the schedule row while reading it - this
      // serializes against a concurrent PATCH/DELETE's `for update` on that
      // same row (backend/src/routes/tests.js), instead of racing it. Each
      // candidate date gets its own transaction, so one date's failure
      // never rolls back a date that already succeeded.
      await client.query("begin");
      try {
        const occurrenceResult = await client.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [schedule.id, targetDate]);
        const occurrenceId = occurrenceResult.rows[0].id;
        await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrenceId]);
        await client.query("commit");
        occurrenceIds.push(occurrenceId);
      } catch (error) {
        await client.query("rollback").catch(() => {});
        // The schedule row may have just been physically deleted by a
        // concurrent DELETE that won the race for the row lock (see the
        // DELETE handler in backend/src/routes/tests.js) - once that DELETE
        // commits, this call's blocked `for share` read simply finds no row
        // left and the function raises exactly this controlled error. That
        // is "nothing to show right now" for THIS date, never a 500 - the
        // schedule is gone, so no occurrence/assignment must ever be
        // created under it; still try any remaining candidate dates in case
        // this was itself a transient race, though realistically none of
        // them will succeed either once the schedule is truly gone.
        if (error?.code === "P0001" && /does not exist/.test(error.message || "")) continue;
        throw error;
      }
    }
    return occurrenceIds;
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
