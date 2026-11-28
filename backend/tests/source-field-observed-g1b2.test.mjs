import { stageMappingsManageForTest } from "./support/mappings-manage-grants.mjs";
import { VARIABLE_MANAGE, editVariablesManageTestRole, stageVariablesManageForTest } from "./support/variables-manage-grants.mjs";
// G1b-2 (docs/ai/gpexe-field-inventory-plan.md, section 8.2; J18's routes 8, 9 and 10) on disposable databases through
// the real routes: the platform's comparison of a generic field (route 8), its tick (route O) and the stored comparisons
// (route 10) - access and the identical 404, every refusal, the one write with every row of 8.2, no athlete id anywhere,
// the values only in T9i, the two-connection word (carry-over 5), concurrency against an M2b act (both orders) and an
// Unbind, and the recorded SQL order of route O's locks.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";
import { writeRevision } from "./support/source-revisions.mjs";
import { PLANTED, previewBundle } from "./support/preview-bundles.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "/api/training-load/sources/metrics";
const ATHLETE = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;
const NAMES = { 1: "Observed Athlete One", 2: "Observed Athlete Two", 3: "Observed Athlete Three" };
const UNIT_REF = "docs/ai/test-evidence.md#unit-of-the-field";

let db, k, server, apiBase, appPool, createSession, observation, verification, mappingService;
const W = {};
const responses = [];
const logLines = [];
const originalConsole = {};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "g1b2", roleRead: true });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  await stageVariablesManageForTest(k);
  await editVariablesManageTestRole(k, VARIABLE_MANAGE, true);
  await stageMappingsManageForTest(k);
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => { logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  }
  const serverModule = await import("../src/server.js");
  ({ pool: appPool } = await import("../src/db.js"));
  ({ createSession } = await import("../src/auth.js"));
  observation = await import("../src/sourceFieldObservationService.js");
  verification = await import("../src/sourceFieldVerificationService.js");
  mappingService = await import("../src/sourceMetricMappingService.js");
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

after(async () => {
  observation?.setObservedHoldForTests(null);
  verification?.setFieldWriteHoldForTests(null);
  mappingService?.setMappingCommitForTests();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];
const rows = async (sql, params = []) => (await k.query(sql, params)).rows;
const key = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString("hex");

async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${PREFIX}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, cache: res.headers.get("cache-control") };
}
const get = (p, who) => api(p, { cookie: who?.cookie });
const post = (p, who, body) => api(p, { method: "POST", cookie: who?.cookie, body });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const refused = (res, status, code) => { assert.deepEqual([res.status, res.body.error], [status, code], res.text); return res.body; };
const NOT_FOUND = { status: 404, body: { error: "notFound" }, cache: "no-store" };
const shape = (res) => ({ status: res.status, body: res.body, cache: res.cache });
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join("&");

async function user(label) {
  return (await one(`insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function platformAdmin(ws = ["platform", null], label = "platform-admin") {
  const id = await user(label);
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (ws[0] === "club") await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, ws[1]]);
  await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id), ctx: { userId: String(id), basis: "platform_admin", owner: { scope: "system", clubId: null } } };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
const club = async (name) => (await one(`insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
let teamCounter = 0;
async function gpexeTeam(clubId, { hostKey = "server3" } = {}) {
  const teamId = (await one(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
  teamCounter += 1;
  const sourceTeamId = String(981000 + teamCounter);
  await k.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,$2,$3)`, [teamId, sourceTeamId, W.pa.id]);
  const connectionId = (await one(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_club_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','club',$1,$2,$3,'exchanged_token',$4,'verified',$5,$6,$7,1, now()) returning id`,
    [clubId, hostKey, `G1b-2 ${uid()}`, W.pa.id, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id;
  const bindingId = (await one(
    `insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
     values ($1,$2,'gpexe',$3,$4,$1) returning id`, [teamId, connectionId, sourceTeamId, W.pa.id])).id;
  return { teamId, clubId, sourceTeamId, bindingId, connectionId };
}
async function check(t, { status = "succeeded" } = {}) {
  return (await one(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id,
                                                    source_path, source_connection_id, source_binding_id, source_team_id, source_host_key, error_code)
     values ($1,$2,$3,'2026-09-14','2026-09-14', now(), $4, 'source_connection', $5, $6, $4, 'server3', $7) returning id`,
    [t.teamId, W.pa.id, status, t.sourceTeamId, t.connectionId, t.bindingId, status === "failed" ? "source_unavailable" : null])).id;
}
let sessionCounter = 0;
// A stored session of the team whose answers carry `plant(gpexeAthleteId)` for each athlete's whole session.
async function candidate(t, plant, { checkStatus = "succeeded", startedAt = "2026-09-14T18:08:12Z" } = {}) {
  sessionCounter += 1;
  const c = await check(t, { status: checkStatus });
  const bundle = previewBundle({ gpexeTeamId: Number(t.sourceTeamId) });
  for (const [id, values] of Object.entries(bundle.details.full.players)) Object.assign(values, plant(id));
  const row = await one(
    `insert into training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id, session_started_at, session_label, bundle_hash,
                                                        raw_bundle, raw_expires_at, status, first_seen_check_id, last_seen_check_id, drill_parameter_effect)
     values ($1, $2, $3, 'Observed session', $4, $5::jsonb, now() + interval '30 days', 'pending', $6, $6, 'confirmed')
     returning id, bundle_hash`,
    [t.teamId, String(58000000 + sessionCounter), startedAt, hash(), JSON.stringify(bundle), c]);
  return { ...row, checkId: c };
}
async function link(t, n) {
  const athleteId = (await one(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,'Europe/Sarajevo') returning id`, [NAMES[n]])).id;
  await k.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, t.clubId, t.teamId]);
  await k.query(`insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,$2,$3,$4)`, [t.teamId, ATHLETE(n), athleteId, W.pa.id]);
}
// A field as route C writes it: the T2a row and revision 1, active and unproven, with the unit the inventory expected.
async function created(name, { endpoint = "details.players", expected = null } = {}) {
  const fieldId = (await one(`insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, created_by_user_id) values ('gpexe','rest_v1',$1,$2,$3) returning id`,
    [`${endpoint}.${name}`, `Field ${name}`, W.pa.id])).id;
  const revisionId = await writeRevision(k, { fieldId, by: W.pa.id, valueShape: endpoint === "details.players" ? "unit_value_object" : "number", evidenceStatus: "unproven", expectedSourceUnit: expected, state: "active" });
  return { fieldId, revisionId: revisionId.revisionId ?? revisionId, name };
}
const energyOf = (name, word = "energy") => (id) => ({ [name]: { unit: typeof word === "function" ? word(id) : word, value: { [ATHLETE(1)]: 412.5, [ATHLETE(2)]: 380, [ATHLETE(3)]: 455.25 }[id] ?? 300 } });
const observationOf = (who, f, extra) => get(`/fields/${f.fieldId}/observation?${qs(extra)}`, who);
const tick = (who, f, body, revisionId = f.revisionId) => post(`/fields/${f.fieldId}/revisions/${revisionId}/observed-confirmation`, who, body);
const tickBody = (o, over = {}) => ({ requestKey: key(), session: { candidateId: o.session.candidateId, pairs: o.pair.positions, placementHash: o.placementHash }, attested: true, ...over });
const noAthleteId = (text, label) => assert.ok(!String(text).includes(PLANTED.athletePrefix), `${label}: no GPEXE athlete id`);

async function world() {
  W.pa = await platformAdmin();
  W.clubA = await club("Club A");
  W.paClub = await platformAdmin(["club", W.clubA], "platform-admin-club");
  W.caA = await clubAdmin(W.clubA);
  W.coach = { id: await user("coach") };
  W.tA = await gpexeTeam(W.clubA);
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [W.coach.id, W.tA.teamId]);
  await workspace(W.coach.id, "team", W.tA.teamId);
  W.coach.cookie = await cookieFor(W.coach.id);
  for (const n of [1, 2, 3]) await link(W.tA, n);
}

