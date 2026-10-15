// Exercise Library save hotfix regression: PATCH /api/exercises/:exerciseId
// (upsertExercise, routes/exercises.js) used a raw SQL existence/access
// check - `select id from library.exercises where id = $2 and
// ${exerciseScope}` - where exerciseScope references the table alias `e`
// (`e.is_active = true and (e.owner_scope = 'system' or e.owner_user_id =
// $1)`), but the query itself never declared that alias
// (`from library.exercises` with no `e`). Every real edit hit a raw
// Postgres 42P01 ("missing FROM-clause entry for table \"e\"") and 500'd -
// an owner could never save a change to their own exercise. Fixed to
// `select e.id from library.exercises e where e.id = $2 and
// ${exerciseScope}`. Also moves the existence/access check ahead of every
// getOrCreateLookup call in the edit path, so a rejected edit (404) can
// never create or reactivate a lookup value as a side effect.
//
// Disposable-DB harness (a uniquely-named temp database, never OPTIMOVE,
// never monitoring2), the real Express app driven over real HTTP with
// real session cookies - same convention as the training-load test
// files. Handbuilt fixtures provide the runtime schema, including source
// linkage and collection access. They do not validate migrations.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import "dotenv/config";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL } from "./support/exercise-collections-fixture.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
if (!ORIGINAL_DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");

// Minimal auth-context schema - the same shape training-load's own
// disposable-DB tests already established, trimmed to exactly what
// authz.js's loadAuthorizationContext/computeCapabilities reads: a real
// active public.user_club_roles row alone is enough to grant
// capabilities.coachWorkspace (requireCoach's own gate on /api/exercises),
// with no need for athletes/user_athletes/workspace-preference tables
// this file's own tests never touch.
const AUTH_FIXTURE_SQL = `
  create extension if not exists pgcrypto;

  create table public.clubs (id uuid primary key default gen_random_uuid(), name text, is_active boolean not null default true);

  create table public.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    password_hash text,
    full_name text,
    display_name text,
    first_name text,
    last_name text,
    role_hint text not null default 'user',
    is_active boolean not null default true
  );
  create table public.auth_sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  );
  create table public.user_global_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    revoked_at timestamptz
  );
  create table public.user_club_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    club_id uuid not null references public.clubs(id) on delete cascade,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.user_team_roles (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    team_id uuid not null,
    role text not null,
    is_active boolean not null default true,
    updated_at timestamptz not null default now()
  );
  create table public.teams (id uuid primary key default gen_random_uuid(), club_id uuid references public.clubs(id), name text, is_active boolean not null default true);
  -- loadAuthorizationContext (authz.js) unconditionally queries this for
  -- every authenticated request (the isAthlete/athleteId signal) - needed
  -- even though this file's own fixtures never populate it.
  create table public.athletes (id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id));
`;

// Real production column shapes (queried directly from the live OPTIMOVE
// schema) for every library.* table exercises.js's own routes actually
// read or write - getOrCreateLookup/syncJunction/loadExerciseDetail/the
// list route's own filters.
const LIBRARY_FIXTURE_SQL = `
  create schema library;

  create table library.exercises (
    id uuid primary key default gen_random_uuid(),
    owner_scope varchar not null default 'system',
    owner_user_id uuid references public.users(id),
    owner_club_id uuid,
    owner_team_id uuid,
    created_by_user_id uuid references public.users(id),
    exercise_code varchar,
    slug varchar,
    name varchar not null,
    place_id uuid,
    complexity_level_id uuid,
    starting_position_id uuid,
    aim text,
    execution_notes text,
    instruction text,
    video_url text,
    image_url text,
    image_mime_type varchar,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    attractor_id uuid
  );

  create table library.places (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create unique index fixture_places_global_name_unique on library.places (lower(name));
  create table library.complexity_levels (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar, rank smallint,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.starting_positions (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.attractors (
    id uuid primary key default gen_random_uuid(), kind varchar not null default 'local', name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.domains (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.categories (
    id uuid primary key default gen_random_uuid(), domain_id uuid references library.domains(id), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.sections (
    id uuid primary key default gen_random_uuid(), category_id uuid references library.categories(id), name varchar not null, slug varchar, description text, color varchar, icon_url text,
    is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid,
    short_note text, note text
  );
  create table library.body_parts (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.movement_patterns (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );
  create table library.tags (
    id uuid primary key default gen_random_uuid(), name varchar not null, slug varchar,
    description text, is_active boolean not null default true, created_by_user_id uuid references public.users(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
    owner_scope varchar not null default 'system', owner_user_id uuid references public.users(id), owner_club_id uuid, owner_team_id uuid
  );

  create table library.exercise_domains (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    domain_id uuid not null references library.domains(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_categories (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    category_id uuid not null references library.categories(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_sections (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    section_id uuid not null references library.sections(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_body_parts (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    body_part_id uuid not null references library.body_parts(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_movement_patterns (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    movement_pattern_id uuid not null references library.movement_patterns(id), is_primary boolean not null default false, sort_order smallint,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_tags (
    id uuid primary key default gen_random_uuid(), exercise_id uuid not null references library.exercises(id) on delete cascade,
    tag_id uuid not null references library.tags(id),
    created_at timestamptz not null default now(), updated_at timestamptz not null default now()
  );
  create table library.exercise_favorites (
    user_id uuid not null references public.users(id), exercise_id uuid not null references library.exercises(id) on delete cascade,
    created_at timestamptz not null default now()
  );
  create table library.filter_hidden (
    id uuid primary key default gen_random_uuid(), kind varchar not null, item_id uuid not null, user_id uuid not null references public.users(id),
    created_at timestamptz not null default now()
  );
`;

// The disposable database comes from the shared test support (T1,
// tests/support/disposable-db.mjs): the same optimove_tests_exlib_<label>_<hex>
// name, the admin connection on "postgres", and a drop that first ends every
// other session - exactly what this file's own makeTempDb / dropTempDb pair
// did before, now with the loopback-only server rule as well.
function makeTempDb(label) {
  return createDisposableDatabase({ prefix: "exlib", label, baseDatabaseUrl: ORIGINAL_DATABASE_URL });
}
function dropTempDb(db) {
  return db.drop();
}

let db, adminClient;
let server, apiBaseUrl;
let query, pool, createSession, hashPassword;

before(async () => {
  db = await makeTempDb("primary");
  adminClient = new pg.Client({ connectionString: db.url });
  await adminClient.connect();
  const ownCheck = await adminClient.query("select current_database() as db");
  assert.equal(ownCheck.rows[0].db, db.name, "SAFETY: test connection landed on an unexpected database");

  await adminClient.query(AUTH_FIXTURE_SQL);
  await adminClient.query(LIBRARY_FIXTURE_SQL);
  await adminClient.query(EXERCISE_COLLECTIONS_FIXTURE_SQL);

  process.env.DATABASE_URL = db.url;
  const dbModule = await import("../src/db.js");
  query = dbModule.query;
  pool = dbModule.pool;
  const authModule = await import("../src/auth.js");
  createSession = authModule.createSession;
  hashPassword = authModule.hashPassword;
  const serverModule = await import("../src/server.js");

  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBaseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await adminClient.end();
  await dropTempDb(db);
});

// ------------------------------------------------------------
// Fixture helpers
// ------------------------------------------------------------

function cookieFor(token) { return `optimove_session=${token}`; }
async function makeCoach(label) {
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`${label} club`]);
  const clubId = clubResult.rows[0].id;
  const userResult = await query(
    `insert into public.users (email, password_hash, full_name, display_name, role_hint, is_active) values ($1,$2,$3,$3,'club_admin',true) returning id`,
    [`${label}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}@test.local`, hashPassword("irrelevant-password-123"), label],
  );
  const userId = userResult.rows[0].id;
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, clubId]);
  const token = await createSession(userId);
  return { userId, clubId, cookie: cookieFor(token) };
}

