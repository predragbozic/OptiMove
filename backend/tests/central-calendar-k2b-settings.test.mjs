// Central calendar K2b-1a: Settings -> Calendar — the club's event types,
// details and places, team colours, migration v51 and the settings API.
// Plan: docs/ai/central-calendar-k2b-plan.md (sections 2-6, 11-13 and 16).
//
// The event-side rows of v51 (an event's chosen details, its values, its
// library place) have no route before K2b-1b: their database rules are hit
// here raw, inside transactions shaped as K2b-1b's commands will be (the
// event's revision bumped, its request and change rows written).
//
// One disposable database through the real runner (support/calendar-
// fixture.mjs); the rollback rehearsal builds and drops a second one. The real
// Express app over HTTP with real session cookies. Nothing touches OPTIMOVE
// or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";
import { addDays, calendarMigrations, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";
import { CALENDAR_COLOR_KEYS } from "../src/calendarColors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V51 = "202611011900_calendar_v51_settings.sql";
const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = addDays(TODAY, 1);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const TZ = "Europe/Belgrade";
const SEEDED_KEYS = ["training", "match", "travel", "meeting", "day_off", "camp", "test"];
const SEEDED_ICONS = ["run", "trophy", "route", "team", "bed", "mountain", "clipboard"];

let env;
let m;
let settingsService;
let eventService;
const raws = [];

before(async () => {
  env = await startCalendarApp({ label: "k2b" });
  settingsService = await import("../src/calendarSettingsService.js");
  eventService = await import("../src/calendarEventService.js");
  m = await calendarRoleMatrix(env, "k2b");
});

after(async () => {
  for (const c of raws) await c.end().catch(() => {});
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const api = (p, o) => env.api(p, o);
const calendarOf = (cookie) => api(`/api/calendar?from=${FROM}&to=${TO}`, { cookie });
const typesOf = (cookie) => api("/api/calendar/events/types", { cookie });
const settingsOf = (cookie) => api("/api/calendar/settings", { cookie });
const send = (cookie, method, p, body) => api(`/api/calendar/settings${p}`, { method, cookie, body: { requestKey: newKey(), ...body } });
const idsOf = (res) => res.body.types.map((t) => t.id).sort();
const ZERO = "00000000-0000-4000-8000-000000000000";

async function rawClient() {
  const client = new pg.Client({ connectionString: env.db.url });
  await client.connect();
  raws.push(client);
  return client;
}

// A club with its admin, for a test that changes the club's catalog.
async function freshClub(label) {
  const clubId = await env.fx.makeClub(`${label} club`);
  const teamId = await env.fx.makeTeam(clubId, `${label} team`);
  const admin = await env.fx.clubAdminOf(clubId, `${label} admin`);
  return { clubId, teamId, admin };
}
async function catalog(cookie) {
  const res = await settingsOf(cookie);
  assert.equal(res.status, 200, res.text);
  return res.body;
}
const byKey = (list, key) => list.find((x) => x.key === key);

// An event through the K2a route (the club's own, targeting the club).
// No details chosen (K2b-1b would copy the type's defaults): the raw writes
// of this suite choose them themselves.
async function clubEvent(admin, clubId, kind = "training") {
  const types = (await typesOf(admin.cookie)).body.types;
  const res = await api("/api/calendar/events", {
    method: "POST", cookie: admin.cookie,
    body: { requestKey: newKey(), timezone: TZ, eventTypeId: types.find((t) => t.kind === kind).id, title: `Event ${uid()}`, day: FUTURE, targets: [{ kind: "club", id: clubId }], fieldIds: [] },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}

// A raw event-side write shaped as a K2b-1b command: the event's revision
// bumped (by `fn` itself when it updates the event: one write, one bump),
// then `fn`, then its request and change rows, in one transaction.
async function rawEventWrite(client, { eventId, userId, bump = true }, fn) {
  await client.query("begin");
  try {
    if (bump) await client.query(`update calendar.events set revision = revision + 1 where id = $1`, [eventId]);
    await fn(client);
    const request = (await client.query(
      `insert into calendar.event_requests (request_key, request_hash, operation, performed_by_user_id, event_id, result)
       values (gen_random_uuid(), $1, 'set_fields', $2, $3, '{}') returning id`,
      ["b".repeat(64), userId, eventId],
    )).rows[0].id;
    const revision = (await client.query(`select revision from calendar.events where id = $1`, [eventId])).rows[0].revision;
    await client.query(
      `insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, request_id, revision) values ($1, 'set_fields', 'club_admin', $2, $3, $4)`,
      [eventId, userId, request, revision],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

// A raw catalog write with its audit: `fn` writes the subject (bumping its
// revision); the request and change rows follow.
async function rawSettingsWrite(client, { clubId, userId, kind, subjectId, operation }, fn) {
  await client.query("begin");
  try {
    await fn(client);
    const request = (await client.query(
      `insert into calendar.settings_requests (request_key, request_hash, operation, performed_by_user_id, club_id, result)
       values (gen_random_uuid(), $1, $2, $3, $4, '{}') returning id`,
      ["c".repeat(64), operation, userId, clubId],
    )).rows[0].id;
    const column = { type: "event_type_id", field: "field_id", location: "location_id", team: "team_id" }[kind];
    const table = { type: "calendar.event_types", field: "calendar.event_fields", location: "calendar.locations", team: "calendar.team_settings" }[kind];
    const revision = (await client.query(`select revision from ${table} where ${kind === "team" ? "team_id" : "id"} = $1`, [subjectId])).rows[0].revision;
    await client.query(
      `insert into calendar.settings_changes (request_id, subject_kind, ${column}, revision, kind, basis, performed_by_user_id) values ($1, $2, $3, $4, $5, 'club_admin', $6)`,
      [request, kind, subjectId, revision, operation, userId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

// An event whose chosen detail `field` holds a value: the field becomes
// "answered" (plan 2.3).
async function answer(client, { admin, clubId, field, value }) {
  const ev = await clubEvent(admin, clubId);
  await rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, field.id]);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, ${value.column}, updated_by_user_id) values ($1, $2, $3, $4)`, [ev.id, field.id, value.value, admin.id]);
  });
  return ev;
}

const DIGEST_SQL = `
  select md5(string_agg(x, '|' order by x)) as d from (
    select 'col:' || table_schema || '.' || table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, '') as x
      from information_schema.columns where table_schema not in ('pg_catalog', 'information_schema')
    union all
    select 'func:' || n.nspname || '.' || p.proname || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname not in ('pg_catalog', 'information_schema') and p.prokind = 'f'
    union all
    select 'trg:' || n.nspname || '.' || c.relname || '.' || t.tgname || ':' || t.tgenabled::text || ':' || pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname not in ('pg_catalog', 'information_schema')
    union all
    select 'idx:' || schemaname || '.' || indexname || ':' || indexdef from pg_indexes where schemaname not in ('pg_catalog', 'information_schema')
    union all
    select 'con:' || n.nspname || '.' || cl.relname || '.' || co.conname || ':' || pg_get_constraintdef(co.oid)
      from pg_constraint co join pg_class cl on cl.oid = co.conrelid join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname not in ('pg_catalog', 'information_schema')
  ) s`;

async function runbookBlocks(client, file) {
  const text = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks", file), "utf8");
  const statements = text.split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const rows = [];
  for (const statement of statements) rows.push((await client.query(statement)).rows[0]);
  return rows;
}

// ---------------------------------------------------------------------------
// 0. The fixture and the form's read
// ---------------------------------------------------------------------------
test("0a. the role matrix resolves to the workspaces the scenarios assume", async () => {
  const { roles, clubs, teams } = m;
  const expected = [
    ["clubAdmin", "club", clubs.c1], ["twoClubAdmin", "club", clubs.c1], ["teamCoach", "team", teams.t1],
    ["privateCoach", "private_coach", null], ["athlete", "athlete", null], ["platformAdmin", "platform", null],
    ["platformInClub", "club", clubs.c1], ["stranger", "club", clubs.c2],
  ];
  for (const [name, type, scopeId] of expected) {
    const res = await calendarOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.equal(res.body.workspace.type, type, name);
    assert.equal(res.body.workspace.scopeId ? String(res.body.workspace.scopeId) : null, scopeId ? String(scopeId) : null, name);
  }
  const revoked = await calendarOf(roles.revokedAdmin.cookie);
  const archived = await calendarOf(roles.archivedAdmin.cookie);
  assert.equal(revoked.status, 403, revoked.text);
  assert.equal(archived.status, revoked.status);
  assert.deepEqual(archived.body, revoked.body);
});

test("0b. every club of the matrix holds the full seed: seven types (with their icons), ten details, seventeen options, thirteen list entries", async () => {
  for (const clubId of Object.values(m.clubs)) {
    const types = await q(`select seed_key, icon_key, revision from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 order by sort_order`, [clubId]);
    assert.deepEqual(types.map((r) => r.seed_key), SEEDED_KEYS);
    assert.deepEqual(types.map((r) => r.icon_key), ["run", "trophy", "route", "team", "bed", "mountain", "clipboard"]);
    const counts = (await q(
      `select (select count(*)::int from calendar.event_fields where owner_scope = 'club' and owner_club_id = $1) as fields,
              (select count(*)::int from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id where f.owner_club_id = $1) as options,
              (select count(*)::int from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id where t.owner_club_id = $1) as lists`,
      [clubId],
    ))[0];
    assert.deepEqual(counts, { fields: 10, options: 17, lists: 13 });
  }
  assert.deepEqual(SEEDED_ICONS.length, 7);
});

test("0c. GET /events/types: the types as before (T2), additively each type's colour and live default details, the workspace's details, places and team defaults; never another club's", async () => {
  const { roles } = m;
  const c1 = await typesOf(roles.clubAdmin.cookie);
  assert.equal(c1.status, 200, c1.text);
  assert.deepEqual(Object.keys(c1.body).sort(), ["fields", "locations", "teamDefaults", "types"]);
  assert.deepEqual(c1.body.types.map((t) => t.key), SEEDED_KEYS);
  assert.ok(c1.body.types.every((t) => t.ownerScope === "club" && "colorKey" in t && Array.isArray(t.defaultFieldIds)));
  const fieldIds = new Set(c1.body.fields.map((f) => f.id));
  assert.equal(c1.body.fields.length, 10);
  assert.equal(c1.body.types.find((t) => t.kind === "match").defaultFieldIds.length, 7);
  assert.ok(c1.body.types.every((t) => t.defaultFieldIds.every((id) => fieldIds.has(id))), "a default detail is one of the club's");
  assert.deepEqual(c1.body.fields.find((f) => f.label === "Weather").options.map((o) => o.label), ["Sunny", "Cloudy", "Rain", "Snow", "Windy"]);
  for (const name of ["twoClubAdmin", "teamCoach", "platformInClub"]) {
    const res = await typesOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.deepEqual(idsOf(res), idsOf(c1), name);
    assert.deepEqual(res.body.fields.map((f) => f.id).sort(), [...fieldIds].sort(), name);
  }
  const c2 = await typesOf(roles.stranger.cookie);
  assert.equal(idsOf(c2).filter((id) => idsOf(c1).includes(id)).length, 0, "club 2's set shares no row with club 1's");
  assert.equal(c2.body.fields.filter((f) => fieldIds.has(f.id)).length, 0);
  for (const name of ["privateCoach", "platformAdmin"]) {
    const res = await typesOf(roles[name].cookie);
    assert.equal(res.status, 200, `${name}: ${res.text}`);
    assert.ok(res.body.types.every((t) => t.ownerScope === "system"), name);
    assert.equal(res.body.fields.length, 10, `${name}: the system details`);
    assert.deepEqual(res.body.locations, [], `${name}: no places (D33)`);
    assert.deepEqual(res.body.teamDefaults, {}, name);
  }
  for (const name of ["athlete", "revokedAdmin", "archivedAdmin"]) {
    assert.equal((await typesOf(roles[name].cookie)).status, 403, name);
  }
});

// ---------------------------------------------------------------------------
// 1. The migration
// ---------------------------------------------------------------------------
test("1a. v51 is recorded once, with its objects and the seed exactly; the post-check reads as expected on the fresh database", async () => {
  const client = await rawClient();
  const post = await runbookBlocks(client, "calendar-settings-v51-postcheck.sql");
  assert.equal(Number(post[0].v51_rows), 1);
  assert.equal(Number(post[0].later_rows), 0);
  assert.equal(post[0].last_migration, `migrations_v2/${V51}`);
  assert.match(post[0].v51_checksum, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    { tables: Number(post[1].tables), functions: Number(post[1].functions), triggers: Number(post[1].triggers), disabled: Number(post[1].disabled_triggers), guard: Number(post[1].read_only_guard) },
    { tables: 16, functions: 48, triggers: 61, disabled: 0, guard: 0 }, "block 2",
  );
  assert.deepEqual([post[2].system_fields, post[2].system_options, post[2].system_lists, post[2].clubs_not_complete, post[2].types_without_icon].map(Number), [10, 17, 13, 0, 0], "block 3");
  assert.ok(Object.values(post[3]).every((v) => Number(v) === 0), `block 4: ${JSON.stringify(post[3])}`);
  assert.equal(Number(post[4].locks_on_calendar), 0, "block 5");
  assert.equal(Number(post[5].tables_granted), 0, "block 6");
  assert.equal(Number(post[6].clubs_without_details), 0, "block 7");
  // The clubs lock is the migration's first statement after its lock_timeout
  // (db review F1: before any DDL on calendar.*, in POST /clubs' order).
  const migration = (await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", V51), "utf8"))
    .split(/\r?\n/).filter((line) => !line.trim().startsWith("--")).join("\n")
    .split(/;\s*\n/).map((x) => x.trim()).filter(Boolean);
  assert.deepEqual(migration.slice(0, 2), ["set local lock_timeout = '5s'", "lock table public.clubs in share row exclusive mode"]);
  // The system set is final (D35).
  await assert.rejects(q(`update calendar.event_fields set required = true, revision = revision + 1 where owner_scope = 'system' and key = 'weather'`), (e) => e.code === "23514");
  await assert.rejects(q(`update calendar.event_types set color_key = 'teal', revision = revision + 1 where owner_scope = 'system' and key = 'match'`), (e) => e.code === "23514");
  await assert.rejects(q(`insert into calendar.event_types (owner_scope, kind, key, label, created_by_user_id) values ('system', 'training', 'extra_sys', 'Extra', $1)`, [m.roles.clubAdmin.id]), (e) => e.code === "23514");
  await assert.rejects(q(`delete from calendar.event_type_fields where event_type_id = (select id from calendar.event_types where owner_scope = 'system' and key = 'match') returning 1`), (e) => e.code === "23514");
  // v49's two CHECKs now hold the two new kinds.
  const defs = await q(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('event_requests_operation_check', 'event_changes_kind_check')`);
  for (const d of defs) assert.ok(d.def.includes("set_fields") && d.def.includes("align_sessions"), d.conname);
});

test("1b. the rollback rehearsal: the preflight on v50, apply -> rollback -> the v50 catalog digest identical -> re-apply; every refusal leaves v51 in place", async () => {
  const before51 = calendarMigrations().filter((x) => x !== V51);
  const other = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "k2brb", migrations: before51 });
  const client = new pg.Client({ connectionString: other.url });
  await client.connect();
  const rollback = await fsp.readFile(path.resolve(__dirname, "../../docs/runbooks/calendar-settings-v51-rollback.sql"), "utf8");
  const refused = async (label, re) => {
    await assert.rejects(client.query(rollback), (e) => re.test(e.message), label);
    await client.query("rollback").catch(() => {});
    assert.ok((await client.query(`select to_regclass('calendar.event_fields') as t`)).rows[0].t, `${label}: nothing dropped`);
  };
  try {
    // A club and its seeded types as v49 left them.
    const clubId = (await client.query(`insert into public.clubs (name) values ('rb club') returning id`)).rows[0].id;
    await client.query(`select calendar.seed_club_event_types($1)`, [clubId]);
    const pre = await runbookBlocks(client, "calendar-settings-v51-preflight.sql");
    assert.equal(pre[0].pg15_or_later, true, "block 1");
    assert.deepEqual([pre[1].v49_rows, pre[1].v50_rows, pre[1].v51_rows, pre[1].at_or_after_v51].map(Number), [1, 1, 0, 0], "block 2");
    assert.equal(pre[1].last_migration, "migrations_v2/202610311200_training_load_v50_source_instance_end.sql");
    assert.deepEqual([pre[2].tables, pre[2].v51_tables, pre[2].read_only_guard, pre[2].non_seed_types, pre[2].typed_icons].map(Number), [7, 0, 1, 0, 0], "block 3");
    assert.ok(Object.values(pre[3]).every((v) => v === true), `block 4: ${JSON.stringify(pre[3])}`);
    assert.equal(Number(pre[4].active_clubs), 1, "block 5");
    assert.deepEqual([pre[5].unknown_operations, pre[5].unknown_kinds].map(Number), [0, 0], "block 6");
    assert.ok("idle_in_transaction" in pre[6] && "strong_locks" in pre[6], "block 7 runs");
    // Without v51 the rollback refuses before touching anything.
    await assert.rejects(client.query(rollback), /v51 is not recorded/);
    await client.query("rollback").catch(() => {});

    const digestBefore = (await client.query(DIGEST_SQL)).rows[0].d;
    await applyGpexeTestMigrations(other.url, [V51]);
    const counts = (await client.query(`select count(*)::int as n from calendar.event_fields where owner_club_id = $1`, [clubId])).rows[0].n;
    assert.equal(counts, 10, "the existing club got its details");
    await client.query(rollback);
    assert.equal((await client.query(`select to_regclass('calendar.event_fields') as t`)).rows[0].t, null, "the tables are gone");
    assert.equal((await client.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%' || $1`, [V51])).rows[0].n, 0, "the record is gone");
    assert.equal((await client.query(DIGEST_SQL)).rows[0].d, digestBefore, "the catalog is exactly v50's again (constraints, function bodies, triggers included)");
    await assert.rejects(client.query(`update calendar.event_types set label = 'X' where owner_club_id = $1 and key = 'training'`, [clubId]), /refused until Settings/, "v49's read-only guard is back");
    await applyGpexeTestMigrations(other.url, [V51]);
    assert.ok((await client.query(`select to_regclass('calendar.event_fields') as t`)).rows[0].t, "re-applied");

    await client.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912311000_later_test_only.sql', $1, 'test')`, ["f".repeat(64)]);
    await refused("a later migration", /later migration/);
    await client.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912311000_later_test_only.sql'`);
    // A row that depends on v51 (a seed-shaped insert needs no change row; its
    // colour is v51's): refused; the club's hard delete then takes it away.
    const clubY = (await client.query(`insert into public.clubs (name) values ('rb club y') returning id`)).rows[0].id;
    await client.query(`insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, color_key, seed_key) values ('club', $1, 'training', 'extra', 'Extra', 'teal', 'extra')`, [clubY]);
    await refused("a row that depends on v51", /depend on v51/);
    await client.query(`delete from public.clubs where id = $1`, [clubY]);
    const holder = new pg.Client({ connectionString: other.url });
    await holder.connect();
    try {
      await holder.query(`select pg_advisory_lock(822026)`);
      await refused("the migrator's lock", /migrator holds its lock/);
    } finally {
      await holder.end();
    }
    await client.query(rollback);
    assert.equal((await client.query(DIGEST_SQL)).rows[0].d, digestBefore, "and once more after the refusals");
  } finally {
    await client.end().catch(() => {});
    await other.drop();
  }
});

// ---------------------------------------------------------------------------
// 2. Black-box scenarios by role
// ---------------------------------------------------------------------------
test("2a. the club admin of C1 reads and writes C1's catalog, its team colours and default places; every write is one request and one change", async () => {
  const { roles, clubs, teams } = m;
  const admin = roles.clubAdmin;
  const cat = await catalog(admin.cookie);
  assert.equal(cat.clubId, String(clubs.c1));
  assert.deepEqual(cat.types.map((t) => t.key), SEEDED_KEYS);
  assert.ok(cat.types.every((t) => t.seeded && t.revision === 1 && t.canEdit));
  assert.equal(cat.fields.length, 10);
  assert.deepEqual(cat.locations, []);
  assert.deepEqual(cat.teams.map((t) => t.teamId).sort(), [teams.t1, teams.t2].map(String).sort(), "active teams only");
  const weather = cat.fields.find((f) => f.key === "weather");

  const requestsBefore = (await q(`select count(*)::int as n from calendar.settings_requests`))[0].n;
  const created = await send(admin.cookie, "POST", "/types", { label: "Recovery session", kind: "training", iconKey: "stretch", colorKey: "green", defaultExpects: ["rpe"], fieldIds: [weather.id] });
  assert.equal(created.status, 201, created.text);
  const type = created.body.type;
  assert.deepEqual([type.key, type.kind, type.iconKey, type.colorKey, type.revision, type.seeded], ["recovery_session", "training", "stretch", "green", 1, false]);
  assert.deepEqual(type.fieldIds, [weather.id]);
  const edited = await send(admin.cookie, "PATCH", `/types/${type.id}`, { expectedRevision: 1, label: "Recovery", colorKey: null, fieldIds: [] });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual([edited.body.type.label, edited.body.type.colorKey, edited.body.type.revision, edited.body.type.fieldIds.length], ["Recovery", null, 2, 0]);
  const stale = await send(admin.cookie, "PATCH", `/types/${type.id}`, { expectedRevision: 1, label: "Stale" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "type_changed");
  assert.equal(stale.body.current.revision, 2);

  const field = await send(admin.cookie, "POST", "/fields", { label: "Pitch quality", valueKind: "choice", options: ["Good", "Fair", "Poor"], required: true });
  assert.equal(field.status, 201, field.text);
  assert.deepEqual([field.body.field.key, field.body.field.required, field.body.field.options.length, field.body.field.filledBy], ["pitch_quality", true, 3, "coach"]);
  assert.equal((await send(admin.cookie, "POST", "/fields", { label: "One option", valueKind: "choice", options: ["Only"] })).body.error, "invalid_option");
  assert.equal((await send(admin.cookie, "POST", "/fields", { label: "Bad unit", valueKind: "yes_no", unit: "kg" })).body.error, "invalid_number");
  const number = await send(admin.cookie, "POST", "/fields", { label: "Wind speed", valueKind: "number", unit: "km/h", minValue: 0, maxValue: 200 });
  assert.equal(number.status, 201, number.text);
  assert.deepEqual([number.body.field.unit, number.body.field.minValue, number.body.field.maxValue], ["km/h", 0, 200]);

  const place = await send(admin.cookie, "POST", "/locations", { name: "Main stadium", address: "1 Stadium Road", note: "Gate B\nParking behind the stand" });
  assert.equal(place.status, 201, place.text);
  assert.equal(place.body.location.note, "Gate B\nParking behind the stand");
  const team = await send(admin.cookie, "PUT", `/teams/${teams.t1}`, { expectedRevision: 0, colorKey: "rose", defaultLocationId: place.body.location.id });
  assert.equal(team.status, 200, team.text);
  assert.deepEqual(team.body.team, { teamId: String(teams.t1), name: team.body.team.name, colorKey: "rose", defaultLocationId: place.body.location.id, revision: 1 });
  const again = await send(admin.cookie, "PUT", `/teams/${teams.t1}`, { expectedRevision: 0, colorKey: "sky" });
  assert.equal(again.body.error, "team_changed");

  const requests = (await q(`select count(*)::int as n from calendar.settings_requests`))[0].n;
  assert.equal(requests - requestsBefore, 6, "one request per successful write, none per refusal");
  const changes = await q(`select c.kind, c.basis, c.details from calendar.settings_changes c join calendar.settings_requests r on r.id = c.request_id where r.performed_by_user_id = $1`, [admin.id]);
  assert.equal(changes.length, 6);
  assert.ok(changes.every((c) => c.basis === "club_admin"));
  assert.ok(changes.every((c) => !JSON.stringify(c.details).includes("Stadium") && !JSON.stringify(c.details).includes("Recovery")), "no label or address in the change log");

  const form = await typesOf(admin.cookie);
  assert.equal(form.body.types.find((t) => t.id === type.id).label, "Recovery");
  assert.ok(form.body.fields.some((f) => f.label === "Pitch quality"));
  assert.deepEqual(form.body.locations.map((l) => l.name), ["Main stadium"]);
  assert.deepEqual(form.body.teamDefaults, { [String(teams.t1)]: place.body.location.id });
  const cal = await calendarOf(admin.cookie);
  assert.equal(cal.body.teams.find((t) => t.teamId === String(teams.t1)).colorKey, "rose");
  assert.equal(cal.body.teams.find((t) => t.teamId === String(teams.t2)).colorKey, null, "automatic");
});

test("2b. the admin of C1 and C2 in C1's workspace: C2's ids are the identical 404 in a path and the identical 400 in a body; a key reused in C2's workspace is refused", async () => {
  const { roles, clubs, teams } = m;
  const admin = roles.twoClubAdmin;
  const cat = await catalog(admin.cookie);
  assert.equal(cat.clubId, String(clubs.c1));
  const c2 = await catalog(roles.stranger.cookie);
  const c2Type = c2.types[0];
  const c2Field = c2.fields[0];
  const foreign = await send(admin.cookie, "PATCH", `/types/${c2Type.id}`, { expectedRevision: 1, label: "Taken over" });
  const random = await send(admin.cookie, "PATCH", `/types/${ZERO}`, { expectedRevision: 1, label: "Taken over" });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.text, random.text, "byte-identical 404");
  assert.equal(foreign.cacheControl, "no-store");
  for (const p of [`/fields/${c2Field.id}/archive`, `/teams/${teams.u1}`]) {
    const method = p.startsWith("/teams") ? "PUT" : "POST";
    const res = await send(admin.cookie, method, p, { expectedRevision: method === "PUT" ? 0 : 1, colorKey: method === "PUT" ? "teal" : undefined });
    assert.equal(res.status, 404, p);
    assert.equal(res.text, random.text, p);
  }
  const bodyForeign = await send(admin.cookie, "POST", "/types", { label: "Foreign list", kind: "training", fieldIds: [c2Field.id] });
  const bodyRandom = await send(admin.cookie, "POST", "/types", { label: "Foreign list", kind: "training", fieldIds: [ZERO] });
  assert.equal(bodyForeign.status, 400);
  assert.equal(bodyForeign.text, bodyRandom.text, "byte-identical 400");
  assert.equal(bodyForeign.body.error, "field_not_available");
  // Nothing of C2 changed.
  assert.equal((await catalog(roles.stranger.cookie)).types[0].revision, 1);

  const key = newKey();
  const body = { requestKey: key, name: `Shared ${uid()}` };
  const first = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
  assert.equal(first.status, 201, first.text);
  await env.fx.setWorkspace(admin.id, "club", clubs.c2);
  try {
    const reused = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
    assert.equal(reused.status, 409, reused.text);
    assert.equal(reused.body.error, "request_key_reused");
    assert.equal((await catalog(admin.cookie)).locations.length, 0, "nothing written in C2");
  } finally {
    await env.fx.setWorkspace(admin.id, "club", clubs.c1);
  }
});

test("2c-2f. the team coach, the private coach, the athlete and the platform workspace: 403 on a collection, the one 404 on an id; the form's lists of their own workspace", async () => {
  const { roles, teams } = m;
  const c1 = await catalog(roles.clubAdmin.cookie);
  const c1Type = c1.types[0];
  const random = await send(roles.teamCoach.cookie, "PATCH", `/types/${ZERO}`, { expectedRevision: 1, label: "X" });
  for (const name of ["teamCoach", "privateCoach", "athlete", "platformAdmin", "stranger", "revokedAdmin", "archivedAdmin"]) {
    const cookie = roles[name].cookie;
    const read = await settingsOf(cookie);
    if (name === "stranger") {
      assert.equal(read.status, 200, "C2's admin reads C2's own catalog");
      assert.notEqual(read.body.clubId, c1.clubId);
    } else if (name === "platformAdmin") {
      assert.deepEqual([read.status, read.body.error], [403, "workspace_required"]);
    } else {
      assert.deepEqual([read.status, read.body], [403, { error: "Forbidden" }], name);
    }
    const write = await send(cookie, "PATCH", `/types/${c1Type.id}`, { expectedRevision: 1, label: "Taken over" });
    assert.equal(write.status, 404, name);
    assert.equal(write.text, random.text, `${name}: byte-identical 404`);
    if (name !== "stranger") {
      const create = await send(cookie, "POST", "/locations", { name: "Nope" });
      assert.equal(create.status, 403, name);
    }
    const team = await send(cookie, "PUT", `/teams/${teams.t1}`, { expectedRevision: 1, colorKey: "teal" });
    assert.equal(team.status, 404, name);
  }
  assert.equal((await catalog(roles.clubAdmin.cookie)).types[0].revision, c1Type.revision, "nothing changed");
  const coachForm = await typesOf(roles.teamCoach.cookie);
  assert.equal(coachForm.status, 200);
  assert.ok(Object.keys(coachForm.body.teamDefaults).every((id) => id === String(teams.t1)), "the coach's own team only");
});

test("2g. a platform admin who also administers C1 writes there on the club_admin basis (T6)", async () => {
  const res = await send(m.roles.platformInClub.cookie, "POST", "/locations", { name: `Support place ${uid()}` });
  assert.equal(res.status, 201, res.text);
  const change = (await q(`select c.basis from calendar.settings_changes c where c.location_id = $1`, [res.body.location.id]))[0];
  assert.equal(change.basis, "club_admin");
});

test("2h. a role revoked between the route's check and the writer lock: the one 404 on an id, 403 on a collection; nothing written", async () => {
  const { clubId, admin } = await freshClub("revoke");
  const cat = await catalog(admin.cookie);
  const hooks = settingsService.testHooks;
  const revoke = async () => q(`update public.user_club_roles set is_active = false where user_id = $1`, [admin.id]);
  try {
    hooks.beforeLocks = revoke;
    const onId = await send(admin.cookie, "PATCH", `/types/${cat.types[0].id}`, { expectedRevision: 1, label: "Late" });
    assert.equal(onId.status, 404, onId.text);
    assert.equal(onId.cacheControl, "no-store");
    await q(`update public.user_club_roles set is_active = true where user_id = $1`, [admin.id]);
    const onCollection = await send(admin.cookie, "POST", "/locations", { name: "Late place" });
    assert.equal(onCollection.status, 403, onCollection.text);
    // A replay is answered only after the locks: the saved answer never
    // reaches a caller who lost the right meanwhile.
    delete hooks.beforeLocks;
    await q(`update public.user_club_roles set is_active = true where user_id = $1`, [admin.id]);
    const key = newKey();
    const saved = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: { requestKey: key, name: "Saved place" } });
    assert.equal(saved.status, 201, saved.text);
    hooks.beforeLocks = revoke;
    const replay = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: { requestKey: key, name: "Saved place" } });
    assert.equal(replay.status, 403, replay.text);
    assert.equal(replay.body.location, undefined);
  } finally {
    delete hooks.beforeLocks;
    await q(`update public.user_club_roles set is_active = true where user_id = $1`, [admin.id]);
  }
  assert.equal((await q(`select count(*)::int as n from calendar.settings_requests where club_id = $1`, [clubId]))[0].n, 1, "only the saved place");
});

// ---------------------------------------------------------------------------
// 3. Invariants
// ---------------------------------------------------------------------------
test("3a. the read's canEdit equals the write verdict for every caller of the matrix", async () => {
  for (const [name, role] of Object.entries(m.roles)) {
    const read = await settingsOf(role.cookie);
    const canEdit = read.status === 200 && read.body.types.every((t) => t.canEdit === true);
    const own = read.status === 200 ? read.body.types.find((t) => !t.archived) : null;
    const target = own ?? (await catalog(m.roles.clubAdmin.cookie)).types[0];
    const write = await send(role.cookie, "PATCH", `/types/${target.id}`, { expectedRevision: target.revision, iconKey: target.iconKey === "run" ? "walk" : "run" });
    assert.equal(write.status === 200, canEdit, `${name}: read ${read.status}, write ${write.status}`);
  }
});

test("3b. the meaning freeze: a detail with a value keeps its label, unit, bounds and option labels — through the route and raw SQL; required, description and options' adding, hiding and showing still work (D30)", async () => {
  const { clubId, admin } = await freshClub("freeze");
  const client = await rawClient();
  const cat = await catalog(admin.cookie);
  const weather = byKey(cat.fields, "weather");
  const temperature = byKey(cat.fields, "temperature");
  // Before any value, the meaning may still change.
  const early = await send(admin.cookie, "PATCH", `/fields/${temperature.id}`, { expectedRevision: 1, maxValue: 45 });
  assert.equal(early.status, 200, early.text);
  await answer(client, { admin, clubId, field: weather, value: { column: "option_id", value: weather.options[0].id } });
  await answer(client, { admin, clubId, field: early.body.field, value: { column: "number_value", value: 21.5 } });
  const answered = (await catalog(admin.cookie)).fields.find((f) => f.id === weather.id);
  assert.equal(answered.answered, true);
  for (const change of [{ label: "Sky" }, { options: { rename: [{ id: weather.options[0].id, label: "Sunshine" }] } }]) {
    const res = await send(admin.cookie, "PATCH", `/fields/${weather.id}`, { expectedRevision: answered.revision, ...change });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, "field_answered");
    // The service names what is frozen and returns the detail as it is.
    assert.deepEqual(res.body.frozen, "label" in change ? ["label"] : ["options.rename"]);
    assert.equal(res.body.current.id, weather.id);
  }
  const temp = (await catalog(admin.cookie)).fields.find((f) => f.id === temperature.id);
  for (const change of [{ unit: "F" }, { minValue: -10 }, { maxValue: 60 }]) {
    const res = await send(admin.cookie, "PATCH", `/fields/${temperature.id}`, { expectedRevision: temp.revision, ...change });
    assert.equal(res.body.error, "field_answered", JSON.stringify(change));
  }
  // Raw: the database refuses whoever writes.
  await assert.rejects(
    rawSettingsWrite(client, { clubId, userId: admin.id, kind: "field", subjectId: weather.id, operation: "field_update" },
      (c) => c.query(`update calendar.event_fields set label = 'Sky', revision = revision + 1 where id = $1`, [weather.id])),
    (e) => e.code === "23514" && e.constraint === "event_fields_answered_frozen",
  );
  await assert.rejects(
    rawSettingsWrite(client, { clubId, userId: admin.id, kind: "field", subjectId: weather.id, operation: "field_update" }, async (c) => {
      await c.query(`update calendar.event_fields set revision = revision + 1 where id = $1`, [weather.id]);
      await c.query(`update calendar.event_field_options set label = 'Sunshine' where id = $1`, [weather.options[0].id]);
    }),
    (e) => e.code === "23514" && e.constraint === "event_fields_answered_frozen",
  );
  // What stays allowed.
  let rev = answered.revision;
  const allowed = [
    { required: true }, { description: "As seen at the start" }, { options: { add: ["Fog"] } },
    { options: { hide: [weather.options[1].id] } }, { options: { show: [weather.options[1].id] } },
  ];
  for (const change of allowed) {
    const res = await send(admin.cookie, "PATCH", `/fields/${weather.id}`, { expectedRevision: rev, ...change });
    assert.equal(res.status, 200, `${JSON.stringify(change)}: ${res.text}`);
    rev = res.body.field.revision;
  }
  const after = (await catalog(admin.cookie)).fields.find((f) => f.id === weather.id);
  assert.deepEqual([after.label, after.required, after.options.length], ["Weather", true, 6]);
  // A hidden option keeps its old answers and leaves the form (D30).
  const hide = await send(admin.cookie, "PATCH", `/fields/${weather.id}`, { expectedRevision: after.revision, options: { hide: [weather.options[0].id] } });
  assert.equal(hide.status, 200, hide.text);
  const form = (await typesOf(admin.cookie)).body.fields.find((f) => f.id === weather.id);
  assert.ok(!form.options.some((o) => o.id === weather.options[0].id));
  assert.equal((await q(`select count(*)::int as n from calendar.event_field_values where option_id = $1`, [weather.options[0].id]))[0].n, 1);
  // A hidden option is never newly chosen (raw).
  const ev = await clubEvent(admin, clubId);
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, weather.id]);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, option_id, updated_by_user_id) values ($1, $2, $3, $4)`, [ev.id, weather.id, weather.options[0].id, admin.id]);
  }), (e) => e.constraint === "event_field_values_option");
});

test("3c. the database keeps every detail inside its owner: type lists, event selections, values by kind and bounds, places", async () => {
  const { clubId, admin } = await freshClub("owner");
  const other = await catalog(m.roles.stranger.cookie);
  const client = await rawClient();
  const cat = await catalog(admin.cookie);
  const training = byKey(cat.types, "training");
  const temperature = byKey(cat.fields, "temperature");
  const foreignField = other.fields[0];
  await assert.rejects(rawSettingsWrite(client, { clubId, userId: admin.id, kind: "type", subjectId: training.id, operation: "type_update" }, async (c) => {
    await c.query(`update calendar.event_types set revision = revision + 1 where id = $1`, [training.id]);
    await c.query(`insert into calendar.event_type_fields (event_type_id, field_id, position) values ($1, $2, 9)`, [training.id, foreignField.id]);
  }), (e) => e.code === "23514" && /own owner/.test(e.message));
  const ev = await clubEvent(admin, clubId);
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id },
    (c) => c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, foreignField.id])),
  (e) => e.code === "23514" && /owner's details/.test(e.message));
  const systemField = (await q(`select id from calendar.event_fields where owner_scope = 'system' and key = 'weather'`))[0];
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id },
    (c) => c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, systemField.id])),
  (e) => /owner's details/.test(e.message), "a club event never takes a system detail");
  // A value: only for a chosen detail, of the detail's kind, inside its bounds.
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id },
    (c) => c.query(`insert into calendar.event_field_values (event_id, field_id, number_value, updated_by_user_id) values ($1, $2, 20, $3)`, [ev.id, temperature.id, admin.id])),
  (e) => /not chosen/.test(e.message));
  const select = (c) => c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, temperature.id]);
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await select(c);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, number_value, updated_by_user_id) values ($1, $2, 99, $3)`, [ev.id, temperature.id, admin.id]);
  }), (e) => e.constraint === "event_field_values_bounds");
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await select(c);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, text_value, updated_by_user_id) values ($1, $2, 'warm', $3)`, [ev.id, temperature.id, admin.id]);
  }), (e) => e.constraint === "event_field_values_kind");
  await rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await select(c);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, number_value, updated_by_user_id) values ($1, $2, 18.5, $3)`, [ev.id, temperature.id, admin.id]);
  });
  // A choice value names an option of ITS detail only.
  const weather = byKey(cat.fields, "weather");
  const surface = byKey(cat.fields, "surface");
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id }, async (c) => {
    await c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 1)`, [ev.id, weather.id]);
    await c.query(`insert into calendar.event_field_values (event_id, field_id, option_id, updated_by_user_id) values ($1, $2, $3, $4)`, [ev.id, weather.id, surface.options[0].id, admin.id]);
  }), (e) => e.constraint === "event_field_values_option");
  // A value is never deleted; a write without the event's own write is refused.
  await assert.rejects(q(`delete from calendar.event_field_values where event_id = $1`, [ev.id]), (e) => e.code === "23514");
  await assert.rejects(q(`update calendar.event_field_values set number_value = 19 where event_id = $1`, [ev.id]), (e) => e.code === "23514" && /written with its event/.test(e.message));
  // A place of another club, and a private coach's event, take no library place.
  const otherPlace = await send(m.roles.stranger.cookie, "POST", "/locations", { name: `C2 place ${uid()}` });
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, revision = revision + 1 where id = $1`, [ev.id, otherPlace.body.location.id])),
  (e) => e.constraint === "events_location_usable");
  const own = await send(admin.cookie, "POST", "/locations", { name: "Own ground", address: "2 Field Lane" });
  await assert.rejects(rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, location = 'Also text', revision = revision + 1 where id = $1`, [ev.id, own.body.location.id])),
  (e) => e.constraint === "events_location_one", "a library place OR a one-off text");
  await rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, location = null, revision = revision + 1 where id = $1`, [ev.id, own.body.location.id]));
});

