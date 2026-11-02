// Phase 9, 9-B (contract J17 section 8.1): the importer writes through mapping
// activations. The characterisation test: Arm A1 (the writer's own entry,
// counts and values against the frozen oracle of the pre-9-B specs) and Arm B1
// (no activation: nothing is written, proven at the writer itself). On
// disposable optimove_tests_gpexe_* databases only; no GPEXE request.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { previewBundle } from "./support/preview-bundles.mjs";
import { LEGACY_SPECS, SPEC_REGISTRY } from "./support/gpexe-legacy-specs.mjs";
import { activateOn, bindTeam, definitionDigest, ensureMappedSystem, platformAdmin, t6Rows, t7Keys } from "./support/mapped-world.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexeBundle, GpexeImportError } from "../src/gpexeImportWriter.js";
import { convertAtStorageScale } from "../src/sourceMetricPreview.js";
import { canonicalDecimal } from "../src/sourceMetricExtractors.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

let db;
let admin;
let pa;
let world;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "mapped_9b" });
  process.env.DATABASE_URL = db.url;
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  pa = await platformAdmin(admin);
  world = await ensureMappedSystem(admin, { platformAdminId: pa });
});

after(async () => {
  try {
    const dbModule = await import("../src/db.js");
    await dbModule.pool.end().catch(() => {});
  } catch { /* not loaded */ }
  await admin?.end().catch(() => {});
  await db?.drop();
});

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

// Each team its own GPEXE team id (gpexe_team_settings is unique on it).
let teamCounter = 0;
const nextSourceTeamId = () => String(9100 + (teamCounter += 1));
async function mappedTeam({ sourceTeamId = nextSourceTeamId(), activate = true, requirement = "optional", only = null } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C", "Athlete D"] });
  const binding = await bindTeam(admin, { teamId: org.teamId, clubId: org.clubId, sourceTeamId, by: pa });
  const started = activate ? await activateOn(world, { bindingId: binding.bindingId, platformAdminId: pa, requirement, only }) : {};
  return { ...org, ...binding, started };
}

async function runImport(org, bundle, athleteMap, extra = {}) {
  const client = await newClient();
  try {
    return await importGpexeBundle(client, bundle, {
      ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: athleteMap, batchFilename: "9b test", ...extra,
    });
  } finally {
    await client.end();
  }
}

// The oracle: what the pre-9-B importer wrote, per (athlete, level, drill,
// legacy key) - the frozen specs on every row the plan's gates keep.
function oracleOf(bundle) {
  const plan = buildGpexeImportPlan(bundle, {
    metricSpecs: LEGACY_SPECS.map((s) => ({ raw: true, key: s.key, levels: { full: true, drill: true }, extract: s.extract })),
  });
  const out = new Map();
  for (const p of plan.participants) {
    for (const r of p.results) {
      for (const v of r.values) out.set(`${p.gpexeAthleteId}|${r.level}|${r.drillIndex ?? ""}|${v.key}`, v.value);
    }
  }
  return out;
}

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

test("A1. the writer through eleven optional activations writes exactly the pre-9-B values, as exact decimals at the storage scale, with one T6 row each, the T7 keys once, today's structural counts and no definition", async () => {
  const org = await mappedTeam({ sourceTeamId: "77" });
  const athleteMap = { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] };
  const bundle = makeBundle({ athletes: standardAthletes() });
  const digestBefore = await definitionDigest(admin);
  const summary = await runImport(org, bundle, athleteMap);
  assert.deepEqual(summary.counts, { created: 5 }, "101: full + 2 drills, 102: full + 1 drill; 103 left out (two tracks)");
  assert.equal(summary.definitionsCreated, undefined);
  assert.equal(summary.connectionCreated, true);
  assert.equal(summary.instanceKeysSet, true);
  assert.deepEqual(await counts(org.teamId), {
    events: 1, segments: 2, event_participants: 2, source_identities: 6, import_batches: 1, occasions: 5, metric_values: 53, provenance: 53,
    activities: 1, activity_components: 2, component_segment_links: 2, event_source_bindings: 1, team_definitions: 0,
  });
  assert.equal(await definitionDigest(admin), digestBefore, "no definition, version or capability is created or changed (C46)");

  // Values against the oracle: the same set, |v - oracle| <= 1e-9, and the text
  // is the exact conversion of the source value.
  const oracle = oracleOf(bundle);
  const keyOfVariable = new Map(Object.entries(world).map(([legacyKey, m]) => [m.variableId, legacyKey]));
  const athleteOfId = new Map(Object.entries(athleteMap).map(([g, a]) => [a, g]));
  const rows = (await admin.query(
    `select p.athlete_id, s.segment_order, v.metric_definition_id, v.value_numeric::text as value_text,
            pr.source_value_numeric::text as source_text, pr.source_unit, pr.activation_id, pr.mapping_version_id,
            mv.scale::text as scale, mv.scale_divisor::text as divisor, mv."offset"::text as "offset"
       from training_load.metric_values v
       join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
       join training_load.source_metric_mapping_versions mv on mv.id = pr.mapping_version_id
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
       left join training_load.metric_event_segments s on s.id = o.segment_id
      where e.owner_team_id = $1`,
    [org.teamId],
  )).rows;
  const written = new Map();
  for (const r of rows) {
    const legacyKey = keyOfVariable.get(String(r.metric_definition_id));
    assert.ok(legacyKey, "every value is of a system variable of the world");
    const level = r.segment_order === null ? "full" : "drill";
    const drill = level === "drill" ? String(Number(r.segment_order) - 1) : "";
    const k = `${athleteOfId.get(String(r.athlete_id))}|${level}|${drill}|${legacyKey}`;
    assert.ok(!written.has(k), `one value per ${k}`);
    written.set(k, r);
    assert.equal(canonicalDecimal(r.value_text), convertAtStorageScale(r.source_text, { scale: r.scale, divisor: r.divisor, offset: r.offset }), k);
    assert.equal(r.source_unit, SPEC_REGISTRY[legacyKey].confirmation.unit, k);
  }
  assert.deepEqual([...written.keys()].sort(), [...oracle.keys()].sort(), "the written set is the oracle's non-skipped set: no extra value, none missing");
  for (const [k, value] of oracle) {
    assert.ok(Math.abs(Number(written.get(k).value_text) - value) <= 1e-9, `${k}: ${written.get(k).value_text} vs ${value}`);
  }
  const zeroSprints = [...oracle.entries()].filter(([k, v]) => k.endsWith("gpexe_sprint_distance_7mps") && v === 0);
  for (const [k] of zeroSprints) assert.equal(canonicalDecimal(written.get(k).value_text), "0", "a real 0 stays 0");

  // T7: the keys set once from NULL (here: inserted with them).
  const instances = await t7Keys(admin, org.teamId);
  assert.equal(instances.length, 1);
  assert.deepEqual([instances[0].state, instances[0].source_host_key, instances[0].source_instance_key], ["active", "server3", "77"]);
  // A second import changes nothing and does not touch the keys.
  const again = await runImport(org, bundle, athleteMap);
  assert.deepEqual(again.counts, { unchanged: 5 });
  assert.equal(again.connectionCreated, false);
  assert.equal(again.instanceKeysSet, false);
  assert.deepEqual(await t7Keys(admin, org.teamId), instances);
  const event = (await admin.query(`select id from training_load.metric_events where owner_team_id = $1`, [org.teamId])).rows[0].id;
  assert.equal((await t6Rows(admin, event)).length, 53);
});

