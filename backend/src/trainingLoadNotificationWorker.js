// The periodic, idempotent worker for training_load.external_schedules -
// occurrence/assignment generation plus athlete invitation/reminder and a
// coach final-digest notification. A structural copy of
// testsNotificationWorker.js's own shape, simplified: no per-schedule
// notification-rule toggles (always-on invitation + reminder), and no
// coach "live digest" phase - Training Load already has a live, read-only
// weekly view (GET /weekly, extended for the external source) that shows
// an occurrence's current state natively, so a second, redundant digest
// notification recomputed every cycle would be scope creep, not a gap
// this worker needs to fill (see the design's own note on this cut).
//
// Meant to run as a one-shot job every few minutes (see
// trainingLoadNotificationWorkerCli.js) - never a setInterval() inside the
// web server, same rule testsNotificationWorkerCli.js documents.
//
// One-shot sends claim directly via the already-deployed
// public.app_notifications.dedupe_key partial-unique index (migrations_v2/
// 202608280900_app_notifications_dedupe_key.sql) - no separate dispatch-
// ledger table, since (unlike WELLNESS's coach_digest) nothing here needs
// to look up and update-in-place a previously-sent notification row.
import { ensureCurrentExternalOccurrence } from "./trainingLoadOccurrenceService.js";
import { emitRealtimeEvent } from "./realtime.js";

const DEDUPE_KEY_VERSION = "v1";

function buildDedupeKey({ kind, occurrenceId, assignmentId, recipientUserId }) {
  return `${DEDUPE_KEY_VERSION}:tl_${kind}:${occurrenceId}:${assignmentId || "-"}:${recipientUserId}`;
}

function formatTimeInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
}

