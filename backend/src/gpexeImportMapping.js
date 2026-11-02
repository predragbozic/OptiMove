// The importer's mapping context (phase 9, 9-B; contract J17 section 3,
// steps 3-6): which open mapping activations a GPEXE import of one team writes
// through, read and locked in the contract's order, and the Metrics Core source
// instance its identities, events and value provenance (T6) name.
//
// Every function takes the caller's client inside its transaction, after
// lockTeamForImport() (the check-time preview and the approval). Nothing here
// opens a connection or imports db.js: the writer and the preview stay free of
// the application pool (the pilot CLI and the disposable suites rely on it).
//
// Lock order (J17 section 3, R5): the team import lock (the caller's) -> the
// binding FOR SHARE (step 3) -> the activation rows read unlocked (step 4) ->
// T2b -> T3 -> T4 -> metric_definitions -> T5, each FOR SHARE in ascending id
// order, then the rows compared again (step 5) -> the team's active Metrics
// Core source instance FOR UPDATE, its T7 keys written in a savepoint (step 6).
// No stronger lock on any of them is asked for later.
//
// Errors carry fixed messages only: no id, value, key or name.

export class ImportMappingChangedError extends Error {
  constructor() {
    super("The mapping activations changed while the import read them.");
    this.code = "mapping_changed";
  }
}

export class ImportBindingNotActiveError extends Error {
  constructor() {
    super("The team's binding is no longer active.");
    this.code = "binding_not_active";
  }
}

// A version's stored parameters with every JSON number as exact decimal text
// (trim_scale), the form the extractor registry compares exactly. A local copy
// of sourceMetricMappingService.js's PARAMS_AS_TEXT (that module imports
// db.js); a disposable test asserts the two give the same answer.
export const PARAMS_AS_TEXT = (column) => `(select coalesce(jsonb_object_agg(e.key, case jsonb_typeof(e.value) when 'number' then to_jsonb(trim_scale((e.value #>> '{}')::numeric)::text) else e.value end), '{}'::jsonb) from jsonb_each(${column}) e)`;

// ---------------------------------------------------------------------------
// Step 3: the binding FOR SHARE
// ---------------------------------------------------------------------------
// The team's binding (an approval: the one its candidate's last check read
// through; a check: the run's own) with its credential connection's host and
// API family. Every writer of a binding holds the team import lock, which the
// caller holds, so this FOR SHARE never waits in a cycle (J17 R5). The
// credential connection's state is not a condition (C55). The source team id is
// the binding's own text: T6 compares the instance key with it as stored.
export async function readImportBinding(client, { teamId, bindingId }) {
  const row = (await client.query(
    `select b.id, b.team_id, b.state, b.source_system, b.connection_id, b.source_team_id,
            c.host_key, c.owner_scope as connection_owner_scope, c.owner_club_id as connection_owner_club_id, h.api_family
       from training_load.source_team_bindings b
       join training_load.source_credential_connections c on c.id = b.connection_id
       left join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
      where b.id = $1
        for share of b`,
    [bindingId],
  )).rows[0];
  if (!row || row.state !== "active" || String(row.team_id) !== String(teamId) || row.source_system !== "gpexe") return null;
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    sourceSystem: row.source_system,
    connectionId: String(row.connection_id),
    sourceTeamId: row.source_team_id,
    hostKey: row.host_key,
    apiFamily: row.api_family,
  };
}

