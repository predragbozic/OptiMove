// The source-field revision lifecycle (C91): an active platform admin, in the
// platform workspace (O1), creates a revision of a source field (T2b,
// training_load.source_metric_definition_versions) as a draft (L1), retires
// an abandoned draft (L2), activates a draft while the field has no active
// revision (L3), replaces the active revision by a draft in one transaction
// (L4), or retires the active revision with no successor (L5, O3).
// Contract: docs/ai/v39-revision-lifecycle-contract.md (J5, section J5.2),
// decision C100 of docs/ai/gpexe-metric-variable-mapping-discovery.md. The
// database guards are migration v39 (J5.3).
//
// - A correction of a field's contract is a new revision; the old revision
//   keeps its facts and its history (C91). R+1 inherits nothing, and a
//   verification stays its own act (M2b).
// - The pinned step (L2, L4, L5; O4, O7): retiring a revision disables every
//   mapping version pinned to it that is needs_review - a club's included -,
//   with the fixed reason "Source revision retired." and one mapping_status
//   audit row each; a pinned draft stays a draft (it can no longer be
//   submitted). An active pinned version or an open activation cannot exist
//   before phase 7 and is refused (fail closed); a needs_review version of an
//   archived club, which no one may write, is 409 club_archived naming those
//   clubs (O7(ii)(a)). Answers count the disabled versions only, never a
//   mapping, a version or a club of another owner.
// - O2 (L4): a verified revision is replaced only by a verified one.
//
// Every write is one bounded transaction of M2's machinery (adminWriteKit),
// in the order of J5.2: the per-user advisory lock, the request record (the
// operation's keyed T8 row; a replay answers the current state of the
// operation, read by its operation_id, after the right is checked again), the
// acting user as the v35 transaction-local setting, T2a FOR SHARE, every
// revision of the field FOR UPDATE (ascending id; it serializes the lifecycle
// against itself and against M2's version create and submit and M2b's acts on
// that field), the pinned step's T3 rows FOR SHARE and T4 rows FOR UPDATE
// (ascending id), the acting user's role and user rows FOR SHARE, the clubs
// of the pinned club versions FOR SHARE (ascending id); only then the 409
// decisions; then the writes, each its own statement (the disables, the
// retirement, the activation), the T8 rows with the keyed one last, and the
// bounded COMMIT (v39's deferred audit links).
import { adminWriteKit, LIST_CAPS, SourceMetricMappingError } from "./sourceMetricMappingService.js";
import { boundedText, unitTokenOk } from "./metricTextRules.js";
import { evidenceRefOk, mayVerify } from "./sourceFieldVerificationService.js";

const {
  runWrite, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, hashOf, UUID, REVISION_COLUMNS, revisionOut,
} = adminWriteKit;

// The version of this request contract inside every request hash; the route is
// in it too, so a key used on L3 is request_key_reused on L4 (both write a
// source_metric_revision_activate row).
const CONTRACT = "source-revisions/v1";
// The disable reason of the pinned step (O4): the version's disable_reason and
// its mapping_status audit row's reason.
export const PINNED_DISABLE_REASON = "Source revision retired.";
// R7: the reads cap a field at this many revisions (LIST_CAPS.revisionsPerField),
// so L1 refuses one more until those reads are paged.
export const REVISION_LIMIT = LIST_CAPS.revisionsPerField;
export const REASON_MAX_LENGTH = 500;
const UNIT_NOTE_MAX_LENGTH = 500;

const VALUE_SHAPES = new Set(["number", "numeric_text", "unit_value_object", "zone_distance", "event_count"]);
const PARAMETER_KINDS = new Set(["none", "zone_bounds", "event_threshold"]);
// R2: a revision may start as documented or observed with a reference;
// verified is derived by the database from the proof, never asserted.
const STARTING_STATUSES = new Set(["unproven", "documented", "observed"]);
const REVISION_ACTIONS = ["source_metric_revision_create", "source_metric_revision_activate", "source_metric_revision_retire"];

