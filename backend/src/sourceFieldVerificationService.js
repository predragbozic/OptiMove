// Source-field evidence confirmation (M2b): an active platform admin, in the
// platform workspace, confirms on an existing revision of a source field (T2b,
// training_load.source_metric_definition_versions) its unit and its meaning,
// each in its own act, once, with a reference to a merged evidence document.
// Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions
// C89-C97 and section J4 (owner's decisions of 2026-10-15).
//
// - The unit act writes the proven unit - and, for a zone or an event
//   threshold, the proven bound unit (v34 demands both together) - with the
//   acting user, the time and the unit evidence reference.
// - The meaning act writes the acting user, the time and the meaning evidence
//   reference - and, for an event threshold, the bound operator. For a zone
//   (parameter_kind zone_bounds) it is refused with 409
//   verification_model_unresolved until the owner decides how closed and open
//   zones share one bound operator (C89); no boundOperator gets past it.
// - evidence_status is always derived by the server (C92): an act that
//   completes the proof raises it to verified (as v34's CHECK demands),
//   otherwise it stays as it was.
// - The meaning itself is never stored: T2b keeps only the stable reference;
//   the content stays in the evidence document (C93). A reference is checked by
//   its format only, never against a file (C95): the evidence document and its
//   anchor are merged before a real act.
// - A wrong confirmation is never overwritten; its correction is a new revision
//   (the revision-lifecycle contract, C91), not part of M2b.
//
// Every write is one bounded transaction of M2's machinery (adminWriteKit):
// the per-user advisory lock, the request record looked up before any row lock
// (the act's own T8 audit row; a replay answers the current state after the
// right is checked again; the same key with another request is
// request_key_reused), the acting user as the v35 transaction-local setting
// before the first protected write (the v37 guards require it), the right and
// the user FOR SHARE, and a bounded COMMIT whose lost answer is verified on
// another connection by the request record. Lock order: the advisory lock ->
// the request record -> the T2b row FOR UPDATE (T2a is read plainly: a
// revision that is not retired implies an active field) -> the role and user
// rows FOR SHARE -> the T2b update -> the T8 row -> the COMMIT (v37's deferred
// audit link). No T3, T4, canonical or binding row is locked.
import { adminWriteKit, LIST_CAPS, SourceMetricMappingError } from "./sourceMetricMappingService.js";
import { unitTokenOk } from "./canonicalVariableAdminService.js";

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, hashOf, UUID,
  REVISION_COLUMNS, revisionOut,
} = adminWriteKit;

