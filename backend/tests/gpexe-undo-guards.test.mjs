// What the undo procedure refuses, and the one end-to-end run through the CLI
// itself. Everything here is on a disposable database that is dropped after
// the run; nothing touches a persistent one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import { collectScope, undoImportedSession, main as undoMain } from "../scripts/gpexe-undo-imported-session.mjs";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes, TZ } from "./_gpexe-fixtures.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

let db;
let admin;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "undoguards" });
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
      ownerTeamId: org.teamId, performedByUserId: org.userId, athleteIdByGpexeId: org.athleteMap, batchFilename: "undo guards",
    });
  } finally {
    await client.end();
  }
}

async function rowCounts(teamId) {
  const r = await admin.query(
    `select (select count(*)::int from training_load.metric_events where owner_team_id = $1) as events,
            (select count(*)::int from training.activities where owner_team_id = $1) as activities,
            (select count(*)::int from training_load.metric_source_identities si
             join training_load.metric_source_connections c on c.id = si.source_connection_id where c.owner_team_id = $1) as identities,
            (select count(*)::int from training_load.metric_values v
             join training_load.metric_measurement_occasions o on o.id = v.occasion_id
             join training_load.metric_event_participants p on p.id = o.event_participant_id
             join training_load.metric_events e on e.id = p.event_id where e.owner_team_id = $1) as values`,
    [teamId],
  );
  return r.rows[0];
}

// A second event of the same team, standing for anything that is not this
// GPEXE session: a CSV upload, a manual day event, another import.
async function otherEvent(teamId, name = "another event") {
  return (await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, event_timezone_snapshot)
     values ($1,'2026-09-14','2026-09-14T18:08:12Z','session','team',$2,$3) returning id`,
    [name, teamId, TZ],
  )).rows[0].id;
}

test("undo: refuses an activity that another event is linked to, even with no participant link", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6101, athletes: standardAthletes() }));
  const foreignEventId = await otherEvent(org.teamId);
  // ensureConfirmedEventLink writes exactly this row on its own, before any
  // participant link exists — which is why counting participants is not enough.
  await admin.query(
    `insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,'manual','confirmed',$3,now(),$3)`,
    [summary.activityId, foreignEventId, org.userId],
  );
  const before = await rowCounts(org.teamId);

  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.equal(scope.otherEventLinks.length, 1);
    await assert.rejects(
      undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "should refuse", apply: true }),
      /is also linked to metric event/,
    );
  } finally {
    await client.end();
  }
  assert.deepEqual(await rowCounts(org.teamId), before, "the other event keeps its activity");
});

test("undo: refuses an activity that was reparented into another one", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6102, athletes: standardAthletes() }));
  const target = (await admin.query(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, started_at, origin, owner_scope, owner_team_id, created_by_user_id)
     values ('training_session','coach plan','2026-09-14',$1,'2026-09-14T18:08:12Z','manual','team',$2,$3) returning id`,
    [TZ, org.teamId, org.userId],
  )).rows[0].id;
  const participantId = (await admin.query(
    `select ap.id from training.activity_participants ap where ap.activity_id = $1 order by ap.id limit 1`,
    [summary.activityId],
  )).rows[0].id;
  // The recorded fact is what the refusal reads. Running the whole sanctioned
  // relink protocol belongs to the activity subsystem's own suite; here the
  // audit row stands for "this activity took part in a reparent".
  await admin.query(
    `insert into training.activity_participant_reparent_log (activity_participant_id, from_activity_id, to_activity_id, component_strategy, reason, performed_by_user_id)
     values ($1,$2,$3,'keep','coach moved it',$4)`,
    [participantId, summary.activityId, target, org.userId],
  );
  const before = await rowCounts(org.teamId);

  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.ok(scope.entangledActivities.length > 0);
    await assert.rejects(
      undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "should refuse", apply: true }),
      /merged, reparented or superseded/,
    );
  } finally {
    await client.end();
  }
  assert.deepEqual(await rowCounts(org.teamId), before);
});

test("undo: removes the session reservation even when the binding is gone", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6103, athletes: standardAthletes() }));
  // An import from before the binding guard existed leaves the event without
  // one; the reservation identity still has to go.
  await admin.query(`alter table training_load.metric_event_source_bindings disable trigger metric_event_source_bindings_no_delete`);
  await admin.query(`delete from training_load.metric_event_source_bindings where event_id = $1`, [summary.eventId]);
  await admin.query(`alter table training_load.metric_event_source_bindings enable trigger metric_event_source_bindings_no_delete`);

  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.equal(scope.binding, null);
    assert.equal(scope.eventExternalId, "team_session:6103");
    assert.equal(scope.identityIds.length, 6, "five results plus the reservation, found through the event itself");
    await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "binding already gone", apply: true });
  } finally {
    await client.end();
  }
  const after = await rowCounts(org.teamId);
  assert.deepEqual([after.events, after.identities, after.values, after.activities], [0, 0, 0, 0]);
});

