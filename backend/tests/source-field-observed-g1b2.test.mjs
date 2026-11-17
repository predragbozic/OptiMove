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
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "g1b2" });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
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
    ["no word", null, null, "word_unknown"],
    ["another unit (two connections)", "power", "J/kg", "expected_unit_differs"],
  ]) {
    const g = await created(`g1b2_${label.replace(/[^a-z]/g, "")}_${uid()}`, { expected });
    const c = await candidate(W.tA, energyOf(g.name, word));
    const read = ok(await observationOf(W.pa, g, { candidateId: c.id, ...(label === "disagree" ? { pairs: "0,1" } : {}) })).observation;
    assert.deepEqual([read.confirmable, read.reason], [false, reason], label);
    const t = refused(await tick(W.pa, g, tickBody(read)), 409, "unit_not_stated");
    assert.deepEqual(t.current, { reason }, label);
    assert.deepEqual(await before(g), [0, "unproven"], label);
  }

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
  const listed = ok(await get(`/fields/${f.fieldId}/observations`, W.pa)).observations;
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
