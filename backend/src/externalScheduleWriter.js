// The one writer of a Training Load external schedule's rows (K2b-2a-1, plan
// 9.1.7): moved out of routes/trainingLoad.js so POST
// /api/training-load/external-schedules (and schedule-again, PATCH) and the
// calendar's *Ask athletes* write the same rows; a test pins that.

export async function insertExternalSchedule(client, { scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventType, eventNote, userId, owner }) {
  const result = await client.query(
    `insert into training_load.external_schedules
       (schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, event_name, event_type, event_note, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,$2,$3,$4,$5,1,$6,$7,$8,'active',$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [scheduleKind, timezone, startDate, endDate, recurrenceRule, opensTime, dueTime, closesTime, eventName, eventType, eventNote, userId, owner.ownerScope, owner.ownerUserId, owner.ownerClubId, owner.ownerTeamId],
  );
  return result.rows[0];
}

export async function insertExternalTargets(client, scheduleId, targets) {
  for (const target of targets) {
    await client.query(
      `insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
       values ($1, $2, $3, $4, $5)`,
      [
        scheduleId,
        target.kind,
        target.kind === "athlete" ? target.id : null,
        target.kind === "team" ? target.id : null,
        target.kind === "club" ? target.id : null,
      ],
    );
  }
}

export async function insertNotificationRules(client, scheduleId, rules) {
  for (const rule of rules) {
    await client.query(
      `insert into training_load.external_schedule_notification_rules (schedule_id, kind, enabled, reminder_offset_minutes) values ($1,$2,$3,$4)`,
      [scheduleId, rule.kind, rule.enabled, rule.reminderOffsetMinutes],
    );
  }
}

// The module's own cancel (POST /external-schedules/:id/cancel): the
// schedule's status only; its occurrences and assignments stay as history.
export async function cancelExternalSchedule(client, scheduleId) {
  return (await client.query(
    `update training_load.external_schedules set status = 'cancelled', updated_at = now() where id = $1 and status <> 'cancelled' returning id`,
    [scheduleId],
  )).rowCount;
}
