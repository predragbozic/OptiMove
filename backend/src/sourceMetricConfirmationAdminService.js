// The two platform-admin operations on stored confirmation values (J18;
// docs/ai/c112-drag-mapping-contract.md, sections 4.2 routes 6 and 7, 5.8):
//   route 6  POST /confirmations/:confirmationId/erase-values - remove one
//            confirmation's values on request, with a fixed reason code;
//   route 7  POST /confirmations/expired-values/remove - the on-demand
//            backstop of the scheduled removal, under the admin's identity.
// Both only for an active platform admin in the platform workspace; everyone
// else, the confirmer included, gets the identical 404. No screen in J18: the
// runbook says how they are called. Neither returns or logs a value.
import { adminWriteKit, classifyDatabaseError, SourceMetricMappingError } from "./sourceMetricMappingService.js";
import { boardKit } from "./sourceMetricBoardService.js";
import { REMOVAL_BATCH } from "./sourceMetricConfirmationRemoval.js";

const { runWrite, rightsStillHold, refusal, NOT_FOUND, plainObject, uuidField, hashOf, UUID } = adminWriteKit;

export const ERASE_REASON_CODES = Object.freeze(["erasure_request", "wrong_confirmation"]);
export const mayRemoveConfirmationValues = (ctx) => ctx?.owner?.scope === "system" && ctx.basis === "platform_admin";

const REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, confirmation_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const ACTOR_TEXTS = new Set([
  "source metric confirmation: the acting user may not remove these values",
  "source metric confirmation: the acting user may not write this audit row",
]);
function classify(error) {
  if (error instanceof SourceMetricMappingError) return error;
  if (error?.code === "42501" && ACTOR_TEXTS.has(error.message)) {
    console.error("[source-metric-board] db_actor_refusal (42501)");
    return NOT_FOUND();
  }
  if (error?.code === "23505" && error.constraint === "source_metric_audit_v65_confirmation_once") {
    return refusal(409, "values_already_removed", "The values of this confirmation were already removed.");
  }
  return classifyDatabaseError(error);
}

// Route 6.
export async function eraseConfirmationValues({ ctx, confirmationId, body }) {
  if (!mayRemoveConfirmationValues(ctx)) throw NOT_FOUND();
  if (typeof confirmationId !== "string" || !UUID.test(confirmationId)) throw NOT_FOUND();
  const id = confirmationId.toLowerCase();
  plainObject(body, ["requestKey", "reasonCode"], ["requestKey", "reasonCode"]);
  const requestKey = uuidField(body.requestKey);
  if (typeof body.reasonCode !== "string" || !ERASE_REASON_CODES.includes(body.reasonCode)) {
    throw refusal(400, "invalid_body", "reasonCode is erasure_request or wrong_confirmation.");
  }
  const reasonCode = body.reasonCode;
  const requestHash = hashOf({ op: "confirmation_values_erased", confirmationId: id, reasonCode });
  return runWrite({
    ctx, where: "confirmation_erase", requestKey, requestHash, action: "confirmation_values_erased", requests: REQUESTS, classify,
    idsOf: () => ({ confirmationId: id }),
    reread: (executor) => boardKit.confirmationById(executor, ctx, id),
    body: async (client, operationId) => {
      // The confirmation's row first, FOR UPDATE: this and the removal of
      // expired values never work on one confirmation at once (section 5.8).
      const row = (await client.query(`select id from training_load.source_metric_confirmations where id = $1 for update`, [id])).rows[0];
      if (!row) throw NOT_FOUND();
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const held = (await client.query(
        `select count(*)::int as n from training_load.source_metric_confirmation_items where confirmation_id = $1 and checked and values_removed_at is null`, [id],
      )).rows[0].n;
      if (held === 0) throw refusal(409, "values_already_removed", "The values of this confirmation were already removed.");
      await client.query(
        `update training_load.source_metric_confirmation_items
            set raw_a = null, stored_a = null, raw_b = null, stored_b = null, values_salt = null, values_removed_kind = 'erased'
          where confirmation_id = $1 and checked and values_removed_at is null`,
        [id],
      );
      await client.query(
        `insert into training_load.source_metric_audit (action, confirmation_id, reason, performed_by_user_id, basis, operation_id, request_key, request_hash)
         values ('confirmation_values_erased', $1, $2, $3, $4, $5, $6, $7)`,
        [id, reasonCode, ctx.userId, ctx.basis, operationId, requestKey, requestHash],
      );
      return { operation_id: operationId, confirmation_id: id };
    },
  });
}

// Route 7. At most REMOVAL_BATCH confirmations per call; `more` says whether
// values past their date are still stored.
async function removalAnswer(executor, operationId) {
  const removed = (await executor.query(
    `select count(*)::int as n from training_load.source_metric_audit where operation_id = $1 and action = 'confirmation_values_expired'`, [operationId],
  )).rows[0].n;
  const more = (await executor.query(
    `select exists (select 1 from training_load.source_metric_confirmations c
                     where c.values_expire_at <= now()
                       and exists (select 1 from training_load.source_metric_confirmation_items i
                                    where i.confirmation_id = c.id and i.checked and i.values_removed_at is null)) as more`,
  )).rows[0].more;
  return { removed, more };
}
export async function removeExpiredConfirmationValues({ ctx, body }) {
  if (!mayRemoveConfirmationValues(ctx)) throw NOT_FOUND();
  plainObject(body, ["requestKey"], ["requestKey"]);
  const requestKey = uuidField(body.requestKey);
  const requestHash = hashOf({ op: "confirmation_values_expired" });
  return runWrite({
    ctx, where: "confirmation_expired_removal", requestKey, requestHash, action: "confirmation_values_expired", requests: REQUESTS, classify,
    idsOf: () => ({}),
    reread: (executor, record) => removalAnswer(executor, record.operation_id),
    body: async (client, operationId) => {
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      const taken = (await client.query(`select training_load.remove_expired_confirmation_values($1) as ids`, [REMOVAL_BATCH])).rows[0].ids;
      // Only the confirmations whose values THIS transaction removed: one that the schedule or an erasure emptied
      // a moment earlier is returned by the function too (its row was free), with nothing left to remove.
      const ids = (await client.query(
        `select distinct i.confirmation_id as id from training_load.source_metric_confirmation_items i
          where i.confirmation_id = any($1::uuid[]) and i.values_removed_kind = 'expired'
            and i.xmin::text::bigint = training_load.source_metric_current_xmin()
          order by 1`,
        [taken],
      )).rows.map((r) => r.id);
      // One row per confirmation whose values were removed, each after its
      // removal; the last one is the operation's keyed request record. A run
      // that removed nothing writes no row.
      for (const [index, confirmationId] of ids.entries()) {
        const last = index === ids.length - 1;
        await client.query(
          `insert into training_load.source_metric_audit (action, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash)
           values ('confirmation_values_expired', $1, $2, $3, $4, $5, $6)`,
          [confirmationId, ctx.userId, ctx.basis, operationId, last ? requestKey : null, last ? requestHash : null],
        );
      }
      return { operation_id: operationId };
    },
  });
}
