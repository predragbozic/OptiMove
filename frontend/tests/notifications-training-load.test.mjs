// Hardening: the notification center did not recognize any of the four
// training_load external-scheduling notification types
// (training_load_external_invitation/_reminder/_final_digest,
// training_load_manual_reminder) - a click on one fell through to the
// generic notification-read and only marked it read, never opening the
// actual RPE assignment/Results view the worker's own comment promised.
// Same minimal-DOM-double harness as notifications-tests-module.test.mjs
// (its own sibling file for the WELLNESS equivalent), covering the same
// two layers: (1) row rendering picks the right data-action/hints, (2)
// dispatching that exact rendered action calls the right handler. Test
// R3 goes one level deeper than that sibling file does: it exercises the
// REAL training-load-actions.js handler (never a mock), proving the
// athlete's own RPE form ends up populated with the exact right
// externalAssignmentId - not just that a handler function got called.
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
const { openExternalAssignmentFromNotification } = await import("../training-load-actions.js");
const { emptyTrainingLoadState, state } = await import("../state.js");

function resetState() {
  state.currentUser = { id: "athlete-1" };
  state.notifications = { open: true, rows: [], unreadCount: 0, loading: false, error: "" };
  state.trainingLoad = emptyTrainingLoadState();
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

test("a training_load_external_invitation row routes to notification-open-training-load-assignment, carrying its own assignment id, with an 'Open RPE' hint", () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_invitation", entity_type: "training_load_external_assignment", entity_id: "asg-1" })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-training-load-assignment"'));
  assert.ok(panelHtml.includes('data-assignment-id="asg-1"'));
  assert.ok(panelHtml.includes("Open RPE"));
});

test("a training_load_external_reminder row routes to the SAME action as invitation", () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_reminder", entity_type: "training_load_external_assignment", entity_id: "asg-2" })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-training-load-assignment"'));
  assert.ok(panelHtml.includes('data-assignment-id="asg-2"'));
});

test("a training_load_manual_reminder row (coach-triggered, POST /external-schedules/:id/remind) routes to the SAME action as invitation/reminder", () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_manual_reminder", entity_type: "training_load_external_assignment", entity_id: "asg-3" })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-training-load-assignment"'));
  assert.ok(panelHtml.includes('data-assignment-id="asg-3"'));
});

test("a training_load_external_final_digest row routes to notification-open-training-load-results, carrying the occurrence's own scheduled date from metadata, with an 'Open Results' hint", () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_final_digest", entity_type: "training_load_external_occurrence", entity_id: "occ-1", metadata: { scheduleId: "sched-1", occurrenceId: "occ-1", scheduledDate: "2026-08-24" } })];
  renderNotifications();
  assert.ok(panelHtml.includes('data-action="notification-open-training-load-results"'));
  assert.ok(panelHtml.includes('data-scheduled-date="2026-08-24"'));
  assert.ok(panelHtml.includes("Open Results"));
});

test("an unrelated notification type is untouched by the new routing - falls through to the generic notification-read", () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "coach_contact_requested", entity_type: "coach_contact_request", entity_id: "req-1" })];
  renderNotifications();
  assert.ok(!panelHtml.includes("notification-open-training-load-assignment"));
  assert.ok(!panelHtml.includes("notification-open-training-load-results"));
});

// ------------------------------------------------------------
// Click dispatch: marks read, closes the panel, calls the right handler
// ------------------------------------------------------------

test("clicking a training-load-assignment notification marks it read, closes the panel, and calls the injected handler with the exact assignment id", async () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_invitation", read_at: null })];
  state.notifications.unreadCount = 1;
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedAssignmentId = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-training-load-assignment", notificationId: "n1", assignmentId: "asg-1" }), {
    openTrainingLoadAssignment: async (id) => { openedAssignmentId = id; },
  });
  assert.equal(handled, true);
  assert.equal(openedAssignmentId, "asg-1");
  assert.equal(state.notifications.open, false);
  assert.ok(fetchCalls.some((c) => c.url === "/api/notifications/n1/read"));
  assert.equal(state.notifications.rows[0].read_at !== null, true);
});

