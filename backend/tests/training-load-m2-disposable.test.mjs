import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";
import { asActor, ROLE_IDS } from "./support/permission-roles-world.mjs";

const ROUTE = "/api/training-load/external-schedules";
const ROLES_API = "/api/organization/roles";
const MANAGE = "load.schedule.manage";
const VIEW = "load.view.team";
const NOT_FOUND = { error: "Schedule not found." };
const DAY = "2026-12-09";
let world;
let actors;
const body = (id, kind = "team", eventName = "M-2 bridge practice") => ({
  eventName, scheduleKind: "one_time", timezone: "UTC", startDate: DAY,
  opensTime: "00:00", closesTime: "23:59", targets: [{ kind, id }],
});
const call = (cookie, path = "", method = "GET", input) => world.api(ROUTE + path, { cookie, method, body: input });
const change = (cookie, path, input) => world.api(ROLES_API + path, {
  cookie, method: "POST", body: { requestKey: newKey(), reason: "M-2 rollout rehearsal", ...input },
});
const checks = (id) => [
  ["PATCH", `/${id}`, { eventName: "M-2 changed" }, 200],
  ["POST", `/${id}/pause`, {}, 200],
  ["POST", `/${id}/resume`, {}, 200],
  ["POST", `/${id}/schedule-again`, { startDate: "2026-12-10" }, 201],
  ["POST", `/${id}/remind`, { assignmentIds: [newKey()] }, 200],
  ["POST", `/${id}/cancel`, {}, 200],
];

async function create(actor, target, kind) {
  const response = await call(actor.cookie, "", "POST", body(target, kind));
  assert.equal(response.status, 201, response.text);
  return response.body.schedules[0].id;
}

async function holding(actor, type, scopeId, word = MANAGE) {
  return (await world.q("select public.user_has_permission($1,$2,$3,$4) as ok", [actor.id, word, type, scopeId]))[0].ok;
}

async function currentRows() {
  return (await world.q(`select
    (select jsonb_agg(to_jsonb(s) order by id) from training_load.external_schedules s) schedules,
    (select jsonb_agg(to_jsonb(t) order by id) from training_load.external_schedule_targets t) targets,
    (select count(*)::int from public.app_notifications) notifications`))[0];
}

// An audited system operation stages a permission change in the database.
// The bridge/old HTTP role editor cannot make this mutation before exposure.
async function narrowTeamRole(clubId, word, client = null) {
  const sql = async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[clubId]]);
    const { rows: [version] } = await tx.query(`insert into public.permission_club_role_versions
      (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
      select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`,
    [clubId, ROLE_IDS.team_coach, actors.roles.platformAdmin.id]);
    await tx.query(`insert into public.permission_club_role_version_items
      select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>$3`,
    [version.id, ROLE_IDS.team_coach, word]);
    await tx.query(`insert into public.permission_club_role_version_changes
      (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
      values ($1,1,'create',$2,'platform_admin','M-2 permission experiment',
        array(select permission_word from public.permission_club_role_version_items where version_id=$1))`,
    [version.id, actors.roles.platformAdmin.id]);
  };
  if (client) await sql(client);
  else await asActor(world.db.url, actors.roles.platformAdmin.id, sql);
}

before(async () => {
  world = await startCalendarApp({ label: "m2_bridge", scheduleBridge: true });
  await world.q(`create table public.app_notifications (
    id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null, actor_user_id uuid,
    type varchar(80) not null, title text not null, body text, entity_type varchar(80), entity_id uuid, href text,
    metadata jsonb not null default '{}'::jsonb, read_at timestamptz, created_at timestamptz not null default now(),
    dedupe_key varchar(300))`);
  actors = await calendarRoleMatrix(world, "M-2");
});
after(async () => { await world?.stop(); });

test("M-2: the staged SQL word and all seven native writes work without exposing it", async () => {
  const { roles, clubs, teams } = actors;
  const { ENFORCED_PERMISSIONS, STORABLE_PERMISSIONS } = await import("../src/permissions.js");
  assert.equal(STORABLE_PERMISSIONS.includes(MANAGE), false);
  assert.equal(Object.hasOwn(ENFORCED_PERMISSIONS, MANAGE), false);
  assert.deepEqual(await world.q("select public.permission_word_honoured($1) as honoured", [MANAGE]), [{ honoured: true }]);

  for (const [actor, scopeType, scopeId] of [[roles.teamCoach, "team", teams.t1], [roles.clubAdmin, "club", clubs.c1]]) {
    const me = await world.api("/api/auth/me", { cookie: actor.cookie });
    assert.ok(me.body.user.permissions.includes(VIEW), me.text);
    assert.ok(!me.body.user.permissions.includes(MANAGE), me.text);
    assert.equal(await holding(actor, scopeType, scopeId), true);
    const id = await create(actor, scopeId, scopeType);
    for (const [method, path, input, good] of checks(id)) {
      const response = await call(actor.cookie, path, method, input);
      assert.equal(response.status, good, `${scopeType} ${method} ${path}: ${response.text}`);
    }
  }
  assert.ok((await world.q("select first_checked_write_at as at from training_load.external_schedule_m2_use"))[0].at);
});

