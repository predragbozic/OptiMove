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
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [org.userId]);
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

test("undo: a foreign event link added after the scope was collected still stops the run", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6108, athletes: standardAthletes() }));
  const client = await newClient();
  let foreignEventId;
  try {
    // Scope collected while the activity is still this session's alone...
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.equal(scope.otherEventLinks.length, 0);
    // ...then another event is linked to it before the undo starts.
    foreignEventId = await otherEvent(org.teamId, "linked in between");
    await admin.query(
      `insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
       values ($1,$2,'manual','confirmed',$3,now(),$3)`,
      [summary.activityId, foreignEventId, org.userId],
    );
    await assert.rejects(
      undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "stale scope", apply: true }),
      /is also linked to metric event/,
    );
  } finally {
    await client.end();
  }
  const kept = (await admin.query(`select count(*)::int as c from training.activity_metric_event_links where metric_event_id = $1`, [foreignEventId])).rows[0].c;
  assert.equal(kept, 1, "the other event's link survives");
  assert.equal((await rowCounts(org.teamId)).events, 2, "nothing of this session was removed either");
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
    undoMain(["--database-url", db.url, "--team-session", "6104", "--owner-team-id", org.teamId, "--performed-by-user-id", org.userId, "--reason", "undo guard test"]),
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
      undoMain(["--database-url", db.url, "--team-session", "6105", "--owner-team-id", org.teamId, "--performed-by-user-id", org.userId, "--reason", "undo guard test", "--log", logPath]),
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
      undoMain(["--database-url", db.url, "--team-session", "6107", "--owner-team-id", org.teamId, "--performed-by-user-id", org.userId, "--reason", "undo guard test", "--log", logPath]),
      (error) => error.code === "EEXIST",
    );
    assert.deepEqual(JSON.parse(await fsp.readFile(logPath, "utf8")), earlier, "the earlier record is untouched");
  } finally {
    console.log = log;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("undo CLI: a run without a reason or an author, or an applied run without a log, is refused", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6106, athletes: standardAthletes() }));
  const before = await rowCounts(org.teamId);
  for (const extra of [[], ["--reason", "x"], ["--performed-by-user-id", org.userId], ["--apply", "--reason", "x"], ["--apply", "--performed-by-user-id", org.userId]]) {
    await assert.rejects(
      undoMain(["--database-url", db.url, "--team-session", "6106", "--owner-team-id", org.teamId, ...extra]),
      /--reason and --performed-by-user-id \(an active platform admin\) are required/,
      JSON.stringify(extra),
    );
  }
  await assert.rejects(
    undoMain(["--database-url", db.url, "--team-session", "6106", "--owner-team-id", org.teamId, "--apply", "--reason", "x", "--performed-by-user-id", org.userId]),
    /--apply requires --log/,
  );
  assert.deepEqual(await rowCounts(org.teamId), before);
  assert.ok(summary.eventId);
});

async function deletionLog(eventId) {
  return (await admin.query(`select *, occurred_date::text as occurred_day from training_load.import_deletion_log where event_id = $1`, [eventId])).rows;
}

