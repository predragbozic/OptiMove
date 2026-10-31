// Central calendar K2a-1a: migration v49 (calendar.*), the event commands
// (create / update / cancel with requestKey), the identical 404, the audit,
// and the events in GET /api/calendar with the athlete's reduced view (D21).
// Plan: docs/ai/central-calendar-k2a-plan.md (sections 1.2, 4, 5, 7, 10).
//
// Everything runs on ONE disposable database (optimove_tests_gpexe_k2a_*):
// the GPEXE legacy scaffold, the Tests v42 files (for test schedules), the
// training_load / training / calendar files through v49 plus v6 / v8, through
// the real runner; dropped at the end (the rollback rehearsal builds and
// drops a second one). Nothing touches OPTIMOVE or any persistent database.
// The real Express app is driven over HTTP with real session cookies.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const V49 = "202610311000_calendar_v49_events.sql";
const TESTS_MIGRATIONS = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];
const EXTRA_TRAINING_LOAD_MIGRATIONS = [
  "202609011200_training_load_v6_external_schedule_event_type.sql",
  "202609030900_training_load_v8_specific_dates_group.sql",
];
const MIGRATIONS = [...TESTS_MIGRATIONS, ...GPEXE_TEST_MIGRATIONS, ...EXTRA_TRAINING_LOAD_MIGRATIONS].sort();
const WELLNESS_TEST_VERSION_ID = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const TZ = "Europe/Belgrade";

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);
const PAST = addDays(TODAY, -2);
const FUTURE = addDays(TODAY, 1);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let eventService;

const uid = () => crypto.randomBytes(4).toString("hex");
const newKey = () => crypto.randomUUID();
async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

