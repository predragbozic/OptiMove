import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL, addMediaSelectionFixture } from "./support/exercise-collections-fixture.mjs";

const coachId = crypto.randomUUID();
const otherCoachId = crypto.randomUUID();
const athleteUserId = crypto.randomUUID();
let database;
let client;
let pool;
let server;
let baseUrl;
let sectionId;
let foreignSectionId;
const exercises = {};

before(async () => {
  database = await createDisposableDatabase({ prefix: "builder_exercise_access", label: "primary" });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name);
  await client.query(`
    create schema plans;
    create schema library;
    create table public.users (id uuid primary key, is_active boolean default true, display_name text, full_name text, email text);
    create table public.user_global_roles (id uuid primary key default gen_random_uuid(), user_id uuid, role text, is_active boolean);
    create table public.athletes (
      id uuid primary key, user_id uuid, athlete_id text, source_external_id text,
      display_name text, full_name text, first_name text, last_name text,
      is_active boolean default true, created_at timestamptz default now()
    );
    create table public.user_athletes (user_id uuid, athlete_id uuid, is_active boolean, relationship_type text);
    create table public.user_team_roles (user_id uuid, team_id uuid, is_active boolean);
    create table public.user_club_roles (user_id uuid, club_id uuid, is_active boolean);
    create table public.athlete_memberships (athlete_id uuid, team_id uuid, club_id uuid, membership_type text, status text);
    create table plans.plans (
      id uuid primary key default gen_random_uuid(), created_by_user_id uuid,
      plan_type text default 'program', week_start date, name text, note text, icon_url text,
      color text, cover_image_url text, visibility text default 'private', is_template boolean default true,
      status text default 'draft', source_type text default 'builder', start_date date, duration_days integer,
      athlete_id uuid, is_edit_draft boolean default false, edit_source_plan_id uuid, builder_batch_id uuid,
      track_training_load_default boolean default false, request_rpe_default boolean default false,
      is_active boolean default true, can_copy boolean default true, can_edit_copy boolean default true,
      can_assign_to_athlete boolean default true, library_scope text default 'my',
      is_free boolean default true, price_cents integer, athlete_can_view_directly boolean default false,
      requires_approval boolean default false, access_model text default 'free_forever', access_duration_days integer,
      subscription_period text, owner_type text, library_category text, available_until date,
      created_at timestamptz default now(), updated_at timestamptz default now()
    );
    create table plans.plan_days (
      id uuid primary key default gen_random_uuid(), plan_id uuid references plans.plans(id),
      block_index integer default 1, block_name text, block_type text, date date, day_order numeric,
      day_note text, block_order numeric
    );
    create table plans.plan_sessions (
      id uuid primary key default gen_random_uuid(), plan_day_id uuid references plans.plan_days(id),
      am_pm text, bta text, session_time time, session_order numeric, name text,
      rpe_enabled boolean default false, training_load_enabled boolean default false,
      logical_session_id uuid default gen_random_uuid()
    );
    create table plans.plan_nodes (
      id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id),
      parent_id uuid, node_type text default 'section', name text default 'Exercises', color text,
      icon_url text, short_note text, note text, node_order numeric default 1
    );
    create table library.exercises (
      id uuid primary key default gen_random_uuid(), name text, owner_scope text, owner_user_id uuid,
      is_active boolean default true, aim text, execution_notes text, instruction text, image_url text, video_url text,
      exercise_code text,slug text,created_by_user_id uuid,updated_at timestamptz default now()
    );
    create table plans.plan_items (
      id uuid primary key default gen_random_uuid(), plan_session_id uuid references plans.plan_sessions(id),
      plan_node_id uuid references plans.plan_nodes(id), item_type text, exercise_id uuid references library.exercises(id),
      title text, description text, short_note text, note text, source_row_ref text,
      image_url text, video_url text, sets text, reps text, load text, updated_at timestamptz default now(),
      item_order numeric, exercise_order numeric,
      ${["domain", "category", "section"].flatMap((level) => [
        `${level}_name text`, `${level}_color text`, `${level}_icon_url text`,
        `${level}_short_note text`, `${level}_note text`, `${level}_order numeric`,
      ]).join(", ")}
    );
  `);
  await client.query(`
    create table public.athlete_library_access (
      athlete_id uuid,
      ${["can_view_coach_library","can_view_team_library","can_view_club_library","can_view_optimove_library",
        "can_view_marketplace","can_view_coach_profiles","can_view_club_coach_profiles","can_view_public_coach_profiles",
        "can_contact_visible_coaches","can_view_assigned_exercises","can_view_coach_exercise_library",
        "can_view_team_exercise_library","can_view_club_exercise_library","can_view_optimove_exercise_library",
        "can_view_exercise_groups","free_only","require_approval","selected_programs_only"].map((field) => field + " boolean").join(",")}
    );
    create table library.program_access (
      id uuid primary key default gen_random_uuid(), plan_id uuid, related_plan_id uuid, user_id uuid, access_type varchar,
      status varchar, expires_at timestamptz, starts_at timestamptz, source text, license_snapshot jsonb,
      accessed_at timestamptz, used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique(plan_id,user_id,access_type)
    );
    create table library.program_usage_events (program_access_id uuid,user_id uuid,event_type varchar,note text);
    create table public.builder_assignment_requests (id uuid primary key,user_id uuid,source_plan_id uuid,payload_key text,
      status text default 'pending',result jsonb,updated_at timestamptz default now());
    create table public.app_notifications (
      id uuid primary key default gen_random_uuid(), recipient_user_id uuid,actor_user_id uuid,type text,title text,body text,
      entity_type text,entity_id uuid,metadata jsonb,dedupe_key text,href text,read_at timestamptz,created_at timestamptz default now()
    );
    create unique index notification_dedupe on public.app_notifications(dedupe_key) where dedupe_key is not null;
    create view plans.v_plan_summary as select p.*,p.id as plan_id from plans.plans p;
    create view plans.v_program_plan_items as
      select p.id as plan_id, day.block_index, day.id as plan_block_id, day.block_name,
        session.id as plan_session_id, session.session_order, item.id as plan_item_id,
        item.title,item.description,item.sets,item.reps,item.load,item.item_order,item.exercise_id
      from plans.plans p join plans.plan_days day on day.plan_id=p.id
      join plans.plan_sessions session on session.plan_day_id=day.id
      join plans.plan_items item on item.plan_session_id=session.id;
  `);
  await client.query("insert into public.users (id) values ($1),($2),($3)", [coachId, otherCoachId, athleteUserId]);
  await client.query(EXERCISE_COLLECTIONS_FIXTURE_SQL);
  await addMediaSelectionFixture(client.query.bind(client));
  await client.query("insert into public.user_global_roles (user_id,role,is_active) values ($1,'platform_admin',true)", [otherCoachId]);
  for (const [key, ownerScope, ownerId, active] of [
    ["own", "user", coachId, true],
    ["foreign", "user", otherCoachId, true],
    ["system", "system", null, true],
    ["inactive", "user", coachId, false],
    ["inactiveSystem", "system", null, false],
  ]) {
    const result = await client.query(
      `insert into library.exercises (name, owner_scope, owner_user_id, is_active, instruction, image_url)
       values ($1,$2,$3,$4,'Original instruction','https://example.com/exercise.png') returning id`,
      [key, ownerScope, ownerId, active],
    );
    exercises[key] = result.rows[0].id;
  }
  sectionId = await makeSection(coachId);
  foreignSectionId = await makeSection(otherCoachId);
  process.env.DATABASE_URL = database.url;
  ({ pool } = await import("../src/db.js"));
  const { default: builderRouter } = await import("../src/routes/builder.js");
  const { default: collectionsRouter } = await import("../src/routes/exerciseCollections.js");
  const { default: exercisesRouter } = await import("../src/routes/exercises.js");
  const { default: templatesRouter } = await import("../src/routes/templates.js");
  const { default: plansRouter } = await import("../src/routes/plans.js");
  const { default: organizationRouter } = await import("../src/routes/organization.js");
  const app = express();
  app.use(express.json());
  app.use("/api/builder", (req, res, next) => {
    req.user = { id: coachId };
    req.authz = { platformRoles: [] };
    next();
  }, builderRouter);
  app.use("/api/exercise-collections", (req, res, next) => {
    req.user = { id: otherCoachId };
    req.authz = { platformRoles: ["platform_admin"] };
    next();
  }, collectionsRouter);
  app.use(["/api/templates", "/api/plans", "/api/organization"], (req, res, next) => {
    const athlete = req.headers["x-test-athlete"] === "true";
    req.user = { id: athlete ? athleteUserId : coachId };
    req.authz = { platformRoles: [], clubRoles: [], teamRoles: [], managedTeamIds: [], isAthlete: athlete, capabilities: { coachWorkspace: !athlete } };
    next();
  });
  app.use("/api/templates", templatesRouter);
  app.use("/api/exercises", (req, res, next) => { req.user = { id: coachId }; req.authz = { platformRoles: [] }; next(); }, exercisesRouter);
  app.use("/api/plans", plansRouter);
  app.use("/api/organization", organizationRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } finally {
    try { await pool?.end(); }
    finally {
      try { await client?.end(); }
      finally { await database?.drop(); }
    }
  }
});

