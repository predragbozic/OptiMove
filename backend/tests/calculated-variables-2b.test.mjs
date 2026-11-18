// Calculated variables, step 2b (J21, C141-C148): the import writes a calculated variable's values once, beside its inputs, in
// its own transaction. Writer-level proofs on the real mapped importer (the 9-B world: system mappings of the seeded GPEXE
// fields, a team binding, its activations) with HMLD = power zone distance 25-60 + 60-75 + 75+, on disposable
// optimove_tests_gpexe_* databases only; no GPEXE request, no credential.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { activateOn, bindTeam, ensureMappedSystem, platformAdmin } from "./support/mapped-world.mjs";
import { importGpexeBundle } from "../src/gpexeImportWriter.js";
import { buildCandidatePreview } from "../src/gpexeImportPreview.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

let db;
let admin;
let pa;
let world;
let hmld;
const ZONES = ["gpexe_power_zone_25_60_distance", "gpexe_power_zone_60_75_distance", "gpexe_power_zone_75_plus_distance"];
const SYS = (userId) => ({ userId: String(userId), basis: "platform_admin", owner: { scope: "system", clubId: null } });
const key = () => crypto.randomUUID();

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "calc_2b" });
  process.env.DATABASE_URL = db.url;
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.match((await admin.query("select current_database() as d")).rows[0].d, /^optimove_tests_/, "SAFETY: a disposable database only");
  pa = await platformAdmin(admin);
  world = await ensureMappedSystem(admin, { platformAdminId: pa });
  const variables = await import("../src/canonicalVariableAdminService.js");
  hmld = (await variables.createVariable({
    ctx: SYS(pa),
    body: { requestKey: key(), label: "High metabolic load distance", unit: "m", levels: ["session", "drill"],
      calculation: { kind: "sum", inputs: ZONES.map((z) => world[z].variableId) } },
  })).variable;
});

after(async () => {
  try {
    const { pool } = await import("../src/db.js");
    await pool.end().catch(() => {});
  } finally {
    await admin?.end().catch(() => {});
    await db?.drop();
  }
});

let teamCounter = 0;
async function mappedTeam({ only = null } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C", "Athlete D"] });
  const sourceTeamId = String(9600 + (teamCounter += 1));
  const binding = await bindTeam(admin, { teamId: org.teamId, clubId: org.clubId, sourceTeamId, by: pa });
  await activateOn(world, { bindingId: binding.bindingId, platformAdminId: pa, only });
  // The preview reads the team's GPEXE athlete links (the import here takes the same map directly).
  for (const [gpexeId, athleteId] of Object.entries(athleteMapOf(org))) {
    await admin.query(`insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4)`,
      [org.teamId, gpexeId, athleteId, pa]);
  }
  return { ...org, ...binding, sourceTeamId };
}
const athleteMapOf = (org) => ({ 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] });
async function runImport(org, bundle) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return await importGpexeBundle(client, bundle, {
      ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: athleteMapOf(org), batchFilename: "2b test",
    });
  } finally {
    await client.end();
  }
}
const bundleOf = (org, { updatedOn, power } = {}) => {
  const athletes = standardAthletes();
  if (power) for (const [i, part] of Object.entries(power)) athletes[0].parts[Number(i)].power = part;
  return makeBundle({ gpexeTeamId: Number(org.sourceTeamId), athletes, ...(updatedOn ? { updatedOn } : {}) });
};