// ---------------------------------------------------------------------------
// Fixtures (the K1a suite's helpers)
// ---------------------------------------------------------------------------
async function makeClub(label = "Club") {
  const id = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [id]);
  return id;
}
async function makeTeam(clubId, label = "Team") {
  return (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
}
async function makeUser(label) {
  return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await q(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function withCookie(id) {
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}
async function clubAdminOf(clubId, label = "club admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}
async function platformAdmin(label = "platform admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}
async function privateCoach(label = "private coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [id]);
  await setWorkspace(id, "private_coach", null);
  return withCookie(id);
}
async function addMembership({ athleteId, clubId, teamId = null, type = teamId ? "team" : "club", startsAt = "2026-01-01T00:00:00Z" }) {
  return (await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active',$5) returning id`,
    [athleteId, clubId, teamId, type, startsAt],
  ))[0].id;
}
async function archiveMembership(membershipId, archivedAt) {
  await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where id = $1`, [membershipId, archivedAt]);
}
async function teamMembershipId(athleteId, teamId) {
  return (await q(`select id from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team'`, [athleteId, teamId]))[0].id;
}
async function makeAthlete(name, { clubId = null, teamId = null, tz = "UTC" } = {}) {
  const userId = await makeUser(name);
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name, tz]))[0].id;
  if (clubId) await addMembership({ athleteId, clubId, type: "club" });
  if (clubId && teamId) await addMembership({ athleteId, clubId, teamId });
  await setWorkspace(userId, "athlete", null);
  return { name, userId, athleteId, ...(await withCookie(userId)) };
}
function ownerColumns(owner) {
  return {
    owner_scope: owner.scope,
    owner_user_id: owner.scope === "user" ? owner.userId : null,
    owner_club_id: owner.scope === "club" ? owner.clubId : null,
    owner_team_id: owner.scope === "team" ? owner.teamId : null,
  };
}
async function makeExternalSchedule({ owner, createdBy, startDate = PAST, eventName = "Away match", status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ('one_time','UTC',$1,null,null,'17:00','23:59',$2,$3,'match',$4,$5,$6,$7,$8) returning id`,
    [startDate, status, eventName, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  ))[0].id;
  for (const t of targets) {
    await q(
      `insert into training_load.external_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1,$2,$3,$4,$5)`,
      [id, t.kind, t.kind === "athlete" ? t.id : null, t.kind === "team" ? t.id : null, t.kind === "club" ? t.id : null],
    );
  }
  return id;
}
async function makeExternalOccurrence(scheduleId, date, status = "closed") {
  return (await q(
    `insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status) values ($1,$2,$3,$4,$5) returning id`,
    [scheduleId, date, `${date}T17:00:00Z`, `${date}T23:59:00Z`, status],
  ))[0].id;
}
async function makeExternalAssignment(occurrenceId, athleteId, date, status = "pending") {
  const completedAt = status === "completed" ? `${date}T18:30:00Z` : null;
  return (await q(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, started_at, completed_at)
     values ($1,$2,'UTC',$3,$4,$5,$6,$7,$7) returning id`,
    [occurrenceId, athleteId, date, `${date}T17:00:00Z`, `${date}T23:59:00Z`, status, completedAt],
  ))[0].id;
}
async function externalFeedback(athleteId, assignmentId, date) {
  await q(
    `insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, event_name, rpe, duration_minutes) values ($1,$2,$3,'scheduled_external','Away match',6,60)`,
    [athleteId, date, assignmentId],
  );
}
async function makeTestSchedule({ owner, createdBy, startDate = PAST, status = "active", targets = [] }) {
  const o = ownerColumns(owner);
  const id = (await q(
    `insert into tests.test_schedules (test_version_id, schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, created_by_user_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
     values ($1,'one_time','UTC',$2,null,null,'07:00','09:00',$3,$4,$5,$6,$7,$8) returning id`,
    [WELLNESS_TEST_VERSION_ID, startDate, status, createdBy, o.owner_scope, o.owner_user_id, o.owner_club_id, o.owner_team_id],
  ))[0].id;
  for (const t of targets) {
    await q(
      `insert into tests.test_schedule_targets (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1,$2,$3,$4,$5)`,
      [id, t.kind, t.kind === "athlete" ? t.id : null, t.kind === "team" ? t.id : null, t.kind === "club" ? t.id : null],
    );
  }
  return id;
}
async function makeTestOccurrence(scheduleId, date, status = "closed") {
  return (await q(
    `insert into tests.test_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status, snapshot_test_version_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [scheduleId, date, `${date}T07:00:00Z`, `${date}T09:00:00Z`, status, WELLNESS_TEST_VERSION_ID],
  ))[0].id;
}
async function makeTestAssignment(occurrenceId, athleteId, date, status = "pending") {
  return (await q(
    `insert into tests.test_assignments (occurrence_id, athlete_id, snapshot_test_version_id, status, timezone, local_scheduled_date, opens_at, closes_at, completed_at)
     values ($1,$2,$3,$4,'UTC',$5,$6,$7,$8) returning id`,
    [occurrenceId, athleteId, WELLNESS_TEST_VERSION_ID, status, date, `${date}T07:00:00Z`, `${date}T09:00:00Z`, status === "completed" ? `${date}T08:00:00Z` : null],
  ))[0].id;
}

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const calendar = (cookie, { from = FROM, to = TO, extra = "" } = {}) => api(`/api/calendar?from=${from}&to=${to}${extra}`, { cookie });
const itemsOn = (res, date) => (res.body.days?.find((d) => d.date === date) || { items: [] }).items;
const allItems = (res) => (res.body.days || []).flatMap((d) => d.items);
const ofKind = (items, kind) => items.filter((i) => i.kind === kind);
const eventCards = (res, eventId) => ofKind(allItems(res), "event").filter((i) => i.eventId === eventId || i.links?.eventId === eventId);
// The statements of a runbook SQL file (comment lines dropped, split at the
// statement ends), each run as the owner would run a block.
async function runbookBlocks(client, file) {
  const text = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks", file), "utf8");
  const statements = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (const statement of statements) rows.push((await client.query(statement)).rows[0]);
  return rows;
}
async function rowDigests(tables) {
  const out = {};
  for (const t of tables) {
    const r = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    out[t] = `${r.n}:${r.d}`;
  }
  return out;
}
const typesOf = (cookie) => api("/api/calendar/events/types", { cookie });
const createEvent = (cookie, body) => api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: newKey(), timezone: TZ, ...body } });
const patchEvent = (cookie, id, body) => api(`/api/calendar/events/${id}`, { method: "PATCH", cookie, body: { requestKey: newKey(), ...body } });
const cancelEvent = (cookie, id, body = {}) => api(`/api/calendar/events/${id}/cancel`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const getEvent = (cookie, id) => api(`/api/calendar/events/${id}`, { cookie });
async function typeOf(cookie, kind) {
  const res = await typesOf(cookie);
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === kind);
}

// A club with two teams, their coaches, the club's admin, two athletes in
// team 1 (members since 2026-01-01), one in team 2.
async function clubFixture(label) {
  const clubId = await makeClub(`${label} club`);
  const team1 = await makeTeam(clubId, `${label} T1`);
  const team2 = await makeTeam(clubId, `${label} T2`);
  const clubAdmin = await clubAdminOf(clubId, `${label} admin`);
  const coach1 = await coachOf(team1, `${label} coach 1`);
  const coach2 = await coachOf(team2, `${label} coach 2`);
  const a1 = await makeAthlete(`${label} A1`, { clubId, teamId: team1 });
  const a2 = await makeAthlete(`${label} A2`, { clubId, teamId: team1 });
  const a3 = await makeAthlete(`${label} A3`, { clubId, teamId: team2 });
  return { clubId, team1, team2, clubAdmin, coach1, coach2, a1, a2, a3 };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "k2a", migrations: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);
  // The scaffold's public.clubs carries only the columns the calendar reads;
  // POST /api/organization/clubs (test 14) writes the real table's columns.
  await admin.query(`alter table public.clubs
    add column if not exists short_name text, add column if not exists logo_url text, add column if not exists city text,
    add column if not exists country text, add column if not exists updated_at timestamptz not null default now()`);
  assert.ok((await q(`select to_regclass('calendar.events') as t`))[0].t, "v49 is applied");
  assert.ok((await q(`select to_regclass('tests.test_schedules') as t`))[0].t, "the Tests schema is applied");

  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  eventService = await import("../src/calendarEventService.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (db) await db.drop();
});

// ---------------------------------------------------------------------------
// 1. The migration
// ---------------------------------------------------------------------------
test("1a. v49 is recorded once, with its objects and seed; the post-check runbook reads as expected; the catalog is read-only and a system type is never deleted", async () => {
  // The post-check runbook, block by block, on the fresh database (before any
  // event exists): the owner's expected values.
  const post = await runbookBlocks(admin, "calendar-events-v49-postcheck.sql");
  assert.equal(Number(post[0].v49_rows), 1);
  assert.equal(Number(post[0].later_rows), 0);
  assert.equal(post[0].last_migration, `migrations_v2/${V49}`);
  assert.match(post[0].v49_checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual({ tables: Number(post[1].tables), functions: Number(post[1].functions), triggers: Number(post[1].triggers), disabled: Number(post[1].disabled_triggers) },
    { tables: 7, functions: 22, triggers: 26, disabled: 0 }, "block 2");
  assert.equal(Number(post[2].system_types), 7);
  assert.equal(Number(post[2].club_copies), 7 * Number(post[2].active_clubs), "block 3: seven copies per active club");
  assert.equal(Number(post[2].other_rows), 0);
  assert.equal(Number(post[2].copies_without_seed_key), 0);
  assert.equal(Number(post[2].clubs_without_seven), 0);
  assert.deepEqual(Object.values(post[3]).map(Number), [0, 0, 0, 0, 0, 0], "block 4: nothing written by the deploy");
  assert.equal(Number(post[4].locks_on_calendar), 0, "block 5");
  assert.equal(Number(post[5].tables_granted), 0, "block 6: no Data API role holds a privilege");
  assert.equal(Number(post[6].clubs_without_seven), 0, "block 7");

  const rec = await q(`select count(*)::int as n from public.schema_migrations where migration_name like '%' || $1`, [V49]);
  assert.equal(rec[0].n, 1);
  const objs = (await q(`select (select count(*) from pg_tables where schemaname = 'calendar')::int as tables,
                                (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'calendar' and not t.tgisinternal)::int as triggers,
                                (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'calendar')::int as functions`))[0];
  assert.deepEqual(objs, { tables: 7, triggers: 26, functions: 22 }, "the post-check runbook's block 2 names the same counts");
  await assert.rejects(q(`delete from calendar.event_types where owner_scope = 'system' and kind = 'travel'`), (e) => e.code === "23514", "a system type is never deleted");
  assert.equal((await q(`select count(*)::int as n from calendar.event_types where owner_scope = 'system'`))[0].n, 7);
  const systemTypes = await q(`select kind, default_expects from calendar.event_types where owner_scope = 'system' order by sort_order`);
  assert.deepEqual(systemTypes.map((t) => [t.kind, t.default_expects]), [
    ["training", ["rpe"]], ["match", ["rpe"]], ["travel", []], ["meeting", []], ["day_off", []], ["camp", []], ["test", ["test_result"]],
  ], "D19: the seeded defaults");
  await assert.rejects(q(`update calendar.event_types set label = 'X' where owner_scope = 'system' and kind = 'training'`), (e) => e.code === "23514");
  // A type in use is kept by the events' foreign key; an unused copy goes
  // with its club (test 23). Here: a club's copy with an event cannot go.
  const c = await clubFixture("types-in-use");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  assert.equal((await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Uses the type", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).status, 201);
  await assert.rejects(q(`delete from calendar.event_types where id = $1`, [training.id]), (e) => e.code === "23503");
});

test("1b. the rollback rehearsal: apply -> rollback -> the v48 catalog digest identical -> re-apply; the rollback refuses once an event exists", async () => {
  const digestSql = `
    select md5(string_agg(x, '|' order by x)) as d from (
      select 'col:' || table_schema || '.' || table_name || '.' || column_name || ':' || data_type as x from information_schema.columns where table_schema not in ('pg_catalog', 'information_schema')
      union all
      select 'func:' || n.nspname || '.' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind = 'f'
      union all
      select 'trg:' || n.nspname || '.' || c.relname || '.' || t.tgname || ':' || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname not in ('pg_catalog', 'information_schema')
      union all
      select 'idx:' || schemaname || '.' || indexname || ':' || indexdef from pg_indexes where schemaname not in ('pg_catalog', 'information_schema')
    ) s`;
  const beforeOurs = MIGRATIONS.filter((m) => m !== V49);
  const other = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "k2arb", migrations: beforeOurs });
  const client = new pg.Client({ connectionString: other.url });
  await client.connect();
  try {
    const before = (await client.query(digestSql)).rows[0].d;
    // The preflight runbook on the database as it stands before v49: the
    // owner's expected values (block 7 is the server-wide quiet-moment read,
    // whose counts other test databases on the same server may change; it is
    // asserted to run, not to be zero).
    const pre = await runbookBlocks(client, "calendar-events-v49-preflight.sql");
    assert.equal(pre[0].pg15_or_later, true, "block 1");
    assert.equal(Number(pre[1].v48_rows), 1, "block 2");
    assert.match(pre[1].v48_checksum, /^[0-9a-f]{64}$/);
    assert.equal(Number(pre[1].v49_rows), 0);
    assert.equal(Number(pre[1].at_or_after_v49), 0);
    assert.equal(pre[1].last_migration, "migrations_v2/202610301900_training_load_v48_mapping_activations.sql");
    assert.equal(Number(pre[2].schema_rows), 0, "block 3");
    assert.ok(Object.values(pre[3]).every((v) => v === true), `block 4: ${JSON.stringify(pre[3])}`);
    assert.equal(pre[4].may_create_schema, true, "block 5");
    assert.ok(Number(pre[5].active_clubs) >= 0, "block 6");
    assert.ok("idle_in_transaction" in pre[6] && "strong_locks" in pre[6] && "other_migrators" in pre[6] && "migrator_lock_held" in pre[6], "block 7 runs");
    await applyGpexeTestMigrations(other.url, [V49]);
    assert.ok((await client.query(`select to_regclass('calendar.events') as t`)).rows[0].t, "v49 applied on the rehearsal database");
    const rollback = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks/calendar-events-v49-rollback.sql"), "utf8");
    await client.query(rollback);
    assert.equal((await client.query(`select to_regclass('calendar.events') as t`)).rows[0].t, null, "the schema is gone");
    assert.equal((await client.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%' || $1`, [V49])).rows[0].n, 0, "the record is gone");
    assert.equal((await client.query(digestSql)).rows[0].d, before, "the catalog is exactly v48's again");
    await applyGpexeTestMigrations(other.url, [V49]);
    assert.ok((await client.query(`select to_regclass('calendar.events') as t`)).rows[0].t, "re-applied");
    // The other refusals, each leaving the schema in place: a later migration
    // recorded, a catalog row that is not the seed, the migrator's lock held.
    const refused = async (label, re) => {
      await assert.rejects(client.query(rollback), (e) => re.test(e.message), label);
      await client.query("rollback").catch(() => {});
      assert.ok((await client.query(`select to_regclass('calendar.events') as t`)).rows[0].t, `${label}: nothing dropped`);
    };
    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912311000_later_test_only.sql', $1, 'test')`, ["f".repeat(64)]);
    await refused("a later migration", /later migration/);
    await client.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912311000_later_test_only.sql'`);
    const clubX = (await client.query(`insert into public.clubs (name) values ('rb club') returning id`)).rows[0].id;
    await client.query(`insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label) values ('club', $1, 'training', 'extra', 'Extra')`, [clubX]);
    await refused("a non-seed catalog row", /not the seed/);
    await client.query(`delete from calendar.event_types where owner_club_id = $1 and key = 'extra'`, [clubX]);
    const holder = new pg.Client({ connectionString: other.url });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(822026)`);
      await refused("the migrator's lock", /migrator holds its lock/);
    } finally {
      await holder.end();
    }
  } finally {
    await client.end().catch(() => {});
    await other.drop();
  }

  // On this suite's database an event exists: the rollback's guard refuses.
  const c = await clubFixture("rb");
  const created = await createEvent(c.clubAdmin.cookie, { eventTypeId: (await typeOf(c.clubAdmin.cookie, "meeting")).id, title: "Board", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(created.status, 201, created.text);
  const rollback = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks/calendar-events-v49-rollback.sql"), "utf8");
  await assert.rejects(admin.query(rollback), (e) => /rollback refused/.test(e.message) && /row\(s\) exist/.test(e.message));
  await admin.query("rollback").catch(() => {});
  assert.ok((await q(`select to_regclass('calendar.events') as t`))[0].t, "nothing was dropped");
});

// ---------------------------------------------------------------------------
// 2. The types
// ---------------------------------------------------------------------------
test("2. GET /types: the club's copy for the club and its teams, the system set for a private coach and the platform; the athlete 403", async () => {
  const c = await clubFixture("types");
  const forAdmin = await typesOf(c.clubAdmin.cookie);
  assert.equal(forAdmin.status, 200, forAdmin.text);
  assert.equal(forAdmin.body.types.length, 7);
  assert.ok(forAdmin.body.types.every((t) => t.ownerScope === "club"));
  assert.deepEqual(forAdmin.body.types.map((t) => t.kind), ["training", "match", "travel", "meeting", "day_off", "camp", "test"]);
  const forCoach = await typesOf(c.coach1.cookie);
  assert.deepEqual(forCoach.body.types.map((t) => t.id), forAdmin.body.types.map((t) => t.id), "the team coach picks from the club's copy");
  const forPrivate = await typesOf((await privateCoach()).cookie);
  assert.equal(forPrivate.body.types.length, 7);
  assert.ok(forPrivate.body.types.every((t) => t.ownerScope === "system"));
  const forPlatform = await typesOf((await platformAdmin()).cookie);
  assert.ok(forPlatform.body.types.every((t) => t.ownerScope === "system"));
  assert.equal((await typesOf(c.a1.cookie)).status, 403);
  assert.equal((await typesOf()).status, 401);
});

// ---------------------------------------------------------------------------
// 3. Create per workspace
// ---------------------------------------------------------------------------
test("3. create: the club admin for the club, the team coach for the team, the private coach for their athletes; the platform workspace, the athlete and a stranger cannot", async () => {
  const c = await clubFixture("cr");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const res = await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Club training", day: FUTURE, startTime: "17:30", endTime: "19:00", location: "Main pitch", targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(res.status, 201, res.text);
  const ev = res.body.event;
  assert.equal(ev.ownerScope, "club");
  assert.equal(ev.ownerClubId, c.clubId);
  assert.equal(ev.revision, 1);
  assert.equal(ev.status, "planned");
  assert.deepEqual(ev.expects, ["rpe"], "the type's default (D19)");
  assert.equal(ev.canManage, true);
  assert.equal(ev.eventKind, "training");
  assert.equal(ev.startTime, "17:30");
  assert.equal(ev.endTime, "19:00");
  assert.deepEqual(ev.targets.map((t) => t.kind), ["club"]);
  assert.equal(ev.notes, null);

  const teamRes = await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Team training", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(teamRes.status, 201, teamRes.text);
  assert.equal(teamRes.body.event.ownerScope, "team");
  assert.equal(teamRes.body.event.ownerTeamId, c.team1);

  const p = await privateCoach("pc");
  const own = await makeAthlete("own athlete");
  await q(`insert into public.user_athletes (user_id, athlete_id) values ($1, $2)`, [p.id, own.athleteId]);
  const meetingSys = await typeOf(p.cookie, "meeting");
  const privateRes = await createEvent(p.cookie, { eventTypeId: meetingSys.id, title: "Talk", day: FUTURE, targets: [{ kind: "athlete", id: own.athleteId }] });
  assert.equal(privateRes.status, 201, privateRes.text);
  assert.equal(privateRes.body.event.ownerScope, "user");
  assert.deepEqual(privateRes.body.event.expects, []);

  const platform = await platformAdmin();
  const platformRes = await createEvent(platform.cookie, { eventTypeId: training.id, title: "X", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(platformRes.status, 403);
  assert.equal(platformRes.body.error, "workspace_required");

  const athleteRes = await createEvent(c.a1.cookie, { eventTypeId: training.id, title: "X", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(athleteRes.status, 403);
  assert.deepEqual(athleteRes.body, { error: "Forbidden" });

  const nobody = await withCookie(await makeUser("nobody"));
  assert.equal((await createEvent(nobody.cookie, { eventTypeId: training.id, title: "X", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).status, 403);
  assert.equal((await createEvent(undefined, { eventTypeId: training.id, title: "X", day: FUTURE, targets: [] })).status, 401);
});

// ---------------------------------------------------------------------------
// 4. Validation and the target rules
// ---------------------------------------------------------------------------
test("4. 400s: the body's shape; a type of another club; every target rule with one identical answer for a missing and a foreign id", async () => {
  const c = await clubFixture("val");
  const other = await clubFixture("other");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const base = { eventTypeId: training.id, title: "T", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] };
  const expect400 = async (over, code, cookie = c.clubAdmin.cookie) => {
    const res = await api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: newKey(), timezone: TZ, ...base, ...over } });
    assert.equal(res.status, 400, `${code}: ${res.text}`);
    assert.equal(res.body.error, code, res.text);
    return res;
  };
  await expect400({ requestKey: "nope" }, "invalid_request_key");
  await expect400({ title: "" }, "invalid_title");
  await expect400({ title: "x".repeat(121) }, "invalid_title");
  await expect400({ title: "a​b" }, "invalid_title");
  await expect400({ day: "2026-02-30" }, "invalid_day");
  await expect400({ endDay: addDays(FUTURE, -1) }, "invalid_day");
  await expect400({ startTime: "25:00" }, "invalid_time");
  await expect400({ endTime: "10:00" }, "invalid_time");
  await expect400({ startTime: "10:00", endTime: "09:00" }, "invalid_time");
  await expect400({ endDay: FUTURE, startTime: "10:00", endTime: "09:00" }, "invalid_time");
  await expect400({ endDay: addDays(FUTURE, 367) }, "invalid_day");
  await expect400({ timezone: "Mars/Olympus" }, "invalid_timezone");
  await expect400({ timezone: "" }, "invalid_timezone");
  await expect400({ expects: ["rpe", "rpe"] }, "invalid_expects");
  await expect400({ expects: ["attendance"] }, "invalid_expects");
  await expect400({ notes: "x".repeat(2001) }, "invalid_notes");
  await expect400({ location: "x".repeat(121) }, "invalid_location");
  await expect400({ targets: [] }, "invalid_targets");
  await expect400({ targets: [{ kind: "group", id: c.team1 }] }, "invalid_targets");
  await expect400({ targets: Array.from({ length: 201 }, () => ({ kind: "athlete", id: crypto.randomUUID() })) }, "invalid_targets");
  await expect400({ eventTypeId: crypto.randomUUID() }, "type_not_available");
  const otherType = await typeOf(other.clubAdmin.cookie, "training");
  await expect400({ eventTypeId: otherType.id }, "type_not_available");
  const sysType = (await q(`select id from calendar.event_types where owner_scope = 'system' and kind = 'training'`))[0].id;
  await expect400({ eventTypeId: sysType }, "type_not_available");

  // Targets: a club event.
  const foreignTeam = await expect400({ targets: [{ kind: "team", id: other.team1 }] }, "target_not_available");
  const randomTeam = await expect400({ targets: [{ kind: "team", id: crypto.randomUUID() }] }, "target_not_available");
  assert.equal(foreignTeam.text, randomTeam.text, "a foreign and a random id answer the byte-identical body");
  await expect400({ targets: [{ kind: "club", id: other.clubId }] }, "target_not_available");
  await expect400({ targets: [{ kind: "athlete", id: other.a1.athleteId }] }, "target_not_available");
  const archivedTeam = await makeTeam(c.clubId, "archived");
  await q(`update public.teams set is_active = false where id = $1`, [archivedTeam]);
  await expect400({ targets: [{ kind: "team", id: archivedTeam }] }, "target_not_available");
  // Targets: a team event.
  const teamBase = { eventTypeId: training.id, title: "T", day: FUTURE };
  await expect400({ ...teamBase, targets: [{ kind: "club", id: c.clubId }] }, "target_not_available", c.coach1.cookie);
  await expect400({ ...teamBase, targets: [{ kind: "team", id: c.team2 }] }, "target_not_available", c.coach1.cookie);
  await expect400({ ...teamBase, targets: [{ kind: "athlete", id: c.a3.athleteId }] }, "target_not_available", c.coach1.cookie);
  // Targets: a private coach.
  const p = await privateCoach("pval");
  const meetingSys = await typeOf(p.cookie, "meeting");
  await expect400({ eventTypeId: meetingSys.id, targets: [{ kind: "team", id: c.team1 }] }, "target_not_available", p.cookie);
  await expect400({ eventTypeId: meetingSys.id, targets: [{ kind: "athlete", id: c.a1.athleteId }] }, "target_not_available", p.cookie);
  // Membership on the day: an athlete who left before the event's day.
  const left = await makeAthlete("left", { clubId: c.clubId, teamId: c.team1 });
  await archiveMembership(await teamMembershipId(left.athleteId, c.team1), `${addDays(TODAY, -1)}T10:00:00Z`);
  await expect400({ ...teamBase, targets: [{ kind: "athlete", id: left.athleteId }] }, "target_not_available", c.coach1.cookie);
  const stillOnPast = await createEvent(c.coach1.cookie, { ...teamBase, day: PAST, targets: [{ kind: "athlete", id: left.athleteId }] });
  assert.equal(stillOnPast.status, 201, "a member on the event's day is a valid target");

  // Nothing of all that was written.
  assert.equal((await q(`select count(*)::int as n from calendar.events where owner_club_id = $1 or owner_team_id in ($2, $3)`, [c.clubId, c.team1, c.team2]))[0].n, 1);
  assert.equal((await q(`select count(*)::int as n from calendar.event_requests r join calendar.events e on e.id = r.event_id where e.owner_club_id = $1 or e.owner_team_id in ($2, $3)`, [c.clubId, c.team1, c.team2]))[0].n, 1, "a refused request leaves no row");
});

test("5. expects as chosen (D19), a multi-day event (D22), the time zone and the DB twin of the text rule", async () => {
  const c = await clubFixture("ex");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const camp = await typeOf(c.clubAdmin.cookie, "camp");
  const none = await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "No RPE", day: FUTURE, expects: [], targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(none.status, 201, none.text);
  assert.deepEqual(none.body.event.expects, []);
  const both = await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "GPS", day: FUTURE, expects: ["device_data", "rpe"], targets: [{ kind: "club", id: c.clubId }] });
  assert.deepEqual(both.body.event.expects, ["rpe", "device_data"], "stored in the fixed order");
  const multi = await createEvent(c.clubAdmin.cookie, { eventTypeId: camp.id, title: "Camp", day: FUTURE, endDay: addDays(FUTURE, 3), startTime: "09:00", endTime: "15:00", location: "Zlatibor", timezone: "Europe/Belgrade", targets: [{ kind: "team", id: c.team1 }, { kind: "team", id: c.team2 }] });
  assert.equal(multi.status, 201, multi.text);
  assert.equal(multi.body.event.endDay, addDays(FUTURE, 3));
  assert.equal(multi.body.event.timezone, "Europe/Belgrade");
  assert.deepEqual(multi.body.event.targets.map((t) => t.kind), ["team", "team"]);
  assert.ok(multi.body.event.targets.every((t) => typeof t.name === "string" && t.name.length > 0), "a team target carries the team's name");
  // The read shows one card per day of the span inside the window.
  const res = await calendar(c.clubAdmin.cookie);
  assert.equal(res.status, 200, res.text);
  const cards = eventCards(res, multi.body.event.id);
  assert.equal(cards.length, 4);
  assert.deepEqual(cards.map((x) => x.date), [FUTURE, addDays(FUTURE, 1), addDays(FUTURE, 2), addDays(FUTURE, 3)]);
  assert.deepEqual(cards[0].span, { from: FUTURE, to: addDays(FUTURE, 3) });
  assert.equal(cards[0].endTime, "15:00");
  assert.equal(cards[0].location, "Zlatibor");
});

// ---------------------------------------------------------------------------
// 6. Idempotency
// ---------------------------------------------------------------------------
test("6. requestKey: the same body replays the saved answer; another body is refused; a refused request leaves the key free", async () => {
  const c = await clubFixture("idem");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const key = newKey();
  const body = { requestKey: key, timezone: TZ, eventTypeId: meeting.id, title: "Staff meeting", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] };
  const first = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body });
  assert.equal(first.status, 201, first.text);
  const again = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.event.id, first.body.event.id);
  assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Staff meeting' and owner_club_id = $1`, [c.clubId]))[0].n, 1, "one event");
  assert.equal((await q(`select count(*)::int as n from calendar.event_requests where request_key = $1`, [key]))[0].n, 1, "one request row");
  const other = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, title: "Another" } });
  assert.equal(other.status, 409);
  assert.equal(other.body.error, "request_key_reused");
  // Another user's key is their own: the same key by the coach is a new request.
  const coachKey = await api("/api/calendar/events", { method: "POST", cookie: c.coach1.cookie, body: { ...body, targets: [{ kind: "team", id: c.team1 }] } });
  assert.equal(coachKey.status, 201, coachKey.text);
  assert.notEqual(coachKey.body.event.id, first.body.event.id);
  // A refused request leaves the key free.
  const freeKey = newKey();
  const refused = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, requestKey: freeKey, targets: [{ kind: "team", id: crypto.randomUUID() }] } });
  assert.equal(refused.status, 400);
  const thenOk = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, requestKey: freeKey, title: "After a refusal" } });
  assert.equal(thenOk.status, 201, thenOk.text);
  assert.equal(thenOk.body.replayed, undefined);
});

