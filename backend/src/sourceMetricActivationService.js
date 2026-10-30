// T5 activations (phase 7d of docs/ai/metrics-core-plan.md): starting an active
// mapping version on explicitly listed team bindings (S1, POST /activations),
// ending one activation (S2, POST /activations/:activationId/end) and the
// paged list (S3, GET /activations). Contract:
// docs/ai/phase7d-mapping-activations-contract.md (J10), sections 2-5, 7 and 9;
// the database guard is migration v48.
//
// Who (C106, section 2): an active platform admin - in the platform workspace,
// system mappings on any club's binding; in club X's workspace, system mappings
// and club X's own, on club X's bindings - and the active admin of club X in
// its own workspace, with the same reach. The binding's club is the owner club
// of its connection, never the team's. Everyone and everything else, an
// archived club included, is the identical 404 (ADR-006), decided on a plain
// read before any lock and decided again under the locks.
//
// Every write is one bounded transaction of M2's machinery (adminWriteKit): the
// per-user advisory lock and the request record (the operation's keyed T8 row;
// a replay answers the operation's activations only when the right holds again
// and the current workspace's scope admits every one), the acting user as the
// v35 transaction-local setting, the locks of section 4 (S1: T2a -> T2b -> T3 ->
// T4 FOR SHARE -> the bindings FOR SHARE -> their teams FOR SHARE -> the acting
// user's rows -> the bindings' clubs; S2: T3 and T4 FOR SHARE before the T5
// row FOR NO KEY UPDATE, then the acting user's rows and the binding's club),
// the state checks after the right, the writes with the keyed audit row last
// and the bounded COMMIT (v48's deferred links). Answers carry no acting user
// and no reason (C63, G).
import { adminWriteKit, classifyDatabaseError } from "./sourceMetricMappingService.js";
import { mayManageActivations, activationInScope, bindingClubHolds } from "./sourceMetricAccess.js";
import {
  ACTIVATION_MESSAGES, ACTIVATION_SELECT, activationVisible, assertListedBindingsInScope, bindingList, checkListedStarts,
  insertStarts, lockListedBindings, operationStarts, publicActivation, startAuditRows,
} from "./sourceMetricActivationSteps.js";
import { boundedText } from "./metricTextRules.js";

export { mayManageActivations };

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, plainObject, uuidField, hashOf, encodeCursor, decodeCursor,
  invalidCursor, LOWER_UUID, UUID,
} = adminWriteKit;

export const ACTIVATION_PAGE_SIZE = 100;
export const ACTIVATION_REASON_MAX_LENGTH = 500;
const INVALID_REASON = "reason is one line of 1-500 visible characters without surrounding spaces.";
const STATES = new Set(["open", "ended", "all"]);

// Test seam (never set by the application): runs inside a write's transaction
// after every lock is taken and every check passed, right before the first row
// is written, with the client and the operation ("activation_start" or
// "activation_end").
let writeHold = null;
export function setActivationWriteHoldForTests(fn) { writeHold = fn ?? null; }
// Test seam (never set by the application): "skip_first_start" leaves out the
// first start's audit row, "skip_end" the end's - so v48's deferred link
// refuses the COMMIT (a definite refusal, nothing written).
let auditFault = null;
export function setActivationAuditFaultForTests(kind) { auditFault = kind ?? null; }

function reasonOf(value) {
  if (!boundedText(value, ACTIVATION_REASON_MAX_LENGTH)) throw refusal(400, "invalid_body", INVALID_REASON);
  return value;
}
// The database's own text rule, once more inside the write.
async function databaseTextAgrees(client, reason) {
  if ((await client.query(`select training_load.source_metric_text_ok($1, $2) as ok`, [reason, ACTIVATION_REASON_MAX_LENGTH])).rows[0].ok !== true) {
    throw refusal(400, "invalid_body", INVALID_REASON);
  }
}

