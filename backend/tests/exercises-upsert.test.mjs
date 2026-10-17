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

  create unique index exercises_exercise_code_unique on library.exercises (exercise_code) where exercise_code is not null;
  create unique index exercises_slug_unique on library.exercises (slug) where slug is not null;

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
    created_at timestamptz not null default now(), primary key (user_id, exercise_id)
  );
  create table library.filter_hidden (
    id uuid primary key default gen_random_uuid(), kind varchar not null, item_id uuid not null, user_id uuid not null references public.users(id),
    created_at timestamptz not null default now(), unique(kind,item_id,user_id)
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
  const { name = "Fixture exercise", isActive = true, ownerScope = "user", exerciseCode = null } = overrides;
  const result = await query(
    `insert into library.exercises (owner_scope, owner_user_id, created_by_user_id, name, slug, is_active, exercise_code)
     values ($1,$2,$2,$3,$4,$5,$6) returning id`,
    [ownerScope, ownerUserId, name, `fixture-${crypto.randomUUID()}`, isActive, exerciseCode],
  );
  return result.rows[0].id;
}

async function makeLibraryAdmin(label) {
  const admin = await makeCoach(label);
  await query("insert into public.user_global_roles (user_id,role) values ($1,'platform_admin')", [admin.userId]);
  return admin;
}

test("block catalog preserves grants, hides denied blocks and excludes restricted originals from Other", async () => {
  const admin = await makeLibraryAdmin("catalog-admin");
  const coach = await makeCoach("catalog-granted");
  const outsider = await makeCoach("catalog-denied");
  const system = await makeExercise(null, { ownerScope: "system", name: "Catalog restricted" });
  await query("update library.exercises set image_url=$2 where id=$1", [system,"https://example.test/original.jpg"]);
  const created = await api("/api/exercise-collections", { method: "POST",cookie: admin.cookie,
    body: { name: "Catalog hidden",description: "Description",exerciseIds: [system],userIds: [coach.userId] } });
  assert.equal(created.status,201,JSON.stringify(created.body));
  const block = created.body.collection;
  assert.equal(block.blockPreview,"hidden");
  assert.equal(block.accessAll,false);
  const allowed = await api("/api/exercise-collections/catalog?search=Catalog hidden",{cookie:coach.cookie});
  assert.equal(allowed.status,200);
  assert.equal(allowed.body.blocks.length,1);
  assert.equal(allowed.body.blocks[0].coverImageUrl,"https://example.test/original.jpg");
  assert.equal(allowed.body.blocks[0].exerciseCount,1);
  assert.equal(allowed.body.blocks[0].locked,false);
  assert.equal((await api("/api/exercise-collections/catalog?search=Catalog hidden",{cookie:outsider.cookie})).body.blocks.length,0);
  assert.equal((await api("/api/exercise-collections/locked-exercises?search=Catalog restricted",{cookie:outsider.cookie})).body.exercises.length,0);
  assert.equal((await api(`/api/exercises?collection=${block.id}`,{cookie:outsider.cookie})).body.exercises.length,0);
  assert.equal((await api("/api/exercises?collection=other&search=Catalog restricted",{cookie:coach.cookie})).body.exercises.length,0);
  assert.equal((await api(`/api/exercises/${system}`,{cookie:outsider.cookie})).status,404);
  assert.equal((await api(`/api/exercises/${system}/copy`,{method:"POST",cookie:outsider.cookie,body:{name:"Denied"}})).status,404);
  assert.equal((await api("/api/exercise-collections",{method:"POST",cookie:outsider.cookie,body:{name:"Denied",exerciseIds:[],userIds:[]}})).status,404);
  assert.equal((await api("/api/exercises?collection=bad",{cookie:coach.cookie})).status,400);
  // The catalog does not tell a coach whether a block is open to everyone.
  assert.equal(Object.hasOwn(allowed.body.blocks[0],"accessAll"),false);
  // A cover the database's check would refuse, or one carrying a user name
  // or password, is a 400 and nothing is saved - never an unknown outcome.
  for (const coverImageUrl of ["http:example.com","https:/example.com","https://user:secret@example.com/a.jpg","javascript:alert(1)"]) {
    const refused = await api(`/api/exercise-collections/${block.id}`,{method:"PATCH",cookie:admin.cookie,body:{name:block.name,exerciseIds:[system],userIds:[coach.userId],expectedRevision:block.revision,coverImageUrl}});
    assert.equal(refused.status,400,coverImageUrl);
    assert.equal(refused.body.error,"invalidBody");
  }
  assert.equal((await query("select cover_image_url from library.exercise_collections where id=$1",[block.id])).rows[0].cover_image_url,"");
});

