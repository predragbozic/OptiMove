// Phase 3A: the periodic, idempotent worker that replaces "someone has to
// open the Tests page" as the trigger for occurrence/assignment generation
// and WELLNESS notifications. Meant to be run as a one-shot job every few
// minutes (see testsNotificationWorkerCli.js) - never a setInterval() inside
// the web server (see that file's own header comment for why).
//
// Five phases, run in order, every cycle:
//   1. Occurrence generation - reuses the existing, already-safe
//      ensureCurrentOccurrence() (testsOccurrenceService.js), the same
//      function Today/check-in routes already call on demand. This worker
//      only decides WHICH active schedules are worth calling it for this
//      cycle (their own opens_time has actually arrived, in their own
//      timezone) - it invents no new generation/locking logic.
//   2. Athlete invitation - one in-app notification per (occurrence,
//      assignment) once its window has opened, if not already completed.
//   3. Athlete reminder - one in-app notification per (occurrence,
//      assignment) once `due_at (or closes_at) - offset` has passed, if
//      still not completed and the window hasn't closed yet.
//   4. Coach live digest - ONE notification row per (occurrence, recipient),
//      recomputed and updated in place every cycle while the occurrence is
//      open - never a new row per cycle.
//   5. Final coach digest - ONE notification per (occurrence, recipient),
//      once, after the occurrence has closed.
//
// Every actual send/update happens in its own single-recipient transaction
// (sendOneShotNotification / upsertDigestNotification below) - one
// recipient's DB error never rolls back or blocks another's, and can always
// be safely retried on the next cycle (see those two functions' own
// comments for exactly how).
//
// tests.test_schedule_notification_rules and
// test_schedule_notification_dispatches already existed before this phase
// (migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql,
// Section 4) - this file is the "future worker" that migration's own
// comment explicitly anticipated. The only schema addition this phase makes
// is one additive column (migrations_v2/202608270900_..., see that file for
// why) linking a dispatch row to the app_notifications row it produced.
import { ensureCurrentOccurrence } from "./testsOccurrenceService.js";
import { emitRealtimeEvent } from "./realtime.js";
import { WELLNESS_INJURY_PARAMETER_ID } from "./routes/tests.js";

const DEDUPE_KEY_VERSION = "v1";

// Deterministic and versioned (section 10 of the spec): a pure function of
// which logical event this is, never random/time-based - the same event
// always maps to the same key, which is exactly what makes `on conflict
// (dedupe_key)` a correct duplicate guard across parallel/repeated worker
// runs. The "v1" prefix exists so a future change to what counts as "the
// same event" can ship as v2 without colliding with old rows.
function buildDedupeKey({ kind, occurrenceId, assignmentId, recipientUserId }) {
  return `${DEDUPE_KEY_VERSION}:${kind}:${occurrenceId}:${assignmentId || "-"}:${recipientUserId}`;
}

function formatTimeInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  } catch {
    // Invalid/unsupported timezone string - fall back rather than throw
    // mid-cycle over a single malformed schedule.
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
}

async function computeOccurrenceCounts(client, occurrenceId) {
  const result = await client.query(
    `select
       count(*)::int as total,
       count(*) filter (where asg.status = 'completed')::int as completed,
       count(*) filter (where asg.status = 'pending')::int as pending,
       count(*) filter (where asg.status = 'missed')::int as missed,
       count(*) filter (where inj.value_boolean = true)::int as injuries
     from tests.test_assignments asg
     left join tests.test_assessments ta
       on ta.standalone_assignment_id = asg.id and ta.superseded_by_assessment_id is null and ta.status = 'completed'
     left join tests.test_assessment_values inj
       on inj.assessment_id = ta.id and inj.test_parameter_id = $2
     where asg.occurrence_id = $1`,
    [occurrenceId, WELLNESS_INJURY_PARAMETER_ID],
  );
  return result.rows[0];
}

