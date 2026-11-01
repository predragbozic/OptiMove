// The one write path of a PUBLISHED weekly session's two Training Load flags
// (`plans.plan_sessions.training_load_enabled` and `rpe_enabled`, v14 / v3):
// the Training Load quick toggles (PATCH /api/training-load/sessions/:id/
// rpe-enabled and /training-load-enabled, routes/trainingLoad.js) and the
// central calendar's alignment of an event's linked sessions (K2a-1b, D20,
// calendarEventService.js) all write through it, so the edit-draft cascade
// and the flag invariant live in one place.
//
// The caller has already:
//   - locked the live session rows FOR UPDATE (the quick toggles' `for
//     update of ps`; the alignment's ascending `for update of ps`);
//   - decided the right (canManagePlanTrainingLoadInScope over the plan's
//     stored plan_workspace_ownership) and the confirmation for turning RPE
//     off on a session that already has results (countSessionResults).
// It never touches the workspace's planned-RPE switch
// (training_load.planned_rpe_workspace_settings), which stays its own
// administrator's decision.

// Only the flags given are written: `undefined` leaves that column as it is
// on every row, the live one and its edit-draft copies alike. The RPE quick
// toggle writes `rpe_enabled` alone, as it always did, so a Builder draft
// whose tracking differs from the live row keeps its own tracking; and a
// row whose tracking is (or becomes) off never takes RPE (the v14 rule, per
// row: such a draft copy keeps RPE off instead of failing the write).
//
// A live plan with an open edit-draft carries its own copy of the same
// logical session (preserveLogicalId, routes/builder.js); it is updated in
// the SAME transaction, or a later "Save and finish" of the draft would
// silently revert the flags. The copies are locked FOR UPDATE here, in
// ascending id. One statement locks the copies and one writes, whatever the
// number of sessions.
export async function writePublishedSessionFlags(client, { sessions, trainingLoadEnabled, rpeEnabled }) {
  for (const flag of [trainingLoadEnabled, rpeEnabled]) {
    if (flag !== undefined && typeof flag !== "boolean") throw new TypeError("writePublishedSessionFlags: a flag is a boolean or undefined");
  }
  if (trainingLoadEnabled === undefined && rpeEnabled === undefined) {
    throw new TypeError("writePublishedSessionFlags: nothing to write");
  }
  // The v14 CHECK (plan_sessions_rpe_requires_training_load) refuses RPE on
  // an untracked session; asked here so a caller's mistake is a programming
  // error, never a raw constraint violation reaching a user.
  if (rpeEnabled === true && trainingLoadEnabled === false) {
    throw new TypeError("writePublishedSessionFlags: RPE needs Training Load tracking");
  }
  if (!Array.isArray(sessions) || !sessions.length) return { draftSessionUpdated: false, draftSessionsUpdated: 0 };
  const draftSessionResult = await client.query(
    `select ps2.id
     from plans.plans d
     join plans.plan_days pd2 on pd2.plan_id = d.id
     join plans.plan_sessions ps2 on ps2.plan_day_id = pd2.id
     join unnest($1::uuid[], $2::uuid[]) as k(plan_id, logical_session_id)
       on d.edit_source_plan_id = k.plan_id and ps2.logical_session_id = k.logical_session_id
     where d.is_edit_draft
     order by ps2.id
     for update of ps2`,
    [sessions.map((s) => s.planId), sessions.map((s) => s.logicalSessionId)],
  );
  const draftIds = new Set(draftSessionResult.rows.map((row) => String(row.id)));
  const idsToUpdate = [...sessions.map((s) => s.sessionId), ...draftIds];
  const written = await client.query(
    `update plans.plan_sessions
        set training_load_enabled = coalesce($1::boolean, training_load_enabled),
            rpe_enabled = coalesce($2::boolean, rpe_enabled) and coalesce($1::boolean, training_load_enabled),
            updated_at = now()
      where id = any($3::uuid[])
      returning id, rpe_enabled`,
    [trainingLoadEnabled ?? null, rpeEnabled ?? null, idsToUpdate],
  );
  // The draft copies asked for RPE that kept it off (their own tracking is
  // off), so the caller can say so instead of claiming the copy follows.
  const draftSessionsKeptRpeOff = rpeEnabled === true
    ? written.rows.filter((row) => draftIds.has(String(row.id)) && row.rpe_enabled !== true).length
    : 0;
  return { draftSessionUpdated: draftIds.size > 0, draftSessionsUpdated: draftIds.size, draftSessionsKeptRpeOff };
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
