// Central calendar K5-4 (docs/ai/central-calendar-k5-4-contract.md section 5, Backend): the key-by-key pin of the
// Imports calendar read the central calendar relies on, GET /api/training-load/gpexe/teams/:teamId/calendar. The
// mapping stream owns the route; this suite pins what the calendar may receive, so a later widening of the answer (a
// label, an id, a name) fails a calendar test first. Read only: nothing of the route changes.
//
// The candidates come from a real check through the team's binding (the fake GPEXE source of the route's own suite),
// never from raw rows. One disposable database; invented people only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle as makeFixtureBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const ORIGINAL_KEYS = process.env.SOURCE_CREDENTIAL_KEYS;
const WINDOW = { from: "2026-09-01", to: "2026-09-14" };
const CAL = "?from=2026-09-01&to=2026-09-30";
const STATES = ["needs", "ready", "imported", "out"];
// Planted, so a leak of any of them is found in the answer's text.
const PLANTED_NAMES = ["Zyxplant Athleteone", "Qwplant Athletetwo"];
const PLANTED_SESSIONS = ["748813", "748814", "748815"];

let db;
let admin;
let server;
let apiBase;
let src;
let connections;
let resolver;
let service;
let createSession;
let appPool;
let team;
let other;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "k54pin" });
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
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  team = await setupTeam("4801");
  other = await setupTeam("4802");
  // A ready session, one with an unlinked athlete (needs), one of a type that stays out, on two UTC days.
  src.serve(team.sourceTeamId, [
    bundle(PLANTED_SESSIONS[0], "2026-09-03T09:00:00"),
    bundle(PLANTED_SESSIONS[1], "2026-09-03T23:30:00", { withUnlinked: true }),
    bundle(PLANTED_SESSIONS[2], "2026-09-06T10:00:00", { category: "OFFICIAL MATCH" }),
  ]);
  service.setGpexeClientFactory(() => { throw new Error("TRAP: the legacy client factory was called for a bound team"); });
  const check = await checkNow(team);
  assert.equal(check.status, "succeeded", JSON.stringify(check));
  // ST-2: no check blocks a session for its category any more (it waits for its session type: "needs"). A preview
  // stored before ST-2 still says "a type that stays out"; the third session is made such a stored preview, so the
  // world keeps all three states this pin reads.
  await admin.query(
    `update training_load.gpexe_import_candidates
        set status = 'blocked', preview = jsonb_build_object('status', 'blocked', 'blocked', jsonb_build_object('code', 'unsupported_category', 'message', 'x'),
              'session', jsonb_build_object('categoryName', 'OFFICIAL MATCH'), 'athletes', '[]'::jsonb, 'changesToImported', '[]'::jsonb)
      where owner_team_id = $1 and gpexe_team_session_id = $2`, [team.teamId, String(PLANTED_SESSIONS[2])]);
});

