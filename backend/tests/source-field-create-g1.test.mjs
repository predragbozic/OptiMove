// G1a (docs/ai/gpexe-field-inventory-plan.md, section 8; migration v74) on disposable databases: route C through the real
// route (8.1), and the database chain of v74 - T2a's actor guard and create link, the observed act on T2b with its T9
// field_observation, T9i field_unit and two T8 rows (8.2, 8.3), source_stated in the gates, the seed and as_sent.
// The observed act's writer (route O) is G1b; here its chain is written by SQL as that writer will.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;

let db, admin, server, apiBase, createSession, appPool, createService, mappingService;
const responses = [];
const W = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "g1" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  createService = await import("../src/sourceFieldCreateService.js");
  mappingService = await import("../src/sourceMetricMappingService.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  createService?.setFieldCreateHoldForTests(null);
  mappingService?.setMappingCommitForTests();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const uid = () => crypto.randomBytes(4).toString("hex");
const key = () => crypto.randomUUID();
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const one = async (sql, params = []) => (await q(sql, params))[0];

async function api(path, { cookie, method = "GET", body } = {}) {
  const headers = { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) };
  const res = await fetch(`${apiBase}${PREFIX}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}
async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;

// Observation rows as a replica writes them (I1's writer is proven elsewhere).
async function observe(connectionId, rows) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("set session_replication_role = replica");
    for (const [endpoint, name, { kind = "number", unit = null } = {}] of rows) {
      const check = crypto.randomUUID();
      await c.query(
        `insert into training_load.source_field_observations (source_connection_id, api_family, endpoint, field_name, value_kind, unit_word, answers_seen, first_seen_check_id, last_seen_check_id, first_seen_at, last_seen_at)
         values ($1,'rest_v1',$2,$3,$4,$5,1,$6,$6,now(),now())`, [connectionId, endpoint, name, kind, unit, check]);
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
  W.club = (await one(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`])).id;
  const ca = await user("club-admin");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [ca, W.club]);
  await workspace(ca, "club", W.club);
  W.ca = { id: ca, cookie: await cookieFor(ca) };
  // The platform admin in a club's workspace: not the platform workspace, so not route C's audience.
  const paClub = await user("platform-admin-club");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [paClub]);
  // Also the club's admin, so the club workspace is really theirs (without a club role the workspace falls back to
  // the platform one).
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [paClub, W.club]);
  await workspace(paClub, "club", W.club);
  W.paClub = { id: paClub, cookie: await cookieFor(paClub) };
  W.conn = (await one(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state)
     values ('gpexe','club',$1,'server3',$2,'exchanged_token',$3,'not_connected') returning id`, [W.club, `Label ${uid()}`, pa])).id;
  await observe(W.conn, [
    ["details.session", "metabolic_power", { kind: "unit_value_object", unit: "power" }],
    ["details.session", "odd_word", { kind: "unit_value_object", unit: "furlongs" }],
    ["details.session", "no_unit_word", { kind: "number" }],
    ["details.drill", "drill_only", { kind: "unit_value_object", unit: "number" }],
    ["athlete_session", "average_v"],
    ["athlete_session", "Zeta_count"],
    ["athlete_session", "teamsession"],
    ["more.events", "acceleration_events_peak"],
  ]);
}

const body = (over = {}) => ({ requestKey: key(), endpoint: "details.session", name: "metabolic_power", label: "Metabolic power", supportsSession: true, supportsDrill: true, ...over });
const fieldOf = (fieldId) => one(`select * from training_load.source_metric_definitions where id = $1`, [fieldId]);
const revisionsOf = (fieldId) => q(`select * from training_load.source_metric_definition_versions where source_metric_definition_id = $1 order by revision_number`, [fieldId]);
const auditOf = (fieldId) => q(`select action, request_key is not null as keyed, basis, performed_by_user_id from training_load.source_metric_audit where source_metric_definition_id = $1 order by performed_at, action`, [fieldId]);

test("1. route C: a platform admin in the platform workspace creates a generic field from an observed name - revision 1 active and unproven, the key derived, three audit rows, the keyed one the request record", async () => {
  const b = body();
  const r = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.field.key, "details.players.metabolic_power");
  assert.deepEqual([r.body.field.sourceSystem, r.body.field.apiFamily, r.body.field.label, r.body.field.state], ["gpexe", "rest_v1", "Metabolic power", "active"]);
  assert.deepEqual([r.body.revision.revisionNumber, r.body.revision.state, r.body.revision.evidenceStatus, r.body.revision.valueShape, r.body.revision.parameterKind, r.body.revision.expectedSourceUnit, r.body.revision.sourceUnit],
    [1, "active", "unproven", "unit_value_object", "none", "W/kg", null]);
  const field = await fieldOf(r.body.field.id);
  assert.equal(field.created_by_user_id, W.pa.id);
  assert.equal(field.seed_migration, null);
  const audit = await auditOf(field.id);
  assert.deepEqual(audit.map((a) => a.action).sort(), ["source_metric_create", "source_metric_revision_activate", "source_metric_revision_create"]);
  assert.deepEqual(audit.filter((a) => a.keyed).map((a) => a.action), ["source_metric_create"], "the keyed row is the request record");
  assert.ok(audit.every((a) => a.basis === "platform_admin" && a.performed_by_user_id === W.pa.id));
  // The same key and body: the same answer, nothing written twice.
  const again = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.field.id, field.id);
  assert.equal((await auditOf(field.id)).length, 3);
  // The same key, another body: request_key_reused.
  const reused = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: { ...b, label: "Other label" } });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
});

test("2. route C: a plain athlete-row number, its expected unit null (GPEXE sends no unit word); a drill-only name supports the drill; no unit word, no hypothesis", async () => {
  const row = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ endpoint: "athlete_session", name: "average_v", label: "Average speed" }) });
  assert.equal(row.status, 201, row.text);
  assert.deepEqual([row.body.field.key, row.body.revision.valueShape, row.body.revision.expectedSourceUnit], ["athlete_session.average_v", "number", null]);
  const drill = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ endpoint: "details.drill", name: "drill_only", label: "Drill only", supportsSession: false }) });
  assert.equal(drill.status, 201, drill.text);
  assert.deepEqual([drill.body.field.key, drill.body.revision.supportsSession, drill.body.revision.supportsDrill, drill.body.revision.expectedSourceUnit], ["details.players.drill_only", false, true, "count"], "the word number is a kind: the expected unit is its seeded token");
  const plain = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ name: "no_unit_word", label: "No unit word" }) });
  assert.equal(plain.status, 201, plain.text);
  assert.equal(plain.body.revision.expectedSourceUnit, null, "no unit word seen, no hypothesis (the inventory's own CHECK keeps a non-token word out)");
  const odd = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ endpoint: "details.session", name: "odd_word", label: "Odd" }) });
  assert.equal(odd.status, 201, odd.text);
  assert.equal(odd.body.revision.expectedSourceUnit, null, "a word not in source_unit_words is never guessed");
});

test("3. route C's refusals, each before anything is written: not generic, not observed, structural, not supported, taken, a bad body; nothing written by any of them", async () => {
  const before = (await one(`select count(*)::int n from training_load.source_metric_definitions`)).n;
  const cases = [
    [body({ endpoint: "more.events", name: "acceleration_events_peak" }), 409, "shape_not_generic"],
    [body({ name: "never_seen" }), 409, "name_not_observed"],
    [body({ endpoint: "athlete_session", name: "teamsession" }), 409, "name_not_observed"],
    [body({ endpoint: "athlete_session", name: "Zeta_count" }), 409, "name_not_supported"],
    [body({ name: "metabolic_power" }), 409, "field_exists"],
    [body({ label: " lead" }), 400, "invalid_body"],
    [body({ extra: 1 }), 400, "invalid_body"],
    [body({ supportsSession: false, supportsDrill: false }), 400, "invalid_body"],
  ];
  for (const [b, status, code] of cases) {
    const r = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
    assert.deepEqual([r.status, r.body.error], [status, code], `${b.endpoint}.${b.name}: ${r.text}`);
  }
  const taken = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body() });
  assert.ok(taken.body.current?.fieldId, "field_exists names the existing field");
  assert.equal((await one(`select count(*)::int n from training_load.source_metric_definitions`)).n, before);
});

test("4. route C's audience: a club admin, a platform admin in a club's workspace, a team coach and an athlete get the identical 404, before the body - a JSON object, a text/plain body or an array alike; no session is the app-wide 401", async () => {
  const missing = await api("/no-such-route-g1", { cookie: W.pa.cookie });
  // G1b (carry-overs 1 and 4): a coach of the club's team and an athlete, in their own workspaces.
  const team = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.club, `Team ${uid()}`])).id;
  const coach = await user("coach");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coach, team]);
  await workspace(coach, "team", team);
  const athleteUser = await user("athlete");
  const athlete = (await one(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [athleteUser, `Athlete ${uid()}`])).id;
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athlete, W.club, team]);
  await workspace(athleteUser, "athlete", null);
  const raw = async (cookie, contentType, text) => {
    const res = await fetch(`${apiBase}${PREFIX}/fields`, { method: "POST", headers: { Cookie: cookie, "Content-Type": contentType }, body: text });
    return { status: res.status, text: await res.text() };
  };
  const before = (await one(`select count(*)::int n from training_load.source_metric_definitions`)).n;
  for (const [who, cookie] of [["club admin", W.ca.cookie], ["platform admin in a club", W.paClub.cookie], ["coach", await cookieFor(coach)], ["athlete", await cookieFor(athleteUser)]]) {
    const r = await api("/fields", { cookie, method: "POST", body: body({ name: "never_seen_either" }) });
    assert.equal(r.status, 404, who);
    assert.equal(r.text, missing.text, `${who}: byte for byte the answer of a missing route`);
    for (const [contentType, text] of [["text/plain", "not json"], ["application/json", JSON.stringify([body()])]]) {
      const odd = await raw(cookie, contentType, text);
      assert.deepEqual([odd.status, odd.text], [404, missing.text], `${who}, ${contentType}: the same 404 before the body is read`);
    }
  }
  assert.equal((await one(`select count(*)::int n from training_load.source_metric_definitions`)).n, before, "nothing written");
  const none = await api("/fields", { method: "POST", body: body() });
  assert.equal(none.status, 401);
});

test("5. v74's T2a guard: with an acting user, only a platform admin, in their own name, a generic gpexe / rest_v1 key, and at COMMIT its source_metric_create row; without one, as before v74", async () => {
  const insert = (c, k, by) => c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,'L',$2) returning id`, [k, by]);
  const tx = async (actor, fn) => {
    const c = new pg.Client({ connectionString: db.url });
    await c.connect();
    try {
      await c.query("begin");
      if (actor) await c.query(CTX, [actor]);
      const out = await fn(c);
      await c.query("commit");
      return { ok: true, out };
    } catch (error) {
      await c.query("rollback").catch(() => {});
      return { ok: false, error };
    } finally {
      await c.end();
    }
  };
  const refused = (res, code, re) => { assert.equal(res.ok, false, "refused"); assert.equal(res.error.code, code); assert.match(res.error.message, re); };
  refused(await tx(W.ca.id, (c) => insert(c, `athlete_session.g1_${uid()}`, W.ca.id)), "42501", /^source metric: the acting user may not create a source metric$/);
  refused(await tx(W.pa.id, (c) => insert(c, `athlete_session.g1_${uid()}`, W.ca.id)), "42501", /^source metric: the acting user may not create a source metric$/);
  refused(await tx(W.pa.id, (c) => insert(c, `more.events.g1_${uid()}`, W.pa.id)), "23514", /^source_metric_definitions: a created source metric is a generic gpexe \/ rest_v1 field$/);
  refused(await tx(W.pa.id, (c) => insert(c, `athlete_session.g1_${uid()}`, W.pa.id)), "23514", /^source_metric_definitions: a created source metric is written with its source_metric_create audit row$/);
  // Its row is the request record: without a request key it is refused (the database review's LOW-1).
  refused(await tx(W.pa.id, async (c) => {
    const id = (await insert(c, `athlete_session.g1_${uid()}`, W.pa.id)).rows[0].id;
    await c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, to_status, performed_by_user_id, basis, operation_id) values ('source_metric_create',$1,'active',$2,'platform_admin',$3)`, [id, W.pa.id, crypto.randomUUID()]);
  }), "23514", /^source_metric_audit: the audit row must follow its own source metric creation in the same transaction$/);
  // With its keyed row: committed.
  const ok = await tx(W.pa.id, async (c) => {
    const id = (await insert(c, `athlete_session.g1_${uid()}`, W.pa.id)).rows[0].id;
    await c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, to_status, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('source_metric_create',$1,'active',$2,'platform_admin',$3,$4,$5)`, [id, W.pa.id, crypto.randomUUID(), crypto.randomUUID(), hash()]);
    return id;
  });
  assert.equal(ok.ok, true, ok.error?.message);
  // Its row once only, and only for a row of this transaction.
  refused(await tx(W.pa.id, (c) => c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, to_status, performed_by_user_id, basis, operation_id) values ('source_metric_create',$1,'active',$2,'platform_admin',$3)`, [ok.out, W.pa.id, crypto.randomUUID()])),
    "23514", /^source_metric_audit: the audit row must follow its own source metric creation in the same transaction$/);
  // Without an acting user: as before v74 (a raw fixture write).
  const raw = await tx(null, (c) => insert(c, `x.test.g1_${uid()}`, W.pa.id));
  assert.equal(raw.ok, true, raw.error?.message);
});

test("6. v74's unit words (section 8.10): the nine seeded rows exactly, seed-only and append-only; no unit conversion seeded; as_sent takes any unit token, the three old rules unchanged", async () => {
  const words = (await q(`select word, source_unit, display_rule, evidence_kind, evidence_ref from training_load.source_unit_words where source_system = 'gpexe' and api_family = 'rest_v1' order by word`)).map((r) => Object.values(r).join("|"));
  const A = "docs/ai/gpexe-field-inventory-plan.md#unit-word-";
  assert.deepEqual(words, [
    `acceleration|m/s2|as_sent|owner_statement|${A}acceleration`, `distance|m|distance_m|repository_by_analogy|${A}distance`,
    `duration|s|duration_mmss|repository_by_analogy|${A}time`, `energy|J/kg|as_sent|owner_statement|${A}energy`,
    `energy_std|J/kg|as_sent|owner_statement|${A}energy`, `number|count|as_sent|repository|${A}number`,
    `power|W/kg|as_sent|owner_statement|${A}power`, `speed|m/s|speed_kmh|repository|${A}speed`, `time|s|duration_mmss|repository_by_analogy|${A}time`]);
  assert.equal((await one(`select count(*)::int n from training_load.source_unit_words`)).n, 9);
  assert.equal((await one(`select count(*)::int n from training_load.unit_conversions where from_unit = 'number' and to_unit = 'count'`)).n, 0, "no conversion is seeded");
  for (const sql of [
    `insert into training_load.source_unit_words (source_system, api_family, word, source_unit, display_rule, evidence_kind, evidence_ref, seed_migration) values ('gpexe','rest_v1','pace','s','as_sent','repository','docs/ai/x.md#p','migrations_v2/202611161200_training_load_v74_generic_source_fields.sql')`,
    `update training_load.source_unit_words set source_unit = 'km' where word = 'distance'`,
    `delete from training_load.source_unit_words where word = 'power'`,
    `truncate training_load.source_unit_words`]) {
    await assert.rejects(q(sql), (e) => e.code === "23514" || e.code === "42501", sql.slice(0, 40));
  }
  const ok = async (rule, unit) => (await one(`select training_load.source_metric_display_unit_ok($1, $2) as ok`, [rule, unit])).ok;
  for (const [rule, unit, want] of [["as_sent", "count", true], ["as_sent", "W/kg", true], ["as_sent", "two words", false], ["as_sent", "", false], ["as_sent", null, false],
    ["duration_mmss", "mm:ss", true], ["duration_mmss", "s", false], ["distance_m", "m", true], ["speed_kmh", "km/h", true], ["speed_kmh", "m/s", false], ["nope", "m", false]]) {
    assert.equal(await ok(rule, unit), want, `${rule} ${unit}`);
  }
});

test("7. source_stated is never written by hand: a raw status change on an unproven revision is refused, with or without a unit", async () => {
  await plantObserved("raw_status");
  const f = await newField("raw_status");
  for (const set of [`evidence_status = 'source_stated'`, `evidence_status = 'source_stated', source_unit = 'number', unit_verified_by_user_id = '${W.pa.id}', unit_verified_at = now()`]) {
    const res = await txAs(W.pa.id, (c) => c.query(`update training_load.source_metric_definition_versions set ${set} where id = $1`, [f.revisionId]));
    assert.equal(res.ok, false, set);
    assert.equal(res.error.code, "23514", `${set}: ${res.error.message}`);
  }
  assert.equal((await one(`select evidence_status from training_load.source_metric_definition_versions where id = $1`, [f.revisionId])).evidence_status, "unproven");
});

// ---------------------------------------------------------------------------
// The observed act's chain (8.2, 8.3), written by SQL as route O will write it (G1b): T9 field_observation, its T9s
// session, one T9i field_unit row, T2b's update to source_stated, and the two T8 rows - in ONE transaction.
// ---------------------------------------------------------------------------
let counter = 0;
const hash = () => crypto.randomBytes(32).toString("hex");
async function storedSession() {
  counter += 1;
  const teamId = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [W.club, `Team ${uid()}`])).id;
  const sourceTeamId = String(960000 + counter);
  const connectionId = (await one(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','club',$1,'server3',$2,'exchanged_token',$3,'verified',$4,$5,$6,1, now()) returning id`,
    [W.club, `G1 ${uid()}`, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id;
  await q(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const bindingId = (await one(
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  const checkId = (await one(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id,
                                                    source_path, source_connection_id, source_binding_id, source_team_id, source_host_key)
     values ($1,$2,'succeeded','2026-09-14','2026-09-14', now(), $3, 'source_connection', $4, $5, $3, 'server3') returning id`,
    [teamId, W.pa.id, sourceTeamId, connectionId, bindingId])).id;
  const cand = await one(
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash,
                                                        raw_bundle, raw_expires_at, status, first_seen_check_id, last_seen_check_id, drill_parameter_effect)
     values ($1, $2, '2026-09-14T18:08:12Z', 'S', $3, '{}'::jsonb, now() + interval '30 days', 'pending', $4, $4, 'confirmed')
     returning id, gpexe_team_session_id, bundle_hash, session_started_at`,
    [teamId, String(870000 + counter), hash(), checkId]);
  return { teamId, connectionId, bindingId, checkId, cand };
}
async function newField(name) {
  const r = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ name, label: `Field ${name}` }) });
  assert.equal(r.status, 201, r.text);
  return { fieldId: r.body.field.id, revisionId: r.body.revision.id };
}
async function txAs(actorId, fn) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    await c.query("begin");
    if (actorId) await c.query(CTX, [actorId]);
    const value = await fn(c);
    await c.query("set constraints all immediate");
    await c.query("commit");
    return { ok: true, value };
  } catch (error) {
    await c.query("rollback").catch(() => {});
    return { ok: false, error };
  } finally {
    await c.end();
  }
}
// The whole observed act; `skip` leaves one step out, `over` changes one value.
async function observed(c, actor, { f, st, word = "number", unit = "count", rawA = "12", rawB = "17", skip = null, over = {} }) {
  const opId = crypto.randomUUID();
  const confId = (await c.query(
    `insert into training_load.source_metric_confirmations (operation_id, kind, owner_scope, owner_club_id, binding_id, team_id, credential_connection_id,
                                                           confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at, source_metric_version_id)
     values ($1, 'field_observation', 'system', null, $2, $3, $4, $5, $6, now(), true, 2, now(), $7) returning id`,
    [opId, st.bindingId, st.teamId, st.connectionId, actor, over.basis ?? "platform_admin", over.revisionId ?? f.revisionId])).rows[0].id;
  if (skip !== "session") {
    await c.query(
      `insert into training_load.source_metric_confirmation_sessions (confirmation_id, session_ordinal, candidate_id, candidate_bundle_hash, gpexe_team_session_id, session_started_at, check_id, team_id, pair_index)
       values ($1, 1, $2, $3, $4, $5, $6, $7, 0)`,
      [confId, st.cand.id, st.cand.bundle_hash, st.cand.gpexe_team_session_id, st.cand.session_started_at, st.checkId, st.teamId]);
  }
  if (skip !== "item") {
    await c.query(
      `insert into training_load.source_metric_confirmation_items (id, confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, source_unit, compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, raw_b, source_unit_word)
       values (gen_random_uuid(), $1, 1, 1, 'field_unit', true, $2, $3, 'session', $4, $5, $6, $7, $8)`,
      [confId, f.revisionId, unit, over.rule ?? "as_sent", over.displayUnit ?? unit, rawA, rawB, word]);
  }
  if (skip !== "revision") {
    await c.query(
      `update training_load.source_metric_definition_versions
          set source_unit = $2, unit_verified_by_user_id = $3, unit_verified_at = now(), unit_observation_id = $4,
              meaning_verified_by_user_id = $3, meaning_verified_at = now(), meaning_observation_id = $4, evidence_status = 'source_stated'
        where id = $1`, [f.revisionId, over.revisionUnit ?? unit, actor, confId]);
  }
  const audit = (action, keyed) => c.query(
    `insert into training_load.source_metric_audit (action, source_metric_definition_id, source_metric_version_id, confirmation_id, performed_by_user_id, basis, operation_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, 'platform_admin', $6, $7, $8)`,
    [action, f.fieldId, f.revisionId, confId, actor, opId, keyed ? crypto.randomUUID() : null, keyed ? hash() : null]);
  if (skip !== "unitRow") await audit("source_metric_unit_observed", over.unitRowKeyed ?? true);
  if (skip !== "meaningRow") await audit("source_metric_meaning_observed", false);
  return confId;
}