// The version of this request contract inside every request hash.
const CONTRACT = "source-fields/v1";
// The closed operator set of a bound (v34 bound_operator).
const OPERATORS = new Set(["between", ">=", ">", "<=", "<"]);
// The JavaScript twin of training_load.source_metric_evidence_ref_ok() (v34,
// C40): a repository-relative docs/ path and one heading anchor, 1-300
// characters. The database function decides again inside the write.
const EVIDENCE_REF = /^docs(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+#[A-Za-z0-9_-]+$/;
export function evidenceRefOk(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 300 && EVIDENCE_REF.test(value);
}
const RETRY_CONSTRAINTS = new Set(["source_metric_audit_one_request_per_key", "source_metric_audit_one_request_per_operation"]);

const TEXT = {
  invalid_unit: "The unit is not a unit token (1-30 characters, no space, '|' or '=').",
  invalid_evidence_ref: "evidenceRef is a repository path under docs/ with one heading anchor (docs/...#anchor), at most 300 characters.",
  invalid_operator: "boundOperator is one of between, >=, >, <=, <.",
  bound_unit_required: "This revision has a bound: sourceBoundUnit is confirmed together with the unit.",
  bound_unit_not_allowed: "This revision has no bound: sourceBoundUnit is not taken.",
  operator_required: "This revision is an event threshold: boundOperator is confirmed together with the meaning.",
  operator_not_allowed: "This revision has no bound: boundOperator is not taken.",
  verification_model_unresolved: "The meaning of a zone revision cannot be confirmed yet: how closed and open zones share one bound operator is not decided.",
  revision_retired: "The revision is retired; it is never changed.",
  unit_already_verified: "The unit of this revision is already confirmed; a correction is a new revision.",
  meaning_already_verified: "The meaning of this revision is already confirmed; a correction is a new revision.",
};

// Writes are a platform admin's in the platform workspace only (C94); every
// other caller of a write route gets the identical 404 - the router asks this
// before it looks at the body, so no other caller learns anything from a 415.
export const mayVerify = (ctx) => ctx?.basis === "platform_admin" && ctx?.owner?.scope === "system";

// ---------------------------------------------------------------------------
// Read: one source field with its revisions and its verification history.
// ---------------------------------------------------------------------------
// GET /fields/:fieldId - the same audience as GET /fields (C94). The history
// names the act, its time and its reference, never who performed it.
export async function getField({ ctx, fieldId, query }) {
  void ctx;
  if (Object.keys(query ?? {}).length > 0) throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  if (typeof fieldId !== "string" || !UUID.test(fieldId)) return null;
  return boundedRead(async (client) => {
    const field = (await client.query(
      `select id, source_system, api_family, source_metric_key, source_label, state
         from training_load.source_metric_definitions where id = $1`, [fieldId],
    )).rows[0];
    if (!field) return null;
    const revisions = (await client.query(
      `select ${REVISION_COLUMNS} from training_load.source_metric_definition_versions
        where source_metric_definition_id = $1 order by revision_number desc limit $2`,
      [field.id, LIST_CAPS.revisionsPerField + 1],
    )).rows;
    if (revisions.length > LIST_CAPS.revisionsPerField) throw tooLarge(LIST_CAPS.revisionsPerField);
    const history = (await client.query(
      `select source_metric_version_id, action, performed_at, evidence_ref from training_load.source_metric_audit
        where source_metric_definition_id = $1 and action in ('source_metric_unit_verified', 'source_metric_meaning_verified')
        order by performed_at, id limit $2`,
      [field.id, 2 * LIST_CAPS.revisionsPerField + 1],
    )).rows;
    if (history.length > 2 * LIST_CAPS.revisionsPerField) throw tooLarge(2 * LIST_CAPS.revisionsPerField);
    return {
      field: {
        id: field.id, sourceSystem: field.source_system, apiFamily: field.api_family, key: field.source_metric_key,
        label: field.source_label, state: field.state, revisions: revisions.map(revisionOut),
      },
      verifications: history.map((h) => ({
        revisionId: h.source_metric_version_id, act: h.action === "source_metric_unit_verified" ? "unit" : "meaning",
        at: h.performed_at, evidenceRef: h.evidence_ref,
      })),
    };
  });
}
function tooLarge(limit) {
  return refusal(409, "result_too_large", "The result is larger than this route returns at once.", { limit });
}

// ---------------------------------------------------------------------------
// Writes: the unit act and the meaning act.
// ---------------------------------------------------------------------------
// The act's own T8 audit row is the request record (D10): one key space with
// M2's mapping writes, so a key used for another operation is request_key_reused.
const FIELD_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, source_metric_definition_id, source_metric_version_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const fieldIdsOf = (written) => ({ fieldId: written.source_metric_definition_id ?? null, revisionId: written.source_metric_version_id ?? null });

// Only the allowlisted database refusals become a 4xx; everything else is a
// sanitized 500 (logged by its code only, by the router). The v34 / v37
// trigger refusals are backstops behind the service's own checks.
export function classifyFieldError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") {
    console.error(`[source-field-verification] try_again (${code})`);
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  if (code === "23505" && RETRY_CONSTRAINTS.has(error.constraint)) return refusal(409, "try_again", MESSAGES.try_again);
  return null;
}

// A write's answer and a replay: the revision as it is now.
async function revisionAnswer(executor, fieldId, revisionId) {
  const row = (await executor.query(
    `select ${REVISION_COLUMNS} from training_load.source_metric_definition_versions where id = $1 and source_metric_definition_id = $2`,
    [revisionId, fieldId],
  )).rows[0];
  return row ? { revision: { fieldId: row.source_metric_definition_id, ...revisionOut(row) } } : null;
}

