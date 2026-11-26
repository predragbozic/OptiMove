// Opt-in exact-build M-2 compatibility rehearsal. Both builds run from
// archived commits, using only separately created loopback disposable databases.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { buildDatabase, fixtures, migrationsWithout, ROLE_IDS } from "./support/permission-roles-world.mjs";

const BASE = "202611301000_calendar_v98_manage_permissions.sql";
const MIGRATION = "202612011000_training_load_v99_schedule_manage_bridge.sql";
const OLD = process.env.M2_PREVIOUS_BUILD_SHA;
const BRIDGE = process.env.M2_BRIDGE_BUILD_SHA;
const enabled = Boolean(OLD || BRIDGE);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORD = "load.schedule.manage";
const R = "/api/organization/roles";
const S = "/api/training-load/external-schedules";
const TEAM_COACH = ROLE_IDS.team_coach;
const clubRoles = "/api/organization/roles/clubs/";
const key = () => crypto.randomUUID();

async function launch(databaseUrl, commit) {
  // The existing launcher checks the commit, dependency lock and disposable
  // URL, strips live service environment settings, and owns scratch cleanup.
  const previous = process.env.P1_PREVIOUS_BUILD_SHA;
  try {
    process.env.P1_PREVIOUS_BUILD_SHA = commit;
    const server = await previousDashboardServer(databaseUrl);
    assert.equal(server.commit, commit);
    return server;
  } finally {
    if (previous === undefined) delete process.env.P1_PREVIOUS_BUILD_SHA;
    else process.env.P1_PREVIOUS_BUILD_SHA = previous;
  }
}