test("a card without its own cover gets up to ten of its exercises' pictures, only what the coach could open from it", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("slides-admin");
  const coach = await makeCoach("slides-coach");
  const outsider = await makeCoach("slides-outsider");
  const named = async (suffix, media = {}) => {
    const id = await makeExercise(null, { ownerScope: "system", name: `Slides ${tag} ${suffix}` });
    await query("update library.exercises set image_url=$2,video_url=$3 where id=$1", [id, media.image ?? null, media.video ?? null]);
    return id;
  };
  const picture = (suffix) => `https://example.test/slide-${tag}-${suffix}.jpg`;
  const ids = [];
  for (const suffix of ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]) ids.push(await named(suffix, { image: picture(suffix) }));
  const bare = await named("00 bare");
  const blank = await named("00 blank", { image: "", video: "" });
  const video = await named("01 video", { video: "https://www.youtube.com/watch?v=abcdefghijk" });
  // A link the page takes no picture from never takes a picture's place: a
  // video elsewhere, a YouTube playlist, a Drive folder, an image of spaces.
  const noPicture = [
    await named("00 vimeo", { video: "https://vimeo.com/123456" }),
    await named("00 playlist", { video: "https://www.youtube.com/playlist?list=PLx" }),
    await named("00 folder", { video: "https://drive.google.com/drive/folders/abc" }),
    await named("00 spaces", { image: "   " }),
  ];
  const drive = await named("01 drive", { video: "https://drive.google.com/file/d/DriveFile123/view" });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Slides block ${tag}`, exerciseIds: [...ids, bare, blank, video, drive, ...noPicture], userIds: [coach.userId], blockPreview: "locked" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // Hidden by this coach, or archived: not on the coach's card.
  await query("insert into library.filter_hidden (kind,item_id,user_id) values ('exercise',$1,$2)", [ids[2], coach.userId]);
  await query("update library.exercises set is_active=false where id=$1", [ids[3]]);
  // Named to sort first among every exercise outside a block in this database.
  const unassigned = await makeExercise(null, { ownerScope: "system", name: `000 slides other ${tag}` });
  await query("update library.exercises set image_url=$2 where id=$1", [unassigned, picture("other")]);
  // Another coach's private exercise: never on anyone else's Other, an
  // administrator's included.
  const foreign = await makeCoach("slides-foreign");
  const foreignPrivate = await makeExercise(foreign.userId, { name: `000 slides foreign ${tag}` });
  await query("update library.exercises set image_url=$2,video_url=$3 where id=$1", [foreignPrivate, picture("foreign"), "https://youtu.be/zyxwvutsrqp"]);
  const catalog = async (cookie) => (await api(`/api/exercise-collections/catalog?search=Slides block ${tag}`, { cookie })).body;
  try {
    const granted = await catalog(coach.cookie);
    assert.deepEqual(granted.blocks[0].coverSlides, [
      { imageUrl: picture("00"), videoUrl: "" },
      { imageUrl: picture("01"), videoUrl: "" },
      { imageUrl: "", videoUrl: "https://drive.google.com/file/d/DriveFile123/view" },
      { imageUrl: "", videoUrl: "https://www.youtube.com/watch?v=abcdefghijk" },
      ...["04", "05", "06", "07", "08", "09"].map((suffix) => ({ imageUrl: picture(suffix), videoUrl: "" })),
    ]);
    // The single cover stays what it was: the first exercise's own image.
    assert.equal(granted.blocks[0].coverImageUrl, picture("00"));
    // Other holds the exercise outside every block, never one of this block's.
    assert.ok(granted.other.coverSlides.some((slide) => slide.imageUrl === picture("other")));
    assert.equal(granted.other.coverSlides.some((slide) => slide.imageUrl.includes(`slide-${tag}-`) && slide.imageUrl !== picture("other")), false);
    assert.ok(granted.other.coverSlides.length <= 10);
    const adminView = await catalog(admin.cookie);
    assert.equal(adminView.blocks[0].coverSlides.length, 10);
    assert.ok(adminView.blocks[0].coverSlides.some((slide) => slide.imageUrl === picture("02")));

    // A locked card shows no exercise's media at all.
    const locked = await catalog(outsider.cookie);
    assert.equal(locked.blocks[0].locked, true);
    assert.deepEqual(locked.blocks[0].coverSlides, []);
    // Nowhere in the outsider's catalog, Other included.
    const blockPicture = new RegExp(`slide-${tag}-\\d`);
    assert.equal(blockPicture.test(JSON.stringify(locked)), false);
    assert.equal(JSON.stringify(locked).includes("abcdefghijk"), false);

    // The block's own cover replaces the exercises' pictures.
    const block = created.body.collection;
    const covered = await api(`/api/exercise-collections/${block.id}`, { method: "PATCH", cookie: admin.cookie,
      body: { name: block.name, exerciseIds: [...ids.filter((id) => id !== ids[3]), bare, blank, video, drive, ...noPicture], userIds: [coach.userId], expectedRevision: block.revision, coverImageUrl: "https://example.test/own-cover.jpg" } });
    assert.equal(covered.status, 200, JSON.stringify(covered.body));
    const afterCover = await catalog(coach.cookie);
    assert.deepEqual(afterCover.blocks[0].coverSlides, []);
    assert.equal(afterCover.blocks[0].coverImageUrl, "https://example.test/own-cover.jpg");

    for (const [who, cookie] of [["coach", coach.cookie], ["outsider", outsider.cookie], ["admin", admin.cookie]]) {
      const body = JSON.stringify(await catalog(cookie));
      assert.equal(body.includes(picture("foreign")) || body.includes("zyxwvutsrqp"), false, who);
    }
    assert.ok((await catalog(foreign.cookie)).other.coverSlides.some((slide) => slide.imageUrl === picture("foreign")));
    // An administrator outside the platform workspace is a coach here: the
    // block's pictures are not theirs to see. Back on its own cover-less
    // state the locked block still carries no exercise media for them.
    const uncovered = await api(`/api/exercise-collections/${block.id}`, { method: "PATCH", cookie: admin.cookie,
      body: { name: block.name, exerciseIds: [...ids.filter((id) => id !== ids[3]), bare, blank, video, drive, ...noPicture], userIds: [coach.userId], expectedRevision: covered.body.collection.revision, coverImageUrl: "" } });
    assert.equal(uncovered.status, 200, JSON.stringify(uncovered.body));
    assert.equal((await catalog(coach.cookie)).blocks[0].coverSlides.length, 10);
    await query("insert into public.user_global_roles (user_id,role) values ($1,'independent_coach')", [admin.userId]);
    assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: { type: "private_coach" } })).status, 200);
    const adminAsCoach = await catalog(admin.cookie);
    assert.equal(adminAsCoach.blocks[0].locked, true);
    assert.deepEqual(adminAsCoach.blocks[0].coverSlides, []);
    assert.equal(blockPicture.test(JSON.stringify(adminAsCoach)) || JSON.stringify(adminAsCoach).includes("abcdefghijk"), false);
  } finally {
    await query("update library.exercises set is_active=false where id = any($1::uuid[])", [[unassigned, foreignPrivate]]);
  }
});

test("an open block lists exactly its exercises with the coach's own copies, and Other exactly what no block holds", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("block-list-admin");
  const coach = await makeCoach("block-list-coach");
  const a1 = await makeExercise(null, { ownerScope: "system", name: `Block A one ${tag}` });
  const b1 = await makeExercise(null, { ownerScope: "system", name: `Block B one ${tag}` });
  const u1 = await makeExercise(null, { ownerScope: "system", name: `Unassigned one ${tag}` });
  const blockA = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `A ${tag}`, exerciseIds: [a1], userIds: [coach.userId] } });
  const blockB = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `B ${tag}`, exerciseIds: [b1], userIds: [coach.userId] } });
  assert.equal(blockA.status, 201, JSON.stringify(blockA.body));
  assert.equal(blockB.status, 201, JSON.stringify(blockB.body));
  const copy = await api(`/api/exercises/${a1}/copy`, { method: "POST", cookie: coach.cookie, body: { name: `Block A copy ${tag}` } });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  const own = await api("/api/exercises", { method: "POST", cookie: coach.cookie, body: { name: `Own private ${tag}` } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const ids = async (query) => {
    const res = await api(`/api/exercises?search=${tag}&limit=100&${query}`, { cookie: coach.cookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return new Set(res.body.exercises.map((exercise) => exercise.id));
  };
  assert.deepEqual(await ids(`collection=${blockA.body.collection.id}`), new Set([a1, copy.body.id]));
  assert.deepEqual(await ids(`collection=${blockB.body.collection.id}`), new Set([b1]));
  assert.deepEqual(await ids("collection=other"), new Set([u1, own.body.id]));
  assert.deepEqual(await ids(""), new Set([a1, b1, u1, copy.body.id, own.body.id]));
});

test("deleting a block returns its exercises to Other for every coach, removes its grants, keeps its audit and is final", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("block-delete-admin");
  const coach = await makeCoach("block-delete-granted");
  const outsider = await makeCoach("block-delete-outsider");
  const system = await makeExercise(null, { ownerScope: "system", name: `Deleted block exercise ${tag}` });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Deleted block ${tag}`, exerciseIds: [system], userIds: [coach.userId] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const block = created.body.collection;
  const copy = await api(`/api/exercises/${system}/copy`, { method: "POST", cookie: coach.cookie, body: { name: `Deleted block copy ${tag}` } });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  const otherIds = async (user) => {
    const res = await api(`/api/exercises?search=${tag}&limit=100&collection=other`, { cookie: user.cookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return new Set(res.body.exercises.map((exercise) => exercise.id));
  };
  assert.equal((await api(`/api/exercises/${system}`, { cookie: outsider.cookie })).status, 404);
  assert.deepEqual(await otherIds(outsider), new Set());
  const remove = (body, cookie = admin.cookie) => api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie, body });
  // Only a block administrator, with the revision the editor showed.
  assert.equal((await remove({ expectedRevision: block.revision }, coach.cookie)).status, 404);
  assert.equal((await remove({})).status, 400);
  assert.equal((await api("/api/exercise-collections/not-a-block", { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: 1 } })).status, 400);
  const stale = await remove({ expectedRevision: block.revision + 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "staleRevision");
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_items where collection_id=$1", [block.id])).rows[0].count, 1);
  const deleted = await remove({ expectedRevision: block.revision });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.deepEqual(deleted.body.deleted, { id: block.id, name: `Deleted block ${tag}`, deleted: true, exerciseCount: 1, userCount: 1 });
  // The exercise is in Other, for a coach who never had the block too.
  assert.equal((await api(`/api/exercises/${system}`, { cookie: outsider.cookie })).status, 200);
  assert.deepEqual(await otherIds(outsider), new Set([system]));
  assert.deepEqual(await otherIds(coach), new Set([system, copy.body.id]));
  // Gone from every list, for good; a repeat or an edit is the same 404.
  assert.equal((await api(`/api/exercise-collections/catalog?search=${tag}`, { cookie: admin.cookie })).body.blocks.length, 0);
  assert.equal((await api("/api/exercise-collections", { cookie: admin.cookie })).body.collections.some((item) => item.id === block.id), false);
  const again = await remove({ expectedRevision: block.revision + 1 });
  assert.equal(again.status, 404);
  assert.equal(again.body.error, "notFound");
  const patched = await api(`/api/exercise-collections/${block.id}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Revived", exerciseIds: [], userIds: [], expectedRevision: block.revision + 1 } });
  assert.equal(patched.status, 404);
  const row = (await query("select deleted_at,deleted_by_user_id,name,revision from library.exercise_collections where id=$1", [block.id])).rows[0];
  assert.ok(row.deleted_at);
  assert.equal(row.deleted_by_user_id, admin.userId);
  assert.equal(row.name, `Deleted block ${tag}`);
  assert.equal(row.revision, block.revision + 1);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_users where collection_id=$1", [block.id])).rows[0].count, 0);
  const audit = (await query("select actor_user_id,before_state,after_state from library.exercise_collection_audit where collection_id=$1 order by created_at desc, id limit 1", [block.id])).rows[0];
  assert.equal(audit.actor_user_id, admin.userId);
  assert.equal(audit.after_state.deleted, true);
  assert.deepEqual(audit.before_state.exercises.map((item) => item.id), [system]);
  assert.deepEqual(audit.before_state.users.map((item) => item.id), [coach.userId]);
  // The database keeps a deleted block final, whoever writes.
  await assert.rejects(query("insert into library.exercise_collection_items (collection_id,exercise_id) values ($1,$2)", [block.id, system]), /exercise block is deleted/);
  await assert.rejects(query("insert into library.exercise_collection_users (collection_id,user_id) values ($1,$2)", [block.id, coach.userId]), /exercise block is deleted/);
  await assert.rejects(query("update library.exercise_collections set name='Revived' where id=$1", [block.id]), /final/);
  // The exercise is free for another block.
  const reused = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Next block ${tag}`, exerciseIds: [system], userIds: [] } });
  assert.equal(reused.status, 201, JSON.stringify(reused.body));
  // A deleted block answers exactly like one that never existed.
  const missing = await api(`/api/exercise-collections/${crypto.randomUUID()}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: 1 } });
  assert.equal(missing.status, again.status);
  assert.deepEqual(missing.body, again.body);
  // A platform admin outside the platform workspace gets the same 404, and nothing changes.
  await query("insert into public.user_global_roles (user_id,role) values ($1,'independent_coach')", [admin.userId]);
  assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: { type: "private_coach" } })).status, 200);
  const outside = await api(`/api/exercise-collections/${reused.body.collection.id}`, { method: "DELETE", cookie: admin.cookie,
    body: { expectedRevision: reused.body.collection.revision } });
  assert.equal(outside.status, 404);
  assert.deepEqual(outside.body, again.body);
  assert.equal((await query("select deleted_at from library.exercise_collections where id=$1", [reused.body.collection.id])).rows[0].deleted_at, null);
});

test("a block delete whose COMMIT fails is never 'not deleted': 503 outcomeUnknown when nothing was written, 200 when the check finds it", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("block-commit-admin");
  const system = await makeExercise(null, { ownerScope: "system", name: `Commit block exercise ${tag}` });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Commit block ${tag}`, exerciseIds: [system], userIds: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const block = created.body.collection;
  // 1. The COMMIT itself is refused (a deferred check): nothing is written, and the answer says unknown.
  await query(`create function library.test_refuse_block_delete() returns trigger language plpgsql as $$
    begin if new.after_state->>'name' = '${`Commit block ${tag}`}' and new.after_state->>'deleted' = 'true' then
      raise exception 'test: commit refused'; end if; return new; end $$`);
  await query(`create constraint trigger test_refuse_block_delete after insert on library.exercise_collection_audit
    deferrable initially deferred for each row execute function library.test_refuse_block_delete()`);
  try {
    const refused = await api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: block.revision } });
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: "outcomeUnknown" });
  } finally {
    await query("drop trigger test_refuse_block_delete on library.exercise_collection_audit");
    await query("drop function library.test_refuse_block_delete()");
  }
  assert.equal((await query("select deleted_at from library.exercise_collections where id=$1", [block.id])).rows[0].deleted_at, null);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_items where collection_id=$1", [block.id])).rows[0].count, 1);
  // 2. The COMMIT lands but its answer is lost: the check on another connection finds the delete.
  const original = pool.connect;
  pool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    pool.connect = original;
    return original.call(this).then((client) => {
      const send = client.query.bind(client);
      client.query = async (...args) => {
        const result = await send(...args);
        if (args[0] === "commit") { client.query = send; throw new Error("test: COMMIT answer lost"); }
        return result;
      };
      return client;
    });
  };
  let lost;
  try {
    lost = await api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: block.revision } });
  } finally { pool.connect = original; }
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.equal(lost.body.verifiedAfterCommitError, true);
  assert.equal(lost.body.deleted.id, block.id);
  assert.ok((await query("select deleted_at from library.exercise_collections where id=$1", [block.id])).rows[0].deleted_at);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_audit where collection_id=$1 and after_state->>'deleted'='true'", [block.id])).rows[0].count, 1);
});

