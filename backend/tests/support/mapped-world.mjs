// The mapped world of the 9-B suites (contract J17 section 8.1): the ten seeded
// gpexe / rest_v1 source fields confirmed with every guard on, eleven system
// variables (one per legacy spec of support/gpexe-legacy-specs.mjs), their
// mappings activated (A1), a team bound to a GPEXE team and the activations
// started on its binding (S1) - every variable, mapping, version and
// activation written through the real M3-0, M2, 7b and 7d service paths.
//
// Disposable databases only: every writer refuses a database whose name is
// not optimove_tests_*. The services import db.js, so they are loaded only
// through import() after process.env.DATABASE_URL points at the disposable
// database (the T1 runner classifies a file by its static imports).
import crypto from "node:crypto";
import { SPEC_REGISTRY } from "./gpexe-legacy-specs.mjs";
import { verifyRevisionRow } from "./source-revisions.mjs";

const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";
const MEANING_REF = "docs/ai/test-evidence.md#meaning-of-the-field";
const SYSTEM_CTX = (userId) => ({ userId: String(userId), basis: "platform_admin", owner: { scope: "system", clubId: null } });
const key = () => crypto.randomUUID();
const suffix = () => crypto.randomBytes(3).toString("hex");

async function assertDisposable(client) {
  const name = (await client.query("select current_database() as db")).rows[0].db;
  if (!/^optimove_tests_[a-z0-9_]+$/.test(name)) throw new Error(`SAFETY: mapped-world writes only to an optimove_tests_* database, not ${name}`);
  if (!new URL(process.env.DATABASE_URL).pathname.slice(1).startsWith("optimove_tests_")) {
    throw new Error("SAFETY: DATABASE_URL must point at the disposable database before the services are loaded");
  }
}

async function services() {
  const [variables, mappings, activations] = await Promise.all([
    import("../../src/canonicalVariableAdminService.js"),
    import("../../src/sourceMetricMappingService.js"),
    import("../../src/sourceMetricActivationService.js"),
  ]);
  return { variables, mappings, activations };
}

// An active platform admin (users + user_global_roles), for the services'
// rights checks.
export async function platformAdmin(client, label = "9b-pa") {
  await assertDisposable(client);
  // The legacy users table of a database built from the production snapshot requires first_name and last_name (the
  // synthetic scaffold has no such columns): fill them when they exist.
  const names = (await client.query(`select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'first_name'`)).rowCount > 0;
  const id = (await client.query(
    names
      ? `insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'9-B','Admin',$2,$2) returning id`
      : `insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`,
    [`${label}-${suffix()}@test.local`, `9-B ${label}`],
  )).rows[0].id;
  await client.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  return String(id);
}

async function seededRevision(client, sourceMetricKey) {
  return (await client.query(
    `select d.id as "fieldId", r.id as "revId", r.evidence_status as evidence
       from training_load.source_metric_definitions d
       join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.revision_number = 1
      where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = $1`,
    [sourceMetricKey],
  )).rows[0];
}

// The system world of one database, built once (memoized by database name):
// { legacyKey -> { fieldId, revId, variableId, mappingId, versionId } }.
const systems = new Map();
export async function ensureMappedSystem(client, { platformAdminId, ranges = {} } = {}) {
  await assertDisposable(client);
  const dbName = (await client.query("select current_database() as db")).rows[0].db;
  if (systems.has(dbName)) return systems.get(dbName);
  const { variables, mappings } = await services();
  const ctx = SYSTEM_CTX(platformAdminId);
  const confirmed = new Set();
  const out = {};
  for (const [legacyKey, spec] of Object.entries(SPEC_REGISTRY)) {
    const rev = await seededRevision(client, spec.sourceMetricKey);
    if (!rev) throw new Error(`the seeded field ${spec.sourceMetricKey} is missing`);
    if (!confirmed.has(rev.revId) && rev.evidence !== "verified") {
      await verifyRevisionRow(client, {
        fieldId: rev.fieldId, revisionId: rev.revId, by: platformAdminId,
        unit: spec.confirmation.unit, boundUnit: spec.confirmation.boundUnit ?? null, unitRef: UNIT_REF,
        meaning: true, operator: spec.confirmation.operator ?? null, meaningRef: MEANING_REF,
      });
    }
    confirmed.add(rev.revId);
    const range = ranges[legacyKey] ?? {};
    const variable = (await variables.createVariable({
      ctx,
      body: {
        requestKey: key(), label: `GPEXE ${legacyKey.replace(/^gpexe_/, "").replace(/_/g, " ")} ${suffix()}`,
        unit: spec.targetUnit, levels: ["session", "drill"],
        dailyAggregationMethod: legacyKey === "gpexe_max_speed" ? "max" : "sum",
        ...(spec.condition ? { condition: spec.condition } : {}),
        ...(range.minValue !== undefined ? { minValue: range.minValue } : {}),
        ...(range.maxValue !== undefined ? { maxValue: range.maxValue } : {}),
      },
    })).variable;
    const mapping = (await mappings.createMapping({ ctx, body: { requestKey: key(), sourceMetricId: rev.fieldId, metricDefinitionId: variable.id } })).mapping;
    const version = (await mappings.createVersion({
      ctx, mappingId: mapping.id,
      body: {
        requestKey: key(), sourceRevisionId: rev.revId, appliesToSession: true, appliesToDrill: true,
        ...(spec.sourceParameters ? { sourceParameters: spec.sourceParameters } : {}),
        ...(spec.conversionNote ? { conversionNote: spec.conversionNote } : {}),
      },
    })).version;
    await mappings.submitVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: key() } });
    await mappings.activateVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: key(), expectedActiveVersionId: null } });
    out[legacyKey] = { fieldId: rev.fieldId, revId: rev.revId, variableId: variable.id, mappingId: mapping.id, versionId: version.id };
  }
  systems.set(dbName, out);
  return out;
}