// ---------------------------------------------------------------------------
// 7. Update and cancel
// ---------------------------------------------------------------------------
test("7. PATCH: revision, the fields, the targets replaced and judged on the new day, the type changed; a stale revision answers event_changed with the current event", async () => {
  const c = await clubFixture("upd");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const created = await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Training", day: FUTURE, startTime: "17:00", targets: [{ kind: "team", id: c.team1 }] });
  const id = created.body.event.id;
  const noRevision = await patchEvent(c.clubAdmin.cookie, id, { title: "X" });
  assert.equal(noRevision.status, 400);
  assert.equal(noRevision.body.error, "invalid_revision");
  const nothing = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 1 });
  assert.equal(nothing.status, 400);
  assert.equal(nothing.body.error, "nothing_to_change");
  const renamed = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 1, title: "Renamed", location: "Hall", notes: "Bring\nthe cones" });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.event.revision, 2);
  assert.equal(renamed.body.event.title, "Renamed");
  assert.equal(renamed.body.event.notes, "Bring\nthe cones");
  const stale = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 1, title: "Stale" });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.body.error, "event_changed");
  assert.equal(stale.body.current.revision, 2);
  assert.equal(stale.body.current.title, "Renamed");
  // Targets replaced; an unknown athlete refused and nothing written (a3, a
  // member of the club's other team, is a valid target of a CLUB event).
  const badTargets = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 2, targets: [{ kind: "athlete", id: crypto.randomUUID() }, { kind: "team", id: c.team1 }] });
  assert.equal(badTargets.status, 400, badTargets.text);
  assert.equal(badTargets.body.error, "target_not_available");
  assert.equal((await q(`select revision from calendar.events where id = $1`, [id]))[0].revision, 2);
  const retargeted = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 2, targets: [{ kind: "athlete", id: c.a1.athleteId }, { kind: "athlete", id: c.a2.athleteId }] });
  assert.equal(retargeted.status, 200, retargeted.text);
  assert.deepEqual(retargeted.body.event.targets.map((t) => t.kind), ["athlete", "athlete"]);
  assert.equal(retargeted.body.event.revision, 3);
  // The day moved: the targets are judged again on the new day. A current
  // member's earlier day passes (the calendar's fallback before their first
  // period, K1a decision 4); a day after a target left is refused.
  const earlier = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 3, day: "2025-12-01" });
  assert.equal(earlier.status, 200, earlier.text);
  const back = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 4, day: FUTURE });
  assert.equal(back.status, 200, back.text);
  const left = await makeAthlete("upd left", { clubId: c.clubId, teamId: c.team1 });
  const pastEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "With leaver", day: PAST, targets: [{ kind: "athlete", id: left.athleteId }] })).body.event;
  await archiveMembership(await teamMembershipId(left.athleteId, c.team1), `${addDays(TODAY, -1)}T10:00:00Z`);
  const tooLate = await patchEvent(c.coach1.cookie, pastEvent.id, { expectedRevision: 1, day: FUTURE });
  assert.equal(tooLate.status, 400, tooLate.text);
  assert.equal(tooLate.body.error, "target_not_available");
  assert.equal((await q(`select day::text as day from calendar.events where id = $1`, [pastEvent.id]))[0].day, PAST, "nothing written");
  // The type changed; expects stays as it is unless sent (D19: the client sends the ticked set).
  const retyped = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 5, eventTypeId: meeting.id, expects: [] });
  assert.equal(retyped.status, 200, retyped.text);
  assert.equal(retyped.body.event.eventKind, "meeting");
  assert.deepEqual(retyped.body.event.expects, []);
  // Times.
  const times = await patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 6, startTime: null, endTime: "18:00" });
  assert.equal(times.status, 400);
  assert.equal(times.body.error, "invalid_time");
  // Two concurrent edits with the same expectedRevision: one lands, the other sees the change.
  const [r1, r2] = await Promise.all([
    patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 6, title: "One" }),
    patchEvent(c.clubAdmin.cookie, id, { expectedRevision: 6, title: "Two" }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `${r1.text} / ${r2.text}`);
  assert.equal((r1.status === 409 ? r1 : r2).body.error, "event_changed");
  assert.equal((await q(`select revision from calendar.events where id = $1`, [id]))[0].revision, 7);
});

test("8. cancel: the facts, then final; the identical 404 for every stranger; the club admin edits the team's event (D18), the team coach not the club's", async () => {
  const c = await clubFixture("can");
  const other = await clubFixture("can-other");
  const training = await typeOf(c.coach1.cookie, "training");
  const teamEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Team training", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  const clubEvent = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Club training", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;

  // Strangers: the one body.
  const strangers = [
    ["another club's admin", other.clubAdmin.cookie, teamEvent.id],
    ["another club's coach", other.coach1.cookie, teamEvent.id],
    ["the other team's coach of the same club", c.coach2.cookie, teamEvent.id],
    ["the team coach on the club-owned event", c.coach1.cookie, clubEvent.id],
    ["an athlete", c.a1.cookie, teamEvent.id],
    ["a random id", c.clubAdmin.cookie, crypto.randomUUID()],
    ["a malformed id", c.clubAdmin.cookie, "not-a-uuid"],
  ];
  const bodies = new Set();
  for (const [label, cookie, id] of strangers) {
    const patch = await patchEvent(cookie, id, { expectedRevision: 1, title: "Hijack" });
    assert.equal(patch.status, 404, `${label}: ${patch.text}`);
    bodies.add(patch.text);
    const cancel = await cancelEvent(cookie, id, { expectedRevision: 1 });
    assert.equal(cancel.status, 404, `${label}: ${cancel.text}`);
    bodies.add(cancel.text);
    const get = await getEvent(cookie, id);
    if (label !== "the team coach on the club-owned event") {
      assert.equal(get.status, 404, `${label}: ${get.text}`);
      bodies.add(get.text);
    }
  }
  assert.equal(bodies.size, 1, `every stranger reads the byte-identical 404 body: ${[...bodies].join(" | ")}`);
  assert.equal([...bodies][0], JSON.stringify({ error: "notFound", message: "Not found." }));
  assert.equal((await q(`select title, status from calendar.events where id = $1`, [teamEvent.id]))[0].title, "Team training");

  // The team coach reads the club's event (it targets the team's club) but cannot manage it.
  const read = await getEvent(c.coach1.cookie, clubEvent.id);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.event.canManage, false);
  assert.equal("notes" in read.body.event, false, "notes are the manager's");

  // D18: the club admin edits and cancels the team's event.
  const byAdmin = await patchEvent(c.clubAdmin.cookie, teamEvent.id, { expectedRevision: 1, title: "Moved by the club" });
  assert.equal(byAdmin.status, 200, byAdmin.text);
  const cancelled = await cancelEvent(c.clubAdmin.cookie, teamEvent.id, { expectedRevision: 2, reason: "Pitch flooded" });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal(cancelled.body.event.status, "cancelled");
  assert.ok(cancelled.body.event.cancelledAt);
  assert.equal(cancelled.body.event.cancelReason, "Pitch flooded");
  assert.equal(cancelled.body.event.revision, 3);
  const afterCancel = await patchEvent(c.coach1.cookie, teamEvent.id, { expectedRevision: 3, title: "Too late" });
  assert.equal(afterCancel.status, 409, afterCancel.text);
  assert.equal(afterCancel.body.error, "event_cancelled");
  assert.equal(afterCancel.body.current.status, "cancelled");
  const twice = await cancelEvent(c.coach1.cookie, teamEvent.id, { expectedRevision: 3 });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "event_cancelled");
  const changes = await q(`select kind, basis, reason from calendar.event_changes where event_id = $1 order by performed_at`, [teamEvent.id]);
  assert.deepEqual(changes, [
    { kind: "create", basis: "team_coach", reason: null },
    { kind: "update", basis: "club_admin", reason: null },
    { kind: "cancel", basis: "club_admin", reason: "Pitch flooded" },
  ]);
  // The platform admin manages from the platform workspace (support).
  const platform = await platformAdmin();
  const support = await patchEvent(platform.cookie, clubEvent.id, { expectedRevision: 1, title: "Support edit" });
  assert.equal(support.status, 200, support.text);
  assert.equal((await q(`select basis from calendar.event_changes where event_id = $1 and kind = 'update'`, [clubEvent.id]))[0].basis, "platform_admin");
});

