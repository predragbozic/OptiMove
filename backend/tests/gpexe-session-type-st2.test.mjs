// ST-2 (docs/ai/session-type-plan.md sections 4 and 15): OptiMove decides the session type of an import, not the source.
// On disposable optimove_tests_gpexe_* databases only; no GPEXE request, no credential (marker values of the fake
// source only).
//   1  the mapper refuses no category: the plan carries the type it is given, or null
//   2  a known category: the team's suggestion (the built-in pair for a team without a row) is in the preview, the hash
//      and the list; the approval needs no choice and writes that type
//   3  an unknown category: pending with session_type_required (blocker, first reason, state "needs", the calendar the
//      same); an approval and a batch item without a choice are refused, nothing written
//   4  the choice: the preview route with activityTypeKey stores nothing; two types two hashes; the approval with the
//      choice and its subsetHash imports with that type; another type than the previewed one is preview_changed
//   5  the team's suggestion follows the choice, for this team and category only; the next session needs no choice
//   6  validation: a malformed key 400 before any lock; a key without subsetHash 400
//   7  a type that is not offered - unknown, another club's, archived - is one 409 session_type_not_offered, body equal
//   8  a stale choice (the type archived after the choice preview): 409, nothing written, nothing stored
//   9  athletes left out and a type together: one hash; the approval row keeps the set and the hash (v59's CHECK)
//  10  a session already imported keeps its type: imported_session in the preview, another type is session_type_fixed
//  11  the batch: one choice per item; a stale choice stops alone; the body's shape
//  12  the suggestion's write fails or is refused: the import stays committed, the answer is the import's
//  13  a lost COMMIT with a choice: verified, and the suggestion still follows
//  14  the SQL order of an approval with a choice: the type row's read comes after the rights lock and before the
//      import itself; the suggestion is written on another connection after the COMMIT
//  15  an archived suggestion is no suggestion: the next review asks for a type
//  16  the direct import path (the CLI's) never writes a session without a type
//  17  two sessions of one category with the same chosen type import in one batch (a choice's hash does not depend on
//      the suggestion the first approval rewrites)
//  18  another club's type is never locked or waited on
//  19  a null key is no choice; a category the suggestion table cannot hold
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { PLANTED, previewAthletes, previewBundle } from "./support/preview-bundles.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const DAY = "2026-09-14";
const MATCH = "OFFICIAL MATCH";

let db;
let admin;
let server;
let apiBase;
let service;
let connections;
let resolver;
let sessionType;
let mapper;
let writer;
let createSession;
let appPool;
let src;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "session_type_st2" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  process.env.SOURCE_CREDENTIAL_KEYS = (await import("../src/sourceCredentialCrypto.js")).generateKeyEntry(1);
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  connections = await import("../src/sourceConnectionService.js");
  resolver = await import("../src/sourceImportCredentialResolver.js");
  sessionType = await import("../src/gpexeSessionTypeSuggestion.js");
  mapper = await import("../src/gpexeImportMapper.js");
  writer = await import("../src/gpexeImportWriter.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  service.setRecomputeIntervalForTests(0);
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  service?.setRecomputeIntervalForTests(null);
  service?.setApprovalCommitForTests(null);
  service?.setApprovalObserver(null);
  sessionType?.setSuggestionWriteFaultForTests(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED; else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
});

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text, headers: res.headers };
}
const api = (path, options) => call(`/training-load${path}`, options);
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

