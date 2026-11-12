// MT-0 through the real check and approval routes (disposable database): the deduplicated athlete is imported once with the
// lowest track's identities and its details as GPEXE gives them (E1 decided); a second search gives the same preview hash; a
// later GPEXE cleanup that removes the ignored track is "nothing new", one that removes the used track is today's
// identities_missing_from_source; a candidate stored before MT-0 is refused with preview_changed, then imported; an already
// imported session whose content did not change is not reopened.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { bindThroughRoutes, createFakeSource } from "./support/gpexe-fake-source.mjs";
import { enableTeamImportSwitch } from "./support/team-import-switch.mjs";
import { activateBinding } from "./support/mapped-world.mjs";

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

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "mt0", migrations: GPEXE_TEST_MIGRATIONS.filter((m) => !m.includes("app_error_events")) });
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
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
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

// Athlete 106 is one recording sent on two identical tracks (9207, and the lower 9206 listed second); keep = which of them GPEXE
// still sends (both, or only one after a cleanup).
function bundleOf({ sessionId, keep = [9207, 9206], updatedOn = "2026-09-14T20:18:09.337" }) {
  const std = standardAthletes();
  const athletes = [structuredClone(std[0]), structuredClone(std[1])];
  athletes[0].tracks = [sessionId * 10 + 1];
  athletes[1].tracks = [sessionId * 10 + 2];
  for (const a of athletes) for (const part of a.parts) delete part.track;
  // Both tracks are always built, then a dropped one is removed: GPEXE keeps a row's id, so the kept rows keep theirs.
  const both = [9207, 9206];
  const dup = { id: 106, tracks: both, parts: [] };
  for (const track of both) for (const part of std[1].parts) dup.parts.push({ ...structuredClone(part), track });
  athletes.push(dup);
  const bundle = makeBundle({ detailsDrills: [0, 1], sessionId, gpexeTeamId: 77, start: "2026-09-14T10:08:12", updatedOn, athletes });
  const dropped = new Set(both.filter((t) => !keep.includes(t)).map(String));
  for (const row of bundle.athleteSessions.filter((r) => dropped.has(String(r.track)))) delete bundle.more[String(row.id)];
  bundle.athleteSessions = bundle.athleteSessions.filter((r) => !dropped.has(String(r.track)));
  for (const t of dropped) delete bundle.tracks[t];
  return bundle;
}

