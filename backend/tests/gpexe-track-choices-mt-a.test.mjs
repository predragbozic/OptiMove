// MT-A (v67): the track choice of an athlete GPEXE recorded on more than one track, through the real routes on disposable
// databases: the table's guard, the approver's audience and the identical 404, the replay, the chain and the way back, the
// refusals, the right and the team under lock, the imported candidate never locked, a stale fingerprint, try_again, the COMMIT,
// and the lock order recorded against the approval's.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";
import crypto from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const D1 = "2026-09-14";
let src;
let connections;
let resolver;
let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;
let choices;
let preview;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mta", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
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
  src = createFakeSource();
  connections.setSourceFetchForTests(src.fetchImpl);
  resolver.setImportSourceFetchForTests(src.fetchImpl);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  choices = await import("../src/gpexeTrackChoiceService.js");
  preview = await import("../src/gpexeImportPreview.js");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  choices?.setTrackChoiceTestHooks(null);
  preview?.setImportTransactionBoundsForTests(null);
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS; else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
async function makeUser(label) {
  return (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${Math.random().toString(16).slice(2)}@test.local`, label])).rows[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}


// A session of three athletes: 101 and 102 on one track each, 103 on two tracks that differ (a real restart), and optionally
// 106 on two identical tracks (one recording, MT-0).
function bundleOf({ sessionId, with106 = false, without103 = false, tweak103 = null, updatedOn = "2026-09-14T20:18:09.337" }) {
  const std = standardAthletes();
  const athletes = std.map((a) => structuredClone(a));
  if (without103) athletes.splice(2, 1);
  athletes[0].tracks = [sessionId * 10 + 1];
  athletes[1].tracks = [sessionId * 10 + 2];
  for (const a of athletes.slice(0, 2)) for (const part of a.parts) delete part.track;
  if (tweak103 && !without103) tweak103(athletes[2]);
  if (with106) {
    const dup = { id: 106, tracks: [9207, 9206], parts: [] };
    for (const track of dup.tracks) for (const part of std[1].parts) dup.parts.push({ ...structuredClone(part), track });
    athletes.push(dup);
  }
  return makeBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: "2026-09-14T10:08:12", updatedOn, athletes });
}

let nextGpexeTeamId = 8700;
async function setupTeam({ link = ["101", "102", "103"] } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Cid"] });
  await admin.query(`delete from public.athlete_memberships where team_id = $1`, [org.teamId]);
  for (const athleteId of org.athleteIds) {
    await admin.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, org.clubId, org.teamId]);
  }
  const coachId = await makeUser("coach");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, org.teamId]);
  await setWorkspace(coachId, "team", org.teamId);
  const coach = { id: coachId, cookie: `optimove_session=${await createSession(coachId)}` };
  const padminId = await makeUser("platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [padminId]);
  await setWorkspace(padminId, "platform", null);
  const padmin = { id: padminId, cookie: `optimove_session=${await createSession(padminId)}` };
  const sourceTeamId = String(nextGpexeTeamId++);
  assert.equal((await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: sourceTeamId } })).status, 200);
  src.show(sourceTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  const ids = { "101": org.athleteIds[0], "102": org.athleteIds[1], "103": org.athleteIds[2] };
  for (const gpexeAthleteId of link) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId: ids[gpexeAthleteId] } })).status, 201);
  }
  return { ...org, coach, padmin, sourceTeamId };
}

async function checkNow(team, bundles) {
  src.serve(team.sourceTeamId, bundles);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.padmin.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.padmin.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}
const candidates = async (team) => (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
async function candidateOf(team, sessionId, bundleOpts = {}) {
  await checkNow(team, [bundleOf({ sessionId, ...bundleOpts })]);
  const c = (await candidates(team)).find((x) => x.gpexeTeamSessionId === String(sessionId) && ["pending", "blocked"].includes(x.status));
  assert.ok(c, "an open candidate");
  return c;
}
const key = () => crypto.randomUUID();
const choicesUrl = (team, cid) => `/teams/${team.teamId}/candidates/${cid}/track-choices`;
const getChoices = (team, cid, cookie = team.padmin.cookie) => api(choicesUrl(team, cid), { cookie });
const put = (team, cid, athlete, body, cookie = team.padmin.cookie) => api(`${choicesUrl(team, cid)}/${athlete}`, { method: "PUT", cookie, body });
const rowsOf = async (teamId) => (await admin.query(`select * from training_load.gpexe_track_choices where owner_team_id = $1 order by chosen_at, id`, [teamId])).rows;
async function grantCoach(team) {
  const r = await api(`/teams/${team.teamId}/approvers`, { method: "POST", cookie: team.padmin.cookie, body: { userId: team.coach.id, reason: "approves this team's imports" } });
  assert.ok([200, 201].includes(r.status), r.text);
  return (await admin.query(`select id from training_load.gpexe_import_approvers where user_id = $1 and owner_team_id = $2 and revoked_at is null`, [team.coach.id, team.teamId])).rows[0].id;
}
async function approve(team, cand) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/teams/${team.teamId}/imports`, { method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } } });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}
// Records every SQL text sent on clients the application pool hands out while fn runs.
async function recordingSql(fn) {
  const seen = [];
  const wrapped = [];
  const original = appPool.connect;
  appPool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    return original.call(this).then((c) => {
      if (!wrapped.some((w) => w.c === c)) {
        const send = c.query;
        wrapped.push({ c, send });
        c.query = function (...args) {
          const t = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (t) seen.push(t.replace(/\s+/g, " "));
          return send.apply(this, args);
        };
      }
      return c;
    });
  };
  try {
    const result = await fn();
    return { result, seen };
  } finally {
    appPool.connect = original;
    for (const w of wrapped) w.c.query = w.send;
  }
}
const indexOf = (seen, re) => seen.findIndex((t) => re.test(t));

