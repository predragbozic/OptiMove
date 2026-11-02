// D45 (the owner, 2026-11-02): a restored team is empty, and only the club
// archives a team. DELETE /api/organization/teams/:teamId is the club's right
// (its admin or a platform admin, never the team's coach) and, in one
// transaction, archives the team and ends every active team membership of it
// the way Remove from team ends one: the archive fields, the closed v25 period,
// the legacy pointer. The athletes stay in the club; a restored team comes back
// without athletes; an archived team is neither renamed nor given a member.
//
// One disposable database through the real runner (support/calendar-
// fixture.mjs, which starts the whole app); the real routes over HTTP with real
// session cookies. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

let env;
let m;

before(async () => {
  env = await startCalendarApp({ label: "d45team" });
  // The scaffold carries only the columns the calendar reads; the routes write
  // the real tables' (the team's edit columns, the athlete's legacy pointer)
  // and the legacy schema's name rule.
  await env.q(`alter table public.teams
    add column if not exists short_name text, add column if not exists logo_url text,
    add column if not exists updated_at timestamptz not null default now()`);
  await env.q(`alter table public.teams add constraint teams_club_name_unique unique (club_id, name)`);
  await env.q(`alter table public.athletes
    add column if not exists club_id uuid, add column if not exists team_id uuid,
    add column if not exists updated_at timestamptz not null default now()`);
  m = await calendarRoleMatrix(env, "d45");
});