async function makeExercise(ownerUserId, overrides = {}) {
  const { name = "Fixture exercise", isActive = true, ownerScope = "user" } = overrides;
  const result = await query(
    `insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, name, slug, is_active)
     values ($1,$2,$2,$3,$3,$4) returning id`,
    [ownerScope, ownerUserId, name, isActive],
  );
  return result.rows[0].id;
}

async function makeLibraryAdmin(label) {
  const admin = await makeCoach(label);
  await query("insert into public.user_global_roles (user_id,role) values ($1,'platform_admin')", [admin.userId]);
  return admin;
}

test("editing a system exercise makes a private copy and leaves the application original unchanged", async () => {
  const coach = await makeCoach("system-copy");
  const other = await makeCoach("system-reader");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Application original" });
  const spoofedSourceId = await makeExercise(other.userId, { name: "Foreign spoofed source" });
  const before = (await query("select * from library.exercises where id = $1", [systemId])).rows[0];
  const saved = await api(`/api/exercises/${systemId}`, {
    method: "PATCH", cookie: coach.cookie, body: {
      name: "Personal variation", instruction: "My instruction",
      sourceExerciseId: spoofedSourceId, source_exercise_id: spoofedSourceId,
    },
  });
  assert.equal(saved.status, 201);
  assert.notEqual(saved.body.id, systemId);
  assert.equal(saved.body.ownerScope, "user");
  assert.equal(saved.body.sourceExerciseId, systemId);
  assert.deepEqual((await query(
    "select owner_user_id,source_exercise_id from library.exercises where id=$1", [saved.body.id],
  )).rows[0], { owner_user_id: coach.userId, source_exercise_id: systemId });
  assert.deepEqual((await query("select * from library.exercises where id = $1", [systemId])).rows[0], before);
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${systemId}`, { cookie: other.cookie })).body.name, "Application original");
  const retried = await api(`/api/exercises/${systemId}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: "Personal variation 2" },
  });
  assert.equal(retried.body.id, saved.body.id);
  assert.equal((await query("select count(*)::integer as count from library.exercises where owner_user_id = $1 and source_exercise_id = $2", [coach.userId, systemId])).rows[0].count, 1);
});

