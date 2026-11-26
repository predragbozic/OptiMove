import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { calendarManageCases } from "./support/calendar-m1-requests.mjs";
import { calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

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