after(async () => {
  service?.setGpexeClientFactory(null);
  connections?.setSourceFetchForTests(null);
  resolver?.setImportSourceFetchForTests(null);
  if (ORIGINAL_KEYS === undefined) delete process.env.SOURCE_CREDENTIAL_KEYS;
  else process.env.SOURCE_CREDENTIAL_KEYS = ORIGINAL_KEYS;
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

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
async function raw(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
async function makeUser(label) {
  return (await admin.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`,
    [`${label.replace(/\s+/g, "-")}-${Math.random().toString(16).slice(2)}@test.local`, label])).rows[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await admin.query(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
async function coachOf(teamId) {
  const id = await makeUser("k54 coach");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdminOf(clubId) {
  const id = await makeUser("k54 club admin");
  await admin.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
async function platformAdmin() {
  const id = await makeUser("k54 platform admin");
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return { id, cookie: await cookieFor(id) };
}
async function athleteAccount(athleteId) {
  const id = await makeUser("k54 athlete");
  await admin.query(`update public.athletes set user_id = $1 where id = $2`, [id, athleteId]);
  await setWorkspace(id, "athlete", null);
  return { id, cookie: await cookieFor(id) };
}

// A team of the pilot organisation, its GPEXE team bound through the real routes; GPEXE athletes 101 and 102 linked.
async function setupTeam(gpexeTeamId) {
  const org = await createGpexePilotOrg(admin, { athleteNames: PLANTED_NAMES });
  const coach = await coachOf(org.teamId);
  const padmin = await platformAdmin();
  const clubAdmin = await clubAdminOf(org.clubId);
  assert.equal((await raw(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId } })).status, 200);
  for (const [gpexeAthleteId, athleteId] of [["101", org.athleteIds[0]], ["102", org.athleteIds[1]]]) {
    const linked = await raw(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } });
    assert.equal(linked.status, 201, linked.text);
  }
  src.show(gpexeTeamId);
  const { bindingId } = await bindThroughRoutes({ apiBase, cookie: padmin.cookie, clubId: org.clubId, teamId: org.teamId, sourceTeamId: gpexeTeamId });
  await enableTeamImportSwitch(admin, org.teamId);
  await activateBinding(admin, bindingId);
  src.serve(gpexeTeamId, []);
  return { ...org, coach, padmin, clubAdmin, sourceTeamId: gpexeTeamId };
}

// 101 and 102, both linked and clean: "ready"; an unlinked 104 makes it "needs"; another category stays "out".
function bundle(sessionId, start, { withUnlinked = false, category } = {}) {
  const athletes = standardAthletes().slice(0, 2);
  if (withUnlinked) athletes.push({ ...structuredClone(athletes[1]), id: 104, tracks: [9005] });
  return makeFixtureBundle({ sessionId: Number(sessionId), gpexeTeamId: 77, start, category, athletes, detailsDrills: [0, 1] });
}

async function checkNow(t) {
  const started = await raw(`/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: WINDOW });
  assert.equal(started.status, 202, started.text);
  for (let i = 0; i < 200; i += 1) {
    const r = await raw(`/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.coach.cookie });
    if (r.body.check?.status !== "running") return r.body.check;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}

// Exactly these keys, no more and no fewer.
const keysOf = (o) => Object.keys(o).sort();

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------
test("K5-4 pin 1: for the team's coach, the club's admin and a platform admin, the answer is exactly { from, to, days[{ day, chips, counts{needs,ready,imported,out} }], truncated }: numbers and state words only", async () => {
  const listed = await raw(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie });
  assert.equal(listed.status, 200, listed.text);
  // The planted facts the answer must never carry: names, GPEXE ids, candidate ids, labels.
  const planted = [...PLANTED_NAMES, ...PLANTED_SESSIONS, ...listed.body.candidates.flatMap((c) => [c.id, c.label].filter(Boolean))];
  assert.ok(listed.body.candidates.length >= 3, "the check stored the three sessions");

  let first = null;
  for (const [who, cookie] of [["coach", team.coach.cookie], ["club admin", team.clubAdmin.cookie], ["platform admin", team.padmin.cookie]]) {
    const res = await raw(`/teams/${team.teamId}/calendar${CAL}`, { cookie });
    assert.equal(res.status, 200, `${who}: ${res.text}`);
    assert.deepEqual(keysOf(res.body), ["days", "from", "to", "truncated"], `${who}: the top level`);
    assert.equal(typeof res.body.truncated, "boolean");
    assert.ok(res.body.days.length >= 2, `${who}: two days`);
    for (const day of res.body.days) {
      assert.deepEqual(keysOf(day), ["chips", "counts", "day"], `${who}: a day`);
      assert.match(day.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(keysOf(day.counts), [...STATES].sort(), `${who}: counts`);
      for (const n of Object.values(day.counts)) assert.ok(Number.isInteger(n) && n >= 0, `${who}: a whole number`);
      assert.ok(Array.isArray(day.chips) && day.chips.length <= 3);
      for (const chip of day.chips) assert.ok(STATES.includes(chip), `${who}: a chip is a state word (${chip})`);
    }
    for (const fact of planted) assert.ok(!res.text.includes(fact), `${who}: the answer carries no ${fact}`);
    if (first) assert.deepEqual(res.body, first, `${who}: the same answer for every audience`);
    first = res.body;
  }
  // The states the world made: ready and needs on 03.09 (UTC), out on 06.09.
  const byDay = Object.fromEntries(first.days.map((d) => [d.day, d.counts]));
  assert.deepEqual(byDay["2026-09-03"], { needs: 1, ready: 1, imported: 0, out: 0 });
  assert.deepEqual(byDay["2026-09-06"], { needs: 0, ready: 0, imported: 0, out: 1 });
});

test("K5-4 pin 2: a refusal is the identical 404 - an unknown team, another team's coach, another club's admin, an athlete, a coach in a club workspace for a team not hers", async () => {
  const unknown = await raw(`/teams/00000000-0000-4000-8000-000000000000/calendar${CAL}`, { cookie: team.coach.cookie });
  assert.equal(unknown.status, 404);
  const athlete = await athleteAccount(team.athleteIds[0]);
  // A coach of another team whose active workspace is this team's club: a club workspace grants a coach nothing here.
  const clubWorkspaceCoach = await makeUser("k54 coach in a club workspace");
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [clubWorkspaceCoach, other.teamId]);
  await setWorkspace(clubWorkspaceCoach, "club", team.clubId);
  for (const [who, cookie] of [
    ["another team's coach", other.coach.cookie],
    ["another club's admin, in its club workspace", other.clubAdmin.cookie],
    ["an athlete of the team", athlete.cookie],
    ["a coach in this team's club workspace, for a team not hers", await cookieFor(clubWorkspaceCoach)],
  ]) {
    const res = await raw(`/teams/${team.teamId}/calendar${CAL}`, { cookie });
    assert.deepEqual([res.status, res.body], [unknown.status, unknown.body], `${who}: the identical 404`);
  }
  // The workspace guard, not the right: the team's OWN coach who also coaches another team, while that other team's
  // workspace is the active one, gets the same 404. (A club workspace she holds no club role for is not honoured -
  // resolveActiveWorkspace falls back to a workspace she may use - so that one cannot be her active workspace.)
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [team.coach.id, other.teamId]);
  await setWorkspace(team.coach.id, "team", other.teamId);
  try {
    const res = await raw(`/teams/${team.teamId}/calendar${CAL}`, { cookie: team.coach.cookie });
    assert.deepEqual([res.status, res.body], [unknown.status, unknown.body], "the team's own coach in another team's workspace: the identical 404");
  } finally {
    await setWorkspace(team.coach.id, "team", team.teamId);
    await admin.query(`delete from public.user_team_roles where user_id = $1 and team_id = $2`, [team.coach.id, other.teamId]);
  }
  const back = await raw(`/teams/${team.teamId}/calendar${CAL}`, { cookie: team.coach.cookie });
  assert.equal(back.status, 200, "and in her team workspace she reads it again");
});