// Every occasion of the team's event: its identity, level, whether it is current, its values by variable, its calculated rows.
async function occasions(teamId) {
  return (await admin.query(
    `select o.id, si.source_external_id as external_id, (si.current_occasion_id = o.id) as current, o.import_conflict_status as conflict,
            (o.segment_id is null) as session_level,
            coalesce(jsonb_object_agg(v.metric_definition_id::text, v.value_numeric::text) filter (where not v.is_derived), '{}'::jsonb) as inputs,
            coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'definition', v.metric_definition_id, 'version', v.metric_definition_version_id,
                                                  'value', v.value_numeric::text, 'role', v.aggregation_role, 'coverage', v.coverage,
                                                  'ref', v.computed_by_ref, 'unit', v.unit_at_capture)) filter (where v.is_derived), '[]'::jsonb) as derived
       from training_load.metric_events e
       join training_load.metric_event_participants p on p.event_id = e.id
       join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
       join training_load.metric_source_identities si on si.id = o.source_identity_id
       left join training_load.metric_values v on v.occasion_id = o.id
      where e.owner_team_id = $1
      group by o.id, si.source_external_id, si.current_occasion_id, o.import_conflict_status, o.segment_id
      order by si.source_external_id, o.created_at`,
    [teamId],
  )).rows;
}
const zoneIds = () => ZONES.map((z) => world[z].variableId);
const expectedSum = (inputs) => {
  const values = zoneIds().map((id) => inputs[id]);
  if (values.some((v) => v === undefined)) return null;
  return values.reduce((a, b) => a + Number(b), 0);
};
// The invariant of C141-C143: every occasion has a calculated value exactly when it has all three inputs, equal to their sum,
// naming its formula version and its inputs' value ids in the formula's order.
async function assertCalculatedMatchInputs(teamId) {
  const rows = await occasions(teamId);
  assert.ok(rows.length > 0);
  for (const o of rows) {
    const sum = expectedSum(o.inputs);
    if (sum === null) {
      assert.deepEqual(o.derived, [], `${o.external_id}: no input set, no calculated value`);
      continue;
    }
    assert.equal(o.derived.length, 1, `${o.external_id}: one calculated value`);
    const d = o.derived[0];
    assert.equal(d.definition, hmld.id);
    assert.equal(d.version, hmld.currentVersion.id);
    assert.equal(Number(d.value), sum, `${o.external_id}: the sum of its own inputs`);
    assert.deepEqual([d.role, d.coverage, d.unit], ["derived_rollup", "complete", "m"]);
    const ids = (await admin.query(`select metric_definition_id::text as def, id::text from training_load.metric_values where occasion_id = $1 and not is_derived`, [o.id])).rows;
    const idOf = new Map(ids.map((r) => [r.def, r.id]));
    assert.deepEqual(d.ref, { formulaVersionId: hmld.currentVersion.id, inputValueIds: zoneIds().map((id) => idOf.get(id)) });
  }
  return rows;
}

test("1. a first import writes HMLD on every occasion that has its three inputs (session and drills), as the exact sum, naming its formula version and its inputs in order; 101's session is 300 + 60 + 40", async () => {
  const org = await mappedTeam();
  const summary = await runImport(org, bundleOf(org));
  assert.ok(summary.results.length > 0);
  const rows = await assertCalculatedMatchInputs(org.teamId);
  const session101 = rows.find((o) => o.current && o.session_level && /athlete_session:\d+:full$/.test(o.external_id) && o.derived.length && Number(o.derived[0].value) === 400);
  assert.ok(session101, "athlete 101's session HMLD is 400");
  assert.ok(rows.some((o) => !o.session_level && o.derived.length && Number(o.derived[0].value) === 200), "a drill's HMLD (150 + 30 + 20)");
  // Re-importing the same session changes nothing: the calculated rows are no imported fact.
  const before = await occasions(org.teamId);
  const again = await runImport(org, bundleOf(org));
  assert.ok(again.results.every((r) => r.outcome === "unchanged"), JSON.stringify(again.counts));
  assert.deepEqual(await occasions(org.teamId), before);
});

test("2. a corrected input (a newer GPEXE answer) supersedes the calculation: the new current occasion carries the new sum, the superseded one keeps its own; a needs-review occasion carries its own sum and leaves the current one as it was; no current occasion ever holds a stale calculated value", async () => {
  const org = await mappedTeam();
  await runImport(org, bundleOf(org));
  const corrected = await runImport(org, bundleOf(org, { updatedOn: "2026-09-15T08:00:00.000", power: { 0: [2400, 200, 330, 60, 40] } }));
  assert.ok(corrected.results.some((r) => r.outcome === "corrected"), JSON.stringify(corrected.counts));
  let rows = await assertCalculatedMatchInputs(org.teamId);
  const current = rows.filter((o) => o.current && o.session_level && o.derived.length);
  assert.ok(current.some((o) => Number(o.derived[0].value) === 430), "the corrected session's HMLD is 330 + 60 + 40");
  // The same reported time with other values: needs review; the current occasion stays, the flagged one has its own sum.
  const review = await runImport(org, bundleOf(org, { updatedOn: "2026-09-15T08:00:00.000", power: { 0: [2400, 200, 310, 60, 40] } }));
  assert.ok(review.results.some((r) => r.outcome === "needs_review"), JSON.stringify(review.counts));
  rows = await assertCalculatedMatchInputs(org.teamId);
  assert.ok(rows.some((o) => o.conflict === "needs_review" && o.derived.length && Number(o.derived[0].value) === 410));
  assert.ok(rows.some((o) => o.current && o.derived.length && Number(o.derived[0].value) === 430), "the current occasion is unchanged");
});