// ---------------------------------------------------------------------------
// 9. The read
// ---------------------------------------------------------------------------
test("9. GET /api/calendar: event cards per workspace with canManage, kinds, include=athletes; the athlete's reduced view carries no teammate and no count; a former member sees no later day", async () => {
  const c = await clubFixture("read");
  const other = await clubFixture("read-other");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const clubEvent = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Club day", day: FUTURE, startTime: "10:00", location: "Stadium", notes: "Internal", targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const teamEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Team session", day: FUTURE, startTime: "17:30", targets: [{ kind: "team", id: c.team1 }] })).body.event;
  // D21 "teams": a direct target on a club-owned event names no team; on a team-owned event it names the owner team.
  const directClub = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "One to one (club)", day: FUTURE, targets: [{ kind: "athlete", id: c.a1.athleteId }] })).body.event;
  const directTeam = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "One to one (team)", day: FUTURE, targets: [{ kind: "athlete", id: c.a1.athleteId }] })).body.event;
  const left = await makeAthlete("read left", { clubId: c.clubId, teamId: c.team1 });
  const pastTeamEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Earlier session", day: PAST, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  await archiveMembership(await teamMembershipId(left.athleteId, c.team1), `${addDays(TODAY, -1)}T10:00:00Z`);
  await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where athlete_id = $1 and membership_type = 'club'`, [left.athleteId, `${addDays(TODAY, -1)}T10:00:00Z`]);

  // The club admin: both, manageable.
  const adminRes = await calendar(c.clubAdmin.cookie);
  assert.equal(adminRes.status, 200, adminRes.text);
  const adminClub = eventCards(adminRes, clubEvent.id)[0];
  const adminTeam = eventCards(adminRes, teamEvent.id)[0];
  assert.ok(adminClub && adminTeam);
  assert.equal(adminClub.canManage, true);
  assert.equal(adminTeam.canManage, true, "D18");
  assert.equal(adminClub.notes, "Internal");
  assert.equal(adminClub.status, "planned");
  assert.deepEqual(adminClub.expects, ["rpe"]);
  assert.deepEqual(adminClub.gaps, ["rpe"], "no channel yet: a gap, not an alarm");
  assert.equal(adminClub.startTime, "10:00");
  assert.equal(adminClub.location, "Stadium");
  assert.equal(adminClub.eventKind, "training");
  assert.equal(adminClub.athleteCount, 3, "the club's three athletes on that day");
  assert.deepEqual([...adminClub.teamIds].sort(), [c.team1, c.team2].sort());
  assert.deepEqual(adminTeam.teamIds, [c.team1]);
  assert.equal(adminTeam.athleteCount, 2);

  // The team coach: the team's event manageable, the club's not; the other team's coach sees the club's only.
  const coachRes = await calendar(c.coach1.cookie);
  assert.equal(eventCards(coachRes, teamEvent.id)[0].canManage, true);
  const coachClub = eventCards(coachRes, clubEvent.id)[0];
  assert.equal(coachClub.canManage, false);
  assert.equal("notes" in coachClub, false);
  assert.equal("eventTypeId" in coachClub, false, "a reader gets no type id");
  assert.deepEqual(Object.keys(coachClub.links).sort(), ["activityIds", "eventId"], "a reader gets no schedule id");
  assert.equal("eventTypeId" in eventCards(coachRes, teamEvent.id)[0], true, "the manager keeps it");
  assert.equal(coachClub.athleteCount, 2, "the team coach sees the club event with the team's athletes only");
  const coach2Res = await calendar(c.coach2.cookie);
  assert.equal(eventCards(coach2Res, teamEvent.id).length, 0);
  assert.equal(eventCards(coach2Res, clubEvent.id).length, 1);

  // Another club sees nothing of it.
  const otherRes = await calendar(other.clubAdmin.cookie);
  assert.equal(ofKind(allItems(otherRes), "event").filter((i) => [clubEvent.id, teamEvent.id].includes(i.eventId)).length, 0);

  // kinds.
  const onlyEvents = await calendar(c.clubAdmin.cookie, { extra: "&kinds=event" });
  assert.ok(allItems(onlyEvents).every((i) => i.kind === "event"));
  assert.equal(eventCards(onlyEvents, clubEvent.id).length, 1);
  const noEvents = await calendar(c.clubAdmin.cookie, { extra: "&kinds=planned,activity" });
  assert.equal(ofKind(allItems(noEvents), "event").length, 0);
  const badKind = await calendar(c.clubAdmin.cookie, { extra: "&kinds=events" });
  assert.equal(badKind.status, 400);

  // include=athletes for a coach.
  const withAthletes = await calendar(c.coach1.cookie, { extra: "&include=athletes" });
  const teamCard = eventCards(withAthletes, teamEvent.id)[0];
  assert.deepEqual(teamCard.athletes.map((a) => a.athleteId).sort(), [c.a1.athleteId, c.a2.athleteId].sort());
  assert.ok(teamCard.athletes.every((a) => a.rpe === null && a.result === null));

  // The athlete (D21): the two events of their teams and club, reduced.
  const athleteRes = await calendar(c.a1.cookie, { extra: "&include=athletes" });
  assert.equal(athleteRes.status, 200, athleteRes.text);
  const athleteCards = ofKind(allItems(athleteRes), "event");
  assert.deepEqual(athleteCards.map((i) => i.links.eventId).sort(), [clubEvent.id, pastTeamEvent.id, teamEvent.id, directClub.id, directTeam.id].sort());
  const teamsByEvent = Object.fromEntries(athleteCards.map((card) => [card.links.eventId, card.teamIds]));
  assert.deepEqual(teamsByEvent[teamEvent.id], [c.team1], "D21 teams: the athlete's own team among the event's team targets");
  assert.deepEqual(teamsByEvent[pastTeamEvent.id], [c.team1]);
  assert.deepEqual(teamsByEvent[clubEvent.id], [], "a club target names no team");
  assert.deepEqual(teamsByEvent[directClub.id], [], "a direct athlete target on a club-owned event names no team");
  assert.deepEqual(teamsByEvent[directTeam.id], [c.team1], "a direct athlete target on a team-owned event names the owner team");
  const allowed = ["key", "kind", "date", "title", "eventKind", "eventTypeLabel", "span", "startTime", "endTime", "location", "status", "cancelled", "teamIds", "links"].sort();
  for (const card of athleteCards) {
    assert.deepEqual(Object.keys(card).sort(), allowed, `the athlete's card carries only the allowed fields: ${Object.keys(card).join(",")}`);
    assert.deepEqual(Object.keys(card.links), ["eventId"]);
    assert.equal(card.status, "planned");
  }
  assert.equal(JSON.stringify(athleteRes.body).includes(c.a2.athleteId), false, "no teammate id anywhere");
  assert.equal(JSON.stringify(athleteRes.body).includes(c.a2.name), false, "no teammate name anywhere");
  assert.equal(JSON.stringify(athleteRes.body).includes("Internal"), false, "no notes");
  // The other team's athlete sees the club's event, not the team's.
  const a3Res = await calendar(c.a3.cookie);
  assert.equal(eventCards(a3Res, clubEvent.id).length, 1);
  assert.equal(eventCards(a3Res, teamEvent.id).length, 0);
  // The former member: the past day stays, the later day is gone (the P1 rule).
  const leftRes = await calendar(left.cookie);
  assert.equal(eventCards(leftRes, pastTeamEvent.id).length, 1, "a member on that day");
  assert.equal(eventCards(leftRes, teamEvent.id).length, 0, "no longer a member on the later day");
  assert.equal(eventCards(leftRes, clubEvent.id).length, 0);
  // Another club's athlete sees nothing.
  assert.equal(ofKind(allItems(await calendar(other.a1.cookie)), "event").filter((i) => [clubEvent.id, teamEvent.id].includes(i.links.eventId)).length, 0);
  // The club admin's Team filter narrows.
  const filtered = await calendar(c.clubAdmin.cookie, { extra: `&teamIds=${c.team2}` });
  assert.equal(eventCards(filtered, teamEvent.id).length, 0);
  assert.equal(eventCards(filtered, clubEvent.id).length, 1);
  assert.equal(eventCards(filtered, clubEvent.id)[0].athleteCount, 1);
  // The platform workspace reads everything.
  const platform = await platformAdmin();
  const platformRes = await calendar(platform.cookie);
  assert.equal(eventCards(platformRes, teamEvent.id).length, 1);
});

test("10. the fold: a referenced external schedule's day card disappears into the event (rpe x/y, per-athlete states, links), whatever kinds asks; a test schedule the same; one planned event per schedule; another club's schedule is not available", async () => {
  const c = await clubFixture("fold");
  const other = await clubFixture("fold-other");
  const match = await typeOf(c.coach1.cookie, "match");
  const testType = await typeOf(c.coach1.cookie, "test");
  const training = await typeOf(c.coach1.cookie, "training");
  const schedule = await makeExternalSchedule({ owner: { scope: "team", teamId: c.team1 }, createdBy: c.coach1.id, startDate: PAST, eventName: "Away match RPE", targets: [{ kind: "team", id: c.team1 }] });
  const occurrence = await makeExternalOccurrence(schedule, PAST);
  const asg1 = await makeExternalAssignment(occurrence, c.a1.athleteId, PAST, "completed");
  await makeExternalAssignment(occurrence, c.a2.athleteId, PAST, "pending");
  await externalFeedback(c.a1.athleteId, asg1, PAST);

  const before = await calendar(c.coach1.cookie);
  const externalCard = allItems(before).find((i) => i.key === `external:${schedule}:${PAST}`);
  assert.ok(externalCard, "the external card stands alone before the event");
  assert.deepEqual(externalCard.rpe, { asked: 2, submitted: 1, missed: 0 });

  const created = await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Away match", day: PAST, startTime: "19:00", externalScheduleId: schedule, targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  assert.equal(ev.externalScheduleId, schedule);

  const after = await calendar(c.coach1.cookie, { extra: "&include=athletes" });
  assert.equal(allItems(after).some((i) => i.key === `external:${schedule}:${PAST}`), false, "the external card is folded, never emitted alone");
  const card = eventCards(after, ev.id)[0];
  assert.ok(card);
  assert.deepEqual(card.rpe, { asked: 2, submitted: 1, missed: 0 });
  assert.equal(card.status, "awaiting_entry", "the day passed with one RPE missing");
  assert.deepEqual(card.gaps, []);
  assert.equal(card.links.externalScheduleId, schedule);
  assert.equal(card.links.externalOccurrenceId, occurrence);
  const states = Object.fromEntries(card.athletes.map((a) => [a.athleteId, a.rpe]));
  assert.equal(states[c.a1.athleteId], "submitted");
  assert.equal(states[c.a2.athleteId], "missing");
  // kinds=event alone still folds (the schedule is read because the event refers to it); kinds=external alone never shows the folded card.
  const eventsOnly = await calendar(c.coach1.cookie, { extra: "&kinds=event" });
  assert.deepEqual(eventCards(eventsOnly, ev.id)[0].rpe, { asked: 2, submitted: 1, missed: 0 });
  const externalOnly = await calendar(c.coach1.cookie, { extra: "&kinds=external" });
  assert.equal(allItems(externalOnly).some((i) => i.key === `external:${schedule}:${PAST}`), false);
  assert.equal(ofKind(allItems(externalOnly), "event").length, 0);
  // The athlete's view of the same event: planned / cancelled only, no counts.
  const athleteRes = await calendar(c.a2.cookie);
  const athleteCard = eventCards(athleteRes, ev.id)[0];
  assert.ok(athleteCard);
  assert.equal(athleteCard.status, "planned");
  assert.equal("rpe" in athleteCard, false);

  // One planned event per schedule; a cancelled one frees it.
  const second = await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Again", day: PAST, externalScheduleId: schedule, targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(second.status, 409, second.text);
  assert.equal(second.body.error, "schedule_already_referenced");
  // Another club's schedule, a random id: the same 400.
  const foreignSchedule = await makeExternalSchedule({ owner: { scope: "team", teamId: other.team1 }, createdBy: other.coach1.id, startDate: PAST, targets: [{ kind: "team", id: other.team1 }] });
  const foreign = await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Foreign", day: PAST, externalScheduleId: foreignSchedule, targets: [{ kind: "team", id: c.team1 }] });
  const random = await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Foreign", day: PAST, externalScheduleId: crypto.randomUUID(), targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(foreign.status, 400, foreign.text);
  assert.equal(foreign.body.error, "schedule_not_available");
  assert.equal(foreign.text, random.text);
  // A test schedule only on a test event; then its day folds with results.
  const testSchedule = await makeTestSchedule({ owner: { scope: "team", teamId: c.team1 }, createdBy: c.coach1.id, startDate: PAST, targets: [{ kind: "team", id: c.team1 }] });
  const testOcc = await makeTestOccurrence(testSchedule, PAST);
  await makeTestAssignment(testOcc, c.a1.athleteId, PAST, "completed");
  await makeTestAssignment(testOcc, c.a2.athleteId, PAST, "completed");
  const mismatch = await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Wrong kind", day: PAST, testScheduleId: testSchedule, targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(mismatch.status, 409, mismatch.text);
  assert.equal(mismatch.body.error, "schedule_kind_mismatch");
  const testEvent = await createEvent(c.coach1.cookie, { eventTypeId: testType.id, title: "Wellness", day: PAST, testScheduleId: testSchedule, targets: [{ kind: "team", id: c.team1 }] });
  assert.equal(testEvent.status, 201, testEvent.text);
  const withTest = await calendar(c.coach1.cookie);
  assert.equal(allItems(withTest).some((i) => i.key === `test:${testSchedule}:${PAST}`), false, "the test card is folded");
  const testCard = eventCards(withTest, testEvent.body.event.id)[0];
  assert.deepEqual(testCard.results, { expected: 2, completed: 2, missed: 0 });
  assert.equal(testCard.status, "done");
  assert.equal(testCard.links.testOccurrenceId, testOcc);
  // Clearing the reference brings the schedule's own card back.
  const cleared = await patchEvent(c.coach1.cookie, testEvent.body.event.id, { expectedRevision: 1, testScheduleId: null });
  assert.equal(cleared.status, 200, cleared.text);
  const afterClear = await calendar(c.coach1.cookie);
  assert.ok(allItems(afterClear).some((i) => i.key === `test:${testSchedule}:${PAST}`));
  assert.deepEqual(eventCards(afterClear, testEvent.body.event.id)[0].gaps, ["test_result"]);
});

test("11. status x expects (D15): a meeting is none; a training expecting RPE without a channel reads planned, then none with a gap; device_data without an import waits; cancelled; the untimed event sorts first", async () => {
  const c = await clubFixture("st");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const club = [{ kind: "club", id: c.clubId }];
  const pastMeeting = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "Past meeting", day: PAST, targets: club })).body.event;
  const pastTraining = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Past training", day: PAST, startTime: "18:00", targets: club })).body.event;
  const futureTraining = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Future training", day: FUTURE, targets: club })).body.event;
  const pastGps = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "GPS session", day: PAST, startTime: "09:00", expects: ["device_data"], targets: club })).body.event;
  const cancelledOne = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Cancelled", day: PAST, startTime: "12:00", targets: club })).body.event;
  assert.equal((await cancelEvent(c.clubAdmin.cookie, cancelledOne.id, { expectedRevision: 1 })).status, 200);
  const res = await calendar(c.clubAdmin.cookie);
  const by = (id) => eventCards(res, id)[0];
  assert.equal(by(pastMeeting.id).status, "none");
  assert.deepEqual(by(pastMeeting.id).gaps, []);
  assert.equal(by(pastTraining.id).status, "none", "nobody could answer: never awaiting");
  assert.deepEqual(by(pastTraining.id).gaps, ["rpe"]);
  assert.equal(by(futureTraining.id).status, "planned");
  assert.deepEqual(by(futureTraining.id).gaps, ["rpe"]);
  assert.equal(by(pastGps.id).status, "awaiting_entry", "the import is the coach's own next step");
  assert.deepEqual(by(pastGps.id).gaps, []);
  assert.equal(by(cancelledOne.id).status, "cancelled");
  assert.equal(by(cancelledOne.id).cancelled, true);
  // Order on PAST: the untimed meeting first, then by start time.
  const pastEvents = ofKind(itemsOn(res, PAST), "event").map((i) => i.title);
  assert.deepEqual(pastEvents, ["Past meeting", "GPS session", "Cancelled", "Past training"]);
});