// INSERT ... ON CONFLICT (dedupe_key) DO NOTHING is the claim itself -
// whichever transaction's insert commits first wins the row; a concurrent/
// later attempt for the exact same dedupe_key gets 0 rows back and returns
// false (nothing to do), never a duplicate notification, never a raised
// constraint-violation error either.
async function sendOneShotNotification(pool, { recipientUserId, type, title, body, entityType, entityId, metadata, dedupeKey }) {
  const result = await pool.query(
    `insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, metadata, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [recipientUserId, type, title, body, entityType, entityId, JSON.stringify(metadata || {}), dedupeKey],
  );
  if (!result.rows[0]) return false;
  emitRealtimeEvent(recipientUserId, "notifications_changed", { notificationId: result.rows[0].id, type });
  return true;
}

async function runOccurrenceGenerationPhase(pool, summary) {
  const result = await pool.query(`select * from training_load.external_schedules where status = 'active'`);
  summary.occurrences.schedulesChecked = result.rowCount;
  for (const schedule of result.rows) {
    const occurrenceIds = await ensureCurrentExternalOccurrence(schedule, pool);
    if (occurrenceIds.length) summary.occurrences.generated += occurrenceIds.length;
    else summary.occurrences.skipped += 1;
  }
}

async function runAthleteInvitationPhase(pool, now, summary) {
  const result = await pool.query(
    `select asg.id as assignment_id, a.user_id as recipient_user_id,
            o.id as occurrence_id, asg.closes_at, asg.due_at, asg.timezone,
            sch.id as schedule_id, sch.event_name
     from training_load.external_assignments asg
     join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
     join training_load.external_schedules sch on sch.id = o.schedule_id
     join public.athletes a on a.id = asg.athlete_id
     left join training_load.external_schedule_notification_rules nr
       on nr.schedule_id = sch.id and nr.kind = 'athlete_invitation'
     where sch.status = 'active'
       and o.status <> 'cancelled'
       -- Only a genuinely actionable assignment gets invited -
       -- 'completed'/'cancelled' were already excluded; 'missed'/
       -- 'excused' are equally terminal and must never receive a "ready
       -- for RPE" invitation either (hardening correction).
       and asg.status in ('pending', 'open', 'in_progress')
       and asg.opens_at <= $1
       and asg.closes_at >= $1
       -- No row for this schedule+kind = "never configured" = the
       -- CURRENT (pre-config) always-on behavior, never a silent
       -- behavior change for a schedule created before this migration or
       -- outside the real create route.
       and coalesce(nr.enabled, true)`,
    [now],
  );
  for (const row of result.rows) {
    summary.invitations.attempted += 1;
    if (!row.recipient_user_id) {
      summary.invitations.noRecipient += 1;
      continue;
    }
    const dedupeKey = buildDedupeKey({ kind: "invitation", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, recipientUserId: row.recipient_user_id });
    const effectiveDue = row.due_at || row.closes_at;
    try {
      const sent = await sendOneShotNotification(pool, {
        recipientUserId: row.recipient_user_id,
        type: "training_load_external_invitation",
        title: "A training session is ready for RPE",
        body: `Log RPE for "${row.event_name}" before ${formatTimeInZone(new Date(effectiveDue), row.timezone)}.`,
        entityType: "training_load_external_assignment",
        entityId: row.assignment_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id, assignmentId: row.assignment_id },
        dedupeKey,
      });
      if (sent) summary.invitations.sent += 1;
      else summary.invitations.alreadySent += 1;
    } catch (error) {
      summary.invitations.failed += 1;
      summary.errors.push({ stage: "invitation", assignmentId: row.assignment_id, message: error.message });
    }
  }
}

// Fallback only, when a schedule has no athlete_reminder row at all (never
// configured - see this migration's own "absent row = current always-on
// behavior" note). A schedule created through the real form always has an
// explicit row (defaulting to this exact same value), so this constant is
// only ever reached by a fixture/schedule that bypassed the create route.
const DEFAULT_REMINDER_OFFSET_MINUTES = 60;

async function runAthleteReminderPhase(pool, now, summary) {
  const result = await pool.query(
    `select asg.id as assignment_id, a.user_id as recipient_user_id,
            o.id as occurrence_id, asg.closes_at, asg.due_at, asg.timezone,
            sch.id as schedule_id, sch.event_name
     from training_load.external_assignments asg
     join training_load.external_schedule_occurrences o on o.id = asg.occurrence_id
     join training_load.external_schedules sch on sch.id = o.schedule_id
     join public.athletes a on a.id = asg.athlete_id
     left join training_load.external_schedule_notification_rules nr
       on nr.schedule_id = sch.id and nr.kind = 'athlete_reminder'
     where sch.status = 'active'
       and o.status <> 'cancelled'
       -- Same actionable-only rule as the invitation phase above -
       -- 'missed'/'excused' must never be reminded either (hardening
       -- correction). asg.opens_at <= $1 is also new: without it, a very
       -- short window (closes_at - opens_at under the reminder offset)
       -- could satisfy the offset check below before the window has even
       -- opened yet - a reminder must never arrive before opens_at.
       and asg.status in ('pending', 'open', 'in_progress')
       and asg.opens_at <= $1
       and asg.closes_at >= $1
       and coalesce(nr.enabled, true)
       and coalesce(asg.due_at, asg.closes_at) - (coalesce(nr.reminder_offset_minutes, $2) || ' minutes')::interval <= $1`,
    [now, DEFAULT_REMINDER_OFFSET_MINUTES],
  );
  for (const row of result.rows) {
    summary.reminders.attempted += 1;
    if (!row.recipient_user_id) {
      summary.reminders.noRecipient += 1;
      continue;
    }
    const dedupeKey = buildDedupeKey({ kind: "reminder", occurrenceId: row.occurrence_id, assignmentId: row.assignment_id, recipientUserId: row.recipient_user_id });
    const effectiveDue = row.due_at || row.closes_at;
    try {
      const sent = await sendOneShotNotification(pool, {
        recipientUserId: row.recipient_user_id,
        type: "training_load_external_reminder",
        title: "Reminder: RPE is still waiting",
        body: `Don't forget to log RPE for "${row.event_name}" before ${formatTimeInZone(new Date(effectiveDue), row.timezone)}.`,
        entityType: "training_load_external_assignment",
        entityId: row.assignment_id,
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id, assignmentId: row.assignment_id },
        dedupeKey,
      });
      if (sent) summary.reminders.sent += 1;
      else summary.reminders.alreadySent += 1;
    } catch (error) {
      summary.reminders.failed += 1;
      summary.errors.push({ stage: "reminder", assignmentId: row.assignment_id, message: error.message });
    }
  }
}