async function request(server, who, route, method = "GET", body) {
  const response = await fetch(server.baseUrl + route, {
    method,
    headers: {
      cookie: who.cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  return { status: response.status, raw, data: JSON.parse(raw) };
}

function expect(response, status) {
  assert.equal(response.status, status, response.raw);
  return response.data;
}

async function switchWorkspace(server, user, type, scopeId = null) {
  const state = expect(await request(server, user, "/api/auth/workspace", "PUT", { type, scopeId }), 200);
  assert.equal(state.activeWorkspace.type, type);
  assert.equal(state.activeWorkspace.scopeId ?? null, scopeId);
}

async function makeWorld(client) {
  const { createSession } = await import("../src/auth.js");
  const fixture = fixtures(client);
  const club = await fixture.club("M2 Bridge");
  const team = await fixture.team(club);
  const otherClub = await fixture.club("M2 Outside");
  const otherTeam = await fixture.team(otherClub);
  async function actor(label, grant) {
    const id = await fixture.user(label);
    await grant?.(id);
    return { id, cookie: "optimove_session=" + await createSession(id, client) };
  }
  const pa = await actor("M2 PA", fixture.grantPlatform);
  const admin = await actor("M2 Club", (id) => fixture.grantClub(id, club));
  const coach = await actor("M2 Coach", (id) => fixture.grantTeam(id, team));
  const noRole = await actor("M2 No Role");
  const athlete = await actor("M2 Athlete");
  await fixture.makeAthlete(athlete.id);
  const id = (await client.query("update public.athletes set device_timezone = 'UTC' where user_id=$1 returning id", [athlete.id])).rows[0].id;
  await client.query("insert into public.athlete_memberships (athlete_id,club_id,team_id,membership_type,status) values ($1,$2,$3,'team','active'), ($1,$2,null,'club','active')", [id, club, team]);
  return { club, team, otherClub, otherTeam, pa, admin, coach, noRole, athlete, athleteId: id };
}

function roleCalls(server, world) {
  const versionPath = R + "/" + TEAM_COACH + "/clubs/" + world.club + "/version";
  const customPath = R + "/users/" + world.coach.id + "/clubs/" + world.club + "/custom";
  const post = (actor, route, body, requestKey = key()) =>
    request(server, actor, route, "POST", { requestKey, reason: "M2 rehearsal", ...body });
  return {
    post,
    change: (body, requestKey) => post(world.pa, R + "/" + TEAM_COACH + "/change", body, requestKey),
    version: (body, requestKey) => post(world.admin, versionPath, body, requestKey),
    answer: (body) => post(world.admin, versionPath + "/answer", body),
    custom: (body, requestKey) => post(world.admin, customPath, { roleId: TEAM_COACH, scopeType: "team", scopeId: world.team, ...body }, requestKey),
    end: (customId) => post(world.admin, R + "/users/" + world.coach.id + "/custom/" + customId + "/end", {}),
  };
}

async function effective(client, userId, scope, scopeId) {
  return (await client.query("select public.user_has_permission($1,$2,$3,$4) as held", [userId, WORD, scope, scopeId])).rows[0].held;
}

async function roleSnapshot(client) {
  return (await client.query(
    "select (select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_roles r) as roles, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_club_role_versions r) as versions, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_custom_roles r) as customs, " +
    "(select jsonb_agg(to_jsonb(r) order by r.role_id,r.permission_word) from public.permission_role_items r) as role_items, " +
    "(select jsonb_agg(to_jsonb(r) order by r.version_id,r.permission_word) from public.permission_club_role_version_items r) as version_items, " +
    "(select jsonb_agg(to_jsonb(r) order by r.custom_role_id,r.permission_word) from public.permission_custom_role_items r) as custom_items, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_role_changes r) as role_audits, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_club_role_version_changes r) as version_audits, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_custom_role_changes r) as custom_audits, " +
    "(select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_requests r) as receipts",
  )).rows[0];
}

async function applyExactMigration(db, client) {
  const blob = execFileSync("git", ["show", BRIDGE + ":migrations_v2/" + MIGRATION], {
    cwd: ROOT, windowsHide: true,
  });
  const checksum = crypto.createHash("sha256").update(blob).digest("hex");
  const staged = migrationsWithout([], BASE);
  try {
    fs.writeFileSync(path.join(staged.dir, MIGRATION), blob);
    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
  } finally {
    staged.cleanup();
  }
  const records = await client.query("select checksum from public.schema_migrations where migration_name=$1", ["migrations_v2/" + MIGRATION]);
  assert.deepEqual(records.rows.map((row) => row.checksum), [checksum]);
  return checksum;
}

async function assertSeedAudit(client, original) {
  const migration = "migrations_v2/" + MIGRATION;
  for (const [table, ownerColumn, ids] of [
    ["permission_role_changes", "role_id", [ROLE_IDS.club_admin, TEAM_COACH]],
    ["permission_club_role_version_changes", "version_id", [original.version.id]],
    ["permission_custom_role_changes", "custom_role_id", [original.custom.id]],
  ]) {
    const audit = await client.query(
      "select " + ownerColumn + " as owner, kind, items_added from public." + table + " where migration_name=$1 order by owner",
      [migration],
    );
    assert.deepEqual(audit.rows, [...ids].sort().map((owner) => ({ owner, kind: "migration", items_added: [WORD] })));
  }
}

async function exerciseRolePolicy(server, client, world, original) {
  const calls = roleCalls(server, world);
  const inventory = (await client.query(
    "select r.revision, array_agg(i.permission_word order by i.permission_word) as items " +
    "from public.permission_roles r join public.permission_role_items i on i.role_id=r.id where r.id=$1 group by r.id",
    [TEAM_COACH],
  )).rows[0];
  assert.ok(inventory.items.includes(WORD));
  assert.equal(await effective(client, world.admin.id, "club", world.club), true);
  assert.equal(await effective(client, world.coach.id, "team", world.team), true);
  for (const actor of [world.admin, world.coach]) {
    const { user } = expect(await request(server, actor, "/api/auth/me"), 200);
    assert.equal(user.permissionsUnavailable, false);
    assert.ok(user.permissions.includes("load.view.team"));
    assert.ok(!user.permissions.includes(WORD), "native navigational inventory must not expose staged word");
  }

  const base = await roleSnapshot(client);
  for (const [label, action] of [
    ["default full-list omission", () => calls.change({ expectedRevision: inventory.revision, items: inventory.items.filter((item) => item !== WORD) })],
    ["club-role add", () => calls.post(world.admin, R, { clubId: world.club, scopeTypes: ["team"], name: "M2 forbidden role", items: ["org.view", WORD] })],
    ["version remove", () => calls.version({ expectedRevision: original.version.revision + 1, remove: [WORD] })],
    ["custom remove", () => calls.custom({ expectedRevision: original.custom.revision + 1, remove: [WORD] })],
    ["bulk custom removal", () => calls.post(world.admin, R + "/" + TEAM_COACH + "/clubs/" + world.club + "/custom-word-removal", { word: WORD, customIds: [original.custom.id] })],
  ]) {
    const response = await action();
    assert.equal(response.status, 409, label + ": " + response.raw);
    assert.match(response.data.error, /^permission_not_(available_yet|honoured)$/, label);
    assert.deepEqual(await roleSnapshot(client), base, label + " must change no row or receipt");
  }

  const copy = expect(await calls.post(world.admin, R + "/" + TEAM_COACH + "/copy", {
    clubId: world.club, name: "M2 independent copy",
  }), 200);
  assert.ok(!copy.role.items.includes(WORD));
  assert.ok(copy.dropped.some((item) => item.word === WORD));
  assert.ok(!(await client.query("select 1 from public.permission_role_items where role_id=$1 and permission_word=$2", [copy.role.id, WORD])).rowCount);

  const edited = expect(await calls.change({
    expectedRevision: inventory.revision,
    items: inventory.items.filter((item) => item !== "athletes.manage"),
  }), 200).role;
  assert.ok(edited.items.includes(WORD), "unrelated full-list edits preserve staged word");
  const club = expect(await request(server, world.admin, clubRoles + world.club + "/roles"), 200);
  const pending = club.systemRoles.find((role) => role.roleId === TEAM_COACH);
  assert.equal(pending.state, "question_pending");
  assert.deepEqual(pending.question.defaultChanges, { added: [], removed: ["athletes.manage"] });

  const accepted = expect(await calls.answer({ systemRevision: edited.revision, choice: "accept_default" }), 200).role;
  assert.equal(accepted.state, "follows_default");
  assert.equal(await effective(client, world.coach.id, "team", world.team), true);

  const ended = expect(await calls.end(original.custom.id), 200).custom;
  assert.equal(ended.endKind, "reassigned");
  assert.equal(await effective(client, world.coach.id, "team", world.team), true);
  const nextVersion = expect(await calls.version({ expectedRevision: null, remove: ["athletes.remove"] }), 200).role;
  assert.ok(nextVersion.effectiveItems.includes(WORD));
  const nextCustom = expect(await calls.custom({ expectedRevision: null, add: ["athletes.remove"] }), 200).custom;
  assert.ok((await client.query("select 1 from public.permission_custom_role_items where custom_role_id=$1 and permission_word=$2", [nextCustom.id, WORD])).rowCount);
  assert.equal(await effective(client, world.coach.id, "team", world.team), true);
}

async function exerciseSchedules(server, client, world, writer, scopeType) {
  // A UTC offset that puts the local clock near noon avoids a 23:59 endpoint race.
  const offset = (12 - new Date().getUTCHours() + 36) % 24 - 12;
  const timezone = offset === 0 ? "UTC" : "Etc/GMT" + (offset > 0 ? "-" : "+") + Math.abs(offset);
  const day = new Date(Date.now() + offset * 3600000).toISOString().slice(0, 10);
  await client.query("update public.athletes set device_timezone=$1 where id=$2", [timezone, world.athleteId]);
  const payload = {
    eventName: "M2 role rollout", scheduleKind: "one_time", timezone, startDate: day,
    opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "athlete", id: world.athleteId }],
  };
  const created = expect(await request(server, writer, S, "POST", payload), 201).schedules[0];
  const route = S + "/" + created.id;
  const storedOwner = (await client.query("select owner_scope, owner_team_id, owner_club_id from training_load.external_schedules where id=$1", [created.id])).rows[0];
  assert.deepEqual(storedOwner, { owner_scope: scopeType, owner_team_id: scopeType === "team" ? world.team : null, owner_club_id: scopeType === "club" ? world.club : null });
  const updated = expect(await request(server, writer, route, "PATCH", { eventName: "M2 edited" }), 200).schedule;
  assert.equal(updated.eventName, "M2 edited");
  assert.equal(expect(await request(server, writer, route + "/pause", "POST"), 200).schedule.status, "paused");
  assert.equal(expect(await request(server, writer, route + "/resume", "POST"), 200).schedule.status, "active");
  const next = new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
  const again = expect(await request(server, writer, route + "/schedule-again", "POST", { startDate: next }), 201).schedule;
  assert.notEqual(again.id, created.id);
  assert.equal(again.eventName, "M2 edited");
  const today = expect(await request(server, world.athlete, "/api/training-load/athlete/today"), 200);
  const pending = await client.query(
    "select a.id from training_load.external_assignments a join training_load.external_schedule_occurrences o on o.id=a.occurrence_id " +
    "where o.schedule_id=$1 and a.athlete_id=$2",
    [created.id, world.athleteId],
  );
  assert.equal(pending.rowCount, 1, "Athlete Home materializes exactly one assignment for this schedule");
  const assignment = today.sessions.find((row) => row.externalAssignmentId === pending.rows[0].id);
  assert.ok(assignment, "the materialized assignment appears in Athlete Home");
  const reminders = { assignmentIds: [assignment.externalAssignmentId] };
  assert.equal(expect(await request(server, writer, route + "/remind", "POST", reminders), 200).notifiedCount, 1);
  assert.equal(expect(await request(server, writer, route + "/remind", "POST", reminders), 200).results[0].outcome, "skippedCooldown");
  const notices = await client.query("select recipient_user_id from public.app_notifications where entity_type='training_load_external_assignment' and type='training_load_manual_reminder' and entity_id=$1", [assignment.externalAssignmentId]);
  assert.deepEqual(notices.rows, [{ recipient_user_id: world.athlete.id }]);
  expect(await request(server, world.athlete, "/api/training-load/external-assignments/" + assignment.externalAssignmentId + "/rpe", "POST", { rpe: 5, durationMinutes: 30 }), 201);
  assert.equal(expect(await request(server, writer, route + "/cancel", "POST"), 200).schedule.status, "cancelled");
  const denied = await request(server, world.noRole, S, "POST", payload);
  assert.equal(denied.status, 403, denied.raw);
}

for (const phase of ["previous", "bridge"]) {
  test("M2 exact " + phase + " build on v99 keeps seeded writers and freezes role policy", {
    skip: enabled ? false : "Set M2_PREVIOUS_BUILD_SHA and M2_BRIDGE_BUILD_SHA for the exact-build rehearsal.",
    timeout: 180000,
  }, async (t) => {
    assert.match(OLD || "", /^[0-9a-f]{40}$/);
    assert.match(BRIDGE || "", /^[0-9a-f]{40}$/);
    assert.notEqual(OLD, BRIDGE);
    const db = await buildDatabase({ label: "m2_" + phase, upTo: BASE });
    const client = new pg.Client({ connectionString: db.url });
    let server;
    try {
      await client.connect();
      const world = await makeWorld(client);
      server = await launch(db.url, OLD);
      await switchWorkspace(server, world.admin, "club", world.club);
      await switchWorkspace(server, world.coach, "team", world.team);
      await switchWorkspace(server, world.pa, "platform");
      const calls = roleCalls(server, world);
      const version = expect(await calls.version({ expectedRevision: null, remove: ["athletes.remove"] }), 200).role.version;
      const custom = expect(await calls.custom({ expectedRevision: null, remove: ["org.view"] }), 200).custom;
      const checksum = await applyExactMigration(db, client);
      await assertSeedAudit(client, { version, custom });
      if (phase === "bridge") {
        await server.stop();
        server = await launch(db.url, BRIDGE);
      }
      t.diagnostic("previous=" + OLD + " bridge=" + BRIDGE + " v99_sha256=" + checksum);
      await exerciseRolePolicy(server, client, world, { version, custom });
      await exerciseSchedules(server, client, world, world.coach, "team");
      await exerciseSchedules(server, client, world, world.admin, "club");
    } finally {
      try {
        await server?.stop();
      } finally {
        try { await client.end(); } finally { await db.drop(); }
      }
    }
  });
}
