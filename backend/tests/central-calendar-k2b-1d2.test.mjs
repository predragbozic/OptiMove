// Central calendar K2b-1d2 (docs/ai/central-calendar-k2b-plan.md section 23, the manager's decisions in 23.6):
//   - every event card carries its type's icon and colour (eventTypeIconKey / eventTypeColorKey) - a manager's, a
//     reader's and the athlete's - under D41, as the type's label: a club's type only on an event of that club now;
//   - the platform workspace names the active teams of active clubs, each with its club's id and name, ordered by club
//     and team; every other workspace's teams are as before (no club keys).
// No migration. One disposable database through the real runner (support/calendar-fixture.mjs); the real Express app
// over HTTP with real session cookies. Nothing touches OPTIMOVE or any persistent database. Invented names only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = addDays(TODAY, 1);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);
const TZ = "Europe/Belgrade";

let env;
let m;
let appPool;

before(async () => {
  env = await startCalendarApp({ label: "k2b1d2" });
  ({ pool: appPool } = await import("../src/db.js"));
  m = await calendarRoleMatrix(env, "k2b1d2");
});

after(async () => {
  if (env) await env.stop();
});

const q = (sql, params) => env.q(sql, params);
const api = (p, o) => env.api(p, o);
const calendarOf = (cookie) => api(`/api/calendar?from=${FROM}&to=${TO}`, { cookie });
const send = (cookie, method, p, body) => api(`/api/calendar/settings${p}`, { method, cookie, body: { requestKey: newKey(), ...body } });
const createEvent = (cookie, body) => api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: newKey(), timezone: TZ, day: FUTURE, ...body } });
// The athlete's card names its event under links only (D21).
const cardsOf = (res, eventId) => (res.body.days || []).flatMap((d) => d.items).filter((i) => i.kind === "event" && (i.eventId ?? i.links?.eventId) === eventId);
const keysOf = (card) => [card.eventTypeIconKey, card.eventTypeColorKey];