async function user(label, { platform = false, team = null, club = null } = {}) {
  const id = (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label.replace(/\s+/g, "-")}-${crypto.randomBytes(4).toString("hex")}@test.local`, label])).rows[0].id;
  if (platform) await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (team) await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, team]);
  if (club) await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, club]);
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [id, platform ? "platform" : club ? "club" : "team", platform ? null : club ?? team]);
  return { id: String(id), cookie: `optimove_session=${await createSession(id)}` };
}

const athleteId = (n) => `${PLANTED.athletePrefix}${String(n).padStart(2, "0")}`;
let nextSession = 48324900;
let nextSourceTeam = 9801;

// A team bound through the real routes AFTER v85 ran (so it has no seeded suggestion row), athletes 1 to 3 linked
// (athlete 4 is left out by the importer: two tracks).
async function team() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A01", "A02", "A03", "A04"] });
  const sourceTeamId = String(nextSourceTeam++);
  const padmin = await user("platform admin", { platform: true });
  const coach = await user("coach", { team: org.teamId });
  assert.equal((await api(`/gpexe/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const bound = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bound.bindingId, { only: null });
  for (const n of [1, 2, 3]) {
    const r = await api(`/gpexe/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: athleteId(n), athleteId: org.athleteIds[n - 1] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return { ...org, sourceTeamId, padmin, coach, ...bound };
}

// One check of the team's source for the given bundles; the candidate of each session, newest version.
async function check(t, bundles) {
  src.serve(t.sourceTeamId, bundles);
  const started = await api(`/gpexe/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: { from: DAY, to: DAY } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 400; i += 1) {
    const r = await api(`/gpexe/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.padmin.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return r.body.check;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the check did not finish");
}
// clean: only the three athletes the import keeps (no two-track athlete), so nothing but the session type can keep the
// session out of Ready.
const bundle = (t, { category = "FULL TRAINING", clean = false, team: _team, ...rest } = {}) => previewBundle({
  gpexeTeamId: Number(t.sourceTeamId), sessionId: nextSession++, category, ...(clean ? { athletes: previewAthletes().slice(0, 3) } : {}), ...rest,
});
const candidateOf = async (t, b) => (await q(
  `select * from training_load.gpexe_import_candidates where owner_team_id = $1 and gpexe_team_session_id = $2 and status <> 'superseded'
    order by first_seen_at desc limit 1`, [t.teamId, String(b.teamSession.id)]))[0];
const rowOf = async (id) => (await q(`select * from training_load.gpexe_import_candidates where id = $1`, [id]))[0];
async function world(options = {}) {
  const t = options.team ?? await team();
  const b = bundle(t, options);
  await check(t, [b]);
  return { t, b, c: await candidateOf(t, b) };
}
const listed = async (t, c, cookie = t.padmin.cookie) => (await api(`/gpexe/teams/${t.teamId}/candidates`, { cookie })).body.candidates.find((x) => x.id === c.id);
const choicePreview = (t, candidateId, body, cookie = t.padmin.cookie) =>
  api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/preview`, { method: "POST", cookie, body });
async function approve(t, candidateId, body, cookie = t.padmin.cookie) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/candidates/${candidateId}/approve`, { method: "POST", cookie, body });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
async function batch(t, body, cookie = t.padmin.cookie) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/gpexe/teams/${t.teamId}/imports`, { method: "POST", cookie, body });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
// The choice preview of one type, then the approval with it.
async function approveWithType(t, c, activityTypeKey, cookie = t.padmin.cookie) {
  const p = await choicePreview(t, c.id, { activityTypeKey }, cookie);
  assert.equal(p.status, 200, JSON.stringify(p.body).slice(0, 300));
  return approve(t, c.id, { previewHash: p.body.subset.previewHash, subsetHash: p.body.subset.subsetHash, activityTypeKey }, cookie);
}
const written = async (teamId) => JSON.stringify((await q(
  `select (select count(*) from training_load.metric_events where owner_team_id = $1) as events,
          (select count(*) from training.activities where owner_team_id = $1) as activities,
          (select count(*) from training_load.gpexe_import_approvals where owner_team_id = $1) as approvals`, [teamId]))[0]);
const NOTHING = JSON.stringify({ events: "0", activities: "0", approvals: "0" });
const activityTypes = async (teamId) => (await q(`select activity_type_key from training.activities where owner_team_id = $1 order by created_at`, [teamId])).map((r) => r.activity_type_key);
const suggestions = async (teamId) => q(
  `select category_name, activity_type_key, set_by_user_id, seeded from training_load.source_session_types where owner_team_id = $1 order by category_name`, [teamId]);
// A club's own session type, made through the ST-1 route by that club's admin.
async function clubType(clubId, label) {
  const clubAdmin = await user("club admin", { club: clubId });
  const made = await call(`/training-activity/session-types`, { method: "POST", cookie: clubAdmin.cookie, body: { requestKey: crypto.randomUUID(), label } });
  assert.equal(made.status, 200, made.text);
  return { key: made.body.type.key, clubAdmin };
}
const archive = (type) => call(`/training-activity/session-types/${type.key}/archive`, { method: "POST", cookie: type.clubAdmin.cookie, body: { requestKey: crypto.randomUUID() } });

test("1. the mapper refuses no category: the plan carries the type it is given, or null, and the source's category", () => {
  const b = previewBundle({ gpexeTeamId: 9700, category: MATCH });
  const plain = mapper.buildGpexeImportPlan(b, { metricSpecs: [] });
  assert.deepEqual([plain.event.activityTypeKey, plain.event.categoryName], [null, MATCH]);
  assert.match(plain.event.name, /^GPEXE OFFICIAL MATCH /);
  const typed = mapper.buildGpexeImportPlan(b, { metricSpecs: [], activityTypeKey: "match" });
  assert.equal(typed.event.activityTypeKey, "match");
  const unnamed = mapper.buildGpexeImportPlan({ ...b, teamSession: { ...b.teamSession, category_name: null } }, { metricSpecs: [] });
  assert.deepEqual([unnamed.event.activityTypeKey, unnamed.event.categoryName], [null, null]);
  assert.match(unnamed.event.name, /^GPEXE session /);
});

test("2. a known category: the suggestion is in the preview, its hash and the list; the approval needs no choice and writes that type", async () => {
  const { t, c } = await world({ clean: true });
  assert.deepEqual(await suggestions(t.teamId), [], "the team was bound after v85: no suggestion row, the built-in pair applies");
  assert.equal(c.status, "pending");
  assert.deepEqual([c.preview.session.activityTypeKey, c.preview.session.activityTypeSource], ["training_session", "team_suggestion"]);
  const row = await listed(t, c);
  assert.equal(row.suggestedActivityTypeKey, "training_session");
  assert.ok(!row.approvalBlockers.includes("session_type_required"));
  assert.ok(!row.reasons.some((r) => r.code === "session_type_required"));
  assert.equal(row.state, "ready");
  const done = await approve(t, c.id, { previewHash: c.preview_hash });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual([done.body.import.activityTypeKey, done.body.import.activityTypeSource], ["training_session", "team_suggestion"]);
  assert.deepEqual(await activityTypes(t.teamId), ["training_session"]);
  assert.deepEqual(await suggestions(t.teamId), [], "a suggestion that was followed writes nothing");
});

test("3. an unknown category waits for a type: pending, session_type_required in the blockers and first in the reasons, state needs; an approval or a batch item without a choice is refused, nothing written", async () => {
  const { t, c } = await world({ category: MATCH, clean: true });
  assert.equal(c.status, "pending", "never blocked as an unsupported category");
  assert.equal(c.preview.status, "ready", "the check-time preview ran without a type");
  assert.deepEqual([c.preview.session.activityTypeKey, c.preview.session.activityTypeSource, c.preview.session.categoryName], [null, "none", MATCH]);
  const row = await listed(t, c);
  assert.ok(row.approvalBlockers.includes("session_type_required"));
  assert.deepEqual(row.reasons, [{ code: "session_type_required", count: 1 }], "the one thing that keeps it out of Ready");
  assert.deepEqual([row.state, row.blockedCode, row.suggestedActivityTypeKey, row.sessionType], ["needs", null, null, MATCH]);
  const asCoach = await listed(t, c, t.coach.cookie);
  assert.deepEqual([asCoach.state, asCoach.reasons[0]?.code], ["needs", "session_type_required"], "the same for a coach");
  const calendar = await api(`/gpexe/teams/${t.teamId}/calendar?from=${DAY}&to=${DAY}`, { cookie: t.padmin.cookie });
  assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
  assert.deepEqual(calendar.body.days.map((d) => d.counts), [{ needs: 1, ready: 0, imported: 0, out: 0 }], "the calendar's trimmed preview gives the same state");
  const refused = await approve(t, c.id, { previewHash: c.preview_hash });
  assert.deepEqual([refused.status, refused.body.error], [409, "session_type_required"], JSON.stringify(refused.body));
  const inBatch = await batch(t, { candidateIds: [c.id], previewHashes: { [c.id]: c.preview_hash } });
  assert.equal(inBatch.status, 200, JSON.stringify(inBatch.body));
  assert.deepEqual([inBatch.body.results[0].outcome, inBatch.body.results[0].code], ["refused", "session_type_required"]);
  assert.equal(await written(t.teamId), NOTHING);
  assert.deepEqual(await rowOf(c.id), c, "the candidate is byte for byte as the check left it");
});

test("4. the choice: its preview stores nothing; two types give two hashes; the approval with the choice and its subsetHash imports with that type; another type than the previewed one is preview_changed", async () => {
  const { t, c } = await world({ category: MATCH });
  const asMatch = await choicePreview(t, c.id, { activityTypeKey: "match" });
  assert.equal(asMatch.status, 200, JSON.stringify(asMatch.body).slice(0, 300));
  assert.equal(asMatch.headers.get("cache-control"), "no-store");
  const s = asMatch.body.subset;
  assert.deepEqual([s.activityTypeKey, s.excludedAthleteIds, s.previewHash], ["match", [], c.preview_hash]);
  assert.deepEqual([s.preview.session.activityTypeKey, s.preview.session.activityTypeSource], ["match", "choice"]);
  assert.notEqual(s.subsetHash, c.preview_hash);
  const again = await choicePreview(t, c.id, { activityTypeKey: "match" });
  assert.equal(again.body.subset.subsetHash, s.subsetHash, "the same choice, the same hash");
  const asFriendly = await choicePreview(t, c.id, { activityTypeKey: "friendly_match" });
  assert.notEqual(asFriendly.body.subset.subsetHash, s.subsetHash, "two types, two hashes");
  assert.deepEqual(await rowOf(c.id), c, "a choice preview stores nothing");
  assert.equal(await written(t.teamId), NOTHING);
  // The previewed type's hash with another type: the recomputed preview differs, nothing is written or stored.
  const swapped = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: s.subsetHash, activityTypeKey: "friendly_match" });
  assert.deepEqual([swapped.status, swapped.body.error], [409, "preview_changed"], JSON.stringify(swapped.body).slice(0, 300));
  assert.deepEqual([swapped.body.subset.activityTypeKey, swapped.body.subset.subsetHash], ["friendly_match", asFriendly.body.subset.subsetHash]);
  // The stored (full) hash is never the proof of a choice.
  const withFull = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: c.preview_hash, activityTypeKey: "match" });
  assert.deepEqual([withFull.status, withFull.body.error], [409, "preview_changed"]);
  assert.equal(await written(t.teamId), NOTHING);
  assert.deepEqual(await rowOf(c.id), c, "a refused choice stores no refreshed preview");
  const done = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: s.subsetHash, activityTypeKey: "match" });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual([done.body.import.activityTypeKey, done.body.import.activityTypeSource], ["match", "choice"]);
  assert.deepEqual(await activityTypes(t.teamId), ["match"]);
  const approval = (await q(`select preview_hash, subset_hash, excluded_athlete_ids from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0];
  assert.deepEqual(approval, { preview_hash: c.preview_hash, subset_hash: null, excluded_athlete_ids: [] },
    "v59 pairs subset_hash with athletes left out: a type chosen alone stores none (the type is on the activity)");
  assert.equal(done.body.approval.subsetHash, null);
});

test("5. the team's suggestion follows the choice, for this team and category only; the next session of that category needs no choice", async () => {
  const first = await world({ category: MATCH });
  const other = await world({ category: MATCH });
  const done = await approveWithType(first.t, first.c, "match");
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual(await suggestions(first.t.teamId), [{ category_name: MATCH, activity_type_key: "match", set_by_user_id: first.t.padmin.id, seeded: false }]);
  assert.deepEqual(await suggestions(other.t.teamId), [], "another team's suggestion is untouched");
  const next = await world({ team: first.t, category: MATCH });
  assert.deepEqual([next.c.preview.session.activityTypeKey, next.c.preview.session.activityTypeSource], ["match", "team_suggestion"]);
  assert.ok(!(await listed(first.t, next.c)).approvalBlockers.includes("session_type_required"));
  // The coach chooses another type for it: the suggestion is replaced, by that approver.
  const changed = await approveWithType(first.t, next.c, "friendly_match");
  assert.equal(changed.status, 200, JSON.stringify(changed.body).slice(0, 300));
  assert.deepEqual((await suggestions(first.t.teamId)).map((r) => r.activity_type_key), ["friendly_match"]);
  assert.deepEqual(await activityTypes(first.t.teamId), ["match", "friendly_match"]);
  assert.equal((await rowOf(other.c.id)).preview.session.activityTypeSource, "none");
});

test("6. validation before any lock: a malformed key is 400 on both routes; a choice without its hash is 400", async () => {
  const { t, c } = await world({ category: MATCH });
  for (const key of [7, "", "Match", "match!", "a", `m${"a".repeat(61)}`, ["match"], { key: "match" }]) {
    const p = await choicePreview(t, c.id, { activityTypeKey: key });
    assert.deepEqual([p.status, p.body.error], [400, "invalid_activity_type_key"], JSON.stringify([key, p.body]));
    const a = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64), activityTypeKey: key });
    assert.deepEqual([a.status, a.body.error], [400, "invalid_activity_type_key"], JSON.stringify([key, a.body]));
  }
  const noHash = await approve(t, c.id, { previewHash: c.preview_hash, activityTypeKey: "match" });
  assert.deepEqual([noHash.status, noHash.body.error], [400, "invalid_subset_hash"]);
  const unknownField = await choicePreview(t, c.id, { activityTypeKey: "match", replaceManual: [] });
  assert.deepEqual([unknownField.status, unknownField.body.error], [400, "invalid_body"]);
  // A coach without the approver right gets no choice preview; a stranger the identical 404.
  const coach = await choicePreview(t, c.id, { activityTypeKey: "match" }, t.coach.cookie);
  assert.deepEqual([coach.status, coach.body.error], [403, "not_an_approver"]);
  assert.equal((await choicePreview(t, c.id, { activityTypeKey: "match" }, (await user("stranger")).cookie)).status, 404);
  assert.equal(await written(t.teamId), NOTHING);
});

test("7. a type that is not offered to the team - unknown, another club's, archived - is one 409 session_type_not_offered with an equal body, on both routes", async () => {
  const { t, c } = await world({ category: MATCH });
  const foreign = await clubType((await createGpexePilotOrg(admin, { athleteNames: ["X01"] })).clubId, "Foreign gym");
  const own = await clubType(t.clubId, "Own gym");
  const bodies = [];
  for (const key of ["no_such_type", foreign.key, "testing_session"]) {
    const p = await choicePreview(t, c.id, { activityTypeKey: key });
    assert.deepEqual([p.status, p.body.error], [409, "session_type_not_offered"], JSON.stringify([key, p.body]));
    const a = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64), activityTypeKey: key });
    assert.deepEqual([a.status, a.body.error], [409, "session_type_not_offered"], JSON.stringify([key, a.body]));
    bodies.push(JSON.stringify(p.body), JSON.stringify(a.body));
  }
  assert.equal(new Set(bodies.filter((_, i) => i % 2 === 0)).size, 1, "the preview route answers the three alike");
  assert.equal(new Set(bodies.filter((_, i) => i % 2 === 1)).size, 1, "the approval answers the three alike");
  assert.equal(await written(t.teamId), NOTHING);
  // The team's own club's type is offered.
  const ok = await approveWithType(t, c, own.key);
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.deepEqual(await activityTypes(t.teamId), [own.key]);
});

test("8. a stale choice: the type is archived after the choice preview - 409 session_type_not_offered, nothing written, nothing stored; restored, the same hash imports", async () => {
  const { t, c } = await world({ category: MATCH });
  const type = await clubType(t.clubId, "Recovery run");
  const p = await choicePreview(t, c.id, { activityTypeKey: type.key });
  assert.equal(p.status, 200, JSON.stringify(p.body).slice(0, 300));
  assert.equal((await archive(type)).status, 200);
  const stale = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: p.body.subset.subsetHash, activityTypeKey: type.key });
  assert.deepEqual([stale.status, stale.body.error], [409, "session_type_not_offered"], JSON.stringify(stale.body));
  assert.equal(await written(t.teamId), NOTHING);
  assert.deepEqual(await rowOf(c.id), c);
  assert.deepEqual(await suggestions(t.teamId), []);
  const restored = await call(`/training-activity/session-types/${type.key}/restore`, { method: "POST", cookie: type.clubAdmin.cookie, body: { requestKey: crypto.randomUUID() } });
  assert.equal(restored.status, 200, restored.text);
  const done = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: p.body.subset.subsetHash, activityTypeKey: type.key });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
});

test("9. athletes left out and a type together are one choice with one hash; the approval row keeps the set and the hash", async () => {
  const { t, c } = await world({ category: MATCH });
  const onlyType = (await choicePreview(t, c.id, { activityTypeKey: "match" })).body.subset;
  const leftOutOnly = await choicePreview(t, c.id, { excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([leftOutOnly.status, leftOutOnly.body.error], [409, "session_type_required"], "athletes left out of a session that still has no type");
  const both = await choicePreview(t, c.id, { activityTypeKey: "match", excludedAthleteIds: [athleteId(3)] });
  assert.equal(both.status, 200, JSON.stringify(both.body).slice(0, 300));
  assert.notEqual(both.body.subset.subsetHash, onlyType.subsetHash);
  // The hash of the type alone does not cover the set, and the reverse.
  const half = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: onlyType.subsetHash, activityTypeKey: "match", excludedAthleteIds: [athleteId(3)] });
  assert.deepEqual([half.status, half.body.error], [409, "preview_changed"]);
  const done = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: both.body.subset.subsetHash, activityTypeKey: "match", excludedAthleteIds: [athleteId(3)] });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  const approval = (await q(`select subset_hash, excluded_athlete_ids from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id]))[0];
  assert.deepEqual(approval, { subset_hash: both.body.subset.subsetHash, excluded_athlete_ids: [athleteId(3)] });
  assert.deepEqual(await activityTypes(t.teamId), ["match"]);
});