test("8. the observed act, whole, in one transaction: the revision is source_stated with its unit, both proofs naming its own field observation; no document reference; once only", async () => {
  await plantObserved("observed_ok");
  const f = await newField("observed_ok");
  const st = await storedSession();
  const res = await txAs(W.pa.id, (c) => observed(c, W.pa.id, { f, st }));
  assert.equal(res.ok, true, res.error?.message);
  const rev = await one(`select * from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
  assert.deepEqual([rev.evidence_status, rev.source_unit, rev.unit_observation_id, rev.meaning_observation_id, rev.unit_evidence_ref, rev.meaning_evidence_ref, rev.evidence_ref],
    ["source_stated", "count", res.value, res.value, null, null, null]);
  const item = await one(`select item_kind, checked, mapping_version_id, stored_a, values_digest is not null as digested, octet_length(values_salt) as salt from training_load.source_metric_confirmation_items where confirmation_id = $1`, [res.value]);
  assert.deepEqual(item, { item_kind: "field_unit", checked: true, mapping_version_id: null, stored_a: null, digested: true, salt: 16 });
  // A second observed act on the same revision: refused (the proof is written once).
  const st2 = await storedSession();
  const again = await txAs(W.pa.id, (c) => observed(c, W.pa.id, { f, st: st2 }));
  assert.equal(again.ok, false);
  // An M2b document act on it: refused (its unit is proven already).
  const doc = await txAs(W.pa.id, (c) => c.query(`update training_load.source_metric_definition_versions set unit_verified_at = now() where id = $1`, [f.revisionId]));
  assert.equal(doc.ok, false);
  // Each word takes its own seeded unit, rule and screen unit (section 8.10).
  for (const [word, unit, rule, displayUnit] of [["speed", "m/s", "speed_kmh", "km/h"], ["distance", "m", "distance_m", "m"], ["time", "s", "duration_mmss", "mm:ss"], ["power", "W/kg", "as_sent", "W/kg"]]) {
    const name = `word_${word}_${uid()}`;
    await plantObserved(name);
    const g = await newField(name);
    const sw = await storedSession();
    const r = await txAs(W.pa.id, (c) => observed(c, W.pa.id, { f: g, st: sw, word, unit, over: { rule, displayUnit } }));
    assert.equal(r.ok, true, `${word}: ${r.error?.message}`);
    assert.equal((await one(`select source_unit from training_load.source_metric_definition_versions where id = $1`, [g.revisionId])).source_unit, unit);
  }
});

test("9. the observed act's refusals: another actor, a club admin, a word not in the table, a unit or display rule not the word's, two equal or a zero value, a missing session, row, revision update or T8 row, an unkeyed request row", async () => {
  const cases = [
    ["a club admin", W.ca.id, {}, "42501", /^source metric confirmation: the acting user may not write this confirmation$/],
    ["a word not in the table (never guessed)", W.pa.id, { word: "furlongs" }, "23514", /^source_metric_confirmation_items: the unit word GPEXE sends has a seeded unit, and the row's unit is it$/],
    ["no word", W.pa.id, { word: null }, "23514", null],
    ["a unit not the word's", W.pa.id, { word: "number", unit: "W/kg" }, "23514", /^source_metric_confirmation_items: the unit word GPEXE sends has a seeded unit, and the row's unit is it$/],
    ["a non-token unit", W.pa.id, { unit: "two words" }, "23514", null],
    ["speed's unit with as_sent (its rule is speed_kmh)", W.pa.id, { word: "speed", unit: "m/s" }, "23514", /^source_metric_confirmation_items: a field_unit row is compared by its word's display rule, in that rule's screen unit$/],
    ["the word's rule in another screen unit", W.pa.id, { word: "speed", unit: "m/s", over: { rule: "speed_kmh", displayUnit: "m/s" } }, "23514", /^source_metric_confirmation_items: a field_unit row is compared by its word's display rule, in that rule's screen unit$/],
    ["a display rule not the word's (distance is distance_m)", W.pa.id, { word: "distance", unit: "m", over: { rule: "as_sent", displayUnit: "m" } }, "23514", /^source_metric_confirmation_items: a field_unit row is compared by its word's display rule, in that rule's screen unit$/],
    ["equal values", W.pa.id, { rawA: "4", rawB: "4" }, "23514", /^source_metric_confirmation_items: the two athletes' values are non-zero and different$/],
    ["a zero value", W.pa.id, { rawA: "0" }, "23514", /^source_metric_confirmation_items: the two athletes' values are non-zero and different$/],
    ["no session (the row's own foreign key)", W.pa.id, { skip: "session" }, "23503", null],
    ["no row", W.pa.id, { skip: "item" }, "23514", null],
    ["no revision update", W.pa.id, { skip: "revision" }, "23514", null],
    ["no unit row", W.pa.id, { skip: "unitRow" }, "23514", null],
    ["no meaning row", W.pa.id, { skip: "meaningRow" }, "23514", null],
    ["an unkeyed unit row", W.pa.id, { over: { unitRowKeyed: false } }, "23514", /^source_metric_audit: the audit row must follow its own verification in the same transaction$/],
    ["the revision's unit not the row's", W.pa.id, { over: { revisionUnit: "m/s" } }, "23514", /^source_metric_definition_versions: an observed act names its own confirmation of this revision, written in this transaction$/],
  ];
  for (const [label, actor, opts, code, message] of cases) {
    const name = `ref_${uid()}`;
    await plantObserved(name);
    const f = await newField(name);
    const st = await storedSession();
    const res = await txAs(actor, (c) => observed(c, actor, { f, st, ...opts }));
    assert.equal(res.ok, false, `${label}: refused`);
    assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
    if (message) assert.match(res.error.message, message, `${label}: its own fixed message (a CHECK would print the row)`);
    const rev = await one(`select evidence_status from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
    assert.equal(rev.evidence_status, "unproven", `${label}: nothing written`);
  }
});