beforeEach(async () => client.query("delete from plans.plan_items"));

async function makeSection(ownerId) {
  const plan = await client.query("insert into plans.plans (created_by_user_id, name) values ($1,'Access test') returning id", [ownerId]);
  const day = await client.query("insert into plans.plan_days (plan_id) values ($1) returning id", [plan.rows[0].id]);
  const session = await client.query("insert into plans.plan_sessions (plan_day_id) values ($1) returning id", [day.rows[0].id]);
  return (await client.query("insert into plans.plan_nodes (plan_session_id) values ($1) returning id", [session.rows[0].id])).rows[0].id;
}

async function addExercise(exerciseId, extra = {}, targetSectionId = sectionId) {
  const response = await fetch(`${baseUrl}/api/builder/nodes/${targetSectionId}/exercises`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exerciseId, sets: "3", reps: "8", load: "20 kg", ...extra }),
  });
  return { status: response.status, body: await response.json() };
}

async function itemCount() {
  return (await client.query("select count(*)::integer as count from plans.plan_items")).rows[0].count;
}

test("archiving a referenced exercise preserves existing program API rows, snapshots and references", async () => {
  const section = await makeSection(coachId);
  const source = (await client.query("insert into library.exercises (name,owner_scope,owner_user_id,is_active,image_url) values ('Archive referenced','user',$1,true,'https://saved.test/image') returning id", [coachId])).rows[0].id;
  assert.equal((await addExercise(source, {}, section)).status, 201);
  const plan = (await client.query(`select day.plan_id from plans.plan_nodes node join plans.plan_sessions session on session.id=node.plan_session_id
    join plans.plan_days day on day.id=session.plan_day_id where node.id=$1`, [section])).rows[0].plan_id;
  const before = await request(`/api/plans/${plan}/program`, null, { method: "GET" });
  assert.equal(before.status, 200);
  const snapshots = (await client.query("select * from plans.plan_items where exercise_id=$1", [source])).rows;
  const archived = await request(`/api/exercises/${source}/archive`, {});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  assert.deepEqual((await request(`/api/plans/${plan}/program`, null, { method: "GET" })).body, before.body);
  assert.deepEqual((await client.query("select * from plans.plan_items where exercise_id=$1", [source])).rows, snapshots);
  assert.equal((await addExercise(source, {}, section)).status, 404);
  assert.equal((await request(`/api/exercises/${source}/restore`, {})).status, 200);
  assert.equal((await addExercise(source, {}, section)).status, 201);
});

