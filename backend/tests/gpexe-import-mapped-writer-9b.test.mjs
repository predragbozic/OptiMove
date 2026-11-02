// Phase 9, 9-B (contract J17 sections 3, 5, 7, 8.2): the writer-level proofs
// of the importer's mapping context beside the main suite
// (gpexe-import-mapped-9b.test.mjs): the content hash under a new mapping
// version (D17), the supplement's exact decimal compare, the two closed power
// zones of one source field, PARAMS_AS_TEXT parity, the bundle-team guard
// (D18), the source instance ended between the read and the lock (R6), and an
// activation whose canonical definition lost a level (R11). On disposable
// optimove_tests_gpexe_* databases only; no GPEXE request, no credential.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { SPEC_REGISTRY } from "./support/gpexe-legacy-specs.mjs";
import { activateOn, bindTeam, definitionDigest, ensureMappedSystem, platformAdmin, t7Keys } from "./support/mapped-world.mjs";
import { importGpexeBundle, importGpexeBundleLocked, lockTeamForImport, GpexeImportError } from "../src/gpexeImportWriter.js";
import { PARAMS_AS_TEXT, prepareImportMapping, readOpenActivations, setSourceInstanceHoldForTests } from "../src/gpexeImportMapping.js";
import { canonicalDecimal } from "../src/sourceMetricExtractors.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

let db;
let admin;
let pa;
let world;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "mapped_writer_9b" });
  process.env.DATABASE_URL = db.url;
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  pa = await platformAdmin(admin);
  world = await ensureMappedSystem(admin, { platformAdminId: pa });
});

