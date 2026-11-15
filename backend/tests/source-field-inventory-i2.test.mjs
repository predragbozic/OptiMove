// I2 (docs/ai/gpexe-field-inventory-plan.md, section 7.2): GET /api/training-load/sources/metrics/field-inventory on
// disposable databases, through the real route. The audiences (Q2, P2), the identical 404, `covered` (section 7.1, a
// literal prefix for the zone family), team thresholds (P1), the unit word (P3), paging, one statement, and no id in any
// answer. Observation rows are planted as a replica would write them (I1's writer is proven in gpexe-in-app-import).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";

let db, admin, server, apiBase, createSession, appPool;
const responses = [];
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "fi2" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

async function api(path, { cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  responses.push(text);
  let body = {};
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}
async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

async function connection({ clubId = null, teamId = null, by }) {
  return (await one(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state)
     values ('gpexe', $1, $2, $3, 'server3', $4, 'exchanged_token', $5, 'not_connected') returning id`,
    [clubId ? "club" : "team", clubId, teamId, `Label ${uid()}`, by])).id;
}
// Observation rows as a replica writes them (no trigger, no foreign key); a check id that exists nowhere.
async function observe(connectionId, rows) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    for (const [endpoint, name, { kind = "number", unit = null, answers = 1, at = "2026-11-10T10:00:00Z" } = {}] of rows) {
      const check = crypto.randomUUID();
      await c.query(
        `insert into training_load.source_field_observations (source_connection_id, api_family, endpoint, field_name, value_kind, unit_word, answers_seen, first_seen_check_id, last_seen_check_id, first_seen_at, last_seen_at)
         values ($1,'rest_v1',$2,$3,$4,$5,$6,$7,$7,$8,$8)`, [connectionId, endpoint, name, kind, unit, answers, check, at]);
    }
  } finally {
    await c.end();
  }
}

async function world() {
  const pa = await user("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [pa]);
  await workspace(pa, "platform", null);
  W.pa = { id: pa, cookie: await cookieFor(pa) };
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.teamA = await team(W.clubA);
  W.teamB = await team(W.clubB);
  const ca = await user("club-admin-a");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true),($1,$3,'club_admin',true)`, [ca, W.clubA, W.clubB]);
  await workspace(ca, "club", W.clubA);
  W.ca = { id: ca, cookie: await cookieFor(ca) };
  // The same admin of both clubs, in club B's workspace: club B's names only.
  const caB = await user("club-admin-ab");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true),($1,$3,'club_admin',true)`, [caB, W.clubA, W.clubB]);
  await workspace(caB, "club", W.clubB);
  W.caB = { id: caB, cookie: await cookieFor(caB) };
  const coach = await user("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'coach',true)`, [coach, W.teamA]);
  await workspace(coach, "team", W.teamA);
  W.coach = { id: coach, cookie: await cookieFor(coach) };

  W.connA = await connection({ clubId: W.clubA, by: pa });
  W.connTeamA = await connection({ teamId: W.teamA, by: pa });
  W.connB = await connection({ clubId: W.clubB, by: pa });
  W.connTeamB = await connection({ teamId: W.teamB, by: pa });
  W.ids = [W.connA, W.connTeamA, W.connB, W.connTeamB];
  await observe(W.connA, [
    ["athlete_session", "total_distance", { unit: null, answers: 10 }], // covered by the seed
    ["athlete_session", "a_b", { answers: 2 }],
    ["details.session", "tot_burst_events", { kind: "unit_value_object", unit: "number" }], // covered (details.players.)
    ["details.session", "metabolic_power", { kind: "unit_value_object", unit: "W/kg" }],
    ["details.drill", "speed_known", { kind: "unit_value_object", unit: "m/s", at: "2026-11-12T10:00:00Z" }],
    ["more.complementary_data", "power", { kind: "zone_list" }], // covered (more.complementary_data.power.distance)
    ["more.complementary_data", "a_b", { kind: "zone_list" }],
    ["more.events", "acceleration_events_count"], // covered
    ["team_thresholds", "max_speed", { unit: "m/s" }],
  ]);
  await observe(W.connTeamA, [["athlete_session", "team_a_only", { answers: 3 }], ["athlete_session", "a_b", { answers: 5, at: "2026-11-14T08:00:00Z" }]]);
  await observe(W.connB, [["athlete_session", "club_b_only"], ["details.session", "custom_secret_unit", { kind: "unit_value_object", unit: "xyzzy" }]]);
  await observe(W.connTeamB, [["athlete_session", "foreign_team_b_only"]]);
  // A T2a key whose underscore position another name would match under LIKE: `axb` is covered only by its own key.
  await q(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id)
           values ('gpexe','rest_v1','more.complementary_data.axb.distance','Synthetic zone', $1)`, [pa]).catch(async () => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    await c.query("set session_replication_role = replica");
    await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1','more.complementary_data.axb.distance','Synthetic zone', $1)`, [pa]);
    await c.end();
  });
}