test("a block write whose session the server ends mid-transaction answers, and the server keeps running", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("block-session-admin");
  const system = await makeExercise(null, { ownerScope: "system", name: `Session block exercise ${tag}` });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Session block ${tag}`, exerciseIds: [system], userIds: [] } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const block = created.body.collection;
  // The server ends the session while the transaction is idle (what the 15 s
  // idle bound or a pooler reset does): pg emits 'error' with no query in flight.
  const original = pool.connect;
  pool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    pool.connect = original;
    return original.call(this).then((client) => {
      const send = client.query.bind(client);
      client.query = async (...args) => {
        const result = await send(...args);
        if (String(args[0]).startsWith("set local idle_in_transaction_session_timeout")) {
          client.query = send;
          await adminClient.query("select pg_terminate_backend($1)", [client.processID]);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return result;
      };
      return client;
    });
  };
  let ended;
  try {
    ended = await api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: block.revision } });
  } finally { pool.connect = original; }
  assert.ok(ended.status >= 500, JSON.stringify(ended.body));
  assert.equal(ended.body.error, "internalError");
  assert.equal((await query("select deleted_at from library.exercise_collections where id=$1", [block.id])).rows[0].deleted_at, null);
  // Still serving: the same delete now succeeds.
  const again = await api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: block.revision } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test("a move whose COMMIT fails is never 'not moved': 503 outcomeUnknown when nothing landed, 200 when the check finds it", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("move-commit-admin");
  const system = await makeExercise(null, { ownerScope: "system", name: `Move commit exercise ${tag}` });
  const from = (await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `Move from ${tag}`, exerciseIds: [system], userIds: [] } })).body.collection;
  const to = (await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `Move to ${tag}`, exerciseIds: [], userIds: [] } })).body.collection;
  const move = () => api(`/api/exercise-collections/exercise-block/${system}`, { method: "PUT", cookie: admin.cookie, body: { collectionId: to.id, expectedCollectionId: from.id } });
  const home = async () => (await query("select collection_id from library.exercise_collection_items where exercise_id=$1", [system])).rows.map((row) => row.collection_id);
  // 1. The COMMIT itself is refused (a deferred check on the target's audit row): nothing moved, the answer says unknown.
  await query(`create function library.test_refuse_move() returns trigger language plpgsql as $$
    begin if new.collection_id = '${to.id}'::uuid then raise exception 'test: commit refused'; end if; return new; end $$`);
  await query(`create constraint trigger test_refuse_move after insert on library.exercise_collection_audit
    deferrable initially deferred for each row execute function library.test_refuse_move()`);
  try {
    const refused = await move();
    assert.equal(refused.status, 503, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: "outcomeUnknown" });
  } finally {
    await query("drop trigger test_refuse_move on library.exercise_collection_audit");
    await query("drop function library.test_refuse_move()");
  }
  assert.deepEqual(await home(), [from.id]);
  // 2. The COMMIT lands but its answer is lost: the check on another connection finds the move.
  const original = pool.connect;
  pool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    pool.connect = original;
    return original.call(this).then((client) => {
      const send = client.query.bind(client);
      client.query = async (...args) => {
        const result = await send(...args);
        if (args[0] === "commit") { client.query = send; throw new Error("test: COMMIT answer lost"); }
        return result;
      };
      return client;
    });
  };
  let lost;
  try { lost = await move(); } finally { pool.connect = original; }
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.deepEqual(lost.body, { exerciseId: system, collectionId: to.id, changed: true, verifiedAfterCommitError: true });
  assert.deepEqual(await home(), [to.id]);
  // The retry after the lost answer writes nothing more.
  const retry = await move();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.changed, false);
});

test("a move to Other whose COMMIT answer is lost is found by the check; a move and a delete of its block sent together stay consistent", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("move-other-admin");
  const system = await makeExercise(null, { ownerScope: "system", name: `Move other exercise ${tag}` });
  const from = (await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `Move other from ${tag}`, exerciseIds: [system], userIds: [] } })).body.collection;
  const home = async () => (await query("select collection_id from library.exercise_collection_items where exercise_id=$1", [system])).rows.map((row) => row.collection_id);
  const original = pool.connect;
  pool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    pool.connect = original;
    return original.call(this).then((client) => {
      const send = client.query.bind(client);
      client.query = async (...args) => {
        const result = await send(...args);
        if (args[0] === "commit") { client.query = send; throw new Error("test: COMMIT answer lost"); }
        return result;
      };
      return client;
    });
  };
  let lost;
  try {
    lost = await api(`/api/exercise-collections/exercise-block/${system}`, { method: "PUT", cookie: admin.cookie, body: { collectionId: null, expectedCollectionId: from.id } });
  } finally { pool.connect = original; }
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  assert.deepEqual(lost.body, { exerciseId: system, collectionId: null, changed: true, verifiedAfterCommitError: true });
  assert.deepEqual(await home(), []);
  // Into a block while that block is deleted: one of them wins, never both.
  const target = (await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie, body: { name: `Move race ${tag}`, exerciseIds: [], userIds: [] } })).body.collection;
  const [moved, deleted] = await Promise.all([
    api(`/api/exercise-collections/exercise-block/${system}`, { method: "PUT", cookie: admin.cookie, body: { collectionId: target.id, expectedCollectionId: null } }),
    api(`/api/exercise-collections/${target.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: target.revision } }),
  ]);
  const row = (await query("select deleted_at from library.exercise_collections where id=$1", [target.id])).rows[0];
  if (moved.status === 200) {
    // The move went first: the delete saw a changed block and refused, the exercise stays in it.
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
    assert.equal(row.deleted_at, null);
    assert.deepEqual(await home(), [target.id]);
  } else {
    // The delete went first: the block is gone and the move found no live block.
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(moved.status, 409);
    assert.equal(moved.body.error, "blockNotAvailable");
    assert.ok(row.deleted_at);
    assert.deepEqual(await home(), []);
  }
});

test("a block save and a block delete sent together end in one consistent state", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("block-race-admin");
  const system = await makeExercise(null, { ownerScope: "system", name: `Race block exercise ${tag}` });
  const created = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Race block ${tag}`, exerciseIds: [system], userIds: [] } });
  const block = created.body.collection;
  const [saved, deleted] = await Promise.all([
    api(`/api/exercise-collections/${block.id}`, { method: "PATCH", cookie: admin.cookie,
      body: { name: `Race renamed ${tag}`, exerciseIds: [system], userIds: [], expectedRevision: block.revision } }),
    api(`/api/exercise-collections/${block.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: block.revision } }),
  ]);
  const row = (await query("select name,deleted_at from library.exercise_collections where id=$1", [block.id])).rows[0];
  const items = (await query("select count(*)::integer as count from library.exercise_collection_items where collection_id=$1", [block.id])).rows[0].count;
  if (deleted.status === 200) {
    assert.ok([404, 409].includes(saved.status), JSON.stringify(saved.body));
    assert.ok(row.deleted_at);
    assert.equal(items, 0);
  } else {
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(deleted.status, 409);
    assert.equal(deleted.body.error, "staleRevision");
    assert.equal(row.deleted_at, null);
    assert.equal(row.name, `Race renamed ${tag}`);
    assert.equal(items, 1);
  }
});