test("foreign private and nonexistent exercises return the identical 404 and create no item", async () => {
  const missing = await addExercise(crypto.randomUUID());
  const foreign = await addExercise(exercises.foreign);
  assert.deepEqual(foreign, missing);
  assert.equal(foreign.status, 404);
  assert.equal(await itemCount(), 0);
});

test("payload owner fields cannot authorize a foreign private exercise", async () => {
  const response = await addExercise(exercises.foreign, { userId: otherCoachId, ownerUserId: otherCoachId, ownerScope: "system" });
  assert.equal(response.status, 404);
  assert.equal(await itemCount(), 0);
});

for (const key of ["own", "system"]) {
  test(`an active ${key} exercise can be added repeatedly with independent dose and media snapshots`, async () => {
    assert.equal((await addExercise(exercises[key])).status, 201);
    assert.equal((await addExercise(exercises[key], { sets: "5" })).status, 201);
    const items = (await client.query("select * from plans.plan_items order by item_order")).rows;
    assert.equal(items.length, 2);
    assert.notEqual(items[0].id, items[1].id);
    assert.deepEqual(items.map((item) => item.sets), ["3", "5"]);
    assert.equal(items[0].exercise_id, exercises[key]);
    assert.equal(items[0].description, "Original instruction");
    assert.equal(items[0].image_url, "https://example.com/exercise.png");
  });
}

test("Builder snapshots inherited media for an authorized copy without changing its Library fields", async () => {
  const original = (await client.query(`insert into library.exercises(name,owner_scope,image_url,video_url)
    values('Snapshot media original','system','https://example.com/inherited.png','https://example.com/inherited.mp4') returning id`)).rows[0].id;
  const copy = (await client.query(`insert into library.exercises(name,owner_scope,owner_user_id,source_exercise_id)
    values('Snapshot media copy','user',$1,$2) returning id`, [coachId, original])).rows[0].id;
  const response = await addExercise(copy);
  assert.equal(response.status, 201);
  const snapshot = (await client.query("select image_url,video_url from plans.plan_items where exercise_id=$1", [copy])).rows[0];
  assert.deepEqual(snapshot, { image_url: "https://example.com/inherited.png", video_url: "https://example.com/inherited.mp4" });
  assert.deepEqual((await client.query("select image_url,video_url from library.exercises where id=$1", [copy])).rows[0],
    { image_url: null, video_url: null });
});

for (const key of ["inactive", "inactiveSystem"]) {
  test(`an ${key} exercise cannot be added and creates no item`, async () => {
    assert.equal((await addExercise(exercises[key])).status, 404);
    assert.equal(await itemCount(), 0);
  });
}

test("access to a system exercise does not grant access to another coach's target section", async () => {
  assert.equal((await addExercise(exercises.system, {}, foreignSectionId)).status, 404);
  assert.equal(await itemCount(), 0);
});

test("Builder follows block grants for the system original and its owner's personal copy", async () => {
  const collection = (await client.query("insert into library.exercise_collections (name,created_by_user_id) values ('Restricted',$1) returning id", [otherCoachId])).rows[0].id;
  await client.query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)", [collection, exercises.system]);
  const copyId = (await client.query("insert into library.exercises (name,owner_scope,owner_user_id,source_exercise_id) values ('Private copy','user',$1,$2) returning id", [coachId, exercises.system])).rows[0].id;
  for (const exerciseId of [exercises.system, copyId]) assert.equal((await addExercise(exerciseId)).status, 404);
  assert.equal(await itemCount(), 0);
  await client.query("insert into library.exercise_collection_users (collection_id,user_id) values ($1,$2)", [collection, coachId]);
  for (const exerciseId of [exercises.system, copyId]) assert.equal((await addExercise(exerciseId)).status, 201);
  await client.query("delete from library.exercise_collection_users where collection_id=$1", [collection]);
  for (const exerciseId of [exercises.system, copyId]) assert.equal((await addExercise(exerciseId)).status, 404);
  assert.equal(await itemCount(), 2);
});

async function makeGrantedExercise() {
  const exerciseId = (await client.query("insert into library.exercises (name,owner_scope) values ('Race source','system') returning id")).rows[0].id;
  const collectionId = (await client.query("insert into library.exercise_collections (name,created_by_user_id) values ('Race block',$1) returning id", [otherCoachId])).rows[0].id;
  await client.query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)", [collectionId, exerciseId]);
  await client.query("insert into library.exercise_collection_users (collection_id,user_id) values ($1,$2)", [collectionId, coachId]);
  return { exerciseId, collectionId };
}

async function revokeAccess({ exerciseId, collectionId }) {
  const response = await fetch(`${baseUrl}/api/exercise-collections/${collectionId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Race block", exerciseIds: [exerciseId], userIds: [], expectedRevision: 1 }),
  });
  return { status: response.status, body: await response.json() };
}

async function waitForBlockedQuery(fragment) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const result = await client.query(`select pid from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid()
        and state = 'active' and wait_event_type = 'Lock' and position($1 in query) > 0`, [fragment]);
    if (result.rowCount) return result.rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No blocked database connection for ${fragment}`);
}