// Shared by athlete_invitation / athlete_reminder / final_digest - every one
// of these is a ONE-SHOT send: happens at most once per (occurrence,
// assignment-or-null, recipient), ever, never updated afterward. Safety
// under retry/two-parallel-workers comes entirely from
// `on conflict (dedupe_key) do nothing`: whichever transaction's INSERT
// commits first wins the row: a concurrent/later attempt for the exact same
// dedupe_key gets 0 rows back and returns `false` (nothing to do), never a
// duplicate notification, never a raised constraint-violation error either.
//
// buildContent runs INSIDE this transaction, on this transaction's own
// client, specifically so a query it needs (final_digest's occurrence
// counts) reads the DB in the same transactional snapshot the dispatch
// claim and the app_notifications insert both commit in - no window where
// "we claimed the send" and "we computed what to send" could see different
// data.
//
// If the app_notifications insert (or anything after the claim) throws, the
// whole transaction rolls back - the dispatch claim row is undone too, so
// this exact event is untouched and will be retried cleanly on the next
// cycle (never left "claimed but never actually sent").
async function sendOneShotNotification(pool, { occurrenceId, assignmentId = null, notificationKind, recipientUserId, dedupeKey, buildContent, entityType, entityId, metadata }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query(
      `insert into tests.test_schedule_notification_dispatches
         (occurrence_id, assignment_id, notification_kind, recipient_user_id, dedupe_key, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (dedupe_key) do nothing
       returning id`,
      [occurrenceId, assignmentId, notificationKind, recipientUserId, dedupeKey],
    );
    if (!claim.rows[0]) {
      await client.query("rollback");
      return false;
    }
    const dispatchId = claim.rows[0].id;
    const { title, body } = await buildContent(client);
    const notificationType = `test_${notificationKind}`;
    const notificationResult = await client.query(
      `insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, metadata)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [recipientUserId, notificationType, title, body, entityType, entityId, JSON.stringify(metadata || {})],
    );
    const notificationId = notificationResult.rows[0].id;
    await client.query(
      `update tests.test_schedule_notification_dispatches
       set status = 'sent', sent_at = now(), app_notification_id = $2, updated_at = now()
       where id = $1`,
      [dispatchId, notificationId],
    );
    await client.query("commit");
    emitRealtimeEvent(recipientUserId, "notifications_changed", { notificationId, type: notificationType });
    return true;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// coach_digest's own send path - the one notification kind in this phase
// that is NOT one-shot: the same (occurrence, recipient) row is recomputed
// and updated IN PLACE every cycle the occurrence stays open, never
// reinserted. Claiming works the same way as sendOneShotNotification's
// (insert-on-conflict-do-nothing first), but when the claim itself conflicts
// (a row already exists - the normal case on the 2nd+ cycle) this locks that
// EXISTING row with `for update` instead of walking away, so two workers
// racing to update the same digest still serialize correctly instead of
// both reading a stale app_notification_id and both trying to insert a
// second app_notifications row.
//
// "Unchanged" is detected by comparing the newly-computed title/body
// against the CURRENTLY STORED app_notifications row's own title/body
// (never a separately-tracked counts column) - this is what makes an
// injury-count change (surfaced only in the body text, no dedicated column
// for it) correctly trigger an update with no extra schema needed, and
// exactly matches "besmislen UPDATE" being defined as "the coach would see
// no different text" rather than "some internal counter didn't move".
async function upsertDigestNotification(pool, { occurrenceId, notificationKind, recipientUserId, dedupeKey, buildContent, entityType, entityId, metadata }) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await client.query(
      `insert into tests.test_schedule_notification_dispatches
         (occurrence_id, notification_kind, recipient_user_id, dedupe_key, status)
       values ($1, $2, $3, $4, 'pending')
       on conflict (dedupe_key) do nothing
       returning id, app_notification_id`,
      [occurrenceId, notificationKind, recipientUserId, dedupeKey],
    );
    let dispatchRow = claim.rows[0];
    if (!dispatchRow) {
      const locked = await client.query(
        `select id, app_notification_id from tests.test_schedule_notification_dispatches where dedupe_key = $1 for update`,
        [dedupeKey],
      );
      dispatchRow = locked.rows[0];
    }

    const counts = await computeOccurrenceCounts(client, occurrenceId);
    const { title, body } = buildContent(counts);

    let existingTitle = null;
    let existingBody = null;
    if (dispatchRow.app_notification_id) {
      const existing = await client.query(`select title, body from public.app_notifications where id = $1`, [dispatchRow.app_notification_id]);
      existingTitle = existing.rows[0]?.title ?? null;
      existingBody = existing.rows[0]?.body ?? null;
    }

    if (dispatchRow.app_notification_id && existingTitle === title && existingBody === body) {
      // Nothing a coach would see differently - no UPDATE to either table,
      // no read/unread state touched, no new dispatch evidence.
      await client.query("rollback");
      return "unchanged";
    }

    const notificationType = `test_${notificationKind}`;
    let notificationId = dispatchRow.app_notification_id;
    if (notificationId) {
      // In place - read_at is deliberately never touched here, so a coach
      // who already read an earlier version of this digest doesn't have it
      // silently flip back to unread just because the counts moved.
      await client.query(`update public.app_notifications set title = $2, body = $3, metadata = $4::jsonb where id = $1`, [notificationId, title, body, JSON.stringify(metadata || {})]);
    } else {
      const inserted = await client.query(
        `insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, metadata)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb) returning id`,
        [recipientUserId, notificationType, title, body, entityType, entityId, JSON.stringify(metadata || {})],
      );
      notificationId = inserted.rows[0].id;
    }

    await client.query(
      `update tests.test_schedule_notification_dispatches
       set status = 'sent', sent_at = coalesce(sent_at, now()), app_notification_id = $2,
           completed_count = $3, total_count = $4, last_computed_at = now(), updated_at = now()
       where id = $1`,
      [dispatchRow.id, notificationId, counts.completed, counts.total],
    );
    await client.query("commit");
    emitRealtimeEvent(recipientUserId, "notifications_changed", { notificationId, type: notificationType });
    return "updated";
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ------------------------------------------------------------
// Phase 1: occurrence/assignment generation
// ------------------------------------------------------------

// Everything ensureCurrentOccurrence() itself needs (status='active',
// start/end date window, one_time-matches-its-own-date) is already
// re-checked safely inside it - this query only adds the ONE thing that
// service doesn't decide on its own: whether opens_time (a time-of-day, not
// just a date) has actually arrived yet in the schedule's own timezone. A
// schedule matched here but raced by a concurrent PATCH/DELETE simply comes
// back null from ensureCurrentOccurrence (already handled there) and is
// counted as "skipped", never an error.
async function runOccurrenceGenerationPhase(pool, summary) {
  const result = await pool.query(
    `select sch.*
     from tests.test_schedules sch
     where sch.status = 'active'
       and (
         (sch.schedule_kind = 'one_time' and (now() at time zone sch.timezone)::date = sch.start_date)
         or (sch.schedule_kind = 'recurring'
             and (now() at time zone sch.timezone)::date >= sch.start_date
             and (sch.end_date is null or (now() at time zone sch.timezone)::date <= sch.end_date))
       )
       and (now() at time zone sch.timezone)::time >= sch.opens_time`,
  );
  summary.occurrences.schedulesChecked = result.rowCount;
  for (const schedule of result.rows) {
    const occurrenceId = await ensureCurrentOccurrence(pool, schedule);
    if (occurrenceId) summary.occurrences.generated += 1;
    else summary.occurrences.skipped += 1;
  }
}

// ------------------------------------------------------------
// Phase 2: athlete invitation
// ------------------------------------------------------------

async function runAthleteInvitationPhase(pool, now, summary) {
  const result = await pool.query(
    `select asg.id as assignment_id, a.user_id as recipient_user_id,
            o.id as occurrence_id, o.closes_at, o.due_at,
            sch.id as schedule_id, sch.timezone
     from tests.test_assignments asg
     join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
     join tests.test_schedules sch on sch.id = o.schedule_id
     join public.athletes a on a.id = asg.athlete_id
     join tests.test_schedule_notification_rules r
       on r.schedule_id = sch.id and r.notification_kind = 'athlete_invitation' and r.enabled = true
     where sch.status = 'active'
       and o.status <> 'cancelled'
       and asg.status not in ('completed', 'cancelled')
       and o.opens_at <= $1
       and o.closes_at >= $1`,
    [now],
  );
  for (const row of result.rows) {
    summary.invitations.attempted += 1;
    if (!row.recipient_user_id) {
      // No linked user account for this athlete - never a crash, just
      // reported so the coach knows this athlete can't be invited in-app.
      summary.invitations.noRecipient += 1;
      continue;
    }
    const dedupeKey = buildDedupeKey({ kind: "athlete_invitation", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, recipientUserId: row.recipient_user_id });
    const effectiveDue = row.due_at || row.closes_at;
    try {
      const sent = await sendOneShotNotification(pool, {
        occurrenceId: row.occurrence_id,
        assignmentId: row.assignment_id,
        notificationKind: "athlete_invitation",
        recipientUserId: row.recipient_user_id,
        dedupeKey,
        buildContent: async () => ({
          title: "WELLNESS check-in is available",
          body: `Please complete today's WELLNESS questionnaire before ${formatTimeInZone(new Date(effectiveDue), row.timezone)}.`,
        }),
        entityType: "test_assignment",
        entityId: row.assignment_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id, assignmentId: row.assignment_id },
      });
      if (sent) summary.invitations.sent += 1;
      else summary.invitations.alreadySent += 1;
    } catch (error) {
      summary.invitations.failed += 1;
      summary.errors.push({ stage: "athlete_invitation", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, message: error.message });
    }
  }
}