const names = (r) => r.body.fields.map((f) => `${f.endpoint}:${f.name}`);

test("1. a platform admin in the platform workspace: every connection's names that no source field covers, with the connection count; covered names and team thresholds left out", async () => {
  const r = await api("/field-inventory", { cookie: W.pa.cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(names(r), [
    "athlete_session:a_b", "athlete_session:club_b_only", "athlete_session:foreign_team_b_only", "athlete_session:team_a_only",
    "details.drill:speed_known", "details.session:custom_secret_unit", "details.session:metabolic_power", "more.complementary_data:a_b",
  ]);
  const ab = r.body.fields.find((f) => f.endpoint === "athlete_session" && f.name === "a_b");
  assert.deepEqual(ab, { endpoint: "athlete_session", name: "a_b", kind: "number", unitWord: null, answersSeen: 7, lastSeenOn: "2026-11-14", covered: false, connectionCount: 2 });
  assert.equal(r.body.fields.find((f) => f.name === "custom_secret_unit").unitWord, "xyzzy", "a platform admin sees the word as recorded");
  assert.equal(r.body.nextCursor, null);
  const all = await api("/field-inventory?state=all", { cookie: W.pa.cookie });
  assert.ok(names(all).includes("athlete_session:total_distance") && names(all).includes("more.complementary_data:power"), "state=all shows the covered too");
  assert.ok(!names(all).some((n) => n.startsWith("team_thresholds")), "thresholds are never a field");
  const covered = await api("/field-inventory?state=covered", { cookie: W.pa.cookie });
  assert.deepEqual(names(covered), ["athlete_session:total_distance", "details.session:tot_burst_events", "more.complementary_data:power", "more.events:acceleration_events_count"]);
});

test("2. covered matches the key literally: `a_b` in the zone family is not covered by the key `axb`, and `power` is covered by `power.distance` only through its own prefix", async () => {
  const r = await api("/field-inventory?endpoint=more.complementary_data&state=all", { cookie: W.pa.cookie });
  const by = Object.fromEntries(r.body.fields.map((f) => [f.name, f.covered]));
  assert.deepEqual(by, { a_b: false, power: true });
});

test("3. P1: team thresholds reach the platform admin only, with endpoint=team_thresholds; a club scope gets an empty list there", async () => {
  const p = await api("/field-inventory?endpoint=team_thresholds", { cookie: W.pa.cookie });
  assert.deepEqual(p.body.fields.map((f) => [f.name, f.covered]), [["max_speed", null]]);
  const c = await api("/field-inventory?endpoint=team_thresholds", { cookie: W.ca.cookie });
  assert.deepEqual([c.status, c.body], [200, { fields: [], nextCursor: null }]);
});

test("4. Q2 / P2: a club admin in their own club's workspace sees the club's connection and their own team's - never another club's, nor another club's team; no connection count", async () => {
  const r = await api("/field-inventory", { cookie: W.ca.cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(names(r), ["athlete_session:a_b", "athlete_session:team_a_only", "details.drill:speed_known", "details.session:metabolic_power", "more.complementary_data:a_b"]);
  assert.ok(r.body.fields.every((f) => !("connectionCount" in f)));
  const b = await api("/field-inventory", { cookie: W.caB.cookie });
  assert.deepEqual(names(b), ["athlete_session:club_b_only", "athlete_session:foreign_team_b_only", "details.session:custom_secret_unit"], "club B's workspace: club B's names only");
});

test("5. P3: a club scope sees a unit word only when it is a known unit (an active conversion's token); a platform admin sees every word", async () => {
  const a = await api("/field-inventory", { cookie: W.ca.cookie });
  const unit = (r, name) => r.body.fields.find((f) => f.name === name).unitWord;
  assert.equal(unit(a, "speed_known"), "m/s", "m/s is a seeded conversion's unit");
  assert.equal(unit(a, "metabolic_power"), null, "W/kg has no active conversion");
  const b = await api("/field-inventory", { cookie: W.caB.cookie });
  assert.equal(unit(b, "custom_secret_unit"), null, "an unknown word is not shown to a club");
});

test("6. the identical 404: a coach, a team workspace, an archived club's workspace, no session - byte for byte the answer of a missing route", async () => {
  const missing = await api("/no-such-route", { cookie: W.pa.cookie });
  const archivedClub = await club("Archived");
  const ac = await user("archived-admin");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [ac, archivedClub]);
  await workspace(ac, "club", archivedClub);
  const acCookie = await cookieFor(ac);
  await q(`update public.clubs set is_active = false where id = $1`, [archivedClub]);
  for (const [who, cookie] of [["coach", W.coach.cookie], ["archived club's admin", acCookie]]) {
    const r = await api("/field-inventory", { cookie });
    assert.deepEqual([r.status, r.text], [missing.status, missing.text], who);
  }
  assert.equal((await api("/field-inventory")).status, 401);
});

test("7. paging: 200 a page in (endpoint, name) order with an opaque cursor bound to the scope, the state and the filter; a tampered cursor or query is 400", async () => {
  const conn = await connection({ clubId: W.clubA, by: W.pa.id });
  await observe(conn, Array.from({ length: 230 }, (_, i) => ["details.drill", `page_${String(i).padStart(3, "0")}`]));
  const first = await api("/field-inventory?endpoint=details.drill", { cookie: W.ca.cookie });
  assert.equal(first.body.fields.length, 200);
  assert.ok(first.body.nextCursor);
  const second = await api(`/field-inventory?endpoint=details.drill&cursor=${first.body.nextCursor}`, { cookie: W.ca.cookie });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.fields.length, 231 - 200, "the rest, speed_known included");
  assert.equal(second.body.nextCursor, null);
  const seen = [...names(first), ...names(second)];
  assert.deepEqual(seen, [...seen].sort(), "ordered");
  assert.equal(new Set(seen).size, 231, "no row twice");
  for (const [label, path, cookie] of [
    ["another state", `/field-inventory?endpoint=details.drill&state=all&cursor=${first.body.nextCursor}`, W.ca.cookie],
    ["another filter", `/field-inventory?cursor=${first.body.nextCursor}`, W.ca.cookie],
    ["another scope", `/field-inventory?endpoint=details.drill&cursor=${first.body.nextCursor}`, W.caB.cookie],
    ["not base64", "/field-inventory?cursor=***", W.ca.cookie],
    ["a forged name", `/field-inventory?endpoint=details.drill&cursor=${Buffer.from(JSON.stringify({ v: 1, s: `${W.clubA}|not_supported`, f: "details.drill", e: "details.drill", n: "x' or 1=1" })).toString("base64url")}`, W.ca.cookie],
    ["a bad state", "/field-inventory?state=everything", W.ca.cookie],
    ["a bad endpoint", "/field-inventory?endpoint=players", W.ca.cookie],
    ["an extra parameter", "/field-inventory?clubId=x", W.ca.cookie],
    ["a repeated parameter", "/field-inventory?state=all&state=covered", W.ca.cookie],
  ]) {
    const r = await api(path, { cookie });
    assert.deepEqual([r.status, r.body.error], [400, "invalid_query"], label);
  }
});

test("8. one SQL statement per request, in a bounded read, and no connection id, check id, label, club or team in any answer of this file", async () => {
  const { pool } = await import("../src/db.js");
  const originalConnect = pool.connect.bind(pool);
  const seen = [];
  pool.connect = async (...args) => {
    const client = await originalConnect(...args);
    if (client && !client.__counted) {
      const originalQuery = client.query.bind(client);
      client.query = (...q) => { seen.push(String(q[0])); return originalQuery(...q); };
      client.__counted = true;
    }
    return client;
  };
  try {
    await api("/field-inventory?state=all", { cookie: W.pa.cookie });
  } finally {
    pool.connect = originalConnect;
  }
  assert.equal(seen.filter((sql) => sql.includes("source_field_observations")).length, 1, "one statement");
  assert.ok(seen.some((sql) => /repeatable read read only/.test(sql)), "inside a read-only transaction");
  assert.ok(seen.some((sql) => /statement_timeout/.test(sql)), "with a statement bound");
  const ids = [...W.ids, W.clubA, W.clubB, W.teamA, W.teamB];
  const checks = (await q(`select distinct first_seen_check_id::text c from training_load.source_field_observations`)).map((r) => r.c);
  const labels = (await q(`select account_label l from training_load.source_credential_connections`)).map((r) => r.l);
  for (const text of responses) {
    for (const s of [...ids, ...checks, ...labels]) assert.ok(!text.includes(s), `no ${s} in an answer`);
  }
});

test("2b. a retired source field no longer covers its name", async () => {
  const clubC = await club("Club C");
  const conn = await connection({ clubId: clubC, by: W.pa.id });
  await observe(conn, [["athlete_session", "retired_field"], ["athlete_session", "active_field"]]);
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    for (const [name, state] of [["retired_field", "retired"], ["active_field", "active"]]) {
      await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id, state, retired_by_user_id, retired_at, retired_reason)
                     values ('gpexe','rest_v1',$1,'Synthetic',$2,$3,$4,$5,$6)`,
        [`athlete_session.${name}`, W.pa.id, state, state === "retired" ? W.pa.id : null, state === "retired" ? new Date() : null, state === "retired" ? "test" : null]);
    }
  } finally {
    await c.end();
  }
  const r = await api("/field-inventory?endpoint=athlete_session&state=all", { cookie: W.pa.cookie });
  const by = Object.fromEntries(r.body.fields.map((f) => [f.name, f.covered]));
  assert.deepEqual([by.retired_field, by.active_field], [false, true]);
});

test("7b. the order is the \"C\" collation's, the same in every database: a capital letter before a small one", async () => {
  const clubD = await club("Club D");
  const conn = await connection({ clubId: clubD, by: W.pa.id });
  await observe(conn, [["more.events", "alpha_count"], ["more.events", "Zeta_count"]]);
  const r = await api("/field-inventory?endpoint=more.events", { cookie: W.pa.cookie });
  const order = names(r).filter((n) => /alpha_count|Zeta_count/.test(n));
  assert.deepEqual(order, ["more.events:Zeta_count", "more.events:alpha_count"]);
});

test("9. the read is bounded: a statement past its bound answers 409 try_again, never a hang or a 500", async () => {
  const mapping = await import("../src/sourceMetricMappingService.js");
  mapping.setMappingReadBoundsForTests({ statementTimeoutMs: 50 });
  mapping.setMappingReadFaultForTests((client) => client.query("select pg_sleep(0.3)"));
  try {
    const r = await api("/field-inventory", { cookie: W.pa.cookie });
    assert.deepEqual([r.status, r.body.error], [409, "try_again"], r.text);
  } finally {
    mapping.setMappingReadFaultForTests(null);
    mapping.setMappingReadBoundsForTests();
  }
  assert.equal((await api("/field-inventory", { cookie: W.pa.cookie })).status, 200);
});

test("10. a platform admin in club A's workspace is a club scope: club A's names only, a club's unit words, no connection count", async () => {
  const id = await user("platform-admin-in-club");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, W.clubA]);
  await workspace(id, "club", W.clubA);
  const cookie = await cookieFor(id);
  for (const endpoint of ["athlete_session", "details.session", "details.drill", "more.complementary_data"]) {
    const r = await api(`/field-inventory?endpoint=${endpoint}&state=all`, { cookie });
    assert.equal(r.status, 200, r.text);
    const own = await api(`/field-inventory?endpoint=${endpoint}&state=all`, { cookie: W.ca.cookie });
    assert.deepEqual(names(r), names(own), `${endpoint}: the same names as club A's own admin`);
    assert.ok(!names(r).some((n) => /club_b_only|foreign_team_b_only|custom_secret_unit/.test(n)));
    assert.ok(r.body.fields.every((f) => !("connectionCount" in f)), "no connection count");
  }
  const session = await api("/field-inventory?endpoint=details.session", { cookie });
  assert.equal(session.body.fields.find((f) => f.name === "metabolic_power").unitWord, null, "a club's unit words");
});

test("11. an admin of club A only, whose workspace preference names club B, reads club A's names (the workspace falls back to their own club) - never club B's", async () => {
  const id = await user("club-a-only");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, W.clubA]);
  await workspace(id, "club", W.clubB);
  const r = await api("/field-inventory?endpoint=athlete_session&state=all", { cookie: await cookieFor(id) });
  assert.equal(r.status, 200, r.text);
  const own = await api("/field-inventory?endpoint=athlete_session&state=all", { cookie: W.ca.cookie });
  assert.deepEqual(names(r), names(own));
  assert.ok(!names(r).some((n) => /club_b_only|foreign_team_b_only/.test(n)), "never club B's names");
});
