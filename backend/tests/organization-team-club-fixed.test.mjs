// D43 (the owner, 2026-11-02): a team's club is fixed after creation.
// PUT /api/organization/teams/:teamId keeps the stored club: the same clubId
// (or none) edits the team as before, another clubId is a 409 and nothing is
// written; the rights are decided before the comparison.
// D44 (the owner, 2026-11-02): a club restores an archived team
// (PUT …/teams/:teamId/restore, the club's admin or a platform admin only),
// and a name taken in the club is a 409 that names an archived team.
//
// One disposable database through the real runner (support/calendar-
// fixture.mjs, which starts the whole app); the real route over HTTP with real
// session cookies. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

let env;
let m;

before(async () => {
  env = await startCalendarApp({ label: "d43team" });
  // The scaffold's teams carry only the columns the calendar reads; the route
  // writes the real table's.
  await env.q(`alter table public.teams
    add column if not exists short_name text, add column if not exists logo_url text,
    add column if not exists updated_at timestamptz not null default now()`);
  // The legacy schema's name rule (archived teams included), which the
  // scaffold does not carry.
  await env.q(`alter table public.teams add constraint teams_club_name_unique unique (club_id, name)`);
  m = await calendarRoleMatrix(env, "d43");
});

after(async () => {
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const put = (cookie, teamId, body) => env.api(`/api/organization/teams/${teamId}`, { method: "PUT", cookie, body });
const teamRow = async (teamId) => (await q(`select club_id, name, short_name, logo_url, updated_at from public.teams where id = $1`, [teamId]))[0];

test("1. the same club edits the team as before; no clubId keeps the stored club; the id's case does not matter", async () => {
  const { clubs, teams, roles } = m;
  let res = await put(roles.clubAdmin.cookie, teams.t2, { name: "Renamed T2", shortName: "RT2", clubId: clubs.c1 });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.team.club_id, res.body.team.name, res.body.team.short_name], [clubs.c1, "Renamed T2", "RT2"]);
  res = await put(roles.clubAdmin.cookie, teams.t2, { name: "Renamed again" });
  assert.equal(res.status, 200, res.text);
  assert.equal((await teamRow(teams.t2)).club_id, clubs.c1);
  res = await put(roles.clubAdmin.cookie, teams.t2, { name: "Upper case", clubId: clubs.c1.toUpperCase() });
  assert.equal(res.status, 200, res.text);
  assert.equal((await put(roles.clubAdmin.cookie, teams.t2, { clubId: clubs.c1 })).body.error, "Team name is required.");
});

test("2. another club is a 409 for every manager of the team — its club admin, an admin of both clubs, a platform admin — and nothing is written", async () => {
  const { clubs, teams, roles } = m;
  for (const [who, role] of [["the club admin", roles.clubAdmin], ["an admin of both clubs", roles.twoClubAdmin], ["a platform admin", roles.platformAdmin]]) {
    const before = await teamRow(teams.t2);
    const res = await put(role.cookie, teams.t2, { name: "Moved?", clubId: clubs.c2 });
    assert.equal(res.status, 409, `${who}: ${res.text}`);
    assert.deepEqual(res.body, { error: "team_club_fixed", message: "A team's club cannot be changed." }, who);
    assert.deepEqual(await teamRow(teams.t2), before, `${who}: nothing written`);
  }
});

test("3. the rights come first, as before: another club's admin and the team's own coach get the existing refusals, whatever clubId they send", async () => {
  const { clubs, teams, roles } = m;
  const before = await teamRow(teams.t1);
  for (const clubId of [clubs.c1, clubs.c2, undefined]) {
    const foreign = await put(roles.stranger.cookie, teams.t1, { name: "Not yours", clubId });
    assert.deepEqual([foreign.status, foreign.body.error], [403, "Team is outside your access."], foreign.text);
    // The team coach may manage the team's athletes, never the team itself (its club's right, unchanged).
    const coach = await put(roles.teamCoach.cookie, teams.t1, { name: "Coach edit", clubId });
    assert.deepEqual([coach.status, coach.body.error], [403, "Club is outside your access."], coach.text);
  }
  assert.deepEqual(await teamRow(teams.t1), before, "nothing written");
  const unknown = await put(roles.platformAdmin.cookie, "00000000-0000-4000-8000-000000000000", { name: "Ghost", clubId: clubs.c1 });
  assert.deepEqual([unknown.status, unknown.body.error], [404, "Team not found."]);
});