// ------------------------------------------------------------
// Phase 3: athlete reminder
// ------------------------------------------------------------

async function runAthleteReminderPhase(pool, now, summary) {
  const result = await pool.query(
    `select asg.id as assignment_id, a.user_id as recipient_user_id,
            o.id as occurrence_id, o.closes_at, o.due_at,
            sch.id as schedule_id, sch.timezone
     from tests.test_assignments asg
     join tests.test_schedule_occurrences o on o.id = asg.occurrence_id
     join tests.test_schedules sch on sch.id = o.schedule_id
     join public.athletes a on a.id = asg.athlete_id
     join tests.test_schedule_notification_rules r
       on r.schedule_id = sch.id and r.notification_kind = 'athlete_reminder' and r.enabled = true
     where sch.status = 'active'
       and o.status <> 'cancelled'
       and asg.status not in ('completed', 'cancelled')
       and $1 <= o.closes_at
       and $1 >= (coalesce(o.due_at, o.closes_at) - (r.reminder_offset_minutes || ' minutes')::interval)`,
    [now],
  );
  for (const row of result.rows) {
    summary.reminders.attempted += 1;
    if (!row.recipient_user_id) {
      summary.reminders.noRecipient += 1;
      continue;
    }
    const dedupeKey = buildDedupeKey({ kind: "athlete_reminder", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, recipientUserId: row.recipient_user_id });
    const effectiveDue = row.due_at || row.closes_at;
    try {
      const sent = await sendOneShotNotification(pool, {
        occurrenceId: row.occurrence_id,
        assignmentId: row.assignment_id,
        notificationKind: "athlete_reminder",
        recipientUserId: row.recipient_user_id,
        dedupeKey,
        buildContent: async () => ({
          title: "WELLNESS reminder",
          body: `Your questionnaire is still waiting. Please complete it before ${formatTimeInZone(new Date(effectiveDue), row.timezone)}.`,
        }),
        entityType: "test_assignment",
        entityId: row.assignment_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id, assignmentId: row.assignment_id },
      });
      if (sent) summary.reminders.sent += 1;
      else summary.reminders.alreadySent += 1;
    } catch (error) {
      summary.reminders.failed += 1;
      summary.errors.push({ stage: "athlete_reminder", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, message: error.message });
    }
  }
}