test("10. a session already imported keeps its type: the next version's preview says imported_session, another type is session_type_fixed, and the re-import leaves the type alone", async () => {
  const t = await team();
  // Athlete 3 is linked only after the first import, so the next version has something to write.
  const link = (await q(`select id from training_load.gpexe_athlete_links where owner_team_id = $1 and gpexe_athlete_id = $2 and unlinked_at is null`, [t.teamId, athleteId(3)]))[0];
  assert.equal((await api(`/gpexe/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie, body: {} })).status, 200);
  const sessionId = nextSession++;
  const first = previewBundle({ gpexeTeamId: Number(t.sourceTeamId), sessionId, category: MATCH });
  await check(t, [first]);
  const c1 = await candidateOf(t, first);
  assert.equal((await approveWithType(t, c1, "match")).status, 200);
  assert.equal((await api(`/gpexe/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: athleteId(3), athleteId: t.athleteIds[2] } })).status, 201);
  const second = previewBundle({ gpexeTeamId: Number(t.sourceTeamId), sessionId, category: MATCH, updatedOn: "2026-09-14T21:30:00.000" });
  await check(t, [second]);
  const c2 = await candidateOf(t, second);
  assert.notEqual(c2.id, c1.id);
  assert.deepEqual([c2.status, c2.preview.session.activityTypeKey, c2.preview.session.activityTypeSource], ["pending", "match", "imported_session"]);
  assert.ok(!(await listed(t, c2)).approvalBlockers.includes("session_type_required"));
  const other = await choicePreview(t, c2.id, { activityTypeKey: "friendly_match" });
  assert.deepEqual([other.status, other.body.error], [409, "session_type_fixed"], JSON.stringify(other.body));
  const fixed = await approve(t, c2.id, { previewHash: c2.preview_hash, subsetHash: "a".repeat(64), activityTypeKey: "friendly_match", acceptChanges: true });
  assert.deepEqual([fixed.status, fixed.body.error], [409, "session_type_fixed"]);
  const same = await choicePreview(t, c2.id, { activityTypeKey: "match" });
  assert.equal(same.status, 200, JSON.stringify(same.body).slice(0, 300));
  assert.equal(same.body.subset.subsetHash, c2.preview_hash, "its own type chosen again is no choice: the stored preview");
  const done = await approve(t, c2.id, { previewHash: c2.preview_hash, acceptChanges: true });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual([done.body.import.activityTypeKey, done.body.import.activityTypeSource], ["match", "imported_session"]);
  assert.deepEqual(await activityTypes(t.teamId), ["match"], "one activity, its type untouched");
});