// ---------------------------------------------------------------------------
// Step 4: the open activations, unlocked
// ---------------------------------------------------------------------------
const ACTIVATIONS_SQL = `
  select a.id as activation_id, a.requirement, a.applies_to_session, a.applies_to_drill,
         a.mapping_version_id, a.mapping_id, a.metric_definition_id, a.parameter_fingerprint,
         v.status as version_status, v.source_metric_version_id, v.metric_definition_version_id,
         trim_scale(v.scale)::text as scale, trim_scale(v.scale_divisor)::text as scale_divisor, trim_scale(v."offset")::text as "offset",
         v.source_unit, v.target_unit, v.parameter_kind, ${PARAMS_AS_TEXT("v.source_parameters")} as source_parameters,
         m.owner_scope as mapping_owner_scope, m.owner_club_id as mapping_owner_club_id,
         d.source_system, d.api_family, d.source_metric_key, d.source_label, d.state as field_state,
         r.value_shape, r.parameter_kind as revision_parameter_kind, r.source_unit as revision_source_unit,
         r.state as revision_state, r.evidence_status,
         md.key as definition_key, md.label as definition_label, md.owner_scope as definition_owner_scope,
         md.state as definition_state, md.current_version_id,
         mv.value_type, trim_scale(mv.min_value)::text as min_value, trim_scale(mv.max_value)::text as max_value
    from training_load.source_metric_mapping_activations a
    join training_load.source_metric_mapping_versions v on v.id = a.mapping_version_id
    join training_load.source_metric_mappings m on m.id = a.mapping_id
    join training_load.source_metric_definitions d on d.id = v.source_metric_definition_id
    join training_load.source_metric_definition_versions r on r.id = v.source_metric_version_id
    join training_load.metric_definitions md on md.id = v.metric_definition_id
    join training_load.metric_definition_versions mv on mv.id = v.metric_definition_version_id
   where a.source_team_binding_id = $1 and a.ended_at is null
   order by a.id`;

function rowOf(r) {
  return {
    activationId: String(r.activation_id),
    requirement: r.requirement,
    appliesToSession: r.applies_to_session === true,
    appliesToDrill: r.applies_to_drill === true,
    mappingVersionId: String(r.mapping_version_id),
    mappingId: String(r.mapping_id),
    sourceMetricVersionId: String(r.source_metric_version_id),
    metricDefinitionId: String(r.metric_definition_id),
    metricDefinitionVersionId: String(r.metric_definition_version_id),
    sourceParameterFingerprint: r.parameter_fingerprint,
    versionStatus: r.version_status,
    scale: r.scale,
    scaleDivisor: r.scale_divisor,
    offset: r.offset,
    sourceUnit: r.source_unit,
    targetUnit: r.target_unit,
    parameterKind: r.parameter_kind,
    sourceParameters: r.source_parameters,
    mappingOwnerScope: r.mapping_owner_scope,
    mappingOwnerClubId: r.mapping_owner_club_id === null ? null : String(r.mapping_owner_club_id),
    sourceSystem: r.source_system,
    apiFamily: r.api_family,
    sourceMetricKey: r.source_metric_key,
    sourceLabel: r.source_label,
    fieldState: r.field_state,
    revisionValueShape: r.value_shape,
    revisionParameterKind: r.revision_parameter_kind,
    revisionSourceUnit: r.revision_source_unit,
    revisionState: r.revision_state,
    revisionEvidence: r.evidence_status,
    definitionKey: r.definition_key,
    definitionLabel: r.definition_label,
    definitionOwnerScope: r.definition_owner_scope,
    definitionState: r.definition_state,
    definitionCurrentVersionId: r.current_version_id === null ? null : String(r.current_version_id),
    valueType: r.value_type,
    minValue: r.min_value,
    maxValue: r.max_value,
  };
}

export async function readOpenActivations(client, bindingId) {
  return (await client.query(ACTIVATIONS_SQL, [bindingId])).rows.map(rowOf);
}

// Every field of a row that decides what is written; the labels are display
// fields, taken from the locked read.
const DISPLAY_FIELDS = new Set(["sourceLabel", "definitionLabel"]);
function decisionKey(row) {
  return JSON.stringify(Object.keys(row).filter((k) => !DISPLAY_FIELDS.has(k)).sort().map((k) => [k, row[k]]));
}

// ---------------------------------------------------------------------------
// Step 5: the registry locks and the re-check
// ---------------------------------------------------------------------------
// T2b -> T3 -> T4 -> the canonical metric_definitions row -> T5, each FOR SHARE,
// ascending by id within a table (the D order; the admin writers take the
// same). Then the rows are read again and compared: any difference (an ended
// or new activation, a disabled version, a retired revision, a changed
// definition) throws ImportMappingChangedError; nothing is written.
const sortedIds = (rows, field) => [...new Set(rows.map((r) => r[field]))].sort();
export async function lockActivations(client, bindingId, rows) {
  const steps = [
    ["training_load.source_metric_definition_versions", "sourceMetricVersionId"],
    ["training_load.source_metric_mappings", "mappingId"],
    ["training_load.source_metric_mapping_versions", "mappingVersionId"],
    ["training_load.metric_definitions", "metricDefinitionId"],
    ["training_load.source_metric_mapping_activations", "activationId"],
  ];
  if (rows.length) {
    for (const [table, field] of steps) {
      await client.query(`select id from ${table} where id = any($1::uuid[]) order by id for share`, [sortedIds(rows, field)]);
    }
  }
  const locked = await readOpenActivations(client, bindingId);
  if (locked.length !== rows.length) throw new ImportMappingChangedError();
  for (let i = 0; i < rows.length; i += 1) {
    if (decisionKey(rows[i]) !== decisionKey(locked[i])) throw new ImportMappingChangedError();
  }
  return locked;
}

