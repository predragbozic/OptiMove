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
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach, W.teamA]);
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
    // Structural keys written before the collector skipped them: the read hides them (STRUCTURAL_FIELDS).
    ["athlete_session", "id"], ["athlete_session", "teamsession", { answers: 4 }], ["athlete_session", "start_timestamp", { kind: "text" }],
    ["team_thresholds", "validity_start", { kind: "text" }], ["team_thresholds", "team"],
  ]);
  // The same name as a measured value of another endpoint stays: the list is per endpoint (seeded on club B's connection).
  await observe(W.connTeamA, [["athlete_session", "team_a_only", { answers: 3 }], ["athlete_session", "a_b", { answers: 5, at: "2026-11-14T08:00:00Z" }]]);
  await observe(W.connB, [["athlete_session", "club_b_only"], ["details.session", "team"], ["details.session", "custom_secret_unit", { kind: "unit_value_object", unit: "xyzzy" }]]);
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
    "details.drill:speed_known", "details.session:custom_secret_unit", "details.session:metabolic_power", "details.session:team",
    "more.complementary_data:a_b",
  ]);
  const ab = r.body.fields.find((f) => f.endpoint === "athlete_session" && f.name === "a_b");
  assert.deepEqual(ab, { endpoint: "athlete_session", name: "a_b", kind: "number", unitWord: null, answersSeen: 7, lastSeenOn: "2026-11-14", covered: false, unit: null, isValue: true, zone: null, connectionCount: 2, creatable: true });
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
  assert.deepEqual(names(b), ["athlete_session:club_b_only", "athlete_session:foreign_team_b_only", "details.session:custom_secret_unit", "details.session:team"], "club B's workspace: club B's names only");
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
  // The Independent's L1: the coach is a real team coach in the team's own workspace, and stays there.
  const pref = await one(`select workspace_type, scope_id from public.user_workspace_preferences where user_id = $1`, [W.coach.id]);
  assert.deepEqual([pref.workspace_type, pref.scope_id], ["team", W.teamA], "the coach's workspace is still the team's after the request");
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

test("12. structural keys written before the collector skipped them are hidden under every state and filter, and the measured names beside them stay", async () => {
  for (const path of ["/field-inventory?state=all", "/field-inventory?state=all&endpoint=athlete_session", "/field-inventory?endpoint=team_thresholds"]) {
    const r = await api(path, { cookie: W.pa.cookie });
    assert.equal(r.status, 200, r.text);
    assert.ok(!names(r).some((n) => /:(id|teamsession|start_timestamp|validity_start|team)$/.test(n)), `${path}: ${names(r)}`);
  }
  const thr = await api("/field-inventory?endpoint=team_thresholds", { cookie: W.pa.cookie });
  assert.deepEqual(names(thr), ["team_thresholds:max_speed"]);
  const details = await api("/field-inventory?endpoint=details.session", { cookie: W.pa.cookie });
  assert.ok(names(details).includes("details.session:team"), "the list is per endpoint: a measured `team` of a players' map stays");
  const ca = await api("/field-inventory?state=all&endpoint=athlete_session", { cookie: W.ca.cookie });
  assert.ok(names(ca).includes("athlete_session:a_b") && !names(ca).some((n) => /:(id|teamsession|start_timestamp)$/.test(n)));
});

test("13. paging over an endpoint with hidden structural rows: page 1 holds 200 visible names and a cursor, the pages together hold every measured name once, in C order, and no structural key", async () => {
  // Club C's own connection, seeded last, so the earlier tests' lists are unchanged.
  const conn = await connection({ clubId: await club("Club C"), by: W.pa.id });
  const measured = Array.from({ length: 205 }, (_, i) => `m${String(i).padStart(3, "0")}`);
  await observe(conn, [...measured.map((n) => ["athlete_session", n]), ["athlete_session", "id"], ["athlete_session", "teamsession"], ["athlete_session", "track"]]);
  const first = await api("/field-inventory?state=all&endpoint=athlete_session", { cookie: W.pa.cookie });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.fields.length, 200, "a full page of visible names");
  assert.ok(first.body.nextCursor);
  const second = await api(`/field-inventory?state=all&endpoint=athlete_session&cursor=${first.body.nextCursor}`, { cookie: W.pa.cookie });
  assert.equal(second.body.nextCursor, null);
  const all = [...first.body.fields, ...second.body.fields].map((f) => f.name);
  assert.equal(new Set(all).size, all.length, "no name twice");
  assert.ok(measured.every((n) => all.includes(n)), "no measured name lost at the page edge");
  assert.ok(!all.some((n) => ["id", "teamsession", "track"].includes(n)), "no structural key");
  assert.deepEqual(all, [...all].sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : Buffer.from(a) > Buffer.from(b) ? 1 : 0)), "C order");
});