test("11. the batch: one choice per item; a session that waits for a type is refused alone without one; a stale choice stops alone; the body's shape", async () => {
  const t = await team();
  const type = await clubType(t.clubId, "Batch gym");
  const plain = bundle(t, { clean: true });
  const needs = bundle(t, { category: MATCH, clean: true });
  const stale = bundle(t, { category: "FRIENDLY", clean: true });
  const waits = bundle(t, { category: "RTP", clean: true });
  await check(t, [plain, needs, stale, waits]);
  const [cPlain, cNeeds, cStale, cWaits] = await Promise.all([plain, needs, stale, waits].map((b) => candidateOf(t, b)));
  const pNeeds = (await choicePreview(t, cNeeds.id, { activityTypeKey: "match" })).body.subset;
  const pStale = (await choicePreview(t, cStale.id, { activityTypeKey: type.key })).body.subset;
  assert.equal((await archive(type)).status, 200);
  const ids = [cStale.id, cWaits.id, cNeeds.id, cPlain.id];
  const previewHashes = Object.fromEntries([cPlain, cNeeds, cStale, cWaits].map((c) => [c.id, c.preview_hash]));
  const shape = async (choices, expect) => {
    const r = await batch(t, { candidateIds: ids, previewHashes, choices });
    assert.deepEqual([r.status, r.body.error], expect, JSON.stringify([choices, r.body]));
  };
  await shape([], [400, "invalid_choices"]);
  await shape({ [crypto.randomUUID()]: { activityTypeKey: "match", subsetHash: pNeeds.subsetHash } }, [400, "invalid_choices"]);
  await shape({ [cNeeds.id]: { activityTypeKey: "match", subsetHash: pNeeds.subsetHash, excludedAthleteIds: [athleteId(3)] } }, [400, "invalid_choices"]);
  await shape({ [cNeeds.id]: { activityTypeKey: "Match", subsetHash: pNeeds.subsetHash } }, [400, "invalid_activity_type_key"]);
  await shape({ [cNeeds.id]: { subsetHash: pNeeds.subsetHash } }, [400, "invalid_activity_type_key"]);
  await shape({ [cNeeds.id]: { activityTypeKey: "match" } }, [400, "invalid_subset_hash"]);
  assert.equal(await written(t.teamId), NOTHING);
  const r = await batch(t, { candidateIds: ids, previewHashes, choices: {
    [cNeeds.id]: { activityTypeKey: "match", subsetHash: pNeeds.subsetHash },
    [cStale.id]: { activityTypeKey: type.key, subsetHash: pStale.subsetHash },
  } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => [x.candidateId, x.outcome, x.code]), [
    [cStale.id, "refused", "session_type_not_offered"],
    [cWaits.id, "refused", "session_type_required"],
    [cNeeds.id, "imported", null],
    [cPlain.id, "imported", null],
  ], "each item stands alone: neither refusal stops the batch");
  assert.deepEqual((await activityTypes(t.teamId)).sort(), ["match", "training_session"]);
  assert.deepEqual((await suggestions(t.teamId)).map((s) => [s.category_name, s.activity_type_key]), [[MATCH, "match"]]);
});