test("a coach-created exercise ignores ownership and source supplied by the client", async () => {
  const coach = await makeCoach("create-ownership");
  const other = await makeCoach("create-ownership-other");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Create provenance system" });
  const foreignId = await makeExercise(other.userId, { name: "Create provenance private" });
  for (const sourceKey of ["sourceExerciseId", "source_exercise_id"]) {
    for (const sourceId of [systemId, foreignId]) {
      const saved = await api("/api/exercises", { method: "POST", cookie: coach.cookie,
        body: {
          name: `My original ${sourceKey} ${sourceId}`,
          ownerScope: "system", ownerUserId: other.userId, [sourceKey]: sourceId,
        } });
      assert.equal(saved.status, 201);
      assert.equal(saved.body.sourceExerciseId, null);
      assert.equal(saved.body.copiedFromSystem, false);
      const row = (await query(
        "select owner_scope,owner_user_id,source_exercise_id from library.exercises where id=$1",
        [saved.body.id],
      )).rows[0];
      assert.deepEqual(row, { owner_scope: "user", owner_user_id: coach.userId, source_exercise_id: null });
    }
  }
});

test("restricted blocks hide the source and each private copy on revocation without sharing copies", async () => {
  const admin = await makeLibraryAdmin("block-admin");
  const coach = await makeCoach("block-coach");
  const other = await makeCoach("block-other");
  const outsider = await makeCoach("block-outsider");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Restricted original" });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: "Selected coaches", exerciseIds: [systemId], userIds: [coach.userId, other.userId] } });
  assert.equal(created.status, 201);
  assert.equal((await api(`/api/exercises/${systemId}`, { cookie: outsider.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${systemId}`, { cookie: admin.cookie })).status, 200);
  const saved = await api(`/api/exercises/${systemId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Private restricted variation" } });
  assert.equal(saved.status, 201);
  const preservedCopy = (await query("select * from library.exercises where id=$1", [saved.body.id])).rows[0];
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: admin.cookie })).status, 404);
  const changed = await api(`/api/exercise-collections/${created.body.collection.id}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Selected coaches", exerciseIds: [systemId], userIds: [other.userId], expectedRevision: 1 } });
  assert.equal(changed.status, 200);
  for (const exerciseId of [systemId, saved.body.id]) {
    assert.equal((await api(`/api/exercises/${exerciseId}`, { cookie: coach.cookie })).status, 404);
    assert.equal((await api(`/api/exercises/${exerciseId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Denied" } })).status, 404);
    assert.equal((await api(`/api/exercises/${exerciseId}/favorite`, { method: "POST", cookie: coach.cookie })).status, 404);
    assert.equal((await api(`/api/exercises/${exerciseId}/tags`, { cookie: coach.cookie })).status, 404);
  }
  const listed = await api("/api/exercises?search=Restricted", { cookie: coach.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.exercises.some((exercise) => [systemId, saved.body.id].includes(exercise.id)), false);
  assert.equal((await api(`/api/exercises/${systemId}`, { cookie: other.cookie })).status, 200);
  assert.equal((await query("select owner_scope,owner_user_id from library.exercises where id=$1", [saved.body.id])).rows[0].owner_user_id, coach.userId);
  assert.equal((await api("/api/exercise-collections", { cookie: coach.cookie })).status, 404);
  const stale = await api(`/api/exercise-collections/${created.body.collection.id}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Stale", exerciseIds: [systemId], userIds: [coach.userId], expectedRevision: 1 } });
  assert.equal(stale.status, 409);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_audit where collection_id=$1", [created.body.collection.id])).rows[0].count, 2);
  const restored = await api(`/api/exercise-collections/${created.body.collection.id}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Selected coaches", exerciseIds: [systemId], userIds: [coach.userId, other.userId], expectedRevision: 2 } });
  assert.equal(restored.status, 200);
  const restoredCopy = await api(`/api/exercises/${saved.body.id}`, { cookie: coach.cookie });
  assert.equal(restoredCopy.status, 200);
  assert.equal(restoredCopy.body.name, "Private restricted variation");
  assert.deepEqual((await query("select * from library.exercises where id=$1", [saved.body.id])).rows[0], preservedCopy);
  const relisted = await api("/api/exercises?search=Restricted", { cookie: coach.cookie });
  assert.equal(relisted.body.exercises.some((exercise) => exercise.id === saved.body.id), true);
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: other.cookie })).status, 404);
});

