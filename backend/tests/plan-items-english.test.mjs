// English for plan items (owner, 2026-11-03): an item that still carries its
// exercise's Serbian name and instruction (whitespace aside) also carries the
// exercise's English (title_en / description_en, titleEn / descriptionEn in
// the Builder); a renamed item, a free item and an exercise without English
// carry none; nothing is written on read. The Builder's PATCH keeps an
// instruction the request does not name, so an instruction shown in English
// is never written back. On a disposable database: the lookup itself (one
// query, only the referenced exercises, five columns), and every read that
// shows an item's text - the Builder's draft, /api/plans/:id/weekly and
// /program, and /api/athletes/:id/program-data (weekly and programs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { EXERCISE_COLLECTIONS_FIXTURE_SQL, addMediaSelectionFixture } from "./support/exercise-collections-fixture.mjs";
import { decoratePlanItemEnglish } from "../src/planItemEnglish.js";

const coachId = crypto.randomUUID();
const athleteUuid = crypto.randomUUID();
let database;
let client;
let pool;
let server;
let baseUrl;
const exercises = {};
const plans = {};
const items = {};

before(async () => {
  database = await createDisposableDatabase({ prefix: "plan_items_english", label: "primary" });
  client = new pg.Client({ connectionString: database.url });
  await client.connect();
  assert.equal((await client.query("select current_database() as name")).rows[0].name, database.name);
  await client.query(`
    create schema plans;
    create schema library;
    create table public.users (id uuid primary key, is_active boolean default true, display_name text, full_name text, email text);
    create table public.user_global_roles (id uuid primary key default gen_random_uuid(), user_id uuid, role text, is_active boolean);
    create table public.user_workspace_preferences (user_id uuid primary key, workspace_type text, scope_id uuid, updated_at timestamptz);
    create table public.athletes (
      id uuid primary key, user_id uuid, athlete_id text, source_external_id text, image_url text,
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
      subscription_period text, owner_type text, library_category text, available_until date, program_order integer,
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
      exercise_code text, slug text, created_by_user_id uuid, updated_at timestamptz default now()
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
    create table library.program_access (
      id uuid primary key default gen_random_uuid(), plan_id uuid, related_plan_id uuid, user_id uuid, access_type varchar,
      status varchar, expires_at timestamptz, starts_at timestamptz, source text, license_snapshot jsonb,
      accessed_at timestamptz, used_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
      unique(plan_id,user_id,access_type)
    );
    create table public.athlete_library_access (athlete_id uuid, require_approval boolean, selected_programs_only boolean);
    -- As the real view: athlete_id is the athlete's own (text) id.
    create view plans.v_plan_summary as
      select p.id as plan_id, p.name as plan_name, p.plan_type, p.status, p.is_template, p.week_start, p.program_order,
        p.duration_days, p.cover_image_url, p.library_category, p.visibility, p.created_by_user_id, p.is_active,
        p.is_edit_draft, p.access_model, p.requires_approval, p.is_free, p.athlete_can_view_directly, p.owner_type,
        p.library_scope, a.id as athlete_uuid, a.athlete_id, a.source_external_id as athlete_source_external_id,
        0 as session_count, 0 as item_count
      from plans.plans p left join public.athletes a on a.id = p.athlete_id;
    -- The real views take exercise_id from a LEFT JOIN on library.exercises (e.id), and the item's own title and
    -- description (pi.title, pi.description); these keep the columns the routes read.
    create view plans.v_weekly_plan_items as
      select p.id as plan_id, p.name as plan_name, p.week_start, p.week_start + 6 as week_end,
        a.id as athlete_uuid, a.athlete_id, a.source_external_id as athlete_source_external_id, a.full_name as athlete_name,
        a.image_url as athlete_image_url, pd.id as plan_day_id, pd.date, pd.day_note, pd.day_order,
        ps.id as plan_session_id, ps.am_pm, ps.bta, ps.session_order, ps.session_time, ps.name as session_name,
        pi.id as plan_item_id, pi.item_type, pi.item_order, pi.title, pi.description, pi.image_url, pi.video_url,
        pi.sets, pi.reps, pi.load, e.id as exercise_id, e.exercise_code, e.name as library_exercise_name,
        pi.source_row_ref, pi.plan_node_id, null::text as hierarchy_sort_path
      from plans.plans p
        join public.athletes a on a.id = p.athlete_id
        join plans.plan_days pd on pd.plan_id = p.id
        join plans.plan_sessions ps on ps.plan_day_id = pd.id
        join plans.plan_items pi on pi.plan_session_id = ps.id
        left join library.exercises e on e.id = pi.exercise_id
      where p.plan_type = 'weekly';
    create view plans.v_program_plan_items as
      select p.id as plan_id, p.name as plan_name, p.plan_type, p.is_template, p.program_order,
        a.id as athlete_uuid, a.athlete_id, a.source_external_id as athlete_source_external_id,
        pd.id as plan_block_id, pd.block_index, pd.block_name, pd.block_type, pd.day_note,
        ps.id as plan_session_id, ps.am_pm, ps.bta, ps.session_order,
        pi.id as plan_item_id, pi.item_type, pi.item_order, pi.title, pi.description, pi.image_url, pi.video_url,
        pi.sets, pi.reps, pi.load, e.id as exercise_id, e.exercise_code, e.name as library_exercise_name,
        pi.source_row_ref, pi.plan_node_id
      from plans.plans p
        left join public.athletes a on a.id = p.athlete_id
        join plans.plan_days pd on pd.plan_id = p.id
        join plans.plan_sessions ps on ps.plan_day_id = pd.id
        join plans.plan_items pi on pi.plan_session_id = ps.id
        left join library.exercises e on e.id = pi.exercise_id
      where p.plan_type = 'program';
  `);
  await client.query(EXERCISE_COLLECTIONS_FIXTURE_SQL);
  await addMediaSelectionFixture(client.query.bind(client));
  await client.query("insert into public.users (id) values ($1)", [coachId]);
  await client.query("insert into public.user_global_roles (user_id, role, is_active) values ($1, 'platform_admin', true)", [coachId]);
  await client.query("insert into public.athletes (id, athlete_id, full_name) values ($1, 'A1', 'Ana')", [athleteUuid]);
  for (const [key, name, instruction, nameEn, instructionEn] of [
    ["lunge", "Iskorak", "Korak napred.", "Lunge", "Step forward."],
    ["serbianOnly", "Sklek", "Spusti grudi.", null, null],
    ["bridge", "Most", "Podigni kukove.", "Bridge", null],
    ["notReferenced", "Čučanj", "Spusti se.", "Squat", "Go down."],
  ]) {
    exercises[key] = (await client.query(
      `insert into library.exercises (name, instruction, name_en, instruction_en, owner_scope) values ($1, $2, $3, $4, 'system') returning id`,
      [name, instruction, nameEn, instructionEn],
    )).rows[0].id;
  }
  plans.draft = await makePlan({ plan_type: "program", is_template: true, status: "draft" }, "draft");
  plans.weekly = await makePlan({ plan_type: "weekly", is_template: false, status: "active", athlete_id: athleteUuid, week_start: "2026-11-02", date: "2026-11-03" }, "weekly");
  plans.program = await makePlan({ plan_type: "program", is_template: false, status: "active", athlete_id: athleteUuid, program_order: 1 }, "program");
  process.env.DATABASE_URL = database.url;
  ({ pool } = await import("../src/db.js"));
  const { default: builderRouter } = await import("../src/routes/builder.js");
  const { default: plansRouter } = await import("../src/routes/plans.js");
  const { default: athletesRouter } = await import("../src/routes/athletes.js");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: coachId };
    req.authz = { platformRoles: ["platform_admin"], clubRoles: [], teamRoles: [], managedTeamIds: [], capabilities: { coachWorkspace: true } };
    next();
  });
  app.use("/api/builder", builderRouter);
  app.use("/api/plans", plansRouter);
  app.use("/api/athletes", athletesRouter);
  app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  try {
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  } finally {
    try { await pool?.end(); } finally {
      try { await client?.end(); } finally { await database?.drop(); }
    }
  }
});

