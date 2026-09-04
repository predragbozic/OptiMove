// Training Load metrics measurements — manual entry (solo or group,
// with/without a plan or RPE link), corrections, and the read-only
// results query. Pure service functions taking an already-resolved
// workspace `scope` (see trainingLoadMetricsAccess.js) — routes and tests
// both call these directly, so there is exactly one implementation of the
// write/correction logic.
//
// Ownership: every metric_events row is stamped from `scope.ownerContext`
// (the WRITER's active workspace at write time), never from client input —
// see trainingLoadMetricsAccess.js's own header for why this differs from
// the catalog's client-requested-scope model.
import crypto from "crypto";
import { pool, query } from "./db.js";
import { isAthleteInWorkspaceScope, canManageMetricEventInScope, metricEventScopeSqlForWorkspace, catalogVisibilitySql } from "./trainingLoadMetricsAccess.js";

function uuid() {
  return crypto.randomUUID();
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// Recursively sorts object keys at every nesting level so JSON.stringify
// is deterministic; array order IS part of the hashed content (a real
// client retry re-sends the same serialized payload, so this never causes
// a false conflict in practice).
function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
  return out;
}
function canonicalHash(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(obj))).digest("hex");
}
function occasionContentHash(values) {
  const sorted = [...values].sort((a, b) => a.metric_definition_id.localeCompare(b.metric_definition_id));
  const canon = sorted.map((v) => ({
    metric_definition_id: v.metric_definition_id,
    metric_definition_version_id: v.metric_definition_version_id,
    value_numeric: v.value_numeric ?? null,
    value_boolean: v.value_boolean ?? null,
    value_text: v.value_text ?? null,
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

function validateCompleteValueSet(oldValues, newValues) {
  const oldIds = new Set(oldValues.map((v) => v.metric_definition_id));
  const newIds = new Set(newValues.map((v) => v.metric_definition_id));
  if (newIds.size !== newValues.length) {
    return { error: "Duplicate metric in the submitted value set.", status: 400 };
  }
  if (oldIds.size !== newIds.size || [...oldIds].some((id) => !newIds.has(id))) {
    return { error: "A correction must carry the complete set of metrics from the original measurement — none may be dropped or added.", status: 400 };
  }
  return null;
}

// §6 fix: strict type parsing — never silently coerces null/empty/
// whitespace-only-string to 0 or false. Number(" ") === 0 in JavaScript,
// so a bare `raw === ""` check alone was not enough.
function parseValueForType(valueType, raw) {
  if (valueType === "numeric") {
    if (raw === null || raw === undefined || typeof raw === "boolean" || typeof raw === "object") {
      return { error: "A numeric value is required." };
    }
    if (typeof raw === "string" && raw.trim() === "") return { error: "A numeric value is required." };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: "Value must be a real number." };
    return { value_numeric: n, value_boolean: null, value_text: null };
  }
  if (valueType === "boolean") {
    if (typeof raw !== "boolean") return { error: "Value must be true or false." };
    return { value_numeric: null, value_boolean: raw, value_text: null };
  }
  // text
  if (typeof raw !== "string" || raw.trim() === "") return { error: "A non-empty text value is required." };
  return { value_numeric: null, value_boolean: null, value_text: raw };
}

// -----------------------------------------------------------------------
// §1/§3 fix: resolves and validates a SET of value entries in TWO batched
// passes — every UNIQUE metricDefinitionId is checked for visibility/
// existence/active-state exactly once, and every UNIQUE
// metricDefinitionVersionId is looked up exactly once — regardless of how
// many participants in a group request reference the same metric. The
// previous version queried per-participant, and never checked visibility
// at all (a coach who merely knew another coach's PRIVATE definition's
// UUID could use it in a measurement, and it would then surface through
// results).
//
// §3 fix: the client MUST name an explicit metricDefinitionVersionId for
// every value — the server never substitutes current_version_id on its
// own. `requireCurrentVersion: true` (new entries) additionally rejects a
// submission whose named version is no longer current (409 — "the
// definition changed since you loaded this form, reload and confirm"),
// so a version bump occurring between form-load and submit is never
// silently absorbed. `requireCurrentVersion: false` (corrections)
// preserves whatever version the client explicitly names — a correction's
// unchanged, re-sent values keep pointing at their ORIGINAL version even
// if the definition has since moved on, and even if it has since been
// archived (requireActive: false for corrections too — archiving blocks
// NEW use of a metric, never a correction of history that already used
// it).
// -----------------------------------------------------------------------
async function resolveValueEntries(client, req, rawEntries, { requireActive, requireCurrentVersion }) {
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
    return { error: "At least one metric value is required.", status: 400 };
  }
  for (const entry of rawEntries) {
    if (!entry?.metricDefinitionId) return { error: "Each value must name a metricDefinitionId.", status: 400 };
    if (!entry?.metricDefinitionVersionId) return { error: "Each value must name an explicit metricDefinitionVersionId.", status: 400 };
  }

  const uniqueDefIds = [...new Set(rawEntries.map((e) => e.metricDefinitionId))];
  const defCache = new Map();
  for (const defId of uniqueDefIds) {
    const visParams = [];
    const visSql = catalogVisibilitySql(req, "d", visParams);
    visParams.push(defId);
    const result = await client.query(
      `select d.id, d.state, d.current_version_id from training_load.metric_definitions d where d.id = $${visParams.length} and (${visSql})`,
      visParams,
    );
    const def = result.rows[0];
    // Deliberately the SAME 404 whether the definition doesn't exist or
    // merely isn't visible to this account — knowing a valid UUID for
    // someone else's private metric must not distinguish "not found" from
    // "not yours", exactly like the app's existing not-yours-vs-missing
    // convention elsewhere (see routes/trainingLoad.js's own comment).
    if (!def) return { error: `Metric definition ${defId} not found.`, status: 404 };
    if (requireActive && def.state !== "active") return { error: `Metric definition ${defId} is archived and cannot accept new values.`, status: 400 };
    defCache.set(defId, def);
  }

  const uniqueVersionIds = [...new Set(rawEntries.map((e) => e.metricDefinitionVersionId))];
  const versionCache = new Map();
  const versionResult = await client.query(
    `select id, metric_definition_id, value_type, min_value, max_value, unit from training_load.metric_definition_versions where id = any($1::uuid[])`,
    [uniqueVersionIds],
  );
  for (const v of versionResult.rows) versionCache.set(v.id, v);

  const resolved = [];
  for (const entry of rawEntries) {
    const def = defCache.get(entry.metricDefinitionId);
    const version = versionCache.get(entry.metricDefinitionVersionId);
    if (!version || String(version.metric_definition_id) !== String(def.id)) {
      return { error: `metricDefinitionVersionId ${entry.metricDefinitionVersionId} does not belong to definition ${entry.metricDefinitionId}.`, status: 400 };
    }
    if (requireCurrentVersion && String(version.id) !== String(def.current_version_id)) {
      return { error: `Metric definition ${def.id} has changed since this was loaded — reload and confirm before submitting.`, status: 409 };
    }
    const parsed = parseValueForType(version.value_type, entry.value);
    if (parsed.error) return { error: `${def.id}: ${parsed.error}`, status: 400 };
    if (version.value_type === "numeric") {
      if (version.min_value !== null && parsed.value_numeric < Number(version.min_value)) return { error: `${def.id}: value below the allowed minimum (${version.min_value}).`, status: 400 };
      if (version.max_value !== null && parsed.value_numeric > Number(version.max_value)) return { error: `${def.id}: value above the allowed maximum (${version.max_value}).`, status: 400 };
    }
    resolved.push({
      metric_definition_id: def.id,
      metric_definition_version_id: version.id,
      ...parsed,
      unit_at_capture: version.unit,
      segmentIndex: entry.segmentIndex ?? null,
    });
  }
  return { values: resolved };
}

// §1 fix: verifies a claimed logicalSessionId/externalAssignmentId
// genuinely belongs to the given athlete AND that the writer's CURRENT
// workspace has real management rights over the specific plan/schedule it
// comes from — not just that the athlete happens to be in scope. Two
// workspaces can both legitimately manage the same athlete (e.g. a club
// and, separately, that athlete's own private coach) without having
// access to each other's plans/schedules for them.
//
// §1 fix: a logical_session_id can be shared by a LIVE published plan
// session and an in-progress Builder edit-draft copy of the same plan
// (see migrations_v2's own plans.plans.is_edit_draft — an edit-draft is
// `is_active = false`). The previous query took whichever physical row
// sorted first by date, which could silently resolve to a draft the
// athlete has never even seen yet. Now filtered to the LIVE, published
// plan only (`p.is_active = true`).
async function resolveParticipantLink(client, athleteId, scope, { logicalSessionId, externalAssignmentId }) {
  if (logicalSessionId && externalAssignmentId) {
    return { error: "A participant may link a planned session OR an external assignment, never both.", status: 400 };
  }
  if (logicalSessionId) {
    const result = await client.query(
      `select ps.name as session_name, p.name as plan_name, p.athlete_id,
              pwo.owner_scope, pwo.owner_user_id, pwo.owner_club_id, pwo.owner_team_id
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       left join training_load.plan_workspace_ownership pwo on pwo.plan_id = p.id
       where ps.logical_session_id = $1 and p.is_active = true
       limit 1`,
      [logicalSessionId],
    );
    const row = result.rows[0];
    if (!row || String(row.athlete_id) !== String(athleteId)) {
      return { error: "The referenced planned session does not belong to this athlete.", status: 400 };
    }
    if (!row.owner_scope || !canManageMetricEventInScope(scope, row)) {
      return { error: "You do not have access to the plan this session belongs to.", status: 403 };
    }
    return { logicalSessionId, linkedSessionNameSnapshot: row.session_name || null, linkedPlanNameSnapshot: row.plan_name || null, externalAssignmentId: null };
  }
  if (externalAssignmentId) {
    const result = await client.query(
      `select ea.athlete_id, es.owner_scope, es.owner_user_id, es.owner_club_id, es.owner_team_id
       from training_load.external_assignments ea
       join training_load.external_schedule_occurrences eo on eo.id = ea.occurrence_id
       join training_load.external_schedules es on es.id = eo.schedule_id
       where ea.id = $1`,
      [externalAssignmentId],
    );
    const row = result.rows[0];
    if (!row || String(row.athlete_id) !== String(athleteId)) {
      return { error: "The referenced external assignment does not belong to this athlete.", status: 400 };
    }
    if (!canManageMetricEventInScope(scope, row)) {
      return { error: "You do not have access to the schedule this assignment belongs to.", status: 403 };
    }
    return { logicalSessionId: null, linkedSessionNameSnapshot: null, linkedPlanNameSnapshot: null, externalAssignmentId };
  }
  return { logicalSessionId: null, linkedSessionNameSnapshot: null, linkedPlanNameSnapshot: null, externalAssignmentId: null };
}

// -----------------------------------------------------------------------
// Write-request claim: authorization is checked BEFORE any write is
// attempted, for a brand-new key exactly as much as for a retry — every
// HTTP request re-resolves the caller's CURRENT workspace/rights from
// scratch (see routes/trainingLoadMetrics.js), so a revoked-rights retry
// is rejected here on its own. §5 fix: this ONLY covers "does the account
// still have SOME workspace of this kind" — it is NOT itself proof the
// account still has rights over the SPECIFIC object a replay would
// return; callers additionally re-check that per-object before returning
// a cached (isNew: false) result — see createGroupEvent/
// correctManualOccasion/correctImportedOccasionManually's own reuse
// branches.
// -----------------------------------------------------------------------
async function claimWriteRequest(client, { requestKey, requestedBy, operationKind, ownerScope, ownerIds, contentHash, isAuthorized }) {
  if (!isAuthorized) {
    return { error: "You no longer have rights over this workspace.", status: 403 };
  }
  const insert = await client.query(
    `insert into training_load.metric_write_requests
       (request_key, requested_by_user_id, operation_kind, owner_scope, owner_user_id, owner_club_id, owner_team_id, request_content_hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (requested_by_user_id, request_key) do nothing
     returning *`,
    [requestKey, requestedBy, operationKind, ownerScope, ownerIds.userId ?? null, ownerIds.clubId ?? null, ownerIds.teamId ?? null, contentHash],
  );
  if (insert.rowCount === 1) return { isNew: true, row: insert.rows[0] };
  const existingRes = await client.query(`select * from training_load.metric_write_requests where requested_by_user_id = $1 and request_key = $2`, [requestedBy, requestKey]);
  const existing = existingRes.rows[0];
  if (existing.operation_kind !== operationKind) return { error: "This request key was already used for a different kind of operation.", status: 409 };
  const sameWorkspace =
    existing.owner_scope === ownerScope &&
    (existing.owner_user_id ?? null) === (ownerIds.userId ?? null) &&
    (existing.owner_club_id ?? null) === (ownerIds.clubId ?? null) &&
    (existing.owner_team_id ?? null) === (ownerIds.teamId ?? null);
  if (!sameWorkspace) return { error: "This request was already submitted under a different workspace.", status: 409 };
  if (existing.request_content_hash !== contentHash) return { error: "This request key was already used with different content.", status: 409 };
  return { isNew: false, row: existing };
}

// -----------------------------------------------------------------------
// Create a group event: one or more participants (a solo entry is simply
// an event with exactly one participant — no special-casing), each with
// one or more metric values, optionally grouped into session/day segments.
// The WHOLE request is atomic: an unauthorized athlete, an inaccessible
// definition, or an invalid value anywhere rejects the entire request
// with zero partial writes.
// -----------------------------------------------------------------------
export async function createGroupEvent(req, scope, body) {
  const requestKey = body?.requestKey;
  if (!requestKey || typeof requestKey !== "string") return { error: "requestKey is required.", status: 400 };
  if (!Array.isArray(body?.participants) || body.participants.length === 0) return { error: "At least one participant is required.", status: 400 };
  if (!body?.occurredDate) return { error: "occurredDate is required.", status: 400 };
  if (!["session", "day"].includes(body?.scopeLevel)) return { error: "scopeLevel must be 'session' or 'day'.", status: 400 };

  const contentHash = canonicalHash({
    eventName: body.eventName ?? null, occurredDate: body.occurredDate, occurredInstant: body.occurredInstant ?? null,
    scopeLevel: body.scopeLevel, segments: body.segments ?? [], participants: body.participants,
  });

  const client = await pool.connect();
  try {
    await client.query("begin");
    const claim = await claimWriteRequest(client, {
      requestKey, requestedBy: req.user.id, operationKind: "create_group_event",
      ownerScope: scope.ownerContext.ownerScope, ownerIds: { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId },
      contentHash, isAuthorized: scope.type !== null,
    });
    if (claim.error) {
      await client.query("rollback");
      return claim;
    }
    if (!claim.isNew) {
      // §5 fix: re-check CURRENT authorization over the event this
      // request already created before returning the cached result — an
      // idempotency record is not a standing grant. This does NOT
      // re-validate participants/values against the (possibly now
      // different) catalog state — a legitimate identical retry must not
      // start failing because a definition was archived or re-versioned
      // in the meantime.
      const eventLookup = await client.query(`select * from training_load.metric_events where id = $1`, [claim.row.result_event_id]);
      if (!eventLookup.rows[0] || !canManageMetricEventInScope(scope, eventLookup.rows[0])) {
        await client.query("rollback");
        return { error: "You no longer have rights over this measurement.", status: 403 };
      }
      await client.query("commit");
      return { reused: true, eventId: claim.row.result_event_id };
    }

    // Validate EVERY participant fully (athlete-in-scope + link ownership)
    // BEFORE any write — a failure anywhere aborts the whole request with
    // zero partial rows. Definitions/versions for ALL participants are
    // resolved together, ONCE per unique id (see resolveValueEntries).
    const flatEntries = [];
    body.participants.forEach((p, participantIndex) => {
      for (const v of p.values || []) flatEntries.push({ ...v, __participantIndex: participantIndex });
    });
    const valuesResult = await resolveValueEntries(client, req, flatEntries, { requireActive: true, requireCurrentVersion: true });
    if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
    const resolvedByParticipant = new Map();
    valuesResult.values.forEach((resolvedValue, idx) => {
      const participantIndex = flatEntries[idx].__participantIndex;
      if (!resolvedByParticipant.has(participantIndex)) resolvedByParticipant.set(participantIndex, []);
      resolvedByParticipant.get(participantIndex).push(resolvedValue);
    });

    const preparedParticipants = [];
    for (let idx = 0; idx < body.participants.length; idx += 1) {
      const p = body.participants[idx];
      if (!p?.athleteId) throw httpError(400, "Each participant requires an athleteId.");
      if (!(await isAthleteInWorkspaceScope(scope, p.athleteId))) throw httpError(403, `Athlete ${p.athleteId} is outside your current workspace.`);
      if (!p?.timezone) throw httpError(400, "Each participant requires a timezone (athlete_timezone_snapshot).");
      const link = await resolveParticipantLink(client, p.athleteId, scope, { logicalSessionId: p.logicalSessionId, externalAssignmentId: p.externalAssignmentId });
      if (link.error) throw httpError(link.status, link.error);
      preparedParticipants.push({ input: p, link, values: resolvedByParticipant.get(idx) || [] });
    }

    const eventId = uuid();
    await client.query(
      `insert into training_load.metric_events (id, event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_user_id, owner_club_id, owner_team_id, created_by_user_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [eventId, body.eventName || null, body.occurredDate, body.occurredInstant || null, body.scopeLevel,
        scope.ownerContext.ownerScope, scope.ownerContext.ownerUserId, scope.ownerContext.ownerClubId, scope.ownerContext.ownerTeamId, req.user.id],
    );

    const segmentIds = [];
    for (const seg of body.segments || []) {
      const segId = uuid();
      await client.query(`insert into training_load.metric_event_segments (id, event_id, label, segment_order) values ($1,$2,$3,$4)`, [segId, eventId, String(seg.label || "").trim() || "Segment", Number(seg.order) || segmentIds.length + 1]);
      segmentIds.push(segId);
    }

    const createdParticipants = [];
    for (const { input, link, values } of preparedParticipants) {
      const participantId = uuid();
      await client.query(
        `insert into training_load.metric_event_participants
           (id, event_id, athlete_id, athlete_timezone_snapshot, logical_session_id, linked_session_name_snapshot, linked_plan_name_snapshot, external_assignment_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [participantId, eventId, input.athleteId, input.timezone, link.logicalSessionId, link.linkedSessionNameSnapshot, link.linkedPlanNameSnapshot, link.externalAssignmentId],
      );
      // Group this participant's values by segment (undefined/null =
      // session-level occasion) — one occasion per distinct group.
      const groups = new Map();
      for (const v of values) {
        const key = v.segmentIndex ?? "session";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(v);
      }
      const occasionIds = [];
      for (const [key, groupValues] of groups) {
        const segmentId = key === "session" ? null : segmentIds[key] ?? null;
        if (key !== "session" && !segmentId) throw httpError(400, `Invalid segmentIndex ${key}.`);
        const occasionId = uuid();
        await client.query(
          `insert into training_load.metric_measurement_occasions (id, event_participant_id, segment_id, entry_method, content_hash, recorded_by_user_id)
           values ($1,$2,$3,'manual',$4,$5)`,
          [occasionId, participantId, segmentId, occasionContentHash(groupValues), req.user.id],
        );
        for (const v of groupValues) {
          await client.query(
            `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [occasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric, v.value_boolean, v.value_text, v.unit_at_capture],
          );
        }
        occasionIds.push(occasionId);
      }
      createdParticipants.push({ participantId, athleteId: input.athleteId, occasionIds });
    }

    await client.query(`update training_load.metric_write_requests set result_event_id = $1 where requested_by_user_id = $2 and request_key = $3`, [eventId, req.user.id, requestKey]);
    await client.query("commit");
    return { reused: false, eventId, participants: createdParticipants };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error.httpStatus) return { error: error.message, status: error.httpStatus };
    throw error;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------
// Manual correction of a purely-manual occasion (no source identity).
// Retry-safe via metric_write_requests; requires the complete value set,
// preserves segment/participant/provenance, preserves each value's
// EXPLICITLY-named semantic version (never auto-current — see
// resolveValueEntries's own header).
//
// §2 fix: the target occasion is now locked (SELECT ... FOR UPDATE) as
// the FIRST operation in this function, and every subsequent decision
// (superseded check, complete-value-set check) reads from that SAME
// locked row — not a separate, earlier, unlocked read. The previous
// version read the target unlocked, decided "not yet superseded" from
// that stale snapshot, and relied on lock_ancestors_before_occasion_insert
// (which only fires during the LATER successor INSERT) to serialize
// against a concurrent correction — too late, since two concurrent
// requests with DIFFERENT request keys could both pass the stale
// "not superseded" check before either one's insert-time lock ever
// engaged, producing two successors and a corrupted superseded_by
// pointer (last UPDATE wins, silently orphaning the other successor).
// -----------------------------------------------------------------------
export async function correctManualOccasion(req, scope, body) {
  const requestKey = body?.requestKey;
  const targetOccasionId = body?.targetOccasionId;
  if (!requestKey) return { error: "requestKey is required.", status: 400 };
  if (!targetOccasionId) return { error: "targetOccasionId is required.", status: 400 };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const targetLookup = await client.query(
      `select o.*, p.event_id, e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id
       from training_load.metric_measurement_occasions o
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
       where o.id = $1
       for update of o`,
      [targetOccasionId],
    );
    const target = targetLookup.rows[0];
    if (!target) throw httpError(404, "Measurement not found.");
    if (!canManageMetricEventInScope(scope, target)) throw httpError(404, "Measurement not found.");
    if (target.source_identity_id) throw httpError(400, "This measurement came from an import — use the import-correction endpoint instead.");

    const contentHash = canonicalHash({ targetOccasionId, values: body.values });
    const claim = await claimWriteRequest(client, {
      requestKey, requestedBy: req.user.id, operationKind: "correct_occasion",
      ownerScope: scope.ownerContext.ownerScope, ownerIds: { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId },
      contentHash, isAuthorized: scope.type !== null,
    });
    if (claim.error) throw httpError(claim.status, claim.error);
    if (!claim.isNew) {
      // §5 fix: re-check current authorization over the RESULT before replay.
      if (claim.row.result_occasion_id) {
        const resultLookup = await client.query(
          `select e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id
           from training_load.metric_measurement_occasions o
           join training_load.metric_event_participants p on p.id = o.event_participant_id
           join training_load.metric_events e on e.id = p.event_id
           where o.id = $1`,
          [claim.row.result_occasion_id],
        );
        if (!resultLookup.rows[0] || !canManageMetricEventInScope(scope, resultLookup.rows[0])) {
          throw httpError(403, "You no longer have rights over this measurement.");
        }
      }
      await client.query("commit");
      return { reused: true, occasionId: claim.row.result_occasion_id };
    }

    // Still under the lock acquired above — this read of `target` is current.
    if (target.superseded_by_occasion_id) throw httpError(409, "This revision was already superseded — reload and retry.");

    const oldValuesRes = await client.query(`select metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text from training_load.metric_values where occasion_id = $1`, [targetOccasionId]);
    const valuesResult = await resolveValueEntries(client, req, body.values, { requireActive: false, requireCurrentVersion: false });
    if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
    const newValues = valuesResult.values;
    const completeness = validateCompleteValueSet(oldValuesRes.rows, newValues);
    if (completeness) throw httpError(completeness.status, completeness.error);

    const newOccasionId = uuid();
    await client.query(
      `insert into training_load.metric_measurement_occasions (id, event_participant_id, segment_id, entry_method, content_hash, recorded_by_user_id, supersedes_occasion_id)
       values ($1,$2,$3,'manual',$4,$5,$6)`,
      [newOccasionId, target.event_participant_id, target.segment_id, occasionContentHash(newValues), req.user.id, targetOccasionId],
    );
    for (const v of newValues) {
      await client.query(
        `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [newOccasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric, v.value_boolean, v.value_text, v.unit_at_capture],
      );
    }
    // Defensive WHERE guard alongside the row lock already held above —
    // documents the invariant even though the lock alone already
    // guarantees this can only ever affect exactly one row.
    const updateResult = await client.query(
      `update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2 and superseded_by_occasion_id is null`,
      [newOccasionId, targetOccasionId],
    );
    if (updateResult.rowCount === 0) throw httpError(409, "This revision was already superseded — reload and retry.");
    await client.query(`update training_load.metric_write_requests set result_occasion_id = $1 where requested_by_user_id = $2 and request_key = $3`, [newOccasionId, req.user.id, requestKey]);
    await client.query("commit");
    return { reused: false, occasionId: newOccasionId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error.httpStatus) return { error: error.message, status: error.httpStatus };
    throw error;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------
// Manual correction of a CURRENTLY-IMPORTED occasion — preserves
// source_identity_id, entry_method='manual', locks the SAME identity row
// a sync would lock (this was already correctly serializing concurrent
// corrections against each other and against a sync — see the identity
// FOR UPDATE below, unlike the pure-manual path which needed §2's fix),
// atomically moves current_occasion_id.
// -----------------------------------------------------------------------
export async function correctImportedOccasionManually(req, scope, body) {
  const { requestKey, sourceIdentityId, expectedCurrentOccasionId } = body || {};
  if (!requestKey) return { error: "requestKey is required.", status: 400 };
  if (!sourceIdentityId || !expectedCurrentOccasionId) return { error: "sourceIdentityId and expectedCurrentOccasionId are required.", status: 400 };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const contentHash = canonicalHash({ sourceIdentityId, expectedCurrentOccasionId, values: body.values });

    const claim = await claimWriteRequest(client, {
      requestKey, requestedBy: req.user.id, operationKind: "correct_occasion",
      ownerScope: scope.ownerContext.ownerScope, ownerIds: { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId },
      contentHash, isAuthorized: scope.type !== null,
    });
    if (claim.error) throw httpError(claim.status, claim.error);
    if (!claim.isNew) {
      // §5 fix: re-check current authorization over the RESULT before replay.
      if (claim.row.result_occasion_id) {
        const resultLookup = await client.query(
          `select e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id
           from training_load.metric_measurement_occasions o
           join training_load.metric_event_participants p on p.id = o.event_participant_id
           join training_load.metric_events e on e.id = p.event_id
           where o.id = $1`,
          [claim.row.result_occasion_id],
        );
        if (!resultLookup.rows[0] || !canManageMetricEventInScope(scope, resultLookup.rows[0])) {
          throw httpError(403, "You no longer have rights over this measurement.");
        }
      }
      await client.query("commit");
      return { reused: true, occasionId: claim.row.result_occasion_id };
    }

    const identityLock = await client.query(`select * from training_load.metric_source_identities where id = $1 for update`, [sourceIdentityId]);
    const identity = identityLock.rows[0];
    if (!identity) throw httpError(404, "Measurement not found.");
    if (identity.current_occasion_id !== expectedCurrentOccasionId) throw httpError(409, "This revision was already superseded — reload and retry.");

    const targetLookup = await client.query(
      `select o.*, p.event_id, e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id
       from training_load.metric_measurement_occasions o
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
       where o.id = $1`,
      [expectedCurrentOccasionId],
    );
    const target = targetLookup.rows[0];
    if (!target || !canManageMetricEventInScope(scope, target)) throw httpError(404, "Measurement not found.");

    const oldValuesRes = await client.query(`select metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text from training_load.metric_values where occasion_id = $1`, [expectedCurrentOccasionId]);
    const valuesResult = await resolveValueEntries(client, req, body.values, { requireActive: false, requireCurrentVersion: false });
    if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
    const newValues = valuesResult.values;
    const completeness = validateCompleteValueSet(oldValuesRes.rows, newValues);
    if (completeness) throw httpError(completeness.status, completeness.error);

    const newOccasionId = uuid();
    await client.query(
      `insert into training_load.metric_measurement_occasions (id, event_participant_id, segment_id, entry_method, content_hash, source_identity_id, recorded_by_user_id, supersedes_occasion_id)
       values ($1,$2,$3,'manual',$4,$5,$6,$7)`,
      [newOccasionId, target.event_participant_id, target.segment_id, occasionContentHash(newValues), sourceIdentityId, req.user.id, expectedCurrentOccasionId],
    );
    for (const v of newValues) {
      await client.query(
        `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [newOccasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric, v.value_boolean, v.value_text, v.unit_at_capture],
      );
    }
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2`, [newOccasionId, expectedCurrentOccasionId]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id = $1 where id = $2`, [newOccasionId, sourceIdentityId]);
    await client.query(`update training_load.metric_write_requests set result_occasion_id = $1 where requested_by_user_id = $2 and request_key = $3`, [newOccasionId, req.user.id, requestKey]);
    await client.query("commit");
    return { reused: false, occasionId: newOccasionId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    if (error.httpStatus) return { error: error.message, status: error.httpStatus };
    throw error;
  } finally {
    client.release();
  }
}

// -----------------------------------------------------------------------
// Import-side correction (entry_method='api_import') and resend handling.
// No HTTP route uses these in this phase (no public import endpoint) —
// they exist so the source-identity correction/idempotency machinery is
// real, tested code, exercised directly against synthetic source data by
// this feature's own tests, ready for a future connector to call.
// -----------------------------------------------------------------------
export async function correctSourceIdentityOccasion(client, { sourceIdentityId, expectedCurrentOccasionId, newValues, recordedBy, sourceReportedAt, onLocked }) {
  await client.query("begin");
  try {
    const lockRes = await client.query(`select * from training_load.metric_source_identities where id=$1 for update`, [sourceIdentityId]);
    const identity = lockRes.rows[0];
    if (onLocked) await onLocked();
    if (identity.current_occasion_id !== expectedCurrentOccasionId) {
      throw new Error(`STALE_BASE_REVISION: expected current=${expectedCurrentOccasionId} but actual current=${identity.current_occasion_id}`);
    }
    const oldOccRes = await client.query(`select content_hash, segment_id, event_participant_id from training_load.metric_measurement_occasions where id=$1`, [expectedCurrentOccasionId]);
    const oldOcc = oldOccRes.rows[0];
    const oldValuesRes = await client.query(`select metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text from training_load.metric_values where occasion_id=$1`, [expectedCurrentOccasionId]);
    const completeness = validateCompleteValueSet(oldValuesRes.rows, newValues);
    if (completeness) throw new Error(`INCOMPLETE_CORRECTION: ${completeness.error}`);
    const newContentHash = occasionContentHash(newValues);
    if (oldOcc.content_hash === newContentHash) {
      await client.query("rollback");
      return { changed: false, occasionId: expectedCurrentOccasionId };
    }
    const newOccasionId = uuid();
    await client.query(
      `insert into training_load.metric_measurement_occasions
         (id, event_participant_id, segment_id, entry_method, content_hash, source_identity_id, source_reported_at, recorded_by_user_id, supersedes_occasion_id)
       values ($1,$2,$3,'api_import',$4,$5,$6,$7,$8)`,
      [newOccasionId, oldOcc.event_participant_id, oldOcc.segment_id, newContentHash, sourceIdentityId, sourceReportedAt ?? null, recordedBy ?? null, expectedCurrentOccasionId],
    );
    for (const v of newValues) {
      await client.query(
        `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [newOccasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric ?? null, v.value_boolean ?? null, v.value_text ?? null, v.unit ?? null],
      );
    }
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id=$1 where id=$2`, [newOccasionId, expectedCurrentOccasionId]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id=$1 where id=$2`, [newOccasionId, sourceIdentityId]);
    await client.query("commit");
    return { changed: true, occasionId: newOccasionId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

export async function importResendSynthetic(client, { sourceIdentityId, newValues, sourceReportedAt, recordedBy, onLocked }) {
  await client.query("begin");
  try {
    const lockRes = await client.query(`select * from training_load.metric_source_identities where id=$1 for update`, [sourceIdentityId]);
    const identity = lockRes.rows[0];
    if (onLocked) await onLocked();
    const currentOccRes = await client.query(`select * from training_load.metric_measurement_occasions where id=$1`, [identity.current_occasion_id]);
    const currentOcc = currentOccRes.rows[0];
    const newContentHash = occasionContentHash(newValues);
    if (currentOcc.content_hash === newContentHash) {
      await client.query("rollback");
      return { outcome: "unchanged_repeat" };
    }
    let conflictStatus = null;
    if (currentOcc.entry_method === "manual") {
      conflictStatus = "stale_resend_ignored";
    } else if (!sourceReportedAt || !currentOcc.source_reported_at) {
      conflictStatus = "needs_review";
    } else if (new Date(sourceReportedAt) <= new Date(currentOcc.source_reported_at)) {
      conflictStatus = "stale_resend_ignored";
    }
    const newOccasionId = uuid();
    if (conflictStatus) {
      await client.query(
        `insert into training_load.metric_measurement_occasions
           (id, event_participant_id, segment_id, entry_method, content_hash, source_identity_id, source_reported_at, recorded_by_user_id, import_conflict_status)
         values ($1,$2,$3,'api_import',$4,$5,$6,$7,$8)`,
        [newOccasionId, currentOcc.event_participant_id, currentOcc.segment_id, newContentHash, sourceIdentityId, sourceReportedAt ?? null, recordedBy ?? null, conflictStatus],
      );
      for (const v of newValues) {
        await client.query(
          `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [newOccasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric ?? null, v.value_boolean ?? null, v.value_text ?? null, v.unit ?? null],
        );
      }
      await client.query("commit");
      return { outcome: conflictStatus, occasionId: newOccasionId };
    }
    const oldValuesRes = await client.query(`select metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text from training_load.metric_values where occasion_id=$1`, [currentOcc.id]);
    const completeness = validateCompleteValueSet(oldValuesRes.rows, newValues);
    if (completeness) throw new Error(`INCOMPLETE_CORRECTION: ${completeness.error}`);
    await client.query(
      `insert into training_load.metric_measurement_occasions
         (id, event_participant_id, segment_id, entry_method, content_hash, source_identity_id, source_reported_at, recorded_by_user_id, supersedes_occasion_id)
       values ($1,$2,$3,'api_import',$4,$5,$6,$7,$8)`,
      [newOccasionId, currentOcc.event_participant_id, currentOcc.segment_id, newContentHash, sourceIdentityId, sourceReportedAt ?? null, recordedBy ?? null, currentOcc.id],
    );
    for (const v of newValues) {
      await client.query(
        `insert into training_load.metric_values (occasion_id, metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text, unit_at_capture)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [newOccasionId, v.metric_definition_id, v.metric_definition_version_id, v.value_numeric ?? null, v.value_boolean ?? null, v.value_text ?? null, v.unit ?? null],
      );
    }
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id=$1 where id=$2`, [newOccasionId, currentOcc.id]);
    await client.query(`update training_load.metric_source_identities set current_occasion_id=$1 where id=$2`, [newOccasionId, sourceIdentityId]);
    await client.query("commit");
    return { outcome: "accepted_correction", occasionId: newOccasionId };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

// -----------------------------------------------------------------------
// Occasion detail / history
// -----------------------------------------------------------------------
// `readContext` = { scope, isAthleteSelf, athleteId } — resolved ONCE by
// the route from the caller's ACTIVE WORKSPACE (never a raw "does this
// account have an athlete profile at all" capability check — see
// routes/trainingLoadMetrics.js's own resolveReadContext for why that
// distinction matters for a dual-role account).
export async function getOccasionDetail(readContext, occasionId) {
  const result = await query(
    `select o.*, p.athlete_id, p.event_id, p.athlete_timezone_snapshot, p.logical_session_id, p.external_assignment_id,
            p.linked_session_name_snapshot, p.linked_plan_name_snapshot,
            e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id, e.event_name, e.occurred_date, e.occurred_instant, e.scope_level
     from training_load.metric_measurement_occasions o
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
     where o.id = $1`,
    [occasionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const isOwnAthlete = readContext.isAthleteSelf && String(readContext.athleteId) === String(row.athlete_id);
  if (!isOwnAthlete && !canManageMetricEventInScope(readContext.scope, row)) return null;
  const values = await query(
    `select v.*, d.label, d.short_label, d.icon_url from training_load.metric_values v
     join training_load.metric_definitions d on d.id = v.metric_definition_id
     where v.occasion_id = $1`,
    [occasionId],
  );
  return { occasion: row, values: values.rows };
}

export async function getOccasionHistory(readContext, occasionId) {
  const chain = [];
  let currentId = occasionId;
  // walk backward through supersedes_occasion_id
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const detail = await getOccasionDetail(readContext, currentId);
    if (!detail) break;
    chain.push(detail);
    currentId = detail.occasion.supersedes_occasion_id;
  }
  return chain;
}

// -----------------------------------------------------------------------
// Read-only results query — the backend a future Results table reads.
// Never creates events/assignments/any business row. One shared
// effectiveness rule for every row: not superseded, not conflict-flagged,
// and (for a source-identified row) additionally must match its
// identity's current_occasion_id. Session/segment/day values are NEVER
// summed here, and a conflict (more than one independently effective
// value for the same participant+segment+metric) is surfaced explicitly
// via `conflict`, never silently resolved.
//
// §4 fix: the previous version returned one row per metric_values row but
// sorted/paginated ONLY by (occurred_date, occasion_id) — an occasion with
// two values and limit=1 would return one of them on page 1, and the
// cursor (keyed only on occasion_id) then excluded that ENTIRE occasion
// from every later page, silently losing the second value forever. The
// sort/cursor key is now the full (occurred_date, occasion_id, value_id)
// triple, so every individual value row is visited exactly once across
// pages regardless of how many values share an occasion.
//
// §4 fix: `effective_count` (the conflict flag) is now computed in a CTE
// over the COMPLETE filtered set (every WHERE condition except the
// cursor/limit), then cursor+limit are applied in the outer query — the
// previous version computed the window function AFTER the cursor
// condition, so a conflict whose two rows land on different pages could
// silently disappear on whichever page didn't happen to already contain
// both.
// -----------------------------------------------------------------------
const RESULTS_MAX_PAGE_SIZE = 200;
const RESULTS_DEFAULT_PAGE_SIZE = 50;
const RESULTS_MAX_METRIC_IDS = 50;
const RESULTS_MAX_DATE_RANGE_DAYS = 366;

export async function queryResults(readContext, filters = {}) {
  if (!filters.dateFrom || !filters.dateTo) return { error: "dateFrom and dateTo are required.", status: 400 };
  const from = new Date(`${filters.dateFrom}T00:00:00Z`);
  const to = new Date(`${filters.dateTo}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return { error: "Invalid date range.", status: 400 };
  const rangeDays = (to.getTime() - from.getTime()) / 86400000;
  if (rangeDays > RESULTS_MAX_DATE_RANGE_DAYS) return { error: `Date range cannot exceed ${RESULTS_MAX_DATE_RANGE_DAYS} days.`, status: 400 };

  const metricIds = Array.isArray(filters.metricDefinitionIds) ? filters.metricDefinitionIds : null;
  if (metricIds && metricIds.length > RESULTS_MAX_METRIC_IDS) return { error: `At most ${RESULTS_MAX_METRIC_IDS} metrics may be requested at once.`, status: 400 };

  if (!readContext.isAthleteSelf && readContext.scope.type === null) return { error: "No active workspace.", status: 403 };

  const params = [];
  const conditions = [
    "o.superseded_by_occasion_id is null",
    "o.import_conflict_status is null",
    `(o.source_identity_id is null or exists (
      select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id
    ))`,
  ];

  if (readContext.isAthleteSelf) {
    params.push(readContext.athleteId);
    conditions.push(`p.athlete_id = $${params.length}`);
  } else {
    conditions.push(metricEventScopeSqlForWorkspace(readContext.scope, "ev", params));
  }

  params.push(filters.dateFrom, filters.dateTo);
  conditions.push(`ev.occurred_date >= $${params.length - 1} and ev.occurred_date <= $${params.length}`);

  if (Array.isArray(filters.athleteIds) && filters.athleteIds.length) {
    params.push(filters.athleteIds);
    conditions.push(`p.athlete_id = any($${params.length}::uuid[])`);
  }
  if (metricIds?.length) {
    params.push(metricIds);
    conditions.push(`v.metric_definition_id = any($${params.length}::uuid[])`);
  }
  if (filters.eventId) {
    params.push(filters.eventId);
    conditions.push(`ev.id = $${params.length}`);
  }
  if (filters.domainId || filters.categoryId) {
    // §1 fix: this EXISTS clause must respect the SAME visibility rule
    // listStructureLinks() already applies (the link's own scope AND
    // every non-null target it references) — the previous version
    // matched ANY link with the right domain/category, including one
    // neither this viewer nor its definition's owner could actually see,
    // which meant a private classification link could leak which OTHER
    // definitions share its domain/category through the results filter.
    // catalogVisibilitySql pushes its own bind params directly onto the
    // SAME `params` array used by the whole query (not a separate,
    // later-concatenated array) — its generated $N placeholders are only
    // correct relative to whatever `params` already holds at call time.
    const linkVis = catalogVisibilitySql(readContext.authzContext, "l", params);
    let linkCondition = `l.metric_definition_id = d.id and (${linkVis})`;
    if (filters.domainId) {
      params.push(filters.domainId);
      linkCondition += ` and l.domain_id = $${params.length}`;
    }
    if (filters.categoryId) {
      params.push(filters.categoryId);
      linkCondition += ` and l.category_id = $${params.length}`;
    }
    conditions.push(`exists (select 1 from training_load.metric_structure_links l where ${linkCondition})`);
  }

  const pageSize = Math.min(Number.parseInt(filters.limit, 10) || RESULTS_DEFAULT_PAGE_SIZE, RESULTS_MAX_PAGE_SIZE);

  // Cursor params are bound AFTER the CTE's own `conditions` params (which
  // already claimed $1..$params.length) and BEFORE the trailing limit —
  // the cursor condition's placeholders must start right where `params`
  // left off, never a hardcoded $1/$2/$3 (that would collide with the
  // CTE's own conditions once both arrays are concatenated below).
  let cursorCondition = "true";
  const cursorConditionParams = [];
  if (filters.cursor?.occurredDate && filters.cursor?.occasionId && filters.cursor?.valueId) {
    const base = params.length;
    cursorConditionParams.push(filters.cursor.occurredDate, filters.cursor.occasionId, filters.cursor.valueId);
    cursorCondition = `(er.occurred_date, er.occasion_id, er.value_id) < ($${base + 1}, $${base + 2}, $${base + 3})`;
  }
  const limitParamIndex = params.length + cursorConditionParams.length + 1;

  const result = await query(
    `with effective_rows as (
       select
         ev.id as event_id, ev.event_name, ev.occurred_date, ev.scope_level,
         seg.id as segment_id, seg.label as segment_label,
         p.id as participant_id, p.athlete_id, a.full_name as athlete_full_name, a.display_name as athlete_display_name,
         o.id as occasion_id, o.entry_method, o.source_identity_id, o.supersedes_occasion_id,
         d.id as metric_definition_id, d.label, d.short_label, d.icon_url,
         dv.id as metric_definition_version_id, dv.version_number, dv.unit, dv.daily_aggregation_method,
         v.id as value_id, v.value_numeric, v.value_boolean, v.value_text,
         count(*) over (partition by o.event_participant_id, o.segment_id, v.metric_definition_id) as effective_count
       from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events ev on ev.id = p.event_id
       left join training_load.metric_event_segments seg on seg.id = o.segment_id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
       join training_load.metric_definition_versions dv on dv.id = v.metric_definition_version_id
       join public.athletes a on a.id = p.athlete_id
       where ${conditions.join(" and ")}
     )
     select er.* from effective_rows er
     where ${cursorCondition}
     order by er.occurred_date desc, er.occasion_id desc, er.value_id desc
     limit $${limitParamIndex}`,
    [...params, ...cursorConditionParams, pageSize + 1],
  );
  const rows = result.rows.slice(0, pageSize).map((r) => ({
    athleteId: r.athlete_id,
    athleteName: r.athlete_display_name || r.athlete_full_name,
    eventId: r.event_id,
    eventName: r.event_name,
    occurredDate: r.occurred_date,
    scopeLevel: r.scope_level,
    segmentId: r.segment_id,
    segmentLabel: r.segment_label,
    metricDefinitionId: r.metric_definition_id,
    metricDefinitionVersionId: r.metric_definition_version_id,
    versionNumber: r.version_number,
    label: r.label,
    shortLabel: r.short_label,
    iconUrl: r.icon_url,
    unit: r.unit,
    dailyAggregationMethod: r.daily_aggregation_method,
    value: r.value_numeric ?? r.value_boolean ?? r.value_text,
    valueId: r.value_id,
    occasionId: r.occasion_id,
    entryMethod: r.entry_method,
    isImported: r.source_identity_id !== null,
    hasHistory: r.supersedes_occasion_id !== null,
    conflict: Number(r.effective_count) > 1,
  }));
  const hasMore = result.rows.length > pageSize;
  const nextCursor = hasMore ? { occurredDate: rows[rows.length - 1].occurredDate, occasionId: rows[rows.length - 1].occasionId, valueId: rows[rows.length - 1].valueId } : null;
  return { rows, nextCursor };
}