test("3d. archived items: refused when newly chosen, kept where they are, back on restore — or label_taken", async () => {
  const { clubId, teamId, admin } = await freshClub("archive");
  const client = await rawClient();
  const cat = await catalog(admin.cookie);
  const surface = byKey(cat.fields, "surface");
  const training = byKey(cat.types, "training");
  const archived = await send(admin.cookie, "POST", `/fields/${surface.id}/archive`, { expectedRevision: 1 });
  assert.equal(archived.status, 200, archived.text);
  assert.equal(archived.body.field.archived, true);
  assert.equal((await send(admin.cookie, "POST", `/fields/${surface.id}/archive`, { expectedRevision: 2 })).body.error, "field_archived");
  assert.equal((await send(admin.cookie, "POST", "/types", { label: "Uses archived", kind: "training", fieldIds: [surface.id] })).body.error, "field_not_available");
  // The database refuses it too, whoever writes: an archived detail is never a NEW list entry.
  const match = byKey(cat.types, "match");
  await assert.rejects(rawSettingsWrite(client, { clubId, userId: admin.id, kind: "type", subjectId: training.id, operation: "type_update" }, async (c) => {
    await c.query(`update calendar.event_types set revision = revision + 1 where id = $1`, [match.id]);
    await c.query(`update calendar.event_types set revision = revision + 1 where id = $1`, [training.id]);
    await c.query(`delete from calendar.event_type_fields where event_type_id = $1 and field_id = $2`, [match.id, surface.id]);
    await c.query(`insert into calendar.event_type_fields (event_type_id, field_id, position) values ($1, $2, 9)`, [match.id, surface.id]);
  }), (e) => /archived detail is not added/.test(e.message));
  const keptList = (await catalog(admin.cookie)).types.find((t) => t.id === training.id).fieldIds;
  assert.ok(keptList.includes(surface.id), "the type's list keeps it");
  assert.ok(!(await typesOf(admin.cookie)).body.types.find((t) => t.id === training.id).defaultFieldIds.includes(surface.id), "the form leaves it out");
  // The list may keep it on an edit; it can't be added anew elsewhere.
  const reorder = await send(admin.cookie, "PATCH", `/types/${training.id}`, { expectedRevision: 1, fieldIds: [...keptList].reverse() });
  assert.equal(reorder.status, 200, reorder.text);
  const restored = await send(admin.cookie, "POST", `/fields/${surface.id}/restore`, { expectedRevision: 2 });
  assert.equal(restored.status, 200, restored.text);
  assert.ok((await typesOf(admin.cookie)).body.types.find((t) => t.id === training.id).defaultFieldIds.includes(surface.id));
  // A type's label is free again once archived; restoring it then is label_taken.
  const a = await send(admin.cookie, "POST", "/types", { label: "Gym", kind: "training" });
  assert.equal((await send(admin.cookie, "POST", `/types/${a.body.type.id}/archive`, { expectedRevision: 1 })).status, 200);
  assert.equal((await send(admin.cookie, "POST", "/types", { label: "gym", kind: "training" })).status, 201);
  const taken = await send(admin.cookie, "POST", `/types/${a.body.type.id}/restore`, { expectedRevision: 2 });
  assert.deepEqual([taken.status, taken.body.error], [409, "label_taken"]);
  // An archived place: no new event and no new team default take it; one
  // that has it keeps it.
  const place = await send(admin.cookie, "POST", "/locations", { name: "Old hall" });
  const ev = await clubEvent(admin, clubId);
  await rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, revision = revision + 1 where id = $1`, [ev.id, place.body.location.id]));
  assert.equal((await send(admin.cookie, "PUT", `/teams/${teamId}`, { expectedRevision: 0, defaultLocationId: place.body.location.id })).status, 200);
  assert.equal((await send(admin.cookie, "POST", `/locations/${place.body.location.id}/archive`, { expectedRevision: 1 })).status, 200);
  const ev2 = await clubEvent(admin, clubId);
  await assert.rejects(rawEventWrite(client, { eventId: ev2.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, revision = revision + 1 where id = $1`, [ev2.id, place.body.location.id])),
    (e) => e.constraint === "events_location_usable");
  await rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set title = 'Still there', revision = revision + 1 where id = $1`, [ev.id]));
  assert.equal((await q(`select location_id from calendar.events where id = $1`, [ev.id]))[0].location_id, place.body.location.id);
  const otherTeam = await env.fx.makeTeam(clubId, "archive team 2");
  assert.equal((await send(admin.cookie, "PUT", `/teams/${otherTeam}`, { expectedRevision: 0, defaultLocationId: place.body.location.id })).body.error, "location_not_available");
  assert.deepEqual((await typesOf(admin.cookie)).body.teamDefaults, {}, "an archived default no longer applies");
});

test("3e. nothing of the catalog is deleted or truncated; a club keeps one live type; a club's hard delete still takes its unused seed", async () => {
  const { clubId, admin } = await freshClub("delete");
  const cat = await catalog(admin.cookie);
  const place = await send(admin.cookie, "POST", "/locations", { name: "Hall" });
  await send(admin.cookie, "PUT", `/teams/${(await q(`select id from public.teams where club_id = $1`, [clubId]))[0].id}`, { expectedRevision: 0, colorKey: "olive" });
  const refusals = [
    [`delete from calendar.event_types where id = $1`, [cat.types[0].id]],
    [`delete from calendar.event_fields where id = $1`, [cat.fields[0].id]],
    [`delete from calendar.event_field_options where field_id = $1`, [byKey(cat.fields, "weather").id]],
    [`delete from calendar.locations where id = $1`, [place.body.location.id]],
    [`delete from calendar.team_settings where team_id in (select id from public.teams where club_id = $1)`, [clubId]],
  ];
  for (const [sql, params] of refusals) await assert.rejects(q(sql, params), (e) => e.code === "23514", sql);
  for (const table of ["event_fields", "event_field_options", "event_type_fields", "event_selected_fields", "event_field_values", "locations", "team_settings", "settings_requests", "settings_changes"]) {
    await assert.rejects(q(`truncate calendar.${table} cascade`), (e) => e.code === "23514", table);
  }
  for (const type of cat.types.slice(1)) assert.equal((await send(admin.cookie, "POST", `/types/${type.id}/archive`, { expectedRevision: 1 })).status, 200);
  const last = await send(admin.cookie, "POST", `/types/${cat.types[0].id}/archive`, { expectedRevision: 1 });
  assert.deepEqual([last.status, last.body.error], [409, "last_type"]);
  // The database refuses it too, whoever writes.
  const client = await rawClient();
  await assert.rejects(rawSettingsWrite(client, { clubId, userId: admin.id, kind: "type", subjectId: cat.types[0].id, operation: "type_archive" },
    (c) => c.query(`update calendar.event_types set archived_at = now(), archived_by_user_id = $2, revision = revision + 1 where id = $1`, [cat.types[0].id, admin.id])),
  (e) => e.constraint === "event_types_last_live");
  // A club with no event and no settings write goes with its seed.
  const bare = await env.fx.makeClub("bare");
  await q(`delete from public.clubs where id = $1`, [bare]);
  assert.equal((await q(`select count(*)::int as n from calendar.event_fields where owner_club_id = $1`, [bare]))[0].n, 0);
  // One with a settings write is kept by its audit.
  await assert.rejects(q(`delete from public.clubs where id = $1`, [clubId]), (e) => e.code === "23503");
});

test("3f. the audit pairing: a catalog write without its change row cannot commit; a seed-shaped insert needs none, a seeded row's update does; an option needs its detail written", async () => {
  const { clubId, admin } = await freshClub("pairing");
  const cat = await catalog(admin.cookie);
  const client = await rawClient();
  const bare = async (fn) => {
    await client.query("begin");
    try {
      await fn(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  };
  await assert.rejects(bare((c) => c.query(`update calendar.event_types set label = 'Unaudited', revision = revision + 1 where id = $1`, [cat.types[0].id])), (e) => /change row/.test(e.message));
  await assert.rejects(bare((c) => c.query(`update calendar.event_types set label = 'No bump' where id = $1`, [cat.types[0].id])), (e) => /exactly one/.test(e.message));
  await assert.rejects(bare((c) => c.query(`insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, created_by_user_id) values ('club', $1, 'training', 'raw_made', 'Raw made', $2)`, [clubId, admin.id])), (e) => /change row/.test(e.message));
  await bare((c) => c.query(`insert into calendar.event_types (owner_scope, owner_club_id, kind, key, label, seed_key) values ('club', $1, 'camp', 'seed_shaped', 'Seed shaped', 'seed_shaped')`, [clubId]));
  await assert.rejects(bare((c) => c.query(`insert into calendar.locations (owner_club_id, name, created_by_user_id) values ($1, 'Raw place', $2)`, [clubId, admin.id])), (e) => /change row/.test(e.message));
  // An option of a club-made detail (a copy still exactly as seeded is the
  // seed's known exception, recorded in the runbook).
  const made = await send(admin.cookie, "POST", "/fields", { label: "Made here", valueKind: "choice", options: ["One", "Two"] });
  await assert.rejects(bare((c) => c.query(`update calendar.event_field_options set archived_at = now() where id = $1`, [made.body.field.options[0].id])), (e) => /written with its detail/.test(e.message));
  // The pair is checked: a change of another club, or at another revision.
  const other = (await catalog(m.roles.stranger.cookie)).types[0];
  await assert.rejects(rawSettingsWrite(client, { clubId, userId: admin.id, kind: "type", subjectId: other.id, operation: "type_update" },
    (c) => c.query(`update calendar.event_types set label = 'Cross', revision = revision + 1 where id = $1`, [other.id])),
  (e) => /request's club/.test(e.message));
  // A change's details never take a nested object.
  assert.equal((await q(`select calendar.details_ok('{"a": {"b": 1}}'::jsonb) as ok`))[0].ok, false);
});

test("3g. requestKey: the same key and body replays once (one row), another body is refused, a replay re-checks the right", async () => {
  const { clubId, admin } = await freshClub("replay");
  const key = newKey();
  const body = { requestKey: key, name: "Replayed hall", address: "3 Court St" };
  const first = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
  const second = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
  assert.equal(first.status, 201, first.text);
  assert.equal(second.status, 201, second.text);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.location.id, first.body.location.id);
  assert.equal((await q(`select count(*)::int as n from calendar.locations where owner_club_id = $1`, [clubId]))[0].n, 1);
  const other = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: { ...body, name: "Another" } });
  assert.deepEqual([other.status, other.body.error], [409, "request_key_reused"]);
  // A refused request leaves its key free.
  const k2 = newKey();
  assert.equal((await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: { requestKey: k2, name: "Replayed hall" } })).body.error, "label_taken");
  assert.equal((await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: { requestKey: k2, name: "Fresh hall" } })).status, 201);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [admin.id]);
  try {
    const replay = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
    assert.equal(replay.status, 403, "the right is decided again on a replay");
  } finally {
    await q(`update public.user_club_roles set is_active = true where user_id = $1`, [admin.id]);
  }
});

test("3l. the same key and body sent for ANOTHER subject is request_key_reused, never the first subject's answer", async () => {
  const { admin } = await freshClub("subject");
  const [x, y] = (await catalog(admin.cookie)).types;
  const body = { requestKey: newKey(), expectedRevision: 1, colorKey: "coral" };
  const first = await api(`/api/calendar/settings/types/${x.id}`, { method: "PATCH", cookie: admin.cookie, body });
  assert.equal(first.status, 200, first.text);
  const second = await api(`/api/calendar/settings/types/${y.id}`, { method: "PATCH", cookie: admin.cookie, body });
  assert.deepEqual([second.status, second.body.error], [409, "request_key_reused"], second.text);
  assert.equal((await catalog(admin.cookie)).types.find((t) => t.id === y.id).colorKey, null, "y untouched");
});

test("3h. the colour keys: the database's closed list equals the server's", async () => {
  const def = (await q(`select pg_get_functiondef('calendar.color_key_ok(text)'::regprocedure) as d`))[0].d;
  const listed = [...def.matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(listed, [...CALENDAR_COLOR_KEYS]);
  for (const key of CALENDAR_COLOR_KEYS) assert.equal((await q(`select calendar.color_key_ok($1) as ok`, [key]))[0].ok, true);
  assert.equal((await q(`select calendar.color_key_ok('red') as ok`))[0].ok, false);
  const { admin } = await freshClub("colours");
  assert.equal((await send(admin.cookie, "POST", "/types", { label: "Red", kind: "training", colorKey: "red" })).body.error, "invalid_color");
  assert.equal((await send(admin.cookie, "POST", "/types", { label: "Icon", kind: "training", iconKey: "not-an-icon" })).body.error, "invalid_icon");
});

test("3i. the order of the types: every live type once; only the moved ones change; a stale list is order_changed", async () => {
  const { admin } = await freshClub("order");
  const cat = await catalog(admin.cookie);
  const ids = cat.types.map((t) => t.id);
  const moved = [ids[1], ids[0], ...ids.slice(2)];
  const res = await send(admin.cookie, "POST", "/types/order", { typeIds: moved });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.types.filter((t) => !t.archived).map((t) => t.id), moved);
  assert.deepEqual(res.body.types.filter((t) => t.revision === 2).map((t) => t.id).sort(), [ids[0], ids[1]].sort(), "only the two moved");
  assert.equal((await send(admin.cookie, "POST", "/types/order", { typeIds: moved })).body.error, "nothing_to_change");
  assert.equal((await send(admin.cookie, "POST", "/types/order", { typeIds: moved.slice(1) })).body.error, "order_changed");
});

test("3j. a new club through POST /api/organization/clubs gets the full seed in the same transaction", async () => {
  const res = await api("/api/organization/clubs", { method: "POST", cookie: m.roles.platformAdmin.cookie, body: { name: `Seeded ${uid()}` } });
  assert.ok(res.status === 200 || res.status === 201, res.text);
  const clubId = res.body.club?.id ?? res.body.id;
  const counts = (await q(
    `select (select count(*)::int from calendar.event_types where owner_club_id = $1) as types,
            (select count(*)::int from calendar.event_fields where owner_club_id = $1) as fields,
            (select count(*)::int from calendar.event_field_options o join calendar.event_fields f on f.id = o.field_id where f.owner_club_id = $1) as options,
            (select count(*)::int from calendar.event_type_fields l join calendar.event_types t on t.id = l.event_type_id where t.owner_club_id = $1) as lists`,
    [clubId],
  ))[0];
  assert.deepEqual(counts, { types: 7, fields: 10, options: 17, lists: 13 });
  assert.equal((await q(`select calendar.seed_club_event_types($1) as n`, [clubId]))[0].n, 0, "idempotent");
});

test("3k. a team moved to another club (security review M1, L1): its events never show the old club's type label, the old club never counts them, and the team's old default place reads as none", async () => {
  const a = await freshClub("moveA");
  const b = await freshClub("moveB");
  const catA = await catalog(a.admin.cookie);
  const training = byKey(catA.types, "training");
  assert.equal((await send(a.admin.cookie, "PATCH", `/types/${training.id}`, { expectedRevision: 1, label: "A secret label" })).status, 200);
  const place = await send(a.admin.cookie, "POST", "/locations", { name: "A ground" });
  assert.equal((await send(a.admin.cookie, "PUT", `/teams/${a.teamId}`, { expectedRevision: 0, colorKey: "plum", defaultLocationId: place.body.location.id })).status, 200);
  const coach = await env.fx.coachOf(a.teamId, "moveA coach");
  const created = await api("/api/calendar/events", {
    method: "POST", cookie: coach.cookie,
    body: { requestKey: newKey(), timezone: TZ, eventTypeId: training.id, title: "Team session", day: FUTURE, targets: [{ kind: "team", id: a.teamId }] },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal((await catalog(a.admin.cookie)).types.find((t) => t.id === training.id).eventCount, 1);
  await q(`update public.teams set club_id = $2 where id = $1`, [a.teamId, b.clubId]);

  const card = (await calendarOf(b.admin.cookie)).body.days.flatMap((d) => d.items).find((i) => i.kind === "event" && (i.eventId === created.body.event.id));
  assert.ok(card, "club B sees its moved team's event");
  assert.equal(card.eventTypeLabel, null, "never club A's label");
  assert.equal(card.eventTypeId, null, "nor club A's type id (D41)");
  const view = await api(`/api/calendar/events/${created.body.event.id}`, { cookie: b.admin.cookie });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.event.eventTypeLabel, null);
  assert.equal(view.body.event.eventTypeId, null);
  const calendarB = await calendarOf(b.admin.cookie);
  for (const text of [calendarB.text, view.text]) {
    assert.ok(!text.includes(training.id) && !text.includes("A secret label"), "club A's type never reaches club B");
  }
  // An edit without a type keeps the stored type (the masked id is never
  // sent back as "no type").
  const edited = await api(`/api/calendar/events/${created.body.event.id}`, {
    method: "PATCH", cookie: b.admin.cookie, body: { requestKey: newKey(), expectedRevision: view.body.event.revision, title: "Team session (B)" },
  });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.body.event.eventTypeId, null);
  assert.ok(!edited.text.includes(training.id));
  assert.equal((await q(`select event_type_id from calendar.events where id = $1`, [created.body.event.id]))[0].event_type_id, training.id, "the stored type is kept");
  const afterA = await catalog(a.admin.cookie);
  assert.equal(afterA.types.find((t) => t.id === training.id).eventCount, 0, "club A no longer counts it");
  assert.deepEqual(afterA.locations.find((l) => l.id === place.body.location.id).defaultOfTeamIds, [], "nor names the moved team");
  const teamInB = (await catalog(b.admin.cookie)).teams.find((t) => t.teamId === String(a.teamId));
  assert.deepEqual([teamInB.colorKey, teamInB.defaultLocationId, teamInB.revision], ["plum", null, 1], "club A's place reads as none");
  assert.equal((await send(a.admin.cookie, "PUT", `/teams/${a.teamId}`, { expectedRevision: 1, colorKey: "rust" })).status, 404, "club A no longer writes it");
  const written = await send(b.admin.cookie, "PUT", `/teams/${a.teamId}`, { expectedRevision: 1, colorKey: "sky" });
  assert.equal(written.status, 200, written.text);
  assert.equal((await q(`select default_location_id from calendar.team_settings where team_id = $1`, [a.teamId]))[0].default_location_id, null, "the stale default is cleared on B's write");
  const audit = (await q(`select details from calendar.settings_changes where team_id = $1 order by revision desc limit 1`, [a.teamId]))[0].details;
  assert.equal(audit.staleDefaultCleared, true, "the clearing is audited");
  assert.ok(!JSON.stringify(audit).includes(place.body.location.id), "never with club A's place id");
  assert.deepEqual((await typesOf(coach.cookie)).body.teamDefaults, {});
});

// ---------------------------------------------------------------------------
// 4. Concurrency
// ---------------------------------------------------------------------------
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  return { opened, open, arrived, reached };
}

test("4a. a value racing a detail's edit, both orders: the edit sees a value committed while it waited; a value written after the edit is judged by the new definition", async () => {
  const { clubId, admin } = await freshClub("race");
  const cat = await catalog(admin.cookie);
  const temperature = byKey(cat.fields, "temperature");
  const valueClient = await rawClient();
  const ev = await clubEvent(admin, clubId);
  // Order 1: the value holds the detail FOR SHARE; the edit waits, then sees it.
  await valueClient.query("begin");
  await valueClient.query(`update calendar.events set revision = revision + 1 where id = $1`, [ev.id]);
  await valueClient.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev.id, temperature.id]);
  await valueClient.query(`insert into calendar.event_field_values (event_id, field_id, number_value, updated_by_user_id) values ($1, $2, 30, $3)`, [ev.id, temperature.id, admin.id]);
  const editing = send(admin.cookie, "PATCH", `/fields/${temperature.id}`, { expectedRevision: 1, maxValue: 25 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const request = (await valueClient.query(`insert into calendar.event_requests (request_key, request_hash, operation, performed_by_user_id, event_id, result) values (gen_random_uuid(), $1, 'set_fields', $2, $3, '{}') returning id`, ["d".repeat(64), admin.id, ev.id])).rows[0].id;
  await valueClient.query(`insert into calendar.event_changes (event_id, kind, basis, performed_by_user_id, request_id, revision) values ($1, 'set_fields', 'club_admin', $2, $3, (select revision from calendar.events where id = $1))`, [ev.id, admin.id, request]);
  await valueClient.query("commit");
  const edited = await editing;
  assert.deepEqual([edited.status, edited.body.error], [409, "field_answered"], edited.text);

  // Order 2: the edit holds the detail FOR UPDATE; a value of a detail the
  // event chose BEFORE the race (so only the value's own FOR SHARE waits)
  // waits, then is judged by the new bounds.
  const travel = byKey(cat.fields, "travel_time");
  const ev2 = await clubEvent(admin, clubId);
  await rawEventWrite(valueClient, { eventId: ev2.id, userId: admin.id },
    (c) => c.query(`insert into calendar.event_selected_fields (event_id, field_id, position) values ($1, $2, 0)`, [ev2.id, travel.id]));
  const hooks = settingsService.testHooks;
  const g = gate();
  hooks.beforeCommit = async () => { g.reached(); await g.opened; };
  try {
    const narrowing = send(admin.cookie, "PATCH", `/fields/${travel.id}`, { expectedRevision: 1, maxValue: 60 });
    await g.arrived;
    const valueWrite = rawEventWrite(valueClient, { eventId: ev2.id, userId: admin.id }, async (c) => {
      await c.query(`insert into calendar.event_field_values (event_id, field_id, number_value, updated_by_user_id) values ($1, $2, 120, $3)`, [ev2.id, travel.id, admin.id]);
    });
    // The check is attached at once: the write may be refused while the test
    // still awaits the edit (an unhandled rejection otherwise).
    const valueRefused = assert.rejects(valueWrite, (e) => e.constraint === "event_field_values_bounds");
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();
    assert.equal((await narrowing).status, 200);
    await valueRefused;
  } finally {
    delete hooks.beforeCommit;
    g.open();
  }
});

test("4b. a place archived while an event sets it: the event waits and is refused; a type archived while an event is created: the create waits and is type_not_available", async () => {
  const { clubId, admin } = await freshClub("archrace");
  const client = await rawClient();
  const place = await send(admin.cookie, "POST", "/locations", { name: "Racing hall" });
  const ev = await clubEvent(admin, clubId);
  const hooks = settingsService.testHooks;
  const g = gate();
  hooks.beforeCommit = async () => { g.reached(); await g.opened; };
  try {
    const archiving = send(admin.cookie, "POST", `/locations/${place.body.location.id}/archive`, { expectedRevision: 1 });
    await g.arrived;
    const setting = rawEventWrite(client, { eventId: ev.id, userId: admin.id, bump: false }, (c) => c.query(`update calendar.events set location_id = $2, revision = revision + 1 where id = $1`, [ev.id, place.body.location.id]));
    // The check is attached at once: the write may be refused while the test
    // still awaits the archive (an unhandled rejection otherwise; the owner's
    // external review of PR #325).
    const settingRefused = assert.rejects(setting, (e) => e.constraint === "events_location_usable");
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();
    assert.equal((await archiving).status, 200);
    await settingRefused;
  } finally {
    delete hooks.beforeCommit;
    g.open();
  }
  const cat = await catalog(admin.cookie);
  const camp = byKey(cat.types, "camp");
  const g2 = gate();
  hooks.beforeCommit = async () => { g2.reached(); await g2.opened; };
  try {
    const archiving = send(admin.cookie, "POST", `/types/${camp.id}/archive`, { expectedRevision: 1 });
    await g2.arrived;
    const creating = api("/api/calendar/events", { method: "POST", cookie: admin.cookie, body: { requestKey: newKey(), timezone: TZ, eventTypeId: camp.id, title: "Camp", day: FUTURE, targets: [{ kind: "club", id: clubId }] } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    g2.open();
    assert.equal((await archiving).status, 200);
    // The create waits on the type (FOR SHARE) and then finds it archived:
    // the stated 400, never a 500.
    const created = await creating;
    assert.deepEqual([created.status, created.body.error], [400, "type_not_available"], created.text);
  } finally {
    delete hooks.beforeCommit;
    g2.open();
  }
});

test("4c. two first PUT /teams at once: one wins, the other is team_changed; two edits of one type: the stale one is type_changed with the current", async () => {
  const { teamId, admin } = await freshClub("teamrace");
  const hooks = settingsService.testHooks;
  const g = gate();
  let first = true;
  hooks.beforeCommit = async () => {
    if (!first) return;
    first = false;
    g.reached();
    await g.opened;
  };
  try {
    const a = send(admin.cookie, "PUT", `/teams/${teamId}`, { expectedRevision: 0, colorKey: "teal" });
    await g.arrived;
    const b = send(admin.cookie, "PUT", `/teams/${teamId}`, { expectedRevision: 0, colorKey: "rust" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200, ra.text);
    assert.deepEqual([rb.status, rb.body.error], [409, "team_changed"], rb.text);
  } finally {
    delete hooks.beforeCommit;
    g.open();
  }
  const cat = await catalog(admin.cookie);
  const t = cat.types[2];
  assert.equal((await send(admin.cookie, "PATCH", `/types/${t.id}`, { expectedRevision: 1, colorKey: "plum" })).status, 200);
  const stale = await send(admin.cookie, "PATCH", `/types/${t.id}`, { expectedRevision: 1, colorKey: "amber" });
  assert.deepEqual([stale.status, stale.body.error, stale.body.current.colorKey], [409, "type_changed", "plum"]);
});

test("4d. the bounded COMMIT of the shared runner: a lost answer after a real COMMIT is verified; after a rollback it is outcome_unknown and the key stays free", async () => {
  const { clubId, admin } = await freshClub("commit");
  const hooks = settingsService.testHooks;
  const body = { requestKey: newKey(), name: "Lost answer hall" };
  let lostBody;
  try {
    hooks.commit = async (client) => {
      await client.query("commit");
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    };
    const verified = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
    assert.equal(verified.status, 201, verified.text);
    assert.equal(verified.body.verifiedAfterCommitError, true);
    assert.equal(verified.body.location.name, "Lost answer hall");
    hooks.commit = async (client) => {
      await client.query("rollback");
      const error = new Error("connection terminated");
      error.code = "ECONNRESET";
      throw error;
    };
    lostBody = { requestKey: newKey(), name: "Never saved hall" };
    const lost = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: lostBody });
    assert.deepEqual([lost.status, lost.body.error], [503, "outcome_unknown"]);
  } finally {
    delete hooks.commit;
  }
  assert.equal((await q(`select count(*)::int as n from calendar.locations where owner_club_id = $1 and name = 'Never saved hall'`, [clubId]))[0].n, 0);
  // The lost request's key is free: the same body with the same key now
  // writes, as a first request (never request_key_reused, never a replay).
  const again = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: lostBody });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.replayed, undefined);
  // A saved request whose view cannot be read now: 503 outcome_unknown (Check
  // result repeats the key), never "nothing was saved".
  try {
    hooks.answerFault = () => { throw new Error("read failed"); };
    const unreadable = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: lostBody });
    assert.deepEqual([unreadable.status, unreadable.body.error], [503, "outcome_unknown"], unreadable.text);
  } finally {
    delete hooks.answerFault;
  }
  const replayed = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body: lostBody });
  assert.deepEqual([replayed.status, replayed.body.replayed], [201, true]);
});

test("4g. a replay of a saved request whose closing ROLLBACK is lost answers the saved outcome (replayed), never 500 — settings and events", async () => {
  const { clubId, admin } = await freshClub("rollback");
  const failRollbackOnce = async ({ client }) => {
    const original = client.query;
    client.query = function (...args) {
      if (args[0] === "rollback") {
        client.query = original;
        return Promise.reject(new Error("Connection terminated unexpectedly"));
      }
      return original.apply(this, args);
    };
  };
  const body = { requestKey: newKey(), name: "Rollback hall" };
  assert.equal((await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body })).status, 201);
  settingsService.testHooks.beforeLocks = failRollbackOnce;
  let settingsReplay;
  try {
    settingsReplay = await api("/api/calendar/settings/locations", { method: "POST", cookie: admin.cookie, body });
  } finally {
    delete settingsService.testHooks.beforeLocks;
  }
  assert.deepEqual([settingsReplay.status, settingsReplay.body.replayed], [201, true], settingsReplay.text);
  const types = (await typesOf(admin.cookie)).body.types;
  const eventBody = { requestKey: newKey(), timezone: TZ, eventTypeId: types[0].id, title: "Rollback event", day: FUTURE, targets: [{ kind: "club", id: clubId }] };
  assert.equal((await api("/api/calendar/events", { method: "POST", cookie: admin.cookie, body: eventBody })).status, 201);
  eventService.testHooks.beforeLocks = failRollbackOnce;
  let eventReplay;
  try {
    eventReplay = await api("/api/calendar/events", { method: "POST", cookie: admin.cookie, body: eventBody });
  } finally {
    delete eventService.testHooks.beforeLocks;
  }
  assert.deepEqual([eventReplay.status, eventReplay.body.replayed], [201, true], eventReplay.text);
  assert.equal((await q(`select count(*)::int as n from calendar.event_requests where request_key = $1`, [eventBody.requestKey]))[0].n, 1);
  // The pool is whole afterwards.
  assert.equal((await settingsOf(admin.cookie)).status, 200);
});

test("4e. the same key twice at once (a double submit while the first is before its COMMIT): one write, the second replays it — a create, and a team's first row", async () => {
  const { clubId, teamId, admin } = await freshClub("twice");
  const hooks = settingsService.testHooks;
  const twice = async (method, p, body) => {
    const g = gate();
    let first = true;
    hooks.beforeCommit = async () => {
      if (!first) return;
      first = false;
      g.reached();
      await g.opened;
    };
    try {
      const a = api(`/api/calendar/settings${p}`, { method, cookie: admin.cookie, body });
      await g.arrived;
      const b = api(`/api/calendar/settings${p}`, { method, cookie: admin.cookie, body });
      await new Promise((resolve) => setTimeout(resolve, 300));
      g.open();
      return await Promise.all([a, b]);
    } finally {
      delete hooks.beforeCommit;
      g.open();
    }
  };
  const placeBody = { requestKey: newKey(), name: "Twice hall" };
  const [pa, pb] = await twice("POST", "/locations", placeBody);
  assert.equal(pa.status, 201, pa.text);
  assert.equal(pb.status, 201, pb.text);
  assert.equal(pb.body.replayed, true);
  assert.equal(pb.body.location.id, pa.body.location.id);
  assert.equal((await q(`select count(*)::int as n from calendar.locations where owner_club_id = $1 and name = 'Twice hall'`, [clubId]))[0].n, 1);
  assert.equal((await q(`select count(*)::int as n from calendar.settings_requests where request_key = $1`, [placeBody.requestKey]))[0].n, 1);
  const teamBody = { requestKey: newKey(), expectedRevision: 0, colorKey: "teal" };
  const [ta, tb] = await twice("PUT", `/teams/${teamId}`, teamBody);
  assert.equal(ta.status, 200, ta.text);
  assert.equal(tb.status, 200, tb.text);
  assert.equal(tb.body.replayed, true);
  assert.equal(tb.body.team.revision, 1);
});

test("4f. two archives of a club's last two live types at once: one passes, the other is last_type (the advisory lock of the guard)", async () => {
  const { admin } = await freshClub("lastrace");
  const cat = await catalog(admin.cookie);
  for (const type of cat.types.slice(2)) assert.equal((await send(admin.cookie, "POST", `/types/${type.id}/archive`, { expectedRevision: 1 })).status, 200);
  const [x, y] = cat.types.slice(0, 2);
  const hooks = settingsService.testHooks;
  const g = gate();
  let first = true;
  hooks.beforeCommit = async () => {
    if (!first) return;
    first = false;
    g.reached();
    await g.opened;
  };
  try {
    const a = send(admin.cookie, "POST", `/types/${x.id}/archive`, { expectedRevision: 1 });
    await g.arrived;
    const b = send(admin.cookie, "POST", `/types/${y.id}/archive`, { expectedRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200, ra.text);
    assert.deepEqual([rb.status, rb.body.error], [409, "last_type"], rb.text);
  } finally {
    delete hooks.beforeCommit;
    g.open();
  }
  assert.equal((await catalog(admin.cookie)).types.filter((t) => !t.archived).length, 1);
});