test("Builder add before revoke commits its authorized snapshot before revoke can complete", async () => {
  const fixture = await makeGrantedExercise();
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let add;
  let revoke;
  try {
    await blocker.query("begin");
    await blocker.query("lock table plans.plan_items in share mode");
    add = addExercise(fixture.exerciseId);
    const addPid = await waitForBlockedQuery("insert into plans.plan_items");
    revoke = revokeAccess(fixture);
    const revokePid = await waitForBlockedQuery("pg_advisory_xact_lock(");
    assert.notEqual(addPid, revokePid);
    const locks = await client.query("select pid,granted from pg_locks where locktype='advisory' and pid=any($1::integer[])", [[addPid, revokePid]]);
    assert.equal(locks.rows.find((lock) => lock.pid === addPid)?.granted, true);
    assert.equal(locks.rows.find((lock) => lock.pid === revokePid)?.granted, false);
    await blocker.query("commit");
    assert.equal((await add).status, 201);
    assert.equal((await revoke).status, 200);
    assert.equal(await itemCount(), 1);
    assert.equal((await addExercise(fixture.exerciseId)).status, 404);
    assert.equal(await itemCount(), 1);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([add, revoke].filter(Boolean));
  }
});

test("revoke before Builder add makes the waiting add recheck access after revoke commits", async () => {
  const fixture = await makeGrantedExercise();
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let add;
  let revoke;
  try {
    await blocker.query("begin");
    await blocker.query("lock table library.exercise_collection_audit in share mode");
    revoke = revokeAccess(fixture);
    const revokePid = await waitForBlockedQuery("insert into library.exercise_collection_audit");
    add = addExercise(fixture.exerciseId);
    const addPid = await waitForBlockedQuery("pg_advisory_xact_lock_shared(");
    assert.notEqual(addPid, revokePid);
    await blocker.query("commit");
    assert.equal((await revoke).status, 200);
    assert.equal((await add).status, 404);
    assert.equal(await itemCount(), 0);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([add, revoke].filter(Boolean));
  }
});

// The account-side routes (PUT /api/exercise-collections/user-grants) change
// the same grant rows under the same block lock as the editor's PATCH, so
// the Builder gets the same guarantees from them.
async function changeGrants(body) {
  const response = await fetch(`${baseUrl}/api/exercise-collections/user-grants`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("a grant and its removal from the account's side rule the Builder: no new use after the removal, the existing item stays", async () => {
  const exerciseId = (await client.query("insert into library.exercises (name,owner_scope) values ('Account-side source','system') returning id")).rows[0].id;
  const collectionId = (await client.query("insert into library.exercise_collections (name,created_by_user_id) values ('Account-side block',$1) returning id", [otherCoachId])).rows[0].id;
  await client.query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)", [collectionId, exerciseId]);
  await client.query("insert into public.user_club_roles (user_id,club_id,is_active) values ($1,$2,true)", [coachId, crypto.randomUUID()]);
  const before = await itemCount();
  assert.equal((await addExercise(exerciseId)).status, 404);
  const granted = await changeGrants({ userIds: [coachId], add: [collectionId] });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal((await addExercise(exerciseId)).status, 201);
  assert.equal(await itemCount(), before + 1);
  const removed = await changeGrants({ userIds: [coachId], remove: [collectionId] });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removed.length, 1);
  // No new use: the add is the same 404 as for a foreign exercise; the item added before stays.
  assert.equal((await addExercise(exerciseId)).status, 404);
  assert.equal(await itemCount(), before + 1);
  assert.equal((await client.query("select count(*)::int as count from plans.plan_items where exercise_id=$1", [exerciseId])).rows[0].count, 1);
});

test("a removal from the account's side before a Builder add makes the waiting add recheck access after the removal commits", async () => {
  const fixture = await makeGrantedExercise();
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let add;
  let revoke;
  try {
    await blocker.query("begin");
    await blocker.query("lock table library.exercise_collection_audit in share mode");
    revoke = changeGrants({ userIds: [coachId], remove: [fixture.collectionId] });
    const revokePid = await waitForBlockedQuery("insert into library.exercise_collection_audit");
    add = addExercise(fixture.exerciseId);
    const addPid = await waitForBlockedQuery("pg_advisory_xact_lock_shared(");
    assert.notEqual(addPid, revokePid);
    await blocker.query("commit");
    assert.equal((await revoke).status, 200);
    assert.equal((await add).status, 404);
    assert.equal(await itemCount(), 0);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([add, revoke].filter(Boolean));
  }
});

async function request(path, body = {}, { athlete = false, method = "POST" } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/json", ...(athlete ? { "x-test-athlete": "true" } : {}) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function makeReuseFixture(personal = false) {
  const grant = await makeGrantedExercise();
  const section = await makeSection(coachId);
  let exerciseId = grant.exerciseId;
  if (personal) {
    exerciseId = (await client.query("insert into library.exercises (name,owner_scope,owner_user_id,source_exercise_id) values ('Preserved personal copy','user',$1,$2) returning id", [coachId, exerciseId])).rows[0].id;
  }
  assert.equal((await addExercise(exerciseId, {}, section)).status, 201);
  const source = (await client.query(`select node.id as node,session.id as session,day.id as day,day.plan_id as plan
    from plans.plan_nodes node join plans.plan_sessions session on session.id=node.plan_session_id
    join plans.plan_days day on day.id=session.plan_day_id where node.id=$1`, [section])).rows[0];
  await client.query("update plans.plans set status='active' where id=$1", [source.plan]);
  const targetNode = await makeSection(coachId);
  const target = (await client.query(`select node.id as node,session.id as session,day.id as day,day.plan_id as plan
    from plans.plan_nodes node join plans.plan_sessions session on session.id=node.plan_session_id
    join plans.plan_days day on day.id=session.plan_day_id where node.id=$1`, [targetNode])).rows[0];
  await client.query("update plans.plans set plan_type='weekly' where id=$1", [target.plan]);
  target.parent = (await client.query("insert into plans.plan_nodes (plan_session_id,node_type) values ($1,'domain') returning id", [target.session])).rows[0].id;
  const athleteId = crypto.randomUUID();
  const athleteCode = crypto.randomUUID();
  await client.query("insert into public.athletes (id,user_id,athlete_id,source_external_id) values ($1,$2,$3,$3)", [athleteId, athleteUserId, athleteCode]);
  await client.query("insert into public.user_athletes values ($1,$2,true,'coach')", [coachId, athleteId]);
  return { ...grant, exerciseId, sourceId: grant.exerciseId, source, target, athleteId, athleteCode };
}