after(async () => {
  setSourceInstanceHoldForTests(null);
  try {
    const dbModule = await import("../src/db.js");
    await dbModule.pool.end().catch(() => {});
  } catch { /* not loaded */ }
  await admin?.end().catch(() => {});
  await db?.drop();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const key = () => crypto.randomUUID();
const hex = () => crypto.randomBytes(3).toString("hex");
const SYS = (userId) => ({ userId: String(userId), basis: "platform_admin", owner: { scope: "system", clubId: null } });
// The acting user of a raw database write, set the way the services set it (the 7g suite's CTX).
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const TEAM_LOCK = /^gpexe: a GPEXE check, import or connection change is running for team [0-9a-f-]{36} \(.*\); try again when it has finished$/;

async function services() {
  const [variables, mappings, activations] = await Promise.all([
    import("../src/canonicalVariableAdminService.js"),
    import("../src/sourceMetricMappingService.js"),
    import("../src/sourceMetricActivationService.js"),
  ]);
  return { variables, mappings, activations };
}

// Every wait of this file is bounded: a lock this file's own connections
// cannot get within 10 s is an error, never a hang.
async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  await client.query("set lock_timeout = '10s'");
  await client.query("set statement_timeout = '30s'");
  return client;
}

// One transaction on its own connection, always rolled back.
async function inTransaction(fn) {
  const client = await newClient();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

// Fixtures of a state no route builds, with triggers off for that one
// transaction (session_replication_role, as the 7d and 7g suites' raw
// fixtures; a disposable database only).
async function rawTx(fn) {
  const client = await newClient();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    await fn(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

// Each team its own GPEXE team id (gpexe_team_settings is unique on it).
let teamCounter = 0;
const nextSourceTeamId = () => String(9400 + (teamCounter += 1));
let heldCounter = 0;
const nextHeldKey = () => String(9800 + (heldCounter += 1));
async function mappedTeam({ sourceTeamId = nextSourceTeamId(), activate = true, requirement = "optional", only = null } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C", "Athlete D"] });
  const binding = await bindTeam(admin, { teamId: org.teamId, clubId: org.clubId, sourceTeamId, by: pa });
  const started = activate ? await activateOn(world, { bindingId: binding.bindingId, platformAdminId: pa, requirement, only }) : {};
  return { ...org, ...binding, sourceTeamId, started };
}
const athleteMapOf = (org) => ({ 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] });
const ctxOf = (org, extra = {}) => ({ ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: athleteMapOf(org), batchFilename: "9b writer test", ...extra });

async function runImport(org, bundle, extra = {}) {
  const client = await newClient();
  try {
    return await importGpexeBundle(client, bundle, ctxOf(org, extra));
  } finally {
    await client.end();
  }
}
const isImportError = (code) => (error) => error instanceof GpexeImportError && error.code === code;

const TEAM_COUNTS = {
  events: `select count(*)::int as c from training_load.metric_events where owner_team_id = $1`,
  segments: `select count(*)::int as c from training_load.metric_event_segments s join training_load.metric_events e on e.id = s.event_id where e.owner_team_id = $1`,
  event_participants: `select count(*)::int as c from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  source_identities: `select count(*)::int as c from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1`,
  import_batches: `select count(*)::int as c from training_load.metric_import_batches where owner_team_id = $1`,
  occasions: `select count(*)::int as c from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  metric_values: `select count(*)::int as c from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  provenance: `select count(*)::int as c from training_load.metric_value_source_provenance pr join training_load.metric_values v on v.id = pr.metric_value_id join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  activities: `select count(*)::int as c from training.activities where owner_team_id = $1`,
  activity_components: `select count(*)::int as c from training.activity_components ac join training.activities a on a.id = ac.activity_id where a.owner_team_id = $1`,
  component_segment_links: `select count(*)::int as c from training.activity_component_metric_segment_links l join training.activity_components ac on ac.id = l.activity_component_id join training.activities a on a.id = ac.activity_id where a.owner_team_id = $1`,
  event_source_bindings: `select count(*)::int as c from training_load.metric_event_source_bindings b join training_load.metric_events e on e.id = b.event_id where e.owner_team_id = $1`,
  team_definitions: `select count(*)::int as c from training_load.metric_definitions where owner_team_id = $1`,
};
async function counts(teamId) {
  const out = {};
  for (const [name, sql] of Object.entries(TEAM_COUNTS)) out[name] = (await admin.query(sql, [teamId])).rows[0].c;
  return out;
}
async function assertNothingWritten(teamId, label) {
  for (const [name, n] of Object.entries(await counts(teamId))) assert.equal(n, 0, `${label}: ${name} stays empty`);
}

// Every occasion of a team with its values and their T6 rows, grouped by
// occasion id; values as canonical decimal text, sorted by definition.
async function occasionsOf(teamId) {
  const rows = (await admin.query(
    `select o.id::text as occasion_id, o.source_identity_id::text as identity_id, o.import_conflict_status as status,
            o.supersedes_occasion_id::text as supersedes, o.superseded_by_occasion_id::text as superseded_by,
            coalesce(si.current_occasion_id = o.id, false) as current, si.source_external_id as external_id,
            v.id::text as value_id, v.metric_definition_id::text as definition_id, v.value_numeric::text as value_text,
            pr.mapping_version_id::text as mapping_version_id, pr.activation_id::text as activation_id,
            pr.source_value_numeric::text as source_text
       from training_load.metric_measurement_occasions o
       join training_load.metric_source_identities si on si.id = o.source_identity_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
       left join training_load.metric_values v on v.occasion_id = o.id
       left join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
      where e.owner_team_id = $1
      order by o.id, v.metric_definition_id`,
    [teamId],
  )).rows;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.occasion_id)) {
      out.set(r.occasion_id, {
        id: r.occasion_id, identityId: r.identity_id, externalId: r.external_id, status: r.status,
        supersedes: r.supersedes, supersededBy: r.superseded_by, current: r.current, values: [],
      });
    }
    if (r.value_id) {
      out.get(r.occasion_id).values.push({
        valueId: r.value_id, definitionId: r.definition_id, valueText: canonicalDecimal(r.value_text),
        mappingVersionId: r.mapping_version_id, activationId: r.activation_id,
        sourceText: r.source_text === null ? null : canonicalDecimal(r.source_text),
      });
    }
  }
  return out;
}
const drillOf = (externalId) => externalId.match(/:drill:([0-9]+)$/)?.[1] ?? null;
const byDefinition = (a, b) => (a.definitionId < b.definitionId ? -1 : a.definitionId > b.definitionId ? 1 : 0);