test("14. the order is the \"C\" collation's even when the column collates otherwise (the Independent's L2): names whose ICU order differs keep C order", async (t) => {
  const icu = await one(`select count(*)::int n from pg_collation where collname = 'und-x-icu'`);
  if (!icu.n) { t.skip("no ICU collation on this cluster: the order difference cannot be shown"); return; }
  const clubE = await club("Club E");
  const conn = await connection({ clubId: clubE, by: W.pa.id });
  const order = ["Zeta_count", "_b", "a_b", "ab", "alpha_count"];
  await observe(conn, order.map((name) => ["more.events", name]));
  await q(`alter table training_load.source_field_observations alter column field_name type text collate "und-x-icu"`);
  try {
    const icuOrder = (await q(`select field_name from training_load.source_field_observations where source_connection_id = $1 order by field_name`, [conn])).map((r) => r.field_name);
    assert.notDeepEqual(icuOrder, order, "the column's own order differs from C's");
    const r = await api("/field-inventory?endpoint=more.events", { cookie: W.pa.cookie });
    assert.deepEqual(r.body.fields.map((f) => f.name).filter((n) => order.includes(n)), order, "C order, byte by byte");
  } finally {
    await q(`alter table training_load.source_field_observations alter column field_name type text collate "default"`);
  }
});