// One plan with one day, session and section, and the same six items:
// carries its exercise's text (a double space and a trailing CRLF in the
// stored text are no difference), renamed by the coach, an exercise with only
// Serbian, a free item, an exercise with an English name only, and an item
// with no instruction of its own.
async function makePlan({ date = null, ...plan }, key) {
  const columns = Object.keys(plan);
  const id = (await client.query(
    `insert into plans.plans (created_by_user_id, name, ${columns.join(", ")}) values ($1, $2, ${columns.map((_, i) => `$${i + 3}`).join(", ")}) returning id`,
    [coachId, `Plan ${key}`, ...Object.values(plan)],
  )).rows[0].id;
  const day = (await client.query("insert into plans.plan_days (plan_id, date, day_order) values ($1, $2, 1) returning id", [id, date])).rows[0].id;
  const session = (await client.query("insert into plans.plan_sessions (plan_day_id, session_order) values ($1, 1) returning id", [day])).rows[0].id;
  const node = (await client.query("insert into plans.plan_nodes (plan_session_id) values ($1) returning id", [session])).rows[0].id;
  items[key] = {};
  let order = 0;
  for (const [name, exerciseId, title, description] of [
    ["carries", exercises.lunge, "Iskorak", "Korak  napred.\r\n"],
    ["renamed", exercises.lunge, "Moj iskorak", "Moje uputstvo."],
    ["serbianOnly", exercises.serbianOnly, "Sklek", "Spusti grudi."],
    ["free", null, "Trčanje", "Lagano."],
    ["nameOnly", exercises.bridge, "Most", "Podigni kukove."],
    ["noInstruction", exercises.lunge, "Iskorak", null],
  ]) {
    items[key][name] = (await client.query(
      `insert into plans.plan_items (plan_session_id, plan_node_id, item_type, exercise_id, title, description, item_order)
       values ($1, $2, 'exercise', $3, $4, $5, $6) returning id`,
      [session, node, exerciseId, title, description, (order += 1)],
    )).rows[0].id;
  }
  return id;
}