test("A2 (writer). the rounding fixture: every value is the exact conversion at the storage scale and within 1e-9 of the oracle", async () => {
  const org = await mappedTeam({ sourceTeamId: "980" });
  const bundle = previewBundle({ gpexeTeamId: 980 });
  const ids = [...new Set(bundle.athleteSessions.map((r) => String(r.athlete)))].sort();
  const athleteMap = Object.fromEntries(ids.map((g, i) => [g, org.athleteIds[i]]));
  const summary = await runImport(org, bundle, athleteMap);
  assert.ok(summary.counts.created > 0);
  const oracle = oracleOf(bundle);
  const rows = (await admin.query(
    `select v.value_numeric::text as value_text, pr.source_value_numeric::text as source_text,
            mv.scale::text as scale, mv.scale_divisor::text as divisor, mv."offset"::text as "offset"
       from training_load.metric_values v
       join training_load.metric_value_source_provenance pr on pr.metric_value_id = v.id
       join training_load.source_metric_mapping_versions mv on mv.id = pr.mapping_version_id
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_events e on e.id = p.event_id
      where e.owner_team_id = $1`,
    [org.teamId],
  )).rows;
  assert.equal(rows.length, oracle.size, "one value per oracle entry");
  for (const r of rows) assert.equal(canonicalDecimal(r.value_text), convertAtStorageScale(r.source_text, { scale: r.scale, divisor: r.divisor, offset: r.offset }));
});

test("B1. no activation on the team's binding: the writer refuses no_mapped_values and writes nothing at all, whatever the bundle", async () => {
  for (const make of [(id) => makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(id) }), (id) => previewBundle({ gpexeTeamId: Number(id) })]) {
    const sourceTeamId = nextSourceTeamId();
    const bundle = make(sourceTeamId);
    const org = await mappedTeam({ sourceTeamId, activate: false });
    const ids = [...new Set(bundle.athleteSessions.map((r) => String(r.athlete)))].sort();
    const athleteMap = Object.fromEntries(ids.map((g, i) => [g, org.athleteIds[i]]));
    const digestBefore = await definitionDigest(admin);
    await assert.rejects(runImport(org, bundle, athleteMap), (error) => error instanceof GpexeImportError && error.code === "no_mapped_values");
    const after = await counts(org.teamId);
    for (const [name, n] of Object.entries(after)) assert.equal(n, 0, `${name} stays empty`);
    assert.equal((await t7Keys(admin, org.teamId)).length, 0, "no source instance either");
    assert.equal(await definitionDigest(admin), digestBefore);
  }
});

test("B1b. a binding whose only activations ended: no_mapped_values, nothing written", async () => {
  const sourceTeamId = nextSourceTeamId();
  const org = await mappedTeam({ sourceTeamId, only: ["gpexe_time_min"] });
  const activations = await import("../src/sourceMetricActivationService.js");
  const ctx = { userId: pa, basis: "platform_admin", owner: { scope: "system", clubId: null } };
  for (const id of org.started.gpexe_time_min) {
    await activations.endActivation({ ctx, activationId: id, body: { requestKey: crypto.randomUUID(), expectedState: "open", reason: "9-B test end." } });
  }
  await assert.rejects(runImport(org, makeBundle({ athletes: standardAthletes(), gpexeTeamId: Number(sourceTeamId) }), { 101: org.athleteIds[0], 102: org.athleteIds[1] }),
    (error) => error instanceof GpexeImportError && error.code === "no_mapped_values");
  assert.equal((await counts(org.teamId)).metric_values, 0);
});