after(async () => {
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const TODAY = new Date().toISOString().slice(0, 10);
const archive = (cookie, teamId) => env.api(`/api/organization/teams/${teamId}`, { method: "DELETE", cookie });
const restore = (cookie, teamId) => env.api(`/api/organization/teams/${teamId}/restore`, { method: "PUT", cookie });
const rename = (cookie, teamId, body) => env.api(`/api/organization/teams/${teamId}`, { method: "PUT", cookie, body });
const addToTeam = (cookie, teamId, athleteId) => env.api(`/api/organization/teams/${teamId}/athletes`, { method: "POST", cookie, body: { athleteId } });
const removeFromTeam = (cookie, teamId, athleteId) => env.api(`/api/organization/teams/${teamId}/athletes/${athleteId}`, { method: "DELETE", cookie });
const restoreMembership = (cookie, teamId, athleteId) => env.api(`/api/organization/teams/${teamId}/athletes/${athleteId}/restore`, { method: "PUT", cookie });
const activeOf = async (teamId) => (await q(`select coalesce(is_active, true) as active from public.teams where id = $1`, [teamId]))[0].active;
const memberships = (athleteId) => q(
  `select m.id, m.club_id, m.team_id, m.membership_type as type, m.status, m.archived_at, m.archived_by_user_id, m.archive_reason, m.updated_at
     from public.athlete_memberships m where m.athlete_id = $1 order by m.membership_type, m.team_id nulls first`,
  [athleteId],
);
const openPeriods = async (membershipId) => (await q(`select count(*)::int as n from public.athlete_membership_periods where membership_id = $1 and valid_to is null`, [membershipId]))[0].n;
const pointer = async (athleteId) => (await q(`select club_id, team_id from public.athletes where id = $1`, [athleteId]))[0];
const activeTeamMembers = async (teamId) => (await q(
  `select count(*)::int as n from public.athlete_memberships where team_id = $1 and membership_type = 'team' and status = 'active'`, [teamId]))[0].n;

// An athlete of the team (club and team membership since 01.01.2026), the
// legacy pointer on that team, optionally also a member of a second team.
async function member(clubId, teamId, { alsoTeamId = null } = {}) {
  const a = await env.fx.makeAthlete(`D45 athlete ${uid()}`, { clubId, teamId });
  if (alsoTeamId) await env.fx.addMembership({ athleteId: a.athleteId, clubId, teamId: alsoTeamId, startsAt: "2026-02-01T00:00:00Z" });
  await q(`update public.athletes set club_id = $2, team_id = $3 where id = $1`, [a.athleteId, clubId, teamId]);
  return a;
}

// Waits until `n` sessions of this database wait on a lock (a race made
// deterministic: the side transaction holds what the request needs).
async function waitForLockWaiters(n) {
  for (let i = 0; i < 100; i += 1) {
    const waiting = (await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0].n;
    if (waiting >= n) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`fewer than ${n} sessions waited on a lock`);
}

test("1. the club's admin archives a team with its athletes: the team memberships end (archive fields, closed periods), the club memberships and another team's stay, the legacy pointer moves; a platform admin likewise", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 archived ${uid()}`);
  const otherTeam = await env.fx.makeTeam(clubs.c1, `D45 other ${uid()}`);
  const a1 = await member(clubs.c1, teamId);
  const a2 = await member(clubs.c1, teamId);
  const a3 = await member(clubs.c1, teamId, { alsoTeamId: otherTeam });

  const res = await archive(roles.clubAdmin.cookie, teamId);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.ok, res.body.archived, res.body.membershipsArchived], [true, true, 3]);
  assert.equal(await activeOf(teamId), false);
  for (const a of [a1, a2, a3]) {
    const rows = await memberships(a.athleteId);
    const club = rows.find((r) => r.type === "club");
    const team = rows.find((r) => r.type === "team" && r.team_id === teamId);
    assert.equal(club.status, "active", "the athlete stays in the club");
    assert.equal(await openPeriods(club.id), 1, "the club period stays open");
    assert.deepEqual([team.status, team.archived_by_user_id, team.archive_reason], ["archived", roles.clubAdmin.id, "team_archived"]);
    assert.ok(team.archived_at, "archived_at is set");
    assert.equal(await openPeriods(team.id), 0, "the team period is closed");
    assert.ok((await q(`select count(*)::int as n from public.athlete_membership_periods where membership_id = $1`, [team.id]))[0].n >= 1, "the history stays");
  }
  const other = (await memberships(a3.athleteId)).find((r) => r.team_id === otherTeam);
  assert.equal(other.status, "active", "another team's membership stays");
  assert.deepEqual(await pointer(a1.athleteId), { club_id: clubs.c1, team_id: null }, "the legacy pointer leaves the archived team");
  assert.deepEqual(await pointer(a3.athleteId), { club_id: clubs.c1, team_id: otherTeam }, "the legacy pointer moves to the remaining team");

  const platformTeam = await env.fx.makeTeam(clubs.c1, `D45 platform ${uid()}`);
  const p1 = await member(clubs.c1, platformTeam);
  const p2 = await member(clubs.c1, platformTeam);
  const byPlatform = await archive(roles.platformAdmin.cookie, platformTeam);
  assert.deepEqual([byPlatform.status, byPlatform.body.archived, byPlatform.body.membershipsArchived], [200, true, 2], byPlatform.text);
  for (const p of [p1, p2]) {
    const team = (await memberships(p.athleteId)).find((r) => r.type === "team");
    assert.deepEqual([team.status, team.archived_by_user_id], ["archived", roles.platformAdmin.id]);
  }
});

test("2. the team's coach, another club's admin and an unknown id get the answer of a foreign team, and nothing is written; a platform admin's unknown id is 404", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 refused ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D45 refused coach");
  const a = await member(clubs.c1, teamId);
  const before = await memberships(a.athleteId);
  for (const [who, cookie] of [["the team's coach", coach.cookie], ["another club's admin", roles.stranger.cookie], ["another team's coach", roles.teamCoach.cookie]]) {
    const res = await archive(cookie, teamId);
    assert.deepEqual([res.status, res.body.error], [403, "Team is outside your access."], `${who}: ${res.text}`);
  }
  assert.equal(await activeOf(teamId), true, "the team stays");
  assert.deepEqual(await memberships(a.athleteId), before, "nothing written");
  for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
    const res = await archive(roles.clubAdmin.cookie, id);
    assert.deepEqual([res.status, res.body.error], [403, "Team is outside your access."], res.text);
  }
  const unknown = await archive(roles.platformAdmin.cookie, "00000000-0000-4000-8000-000000000000");
  assert.deepEqual([unknown.status, unknown.body.error], [404, "Team not found."]);
});

test("3. an archived team: archived again is 200 with nothing written; it is not renamed (409 team_archived, after the rights) and takes no member back or new", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 settled ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D45 settled coach");
  const a = await member(clubs.c1, teamId);
  assert.equal((await archive(roles.clubAdmin.cookie, teamId)).status, 200);
  const team = async () => (await q(`select name, updated_at from public.teams where id = $1`, [teamId]))[0];
  const before = { team: await team(), memberships: await memberships(a.athleteId) };

  const again = await archive(roles.clubAdmin.cookie, teamId);
  assert.deepEqual([again.status, again.body.archived, again.body.membershipsArchived], [200, false, 0], again.text);
  assert.deepEqual({ team: await team(), memberships: await memberships(a.athleteId) }, before, "nothing new");

  const renamed = await rename(roles.clubAdmin.cookie, teamId, { name: `D45 renamed ${uid()}` });
  assert.deepEqual([renamed.status, renamed.body.error], [409, "team_archived"], renamed.text);
  const foreign = await rename(roles.stranger.cookie, teamId, { name: "Not yours" });
  assert.deepEqual([foreign.status, foreign.body.error], [403, "Team is outside your access."], "the rights come first");
  const byCoach = await rename(coach.cookie, teamId, { name: "Coach" });
  assert.deepEqual([byCoach.status, byCoach.body.error], [403, "Club is outside your access."]);

  const back = await restoreMembership(roles.clubAdmin.cookie, teamId, a.athleteId);
  assert.deepEqual([back.status, back.body.error], [409, "team_archived"], back.text);
  const added = await addToTeam(roles.clubAdmin.cookie, teamId, a.athleteId);
  assert.equal(added.status, 404, added.text);
  assert.deepEqual({ team: await team(), memberships: await memberships(a.athleteId) }, before, "nothing written");
});

test("4. the calendar: an archived team's athlete keeps its earlier days and sees none after; a restored team comes back empty, its coach reads its new events and no former athlete does", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 calendar ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D45 calendar coach");
  const a = await member(clubs.c1, teamId);
  const types = (await env.api("/api/calendar/events/types", { cookie: coach.cookie })).body.types;
  const training = types.find((t) => t.key === "training").id;
  const create = async (day, title) => {
    const res = await env.api("/api/calendar/events", { method: "POST", cookie: coach.cookie, body: {
      requestKey: newKey(), eventTypeId: training, title, day, timezone: "UTC", targets: [{ kind: "team", id: teamId }] } });
    assert.equal(res.status, 201, res.text);
    return res.body.event.id;
  };
  const yesterday = addDays(TODAY, -1);
  const tomorrow = addDays(TODAY, 1);
  const earlier = await create(yesterday, "Earlier session");
  const later = await create(tomorrow, "Later session");
  const sees = async (cookie, eventId) => {
    const res = await env.api(`/api/calendar?from=${yesterday}&to=${tomorrow}`, { cookie });
    assert.equal(res.status, 200, res.text);
    return (res.body.days || []).flatMap((d) => d.items).some((i) => i.kind === "event" && (i.eventId ?? i.links?.eventId) === eventId);
  };
  assert.equal(await sees(a.cookie, earlier), true);
  assert.equal(await sees(a.cookie, later), true);

  assert.equal((await archive(roles.clubAdmin.cookie, teamId)).status, 200);
  assert.equal(await sees(a.cookie, earlier), true, "the earlier day stays in the athlete's history");
  assert.equal(await sees(a.cookie, later), false, "no day after the archive");

  const restored = await restore(roles.clubAdmin.cookie, teamId);
  assert.deepEqual([restored.status, restored.body.restored], [200, true], restored.text);
  assert.equal(await activeTeamMembers(teamId), 0, "the restored team is empty");
  const next = await create(addDays(TODAY, 2), "New season");
  const window = await env.api(`/api/calendar?from=${yesterday}&to=${addDays(TODAY, 2)}`, { cookie: a.cookie });
  assert.ok(!(window.body.days || []).flatMap((d) => d.items).some((i) => (i.eventId ?? i.links?.eventId) === next), "a former athlete does not see the new season");
  const coachView = await env.api(`/api/calendar?from=${addDays(TODAY, 2)}&to=${addDays(TODAY, 2)}`, { cookie: coach.cookie });
  assert.ok((coachView.body.days || []).flatMap((d) => d.items).some((i) => (i.eventId ?? i.links?.eventId) === next), "the coach (role kept) reads it");
});

test("5. Remove from team (the same helper, one athlete) ends only that athlete's membership, with its period and pointer", async () => {
  const { clubs } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 remove ${uid()}`);
  const coach = await env.fx.coachOf(teamId, "D45 remove coach");
  const a = await member(clubs.c1, teamId);
  const b = await member(clubs.c1, teamId);
  const res = await removeFromTeam(coach.cookie, teamId, a.athleteId);
  assert.equal(res.status, 200, res.text);
  const ended = (await memberships(a.athleteId)).find((r) => r.type === "team");
  assert.deepEqual([ended.status, ended.archived_by_user_id], ["archived", coach.id]);
  assert.equal(await openPeriods(ended.id), 0);
  assert.deepEqual(await pointer(a.athleteId), { club_id: clubs.c1, team_id: null });
  assert.equal((await memberships(b.athleteId)).find((r) => r.type === "team").status, "active", "the other athlete stays");
  assert.equal(await activeOf(teamId), true);
  const again = await removeFromTeam(coach.cookie, teamId, a.athleteId);
  assert.equal(again.status, 404, "nothing left to end");
});