// ---------------------------------------------------------------------------
// D44
// ---------------------------------------------------------------------------
const restore = (cookie, teamId) => env.api(`/api/organization/teams/${teamId}/restore`, { method: "PUT", cookie });
const archive = (cookie, teamId) => env.api(`/api/organization/teams/${teamId}`, { method: "DELETE", cookie });
const createTeam = (cookie, body) => env.api("/api/organization/teams", { method: "POST", cookie, body });
const activeOf = async (teamId) => (await q(`select coalesce(is_active, true) as active from public.teams where id = $1`, [teamId]))[0].active;

test("4. a club restores its archived team: its admin and a platform admin get 200, an active team answers 200 as it is", async () => {
  const { clubs, roles } = m;
  for (const role of [roles.clubAdmin, roles.platformAdmin]) {
    const teamId = await env.fx.makeTeam(clubs.c1, `D44 restore ${uid()}`);
    assert.equal((await archive(roles.clubAdmin.cookie, teamId)).status, 200);
    assert.equal(await activeOf(teamId), false);
    const res = await restore(role.cookie, teamId);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([res.body.team.id, res.body.restored], [teamId, true]);
    assert.equal(await activeOf(teamId), true);
    const again = await restore(role.cookie, teamId);
    assert.deepEqual([again.status, again.body.restored], [200, false], "idempotent");
  }
});

test("5. the team's coach, another club's admin and anyone else get the answer of a foreign team, and nothing changes; an unknown id is that answer too (a platform admin: 404)", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D44 refused ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D44 coach");
  assert.equal((await archive(roles.clubAdmin.cookie, teamId)).status, 200);
  const foreign = { status: 403, error: "Team is outside your access." };
  for (const [who, cookie] of [["the team's coach", coach.cookie], ["another club's admin", roles.stranger.cookie]]) {
    const res = await restore(cookie, teamId);
    assert.deepEqual([res.status, res.body.error], [foreign.status, foreign.error], `${who}: ${res.text}`);
  }
  assert.equal(await activeOf(teamId), false, "nothing changed");
  for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const res = await restore(roles.clubAdmin.cookie, id);
    assert.deepEqual([res.status, res.body.error], [foreign.status, foreign.error], res.text);
  }
  const platformUnknown = await restore(roles.platformAdmin.cookie, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual([platformUnknown.status, platformUnknown.body.error], [404, "Team not found."]);
});

test("6. a team of an archived club is not restored before its club", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c3, `D44 archived club ${uid()}`);
  await q(`update public.teams set is_active = false where id = $1`, [teamId]);
  const res = await restore(roles.platformAdmin.cookie, teamId);
  assert.deepEqual([res.status, res.body.error], [409, "club_archived"], res.text);
  const own = await restore(roles.archivedAdmin.cookie, teamId);
  assert.deepEqual([own.status, own.body.error], [409, "club_archived"], `the archived club's own admin: ${own.text}`);
  const stranger = await restore(roles.stranger.cookie, teamId);
  assert.deepEqual([stranger.status, stranger.body.error], [403, "Team is outside your access."], `another club's admin learns nothing: ${stranger.text}`);
  assert.equal(await activeOf(teamId), false);
});

test("7. after a restore the coach reads the team's events again; the athletes' memberships are not touched", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D44 season ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D44 season coach");
  await env.fx.makeAthlete(`D44 season athlete ${uid()}`, { clubId: clubs.c1, teamId });
  const types = (await env.api("/api/calendar/events/types", { cookie: coach.cookie })).body.types;
  const day = addDays(new Date().toISOString().slice(0, 10), 1);
  const created = await env.api("/api/calendar/events", { method: "POST", cookie: coach.cookie, body: {
    requestKey: newKey(), eventTypeId: types.find((t) => t.key === "training").id, title: "Season event", day, timezone: "UTC", targets: [{ kind: "team", id: teamId }] } });
  assert.equal(created.status, 201, created.text);
  const memberships = async () => q(`select to_jsonb(m) as row from public.athlete_memberships m where m.team_id = $1 order by m.id`, [teamId]);
  const before = await memberships();
  assert.equal((await archive(roles.clubAdmin.cookie, teamId)).status, 200);
  assert.equal((await restore(roles.clubAdmin.cookie, teamId)).status, 200);
  assert.deepEqual(await memberships(), before, "memberships exactly as they were");
  const cal = await env.api(`/api/calendar?from=${day}&to=${day}`, { cookie: coach.cookie });
  assert.equal(cal.status, 200, cal.text);
  assert.ok((cal.body.days || []).flatMap((d) => d.items).some((i) => i.eventId === created.body.event.id), "the coach reads the team's event again");
});

