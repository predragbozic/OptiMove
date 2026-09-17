// The rehearsal of the undo procedure for ONE imported GPEXE session, proven
// on a disposable database: what it removes, what it refuses, that the session
// can be imported again afterwards, and that it will not run anywhere but a
// disposable database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import { collectScope, undoImportedSession, main as undoMain } from "../scripts/gpexe-undo-imported-session.mjs";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let db;
let admin;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undo" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
});

after(async () => {
  if (admin) await admin.end();
  if (db) await db.drop();
});

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Athlete A", "Athlete B", "Athlete C"] });
  return { ...org, athleteMap: { 101: org.athleteIds[0], 102: org.athleteIds[1], 103: org.athleteIds[2] } };
}

async function runImport(org, bundle) {
  const client = await newClient();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundle), {
      ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "undo test",
    });
  } finally {
    await client.end();
  }
}

const COUNTS = {
  events: `select count(*)::int as c from training_load.metric_events where owner_team_id = $1`,
  segments: `select count(*)::int as c from training_load.metric_event_segments s join training_load.metric_events e on e.id = s.event_id where e.owner_team_id = $1`,
  participants: `select count(*)::int as c from training_load.metric_event_participants p join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  bindings: `select count(*)::int as c from training_load.metric_event_source_bindings b join training_load.metric_source_connections c on c.id = b.source_connection_id where c.owner_team_id = $1`,
  identities: `select count(*)::int as c from training_load.metric_source_identities si join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1`,
  occasions: `select count(*)::int as c from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  values: `select count(*)::int as c from training_load.metric_values v join training_load.metric_measurement_occasions o on o.id = v.occasion_id join training_load.metric_event_participants p on p.id = o.event_participant_id join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1`,
  activities: `select count(*)::int as c from training.activities where owner_team_id = $1`,
  components: `select count(*)::int as c from training.activity_components ac join training.activities a on a.id = ac.activity_id where a.owner_team_id = $1`,
  batches: `select count(*)::int as c from training_load.metric_import_batches where owner_team_id = $1`,
  connections: `select count(*)::int as c from training_load.metric_source_connections where owner_team_id = $1`,
  definitions: `select count(*)::int as c from training_load.metric_definitions where owner_team_id = $1`,
};

async function counts(teamId) {
  const out = {};
  for (const [name, sql] of Object.entries(COUNTS)) out[name] = (await admin.query(sql, [teamId])).rows[0].c;
  return out;
}

test("undo: removes exactly the imported session and keeps the connection and the metric catalogue", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6001, athletes: standardAthletes() }));
  const before = await counts(org.teamId);
  assert.deepEqual(
    [before.events, before.participants, before.occasions, before.bindings, before.activities],
    [1, 2, 5, 1, 1],
  );

  const client = await newClient();
  let log;
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.equal(scope.occasionIds.length, 5);
    assert.equal(scope.valueCount, before.values);
    assert.equal(scope.identityIds.length, 6, "five results plus the session reservation");
    assert.equal(scope.manualOccasionIds.length, 0);
    log = await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "wrong session imported", apply: true });
  } finally {
    await client.end();
  }

  const after = await counts(org.teamId);
  assert.deepEqual(
    [after.events, after.segments, after.participants, after.bindings, after.identities, after.occasions, after.values, after.activities, after.components, after.batches],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    JSON.stringify(after),
  );
  assert.equal(after.connections, before.connections, "the GPEXE connection is not session-specific and stays");
  assert.equal(after.definitions, before.definitions, "so do the metric definitions");

  // The log says what was removed, for whom and why.
  assert.equal(log.applied, true);
  assert.equal(log.eventId, summary.eventId);
  assert.equal(log.sourceExternalId, "team_session:6001");
  assert.equal(log.referenceSetExternalId, "1473");
  assert.equal(log.reason, "wrong session imported");
  assert.equal(String(log.performedByUserId), String(org.userId));
  assert.equal(log.removed.metric_values, before.values);
  assert.equal(log.removed.metric_events, 1);

  // The protections are on again afterwards.
  const check = await runImport(org, makeBundle({ sessionId: 6001, athletes: standardAthletes() }));
  assert.deepEqual(check.counts, { created: 5 }, "the session imports again from scratch");
  await assert.rejects(
    admin.query(`delete from training_load.metric_event_source_bindings where event_id = $1`, [check.eventId]),
    /cannot be deleted/,
  );
  await assert.rejects(
    admin.query(`delete from training_load.metric_values v using training_load.metric_measurement_occasions o, training_load.metric_event_participants p
                 where v.occasion_id = o.id and o.event_participant_id = p.id and p.event_id = $1`, [check.eventId]),
    /immutable/,
  );
});

test("undo: a dry run reports the same scope and removes nothing", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6002, athletes: standardAthletes() }));
  const before = await counts(org.teamId);
  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    const log = await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "dry run", apply: false });
    assert.equal(log.applied, false);
    assert.equal(log.removed.metric_events, 1, "the dry run runs the same statements before rolling back");
  } finally {
    await client.end();
  }
  assert.deepEqual(await counts(org.teamId), before, "nothing was removed");
});

test("undo: refuses a session that carries a manual correction", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6003, athletes: standardAthletes() }));
  const identity = (await admin.query(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si
     join training_load.metric_source_connections c on c.id = si.source_connection_id
     where c.owner_team_id = $1 and si.source_external_id = 'athlete_session:600301:full'`,
    [org.teamId],
  )).rows[0];
  const values = (await admin.query(
    `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`,
    [identity.current_occasion_id],
  )).rows.map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));

  process.env.DATABASE_URL = db.url;
  const { correctImportedOccasionManually } = await import("../src/trainingLoadMetricsMeasurements.js");
  const dbModule = await import("../src/db.js");
  try {
    const req = { user: { id: org.userId }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: org.teamId }], managedTeamIds: [] } };
    const scopeCtx = { type: "team", teamId: org.teamId, ownerContext: { ownerScope: "team", ownerTeamId: org.teamId, ownerClubId: null, ownerUserId: null } };
    const manual = await correctImportedOccasionManually(req, scopeCtx, { requestKey: `undo-${org.teamId}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
    assert.equal(manual.error, undefined, JSON.stringify(manual));

    const before = await counts(org.teamId);
    const client = await newClient();
    try {
      const scope = await collectScope(client, { eventId: summary.eventId });
      assert.equal(scope.manualOccasionIds.length, 1);
      await assert.rejects(
        undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "should refuse", apply: true }),
        /corrected manually/,
      );
    } finally {
      await client.end();
    }
    assert.deepEqual(await counts(org.teamId), before);
  } finally {
    await dbModule.pool.end();
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  }
});

test("undo: refuses any database that is not a disposable GPEXE test database", async () => {
  for (const url of [
    "postgresql://u:p@localhost:5432/OPTIMOVE",
    "postgresql://u:p@localhost:5432/monitoring2",
    "postgresql://u:p@db.example.supabase.com:5432/optimove_tests_gpexe_x",
    "postgresql://u:p@localhost:5432/optimove_tests_gpexe_x?host=db.example.supabase.com",
  ]) {
    await assert.rejects(
      undoMain(["--database-url", url, "--team-session", "6004", "--owner-team-id", "00000000-0000-0000-0000-000000000000"]),
      /refusing --apply/,
      url,
    );
  }
});