test("the administrator moves one exercise between blocks and Other; access follows, both blocks are revised and audited", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const admin = await makeLibraryAdmin("move-admin");
  const granted = await makeCoach("move-granted");
  const outsider = await makeCoach("move-outsider");
  const system = await makeExercise(null, { ownerScope: "system", name: `Move exercise ${tag}` });
  const restricted = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Move restricted ${tag}`, exerciseIds: [], userIds: [granted.userId] } });
  const open = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: `Move open ${tag}`, exerciseIds: [], userIds: [], accessAll: true } });
  assert.equal(restricted.status, 201);
  assert.equal(open.status, 201);
  const A = restricted.body.collection;
  const B = open.body.collection;
  const path = `/api/exercise-collections/exercise-block/${system}`;
  const move = (collectionId, expectedCollectionId, cookie = admin.cookie) => api(path, { method: "PUT", cookie, body: { collectionId, expectedCollectionId } });
  const revision = async (id) => (await query("select revision from library.exercise_collections where id=$1", [id])).rows[0].revision;
  // Only the administrator reads or moves; everyone else gets the same 404.
  assert.equal((await api(path, { cookie: outsider.cookie })).status, 404);
  assert.equal((await move(A.id, null, outsider.cookie)).status, 404);
  assert.equal((await api("/api/exercise-collections/exercise-block/not-an-id", { cookie: admin.cookie })).status, 400);
  assert.equal((await api(path, { method: "PUT", cookie: admin.cookie, body: { collectionId: "x", expectedCollectionId: null } })).status, 400);
  // A missing key never means "Other".
  assert.equal((await api(path, { method: "PUT", cookie: admin.cookie, body: { expectedCollectionId: null } })).status, 400);
  assert.equal((await api(path, { method: "PUT", cookie: admin.cookie, body: { collectionId: A.id } })).status, 400);
  const shown = await api(path, { cookie: admin.cookie });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.exerciseName, `Move exercise ${tag}`);
  assert.equal(shown.body.movable, true);
  assert.equal(shown.body.current, null);
  assert.ok(shown.body.blocks.some((block) => block.id === A.id) && shown.body.blocks.some((block) => block.id === B.id && block.accessAll === true));
  // Other -> a restricted block: the outsider loses it, the granted coach keeps it.
  assert.equal((await api(`/api/exercises/${system}`, { cookie: outsider.cookie })).status, 200);
  const intoA = await move(A.id.toUpperCase(), null);
  assert.equal(intoA.status, 200, JSON.stringify(intoA.body));
  assert.deepEqual(intoA.body, { exerciseId: system, collectionId: A.id, changed: true });
  assert.equal((await api(`/api/exercises/${system}`, { cookie: outsider.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: granted.cookie })).status, 200);
  assert.equal(await revision(A.id), A.revision + 1);
  assert.deepEqual((await api(path, { cookie: admin.cookie })).body.current, { id: A.id, name: A.name });
  // A repeat of a move already made is the same answer, with nothing written.
  const repeat = await move(A.id, null);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.changed, false);
  assert.equal(await revision(A.id), A.revision + 1);
  // A block that changed elsewhere: the exercise is not where the screen showed it.
  const stale = await move(B.id, null);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "staleRevision");
  // The editor that loaded A before the move now sees A changed.
  const editor = await api(`/api/exercise-collections/${A.id}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: A.name, exerciseIds: [], userIds: [granted.userId], expectedRevision: A.revision } });
  assert.equal(editor.status, 409);
  assert.equal(editor.body.error, "staleRevision");
  // Block -> block, then -> Other: both blocks revised, every move audited per block.
  const auditCount = async (id) => (await query("select count(*)::integer as count from library.exercise_collection_audit where collection_id=$1", [id])).rows[0].count;
  const auditsA = await auditCount(A.id);
  const auditsB = await auditCount(B.id);
  const intoB = await move(B.id, A.id.toUpperCase());
  assert.equal(intoB.status, 200, JSON.stringify(intoB.body));
  assert.equal(await revision(A.id), A.revision + 2);
  assert.equal(await revision(B.id), B.revision + 1);
  assert.equal(await auditCount(A.id), auditsA + 1);
  assert.equal(await auditCount(B.id), auditsB + 1);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: outsider.cookie })).status, 200, "an open block is open to everyone");
  const last = (await query("select actor_user_id,before_state,after_state from library.exercise_collection_audit where collection_id=$1 order by created_at desc,id limit 1", [A.id])).rows[0];
  assert.equal(last.actor_user_id, admin.userId);
  assert.deepEqual(last.before_state.exercises.map((item) => item.id), [system]);
  assert.deepEqual(last.after_state.exercises, []);
  const toOther = await move(null, B.id);
  assert.equal(toOther.status, 200);
  assert.equal((await query("select count(*)::integer as count from library.exercise_collection_items where exercise_id=$1", [system])).rows[0].count, 0);
  // A deleted block is not a destination; a private exercise is not movable.
  const deleted = await api(`/api/exercise-collections/${A.id}`, { method: "DELETE", cookie: admin.cookie, body: { expectedRevision: await revision(A.id) } });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  const gone = await move(A.id, null);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.error, "blockNotAvailable");
  assert.equal((await api(path, { cookie: admin.cookie })).body.blocks.some((block) => block.id === A.id), false);
  const own = await makeExercise(granted.userId, { name: `Move private ${tag}` });
  const privateMove = await api(`/api/exercise-collections/exercise-block/${own}`, { method: "PUT", cookie: admin.cookie, body: { collectionId: B.id, expectedCollectionId: null } });
  assert.equal(privateMove.status, 400);
  assert.equal(privateMove.body.error, "invalidSelection");
  assert.equal((await api(`/api/exercise-collections/exercise-block/${own}`, { cookie: admin.cookie })).body.movable, false);
});