// ---------------------------------------------------------------------------
test("1. the audience: routes 8, O and 10 answer an active platform admin in the platform workspace; a club's admin, a platform admin in a club workspace, a coach and an unknown field get the identical 404, before the query or the body is read", async () => {
  const f = await created("g1b2_access", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  for (const who of [W.caA, W.paClub, W.coach]) {
    assert.deepEqual(shape(await observationOf(who, f, { candidateId: cand.id })), NOT_FOUND);
    assert.deepEqual(shape(await get(`/fields/${f.fieldId}/observation?bad=1`, who)), NOT_FOUND, "before the query");
    assert.deepEqual(shape(await tick(who, f, { anything: true })), NOT_FOUND, "before the body");
    assert.deepEqual(shape(await get(`/fields/${f.fieldId}/observations`, who)), NOT_FOUND);
  }
  assert.equal((await get(`/fields/${f.fieldId}/observation?candidateId=${cand.id}`)).status, 401, "no session");
  for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
    assert.deepEqual(shape(await get(`/fields/${id}/observation?candidateId=${cand.id}`, W.pa)), NOT_FOUND, id);
    assert.deepEqual(shape(await get(`/fields/${id}/observations`, W.pa)), NOT_FOUND, id);
  }
  // An unknown candidate or team is the identical 404 too.
  assert.deepEqual(shape(await observationOf(W.pa, f, { candidateId: crypto.randomUUID() })), NOT_FOUND);
  assert.deepEqual(shape(await observationOf(W.pa, f, { teamId: crypto.randomUUID() })), NOT_FOUND);
});

