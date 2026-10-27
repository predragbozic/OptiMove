// Test fixtures for source-field revisions (T2b) on a disposable database
// carrying v39 (docs/ai/v39-revision-lifecycle-contract.md, J5.3): every write
// goes through the lifecycle's database path with every guard on - the acting
// user set the way the services set it (the v35 transaction-local setting),
// each write followed by its own audit row (T8), one transaction per call. No
// trigger is switched off. The acting user must be an active platform admin.
import crypto from "node:crypto";

const ACTOR_SQL = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;

async function inTransaction(client, actorId, work) {
  await client.query("begin");
  try {
    await client.query(ACTOR_SQL, [String(actorId).toLowerCase()]);
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

const auditRow = (client, { action, fieldId, revisionId, fromStatus = null, toStatus = null, reason = null, evidenceRef = null, by, operationId }) => client.query(
  `insert into training_load.source_metric_audit
     (action, source_metric_definition_id, source_metric_version_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id)
   values ($1, $2, $3, $4, $5, $6, $7, $8, 'platform_admin', $9)`,
  [action, fieldId, revisionId, fromStatus, toStatus, reason, evidenceRef, by, operationId ?? crypto.randomUUID()],
);

// A revision of `fieldId`, created as a draft and taken as far as asked: the unit
// act (unit / boundUnit), the meaning act (meaning: true, with operator), the
// activation and the retirement - each with its audit row.
export async function writeRevision(client, {
  fieldId, by, revisionNumber = 1, valueShape = "number", parameterKind = "none", supportsSession = true, supportsDrill = true,
  expectedSourceUnit = null, evidenceStatus = "observed", evidenceRef = null, unit = null, boundUnit = null, unitRef = null,
  meaning = false, operator = null, meaningRef = null, state = "active", retiredReason = "Test retirement",
}) {
  return inTransaction(client, by, async () => {
    const revisionId = (await client.query(
      `insert into training_load.source_metric_definition_versions
         (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
          expected_source_unit, evidence_status, evidence_ref, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [fieldId, revisionNumber, valueShape, parameterKind, supportsSession, supportsDrill, expectedSourceUnit, evidenceStatus,
        evidenceStatus === "unproven" ? null : evidenceRef, by],
    )).rows[0].id;
    await auditRow(client, { action: "source_metric_revision_create", fieldId, revisionId, toStatus: "draft", by });
    if (unit !== null) {
      await client.query(
        `update training_load.source_metric_definition_versions
            set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5
          where id = $1`,
        [revisionId, unit, boundUnit, by, unitRef],
      );
      await auditRow(client, { action: "source_metric_unit_verified", fieldId, revisionId, evidenceRef: unitRef, by });
    }
    if (meaning) {
      await client.query(
        `update training_load.source_metric_definition_versions
            set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4,
                evidence_status = case when source_unit is not null then 'verified' else evidence_status end
          where id = $1`,
        [revisionId, operator, by, meaningRef],
      );
      await auditRow(client, { action: "source_metric_meaning_verified", fieldId, revisionId, evidenceRef: meaningRef, by });
    }
    if (state === "active" || state === "retired") {
      await client.query(
        `update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`,
        [revisionId, by],
      );
      await auditRow(client, { action: "source_metric_revision_activate", fieldId, revisionId, fromStatus: "draft", toStatus: "active", by });
    }
    if (state === "retired") {
      await client.query(
        `update training_load.source_metric_definition_versions
            set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = $3 where id = $1`,
        [revisionId, by, retiredReason],
      );
      await auditRow(client, { action: "source_metric_revision_retire", fieldId, revisionId, fromStatus: "active", toStatus: "retired", reason: retiredReason, by });
    }
    return revisionId;
  });
}

// Retires an existing draft or active revision, with its audit row (the
// pinned versions must allow it: v34 refuses while one is needs_review or active).
export async function retireRevisionRow(client, { fieldId, revisionId, by, reason = "Test retirement" }) {
  return inTransaction(client, by, async () => {
    const from = (await client.query(
      `select state from training_load.source_metric_definition_versions where id = $1 for update`, [revisionId],
    )).rows[0].state;
    await client.query(
      `update training_load.source_metric_definition_versions
          set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = $3 where id = $1`,
      [revisionId, by, reason],
    );
    await auditRow(client, { action: "source_metric_revision_retire", fieldId, revisionId, fromStatus: from, toStatus: "retired", reason, by });
  });
}

// Activates an existing draft, with its audit row.
export async function activateRevisionRow(client, { fieldId, revisionId, by }) {
  return inTransaction(client, by, async () => {
    await client.query(
      `update training_load.source_metric_definition_versions set state = 'active', activated_by_user_id = $2, activated_at = now() where id = $1`,
      [revisionId, by],
    );
    await auditRow(client, { action: "source_metric_revision_activate", fieldId, revisionId, fromStatus: "draft", toStatus: "active", by });
  });
}

// The unit act and / or the meaning act on an existing revision, each with its
// audit row, in one transaction (as M2b writes them; a zone's meaning act is
// refused by the database until the zone model is decided, C89).
export async function verifyRevisionRow(client, { fieldId, revisionId, by, unit = null, boundUnit = null, unitRef = null, meaning = false, operator = null, meaningRef = null }) {
  return inTransaction(client, by, async () => {
    if (unit !== null) {
      await client.query(
        `update training_load.source_metric_definition_versions
            set source_unit = $2, source_bound_unit = $3, unit_verified_by_user_id = $4, unit_verified_at = now(), unit_evidence_ref = $5,
                evidence_status = case when meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null)
                                       then 'verified' else evidence_status end
          where id = $1`,
        [revisionId, unit, boundUnit, by, unitRef],
      );
      await auditRow(client, { action: "source_metric_unit_verified", fieldId, revisionId, evidenceRef: unitRef, by });
    }
    if (meaning) {
      await client.query(
        `update training_load.source_metric_definition_versions
            set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4,
                evidence_status = case when source_unit is not null then 'verified' else evidence_status end
          where id = $1`,
        [revisionId, operator, by, meaningRef],
      );
      await auditRow(client, { action: "source_metric_meaning_verified", fieldId, revisionId, evidenceRef: meaningRef, by });
    }
  });
}

// A zone's meaning act as a later owner decision on the zone model (C89) might
// allow it: the act guard and its deferred audit link (the triggers
// source_metric_revisions_v37_actor_guard and _v37_audit_link) are off for this
// one statement only - a pending deferred event would block switching them on
// again -, and the act still carries its audit row, written with every T8 guard
// on - on a disposable database only. Nothing of the revision lifecycle goes
// through here.
const ZONE_ACT_TRIGGERS = ["source_metric_revisions_v37_actor_guard", "source_metric_revisions_v37_audit_link"];
export async function zoneMeaningAsFutureDecision(client, { fieldId, revisionId, by, operator, meaningRef }) {
  return inTransaction(client, by, async () => {
    for (const t of ZONE_ACT_TRIGGERS) await client.query(`alter table training_load.source_metric_definition_versions disable trigger ${t}`);
    await client.query(
      `update training_load.source_metric_definition_versions
          set bound_operator = $2, meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_evidence_ref = $4,
              evidence_status = case when source_unit is not null then 'verified' else evidence_status end
        where id = $1`,
      [revisionId, operator, by, meaningRef],
    );
    for (const t of ZONE_ACT_TRIGGERS) await client.query(`alter table training_load.source_metric_definition_versions enable trigger ${t}`);
    await auditRow(client, { action: "source_metric_meaning_verified", fieldId, revisionId, evidenceRef: meaningRef, by });
  });
}