// A club-owned server3 credential connection (random credential bytes, never
// decrypted or sent), the team's approved pair and its binding - raw SQL as
// the 7d suite does, for writer-level suites; route suites bind through the
// real Connect / Bind routes (support/gpexe-fake-source.mjs).
export async function bindTeam(client, { teamId, clubId, sourceTeamId, by }) {
  await assertDisposable(client);
  const connectionId = (await client.query(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','club',$1,'server3','9-B test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
    [clubId, by, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)],
  )).rows[0].id;
  await client.query(
    `insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)
     on conflict (owner_team_id) do nothing`,
    [teamId, String(sourceTeamId), by],
  );
  const bindingId = (await client.query(
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`,
    [teamId, connectionId, String(sourceTeamId), by],
  )).rows[0].id;
  return { bindingId: String(bindingId), connectionId: String(connectionId) };
}

// The activations of the system world on one binding (S1, in the platform
// workspace): every legacy key, or only those named.
export async function activateOn(world, { bindingId, platformAdminId, requirement = "optional", only = null }) {
  const { activations } = await services();
  const ctx = SYSTEM_CTX(platformAdminId);
  const started = {};
  for (const [legacyKey, m] of Object.entries(world)) {
    if (only && !only.includes(legacyKey)) continue;
    const body = { requestKey: key(), mappingId: m.mappingId, versionId: m.versionId, bindings: [{ bindingId, requirement }], reason: "9-B test activation." };
    const answer = await activations.startActivations({ ctx, body });
    started[legacyKey] = answer.activations.map((a) => a.id ?? a.activationId);
  }
  return started;
}

// The canonical catalog's digest: definitions, versions and scope
// capabilities, row by row (an importer creates none of them, C46).
export async function definitionDigest(client) {
  const q = async (sql) => (await client.query(sql)).rows.map((r) => r.t).join("\n");
  const text = [
    await q(`select (d.*)::text as t from training_load.metric_definitions d order by d.id`),
    await q(`select (v.*)::text as t from training_load.metric_definition_versions v order by v.id`),
    await q(`select (c.*)::text as t from training_load.metric_definition_scope_capabilities c order by c.metric_definition_id, c.scope_level`),
  ].join("\n--\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

export async function t6Rows(client, eventId) {
  return (await client.query(
    `select p.*, p.source_value_numeric::text as source_value_text, v.value_numeric::text as value_text, v.metric_definition_id, v.unit_at_capture
       from training_load.metric_value_source_provenance p
       join training_load.metric_values v on v.id = p.metric_value_id
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants ep on ep.id = o.event_participant_id
      where ep.event_id = $1`,
    [eventId],
  )).rows;
}

export async function t7Keys(client, teamId) {
  return (await client.query(
    `select id, state, source_host_key, source_instance_key from training_load.metric_source_connections
      where source_system = 'gpexe' and owner_scope = 'team' and owner_team_id = $1 order by created_at, id`,
    [teamId],
  )).rows;
}

// One platform admin per database for the world and its activations
// (memoized like the world itself).
const worldAdmins = new Map();
async function worldAdmin(client) {
  await assertDisposable(client);
  const dbName = (await client.query("select current_database() as db")).rows[0].db;
  if (!worldAdmins.has(dbName)) worldAdmins.set(dbName, await platformAdmin(client, "9b-world"));
  return worldAdmins.get(dbName);
}

// The 9-B path of a suite that imports or approves: the system world (built
// once per database), then the activations on a binding. `activateBinding`
// takes a binding made through the real Connect / Bind routes;
// `mappedBinding` binds with raw SQL first (writer-level suites). The
// bundle's GPEXE team must be the binding's source team (the D18 guard), and
// gpexe_team_settings is unique on it: one source team id per OptiMove team.
export async function activateBinding(client, bindingId, { requirement = "optional", only = null } = {}) {
  const platformAdminId = await worldAdmin(client);
  const world = await ensureMappedSystem(client, { platformAdminId });
  const started = await activateOn(world, { bindingId: String(bindingId), platformAdminId, requirement, only });
  return { world, started, platformAdminId };
}

export async function mappedBinding(client, { teamId, clubId, sourceTeamId, by, activate = true, requirement = "optional", only = null }) {
  const platformAdminId = await worldAdmin(client);
  const binding = await bindTeam(client, { teamId, clubId, sourceTeamId, by: by ?? platformAdminId });
  const activated = activate ? await activateBinding(client, binding.bindingId, { requirement, only }) : { world: null, started: {}, platformAdminId };
  return { ...binding, ...activated };
}