// ---------------------------------------------------------------------------
// B1. D17: a new mapping version is never "unchanged"
// ---------------------------------------------------------------------------
test("B1. D17: after a 7b A1 replacement of a variable's mapping version (the same conversion, the same value), re-importing the same session flags every occasion needs_review under the new version, writes it once, and never overwrites or supersedes the values imported under the old version", async () => {
  // Its own system variable on the closed 20-25 W/kg power zone (a parameter
  // set the world does not use): a replacement of a world mapping would end
  // every binding's activation of it in this database (A1 ends N's open
  // activations on all bindings).
  const { variables, mappings, activations } = await services();
  const ctx = SYS(pa);
  const zone = world.gpexe_power_zone_25_60_distance;
  const org = await mappedTeam({ activate: false });
  const variable = (await variables.createVariable({
    ctx,
    body: {
      requestKey: key(), label: `GPEXE power 20 25 ${hex()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum",
      condition: { kind: "zone", operator: "between", lower: "20", upper: "25", unit: "W/kg" },
    },
  })).variable;
  const mapping = (await mappings.createMapping({ ctx, body: { requestKey: key(), sourceMetricId: zone.fieldId, metricDefinitionId: variable.id } })).mapping;
  const newVersion = async () => {
    const version = (await mappings.createVersion({
      ctx, mappingId: mapping.id,
      body: { requestKey: key(), sourceRevisionId: zone.revId, appliesToSession: true, appliesToDrill: true, sourceParameters: { lower: "20", upper: "25" } },
    })).version;
    await mappings.submitVersion({ ctx, mappingId: mapping.id, versionId: version.id, body: { requestKey: key() } });
    return String(version.id);
  };
  const v1 = await newVersion();
  await mappings.activateVersion({ ctx, mappingId: mapping.id, versionId: v1, body: { requestKey: key(), expectedActiveVersionId: null } });
  await activations.startActivations({ ctx, body: { requestKey: key(), mappingId: mapping.id, versionId: v1, bindings: [{ bindingId: org.bindingId, requirement: "optional" }], reason: "9-B test activation." } });

  const bundle = makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) });
  const first = await runImport(org, bundle);
  assert.deepEqual(first.counts, { created: 5 });
  const before = await occasionsOf(org.teamId);
  assert.equal(before.size, 5);
  const firstActivation = (await admin.query(
    `select id::text from training_load.source_metric_mapping_activations where source_team_binding_id = $1 and ended_at is null`, [org.bindingId],
  )).rows;
  assert.equal(firstActivation.length, 1);
  // The zone's distances of the fixture (zone [20, 25] of each row).
  const EXPECTED = { "101|full": "200", "101|0": "100", "101|1": "100", "102|full": "100", "102|0": "100" };
  for (const o of before.values()) {
    assert.equal(o.values.length, 1);
    assert.deepEqual([o.values[0].definitionId, o.values[0].mappingVersionId, o.values[0].activationId], [String(variable.id), v1, firstActivation[0].id]);
    assert.equal(o.current, true);
  }

  // 7b A1: replace v1 by v2 (the same field, parameters and factors) and start
  // v2 on the binding in the same operation.
  const v2 = await newVersion();
  await mappings.activateVersion({
    ctx, mappingId: mapping.id, versionId: v2,
    body: {
      requestKey: key(), expectedActiveVersionId: v1, reason: "9-B test replacement.",
      activations: [{ bindingId: org.bindingId, requirement: "optional" }], activationReason: "9-B test activation.",
    },
  });
  const statuses = (await admin.query(
    `select id::text, status from training_load.source_metric_mapping_versions where id = any($1::uuid[])`, [[v1, v2]],
  )).rows;
  assert.deepEqual(Object.fromEntries(statuses.map((r) => [r.id, r.status])), { [v1]: "disabled", [v2]: "active" });
  const t5 = (await admin.query(
    `select id::text, mapping_version_id::text as version_id, ended_at, end_reason from training_load.source_metric_mapping_activations
      where source_team_binding_id = $1 order by activated_at, id`,
    [org.bindingId],
  )).rows;
  assert.equal(t5.length, 2);
  const oldT5 = t5.find((r) => r.version_id === v1);
  const newT5 = t5.find((r) => r.version_id === v2);
  assert.ok(oldT5.ended_at !== null && oldT5.end_reason === "mapping_version_replaced", "N's activation ended by the replacement");
  assert.equal(newT5.ended_at, null, "N+1 started on the binding");

  // The same session again: every occasion is needs_review (D17 sameMappings),
  // never unchanged, never corrected or supplemented.
  const second = await runImport(org, bundle);
  assert.deepEqual(second.counts, { needs_review: 5 });
  const after = await occasionsOf(org.teamId);
  assert.equal(after.size, 10, "five flagged occasions beside the five imported ones");
  for (const [id, o] of before) assert.deepEqual(after.get(id), o, "an occasion imported under v1 is untouched: still current, its values and provenance unchanged");
  for (const r of second.results) {
    const flagged = after.get(String(r.occasionId));
    assert.ok(flagged && !before.has(flagged.id), "a new flagged occasion");
    assert.deepEqual([flagged.status, flagged.current, flagged.supersedes, flagged.supersededBy], ["needs_review", false, null, null]);
    const current = [...before.values()].find((o) => o.identityId === flagged.identityId);
    assert.ok(current, "the identity's current occasion is still the one imported under v1");
    assert.equal(flagged.values.length, 1);
    const [value] = flagged.values;
    assert.deepEqual([value.definitionId, value.mappingVersionId, value.activationId], [String(variable.id), v2, newT5.id]);
    const where = `${r.gpexeAthleteId}|${drillOf(r.externalId) ?? "full"}`;
    assert.equal(value.valueText, EXPECTED[where], where);
    assert.equal(value.valueText, current.values[0].valueText, "the same value, yet not unchanged: its mapping version differs");
  }
  // A flagged result with the same hash and status is written only once.
  const third = await runImport(org, bundle);
  assert.deepEqual(third.counts, { needs_review_already_recorded: 5 });
  assert.equal((await occasionsOf(org.teamId)).size, 10);
});

// ---------------------------------------------------------------------------
// B2. the supplement and its exact decimal compare
// ---------------------------------------------------------------------------
test("B2a. supplemented: a first import without the drill details (burst / brake not fetched), then the same session with them - every drill result is supplemented with exactly the burst and brake values (addedValues by definition and activation), every earlier value carried over unchanged; the whole-session results stay unchanged", async () => {
  const org = await mappedTeam();
  const make = (detailsDrills) => makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId), detailsDrills });
  const first = await runImport(org, make([]));
  assert.deepEqual(first.counts, { created: 5 });
  const before = await occasionsOf(org.teamId);

  const second = await runImport(org, make([0, 1]));
  assert.deepEqual(second.counts, { unchanged: 2, supplemented: 3 });
  const after = await occasionsOf(org.teamId);
  const burst = { definitionId: String(world.gpexe_burst_events.variableId), activationId: String(org.started.gpexe_burst_events[0]), mappingVersionId: String(world.gpexe_burst_events.versionId) };
  const brake = { definitionId: String(world.gpexe_brake_events.variableId), activationId: String(org.started.gpexe_brake_events[0]), mappingVersionId: String(world.gpexe_brake_events.versionId) };
  const expectedAdded = [burst, brake].map(({ definitionId, activationId }) => ({ metricDefinitionId: definitionId, activationId }))
    .sort((a, b) => (a.metricDefinitionId < b.metricDefinitionId ? -1 : a.metricDefinitionId > b.metricDefinitionId ? 1 : 0));
  // The fixture's burst / brake of each drill row.
  const DETAILS = { "101|0": ["5", "4"], "101|1": ["4", "3"], "102|0": ["2", "2"] };
  for (const r of second.results) {
    const drill = drillOf(r.externalId);
    if (drill === null) {
      assert.equal(r.outcome, "unchanged");
      assert.ok(before.has(String(r.occasionId)) && after.get(String(r.occasionId)).current);
      continue;
    }
    const where = `${r.gpexeAthleteId}|${drill}`;
    assert.equal(r.outcome, "supplemented", where);
    assert.deepEqual(r.addedValues, expectedAdded, `${where}: exactly burst and brake are added`);
    const occasion = after.get(String(r.occasionId));
    const prior = after.get(occasion.supersedes);
    assert.ok(prior && before.has(prior.id), `${where}: supersedes the first import's occasion`);
    assert.deepEqual([occasion.current, occasion.status, prior.current, prior.supersededBy], [true, null, false, occasion.id]);
    assert.deepEqual(prior.values, before.get(prior.id).values, `${where}: the superseded occasion's values are untouched`);
    const priorByDefinition = new Map(prior.values.map((v) => [v.definitionId, v]));
    assert.equal(occasion.values.length, prior.values.length + 2);
    const added = [];
    for (const v of occasion.values) {
      const old = priorByDefinition.get(v.definitionId);
      if (!old) { added.push(v); continue; }
      const { valueId: _a, ...newFacts } = v;
      const { valueId: _b, ...oldFacts } = old;
      assert.deepEqual(newFacts, oldFacts, `${where}: an earlier value is carried over exactly`);
    }
    const [burstText, brakeText] = DETAILS[where];
    assert.deepEqual(
      added.map(({ valueId: _v, ...facts }) => facts).sort(byDefinition),
      [{ ...burst, valueText: burstText, sourceText: burstText }, { ...brake, valueText: brakeText, sourceText: brakeText }].sort(byDefinition),
      `${where}: the added values are the new burst and brake values`,
    );
  }
});

test("B2b. the supplement compares exact decimals: a drill row whose source time differs only beyond the storage scale (its stored canonical value is the same text) is not a supplement - it is flagged needs_review and the current occasion stays; the other drill results are still supplemented", async () => {
  const org = await mappedTeam();
  const first = await runImport(org, makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId), detailsDrills: [] }));
  assert.deepEqual(first.counts, { created: 5 });
  const before = await occasionsOf(org.teamId);

  // 101's drill 0: 1200 s, then 1200.0000000001 s. Both are "20" min at the
  // storage scale (9 decimals): the value text is equal, the source is not.
  const athletes = standardAthletes();
  athletes[0].parts[1].time = 1200.0000000001;
  assert.equal(athletes[0].parts[1].drill, 0);
  const second = await runImport(org, makeBundle({ athletes, gpexeTeamId: Number(org.sourceTeamId), detailsDrills: [0, 1] }));
  assert.deepEqual(second.counts, { unchanged: 2, supplemented: 2, needs_review: 1 });
  const after = await occasionsOf(org.teamId);
  const time = String(world.gpexe_time_min.variableId);
  for (const r of second.results) {
    const drill = drillOf(r.externalId);
    const where = `${r.gpexeAthleteId}|${drill ?? "full"}`;
    if (drill === null) { assert.equal(r.outcome, "unchanged", where); continue; }
    if (where !== "101|0") { assert.equal(r.outcome, "supplemented", where); continue; }
    assert.equal(r.outcome, "needs_review", where);
    assert.equal(r.addedValues, undefined);
    const flagged = after.get(String(r.occasionId));
    assert.deepEqual([flagged.status, flagged.current, flagged.supersedes], ["needs_review", false, null]);
    const current = [...after.values()].find((o) => o.identityId === flagged.identityId && o.current);
    assert.ok(current && before.has(current.id), "the first import's occasion stays current");
    assert.deepEqual(current, before.get(current.id), "and untouched");
    assert.equal(current.supersededBy, null);
    const flaggedTime = flagged.values.find((v) => v.definitionId === time);
    const currentTime = current.values.find((v) => v.definitionId === time);
    assert.equal(flaggedTime.valueText, "20");
    assert.equal(currentTime.valueText, "20", "the stored canonical values are the same text");
    assert.deepEqual([currentTime.sourceText, flaggedTime.sourceText], ["1200", "1200.0000000001"], "the source values differ beyond the storage scale");
    assert.equal(flagged.values.length, current.values.length + 2, "the flagged occasion also carries the new burst and brake");
  }
});