test("1. v67: the table, its guard and append-only - no actor, another basis, a cleared or second root, a track outside the fingerprint, an UPDATE, a DELETE and a TRUNCATE are refused", async () => {
  const team = await setupTeam();
  const fp = "9003:1;9004:2";
  const base = [team.teamId, "4100", "103", fp];
  const insert = (c, { choice = "track", track = "9003", user = team.padmin.id, basis = "platform_admin", supersedes = null } = {}) => c.query(
    `insert into training_load.gpexe_track_choices (owner_team_id, gpexe_team_session_id, gpexe_athlete_id, track_set_fingerprint, choice, chosen_track_id,
       chosen_by_user_id, chosen_basis, supersedes_choice_id, request_key, request_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,gen_random_uuid(),$10) returning id`,
    [...base, choice, choice === "track" ? track : null, user, basis, supersedes, "a".repeat(64)]);
  const asActor = async (user, fn) => {
    await admin.query("begin");
    try {
      await admin.query(`select set_config('optimove.track_choice_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [user]);
      const r = await fn();
      await admin.query("commit");
      return r;
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  };
  await assert.rejects(insert(admin), { code: "42501" }, "no acting user");
  await assert.rejects(asActor(team.coach.id, () => insert(admin, { user: team.padmin.id })), { code: "42501" }, "another author");
  // Another platform admin as the acting user: the right holds, only the author check refuses.
  const otherAdmin = await makeUser("another platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [otherAdmin]);
  await assert.rejects(asActor(otherAdmin, () => insert(admin, { user: team.padmin.id })), { code: "42501", message: /the author must be the acting user/ }, "another author with a right");
  await assert.rejects(asActor(team.coach.id, () => insert(admin, { user: team.coach.id, basis: "team_coach" })), { code: "42501" }, "no right");
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { basis: "team_grant" })), { code: "42501" }, "another basis than the right");
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { track: "9005" })), { code: "23514" }, "a track outside the fingerprint");
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { choice: "cleared" })), { code: "23514" }, "nothing to clear");
  const first = (await asActor(team.padmin.id, () => insert(admin))).rows[0].id;
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { choice: "none" })), { code: "23514" }, "a second root");
  const second = (await asActor(team.padmin.id, () => insert(admin, { choice: "cleared", supersedes: first }))).rows[0].id;
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { choice: "none", supersedes: first })), { code: "23514" }, "a superseded choice is not the current one");
  await assert.rejects(asActor(team.padmin.id, () => insert(admin, { choice: "cleared", supersedes: second })), { code: "23514" }, "a cleared choice is not cleared again");
  await assert.rejects(admin.query(`update training_load.gpexe_track_choices set choice = 'none' where id = $1`, [first]), /immutable row/);
  await assert.rejects(admin.query(`delete from training_load.gpexe_track_choices where id = $1`, [first]), /immutable row/);
  await assert.rejects(admin.query(`truncate training_load.gpexe_track_choices`), /immutable row/);
  assert.equal((await rowsOf(team.teamId)).length, 2);
});

test("2. the audience: a platform admin and an approved coach read the multi-track athletes; a coach without the right, another team's candidate and a malformed id get the identical 404", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4201, { with106: true });
  const r = await getChoices(team, cand.id);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.athletes.length, 1, "only 103: 101 and 102 have one track, 106's two tracks are one recording");
  const a = r.body.athletes[0];
  assert.equal(a.gpexeAthleteId, "103");
  assert.deepEqual(a.tracks.map((t) => [t.trackId, t.wholeSessionSeconds, t.wholeSessionDistance]), [["9003", 600, 700], ["9004", 900, 1000]]);
  assert.equal(a.sumOffered, false);
  assert.equal(a.currentChoice, null);
  assert.equal(JSON.stringify(r.body).includes("rowIds"), false, "row ids stay on the server");

  const denied = await getChoices(team, cand.id, team.coach.cookie);
  const unknown = await getChoices(team, crypto.randomUUID());
  assert.equal(denied.status, 404);
  assert.deepEqual(denied.body, unknown.body, "identical 404");
  assert.equal((await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null }, team.coach.cookie)).status, 404);
  const other = await setupTeam();
  assert.equal((await getChoices(other, cand.id)).status, 404, "another team's candidate");
  assert.equal((await api(`/teams/${team.teamId}/candidates/not-a-uuid/track-choices`, { cookie: team.padmin.cookie })).status, 404);
  assert.equal((await put(team, cand.id, "0103", { requestKey: key(), choice: "none", expectedChoiceId: null })).status, 404, "a non-canonical athlete id");

  await grantCoach(team);
  assert.equal((await getChoices(team, cand.id, team.coach.cookie)).status, 200);
  assert.equal((await rowsOf(team.teamId)).length, 0);
});

test("3. a choice: 201 with the row, its basis the approval's (platform admin; an approved coach's grant), the server's fingerprint; a replay answers the same; another body on the key is request_key_reused", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4301);
  const body = { requestKey: key(), choice: "track", trackId: "9004", expectedChoiceId: null };
  const r = await put(team, cand.id, "103", body);
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.choice.choice, "track");
  assert.equal(r.body.choice.trackId, "9004");
  const [row] = await rowsOf(team.teamId);
  assert.equal(row.chosen_basis, "platform_admin");
  assert.equal(row.chosen_grant_id, null);
  assert.match(row.track_set_fingerprint, /^9003:[0-9]+;9004:[0-9]+$/);
  const again = await put(team, cand.id, "103", body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(again.body.choice, r.body.choice);
  const reused = await put(team, cand.id, "103", { ...body, trackId: "9003" });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  assert.equal((await rowsOf(team.teamId)).length, 1);
  const listed = (await getChoices(team, cand.id)).body.athletes[0].currentChoice;
  assert.equal(listed.id, r.body.choice.id);
  assert.equal(listed.stale, false);

  const grantId = await grantCoach(team);
  const byCoach = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: r.body.choice.id }, team.coach.cookie);
  assert.equal(byCoach.status, 201, byCoach.text);
  const latest = (await rowsOf(team.teamId)).at(-1);
  assert.equal(latest.chosen_basis, "team_grant");
  assert.equal(String(latest.chosen_grant_id), String(grantId));
  assert.equal(String(latest.supersedes_choice_id), r.body.choice.id);
});

test("4. the chain: a stale expectedChoiceId is choice_changed with the current choice; Clear the choice supersedes it, a second clear is nothing_to_clear, and a new choice follows the clear", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4401);
  const first = (await put(team, cand.id, "103", { requestKey: key(), choice: "track", trackId: "9003", expectedChoiceId: null })).body.choice;
  const stale = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "choice_changed");
  assert.equal(stale.body.currentChoice.id, first.id);
  const wrong = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: crypto.randomUUID() });
  assert.equal(wrong.body.error, "choice_changed");
  const cleared = await put(team, cand.id, "103", { requestKey: key(), choice: "cleared", expectedChoiceId: first.id });
  assert.equal(cleared.status, 201, cleared.text);
  const twice = await put(team, cand.id, "103", { requestKey: key(), choice: "cleared", expectedChoiceId: cleared.body.choice.id });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "nothing_to_clear");
  const none = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: cleared.body.choice.id });
  assert.equal(none.status, 201, none.text);
  assert.deepEqual((await rowsOf(team.teamId)).map((r) => r.choice), ["track", "cleared", "none"]);
  assert.equal((await getChoices(team, cand.id)).body.athletes[0].currentChoice.choice, "none");
});

test("5. refusals before anything is written: one track or one recording is not_multiple_tracks, a track outside the session is track_not_in_session, a malformed body is 400", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4501, { with106: true });
  for (const athlete of ["101", "106", "999"]) {
    const r = await put(team, cand.id, athlete, { requestKey: key(), choice: "none", expectedChoiceId: null });
    assert.equal(r.status, 409, athlete);
    assert.equal(r.body.error, "not_multiple_tracks", athlete);
  }
  const outside = await put(team, cand.id, "103", { requestKey: key(), choice: "track", trackId: "9001", expectedChoiceId: null });
  assert.equal(outside.body.error, "track_not_in_session");
  const bad = [
    [{ choice: "none", expectedChoiceId: null }, "invalid_request_key"],
    [{ requestKey: key(), choice: "sum", expectedChoiceId: null }, "invalid_choice"],
    [{ requestKey: key(), choice: "track", expectedChoiceId: null }, "invalid_track_id"],
    [{ requestKey: key(), choice: "none", trackId: "9003", expectedChoiceId: null }, "invalid_track_id"],
    [{ requestKey: key(), choice: "none" }, "invalid_expected_choice"],
    [{ requestKey: key(), choice: "none", expectedChoiceId: null, note: "x" }, "invalid_body"],
  ];
  for (const [body, code] of bad) {
    const r = await put(team, cand.id, "103", body);
    assert.equal(r.status, 400, code);
    assert.equal(r.body.error, code);
  }
  assert.equal((await rowsOf(team.teamId)).length, 0);
});

test("6. the right under lock: revoked between the route's check and the lock is the identical 404; the team's switch off is team_import_switch_off; an archived team is 404; nothing written", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4601);
  const grantId = await grantCoach(team);
  choices.setTrackChoiceTestHooks({ beforeTeamLock: async () => {
    await admin.query(`update training_load.gpexe_import_approvers set revoked_at = now(), revoked_by_user_id = $2, revoke_reason = 'test' where id = $1`, [grantId, team.padmin.id]);
  } });
  try {
    const r = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null }, team.coach.cookie);
    assert.equal(r.status, 404, r.text);
  } finally {
    choices.setTrackChoiceTestHooks(null);
  }
  await enableTeamImportSwitch(admin, team.teamId, null, { enabled: false });
  const off = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null });
  assert.equal(off.status, 409);
  assert.equal(off.body.error, "team_import_switch_off");
  await enableTeamImportSwitch(admin, team.teamId);
  choices.setTrackChoiceTestHooks({ beforeTeamLock: async () => { await admin.query(`update public.teams set is_active = false where id = $1`, [team.teamId]); } });
  try {
    const gone = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null });
    assert.equal(gone.status, 404, gone.text);
  } finally {
    choices.setTrackChoiceTestHooks(null);
    await admin.query(`update public.teams set is_active = true where id = $1`, [team.teamId]);
  }
  assert.equal((await rowsOf(team.teamId)).length, 0);
});

test("7. an imported candidate is choice_final_after_import without being locked (the undo locks it after the team lock): even while another transaction holds the team lock and the candidate FOR UPDATE, the answer comes at once", async () => {
  const team = await setupTeam({ link: ["101", "102"] });
  // A session without a two-track athlete imports (one blocks it today: athletes_need_manual_review); the status is decided first.
  const cand = await candidateOf(team, 4701, { without103: true });
  const r = await approve(team, cand);
  assert.equal(r.body.results?.[0]?.outcome, "imported", r.text);
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1, 21))`, [team.teamId]);
    await holder.query(`select id from training_load.gpexe_import_candidates where id = $1 for update`, [cand.id]);
    const started = Date.now();
    const final = await put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null });
    assert.equal(final.status, 409, final.text);
    assert.equal(final.body.error, "choice_final_after_import");
    assert.ok(Date.now() - started < 3000, "answered without waiting for the held locks");
  } finally {
    await holder.query("rollback");
    await holder.end();
  }
});

