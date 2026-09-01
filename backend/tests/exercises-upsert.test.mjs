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
// files. exercises.js reads/writes only pre-existing legacy schema (never
// anything migrations_v2 manages), so this file builds its own minimal
// raw schema directly and never touches migrate.js/the Strategy B runner
// at all.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import "dotenv/config";
import pg from "pg";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
if (!ORIGINAL_DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const baseUrl = new URL(ORIGINAL_DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const ADMIN_URL = adminUrl.toString();

function dbUrlFor(name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
}
function refuseForbidden(name, url) {
  if (name.toLowerCase() === "optimove" || /monitoring2/i.test(url)) {
    throw new Error("SAFETY: refusing to run against a forbidden database name");
  }
}

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

async function makeTempDb(label) {
  const name = `optimove_tests_exlib_${label}_${crypto.randomBytes(6).toString("hex")}`;
  const url = dbUrlFor(name);
  refuseForbidden(name, url);
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const cur = await admin.query("select current_database() as db");
  assert.equal(cur.rows[0].db, "postgres", "SAFETY: admin connection must be on the postgres database");
  await admin.query(`create database "${name}"`);
  await admin.end();
  return { name, url };
}
async function dropTempDb({ name }) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [name]);
  await admin.query(`drop database if exists "${name}"`);
  await admin.end();
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