// R11: a canonical definition must carry the scope capability of every level
// its activation covers (session for the whole session, component for a
// drill), or the import is refused before anything is written.
async function capabilitiesHold(client, rows) {
  if (rows.length === 0) return true;
  const caps = (await client.query(
    `select metric_definition_id, scope_level from training_load.metric_definition_scope_capabilities where metric_definition_id = any($1::uuid[])`,
    [sortedIds(rows, "metricDefinitionId")],
  )).rows;
  const has = new Set(caps.map((c) => `${c.metric_definition_id}|${c.scope_level}`));
  return rows.every((r) => (!r.appliesToSession || has.has(`${r.metricDefinitionId}|session`))
    && (!r.appliesToDrill || has.has(`${r.metricDefinitionId}|component`)));
}

// The labels of the known source fields of the binding's family that have no
// open activation on it (section F row 2; J17 section 4), sorted.
async function unactivatedLabels(client, binding) {
  return (await client.query(
    `select d.source_label
       from training_load.source_metric_definitions d
      where d.source_system = $1 and d.api_family = $2 and d.state = 'active'
        and not exists (select 1 from training_load.source_metric_mapping_activations a
                          join training_load.source_metric_mapping_versions v on v.id = a.mapping_version_id
                         where a.source_team_binding_id = $3 and a.ended_at is null and v.source_metric_definition_id = d.id)
      order by d.source_label, d.id`,
    [binding.sourceSystem, binding.apiFamily, binding.id],
  )).rows.map((r) => r.source_label);
}

// ---------------------------------------------------------------------------
// Step 6: the Metrics Core source instance FOR UPDATE, its T7 keys
// ---------------------------------------------------------------------------
// The team's active team-owned gpexe row (v20: at most one), locked by id;
// an inactive row (ended by 7g) is never used again (v50). With NULL keys
// (written before M4) the keys are set from NULL; with no active row one is
// inserted with its keys. Either write runs in its own savepoint, so a 23505
// (another team holds the triple) rolls back to it and the transaction stays
// usable for storing the candidate as blocked. The keys are set before the
// first T6 row (its check compares them with the binding).
let sourceInstanceHold = null;
export function setSourceInstanceHoldForTests(fn) { sourceInstanceHold = fn ?? null; }

