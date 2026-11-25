import { test } from "node:test";
import assert from "node:assert/strict";

// Loading the routers constructs lazy pools. No connection is used by these tests.
process.env.DATABASE_URL ??= "postgresql://calendar_m1@127.0.0.1:1/calendar_m1_no_database";
const { eventWriteBasis } = await import("../src/calendarEventAccess.js");
const { settingsClub } = await import("../src/calendarSettingsService.js");
const { default: events } = await import("../src/routes/calendarEvents.js");
const { default: settings } = await import("../src/routes/calendarSettings.js");
const { default: athleteQuestions } = await import("../src/routes/calendarQuestions.js");

const club = "club-a";
const team = "team-a";
const actor = "coach";
const clubOwner = { scope: "club", clubId: club, clubActive: true };
const teamOwner = { scope: "team", teamId: team, teamClubId: club, teamActive: true, teamClubActive: true };
const clubRole = { clubId: club, role: "club_admin" };
const teamRole = { teamId: team, role: "team_coach" };
const view = "calendar.view";
const eventManage = "calendar.events.manage";
const settingsManage = "calendar.settings.manage";
const grant = (scopeType, scopeId, words, closedModules = []) => ({
  scopeType, scopeId, words, teamIds: scopeType === "club" ? [team] : [], closedModules,
});
const ctx = (type, scopeId, authz = {}) => ({
  type: "coach", workspace: { type, scopeId }, userId: actor,
  authz: { platformRoles: [], clubRoles: [], teamRoles: [], rolePermissions: [], ...authz },
});

test("M-1: the active club's event word is independent of the Settings word and the event's narrower team scope", () => {
  const base = { clubRoles: [clubRole] };
  const teamWordOnly = ctx("club", club, { ...base, rolePermissions: [grant("club", club, [view, settingsManage]), grant("team", team, [eventManage])] });
  assert.equal(eventWriteBasis(teamWordOnly, clubOwner), null);
  assert.equal(eventWriteBasis(teamWordOnly, teamOwner), null);
  assert.deepEqual(settingsClub(teamWordOnly), { clubId: club, basis: "club_admin" });

  const clubWordOnly = ctx("club", club, { ...base, rolePermissions: [grant("club", club, [view, eventManage])] });
  assert.equal(eventWriteBasis(clubWordOnly, clubOwner), "club_admin");
  assert.equal(eventWriteBasis(clubWordOnly, teamOwner), "club_admin");
  assert.equal(eventWriteBasis(clubWordOnly, { ...teamOwner, teamClubId: "club-b" }), null);
  assert.throws(() => settingsClub(clubWordOnly), { status: 403, code: "forbidden" });
  assert.throws(() => settingsClub(clubWordOnly, { withId: true }), { status: 404, code: "notFound" });
});

test("M-1: native team requires its scoped word and its owner, a closed licence and view workspace keep writes closed", () => {
  const base = { teamRoles: [teamRole] };
  const coach = ctx("team", team, { ...base, rolePermissions: [grant("team", team, [view, eventManage])] });
  assert.equal(eventWriteBasis(coach, teamOwner), "team_coach");
  assert.equal(eventWriteBasis(coach, clubOwner), null);
  assert.equal(eventWriteBasis(coach, { ...teamOwner, teamId: "team-b" }), null);
  assert.throws(() => settingsClub(coach), { status: 403 });
  assert.equal(eventWriteBasis({ ...coach, view: { type: "team", id: team }, readOnly: true }, teamOwner), null);
  const closed = ctx("team", team, { ...base, rolePermissions: [grant("team", team, [view, eventManage], ["calendar"])] });
  assert.equal(eventWriteBasis(closed, teamOwner), null);
});

test("M-1: platform support and private-owner event authority keep their structural limits", () => {
  const support = ctx("platform", null, { platformRoles: ["platform_admin"] });
  assert.equal(eventWriteBasis(support, teamOwner), "platform_admin");
  assert.throws(() => settingsClub(support), { status: 403, code: "workspace_required" });
  const own = ctx("private_coach", actor, { isIndependentCoach: true });
  assert.equal(eventWriteBasis(own, { scope: "user", userId: actor }), "private_coach");
  assert.equal(eventWriteBasis(own, { scope: "user", userId: "someone-else" }), null);
  assert.equal(eventWriteBasis(own, teamOwner), null);
});

function mountedWrites(router) {
  return router.stack.flatMap(({ route }) => route
    ? Object.keys(route.methods).filter((method) => method !== "get" && method !== "head")
      .map((method) => `${method.toUpperCase()} ${route.path}`)
    : []).sort();
}

test("M-1: every mounted staff write and the separate athlete self write are in the permission inventory", () => {
  assert.deepEqual(mountedWrites(events), [
    "POST /", "PATCH /:eventId", "POST /:eventId/cancel", "POST /:eventId/delete",
    "POST /:eventId/sessions", "POST /:eventId/sessions/detach", "POST /:eventId/sessions/align",
    "POST /:eventId/activities", "POST /:eventId/activities/detach", "POST /:eventId/fields",
    "POST /:eventId/questions", "POST /:eventId/questions/:questionId/remove",
    "POST /:eventId/questions/:questionId/move",
  ].sort());
  assert.deepEqual(mountedWrites(settings), [
    "POST /types", "POST /types/order", "PATCH /types/:typeId", "POST /types/:typeId/archive", "POST /types/:typeId/restore",
    "POST /fields", "PATCH /fields/:fieldId", "POST /fields/:fieldId/archive", "POST /fields/:fieldId/restore",
    "POST /locations", "PATCH /locations/:locationId", "POST /locations/:locationId/archive", "POST /locations/:locationId/restore",
    "PUT /teams/:teamId", "PUT /questions",
  ].sort());
  assert.deepEqual(mountedWrites(athleteQuestions), ["POST /:questionId/later"]);
});