test("undo: refuses when two gpexe connections carry the same team_session", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 6104, athletes: standardAthletes() }));
  // v20 allows this: the index covers active connections only.
  await admin.query(`update training_load.metric_source_connections set state = 'inactive' where owner_team_id = $1 and source_system = 'gpexe'`, [org.teamId]);
  const second = (await admin.query(
    `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`,
    [org.teamId],
  )).rows[0].id;
  await admin.query(
    `insert into training_load.metric_events
       (event_name, occurred_date, occurred_instant, scope_level, owner_scope, owner_team_id, source_connection_id, source_external_id, event_timezone_snapshot)
     values ('re-imported','2026-09-14','2026-09-14T18:08:12Z','session','team',$1,$2,'team_session:6104',$3)`,
    [org.teamId, second, TZ],
  );
  const before = await rowCounts(org.teamId);
  await assert.rejects(
    undoMain(["--database-url", db.url, "--team-session", "6104", "--owner-team-id", org.teamId]),
    /ambiguous: 2 events/,
  );
  assert.deepEqual(await rowCounts(org.teamId), before);
});

test("undo CLI: an applied run through main() removes the session and writes a committed log", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 6105, athletes: standardAthletes() }));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpexe-undo-cli-"));
  const logPath = path.join(dir, "undo.json");
  const log = console.log;
  console.log = () => {};
  try {
    const result = await undoMain([
      "--database-url", db.url, "--team-session", "6105", "--owner-team-id", org.teamId,
      "--apply", "--performed-by-user-id", org.userId, "--reason", "imported the wrong session", "--log", logPath,
    ]);
    console.log = log;
    assert.equal(result.log.outcome, "committed");
    const written = JSON.parse(await fsp.readFile(logPath, "utf8"));
    assert.equal(written.outcome, "committed");
    assert.equal(written.sourceExternalId, "team_session:6105");
    assert.equal(written.reason, "imported the wrong session");
    assert.equal(written.removed.metric_events, 1);
    const after = await rowCounts(org.teamId);
    assert.deepEqual([after.events, after.activities, after.identities, after.values], [0, 0, 0, 0]);

    // The runbook sends the operator back to this command to check the
    // database; that must not overwrite the record of what was applied.
    await assert.rejects(
      undoMain(["--database-url", db.url, "--team-session", "6105", "--owner-team-id", org.teamId, "--log", logPath]),
      /no imported GPEXE event|EEXIST/,
    );
    assert.equal(JSON.parse(await fsp.readFile(logPath, "utf8")).outcome, "committed", "the applied record survives");
  } finally {
    console.log = log;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("undo CLI: a later run never writes over an existing log file", async () => {
  const org = await setupTeam();
  await runImport(org, makeBundle({ sessionId: 6107, athletes: standardAthletes() }));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gpexe-undo-keep-"));
  const logPath = path.join(dir, "undo.json");
  // The record of an applied run from an earlier session.
  const earlier = { outcome: "committed", eventId: "earlier", removed: { metric_events: 1 } };
  await fsp.writeFile(logPath, JSON.stringify(earlier));
  const log = console.log;
  console.log = () => {};
  try {
    // A dry run for a session that DOES exist would otherwise write here.
    await assert.rejects(
      undoMain(["--database-url", db.url, "--team-session", "6107", "--owner-team-id", org.teamId, "--log", logPath]),
      (error) => error.code === "EEXIST",
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(logPath, "utf8")), earlier, "the earlier record is untouched");
  } finally {
    console.log = log;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("undo CLI: --apply without a log, a reason or an author is refused", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6106, athletes: standardAthletes() }));
  const before = await rowCounts(org.teamId);
  for (const extra of [[], ["--reason", "x"], ["--performed-by-user-id", "00000000-0000-0000-0000-000000000000"]]) {
    await assert.rejects(
      undoMain(["--database-url", db.url, "--team-session", "6106", "--owner-team-id", org.teamId, "--apply", ...extra]),
      /--apply requires --log, --reason and --performed-by-user-id/,
      JSON.stringify(extra),
    );
  }
  assert.deepEqual(await rowCounts(org.teamId), before);
  assert.ok(summary.eventId);
});

test("undo: the exported functions refuse a client connected to a database that is not disposable", async () => {
  // The guard lives in the functions themselves, not only in the CLI wrapper.
  const persistent = new pg.Client({ connectionString: ORIGINAL_DATABASE_URL });
  await persistent.connect();
  try {
    await assert.rejects(
      collectScope(persistent, { eventId: "00000000-0000-0000-0000-000000000000" }),
      /is not a disposable GPEXE test database/,
    );
    await assert.rejects(
      undoImportedSession(persistent, { eventId: "00000000-0000-0000-0000-000000000000", manualOccasionIds: [], activities: [], occasionIds: [], identityIds: [], participantIds: [], segmentIds: [], batchIds: [], binding: null }, { apply: true }),
      /is not a disposable GPEXE test database/,
    );
  } finally {
    await persistent.end();
  }
});
