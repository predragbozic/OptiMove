// D43 (the owner, 2026-11-02): a team's club is fixed after creation.
// PUT /api/organization/teams/:teamId keeps the stored club: the same clubId
// (or none) edits the team as before, another clubId is a 409 and nothing is
// written; the rights are decided before the comparison.
//
// One disposable database through the real runner (support/calendar-
// fixture.mjs, which starts the whole app); the real route over HTTP with real
// session cookies. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { calendarRoleMatrix, startCalendarApp } from "./support/calendar-fixture.mjs";

let env;
let m;

before(async () => {
  env = await startCalendarApp({ label: "d43team" });
  // The scaffold's teams carry only the columns the calendar reads; the route
  // writes the real table's.
  await env.q(`alter table public.teams
    add column if not exists short_name text, add column if not exists logo_url text,
    add column if not exists updated_at timestamptz not null default now()`);
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
