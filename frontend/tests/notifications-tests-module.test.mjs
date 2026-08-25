// Phase 3A: notification-center routing for the 4 new WELLNESS notification
// types (testsNotificationWorker.js on the backend). Same minimal-DOM-double
// pattern already established for this module's other frontend tests (see
// tests-schedule-management.actions.test.mjs) - just enough of `document`
// for dom.js's top-level querySelector calls (transitively imported via
// messages.js) to not throw, plus two real fake elements (notificationToggle/
// notificationPanel) so renderNotifications() actually renders into a
// string we can assert against, instead of bailing out early.
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
  state.currentUser = { id: "coach-1" };
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

test("an athlete_invitation row routes to notification-open-test-assignment, carrying its own assignment id", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_athlete_invitation", entity_type: "test_assignment", entity_id: "asg-1" })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-test-assignment"'));
  assert.ok(panelHtml.includes('data-assignment-id="asg-1"'));
});

test("an athlete_reminder row routes to the SAME notification-open-test-assignment action as invitation", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_athlete_reminder", entity_type: "test_assignment", entity_id: "asg-2" })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-test-assignment"'));
  assert.ok(panelHtml.includes('data-assignment-id="asg-2"'));
});

test("a coach_digest row routes to notification-open-tests-today", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_coach_digest", entity_type: "test_occurrence", entity_id: "occ-1", metadata: { scheduleId: "sched-1" } })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-tests-today"'));
});

test("a final_digest row routes to notification-open-tests-results, carrying the schedule id from metadata", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_final_digest", entity_type: "test_occurrence", entity_id: "occ-2", metadata: { scheduleId: "sched-2" } })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-tests-results"'));
  assert.ok(panelHtml.includes('data-schedule-id="sched-2"'));
});

test("an unrelated notification type (e.g. a message) is untouched by any of the new routing - falls through to the generic notification-read", () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "coach_contact_requested", entity_type: "coach_contact_request", entity_id: "req-1" })];
  renderNotifications();
  assert.ok(!panelHtml.includes("notification-open-test-assignment"));
  assert.ok(!panelHtml.includes("notification-open-tests-today"));
  assert.ok(!panelHtml.includes("notification-open-tests-results"));
});

// ------------------------------------------------------------
// Click dispatch: marks read, closes the panel, calls the right handler
// ------------------------------------------------------------

test("clicking a test-assignment notification marks it read, closes the panel, and opens the athlete's OWN assignment via the injected handler", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_athlete_invitation", read_at: null })];
  state.notifications.unreadCount = 1;
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedAssignmentId = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-test-assignment", notificationId: "n1", assignmentId: "asg-1" }), {
    openTestAssignment: async (id) => { openedAssignmentId = id; },
  });
  assert.equal(handled, true);
  assert.equal(openedAssignmentId, "asg-1");
  assert.equal(state.notifications.open, false);
  assert.ok(fetchCalls.some((c) => c.url === "/api/notifications/n1/read"));
  assert.equal(state.notifications.rows[0].read_at !== null, true);
});

test("clicking a coach-digest notification marks it read, closes the panel, and calls openTestsToday", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_coach_digest", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let calledToday = false;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-tests-today", notificationId: "n1" }), {
    openTestsToday: async () => { calledToday = true; },
  });
  assert.equal(handled, true);
  assert.equal(calledToday, true);
  assert.equal(state.notifications.open, false);
});

test("clicking a final-digest notification marks it read and calls openTestsResults with the schedule id from the row's own dataset", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_final_digest", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedScheduleId = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-tests-results", notificationId: "n1", scheduleId: "sched-9" }), {
    openTestsResults: async (id) => { openedScheduleId = id; },
  });
  assert.equal(handled, true);
  assert.equal(openedScheduleId, "sched-9");
});

test("a test-assignment click with no assignment id (malformed row) still marks it read but never calls the open handler with an empty id", async () => {
  resetNotificationsState();
  state.notifications.rows = [baseRow({ type: "test_athlete_invitation", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openCalled = false;
  await handleNotificationAction(fakeAction({ action: "notification-open-test-assignment", notificationId: "n1", assignmentId: "" }), {
    openTestAssignment: async () => { openCalled = true; },
  });
  assert.equal(openCalled, false);
});