test("12. the suggestion's write fails, or the database refuses it: the import stays committed and the answer is the import's", async () => {
  const failing = await world({ category: MATCH });
  sessionType.setSuggestionWriteFaultForTests(async () => { throw new Error("the suggestion's connection broke"); });
  let done;
  try {
    done = await approveWithType(failing.t, failing.c, "match");
  } finally {
    sessionType.setSuggestionWriteFaultForTests(null);
  }
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.equal(done.body.outcome, "imported");
  assert.deepEqual(await activityTypes(failing.t.teamId), ["match"]);
  assert.deepEqual(await suggestions(failing.t.teamId), []);
  // v85's guard refuses a suggestion by somebody who is not a manager of the team (here: the right is gone by then).
  const refused = await world({ category: MATCH });
  sessionType.setSuggestionWriteFaultForTests(async () => {
    await admin.query(`update public.user_global_roles set is_active = false where user_id = $1`, [refused.t.padmin.id]);
  });
  try {
    done = await approveWithType(refused.t, refused.c, "match");
  } finally {
    sessionType.setSuggestionWriteFaultForTests(null);
  }
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual(await activityTypes(refused.t.teamId), ["match"]);
  assert.deepEqual(await suggestions(refused.t.teamId), [], "the guard's refusal leaves the suggestion as it was");
  // The pool is whole afterwards.
  assert.equal((await api(`/gpexe/teams/${failing.t.teamId}/candidates`, { cookie: failing.t.coach.cookie })).status, 200);
});