test("8. a name taken in the club is a 409 that says whether the other team is archived (and then names it), on create and on rename; another club may use it", async () => {
  const { clubs, roles } = m;
  const name = `D44 U17 ${uid()}`;
  const active = await createTeam(roles.clubAdmin.cookie, { name, clubId: clubs.c1 });
  assert.equal(active.status, 201, active.text);
  let res = await createTeam(roles.clubAdmin.cookie, { name, clubId: clubs.c1 });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.body, { error: "team_name_taken", archived: false, message: "A team with this name already exists in this club." });

  assert.equal((await archive(roles.clubAdmin.cookie, active.body.team.id)).status, 200);
  res = await createTeam(roles.clubAdmin.cookie, { name, clubId: clubs.c1 });
  assert.equal(res.status, 409, res.text);
  assert.deepEqual(res.body, { error: "team_name_taken", archived: true, teamId: active.body.team.id, message: "An archived team with this name exists in this club — restore it instead." });

  const other = await createTeam(roles.clubAdmin.cookie, { name: `${name} B`, clubId: clubs.c1 });
  res = await put(roles.clubAdmin.cookie, other.body.team.id, { name });
  assert.deepEqual([res.status, res.body.error, res.body.archived, res.body.teamId], [409, "team_name_taken", true, active.body.team.id]);
  assert.equal((await put(roles.clubAdmin.cookie, other.body.team.id, { name: `${name} B` })).status, 200, "its own name is no clash");

  const elsewhere = await createTeam(roles.twoClubAdmin.cookie, { name, clubId: clubs.c2 });
  assert.equal(elsewhere.status, 201, elsewhere.text);
  // A caller who may not manage the club learns nothing: the club right comes before the write.
  const stranger = await createTeam(roles.stranger.cookie, { name, clubId: clubs.c1 });
  assert.deepEqual([stranger.status, stranger.body.error], [403, "Club is outside your access."]);
});

// GET /api/organization reads legacy columns the disposable scaffold does not
// carry, so its two D44 parts are checked directly: the loader (with the real
// authorization context of each role) and the workspace narrowing.
test("9. the archived teams are listed only to whoever may restore them, in the workspace's scope", async () => {
  const { clubs, roles } = m;
  const { archivedTeamsForWorkspace, loadArchivedTeams } = await import("../src/routes/organization.js");
  const { loadAuthorizationContext } = await import("../src/authz.js");
  const teamId = await env.fx.makeTeam(clubs.c1, `D44 listed ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D44 listed coach");
  const archivedClubTeam = await env.fx.makeTeam(clubs.c3, `D44 listed archived club ${uid()}`);
  await q(`update public.teams set is_active = false where id = any($1::uuid[])`, [[teamId, archivedClubTeam]]);
  const listed = async (role) => {
    const user = (await q(`select * from public.users where id = $1`, [role.id]))[0];
    return (await loadArchivedTeams({ user, authz: await loadAuthorizationContext(user) })).map((t) => [t.id, t.club_active]);
  };
  const forAdmin = await listed(roles.clubAdmin);
  assert.ok(forAdmin.some(([id]) => id === teamId), "the club's admin");
  assert.ok(!forAdmin.some(([id]) => id === archivedClubTeam), "not a team of an archived club");
  const noClubTeam = await env.fx.makeTeam(clubs.c1, `D44 listed no club ${uid()}`);
  await q(`update public.teams set is_active = false, club_id = null where id = $1`, [noClubTeam]);
  const forPlatform = await listed(roles.platformAdmin);
  assert.deepEqual(forPlatform.find(([id]) => id === archivedClubTeam), [archivedClubTeam, false], "a platform admin, with the club's state");
  assert.deepEqual(forPlatform.find(([id]) => id === noClubTeam), [noClubTeam, false], "a team without a club is not restorable either");
  const noClubRestore = await restore(roles.platformAdmin.cookie, noClubTeam);
  assert.equal(noClubRestore.status, 403, `the route refuses it as the list says: ${noClubRestore.text}`);
  assert.deepEqual(await listed(coach), [], "never the coach");
  assert.ok(!(await listed(roles.stranger)).some(([id]) => id === teamId), "never another club's admin");

  const rows = [{ id: "a", club_id: "c1" }, { id: "b", club_id: "c2" }];
  assert.deepEqual(archivedTeamsForWorkspace({ type: "platform" }, rows), rows);
  assert.deepEqual(archivedTeamsForWorkspace({ type: "club", scopeId: "c2" }, rows), [rows[1]]);
  for (const type of ["team", "private_coach", "athlete"]) assert.deepEqual(archivedTeamsForWorkspace({ type, scopeId: "c1" }, rows), [], type);
  assert.deepEqual(archivedTeamsForWorkspace(null, rows), []);
});