let nextGpexeTeamId = 8600;
async function setupTeam() {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["Ana", "Bea", "Dup"] });
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
  const [a, b, d] = org.athleteIds;
  for (const [gpexeAthleteId, athleteId] of [["101", a], ["102", b], ["106", d]]) {
    assert.equal((await api(`/teams/${org.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId, athleteId } })).status, 201);
  }
  return { ...org, coach, padmin, sourceTeamId };
}

async function checkNow(team, bundles) {
  src.serve(team.sourceTeamId, bundles);
  const started = await api(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: { from: D1, to: D1 } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200; i += 1) {
    const r = await api(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("check did not finish");
}
const candidates = async (team) => (await api(`/teams/${team.teamId}/candidates`, { cookie: team.padmin.cookie })).body.candidates;
const detailOf = async (team, id) => (await api(`/teams/${team.teamId}/candidates/${id}`, { cookie: team.padmin.cookie })).body.candidate;

async function approve(team, cand) {
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    return await api(`/teams/${team.teamId}/imports`, {
      method: "POST", cookie: team.padmin.cookie, body: { candidateIds: [cand.id], previewHashes: { [cand.id]: cand.previewHash } },
    });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}

const identitiesOf = async (teamId, athleteId) => (await admin.query(
  `select si.source_external_id
     from training_load.metric_source_identities si
     join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
     join training_load.metric_event_participants p on p.id = o.event_participant_id
     join training_load.metric_events e on e.id = p.event_id
    where e.owner_team_id = $1 and p.athlete_id = $2 order by 1`,
  [teamId, athleteId],
)).rows.map((r) => r.source_external_id);

test("1. a session whose athlete 106 is sent on two identical tracks: the preview labels it, keeps its details (E1 decided), and the import writes it once, from track 9206, with that track's native identities; a second search gives the same preview hash", async () => {
  const team = await setupTeam();
  const bundle = bundleOf({ sessionId: 9501 });
  await checkNow(team, [bundle]);
  const cand = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "9501" && c.status === "pending");
  assert.ok(cand, "a pending candidate");
  const detail = await detailOf(team, cand.id);
  assert.equal(detail.preview.status, "ready", JSON.stringify(detail.preview.blocked));
  const entry = detail.preview.athletes.find((a) => a.gpexeAthleteId === "106");
  assert.deepEqual(entry.duplicateTracks, { count: 2, usedTrackId: "9206", ignoredTrackIds: ["9207"] });
  assert.equal(entry.notImported, null);
  assert.deepEqual(entry.skippedValues, [], "nothing of the deduplicated athlete is left out");
  assert.equal(detail.preview.athletes.filter((a) => a.gpexeAthleteId !== "106").every((a) => !("duplicateTracks" in a)), true, "only the deduplicated athlete carries the label");

  // The same bundle searched again: unchanged, the same preview hash.
  await checkNow(team, [bundle]);
  const again = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "9501" && c.status === "pending");
  assert.equal(again.id, cand.id);
  assert.equal(again.previewHash, cand.previewHash);

  const r = await approve(team, again);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.results[0].outcome, "imported", r.text);
  const used = bundle.athleteSessions.filter((x) => String(x.athlete) === "106" && String(x.track) === "9206");
  const expected = used.map((x) => (x.drill === null ? `athlete_session:${x.id}:full` : `athlete_session:${x.id}:drill:${x.drill}`)).sort();
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), expected);
  const keys = (await admin.query(
    `select d.key from training_load.metric_values v
       join training_load.metric_measurement_occasions o on o.id = v.occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
       join training_load.metric_definitions d on d.id = v.metric_definition_id
      where p.athlete_id = $1 and o.segment_id is null`, [team.athleteIds[2]])).rows.map((x) => x.key);
  assert.equal(keys.filter((k) => /burst/.test(k)).length, 1, "burst once, as the details give it");
  assert.equal(keys.filter((k) => /brake/.test(k)).length, 1, "brake once, as the details give it");
});

test("2. a later GPEXE cleanup: removing the ignored track (9207) keeps the same identities and the same values (nothing to import again); removing the used one (9206) leaves another row id, so the session is blocked as identities_missing_from_source", async () => {
  const team = await setupTeam();
  await checkNow(team, [bundleOf({ sessionId: 9502 })]);
  const cand = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "9502" && c.status === "pending");
  assert.equal((await approve(team, cand)).body.results[0].outcome, "imported");
  const before = await identitiesOf(team.teamId, team.athleteIds[2]);

  await checkNow(team, [bundleOf({ sessionId: 9502, keep: [9206], updatedOn: "2026-09-15T09:00:00.000" })]);
  const kept = (await candidates(team)).filter((c) => c.gpexeTeamSessionId === "9502" && c.status === "pending");
  assert.equal(kept.length, 1, "the changed session is one pending candidate");
  for (const c of kept) {
    const d = await detailOf(team, c.id);
    const e = d.preview.athletes.find((a) => a.gpexeAthleteId === "106");
    // The same identities and the same values: the deduplicated import was already the single recording.
    assert.deepEqual(e.results.map((x) => x.outcome), ["unchanged", "unchanged"], JSON.stringify(e.results.map((x) => x.outcome)));
    for (const res of e.results) assert.deepEqual(res.values.filter((v) => v.change !== "same"), [], JSON.stringify(res.values));
    assert.equal("duplicateTracks" in e, false, "one track now: no label");
  }
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), before);

  const team2 = await setupTeam();
  await checkNow(team2, [bundleOf({ sessionId: 9503 })]);
  const c2 = (await candidates(team2)).find((c) => c.gpexeTeamSessionId === "9503" && c.status === "pending");
  assert.equal((await approve(team2, c2)).body.results[0].outcome, "imported");
  await checkNow(team2, [bundleOf({ sessionId: 9503, keep: [9207], updatedOn: "2026-09-15T09:00:00.000" })]);
  const blocked = (await candidates(team2)).find((c) => c.gpexeTeamSessionId === "9503" && c.status !== "imported" && c.status !== "superseded");
  assert.ok(blocked);
  const d2 = await detailOf(team2, blocked.id);
  assert.equal(d2.preview.blocked?.code, "identities_missing_from_source");
});

test("3. a pending candidate stored before MT-0 (another preview hash): the approval with that hash is refused with preview_changed and writes nothing; reviewed again, it imports the athlete once from track 9206", async () => {
  const team = await setupTeam();
  await checkNow(team, [bundleOf({ sessionId: 9504 })]);
  const fresh = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "9504" && c.status === "pending");
  // The stored preview of before this change (athlete 106 left out as multiple_tracks) had another hash.
  const oldHash = "0".repeat(64);
  await admin.query(`update training_load.gpexe_import_candidates set preview_hash = $2 where id = $1`, [fresh.id, oldHash]);
  const stale = (await candidates(team)).find((c) => c.id === fresh.id);
  assert.equal(stale.previewHash, oldHash);
  const refused = await approve(team, stale);
  assert.equal(refused.status, 200, refused.text);
  assert.deepEqual(refused.body.results.map((x) => [x.outcome, x.code]), [["refused", "preview_changed"]], refused.text);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_approvals where candidate_id = $1`, [fresh.id])).rows[0].n, 0);
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), []);

  const again = (await candidates(team)).find((c) => c.id === fresh.id);
  assert.notEqual(again.previewHash, oldHash, "the refusal stored today's preview");
  const r = await approve(team, again);
  assert.equal(r.body.results[0].outcome, "imported", r.text);
  const used = bundleOf({ sessionId: 9504 }).athleteSessions.filter((x) => String(x.athlete) === "106" && String(x.track) === "9206");
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), used.map((x) => (x.drill === null ? `athlete_session:${x.id}:full` : `athlete_session:${x.id}:drill:${x.drill}`)).sort());
});

