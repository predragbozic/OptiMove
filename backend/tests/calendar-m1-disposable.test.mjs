import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { calendarManageCases } from "./support/calendar-m1-requests.mjs";
import { calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";
import { ROLE_IDS } from "./support/permission-roles-world.mjs";

let world;
let matrix;
let cases;
let event;
const missing = Object.freeze({ error: "notFound", message: "Not found." });

before(async () => {
  world = await startCalendarApp({ label: "calendar_m1" });
  matrix = await calendarRoleMatrix(world, "M-1");
  const { clubs, teams, roles } = matrix;
  const settings = await world.api("/api/calendar/settings", { cookie: roles.platformInClub.cookie });
  assert.equal(settings.status, 200, settings.text);
  const eventTypeId = settings.body.types.find((x) => x.kind === "training").id;
  const detailId = settings.body.fields[0].id;
  const place = await world.api("/api/calendar/settings/locations", {
    method: "POST", cookie: roles.platformInClub.cookie, body: { requestKey: newKey(), name: "M-1 fixture place" },
  });
  assert.equal(place.status, 201, place.text);
  const created = await world.api("/api/calendar/events", {
    method: "POST", cookie: roles.platformInClub.cookie, body: {
      requestKey: newKey(), eventTypeId, title: "M-1 fixture event", day: "2026-11-28",
      timezone: "UTC", targets: [{ kind: "club", id: clubs.c1 }],
    },
  });
  assert.equal(created.status, 201, created.text);
  event = created.body.event;
  // Rule 7: Club admin remains a superset of the club's Team coach version.
  for (const [roleId, remove] of [
    [ROLE_IDS.team_coach, ["calendar.events.manage"]],
    [ROLE_IDS.club_admin, ["calendar.events.manage", "calendar.settings.manage"]],
  ]) {
    const narrowed = await world.api(`/api/organization/roles/${roleId}/clubs/${clubs.c1}/version`, {
      method: "POST", cookie: roles.platformAdmin.cookie, body: {
        requestKey: newKey(), expectedRevision: null, add: [], remove, reason: "Keep calendar read only",
      },
    });
    assert.equal(narrowed.status, 200, narrowed.text);
  }
  cases = calendarManageCases({
    eventId: event.id, eventTypeId, detailId, locationId: place.body.location.id,
    clubId: clubs.c1, teamId: teams.t1, auxiliaryId: newKey(), requestKey: newKey,
  });
});
after(async () => { await world?.stop(); });

test("M-1: Calendar view without the Manage words keeps the event read and gives no manager projection", async () => {
  const cookie = matrix.roles.clubAdmin.cookie;
  const read = await world.api(`/api/calendar/events/${event.id}`, { cookie });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.event.canManage, false);
  assert.equal(read.body.event.deletable, undefined);
  assert.equal(read.body.event.detailCounts, undefined);
  const questions = await world.api(`/api/calendar/events/${event.id}/questions`, { cookie });
  assert.equal(questions.status, 404, questions.text);
  assert.deepEqual(questions.body, missing);
});

test("M-1: every staff write refuses a native club viewer without Manage, leaving no receipt or event change", async () => {
  const actor = matrix.roles.clubAdmin;
  for (const req of [...cases.event, ...cases.settings]) {
    const res = await world.api(req.path, { cookie: actor.cookie, method: req.method, body: req.body });
    assert.equal(res.status, req.status, `${req.method} ${req.path}: ${res.text}`);
    assert.deepEqual(res.body, req.status === 404 ? missing : { error: "Forbidden" }, `${req.method} ${req.path}`);
  }
  assert.deepEqual(await world.q(`select
    (select count(*)::int from calendar.event_requests where performed_by_user_id=$1) as events,
    (select count(*)::int from calendar.settings_requests where performed_by_user_id=$1) as settings,
    (select count(*)::int from calendar.event_deletion_log where performed_by_user_id=$1) as deletes`, [actor.id]),
  [{ events: 0, settings: 0, deletes: 0 }]);
  assert.deepEqual(await world.q("select title, revision from calendar.events where id=$1", [event.id]), [{ title: event.title, revision: event.revision }]);
});

test("M-1: post-cutover old lock and v93 delete refuse, the checked path can still replay", async () => {
  const { roles, clubs } = matrix;
  const newEvent = {
    requestKey: newKey(), day: "2026-11-28", timezone: "UTC", title: "M-1 checked replay",
    eventTypeId: cases.event[0].body.eventTypeId, targets: [{ kind: "club", id: clubs.c1 }],
  };
  const created = await world.api("/api/calendar/events", { method: "POST", cookie: roles.platformInClub.cookie, body: newEvent });
  assert.equal(created.status, 201, created.text);
  const deleteBody = { requestKey: newKey(), expectedRevision: created.body.event.revision };
  const id = created.body.event.id;
  await world.q("select calendar.lock_event_writer($1,'club',$2,'club_admin')", [roles.platformInClub.id, clubs.c1]);
  await world.admin.query(`begin;
    select pg_advisory_xact_lock(11816506, 1);
    update calendar.m1_activation set active=true where singleton;
    commit`);
  await assert.rejects(world.q("select calendar.lock_event_writer($1,'club',$2,'club_admin')", [roles.platformInClub.id, clubs.c1]), { code: "42501" });
  await assert.rejects(world.q("select calendar.delete_event($1,$2,$3,'club_admin',$4,$5,'{}'::jsonb)",
    [id, deleteBody.expectedRevision, roles.platformInClub.id, deleteBody.requestKey, "a".repeat(64)]), { code: "42501" });

  const path = `/api/calendar/events/${id}/delete`;
  const deleted = await world.api(path, { method: "POST", cookie: roles.platformInClub.cookie, body: deleteBody });
  assert.deepEqual(deleted.body, { deleted: true, eventId: id });
  const replay = await world.api(path, { method: "POST", cookie: roles.platformInClub.cookie, body: deleteBody });
  assert.deepEqual(replay.body, { deleted: true, eventId: id, replayed: true });
  assert.deepEqual(await world.q("select writer_workspace_type,writer_workspace_id from calendar.event_deletion_log where event_id=$1", [id]),
    [{ writer_workspace_type: "club", writer_workspace_id: clubs.c1 }]);
});