async function restoreAccess(fixture) {
  return request(`/api/exercise-collections/${fixture.collectionId}`, {
    name: "Race block", exerciseIds: [fixture.sourceId], userIds: [coachId], expectedRevision: 2,
  }, { method: "PATCH" });
}

async function contentCounts() {
  return (await client.query(`select
    (select count(*) from plans.plans) as plans,
    (select count(*) from plans.plan_days) as days,
    (select count(*) from plans.plan_sessions) as sessions,
    (select count(*) from plans.plan_nodes) as nodes,
    (select count(*) from plans.plan_items) as items,
    (select count(*) from library.program_access) as access`)).rows[0];
}

for (const scenario of ["system", "own copy", "copy source"]) {
  test(`inactive ${scenario} cannot be copied, assigned or activated`, async () => {
    const fixture = await makeReuseFixture(scenario !== "system");
    const inactiveId = scenario === "copy source" ? fixture.sourceId : fixture.exerciseId;
    await client.query("update library.exercises set is_active=false where id=$1", [inactiveId]);
    await client.query("update plans.plans set status='draft' where id=$1", [fixture.source.plan]);
    const before = await contentCounts();
    for (const [path, body] of [
      [`/api/builder/plans/${fixture.source.plan}/duplicate`, {}],
      [`/api/templates/${fixture.source.plan}/assignments`, { athleteIds: [fixture.athleteCode] }],
      [`/api/builder/plans/${fixture.source.plan}/submit`, {}],
    ]) {
      const denied = await request(path, body);
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.deepEqual(await contentCounts(), before);
    }
    assert.equal((await addExercise(fixture.exerciseId)).status, 404);
    await client.query("update library.exercises set is_active=true where id=$1", [inactiveId]);
    assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 201);
  });
}

test("sharing an active author's private snapshot does not expose its Library row", async () => {
  const fixture = await makeReuseFixture(true);
  await client.query("update library.exercises set owner_user_id=$2 where id=$1", [fixture.exerciseId, otherCoachId]);
  assert.equal((await addExercise(fixture.exerciseId)).status, 404);
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 201);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 409);
  assert.equal((await restoreAccess(fixture)).status, 200);
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 201);
  assert.equal((await addExercise(fixture.exerciseId)).status, 404);
});

test("deactivation preserves assigned Athlete snapshots and same-plan edits, but not new occurrences", async () => {
  const fixture = await makeReuseFixture(true);
  await client.query("update plans.plans set athlete_id=$2,is_template=false where id=$1", [fixture.source.plan, fixture.athleteId]);
  const saved = (await client.query("select * from plans.plan_items where plan_session_id=$1", [fixture.source.session])).rows;
  await client.query("update library.exercises set is_active=false where id=$1", [fixture.sourceId]);
  const read = await request(`/api/plans/${fixture.source.plan}/program`, {}, { method: "GET", athlete: true });
  assert.equal(read.status, 200);
  assert.deepEqual((await client.query("select * from plans.plan_items where plan_session_id=$1", [fixture.source.session])).rows, saved);
  const { assertExerciseReuseAllowed } = await import("../src/exerciseAccess.js");
  const connection = await pool.connect();
  try {
    await connection.query("begin");
    const scope = { planIds: [fixture.source.plan] };
    await assert.rejects(assertExerciseReuseAllowed(connection, coachId, scope), { message: "exerciseAccessRevoked" });
    await assertExerciseReuseAllowed(connection, coachId, { ...scope, retainedItems: [{ exercise_id: fixture.exerciseId, uses: 1 }] });
  } finally {
    await connection.query("rollback");
    connection.release();
  }
});

test("an author's ordinary private snapshot remains reusable only while active", async () => {
  const fixture = await makeReuseFixture();
  await client.query("update plans.plan_items set exercise_id=$2 where plan_session_id=$1", [fixture.source.session, exercises.foreign]);
  assert.equal((await addExercise(exercises.foreign)).status, 404);
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 201);
  for (const active of [false, null]) {
    await client.query("update library.exercises set is_active=$2 where id=$1", [exercises.foreign, active]);
    const before = await contentCounts();
    assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 409);
    assert.deepEqual(await contentCounts(), before);
  }
  await client.query("update library.exercises set is_active=true where id=$1", [exercises.foreign]);
});