test("6. an archive races an athlete joining the team: the archive first leaves nothing to join (409 team_archived), the join first is ended by the archive; never a 500, never an active membership in an archived team", async () => {
  const { clubs, roles } = m;
  const clubOnly = async () => {
    const a = await env.fx.makeAthlete(`D45 joining ${uid()}`, { clubId: clubs.c1 });
    await q(`update public.athletes set club_id = $2 where id = $1`, [a.athleteId, clubs.c1]);
    return a;
  };
  const side = new pg.Client({ connectionString: env.db.url });
  await side.connect();
  try {
    // The archive first: it holds the team and waits on the memberships, the
    // join reads the team as active, then waits for the archive's team lock.
    const t1 = await env.fx.makeTeam(clubs.c1, `D45 race archive first ${uid()}`);
    await member(clubs.c1, t1);
    const j1 = await clubOnly();
    await side.query("begin");
    await side.query("lock table public.athlete_memberships in exclusive mode");
    const archived = archive(roles.clubAdmin.cookie, t1);
    await waitForLockWaiters(1);
    const joined = addToTeam(roles.clubAdmin.cookie, t1, j1.athleteId);
    await waitForLockWaiters(2);
    await side.query("commit");
    const [ra, rj] = await Promise.all([archived, joined]);
    assert.deepEqual([ra.status, ra.body.archived], [200, true], ra.text);
    assert.deepEqual([rj.status, rj.body.error], [409, "team_archived"], rj.text);
    assert.equal(await activeTeamMembers(t1), 0, "no member in the archived team");

    // The join first: it holds the team's share lock; the archive waits, then
    // ends the new membership with the others.
    const t2 = await env.fx.makeTeam(clubs.c1, `D45 race join first ${uid()}`);
    await member(clubs.c1, t2);
    const j2 = await clubOnly();
    await side.query("begin");
    await side.query(`select id from public.teams where id = $1 for share`, [t2]);
    const archived2 = archive(roles.clubAdmin.cookie, t2);
    await waitForLockWaiters(1);
    const rj2 = await addToTeam(roles.clubAdmin.cookie, t2, j2.athleteId);
    assert.equal(rj2.status, 200, `the join goes through first: ${rj2.text}`);
    await side.query("commit");
    const ra2 = await archived2;
    assert.deepEqual([ra2.status, ra2.body.membershipsArchived], [200, 2], ra2.text);
    assert.equal(await activeTeamMembers(t2), 0, "the archive ended the joined membership too");
    assert.equal((await memberships(j2.athleteId)).find((r) => r.type === "team").status, "archived");
  } finally {
    await side.query("rollback").catch(() => {});
    await side.end().catch(() => {});
  }
});