test("3. a missing input is no value (C142): a team without the 75+ zone gets no HMLD at all, and the preview names the missing input for every result, by name", async () => {
  const org = await mappedTeam({ only: ["gpexe_power_zone_25_60_distance", "gpexe_power_zone_60_75_distance", "gpexe_total_distance"] });
  await runImport(org, bundleOf(org));
  const rows = await occasions(org.teamId);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((o) => o.derived.length === 0), "never a partial sum");
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const { preview } = await buildCandidatePreview(client, { bundle: bundleOf(org), ownerTeamId: org.teamId, performedByUserId: org.userId,
      importPath: { path: "source_connection", bindingId: org.bindingId } });
    const results = preview.athletes.flatMap((a) => a.results);
    assert.ok(results.length > 0);
    const label75 = (await admin.query(`select label from training_load.metric_definitions where id = $1`, [world.gpexe_power_zone_75_plus_distance.variableId])).rows[0].label;
    const imported = results.filter((x) => x.outcome !== "not_imported");
    assert.ok(imported.length > 0, "the preview imports results to describe");
    for (const r of imported) {
      assert.deepEqual(r.calculated, [{ metricDefinitionId: hmld.id, label: hmld.label, value: null, unit: null,
        missingInputs: [{ metricDefinitionId: world.gpexe_power_zone_75_plus_distance.variableId, label: label75 }] }], r.externalId);
    }
  } finally {
    await client.end();
  }
});

test("4. the preview of a team with every input lists each result's HMLD value; a team whose club hid HMLD, and a club variable of another club, get none", async () => {
  const org = await mappedTeam();
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const { preview } = await buildCandidatePreview(client, { bundle: bundleOf(org), ownerTeamId: org.teamId, performedByUserId: org.userId,
      importPath: { path: "source_connection", bindingId: org.bindingId } });
    const session = preview.athletes.find((a) => a.gpexeAthleteId === "101").results.find((r) => r.level === "full");
    assert.deepEqual(session.calculated, [{ metricDefinitionId: hmld.id, label: hmld.label, value: "400", unit: "m", missingInputs: [] }]);
    // A club's own calculated variable applies to its team; another club's never does (two raw club variables over the
    // same system inputs: 25-60 + 60-75).
    const clubCalc = async (clubId, label) => {
      const d = (await admin.query(`insert into training_load.metric_definitions (key, label, owner_scope, owner_club_id) values ($1, $2, 'club', $3) returning id`,
        [`calc_2b_${crypto.randomBytes(3).toString("hex")}`, label, clubId])).rows[0].id;
      await admin.query(`insert into training_load.metric_definition_scope_capabilities (metric_definition_id, scope_level) values ($1, 'session')`, [d]);
      const v = (await admin.query(`insert into training_load.metric_definition_versions (metric_definition_id, version_number, unit, value_type, calculation) values ($1, 1, 'm', 'numeric', $2) returning id`,
        [d, JSON.stringify({ kind: "sum", inputs: zoneIds().slice(0, 2) })])).rows[0].id;
      await admin.query(`update training_load.metric_definitions set current_version_id = $1 where id = $2`, [v, d]);
      return String(d);
    };
    const otherClub = (await admin.query(`insert into public.clubs (name) values ($1) returning id`, [`Other club ${key()}`])).rows[0].id;
    const ownCalc = await clubCalc(org.clubId, "AA club high load");
    await clubCalc(otherClub, "AB other club high load");
    const withClub = await buildCandidatePreview(client, { bundle: bundleOf(org), ownerTeamId: org.teamId, performedByUserId: org.userId,
      importPath: { path: "source_connection", bindingId: org.bindingId } });
    const full = withClub.preview.athletes.find((a) => a.gpexeAthleteId === "101").results.find((r) => r.level === "full");
    assert.deepEqual(full.calculated.map((c) => [c.metricDefinitionId, c.value]), [[ownCalc, "360"], [hmld.id, "400"]], "the team's club's own and OptiMove's, never another club's");
    // The club hides HMLD (7i; the row written with the guards off, as the route's own test covers the route).
    await admin.query("begin");
    await admin.query("set local session_replication_role = replica");
    await admin.query(`insert into training_load.metric_definition_club_hides (club_id, metric_definition_id, hidden_by_user_id, hidden_basis, hide_request_key, hide_request_hash)
      values ($1, $2, $3, 'platform_admin', $4, $5)`, [org.clubId, hmld.id, pa, key(), "a".repeat(64)]);
    await admin.query("commit");
    const hidden = await buildCandidatePreview(client, { bundle: bundleOf(org), ownerTeamId: org.teamId, performedByUserId: org.userId,
      importPath: { path: "source_connection", bindingId: org.bindingId } });
    const afterHide = hidden.preview.athletes.flatMap((a) => a.results).flatMap((r) => r.calculated ?? []);
    assert.ok(afterHide.length > 0 && afterHide.every((c) => c.metricDefinitionId === ownCalc), "a hidden calculated variable is not calculated for the club");
    await runImport(org, bundleOf(org));
    assert.ok((await occasions(org.teamId)).every((o) => o.derived.every((d) => d.definition === ownCalc)));
  } finally {
    await client.end();
  }
});