const TEXT = {
  invalid_unit: "The unit is not a unit token (1-30 characters, no space, '|' or '=').",
  invalid_evidence_ref: "evidenceRef is a repository path under docs/ with one heading anchor (docs/...#anchor), at most 300 characters.",
  invalid_reason: "reason is one line of 1-500 visible characters without surrounding spaces.",
  field_not_active: "The source field is retired; it takes no new or activated revision.",
  draft_exists: "The source field already has a draft revision; activate it, replace with it or retire it first.",
  revision_limit: "The source field has the most revisions the reads return; no further revision is created yet.",
  revision_retired: "The revision is retired; it is never changed.",
  revision_not_draft: "Only a draft revision is activated or takes over from the active revision.",
  revision_active_exists: "The source field already has an active revision; replace it instead.",
  revision_not_active: "The source field has no active revision to replace.",
  revision_changed: "The active revision of the source field is not the one this request names; read the field again.",
  successor_not_verified: "A verified revision is replaced only by a verified revision: confirm the draft's unit and meaning first.",
  version_active: "A mapping version pinned to this revision is active; it is not retired before the mapping is moved.",
  activation_open: "A mapping version pinned to this revision has an open activation; it is not retired before the activation ends.",
  club_archived: "A submitted mapping version pinned to this revision belongs to an archived club; restore the club, then repeat this request.",
};

// O1 (as M2b's acts, C94): writes are a platform admin's in the platform
// workspace only; every other caller gets the identical 404 - the router asks
// this before it looks at the body.
export const mayChangeRevisions = mayVerify;

// The operation's keyed T8 row is its request record (D10): one key space with
// M2's and M2b's writes, so a key used for another operation is
// request_key_reused.
const REVISION_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, source_metric_definition_id, source_metric_version_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const revisionIdsOf = (written) => ({ fieldId: written.source_metric_definition_id ?? null, revisionId: written.source_metric_version_id ?? null });

const RETRY_CONSTRAINTS = new Set([
  "source_metric_revisions_number_key", "source_metric_audit_one_request_per_key", "source_metric_audit_one_request_per_operation",
]);

// Only the allowlisted database refusals become a 4xx; everything else is a
// sanitized 500 (logged by its code only, by the router). Every condition a
// v34 / v39 trigger checks has its own pre-check under the locks, so a trigger
// refusal reached through this service is a programming error.
export function classifyRevisionError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") {
    console.error(`[source-revision-lifecycle] try_again (${code})`);
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23505" && error.constraint === "source_metric_revisions_one_draft") return refusal(409, "draft_exists", TEXT.draft_exists);
  if (code === "23505" && RETRY_CONSTRAINTS.has(error.constraint)) return refusal(409, "try_again", MESSAGES.try_again);
  return null;
}

// ---------------------------------------------------------------------------
// The answer: the operation's revisions as M2b shows them, and for a
// retirement the disabled versions counted by owner scope.
// ---------------------------------------------------------------------------
async function operationAnswer(executor, record) {
  const rows = (await executor.query(
    `select action, source_metric_version_id from training_load.source_metric_audit
      where operation_id = $1 and action = any($2::text[]) and source_metric_definition_id = $3`,
    [record.operation_id, REVISION_ACTIONS, record.source_metric_definition_id],
  )).rows;
  if (rows.length === 0) return null;
  const ids = rows.map((r) => r.source_metric_version_id);
  const revisions = new Map((await executor.query(
    `select ${REVISION_COLUMNS} from training_load.source_metric_definition_versions
      where id = any($1::uuid[]) and source_metric_definition_id = $2`,
    [ids, record.source_metric_definition_id],
  )).rows.map((r) => [r.id, { fieldId: r.source_metric_definition_id, ...revisionOut(r) }]));
  const byAction = new Map(rows.map((r) => [r.action, revisions.get(r.source_metric_version_id) ?? null]));
  const created = byAction.get("source_metric_revision_create");
  const activated = byAction.get("source_metric_revision_activate");
  const retired = byAction.get("source_metric_revision_retire");
  if (created) return { revision: created };
  const answer = activated ? { revision: activated, ...(retired ? { replaced: retired } : {}) } : { revision: retired };
  if (!answer.revision) return null;
  if (byAction.has("source_metric_revision_retire")) {
    const counts = (await executor.query(
      `select m.owner_scope, count(*)::int as n
         from training_load.source_metric_audit a
         join training_load.source_metric_mappings m on m.id = a.mapping_id
        where a.operation_id = $1 and a.action = 'mapping_status'
        group by m.owner_scope`,
      [record.operation_id],
    )).rows;
    const of = (scope) => counts.find((c) => c.owner_scope === scope)?.n ?? 0;
    answer.disabledVersions = { system: of("system"), club: of("club") };
  }
  return answer;
}