test("13. a lost COMMIT of an approval with a choice: found committed, the answer says so and the suggestion follows; not committed is 503 and no suggestion", async () => {
  const landed = await world({ category: MATCH });
  service.setApprovalCommitForTests(async (client) => { await client.query("commit"); throw new Error("answer lost"); }, { timeoutMs: 2000 });
  let r;
  try {
    r = await approveWithType(landed.t, landed.c, "match");
  } finally {
    service.setApprovalCommitForTests(null);
  }
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.commitConfirmation, "verified_after_commit_error");
  assert.equal(r.body.import.activityTypeKey, "match");
  assert.deepEqual((await suggestions(landed.t.teamId)).map((s) => s.activity_type_key), ["match"]);
  const lost = await world({ category: MATCH });
  service.setApprovalCommitForTests(async () => { throw new Error("connection lost before the COMMIT"); }, { timeoutMs: 2000 });
  try {
    r = await approveWithType(lost.t, lost.c, "match");
  } finally {
    service.setApprovalCommitForTests(null);
  }
  assert.deepEqual([r.status, r.body.error], [503, "import_outcome_unknown"]);
  assert.deepEqual(await suggestions(lost.t.teamId), [], "an unconfirmed import never moves the suggestion");
  assert.equal(await written(lost.t.teamId), NOTHING);
});