// ---------------------------------------------------------------------------
// S1: POST /activations - start one version on the listed bindings, in one
// operation: N T5 rows in ascending binding id, N activation_start rows, the
// keyed one last.
// ---------------------------------------------------------------------------
export async function startActivations({ ctx, body }) {
  if (!mayManageActivations(ctx)) throw NOT_FOUND();
  const keys = ["requestKey", "mappingId", "versionId", "bindings", "reason"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  const mappingId = uuidField(body.mappingId);
  const versionId = uuidField(body.versionId);
  const bindings = bindingList(body.bindings);
  const reason = reasonOf(body.reason);
  const requestHash = hashOf({ op: "activation_start", mappingId, versionId, bindings, reason });
  return runWrite({
    ctx, where: "activation_start", requestKey, requestHash, action: "activation_start",
    idsOf: (written) => ({ mappingId: written.mapping_id ?? null, versionId: written.mapping_version_id ?? null }),
    reread: async (executor, record) => {
      const activations = await operationStarts(executor, ctx, record.operation_id);
      return activations && activations.length > 0 ? { activations } : null;
    },
    body: async (client, operationId) => {
      // Step 2: the scope on a plain read, before any lock - the version of the
      // named mapping, its owner, each binding's club and team.
      const v = (await client.query(
        `select v.id, v.mapping_id, v.status, v.source_metric_definition_id, v.source_metric_version_id, v.metric_definition_id,
                v.parameter_fingerprint, v.applies_to_session, v.applies_to_drill, m.owner_key, d.source_system, d.api_family
           from training_load.source_metric_mapping_versions v
           join training_load.source_metric_mappings m on m.id = v.mapping_id
           join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
          where v.id = $1 and v.mapping_id = $2`,
        [versionId, mappingId],
      )).rows[0];
      if (!v) throw NOT_FOUND();
      const clubIds = await assertListedBindingsInScope(client, ctx, v.owner_key, bindings);
      // Step 4: the locks - T2a and T2b (LOW-1), T3, T4, the bindings, their teams.
      const field = (await client.query(`select state from training_load.source_metric_definitions where id = $1 for share`, [v.source_metric_definition_id])).rows[0];
      await client.query(`select 1 from training_load.source_metric_definition_versions where id = $1 for share`, [v.source_metric_version_id]);
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for share`, [mappingId]);
      const version = (await client.query(
        `select status from training_load.source_metric_mapping_versions where id = $1 and mapping_id = $2 for share`, [versionId, mappingId],
      )).rows[0];
      if (!version) throw NOT_FOUND();
      const locked = await lockListedBindings(client, bindings);
      // Step 5: the rights - the actor (with the promotion probe), then the
      // bindings' clubs FOR SHARE (R6), then the scope again (its facts are
      // immutable; the teams were qualified under their lock).
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (!(await bindingClubHolds(client, clubIds))) throw NOT_FOUND();
      for (const clubId of clubIds) if (!activationInScope(ctx, { mappingOwnerKey: v.owner_key, bindingClubId: clubId })) throw NOT_FOUND();
      // Step 6: the states, answered only now.
      if (version.status !== "active") throw refusal(409, "version_not_active", ACTIVATION_MESSAGES.version_not_active, { current: { status: version.status } });
      if (!field || field.state !== "active") throw refusal(409, "field_retired", ACTIVATION_MESSAGES.field_retired);
      await checkListedStarts(client, v, bindings, locked);
      await databaseTextAgrees(client, reason);
      if (writeHold) await writeHold(client, "activation_start");
      // Steps 7 and 8: the T5 rows, then their audit rows with the keyed one last.
      const starts = await insertStarts(client, ctx, v, bindings, locked, reason);
      await startAuditRows(client, ctx, auditFault === "skip_first_start" ? starts.slice(1) : starts, reason, operationId, { requestKey, requestHash });
      return { mapping_id: mappingId, mapping_version_id: versionId, operation_id: operationId };
    },
  });
}

// ---------------------------------------------------------------------------
// S2: POST /activations/:activationId/end - end one open activation
// (admin_ended), with a reason written to its audit row only (R5).
// ---------------------------------------------------------------------------
// The activation of an operation's activation_end row, visible in the current
// workspace (else null: the identical 404).
async function endedActivation(executor, ctx, operationId) {
  const a = (await executor.query(
    `${ACTIVATION_SELECT}
      where a.id = (select activation_id from training_load.source_metric_audit where operation_id = $1 and action = 'activation_end')`,
    [operationId],
  )).rows[0];
  return a && activationVisible(ctx, a) ? publicActivation(a) : null;
}

export async function endActivation({ ctx, activationId, body }) {
  if (!mayManageActivations(ctx)) throw NOT_FOUND();
  if (typeof activationId !== "string" || !UUID.test(activationId)) throw NOT_FOUND();
  const id = activationId.toLowerCase();
  const keys = ["requestKey", "expectedState", "reason"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  if (body.expectedState !== "open") throw refusal(400, "invalid_body", "expectedState is open: the state of the activation this request ends.");
  const reason = reasonOf(body.reason);
  const requestHash = hashOf({ op: "activation_end", activationId: id, expectedState: "open", reason });
  return runWrite({
    ctx, where: "activation_end", requestKey, requestHash, action: "activation_end",
    idsOf: () => ({ activationId: id }),
    reread: async (executor, record) => {
      const activation = await endedActivation(executor, ctx, record.operation_id);
      return activation ? { activation } : null;
    },
    body: async (client, operationId) => {
      // Step 2: the scope on a plain read - the activation, its mapping's owner
      // and its binding's club (the connection's owner, which never changes).
      const plain = (await client.query(`${ACTIVATION_SELECT} where a.id = $1`, [id])).rows[0];
      if (!plain || !activationVisible(ctx, plain)) throw NOT_FOUND();
      // Step 4: T3 and T4 FOR SHARE before the T5 row (T8's foreign key on the
      // version takes FOR KEY SHARE on T4; A2 and the pinned step hold T4 FOR
      // UPDATE before they lock T5 - section 5).
      await client.query(`select 1 from training_load.source_metric_mappings where id = $1 for share`, [plain.mapping_id]);
      await client.query(`select 1 from training_load.source_metric_mapping_versions where id = $1 for share`, [plain.mapping_version_id]);
      const row = (await client.query(
        `select id, ended_at from training_load.source_metric_mapping_activations where id = $1 for no key update`, [id],
      )).rows[0];
      // Step 5: the rights, the binding's club, the scope again.
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      if (!(await bindingClubHolds(client, [plain.club_id]))) throw NOT_FOUND();
      if (!activationInScope(ctx, { mappingOwnerKey: plain.owner_key, bindingClubId: plain.club_id })) throw NOT_FOUND();
      // Step 6: the state.
      if (row.ended_at !== null) {
        const current = (await client.query(`${ACTIVATION_SELECT} where a.id = $1`, [id])).rows[0];
        throw refusal(409, "activation_not_open", ACTIVATION_MESSAGES.activation_not_open, { current: publicActivation(current) });
      }
      await databaseTextAgrees(client, reason);
      if (writeHold) await writeHold(client, "activation_end");
      // Steps 7 and 8: the end, then its keyed audit row.
      await client.query(
        `update training_load.source_metric_mapping_activations
            set ended_at = now(), ended_by_user_id = $2, ended_basis = $3, end_reason = 'admin_ended'
          where id = $1`,
        [id, ctx.userId, ctx.basis],
      );
      if (auditFault !== "skip_end") {
        await client.query(
          `insert into training_load.source_metric_audit
             (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id, request_key, request_hash)
           values ('activation_end', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [plain.mapping_version_id, id, plain.team_id, reason, ctx.userId, ctx.basis, operationId, requestKey, requestHash],
        );
      }
      return { mapping_id: plain.mapping_id, mapping_version_id: plain.mapping_version_id, operation_id: operationId };
    },
  });
}