test("deactivating the canonical source hides a private copy without deleting its edits", async () => {
  const coach = await makeCoach("inactive-source");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Deactivation source" });
  const copy = await api(`/api/exercises/${systemId}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: "Preserved deactivation variation" },
  });
  assert.equal(copy.status, 201);
  const saved = (await query("select * from library.exercises where id=$1", [copy.body.id])).rows[0];
  await query("update library.exercises set is_active=false where id=$1", [systemId]);
  for (const exerciseId of [systemId, copy.body.id]) {
    assert.equal((await api(`/api/exercises/${exerciseId}`, { cookie: coach.cookie })).status, 404);
    assert.equal((await api(`/api/exercises/${exerciseId}`, {
      method: "PATCH", cookie: coach.cookie, body: { name: "Denied source edit" },
    })).status, 404);
  }
  const listed = await api("/api/exercises?search=deactivation", { cookie: coach.cookie });
  assert.equal(listed.body.exercises.some((exercise) => [systemId, copy.body.id].includes(exercise.id)), false);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [copy.body.id])).rows[0], saved);
  await query("update library.exercises set is_active=true where id=$1", [systemId]);
  const restored = await api(`/api/exercises/${copy.body.id}`, { cookie: coach.cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.name, saved.name);
  assert.equal((await api(`/api/exercises/${systemId}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: saved.name },
  })).body.id, copy.body.id);
});

test("collection rollback refuses existing restricted blocks", async () => {
  const admin = await makeLibraryAdmin("rollback-guard-admin");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Rollback guard source" });
  const created = await api("/api/exercise-collections", {
    method: "POST", cookie: admin.cookie,
    body: { name: "Rollback guard block", exerciseIds: [systemId], userIds: [] },
  });
  assert.equal(created.status, 201);
  const { readFile } = await import("node:fs/promises");
  await assert.rejects(
    adminClient.query(await readFile(
      new URL("../../docs/runbooks/exercise-library-collections-rollback.sql", import.meta.url), "utf8",
    )),
    /Rollback refused/,
  );
});

test("deactivated platform administrator cannot authenticate with an existing session", async () => {
  const admin = await makeLibraryAdmin("deactivated-library-admin");
  assert.equal((await api("/api/exercise-collections", { cookie: admin.cookie })).status, 200);
  await query("update public.users set is_active=false where id=$1", [admin.userId]);
  for (const path of ["/api/exercise-collections", "/api/exercises", `/api/builder/plans/${crypto.randomUUID()}`]) {
    assert.equal((await api(path, { cookie: admin.cookie })).status, 401);
  }
});

