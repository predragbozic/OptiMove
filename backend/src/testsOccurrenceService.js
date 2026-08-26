// On-demand occurrence/materialization for the Tests module (Phase 2).
// There is no cron/worker yet (explicitly out of scope) - Today/athlete/
// check-in endpoints call ensureCurrentOccurrence() themselves, right before
// they need "today's" (or a one-time schedule's single) occurrence to exist.
// Safe for repeated/parallel calls: it only ever calls the real Phase 1
// functions (tests.generate_test_schedule_occurrence,
// tests.materialize_test_assignments_for_occurrence), which are themselves
// already idempotent/lock-protected - no new locking or state is invented
// here.
//
// Date math is always done IN POSTGRES, in the schedule's own IANA timezone
// (`now() at time zone $1`), never in JS with the server's local clock -
// this is what makes "today" mean the same calendar date for the schedule's
// timezone regardless of which timezone the backend process itself runs in.

// pool: the real pg Pool (every call site passes the module-level `pool`
// from db.js, never an already-open transaction client - generate +
// materialize get their OWN single connection/transaction here, borrowed
// and released within this one call).
// schedule: a full row from tests.test_schedules (needs id, status,
// schedule_kind, timezone, start_date, end_date).
// Returns the occurrence id, or null if there is nothing to show right now
// (schedule not active, not yet started, already past its end_date/its own
// one_time date, or - see below - concurrently deleted).
export async function ensureCurrentOccurrence(pool, schedule) {
  if (schedule.status !== "active") return null;

  const client = await pool.connect();
  try {
    // Always computed, for BOTH schedule kinds - a one_time schedule's
    // single occurrence is only ever "today's" on its own start_date,
    // exactly like a daily schedule's occurrence is only ever "today's" on
    // today. Before that date there is nothing to show yet; once it has
    // passed, this function stops surfacing it as current (its own row,
    // once generated, remains reachable through History/Results - this
    // function only governs what counts as "today" for the Today view).
    const localDateResult = await client.query(`select (now() at time zone $1)::date as local_date`, [schedule.timezone]);
    const localToday = localDateResult.rows[0].local_date;

    let targetDate;
    if (schedule.schedule_kind === "one_time") {
      if (localToday !== schedule.start_date) return null;
      targetDate = schedule.start_date;
    } else {
      targetDate = localToday;
    }

    if (targetDate < schedule.start_date) return null;
    if (schedule.end_date && targetDate > schedule.end_date) return null;

    // Generate + materialize share ONE transaction on ONE connection, and
    // tests.generate_test_schedule_occurrence() (see
    // migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql)
    // now takes `for share` on the schedule row while reading it - this
    // serializes against a concurrent PATCH/DELETE's `for update` on that
    // same row (backend/src/routes/tests.js), instead of racing it.
    await client.query("begin");
    try {
      const occurrenceResult = await client.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [schedule.id, targetDate]);
      const occurrenceId = occurrenceResult.rows[0].id;
      await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrenceId]);
      await client.query("commit");
      return occurrenceId;
    } catch (error) {
      await client.query("rollback").catch(() => {});
      // The schedule row may have just been physically deleted by a
      // concurrent DELETE that won the race for the row lock (see the
      // DELETE handler in backend/src/routes/tests.js) - once that DELETE
      // commits, this call's blocked `for share` read simply finds no row
      // left and the function raises exactly this controlled error. That is
      // "nothing to show right now" here, never a 500 - the schedule is
      // gone, so no occurrence/assignment must ever be created under it.
      if (error?.code === "P0001" && /does not exist/.test(error.message || "")) return null;
      throw error;
    }
  } finally {
    client.release();
  }
}

// Whether an occurrence is currently accepting submissions. Deliberately
// computed from opens_at/closes_at at read time rather than a stored
// "open"/"closed" status column - Phase 1 never added a time-driven status
// transition (there is no cron to run it), so the timestamps are the only
// real source of truth for "is this open right now".
export function occurrenceIsOpen(occurrence, now = new Date()) {
  if (occurrence.status === "cancelled") return false;
  const opensAt = new Date(occurrence.opens_at);
  const closesAt = new Date(occurrence.closes_at);
  return now >= opensAt && now <= closesAt;
}

// Phase 4 (per-athlete timezone-correct windows): the real, per-assignment
// equivalent of occurrenceIsOpen above - every "is this open" decision in
// the app must use THIS assignment's own opens_at/closes_at (computed at
// materialization time in the athlete's own effective timezone, see
// migrations_v2/202608300900_..._phase4_assignment_timezone_window.sql),
// never the parent occurrence's shared reference window, or two athletes
// under the same occurrence with different device timezones would
// incorrectly see/be gated by the exact same absolute instant.
// occurrenceIsOpen() itself is kept (unremoved) as the coarse,
// schedule-timezone reference check some readers still legitimately use
// (e.g. the coach Today group header, which has no single "the" athlete).
export function assignmentIsOpen(assignment, now = new Date()) {
  if (assignment.status === "cancelled") return false;
  const opensAt = new Date(assignment.opens_at);
  const closesAt = new Date(assignment.closes_at);
  return now >= opensAt && now <= closesAt;
}