// ---------------------------------------------------------------------------
// S3: GET /activations - by bindingId and/or versionId (at least one), state
// open (default), ended or all; pages of 100 by an opaque cursor that carries
// a position only (the last row's id). Every page applies the caller's current
// scope and the filters sent with it again. A filter outside the scope is the
// identical 404.
// ---------------------------------------------------------------------------
function listQuery(query) {
  const allowed = new Set(["bindingId", "versionId", "state", "cursor"]);
  const q = query ?? {};
  for (const key of Object.keys(q)) {
    if (!allowed.has(key) || typeof q[key] !== "string") throw refusal(400, "invalid_query", "The query carries a parameter this route does not take.");
  }
  if (q.bindingId === undefined && q.versionId === undefined) throw refusal(400, "invalid_query", "The list needs a bindingId or a versionId.");
  const state = q.state ?? "open";
  if (!STATES.has(state)) throw refusal(400, "invalid_query", "state is open, ended or all.");
  let after = null;
  if (q.cursor !== undefined) {
    const p = decodeCursor(q.cursor, "i,k,v");
    if (p.k !== "activations" || typeof p.i !== "string" || !LOWER_UUID.test(p.i)) throw invalidCursor();
    after = p.i;
  }
  return { bindingId: q.bindingId, versionId: q.versionId, state, after };
}