test("system copy under a REPEATABLE READ pool default cannot reuse the grant revoked while waiting", async () => {
  const admin = await makeLibraryAdmin("repeatable-revoke-admin");
  const coach = await makeCoach("repeatable-copy-coach");
  const source = await makeExercise(null, { ownerScope: "system", name: "RR system source" });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: "RR block", exerciseIds: [source], userIds: [coach.userId] } });
  assert.equal(created.status, 201);
  const connections = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
  for (const connection of connections) await connection.query("set default_transaction_isolation='repeatable read'");
  for (const connection of connections) connection.release();
  const blocker = new pg.Client({ connectionString: db.url });
  await blocker.connect();
  async function waitFor(fragment) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const waiting = await adminClient.query("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and position($1 in query)>0", [fragment]);
      if (waiting.rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Expected blocked copy/revoke connection");
  }
  let revoke;
  let copy;
  try {
    await blocker.query("begin");
    await blocker.query("lock table library.exercise_collection_audit in share mode");
    revoke = api(`/api/exercise-collections/${created.body.collection.id}`, { method: "PATCH", cookie: admin.cookie,
      body: { name: "RR block", exerciseIds: [source], userIds: [], expectedRevision: 1 } });
    await waitFor("insert into library.exercise_collection_audit");
    copy = api(`/api/exercises/${source}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Must not be copied" } });
    await waitFor("pg_advisory_xact_lock_shared(");
    await blocker.query("commit");
    assert.equal((await revoke).status, 200);
    assert.equal((await copy).status, 404);
    assert.equal((await adminClient.query("select count(*)::integer as count from library.exercises where source_exercise_id=$1", [source])).rows[0].count, 0);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([copy, revoke].filter(Boolean));
    const reset = await Promise.all(Array.from({ length: pool.options.max }, () => pool.connect()));
    for (const connection of reset) { await connection.query("set default_transaction_isolation='read committed'"); connection.release(); }
  }
});

test("patching an owned private exercise ignores spoofed provenance without cloning or transferring ownership", async () => {
  const coach = await makeCoach("private-provenance");
  const other = await makeCoach("private-provenance-other");
  const canonicalSourceId = await makeExercise(null, { ownerScope: "system", name: "Canonical source" });
  const spoofedSourceId = await makeExercise(other.userId, { name: "Spoofed private source" });
  const originalId = await makeExercise(coach.userId, { name: "Private original" });
  const copy = await api(`/api/exercises/${canonicalSourceId}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: "Canonical private copy" },
  });
  assert.equal(copy.status, 201);
  const beforeCount = (await query("select count(*)::integer as count from library.exercises")).rows[0].count;
  for (const [exerciseId, sourceId] of [[originalId, null], [copy.body.id, canonicalSourceId]]) {
    for (const sourceKey of ["sourceExerciseId", "source_exercise_id"]) {
      const saved = await api(`/api/exercises/${exerciseId}`, {
        method: "PATCH", cookie: coach.cookie,
        body: {
          name: `Updated private ${sourceKey}`, ownerScope: "system",
          ownerUserId: other.userId, [sourceKey]: spoofedSourceId,
        },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.id, exerciseId);
      assert.equal(saved.body.sourceExerciseId, sourceId);
      assert.equal(saved.body.copiedFromSystem, false);
      assert.deepEqual((await query(
        "select owner_scope,owner_user_id,source_exercise_id from library.exercises where id=$1",
        [exerciseId],
      )).rows[0], { owner_scope: "user", owner_user_id: coach.userId, source_exercise_id: sourceId });
    }
  }
  assert.equal((await query("select count(*)::integer as count from library.exercises")).rows[0].count, beforeCount);
});

test("patching foreign private or inaccessible system exercises with spoofed provenance returns 404 without copying", async () => {
  const coach = await makeCoach("denied-provenance");
  const other = await makeLibraryAdmin("denied-provenance-other");
  const foreignId = await makeExercise(other.userId, { name: "Foreign private provenance" });
  const restrictedId = await makeExercise(null, { ownerScope: "system", name: "Restricted provenance" });
  const inactiveId = await makeExercise(null, {
    ownerScope: "system", name: "Inactive system provenance", isActive: false,
  });
  const authorizedId = await makeExercise(null, { ownerScope: "system", name: "Authorized spoof target" });
  const block = await api("/api/exercise-collections", {
    method: "POST", cookie: other.cookie,
    body: { name: "Provenance restricted block", exerciseIds: [restrictedId], userIds: [other.userId] },
  });
  assert.equal(block.status, 201);
  const before = (await query("select * from library.exercises order by id")).rows;
  for (const exerciseId of [foreignId, restrictedId, inactiveId]) {
    for (const sourceKey of ["sourceExerciseId", "source_exercise_id"]) {
      const saved = await api(`/api/exercises/${exerciseId}`, {
        method: "PATCH", cookie: coach.cookie,
        body: {
          name: "Denied provenance edit", place: "Denied provenance place",
          ownerScope: "user", ownerUserId: coach.userId, [sourceKey]: authorizedId,
        },
      });
      assert.equal(saved.status, 404);
      assert.deepEqual((await query("select * from library.exercises order by id")).rows, before);
    }
  }
  assert.equal((await query(
    "select count(*)::integer as count from library.places where name='Denied provenance place'",
  )).rows[0].count, 0);
});