// ------------------------------------------------------------
// Phase 4: coach live digest
// ------------------------------------------------------------

// Recipient is deliberately only ever schedule.created_by_user_id this phase
// (section 8 of the spec) - never every club/team coach, to avoid turning
// one occurrence into a spam blast. Gated on schedule.status = 'active'
// specifically (not merely "not cancelled") - a paused schedule stops
// prompting new athlete activity, and live reporting is paused right along
// with it; final_digest below uses the broader "not cancelled" gate since a
// closing summary is read-only reporting, not a new prompt.
async function runCoachDigestPhase(pool, now, summary) {
  const result = await pool.query(
    `select o.id as occurrence_id, sch.id as schedule_id, sch.created_by_user_id
     from tests.test_schedule_occurrences o
     join tests.test_schedules sch on sch.id = o.schedule_id
     join tests.test_schedule_notification_rules r
       on r.schedule_id = sch.id and r.notification_kind = 'coach_digest' and r.enabled = true
     where sch.status = 'active'
       and o.status <> 'cancelled'
       and o.opens_at <= $1
       and $1 <= o.closes_at`,
    [now],
  );
  for (const row of result.rows) {
    summary.coachDigests.attempted += 1;
    const dedupeKey = buildDedupeKey({ kind: "coach_digest", occurrenceId: row.occurrence_id, assignmentId: null, recipientUserId: row.created_by_user_id });
    try {
      const outcome = await upsertDigestNotification(pool, {
        occurrenceId: row.occurrence_id,
        notificationKind: "coach_digest",
        recipientUserId: row.created_by_user_id,
        dedupeKey,
        buildContent: (counts) => ({
          title: "WELLNESS completion update",
          body: `${counts.completed}/${counts.total} completed · ${counts.pending} pending · ${counts.injuries} injury report${counts.injuries === 1 ? "" : "s"}`,
        }),
        entityType: "test_occurrence",
        entityId: row.occurrence_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id },
      });
      if (outcome === "updated") summary.coachDigests.sent += 1;
      else summary.coachDigests.unchanged += 1;
    } catch (error) {
      summary.coachDigests.failed += 1;
      summary.errors.push({ stage: "coach_digest", occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, message: error.message });
    }
  }
}