test("undo: only an active platform admin may run it; anyone else is refused before anything is removed", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6201, athletes: standardAthletes() }));
  const coach = (await admin.query(`insert into public.users (email, full_name) values ($1, 'Team coach') returning id`, [`coach-${org.teamId}@example.test`])).rows[0].id;
  const revoked = (await admin.query(`insert into public.users (email, full_name) values ($1, 'Former admin') returning id`, [`former-${org.teamId}@example.test`])).rows[0].id;
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active, revoked_at) values ($1, 'platform_admin', false, now())`, [revoked]);
  const inactive = (await admin.query(`insert into public.users (email, full_name, is_active) values ($1, 'Disabled admin', false) returning id`, [`off-${org.teamId}@example.test`])).rows[0].id;
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [inactive]);
  const before = await rowCounts(org.teamId);

  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    for (const [who, userId] of [["a team coach", coach], ["a revoked admin", revoked], ["a disabled admin account", inactive]]) {
      await assert.rejects(
        undoImportedSession(client, scope, { performedByUserId: userId, reason: "not allowed", apply: true }),
        // The script's own check, before anything is locked; the database
        // check behind it is tested on its own below.
        // (assert.rejects matches a RegExp against String(error), hence "Error: ".)
        /^Error: refusing: user \S+ is not an active platform admin/,
        who,
      );
    }
    await assert.rejects(undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "   ", apply: true }), /a reason is required/);
    await assert.rejects(undoImportedSession(client, scope, { performedByUserId: null, reason: "no author", apply: true }), /must be named/);
  } finally {
    await client.end();
  }
  assert.deepEqual(await rowCounts(org.teamId), before, "nothing was removed");
  assert.equal((await deletionLog(summary.eventId)).length, 0, "and nothing was logged");
});

test("undo: the removal and its database log row commit together, and the row says who, why, what and how much", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6202, athletes: standardAthletes() }));
  const client = await newClient();
  let log;
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    log = await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "  imported the wrong session  ", apply: true });
  } finally {
    await client.end();
  }
  const rows = await deletionLog(summary.eventId);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(String(row.id), String(log.databaseLogId), "the file log names the database row");
  assert.equal(String(row.deleted_by_user_id), String(org.userId));
  assert.equal(row.authorized_via, "platform_admin");
  assert.equal(row.reason, "imported the wrong session", "the reason, trimmed");
  assert.equal(row.source_system, "gpexe");
  assert.equal(row.source_external_id, "team_session:6202");
  assert.equal(String(row.owner_team_id), String(org.teamId));
  assert.equal(row.occurred_day, "2026-09-14");
  assert.equal(row.reference_set_external_id, "1473");
  assert.equal(row.removed_counts.metric_events, 1);
  assert.equal(row.removed_counts.metric_values, log.removed.metric_values);
  assert.equal(row.removed_total, Object.values(row.removed_counts).reduce((a, b) => a + b, 0));
  assert.equal(log.removedTotal, row.removed_total);
  assert.equal((await rowCounts(org.teamId)).events, 0);
});

test("undo: a dry run writes and rolls back the log row, and names no row that does not exist", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6205, athletes: standardAthletes() }));
  const client = await newClient();
  let log;
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    log = await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "dry run", apply: false });
  } finally {
    await client.end();
  }
  assert.equal(log.applied, false);
  assert.ok(log.removedTotal > 0, "the dry run went through the whole removal, log insert included");
  assert.equal(log.databaseLogId, null);
  assert.equal((await deletionLog(summary.eventId)).length, 0);
  assert.equal((await rowCounts(org.teamId)).events, 1);
});

test("undo: a run that fails after the removal leaves neither the removal nor a log row", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6203, athletes: standardAthletes() }));
  const before = await rowCounts(org.teamId);
  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    await assert.rejects(
      undoImportedSession(client, scope, {
        performedByUserId: org.userId, reason: "interrupted after the log row", apply: true,
        onBeforeCommit: async () => { throw new Error("process died before commit"); },
      }),
      /process died before commit/,
    );
  } finally {
    await client.end();
  }
  assert.deepEqual(await rowCounts(org.teamId), before);
  assert.equal((await deletionLog(summary.eventId)).length, 0, "the log row went with the rolled-back removal");
});

test("database: the deletion log is append-only and only records removals that happened, by an active platform admin", async () => {
  const org = await setupTeam();
  const summary = await runImport(org, makeBundle({ sessionId: 6204, athletes: standardAthletes() }));
  const connectionId = summary.connectionId;
  const insertLog = (eventId, userId, extra = {}) => admin.query(
    `insert into training_load.import_deletion_log
       (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id, owner_team_id, occurred_date, removed_counts, removed_total)
     values ($1,'platform_admin',$2,$3,'gpexe',$4,'team_session:x',$5,'2026-09-14',$6,$7)`,
    [userId, extra.reason ?? "because", eventId, connectionId, org.teamId, extra.counts ?? '{"metric_events":1}', extra.total ?? 1],
  );
  // An event that still exists: a log row is a record of a removal, not a plan.
  await assert.rejects(insertLog(summary.eventId, org.userId), /still exists/);
  // A user who is not an active platform admin cannot be recorded as the one
  // who did it: not a coach, not a revoked admin, not a disabled account.
  const coach = (await admin.query(`insert into public.users (email, full_name) values ($1, 'Coach') returning id`, [`c2-${org.teamId}@example.test`])).rows[0].id;
  const revoked = (await admin.query(`insert into public.users (email, full_name) values ($1, 'Revoked') returning id`, [`r2-${org.teamId}@example.test`])).rows[0].id;
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active, revoked_at) values ($1, 'platform_admin', false, now())`, [revoked]);
  const disabled = (await admin.query(`insert into public.users (email, full_name, is_active) values ($1, 'Disabled', false) returning id`, [`d2-${org.teamId}@example.test`])).rows[0].id;
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)`, [disabled]);
  for (const userId of [coach, revoked, disabled]) {
    await assert.rejects(insertLog("00000000-0000-4000-8000-000000000001", userId), (e) => e.code === "42501" && /is not an active platform admin/.test(e.message));
  }
  // Empty reason, empty counts, a non-positive total, another basis: refused by the table itself.
  await assert.rejects(insertLog("00000000-0000-4000-8000-000000000002", org.userId, { reason: " " }), /check constraint/);
  await assert.rejects(insertLog("00000000-0000-4000-8000-000000000003", org.userId, { counts: "{}" }), /check constraint/);
  await assert.rejects(insertLog("00000000-0000-4000-8000-000000000004", org.userId, { total: 0 }), /check constraint/);
  await assert.rejects(
    admin.query(`insert into training_load.import_deletion_log (deleted_by_user_id, authorized_via, reason, event_id, source_system, source_connection_id, source_external_id, owner_team_id, occurred_date, removed_counts, removed_total)
                 values ($1,'team_coach','x','00000000-0000-4000-8000-000000000005','gpexe',$2,'x',$3,'2026-09-14','{"a":1}',1)`, [org.userId, connectionId, org.teamId]),
    /check constraint/,
  );

  // A real row, then: it can be neither changed nor removed.
  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    await undoImportedSession(client, scope, { performedByUserId: org.userId, reason: "append-only check", apply: true });
  } finally {
    await client.end();
  }
  await assert.rejects(admin.query(`update training_load.import_deletion_log set reason = 'rewritten' where event_id = $1`, [summary.eventId]), /append-only/);
  await assert.rejects(admin.query(`delete from training_load.import_deletion_log where event_id = $1`, [summary.eventId]), /append-only/);
  await assert.rejects(admin.query(`truncate training_load.import_deletion_log`), /append-only \(TRUNCATE refused\)/);
  // Nor through a cascade from a table it references: ON DELETE RESTRICT does
  // not apply to TRUNCATE, the trigger does.
  const c = await newClient();
  try {
    await c.query("begin");
    await assert.rejects(c.query(`truncate training_load.metric_source_connections cascade`), /append-only \(TRUNCATE refused\)/);
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
  assert.equal((await deletionLog(summary.eventId))[0].reason, "append-only check");
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