// ---------------------------------------------------------------------------
// 12. The audit, the bounded COMMIT, the club seed
// ---------------------------------------------------------------------------
test("12. the audit pair is required by the database; a change without its request, a request without its change, and a mismatched pair are refused", async () => {
  const c = await clubFixture("audit");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const ev = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "Audit", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const requests = await q(`select operation, performed_by_user_id from calendar.event_requests where event_id = $1`, [ev.id]);
  assert.deepEqual(requests, [{ operation: "create", performed_by_user_id: c.clubAdmin.id }]);
  const changes = await q(`select kind, basis, revision, details from calendar.event_changes where event_id = $1`, [ev.id]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "create");
  assert.equal(changes[0].basis, "club_admin");
  assert.equal(changes[0].revision, 1);
  assert.deepEqual(changes[0].details.targetKinds, ["club"]);
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const hash = "b".repeat(64);
    await client.query("begin");
    await client.query(`insert into calendar.event_requests (request_key, request_hash, operation, performed_by_user_id, event_id, result) values ($1, $2, 'update', $3, $4, '{}')`, [crypto.randomUUID(), hash, c.clubAdmin.id, ev.id]);
    await assert.rejects(client.query("commit"), (e) => e.code === "23514" && /must have its change row/.test(e.message));
    await assert.rejects(client.query(`insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, request_id, revision) values ($1, 'update', 'club_admin', $2, $3, 1)`, [ev.id, c.clubAdmin.id, crypto.randomUUID()]), (e) => e.code === "23503" || e.code === "23514");
    await client.query("rollback").catch(() => {});
    await assert.rejects(client.query(`update calendar.event_requests set result = '{"x":1}' where event_id = $1`, [ev.id]), (e) => e.code === "23514");
    await assert.rejects(client.query(`delete from calendar.event_changes where event_id = $1`, [ev.id]), (e) => e.code === "23514");
    await assert.rejects(client.query(`delete from calendar.events where id = $1`, [ev.id]), (e) => e.code === "23514");
  } finally {
    await client.end();
  }
});

test("13. the bounded COMMIT: a lost answer after a real COMMIT is verified from the request row; a lost answer after a rollback is outcome_unknown and the key stays free", async () => {
  const c = await clubFixture("commit");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const hooks = eventService.testHooks;
  const body = { requestKey: newKey(), timezone: TZ, eventTypeId: meeting.id, title: "Lost answer", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] };
  try {
    hooks.commit = async (client) => {
      await client.query("commit");
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    };
    const verified = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body });
    assert.equal(verified.status, 201, verified.text);
    assert.equal(verified.body.verifiedAfterCommitError, true);
    assert.equal(verified.body.event.title, "Lost answer");
    assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Lost answer'`))[0].n, 1);

    hooks.commit = async (client) => {
      await client.query("rollback");
      const error = new Error("connection terminated");
      error.code = "ECONNRESET";
      throw error;
    };
    const lost = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, requestKey: newKey(), title: "Never saved" } });
    assert.equal(lost.status, 503, lost.text);
    assert.equal(lost.body.error, "outcome_unknown");
    assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Never saved'`))[0].n, 0);

    // A COMMIT that never answers: the bound expires, the connection is
    // destroyed (the open transaction rolls back), the check finds nothing.
    hooks.commit = () => new Promise(() => {});
    hooks.commitTimeoutMs = 50;
    hooks.checkTimeoutMs = 2000;
    const started = Date.now();
    const silent = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, requestKey: newKey(), title: "Silent commit" } });
    assert.equal(silent.status, 503, silent.text);
    assert.equal(silent.body.error, "outcome_unknown");
    assert.ok(Date.now() - started < 5000, "answered within the bounds");
    assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Silent commit'`))[0].n, 0);
  } finally {
    delete hooks.commit;
    delete hooks.commitTimeoutMs;
    delete hooks.checkTimeoutMs;
  }
  // The second key is free: the same request now succeeds.
  const retry = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...body, requestKey: newKey(), title: "Never saved" } });
  assert.equal(retry.status, 201, retry.text);
  // The pool is whole: a plain read works.
  assert.equal((await calendar(c.clubAdmin.cookie)).status, 200);
});

test("14. POST /api/organization/clubs seeds the club's copy of the event types in the same transaction", async () => {
  const platform = await platformAdmin();
  const res = await api("/api/organization/clubs", { method: "POST", cookie: platform.cookie, body: { name: `Seeded ${uid()}` } });
  assert.equal(res.status, 201, res.text);
  const copies = await q(`select kind, seed_key from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 order by sort_order`, [res.body.club.id]);
  assert.equal(copies.length, 7);
  assert.deepEqual(copies.map((t) => t.kind), ["training", "match", "travel", "meeting", "day_off", "camp", "test"]);
  assert.ok(copies.every((t) => t.seed_key === t.kind));
});

// ---------------------------------------------------------------------------
// 15. No write on read; bounded statements
// ---------------------------------------------------------------------------
test("15. the read writes nothing (the calendar tables included) and its statement count does not depend on the number of events", async () => {
  const c = await clubFixture("nw");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const camp = await typeOf(c.clubAdmin.cookie, "camp");
  const match = await typeOf(c.clubAdmin.cookie, "match");
  const schedule = await makeExternalSchedule({ owner: { scope: "club", clubId: c.clubId }, createdBy: c.clubAdmin.id, startDate: PAST, targets: [{ kind: "club", id: c.clubId }] });
  const occ = await makeExternalOccurrence(schedule, PAST);
  await makeExternalAssignment(occ, c.a1.athleteId, PAST);
  assert.equal((await createEvent(c.clubAdmin.cookie, { eventTypeId: match.id, title: "Match", day: PAST, externalScheduleId: schedule, targets: [{ kind: "club", id: c.clubId }] })).status, 201);
  const tables = [
    "calendar.events", "calendar.event_targets", "calendar.event_requests", "calendar.event_changes", "calendar.event_types",
    "calendar.event_session_links", "calendar.event_activity_links",
    "training_load.external_schedules", "training_load.external_schedule_occurrences", "training_load.external_assignments",
    "tests.test_schedules", "training.activities", "training_load.session_feedback", "plans.plans", "public.athlete_memberships",
  ];
  const before = await rowDigests(tables);
  const small = await calendar(c.clubAdmin.cookie, { extra: "&include=athletes" });
  assert.equal(small.status, 200, small.text);
  assert.deepEqual(await rowDigests(tables), before, "no row of any table changed");

  const original = appPool.query;
  let count = 0;
  appPool.query = function counted(...args) {
    count += 1;
    return original.apply(this, args);
  };
  try {
    count = 0;
    assert.equal((await calendar(c.clubAdmin.cookie)).status, 200);
    const smallCount = count;
    assert.ok(smallCount > 0);
    for (let i = 0; i < 6; i += 1) {
      assert.equal((await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: `Training ${i}`, day: addDays(PAST, i), startTime: "18:00", targets: [{ kind: "team", id: i % 2 ? c.team1 : c.team2 }] })).status, 201);
    }
    assert.equal((await createEvent(c.clubAdmin.cookie, { eventTypeId: camp.id, title: "Camp", day: TODAY, endDay: addDays(TODAY, 5), targets: [{ kind: "club", id: c.clubId }] })).status, 201);
    count = 0;
    const large = await calendar(c.clubAdmin.cookie);
    assert.equal(large.status, 200);
    assert.equal(ofKind(allItems(large), "event").length, 1 + 6 + 6, "the match, six trainings, six camp days");
    assert.equal(count, smallCount, `the same number of statements for 1 event and for 13 event cards (${smallCount})`);
  } finally {
    appPool.query = original;
  }
  // Statically: the calendar read still imports no generator and holds no write.
  for (const file of ["calendarQuery.js", "calendarAccess.js", "routes/calendar.js"]) {
    const source = (await fsp.readFile(path.resolve(__dirname, "../src", file), "utf8")).replace(/\/\/.*$/gm, "");
    assert.equal(/^import\b[^\n]*OccurrenceService/m.test(source), false, `${file} must not import an occurrence service`);
    assert.equal(/\b(insert|update|delete)\s+(into\s+)?[a-z_]+\./i.test(source), false, `${file} holds no write statement`);
  }
});

// ---------------------------------------------------------------------------
// 16-26. After the internal reviews (2026-10-30)
// ---------------------------------------------------------------------------
test("16. GET /:id for a reader who may not manage the event carries only the targets inside the reader's scope — never a foreign athlete's name, the owner's ids, the schedules, the links or the notes", async () => {
  const c = await clubFixture("rv");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  // A private coach P with athlete X, who is also a member of the club's team 1.
  const p = await privateCoach("rv private");
  await q(`insert into public.user_athletes (user_id, athlete_id) values ($1, $2)`, [p.id, c.a1.athleteId]);
  const schedule = await makeExternalSchedule({ owner: { scope: "club", clubId: c.clubId }, createdBy: c.clubAdmin.id, startDate: FUTURE, targets: [{ kind: "club", id: c.clubId }] });
  const ev = (await createEvent(c.clubAdmin.cookie, {
    eventTypeId: training.id, title: "Club session", day: FUTURE, startTime: "18:00", notes: "Coach notes", externalScheduleId: schedule,
    targets: [{ kind: "athlete", id: c.a1.athleteId }, { kind: "athlete", id: c.a2.athleteId }, { kind: "team", id: c.team2 }, { kind: "club", id: c.clubId }],
  })).body.event;
  // P reads it through X: X only.
  const byP = await getEvent(p.cookie, ev.id);
  assert.equal(byP.status, 200, byP.text);
  assert.equal(byP.body.event.canManage, false);
  assert.deepEqual(byP.body.event.targets.map((t) => [t.kind, t.id]), [["athlete", c.a1.athleteId]]);
  const textP = byP.text;
  for (const forbidden of [c.a2.athleteId, c.a2.name, c.team2, c.clubAdmin.id, schedule, "Coach notes", "ownerClubId", "ownerUserId", "links", "externalScheduleId", "createdAt"]) {
    assert.equal(textP.includes(forbidden), false, `the reader's body must not carry ${forbidden}`);
  }
  // Team 1's coach reads the club's event: team 1's athletes and the club target (their structural scope); never team 2 or a2's absence hides anything.
  const byCoach1 = await getEvent(c.coach1.cookie, ev.id);
  assert.equal(byCoach1.status, 200, byCoach1.text);
  assert.deepEqual(byCoach1.body.event.targets.map((t) => [t.kind, t.id]).sort(), [["athlete", c.a1.athleteId], ["athlete", c.a2.athleteId], ["club", c.clubId]].sort());
  assert.equal(byCoach1.text.includes(c.team2), false, "team 2 is outside team 1's scope");
  assert.equal(byCoach1.text.includes("Coach notes"), false);
  assert.equal("eventTypeId" in byCoach1.body.event, false, "the reduced view carries no type id (the card's contract)");
  // Team 2's coach: the club target and the team-2 target, no team-1 athlete.
  const byCoach2 = await getEvent(c.coach2.cookie, ev.id);
  assert.equal(byCoach2.status, 200, byCoach2.text);
  assert.deepEqual(byCoach2.body.event.targets.map((t) => [t.kind, t.id]).sort(), [["club", c.clubId], ["team", c.team2]].sort());
  assert.equal(byCoach2.text.includes(c.a1.athleteId), false);
  assert.equal(byCoach2.text.includes(c.a2.name), false);
  // The manager still sees everything.
  const byAdmin = await getEvent(c.clubAdmin.cookie, ev.id);
  assert.equal(byAdmin.body.event.targets.length, 4);
  assert.equal(byAdmin.body.event.notes, "Coach notes");
  // A stranger: 404.
  assert.equal((await getEvent((await privateCoach("rv stranger")).cookie, ev.id)).status, 404);
});

test("17. a requestKey is bound to its event and its owner: the same key and body on another event, or in another workspace, is refused and changes nothing", async () => {
  const c = await clubFixture("rk");
  const other = await clubFixture("rk-other");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const e1 = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "One", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const e2 = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "Two", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const key = newKey();
  const cancelled = await api(`/api/calendar/events/${e1.id}/cancel`, { method: "POST", cookie: c.clubAdmin.cookie, body: { requestKey: key, expectedRevision: 1, reason: "Rain" } });
  assert.equal(cancelled.status, 200, cancelled.text);
  const onE2 = await api(`/api/calendar/events/${e2.id}/cancel`, { method: "POST", cookie: c.clubAdmin.cookie, body: { requestKey: key, expectedRevision: 1, reason: "Rain" } });
  assert.equal(onE2.status, 409, onE2.text);
  assert.equal(onE2.body.error, "request_key_reused");
  assert.equal((await q(`select status from calendar.events where id = $1`, [e2.id]))[0].status, "planned", "E2 is untouched");
  const replayE1 = await api(`/api/calendar/events/${e1.id}/cancel`, { method: "POST", cookie: c.clubAdmin.cookie, body: { requestKey: key, expectedRevision: 1, reason: "Rain" } });
  assert.equal(replayE1.status, 200, replayE1.text);
  assert.equal(replayE1.body.replayed, true);
  assert.equal(replayE1.body.event.status, "cancelled");
  // One account, admin of two clubs: the same create key and body in the other club's workspace is a different request.
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [c.clubAdmin.id, other.clubId]);
  const createKey = newKey();
  const bodyA = { requestKey: createKey, timezone: TZ, eventTypeId: meeting.id, title: "Board", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] };
  const inA = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: bodyA });
  assert.equal(inA.status, 201, inA.text);
  await setWorkspace(c.clubAdmin.id, "club", other.clubId);
  const otherMeeting = (await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = 'meeting'`, [other.clubId]))[0].id;
  const inB = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { ...bodyA, eventTypeId: otherMeeting, targets: [{ kind: "club", id: other.clubId }] } });
  assert.equal(inB.status, 409, inB.text);
  assert.equal(inB.body.error, "request_key_reused");
  assert.equal((await q(`select count(*)::int as n from calendar.events where owner_club_id = $1`, [other.clubId]))[0].n, 0, "nothing created in B");
  await setWorkspace(c.clubAdmin.id, "club", c.clubId);
  // One account that is both the club's admin and team 1's coach: the same
  // create body and key in the club workspace, then in the team workspace,
  // is another owner — refused, nothing created.
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)`, [c.clubAdmin.id, c.team1]);
  const dualKey = newKey();
  const dualBody = { requestKey: dualKey, timezone: TZ, eventTypeId: meeting.id, title: "Dual", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] };
  const asClub = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: dualBody });
  assert.equal(asClub.status, 201, asClub.text);
  assert.equal(asClub.body.event.ownerScope, "club");
  await setWorkspace(c.clubAdmin.id, "team", c.team1);
  const asTeam = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: dualBody });
  assert.equal(asTeam.status, 409, asTeam.text);
  assert.equal(asTeam.body.error, "request_key_reused");
  assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Dual'`))[0].n, 1, "no second event");
  await setWorkspace(c.clubAdmin.id, "club", c.clubId);
});

