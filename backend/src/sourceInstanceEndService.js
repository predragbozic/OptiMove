// Ending a held source instance (phase 7g, contract J13,
// docs/ai/phase7g-source-instance-end-contract.md; D9 of the discovery
// document): an active platform admin, in the platform workspace, ends one
// team-owned Metrics Core source connection that holds its write-once source
// instance (T7: source_host_key, source_instance_key). The row turns
// `inactive`; nothing is deleted or moved, and every historical fact keeps
// pointing to it (C36). An ended instance stays ended (R4). Before M4 no code
// writes the T7 keys, so every GPEXE connection answers instance_not_held.
//
// The write is one bounded transaction of M2's machinery (adminWriteKit): the
// per-user advisory lock, the request record looked up before any row lock
// (the write's own T8 audit row, source_instance_end; a replay answers the
// current state after the right is checked again; the same key with another
// request is request_key_reused), the acting user as the v35
// transaction-local setting before the first write (v50's guards require it),
// the right and the user FOR SHARE, and a bounded COMMIT whose lost answer is
// verified on another connection by the request record. Lock order (J13
// section 4, R5): the advisory lock -> the request record -> the owner team's
// import lock (a try-lock: false is try_again) -> the owner team's bindings of
// that source team FOR SHARE -> the connection FOR NO KEY UPDATE -> the role
// and user rows FOR SHARE -> the UPDATE -> the T8 row -> the COMMIT (v50's
// deferred audit link).
//
// An answer never carries a reason, an acting user, a credential column or a
// database text: only the keys of LIST_KEYS, and for a 409 the keys J13
// section 3.2 names.
import { adminWriteKit, classifyDatabaseError, SourceMetricMappingError } from "./sourceMetricMappingService.js";

const {
  runWrite, boundedRead, rightsStillHold, refusal, NOT_FOUND, MESSAGES, plainObject, uuidField, boundedText, hashOf, UUID,
  encodeCursor, decodeCursor, invalidCursor, LOWER_UUID,
} = adminWriteKit;

// GET /source-instances answers in pages of this size (C68).
export const INSTANCE_PAGE_SIZE = 100;
// M2's source system rule (sourceMetricMappingService.js, SOURCE_SYSTEM) and
// the T7 formats (v27 host_key, v34 source_instance_key).
const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,30}$/;
const HOST_KEY = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const INSTANCE_KEY = /^[A-Za-z0-9._:-]{1,64}$/;
const REASON_MAX_LENGTH = 500;
const ACTION = "source_instance_end";

const TEXT = {
  instance_not_held: "This source connection holds no source instance of a team; there is nothing to end.",
  instance_mismatch: "The source instance is not the one this request names; read the list again.",
  instance_already_ended: "The source instance is already ended.",
  instance_binding_active: "The owner team still has an active binding of this source team; unbind it first.",
  instance_in_use: "An activation of this source team is still open on the owner team; end it first.",
  reason: "reason is one line of 1-500 characters.",
  expected: "expected is an object with exactly sourceSystem, sourceHostKey and sourceInstanceKey, each in its format.",
  query: "The query carries a parameter this route does not take, or a value it does not accept.",
};

// OD5 (decided): an active platform admin in the platform workspace only, the
// predicate of mayMaintainConversions and mayVerify. Everyone else gets the
// identical 404 - the router asks this before it looks at the query or the
// body, and each service function asks it again.
export const mayEndInstances = (ctx) => ctx?.basis === "platform_admin" && ctx?.owner?.scope === "system";

// ---------------------------------------------------------------------------
// The row of the list and of every answer (J13 section 3.1).
// ---------------------------------------------------------------------------
// `held`: the instance is active and an active binding of ANOTHER team names
// the same source system, host and source team - the instance is what blocks
// that team (an ended instance blocks nothing). The host comes from the
// binding's credential connection; no other column of that table is read.
// `endedAt`: the performed_at of the connection's source_instance_end row.
const INSTANCE_SELECT = `
  select c.id, c.source_system, c.source_host_key, c.source_instance_key, c.state, c.created_at, c.owner_team_id,
         t.name as owner_team_name,
         (c.state = 'active' and exists (
            select 1 from training_load.source_team_bindings b
              join training_load.source_credential_connections cc on cc.id = b.connection_id
             where b.state = 'active' and b.team_id <> c.owner_team_id and b.source_system = c.source_system
               and b.source_team_id = c.source_instance_key and cc.host_key = c.source_host_key)) as held,
         e.performed_at as ended_at
    from training_load.metric_source_connections c
    join public.teams t on t.id = c.owner_team_id
    left join training_load.source_metric_audit e on e.action = 'source_instance_end' and e.metric_source_connection_id = c.id`;