test("clicking a final-digest notification marks it read and calls openTrainingLoadResults with the scheduled date from the row's own dataset", async () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_final_digest", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openedDate = null;
  const handled = await handleNotificationAction(fakeAction({ action: "notification-open-training-load-results", notificationId: "n1", scheduledDate: "2026-08-24" }), {
    openTrainingLoadResults: async (date) => { openedDate = date; },
  });
  assert.equal(handled, true);
  assert.equal(openedDate, "2026-08-24");
});

test("a training-load-assignment click with no assignment id (malformed row) still marks it read but never calls the open handler", async () => {
  resetState();
  state.notifications.rows = [baseRow({ type: "training_load_external_invitation", read_at: null })];
  installFetchMock((call) => (call.url === "/api/notifications/n1/read" ? { status: 200, body: { id: "n1", read_at: new Date().toISOString() } } : { status: 404, body: {} }));
  let openCalled = false;
  await handleNotificationAction(fakeAction({ action: "notification-open-training-load-assignment", notificationId: "n1", assignmentId: "" }), {
    openTrainingLoadAssignment: async () => { openCalled = true; },
  });
  assert.equal(openCalled, false);
});

// ------------------------------------------------------------
// R3. The REAL handler, not a mock - proves the athlete's own RPE form
// actually ends up populated with the right externalAssignmentId, not
// just that some handler function got invoked with the right string.
// ------------------------------------------------------------

test("clicking an invitation notification for an assignment NOT among today's already-loaded sessions still opens the right RPE form, by falling back to the athlete's own weekly overlay fetch", async () => {
  resetState();
  installFetchMock((call) => {
    if (call.url === "/api/training-load/athlete/today") {
      return { status: 200, body: { date: "2026-08-24", sessions: [] } }; // the assignment is NOT today
    }
    if (call.url.startsWith("/api/training-load/weekly")) {
      return {
        status: 200,
        body: {
          weekStart: "2026-08-24", weekEnd: "2026-08-30",
          days: [
            { date: "2026-08-24", sessions: [] },
            { date: "2026-08-25", sessions: [{ sessionId: null, externalAssignmentId: "asg-7", source: "scheduled_external", sessionName: "National team camp", rated: false, feedback: null }] },
          ],
        },
      };
    }
    return { status: 404, body: {} };
  });

  await openExternalAssignmentFromNotification("asg-7");

  assert.ok(state.trainingLoad.rpeForm, "the RPE form must actually be open");
  assert.equal(state.trainingLoad.rpeForm.externalAssignmentId, "asg-7", "must be populated with the EXACT assignment from the notification, not some other one");
  assert.equal(state.trainingLoad.rpeForm.source, "scheduled_external");
  assert.equal(state.trainingLoad.rpeForm.sessionName, "National team camp");
});

test("clicking an invitation notification for an assignment already among today's sessions opens it directly, without needing the weekly-overlay fallback fetch", async () => {
  resetState();
  installFetchMock((call) => {
    if (call.url === "/api/training-load/athlete/today") {
      return { status: 200, body: { date: "2026-08-24", sessions: [{ sessionId: null, externalAssignmentId: "asg-8", source: "scheduled_external", sessionName: "Extra gym session", rated: false, feedback: null }] } };
    }
    if (call.url.startsWith("/api/training-load/weekly")) {
      throw new Error("must not need the weekly-overlay fallback when the assignment is already in today's own sessions");
    }
    return { status: 404, body: {} };
  });

  await openExternalAssignmentFromNotification("asg-8");

  assert.equal(state.trainingLoad.rpeForm.externalAssignmentId, "asg-8");
  assert.equal(state.trainingLoad.rpeForm.sessionName, "Extra gym session");
});

test("clicking an invitation notification for an ALREADY-RATED assignment is a safe no-op - never re-opens a blank form that would only 409", async () => {
  resetState();
  installFetchMock((call) => {
    if (call.url === "/api/training-load/athlete/today") {
      return { status: 200, body: { date: "2026-08-24", sessions: [{ sessionId: null, externalAssignmentId: "asg-9", source: "scheduled_external", sessionName: "Already done", rated: true, feedback: { rpe: 5, durationMinutes: 30, srpe: 150 } }] } };
    }
    return { status: 200, body: { weekStart: "2026-08-24", weekEnd: "2026-08-30", days: [] } };
  });

  await openExternalAssignmentFromNotification("asg-9");

  assert.equal(state.trainingLoad.rpeForm, null);
});
