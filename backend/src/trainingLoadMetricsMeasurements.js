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
import { isAthleteInWorkspaceScope, canManageMetricEventInScope, metricEventScopeSqlForWorkspace } from "./trainingLoadMetricsAccess.js";

function uuid() {
  return crypto.randomUUID();
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

// Strict type parsing — never silently coerces null/empty-string to 0 or
// false. `raw` is the client-submitted value for one metric.
function parseValueForType(valueType, raw) {
  if (valueType === "numeric") {
    if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean" || typeof raw === "object") {
      return { error: "A numeric value is required." };
    }
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

// Resolves each requested metricDefinitionId to its CURRENT semantic
// version and validates the submitted value against it — the version id
// is never accepted from the client, so a submission always captures
// against whatever semantics are live right now (see this module's own
// header + the migration's header for why).
async function resolveAndValidateValues(client, rawValues) {
  if (!Array.isArray(rawValues) || rawValues.length === 0) {
    return { error: "At least one metric value is required.", status: 400 };
  }
  const resolved = [];
  for (const entry of rawValues) {
    if (!entry?.metricDefinitionId) return { error: "Each value must name a metricDefinitionId.", status: 400 };
    const defResult = await client.query(
      `select d.id, d.state, dv.id as version_id, dv.value_type, dv.min_value, dv.max_value, dv.unit
       from training_load.metric_definitions d
       join training_load.metric_definition_versions dv on dv.id = d.current_version_id
       where d.id = $1`,
      [entry.metricDefinitionId],
    );
    const def = defResult.rows[0];
    if (!def) return { error: `Unknown metric definition ${entry.metricDefinitionId}.`, status: 400 };
    if (def.state !== "active") return { error: `Metric definition ${entry.metricDefinitionId} is archived and cannot accept new values.`, status: 400 };
    const parsed = parseValueForType(def.value_type, entry.value);
    if (parsed.error) return { error: `${entry.metricDefinitionId}: ${parsed.error}`, status: 400 };
    if (def.value_type === "numeric") {
      if (def.min_value !== null && parsed.value_numeric < Number(def.min_value)) return { error: `${entry.metricDefinitionId}: value below the allowed minimum (${def.min_value}).`, status: 400 };
      if (def.max_value !== null && parsed.value_numeric > Number(def.max_value)) return { error: `${entry.metricDefinitionId}: value above the allowed maximum (${def.max_value}).`, status: 400 };
    }
    resolved.push({
      metric_definition_id: def.id,
      metric_definition_version_id: def.version_id,
      ...parsed,
      unit_at_capture: def.unit,
      segmentIndex: entry.segmentIndex ?? null,
    });
  }
  return { values: resolved };
}

// Verifies a claimed logicalSessionId/externalAssignmentId genuinely
// belongs to the given athlete AND that the writer's active workspace has
// real rights over it — knowing a syntactically valid UUID is never
// sufficient on its own. Returns the frozen name snapshots to store.
async function resolveParticipantLink(client, scope, athleteId, { logicalSessionId, externalAssignmentId }) {
  if (logicalSessionId && externalAssignmentId) {
    return { error: "A participant may link a planned session OR an external assignment, never both.", status: 400 };
  }
  if (logicalSessionId) {
    const result = await client.query(
      `select ps.name as session_name, p.name as plan_name, p.athlete_id
       from plans.plan_sessions ps
       join plans.plan_days pd on pd.id = ps.plan_day_id
       join plans.plans p on p.id = pd.plan_id
       where ps.logical_session_id = $1
       order by pd.date desc
       limit 1`,
      [logicalSessionId],
    );
    const row = result.rows[0];
    if (!row || String(row.athlete_id) !== String(athleteId)) {
      return { error: "The referenced planned session does not belong to this athlete.", status: 400 };
    }
    if (!(await isAthleteInWorkspaceScope(scope, athleteId))) {
      return { error: "That athlete is outside your current workspace.", status: 403 };
    }
    return { logicalSessionId, linkedSessionNameSnapshot: row.session_name || null, linkedPlanNameSnapshot: row.plan_name || null, externalAssignmentId: null };
  }
  if (externalAssignmentId) {
    const result = await client.query(`select athlete_id from training_load.external_assignments where id = $1`, [externalAssignmentId]);
    const row = result.rows[0];
    if (!row || String(row.athlete_id) !== String(athleteId)) {
      return { error: "The referenced external assignment does not belong to this athlete.", status: 400 };
    }
    if (!(await isAthleteInWorkspaceScope(scope, athleteId))) {
      return { error: "That athlete is outside your current workspace.", status: 403 };
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
// is rejected here on its own, without any special-cased "re-check" path.
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
// The WHOLE request is atomic: an unauthorized athlete or an invalid value
// anywhere rejects the entire request with zero partial writes.
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
      await client.query("commit");
      return { reused: true, eventId: claim.row.result_event_id };
    }

    // Validate EVERY participant fully (athlete-in-scope + link ownership
    // + value types/bounds) BEFORE any write — a failure anywhere aborts
    // the whole request with zero partial rows.
    const preparedParticipants = [];
    for (const p of body.participants) {
      if (!p?.athleteId) throw httpError(400, "Each participant requires an athleteId.");
      if (!(await isAthleteInWorkspaceScope(scope, p.athleteId))) throw httpError(403, `Athlete ${p.athleteId} is outside your current workspace.`);
      if (!p?.timezone) throw httpError(400, "Each participant requires a timezone (athlete_timezone_snapshot).");
      const link = await resolveParticipantLink(client, scope, p.athleteId, { logicalSessionId: p.logicalSessionId, externalAssignmentId: p.externalAssignmentId });
      if (link.error) throw httpError(link.status, link.error);
      const valuesResult = await resolveAndValidateValues(client, p.values);
      if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
      preparedParticipants.push({ input: p, link, values: valuesResult.values });
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

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// -----------------------------------------------------------------------
// Manual correction of a purely-manual occasion (no source identity).
// Retry-safe via metric_write_requests; locks the target occasion
// directly, requires the complete value set, preserves segment/
// participant/provenance.
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
       where o.id = $1`,
      [targetOccasionId],
    );
    const target = targetLookup.rows[0];
    if (!target) throw httpError(404, "Measurement not found.");
    if (!canManageMetricEventInScope(scope, target)) throw httpError(404, "Measurement not found.");
    if (target.source_identity_id) throw httpError(400, "This measurement came from an import — use the import-correction endpoint instead.");

    const valuesResult = await resolveAndValidateValues(client, body.values);
    if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
    const newValues = valuesResult.values;

    const contentHash = canonicalHash({ targetOccasionId, values: body.values });
    const claim = await claimWriteRequest(client, {
      requestKey, requestedBy: req.user.id, operationKind: "correct_occasion",
      ownerScope: scope.ownerContext.ownerScope, ownerIds: { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId },
      contentHash, isAuthorized: scope.type !== null,
    });
    if (claim.error) throw httpError(claim.status, claim.error);
    if (!claim.isNew) {
      await client.query("commit");
      return { reused: true, occasionId: claim.row.result_occasion_id };
    }

    if (target.superseded_by_occasion_id) throw httpError(409, "This revision was already superseded — reload and retry.");
    const oldValuesRes = await client.query(`select metric_definition_id, metric_definition_version_id, value_numeric, value_boolean, value_text from training_load.metric_values where occasion_id = $1`, [targetOccasionId]);
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
    await client.query(`update training_load.metric_measurement_occasions set superseded_by_occasion_id = $1 where id = $2`, [newOccasionId, targetOccasionId]);
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
// a sync would lock, atomically moves current_occasion_id. A later
// re-sync of the (now-stale) original content is automatically ignored
// (see correctSourceIdentityOccasion / importResendSynthetic's own rule:
// a human correction always outranks a re-sync).
// -----------------------------------------------------------------------
export async function correctImportedOccasionManually(req, scope, body) {
  const { requestKey, sourceIdentityId, expectedCurrentOccasionId } = body || {};
  if (!requestKey) return { error: "requestKey is required.", status: 400 };
  if (!sourceIdentityId || !expectedCurrentOccasionId) return { error: "sourceIdentityId and expectedCurrentOccasionId are required.", status: 400 };

  const client = await pool.connect();
  try {
    await client.query("begin");
    const valuesResult = await resolveAndValidateValues(client, body.values);
    if (valuesResult.error) throw httpError(valuesResult.status, valuesResult.error);
    const newValues = valuesResult.values;
    const contentHash = canonicalHash({ sourceIdentityId, expectedCurrentOccasionId, values: body.values });

    const claim = await claimWriteRequest(client, {
      requestKey, requestedBy: req.user.id, operationKind: "correct_occasion",
      ownerScope: scope.ownerContext.ownerScope, ownerIds: { userId: scope.ownerContext.ownerUserId, clubId: scope.ownerContext.ownerClubId, teamId: scope.ownerContext.ownerTeamId },
      contentHash, isAuthorized: scope.type !== null,
    });
    if (claim.error) throw httpError(claim.status, claim.error);
    if (!claim.isNew) {
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
// account have an athlete profile" capability check — see
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
// -----------------------------------------------------------------------
const RESULTS_MAX_PAGE_SIZE = 200;
const RESULTS_DEFAULT_PAGE_SIZE = 50;
const RESULTS_MAX_METRIC_IDS = 50;
const RESULTS_MAX_DATE_RANGE_DAYS = 366;

// `readContext` = { scope, isAthleteSelf, athleteId } — same resolved-once
// context as getOccasionDetail/getOccasionHistory above.
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
    const linkParams = [];
    let linkCondition = "l.metric_definition_id = d.id";
    if (filters.domainId) {
      linkParams.push(filters.domainId);
      linkCondition += ` and l.domain_id = $${params.length + linkParams.length}`;
    }
    if (filters.categoryId) {
      linkParams.push(filters.categoryId);
      linkCondition += ` and l.category_id = $${params.length + linkParams.length}`;
    }
    params.push(...linkParams);
    conditions.push(`exists (select 1 from training_load.metric_structure_links l where ${linkCondition})`);
  }

  const pageSize = Math.min(Number.parseInt(filters.limit, 10) || RESULTS_DEFAULT_PAGE_SIZE, RESULTS_MAX_PAGE_SIZE);
  if (filters.cursor?.occurredDate && filters.cursor?.occasionId) {
    params.push(filters.cursor.occurredDate, filters.cursor.occasionId);
    conditions.push(`(ev.occurred_date, o.id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(pageSize + 1);

  const result = await query(
    `select
       ev.id as event_id, ev.event_name, ev.occurred_date, ev.scope_level,
       seg.id as segment_id, seg.label as segment_label,
       p.id as participant_id, p.athlete_id, a.full_name as athlete_full_name, a.display_name as athlete_display_name,
       o.id as occasion_id, o.entry_method, o.source_identity_id, o.supersedes_occasion_id, o.created_at as occasion_created_at,
       d.id as metric_definition_id, d.label, d.short_label, d.icon_url,
       dv.id as metric_definition_version_id, dv.version_number, dv.unit, dv.daily_aggregation_method,
       v.value_numeric, v.value_boolean, v.value_text,
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
     order by ev.occurred_date desc, o.id desc
     limit $${params.length}`,
    params,
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
    occasionId: r.occasion_id,
    entryMethod: r.entry_method,
    isImported: r.source_identity_id !== null,
    hasHistory: r.supersedes_occasion_id !== null,
    conflict: Number(r.effective_count) > 1,
  }));
  const hasMore = result.rows.length > pageSize;
  const nextCursor = hasMore ? { occurredDate: rows[rows.length - 1].occurredDate, occasionId: rows[rows.length - 1].occasionId } : null;
  return { rows, nextCursor };
}