// Only an instance: a team-owned connection that holds its T7 keys (R1).
const IS_INSTANCE = `c.owner_scope = 'team' and c.owner_team_id is not null and c.source_host_key is not null and c.source_instance_key is not null`;

const instanceOut = (r) => ({
  id: r.id, sourceSystem: r.source_system, sourceHostKey: r.source_host_key, sourceInstanceKey: r.source_instance_key,
  state: r.state, createdAt: r.created_at, ownerTeamId: r.owner_team_id, ownerTeamName: r.owner_team_name ?? null,
  held: r.held === true, endedAt: r.ended_at ?? null,
});

async function instanceRow(executor, connectionId) {
  return (await executor.query(`${INSTANCE_SELECT} where c.id = $1 and ${IS_INSTANCE}`, [connectionId])).rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Read: the instances, in pages.
// ---------------------------------------------------------------------------
// The query, read from the raw query string (never Express's parsed
// req.query, which drops a key named like an Object.prototype member and nests
// brackets): `state`, `sourceSystem` and `cursor`, each at most once; anything
// else is 400 invalid_query.
function listInput(queryString) {
  if (typeof queryString !== "string") throw refusal(400, "invalid_query", TEXT.query);
  const seen = new Map();
  for (const [key, value] of new URLSearchParams(queryString)) {
    if (!["state", "sourceSystem", "cursor"].includes(key) || seen.has(key)) throw refusal(400, "invalid_query", TEXT.query);
    seen.set(key, value);
  }
  const state = seen.has("state") ? seen.get("state") : "active";
  if (!["active", "inactive", "all"].includes(state)) throw refusal(400, "invalid_query", TEXT.query);
  const sourceSystem = seen.has("sourceSystem") ? seen.get("sourceSystem") : null;
  if (sourceSystem !== null && !SOURCE_SYSTEM.test(sourceSystem)) throw refusal(400, "invalid_query", TEXT.query);
  let after = null;
  if (seen.has("cursor")) {
    const p = decodeCursor(seen.get("cursor"), "i,k,v");
    if (p.k !== "source_instances" || typeof p.i !== "string" || !LOWER_UUID.test(p.i)) throw invalidCursor();
    after = p.i;
  }
  return { state, sourceSystem, after };
}

// GET /source-instances - the team-owned connections that hold an instance,
// by id; one page, the next after the cursor's id (ids are never deleted, so
// the id alone finds the position).
export async function listInstances({ ctx, queryString }) {
  if (!mayEndInstances(ctx)) throw NOT_FOUND();
  const { state, sourceSystem, after } = listInput(queryString);
  return boundedRead(async (client) => {
    const rows = (await client.query(
      `${INSTANCE_SELECT}
        where ${IS_INSTANCE}
          and ($1::text = 'all' or c.state = $1::text)
          and ($2::text is null or c.source_system = $2::text)
          and ($3::uuid is null or c.id > $3::uuid)
        order by c.id
        limit $4`,
      [state, sourceSystem, after, INSTANCE_PAGE_SIZE + 1],
    )).rows;
    const page = rows.slice(0, INSTANCE_PAGE_SIZE);
    const nextCursor = rows.length > INSTANCE_PAGE_SIZE ? encodeCursor({ v: 1, k: "source_instances", i: page[page.length - 1].id }) : null;
    return { instances: page.map(instanceOut), nextCursor };
  });
}

// ---------------------------------------------------------------------------
// Write: end one instance.
// ---------------------------------------------------------------------------
// The write's own T8 audit row is the request record (D10): one key space with
// M2's other writes, so a key used for another operation is request_key_reused.
const INSTANCE_REQUESTS = Object.freeze({
  find: `select action as operation, request_hash, operation_id, metric_source_connection_id
           from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
  exists: `select 1 from training_load.source_metric_audit where performed_by_user_id = $1 and request_key = $2`,
});
const instanceIdsOf = (written) => ({ connectionId: written.metric_source_connection_id ?? null });

// Only the allowlisted database refusals become a 4xx; everything else - every
// v50 guard text, which the service's own checks make unreachable, and the
// once-index - is a sanitized 500 (logged by its code only, by the router).
export function classifyInstanceError(error) {
  if (error instanceof SourceMetricMappingError) return error;
  if (error?.code === "23505" && error.constraint === "source_metric_audit_one_request_per_operation") return refusal(409, "try_again", MESSAGES.try_again);
  return classifyDatabaseError(error);
}

// Test seams (never set by the application): `writeHold` runs inside the
// write after every lock is taken and every check passed, right before the
// UPDATE; `afterBindings` runs after the bindings are locked and before the
// connection is; `skipAudit` leaves the T8 row out, so v50's deferred link
// refuses the COMMIT.
let writeHold = null;
let afterBindings = null;
let skipAudit = false;
export function setInstanceWriteHoldForTests(fn) { writeHold = fn ?? null; }
export function setInstanceSeamsForTests({ skipAudit: noAudit = false, afterBindings: hold = null } = {}) {
  skipAudit = noAudit;
  afterBindings = hold;
}

function expectedField(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw refusal(400, "invalid_body", TEXT.expected);
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "sourceHostKey,sourceInstanceKey,sourceSystem") throw refusal(400, "invalid_body", TEXT.expected);
  const { sourceSystem, sourceHostKey, sourceInstanceKey } = value;
  if (typeof sourceSystem !== "string" || !SOURCE_SYSTEM.test(sourceSystem)
      || typeof sourceHostKey !== "string" || !HOST_KEY.test(sourceHostKey)
      || typeof sourceInstanceKey !== "string" || !INSTANCE_KEY.test(sourceInstanceKey)) {
    throw refusal(400, "invalid_body", TEXT.expected);
  }
  // A fixed key order: the request hash does not depend on the client's.
  return { sourceSystem, sourceHostKey, sourceInstanceKey };
}

const isInstance = (r) => r.owner_scope === "team" && r.owner_team_id !== null && r.source_host_key !== null && r.source_instance_key !== null;

// POST /source-instances/:connectionId/end
export async function endInstance({ ctx, connectionId: rawId, body }) {
  if (!mayEndInstances(ctx)) throw NOT_FOUND();
  if (typeof rawId !== "string" || !UUID.test(rawId)) throw NOT_FOUND();
  const connectionId = rawId.toLowerCase();
  const keys = ["requestKey", "reason", "expected"];
  plainObject(body, keys, keys);
  const requestKey = uuidField(body.requestKey);
  if (!boundedText(body.reason, REASON_MAX_LENGTH)) throw refusal(400, "invalid_body", TEXT.reason);
  const reason = body.reason;
  const expected = expectedField(body.expected);
  const requestHash = hashOf({ op: ACTION, connectionId, reason, expected });
  return runWrite({
    ctx, where: ACTION, requestKey, requestHash, action: ACTION, requests: INSTANCE_REQUESTS, classify: classifyInstanceError, idsOf: instanceIdsOf,
    reread: async (executor, record) => {
      const row = await instanceRow(executor, record.metric_source_connection_id);
      return row ? { instance: instanceOut(row) } : null;
    },
    body: async (client, operationId) => {
      const PLAIN = `select id, owner_scope, owner_team_id, source_system, source_host_key, source_instance_key, state
                       from training_load.metric_source_connections where id = $1`;
      // 1. The connection without a lock: its owner team and T7 keys (the keys
      // never change once set; the owner may still change on a connection no
      // event or identity uses, so step 6 compares it again).
      const plain = (await client.query(PLAIN, [connectionId])).rows[0];
      if (!plain) throw NOT_FOUND();
      if (!isInstance(plain)) {
        // No owner team, so no team lock: the right first, then the row once
        // more - if it became an instance meanwhile, the caller tries again.
        if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
        const again = (await client.query(PLAIN, [connectionId])).rows[0];
        if (!again) throw NOT_FOUND();
        if (isInstance(again)) throw refusal(409, "try_again", MESSAGES.try_again);
        throw refusal(409, "instance_not_held", TEXT.instance_not_held, { current: { id: again.id } });
      }
      const teamId = plain.owner_team_id;
      // 2. The owner team's import lock (the key of v24's hold_gpexe_team_lock
      // and the import writer's lockTeamForImport), a try-lock: a check, an
      // import, a bind, an Unbind or a settings change running for the team
      // answers try_again from this boolean - never from a database text (C72).
      const locked = (await client.query(
        `select pg_try_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1::uuid::text, 21)) as locked`, [teamId],
      )).rows[0].locked;
      if (locked !== true) throw refusal(409, "try_again", MESSAGES.try_again);
      // 3. The owner team's bindings of that source system and source team
      // FOR SHARE, ascending (never stronger, R5); the host decides which of
      // them name this instance. Then their open activations, a plain read
      // (an ended binding's open activation included, C58).
      const bindings = (await client.query(
        `select b.id, b.team_id, b.state, cc.host_key = $3 as same_host
           from training_load.source_team_bindings b
           join training_load.source_credential_connections cc on cc.id = b.connection_id
          where b.team_id = $1 and b.source_system = $2 and b.source_team_id = $4
          order by b.id
          for share of b`,
        [teamId, plain.source_system, plain.source_host_key, plain.source_instance_key],
      )).rows.filter((b) => b.same_host === true);
      const open = bindings.length === 0 ? null : (await client.query(
        `select a.id, a.source_team_binding_id from training_load.source_metric_mapping_activations a
          where a.source_team_binding_id = any($1::uuid[]) and a.ended_at is null
          order by a.id limit 1`,
        [bindings.map((b) => b.id)],
      )).rows[0] ?? null;
      if (afterBindings) await afterBindings(client);
      // 4. The connection FOR NO KEY UPDATE (after the bindings: D's order).
      const row = (await client.query(`${PLAIN} for no key update`, [connectionId])).rows[0];
      if (!row) throw NOT_FOUND();
      // 5. The right, once more, with the role and user rows FOR SHARE.
      if (!(await rightsStillHold(client, ctx))) throw NOT_FOUND();
      // 6. The locked row: the owner it was locked for, then the 409s in the
      // order of J13 section 3.2.
      if (row.owner_team_id !== teamId) throw refusal(409, "try_again", MESSAGES.try_again);
      if (!isInstance(row)) throw refusal(409, "instance_not_held", TEXT.instance_not_held, { current: { id: row.id } });
      const current = async () => instanceOut(await instanceRow(client, connectionId));
      if (row.source_system !== expected.sourceSystem || row.source_host_key !== expected.sourceHostKey
          || row.source_instance_key !== expected.sourceInstanceKey) {
        throw refusal(409, "instance_mismatch", TEXT.instance_mismatch, { current: await current() });
      }
      if (row.state !== "active") throw refusal(409, "instance_already_ended", TEXT.instance_already_ended, { current: await current() });
      const activeBinding = bindings.find((b) => b.state === "active");
      if (activeBinding) {
        throw refusal(409, "instance_binding_active", TEXT.instance_binding_active, { current: { bindingId: activeBinding.id, teamId: activeBinding.team_id } });
      }
      if (open) {
        throw refusal(409, "instance_in_use", TEXT.instance_in_use, { current: { activationId: open.id, bindingId: open.source_team_binding_id } });
      }
      // 7. The database's text rule, once more inside the write (its twin
      // decided before any lock).
      if ((await client.query(`select training_load.source_metric_text_ok($1, ${REASON_MAX_LENGTH}) as ok`, [reason])).rows[0].ok !== true) {
        throw refusal(400, "invalid_body", TEXT.reason);
      }
      if (writeHold) await writeHold(client, ACTION);
      // 8. The end, then its T8 row (v50's guards check both).
      await client.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [connectionId]);
      if (!skipAudit) {
        await client.query(
          `insert into training_load.source_metric_audit
             (action, metric_source_connection_id, team_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id, request_key, request_hash)
           values ($1, $2, $3, 'active', 'inactive', $4, $5, 'platform_admin', $6, $7, $8)`,
          [ACTION, connectionId, teamId, reason, ctx.userId, operationId, requestKey, requestHash],
        );
      }
      return { operation: ACTION, metric_source_connection_id: connectionId, operation_id: operationId };
    },
  });
}