test("14. the SQL order of an approval with a choice: the type's read comes after the approver-rights lock and before the import itself; the suggestion is written on another connection, after the COMMIT", async () => {
  const { t, c } = await world({ category: MATCH });
  const p = (await choicePreview(t, c.id, { activityTypeKey: "match" })).body.subset;
  const seen = [];
  const realConnect = appPool.connect.bind(appPool);
  let clock = 0;
  const wrap = (client) => {
    const realQuery = client.query.bind(client);
    const log = [];
    client.query = (text, ...rest) => {
      const sql = typeof text === "string" ? text : text?.text ?? "";
      log.push({ at: clock++, sql: sql.replace(/\s+/g, " ").trim().toLowerCase() });
      return realQuery(text, ...rest);
    };
    seen.push(log);
    return client;
  };
  appPool.connect = (...args) => (typeof args[args.length - 1] === "function" ? realConnect(...args) : realConnect(...args).then(wrap));
  let done;
  try {
    done = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: p.subsetHash, activityTypeKey: "match" });
  } finally {
    appPool.connect = realConnect;
  }
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  const approval = seen.find((l) => l.some((s) => s.sql.includes("lock_gpexe_import_approver")));
  assert.ok(approval, "the approval's connection was found");
  const at = (log, pred) => log.find((s) => pred(s.sql))?.at ?? -1;
  const rights = at(approval, (s) => s.includes("lock_gpexe_import_approver"));
  const teamLock = at(approval, (s) => s.includes("pg_advisory_xact_lock"));
  const typeRead = at(approval, (s) => s.includes("session_type_offered"));
  const importStart = at(approval, (s) => s.startsWith("savepoint gpexe_preview_import"));
  const commit = at(approval, (s) => s === "commit");
  assert.ok(teamLock >= 0 && rights > teamLock, "the rights lock after the team lock (unchanged)");
  assert.ok(typeRead > rights, "the type row is read (FOR SHARE inside session_type_offered) after the rights lock");
  assert.ok(importStart > typeRead, "and before the import itself starts (its savepoint)");
  assert.equal(approval.filter((s) => s.sql.includes("session_type_offered")).length, 1, "one type is checked: the chosen one (the category has no suggestion)");
  assert.ok(commit > importStart);
  // Everything sent on any connection, in order. The approval's connection is released before the suggestion takes one
  // (db review of ST-2), so the pool may hand the same connection back: the proof is the order, not the connection.
  const all = seen.flat().sort((x, y) => x.at - y.at);
  const suggestionInsert = all.find((s) => s.sql.startsWith("insert into training_load.source_session_types"));
  assert.ok(suggestionInsert, "the suggestion was written");
  assert.ok(suggestionInsert.at > commit, "after the approval's COMMIT: the approval's transaction never writes the suggestion");
  const after = all.filter((s) => s.at > commit);
  const begin = after.find((s) => s.sql === "begin");
  assert.ok(begin && begin.at < suggestionInsert.at, "in a transaction of its own, begun after the approval's COMMIT");
  assert.ok(!after.some((s) => s.sql.includes("pg_advisory_xact_lock")), "which never takes the team's import lock");
  assert.ok(after.some((s) => s.sql === "commit" && s.at > suggestionInsert.at), "and commits on its own");
});

test("15. an archived suggestion is no suggestion: the next review of a session of that category asks for a type", async () => {
  const t = await team();
  const type = await clubType(t.clubId, "Seasonal");
  const first = await world({ team: t, category: MATCH });
  assert.equal((await approveWithType(t, first.c, type.key)).status, 200);
  const second = await world({ team: t, category: MATCH });
  assert.deepEqual([second.c.preview.session.activityTypeKey, second.c.preview.session.activityTypeSource], [type.key, "team_suggestion"]);
  assert.equal((await archive(type)).status, 200);
  // The stored preview still names the archived type; the approval recomputes it and stores the answer.
  const stale = await approve(t, second.c.id, { previewHash: second.c.preview_hash });
  assert.deepEqual([stale.status, stale.body.error], [409, "preview_changed"], JSON.stringify(stale.body).slice(0, 200));
  const now = await rowOf(second.c.id);
  assert.deepEqual([now.status, now.preview.session.activityTypeKey, now.preview.session.activityTypeSource], ["pending", null, "none"]);
  assert.ok((await listed(t, now)).approvalBlockers.includes("session_type_required"));
  const again = await approve(t, second.c.id, { previewHash: now.preview_hash });
  assert.deepEqual([again.status, again.body.error], [409, "session_type_required"]);
  assert.deepEqual(await activityTypes(t.teamId), [type.key], "only the first session was imported");
  assert.equal((await approveWithType(t, now, "match")).status, 200);
});

