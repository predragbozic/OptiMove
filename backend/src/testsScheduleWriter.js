// The one writer of a Tests schedule's rows (K2b-2a-1, plan 9.1.7): moved out
// of routes/tests.js so POST /api/tests/schedules (and /bulk, PATCH) and the
// calendar's *Ask athletes* write the same rows; a test pins that.
export const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";

export async function replaceNotificationRules(client, scheduleId, rules) {
  await client.query(`delete from tests.test_schedule_notification_rules where schedule_id = $1`, [scheduleId]);
  for (const rule of rules) {
    await client.query(
      `insert into tests.test_schedule_notification_rules
         (schedule_id, notification_kind, enabled, reminder_offset_minutes, digest_trigger)
       values ($1, $2, $3, $4, $5)`,
      [scheduleId, rule.kind, rule.enabled, rule.reminderOffsetMinutes, rule.digestTrigger],
    );
  }
}

// Shared by POST /schedules (create) and POST /schedules/bulk (Specific
// dates) - the one place that actually inserts a tests.test_schedules row,
// so both call sites stay byte-for-byte identical in what they write.
export async function insertScheduleRow(client, { scheduleKind, timezone, startDate, endDate, opensTime, dueTime, closesTime, userId, owner, skipDaysOff = false }) {
  // skip_days_off (v81) is named only when it is set, so a database without
  // v81 (the Tests suites' own migration lists) takes the same statement as
  // before it.
  const result = await client.query(
    `insert into tests.test_schedules
       (test_version_id, schedule_kind, timezone, start_date, end_date, recurrence_rule, recurrence_rule_version, opens_time, due_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id${skipDaysOff ? ", skip_days_off" : ""})
     values ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, 'active', $10, $11, $12, $13, $14${skipDaysOff ? ", true" : ""})
     returning *`,
    [
      WELLNESS_TEST_VERSION_ID,
      scheduleKind,
      timezone,
      startDate,
      scheduleKind === "one_time" ? (endDate || startDate) : endDate,
      scheduleKind === "recurring" ? JSON.stringify({ version: 1, freq: "daily" }) : null,
      opensTime,
      dueTime,
      closesTime,
      userId,
      owner.ownerScope,
      owner.ownerUserId,
      owner.ownerClubId,
      owner.ownerTeamId,
    ],
  );
  return result.rows[0];
}

export async function insertScheduleTargets(client, scheduleId, targets) {
  for (const target of targets) {
    await client.query(
      `insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
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

// The schedule's own cancel, as DELETE /schedules/:id does for a schedule with
// occurrences: the status, and its active check-in links revoked by the actor
// (review round 1, M3). Its occurrences and assignments stay as history.
export async function cancelTestSchedule(client, scheduleId, userId) {
  const cancelled = (await client.query(
    `update tests.test_schedules set status = 'cancelled', updated_at = now() where id = $1 and status <> 'cancelled' returning id`,
    [scheduleId],
  )).rowCount;
  await client.query(
    `update tests.test_access_links set status = 'revoked', revoked_at = now(), revoked_by_user_id = $2 where schedule_id = $1 and status = 'active'`,
    [scheduleId, userId],
  );
  return cancelled;
}