async function catalog(cookie) {
  const res = await api("/api/calendar/settings", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body;
}
async function freshClub(label) {
  const clubId = await env.fx.makeClub(`${label} club`);
  const teamId = await env.fx.makeTeam(clubId, `${label} team`);
  const admin = await env.fx.clubAdminOf(clubId, `${label} admin`);
  return { clubId, teamId, admin };
}
async function colourType(admin, typeKey, colorKey) {
  const type = (await catalog(admin.cookie)).types.find((t) => t.key === typeKey);
  const res = await send(admin.cookie, "PATCH", `/types/${type.id}`, { expectedRevision: type.revision, colorKey });
  assert.equal(res.status, 200, res.text);
  return res.body.type;
}

// ---------------------------------------------------------------------------
// 1. The type's icon and colour on every card
// ---------------------------------------------------------------------------
test("1a. a club's type: its icon and colour on the manager's, the reader's and the athlete's card of the same event", async () => {
  const { clubs, teams, roles } = m;
  const type = await colourType(roles.clubAdmin, "training", "green");
  assert.ok(type.iconKey, "the seeded training type has its icon");
  const created = await createEvent(roles.clubAdmin.cookie, { eventTypeId: type.id, title: `Team session ${uid()}`, targets: [{ kind: "team", id: teams.t1 }] });
  assert.equal(created.status, 201, created.text);
  const id = created.body.event.id;

  const [managerCard] = cardsOf(await calendarOf(roles.clubAdmin.cookie), id);
  assert.ok(managerCard && managerCard.canManage === true, "the club's admin manages it");
  assert.deepEqual(keysOf(managerCard), [type.iconKey, "green"]);

  const [readerCard] = cardsOf(await calendarOf(roles.teamCoach.cookie), id);
  assert.ok(readerCard && readerCard.canManage === false, "the team's coach reads it");
  assert.deepEqual(keysOf(readerCard), [type.iconKey, "green"], "a reader's card carries them too");
  assert.equal("eventTypeId" in readerCard, false, "still no type id for a reader");

  const athleteRes = await calendarOf(m.athletes.athlete.cookie);
  const [athleteCard] = cardsOf(athleteRes, id);
  assert.ok(athleteCard, "the athlete of the team reads it");
  assert.deepEqual(keysOf(athleteCard), [type.iconKey, "green"]);
  assert.deepEqual(Object.keys(athleteCard).sort(), ["cancelled", "date", "endTime", "eventKind", "eventTypeColorKey", "eventTypeIconKey", "eventTypeLabel", "key", "kind", "links", "location", "place", "span", "startTime", "status", "teamIds", "title"], "the athlete's allowlist, key by key");
  assert.equal(athleteRes.text.includes(String(clubs.c1)), false, "no club id reaches the athlete");
});

test("1b. a colour set shows on the card; taken away, the card reads null again and keeps the icon", async () => {
  const { roles, teams } = m;
  const coloured = await colourType(roles.clubAdmin, "match", "amber");
  const created = await createEvent(roles.clubAdmin.cookie, { eventTypeId: coloured.id, title: `Match ${uid()}`, targets: [{ kind: "team", id: teams.t1 }] });
  assert.equal(created.status, 201, created.text);
  const [card] = cardsOf(await calendarOf(roles.clubAdmin.cookie), created.body.event.id);
  assert.deepEqual(keysOf(card), [coloured.iconKey, "amber"]);
  const cleared = await send(roles.clubAdmin.cookie, "PATCH", `/types/${coloured.id}`, { expectedRevision: coloured.revision, colorKey: null });
  assert.equal(cleared.status, 200, cleared.text);
  const [after] = cardsOf(await calendarOf(roles.clubAdmin.cookie), created.body.event.id);
  assert.deepEqual(keysOf(after), [coloured.iconKey, null]);
});

test("1c. a system type (a private coach's event): its icon and colour on the card", async () => {
  const { roles, athletes } = m;
  const types = await api("/api/calendar/events/types", { cookie: roles.privateCoach.cookie });
  assert.equal(types.status, 200, types.text);
  const training = types.body.types.find((t) => t.kind === "training");
  assert.ok(training, "the system set is offered");
  const created = await createEvent(roles.privateCoach.cookie, { eventTypeId: training.id, title: `Own session ${uid()}`, targets: [{ kind: "athlete", id: athletes.ownAthlete.athleteId }] });
  assert.equal(created.status, 201, created.text);
  const [card] = cardsOf(await calendarOf(roles.privateCoach.cookie), created.body.event.id);
  assert.deepEqual(keysOf(card), [training.iconKey ?? null, training.colorKey ?? null]);
  assert.ok(card.eventTypeIconKey, "a system type has its icon");
});

test("1d. D41: a team moved to another club - its event's card carries no icon and no colour of the old club's type, as no label and no id", async () => {
  const a = await freshClub(`moveA${uid()}`);
  const b = await freshClub(`moveB${uid()}`);
  const type = await colourType(a.admin, "training", "plum");
  const coach = await env.fx.coachOf(a.teamId, "moveA coach");
  const created = await createEvent(coach.cookie, { eventTypeId: type.id, title: "Team session", targets: [{ kind: "team", id: a.teamId }] });
  assert.equal(created.status, 201, created.text);
  const [before] = cardsOf(await calendarOf(a.admin.cookie), created.body.event.id);
  assert.deepEqual(keysOf(before), [type.iconKey, "plum"], "club A's own card shows them");
  // A raw write: since D43 the route no longer moves a team; the calendar is checked against such a write.
  await q(`update public.teams set club_id = $2 where id = $1`, [a.teamId, b.clubId]);
  const res = await calendarOf(b.admin.cookie);
  const [card] = cardsOf(res, created.body.event.id);
  assert.ok(card, "club B sees its moved team's event");
  assert.equal(card.eventTypeLabel, null);
  assert.deepEqual(keysOf(card), [null, null], "nothing of club A's type");
});

// ---------------------------------------------------------------------------
// 2. The platform's teams with their clubs
// ---------------------------------------------------------------------------
test("2a. the platform workspace names the active teams of active clubs, ordered by club and team, each with its club's id and name", async () => {
  const { clubs, teams, roles } = m;
  // A team of an archived club (C3 is archived by the matrix): never named.
  const archivedClubTeam = await env.fx.makeTeam(clubs.c3, "k2b1d2 C3 team");
  // The colour its club chose (Q3): set on T1, read back by the platform.
  const colour = await api(`/api/calendar/settings/teams/${teams.t1}`, { method: "PUT", cookie: roles.clubAdmin.cookie, body: { requestKey: newKey(), expectedRevision: 0, colorKey: "rust" } });
  assert.equal(colour.status, 200, colour.text);
  // A T1 member whose team membership is archived (the statement Settings runs, organization.js) is not counted: the
  // platform's athleteCount counts active team memberships only (the independent review).
  const leaver = await env.fx.makeAthlete(`k2b1d2 leaver ${uid()}`, { clubId: clubs.c1, teamId: teams.t1 });
  await q(
    `update public.athlete_memberships set status = 'archived', archived_at = now(), updated_at = now()
      where athlete_id = $1 and team_id = $2 and membership_type = 'team'`,
    [leaver.athleteId, teams.t1],
  );
  const archivedRows = await q(`select count(*)::int as n from public.athlete_memberships where team_id = $1 and membership_type = 'team' and status <> 'active'`, [teams.t1]);
  assert.ok(archivedRows[0].n >= 1, "T1 holds an archived team membership");
  const activeCount = (await q(`select count(*)::int as n from public.athlete_memberships where team_id = $1 and membership_type = 'team' and status = 'active'`, [teams.t1]))[0].n;
  // The order is by club first: a club whose name sorts first holds a team whose name sorts last (code review).
  const clubAaa = await env.fx.makeClub(`Aaa order ${uid()}`);
  const clubBbb = await env.fx.makeClub(`Bbb order ${uid()}`);
  const zzTeam = await env.fx.makeTeam(clubAaa, "Zz order team");
  const aaTeam = await env.fx.makeTeam(clubBbb, "Aa order team");
  const res = await calendarOf(roles.platformAdmin.cookie);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.workspace.type, "platform");
  const ours = res.body.teams.filter((t) => [clubs.c1, clubs.c2, clubs.c3].map(String).includes(String(t.clubId)));
  assert.deepEqual(ours.map((t) => [String(t.clubId), String(t.teamId)]), [
    [String(clubs.c1), String(teams.t1)],
    [String(clubs.c1), String(teams.t2)],
    [String(clubs.c2), String(teams.u1)],
  ], "T3 (archived) and the archived club's team are left out; club, then team");
  const ids = res.body.teams.map((t) => String(t.teamId));
  assert.ok(ids.indexOf(String(zzTeam)) >= 0 && ids.indexOf(String(aaTeam)) >= 0);
  assert.ok(ids.indexOf(String(zzTeam)) < ids.indexOf(String(aaTeam)), "club first, then team: Aaa's Zz before Bbb's Aa");
  assert.equal(ids.includes(String(teams.t3)), false);
  assert.equal(ids.includes(String(archivedClubTeam)), false);
  for (const team of res.body.teams) {
    assert.deepEqual(Object.keys(team).sort(), ["athleteCount", "clubId", "clubName", "colorKey", "name", "teamId"]);
    assert.ok(typeof team.clubName === "string" && team.clubName.length > 0);
  }
  const t1 = ours.find((t) => String(t.teamId) === String(teams.t1));
  const clubT1 = (await calendarOf(roles.clubAdmin.cookie)).body.teams.find((t) => String(t.teamId) === String(teams.t1));
  assert.equal(t1.athleteCount, activeCount, "active team memberships only: the archived one is not counted");
  assert.equal(t1.athleteCount, clubT1.athleteCount, "the same member count as the club's own answer");
  assert.equal(t1.colorKey, "rust", "the colour its club chose (Q3)");
  assert.equal(clubT1.colorKey, "rust");
  // The clubs' names, from the database.
  const names = await q(`select id, name from public.clubs where id = any($1::uuid[])`, [[clubs.c1, clubs.c2]]);
  for (const row of names) assert.ok(ours.filter((t) => String(t.clubId) === String(row.id)).every((t) => t.clubName === row.name));
});