test("M-2: foreign or missing schedule IDs match even while foreign rows are locked", async () => {
  const { roles, teams } = actors;
  const schedule = await create(roles.stranger, teams.u1, "team");
  await world.admin.query("begin");
  try {
    await world.admin.query("select id from training_load.external_schedules where id=$1 for update", [schedule]);
    for (const [method, path, input] of checks(schedule)) {
      const group = Promise.all([
        call(roles.twoClubAdmin.cookie, path, method, input),
        call(roles.twoClubAdmin.cookie, path.replace(schedule, newKey()), method, input),
      ]);
      const [foreign, missing] = await Promise.race([group, delay(4000, null, { ref: false })]) ?? [];
      assert.ok(foreign && missing, `${method} ${path} waited on a foreign schedule`);
      assert.equal(foreign.status, 404, foreign.text);
      assert.deepEqual(foreign.body, NOT_FOUND);
      assert.equal(foreign.text, missing.text);
    }
  } finally { await world.admin.query("rollback"); }
});

test("M-2: all writes refuse a role with View but no Manage, without rows or reminders changing", async () => {
  const { roles, clubs, teams } = actors;
  const id = await create(roles.teamCoach, teams.t1, "team");
  await narrowTeamRole(clubs.c1, MANAGE);
  assert.equal(await holding(roles.teamCoach, "team", teams.t1, VIEW), true);
  assert.equal(await holding(roles.teamCoach, "team", teams.t1), false);
  assert.equal((await call(roles.teamCoach.cookie, `/${id}`)).status, 200);
  const beforeRows = await currentRows();
  for (const [method, path, input] of [["POST", "", body(teams.t1)], ...checks(id)]) {
    const response = await call(roles.teamCoach.cookie, path, method, input);
    assert.equal(response.status, 403, `${method} ${path}: ${response.text}`);
  }
  assert.deepEqual(await currentRows(), beforeRows);
});

test("M-2: losing View while waiting on the ceiling lock refuses before mutation", async () => {
  const club = await world.fx.makeClub("M-2 race club");
  const team = await world.fx.makeTeam(club);
  const coach = await world.fx.coachOf(team);
  const beforeRows = await currentRows();
  const control = new pg.Client({ connectionString: world.db.url });
  await control.connect();
  try {
    await control.query("begin");
    await control.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    await control.query("select set_config('optimove.permission_actor', $1 || ':' || pg_current_xact_id()::text, true)", [actors.roles.platformAdmin.id]);
    const posted = call(coach.cookie, "", "POST", body(team));
    const deadline = Date.now() + 4000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = (await world.q(`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event='advisory'
            and query like 'select public.lock_club_ceiling%'`))[0].n > 0;
      if (!waiting) await delay(20);
    }
    assert.ok(waiting, "the real HTTP transaction reached the ceiling after the old View check");
    await narrowTeamRole(club, VIEW, control);
    await control.query("commit");
    const response = await posted;
    assert.equal(response.status, 403, response.text);
  } finally {
    await control.query("rollback").catch(() => {});
    await control.end();
  }
  assert.equal(await holding(coach, "team", team), true);
  assert.equal(await holding(coach, "team", team, VIEW), false);
  assert.deepEqual(await currentRows(), beforeRows);
});

test("M-2: private ownership, platform ownership and athlete write denial stay distinct", async () => {
  const { roles, athletes } = actors;
  const userSchedule = await create(roles.privateCoach, athletes.ownAthlete.athleteId, "athlete");
  const systemSchedule = await create(roles.platformAdmin, athletes.ownAthlete.athleteId, "athlete");
  assert.deepEqual((await world.q(`select owner_scope from training_load.external_schedules where id=$1 or id=$2 order by 1`, [userSchedule, systemSchedule])).map((r) => r.owner_scope), ["system", "user"]);
  assert.equal((await call(roles.privateCoach.cookie, `/${userSchedule}`, "PATCH", { eventName: "Private own" })).status, 200);
  assert.equal((await call(roles.privateCoach.cookie, `/${systemSchedule}`, "PATCH", { eventName: "Not private" })).status, 404);
  assert.equal((await call(roles.platformAdmin.cookie, `/${userSchedule}`, "PATCH", { eventName: "Platform support" })).status, 200);
  assert.equal((await call(roles.athlete.cookie, `/${userSchedule}`, "PATCH", { eventName: "Athlete staff attempt" })).status, 403);
});

