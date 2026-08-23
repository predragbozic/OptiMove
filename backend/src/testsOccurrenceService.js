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

// schedule: a full row from tests.test_schedules (needs id, status,
// schedule_kind, timezone, start_date, end_date).
// Returns the occurrence id, or null if there is nothing to show right now
// (schedule not active, not yet started, or already past its end_date).
export async function ensureCurrentOccurrence(client, schedule) {
  if (schedule.status !== "active") return null;

  let targetDate;
  if (schedule.schedule_kind === "one_time") {
    targetDate = schedule.start_date;
  } else {
    const localDateResult = await client.query(`select (now() at time zone $1)::date as local_date`, [schedule.timezone]);
    targetDate = localDateResult.rows[0].local_date;
  }

  if (targetDate < schedule.start_date) return null;
  if (schedule.end_date && targetDate > schedule.end_date) return null;

  const occurrenceResult = await client.query(`select tests.generate_test_schedule_occurrence($1, $2) as id`, [schedule.id, targetDate]);
  const occurrenceId = occurrenceResult.rows[0].id;
  await client.query(`select tests.materialize_test_assignments_for_occurrence($1)`, [occurrenceId]);
  return occurrenceId;
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