test("locked previews expose no exercise media, instructions, grants or usable exercise; all-users remains explicit", async () => {
  const admin = await makeLibraryAdmin("locked-admin");
  const outsider = await makeCoach("locked-denied");
  const system = await makeExercise(null, {ownerScope:"system",name:"Locked visible title"});
  await query("update library.exercises set image_url=$2,video_url=$3,instruction='Secret instruction' where id=$1",
    [system,"https://example.test/secret-image.jpg","https://example.test/secret-video"]);
  const created = await api("/api/exercise-collections",{method:"POST",cookie:admin.cookie,body:{name:"Locked package",exerciseIds:[system],userIds:[],blockPreview:"locked",exercisePreview:"locked"}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  let block=created.body.collection;
  const catalog=await api("/api/exercise-collections/catalog?search=Locked package",{cookie:outsider.cookie});
  assert.equal(catalog.body.blocks[0].locked,true);
  assert.equal(catalog.body.blocks[0].coverImageUrl,"");
  const previews=await api("/api/exercise-collections/locked-exercises?search=Locked visible title",{cookie:outsider.cookie});
  assert.deepEqual(Object.keys(previews.body.exercises[0]).sort(),["blockName","id","name"]);
  assert.equal(JSON.stringify([catalog.body,previews.body]).includes("secret-"),false);
  const mainList=await api("/api/exercises?search=Locked visible title&lockedPreviews=1",{cookie:outsider.cookie});
  assert.equal(mainList.body.exercises.length,0);
  assert.equal(mainList.body.lockedPreviews.length,1);
  // Only the Exercise Library asks for previews, and only for its first page
  // (it pages by limit): the Builder's search (no opt-in, offset paging)
  // runs no second query and gets none.
  assert.deepEqual((await api("/api/exercises?search=Locked visible title",{cookie:outsider.cookie})).body.lockedPreviews,[]);
  assert.deepEqual((await api("/api/exercises?search=Locked visible title&lockedPreviews=1&offset=18",{cookie:outsider.cookie})).body.lockedPreviews,[]);
  assert.equal((await api("/api/exercises?search=Locked visible title&offset=invalid",{cookie:outsider.cookie})).status,200);
  assert.equal((await api(`/api/exercises/${system}`,{cookie:outsider.cookie})).status,404);
  const update=async (body)=>api(`/api/exercise-collections/${block.id}`,{method:"PATCH",cookie:admin.cookie,body:{name:block.name,exerciseIds:[system],userIds:[],expectedRevision:block.revision,...body}});
  const hideBlock=await update({blockPreview:"hidden"});
  block=hideBlock.body.collection;
  assert.equal((await api("/api/exercise-collections/catalog?search=Locked package",{cookie:outsider.cookie})).body.blocks.length,0);
  assert.equal((await api("/api/exercise-collections/locked-exercises?search=Locked visible title",{cookie:outsider.cookie})).body.exercises.length,1);
  assert.equal((await api("/api/exercise-collections/locked-exercises?search=Locked visible title",{cookie:outsider.cookie})).body.exercises[0].blockName,null);
  const hideExercises=await update({blockPreview:"locked",exercisePreview:"hidden"});
  block=hideExercises.body.collection;
  assert.equal((await api("/api/exercise-collections/catalog?search=Locked package",{cookie:outsider.cookie})).body.blocks.length,1);
  assert.equal((await api("/api/exercise-collections/locked-exercises?search=Locked visible title",{cookie:outsider.cookie})).body.exercises.length,0);
  const publicResult=await update({accessAll:true,coverImageUrl:"https://example.test/public-cover.jpg",description:"Public presentation"});
  assert.equal(publicResult.status,200,JSON.stringify(publicResult.body));
  block=publicResult.body.collection;
  const future=await makeCoach("locked-future");
  assert.equal((await api(`/api/exercises/${system}`,{cookie:future.cookie})).status,200);
  const copied=await api(`/api/exercises/${system}/copy`,{method:"POST",cookie:future.cookie,body:{name:"Catalog personal copy"}});
  assert.equal(copied.status,201);
  const legacyUpdate=await update({});
  assert.equal(legacyUpdate.body.collection.accessAll,true);
  assert.equal(legacyUpdate.body.collection.description,"Public presentation");
  assert.equal(legacyUpdate.body.collection.coverImageUrl,"https://example.test/public-cover.jpg");
  block=legacyUpdate.body.collection;
  assert.equal((await update({coverImageUrl:"javascript:alert(1)"})).status,400);
  assert.equal((await update({blockPreview:"public"})).status,400);
  const revoked=await update({accessAll:false,blockPreview:"hidden",exercisePreview:"hidden"});
  assert.equal(revoked.status,200);
  assert.equal((await api(`/api/exercises/${copied.body.id}`,{cookie:future.cookie})).status,404);
  assert.equal((await api(`/api/exercises/${system}`,{cookie:future.cookie})).status,404);
  assert.equal((await query("select image_url,video_url from library.exercises where id=$1",[system])).rows[0].image_url,"https://example.test/secret-image.jpg");
});

test("admin capabilities require the selected platform workspace, not just a global role", async () => {
  const admin = await makeLibraryAdmin("workspace-admin");
  const other = await makeCoach("workspace-other");
  const system = await makeExercise(null, { ownerScope: "system" });
  const privateId = await makeExercise(other.userId);
  await query("insert into public.user_global_roles (user_id,role) values ($1,'independent_coach')", [admin.userId]);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: admin.cookie })).body.canEdit, true);
  assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: { type: "private_coach" } })).status, 200);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: admin.cookie })).body.canEdit, false);
  assert.equal((await api(`/api/exercises/${system}`, { method: "PATCH", cookie: admin.cookie, body: { name: "Denied" } })).status, 403);
  assert.equal((await api(`/api/exercises/${privateId}`, { cookie: admin.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${privateId}/copy`, { method: "POST", cookie: admin.cookie, body: { name: "Denied" } })).status, 404);
  assert.equal((await api(`/api/exercises/${privateId}/archive`, { method: "POST", cookie: admin.cookie })).status, 404);
  assert.equal((await api("/api/exercise-collections", { cookie: admin.cookie })).status, 404);
  assert.equal((await api("/api/exercises/owners?search=workspace", { cookie: admin.cookie })).status, 403);
  assert.equal((await api("/api/exercises/options", { cookie: admin.cookie })).body.owners, undefined);
  const ownCopy = await api(`/api/exercises/${system}/copy`, { method: "POST", cookie: admin.cookie, body: { name: "Private coaching copy" } });
  assert.equal(ownCopy.status, 201);
  assert.equal((await api(`/api/exercises/${ownCopy.body.id}`, { method: "PATCH", cookie: admin.cookie, body: { name: "Own edit remains allowed" } })).status, 200);
  assert.equal((await api(`/api/exercises/${ownCopy.body.id}/permanent`, { method: "DELETE", cookie: admin.cookie })).status, 200);
  assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: { type: "club", scopeId: admin.clubId } })).status, 200);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: admin.cookie })).body.canEdit, false);
  const team = (await query("insert into public.teams (name,club_id) values ('Workspace test team',$1) returning id", [admin.clubId])).rows[0].id;
  await query("insert into public.user_team_roles (user_id,team_id,role,is_active) values ($1,$2,'team_coach',true)", [admin.userId, team]);
  await query("insert into public.athletes (id,user_id) values (gen_random_uuid(),$1)", [admin.userId]);
  for (const workspace of [{ type: "team", scopeId: team }, { type: "athlete" }]) {
    assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: workspace })).status, 200);
    assert.equal((await api(`/api/exercises/${system}`, { method: "PATCH", cookie: admin.cookie, body: { name: "Denied outside platform" } })).status, 403);
  }
  assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: admin.cookie, body: { type: "platform" } })).status, 200);
  assert.equal((await api(`/api/exercises/${system}`, { cookie: admin.cookie })).body.canEdit, true);
  assert.equal((await api(`/api/exercises/${privateId}`, { cookie: admin.cookie })).status, 200);
  assert.equal((await query("select count(*)::int as count from public.user_global_roles where user_id=$1 and role='platform_admin' and is_active", [admin.userId])).rows[0].count, 1);
  assert.equal((await api("/api/auth/workspace", { method: "PUT", cookie: other.cookie, body: { type: "platform" } })).status, 403);
});

test("owner lookup pins my account, searches on demand and bounds results", async () => {
  const admin = await makeLibraryAdmin("owner-search-admin");
  const coach = await makeCoach("owner-search-coach");
  const owners = await query(`insert into public.users (email,display_name) select 'owner-search-'||position||'@test.local','Owner search fixture '||position
    from generate_series(1,25) position returning id`);
  for (const owner of owners.rows) await makeExercise(owner.id);
  const options = await api("/api/exercises/options", { cookie: admin.cookie });
  assert.deepEqual(options.body.owners.map((owner) => owner.id), [admin.userId]);
  const empty = await api("/api/exercises/owners", { cookie: admin.cookie });
  assert.deepEqual(empty.body.owners.map((owner) => owner.id), [admin.userId]);
  const found = await api("/api/exercises/owners?search=Owner%20search%20fixture", { cookie: admin.cookie });
  assert.equal(found.status, 200);
  assert.equal(found.body.owners[0].id, admin.userId);
  assert.equal(found.body.owners.length, 21);
  assert.equal(found.body.hasMore, true);
  assert.ok(found.body.owners.every((owner) => owner.email));
  assert.equal((await api("/api/exercises/owners?search=Owner", { cookie: coach.cookie })).status, 403);
  const privateId = await makeExercise(admin.userId);
  const mine = await api("/api/exercises?kind=mine", { cookie: admin.cookie });
  assert.ok(mine.body.exercises.some((exercise) => exercise.id === privateId));
  assert.ok(mine.body.exercises.every((exercise) => exercise.owner_user_id === admin.userId));
  const normal = await api("/api/exercises?kind=accessible", { cookie: admin.cookie });
  assert.ok(normal.body.exercises.every((exercise) => exercise.owner_scope === "system" || exercise.owner_user_id === admin.userId));
});

test("renamed copy matches name search alone; the original's personal tag remains searchable explicitly", async () => {
  const owner = await makeCoach("copy-name-search");
  const original = await makeExercise(null, { ownerScope: "system", name: "Original jump fixture" });
  const name = `Proba-${crypto.randomUUID()}`;
  await api(`/api/exercises/${original}/tags`, { method: "POST", cookie: owner.cookie, body: { name } });
  const copy = await api(`/api/exercises/${original}/copy`, { method: "POST", cookie: owner.cookie, body: { name } });
  assert.equal(copy.status, 201);
  const names = await api(`/api/exercises?search=${name}&searchIn=name`, { cookie: owner.cookie });
  assert.deepEqual(names.body.exercises.map((exercise) => exercise.id), [copy.body.id]);
  const all = await api(`/api/exercises?search=${name}&searchIn=all`, { cookie: owner.cookie });
  assert.deepEqual(new Set(all.body.exercises.map((exercise) => exercise.id)), new Set([original, copy.body.id]));
  assert.equal((await query("select name from library.exercises where id=$1", [original])).rows[0].name, "Original jump fixture");
  assert.equal((await api(`/api/exercises?tag=${name}`, { cookie: owner.cookie })).body.exercises[0].id, original);
});

test("permanent deletion removes only an unreferenced owned private copy and its metadata", async () => {
  const owner = await makeCoach("delete-owner");
  const other = await makeCoach("delete-other");
  const admin = await makeLibraryAdmin("delete-admin");
  assert.equal((await api("/api/exercises/not-a-uuid/permanent", { method: "DELETE", cookie: owner.cookie })).status, 400);
  const original = await makeExercise(null, { ownerScope: "system", name: "Delete retained original" });
  const before = (await query("select * from library.exercises where id=$1", [original])).rows[0];
  const copy = await api(`/api/exercises/${original}/copy`, { method: "POST", cookie: owner.cookie, body: { name: "Disposable private" } });
  const id = copy.body.id;
  await api(`/api/exercises/${id}/tags`, { method: "POST", cookie: owner.cookie, body: { name: "Delete metadata" } });
  await api(`/api/exercises/${id}/favorite`, { method: "POST", cookie: owner.cookie });
  await api(`/api/exercises/${id}/classification`, { method: "PUT", cookie: owner.cookie, body: { overrides: { place: "Delete place" } } });
  await api(`/api/exercises/${id}/hidden`, { method: "POST", cookie: owner.cookie, body: { hidden: true } });
  assert.equal((await api(`/api/exercises/${id}/permanent`, { method: "DELETE", cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${original}/permanent`, { method: "DELETE", cookie: owner.cookie })).status, 403);
  assert.equal((await api(`/api/exercises/${original}/permanent`, { method: "DELETE", cookie: admin.cookie })).status, 403);
  const deleted = await api(`/api/exercises/${id}/permanent`, { method: "DELETE", cookie: owner.cookie });
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await query("select count(*)::int as count from library.exercises where id=$1", [id])).rows[0].count, 0);
  assert.equal((await query("select count(*)::int as count from library.exercise_personal_tags where exercise_id=$1", [id])).rows[0].count, 0);
  assert.equal((await query("select count(*)::int as count from library.filter_hidden where item_id=$1 and kind='exercise'", [id])).rows[0].count, 0);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [original])).rows[0], before);
});

test("permanent deletion refuses SET NULL, CASCADE, program/activity references and dependent copies", async () => {
  const owner = await makeCoach("delete-in-use");
  await query(`create schema if not exists deletion_reference_fixture;
    create table deletion_reference_fixture.program_items (exercise_id uuid references library.exercises(id) on delete set null);
    create table deletion_reference_fixture.activities (exercise_id uuid references library.exercises(id) on delete cascade)`);
  for (const table of ["program_items", "activities"]) {
    const id = await makeExercise(owner.userId);
    await query(`insert into deletion_reference_fixture.${table} values ($1)`, [id]);
    const deleted = await api(`/api/exercises/${id}/permanent`, { method: "DELETE", cookie: owner.cookie });
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
    assert.equal((await query(`select exercise_id from deletion_reference_fixture.${table} where exercise_id=$1`, [id])).rows[0].exercise_id, id);
    assert.equal((await api(`/api/exercises/${id}/archive`, { method: "POST", cookie: owner.cookie })).status, 200);
    assert.equal((await api(`/api/exercises/${id}/restore`, { method: "POST", cookie: owner.cookie })).status, 200);
  }
  const parent = await makeExercise(owner.userId);
  const child = await api(`/api/exercises/${parent}/copy`, { method: "POST", cookie: owner.cookie, body: { name: "Dependent child" } });
  assert.equal(child.status, 201);
  assert.equal((await api(`/api/exercises/${parent}/permanent`, { method: "DELETE", cookie: owner.cookie })).status, 409);
  assert.equal((await api(`/api/exercises/${child.body.id}`, { cookie: owner.cookie })).status, 200);
});