test("4. an already imported session is not reopened: its content unchanged, the next search only records a sighting, so an athlete it left out stays out (the remedy is the undo)", async () => {
  const team = await setupTeam();
  const bundle = bundleOf({ sessionId: 9505 });
  await checkNow(team, [bundle]);
  const cand = (await candidates(team)).find((c) => c.gpexeTeamSessionId === "9505" && c.status === "pending");
  // Imported with athlete 106 left out (J20-B), as a pre-MT-0 import left it out as multiple_tracks.
  const subset = (await api(`/teams/${team.teamId}/candidates/${cand.id}/preview`, { method: "POST", cookie: team.padmin.cookie, body: { excludedAthleteIds: ["106"] } })).body.subset;
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  let done;
  try {
    done = await api(`/teams/${team.teamId}/candidates/${cand.id}/approve`, {
      method: "POST", cookie: team.padmin.cookie, body: { previewHash: subset.previewHash, subsetHash: subset.subsetHash, excludedAthleteIds: ["106"] },
    });
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
  assert.equal(done.body.outcome, "imported", done.text);
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), []);

  await checkNow(team, [bundle]);
  const rows = (await candidates(team)).filter((c) => c.gpexeTeamSessionId === "9505");
  assert.deepEqual(rows.map((c) => c.status), ["imported"], "one candidate, still imported: nothing new to approve");
  assert.deepEqual(await identitiesOf(team.teamId, team.athleteIds[2]), []);
});