async function plantObserved(name) {
  await observe(W.conn, [["details.session", name, { kind: "unit_value_object", unit: "power" }]]);
}

test("10. a source_stated revision stays active and proven; the lifecycle never replaces it by an unproven draft (O2 as G1 widens it; its mapping version is G2's, which gives the field an extractor)", async () => {
  const name = `gate_${uid()}`;
  await plantObserved(name);
  const f = await newField(name);
  const st = await storedSession();
  const res = await txAs(W.pa.id, (c) => observed(c, W.pa.id, { f, st }));
  assert.equal(res.ok, true, res.error?.message);
  const rev = await one(`select state, evidence_status from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
  assert.deepEqual(rev, { state: "active", evidence_status: "source_stated" });
  // A draft R+1, then replacing the source_stated revision with it: refused while the draft is unproven (O2 as G1 widens it).
  const draft = await api(`/fields/${f.fieldId}/revisions`, { cookie: W.pa.cookie, method: "POST", body: { requestKey: key(), valueShape: "unit_value_object", parameterKind: "none", supportsSession: true, supportsDrill: true } });
  assert.equal(draft.status, 201, draft.text);
  const replace = await api(`/fields/${f.fieldId}/revisions/${draft.body.revision.id}/replace`, { cookie: W.pa.cookie, method: "POST", body: { requestKey: key(), expectedActiveRevisionId: f.revisionId, reason: "Proven by documents later." } });
  assert.deepEqual([replace.status, replace.body.error], [409, "successor_not_verified"], replace.text);
});

// ---------------------------------------------------------------------------
// The migration's own scripts: the preflight on v72, the post-check on v74 (the verified revisions' digest equal),
// the rollback back to v72's catalog exactly and v74 again, and the rollback's refusals.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const V74 = "202611161200_training_load_v74_generic_source_fields.sql";
const RUNBOOK = (f) => fs.readFileSync(path.join(ROOT, "docs/runbooks", f), "utf8");
const CATALOG = `
  select 'f:'||p.proname||':'||md5(pg_get_functiondef(p.oid)) as x from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='training_load'
  union all select 'c:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) from pg_constraint where connamespace='training_load'::regnamespace
  union all select 'a:'||attrelid::regclass::text||':'||attname||':'||atttypid::regtype::text||':'||attnotnull from pg_attribute a join pg_class cl on cl.oid=a.attrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='training_load' and a.attnum>0 and not a.attisdropped and cl.relkind='r'
  union all select 'i:'||indexrelid::regclass::text from pg_index i join pg_class cl on cl.oid=i.indexrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='training_load'
  union all select 't:'||tgrelid::regclass::text||':'||tgname||':'||tgenabled::text from pg_trigger t join pg_class cl on cl.oid=t.tgrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='training_load' and not tgisinternal
  union all select 'm:'||migration_name from public.schema_migrations
  order by 1`;
async function readOnly(c, sql) {
  await c.query("begin transaction read only");
  try { const r = await c.query(sql); return (Array.isArray(r) ? r : [r]).map((x) => x.rows); } finally { await c.query("rollback"); }
}
async function migrateTo(url, files) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v74-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of files) await fsp.copyFile(path.join(ROOT, "migrations_v2", f), path.join(dir, f));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

test("11. the preflight on v72, v74, the post-check (a verified revision's digest unchanged), the rollback to v72's catalog exactly, v74 again; the rollback refuses once a field was created", async () => {
  // Production's state when v74 is applied: every test migration and App health's v70 and v73, which reached
  // production first. v73 sorts before v74 by file name, so no "later than v74" check counts it. v76 (the undo by the
  // importer) sorts after v74 but reached production first too: it shares no object with v74, so the preflight expects
  // it, the post-check and the rollback do not count it, and only another later migration is a stop.
  const withAppHealth = [...GPEXE_TEST_MIGRATIONS, "202611131400_app_error_events_v70_device_and_keyed_hash.sql", "202611151500_app_error_events_v73_request_and_restart.sql"].sort();
  const before72 = withAppHealth.filter((m) => m !== V74);
  const rdb = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "g1rb", migrations: before72 });
  const c = new pg.Client({ connectionString: rdb.url });
  await c.connect();
  try {
    // A revision verified by documents, before v74 (written as M2b would: its guards off for the fixture).
    await c.query("set session_replication_role = replica");
    const pa = (await c.query(`insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`pa-${uid()}@test.local`])).rows[0].id;
    const fid = (await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1','details.players.g1_verified','V',$1) returning id`, [pa])).rows[0].id;
    await c.query(`insert into training_load.source_metric_definition_versions (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill, state, activated_by_user_id, activated_at,
                     source_unit, unit_verified_by_user_id, unit_verified_at, unit_evidence_ref, meaning_verified_by_user_id, meaning_verified_at, meaning_evidence_ref, evidence_status, evidence_ref, created_by_user_id)
                   values ($1, 1, 'unit_value_object', 'none', true, true, 'active', $2, now(), 'count', $2, now(), 'docs/ai/x.md#u', $2, now(), 'docs/ai/x.md#m', 'verified', 'docs/ai/x.md#u', $2)`, [fid, pa]);
    await c.query("set session_replication_role = origin");
    const pre = await readOnly(c, RUNBOOK("generic-source-fields-v74-preflight.sql"));
    assert.deepEqual([pre[0][0].v72, pre[0][0].v74, pre[0][0].v76, pre[0][0].later_than_v74], ["1", "0", "1", "0"], "v76 recorded, as on production");
    assert.equal((await c.query(`select count(*)::int n from public.schema_migrations where migration_name = 'migrations_v2/202611151500_app_error_events_v73_request_and_restart.sql'`)).rows[0].n, 1, "v73 is recorded, as on production");
    assert.ok(pre[1].length === 14 && pre[1].every((r) => r.ok === true), "the fourteen bodies are the ones v74 was written on");
    assert.deepEqual(pre[2][0], { functions: "0", columns: "0", words_table: "0" });
    assert.deepEqual(pre[4][0], { locks: "0", idle_transactions: "0" });
    const digestBefore = pre[5][0];
    assert.equal(digestBefore.verified_revisions, 1);
    const catalog72 = (await c.query(CATALOG)).rows.map((r) => r.x);

    await migrateTo(rdb.url, withAppHealth);
    const post = await readOnly(c, RUNBOOK("generic-source-fields-v74-postcheck.sql"));
    assert.deepEqual([post[0][0].v74_rows, post[0][0].checksum_ok, post[0][0].later], ["1", true, "0"], "recorded once with the file's checksum");
    assert.ok(post[1].length === 17 && post[1].every((r) => r.ok === true), "the seventeen v74 bodies");
    assert.deepEqual(post[2][0], { triggers: "5", columns: "4", indexes: "3" });
    assert.equal(post[3].length, 9, "the nine unit words");
    assert.deepEqual(post[4][0], digestBefore, "the revision verified by documents is unchanged byte for byte");
    assert.deepEqual(post[5][0], { audit_rows: "0", observations: "0", source_stated: "0" });

    // The rollback: the catalog of v72 exactly; v74 applies again.
    await c.query(RUNBOOK("generic-source-fields-v74-rollback.sql"));
    assert.deepEqual((await c.query(CATALOG)).rows.map((r) => r.x), catalog72);
    await migrateTo(rdb.url, withAppHealth);
    assert.equal((await c.query(`select count(*)::int n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V74}`])).rows[0].n, 1);

    // A row that names a GPEXE unit word: the rollback refuses (plan section 8.10) and changes nothing.
    const catalogW = (await c.query(CATALOG)).rows.map((r) => r.x);
    await c.query("set session_replication_role = replica");
    const wRev = (await c.query(`select id from training_load.source_metric_definition_versions where source_metric_definition_id = $1`, [fid])).rows[0].id;
    const wConf = (await c.query(`insert into training_load.source_metric_confirmations (id, operation_id, kind, owner_scope, binding_id, team_id, credential_connection_id, confirmed_by_user_id, confirmed_basis, confirmed_at, attested, display_registry_version, values_expire_at, source_metric_version_id)
                                  select gen_random_uuid(), gen_random_uuid(), 'field_observation', 'system', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, 'platform_admin', now(), true, 2, now() + interval '2160 hours', $2 returning id`, [pa, wRev])).rows[0].id;
    await c.query(`insert into training_load.source_metric_confirmation_items (id, confirmation_id, session_ordinal, item_no, item_kind, checked, source_metric_version_id, source_unit, compared_level, gpexe_display_rule, gpexe_display_unit, raw_a, raw_b, values_salt, values_digest, source_unit_word)
                   values (gen_random_uuid(), $1, 1, 1, 'field_unit', true, $2, 'count', 'session', 'as_sent', 'count', 12, 17, uuid_send(gen_random_uuid()), encode(sha256('x'), 'hex'), 'number')`, [wConf, wRev]);
    await c.query("set session_replication_role = origin");
    await assert.rejects(c.query(RUNBOOK("generic-source-fields-v74-rollback.sql")), /v74 rollback refused: a row names a GPEXE unit word/);
    await c.query("rollback").catch(() => {});
    // Any later migration but v76 is a stop for the rollback, and for the preflight and the post-check counts.
    const later = "migrations_v2/209901010000_a_later_migration.sql";
    await c.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1,$2,0,'test')`, [later, "0".repeat(64)]);
    await assert.rejects(c.query(RUNBOOK("generic-source-fields-v74-rollback.sql")), /v74 rollback refused: a later migration is recorded/);
    await c.query("rollback").catch(() => {});
    assert.equal((await readOnly(c, RUNBOOK("generic-source-fields-v74-postcheck.sql")))[0][0].later, "1", "the post-check counts it");
    assert.equal((await readOnly(c, RUNBOOK("generic-source-fields-v74-preflight.sql")))[0][0].later_than_v74, "1", "the preflight counts it");
    await c.query(`delete from public.schema_migrations where migration_name = $1`, [later]);
    await c.query("rollback").catch(() => {});
    assert.deepEqual((await c.query(CATALOG)).rows.map((r) => r.x), catalogW, "nothing changed");
    await c.query("set session_replication_role = replica");
    await c.query(`delete from training_load.source_metric_confirmation_items where confirmation_id = $1`, [wConf]);
    await c.query(`delete from training_load.source_metric_confirmations where id = $1`, [wConf]);
    await c.query("set session_replication_role = origin");

    // Once a field is created (a source_metric_create row), the rollback refuses and changes nothing.
    await c.query("begin");
    await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [pa]);
    await c.query(CTX, [pa]);
    const nid = (await c.query(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1','athlete_session.g1_created','C',$1) returning id`, [pa])).rows[0].id;
    await c.query(`insert into training_load.source_metric_audit (action, source_metric_definition_id, to_status, performed_by_user_id, basis, operation_id, request_key, request_hash) values ('source_metric_create',$1,'active',$2,'platform_admin',$3,$4,$5)`, [nid, pa, crypto.randomUUID(), crypto.randomUUID(), hash()]);
    await c.query("commit");
    const catalog74 = (await c.query(CATALOG)).rows.map((r) => r.x);
    await assert.rejects(c.query(RUNBOOK("generic-source-fields-v74-rollback.sql")), /v74 rollback refused: a field was created or observed/);
    await c.query("rollback").catch(() => {});
    assert.deepEqual((await c.query(CATALOG)).rows.map((r) => r.x), catalog74, "nothing changed");
  } finally {
    await c.end();
    await rdb.drop();
  }
});