const EXPECTED = {
  carries: ["Lunge", "Step forward."],
  renamed: [null, null],
  serbianOnly: [null, null],
  free: [null, null],
  nameOnly: ["Bridge", null],
  noInstruction: ["Lunge", null],
};

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

function draftItems(draft) {
  return draft.blocks.flatMap((block) => block.sessions).flatMap((session) => session.nodes).flatMap((node) => node.items);
}

function assertEnglish(found, ids, titleKey, descriptionKey, where) {
  for (const [name, [titleEn, descriptionEn]] of Object.entries(EXPECTED)) {
    const item = found.get(ids[name]);
    assert.ok(item, `${where}: ${name} is listed`);
    assert.equal(item[titleKey] ?? null, titleEn, `${where}: ${name} ${titleKey}`);
    assert.equal(item[descriptionKey] ?? null, descriptionEn, `${where}: ${name} ${descriptionKey}`);
  }
}

test("1. the lookup: one query for every row, only the exercises the rows reference, five columns; none when no row names an exercise", async () => {
  const calls = [];
  const runQuery = async (sql, params) => {
    const result = await client.query(sql, params);
    calls.push({ sql, params, rows: result.rows });
    return result;
  };
  const rows = [
    { exercise_id: exercises.lunge, title: "Iskorak", description: "Korak napred." },
    { exercise_id: exercises.lunge, title: "Moj iskorak", description: "x" },
    { exercise_id: exercises.bridge, title: "Most", description: "Podigni kukove." },
    { exercise_id: null, title: "Trčanje", description: "" },
  ];
  await decoratePlanItemEnglish(rows, runQuery);
  assert.equal(calls.length, 1, "one query for all rows");
  assert.deepEqual([...calls[0].params[0]].sort(), [exercises.lunge, exercises.bridge].sort(), "only the referenced exercises, each once");
  assert.equal(calls[0].rows.length, 2, "the database returns only those");
  assert.deepEqual(Object.keys(calls[0].rows[0]).sort(), ["id", "instruction", "instruction_en", "name", "name_en"]);
  assert.deepEqual(rows.map((row) => [row.title_en, row.description_en]), [["Lunge", "Step forward."], [null, null], ["Bridge", null], [null, null]]);
  const none = [{ exercise_id: null, title: "Trčanje" }];
  await decoratePlanItemEnglish(none, runQuery);
  assert.equal(calls.length, 1, "no query when no row names an exercise");
  assert.deepEqual([none[0].title_en, none[0].description_en], [null, null]);
});

test("2. the Builder's draft carries titleEn / descriptionEn by the rule, and the stored text as it is", async () => {
  const draft = await getJson(`/api/builder/plans/${plans.draft}`);
  const found = new Map(draftItems(draft).map((item) => [item.id, item]));
  assertEnglish(found, items.draft, "titleEn", "descriptionEn", "builder");
  assert.equal(found.get(items.draft.carries).title, "Iskorak", "the stored title is sent as it is");
  assert.equal(found.get(items.draft.carries).description, "Korak  napred.\r\n");
  assert.ok(!JSON.stringify(draft).includes("Squat"), "an exercise no item references is never read");
});