test("a concurrently inserted dependency is retained and blocks permanent deletion", async () => {
  const owner = await makeCoach("delete-race");
  const id = await makeExercise(owner.userId);
  const writer = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await writer.connect();
  let deleting;
  try {
    await writer.query("begin");
    await writer.query("insert into deletion_reference_fixture.program_items values ($1)", [id]);
    deleting = api(`/api/exercises/${id}/permanent`, { method: "DELETE", cookie: owner.cookie });
    const deadline = Date.now() + 1200;
    let waiting = false;
    while (Date.now() < deadline) {
      waiting = (await query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike 'select e.id,e.owner_scope,e.owner_user_id from library.exercises e%'")).rowCount > 0;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true);
    await writer.query("commit");
    assert.equal((await deleting).status, 409);
    assert.equal((await query("select exercise_id from deletion_reference_fixture.program_items where exercise_id=$1", [id])).rows[0].exercise_id, id);
  } finally {
    await writer.query("rollback");
    await writer.end();
    await Promise.allSettled([deleting].filter(Boolean));
  }
});

test("personal classification overrides all existing fields, isolates users and resets without copying", async () => {
  const first = await makeCoach("classify-first");
  const second = await makeCoach("classify-second");
  const admin = await makeLibraryAdmin("classify-admin");
  const source = await makeExercise(null, { ownerScope: "system", name: "Classification source" });
  const initial = await api(`/api/exercises/${source}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Classification source", place: "Classification original gym", purposes: ["Classification original purpose"], bodyParts: ["Classification original body"] } });
  assert.equal(initial.status, 200);
  const original = (await query("select * from library.exercises where id=$1", [source])).rows[0];
  const count = (await query("select count(*)::int as count from library.exercises")).rows[0].count;
  const values = { place: "Classification personal gym", complexity: "Classification level", startingPosition: "Classification stance", attractor: "Classification attractor",
    purposes: ["Classification personal purpose"], qualities: ["Classification quality"], groups: ["Classification group"], bodyParts: [], movementPatterns: ["Classification pattern"] };
  assert.equal((await api(`/api/exercises/${source}/classification`, { method: "PUT", cookie: first.cookie, body: { overrides: values } })).status, 200);
  assert.equal((await api(`/api/exercises/${source}/classification`, { method: "PUT", cookie: second.cookie, body: { overrides: { place: "Different gym" } } })).status, 200);
  for (const [filter, value] of Object.entries({ place: values.place, complexity: values.complexity, startingPosition: values.startingPosition, attractor: values.attractor,
    purpose: values.purposes[0], quality: values.qualities[0], group: values.groups[0], movementPattern: values.movementPatterns[0] })) {
    const listed = await api(`/api/exercises?${filter}=${encodeURIComponent(value)}`, { cookie: first.cookie });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.exercises.filter((exercise) => exercise.id === source).length, 1);
    assert.equal((await api(`/api/exercises?${filter}=${encodeURIComponent(value)}`, { cookie: second.cookie })).body.exercises.some((exercise) => exercise.id === source), false);
  }
  assert.equal((await api("/api/exercises?bodyPart=Classification%20original%20body", { cookie: first.cookie })).body.exercises.some((exercise) => exercise.id === source), false);
  const loaded = await api(`/api/exercises/${source}/classification`, { cookie: first.cookie });
  assert.deepEqual(loaded.body.effective.bodyParts, []);
  assert.equal(loaded.body.system.place, "Classification original gym");
  assert.equal((await api("/api/exercises?search=Classification%20personal%20purpose", { cookie: first.cookie })).body.exercises.filter((exercise) => exercise.id === source).length, 1);
  assert.equal((await api("/api/exercises?search=Classification%20personal%20purpose", { cookie: second.cookie })).body.exercises.some((exercise) => exercise.id === source), false);
  const partialReset = { ...values };
  delete partialReset.place;
  assert.equal((await api(`/api/exercises/${source}/classification`, { method: "PUT", cookie: first.cookie, body: { overrides: partialReset } })).status, 200);
  assert.equal((await api(`/api/exercises/${source}/classification`, { cookie: first.cookie })).body.effective.place, "Classification original gym");
  await api(`/api/exercises/${source}/classification`, { method: "PUT", cookie: first.cookie, body: { overrides: {} } });
  assert.deepEqual((await api(`/api/exercises/${source}/classification`, { cookie: first.cookie })).body.effective.bodyParts, ["Classification original body"]);
  assert.equal((await query("select count(*)::int as count from library.exercises")).rows[0].count, count);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [source])).rows[0], original);
});

test("classification rejects unknown/media fields and foreign private writes", async () => {
  const coach = await makeCoach("classification-validation");
  const other = await makeCoach("classification-private");
  const source = await makeExercise(null, { ownerScope: "system" });
  for (const overrides of [{ videoUrl: "https://bad.test" }, { purposes: null }, { place: ["Bad"] }, { place: " bad " }, JSON.parse('{"__proto__":"bad"}')]) {
    assert.equal((await api(`/api/exercises/${source}/classification`, { method: "PUT", cookie: coach.cookie, body: { overrides } })).status, 400);
  }
  const privateId = await makeExercise(other.userId);
  assert.equal((await api(`/api/exercises/${privateId}/classification`, { method: "PUT", cookie: coach.cookie, body: { overrides: { place: "No" } } })).status, 404);
});

test("media fallback follows source updates, prioritizes own media and disappears when grants are revoked", async () => {
  const coach = await makeCoach("fallback-owner");
  const admin = await makeLibraryAdmin("fallback-admin");
  const source = await makeExercise(null, { ownerScope: "system", name: "Fallback source" });
  await query("update library.exercises set video_url='https://source.test/one',image_url='https://source.test/image-one' where id=$1", [source]);
  const saved = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Fallback copy" } });
  assert.equal(saved.status, 201);
  const id = saved.body.id;
  let detail = await api(`/api/exercises/${id}`, { cookie: coach.cookie });
  assert.equal(detail.body.videoUrl, "");
  assert.equal(detail.body.imageUrl, "");
  assert.equal(detail.body.effectiveVideoUrl, "https://source.test/one");
  await query("update library.exercises set video_url='https://source.test/two',image_url='https://source.test/image-two' where id=$1", [source]);
  detail = await api(`/api/exercises/${id}`, { cookie: coach.cookie });
  assert.equal(detail.body.effectiveVideoUrl, "https://source.test/two");
  const own = await api(`/api/exercises/${id}`, { method: "PATCH", cookie: coach.cookie, body: { ...detail.body, videoUrl: "https://own.test/video" } });
  assert.equal(own.status, 200);
  assert.equal((await api(`/api/exercises/${id}`, { cookie: coach.cookie })).body.effectiveVideoUrl, "https://own.test/video");
  await api(`/api/exercises/${id}`, { method: "PATCH", cookie: coach.cookie, body: { ...detail.body, videoUrl: "", imageUrl: "" } });
  assert.equal((await api(`/api/exercises/${id}`, { cookie: coach.cookie })).body.effectiveVideoUrl, "https://source.test/two");
  assert.equal((await query("select video_url from library.exercises where id=$1", [id])).rows[0].video_url, null);
  const block = await api("/api/exercise-collections", { method: "POST", cookie: admin.cookie,
    body: { name: "Fallback restricted", exerciseIds: [source], userIds: [] } });
  assert.equal(block.status, 201);
  assert.equal((await api(`/api/exercises/${id}`, { cookie: coach.cookie })).status, 404);
  assert.equal((await api(`/api/exercises?search=Fallback`, { cookie: coach.cookie })).body.exercises.length, 0);
});

test("private Copy uses immutable parent provenance with inherited ACL and never changes canonical source uniqueness", async () => {
  const owner = await makeCoach("private-copy-owner");
  const other = await makeCoach("private-copy-outsider");
  const admin = await makeLibraryAdmin("private-copy-admin");
  const source = await makeExercise(owner.userId, { name: "Private parent" });
  await query("update library.exercises set video_url='https://private.test/video' where id=$1", [source]);
  assert.equal((await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: other.cookie, body: { name: "Denied" } })).status, 404);
  const copy = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: owner.cookie, body: { name: "Private child" } });
  assert.equal(copy.status, 201);
  assert.equal(copy.body.copyParentId, source);
  assert.equal(copy.body.sourceExerciseId, null);
  assert.equal((await api(`/api/exercises/${copy.body.id}`, { cookie: owner.cookie })).body.effectiveVideoUrl, "https://private.test/video");
  const copiedByAdmin = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: admin.cookie, body: { name: "Admin private child" } });
  assert.equal(copiedByAdmin.status, 201);
  await query("update public.user_global_roles set is_active=false where user_id=$1", [admin.userId]);
  assert.equal((await api(`/api/exercises/${copiedByAdmin.body.id}`, { cookie: admin.cookie })).status, 404);
  const otherParent = await makeExercise(other.userId);
  await assert.rejects(query("update library.exercises set copy_parent_id=$2 where id=$1", [copy.body.id, otherParent]), /provenance/i);
  await assert.rejects(query("update library.exercises set copy_parent_id=$2 where id=$1", [source, copy.body.id]), /cycle/i);
});

test("Hide is personal, reversible and does not deny direct exercise access", async () => {
  const first = await makeCoach("hide-first");
  const second = await makeCoach("hide-second");
  const source = await makeExercise(null, { ownerScope: "system", name: "Hide fixture" });
  const before = (await query("select * from library.exercises where id=$1", [source])).rows[0];
  assert.equal((await api(`/api/exercises/${source}/hidden`, { method: "POST", cookie: first.cookie, body: { hidden: true } })).status, 200);
  assert.equal((await api("/api/exercises?search=Hide%20fixture", { cookie: first.cookie })).body.exercises.length, 0);
  assert.equal((await api("/api/exercises?hidden=hidden&search=Hide%20fixture", { cookie: first.cookie })).body.exercises.length, 1);
  const markedHidden = await api("/api/exercises/visible-marked", { method: "POST", cookie: first.cookie, body: { ids: [source], hidden: "hidden" } });
  assert.deepEqual(markedHidden.body.ids, [source]);
  assert.deepEqual((await api("/api/exercises/visible-marked", { method: "POST", cookie: first.cookie, body: { ids: [source] } })).body.ids, []);
  assert.equal((await api("/api/exercises?search=Hide%20fixture", { cookie: second.cookie })).body.exercises.length, 1);
  assert.equal((await api(`/api/exercises/${source}`, { cookie: first.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${source}/hidden`, { method: "POST", cookie: first.cookie, body: { hidden: false } })).status, 200);
  assert.equal((await api("/api/exercises?search=Hide%20fixture", { cookie: first.cookie })).body.exercises.length, 1);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [source])).rows[0], before);
});

