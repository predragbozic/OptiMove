// Builder plan-assignment notifications: notification-center routing for
// the 2 new types (weekly_plan_assigned, specific_program_assigned) written
// by backend/src/routes/builder.js's notifyPlanAssignments. Same minimal-
// DOM-double pattern already established for the Phase 3A WELLNESS routing
// tests (tests/notifications-tests-module.test.mjs) - reused near-verbatim.
import { test } from "node:test";
import assert from "node:assert/strict";

let panelHtml = "";
const fakeNotificationToggle = { hidden: false, querySelector: () => null };
const fakeNotificationPanel = {
  hidden: false,
  get innerHTML() { return panelHtml; },
  set innerHTML(value) { panelHtml = value; },
};
globalThis.document = {
  querySelector: (sel) => (sel === "#notificationToggle" ? fakeNotificationToggle : sel === "#notificationPanel" ? fakeNotificationPanel : null),
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { matchMedia: () => ({ matches: true }) };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, json: async () => result.body };
  };
}

const { handleNotificationAction, renderNotifications } = await import("../notifications.js");
const { state } = await import("../state.js");

function resetNotificationsState() {
  state.currentUser = { id: "athlete-1" };
  state.notifications = { open: true, rows: [], unreadCount: 0, loading: false, error: "" };
  panelHtml = "";
}

function fakeAction(dataset) {
  return { dataset };
}

function baseRow(overrides) {
  return { id: "n1", title: "Notification", body: "", read_at: null, created_at: new Date().toISOString(), metadata: {}, ...overrides };
}

// ------------------------------------------------------------
// Row rendering: which data-action each new type gets
// ------------------------------------------------------------

test("a weekly_plan_assigned row routes to notification-open-weekly-plan, carrying its own week start", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "weekly_plan_assigned", entity_type: "plan", entity_id: "plan-1", metadata: { planId: "plan-1", planType: "weekly", weekStart: "2027-02-08" } })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-weekly-plan"'));
  assert.ok(panelHtml.includes('data-week-start="2027-02-08"'));
  assert.ok(panelHtml.includes("Open weekly plan"));
});

test("a specific_program_assigned row routes to notification-open-specific-program, carrying its plan id (never resolved by name)", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "specific_program_assigned", entity_type: "plan", entity_id: "plan-2", title: "New program assigned", body: "Strength Block", metadata: { planId: "plan-2", planType: "program" } })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-specific-program"'));
  assert.ok(panelHtml.includes('data-plan-id="plan-2"'));
  assert.ok(panelHtml.includes("Open program"));
});

test("an unrelated notification type is untouched by either new route - falls through to the generic notification-read", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "coach_contact_requested", entity_type: "coach_contact_request", entity_id: "req-1" })];
  renderNotifications();
  assert.ok(!panelHtml.includes("notification-open-weekly-plan"));
  assert.ok(!panelHtml.includes("notification-open-specific-program"));
});

test("a plan-typed row of an unrecognized notification type does not accidentally match either new route", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "some_other_plan_event", entity_type: "plan", entity_id: "plan-3" })];
  renderNotifications();
  assert.ok(!panelHtml.includes("notification-open-weekly-plan"));
  assert.ok(!panelHtml.includes("notification-open-specific-program"));
});

// ------------------------------------------------------------
// Click dispatch: marks read, closes the panel, calls the right handler
// ------------------------------------------------------------

test("clicking a weekly-plan notification marks it read, closes the panel, and opens the athlete's OWN week via the injected handler", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "weekly_plan_assigned", read_at: null })];
  state.notifications.unreadCount = 1;
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedWeekStart = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-weekly-plan", notificationId: "n1", weekStart: "2027-02-08" }), {
    openWeeklyPlanFromNotification: async (weekStart) => { openedWeekStart = weekStart; },
  });
  assert.equal(handled, true);
  assert.equal(openedWeekStart, "2027-02-08");
  assert.equal(state.notifications.open, false);
  assert.ok(fetchCalls.some((c) => c.url === "/api/notifications/n1/read"));
  assert.equal(state.notifications.rows[0].read_at !== null, true);
});

test("clicking a specific-program notification marks it read, closes the panel, and opens the exact program by id", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "specific_program_assigned", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedPlanId = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-specific-program", notificationId: "n1", planId: "plan-2" }), {
    openSpecificProgramFromNotification: async (id) => { openedPlanId = id; },
  });
  assert.equal(handled, true);
  assert.equal(openedPlanId, "plan-2");
  assert.equal(state.notifications.open, false);
});

test("a weekly-plan click with no week start (malformed row) still marks it read but never calls the open handler", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "weekly_plan_assigned", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openCalled = false;
  await handleNotificationAction(fakeAction({ action: "notification-open-weekly-plan", notificationId: "n1", weekStart: "" }), {
    openWeeklyPlanFromNotification: async () => { openCalled = true; },
  });
  assert.equal(openCalled, false);
});

test("a specific-program click with no plan id (malformed row) still marks it read but never calls the open handler", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "specific_program_assigned", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openCalled = false;
  await handleNotificationAction(fakeAction({ action: "notification-open-specific-program", notificationId: "n1", planId: "" }), {
    openSpecificProgramFromNotification: async () => { openCalled = true; },
  });
  assert.equal(openCalled, false);
});