test("3. /api/plans/:id/weekly and /program, and /api/athletes/:id/program-data (weekly and programs) carry title_en / description_en", async () => {
  const weekly = await getJson(`/api/plans/${plans.weekly}/weekly`);
  assertEnglish(new Map(weekly.rows.map((row) => [row.plan_item_id, row])), items.weekly, "title_en", "description_en", "plans weekly rows");
  const weekItems = weekly.weeks.flatMap((week) => week.days.flatMap((day) => Object.values(day.slots || {}).flatMap((slot) => Object.values(slot).flat())));
  assert.equal(weekItems.length, 6, "the week's day holds the six items");
  assertEnglish(new Map(weekItems.map((item) => [item.plan_item_id, item])), items.weekly, "title_en", "description_en", "plans weekly items");
  const program = await getJson(`/api/plans/${plans.program}/program`);
  assertEnglish(new Map(program.rows.map((item) => [item.plan_item_id, item])), items.program, "title_en", "description_en", "plans program");
  const athleteWeekly = await getJson("/api/athletes/A1/program-data?program=__weekly__");
  assertEnglish(new Map(athleteWeekly.rows.map((row) => [row.plan_item_id, row])), items.weekly, "title_en", "description_en", "athlete weekly");
  const athletePrograms = await getJson("/api/athletes/A1/program-data?program=__all_programs__");
  const programRows = athletePrograms.programs.flatMap((entry) => entry.data.rows);
  assertEnglish(new Map(programRows.map((item) => [item.plan_item_id, item])), items.program, "title_en", "description_en", "athlete programs");
  for (const body of [weekly, program, athleteWeekly, athletePrograms]) assert.ok(!JSON.stringify(body).includes("Squat"));
});

test("4. the save rule: a PATCH without description keeps the stored instruction byte for byte; a typed one is stored and from then on shown as stored", async () => {
  const id = items.draft.carries;
  const stored = async () => (await client.query("select title, description from plans.plan_items where id = $1", [id])).rows[0];
  const before_ = await stored();
  const patch = async (body) => {
    const response = await fetch(`${baseUrl}/api/builder/items/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, responseMode: "item" }),
    });
    const answer = await response.json();
    assert.equal(response.status, 200, JSON.stringify(answer));
    return answer;
  };
  // An English reader edits the sets: the instruction is not sent.
  const sets = await patch({ sets: "3", reps: "8", load: "" });
  assert.deepEqual(await stored(), before_, "title and description unchanged, byte for byte");
  assert.equal(sets.item.description, "Korak  napred.\r\n");
  assert.equal(sets.item.descriptionEn, "Step forward.", "the answer keeps the English while the item still carries its exercise's text");
  assert.equal(sets.item.sets, "3");
  // The coach types over the English: what was typed is the item's own text.
  const typed = await patch({ sets: "3", reps: "8", load: "", description: "Step forward slowly." });
  assert.equal((await stored()).description, "Step forward slowly.");
  assert.equal(typed.item.descriptionEn, null, "a coach's own text carries no English");
  const draft = await getJson(`/api/builder/plans/${plans.draft}`);
  const item = draftItems(draft).find((candidate) => candidate.id === id);
  assert.equal(item.description, "Step forward slowly.");
  assert.equal(item.descriptionEn, null, "shown as stored, in any language");
  assert.equal(item.titleEn, "Lunge", "the title still carries its exercise's name");
  // An empty instruction, sent, still clears it.
  await patch({ sets: "3", reps: "8", load: "", description: "" });
  assert.equal((await stored()).description, null);
  await client.query("update plans.plan_items set description = $2 where id = $1", [id, before_.description]);
});

test("5. reading writes nothing", async () => {
  const snapshot = async () => (await client.query("select to_jsonb(i) as row from plans.plan_items i order by id")).rows;
  const before_ = await snapshot();
  await getJson(`/api/builder/plans/${plans.draft}`);
  await getJson(`/api/plans/${plans.weekly}/weekly`);
  await getJson(`/api/plans/${plans.program}/program`);
  await getJson("/api/athletes/A1/program-data?program=__all_programs__");
  assert.deepEqual(await snapshot(), before_);
});