test("Archive/Delete are authorized soft operations; Restore keeps references and media", async () => {
  const owner = await makeCoach("archive-owner");
  const other = await makeCoach("archive-other");
  const admin = await makeLibraryAdmin("archive-admin");
  const source = await makeExercise(null, { ownerScope: "system", name: "Archive system" });
  const privateId = await makeExercise(owner.userId, { name: "Archive private" });
  await query("create schema if not exists archive_reference_fixture; create table archive_reference_fixture.items (exercise_id uuid references library.exercises(id) on delete restrict)");
  await query("insert into archive_reference_fixture.items values ($1)", [privateId]);
  for (const path of [`/api/exercises/${source}/archive`, `/api/exercises/${source}`]) {
    assert.equal((await api(path, { method: path.endsWith('archive') ? "POST" : "DELETE", cookie: owner.cookie })).status, 403);
  }
  assert.equal((await api(`/api/exercises/${privateId}/archive`, { method: "POST", cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${privateId}`, { method: "DELETE", cookie: owner.cookie })).status, 200);
  assert.equal((await api(`/api/exercises?visibility=archived&kind=private`, { cookie: owner.cookie })).body.exercises.some((exercise) => exercise.id === privateId), true);
  assert.equal((await query("select count(*)::int as count from archive_reference_fixture.items")).rows[0].count, 1);
  assert.equal((await api(`/api/exercises/${privateId}/restore`, { method: "POST", cookie: owner.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${privateId}`, { cookie: owner.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${privateId}/archive`, { method: "POST", cookie: admin.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${privateId}/restore`, { method: "POST", cookie: admin.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${source}/archive`, { method: "POST", cookie: admin.cookie })).status, 200);
  assert.equal((await api(`/api/exercises/${source}/restore`, { method: "POST", cookie: admin.cookie })).status, 200);
});

test("administrator type/owner/archive filters do not expose foreign private exercises to coaches", async () => {
  const owner = await makeCoach("owner-filter-coach");
  const other = await makeCoach("owner-filter-other");
  const admin = await makeLibraryAdmin("owner-filter-admin");
  const id = await makeExercise(other.userId, { name: "Owner filter private" });
  const listed = await api(`/api/exercises?kind=private&owner=${other.userId}&visibility=all&hidden=all`, { cookie: admin.cookie });
  assert.equal(listed.status, 200);
  assert.ok(listed.body.exercises.some((exercise) => exercise.id === id));
  assert.equal((await api(`/api/exercises?owner=${other.userId}`, { cookie: owner.cookie })).status, 403);
  assert.equal((await api(`/api/exercises?kind=private`, { cookie: owner.cookie })).body.exercises.some((exercise) => exercise.id === id), false);
});

test("personal tags and favorites never copy or mutate originals and remain user scoped", async () => {
  const first = await makeCoach("personal-tags-first");
  const second = await makeCoach("personal-tags-second");
  const source = await makeExercise(null, { ownerScope: "system", name: "Personal tagging source" });
  const original = (await query("select * from library.exercises where id=$1", [source])).rows[0];
  const count = (await query("select count(*)::int as count from library.exercises")).rows[0].count;
  const added = [];
  for (const coach of [first, second]) {
    const tag = await api(`/api/exercises/${source}/tags`, { method: "POST", cookie: coach.cookie, body: { name: "skip" } });
    assert.equal(tag.status, 201);
    added.push(tag.body.tag);
    assert.equal((await api(`/api/exercises/${source}/tags`, { method: "POST", cookie: coach.cookie, body: { name: "SKIP" } })).body.tag.id, tag.body.tag.id);
  }
  assert.notEqual(added[0].id, added[1].id);
  assert.equal((await api(`/api/exercises/${source}/tags/${added[1].id}`, { method: "DELETE", cookie: first.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${source}/tags`, { method: "POST", cookie: first.cookie, body: { tagId: added[1].id } })).status, 404);
  const firstTags = await api(`/api/exercises/${source}/tags`, { cookie: first.cookie });
  assert.deepEqual(firstTags.body.tags.map((tag) => tag.id), [added[0].id]);
  for (const suffix of ["?tag=skip", "?search=skip"]) {
    const result = await api(`/api/exercises${suffix}`, { cookie: first.cookie });
    assert.equal(result.status, 200);
    assert.equal(result.body.exercises.filter((exercise) => exercise.id === source).length, 1);
  }
  assert.equal((await api(`/api/exercises/${source}/favorite`, { method: "POST", cookie: first.cookie })).status, 200);
  assert.equal((await api("/api/exercises?favorite=true", { cookie: first.cookie })).body.exercises.some((exercise) => exercise.id === source), true);
  assert.equal((await api("/api/exercises?favorite=true", { cookie: second.cookie })).body.exercises.some((exercise) => exercise.id === source), false);
  assert.equal((await api(`/api/exercises/${source}/tags/${added[0].id}`, { method: "DELETE", cookie: first.cookie })).status, 200);
  assert.equal((await api("/api/exercises?tag=skip", { cookie: first.cookie })).body.exercises.some((exercise) => exercise.id === source), false);
  assert.equal((await api("/api/exercises?tag=skip", { cookie: second.cookie })).body.exercises.some((exercise) => exercise.id === source), true);
  assert.equal((await query("select count(*)::int as count from library.exercises")).rows[0].count, count);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [source])).rows[0], original);
});