for (const scenario of [
  { name: "active foreign private lookup returns 409 without side effects", scope: "user", active: true, own: false, status: 409 },
  { name: "inactive foreign private lookup returns 409 without reactivation or side effects", scope: "user", active: false, own: false, status: 409 },
  { name: "own inactive lookup is reactivated and reused", scope: "user", active: false, own: true, status: 200 },
  { name: "active system lookup is reused without changing its owner", scope: "system", active: true, own: false, status: 200 },
  { name: "inactive system lookup returns 409 and remains inactive", scope: "system", active: false, own: false, status: 409 },
]) {
  test(scenario.name, async () => {
    const coach = await makeCoach(`lookup-${scenario.scope}-${scenario.active}-${scenario.own}`);
    const other = await makeCoach("lookup-other");
    const exerciseId = await makeExercise(coach.userId, { name: `Lookup exercise ${scenario.name}` });
    const lookupName = `Lookup place ${scenario.name}`;
    const ownerId = scenario.scope === "system" ? null : scenario.own ? coach.userId : other.userId;
    const lookupId = (await query(
      `insert into library.places (name,owner_scope,owner_user_id,is_active)
       values ($1,$2,$3,$4) returning id`,
      [lookupName, scenario.scope, ownerId, scenario.active],
    )).rows[0].id;
    const beforePlaces = (await query("select * from library.places order by id")).rows;
    const beforeExercises = (await query("select * from library.exercises order by id")).rows;
    const saved = await api(`/api/exercises/${exerciseId}`, {
      method: "PATCH", cookie: coach.cookie,
      body: { name: "Lookup edit", place: lookupName.toUpperCase() },
    });
    assert.equal(saved.status, scenario.status, JSON.stringify(saved.body));
    if (scenario.status === 409) {
      assert.deepEqual((await query("select * from library.places order by id")).rows, beforePlaces);
      assert.deepEqual((await query("select * from library.exercises order by id")).rows, beforeExercises);
      const created = await api("/api/exercises", {
        method: "POST", cookie: coach.cookie,
        body: { name: "Rejected lookup create", place: lookupName.toUpperCase() },
      });
      assert.equal(created.status, 409, JSON.stringify(created.body));
      assert.deepEqual(created.body, saved.body);
      assert.deepEqual((await query("select * from library.places order by id")).rows, beforePlaces);
      assert.deepEqual((await query("select * from library.exercises order by id")).rows, beforeExercises);
    } else {
      assert.equal(saved.body.id, exerciseId);
      assert.equal((await query(
        "select place_id from library.exercises where id=$1", [exerciseId],
      )).rows[0].place_id, lookupId);
      assert.equal((await query(
        "select count(*)::integer as count from library.places where lower(name)=lower($1)", [lookupName],
      )).rows[0].count, 1);
      assert.deepEqual((await query(
        "select owner_scope,owner_user_id,is_active from library.places where id=$1", [lookupId],
      )).rows[0], { owner_scope: scenario.scope, owner_user_id: ownerId, is_active: true });
      if (scenario.scope === "system") {
        assert.deepEqual((await query("select * from library.places order by id")).rows, beforePlaces);
      }
    }
  });
}

test("block administration rejects non-admin writes and private exercises without changing grants", async () => {
  const admin = await makeLibraryAdmin("invalid-block-admin");
  const coach = await makeCoach("invalid-block-coach");
  const privateId = await makeExercise(coach.userId);
  const payload = { name: "Invalid block", exerciseIds: [privateId], userIds: [coach.userId] };
  assert.equal((await api("/api/exercise-collections", { method: "POST", cookie: coach.cookie, body: payload })).status, 404);
  assert.equal((await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: payload })).status, 400);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collections where name='Invalid block'")).rows[0].count, 0);
});

test("a failed copy save rolls back the exercise and all new lookup values", async () => {
  const coach = await makeCoach("copy-rollback");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Rollback source" });
  await query("alter table library.tags add constraint reject_copy_failure_tag check (name <> 'force-copy-save-failure')");
  try {
    const response = await api(`/api/exercises/${systemId}`, { method: "PATCH", cookie: coach.cookie,
      body: { name: "Must roll back", place: "Must roll back place", tags: ["force-copy-save-failure"] } });
    assert.equal(response.status, 500);
    assert.equal((await query("select count(*)::integer as count from library.exercises where source_exercise_id=$1", [systemId])).rows[0].count, 0);
    assert.equal((await query("select count(*)::integer as count from library.places where name='Must roll back place'")).rows[0].count, 0);
    assert.equal((await query("select name from library.exercises where id=$1", [systemId])).rows[0].name, "Rollback source");
  } finally { await query("alter table library.tags drop constraint reject_copy_failure_tag"); }
});

test("tag endpoints cannot mutate the application original or remove another user's private tag", async () => {
  const coach = await makeCoach("tag-owner");
  const other = await makeCoach("tag-other");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "System tags original" });
  const tagId = (await query("insert into library.tags (name,slug,owner_scope,owner_user_id) values ('Other private tag','other-private','user',$1) returning id", [other.userId])).rows[0].id;
  await query("insert into library.exercise_tags (exercise_id,tag_id) values ($1,$2)", [systemId, tagId]);
  assert.equal((await api(`/api/exercises/${systemId}/tags`, { method: "POST", cookie: coach.cookie, body: { name: "New tag" } })).status, 409);
  assert.equal((await api(`/api/exercises/${systemId}/tags/${tagId}`, { method: "DELETE", cookie: coach.cookie })).status, 409);
  assert.equal((await query("select count(*)::integer as count from library.exercise_tags where exercise_id=$1", [systemId])).rows[0].count, 1);
  const ownId = await makeExercise(coach.userId);
  await query("insert into library.exercise_tags (exercise_id,tag_id) values ($1,$2)", [ownId, tagId]);
  assert.equal((await api(`/api/exercises/${ownId}/tags/${tagId}`, { method: "DELETE", cookie: coach.cookie })).status, 404);
  assert.equal((await query("select count(*)::integer as count from library.exercise_tags where exercise_id=$1", [ownId])).rows[0].count, 1);
});

