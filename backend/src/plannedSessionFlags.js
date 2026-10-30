// The one write path of a PUBLISHED weekly session's two Training Load flags
// (`plans.plan_sessions.training_load_enabled` and `rpe_enabled`, v14 / v3):
// the Training Load quick toggles (PATCH /api/training-load/sessions/:id/
// rpe-enabled and /training-load-enabled, routes/trainingLoad.js) and the
// central calendar's alignment of an event's linked sessions (K2a-1b, D20,
// calendarEventService.js) all write through it, so the edit-draft cascade
// and the flag invariant live in one place.
//
// The caller has already:
//   - locked the live session row FOR UPDATE (the quick toggles' `for update
//     of ps`; the alignment's ascending `for update of ps`);
//   - decided the right (canManagePlanTrainingLoadInScope over the plan's
//     stored plan_workspace_ownership) and the confirmation for turning RPE
//     off on a session that already has results (countSessionResults).
// It never touches the workspace's planned-RPE switch
// (training_load.planned_rpe_workspace_settings), which stays its own
// administrator's decision.

// A live plan with an open edit-draft carries its own copy of the same
// logical session (preserveLogicalId, routes/builder.js); it is updated in
// the SAME transaction, or a later "Save and finish" of the draft would
// silently revert the flags. The copies are locked FOR UPDATE here.
export async function writePublishedSessionFlags(client, { sessionId, planId, logicalSessionId, trainingLoadEnabled, rpeEnabled }) {
  if (typeof trainingLoadEnabled !== "boolean" || typeof rpeEnabled !== "boolean") {
    throw new TypeError("writePublishedSessionFlags: both flags must be booleans");
  }
  // The v14 CHECK (plan_sessions_rpe_requires_training_load) refuses RPE on
  // an untracked session; asked here so a caller's mistake is a programming
  // error, never a raw constraint violation reaching a user.
  if (rpeEnabled && !trainingLoadEnabled) {
    throw new TypeError("writePublishedSessionFlags: RPE needs Training Load tracking");
  }
  const draftSessionResult = await client.query(
    `select ps2.id
     from plans.plans d
     join plans.plan_days pd2 on pd2.plan_id = d.id
     join plans.plan_sessions ps2 on ps2.plan_day_id = pd2.id
     where d.edit_source_plan_id = $1 and d.is_edit_draft
       and ps2.logical_session_id = $2
     for update of ps2`,
    [planId, logicalSessionId],
  );
  const idsToUpdate = [sessionId, ...draftSessionResult.rows.map((row) => row.id)];
  await client.query(
    `update plans.plan_sessions set training_load_enabled = $1, rpe_enabled = $2, updated_at = now() where id = any($3::uuid[])`,
    [trainingLoadEnabled, rpeEnabled, idsToUpdate],
  );
  return { draftSessionUpdated: draftSessionResult.rowCount > 0 };
}

// The submitted planned results of one logical session (the quick toggles'
// own "disabling with existing results" gate).
export async function countSessionResults(client, logicalSessionId) {
  const result = await client.query(
    `select count(*)::int as n from training_load.session_feedback where logical_session_id = $1`,
    [logicalSessionId],
  );
  return result.rows[0].n;
}