for (const personal of [false, true]) {
  for (const operation of ["program", "block", "session", "node", "day", "cross block", "assign", "template assignment", "submit"]) {
    test(`${personal ? "private copy" : "system original"}: ${operation} rejects revoke atomically and works after regrant`, async () => {
      const fixture = await makeReuseFixture(personal);
      const { source, target } = fixture;
      if (operation === "day") {
        await client.query("update plans.plans set plan_type='weekly' where id=$1", [source.plan]);
        await client.query("update plans.plan_days set plan_id=$1 where id=$2", [source.plan, target.day]);
      }
      if (operation === "submit") await client.query("update plans.plans set status='draft' where id=$1", [source.plan]);
      const paths = {
        program: [`/api/builder/plans/${source.plan}/duplicate`, {}],
        block: [`/api/builder/blocks/${source.day}/copy`, {}],
        session: [`/api/builder/sessions/${source.session}/copy-into/${target.day}`, {}],
        node: [`/api/builder/nodes/${source.node}/copy`, { targetSessionId: target.session, targetParentId: target.parent }],
        day: [`/api/builder/days/${source.day}/copy-into/${target.day}`, { confirmOverwrite: true }],
        "cross block": [`/api/builder/blocks/${source.day}/copy-into/${target.day}`, { confirmOverwrite: true }],
        assign: [`/api/builder/plans/${source.plan}/duplicate`, { intent: "assign", athleteIds: [fixture.athleteCode], assignmentRequestId: crypto.randomUUID() }],
        "template assignment": [`/api/templates/${source.plan}/assignments`, { athleteIds: [fixture.athleteCode] }],
        submit: [`/api/builder/plans/${source.plan}/submit`, {}],
      };
      assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
      const before = await contentCounts();
      const denied = await request(...paths[operation]);
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
      assert.deepEqual(await contentCounts(), before);
      assert.equal((await restoreAccess(fixture)).status, 200);
      const allowed = await request(...paths[operation]);
      assert.ok([200, 201].includes(allowed.status), JSON.stringify(allowed.body));
    });
  }
}

test("existing active Athlete program and prescription survive revocation unchanged", async () => {
  const fixture = await makeReuseFixture(true);
  await client.query("update plans.plans set athlete_id=$2,is_template=false where id=$1", [fixture.source.plan, fixture.athleteId]);
  const before = (await client.query("select * from plans.plan_items where plan_session_id=$1", [fixture.source.session])).rows;
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const read = await request(`/api/plans/${fixture.source.plan}/program`, {}, { method: "GET", athlete: true });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok(JSON.stringify(read.body).includes("Private copy") || JSON.stringify(read.body).includes("Preserved personal copy"));
  assert.deepEqual((await client.query("select * from plans.plan_items where plan_session_id=$1", [fixture.source.session])).rows, before);
  assert.equal((await addExercise(fixture.exerciseId, {}, fixture.source.node)).status, 404);
});

test("existing approved template use remains available but cannot extend its expiry after revoke", async () => {
  const fixture = await makeReuseFixture();
  const expiresAt = new Date(Date.now() + 86400000);
  await client.query("insert into library.program_access (plan_id,user_id,access_type,status,expires_at) values ($1,$2,'coach_assigned','accessed',$3)", [fixture.source.plan, athleteUserId, expiresAt]);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  assert.equal((await request(`/api/templates/${fixture.source.plan}/use`)).status, 409);
  const use = await request(`/api/templates/${fixture.source.plan}/use`, {}, { athlete: true });
  assert.equal(use.status, 200, JSON.stringify(use.body));
  assert.equal(new Date(use.body.access.expires_at).toISOString(), expiresAt.toISOString());
});

