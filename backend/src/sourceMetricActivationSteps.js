// The T5 steps phase 7d's writers share (docs/ai/phase7d-mapping-activations-contract.md,
// J10, sections 3-5): the start of an active mapping version on explicitly
// listed team bindings (S1 and A1's listed starts) and the ends of the open
// activations of the versions a transition disables (A1's replacement, A2 and
// the revision lifecycle's pinned step, D6 and O5). A module of its own, so
// the activation service, the M2 service and the revision lifecycle use one
// source without an import cycle; it opens no connection - every step runs
// on its caller's write transaction, in the lock order of section 4.
//
// The binding's club is the owner club of its connection
// (training_load.source_metric_binding_club, v48), never the team's club. The
// database guards every write again (v48): the acting user, the basis it
// derives, the binding's club and the audit chain.
import { refusal, activationInScope } from "./sourceMetricAccess.js";

const NOT_FOUND = () => refusal(404, "notFound", "Not found.");

// R2: at most this many bindings in one S1 or A1 call.
export const MAX_LISTED_BINDINGS = 50;
const REQUIREMENTS = new Set(["required", "optional"]);
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ACTIVATION_MESSAGES = Object.freeze({
  version_not_active: "The mapping version is not active.",
  binding_not_active: "A listed team binding has ended.",
  binding_source_mismatch: "A listed team binding is not of this source field's source and API family.",
  field_retired: "The source field is retired.",
  activation_exists: "A listed team binding already imports this source field with these parameters.",
  variable_taken_on_binding: "A listed team binding already imports this canonical variable at this level through another activation.",
  activation_not_open: "The activation has ended.",
});
// v34's T5 texts (the backstop of the checks below), exactly; an ended row
// written again is an end that lost its race.
export const ACTIVATION_TRIGGER_REFUSALS = new Map([
  ["source_metric_mapping_activations: only an active mapping version is activated", "version_not_active"],
  ["source_metric_mapping_activations: the team binding is not active", "binding_not_active"],
  ["source_metric_mapping_activations: the binding's source is not the source metric's", "binding_source_mismatch"],
  ["source_metric_mapping_activations: the API family of the binding's host is not the source metric's", "binding_source_mismatch"],
  ["source_metric_mapping_activations: the source metric is retired", "field_retired"],
  ["source_metric_mapping_activations: an ended activation is immutable", "activation_not_open"],
]);
// The two open-row unique indexes of v34 (by name).
export const ACTIVATION_UNIQUE_CODES = new Map([
  ["source_metric_activations_one_open_per_field", "activation_exists"],
  ["source_metric_activations_one_open_session_target", "variable_taken_on_binding"],
  ["source_metric_activations_one_open_drill_target", "variable_taken_on_binding"],
]);
const stateRefusal = (code, current) => refusal(409, code, ACTIVATION_MESSAGES[code], current ? { current } : undefined);