test("2b. every other workspace answers its teams as before: no club keys; the athlete's none", async () => {
  const { teams, roles } = m;
  const club = await calendarOf(roles.clubAdmin.cookie);
  assert.deepEqual(club.body.teams.map((t) => String(t.teamId)).sort(), [String(teams.t1), String(teams.t2)].sort());
  for (const team of club.body.teams) assert.deepEqual(Object.keys(team).sort(), ["athleteCount", "colorKey", "name", "teamId"]);
  // A platform admin in a club's workspace reads that club as its admin does.
  const inClub = await calendarOf(roles.platformInClub.cookie);
  assert.notEqual(inClub.body.workspace.type, "platform");
  for (const team of inClub.body.teams) assert.equal("clubName" in team, false);
  const coach = await calendarOf(roles.teamCoach.cookie);
  assert.deepEqual(coach.body.teams.map((t) => String(t.teamId)), [String(teams.t1)]);
  assert.equal("clubName" in coach.body.teams[0], false);
  assert.deepEqual((await calendarOf(roles.privateCoach.cookie)).body.teams, []);
  assert.deepEqual((await calendarOf(m.athletes.athlete.cookie)).body.teams, []);
});

test("2b2. a platform admin whose role is revoked: the next answer is no longer the platform's and names no club (security review)", async () => {
  const pa = await env.fx.platformAdmin(`revoked platform ${uid()}`);
  const before = await calendarOf(pa.cookie);
  assert.equal(before.body.workspace.type, "platform");
  assert.ok(before.body.teams.length > 0 && before.body.teams.every((t) => "clubName" in t));
  await q(`update public.user_global_roles set is_active = false where user_id = $1 and role = 'platform_admin'`, [pa.id]);
  const after = await calendarOf(pa.cookie);
  if (after.status === 200) {
    assert.notEqual(after.body.workspace.type, "platform");
    assert.equal(after.body.teams.some((t) => "clubName" in t), false, "no club keys outside the platform workspace");
  } else {
    assert.equal(after.status, 403, after.text);
    assert.equal(after.text.includes("clubName"), false);
  }
});