test("a copy receipt cannot become a new use entitlement after revoke", async () => {
  const fixture = await makeReuseFixture();
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/duplicate`)).status, 201);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const use = await request(`/api/templates/${fixture.source.plan}/use`);
  assert.equal(use.status, 409, JSON.stringify(use.body));
  assert.equal((await client.query("select status from library.program_access where plan_id=$1 and access_type='copied' and user_id=$2", [fixture.source.plan, coachId])).rows[0].status, "accessed");
});

for (const oldStatus of ["accessed", "used", "completed"]) {
  test(`expired ${oldStatus} access cannot be silently renewed through an approval-required use`, async () => {
    const fixture = await makeReuseFixture();
    await client.query("update plans.plans set athlete_can_view_directly=true,requires_approval=true where id=$1", [fixture.source.plan]);
    await client.query("insert into public.athlete_library_access (athlete_id,can_view_coach_library,require_approval) values ($1,true,true)", [fixture.athleteId]);
    await client.query("insert into library.program_access (plan_id,user_id,access_type,status,expires_at) values ($1,$2,'free',$3,now()-interval '1 day')", [fixture.source.plan, athleteUserId, oldStatus]);
    assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
    const use = await request(`/api/templates/${fixture.source.plan}/use`, {}, { athlete: true });
    assert.equal(use.status, 200, JSON.stringify(use.body));
    assert.equal(use.body.access.status, "requested");
    assert.equal((await client.query("select count(*)::integer as count from library.program_access where plan_id=$1 and user_id=$2 and status in ('accessed','used','completed') and (expires_at is null or expires_at>now())", [fixture.source.plan, athleteUserId])).rows[0].count, 0);
  });
}

for (const bulk of [false, true]) {
  test(`${bulk ? "bulk" : "single"} approval cannot grant revoked exercises and works after regrant`, async () => {
    const fixture = await makeReuseFixture(true);
    const accessId = (await client.query("insert into library.program_access (plan_id,user_id,access_type,status) values ($1,$2,'coach_assigned','requested') returning id", [fixture.source.plan, athleteUserId])).rows[0].id;
    const path = bulk ? "/api/organization/program-access/bulk" : `/api/organization/program-access/${accessId}/approve`;
    const body = bulk ? { action: "approve", accessIds: [accessId] } : {};
    assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
    assert.equal((await request(path, body)).status, 409);
    assert.equal((await client.query("select status from library.program_access where id=$1", [accessId])).rows[0].status, "requested");
    assert.equal((await restoreAccess(fixture)).status, 200);
    const allowed = await request(path, body);
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  });
}

test("metadata publication cannot newly expose a revoked draft", async () => {
  const fixture = await makeReuseFixture();
  await client.query("update plans.plans set status='draft' where id=$1", [fixture.source.plan]);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const path = `/api/templates/${fixture.source.plan}/metadata`;
  const body = { libraryScope: "my", programStatus: "active", athleteCanViewDirectly: true };
  const denied = await request(path, body, { method: "PATCH" });
  assert.equal(denied.status, 409, JSON.stringify(denied.body));
  assert.equal((await client.query("select status from plans.plans where id=$1", [fixture.source.plan])).rows[0].status, "draft");
  assert.equal((await restoreAccess(fixture)).status, 200);
  const allowed = await request(path, body, { method: "PATCH" });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
});

test("same-plan edit round trip retains revoked prescriptions but cannot increase their count", async () => {
  const fixture = await makeReuseFixture(true);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const opened = await request(`/api/builder/plans/${fixture.source.plan}/edit`);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const draftId = opened.body.plan.id;
  const item = (await client.query(`select item.* from plans.plan_items item
    join plans.plan_sessions session on session.id=item.plan_session_id join plans.plan_days day on day.id=session.plan_day_id
    where day.plan_id=$1`, [draftId])).rows[0];
  assert.equal((await request(`/api/builder/items/${item.id}`, { sets: "7" }, { method: "PATCH" })).status, 200);
  const extraId = (await client.query("insert into plans.plan_items (plan_session_id,plan_node_id,item_type,exercise_id,title) values ($1,$2,'exercise',$3,'Injected duplicate') returning id", [item.plan_session_id, item.plan_node_id, item.exercise_id])).rows[0].id;
  assert.equal((await request(`/api/builder/plans/${draftId}/submit`)).status, 409);
  await client.query("delete from plans.plan_items where id=$1", [extraId]);
  const applied = await request(`/api/builder/plans/${draftId}/submit`);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((await client.query(`select item.sets from plans.plan_items item
    join plans.plan_sessions session on session.id=item.plan_session_id join plans.plan_days day on day.id=session.plan_day_id
    where day.plan_id=$1`, [fixture.source.plan])).rows[0].sets, "7");
});

test("explicit and implicit batch sync do not fan revoked snapshots out to sibling plans", async () => {
  const fixture = await makeReuseFixture();
  const batchId = crypto.randomUUID();
  await client.query("update plans.plans set status='draft',builder_batch_id=$2 where id=any($1::uuid[])", [[fixture.source.plan, fixture.target.plan], batchId]);
  await client.query("update plans.plans set plan_type='program' where id=$1", [fixture.target.plan]);
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const before = await contentCounts();
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}/sync-batch`)).status, 409);
  assert.deepEqual(await contentCounts(), before);
  assert.equal((await request(`/api/builder/plans/${fixture.source.plan}`, { name: "Still editing", syncBatch: true }, { method: "PATCH" })).status, 409);
  assert.deepEqual(await contentCounts(), before);
  const exercisesBefore = (await client.query("select count(*)::integer as count from library.exercises")).rows[0].count;
  const unrelatedSession = (await client.query("select plan_session_id from plans.plan_nodes where id=$1", [sectionId])).rows[0].plan_session_id;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const custom = await request(`/api/builder/nodes/${fixture.source.node}/custom-exercise`, { name: "No partial custom save", syncBatch: true, targetSessionId: unrelatedSession });
    assert.equal(custom.status, 409, JSON.stringify(custom.body));
    assert.deepEqual(await contentCounts(), before);
    assert.equal((await client.query("select count(*)::integer as count from library.exercises")).rows[0].count, exercisesBefore);
  }
  assert.equal((await restoreAccess(fixture)).status, 200);
  const allowed = await request(`/api/builder/plans/${fixture.source.plan}/sync-batch`);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const custom = await request(`/api/builder/nodes/${fixture.source.node}/custom-exercise`, { name: "Granted custom save", syncBatch: true });
  assert.equal(custom.status, 201, JSON.stringify(custom.body));
  assert.equal((await client.query("select count(*)::integer as count from library.exercises")).rows[0].count, exercisesBefore + 1);
});

test("Builder add under a REPEATABLE READ pool default still rechecks after revoke commits", async () => {
  const fixture = await makeGrantedExercise();
  const connections = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
  for (const connection of connections) await connection.query("set default_transaction_isolation='repeatable read'");
  for (const connection of connections) connection.release();
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let add;
  let revoke;
  try {
    await blocker.query("begin");
    await blocker.query("lock table library.exercise_collection_audit in share mode");
    revoke = revokeAccess(fixture);
    await waitForBlockedQuery("insert into library.exercise_collection_audit");
    add = addExercise(fixture.exerciseId);
    await waitForBlockedQuery("pg_advisory_xact_lock_shared(");
    await blocker.query("commit");
    assert.equal((await revoke).status, 200);
    assert.equal((await add).status, 404);
    assert.equal(await itemCount(), 0);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([add, revoke].filter(Boolean));
    const reset = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
    for (const connection of reset) { await connection.query("set default_transaction_isolation='read committed'"); connection.release(); }
  }
});

async function configureBatch(fixture) {
  await client.query("update plans.plans set status='draft',builder_batch_id=$2,plan_type='program' where id=any($1::uuid[])", [[fixture.source.plan, fixture.target.plan], crypto.randomUUID()]);
}