test("7. the archive's waits are bounded: a team held by another transaction answers 409 try_again with nothing written", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 busy ${uid()}`);
  const a = await member(clubs.c1, teamId);
  const before = await memberships(a.athleteId);
  const side = new pg.Client({ connectionString: env.db.url });
  await side.connect();
  try {
    await side.query("begin");
    await side.query(`select id from public.teams where id = $1 for share`, [teamId]);
    const started = Date.now();
    const answer = await Promise.race([archive(roles.clubAdmin.cookie, teamId), new Promise((res) => setTimeout(() => res(null), 9000))]);
    assert.ok(answer, "the archive answered while the team was still held");
    assert.deepEqual([answer.status, answer.body.error], [409, "try_again"], answer.text);
    assert.ok(Date.now() - started < 9000);
  } finally {
    await side.query("rollback").catch(() => {});
    await side.end().catch(() => {});
  }
  assert.equal(await activeOf(teamId), true, "nothing written");
  assert.deepEqual(await memberships(a.athleteId), before);
});

test("8. editing an athlete of the team while the team is archived: one lock order, so the archive goes through and the edit is 409 team_archived, never a 500", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 edited ${uid()}`);
  const a = await member(clubs.c1, teamId);
  const side = new pg.Client({ connectionString: env.db.url });
  await side.connect();
  try {
    // The archive holds the team and waits on the memberships; the edit then
    // waits for the team, holding nothing the archive needs (the athlete row
    // comes after the team).
    await side.query("begin");
    await side.query("lock table public.athlete_memberships in exclusive mode");
    const archived = archive(roles.clubAdmin.cookie, teamId);
    await waitForLockWaiters(1);
    const edited = env.api(`/api/organization/athletes/${a.athleteId}`, { method: "PUT", cookie: roles.clubAdmin.cookie, body: { fullName: "D45 edited athlete", clubId: clubs.c1, teamId } });
    await waitForLockWaiters(2);
    await side.query("commit");
    const [ra, re] = await Promise.all([archived, edited]);
    assert.deepEqual([ra.status, ra.body.archived], [200, true], ra.text);
    assert.deepEqual([re.status, re.body.error], [409, "team_archived"], re.text);
  } finally {
    await side.query("rollback").catch(() => {});
    await side.end().catch(() => {});
  }
  assert.equal(await activeTeamMembers(teamId), 0);
  assert.deepEqual(await pointer(a.athleteId), { club_id: clubs.c1, team_id: null }, "the edit wrote nothing");
});