// ---------------------------------------------------------------------------
// The common steps of a write (J5.2).
// ---------------------------------------------------------------------------
function pathIds(fieldId, revisionId) {
  if (typeof fieldId !== "string" || !UUID.test(fieldId)) throw NOT_FOUND();
  if (revisionId !== undefined && (typeof revisionId !== "string" || !UUID.test(revisionId))) throw NOT_FOUND();
  return { fieldId: fieldId.toLowerCase(), revisionId: revisionId === undefined ? null : revisionId.toLowerCase() };
}

// T2a FOR SHARE, then every revision of the field FOR UPDATE in ascending id,
// then the same rows read again by a new statement: a revision another
// transaction inserted and committed while this one waited for the lock is not
// in the locked set, but the second read sees it (READ COMMITTED).
async function lockField(client, fieldId) {
  const field = (await client.query(
    `select id, state from training_load.source_metric_definitions where id = $1 for share`, [fieldId],
  )).rows[0];
  if (!field) throw NOT_FOUND();
  await client.query(
    `select id from training_load.source_metric_definition_versions where source_metric_definition_id = $1 order by id for update`, [fieldId],
  );
  const revisions = (await client.query(
    `select id, revision_number, state, evidence_status, activated_at from training_load.source_metric_definition_versions
      where source_metric_definition_id = $1 order by revision_number`,
    [fieldId],
  )).rows;
  return { field, revisions };
}

// The pinned step's locks and facts (O4, O7) for a revision being retired:
// the T3 rows of the versions pinned to it FOR SHARE, then those versions FOR
// UPDATE, both in ascending id; their open activations. The clubs are locked
// later, after the acting user's rows (v35's order).
async function lockPinned(client, revisionId) {
  const mappingIds = (await client.query(
    `select distinct mapping_id from training_load.source_metric_mapping_versions where source_metric_version_id = $1`, [revisionId],
  )).rows.map((r) => r.mapping_id);
  if (mappingIds.length > 0) {
    await client.query(`select id from training_load.source_metric_mappings where id = any($1::uuid[]) order by id for share`, [mappingIds]);
  }
  const versions = (await client.query(
    `select v.id, v.mapping_id, v.status, m.owner_scope, m.owner_club_id
       from training_load.source_metric_mapping_versions v
       join training_load.source_metric_mappings m on m.id = v.mapping_id
      where v.source_metric_version_id = $1
      order by v.id
        for update of v`,
    [revisionId],
  )).rows;
  const openActivations = versions.length === 0 ? 0 : (await client.query(
    `select count(*)::int as n from training_load.source_metric_mapping_activations
      where mapping_version_id = any($1::uuid[]) and ended_at is null`,
    [versions.map((v) => v.id)],
  )).rows[0].n;
  return { versions, openActivations };
}

// After the acting user's rows: the clubs of the pinned club versions to be
// disabled, FOR SHARE in ascending id, and the archived ones among them.
async function archivedPinnedClubs(client, toDisable) {
  const clubIds = [...new Set(toDisable.filter((v) => v.owner_scope === "club").map((v) => v.owner_club_id))].sort();
  if (clubIds.length === 0) return [];
  const clubs = (await client.query(
    `select id, coalesce(is_active, true) as active from public.clubs where id = any($1::uuid[]) order by id for share`, [clubIds],
  )).rows;
  return clubs.filter((c) => !c.active).map((c) => c.id).sort();
}