// ---------------------------------------------------------------------------
// B3. two closed power zones of one source field
// ---------------------------------------------------------------------------
test("B3. the two closed power zones (25-60 and 60-75 W/kg) are keyed separately: two activations of the same source field with two parameter sets write two values per row, each through its own activation and parameter fingerprint, each the distance of its own zone", async () => {
  const a = world.gpexe_power_zone_25_60_distance;
  const b = world.gpexe_power_zone_60_75_distance;
  assert.equal(String(a.fieldId), String(b.fieldId), "one source field");
  assert.equal(String(a.revId), String(b.revId), "one source revision");
  const org = await mappedTeam({ only: ["gpexe_power_zone_25_60_distance", "gpexe_power_zone_60_75_distance"] });
  const summary = await runImport(org, makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) }));
  assert.deepEqual(summary.counts, { created: 5 });
  const rows = (await admin.query(
    `select p.athlete_id::text as athlete_id, s.segment_order, o.id::text as occasion_id, v.metric_definition_id::text as definition_id,
            v.value_numeric::text as value_text, pr.source_value_numeric::text as source_text, pr.activation_id::text as activation_id,
            pr.mapping_version_id::text as version_id, a.parameter_fingerprint as activation_fp, mv.parameter_fingerprint as version_fp,
            mv.source_metric_definition_id::text as field_id
       from training_load.metric_values v
       join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
       join training_load.source_metric_mapping_activations a on a.id = pr.activation_id
       join training_load.source_metric_mapping_versions mv on mv.id = pr.mapping_version_id
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
       left join training_load.metric_event_segments s on s.id = o.segment_id
      where e.owner_team_id = $1`,
    [org.teamId],
  )).rows;
  assert.equal(rows.length, 10, "two values per occasion, one T6 row each");
  const zoneOf = new Map([[String(a.variableId), "25_60"], [String(b.variableId), "60_75"]]);
  const activationOf = { "25_60": String(org.started.gpexe_power_zone_25_60_distance[0]), "60_75": String(org.started.gpexe_power_zone_60_75_distance[0]) };
  const versionOf = { "25_60": String(a.versionId), "60_75": String(b.versionId) };
  const athleteOf = new Map(Object.entries(athleteMapOf(org)).map(([g, id]) => [String(id), g]));
  // The fixture's zone distances: power[2] is [25, 60], power[3] is [60, 75].
  const EXPECTED = {
    "101|full": { "25_60": "300", "60_75": "60" }, "101|0": { "25_60": "150", "60_75": "30" }, "101|1": { "25_60": "150", "60_75": "30" },
    "102|full": { "25_60": "80", "60_75": "15" }, "102|0": { "25_60": "80", "60_75": "15" },
  };
  const perOccasion = new Map();
  const fingerprints = {};
  for (const r of rows) {
    const zone = zoneOf.get(r.definition_id);
    assert.ok(zone, "every value is one of the two zone variables");
    assert.equal(r.field_id, String(a.fieldId), "of the one source field");
    assert.equal(r.activation_id, activationOf[zone]);
    assert.equal(r.version_id, versionOf[zone]);
    assert.match(r.activation_fp, /^v[0-9]+:[0-9a-f]{64}$/);
    assert.equal(r.activation_fp, r.version_fp, "the activation carries its version's fingerprint");
    if (fingerprints[zone] === undefined) fingerprints[zone] = r.activation_fp;
    assert.equal(r.activation_fp, fingerprints[zone], "one fingerprint per zone");
    const where = `${athleteOf.get(r.athlete_id)}|${r.segment_order === null ? "full" : String(Number(r.segment_order) - 1)}`;
    assert.equal(canonicalDecimal(r.value_text), EXPECTED[where][zone], `${where} ${zone}`);
    assert.equal(canonicalDecimal(r.source_text), EXPECTED[where][zone], `${where} ${zone}: identity conversion`);
    if (!perOccasion.has(r.occasion_id)) perOccasion.set(r.occasion_id, []);
    perOccasion.get(r.occasion_id).push(zone);
  }
  assert.notEqual(fingerprints["25_60"], fingerprints["60_75"], "two parameter sets, two fingerprints");
  assert.equal(perOccasion.size, 5);
  for (const zones of perOccasion.values()) assert.deepEqual(zones.sort(), ["25_60", "60_75"], "each occasion holds both zones once");
});