test("deleting the last revoked occurrence can synchronize remaining authorized content", async () => {
  const fixture = await makeReuseFixture();
  await configureBatch(fixture);
  assert.equal((await addExercise(exercises.own, {}, fixture.source.node)).status, 201);
  const items = (await client.query("select id,exercise_id from plans.plan_items where plan_node_id=$1", [fixture.source.node])).rows;
  assert.equal((await revokeAccess({ ...fixture, exerciseId: fixture.sourceId })).status, 200);
  const authorized = items.find((item) => item.exercise_id === exercises.own);
  const blocked = items.find((item) => item.exercise_id === fixture.exerciseId);
  assert.equal((await request(`/api/builder/items/${authorized.id}?syncBatch=1`, {}, { method: "DELETE" })).status, 409);
  const deleted = await request(`/api/builder/items/${blocked.id}?syncBatch=1`, {}, { method: "DELETE" });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await client.query("select count(*)::integer as count from plans.plan_items where exercise_id=$1", [fixture.exerciseId])).rows[0].count, 0);
  assert.equal((await client.query("select count(*)::integer as count from plans.plan_items where exercise_id=$1", [exercises.own])).rows[0].count, 2);
});

test("implicit batch custom save finishes before queued revoke without an inner advisory-lock cycle", async () => {
  const fixture = await makeReuseFixture();
  await configureBatch(fixture);
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let custom;
  let revoke;
  try {
    await blocker.query("begin");
    await blocker.query("lock table plans.plan_items in share mode");
    custom = request(`/api/builder/nodes/${fixture.source.node}/custom-exercise`, { name: "Queued revoke custom", syncBatch: true });
    await waitForBlockedQuery("insert into plans.plan_items");
    revoke = revokeAccess({ ...fixture, exerciseId: fixture.sourceId });
    await waitForBlockedQuery("pg_advisory_xact_lock(");
    await blocker.query("commit");
    assert.equal((await custom).status, 201);
    assert.equal((await revoke).status, 200);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([custom, revoke].filter(Boolean));
  }
});

test("batch admission leaves checkout capacity and rejects excess work before custom writes", async () => {
  const fixture = await makeReuseFixture();
  await configureBatch(fixture);
  const originalMax = pool.options.max;
  const idle = await Promise.all(Array.from({ length: originalMax }, () => pool.connect()));
  for (const connection of idle) connection.release(true);
  pool.options.max = 3;
  const blocker = new pg.Client({ connectionString: database.url });
  await blocker.connect();
  let first;
  try {
    await blocker.query("begin");
    await blocker.query("lock table plans.plan_items in share mode");
    first = request(`/api/builder/nodes/${fixture.source.node}/custom-exercise`, { name: "Admitted custom", syncBatch: true });
    await waitForBlockedQuery("insert into plans.plan_items");
    const count = (await client.query("select count(*)::integer as count from library.exercises")).rows[0].count;
    const excess = await Promise.all([1, 2].map(() => request(`/api/builder/nodes/${fixture.source.node}/custom-exercise`, { name: "Must not enter", syncBatch: true })));
    assert.deepEqual(excess.map((result) => result.status), [503, 503]);
    assert.equal((await client.query("select count(*)::integer as count from library.exercises")).rows[0].count, count);
    await blocker.query("commit");
    assert.equal((await first).status, 201);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([first].filter(Boolean));
    pool.options.max = originalMax;
  }
});

for (const operation of ["copy", "assign", "template assignment"]) {
  for (const revokeFirst of [false, true]) {
    test(`${operation} versus revoke: ${revokeFirst ? "revoke" : "reuse"} commits first without post-revoke new use`, async () => {
      const fixture = await makeReuseFixture(true);
      const blocker = new pg.Client({ connectionString: database.url });
      await blocker.connect();
      let reuse;
      let revoke;
      const path = operation === "template assignment"
        ? `/api/templates/${fixture.source.plan}/assignments`
        : `/api/builder/plans/${fixture.source.plan}/duplicate`;
      const body = operation === "assign"
        ? { intent: "assign", athleteIds: [fixture.athleteCode], assignmentRequestId: crypto.randomUUID() }
        : operation === "template assignment" ? { athleteIds: [fixture.athleteCode] } : {};
      try {
        await blocker.query("begin");
        await blocker.query(revokeFirst
          ? "lock table library.exercise_collection_audit in share mode"
          : operation === "template assignment" ? "lock table library.program_access in share mode" : "lock table plans.plan_items in share mode");
        if (revokeFirst) {
          revoke = revokeAccess({ ...fixture, exerciseId: fixture.sourceId });
          await waitForBlockedQuery("insert into library.exercise_collection_audit");
          reuse = request(path, body);
          await waitForBlockedQuery("pg_advisory_xact_lock_shared(");
        } else {
          reuse = request(path, body);
          await waitForBlockedQuery(operation === "template assignment" ? "insert into library.program_access" : "insert into plans.plan_items");
          revoke = revokeAccess({ ...fixture, exerciseId: fixture.sourceId });
          await waitForBlockedQuery("pg_advisory_xact_lock(");
        }
        await blocker.query("commit");
        assert.equal((await revoke).status, 200);
        assert.equal((await reuse).status, revokeFirst ? 409 : 201);
        const before = await contentCounts();
        assert.equal((await request(path, { ...body, ...(operation === "assign" ? { assignmentRequestId: crypto.randomUUID() } : {}) })).status, 409);
        assert.deepEqual(await contentCounts(), before);
      } finally {
        await blocker.query("rollback");
        await blocker.end();
        await Promise.allSettled([reuse, revoke].filter(Boolean));
      }
    });
  }
}