// The listed bindings of S1 or A1: 1-50 (A1: 0-50) distinct objects of exactly
// { bindingId, requirement }, the requirement required or optional with no
// default (C23). Answered in ascending binding id.
export function bindingList(value, { allowEmpty = false } = {}) {
  const invalid = (message) => refusal(400, "invalid_body", message);
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_LISTED_BINDINGS) {
    throw invalid(`The bindings are a list of ${allowEmpty ? 0 : 1}-${MAX_LISTED_BINDINGS} entries.`);
  }
  const seen = new Set();
  const list = value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join(",") !== "bindingId,requirement") {
      throw invalid("Each binding is an object of exactly bindingId and requirement.");
    }
    if (typeof entry.bindingId !== "string" || !UUID_TEXT.test(entry.bindingId)) throw invalid("An id field must be a UUID.");
    if (typeof entry.requirement !== "string" || !REQUIREMENTS.has(entry.requirement)) throw invalid("requirement is required or optional.");
    const bindingId = entry.bindingId.toLowerCase();
    if (seen.has(bindingId)) throw invalid("A binding is listed once.");
    seen.add(bindingId);
    return { bindingId, requirement: entry.requirement };
  });
  return list.sort((a, b) => (a.bindingId < b.bindingId ? -1 : a.bindingId > b.bindingId ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The scope, on a plain read before any lock (section 3.1 step 6).
// ---------------------------------------------------------------------------
// Each listed binding with its club (the connection's owner) and team, and
// whether both are active. A binding that does not exist, is outside the
// scope rule, or whose club or team is archived is the identical 404.
export async function assertListedBindingsInScope(executor, ctx, mappingOwnerKey, bindings) {
  const ids = bindings.map((b) => b.bindingId);
  const rows = (await executor.query(
    `select b.id, training_load.source_metric_binding_club(b.id) as club_id, coalesce(cl.is_active, true) as club_active,
            coalesce(t.is_active, true) as team_active
       from training_load.source_team_bindings b
       join public.teams t on t.id = b.team_id
       left join public.clubs cl on cl.id = training_load.source_metric_binding_club(b.id)
      where b.id = any($1::uuid[])`,
    [ids],
  )).rows;
  if (rows.length !== ids.length) throw NOT_FOUND();
  for (const row of rows) {
    if (!activationInScope(ctx, { mappingOwnerKey, bindingClubId: row.club_id }) || !row.club_active || !row.team_active) throw NOT_FOUND();
  }
  return rows.map((r) => r.club_id);
}

// ---------------------------------------------------------------------------
// The starts (S1 steps 4-8; A1's listed starts, section 4.3).
// ---------------------------------------------------------------------------
// The listed bindings FOR SHARE in ascending id (stronger than the T5 foreign
// key's FOR KEY SHARE: an Unbind or a raw UPDATE of the binding waits or lands
// first, R4), then their teams FOR SHARE, distinct ids ascending (as a bind
// locks its team). An archived team is the identical 404. Returns each
// binding's locked state with its connection's source and API family.
export async function lockListedBindings(client, bindings) {
  const ids = bindings.map((b) => b.bindingId);
  const locked = (await client.query(
    `select id, state, team_id, source_system, connection_id from training_load.source_team_bindings
      where id = any($1::uuid[]) order by id for share`,
    [ids],
  )).rows;
  if (locked.length !== ids.length) throw NOT_FOUND();
  const teamIds = [...new Set(locked.map((b) => b.team_id))].sort();
  const teams = (await client.query(
    `select id, coalesce(is_active, true) as active from public.teams where id = any($1::uuid[]) order by id for share`, [teamIds],
  )).rows;
  if (teams.length !== teamIds.length || teams.some((t) => !t.active)) throw NOT_FOUND();
  // The connection's API family (the connection and the host catalog are
  // immutable once a binding exists, v27; a plain read).
  const families = new Map((await client.query(
    `select b.id, h.api_family
       from training_load.source_team_bindings b
       join training_load.source_credential_connections c on c.id = b.connection_id
       join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
      where b.id = any($1::uuid[])`,
    [ids],
  )).rows.map((r) => [r.id, r.api_family]));
  return new Map(locked.map((b) => [b.id, { ...b, api_family: families.get(b.id) ?? null }]));
}

// The state checks of the listed starts, one ascending pass (section 4.1 step
// 6): the first failing binding is named, whatever the kind of failure. `v` is
// the version (with its field's source and API family). A1 calls this after it
// has ended N's open activations in the same transaction (section 4.3), so a
// row it ended no longer holds its binding (test 9 restarts N+1 on N's own
// binding).
export async function checkListedStarts(client, v, bindings, locked) {
  for (const { bindingId } of bindings) {
    const b = locked.get(bindingId);
    if (b.state !== "active") throw stateRefusal("binding_not_active", { bindingId, bindingState: b.state });
    if (b.source_system !== v.source_system || b.api_family !== v.api_family) throw stateRefusal("binding_source_mismatch", { bindingId });
    const sameField = await client.query(
      `select 1 from training_load.source_metric_mapping_activations
        where source_team_binding_id = $1 and source_metric_definition_id = $2 and parameter_fingerprint = $3
          and ended_at is null`,
      [bindingId, v.source_metric_definition_id, v.parameter_fingerprint],
    );
    if (sameField.rowCount > 0) throw stateRefusal("activation_exists", { bindingId });
    const sameTarget = await client.query(
      `select 1 from training_load.source_metric_mapping_activations
        where source_team_binding_id = $1 and metric_definition_id = $2 and ended_at is null
          and ((applies_to_session and $3::boolean) or (applies_to_drill and $4::boolean))`,
      [bindingId, v.metric_definition_id, v.applies_to_session, v.applies_to_drill],
    );
    if (sameTarget.rowCount > 0) throw stateRefusal("variable_taken_on_binding", { bindingId });
  }
}

// The T5 INSERTs in ascending binding id (v34's and v48's guards run on each);
// a 23505 names the binding of the insert that failed. Returns each new row's
// id with its binding and team.
export async function insertStarts(client, ctx, v, bindings, locked, reason) {
  const starts = [];
  for (const { bindingId, requirement } of bindings) {
    const teamId = locked.get(bindingId).team_id;
    let id;
    try {
      id = (await client.query(
        `insert into training_load.source_metric_mapping_activations
           (mapping_version_id, mapping_id, source_metric_definition_id, metric_definition_id, parameter_fingerprint,
            source_team_binding_id, team_id, applies_to_session, applies_to_drill, requirement,
            activated_by_user_id, activated_basis, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
        [v.id, v.mapping_id, v.source_metric_definition_id, v.metric_definition_id, v.parameter_fingerprint,
          bindingId, teamId, v.applies_to_session, v.applies_to_drill, requirement, ctx.userId, ctx.basis, reason],
      )).rows[0].id;
    } catch (error) {
      if (error?.code === "23505" && ACTIVATION_UNIQUE_CODES.has(error.constraint)) {
        throw stateRefusal(ACTIVATION_UNIQUE_CODES.get(error.constraint), { bindingId });
      }
      throw error;
    }
    starts.push({ id, bindingId, teamId, versionId: v.id });
  }
  return starts;
}

// One activation_start audit row per start (shape 00011001: the version, the
// activation and the team; no mapping_id), with the start's own reason. The
// request record, when given, is the last of them (S1's keyed row).
export async function startAuditRows(client, ctx, starts, reason, operationId, keyed = null) {
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i];
    const last = keyed && i === starts.length - 1;
    await client.query(
      `insert into training_load.source_metric_audit
         (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id, request_key, request_hash)
       values ('activation_start', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [s.versionId, s.id, s.teamId, reason, ctx.userId, ctx.basis, operationId, last ? keyed.requestKey : null, last ? keyed.requestHash : null],
    );
  }
}

// ---------------------------------------------------------------------------
// The version-driven ends (A1's replacement, A2, the pinned step).
// ---------------------------------------------------------------------------
// After the versions' T4 rows FOR UPDATE: their open T5 rows FOR NO KEY
// UPDATE in ascending id (D: "then the T5 rows, before its first
// modification"). An importing transaction's FOR SHARE is waited for.
export async function lockOpenActivations(client, versionIds) {
  const ids = [...new Set(versionIds)].filter(Boolean);
  if (ids.length === 0) return [];
  return (await client.query(
    `select id, mapping_version_id, team_id from training_load.source_metric_mapping_activations
      where mapping_version_id = any($1::uuid[]) and ended_at is null
      order by id for no key update`,
    [ids],
  )).rows;
}

// The ends, one statement, before the versions' status changes (v34 refuses
// to disable a version with an open activation): at the transaction's time,
// by the acting user. A version-driven end carries the platform admin's basis
// the database derives without the club gate (section 2.3): the basis is the
// constant 'platform_admin' because A1, A2 and the pinned step admit only a
// platform admin (mayTransitionMappings, the lifecycle's own gate); opening
// them to another basis must change it here and in endAuditRows (v48 refuses
// it with 42501 otherwise).
export async function endOpenActivations(client, ctx, rows, endReason) {
  if (rows.length === 0) return;
  await client.query(
    `update training_load.source_metric_mapping_activations
        set ended_at = now(), ended_by_user_id = $2, ended_basis = 'platform_admin', end_reason = $3
      where id = any($1::uuid[])`,
    [rows.map((r) => r.id), ctx.userId, endReason],
  );
}

// One activation_end audit row per end, with the version's disable_reason as
// its reason (v48 checks it), after the versions' status changes; the basis is
// 'platform_admin' for the reason given at endOpenActivations.
export async function endAuditRows(client, ctx, rows, reason, operationId) {
  for (const r of rows) {
    await client.query(
      `insert into training_load.source_metric_audit
         (action, mapping_version_id, activation_id, team_id, reason, performed_by_user_id, basis, operation_id)
       values ('activation_end', $1, $2, $3, $4, $5, 'platform_admin', $6)`,
      [r.mapping_version_id, r.id, r.team_id, reason, ctx.userId, operationId],
    );
  }
}

// ---------------------------------------------------------------------------
// Reading activations (the answers, the replays and S3).
// ---------------------------------------------------------------------------
// One row with what the scope rule needs: the mapping's owner key and the
// binding's club with whether it is active. No acting user and no reason
// (C63, G).
export const ACTIVATION_SELECT = `
  select a.id, a.mapping_id, a.mapping_version_id, a.source_team_binding_id, b.state as binding_state, a.team_id, a.requirement,
         a.applies_to_session, a.applies_to_drill, a.activated_basis, a.activated_at, a.ended_at, a.end_reason,
         m.owner_key, bc.club_id, coalesce(cl.is_active, true) as club_active
    from training_load.source_metric_mapping_activations a
    join training_load.source_metric_mappings m on m.id = a.mapping_id
    join training_load.source_team_bindings b on b.id = a.source_team_binding_id
    cross join lateral (select training_load.source_metric_binding_club(a.source_team_binding_id) as club_id) bc
    left join public.clubs cl on cl.id = bc.club_id`;
export function publicActivation(a) {
  return {
    id: a.id, mappingId: a.mapping_id, versionId: a.mapping_version_id, bindingId: a.source_team_binding_id, bindingState: a.binding_state,
    teamId: a.team_id, requirement: a.requirement, appliesToSession: a.applies_to_session, appliesToDrill: a.applies_to_drill,
    basis: a.activated_basis, activatedAt: a.activated_at, endedAt: a.ended_at, endReason: a.end_reason,
  };
}
// Section 2.1 on a read row: the mapping and the binding admitted, the club active.
export const activationVisible = (ctx, a) => activationInScope(ctx, { mappingOwnerKey: a.owner_key, bindingClubId: a.club_id }) && a.club_active;

// The activations an operation started, in ascending binding id - null (the
// identical 404) unless every one is visible in the current workspace.
export async function operationStarts(executor, ctx, operationId) {
  const rows = (await executor.query(
    `${ACTIVATION_SELECT}
      where a.id in (select activation_id from training_load.source_metric_audit where operation_id = $1 and action = 'activation_start')
      order by a.source_team_binding_id`,
    [operationId],
  )).rows;
  if (!rows.every((a) => activationVisible(ctx, a))) return null;
  return rows.map(publicActivation);
}
// How many activations an operation ended.
export async function operationEndCount(executor, operationId) {
  return (await executor.query(
    `select count(*)::int as n from training_load.source_metric_audit where operation_id = $1 and action = 'activation_end'`, [operationId],
  )).rows[0].n;
}