// ---------------------------------------------------------------------------
// B4. PARAMS_AS_TEXT parity
// ---------------------------------------------------------------------------
test("B4. PARAMS_AS_TEXT parity: the importer's local copy and sourceMetricMappingService's give the same object for every stored T4 source_parameters (every JSON number as its exact trimmed decimal text, strings and nulls as stored) and for a literal with numeric-looking values; readOpenActivations hands the extractor exactly that object", async () => {
  const { adminWriteKit } = await import("../src/sourceMetricMappingService.js");
  assert.equal(PARAMS_AS_TEXT("v.source_parameters"), adminWriteKit.PARAMS_AS_TEXT("v.source_parameters"), "the same SQL text");
  const org = await mappedTeam();
  const stored = (await admin.query(
    `select v.id::text as id, ${PARAMS_AS_TEXT("v.source_parameters")} as local_form, ${adminWriteKit.PARAMS_AS_TEXT("v.source_parameters")} as service_form,
            (select coalesce(jsonb_agg(jsonb_build_array(e.key, jsonb_typeof(e.value), e.value #>> '{}')), '[]'::jsonb) from jsonb_each(v.source_parameters) e) as raw
       from training_load.source_metric_mapping_versions v order by v.id`,
  )).rows;
  assert.ok(stored.length >= Object.keys(world).length);
  let numbers = 0;
  let fractions = 0;
  for (const r of stored) {
    assert.deepEqual(r.local_form, r.service_form, `version ${r.id}`);
    assert.equal(Object.keys(r.local_form).length, r.raw.length);
    for (const [name, type, text] of r.raw) {
      if (type === "number") {
        numbers += 1;
        if (text.includes(".")) fractions += 1;
        assert.equal(r.local_form[name], canonicalDecimal(text), `${name}: the number as exact decimal text`);
      } else if (type === "null") {
        assert.equal(r.local_form[name], null);
      } else {
        assert.equal(type, "string", `${name}: only numbers, strings and nulls are stored`);
        assert.equal(r.local_form[name], text);
      }
    }
  }
  assert.ok(numbers > 0 && fractions > 0, "the world stores numeric parameters, fractional ones among them (2.5, -2.5, 0.3)");

  // A literal with every numeric-looking form, and the empty and missing object.
  const literal = '{"lower": 25.50, "upper": 60.000, "threshold_value": -2.500, "duration_seconds": 0.30, "big": 1e2, "tiny": 0.000000001, "text": "2.50", "operator": "between", "unit": "W/kg", "none": null}';
  const forms = async (sql, params = []) => (await admin.query(
    `select ${PARAMS_AS_TEXT("x.p")} as local_form, ${adminWriteKit.PARAMS_AS_TEXT("x.p")} as service_form from (${sql}) x`, params,
  )).rows[0];
  const lit = await forms("select $1::jsonb as p", [literal]);
  const EXPECTED = { lower: "25.5", upper: "60", threshold_value: "-2.5", duration_seconds: "0.3", big: "100", tiny: "0.000000001", text: "2.50", operator: "between", unit: "W/kg", none: null };
  assert.deepEqual(lit.local_form, EXPECTED);
  assert.deepEqual(lit.service_form, EXPECTED);
  for (const sql of ["select '{}'::jsonb as p", "select null::jsonb as p"]) {
    const empty = await forms(sql);
    assert.deepEqual([empty.local_form, empty.service_form], [{}, {}], sql);
  }

  // The JS side: the rows the importer reads carry the same object, which is
  // the stored form of the legacy spec's parameters.
  const byVersion = new Map(stored.map((r) => [r.id, r.local_form]));
  const rows = await readOpenActivations(admin, org.bindingId);
  assert.equal(rows.length, Object.keys(world).length);
  for (const row of rows) {
    const legacyKey = Object.keys(world).find((k) => String(world[k].versionId) === row.mappingVersionId);
    assert.ok(legacyKey, "an activation of the world");
    assert.deepEqual(row.sourceParameters, byVersion.get(row.mappingVersionId), legacyKey);
    assert.deepEqual(row.sourceParameters, SPEC_REGISTRY[legacyKey].storedParameters, legacyKey);
  }
});