test("12. route C's lost answer, through the route: a COMMIT that went through but whose answer was lost is verified by its request key (200, verified_after_commit_error, one field, as M2); a COMMIT that did not go through and cannot be confirmed is 503 outcome_unknown, and the same key then creates it once", async () => {
  const plant = async (name) => observe(W.conn, [["details.session", name, { kind: "unit_value_object", unit: "power" }]]);
  // (a) The COMMIT is sent and goes through; its answer is lost.
  const nameA = `lost_ok_${uid()}`;
  await plant(nameA);
  mappingService.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const lost = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: body({ name: nameA, label: "Lost ok" }) });
  mappingService.setMappingCommitForTests();
  assert.deepEqual([lost.status, lost.body.commitConfirmation, lost.body.replayed], [200, "verified_after_commit_error", false], lost.text);
  const fieldA = await one(`select id from training_load.source_metric_definitions where source_metric_key = $1`, [`details.players.${nameA}`]);
  assert.equal(lost.body.field.id, fieldA.id);
  assert.equal((await auditOf(fieldA.id)).filter((r) => r.keyed).length, 1, "one request record");
  // (b) The COMMIT does not go through and the check cannot confirm it: outcome unknown; the same key creates it once.
  const nameB = `lost_unknown_${uid()}`;
  await plant(nameB);
  const b = body({ name: nameB, label: "Lost unknown" });
  mappingService.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("answer lost"); }), timeoutMs: 2_000 });
  const unknown = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
  mappingService.setMappingCommitForTests();
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", b.requestKey], unknown.text);
  assert.equal((await q(`select 1 from training_load.source_metric_definitions where source_metric_key = $1`, [`details.players.${nameB}`])).length, 0);
  const retry = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
  assert.equal(retry.status, 201, retry.text);
  const again = await api("/fields", { cookie: W.pa.cookie, method: "POST", body: b });
  assert.deepEqual([again.status, again.body.replayed, again.body.field.id], [200, true, retry.body.field.id], again.text);
  assert.equal((await q(`select 1 from training_load.source_metric_definitions where source_metric_key = $1`, [`details.players.${nameB}`])).length, 1, "created once");
});