test("9. a team of an archived club is not archived (as it is not restored): 409 club_archived after the club's right, nothing written", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c3, `D45 archived club ${uid()}`);
  const a = await member(clubs.c3, teamId);
  const before = await memberships(a.athleteId);
  for (const [who, cookie] of [["the archived club's admin", roles.archivedAdmin.cookie], ["a platform admin", roles.platformAdmin.cookie]]) {
    const res = await archive(cookie, teamId);
    assert.deepEqual([res.status, res.body.error], [409, "club_archived"], `${who}: ${res.text}`);
  }
  const foreign = await archive(roles.clubAdmin.cookie, teamId);
  assert.deepEqual([foreign.status, foreign.body.error], [403, "Team is outside your access."], "another club's admin learns nothing");
  assert.equal(await activeOf(teamId), true);
  assert.deepEqual(await memberships(a.athleteId), before);
});

test("10. restoring a team membership locks the club membership before the team membership (the one lock order)", async () => {
  const { clubs, roles } = m;
  const teamId = await env.fx.makeTeam(clubs.c1, `D45 order ${uid()}`);
  const a = await member(clubs.c1, teamId);
  assert.equal((await removeFromTeam(roles.clubAdmin.cookie, teamId, a.athleteId)).status, 200);
  const holder = new pg.Client({ connectionString: env.db.url });
  const prober = new pg.Client({ connectionString: env.db.url });
  await holder.connect();
  await prober.connect();
  try {
    // The club membership is held: the restore waits there, before it takes the team membership.
    await holder.query("begin");
    await holder.query(
      `select id from public.athlete_memberships where athlete_id = $1 and club_id = $2 and membership_type = 'club' for update`,
      [a.athleteId, clubs.c1],
    );
    const restored = restoreMembership(roles.clubAdmin.cookie, teamId, a.athleteId);
    await waitForLockWaiters(1);
    await prober.query("begin");
    const free = await prober.query(
      `select id from public.athlete_memberships where athlete_id = $1 and team_id = $2 and membership_type = 'team' for update nowait`,
      [a.athleteId, teamId],
    );
    assert.equal(free.rows.length, 1, "the team membership is not yet held by the restore");
    await prober.query("rollback");
    await holder.query("rollback");
    const answer = await restored;
    assert.equal(answer.status, 200, answer.text);
  } finally {
    await prober.query("rollback").catch(() => {});
    await holder.query("rollback").catch(() => {});
    await prober.end().catch(() => {});
    await holder.end().catch(() => {});
  }
  assert.equal((await memberships(a.athleteId)).find((r) => r.type === "team").status, "active");
});