test("15. G1b: a platform admin in the platform workspace reads which names route C would create (creatable) - not covered, a generic endpoint, a name route C takes, every observation a kind a check keeps; a club scope never gets the flag", async () => {
  // Planted on club B's connection only for this test, removed after it.
  const planted = [["athlete_session", "g1b_text_kind", { kind: "text" }], ["details.session", "g1b_plain_number", { kind: "number" }], ["athlete_session", "g1b_mixed", { kind: "number" }], ["athlete_session", "G1b_Upper", { kind: "number" }]];
  await observe(W.connB, planted);
  await observe(W.connTeamB, [["athlete_session", "g1b_mixed", { kind: "boolean" }]]);
  try {
    // One read per endpoint (test 7 planted more athlete-row names than one page holds).
    const rows = [];
    for (const endpoint of ["athlete_session", "details.session", "details.drill", "more.events", "more.complementary_data"]) {
      let cursor = null;
      do {
        const r = await api(`/field-inventory?state=all&endpoint=${endpoint}${cursor ? `&cursor=${cursor}` : ""}`, { cookie: W.pa.cookie });
        assert.equal(r.status, 200, r.text);
        rows.push(...r.body.fields);
        cursor = r.body.nextCursor;
      } while (cursor);
    }
    const r = { body: { fields: rows } };
    const flag = Object.fromEntries(r.body.fields.map((f) => [`${f.endpoint}:${f.name}`, f.creatable]));
    assert.deepEqual({
      ab: flag["athlete_session:a_b"], drill: flag["details.drill:speed_known"], session: flag["details.session:metabolic_power"],
      covered: flag["athlete_session:total_distance"], zones: flag["more.complementary_data:a_b"], events: flag["more.events:acceleration_events_count"],
      text: flag["athlete_session:g1b_text_kind"], plainNumberInDetails: flag["details.session:g1b_plain_number"], mixed: flag["athlete_session:g1b_mixed"],
      // A number route C still refuses: a capital letter cannot be in a key (decision (e)).
      upper: flag["athlete_session:G1b_Upper"],
    }, { ab: true, drill: true, session: true, covered: false, zones: false, events: false, text: false, plainNumberInDetails: false, mixed: false, upper: false });
    assert.ok(r.body.fields.every((f) => typeof f.creatable === "boolean"), "every row says it, for the platform admin");
    // A key route C would refuse as field_exists: a retired T2a row of the same key (plan 8.1, any state).
    {
      const c = new pg.Client({ connectionString: db.url });
      await c.connect();
      try {
        await c.query("set session_replication_role = replica");
        await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id, state, retired_by_user_id, retired_at, retired_reason)
                       values ('gpexe','rest_v1','athlete_session.g1b_retired_key','Retired', $1, 'retired', $1, now(), 'G1b test')`, [W.pa.id]);
      } finally {
        await c.end();
      }
    }
    await observe(W.connB, [["athlete_session", "g1b_retired_key", { kind: "number" }]]);
    const retired = await api("/field-inventory?endpoint=athlete_session&state=all", { cookie: W.pa.cookie });
    let page = retired.body;
    let found = page.fields.find((f) => f.name === "g1b_retired_key");
    while (!found && page.nextCursor) {
      page = (await api(`/field-inventory?endpoint=athlete_session&state=all&cursor=${page.nextCursor}`, { cookie: W.pa.cookie })).body;
      found = page.fields.find((f) => f.name === "g1b_retired_key");
    }
    assert.deepEqual([found?.covered, found?.creatable], [false, false], "a retired key is not covered, and route C would refuse it");
    // A platform admin in a club's workspace is a club scope: no flag either.
    const paClub = await user("platform-admin-in-club-g1b");
    await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [paClub]);
    await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [paClub, W.clubA]);
    await workspace(paClub, "club", W.clubA);
    for (const cookie of [W.ca.cookie, W.caB.cookie, await cookieFor(paClub)]) {
      const club = await api("/field-inventory?state=all", { cookie });
      assert.equal(club.status, 200, club.text);
      assert.ok(club.body.fields.length > 0 && club.body.fields.every((f) => !("creatable" in f)), "a club scope never gets the flag");
    }
  } finally {
    // Observations are append-only (I1): removed past the guard, as the world wrote them.
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query("set session_replication_role = replica");
      await c.query(`delete from training_load.source_field_observations where field_name in ('g1b_text_kind', 'g1b_plain_number', 'g1b_mixed', 'G1b_Upper', 'g1b_retired_key')`);
    } finally {
      await c.end();
    }
  }
});

test("R (the owner's first use, 2026-11-18): each row carries the unit its word stands for (v74's seed, to every audience), whether it is a value (a field, or one route C would create), and a zone name's own facts; names that are a reference, a group, a flag or a time are never values and never creatable; the platform gets the zone thresholds, a club never", async () => {
  const conn = await connection({ clubId: W.clubA, by: W.pa.id });
  await observe(conn, [
    ["details.session", "athletesessionpowerzone_distance_4", { kind: "unit_value_object", unit: "distance" }],
    ["details.session", "r_energy_like", { kind: "unit_value_object", unit: "furlongs" }],
    ["details.drill", "athlete", { kind: "object" }],
    ["details.drill", "athlete_session_id", { kind: "number" }],
    ["details.session", "are_values_visible", { kind: "boolean" }],
    ["details.session", "validity_start_r", { kind: "text" }],
    ["athlete_session", "r_hsr", { kind: "number" }],
    ["more.events", "r_ev_hits", { kind: "number" }],
    ["more.complementary_data", "power", { kind: "object" }],
    ["more.complementary_data", "r_cd_other", { kind: "object" }],
  ]);
  // Each endpoint on its own (an earlier test fills the first page of athlete_session names).
  const read = async (who) => {
    const out = { fields: [], zoneThresholds: undefined };
    for (const endpoint of ["details.session", "details.drill", "athlete_session", "more.events", "more.complementary_data"]) {
      let cursor = null;
      do {
        const body = (await api(`/field-inventory?state=all&endpoint=${endpoint}${cursor ? `&cursor=${cursor}` : ""}`, { cookie: who.cookie })).body;
        out.fields.push(...body.fields);
        if ("zoneThresholds" in body) out.zoneThresholds = body.zoneThresholds;
        cursor = body.nextCursor;
      } while (cursor);
    }
    return out;
  };
  const byName = (body) => Object.fromEntries(body.fields.map((f) => [f.name, f]));
  const pa = await read(W.pa);
  const rows = byName(pa);
  assert.deepEqual([rows.athletesessionpowerzone_distance_4.unit, rows.athletesessionpowerzone_distance_4.isValue, rows.athletesessionpowerzone_distance_4.zone],
    ["m", true, { family: "power", measure: "distance", number: 4 }]);
  assert.deepEqual([rows.r_energy_like.unit, rows.r_energy_like.isValue], [null, true], "a word without a seed row has no unit; the name can still become a field");
  assert.deepEqual([rows.r_hsr.unit, rows.r_hsr.isValue, rows.r_hsr.zone], [null, true, null]);
  // A value route C cannot create (the code review's MEDIUM) is still a value, never folded as "not values".
  assert.deepEqual([rows.r_ev_hits.isValue, rows.r_ev_hits.creatable], [true, false]);
  // A complementary-data family is an object of zone lists: a value, covered or not (the re-review's MEDIUM).
  assert.deepEqual([rows.power.isValue, rows.power.covered], [true, true], "an already used family is never folded as not a value");
  assert.deepEqual([rows.r_cd_other.isValue, rows.r_cd_other.covered], [true, false]);
  for (const name of ["athlete", "athlete_session_id", "are_values_visible", "validity_start_r"]) {
    assert.deepEqual([rows[name].isValue, rows[name].creatable], [false, false], name);
  }
  assert.ok(pa.zoneThresholds && "power" in pa.zoneThresholds && "speed" in pa.zoneThresholds, "the platform gets the zone thresholds");
  const club = await read(W.ca);
  assert.equal(club.zoneThresholds, undefined, "a club never gets the team thresholds (P1)");
  assert.equal(byName(club).athletesessionpowerzone_distance_4.unit, "m", "the unit is the seed's, so a club sees it");
  // Route C refuses the names that are not values.
  const { deriveField, FieldCreateRefusal } = await import("../src/sourceFieldCreate.js");
  for (const [endpoint, name] of [["details.drill", "athlete_session_id"], ["details.session", "are_values_visible"], ["details.drill", "athlete"]]) {
    assert.throws(() => deriveField({ endpoint, name, supportsSession: true, supportsDrill: true }), (e) => e instanceof FieldCreateRefusal && e.code === "name_not_observed", name);
  }
});

test("R2: the zone thresholds - one set when every bound team's newest stored session carries the same, otherwise only that they differ (zoneThresholdsOf); zoneOf reads only the name's facts", async () => {
  const { zoneThresholdsOf, zoneOf, isValueRow } = await import("../src/sourceFieldInventoryRead.js");
  // isValueRow (the re-review's MEDIUM): a covered object and a complementary family are values; a threshold or a
  // structural name never is, even when covered.
  assert.equal(isValueRow({ endpoint: "details.session", field_name: "r_obj", kind: "object", covered: true }), true);
  assert.equal(isValueRow({ endpoint: "more.complementary_data", field_name: "speed", kind: "object", covered: false }), true);
  assert.equal(isValueRow({ endpoint: "details.session", field_name: "r_obj", kind: "object", covered: false }), false);
  assert.equal(isValueRow({ endpoint: "team_thresholds", field_name: "power_thresholds", kind: "number", covered: false }), false);
  assert.equal(isValueRow({ endpoint: "details.drill", field_name: "athlete_session_id", kind: "number", covered: true }), false);
  assert.deepEqual(zoneThresholdsOf([]), { power: null, speed: null });
  assert.deepEqual(zoneThresholdsOf([{ power: [20, 25, 60, 75], speed: [5.5, 7] }, { power: [20, 25, 60, 75], speed: [5.5, 7] }]), { power: { values: [20, 25, 60, 75] }, speed: { values: [5.5, 7] } });
  assert.deepEqual(zoneThresholdsOf([{ power: [20, 25, 60, 75], speed: [5.5, 7] }, { power: [20, 25, 60, 80], speed: [5.5, 7] }]), { power: { differ: true }, speed: { values: [5.5, 7] } });
  assert.deepEqual(zoneThresholdsOf([{ power: [20, 25], speed: null }, { power: [20, 25], speed: [5.5, 7] }]), { power: { values: [20, 25] }, speed: { differ: true } }, "a team without a set is not a match");
  assert.deepEqual(zoneThresholdsOf([{ power: ["x"], speed: [] }]), { power: null, speed: null }, "only finite number lists");
  assert.deepEqual(zoneOf("athletesessionrelativespeedzone_distance_3"), { family: "relativespeed", measure: "distance", number: 3 });
  for (const name of ["ext_work_over_zone0", "athletesessionpowerzone_distance", "powerzone_distance_4", "athletesessionpowerzone_speed_4"]) assert.equal(zoneOf(name), null, name);
});

test("R3 (the code review's MEDIUM): the zone thresholds are a secondary read - when it fails, the list is answered with zoneThresholds null, never a failed list", async () => {
  const mod = await import("../src/sourceFieldInventoryRead.js");
  mod.setInventoryThresholdsFaultForTests(async () => { throw Object.assign(new Error("slow"), { code: "57014" }); });
  try {
    const r = await api("/field-inventory?endpoint=details.session", { cookie: W.pa.cookie });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.fields.length > 0);
    assert.equal(r.body.zoneThresholds, null);
  } finally {
    mod.setInventoryThresholdsFaultForTests(null);
  }
  // The read opens one stored bundle per binding: the newest session is chosen by its id first (a LIMIT 1 per binding).
  assert.match(mod.THRESHOLDS_SQL.replace(/\s+/g, " "), /cross join lateral \( select c\.id from training_load\.gpexe_import_candidates c .* limit 1\) newest join training_load\.gpexe_import_candidates t on t\.id = newest\.id/);
});
