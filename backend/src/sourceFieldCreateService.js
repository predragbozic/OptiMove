// G1, route C (docs/ai/gpexe-field-inventory-plan.md, section 8.1): an active platform admin, in the platform workspace,
// creates a generic GPEXE field from a name the inventory observed (I1, v72). One write, in M2's machinery
// (adminWriteKit): the per-user lock, the request record (the keyed source_metric_create row of T8), the acting user,
// then T2a, its source_metric_create row, revision 1 as a draft and its activation through v39's own chains - so the
// field starts as revision 1, active, unproven, as C91 asks - and the bounded COMMIT (v74's deferred link).
// The key is derived by the server (sourceFieldCreate.js), never typed; a name the inventory never saw, a structural
// key, a name outside T2a's key rule or a taken key is refused before anything is written.
import { adminWriteKit, SourceMetricMappingError } from "./sourceMetricMappingService.js";
import { mayVerify } from "./sourceFieldVerificationService.js";
import { deriveField, FieldCreateRefusal, LABEL_MAX_LENGTH, parseCreateFieldBody } from "./sourceFieldCreate.js";

const { runWrite, rightsStillHold, refusal, NOT_FOUND, MESSAGES, hashOf, REVISION_COLUMNS, revisionOut } = adminWriteKit;

const CONTRACT = "source-field-create/v1";
export const mayCreateFields = mayVerify;

const TEXT = {
  name_not_observed: "GPEXE has not sent this name through any connection yet; find new sessions first.",
  field_exists: "A source field with this key already exists.",
  invalid_label: `label is one line of 1-${LABEL_MAX_LENGTH} visible characters without surrounding spaces.`,
};

// The request record: the keyed source_metric_create row (one key space with M2's, M2b's and the lifecycle's writes).
const FIELD_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, source_metric_definition_id, source_metric_version_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const idsOf = (written) => ({ fieldId: written.source_metric_definition_id ?? null, revisionId: null });

function classify(error) {
  if (error instanceof SourceMetricMappingError) return error;
  const code = error?.code;
  if (code === "55P03" || code === "40P01" || code === "57014") return refusal(409, "try_again", MESSAGES.try_again);
  if (code === "23505" && error.constraint === "source_metric_definitions_identity_key") return refusal(409, "field_exists", TEXT.field_exists);
  if (code === "23505" && (error.constraint === "source_metric_audit_one_request_per_key" || error.constraint === "source_metric_audit_one_request_per_operation")) {
    return refusal(409, "try_again", MESSAGES.try_again);
  }
  return null;
}

// The answer: the field and its revision 1, read by the operation's field.
async function fieldAnswer(executor, record) {
  const field = (await executor.query(
    `select id, source_system, api_family, source_metric_key, source_label, state from training_load.source_metric_definitions where id = $1`,
    [record.source_metric_definition_id],
  )).rows[0];
  if (!field) return null;
  const revision = (await executor.query(
    `select ${REVISION_COLUMNS} from training_load.source_metric_definition_versions where source_metric_definition_id = $1 and revision_number = 1`,
    [field.id],
  )).rows[0];
  return {
    field: { id: field.id, sourceSystem: field.source_system, apiFamily: field.api_family, key: field.source_metric_key, label: field.source_label, state: field.state },
    revision: revision ? revisionOut(revision) : null,
  };
}

async function auditRow(client, { action, fieldId, revisionId = null, fromStatus = null, toStatus, ctx, operationId, requestKey = null, requestHash = null }) {
  await client.query(
    `insert into training_load.source_metric_audit
       (action, source_metric_definition_id, source_metric_version_id, from_status, to_status, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, 'platform_admin', $7, $8, $9)`,
    [action, fieldId, revisionId, fromStatus, toStatus, ctx.userId, operationId, requestKey, requestHash],
  );
}

// Test seam (never set by the application): runs inside the write after every check, before the first insert.
let writeHold = null;
export function setFieldCreateHoldForTests(fn) { writeHold = fn ?? null; }

// POST /fields
export async function createField({ ctx, body }) {
  if (!mayCreateFields(ctx)) throw NOT_FOUND();
  let parsed;
  let derived;
  try {
    parsed = parseCreateFieldBody(body);
    derived = deriveField(parsed);
  } catch (error) {
    if (error instanceof FieldCreateRefusal) throw refusal(error.status, error.code, error.message);
    throw error;
  }
  const { requestKey, endpoint, name, label } = parsed;
  const action = "source_metric_create";
  const requestHash = hashOf({ contract: CONTRACT, body: { endpoint, name, label, supportsSession: parsed.supportsSession, supportsDrill: parsed.supportsDrill } });
  return runWrite({
    ctx, where: "source_field_create", requestKey, requestHash, action, requests: FIELD_REQUESTS, classify, idsOf,
    reread: (executor, record) => fieldAnswer(executor, record),
    body: async (client, operationId) => {
      // The inventory: the name was observed on this endpoint through a rest_v1 connection, and its latest unit word.
      // The word is a quantity kind (plan section 8.10): the expected unit is its seeded unit token, or none - a word
      // without a row of source_unit_words is never guessed.
      const seen = (await client.query(
        `select o.unit_word, w.unit_token from training_load.source_field_observations o
           left join training_load.source_unit_words w on w.source_system = 'gpexe' and w.api_family = 'rest_v1' and w.word = o.unit_word
          where o.api_family = 'rest_v1' and o.endpoint = $1 and o.field_name = $2
          order by o.last_seen_at desc, o.source_connection_id limit 1`,
        [endpoint, name],
      )).rows[0];
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (!seen) throw refusal(409, "name_not_observed", TEXT.name_not_observed);
      const taken = (await client.query(
        `select id from training_load.source_metric_definitions where source_system = 'gpexe' and api_family = 'rest_v1' and source_metric_key = $1`,
        [derived.sourceMetricKey],
      )).rows[0];
      if (taken) throw refusal(409, "field_exists", TEXT.field_exists, { current: { fieldId: taken.id } });
      if ((await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [label, LABEL_MAX_LENGTH])).rows[0].ok !== true) {
        throw refusal(400, "invalid_body", TEXT.invalid_label);
      }
      const expected = seen.unit_token ?? null;
      if (writeHold) await writeHold(client);
      const fieldId = (await client.query(
        `insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id)
         values ('gpexe', 'rest_v1', $1, $2, $3) returning id`,
        [derived.sourceMetricKey, label, ctx.userId],
      )).rows[0].id;
      await auditRow(client, { action, fieldId, toStatus: "active", ctx, operationId, requestKey, requestHash });
      const revisionId = (await client.query(
        `insert into training_load.source_metric_definition_versions
           (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
            expected_source_unit, evidence_status, created_by_user_id)
         values ($1, 1, $2, 'none', $3, $4, $5, 'unproven', $6) returning id`,
        [fieldId, derived.valueShape, derived.supportsSession, derived.supportsDrill, expected, ctx.userId],
      )).rows[0].id;
      await auditRow(client, { action: "source_metric_revision_create", fieldId, revisionId, toStatus: "draft", ctx, operationId });
      await client.query(
        `update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = clock_timestamp() where id = $1`,
        [revisionId, ctx.userId],
      );
      await auditRow(client, { action: "source_metric_revision_activate", fieldId, revisionId, fromStatus: "draft", toStatus: "active", ctx, operationId });
      return { operation: action, operation_id: operationId, source_metric_definition_id: fieldId };
    },
  });
}