// The pinned step's 409 decisions, after every lock and the right (J5.2, step 5).
async function pinnedDecisions(client, pinned) {
  if (pinned.versions.some((v) => v.status === "active")) throw refusal(409, "version_active", TEXT.version_active);
  if (pinned.openActivations > 0) throw refusal(409, "activation_open", TEXT.activation_open);
  const toDisable = pinned.versions.filter((v) => v.status === "needs_review");
  const archived = await archivedPinnedClubs(client, toDisable);
  // O7(ii)(a): the caller, an active platform admin, learns which archived
  // clubs to restore - never a mapping or a version.
  if (archived.length > 0) throw refusal(409, "club_archived", TEXT.club_archived, { clubIds: archived });
  return toDisable;
}

// The pinned step's writes: one statement for the disables, before the
// retirement (v34 refuses a retirement while a pinned version is needs_review).
async function disablePinned(client, ctx, toDisable) {
  if (toDisable.length === 0) return;
  await client.query(
    `update training_load.source_metric_mapping_versions
        set status = 'disabled', disabled_by_user_id = $2, disabled_at = clock_timestamp(), disabled_basis = 'platform_admin', disable_reason = $3
      where id = any($1::uuid[]) and status = 'needs_review'`,
    [toDisable.map((v) => v.id), ctx.userId, PINNED_DISABLE_REASON],
  );
}
async function disabledAuditRows(client, ctx, toDisable, operationId) {
  for (const v of toDisable) {
    await client.query(
      `insert into training_load.source_metric_audit
         (action, mapping_id, mapping_version_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
       values ('mapping_status', $1, $2, 'needs_review', 'disabled', $3, $4, 'platform_admin', $5)`,
      [v.mapping_id, v.id, PINNED_DISABLE_REASON, ctx.userId, operationId],
    );
  }
}
async function retire(client, ctx, revisionId, reason) {
  await client.query(
    `update training_load.source_metric_definition_versions
        set state = 'retired', retired_by_user_id = $2, retired_at = clock_timestamp(), retired_reason = $3
      where id = $1`,
    [revisionId, ctx.userId, reason],
  );
}
async function activate(client, ctx, revisionId) {
  await client.query(
    `update training_load.source_metric_definition_versions
        set state = 'active', activated_by_user_id = $2, activated_at = clock_timestamp()
      where id = $1`,
    [revisionId, ctx.userId],
  );
}
async function revisionAuditRow(client, { action, fieldId, revisionId, fromStatus, toStatus, reason = null, evidenceRef = null, ctx, operationId, requestKey = null, requestHash = null }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, source_metric_definition_id, source_metric_version_id, from_status, to_status, reason, evidence_ref,
        performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'platform_admin', $9, $10, $11)`,
    [action, fieldId, revisionId, fromStatus, toStatus, reason, evidenceRef, ctx.userId, operationId, requestKey, requestHash],
  );
}

// The database's own text rules, once more inside the write (the JavaScript
// twins decided before any lock; v40 makes them the same rule).
async function databaseAgrees(client, { units = [], texts = [], evidenceRef = null }) {
  for (const unit of units) {
    if ((await client.query(`select training_load.source_metric_unit_token_ok($1) as ok`, [unit])).rows[0].ok !== true) {
      throw refusal(400, "invalid_unit", TEXT.invalid_unit);
    }
  }
  for (const [text, max, code, message] of texts) {
    if ((await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [text, max])).rows[0].ok !== true) {
      throw refusal(400, code, message);
    }
  }
  if (evidenceRef !== null && (await client.query(`select training_load.source_metric_evidence_ref_ok($1) as ok`, [evidenceRef])).rows[0].ok !== true) {
    throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  }
}

function reasonOf(body) {
  if (!boundedText(body.reason, REASON_MAX_LENGTH)) throw refusal(400, "invalid_body", TEXT.invalid_reason);
  return body.reason;
}

// Test seam (never set by the application): runs inside a write's transaction
// after every lock is taken and every check passed, right before the first write.
let writeHold = null;
export function setRevisionWriteHoldForTests(fn) { writeHold = fn ?? null; }
// Test seam: leaves out the keyed audit row's predecessors so a deferred v39
// link refuses the COMMIT (J5.5: a definite 23514, nothing written).
let skipAuditRow = null;
export function setRevisionSkipAuditRowForTests(action) { skipAuditRow = action ?? null; }

function write({ ctx, where, requestKey, requestHash, action, body }) {
  return runWrite({
    ctx, where, requestKey, requestHash, action, requests: REVISION_REQUESTS, classify: classifyRevisionError, idsOf: revisionIdsOf,
    reread: (executor, record) => operationAnswer(executor, record), body,
  });
}

// ---------------------------------------------------------------------------
// L1: POST /fields/:fieldId/revisions - revision R+1 as a draft.
// ---------------------------------------------------------------------------
export async function createRevision({ ctx, fieldId: rawField, body }) {
  if (!mayChangeRevisions(ctx)) throw NOT_FOUND();
  const { fieldId } = pathIds(rawField);
  plainObject(body,
    ["requestKey", "valueShape", "parameterKind", "supportsSession", "supportsDrill", "expectedSourceUnit", "expectedSourceBoundUnit", "unitNote", "evidenceStatus", "evidenceRef"],
    ["requestKey", "valueShape", "parameterKind", "supportsSession", "supportsDrill"]);
  const requestKey = uuidField(body.requestKey);
  const { valueShape, parameterKind } = body;
  if (typeof valueShape !== "string" || !VALUE_SHAPES.has(valueShape)) throw refusal(400, "invalid_body", "valueShape is one of number, numeric_text, unit_value_object, zone_distance, event_count.");
  if (typeof parameterKind !== "string" || !PARAMETER_KINDS.has(parameterKind)) throw refusal(400, "invalid_body", "parameterKind is one of none, zone_bounds, event_threshold.");
  if ((valueShape === "zone_distance") !== (parameterKind === "zone_bounds") || (valueShape === "event_count") !== (parameterKind === "event_threshold")) {
    throw refusal(400, "invalid_body", "A zone_distance shape takes zone_bounds, an event_count shape takes event_threshold, and no other shape takes either.");
  }
  if (typeof body.supportsSession !== "boolean" || typeof body.supportsDrill !== "boolean") throw refusal(400, "invalid_body", "supportsSession and supportsDrill are booleans.");
  if (!body.supportsSession && !body.supportsDrill) throw refusal(400, "invalid_body", "At least one of supportsSession and supportsDrill is true.");
  const expectedSourceUnit = body.expectedSourceUnit ?? null;
  if (expectedSourceUnit !== null && !unitTokenOk(expectedSourceUnit)) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  const expectedSourceBoundUnit = body.expectedSourceBoundUnit ?? null;
  if (expectedSourceBoundUnit !== null && parameterKind === "none") throw refusal(400, "invalid_body", "A revision without a bound takes no expectedSourceBoundUnit.");
  if (expectedSourceBoundUnit !== null && !unitTokenOk(expectedSourceBoundUnit)) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  const unitNote = body.unitNote ?? null;
  if (unitNote !== null && !boundedText(unitNote, UNIT_NOTE_MAX_LENGTH)) throw refusal(400, "invalid_body", "unitNote is one line of 1-500 visible characters without surrounding spaces.");
  const evidenceStatus = body.evidenceStatus ?? "unproven";
  if (typeof evidenceStatus !== "string" || !STARTING_STATUSES.has(evidenceStatus)) throw refusal(400, "invalid_body", "evidenceStatus is unproven, documented or observed; verified is derived from the proof.");
  const evidenceRef = body.evidenceRef ?? null;
  if (evidenceStatus === "unproven" && evidenceRef !== null) throw refusal(400, "invalid_body", "An unproven revision takes no evidenceRef.");
  if (evidenceStatus !== "unproven" && !evidenceRefOk(evidenceRef)) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  const normalized = {
    valueShape, parameterKind, supportsSession: body.supportsSession, supportsDrill: body.supportsDrill,
    expectedSourceUnit, expectedSourceBoundUnit, unitNote, evidenceStatus, evidenceRef,
  };
  const action = "source_metric_revision_create";
  const requestHash = hashOf({ contract: CONTRACT, route: "create", fieldId, revisionId: null, body: normalized });
  return write({
    ctx, where: action, requestKey, requestHash, action,
    body: async (client, operationId) => {
      const { field, revisions } = await lockField(client, fieldId);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (field.state !== "active") throw refusal(409, "field_not_active", TEXT.field_not_active);
      const draft = revisions.find((r) => r.state === "draft");
      if (draft) throw refusal(409, "draft_exists", TEXT.draft_exists, { current: { draftRevisionId: draft.id } });
      if (revisions.length >= REVISION_LIMIT) throw refusal(409, "revision_limit", TEXT.revision_limit, { limit: REVISION_LIMIT });
      await databaseAgrees(client, {
        units: [expectedSourceUnit, expectedSourceBoundUnit].filter((u) => u !== null),
        texts: unitNote === null ? [] : [[unitNote, UNIT_NOTE_MAX_LENGTH, "invalid_body", "unitNote is one line of 1-500 visible characters without surrounding spaces."]],
        evidenceRef,
      });
      if (writeHold) await writeHold(client, "create");
      const nextNumber = revisions.reduce((max, r) => Math.max(max, r.revision_number), 0) + 1;
      const revisionId = (await client.query(
        `insert into training_load.source_metric_definition_versions
           (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
            expected_source_unit, expected_source_bound_unit, unit_note, evidence_status, evidence_ref, created_by_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning id`,
        [fieldId, nextNumber, valueShape, parameterKind, body.supportsSession, body.supportsDrill,
          expectedSourceUnit, expectedSourceBoundUnit, unitNote, evidenceStatus, evidenceRef, ctx.userId],
      )).rows[0].id;
      if (skipAuditRow !== action) {
        await revisionAuditRow(client, { action, fieldId, revisionId, fromStatus: null, toStatus: "draft", evidenceRef, ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, operation_id: operationId, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}

// ---------------------------------------------------------------------------
// L2 / L5: POST /fields/:fieldId/revisions/:revisionId/retire - a draft (L2)
// or the active revision with no successor (L5), with the pinned step.
// ---------------------------------------------------------------------------
export async function retireRevision({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayChangeRevisions(ctx)) throw NOT_FOUND();
  const { fieldId, revisionId } = pathIds(rawField, rawRevision);
  plainObject(body, ["requestKey", "reason"], ["requestKey", "reason"]);
  const requestKey = uuidField(body.requestKey);
  const reason = reasonOf(body);
  const action = "source_metric_revision_retire";
  const requestHash = hashOf({ contract: CONTRACT, route: "retire", fieldId, revisionId, body: { reason } });
  return write({
    ctx, where: action, requestKey, requestHash, action,
    body: async (client, operationId) => {
      const { revisions } = await lockField(client, fieldId);
      const target = revisions.find((r) => r.id === revisionId);
      if (!target) throw NOT_FOUND();
      const pinned = await lockPinned(client, revisionId);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (target.state === "retired") throw refusal(409, "revision_retired", TEXT.revision_retired);
      const toDisable = await pinnedDecisions(client, pinned);
      await databaseAgrees(client, { texts: [[reason, REASON_MAX_LENGTH, "invalid_body", TEXT.invalid_reason]] });
      if (writeHold) await writeHold(client, "retire");
      await disablePinned(client, ctx, toDisable);
      await retire(client, ctx, revisionId, reason);
      await disabledAuditRows(client, ctx, toDisable, operationId);
      if (skipAuditRow !== action) {
        await revisionAuditRow(client, { action, fieldId, revisionId, fromStatus: target.state, toStatus: "retired", reason, ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, operation_id: operationId, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}

// ---------------------------------------------------------------------------
// L3: POST /fields/:fieldId/revisions/:revisionId/activate - a draft, while the
// field has no active revision (O2 does not apply, see O3).
// ---------------------------------------------------------------------------
export async function activateRevision({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayChangeRevisions(ctx)) throw NOT_FOUND();
  const { fieldId, revisionId } = pathIds(rawField, rawRevision);
  plainObject(body, ["requestKey"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const action = "source_metric_revision_activate";
  const requestHash = hashOf({ contract: CONTRACT, route: "activate", fieldId, revisionId, body: {} });
  return write({
    ctx, where: action, requestKey, requestHash, action,
    body: async (client, operationId) => {
      const { field, revisions } = await lockField(client, fieldId);
      const target = revisions.find((r) => r.id === revisionId);
      if (!target) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (target.state !== "draft") throw refusal(409, "revision_not_draft", TEXT.revision_not_draft, { current: { state: target.state } });
      if (field.state !== "active") throw refusal(409, "field_not_active", TEXT.field_not_active);
      const active = revisions.find((r) => r.state === "active");
      if (active) throw refusal(409, "revision_active_exists", TEXT.revision_active_exists, { current: { activeRevisionId: active.id } });
      if (writeHold) await writeHold(client, "activate");
      await activate(client, ctx, revisionId);
      if (skipAuditRow !== action) {
        await revisionAuditRow(client, { action, fieldId, revisionId, fromStatus: "draft", toStatus: "active", ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, operation_id: operationId, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}

// ---------------------------------------------------------------------------
// L4: POST /fields/:fieldId/revisions/:revisionId/replace - the active R ->
// retired and the draft R+1 (:revisionId) -> active, in one transaction (R1),
// with the pinned step on R.
// ---------------------------------------------------------------------------
export async function replaceRevision({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayChangeRevisions(ctx)) throw NOT_FOUND();
  const { fieldId, revisionId } = pathIds(rawField, rawRevision);
  plainObject(body, ["requestKey", "reason", "expectedActiveRevisionId"], ["requestKey", "reason", "expectedActiveRevisionId"]);
  const requestKey = uuidField(body.requestKey);
  const reason = reasonOf(body);
  const expectedActiveRevisionId = uuidField(body.expectedActiveRevisionId);
  const action = "source_metric_revision_activate";
  const requestHash = hashOf({ contract: CONTRACT, route: "replace", fieldId, revisionId, body: { reason, expectedActiveRevisionId } });
  return write({
    ctx, where: "source_metric_revision_replace", requestKey, requestHash, action,
    body: async (client, operationId) => {
      const { field, revisions } = await lockField(client, fieldId);
      const successor = revisions.find((r) => r.id === revisionId);
      if (!successor) throw NOT_FOUND();
      const active = revisions.find((r) => r.state === "active") ?? null;
      // The pinned step's locks on the revision this request means to retire,
      // when it is the field's active one.
      const pinned = active && active.id === expectedActiveRevisionId ? await lockPinned(client, active.id) : null;
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (successor.state !== "draft") throw refusal(409, "revision_not_draft", TEXT.revision_not_draft, { current: { state: successor.state } });
      if (field.state !== "active") throw refusal(409, "field_not_active", TEXT.field_not_active);
      if (!active) throw refusal(409, "revision_not_active", TEXT.revision_not_active);
      if (active.id !== expectedActiveRevisionId) throw refusal(409, "revision_changed", TEXT.revision_changed, { current: { activeRevisionId: active.id } });
      // O2: a verified revision is replaced only by a verified one.
      if (active.evidence_status === "verified" && successor.evidence_status !== "verified") {
        throw refusal(409, "successor_not_verified", TEXT.successor_not_verified);
      }
      const toDisable = await pinnedDecisions(client, pinned);
      await databaseAgrees(client, { texts: [[reason, REASON_MAX_LENGTH, "invalid_body", TEXT.invalid_reason]] });
      if (writeHold) await writeHold(client, "replace");
      await disablePinned(client, ctx, toDisable);
      await retire(client, ctx, active.id, reason);
      await activate(client, ctx, revisionId);
      await disabledAuditRows(client, ctx, toDisable, operationId);
      if (skipAuditRow !== "source_metric_revision_retire") {
        await revisionAuditRow(client, { action: "source_metric_revision_retire", fieldId, revisionId: active.id, fromStatus: "active", toStatus: "retired", reason, ctx, operationId });
      }
      if (skipAuditRow !== action) {
        await revisionAuditRow(client, { action, fieldId, revisionId, fromStatus: "draft", toStatus: "active", ctx, operationId, requestKey, requestHash });
      }
      return { operation: action, operation_id: operationId, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}