test("only platform admins edit originals; private owners edit but cannot expose another owner's copy", async () => {
  const coach = await makeCoach("explicit-edit-coach");
  const admin = await makeLibraryAdmin("explicit-edit-admin");
  const source = await makeExercise(null, { ownerScope: "system", name: "Admin editable" });
  assert.equal((await api(`/api/exercises/${source}`, { method: "PATCH", cookie: coach.cookie, body: { name: "Denied" } })).status, 403);
  const edited = await api(`/api/exercises/${source}`, { method: "PATCH", cookie: admin.cookie,
    body: { name: "Admin updated original", videoUrl: "https://original.test/video", imageUrl: "https://original.test/image", purposes: ["New application purpose"] } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.id, source);
  assert.equal(edited.body.ownerScope, "system");
  assert.deepEqual((await api(`/api/exercises/${source}`, { cookie: coach.cookie })).body.purposes, ["New application purpose"]);
  const privateId = await makeExercise(coach.userId, { name: "Owned private" });
  assert.equal((await api(`/api/exercises/${privateId}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Owned copy" } })).status, 201);
  for (const method of ["GET", "PATCH"]) {
    assert.equal((await api(`/api/exercises/${privateId}`, { method, cookie: admin.cookie, ...(method === "PATCH" ? { body: { name: "Admin edit" } } : {}) })).status, 200);
  }
  assert.equal((await api(`/api/exercises/${privateId}/copy`, { method: "POST", cookie: admin.cookie, body: { name: "Admin copy" } })).status, 201);
});

test("new system copies never inherit media and direct source media submissions fail before writes", async () => {
  const coach = await makeCoach("media-copy-owner");
  const source = await makeExercise(null, { ownerScope: "system", name: "Source with media" });
  await query("update library.exercises set video_url=$2,image_url=$3 where id=$1", [source, "https://source.test/video", "https://source.test/image"]);
  const before = (await query("select * from library.exercises where id=$1", [source])).rows[0];
  for (const media of [{ videoUrl: before.video_url }, { imageUrl: before.image_url }, { imageUrl: before.video_url }, { videoUrl: ` ${before.video_url} ` }]) {
    const denied = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Denied media", ...media } });
    assert.equal(denied.status, 400);
    assert.equal((await query("select count(*)::int as count from library.exercises where source_exercise_id=$1", [source])).rows[0].count, 0);
  }
  const empty = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "No inherited media" } });
  assert.equal(empty.status, 201);
  assert.equal(empty.body.videoUrl, "");
  assert.equal(empty.body.imageUrl, "");
  const other = await makeCoach("media-copy-custom");
  const custom = await api(`/api/exercises/${source}/copy`, { method: "POST", cookie: other.cookie,
    body: { name: "Custom media", videoUrl: "https://mine.test/video", imageUrl: "https://mine.test/image" } });
  assert.equal(custom.status, 201);
  assert.equal(custom.body.videoUrl, "https://mine.test/video");
  assert.equal(custom.body.imageUrl, "https://mine.test/image");
  const edited = await api(`/api/exercises/${custom.body.id}`, { method: "PATCH", cookie: other.cookie, body: { ...custom.body, name: "Edited custom" } });
  assert.equal(edited.body.id, custom.body.id);
  assert.equal(edited.body.videoUrl, custom.body.videoUrl);
  const legacy = await makeExercise(coach.userId, { name: "Preexisting private media" });
  await query("update library.exercises set video_url=$2,image_url=$3 where id=$1", [legacy, before.video_url, before.image_url]);
  const legacyDetail = await api(`/api/exercises/${legacy}`, { cookie: coach.cookie });
  assert.equal((await api(`/api/exercises/${legacy}`, { method: "PATCH", cookie: coach.cookie, body: legacyDetail.body })).body.videoUrl, before.video_url);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [source])).rows[0], before);
});

test("explicitly copying a system exercise makes a private copy and leaves the application original unchanged", async () => {
  const coach = await makeCoach("system-copy");
  const other = await makeCoach("system-reader");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Application original" });
  const spoofedSourceId = await makeExercise(other.userId, { name: "Foreign spoofed source" });
  const before = (await query("select * from library.exercises where id = $1", [systemId])).rows[0];
  const saved = await api(`/api/exercises/${systemId}/copy`, {
    method: "POST", cookie: coach.cookie, body: {
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
  const retried = await api(`/api/exercises/${saved.body.id}`, {
    method: "PATCH", cookie: coach.cookie, body: { name: "Personal variation 2" },
  });
  assert.equal(retried.body.id, saved.body.id);
  assert.equal((await query("select count(*)::integer as count from library.exercises where owner_user_id = $1 and source_exercise_id = $2", [coach.userId, systemId])).rows[0].count, 1);
});

test("editor round trips preserve a private copy identity with production unique indexes", async () => {
  const coach = await makeCoach("unique-copy-owner");
  const other = await makeCoach("unique-copy-other");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Unique application original", exerciseCode: "SYSTEM-UNIQUE-CODE" });
  const original = (await query("select * from library.exercises where id=$1", [systemId])).rows[0];
  const detail = await api(`/api/exercises/${systemId}`, { cookie: coach.cookie });
  const requestBody = { ...detail.body, instruction: "Private instruction" };
  const saved = await api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie, body: requestBody });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.exerciseCode, "");
  const copy = (await query("select * from library.exercises where id=$1", [saved.body.id])).rows[0];
  assert.equal(copy.exercise_code, null);
  assert.notEqual(copy.slug, original.slug);
  assert.equal(copy.owner_scope, "user");
  assert.equal(copy.owner_user_id, coach.userId);
  assert.equal(copy.source_exercise_id, systemId);
  for (const targetId of [copy.id, copy.id, copy.id]) {
    const body = targetId === copy.id ? { ...saved.body, instruction: "Saved directly" } : requestBody;
    const updated = await api(`/api/exercises/${targetId}`, { method: "PATCH", cookie: coach.cookie, body });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.id, copy.id);
    assert.equal(updated.body.sourceExerciseId, systemId);
    assert.equal(updated.body.exerciseCode, "");
  }
  assert.equal((await query("select slug from library.exercises where id=$1", [copy.id])).rows[0].slug, copy.slug);
  const customized = await api(`/api/exercises/${copy.id}`, { method: "PATCH", cookie: coach.cookie,
    body: { ...saved.body, exerciseCode: "MY-PRIVATE-CODE" } });
  assert.equal(customized.status, 200);
  assert.equal(customized.body.id, copy.id);
  assert.equal(customized.body.exerciseCode, "MY-PRIVATE-CODE");
  const repeated = await api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie, body: requestBody });
  assert.equal(repeated.status, 409);
  assert.equal(repeated.body.exerciseId, copy.id);
  assert.equal((await query("select exercise_code from library.exercises where id=$1", [copy.id])).rows[0].exercise_code, "MY-PRIVATE-CODE");
  assert.equal((await query("select count(*)::integer as count from library.exercises where owner_user_id=$1 and source_exercise_id=$2", [coach.userId, systemId])).rows[0].count, 1);
  assert.equal((await api(`/api/exercises/${copy.id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${copy.id}`, { method: "PATCH", cookie: other.cookie, body: requestBody })).status, 404);
  assert.deepEqual((await query("select * from library.exercises where id=$1", [systemId])).rows[0], original);
});

test("two coaches can concurrently save same-name copies of a coded system exercise", async () => {
  const coaches = await Promise.all([makeCoach("same-name-first"), makeCoach("same-name-second")]);
  const systemId = await makeExercise(null, { ownerScope: "system", name: "Shared copy name", exerciseCode: "SHARED-SYSTEM-CODE" });
  const original = (await query("select * from library.exercises where id=$1", [systemId])).rows[0];
  const saved = await Promise.all(coaches.map(async (coach) => {
    const detail = await api(`/api/exercises/${systemId}`, { cookie: coach.cookie });
    return api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie, body: detail.body });
  }));
  assert.deepEqual(saved.map((result) => result.status), [201, 201]);
  const copies = (await query("select * from library.exercises where source_exercise_id=$1 order by id", [systemId])).rows;
  assert.equal(copies.length, 2);
  assert.equal(new Set(copies.map((copy) => copy.slug)).size, 2);
  assert.deepEqual(new Set(copies.map((copy) => copy.owner_user_id)), new Set(coaches.map((coach) => coach.userId)));
  for (const copy of copies) {
    assert.equal(copy.name, original.name);
    assert.equal(copy.exercise_code, null);
    assert.equal(copy.owner_scope, "user");
    assert.equal(copy.source_exercise_id, systemId);
  }
  assert.deepEqual((await query("select * from library.exercises where id=$1", [systemId])).rows[0], original);
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
  const saved = await api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Private restricted variation" } });
  assert.equal(saved.status, 201);
  const preservedCopy = (await query("select * from library.exercises where id=$1", [saved.body.id])).rows[0];
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await api(`/api/exercises/${saved.body.id}`, { cookie: admin.cookie })).status, 200);
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
  const copy = await api(`/api/exercises/${systemId}/copy`, {
    method: "POST", cookie: coach.cookie, body: { name: "Preserved deactivation variation" },
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
  assert.equal((await api(`/api/exercises/${copy.body.id}`, {
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
    copy = api(`/api/exercises/${source}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Must not be copied" } });
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
  const copy = await api(`/api/exercises/${canonicalSourceId}/copy`, {
    method: "POST", cookie: coach.cookie, body: { name: "Canonical private copy" },
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
  await query("alter table library.exercise_personal_tags add constraint reject_copy_failure_tag check (name <> 'force-copy-save-failure')");
  try {
    const response = await api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie,
      body: { name: "Must roll back", place: "Must roll back place", tags: ["force-copy-save-failure"] } });
    assert.equal(response.status, 500);
    assert.equal((await query("select count(*)::integer as count from library.exercises where source_exercise_id=$1", [systemId])).rows[0].count, 0);
    assert.equal((await query("select count(*)::integer as count from library.places where name='Must roll back place'")).rows[0].count, 0);
    assert.equal((await query("select name from library.exercises where id=$1", [systemId])).rows[0].name, "Rollback source");
  } finally { await query("alter table library.exercise_personal_tags drop constraint reject_copy_failure_tag"); }
});

test("tag endpoints cannot mutate the application original or remove another user's private tag", async () => {
  const coach = await makeCoach("tag-owner");
  const other = await makeCoach("tag-other");
  const systemId = await makeExercise(null, { ownerScope: "system", name: "System tags original" });
  const tagId = (await query("insert into library.tags (name,slug,owner_scope,owner_user_id) values ('Other private tag','other-private','user',$1) returning id", [other.userId])).rows[0].id;
  await query("insert into library.exercise_tags (exercise_id,tag_id) values ($1,$2)", [systemId, tagId]);
  assert.equal((await api(`/api/exercises/${systemId}/tags`, { method: "POST", cookie: coach.cookie, body: { name: "New tag" } })).status, 201);
  assert.equal((await api(`/api/exercises/${systemId}/tags/${tagId}`, { method: "DELETE", cookie: coach.cookie })).status, 404);
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
  const copy = await api(`/api/exercises/${systemId}/copy`, { method: "POST", cookie: coach.cookie, body: { name: "Race copy" } });
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

// Library search speed (2026-10-16): the search's plan holds dozens of
// correlated sub-plans, so Postgres estimated a cost in the hundreds of
// thousands and JIT-compiled it first - 5.3 s of JIT for 40 ms of work on
// 3000 exercises; the Builder showed "No matching exercises." while it ran.
// The search runs through queryWithoutJit: JIT off for its own short read
// transaction only.
test("the library search runs with JIT off in its own read-only transaction, and the connection keeps its own setting", async () => {
  const dbModule = await import("../src/db.js");
  const inside = await dbModule.queryWithoutJit("select current_setting('jit') as jit, current_setting('transaction_read_only') as read_only");
  assert.deepEqual(inside.rows[0], { jit: "off", read_only: "on" });
  const outside = await query("select current_setting('jit') as jit");
  assert.equal(outside.rows[0].jit, (await adminClient.query("select current_setting('jit') as jit")).rows[0].jit, "nothing leaks out of the transaction");
  await assert.rejects(dbModule.queryWithoutJit("select 1/0"), /division by zero/);
  assert.equal((await dbModule.queryWithoutJit("select 1 as one")).rows[0].one, 1, "the pool is usable after a failed read");
  const { readFile } = await import("node:fs/promises");
  const route = await readFile(new URL("../src/routes/exercises.js", import.meta.url), "utf8");
  assert.match(route, /const result = await queryWithoutJit\(\s*`\s*select\s*e\.id,/, "the search query itself");
});

test("the library search answers a coach with an empty search: the first page, in order, with more to come", async () => {
  const coach = await makeCoach("search-empty");
  await query(`insert into library.exercises (owner_scope, name, slug, is_active, exercise_code)
    select 'system', 'Speed fixture ' || g, 'speed-fixture-' || g || '-' || md5(random()::text), true, 'SF' || g from generate_series(1, 40) g`);
  const res = await api("/api/exercises?search=&limit=18&offset=0", { cookie: coach.cookie });
  assert.equal(res.status, 200);
  assert.equal(res.body.exercises.length, 18);
  assert.equal(res.body.hasMore, true);
  // First to last: by the code's number (codes without one last), then name, then id.
  const key = (exercise) => [Number((exercise.exercise_code || "").replace(/\D/g, "")) || Infinity, exercise.name, exercise.id];
  const compare = (a, b) => (a[0] - b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
  const keys = res.body.exercises.map(key);
  assert.deepEqual(keys, [...keys].sort(compare));
  const second = await api("/api/exercises?search=&limit=18&offset=18", { cookie: coach.cookie });
  assert.equal(new Set([...res.body.exercises, ...second.body.exercises].map((exercise) => exercise.id)).size, 36, "the next page continues without repeats");
});