test("2. route 8: two named athletes' raw values and what GPEXE shows (energy: as_sent in J/kg), their positions and names, the word, the comparison's hash; pair and pairs choose another pair; no athlete id; a bad query is 400", async () => {
  const f = await created("g1b2_read", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const { observation: o } = ok(await observationOf(W.pa, f, { candidateId: cand.id }));
  assert.equal(o.gpexeName, f.name, "GPEXE's own name of the value, to find it on the GPEXE screen");
  assert.deepEqual([o.fieldId, o.revisionId, o.key, o.confirmable, o.reason, o.word, o.unit, o.displayRule, o.displayUnit],
    [f.fieldId, f.revisionId, `details.players.${f.name}`, true, null, "energy", "J/kg", "as_sent", "J/kg"]);
  assert.equal(o.session.candidateId, cand.id);
  assert.equal(o.team.id, W.tA.teamId);
  assert.equal(o.pair.count, 3, "three named athletes, three pairs");
  assert.ok(o.pair.labels.every((l) => Object.values(NAMES).includes(l)), JSON.stringify(o.pair.labels));
  assert.ok(o.pair.positions.every(Number.isInteger));
  for (const side of [o.values.a, o.values.b]) assert.equal(side.shown, side.raw, "as_sent: the raw value as GPEXE sends it");
  assert.ok(["412.5", "380", "455.25"].includes(o.values.a.raw) && ["412.5", "380", "455.25"].includes(o.values.b.raw), JSON.stringify(o.values));
  assert.match(o.placementHash, /^[0-9a-f]{64}$/);
  noAthleteId(JSON.stringify(o), "route 8");
  // The same request answers the same hash; another pair another hash; pairs names the same pair as pair.
  assert.equal(ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation.placementHash, o.placementHash);
  const second = ok(await observationOf(W.pa, f, { candidateId: cand.id, pair: 1 })).observation;
  assert.notEqual(second.placementHash, o.placementHash);
  const byPositions = ok(await observationOf(W.pa, f, { candidateId: cand.id, pairs: second.pair.positions.join(",") })).observation;
  assert.deepEqual([byPositions.pair.index, byPositions.placementHash], [1, second.placementHash]);
  refused(await observationOf(W.pa, f, { candidateId: cand.id, pair: 3 }), 409, "pair_out_of_range");
  // With a team only: the newest stored session that has a pair.
  assert.equal(ok(await observationOf(W.pa, f, { teamId: W.tA.teamId })).observation.session.candidateId, cand.id);
  for (const bad of ["bad=1", `candidateId=${cand.id}&candidateId=${cand.id}`, `candidateId=${cand.id}&pair=0&pairs=0,1`, `candidateId=${cand.id}&pairs=1,1`, `candidateId=${cand.id}&pairs=0`, "", `candidateId=${cand.id}&pair=-1`]) {
    refused(await get(`/fields/${f.fieldId}/observation?${bad}`, W.pa), 400, "invalid_query");
  }
});

test("3. route O, the one write: T9 field_observation (system, no club, the session's binding, team and connection, attested), its one T9s session, one T9i field_unit row with both raw values, the word and the word's rule; T2b source_stated in J/kg, both proofs naming the comparison; the keyed source_metric_unit_observed row and source_metric_meaning_observed; no athlete id anywhere; the same key replays", async () => {
  const f = await created("g1b2_write", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  const body = tickBody(o);
  const r = ok(await tick(W.pa, f, body), 201);
  assert.deepEqual([r.revision.evidenceStatus, r.revision.sourceUnit, r.revision.state], ["source_stated", "J/kg", "active"]);
  const conf = await one(`select * from training_load.source_metric_confirmations where id = $1`, [r.confirmationId]);
  assert.deepEqual([conf.kind, conf.owner_scope, conf.owner_club_id, conf.binding_id, conf.team_id, conf.credential_connection_id, conf.confirmed_basis, conf.attested, conf.source_metric_version_id, conf.display_registry_version],
    ["field_observation", "system", null, W.tA.bindingId, W.tA.teamId, W.tA.connectionId, "platform_admin", true, f.revisionId, 2]);
  const sessions = await rows(`select * from training_load.source_metric_confirmation_sessions where confirmation_id = $1`, [conf.id]);
  assert.equal(sessions.length, 1);
  assert.deepEqual([sessions[0].candidate_id, sessions[0].candidate_bundle_hash, sessions[0].check_id, sessions[0].pair_index], [cand.id, cand.bundle_hash, cand.checkId, o.pair.index]);
  const items = await rows(`select item_kind, checked, source_unit_word, source_unit, gpexe_display_rule, gpexe_display_unit, trim_scale(raw_a)::text a, trim_scale(raw_b)::text b, mapping_version_id, stored_a from training_load.source_metric_confirmation_items where confirmation_id = $1`, [conf.id]);
  assert.deepEqual(items, [{ item_kind: "field_unit", checked: true, source_unit_word: "energy", source_unit: "J/kg", gpexe_display_rule: "as_sent", gpexe_display_unit: "J/kg", a: o.values.a.raw, b: o.values.b.raw, mapping_version_id: null, stored_a: null }]);
  const rev = await one(`select * from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
  assert.deepEqual([rev.evidence_status, rev.source_unit, rev.unit_observation_id, rev.meaning_observation_id, rev.unit_verified_by_user_id, rev.meaning_verified_by_user_id, rev.evidence_ref],
    ["source_stated", "J/kg", conf.id, conf.id, W.pa.id, W.pa.id, null]);
  const audit = await rows(`select action, request_key is not null as keyed, confirmation_id, basis from training_load.source_metric_audit where operation_id = $1 order by action`, [conf.operation_id]);
  assert.deepEqual(audit.map((a) => [a.action, a.keyed, a.confirmation_id, a.basis]),
    [["source_metric_meaning_observed", false, conf.id, "platform_admin"], ["source_metric_unit_observed", true, conf.id, "platform_admin"]]);
  // No athlete id in any row the write touched, nor in the answer; the values only in T9i.
  const written = JSON.stringify([conf, sessions, await rows(`select * from training_load.source_metric_confirmation_items where confirmation_id = $1`, [conf.id]), rev,
    await rows(`select * from training_load.source_metric_audit where operation_id = $1`, [conf.operation_id])]);
  noAthleteId(written, "the stored rows");
  noAthleteId(JSON.stringify(r), "the answer");
  for (const value of [o.values.a.raw, o.values.b.raw]) {
    assert.ok(!JSON.stringify([conf, sessions, rev]).includes(`"${value}"`), `${value} only in T9i`);
  }
  // The same key: the same answer, replayed, nothing more written; the key with another request: request_key_reused.
  const replay = ok(await tick(W.pa, f, body), 200);
  assert.deepEqual([replay.replayed, replay.confirmationId], [true, conf.id]);
  assert.equal((await one(`select count(*)::int n from training_load.source_metric_confirmations where source_metric_version_id = $1`, [f.revisionId])).n, 1);
  refused(await tick(W.pa, f, { ...body, session: { ...body.session, pairs: [...body.session.pairs].reverse().map((p) => p + 10) } }), 409, "request_key_reused");
  // A second tick with a new key: the unit is proven now.
  refused(await tick(W.pa, f, tickBody(o)), 409, "unit_already_verified");
  // Route 8 says the same.
  refused(await observationOf(W.pa, f, { candidateId: cand.id }), 409, "unit_already_verified");
});

test("4. route O's refusals, nothing written: not attested, a bad body, a field with parameters, an athlete-row field (no unit word, the sentence), the words disagree, a word not seeded, a word of another unit than the field was created with (carry-over 5), a changed comparison (board_changed), a failed check, a revision that is not the active one", async () => {
  const before = async (f) => [(await one(`select count(*)::int n from training_load.source_metric_confirmations where source_metric_version_id = $1`, [f.revisionId])).n,
    (await one(`select evidence_status from training_load.source_metric_definition_versions where id = $1`, [f.revisionId])).evidence_status];
  const f = await created("g1b2_refuse", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  refused(await tick(W.pa, f, tickBody(o, { attested: false })), 400, "invalid_body");
  refused(await tick(W.pa, f, { ...tickBody(o), extra: 1 }), 400, "invalid_body");
  refused(await tick(W.pa, f, tickBody(o, { session: { candidateId: cand.id, pairs: [0], placementHash: o.placementHash } })), 400, "invalid_body");
  refused(await tick(W.pa, f, tickBody(o, { session: { ...tickBody(o).session, placementHash: "x" } })), 400, "invalid_body");
  // A changed comparison: another hash.
  refused(await tick(W.pa, f, tickBody(o, { session: { ...tickBody(o).session, placementHash: "0".repeat(64) } })), 409, "board_changed");
  assert.deepEqual(await before(f), [0, "unproven"]);

  // A field with parameters (the seeded power zone).
  const zone = await one(`select d.id as "fieldId", r.id as "revisionId" from training_load.source_metric_definitions d join training_load.source_metric_definition_versions r on r.source_metric_definition_id = d.id and r.state = 'active' where d.source_metric_key = 'more.complementary_data.power.distance'`);
  if (zone) refused(await observationOf(W.pa, zone, { candidateId: cand.id }), 409, "field_has_parameters");

  // An athlete-row field: GPEXE sends no word with it.
  const row = await created("g1b2_row", { endpoint: "athlete_session" });
  const rowRes = refused(await observationOf(W.pa, row, { candidateId: cand.id }), 409, "unit_not_stated");
  assert.deepEqual(rowRes.current, { reason: "no_unit_word" });
  assert.equal(rowRes.message, "GPEXE sends no unit with this value. A platform administrator confirms it with a document (Confirm the unit).");
  refused(await tick(W.pa, row, tickBody({ ...o, placementHash: o.placementHash })), 409, "unit_not_stated");

  // The words disagree; a word not seeded; a word of another unit than the expected one.
  for (const [label, word, expected, reason] of [
    ["disagree", (id) => (id === ATHLETE(1) ? "power" : "energy"), "J/kg", "words_disagree"],
    ["not seeded", "furlongs", null, "word_unknown"],
    ["no word", null, null, "no_unit_word"],
    ["another unit (two connections)", "power", "J/kg", "expected_unit_differs"],
  ]) {
    const g = await created(`g1b2_${label.replace(/[^a-z]/g, "")}_${uid()}`, { expected });
    const c = await candidate(W.tA, energyOf(g.name, word));
    const read = ok(await observationOf(W.pa, g, { candidateId: c.id, ...(label === "disagree" ? { pairs: "0,1" } : {}) })).observation;
    assert.deepEqual([read.confirmable, read.reason], [false, reason], label);
    // A word is echoed only when it is a seeded one (security review LOW-1).
    assert.ok((read.words || []).every((w) => w === null || ["energy", "power"].includes(w)), `${label}: ${JSON.stringify(read.words)}`);
    if (label === "not seeded") assert.deepEqual(read.words, [null, null]);
    const t = refused(await tick(W.pa, g, tickBody(read)), 409, "unit_not_stated");
    assert.deepEqual(t.current, { reason }, label);
    assert.deepEqual(await before(g), [0, "unproven"], label);
  }

  // A field that carries other evidence (observed, nothing confirmed): field_has_evidence, never "already confirmed".
  const observed = await created(`g1b2_observed_${uid()}`, { expected: "J/kg" });
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.source_metric_definition_versions set evidence_status = 'observed', evidence_ref = 'docs/ai/test-evidence.md#observed' where id = $1`, [observed.revisionId]);
  await k.query("commit");
  const evid = refused(await observationOf(W.pa, observed, { candidateId: cand.id }), 409, "field_has_evidence");
  assert.deepEqual(evid.current, { evidenceStatus: "observed" });

  // A session whose last check failed is not read.
  const g = await created("g1b2_failed", { expected: "J/kg" });
  const failed = await candidate(W.tA, energyOf(g.name), { checkStatus: "failed" });
  refused(await observationOf(W.pa, g, { candidateId: failed.id }), 409, "candidate_source_mismatch");
  // A revision of the field that is not the active one (a draft R+1): revision_not_active; another field's revision: 404.
  const draft = await writeRevision(k, { fieldId: f.fieldId, by: W.pa.id, revisionNumber: 2, valueShape: "unit_value_object", evidenceStatus: "unproven", state: "draft" });
  refused(await tick(W.pa, f, tickBody(o), draft.revisionId ?? draft), 409, "revision_not_active");
  assert.deepEqual(shape(await tick(W.pa, f, tickBody(o), g.revisionId)), NOT_FOUND);
  assert.deepEqual(await before(f), [0, "unproven"]);
});

test("5. route 10: the field's stored comparisons for a platform admin - the word, the unit, the team, who and when, the two raw values while kept; once removed, no value; never an athlete's name or id", async () => {
  const f = await created("g1b2_list", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  ok(await tick(W.pa, f, tickBody(o)), 201);
  const listedAnswer = ok(await get(`/fields/${f.fieldId}/observations`, W.pa));
  assert.equal(listedAnswer.truncated, false);
  const listed = listedAnswer.observations;
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0].word, listed[0].unit, listed[0].displayRule, listed[0].team.id, listed[0].values], ["energy", "J/kg", "as_sent", W.tA.teamId, { a: o.values.a.raw, b: o.values.b.raw }]);
  noAthleteId(JSON.stringify(listed), "route 10");
  for (const name of Object.values(NAMES)) assert.ok(!JSON.stringify(listed).includes(name), "no athlete's name");
  refused(await get(`/fields/${f.fieldId}/observations?x=1`, W.pa), 400, "invalid_query");
  // Past the values' date (set by a replica write): the removal before the read clears them, and the list shows none.
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    await k.query(`update training_load.source_metric_confirmations set confirmed_at = confirmed_at - interval '2184 hours', values_expire_at = values_expire_at - interval '2184 hours' where source_metric_version_id = $1`, [f.revisionId]);
    await k.query("commit");
  } catch (error) {
    await k.query("rollback");
    throw error;
  }
  // Even when the removal before the read fails, no value past its date is answered.
  const removal = await import("../src/sourceMetricConfirmationRemoval.js");
  removal.setRemovalFaultForTests(() => { throw new Error("removal down (test)"); });
  try {
    const stale = ok(await get(`/fields/${f.fieldId}/observations`, W.pa)).observations;
    assert.equal(stale[0].values, null, "no value past its date while the removal is down");
    assert.notEqual((await one(`select raw_a from training_load.source_metric_confirmation_items i join training_load.source_metric_confirmations c on c.id = i.confirmation_id where c.source_metric_version_id = $1`, [f.revisionId])).raw_a, null, "the removal did not run");
  } finally {
    removal.setRemovalFaultForTests(null);
  }
  const after = ok(await get(`/fields/${f.fieldId}/observations`, W.pa)).observations;
  assert.equal(after.length, 1);
  assert.equal(after[0].values, null, "no value past its date");
  const item = await one(`select raw_a, raw_b, values_removed_at from training_load.source_metric_confirmation_items i join training_load.source_metric_confirmations c on c.id = i.confirmation_id where c.source_metric_version_id = $1`, [f.revisionId]);
  assert.deepEqual([item.raw_a, item.raw_b, item.values_removed_at !== null], [null, null, true], "removed from T9i");
});