// The revision of the act, FOR UPDATE (the first registry lock of the act).
async function lockedRevision(client, fieldId, revisionId) {
  const row = (await client.query(
    `select id, source_metric_definition_id, state, parameter_kind, source_unit, source_bound_unit, bound_operator,
            unit_verified_at, unit_evidence_ref, meaning_verified_at, meaning_evidence_ref
       from training_load.source_metric_definition_versions
      where id = $1 and source_metric_definition_id = $2 for update`,
    [revisionId, fieldId],
  )).rows[0];
  if (!row) throw NOT_FOUND();
  return row;
}

// The database's own rules, once more inside the write (the JavaScript twins
// decided before any lock; they must agree).
async function databaseAgrees(client, units, evidenceRef) {
  for (const unit of units) {
    const ok = (await client.query(`select training_load.source_metric_unit_token_ok($1) as ok`, [unit])).rows[0].ok;
    if (ok !== true) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  }
  const ref = (await client.query(`select training_load.source_metric_evidence_ref_ok($1) as ok`, [evidenceRef])).rows[0].ok;
  if (ref !== true) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
}

async function insertAuditRow(client, { action, fieldId, revisionId, evidenceRef, ctx, operationId, requestKey, requestHash }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, source_metric_definition_id, source_metric_version_id, evidence_ref, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, 'platform_admin', $6, $7, $8)`,
    [action, fieldId, revisionId, evidenceRef, ctx.userId, operationId, requestKey, requestHash],
  );
}

// Test seam (never set by the application): runs inside a write's transaction
// after every lock is taken and every check passed, right before the update.
let writeHold = null;
export function setFieldWriteHoldForTests(fn) { writeHold = fn ?? null; }

function pathIds(fieldId, revisionId) {
  if (typeof fieldId !== "string" || !UUID.test(fieldId) || typeof revisionId !== "string" || !UUID.test(revisionId)) throw NOT_FOUND();
  return { fieldId: fieldId.toLowerCase(), revisionId: revisionId.toLowerCase() };
}

// POST /fields/:fieldId/revisions/:revisionId/unit-verification
export async function verifyUnit({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayVerify(ctx)) throw NOT_FOUND();
  const { fieldId, revisionId } = pathIds(rawField, rawRevision);
  plainObject(body, ["requestKey", "sourceUnit", "sourceBoundUnit", "evidenceRef"], ["requestKey", "sourceUnit", "evidenceRef"]);
  const requestKey = uuidField(body.requestKey);
  if (!unitTokenOk(body.sourceUnit)) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  const sourceUnit = body.sourceUnit;
  const sourceBoundUnit = body.sourceBoundUnit ?? null;
  if (sourceBoundUnit !== null && !unitTokenOk(sourceBoundUnit)) throw refusal(400, "invalid_unit", TEXT.invalid_unit);
  if (!evidenceRefOk(body.evidenceRef)) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  const evidenceRef = body.evidenceRef;
  const action = "source_metric_unit_verified";
  const requestHash = hashOf({ contract: CONTRACT, operation: action, fieldId, revisionId, body: { sourceUnit, sourceBoundUnit, evidenceRef } });
  return runWrite({
    ctx, where: action, requestKey, requestHash, action, requests: FIELD_REQUESTS, classify: classifyFieldError, idsOf: fieldIdsOf,
    reread: (executor, record) => revisionAnswer(executor, record.source_metric_definition_id, record.source_metric_version_id),
    body: async (client, operationId) => {
      const rev = await lockedRevision(client, fieldId, revisionId);
      if (rev.state === "retired") throw refusal(409, "revision_retired", TEXT.revision_retired);
      if (rev.unit_verified_at !== null) {
        throw refusal(409, "unit_already_verified", TEXT.unit_already_verified, {
          current: { sourceUnit: rev.source_unit, sourceBoundUnit: rev.source_bound_unit, unitEvidenceRef: rev.unit_evidence_ref, unitVerifiedAt: rev.unit_verified_at },
        });
      }
      if (rev.parameter_kind !== "none" && sourceBoundUnit === null) throw refusal(400, "bound_unit_required", TEXT.bound_unit_required);
      if (rev.parameter_kind === "none" && sourceBoundUnit !== null) throw refusal(400, "bound_unit_not_allowed", TEXT.bound_unit_not_allowed);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      await databaseAgrees(client, sourceBoundUnit === null ? [sourceUnit] : [sourceUnit, sourceBoundUnit], evidenceRef);
      if (writeHold) await writeHold(client, action);
      // The status (C92): verified when this act completes the proof (the
      // meaning, and for a bound its operator, already confirmed), else as it
      // was; a first reference comes with the rise from unproven (v34).
      await client.query(
        `update training_load.source_metric_definition_versions
            set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5,
                evidence_status = case when meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null)
                                       then 'verified' else evidence_status end,
                evidence_ref = case when evidence_status = 'unproven' and meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null)
                                    then $5 else evidence_ref end
          where id = $1`,
        [revisionId, sourceUnit, sourceBoundUnit, ctx.userId, evidenceRef],
      );
      await insertAuditRow(client, { action, fieldId, revisionId, evidenceRef, ctx, operationId, requestKey, requestHash });
      return { operation: action, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}

// POST /fields/:fieldId/revisions/:revisionId/meaning-verification
export async function verifyMeaning({ ctx, fieldId: rawField, revisionId: rawRevision, body }) {
  if (!mayVerify(ctx)) throw NOT_FOUND();
  const { fieldId, revisionId } = pathIds(rawField, rawRevision);
  plainObject(body, ["requestKey", "boundOperator", "evidenceRef"], ["requestKey", "evidenceRef"]);
  const requestKey = uuidField(body.requestKey);
  const boundOperator = body.boundOperator ?? null;
  if (boundOperator !== null && (typeof boundOperator !== "string" || !OPERATORS.has(boundOperator))) throw refusal(400, "invalid_operator", TEXT.invalid_operator);
  if (!evidenceRefOk(body.evidenceRef)) throw refusal(400, "invalid_evidence_ref", TEXT.invalid_evidence_ref);
  const evidenceRef = body.evidenceRef;
  const action = "source_metric_meaning_verified";
  const requestHash = hashOf({ contract: CONTRACT, operation: action, fieldId, revisionId, body: { boundOperator, evidenceRef } });
  return runWrite({
    ctx, where: action, requestKey, requestHash, action, requests: FIELD_REQUESTS, classify: classifyFieldError, idsOf: fieldIdsOf,
    reread: (executor, record) => revisionAnswer(executor, record.source_metric_definition_id, record.source_metric_version_id),
    body: async (client, operationId) => {
      const rev = await lockedRevision(client, fieldId, revisionId);
      // C89: a zone's meaning is never confirmed until its model is decided,
      // whatever the body names - before every other check of the act.
      if (rev.parameter_kind === "zone_bounds") throw refusal(409, "verification_model_unresolved", TEXT.verification_model_unresolved);
      if (rev.state === "retired") throw refusal(409, "revision_retired", TEXT.revision_retired);
      if (rev.meaning_verified_at !== null) {
        throw refusal(409, "meaning_already_verified", TEXT.meaning_already_verified, {
          current: { boundOperator: rev.bound_operator, meaningEvidenceRef: rev.meaning_evidence_ref, meaningVerifiedAt: rev.meaning_verified_at },
        });
      }
      if (rev.parameter_kind === "event_threshold" && boundOperator === null) throw refusal(400, "operator_required", TEXT.operator_required);
      if (rev.parameter_kind === "none" && boundOperator !== null) throw refusal(400, "operator_not_allowed", TEXT.operator_not_allowed);
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      await databaseAgrees(client, [], evidenceRef);
      if (writeHold) await writeHold(client, action);
      // The status (C92): verified when the unit is already proven (for an
      // event threshold with its bound unit, which v34 demands with the unit).
      await client.query(
        `update training_load.source_metric_definition_versions
            set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4,
                evidence_status = case when source_unit is not null then 'verified' else evidence_status end,
                evidence_ref = case when evidence_status = 'unproven' and source_unit is not null then $4 else evidence_ref end
          where id = $1`,
        [revisionId, boundOperator, ctx.userId, evidenceRef],
      );
      await insertAuditRow(client, { action, fieldId, revisionId, evidenceRef, ctx, operationId, requestKey, requestHash });
      return { operation: action, source_metric_definition_id: fieldId, source_metric_version_id: revisionId };
    },
  });
}