test("M-2: role editing inherits and preserves seeded words but cannot make them editable", async () => {
  const club = await world.fx.makeClub("M-2 role editor");
  const team = await world.fx.makeTeam(club);
  const coach = await world.fx.coachOf(team);
  const cookie = actors.roles.platformAdmin.cookie;
  const id = ROLE_IDS.team_coach;
  const rolePath = `/${id}/change`;
  const info = async () => (await world.q(`select r.revision,array(
    select i.permission_word from public.permission_role_items i where i.role_id=r.id order by 1
  ) as items from public.permission_roles r where r.id=$1`, [id]))[0];
  const original = await info();
  const omission = await change(cookie, rolePath, {
    expectedRevision: original.revision, items: original.items.filter((w) => w !== MANAGE),
  });
  assert.equal(omission.status, 409, omission.text);
  assert.deepEqual(await info(), original);

  const versionPath = `/${id}/clubs/${club}/version`;
  const version = await change(cookie, versionPath, { expectedRevision: null, remove: ["athletes.remove"] });
  assert.equal(version.status, 200, version.text);
  assert.equal(await holding(coach, "team", team), true);
  const remove = await change(cookie, versionPath, { expectedRevision: 1, remove: [MANAGE] });
  assert.equal(remove.status, 409, remove.text);
  const full = await change(cookie, rolePath, {
    expectedRevision: original.revision, items: original.items, description: "Bridge retains the full list",
  });
  assert.equal(full.status, 200, full.text);
  assert.deepEqual((await info()).items, original.items);
  const systemRevision = (await info()).revision;
  const accepted = await change(cookie, versionPath + "/answer", { systemRevision, choice: "accept_default" });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(await holding(coach, "team", team), true);

  const customPath = `/users/${coach.id}/clubs/${club}/custom`;
  const custom = await change(cookie, customPath, {
    roleId: id, scopeType: "team", scopeId: team, expectedRevision: null, remove: ["athletes.remove"],
  });
  assert.equal(custom.status, 200, custom.text);
  const customRefusal = await change(cookie, customPath, {
    roleId: id, scopeType: "team", scopeId: team, expectedRevision: 1, remove: [MANAGE],
  });
  assert.equal(customRefusal.status, 409, customRefusal.text);
  assert.equal(await holding(coach, "team", team), true);
  const [active] = await world.q(`select id from public.permission_custom_roles where user_id=$1 and ended_at is null`, [coach.id]);
  const ended = await change(cookie, `/users/${coach.id}/custom/${active.id}/end`, {});
  assert.equal(ended.status, 200, ended.text);
  assert.equal(await holding(coach, "team", team), true);

  const copied = await change(cookie, `/${id}/copy`, { clubId: club, name: "M-2 own version" });
  assert.equal(copied.status, 200, copied.text);
  assert.ok(!copied.body.role.items.includes(MANAGE), copied.text);
  assert.deepEqual(await info().then((x) => x.items), original.items);
  const add = await change(cookie, `/${copied.body.role.id}/change`, {
    expectedRevision: copied.body.role.revision, items: [...copied.body.role.items, MANAGE],
  });
  assert.equal(add.status, 409, add.text);
});

test("M-2: the real writer locks targets in D45 order without rewriting the submitted set", async () => {
  const { roles, clubs, teams, athletes } = actors;
  const lower = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const teamIds = [teams.t1, teams.t2].sort(lower);
  const athleteIds = [athletes.athlete.athleteId, athletes.athleteU1.athleteId].sort(lower);
  const targets = [
    { kind: "athlete", id: athleteIds[1] },
    { kind: "team", id: teamIds[1] },
    { kind: "club", id: clubs.c1 },
    { kind: "athlete", id: athleteIds[0] },
    { kind: "team", id: teamIds[0] },
  ];
  const observed = [];
  const originalConnect = world.appPool.connect;
  world.appPool.connect = function (...args) {
    if (args.length) return originalConnect.apply(this, args);
    return originalConnect.call(this).then((client) => {
      const originalQuery = client.query;
      const release = client.release;
      client.query = function (sql, params) {
        observed.push({ sql, params });
        return originalQuery.call(this, sql, params);
      };
      client.release = function (...options) {
        client.query = originalQuery;
        return release.apply(this, options);
      };
      return client;
    });
  };
  try {
    const response = await call(roles.platformAdmin.cookie, "", "POST", { ...body(clubs.c1, "club"), targets });
    assert.equal(response.status, 201, response.text);
    const targetLocks = observed.filter(({ sql }) => /from public[.](teams|clubs|athletes) where.*for share$/.test(sql));
    assert.deepEqual(targetLocks.map(({ params }) => params[0]), [...teamIds, clubs.c1, ...athleteIds]);
    const insertOrder = observed.filter(({ sql }) => sql.includes("insert into training_load.external_schedule_targets"));
    assert.deepEqual(insertOrder.map(({ params }) => params[2] ?? params[3] ?? params[4]), targets.map(({id}) => id));

    observed.length = 0;
    await create(roles.teamCoach, teams.t1, "team");
    const order = observed.map(({ sql }) => sql);
    const firstRowLock = order.findIndex((sql) => sql.includes("for share"));
    assert.equal(order[0], "begin");
    assert.match(order[1], /select public[.]lock_club_ceiling/);
    assert.match(order[2], /select public[.]lock_permission_actor/);
    assert.ok(firstRowLock > 2);
    assert.match(order.at(-2), /update training_load[.]external_schedule_m2_use/);
    assert.equal(order.at(-1), "commit");
  } finally {
    world.appPool.connect = originalConnect;
  }
});