// ---------------------------------------------------------------------------
// B5. D18, the bundle-team guard
// ---------------------------------------------------------------------------
test("B5. D18: a bundle whose teamSession.team is not the binding's source team is refused mapping_not_usable (blockReason bundle_team) and nothing is written - no event, value, provenance, source instance or definition; the binding's own team's bundle then imports", async () => {
  const org = await mappedTeam();
  const foreignTeam = Number(org.sourceTeamId) + 500;
  const foreign = makeBundle({ athletes: standardAthletes(), gpexeTeamId: foreignTeam });
  const digestBefore = await definitionDigest(admin);
  await assert.rejects(runImport(org, foreign), isImportError("mapping_not_usable"));
  await assertNothingWritten(org.teamId, "D18");
  assert.equal((await t7Keys(admin, org.teamId)).length, 0, "no source instance");
  assert.equal(await definitionDigest(admin), digestBefore);
  const prepared = await inTransaction(async (client) => {
    await lockTeamForImport(client, org.teamId);
    return prepareImportMapping(client, { teamId: org.teamId, bindingId: org.bindingId, sessionExternalId: "team_session:5001", sourceTeamIdOfBundle: String(foreignTeam) });
  });
  assert.deepEqual([prepared.block, prepared.blockReason, prepared.rows.length, prepared.connection], ["mapping_not_usable", "bundle_team", 0, null]);
  assert.equal(prepared.binding.id, org.bindingId);
  // Control: the same session of the bound GPEXE team is written.
  const own = await runImport(org, makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) }));
  assert.deepEqual(own.counts, { created: 5 });
});

