// K2b-2a-3: a calendar question notification (calendar_question_asked / calendar_question_moved, written by
// backend/src/calendarQuestions.js notifyQuestion: entity_type 'calendar_event', metadata { eventId, questionId, kind })
// opens the question (docs/ai/central-calendar-k2b2a3-ui-contract.md section 5). The same minimal-DOM harness as
// notifications-training-load.test.mjs: (1) the row's rendering picks the action, the question id and the hint;
// (2) dispatching that action marks it read, closes the panel and calls the injected openCalendarQuestion.
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
function installFetchMock() {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url, method: options.method || "GET" });
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const { handleNotificationAction, renderNotifications } = await import("../notifications.js");
const { state } = await import("../state.js");

function resetState() {
  state.currentUser = { id: "athlete-1" };
  state.notifications = { open: true, rows: [], unreadCount: 0, loading: false, error: "" };
  panelHtml = "";
}

function row(overrides) {
  return {
    id: "n1", title: "Your coach has a question", body: "How did Training go? Answer from 18:00 on 21.11.", read_at: null,
    created_at: new Date().toISOString(), type: "calendar_question_asked", entity_type: "calendar_event", entity_id: "event-1",
    metadata: { eventId: "event-1", questionId: "q-1", kind: "rpe" }, ...overrides,
  };
}

test("N1. calendar_question_asked and calendar_question_moved route to notification-open-calendar-question with the question id and an 'Answer' hint", () => {
  for (const type of ["calendar_question_asked", "calendar_question_moved"]) {
    resetState();
    state.notifications.rows = [row({ type })];
    renderNotifications();
    assert.ok(panelHtml.includes('data-action="notification-open-calendar-question"'), type);
    assert.ok(panelHtml.includes('data-question-id="q-1"'), type);
    assert.ok(panelHtml.includes('<small class="notification-hint">Answer</small>'), type);
    assert.equal(panelHtml.includes("event-1</"), false, "the event id is never text");
  }
});

test("N2. another entity_type, a missing metadata.questionId, or another type stay the generic notification-read with no question id", () => {
  for (const overrides of [{ entity_type: "plan" }, { metadata: { eventId: "event-1" } }, { metadata: null }, { type: "calendar_event_changed" }]) {
    resetState();
    state.notifications.rows = [row(overrides)];
    renderNotifications();
    assert.ok(panelHtml.includes('data-action="notification-read"'), JSON.stringify(overrides));
    assert.ok(panelHtml.includes('data-question-id=""'), JSON.stringify(overrides));
    assert.equal(panelHtml.includes("notification-hint\">Answer<"), false);
  }
});

test("N3. the click marks it read, closes the panel and calls openCalendarQuestion with the question id, after the leave guard", async () => {
  resetState();
  state.notifications.rows = [row({})];
  state.notifications.unreadCount = 1;
  installFetchMock();
  let opened = null;
  let discarded = 0;
  const handled = await handleNotificationAction({ dataset: { action: "notification-open-calendar-question", notificationId: "n1", questionId: "q-1" } }, {
    confirmLeave: () => true,
    discardLeave: () => { discarded += 1; },
    openCalendarQuestion: async (id) => { opened = id; },
  });
  assert.equal(handled, true);
  assert.equal(opened, "q-1");
  assert.equal(state.notifications.open, false);
  assert.equal(state.notifications.unreadCount, 0);
  assert.deepEqual(fetchCalls.map((c) => [c.method, c.url]), [["POST", "/api/notifications/n1/read"]]);
  assert.equal(discarded, 1);
});

test("N4. a declined leave guard stops it: nothing read, nothing opened", async () => {
  resetState();
  state.notifications.rows = [row({})];
  installFetchMock();
  let opened = null;
  await handleNotificationAction({ dataset: { action: "notification-open-calendar-question", notificationId: "n1", questionId: "q-1" } }, {
    confirmLeave: () => false,
    openCalendarQuestion: async (id) => { opened = id; },
  });
  assert.equal(opened, null);
  assert.equal(fetchCalls.length, 0);
  assert.equal(state.notifications.open, true);
});