// One-shot per (occurrence, coach), gated on status <> 'cancelled' for
// both the schedule AND the occurrence (broader than 'active' - a closing
// summary is read-only reporting, matching WELLNESS's own final_digest
// reasoning; a cancelled occurrence is always skipped outright, matching
// submit's own guard). Hardening correction: this used to gate on
// o.closes_at, which is only ever the SCHEDULE's own reference-timezone
// window - each athlete's REAL closes_at is the frozen, per-assignment
// external_assignments.closes_at (their own device timezone snapshotted
// at materialization). Athletes spread across timezones can have closes_
// at values hours apart for the exact same occurrence; sending the digest
// as soon as the reference window closed could fire while some athlete's
// own RPE window is still genuinely open. The digest now waits for BOTH
// the LAST athlete's own authoritative closes_at to have passed - once
// that holds, no assignment's window can still be open BY DEFINITION
// (closes_at is each assignment's own hard deadline, and nothing in this
// codebase ever flips a still-unrated assignment out of 'pending' on a
// timer - it stays 'pending' forever once its window lapses unrated,
// exactly like the schema's own "0/1 completed" case), so there is no
// separate status condition to also satisfy here.
async function runFinalDigestPhase(pool, now, summary) {
  const result = await pool.query(
    `select o.id as occurrence_id, o.scheduled_date::text as scheduled_date, sch.id as schedule_id, sch.event_name, sch.created_by_user_id as recipient_user_id,
            count(asg.id)::int as total, count(asg.id) filter (where asg.status = 'completed')::int as completed
     from training_load.external_schedule_occurrences o
     join training_load.external_schedules sch on sch.id = o.schedule_id
     join training_load.external_assignments asg on asg.occurrence_id = o.id
     left join training_load.external_schedule_notification_rules nr
       on nr.schedule_id = sch.id and nr.kind = 'final_digest'
     where sch.status <> 'cancelled'
       and o.status <> 'cancelled'
       and coalesce(nr.enabled, true)
     group by o.id, sch.id, sch.event_name, sch.created_by_user_id
     having max(asg.closes_at) <= $1`,
    [now],
  );
  for (const row of result.rows) {
    summary.finalDigests.attempted += 1;
    const dedupeKey = buildDedupeKey({ kind: "final_digest", occurrenceId: row.occurrence_id, assignmentId: null, recipientUserId: row.recipient_user_id });
    try {
      const sent = await sendOneShotNotification(pool, {
        recipientUserId: row.recipient_user_id,
        type: "training_load_external_final_digest",
        title: `"${row.event_name}" check-in closed`,
        body: `${row.completed}/${row.total} athletes logged RPE.`,
        entityType: "training_load_external_occurrence",
        entityId: row.occurrence_id,
        // scheduledDate lets the coach-side deep-link open Training Load
        // -> Results on the actual right week, not just the tab itself.
        metadata: { scheduleId: row.schedule_id, occurrenceId: row.occurrence_id, scheduledDate: row.scheduled_date },
        dedupeKey,
      });
      if (sent) summary.finalDigests.sent += 1;
      else summary.finalDigests.alreadySent += 1;
    } catch (error) {
      summary.finalDigests.failed += 1;
      summary.errors.push({ stage: "final_digest", occurrenceId: row.occurrence_id, message: error.message });
    }
  }
}

export async function processTrainingLoadNotificationCycle({ now = new Date(), pool }) {
  const summary = {
    occurrences: { schedulesChecked: 0, generated: 0, skipped: 0 },
    invitations: { attempted: 0, sent: 0, alreadySent: 0, noRecipient: 0, failed: 0 },
    reminders: { attempted: 0, sent: 0, alreadySent: 0, noRecipient: 0, failed: 0 },
    finalDigests: { attempted: 0, sent: 0, alreadySent: 0, failed: 0 },
    errors: [],
  };
  await runOccurrenceGenerationPhase(pool, summary);
  await runAthleteInvitationPhase(pool, now, summary);
  await runAthleteReminderPhase(pool, now, summary);
  await runFinalDigestPhase(pool, now, summary);
  return summary;
}