test("2c. the platform's cards name the teams they reach, with the team ids of its list", async () => {
  const { teams, roles } = m;
  const type = (await catalog(roles.clubAdmin.cookie)).types.find((t) => t.key === "meeting");
  const created = await createEvent(roles.clubAdmin.cookie, { eventTypeId: type.id, title: `Meeting ${uid()}`, targets: [{ kind: "team", id: teams.t2 }] });
  assert.equal(created.status, 201, created.text);
  const res = await calendarOf(roles.platformAdmin.cookie);
  const [card] = cardsOf(res, created.body.event.id);
  assert.ok(card, "the platform reads every club's event");
  assert.ok(card.teamIds.includes(String(teams.t2)), "the card names its team");
  const listed = new Set(res.body.teams.map((t) => String(t.teamId)));
  for (const item of res.body.days.flatMap((d) => d.items)) for (const id of item.teamIds) assert.ok(listed.has(String(id)), "a card names only teams of the list");
});

test("2d. the platform's read takes the same number of statements with 2 or 12 teams of a club (the list is one statement)", async () => {
  const club = await freshClub(`count${uid()}`);
  const count = async () => {
    const original = appPool.query;
    let n = 0;
    appPool.query = function counted(...args) {
      n += 1;
      return original.apply(this, args);
    };
    try {
      const res = await calendarOf(m.roles.platformAdmin.cookie);
      assert.equal(res.status, 200, res.text);
    } finally {
      appPool.query = original;
    }
    return n;
  };
  const small = await count();
  assert.ok(small > 0, "the interception counts real statements");
  for (let i = 0; i < 10; i += 1) await env.fx.makeTeam(club.clubId, `count team ${i}`);
  assert.equal(await count(), small, `the same number of statements (${small})`);
});