// ---------------------------------------------------------------------------
// B7. R6: the team's source instance ends between the read and the lock
// ---------------------------------------------------------------------------
// A team bound to GPEXE team Y whose active Metrics Core source instance is
// keyed to another GPEXE team X (a raw fixture row, as the 7g suite's): the
// only instance v50 lets end while the team is bound and activated, since
// every writer of the binding and its activations waits on the import's FOR
// SHARE locks. The end is the 7g suite's raw path with every trigger on: the
// acting platform admin, the update and its source_instance_end audit row.
async function heldInstanceTeam() {
  const org = await mappedTeam({ only: ["gpexe_time_min"] });
  const heldKey = nextHeldKey();
  const instanceId = String((await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id, source_host_key, source_instance_key)
     values ('gpexe','team',$1,'server3',$2) returning id`,
    [org.teamId, heldKey],
  )).rows[0].id);
  return { org, heldKey, instanceId, bundle: makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) }) };
}
async function endInstanceRaw({ org, instanceId }) {
  const client = await newClient();
  try {
    await client.query("begin");
    await client.query(CTX, [pa]);
    await client.query(`update training_load.metric_source_connections set state = 'inactive' where id = $1`, [instanceId]);
    await client.query(
      `insert into training_load.source_metric_audit (action, metric_source_connection_id, team_id, from_status, to_status, reason, evidence_ref, performed_by_user_id, basis, operation_id, request_key, request_hash)
       values ('source_instance_end',$1,$2,'active','inactive','A raw end.',null,$3,'platform_admin',$4,$5,$6)`,
      [instanceId, org.teamId, pa, crypto.randomUUID(), crypto.randomUUID(), "0".repeat(64)],
    );
    await client.query("commit");
    return { ok: true };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error };
  } finally {
    await client.end().catch(() => {});
  }
}
async function instanceRows(teamId) {
  return (await admin.query(
    `select id::text as id, state, source_host_key, source_instance_key from training_load.metric_source_connections
      where source_system = 'gpexe' and owner_scope = 'team' and owner_team_id = $1 order by created_at, id`,
    [teamId],
  )).rows;
}

test("B7. R6: the team's source instance ends (7g, every trigger on) between the importer's unlocked read and its FOR UPDATE: mapping_not_usable (blockReason source_instance_inactive), the ended row is never reactivated and no row is created in its place, nothing is written; under the team import lock the v50 guard refuses that end instead (its try-lock), and the import answers source_instance_changed", async () => {
  // (a) Control, nothing ended: the instance's keys are not the binding's.
  const s1 = await heldInstanceTeam();
  const control = await inTransaction(async (client) => {
    await lockTeamForImport(client, s1.org.teamId);
    return prepareImportMapping(client, { teamId: s1.org.teamId, bindingId: s1.org.bindingId, sessionExternalId: "team_session:5001", sourceTeamIdOfBundle: s1.org.sourceTeamId });
  });
  assert.deepEqual([control.block, control.blockReason], ["source_instance_changed", null]);

  // (b) The real import holds the team import lock: the end, tried inside the
  // hold, is refused at once by v50's try-lock; the import goes on and refuses.
  let attempt = null;
  try {
    setSourceInstanceHoldForTests(async () => { if (attempt === null) attempt = await endInstanceRaw(s1); });
    await assert.rejects(runImport(s1.org, s1.bundle), isImportError("source_instance_changed"));
  } finally {
    setSourceInstanceHoldForTests(null);
  }
  assert.ok(attempt && attempt.ok === false, "the end was tried in the hold and refused");
  assert.equal(attempt.error.code, "P0001");
  assert.match(attempt.error.message, TEAM_LOCK);
  assert.deepEqual((await instanceRows(s1.org.teamId)).map((r) => [r.id, r.state]), [[s1.instanceId, "active"]]);
  await assertNothingWritten(s1.org.teamId, "R6 (b)");

  // (c) R6 through the mapping context, the caller holding no team lock: the
  // end commits in the hold, the FOR UPDATE then reads the ended row.
  attempt = null;
  let prepared;
  try {
    setSourceInstanceHoldForTests(async () => { if (attempt === null) attempt = await endInstanceRaw(s1); });
    prepared = await inTransaction((client) => prepareImportMapping(client, {
      teamId: s1.org.teamId, bindingId: s1.org.bindingId, sessionExternalId: "team_session:5001", sourceTeamIdOfBundle: s1.org.sourceTeamId,
    }));
  } finally {
    setSourceInstanceHoldForTests(null);
  }
  assert.deepEqual(attempt, { ok: true }, "the 7g end committed between the read and the lock");
  assert.deepEqual([prepared.block, prepared.blockReason, prepared.connection, prepared.rows.length], ["mapping_not_usable", "source_instance_inactive", null, 1]);
  assert.deepEqual((await instanceRows(s1.org.teamId)).map((r) => [r.id, r.state, r.source_instance_key]), [[s1.instanceId, "inactive", s1.heldKey]],
    "the ended row stays ended; no row is created in its place");
  await assertNothingWritten(s1.org.teamId, "R6 (c)");

  // (d) The same race through the writer (importGpexeBundleLocked, again
  // without the team lock): mapping_not_usable, nothing written.
  const s2 = await heldInstanceTeam();
  attempt = null;
  let outcome;
  try {
    setSourceInstanceHoldForTests(async () => { if (attempt === null) attempt = await endInstanceRaw(s2); });
    outcome = await inTransaction(async (client) => {
      try {
        await importGpexeBundleLocked(client, s2.bundle, ctxOf(s2.org));
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    });
  } finally {
    setSourceInstanceHoldForTests(null);
  }
  assert.deepEqual(attempt, { ok: true });
  assert.equal(outcome.ok, false);
  assert.ok(isImportError("mapping_not_usable")(outcome.error), `got ${outcome.error?.code}`);
  assert.deepEqual((await instanceRows(s2.org.teamId)).map((r) => [r.id, r.state]), [[s2.instanceId, "inactive"]]);
  await assertNothingWritten(s2.org.teamId, "R6 (d)");
});

// ---------------------------------------------------------------------------
// B6. R11: a canonical definition without the scope capability of a level
// ---------------------------------------------------------------------------
// Runs last: it removes, with triggers off for that one statement, the
// component capability of the world's time variable and restores it in
// `finally` (the digest of the catalog is compared after the restore).
test("B6 (last). R11: an activation whose canonical definition lost the scope capability of a level it covers - the import answers mapping_not_usable (blockReason scope_capability) and writes nothing; with triggers on the capability cannot be removed at all", async () => {
  const org = await mappedTeam({ only: ["gpexe_time_min"] });
  const variableId = String(world.gpexe_time_min.variableId);
  const digestBefore = await definitionDigest(admin);
  const capability = `select count(*)::int as n from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`;
  // The database's own guards keep the level while an active version applies to it.
  await assert.rejects(admin.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [variableId]));
  assert.equal((await admin.query(capability, [variableId])).rows[0].n, 1);
  try {
    await rawTx((client) => client.query(`delete from training_load.metric_definition_scope_capabilities where metric_definition_id = $1 and scope_level = 'component'`, [variableId]));
    assert.equal((await admin.query(capability, [variableId])).rows[0].n, 0);
    await assert.rejects(runImport(org, makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(org.sourceTeamId) })), isImportError("mapping_not_usable"));
    await assertNothingWritten(org.teamId, "R11");
    assert.equal((await t7Keys(admin, org.teamId)).length, 0, "refused before the source instance step");
    const prepared = await inTransaction(async (client) => {
      await lockTeamForImport(client, org.teamId);
      return prepareImportMapping(client, { teamId: org.teamId, bindingId: org.bindingId, sessionExternalId: "team_session:5001", sourceTeamIdOfBundle: org.sourceTeamId });
    });
    assert.deepEqual([prepared.block, prepared.blockReason, prepared.connection, prepared.rows.length], ["mapping_not_usable", "scope_capability", null, 1]);
  } finally {
    await rawTx((client) => client.query(
      `insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'component') on conflict do nothing`, [variableId],
    ));
  }
  assert.equal(await definitionDigest(admin), digestBefore, "the catalog is restored exactly");
});