export async function lockSourceInstance(client, { teamId, binding, sessionExternalId }) {
  const found = (await client.query(
    `select id from training_load.metric_source_connections
      where source_system = 'gpexe' and owner_scope = 'team' and owner_team_id = $1 and state = 'active'`,
    [teamId],
  )).rows;
  if (found.length > 1) return { block: "mapping_not_usable", blockReason: "ambiguous_source_connection" };
  if (sourceInstanceHold) await sourceInstanceHold(client);
  let connection = null;
  if (found.length === 1) {
    const row = (await client.query(
      `select id, state, source_system, source_host_key, source_instance_key
         from training_load.metric_source_connections where id = $1 for update`,
      [found[0].id],
    )).rows[0];
    // R6: ended (7g) between the read and the lock - never used again, never
    // reactivated, and no other row is created in its place by this import.
    if (!row || row.state !== "active") return { block: "mapping_not_usable", blockReason: "source_instance_inactive" };
    connection = { id: String(row.id), hostKey: row.source_host_key, instanceKey: row.source_instance_key, created: false, keysSet: false };
    if (connection.hostKey !== null || connection.instanceKey !== null) {
      if (connection.hostKey !== binding.hostKey || connection.instanceKey !== binding.sourceTeamId) return { block: "source_instance_changed" };
    }
  }
  if (!connection || connection.hostKey === null) {
    await client.query("savepoint gpexe_source_instance");
    try {
      if (connection) {
        const updated = await client.query(
          `update training_load.metric_source_connections set source_host_key = $2, source_instance_key = $3
            where id = $1 and source_host_key is null and source_instance_key is null`,
          [connection.id, binding.hostKey, binding.sourceTeamId],
        );
        if (updated.rowCount !== 1) throw new ImportMappingChangedError();
        connection = { ...connection, hostKey: binding.hostKey, instanceKey: binding.sourceTeamId, keysSet: true };
      } else {
        const inserted = await client.query(
          `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
           values ('gpexe', 'team', $1, $2, $3) returning id`,
          [teamId, binding.hostKey, binding.sourceTeamId],
        );
        connection = { id: String(inserted.rows[0].id), hostKey: binding.hostKey, instanceKey: binding.sourceTeamId, created: true, keysSet: true };
      }
      await client.query("release savepoint gpexe_source_instance");
    } catch (error) {
      await client.query("rollback to savepoint gpexe_source_instance");
      if (error?.code === "23505" && error.constraint === "metric_source_connections_one_active_instance") return { block: "source_instance_held" };
      if (error?.code === "23505" && error.constraint === "metric_source_connections_one_active_gpexe_per_team_idx") {
        return { block: "mapping_not_usable", blockReason: "source_connection_conflict" };
      }
      throw error;
    }
  }
  // The session already imported under another instance of the same triple
  // (any state, any owner): a boolean only, never an id.
  const elsewhere = (await client.query(
    `select exists (select 1 from training_load.metric_source_identities si
                      join training_load.metric_source_connections c on c.id = si.source_connection_id
                     where c.id <> $1 and c.source_system = 'gpexe' and c.source_host_key = $2 and c.source_instance_key = $3
                       and si.source_external_id = $4) as found`,
    [connection.id, binding.hostKey, binding.sourceTeamId, sessionExternalId],
  )).rows[0].found;
  if (elsewhere === true) return { block: "session_imported_under_another_instance" };
  return { block: null, connection };
}

// ---------------------------------------------------------------------------
// Steps 3-6 together
// ---------------------------------------------------------------------------
let mappingHold = null;
export function setImportMappingHoldForTests(fn) { mappingHold = fn ?? null; }

// bindingId: the binding the import reads through, or null (a legacy_env
// candidate or check: no binding, so no activation - mapping_not_usable).
// Returns { block, blockReason, binding, connection, rows, activationSet,
// unactivated }; throws only ImportMappingChangedError (a difference under the
// locks) and the database's own errors.
export async function prepareImportMapping(client, { teamId, bindingId, sessionExternalId, sourceTeamIdOfBundle }) {
  const empty = { binding: null, connection: null, rows: [], activationSet: [], unactivated: [] };
  if (!bindingId) return { ...empty, block: "mapping_not_usable", blockReason: "legacy_path" };
  const binding = await readImportBinding(client, { teamId, bindingId });
  if (!binding) return { ...empty, block: "mapping_not_usable", blockReason: "binding_not_active" };
  // D18: a bundle of another GPEXE team than the binding's is never written
  // through it (defence in depth: the adapter reads only the bound team).
  if (sourceTeamIdOfBundle !== undefined && sourceTeamIdOfBundle !== null && String(sourceTeamIdOfBundle) !== String(binding.sourceTeamId).replace(/^0+(?=[0-9])/, "")) {
    return { ...empty, binding, block: "mapping_not_usable", blockReason: "bundle_team" };
  }
  const unlocked = await readOpenActivations(client, binding.id);
  if (mappingHold) await mappingHold(client);
  const rows = await lockActivations(client, binding.id, unlocked);
  const unactivated = await unactivatedLabels(client, binding);
  const activationSet = rows.map((r) => [r.activationId, r.mappingVersionId]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const base = { binding, rows, activationSet, unactivated, connection: null };
  if (rows.length === 0) return { ...base, block: "no_mapped_values", blockReason: "no_activation" };
  if (!(await capabilitiesHold(client, rows))) return { ...base, block: "mapping_not_usable", blockReason: "scope_capability" };
  const instance = await lockSourceInstance(client, { teamId, binding, sessionExternalId });
  if (instance.block) return { ...base, block: instance.block, blockReason: instance.blockReason ?? null };
  return { ...base, block: null, blockReason: null, connection: instance.connection };
}