test("18. a referenced test schedule is authorized by the active workspace, not account-wide: an admin of two clubs cannot bind club A's event to club B's test schedule", async () => {
  const c = await clubFixture("ts");
  const other = await clubFixture("ts-other");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [c.clubAdmin.id, other.clubId]);
  const testType = await typeOf(c.clubAdmin.cookie, "test");
  const scheduleB = await makeTestSchedule({ owner: { scope: "club", clubId: other.clubId }, createdBy: other.clubAdmin.id, startDate: FUTURE, targets: [{ kind: "club", id: other.clubId }] });
  const foreign = await createEvent(c.clubAdmin.cookie, { eventTypeId: testType.id, title: "Wellness", day: FUTURE, testScheduleId: scheduleB, targets: [{ kind: "club", id: c.clubId }] });
  const random = await createEvent(c.clubAdmin.cookie, { eventTypeId: testType.id, title: "Wellness", day: FUTURE, testScheduleId: crypto.randomUUID(), targets: [{ kind: "club", id: c.clubId }] });
  assert.equal(foreign.status, 400, foreign.text);
  assert.equal(foreign.body.error, "schedule_not_available");
  assert.equal(foreign.text, random.text);
  // The same admin in club B's workspace may reference it.
  await setWorkspace(c.clubAdmin.id, "club", other.clubId);
  const testTypeB = (await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = 'test'`, [other.clubId]))[0].id;
  const ok = await createEvent(c.clubAdmin.cookie, { eventTypeId: testTypeB, title: "Wellness", day: FUTURE, testScheduleId: scheduleB, targets: [{ kind: "club", id: other.clubId }] });
  assert.equal(ok.status, 201, ok.text);
  await setWorkspace(c.clubAdmin.id, "club", c.clubId);
});

test("19. two creates with the same key at the same time: the second meets the unique request key and answers the saved event, never a 500; the stored result holds ids only", async () => {
  const c = await clubFixture("race");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const e0 = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "First", day: FUTURE, notes: "secret", targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const stored = (await q(`select result from calendar.event_requests where event_id = $1`, [e0.id]))[0].result;
  assert.deepEqual(Object.keys(stored).sort(), ["eventId", "httpStatus"], "the request record holds ids only");
  assert.equal(JSON.stringify(stored).includes("secret"), false);
  const hooks = eventService.testHooks;
  const key = newKey();
  try {
    // The "other request" lands its row for the same key while this one is between its replay check and its request row.
    hooks.beforeRequestRow = async ({ requestKey, hash, userId }) => {
      const other = new pg.Client({ connectionString: db.url });
      await other.connect();
      try {
        await other.query("begin");
        const requestId = crypto.randomUUID();
        await other.query(
          `insert into calendar.event_requests (id, request_key, request_hash, operation, performed_by_user_id, event_id, result) values ($1, $2, $3, 'create', $4, $5, $6)`,
          [requestId, requestKey, hash, userId, e0.id, JSON.stringify({ httpStatus: 201, eventId: e0.id })],
        );
        await other.query(
          `insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, details, request_id, revision) values ($1, 'create', 'club_admin', $2, '{}', $3, $4)`,
          [e0.id, userId, requestId, e0.revision],
        );
        await other.query("commit");
      } finally {
        await other.end();
      }
    };
    const before = (await q(`select count(*)::int as n from calendar.events where owner_club_id = $1`, [c.clubId]))[0].n;
    const raced = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { requestKey: key, timezone: TZ, eventTypeId: meeting.id, title: "Second", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] } });
    assert.equal(raced.status, 201, raced.text);
    assert.equal(raced.body.replayed, true);
    assert.equal(raced.body.event.id, e0.id, "the saved request's event, not a second one");
    assert.equal((await q(`select count(*)::int as n from calendar.events where owner_club_id = $1`, [c.clubId]))[0].n, before, "the racing event was rolled back");
  } finally {
    delete hooks.beforeRequestRow;
  }
});

test("20. the platform admin manages a private coach's event from the platform workspace; an archived owner's events pass to the next level up — the platform admin for an archived club, the club admin for an archived team — and everyone else gets the 404", async () => {
  const p = await privateCoach("pa coach");
  const own = await makeAthlete("pa athlete");
  await q(`insert into public.user_athletes (user_id, athlete_id) values ($1, $2)`, [p.id, own.athleteId]);
  const meetingSys = await typeOf(p.cookie, "meeting");
  const ev = (await createEvent(p.cookie, { eventTypeId: meetingSys.id, title: "Talk", day: FUTURE, targets: [{ kind: "athlete", id: own.athleteId }] })).body.event;
  const platform = await platformAdmin();
  const read = await calendar(platform.cookie);
  assert.equal(eventCards(read, ev.id)[0].canManage, true);
  const edited = await patchEvent(platform.cookie, ev.id, { expectedRevision: 1, title: "Talk (support)" });
  assert.equal(edited.status, 200, edited.text);
  assert.equal((await q(`select basis from calendar.event_changes where event_id = $1 and kind = 'update'`, [ev.id]))[0].basis, "platform_admin");
  // An archived club: canManage false and the write 404, in the same words the lock speaks.
  const c = await clubFixture("pa club");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const clubEvent = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Before archive", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const teamEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Team before archive", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  await q(`update public.clubs set is_active = false where id = $1`, [c.clubId]);
  try {
    // An archived club: the platform admin alone manages its events and its
    // teams' events; the club admin and the team coach get the one 404 (the
    // same answer the lock speaks), and canManage says so.
    const afterArchive = await calendar(platform.cookie);
    assert.equal(eventCards(afterArchive, clubEvent.id)[0].canManage, true, "the platform admin may still cancel an archived club's event");
    const support = await cancelEvent(platform.cookie, clubEvent.id, { expectedRevision: 1, reason: "Club archived" });
    assert.equal(support.status, 200, support.text);
    assert.equal((await q(`select basis from calendar.event_changes where event_id = $1 and kind = 'cancel'`, [clubEvent.id]))[0].basis, "platform_admin");
    const adminWrite = await patchEvent(c.clubAdmin.cookie, teamEvent.id, { expectedRevision: 1, title: "X" });
    assert.equal(adminWrite.status, 404, adminWrite.text);
    const coachRead = await calendar(c.coach1.cookie);
    assert.equal(eventCards(coachRead, teamEvent.id)[0].canManage, false, "the team's club is archived");
    const coachWrite = await patchEvent(c.coach1.cookie, teamEvent.id, { expectedRevision: 1, title: "X" });
    assert.equal(coachWrite.status, 404, coachWrite.text);
    assert.equal(coachWrite.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    const supportTeam = await patchEvent(platform.cookie, teamEvent.id, { expectedRevision: 1, title: "Team (support)" });
    assert.equal(supportTeam.status, 200, supportTeam.text);
    assert.equal((await q(`select title from calendar.events where id = $1`, [teamEvent.id]))[0].title, "Team (support)");
  } finally {
    await q(`update public.clubs set is_active = true where id = $1`, [c.clubId]);
  }
  // An archived team of an active club: its club's admin (D18, the next level
  // up) and the platform admin manage its events, audited on their basis; its
  // own coach gets the 404 (the workspace of an archived team is not offered
  // at all, and the lock refuses team_coach either way).
  const t3 = await makeTeam(c.clubId, "pa T3");
  const coach3 = await coachOf(t3, "pa coach 3");
  const t3Event = (await createEvent(coach3.cookie, { eventTypeId: training.id, title: "T3 before archive", day: FUTURE, targets: [{ kind: "team", id: t3 }] })).body.event;
  await q(`update public.teams set is_active = false where id = $1`, [t3]);
  try {
    const coachWrite = await cancelEvent(coach3.cookie, t3Event.id, { expectedRevision: 1 });
    assert.equal(coachWrite.status, 404, coachWrite.text);
    assert.equal(coachWrite.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    const byAdmin = await getEvent(c.clubAdmin.cookie, t3Event.id);
    assert.equal(byAdmin.status, 200, byAdmin.text);
    assert.equal(byAdmin.body.event.canManage, true, "the club admin manages the archived team's event");
    const renamed = await patchEvent(c.clubAdmin.cookie, t3Event.id, { expectedRevision: 1, title: "T3 (archived team)" });
    assert.equal(renamed.status, 200, renamed.text);
    const bySupport = await patchEvent(platform.cookie, t3Event.id, { expectedRevision: 2, title: "T3 (support)" });
    assert.equal(bySupport.status, 200, bySupport.text);
    const cancelled = await cancelEvent(c.clubAdmin.cookie, t3Event.id, { expectedRevision: 3, reason: "Team archived" });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.deepEqual((await q(`select basis from calendar.event_changes where event_id = $1 and kind <> 'create' order by revision`, [t3Event.id])).map((r) => r.basis), ["club_admin", "platform_admin", "club_admin"]);
    assert.equal((await q(`select status from calendar.events where id = $1`, [t3Event.id]))[0].status, "cancelled");
  } finally {
    await q(`update public.teams set is_active = true where id = $1`, [t3]);
  }
});

test("21. a cancelled event folds nothing: its referenced schedule's card comes back (the schedule keeps collecting), and a later planned event on the same schedule folds it whatever the ids' order", async () => {
  const c = await clubFixture("cf");
  const match = await typeOf(c.coach1.cookie, "match");
  const schedule = await makeExternalSchedule({ owner: { scope: "team", teamId: c.team1 }, createdBy: c.coach1.id, startDate: PAST, targets: [{ kind: "team", id: c.team1 }] });
  const occ = await makeExternalOccurrence(schedule, PAST);
  await makeExternalAssignment(occ, c.a1.athleteId, PAST);
  const first = (await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "First match", day: PAST, externalScheduleId: schedule, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  assert.equal((await cancelEvent(c.coach1.cookie, first.id, { expectedRevision: 1, reason: "Postponed" })).status, 200);
  assert.equal((await q(`select status from training_load.external_schedules where id = $1`, [schedule]))[0].status, "active", "the schedule is never cancelled by the event");
  const afterCancel = await calendar(c.coach1.cookie);
  assert.ok(allItems(afterCancel).some((i) => i.key === `external:${schedule}:${PAST}`), "the schedule's card is back");
  const cancelledCard = eventCards(afterCancel, first.id)[0];
  assert.equal(cancelledCard.status, "cancelled");
  assert.equal(cancelledCard.rpe, null);
  const second = (await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Replay", day: PAST, externalScheduleId: schedule, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  const withSecond = await calendar(c.coach1.cookie);
  assert.equal(allItems(withSecond).some((i) => i.key === `external:${schedule}:${PAST}`), false, "folded under the planned event");
  assert.deepEqual(eventCards(withSecond, second.id)[0].rpe, { asked: 1, submitted: 0, missed: 0 });
  assert.equal(eventCards(withSecond, first.id)[0].rpe, null, "the cancelled one still holds nothing");
  // The athlete workspace folds nothing: the athlete's own RPE request stays visible beside the reduced event card.
  const athleteRes = await calendar(c.a1.cookie);
  assert.ok(allItems(athleteRes).some((i) => i.key === `external:${schedule}:${PAST}`), "the athlete still sees their RPE request");
  assert.equal(eventCards(athleteRes, second.id).length, 1);
});

test("22. the database rules hold against a raw write: every target rule, the type owner, the test-schedule reference, write-once owner, revision +1, cancelled final (targets too), the audit pair from the event's side, the need for a target, the link triggers, TRUNCATE", async () => {
  const c = await clubFixture("raw");
  const other = await clubFixture("raw-other");
  const training = await typeOf(c.clubAdmin.cookie, "training");
  const testType = await typeOf(c.clubAdmin.cookie, "test");
  const otherTraining = await typeOf(other.clubAdmin.cookie, "training");
  const clubEvent = (await createEvent(c.clubAdmin.cookie, { eventTypeId: training.id, title: "Raw club", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const teamEvent = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Raw team", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  const p = await privateCoach("raw private");
  const own = await makeAthlete("raw own");
  await q(`insert into public.user_athletes (user_id, athlete_id) values ($1, $2)`, [p.id, own.athleteId]);
  const guarded = await makeAthlete("raw guarded");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type) values ($1, $2, 'parent')`, [p.id, guarded.athleteId]);
  const meetingSys = (await q(`select id from calendar.event_types where owner_scope = 'system' and kind = 'meeting'`))[0].id;
  const userEvent = (await createEvent(p.cookie, { eventTypeId: meetingSys, title: "Raw user", day: FUTURE, targets: [{ kind: "athlete", id: own.athleteId }] })).body.event;
  const archivedTeam = await makeTeam(c.clubId, "raw archived");
  await q(`update public.teams set is_active = false where id = $1`, [archivedTeam]);
  const refused = (label, sql, params, code = "23514") => assert.rejects(q(sql, params), (e) => e.code === code, `${label} → ${code}`);
  const target = (eventId, kind, id) => q(`insert into calendar.event_targets (event_id, target_kind, target_athlete_id, target_team_id, target_club_id) values ($1, $2, $3, $4, $5)`,
    [eventId, kind, kind === "athlete" ? id : null, kind === "team" ? id : null, kind === "club" ? id : null]);
  const refusedTarget = (label, eventId, kind, id) => assert.rejects(target(eventId, kind, id), (e) => e.code === "23514", label);
  // Targets of a club-owned event.
  await refusedTarget("club event: another club's team", clubEvent.id, "team", other.team1);
  await refusedTarget("club event: another club", clubEvent.id, "club", other.clubId);
  await refusedTarget("club event: a non-member", clubEvent.id, "athlete", other.a1.athleteId);
  await refusedTarget("club event: an archived team", clubEvent.id, "team", archivedTeam);
  await target(clubEvent.id, "athlete", c.a3.athleteId);
  // Targets of a team-owned event.
  await refusedTarget("team event: a club", teamEvent.id, "club", c.clubId);
  await refusedTarget("team event: another team", teamEvent.id, "team", c.team2);
  await refusedTarget("team event: a non-member", teamEvent.id, "athlete", c.a3.athleteId);
  await target(teamEvent.id, "athlete", c.a1.athleteId);
  // Targets of a private coach's event.
  await refusedTarget("user event: a team", userEvent.id, "team", c.team1);
  await refusedTarget("user event: someone else's athlete", userEvent.id, "athlete", c.a1.athleteId);
  await refusedTarget("user event: a non-coach relationship", userEvent.id, "athlete", guarded.athleteId);
  // Events: the type's owner, the test-schedule reference.
  const rawEvent = (over = {}) => q(
    `insert into calendar.events (owner_scope, owner_club_id, event_type_id, title, day, timezone, created_by_user_id, test_schedule_id)
     values ('club', $1, $2, 'Raw', $3, 'UTC', $4, $5)`,
    [c.clubId, over.type ?? training.id, FUTURE, c.clubAdmin.id, over.testScheduleId ?? null],
  );
  await assert.rejects(rawEvent({ type: otherTraining.id }), (e) => e.code === "23514", "another club's type");
  await assert.rejects(rawEvent({ type: training.id, testScheduleId: crypto.randomUUID() }), (e) => e.code === "23514", "a test schedule on a training");
  await assert.rejects(rawEvent({ type: testType.id, testScheduleId: crypto.randomUUID() }), (e) => e.code === "23514", "a test schedule that does not exist");
  // Owner write-once; revision +1; cancelled final.
  await refused("the owner", `update calendar.events set owner_club_id = $2, revision = revision + 1 where id = $1`, [clubEvent.id, other.clubId]);
  await refused("a write without revision + 1", `update calendar.events set title = 'X' where id = $1`, [clubEvent.id]);
  // A raw write with revision + 1 and no audit cannot be committed.
  const raw = new pg.Client({ connectionString: db.url });
  await raw.connect();
  try {
    await raw.query("begin");
    await raw.query(`update calendar.events set title = 'Unaudited', revision = revision + 1 where id = $1`, [clubEvent.id]);
    await assert.rejects(raw.query("commit"), (e) => e.code === "23514" && /change row/.test(e.message), "an unaudited write");
    assert.equal((await q(`select title from calendar.events where id = $1`, [clubEvent.id]))[0].title, "Raw club");
    // A new event without a target cannot be committed either.
    await raw.query("begin");
    await raw.query(`insert into calendar.events (owner_scope, owner_club_id, event_type_id, title, day, timezone, created_by_user_id) values ('club', $1, $2, 'Lonely', $3, 'UTC', $4)`, [c.clubId, training.id, FUTURE, c.clubAdmin.id]);
    await assert.rejects(raw.query("commit"), (e) => e.code === "23514", "no target");
    // Deleting the only target cannot be committed.
    await raw.query("begin");
    await raw.query(`delete from calendar.event_targets where event_id = $1`, [teamEvent.id]);
    await assert.rejects(raw.query("commit"), (e) => e.code === "23514", "the last target removed");
  } finally {
    await raw.end();
  }
  assert.equal((await cancelEvent(c.clubAdmin.cookie, teamEvent.id, { expectedRevision: 1 })).status, 200);
  await refused("a cancelled event", `update calendar.events set title = 'X', revision = revision + 1 where id = $1`, [teamEvent.id]);
  await refusedTarget("a cancelled event's new target", teamEvent.id, "athlete", c.a2.athleteId);
  await refused("a cancelled event's target removed", `delete from calendar.event_targets where event_id = $1 and target_kind = 'athlete'`, [teamEvent.id]);
  await refused("DELETE of an event", `delete from calendar.events where id = $1`, [userEvent.id]);
  await refused("a target UPDATE", `update calendar.event_targets set target_kind = 'club' where event_id = $1`, [userEvent.id]);
  // Links (tables only in K2a-1a): their triggers.
  await refused("a session link on a cancelled event", `insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, linked_by_user_id) values ($1, gen_random_uuid(), $2, 'PM', 'T', 0, $3)`, [teamEvent.id, FUTURE, c.coach1.id]);
  await refused("a session link on a day outside the event", `insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, linked_by_user_id) values ($1, gen_random_uuid(), '2000-01-01', 'PM', 'T', 0, $2)`, [clubEvent.id, c.clubAdmin.id]);
  await refused("a session link to a slot without a session", `insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, linked_by_user_id) values ($1, gen_random_uuid(), $2, 'PM', 'T', 0, $3)`, [clubEvent.id, FUTURE, c.clubAdmin.id]);
  const superseded = (await q(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
     values ('training_session', 'Old', $1, 'UTC', 'team', $2, 'manual', 'confirmed') returning id`, [FUTURE, c.team1],
  ))[0].id;
  const survivor = (await q(
    `insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
     values ('training_session', 'New', $1, 'UTC', 'team', $2, 'manual', 'confirmed') returning id`, [FUTURE, c.team1],
  ))[0].id;
  // The supersede flag the sanctioned merge functions set (v1 core,
  // protect_activity_identity_fields): the test plays the merge's own part.
  await q(`select set_config('training.allow_supersede_write', 'on', false)`);
  try {
    await q(`update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = $2 where id = $1`, [superseded, survivor]);
  } finally {
    await q(`select set_config('training.allow_supersede_write', 'off', false)`);
  }
  await refused("an activity link to a superseded activity", `insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [clubEvent.id, superseded, c.clubAdmin.id]);
  await q(`insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [clubEvent.id, survivor, c.clubAdmin.id]);
  await refused("a second live link of the same activity", `insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1, $2, $3)`, [userEvent.id, survivor, p.id], "23505");
  await refused("DELETE of an activity link", `delete from calendar.event_activity_links where activity_id = $1`, [survivor]);
  // A system type is never deleted, even unused.
  await refused("DELETE of an unused system type", `delete from calendar.event_types where owner_scope = 'system' and kind = 'travel'`, []);
  // TRUNCATE.
  // CASCADE, so the refusal is the before-truncate trigger's (PostgreSQL
  // refuses a plain TRUNCATE of a referenced table on the foreign key first).
  for (const table of ["calendar.event_changes", "calendar.event_requests", "calendar.event_activity_links", "calendar.event_session_links", "calendar.event_targets", "calendar.events", "calendar.event_types"]) {
    await refused(`TRUNCATE ${table}`, `truncate ${table} cascade`, []);
  }
});

test("23. the club route: the role gate, the body, the seed, and a failure that leaves no club row", async () => {
  const platform = await platformAdmin();
  const c = await clubFixture("clubroute");
  assert.equal((await api("/api/organization/clubs", { method: "POST", cookie: c.clubAdmin.cookie, body: { name: "By a club admin" } })).status, 403);
  assert.equal((await api("/api/organization/clubs", { method: "POST", cookie: platform.cookie, body: { name: "" } })).status, 400);
  const before = (await q(`select count(*)::int as n from public.clubs`))[0].n;
  await q(`alter function calendar.seed_club_event_types(uuid) rename to seed_club_event_types_off`);
  try {
    const failed = await api("/api/organization/clubs", { method: "POST", cookie: platform.cookie, body: { name: `Unseeded ${uid()}` } });
    assert.equal(failed.status, 500, failed.text);
    assert.equal((await q(`select count(*)::int as n from public.clubs`))[0].n, before, "the club insert rolled back with the failed seed");
  } finally {
    await q(`alter function calendar.seed_club_event_types_off(uuid) rename to seed_club_event_types`);
  }
  const ok = await api("/api/organization/clubs", { method: "POST", cookie: platform.cookie, body: { name: `Seeded ${uid()}` } });
  assert.equal(ok.status, 201, ok.text);
  assert.equal((await q(`select count(*)::int as n from calendar.event_types where owner_club_id = $1`, [ok.body.club.id]))[0].n, 7);
  // A club's hard delete (the shared suites' cleanup) cascades its unused copies; a club with an event is kept.
  await q(`delete from public.clubs where id = $1`, [ok.body.club.id]);
  assert.equal((await q(`select count(*)::int as n from calendar.event_types where owner_club_id = $1`, [ok.body.club.id]))[0].n, 0);
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  assert.equal((await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "Keeps the club", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).status, 201);
  await assert.rejects(q(`delete from public.clubs where id = $1`, [c.clubId]), (e) => e.code === "23503");
});

test("24. lock_event_writer: every basis and owner combination, including the platform admin over a private coach and the archived club of a team", async () => {
  const c = await clubFixture("lock");
  const other = await clubFixture("lock-other");
  const p = await privateCoach("lock private");
  const platform = await platformAdmin();
  const nobody = await makeUser("lock nobody");
  const lock = async (user, scope, owner, basis) => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query("begin");
      const r = await client.query(`select calendar.lock_event_writer($1, $2, $3, $4) as basis`, [user, scope, owner, basis]);
      await client.query("rollback");
      return r.rows[0].basis;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
  };
  const refused = (label, ...args) => assert.rejects(lock(...args), (e) => e.code === "42501", label);
  assert.equal(await lock(c.clubAdmin.id, "club", c.clubId, "club_admin"), "club_admin");
  assert.equal(await lock(c.clubAdmin.id, "team", c.team1, "club_admin"), "club_admin", "D18");
  await refused("another club", c.clubAdmin.id, "club", other.clubId, "club_admin");
  await refused("another club's team", c.clubAdmin.id, "team", other.team1, "club_admin");
  assert.equal(await lock(c.coach1.id, "team", c.team1, "team_coach"), "team_coach");
  await refused("the coach on the club", c.coach1.id, "club", c.clubId, "team_coach");
  await refused("the coach claiming club_admin", c.coach1.id, "team", c.team1, "club_admin");
  await refused("no role", nobody, "club", c.clubId, "club_admin");
  assert.equal(await lock(platform.id, "team", other.team1, "platform_admin"), "platform_admin");
  assert.equal(await lock(platform.id, "user", p.id, "platform_admin"), "platform_admin", "support over a private coach");
  assert.equal(await lock(p.id, "user", p.id, "private_coach"), "private_coach");
  await refused("another coach's events", p.id, "user", nobody, "private_coach");
  await refused("no independent_coach role", nobody, "user", nobody, "private_coach");
  await assert.rejects(lock(c.clubAdmin.id, "club", c.clubId, "owner"), (e) => e.code === "22023");
  await refused("an unknown team", c.clubAdmin.id, "team", crypto.randomUUID(), "club_admin");
  // An archived owner: the next level up only (plan 4.1).
  await q(`update public.teams set is_active = false where id = $1`, [c.team1]);
  await refused("an archived team, as its coach", c.coach1.id, "team", c.team1, "team_coach");
  assert.equal(await lock(c.clubAdmin.id, "team", c.team1, "club_admin"), "club_admin", "an archived team of an active club: its club's admin");
  assert.equal(await lock(platform.id, "team", c.team1, "platform_admin"), "platform_admin");
  await q(`update public.teams set is_active = true where id = $1`, [c.team1]);
  await q(`update public.clubs set is_active = false where id = $1`, [c.clubId]);
  await refused("a team of an archived club, as its coach", c.coach1.id, "team", c.team1, "team_coach");
  await refused("a team of an archived club, as the club admin", c.clubAdmin.id, "team", c.team1, "club_admin");
  assert.equal(await lock(platform.id, "team", c.team1, "platform_admin"), "platform_admin", "an archived club: the platform admin only");
  await refused("an archived club, as its admin", c.clubAdmin.id, "club", c.clubId, "club_admin");
  assert.equal(await lock(platform.id, "club", c.clubId, "platform_admin"), "platform_admin");
  await q(`update public.clubs set is_active = true where id = $1`, [c.clubId]);
});

test("25. a cancel still works after the referenced test schedule was deleted and after the owner team moved to another club", async () => {
  const c = await clubFixture("later");
  const other = await clubFixture("later-other");
  const testType = await typeOf(c.coach1.cookie, "test");
  const training = await typeOf(c.coach1.cookie, "training");
  const schedule = await makeTestSchedule({ owner: { scope: "team", teamId: c.team1 }, createdBy: c.coach1.id, startDate: FUTURE, targets: [{ kind: "team", id: c.team1 }] });
  const withTest = (await createEvent(c.coach1.cookie, { eventTypeId: testType.id, title: "Wellness", day: FUTURE, testScheduleId: schedule, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  await q(`delete from tests.test_schedule_targets where schedule_id = $1`, [schedule]);
  await q(`delete from tests.test_schedules where id = $1`, [schedule]);
  // Setting the OTHER reference validates only that one: the dangling test
  // schedule reference is left as it is.
  const ext = await makeExternalSchedule({ owner: { scope: "team", teamId: c.team1 }, createdBy: c.coach1.id, startDate: FUTURE, eventName: "Wellness RPE", targets: [{ kind: "team", id: c.team1 }] });
  const refOnly = await patchEvent(c.coach1.cookie, withTest.id, { expectedRevision: 1, externalScheduleId: ext });
  assert.equal(refOnly.status, 200, refOnly.text);
  assert.equal(refOnly.body.event.externalScheduleId, ext);
  assert.equal(refOnly.body.event.testScheduleId, schedule, "the dangling reference stays");
  const renamed = await patchEvent(c.coach1.cookie, withTest.id, { expectedRevision: 2, title: "Wellness (schedule gone)" });
  assert.equal(renamed.status, 200, renamed.text);
  const cancelled = await cancelEvent(c.coach1.cookie, withTest.id, { expectedRevision: 3 });
  assert.equal(cancelled.status, 200, cancelled.text);
  const read = await calendar(c.coach1.cookie);
  assert.equal(eventCards(read, withTest.id)[0].status, "cancelled", "the event stands alone and reads");
  // A team moved to another club keeps its events writable by its coach (a
  // team without memberships: the memberships' composite key pins a member's
  // team to its club).
  const team3 = await makeTeam(c.clubId, "later T3");
  const coach3 = await coachOf(team3, "later coach 3");
  const moved = (await createEvent(coach3.cookie, { eventTypeId: training.id, title: "Before the move", day: FUTURE, targets: [{ kind: "team", id: team3 }] })).body.event;
  await q(`update public.teams set club_id = $2 where id = $1`, [team3, other.clubId]);
  try {
    const afterMove = await cancelEvent(coach3.cookie, moved.id, { expectedRevision: 1, reason: "Moved" });
    assert.equal(afterMove.status, 200, afterMove.text);
  } finally {
    await q(`update public.teams set club_id = $2 where id = $1`, [team3, c.clubId]);
  }
});

test("27. the same-key race with a failing lookup says try again, never that the key is another's", async () => {
  const c = await clubFixture("race-fault");
  const meeting = await typeOf(c.clubAdmin.cookie, "meeting");
  const e0 = (await createEvent(c.clubAdmin.cookie, { eventTypeId: meeting.id, title: "First", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] })).body.event;
  const hooks = eventService.testHooks;
  try {
    hooks.beforeRequestRow = async ({ requestKey, hash, userId }) => {
      const other = new pg.Client({ connectionString: db.url });
      await other.connect();
      try {
        await other.query("begin");
        const requestId = crypto.randomUUID();
        await other.query(
          `insert into calendar.event_requests (id, request_key, request_hash, operation, performed_by_user_id, event_id, result) values ($1, $2, $3, 'create', $4, $5, $6)`,
          [requestId, requestKey, hash, userId, e0.id, JSON.stringify({ httpStatus: 201, eventId: e0.id })],
        );
        await other.query(
          `insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, details, request_id, revision) values ($1, 'create', 'club_admin', $2, '{}', $3, $4)`,
          [e0.id, userId, requestId, e0.revision],
        );
        await other.query("commit");
      } finally {
        await other.end();
      }
    };
    hooks.checkFault = async () => { throw new Error("the lookup connection died"); };
    const raced = await api("/api/calendar/events", { method: "POST", cookie: c.clubAdmin.cookie, body: { requestKey: newKey(), timezone: TZ, eventTypeId: meeting.id, title: "Second", day: FUTURE, targets: [{ kind: "club", id: c.clubId }] } });
    assert.equal(raced.status, 409, raced.text);
    assert.equal(raced.body.error, "try_again");
    assert.equal((await q(`select count(*)::int as n from calendar.events where title = 'Second' and owner_club_id = $1`, [c.clubId]))[0].n, 0);
  } finally {
    delete hooks.beforeRequestRow;
    delete hooks.checkFault;
  }
});

test("26. GET /types and a create in a team workspace of an archived club answer the one 404, never the system set; an archived team's own workspace is not offered at all (403)", async () => {
  const c = await clubFixture("types-archived");
  await q(`update public.teams set is_active = false where id = $1`, [c.team1]);
  try {
    // The workspace of an archived team is never offered (workspace.js), so
    // the coach reaches no coach workspace at all.
    assert.equal((await typesOf(c.coach1.cookie)).status, 403);
  } finally {
    await q(`update public.teams set is_active = true where id = $1`, [c.team1]);
  }
  // A team of an archived club: the team workspace still resolves, but
  // nothing can be created there — no types, and the create is the 404.
  await q(`update public.clubs set is_active = false where id = $1`, [c.clubId]);
  try {
    const types = await typesOf(c.coach2.cookie);
    assert.equal(types.status, 404, types.text);
    assert.equal(types.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    const create = await createEvent(c.coach2.cookie, { eventTypeId: crypto.randomUUID(), title: "X", day: FUTURE, targets: [{ kind: "team", id: c.team2 }] });
    assert.equal(create.status, 404, create.text);
    assert.equal(create.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    assert.equal((await q(`select count(*)::int as n from calendar.events where owner_team_id = $1`, [c.team2]))[0].n, 0);
  } finally {
    await q(`update public.clubs set is_active = true where id = $1`, [c.clubId]);
  }
});

test("28. a right lost between the request's check and the lock (42501 on an existing event) is the one 404 body, never a 500; the 404 is no-store", async () => {
  const c = await clubFixture("lost-right");
  const training = await typeOf(c.coach1.cookie, "training");
  const ev = (await createEvent(c.coach1.cookie, { eventTypeId: training.id, title: "Before", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  const hooks = eventService.testHooks;
  // The coach's role row deactivated after the service's own check, before the lock (the roster suites' pattern).
  hooks.beforeLocks = async () => { await q(`update public.user_team_roles set is_active = false where user_id = $1`, [c.coach1.id]); };
  try {
    const res = await patchEvent(c.coach1.cookie, ev.id, { expectedRevision: 1, title: "After" });
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    assert.equal((await q(`select title from calendar.events where id = $1`, [ev.id]))[0].title, "Before");
    assert.equal((await q(`select count(*)::int as n from calendar.event_requests where performed_by_user_id = $1`, [c.coach1.id]))[0].n, 1, "the create's request row only");
  } finally {
    delete hooks.beforeLocks;
    await q(`update public.user_team_roles set is_active = true where user_id = $1`, [c.coach1.id]);
  }
  // The owner team archived inside the hook: the lock refuses team_coach (plan 4.1).
  hooks.beforeLocks = async () => { await q(`update public.teams set is_active = false where id = $1`, [c.team1]); };
  try {
    const res = await cancelEvent(c.coach1.cookie, ev.id, { expectedRevision: 1 });
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, JSON.stringify({ error: "notFound", message: "Not found." }));
    assert.equal((await q(`select status from calendar.events where id = $1`, [ev.id]))[0].status, "planned");
  } finally {
    delete hooks.beforeLocks;
    await q(`update public.teams set is_active = true where id = $1`, [c.team1]);
  }
  // The router's 404 is never cached.
  const raw = await fetch(`${apiBase}/api/calendar/events/${crypto.randomUUID()}`, { headers: { Cookie: c.coach1.cookie } });
  assert.equal(raw.status, 404);
  assert.equal(raw.headers.get("cache-control"), "no-store");
  assert.equal(await raw.text(), JSON.stringify({ error: "notFound", message: "Not found." }));
});

test("29. a referenced schedule belongs to the event's owner or its club, for every basis: the platform admin cannot bind club A's event to club B's schedule, nor to another team's", async () => {
  const c = await clubFixture("so");
  const other = await clubFixture("so-other");
  const platform = await platformAdmin();
  const match = await typeOf(c.coach1.cookie, "match");
  const ev = (await createEvent(c.coach1.cookie, { eventTypeId: match.id, title: "Derby", day: FUTURE, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  const schedB = await makeExternalSchedule({ owner: { scope: "club", clubId: other.clubId }, createdBy: other.clubAdmin.id, startDate: FUTURE, targets: [{ kind: "club", id: other.clubId }] });
  const schedT2 = await makeExternalSchedule({ owner: { scope: "team", teamId: c.team2 }, createdBy: c.coach2.id, startDate: FUTURE, targets: [{ kind: "team", id: c.team2 }] });
  const schedClub = await makeExternalSchedule({ owner: { scope: "club", clubId: c.clubId }, createdBy: c.clubAdmin.id, startDate: FUTURE, targets: [{ kind: "club", id: c.clubId }] });
  const foreign = await patchEvent(platform.cookie, ev.id, { expectedRevision: 1, externalScheduleId: schedB });
  const random = await patchEvent(platform.cookie, ev.id, { expectedRevision: 1, externalScheduleId: crypto.randomUUID() });
  const sibling = await patchEvent(platform.cookie, ev.id, { expectedRevision: 1, externalScheduleId: schedT2 });
  assert.equal(foreign.status, 400, foreign.text);
  assert.equal(foreign.body.error, "schedule_not_available");
  assert.equal(foreign.text, random.text, "a foreign schedule reads exactly as a random id");
  assert.equal(sibling.text, random.text, "another team's schedule of the same club is not the owner's either");
  assert.equal((await q(`select revision from calendar.events where id = $1`, [ev.id]))[0].revision, 1, "the refusals wrote nothing");
  const own = await patchEvent(platform.cookie, ev.id, { expectedRevision: 1, externalScheduleId: schedClub });
  assert.equal(own.status, 200, own.text, "the owner team's club's schedule is the owner's");
  assert.equal(own.body.event.externalScheduleId, schedClub);
});

test("30. a referenced schedule folds only when the event's targets cover its athletes, per day and per viewer: wider, both cards stay with their own counts and the event says so; covering, it folds; a membership change flips one day only; a wide range is the union of its days", async () => {
  // The owner's external review of PR #298 (P1): the schedule targets team 1
  // (a1, a2, both asked for RPE); the event targets a1 only.
  const c = await clubFixture("cover");
  const match = await typeOf(c.clubAdmin.cookie, "match");
  const wider = await makeExternalSchedule({ owner: { scope: "club", clubId: c.clubId }, createdBy: c.clubAdmin.id, startDate: PAST, eventName: "Away RPE", targets: [{ kind: "team", id: c.team1 }] });
  const occ = await makeExternalOccurrence(wider, PAST);
  const asg1 = await makeExternalAssignment(occ, c.a1.athleteId, PAST, "completed");
  await makeExternalAssignment(occ, c.a2.athleteId, PAST);
  await externalFeedback(c.a1.athleteId, asg1, PAST);
  const narrow = (await createEvent(c.clubAdmin.cookie, { eventTypeId: match.id, title: "Away", day: PAST, externalScheduleId: wider, targets: [{ kind: "athlete", id: c.a1.athleteId }] })).body.event;
  for (const viewer of [c.coach1, c.clubAdmin]) {
    const res = await calendar(viewer.cookie, { from: PAST, to: PAST, extra: "&include=athletes" });
    const ev = eventCards(res, narrow.id)[0];
    const ext = allItems(res).find((i) => i.key === `external:${wider}:${PAST}`);
    assert.ok(ext, "the wider schedule stays its own card");
    assert.deepEqual(ext.rpe, { asked: 2, submitted: 1, missed: 0 }, "with its own counts");
    assert.ok(ext.athleteIds.includes(c.a2.athleteId), "a2's request is not lost");
    assert.deepEqual(ev.scheduleFold, { external: "separate", test: null });
    assert.equal(ev.rpe, null, "no number from an athlete the event card does not list");
    assert.deepEqual(ev.athleteIds, [c.a1.athleteId]);
    assert.deepEqual(ev.gaps, [], "the schedule beside it is the channel, not a gap");
  }
  // Covering: the event targets the whole team — it folds, its counts match its list.
  const covering = await makeExternalSchedule({ owner: { scope: "club", clubId: c.clubId }, createdBy: c.clubAdmin.id, startDate: PAST, eventName: "Home RPE", targets: [{ kind: "team", id: c.team1 }] });
  const occ2 = await makeExternalOccurrence(covering, PAST);
  await makeExternalAssignment(occ2, c.a1.athleteId, PAST);
  await makeExternalAssignment(occ2, c.a2.athleteId, PAST);
  const whole = (await createEvent(c.clubAdmin.cookie, { eventTypeId: match.id, title: "Home", day: PAST, externalScheduleId: covering, targets: [{ kind: "team", id: c.team1 }] })).body.event;
  let res = await calendar(c.coach1.cookie, { from: PAST, to: PAST, extra: "&include=athletes" });
  const folded = eventCards(res, whole.id)[0];
  assert.equal(allItems(res).some((i) => i.key === `external:${covering}:${PAST}`), false, "covered: folded");
  assert.deepEqual(folded.scheduleFold, { external: "folded", test: null });
  assert.deepEqual(folded.rpe, { asked: 2, submitted: 0, missed: 0 });
  assert.deepEqual([...folded.athleteIds].sort(), [c.a1.athleteId, c.a2.athleteId].sort(), "the counts are the listed athletes'");
  // Per day: a schedule over two days of team 1, an event naming a1 and a2;
  // a leaver of team 1 is a member on the first day only (the leaving day
  // counts) — the first day stays separate, the second folds.
  const leaver = await makeAthlete("cover leaver", { clubId: c.clubId, teamId: c.team1 });
  await archiveMembership(await teamMembershipId(leaver.athleteId, c.team1), `${FUTURE}T12:00:00Z`);
  const day2 = addDays(FUTURE, 1);
  const twoDays = (await q(
    `insert into training_load.external_schedules (schedule_kind, timezone, start_date, end_date, recurrence_rule, opens_time, closes_time, status, event_name, event_type, created_by_user_id, owner_scope, owner_club_id)
     values ('recurring','UTC',$1,$2,'{"version":1,"freq":"daily"}'::jsonb,'17:00','23:59','active','Camp RPE','match',$3,'club',$4) returning id`,
    [FUTURE, day2, c.clubAdmin.id, c.clubId],
  ))[0].id;
  await q(`insert into training_load.external_schedule_targets (schedule_id, target_kind, target_team_id) values ($1, 'team', $2)`, [twoDays, c.team1]);
  const camp = (await createEvent(c.clubAdmin.cookie, { eventTypeId: match.id, title: "Camp", day: FUTURE, endDay: day2, externalScheduleId: twoDays, targets: [{ kind: "athlete", id: c.a1.athleteId }, { kind: "athlete", id: c.a2.athleteId }] })).body.event;
  res = await calendar(c.coach1.cookie, { from: FUTURE, to: day2 });
  const byDay = Object.fromEntries(eventCards(res, camp.id).map((card) => [card.date, card.scheduleFold.external]));
  assert.deepEqual(byDay, { [FUTURE]: "separate", [day2]: "folded" });
  assert.ok(itemsOn(res, FUTURE).some((i) => i.key === `external:${twoDays}:${FUTURE}`), "the leaver's day keeps the schedule's card");
  assert.equal(itemsOn(res, day2).some((i) => i.key === `external:${twoDays}:${day2}`), false);
  // A wide range is the union of its days, for every viewer.
  for (const viewer of [c.coach1, c.coach2, c.clubAdmin]) {
    const wide = await calendar(viewer.cookie, { from: PAST, to: day2, extra: "&include=athletes" });
    for (const day of [PAST, FUTURE, day2]) {
      const single = await calendar(viewer.cookie, { from: day, to: day, extra: "&include=athletes" });
      const shape = (items) => items.map((i) => `${i.key}|${[...(i.athleteIds || [])].sort().join(",")}|${JSON.stringify(i.rpe)}|${JSON.stringify(i.scheduleFold ?? null)}`).sort();
      assert.deepEqual(shape(itemsOn(wide, day)), shape(itemsOn(single, day)), `wide == the day ${day}`);
    }
  }
});