test("13. the database review's MEDIUM-2: a field_unit row's word is final (an update that changes it is refused) and inside its values digest (a row without a word keeps v65's digest)", async () => {
  await plantObserved("final_word");
  const f = await newField("final_word");
  const st = await storedSession();
  const res = await txAs(W.pa.id, (c) => observed(c, W.pa.id, { f, st }));
  assert.equal(res.ok, true, res.error?.message);
  const changed = await txAs(W.pa.id, (c) => c.query(`update training_load.source_metric_confirmation_items set source_unit_word = 'time' where confirmation_id = $1`, [res.value]));
  assert.equal(changed.ok, false);
  assert.equal(changed.error.code, "23514");
  assert.match(changed.error.message, /^source_metric_confirmation_items: only the values of a row are removed$/);
  const d = await one(`select i.values_digest = training_load.source_metric_confirmation_item_digest(i) as stored_is_recomputed,
                              training_load.source_metric_confirmation_item_digest(i)
                                <> training_load.source_metric_confirmation_item_digest(jsonb_populate_record(i, '{"source_unit_word": "time"}')) as word_covered,
                              training_load.source_metric_confirmation_item_digest(jsonb_populate_record(i, '{"source_unit_word": null}'))
                                = encode(sha256(i.values_salt || convert_to(concat_ws('|', i.confirmation_id::text, i.item_no::text, i.item_kind, i.mapping_version_id::text,
                                    i.source_metric_version_id::text, i.parameter_fingerprint, i.source_unit, i.target_unit, i.scale::text, i.scale_divisor::text, i."offset"::text,
                                    i.gpexe_display_rule, i.gpexe_display_unit, i.raw_a::text, i.stored_a::text, i.raw_b::text, i.stored_b::text), 'UTF8')), 'hex') as wordless_is_v65
                         from training_load.source_metric_confirmation_items i where i.confirmation_id = $1`, [res.value]);
  assert.deepEqual(d, { stored_is_recomputed: true, word_covered: true, wordless_is_v65: true });
});