test("6. the gates after a tick: a source_stated revision is proven for a mapping version - created, submitted and activated through M2 (v52's activation gate accepts it; carry-over 3)", async () => {
  const f = await created("g1b2_gate", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  ok(await tick(W.pa, f, tickBody(ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation)), 201);
  const variable = ok(await post("/variables", W.pa, { requestKey: key(), label: `Energy ${uid()}`, unit: "J/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
  const mapping = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
  const version = ok(await post(`/mappings/${mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false }), 201).version;
  ok(await post(`/mappings/${mapping.id}/versions/${version.id}/submit`, W.pa, { requestKey: key() }));
  const active = ok(await post(`/mappings/${mapping.id}/versions/${version.id}/activate`, W.pa, { requestKey: key(), expectedActiveVersionId: null }));
  assert.equal(active.version.status, "active");
});

// The tick's statements, in order, through the application pool (the recorded SQL order of its locks).
async function recordStatements(fn) {
  const statements = [];
  const original = appPool.connect.bind(appPool);
  appPool.connect = async (...args) => {
    const client = await original(...args);
    if (!client.__recorded) {
      const query = client.query.bind(client);
      client.query = (sql, ...rest) => { statements.push(typeof sql === "string" ? sql : sql?.text ?? ""); return query(sql, ...rest); };
      client.__recorded = query;
    }
    return client;
  };
  try {
    return { value: await fn(), statements };
  } finally {
    appPool.connect = original;
  }
}

test("7. the recorded SQL order of route O's locks (.claude/rules/migrations.md): the per-user lock, the request record, the revision FOR UPDATE, the binding and team FOR SHARE, users before the role, the club, then T9, T9s, T9i, the T2b update, and T8 last - every lock before the first write", async () => {
  const f = await created("g1b2_order", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  const { value, statements } = await recordStatements(() => observation.confirmObserved({ ctx: W.pa.ctx, fieldId: f.fieldId, revisionId: f.revisionId, body: tickBody(o) }));
  assert.ok(value.confirmationId);
  const norm = statements.map((s) => s.replace(/\s+/g, " ").trim());
  const at = (re, label) => { const i = norm.findIndex((s) => re.test(s)); assert.ok(i >= 0, `${label} not found`); return i; };
  const order = [
    at(/pg_advisory_xact_lock\(hashtextextended\(\$1, 34\)\)/, "the per-user lock"),
    at(/from training_load\.source_metric_audit where performed_by_user_id = \$1 and request_key = \$2/, "the request record"),
    at(/from training_load\.source_metric_definition_versions where id = \$1 and source_metric_definition_id = \$2 for update/, "the revision"),
    at(/from training_load\.source_team_bindings where id = any\(\$1::uuid\[\]\) order by id for share/, "the binding"),
    at(/from public\.teams where id = any\(\$1::uuid\[\]\) order by id for share/, "the team"),
    at(/from public\.user_global_roles g join public\.users u on u\.id = g\.user_id .*for share of u, g$/, "the rights, users first"),
    at(/from public\.clubs where id = any\(\$1::uuid\[\]\) order by id for share/, "the club"),
    at(/^insert into training_load\.source_metric_confirmations /, "T9"),
    at(/^insert into training_load\.source_metric_confirmation_sessions /, "T9s"),
    at(/^insert into training_load\.source_metric_confirmation_items /, "T9i"),
    at(/^update training_load\.source_metric_definition_versions set source_unit/, "the T2b update"),
    at(/^insert into training_load\.source_metric_audit .*values/, "T8"),
  ];
  assert.deepEqual(order, [...order].sort((a, b) => a - b), JSON.stringify(order));
  const firstWrite = order[7];
  // The write's own transaction ends at its COMMIT (the answer's read after it is another transaction).
  const commit = norm.findIndex((s, i) => i > firstWrite && s === "commit");
  assert.ok(commit > firstWrite, "the COMMIT");
  const locks = norm.map((s, i) => [s, i]).filter(([s, i]) => i < commit && /\bfor (update|share|no key update)\b/.test(s));
  assert.ok(locks.length >= 5 && locks.every(([, i]) => i < firstWrite), "every row lock before the first write");
});

test("8. concurrency with an M2b act on the same revision, in both orders: the second waits for the first's revision lock and is refused with unit_already_verified; exactly one proof is written", async () => {
  for (const first of ["observed", "document"]) {
    const f = await created(`g1b2_race_${first}`, { expected: "J/kg" });
    const cand = await candidate(W.tA, energyOf(f.name));
    const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let reached;
    const reachedP = new Promise((resolve) => { reached = resolve; });
    const doc = () => post(`/fields/${f.fieldId}/revisions/${f.revisionId}/unit-verification`, W.pa, { requestKey: key(), sourceUnit: "J/kg", evidenceRef: UNIT_REF });
    let firstCall;
    if (first === "observed") {
      observation.setObservedHoldForTests(async (_c, step) => { if (step === "before_writes") { reached(); await held; } });
      firstCall = tick(W.pa, f, tickBody(o));
    } else {
      verification.setFieldWriteHoldForTests(async () => { reached(); await held; });
      firstCall = doc();
    }
    await reachedP;
    observation.setObservedHoldForTests(null);
    verification.setFieldWriteHoldForTests(null);
    const secondCall = first === "observed" ? doc() : tick(W.pa, f, tickBody(o));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [a, b] = await Promise.all([firstCall, secondCall]);
    assert.ok([200, 201].includes(a.status), `${first} first: ${a.text}`);
    refused(b, 409, "unit_already_verified");
    const rev = await one(`select evidence_status, unit_observation_id, unit_evidence_ref from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
    if (first === "observed") assert.deepEqual([rev.evidence_status, rev.unit_evidence_ref !== null], ["source_stated", false]);
    else assert.deepEqual([rev.unit_observation_id, rev.unit_evidence_ref], [null, UNIT_REF]);
  }
});

test("9. concurrency with an Unbind of the session's binding (v65's order): a tick holding its locks makes the Unbind wait (or answer try_again), never a deadlock; a tick after the Unbind is the identical 404 (the session's team is no longer bound)", async () => {
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2, 3]) await link(t, n);
  const f = await created("g1b2_unbind", { expected: "J/kg" });
  const cand = await candidate(t, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const reachedP = new Promise((resolve) => { reached = resolve; });
  observation.setObservedHoldForTests(async (_c, step) => { if (step === "before_writes") { reached(); await held; } });
  const tickCall = tick(W.pa, f, tickBody(o));
  await reachedP;
  observation.setObservedHoldForTests(null);
  const unbind = api(`/../gpexe/connections/${t.connectionId}/bindings/${t.bindingId}/unbind`, { method: "POST", cookie: W.pa.cookie, body: { requestKey: key(), reason: "G1b-2 race.", expected: { teamId: t.teamId, sourceTeamId: t.sourceTeamId } } });
  await new Promise((r) => setTimeout(r, 500));
  release();
  const [ticked, unbound] = await Promise.all([tickCall, unbind]);
  assert.equal(ticked.status, 201, ticked.text);
  assert.equal(unbound.status, 200, unbound.text);
  // The Unbind went through once the tick released its locks: the binding has ended, so the same session is no longer
  // the team's (no active binding) - a comparison of it is the identical 404.
  assert.equal((await one(`select state from training_load.source_team_bindings where id = $1`, [t.bindingId])).state, "ended");
  const g = await created("g1b2_unbound", { expected: "J/kg" });
  const stored = (await one(`select raw_bundle from training_load.gpexe_import_candidates where id = $1`, [cand.id])).raw_bundle;
  for (const [id, values] of Object.entries(stored.details.full.players)) Object.assign(values, energyOf(g.name)(id));
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = $2 where id = $1`, [cand.id, stored]);
  assert.deepEqual(shape(await observationOf(W.pa, g, { candidateId: cand.id })), NOT_FOUND);
});

test("10. the log and the answers carry no athlete id; no value is logged", async () => {
  noAthleteId(responses.join("\n"), "every answer");
  noAthleteId(logLines.join("\n"), "every log line");
  for (const v of ["412.5", "455.25"]) assert.ok(!logLines.join("\n").includes(v), `${v} not logged`);
});

test("11. the club board after a tick (the Rukovodilac's addition): before route O a created field is not readable on the club's board (G2's guard: no value leaves the server); after it, the same column is a normal proven column - its values read and placeable", async () => {
  const f = await created("g1b2_board", { expected: "J/kg" });
  // The board chooses its pair over every column that can be placed: the session carries a value of every created
  // details field (the earlier tests proved some of them).
  const names = (await rows(`select substring(source_metric_key from 'details\\.players\\.(.*)') as n from training_load.source_metric_definitions where source_metric_key like 'details.players.g1b2%'`)).map((r) => r.n);
  // Each planted value carries a decimal point, so it can never be found inside a random UUID of the answer (a bare 7300
  // was: the flake of the 2b runs, the same class as the resolver's test 38).
  const own = { [ATHLETE(1)]: 7412.5, [ATHLETE(2)]: 7455.25, [ATHLETE(3)]: 7300.375 };
  const cand = await candidate(W.tA, (id) => Object.assign({}, ...names.map((n) => energyOf(n)(id)), { [f.name]: { unit: "energy", value: own[id] ?? 7000 } }));
  const board = async () => {
    const res = await get(`/board?${qs({ teamId: W.tA.teamId, candidateId: cand.id })}`, W.caA);
    const b = ok(res).board;
    return { col: b.columns.find((c) => c.fieldId === f.fieldId), text: res.text };
  };
  const before = await board();
  assert.ok(before.col, "the column is listed");
  assert.deepEqual([before.col.rawA, before.col.rawB, before.col.placeable, before.col.reason], [null, null, false, "field_not_confirmed"]);
  for (const v of ["7412.5", "7455.25", "7300.375"]) assert.ok(!before.text.includes(v), `${v} does not leave the server before the tick`);
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  ok(await tick(W.pa, f, tickBody(o)), 201);
  const after = await board();
  assert.deepEqual([after.col.unitProven, after.col.unit, after.col.displayRule, after.col.reason, after.col.placeable], [true, "J/kg", "as_sent", null, true], JSON.stringify(after.col));
  assert.ok(after.col.rawA !== null && after.col.rawB !== null, "its values are read");
});

test("12. what the comparison stands on is read again under the locks: a stored session changed, or an athlete renamed, between the comparison and the tick answers board_changed and writes nothing", async () => {
  const cases = [
    ["bundle", async (cand) => k.query(`begin; set local session_replication_role = replica; update training_load.gpexe_import_candidates set bundle_hash = encode(sha256(convert_to(bundle_hash, 'UTF8')), 'hex') where id = $1; commit;`.replace(/\$1/, `'${cand.id}'`))],
    ["name", async () => k.query(`update public.athletes a set display_name = display_name || ' (renamed)' from training_load.gpexe_athlete_links l where l.athlete_id = a.id and l.owner_team_id = $1 and l.gpexe_athlete_id = $2`, [W.tA.teamId, ATHLETE(1)])],
  ];
  for (const [label, change] of cases) {
    const f = await created(`g1b2_recheck_${label}`, { expected: "J/kg" });
    const cand = await candidate(W.tA, energyOf(f.name));
    const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
    observation.setObservedHoldForTests(async (_c, step) => { if (step === "before_locks") await change(cand); });
    let answer;
    try { answer = await tick(W.pa, f, tickBody(o)); } finally { observation.setObservedHoldForTests(null); }
    refused(answer, 409, "board_changed");
    const rev = await one(`select evidence_status, unit_observation_id from training_load.source_metric_definition_versions where id = $1`, [f.revisionId]);
    assert.deepEqual([rev.evidence_status, rev.unit_observation_id], ["unproven", null], label);
    if (label === "name") await k.query(`update public.athletes a set display_name = replace(display_name, ' (renamed)', '') from training_load.gpexe_athlete_links l where l.athlete_id = a.id and l.owner_team_id = $1 and l.gpexe_athlete_id = $2`, [W.tA.teamId, ATHLETE(1)]);
  }
});

test("13. rule (b) at the mapping (the code review's MEDIUM, G1b-3): a created details field proven by a document gets a mapping version only where its unit has exactly one GPEXE word - bpm (no word) is 409 unit_word_missing, J/kg (energy, energy_std) is 409 unit_word_ambiguous, nothing written; W/kg (power) is 201", async () => {
  for (const [unit, expect, code] of [["bpm", 409, "unit_word_missing"], ["J/kg", 409, "unit_word_ambiguous"], ["W/kg", 201]]) {
    const f = await created(`g1b2_word_${{ bpm: "bpm", "J/kg": "jkg", "W/kg": "wkg" }[unit]}`, { expected: unit });
    const proven = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/unit-verification`, W.pa, { requestKey: key(), sourceUnit: unit, evidenceRef: UNIT_REF });
    assert.ok([200, 201].includes(proven.status), proven.text);
    // The variable in the field's own unit where a token is a variable unit (no conversion needed), else J/kg.
    const variable = ok(await post("/variables", W.pa, { requestKey: key(), label: `Word rule ${uid()}`, unit: unit === "bpm" ? "J/kg" : unit, levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
    const mapping = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
    const res = await post(`/mappings/${mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false, conversionNote: unit === "bpm" ? "not the same unit" : undefined });
    const versions = (await one(`select count(*)::int n from training_load.source_metric_mapping_versions where mapping_id = $1`, [mapping.id])).n;
    if (expect === 409) {
      refused(res, 409, code);
      assert.equal(versions, 0, "nothing written");
    } else {
      ok(res, 201);
      assert.equal(versions, 1);
    }
  }
});

test("14. route O's lost COMMIT (the code review's MEDIUM): a rollback then a lost answer is 503 outcome_unknown with nothing written, and the same key then writes once; a COMMIT whose answer is lost is verified through the request record (one proof); its replay writes nothing; a failed read after the COMMIT still answers the write", async () => {
  const proofs = async (f) => (await one(`select count(*)::int n from training_load.source_metric_confirmations where source_metric_version_id = $1`, [f.revisionId])).n;
  const lost = (sql) => ({ fault: (client) => client.query(sql).then(() => { throw Object.assign(new Error("lost"), { code: "08006" }); }) });
  // A rollback, then the answer lost.
  const f1 = await created("g1b2_lost_rb", { expected: "J/kg" });
  const o1 = ok(await observationOf(W.pa, f1, { candidateId: (await candidate(W.tA, energyOf(f1.name))).id })).observation;
  const body1 = tickBody(o1);
  mappingService.setMappingCommitForTests(lost("rollback"));
  let unknown;
  try { unknown = await tick(W.pa, f1, body1); } finally { mappingService.setMappingCommitForTests(); }
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.requestKey], [503, "outcome_unknown", body1.requestKey], unknown.text);
  assert.equal(await proofs(f1), 0, "nothing written");
  ok(await tick(W.pa, f1, body1), 201);
  assert.equal(await proofs(f1), 1, "the same key then writes once");
  // A real COMMIT, then the answer lost.
  const f2 = await created("g1b2_lost_commit", { expected: "J/kg" });
  const o2 = ok(await observationOf(W.pa, f2, { candidateId: (await candidate(W.tA, energyOf(f2.name))).id })).observation;
  const body2 = tickBody(o2);
  mappingService.setMappingCommitForTests(lost("commit"));
  let verified;
  try { verified = await tick(W.pa, f2, body2); } finally { mappingService.setMappingCommitForTests(); }
  assert.ok([200, 201].includes(verified.status), verified.text);
  assert.equal(verified.body.commitConfirmation, "verified_after_commit_error");
  assert.equal(await proofs(f2), 1, "one proof");
  const replay = ok(await tick(W.pa, f2, body2));
  assert.equal(replay.replayed, true);
  assert.equal(await proofs(f2), 1, "the replay writes nothing");
  // A read that fails after the COMMIT.
  const f3 = await created("g1b2_lost_read", { expected: "J/kg" });
  const o3 = ok(await observationOf(W.pa, f3, { candidateId: (await candidate(W.tA, energyOf(f3.name))).id })).observation;
  mappingService.setMappingRereadFaultForTests(async () => { throw new Error("read broke"); });
  let read;
  try { read = await tick(W.pa, f3, tickBody(o3)); } finally { mappingService.setMappingRereadFaultForTests(null); }
  assert.deepEqual([read.status, read.body.readError], [201, true], read.text);
  assert.equal(await proofs(f3), 1);
});

test("15. route 8 without a session (the code review's LOWs): a pair without candidateId is 400 invalid_query; a newest stored session the plan cannot walk is passed by (200 on an older one), never a 500 for the team", async () => {
  const f = await created("g1b2_default_loop", { expected: "J/kg" });
  for (const bad of [`teamId=${W.tA.teamId}&pair=1`, `teamId=${W.tA.teamId}&pairs=0,1`]) {
    const res = await get(`/fields/${f.fieldId}/observation?${bad}`, W.pa);
    refused(res, 400, "invalid_query");
  }
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2, 3]) await link(t, n);
  const good = await candidate(t, energyOf(f.name), { startedAt: "2026-09-10T18:00:00Z" });
  const broken = await candidate(t, energyOf(f.name), { startedAt: "2026-09-20T18:00:00Z" });
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = jsonb_set(raw_bundle, '{details,full,players}', '5'::jsonb) where id = $1`, [broken.id]);
  const answer = ok(await observationOf(W.pa, f, { teamId: t.teamId })).observation;
  assert.equal(answer.session.candidateId, good.id);
});

test("16. G1b-3, the unit word at activation and at a club's copy (the code review's LOW): a draft version whose field's proven unit has no GPEXE word (bpm, set under the replica role) is refused at A1 with 409 unit_word_missing and stays as it was; copiedMappingRefusal names the field with unit_word_missing", async () => {
  const variable = ok(await post("/variables", W.pa, { requestKey: key(), label: `Word guard ${uid()}`, unit: "W/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
  const f = await created("g1b3_guard_wkg", { expected: "W/kg" });
  const proven = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/unit-verification`, W.pa, { requestKey: key(), sourceUnit: "W/kg", evidenceRef: UNIT_REF });
  assert.ok([200, 201].includes(proven.status), proven.text);
  const meant = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/meaning-verification`, W.pa, { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
  assert.ok([200, 201].includes(meant.status), meant.text);
  const mapping = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
  const version = ok(await post(`/mappings/${mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false }), 201).version;
  ok(await post(`/mappings/${mapping.id}/versions/${version.id}/submit`, W.pa, { requestKey: key() }));
  // A version written before the rule (or by hand): its field's proven unit has no GPEXE word.
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.source_metric_definition_versions set source_unit = 'bpm' where id = $1`, [f.revisionId]);
  await k.query(`update training_load.source_metric_mapping_versions set source_unit = 'bpm', target_unit = 'bpm' where id = $1`, [version.id]);
  await k.query("commit");
  const before = await one(`select status from training_load.source_metric_mapping_versions where id = $1`, [version.id]);
  refused(await post(`/mappings/${mapping.id}/versions/${version.id}/activate`, W.pa, { requestKey: key(), expectedActiveVersionId: null }), 409, "unit_word_missing");
  assert.deepEqual(await one(`select status from training_load.source_metric_mapping_versions where id = $1`, [version.id]), before, "the version stays as it was");
  const client = await appPool.connect();
  try {
    const named = await mappingService.copiedMappingRefusal(client, [{ id: version.id, source_metric_definition_id: f.fieldId, source_metric_version_id: f.revisionId }], {
      fields: new Map([[f.fieldId, "active"]]), revisions: new Map([[f.revisionId, { state: "active", source_unit: "bpm" }]]),
    });
    assert.deepEqual(named, { sourceMetricId: f.fieldId, code: "unit_word_missing" });
    // The same version with the field's unit set to a shared one (J/kg) and no proven word: ambiguous.
    await k.query("begin");
    await k.query("set local session_replication_role = replica");
    await k.query(`update training_load.source_metric_definition_versions set source_unit = 'J/kg' where id = $1`, [f.revisionId]);
    await k.query(`update training_load.source_metric_mapping_versions set source_unit = 'J/kg', target_unit = 'J/kg' where id = $1`, [version.id]);
    await k.query("commit");
    const ambiguous = await mappingService.copiedMappingRefusal(client, [{ id: version.id, source_metric_definition_id: f.fieldId, source_metric_version_id: f.revisionId }], {
      fields: new Map([[f.fieldId, "active"]]), revisions: new Map([[f.revisionId, { state: "active", source_unit: "J/kg" }]]),
    });
    assert.deepEqual(ambiguous, { sourceMetricId: f.fieldId, code: "unit_word_ambiguous" });
  } finally {
    client.release();
  }
});

test("17. route O against an Unbind that comes first (the code review's LOW): the Unbind holds the binding; the tick waits on the binding lock and, once the Unbind commits, is refused with binding_not_active; nothing is written", async () => {
  const connections = await import("../src/sourceConnectionService.js");
  const t = await gpexeTeam(W.clubA);
  for (const n of [1, 2, 3]) await link(t, n);
  const f = await created("g1b3_unbind_first", { expected: "J/kg" });
  const cand = await candidate(t, energyOf(f.name));
  const o = ok(await observationOf(W.pa, f, { candidateId: cand.id })).observation;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const reachedP = new Promise((resolve) => { reached = resolve; });
  connections.setSourceUnbindHoldForTests(async () => { reached(); await held; });
  let unbind;
  try {
    unbind = api(`/../gpexe/connections/${t.connectionId}/bindings/${t.bindingId}/unbind`, { method: "POST", cookie: W.pa.cookie, body: { requestKey: key(), reason: "G1b-3 race.", expected: { teamId: t.teamId, sourceTeamId: t.sourceTeamId } } });
    await reachedP;
  } finally {
    connections.setSourceUnbindHoldForTests(null);
  }
  const tickCall = tick(W.pa, f, tickBody(o));
  // The tick is seen waiting on a lock (the binding the Unbind holds) before the Unbind is let go (the code review's LOW).
  let waited = false;
  for (let i = 0; i < 100 && !waited; i += 1) {
    waited = (await one(`select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%source_team_bindings%'`)).n > 0;
    if (!waited) await new Promise((r) => setTimeout(r, 50));
  }
  release();
  assert.ok(waited, "the tick waited on the binding lock");
  const [unbound, ticked] = await Promise.all([unbind, tickCall]);
  assert.equal(unbound.status, 200, unbound.text);
  refused(ticked, 409, "binding_not_active");
  assert.equal((await one(`select count(*)::int n from training_load.source_metric_confirmations where source_metric_version_id = $1`, [f.revisionId])).n, 0, "nothing written");
});

test("18. G1b-3, the board (the Independent's LOW-2): a created details field proven by a document in J/kg is listed on the club's board with the reason unit_word_ambiguous, carries no value and is not placeable; a save that names it anyway is refused 409 unit_word_ambiguous and writes nothing", async () => {
  const f = await created("g1b2_board_doc", { expected: "J/kg" });
  for (const act of ["unit-verification", "meaning-verification"]) {
    const res = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/${act}`, W.pa, act === "unit-verification" ? { requestKey: key(), sourceUnit: "J/kg", evidenceRef: UNIT_REF } : { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
    assert.ok([200, 201].includes(res.status), res.text);
  }
  const names = (await rows(`select substring(source_metric_key from 'details\\.players\\.(.*)') as n from training_load.source_metric_definitions where source_metric_key like 'details.players.g1b2%'`)).map((r) => r.n);
  const cand = await candidate(W.tA, (id) => Object.assign({}, ...names.map((n) => energyOf(n)(id))));
  const res = await get(`/board?${qs({ teamId: W.tA.teamId, candidateId: cand.id })}`, W.caA);
  const b = ok(res).board;
  const col = b.columns.find((c) => c.fieldId === f.fieldId);
  assert.deepEqual([col?.reason, col?.placeable, col?.rawA ?? null, col?.rawB ?? null], ["unit_word_ambiguous", false, null, null], JSON.stringify(col));
  const variable = ok(await post("/variables", W.caA, { requestKey: key(), label: `Board word ${uid()}`, unit: "J/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
  const versions = async () => (await one(`select count(*)::int n from training_load.source_metric_mapping_versions where source_metric_definition_id = $1`, [f.fieldId])).n;
  const saved = await post("/confirmations", W.caA, {
    requestKey: key(), teamId: W.tA.teamId, candidateId: cand.id, pair: b.pair.index, rows: [{
      kind: "new", fieldId: f.fieldId, targetId: variable.id, expectedTargetVersionId: variable.currentVersionId ?? variable.versionId ?? crypto.randomUUID(),
      displayUnit: "J/kg", placementHash: "0".repeat(64), requirement: "required", replaces: [], checked: true,
    }],
  });
  refused(saved, 409, "unit_word_ambiguous");
  assert.equal(await versions(), 0, "nothing written");
});

test("19. G1b-3, the way out of unit_word_ambiguous is one the server takes (the Rukovodilac's point): a created field proven by a document in J/kg gets no mapping version, and route 8 refuses to compare it (unit_already_verified); the refusal's own steps - retire the revision (L5), add a new unproven revision (L1) and activate it (L3), then compare it with GPEXE (routes 8 and O) - prove the exact word, and the version is then created", async () => {
  const f = await created("g1b2_wayout", { expected: "J/kg" });
  for (const act of ["unit-verification", "meaning-verification"]) {
    const res = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/${act}`, W.pa, act === "unit-verification" ? { requestKey: key(), sourceUnit: "J/kg", evidenceRef: UNIT_REF } : { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
    assert.ok([200, 201].includes(res.status), res.text);
  }
  const variable = ok(await post("/variables", W.pa, { requestKey: key(), label: `Way out ${uid()}`, unit: "J/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
  const mapping = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
  const versionOf = (revisionId) => post(`/mappings/${mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: revisionId, appliesToSession: true, appliesToDrill: false });
  const refusedVersion = refused(await versionOf(f.revisionId), 409, "unit_word_ambiguous");
  assert.match(refusedVersion.message, /Retire this revision, add a new unproven revision of the field and activate it, then compare it with GPEXE/);
  const cand = await candidate(W.tA, energyOf(f.name));
  // Comparing the document-proven revision itself is refused - the sentence never sends the admin there.
  refused(await observationOf(W.pa, f, { candidateId: cand.id }), 409, "unit_already_verified");
  // The sentence's steps.
  ok(await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/retire`, W.pa, { requestKey: key(), reason: "The word is proved on a new revision.", expectedState: "active" }));
  const next = ok(await post(`/fields/${f.fieldId}/revisions`, W.pa, { requestKey: key(), valueShape: "unit_value_object", parameterKind: "none", supportsSession: true, supportsDrill: false, expectedSourceUnit: "J/kg" }), 201);
  const r2 = next.revision?.id ?? next.revisionId;
  assert.ok(r2, JSON.stringify(next));
  ok(await post(`/fields/${f.fieldId}/revisions/${r2}/activate`, W.pa, { requestKey: key() }));
  const g = { ...f, revisionId: r2 };
  const o = ok(await observationOf(W.pa, g, { candidateId: cand.id })).observation;
  assert.deepEqual([o.confirmable, o.word, o.unit], [true, "energy", "J/kg"]);
  ok(await tick(W.pa, g, tickBody(o)), 201);
  ok(await versionOf(r2), 201);
});

test("20. G1b-3 (the code review's HIGH): a club's admin is never told to take the platform's steps - its createVersion of a club mapping of a document-proven J/kg field is 409 unit_word_ambiguous asking a platform administrator, nothing written; the platform admin's answer names the steps", async () => {
  const f = await created("g1b2_club_audience", { expected: "J/kg" });
  for (const act of ["unit-verification", "meaning-verification"]) {
    const res = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/${act}`, W.pa, act === "unit-verification" ? { requestKey: key(), sourceUnit: "J/kg", evidenceRef: UNIT_REF } : { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
    assert.ok([200, 201].includes(res.status), res.text);
  }
  for (const [who, steps] of [[W.caA, false], [W.pa, true]]) {
    const variable = ok(await post("/variables", who, { requestKey: key(), label: `Audience ${uid()}`, unit: "J/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
    const mapping = ok(await post("/mappings", who, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
    const body = refused(await post(`/mappings/${mapping.id}/versions`, who, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false }), 409, "unit_word_ambiguous");
    if (steps) assert.match(body.message, /Retire this revision/);
    else {
      assert.equal(body.message, "A document cannot tell which GPEXE word this unit is. Ask a platform administrator to compare this field with GPEXE.");
    }
    assert.equal((await one(`select count(*)::int n from training_load.source_metric_mapping_versions where mapping_id = $1`, [mapping.id])).n, 0, "nothing written");
  }
});

test("21. G1b-3, S1 (the code review's MEDIUM): an active version from before the exact-word rule (its created field proven by a document in J/kg, set under the replica role) is not switched on for a team - 409 unit_word_ambiguous, no activation", async () => {
  const t = await gpexeTeam(W.clubA);
  const variable = ok(await post("/variables", W.pa, { requestKey: key(), label: `S1 word ${uid()}`, unit: "W/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
  const f = await created("g1b3_s1_wkg", { expected: "W/kg" });
  for (const act of ["unit-verification", "meaning-verification"]) {
    const res = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/${act}`, W.pa, act === "unit-verification" ? { requestKey: key(), sourceUnit: "W/kg", evidenceRef: UNIT_REF } : { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
    assert.ok([200, 201].includes(res.status), res.text);
  }
  const mapping = ok(await post("/mappings", W.pa, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
  const version = ok(await post(`/mappings/${mapping.id}/versions`, W.pa, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false }), 201).version;
  ok(await post(`/mappings/${mapping.id}/versions/${version.id}/submit`, W.pa, { requestKey: key() }));
  ok(await post(`/mappings/${mapping.id}/versions/${version.id}/activate`, W.pa, { requestKey: key(), expectedActiveVersionId: null }));
  await k.query("begin");
  await k.query("set local session_replication_role = replica");
  await k.query(`update training_load.source_metric_definition_versions set source_unit = 'J/kg' where id = $1`, [f.revisionId]);
  await k.query(`update training_load.source_metric_mapping_versions set source_unit = 'J/kg', target_unit = 'J/kg' where id = $1`, [version.id]);
  await k.query("commit");
  const res = await post("/activations", W.pa, { requestKey: key(), mappingId: mapping.id, versionId: version.id, bindings: [{ bindingId: t.bindingId, requirement: "optional" }], reason: "G1b-3 S1 word check." });
  refused(res, 409, "unit_word_ambiguous");
  assert.equal((await one(`select count(*)::int n from training_load.source_metric_mapping_activations where mapping_version_id = $1`, [version.id])).n, 0, "no activation");
});

test("22. the inventory's zone thresholds come from the newest stored session of each active binding: one set while they agree, 'differ' once a team's newest session carries another set; a club never gets them", async () => {
  const zone = async (who) => (await get(`/field-inventory?endpoint=details.session`, who)).body.zoneThresholds;
  const t = await gpexeTeam(W.clubA);
  await candidate(t, () => ({}), { startedAt: "2026-10-01T18:00:00Z" });
  await candidate(W.tA, () => ({}), { startedAt: "2026-10-01T18:00:00Z" });
  assert.deepEqual(await zone(W.pa), { power: { values: [20, 25, 60, 75] }, speed: { values: [5.5, 7] }, acceleration: { value: 2.5, duration: 0.3 }, deceleration: { value: -2.5, duration: 0.3 }, asOf: "2026-10-01T18:00:00.000Z" }, "the day of the newest session the limits come from");
  // The newer session of one team carries another power set.
  const newer = await candidate(t, () => ({}), { startedAt: "2026-10-02T18:00:00Z" });
  const stored = (await one(`select raw_bundle from training_load.gpexe_import_candidates where id = $1`, [newer.id])).raw_bundle;
  stored.teamThresholds.power_thresholds = [20, 25, 60, 80];
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = $2 where id = $1`, [newer.id, stored]);
  assert.deepEqual(await zone(W.pa), { power: { differ: true }, speed: { values: [5.5, 7] }, acceleration: { value: 2.5, duration: 0.3 }, deceleration: { value: -2.5, duration: 0.3 }, asOf: "2026-10-02T18:00:00.000Z" });
  // v80 step A: an event setting that differs (0.5 s against 0.3 s) is only said to differ, as a zone set is.
  stored.teamThresholds.acceleration_events_duration = 0.5;
  await k.query(`update training_load.gpexe_import_candidates set raw_bundle = $2 where id = $1`, [newer.id, stored]);
  assert.deepEqual(await zone(W.pa), { power: { differ: true }, speed: { values: [5.5, 7] }, acceleration: { differ: true }, deceleration: { value: -2.5, duration: 0.3 }, asOf: "2026-10-02T18:00:00.000Z" });
  assert.equal(await zone(W.caA), undefined, "a club never gets the team thresholds (P1)");
});

test("23. #601's LOW-1: a platform admin working in a club's workspace is told to switch to the platform workspace (never to ask a platform administrator); a club's admin is told to ask one", async () => {
  const f = await created("g1b2_pa_in_club", { expected: "J/kg" });
  for (const act of ["unit-verification", "meaning-verification"]) {
    const res = await post(`/fields/${f.fieldId}/revisions/${f.revisionId}/${act}`, W.pa, act === "unit-verification" ? { requestKey: key(), sourceUnit: "J/kg", evidenceRef: UNIT_REF } : { requestKey: key(), evidenceRef: "docs/ai/test-evidence.md#meaning-of-the-field" });
    assert.ok([200, 201].includes(res.status), res.text);
  }
  for (const [who, expected] of [[W.paClub, /^A document cannot tell which GPEXE word this unit is\. Switch to the platform workspace, then retire this revision/], [W.caA, /^A document cannot tell which GPEXE word this unit is\. Ask a platform administrator/]]) {
    const variable = ok(await post("/variables", who, { requestKey: key(), label: `Who ${uid()}`, unit: "J/kg", levels: ["session"], dailyAggregationMethod: "sum" }), 201).variable;
    const mapping = ok(await post("/mappings", who, { requestKey: key(), sourceMetricId: f.fieldId, metricDefinitionId: variable.id }), 201).mapping;
    const body = refused(await post(`/mappings/${mapping.id}/versions`, who, { requestKey: key(), sourceRevisionId: f.revisionId, appliesToSession: true, appliesToDrill: false }), 409, "unit_word_ambiguous");
    assert.match(body.message, expected);
  }
});

test("24 (the Rukovodilac, 2026-11-18): route 8 carries the compared session's own team zone limits, the range a numbered zone is expected to cover", async () => {
  const f = await created("g1b2_limits", { expected: "J/kg" });
  const cand = await candidate(W.tA, energyOf(f.name));
  const stored = (await one(`select raw_bundle from training_load.gpexe_import_candidates where id = $1`, [cand.id])).raw_bundle;
  const body = (await observationOf(W.pa, f, { candidateId: cand.id })).body;
  const t = stored.teamThresholds;
  assert.deepEqual(body.observation.zoneThresholds, {
    power: t.power_thresholds, speed: t.speed_thresholds,
    // v80 step A: the team's event settings of the same set.
    acceleration: { value: t.acceleration_events_threshold, duration: t.acceleration_events_duration },
    deceleration: { value: t.deceleration_events_threshold, duration: t.deceleration_events_duration },
  });
});