test("17. two sessions of one category, the same type chosen for both before either is approved: one batch imports both - the hash of a choice does not depend on the team's suggestion, which the first approval rewrites", async () => {
  const t = await team();
  const a = bundle(t, { category: MATCH, clean: true });
  const b = bundle(t, { category: MATCH, clean: true });
  await check(t, [a, b]);
  const [ca, cb] = [await candidateOf(t, a), await candidateOf(t, b)];
  const pa = (await choicePreview(t, ca.id, { activityTypeKey: "match" })).body.subset;
  const pb = (await choicePreview(t, cb.id, { activityTypeKey: "match" })).body.subset;
  const r = await batch(t, { candidateIds: [ca.id, cb.id], previewHashes: { [ca.id]: ca.preview_hash, [cb.id]: cb.preview_hash },
    choices: { [ca.id]: { activityTypeKey: "match", subsetHash: pa.subsetHash }, [cb.id]: { activityTypeKey: "match", subsetHash: pb.subsetHash } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => [x.outcome, x.code]), [["imported", null], ["imported", null]]);
  assert.deepEqual(await activityTypes(t.teamId), ["match", "match"]);
  // The suggestion chosen again is still a choice (its own hash), and imports.
  const c = await world({ team: t, category: MATCH, clean: true });
  assert.equal(c.c.preview.session.activityTypeSource, "team_suggestion");
  const pc = (await choicePreview(t, c.c.id, { activityTypeKey: "match" })).body.subset;
  assert.equal(pc.preview.session.activityTypeSource, "choice");
  assert.notEqual(pc.subsetHash, c.c.preview_hash);
  assert.equal((await approve(t, c.c.id, { previewHash: c.c.preview_hash, subsetHash: pc.subsetHash, activityTypeKey: "match" })).status, 200);
});

test("18. another club's type is never locked or waited on: with its row held FOR UPDATE elsewhere, a choice of it is the immediate 409 of an unknown key (security review); the team's own type held the same way is waited for", async () => {
  const { t, c } = await world({ category: MATCH });
  const foreign = await clubType((await createGpexePilotOrg(admin, { athleteNames: ["Y01"] })).clubId, "Held elsewhere");
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select 1 from training.activity_types where key = $1 for update`, [foreign.key]);
    const started = Date.now();
    const p = await choicePreview(t, c.id, { activityTypeKey: foreign.key });
    const a = await approve(t, c.id, { previewHash: c.preview_hash, subsetHash: "a".repeat(64), activityTypeKey: foreign.key });
    const unknown = await choicePreview(t, c.id, { activityTypeKey: "no_such_type" });
    assert.deepEqual([p.status, p.body.error, a.status, a.body.error], [409, "session_type_not_offered", 409, "session_type_not_offered"]);
    assert.deepEqual(p.body, unknown.body, "the same body as an unknown key");
    assert.ok(Date.now() - started < 3000, "no wait on the other club's row (the lock bound is 5 s)");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.equal(await written(t.teamId), NOTHING);
});

test("19. small contracts: a null activityTypeKey is no choice on the preview route; a category the suggestion table cannot hold has no suggestion and none is written", async () => {
  const { t, c } = await world();
  const r = await choicePreview(t, c.id, { activityTypeKey: null });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.ok(r.body.candidate && !r.body.subset, "the plain review update, not a choice preview");
  const types = await import("../src/gpexeSessionType.js");
  for (const bad of [" MATCH", "MATCH ", "", "A​B", "x".repeat(81), null, 7]) assert.equal(types.usableCategory(bad), null, JSON.stringify(bad));
  assert.equal(types.usableCategory("OFFICIAL MATCH"), "OFFICIAL MATCH");
  assert.deepEqual(await sessionType.recordTeamSessionTypeSuggestion({ teamId: t.teamId, userId: t.padmin.id, categoryName: " MATCH ", activityTypeKey: "match" }),
    { written: false, reason: "not_recordable" });
  assert.deepEqual(await suggestions(t.teamId), []);
});

test("16. the direct import path (the CLI's and the tests') never writes a session without a type: session_type_required, or the given type", async () => {
  const t = await team();
  const b = bundle(t, { category: MATCH });
  const run = async (ctx) => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query("begin");
      await writer.lockTeamForImport(client, t.teamId);
      const links = new Map((await client.query(`select gpexe_athlete_id, athlete_id from training_load.gpexe_athlete_links where owner_team_id = $1 and unlinked_at is null`, [t.teamId])).rows.map((r) => [r.gpexe_athlete_id, r.athlete_id]));
      const summary = await writer.importGpexeBundleLocked(client, b, { ownerTeamId: t.teamId, performedByUserId: t.padmin.id, athleteIdByGpexeId: links, onlyMapped: true, bindingId: t.bindingId, ...ctx });
      const type = (await client.query(`select activity_type_key from training.activities where id = $1`, [summary.activityId])).rows[0].activity_type_key;
      return { type };
    } catch (error) {
      return { code: error.code };
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  };
  assert.deepEqual(await run({}), { code: "session_type_required" });
  assert.deepEqual(await run({ activityTypeKey: "testing_session" }), { code: "session_type_not_offered" });
  assert.deepEqual(await run({ activityTypeKey: "match" }), { type: "match" });
  assert.equal(await written(t.teamId), NOTHING, "each run was rolled back");
});