// ------------------------------------------------------------
// Phase 5: final coach digest
// ------------------------------------------------------------

async function runFinalDigestPhase(pool, now, summary) {
  const result = await pool.query(
    `select o.id as occurrence_id, sch.id as schedule_id, sch.created_by_user_id
     from tests.test_schedule_occurrences o
     join tests.test_schedules sch on sch.id = o.schedule_id
     join tests.test_schedule_notification_rules r
       on r.schedule_id = sch.id and r.notification_kind = 'final_digest' and r.enabled = true
     where sch.status <> 'cancelled'
       and o.status <> 'cancelled'
       and o.closes_at <= $1`,
    [now],
  );
  for (const row of result.rows) {
    summary.finalDigests.attempted += 1;
    const dedupeKey = buildDedupeKey({ kind: "final_digest", occurrenceId: row.occurrence_id, assignmentId: null, recipientUserId: row.created_by_user_id });
    try {
      const sent = await sendOneShotNotification(pool, {
        occurrenceId: row.occurrence_id,
        assignmentId: null,
        notificationKind: "final_digest",
        recipientUserId: row.created_by_user_id,
        dedupeKey,
        buildContent: async (client) => {
          const counts = await computeOccurrenceCounts(client, row.occurrence_id);
          return {
            title: "WELLNESS final summary",
            body: `${counts.completed}/${counts.total} completed · ${counts.missed} missed · ${counts.injuries} injury report${counts.injuries === 1 ? "" : "s"}`,
          };
        },
        entityType: "test_occurrence",
        entityId: row.occurrence_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id },
      });
      if (sent) summary.finalDigests.sent += 1;
      else summary.finalDigests.alreadySent += 1;
    } catch (error) {
      summary.finalDigests.failed += 1;
      summary.errors.push({ stage: "final_digest", occurrenceId: row.occurrence_id, scheduleId: row.schedule_id, message: error.message });
    }
  }
}

// ------------------------------------------------------------
// Orchestrator
// ------------------------------------------------------------

// `now` drives every notification-timing decision (invitation/reminder/
// digest windows all compare against absolute occurrence timestamps, so an
// explicit, testable instant works correctly for all of them). Occurrence
// GENERATION is the one exception: ensureCurrentOccurrence()/
// generate_test_schedule_occurrence() always use Postgres's own now()
// internally (by design - date math belongs in Postgres, see
// testsOccurrenceService.js's header comment) and have no override, so that
// one phase is always driven by the real wall clock regardless of what
// `now` is passed here.
export async function processTestNotificationCycle({ now = new Date(), pool } = {}) {
  if (!pool) throw new Error("processTestNotificationCycle requires a pool.");
  const summary = {
    startedAt: now.toISOString(),
    occurrences: { schedulesChecked: 0, generated: 0, skipped: 0 },
    invitations: { attempted: 0, sent: 0, alreadySent: 0, noRecipient: 0, failed: 0 },
    reminders: { attempted: 0, sent: 0, alreadySent: 0, noRecipient: 0, failed: 0 },
    coachDigests: { attempted: 0, sent: 0, unchanged: 0, failed: 0 },
    finalDigests: { attempted: 0, sent: 0, alreadySent: 0, failed: 0 },
    errors: [],
  };

  await runOccurrenceGenerationPhase(pool, summary);
  await runAthleteInvitationPhase(pool, now, summary);
  await runAthleteReminderPhase(pool, now, summary);
  await runCoachDigestPhase(pool, now, summary);
  await runFinalDigestPhase(pool, now, summary);

  summary.finishedAt = new Date().toISOString();
  summary.durationMs = new Date(summary.finishedAt).getTime() - now.getTime();
  return summary;
}