export async function listActivations({ ctx, query }) {
  if (!mayManageActivations(ctx)) throw NOT_FOUND();
  const q = listQuery(query);
  const bindingId = q.bindingId === undefined ? null : q.bindingId;
  const versionId = q.versionId === undefined ? null : q.versionId;
  if ((bindingId !== null && !UUID.test(bindingId)) || (versionId !== null && !UUID.test(versionId))) throw NOT_FOUND();
  return boundedRead(async (client) => {
    // A filter outside the scope: the identical 404 (the binding's club in
    // scope and active; the version's mapping readable in this workspace).
    if (bindingId !== null) {
      const b = (await client.query(
        `select bc.club_id, coalesce(cl.is_active, true) as club_active
           from training_load.source_team_bindings b
           cross join lateral (select training_load.source_metric_binding_club(b.id) as club_id) bc
           left join public.clubs cl on cl.id = bc.club_id
          where b.id = $1`,
        [bindingId.toLowerCase()],
      )).rows[0];
      const admitsBinding = b && b.club_active && b.club_id
        && (ctx.owner.scope === "system" ? ctx.basis === "platform_admin" : b.club_id === ctx.owner.clubId);
      if (!admitsBinding) throw NOT_FOUND();
    }
    if (versionId !== null) {
      const v = (await client.query(
        `select m.owner_key from training_load.source_metric_mapping_versions v join training_load.source_metric_mappings m on m.id = v.mapping_id
          where v.id = $1`,
        [versionId.toLowerCase()],
      )).rows[0];
      const admitsVersion = v && (ctx.owner.scope === "system" ? v.owner_key === "system" : v.owner_key === "system" || v.owner_key === ctx.owner.clubId);
      if (!admitsVersion) throw NOT_FOUND();
    }
    // Section 2.1 in the query: the mapping's owner and the binding's club,
    // the club active.
    const ownerKeys = ctx.owner.scope === "system" ? ["system"] : ["system", ctx.owner.clubId];
    const rows = (await client.query(
      `${ACTIVATION_SELECT}
        where ($1::uuid is null or a.source_team_binding_id = $1::uuid)
          and ($2::uuid is null or a.mapping_version_id = $2::uuid)
          and ($3 = 'all' or ($3 = 'open' and a.ended_at is null) or ($3 = 'ended' and a.ended_at is not null))
          and m.owner_key = any($4::text[])
          and bc.club_id is not null and coalesce(cl.is_active, true)
          and ($5::uuid is null or bc.club_id = $5::uuid)
          and ($6::uuid is null or a.id > $6::uuid)
        order by a.id
        limit $7`,
      [bindingId?.toLowerCase() ?? null, versionId?.toLowerCase() ?? null, q.state, ownerKeys,
        ctx.owner.scope === "system" ? null : ctx.owner.clubId, q.after, ACTIVATION_PAGE_SIZE + 1],
    )).rows.filter((a) => activationVisible(ctx, a));
    const page = rows.slice(0, ACTIVATION_PAGE_SIZE);
    const nextCursor = rows.length > ACTIVATION_PAGE_SIZE ? encodeCursor({ v: 1, k: "activations", i: page[page.length - 1].id }) : null;
    return { activations: page.map(publicActivation), nextCursor };
  });
}

export { classifyDatabaseError };