test("a copy edit and grant revocation serialize without committing behind a 500 response", async () => {
  const admin = await makeLibraryAdmin("race-admin");
  const coach = await makeCoach("race-coach");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Race source" });
  const block = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: "Race block", exerciseIds: [systemId], userIds: [coach.userId] } });
  const copy = await api(`/api/exercises/${systemId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Race copy" } });
  const blocker = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await blocker.connect();
  await query(`create function library.pause_copy_test() returns trigger language plpgsql as $$ begin
    if new.name = 'Concurrent copy edit' then perform pg_advisory_xact_lock(77441199); end if; return new; end $$;
    create trigger pause_copy_test before update on library.exercises for each row execute function library.pause_copy_test()`);
  let editing;
  let revoking;
  try {
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(77441199)");
    editing = api(`/api/exercises/${copy.body.id}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Concurrent copy edit" } });
    const deadline = Date.now() + 1500;
    let paused = false;
    while (Date.now() < deadline) {
      paused = (await query("select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query ilike '%update library.exercises set%'")).rowCount > 0;
      if (paused) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(paused, true);
    revoking = api(`/api/exercise-collections/${block.body.collection.id}`, { method: "PATCH", cookie: admin.cookie,
      body: { name: "Race block", exerciseIds: [systemId], userIds: [], expectedRevision: 1 } });
    const revokeDeadline = Date.now() + 1500;
    let revokeWaiting = false;
    while (Date.now() < revokeDeadline) {
      revokeWaiting = (await query("select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query ilike '%pg_advisory_xact_lock(hashtextextended%'")).rowCount > 0;
      if (revokeWaiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(revokeWaiting, true);
    await blocker.query("commit");
    assert.equal((await editing).status, 200);
    assert.equal((await revoking).status, 200);
    assert.equal((await api(`/api/exercises/${copy.body.id}`, { cookie: coach.cookie })).status, 404);
    const hidden = await api("/api/exercises/visible-marked", { method: "POST", cookie: coach.cookie, body: { ids: [systemId, copy.body.id] } });
    assert.deepEqual(hidden.body.ids, []);
  } finally {
    await blocker.query("rollback");
    await blocker.end();
    await Promise.allSettled([editing, revoking].filter(Boolean));
    await query("drop trigger pause_copy_test on library.exercises; drop function library.pause_copy_test()");
  }
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// ------------------------------------------------------------
// Tests
// ------------------------------------------------------------

test("editing your own active exercise returns 200, and a fresh GET confirms the change was actually saved", async () => {
  const coach = await makeCoach("edit-own");
  const exerciseId = await makeExercise(coach.userId, { name: "Original name" });

  const res = await api(`/api/exercises/${exerciseId}`, {
    method: "PATCH",
    cookie: coach.cookie,
    body: { name: "Updated name", aim: "Updated aim", place: "Gym", complexity: "Intermediate" },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.name, "Updated name");

  const refetch = await api(`/api/exercises/${exerciseId}`, { cookie: coach.cookie });
  assert.equal(refetch.status, 200);
  assert.equal(refetch.body.name, "Updated name", "the edit must actually be persisted, not just echoed back in the PUT response");
  assert.equal(refetch.body.aim, "Updated aim");
  assert.equal(refetch.body.place, "Gym");
  assert.equal(refetch.body.complexity, "Intermediate");
});

test("editing someone else's PRIVATE exercise returns 404 and writes nothing - name unchanged, no lookup values created", async () => {
  const owner = await makeCoach("owner-private");
  const outsider = await makeCoach("outsider");
  const exerciseId = await makeExercise(owner.userId, { name: "Owner's private exercise", ownerScope: "user" });

  const res = await api(`/api/exercises/${exerciseId}`, {
    method: "PATCH",
    cookie: outsider.cookie,
    body: { name: "Hijacked name", place: "Sneaky new place" },
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);

  const row = (await query(`select name from library.exercises where id = $1`, [exerciseId])).rows[0];
  assert.equal(row.name, "Owner's private exercise", "a rejected edit must never change the row");

  const placeRow = (await query(`select count(*)::int as n from library.places where lower(name) = lower('Sneaky new place')`)).rows[0];
  assert.equal(placeRow.n, 0, "a rejected edit must never create a lookup value as a side effect - the existence/access check runs BEFORE any getOrCreateLookup call");
});

test("editing a NONEXISTENT exercise id returns 404, and creates nothing", async () => {
  const coach = await makeCoach("nonexistent");
  const fakeId = crypto.randomUUID();

  const res = await api(`/api/exercises/${fakeId}`, {
    method: "PATCH",
    cookie: coach.cookie,
    body: { name: "Should never be created", complexity: "Should never exist" },
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);

  const exerciseRow = (await query(`select count(*)::int as n from library.exercises where id = $1`, [fakeId])).rows[0];
  assert.equal(exerciseRow.n, 0);
  const complexityRow = (await query(`select count(*)::int as n from library.complexity_levels where lower(name) = lower('Should never exist')`)).rows[0];
  assert.equal(complexityRow.n, 0, "a 404 on a nonexistent id must never create a lookup value either");
});

test("editing your own INACTIVE (archived) exercise returns 404, and writes nothing", async () => {
  const coach = await makeCoach("inactive");
  const exerciseId = await makeExercise(coach.userId, { name: "Archived exercise", isActive: false });

  const res = await api(`/api/exercises/${exerciseId}`, {
    method: "PATCH",
    cookie: coach.cookie,
    body: { name: "Should never apply", startingPosition: "Should never exist" },
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status}: ${JSON.stringify(res.body)}`);

  const row = (await query(`select name, is_active from library.exercises where id = $1`, [exerciseId])).rows[0];
  assert.equal(row.name, "Archived exercise");
  assert.equal(row.is_active, false);
  const spRow = (await query(`select count(*)::int as n from library.starting_positions where lower(name) = lower('Should never exist')`)).rows[0];
  assert.equal(spRow.n, 0);
});

test("creating a new exercise still works end to end - real place/complexity/tag lookups get created and linked, and a fresh GET returns everything", async () => {
  const coach = await makeCoach("create-new");

  const res = await api("/api/exercises", {
    method: "POST",
    cookie: coach.cookie,
    body: {
      name: "Brand new exercise",
      aim: "Test the create path",
      place: "New Gym",
      complexity: "Beginner",
      startingPosition: "Standing",
      attractor: "Cone",
      purposes: ["Strength"],
      qualities: ["Power"],
      groups: ["Lower body"],
      bodyParts: ["Quadriceps"],
      movementPatterns: ["Squat"],
      tags: ["fixture-tag"],
    },
  });
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.name, "Brand new exercise");
  const newId = res.body.id;
  assert.ok(newId);

  const refetch = await api(`/api/exercises/${newId}`, { cookie: coach.cookie });
  assert.equal(refetch.status, 200);
  assert.equal(refetch.body.place, "New Gym");
  assert.equal(refetch.body.complexity, "Beginner");
  assert.equal(refetch.body.startingPosition, "Standing");
  assert.equal(refetch.body.attractor, "Cone");
  assert.deepEqual(refetch.body.purposes, ["Strength"]);
  assert.deepEqual(refetch.body.qualities, ["Power"]);
  assert.deepEqual(refetch.body.groups, ["Lower body"]);
  assert.deepEqual(refetch.body.bodyParts, ["Quadriceps"]);
  assert.deepEqual(refetch.body.movementPatterns, ["Squat"]);
  assert.deepEqual(refetch.body.tags, ["fixture-tag"]);

  const ownerRow = (await query(`select owner_scope, owner_user_id from library.exercises where id = $1`, [newId])).rows[0];
  assert.equal(ownerRow.owner_scope, "user");
  assert.equal(ownerRow.owner_user_id, coach.userId);
});

test("a subsequent edit of the SAME exercise after creation also succeeds (the exact Edit -> Save -> Save-again round trip)", async () => {
  const coach = await makeCoach("round-trip");
  const created = await api("/api/exercises", { method: "POST", cookie: coach.cookie, body: { name: "Round trip exercise" } });
  assert.equal(created.status, 201);
  const exerciseId = created.body.id;

  const firstEdit = await api(`/api/exercises/${exerciseId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Round trip exercise v2" } });
  assert.equal(firstEdit.status, 200, `expected 200, got ${firstEdit.status}: ${JSON.stringify(firstEdit.body)}`);

  const secondEdit = await api(`/api/exercises/${exerciseId}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Round trip exercise v3" } });
  assert.equal(secondEdit.status, 200, `expected 200, got ${secondEdit.status}: ${JSON.stringify(secondEdit.body)}`);

  const refetch = await api(`/api/exercises/${exerciseId}`, { cookie: coach.cookie });
  assert.equal(refetch.body.name, "Round trip exercise v3");
});