test("8. a choice whose tracks GPEXE changed is stale in the next candidate's list; a wait for the team lock is try_again with nothing written", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4801);
  const made = (await put(team, cand.id, "103", { requestKey: key(), choice: "track", trackId: "9004", expectedChoiceId: null })).body.choice;
  const next = await candidateOf(team, 4801, { updatedOn: "2026-09-15T09:00:00.000", tweak103: (a) => { a.tracks = [9003, 9004, 9005]; a.parts.push({ drill: null, track: 9005, time: 300, distance: 200, maxV: 4, power: [300, 0, 0, 0, 0], acc: 1, dec: 1 }); } });
  assert.notEqual(next.id, cand.id);
  const listed = (await getChoices(team, next.id)).body.athletes[0];
  assert.equal(listed.tracks.length, 3);
  assert.equal(listed.currentChoice.id, made.id);
  assert.equal(listed.currentChoice.stale, true);

  preview.setImportTransactionBoundsForTests({ lockTimeoutMs: 200 });
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1, 21))`, [team.teamId]);
    const r = await put(team, next.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: made.id });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.error, "try_again");
  } finally {
    await holder.query("rollback");
    await holder.end();
    preview.setImportTransactionBoundsForTests(null);
  }
  assert.equal((await rowsOf(team.teamId)).length, 1);
});

test("9. the COMMIT: an answer lost after the row committed is verified by the request key (201, verifiedAfterCommitError); a COMMIT that never answers and wrote nothing is 503 outcome_unknown, and the same request then saves once", async () => {
  const team = await setupTeam();
  const cand = await candidateOf(team, 4901);
  const body = { requestKey: key(), choice: "none", expectedChoiceId: null };
  choices.setTrackChoiceTestHooks({ commit: async (client) => { await client.query("commit"); throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); } });
  try {
    const r = await put(team, cand.id, "103", body);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.verifiedAfterCommitError, true);
  } finally {
    choices.setTrackChoiceTestHooks(null);
  }
  const body2 = { requestKey: key(), choice: "cleared", expectedChoiceId: (await rowsOf(team.teamId))[0].id };
  choices.setTrackChoiceTestHooks({ commit: async (client) => { await client.query("rollback"); return new Promise(() => {}); }, commitTimeoutMs: 100, checkTimeoutMs: 2000 });
  try {
    const r = await put(team, cand.id, "103", body2);
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.error, "outcome_unknown");
  } finally {
    choices.setTrackChoiceTestHooks(null);
  }
  assert.equal((await rowsOf(team.teamId)).length, 1);
  const retried = await put(team, cand.id, "103", body2);
  assert.equal(retried.status, 201, retried.text);
  assert.equal((await rowsOf(team.teamId)).length, 2);
});

test("10. the lock order (recorded SQL): the PUT takes the request key lock, the open candidate FOR SHARE, the team lock, the team and club, the approver's rights, the current choice FOR UPDATE, then inserts - the approval's order (candidate, team lock, rights last), which the approval itself is recorded taking too", async () => {
  const team = await setupTeam({ link: ["101", "102"] });
  const cand = await candidateOf(team, 5001);
  const { result, seen } = await recordingSql(() => put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null }));
  assert.equal(result.status, 201, result.text);
  const order = [
    indexOf(seen, /track-choice-request/),
    indexOf(seen, /from training_load\.gpexe_import_candidates where id = \$1 and owner_team_id = \$2 and status in \('pending', 'blocked'\) for share/),
    indexOf(seen, /pg_advisory_xact_lock\(hashtextextended\(\$1, 21\)\)/),
    indexOf(seen, /from public\.teams where id = \$1 for share/),
    indexOf(seen, /from public\.clubs where id = \$1 for share/),
    indexOf(seen, /lock_gpexe_import_approver/),
    indexOf(seen, /gpexe_track_choices n where n\.supersedes_choice_id = c\.id\) for update/),
    indexOf(seen, /insert into training_load\.gpexe_track_choices/),
  ];
  assert.ok(order.every((i) => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `the order: ${JSON.stringify(order)}`);
  assert.equal(seen.filter((t) => /for update|for share|advisory/i.test(t)).length, 6, "no other lock");

  // The approval, recorded: the candidate before the team lock, the rights after it - the same relative order.
  const importable = await candidateOf(team, 5002, { without103: true });
  const approved = await recordingSql(() => approve(team, importable));
  assert.equal(approved.result.body.results?.[0]?.outcome, "imported", approved.result.text);
  const a = approved.seen;
  const candidateLock = indexOf(a, /from training_load\.gpexe_import_candidates where id = \$1 and owner_team_id = \$2 for update/);
  const teamLock = indexOf(a, /pg_advisory_xact_lock\(hashtextextended\(\$1, 21\)\)/);
  const rights = indexOf(a, /lock_gpexe_import_approver/);
  assert.ok(candidateLock >= 0 && teamLock > candidateLock && rights > teamLock, JSON.stringify([candidateLock, teamLock, rights]));
});

test("11. the lock order against the other writers of a candidate (recorded SQL and the undo's body): the J20-A1 recompute and the check's finalization lock candidates before the team lock, as the PUT does; the undo takes the team lock first but locks only approved (imported) candidates, which the PUT never locks", async () => {
  const team = await setupTeam({ link: ["101", "102"] });
  // The finalization of a check: the session's candidates FOR UPDATE, then the team lock.
  const checked = await recordingSql(() => checkNow(team, [bundleOf({ sessionId: 5101 })]));
  const f = checked.seen;
  const finalCandidates = indexOf(f, /from training_load\.gpexe_import_candidates where owner_team_id = \$1 .* order by id for update/);
  const finalTeamLock = indexOf(f, /hold_gpexe_team_lock/);
  assert.ok(finalCandidates >= 0 && finalTeamLock > finalCandidates, JSON.stringify([finalCandidates, finalTeamLock]));
  // The J20-A1 recompute: the candidate FOR UPDATE, then the team lock, then the team and club.
  const cand = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "5101");
  const recomputed = await recordingSql(() => api(`/teams/${team.teamId}/candidates/${cand.id}/preview`, { method: "POST", cookie: team.padmin.cookie }));
  assert.equal(recomputed.result.status, 200, recomputed.result.text);
  const r = recomputed.seen;
  const rCandidate = indexOf(r, /from training_load\.gpexe_import_candidates where id = \$1 and owner_team_id = \$2 for update/);
  const rTeamLock = indexOf(r, /pg_advisory_xact_lock\(hashtextextended\(\$1, 21\)\)/);
  assert.ok(rCandidate >= 0 && rTeamLock > rCandidate, JSON.stringify([rCandidate, rTeamLock]));
  // The undo (the database function in force): the team lock, then only the candidates an approval wrote, FOR UPDATE.
  const undo = (await admin.query(`select pg_get_functiondef(p.oid) as d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'undo_imported_session'`)).rows[0].d.replace(/\s+/g, " ");
  const uTeamLock = undo.indexOf("'gpexe-import-team:'");
  const uCandidates = undo.indexOf("c.id in (select a.candidate_id from training_load.gpexe_import_approvals a where a.metric_event_id = v_event_id) order by c.id for update");
  assert.ok(uTeamLock >= 0 && uCandidates > uTeamLock, JSON.stringify([uTeamLock, uCandidates]));
  // ...and the PUT's lock takes only an open candidate (test 7 proves it does not wait on an imported one).
  const put103 = await recordingSql(() => put(team, cand.id, "103", { requestKey: key(), choice: "none", expectedChoiceId: null }));
  assert.equal(put103.result.status, 201, put103.result.text);
  assert.equal(put103.seen.filter((t) => /gpexe_import_candidates .*for (share|update)/.test(t)).every((t) => /status in \('pending', 'blocked'\) for share/.test(t)), true);
});
