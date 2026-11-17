// v76 (the owner, 2026-11-17): "Delete imported data" on an imported session of Training Load > Activities, for whoever
// may import (viewer.undoImport). The session's team comes from its roster read; the import from
// GET .../activities/:id/import-undo; the delete itself is the Imports review's (undo-preview, undo-import). Real handlers,
// a fake fetch.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

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

// Matches by URL substring; anything unmatched gets a harmless empty-rows
// 200 — most tests only care about the calendar/activity endpoint they're
// actually exercising, not the background metric-catalog fetches
// select-activity also fires.
function rulesResponder(rules) {
  return async (call) => {
    const rule = rules.find((r) => call.url.includes(r[0]));
    if (rule) return { status: rule[2] || 200, body: rule[1] };
    return { status: 200, body: { rows: [] } };
  };
}

// Deferred-resolution mock, same shape as training-load.actions.test.mjs's
// own installDeferredFetchMock — for deterministic fast-switching race
// tests (rapid week/month/activity navigation).
function installDeferredFetchMock() {
  const deferreds = [];
  fetchCalls = [];
  globalThis.fetch = (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    deferreds.push({ call, resolve: (result) => resolve({ ok: result.status < 300, status: result.status, json: async () => result.body }) });
    return promise;
  };
  return deferreds;
}

const { handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const {
  loadTrainingLoadCalendarWeek,
  loadTrainingLoadCalendarMonth,
  loadActivityDetail,
  captureTrainingLoadCalendarMutationContext,
  invalidateTrainingLoadCalendarContext,
} = await import("../training-load-calendar-data.js");
const { renderTrainingLoadCalendarHtml } = await import("../training-load-calendar-view.js");
const { addDaysIso, weekMondayIso, monthStartIso } = await import("../utils.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.athletes = [];
  queried = {};
}

let renderCount;
function renderTrainingLoad() {
  renderCount += 1;
}

function fakeAction(dataset, value) {
  return { dataset, value };
}

// ------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------

function activityItem(overrides = {}) {
  return {
    kind: "activity",
    activityId: "act-1",
    name: "Morning Strength",
    activityTypeKey: "training_session",
    occurredLocalDate: "2026-09-09",
    startedAt: "2026-09-09T09:00:00.000Z",
    timezoneSnapshot: "Europe/Belgrade",
    origin: "planned_session",
    lifecycleState: "confirmed",
    participantCount: 1,
    rpe: { requested: 1, rated: 1 },
    metrics: { total: 1, withData: 1 },
    conflictCount: 0,
    openSuggestionCount: 0,
    ...overrides,
  };
}
function plannedItem(overrides = {}) {
  return {
    kind: "planned", sessionId: "sess-1", logicalSessionId: "log-1", planId: "plan-1",
    sessionName: "Recovery Run", sessionTime: "09:00:00", rpeEnabled: true,
    athleteId: "ath-3", athleteName: "Petra Z", ...overrides,
  };
}
function externalItem(overrides = {}) {
  return {
    kind: "external", externalAssignmentId: "ext-1", scheduleId: "sch-1", eventName: "Camp",
    scheduleStatus: "active", assignmentStatus: "pending", opensAt: "2026-09-09T07:00:00.000Z",
    closesAt: null, athleteId: "ath-4", athleteName: "Marko M", ...overrides,
  };
}
function calendarPayload(weekStart, itemsByDate = {}) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(weekStart, i);
    days.push({ date, items: itemsByDate[date] || [] });
  }
  return { dateFrom: weekStart, dateTo: addDaysIso(weekStart, 6), days };
}
function monthGridPayload(gridStart, gridEnd, itemsByDate = {}) {
  const days = [];
  let d = gridStart;
  while (d <= gridEnd) {
    days.push({ date: d, items: itemsByDate[d] || [] });
    d = addDaysIso(d, 1);
  }
  return { dateFrom: gridStart, dateTo: gridEnd, days };
}
function rpeFact(athleteId, overrides = {}) {
  return { canonicalActivityId: "act-1", canonicalParticipantId: `p-${athleteId}`, athleteId, factKind: "rpe", detail: { sessionFeedbackId: "fb-1", rpe: 7, durationMinutes: 60, srpe: 420, source: "planned", ...overrides } };
}
function metricValueFact(athleteId, overrides = {}) {
  return {
    canonicalActivityId: "act-1", canonicalParticipantId: `p-${athleteId}`, athleteId, factKind: "metric_value",
    detail: {
      occasionId: "occ-1", sourceIdentityId: null, entryMethod: "manual", metricDefinitionId: "def-distance",
      metricDefinitionVersionId: "defv-1", valueNumeric: 5000, valueBoolean: null, valueText: null,
      unitAtCapture: "m", aggregationRole: "standalone", coverage: "full", isDerived: false, computedByRef: null,
      segmentId: null, ...overrides,
    },
  };
}
function componentLinkFact(componentId, segmentId) {
  return { canonicalActivityId: "act-1", canonicalParticipantId: null, athleteId: null, factKind: "component_metric_segment_link", detail: { componentId, metricEventSegmentId: segmentId, linkStatus: "confirmed" } };
}
function activityDetailPayload(overrides = {}) {
  return { canonicalActivityId: "act-1", facts: [], athleteNamesById: {}, components: [], ...overrides };
}
function withActivitySelected(cal, { weekStart = "2026-09-07", selectedDate = "2026-09-09", item = activityItem(), detail = activityDetailPayload() } = {}) {
  cal.weekStart = weekStart;
  cal.selectedDate = selectedDate;
  cal.data = calendarPayload(weekStart, { [selectedDate]: [item] });
  cal.selectedActivityId = item.activityId;
  cal.activityDetail = { activityId: item.activityId, data: detail, loading: false, error: "" };
}


const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const CAND = "cccccccc-0000-4000-8000-000000000001";
const EVENT = "eeeeeeee-0000-4000-8000-000000000001";
const imported = (o = {}) => activityItem({ origin: "source_import", name: "FULL TRAINING", ...o });
const rosterFor = (teamId = TEAM) => ({
  activity: { id: "act-1", name: "FULL TRAINING", occurredLocalDate: "2026-09-09", startedAt: "2026-09-09T09:00:00Z", timezone: "Europe/Belgrade", ownerTeamId: teamId },
  canonicalActivityId: "act-1", viewer: { basis: "team_coach" }, completion: { status: "complete" }, reasons: [],
  counts: { total: 0, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 }, athletes: [], recordedOutsideRoster: [],
});
const preview = { eventId: EVENT, removedCounts: { metric_event_participants: 3, metric_values: 9, activities: 1 }, removedTotal: 13, undoneCandidateIds: [CAND], rosterWork: null };

// One server: the calendar week, the activity, its roster, the team's status, the import lookup and the delete.
function server({ undoImport = true, admin = false, lookup = { status: 200, body: { importUndo: { candidateId: CAND } } }, undo = null, item = imported(), statusFails = false } = {}) {
  const calls = [];
  installFetchMock(async (call) => {
    calls.push(call);
    if (call.url.startsWith("/api/training-load/calendar")) return { status: 200, body: calendarPayload("2026-09-07", { "2026-09-09": [item] }) };
    if (call.url === "/api/training-activity/act-1") return { status: 200, body: activityDetailPayload() };
    if (call.url === "/api/training-activity/act-1/roster") return { status: 200, body: rosterFor() };
    if (call.url === `/api/training-load/gpexe/teams/${TEAM}/status`) return statusFails ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: { viewer: { canApprove: true, isPlatformAdmin: admin, ...(undoImport ? { undoImport: true } : {}) } } };
    if (call.url === `/api/training-load/gpexe/teams/${TEAM}/activities/act-1/import-undo`) return lookup;
    if (call.url.endsWith(`/candidates/${CAND}/undo-preview`)) return { status: 200, body: { undoPreview: preview } };
    if (call.url.endsWith(`/candidates/${CAND}/undo-import`)) return undo ? undo(call) : { status: 200, body: { undo: { removedCounts: preview.removedCounts, offeredAgain: true } } };
    return { status: 200, body: { rows: [] } };
  });
  return calls;
}

async function openSession(options) {
  resetState();
  const calls = server(options);
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-07";
  cal.selectedDate = "2026-09-09";
  cal.data = calendarPayload("2026-09-07", { "2026-09-09": [options?.item || imported()] });
  renderCount = 0;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-calendar-select-activity", activityId: "act-1" }), { renderTrainingLoad });
  return calls;
}
const act = (action, dataset = {}) => handleTrainingLoadAction(fakeAction({ action, ...dataset }), { renderTrainingLoad });
const section = () => {
  const page = renderTrainingLoadCalendarHtml();
  const at = page.indexOf('aria-label="Delete imported data"');
  return at < 0 ? "" : page.slice(at);
};
let reason = "";
queried["[data-gpexe-undo-reason]"] = null;
function typeReason(text) {
  reason = text;
  queried["[data-gpexe-undo-reason]"] = { value: reason };
}

test("1. an imported session, for a viewer who may import: the team comes from the roster, then the import; one button", async () => {
  const calls = await openSession();
  assert.ok(calls.some((c) => c.url === `/api/training-load/gpexe/teams/${TEAM}/status`), "the session's own team");
  assert.ok(calls.some((c) => c.url === `/api/training-load/gpexe/teams/${TEAM}/activities/act-1/import-undo`));
  const s = section();
  assert.match(s, /data-action="training-load-session-undo-open"[^>]*>Delete imported data\.\.\.</);
  assert.equal(calls.filter((c) => c.url.includes("/undo-preview")).length, 0, "nothing is read before the button");
});

test("2. nothing is offered without the right, for a session that is not an import, for a 404 or a failed read - and never an error", async () => {
  let calls = await openSession({ undoImport: false });
  assert.equal(section(), "");
  assert.ok(!calls.some((c) => c.url.includes("/import-undo")), "no lookup without the right");
  await openSession({ lookup: { status: 404, body: { error: "notFound" } } });
  assert.equal(section(), "");
  await openSession({ statusFails: true });
  assert.equal(section(), "");
  assert.doesNotMatch(renderTrainingLoadCalendarHtml(), /builder-error/, "no error on the session");
  calls = await openSession({ item: activityItem({ origin: "planned_session" }) });
  assert.ok(!calls.some((c) => c.url.includes("/gpexe/")), "a planned session asks nothing");
  assert.equal(section(), "");
});

test("3. the delete from the session: the scope first, a reason, one POST to the session's team with the key and event; the contract's sentence; no re-import button; the day is read again", async () => {
  const calls = await openSession();
  await act("training-load-session-undo-open");
  let s = section();
  assert.match(s, /This removes the session from the calendar and deletes its imported data: 3 athletes, 9 values\./);
  await act("training-load-gpexe-undo-confirm");
  assert.match(section(), /Write why the imported data is deleted\./);
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  typeReason("Wrong athletes");
  const asked = [];
  globalThis.window.confirm = (q) => { asked.push(q); return true; };
  const weekReads = calls.filter((c) => c.url.startsWith("/api/training-load/calendar")).length;
  await act("training-load-gpexe-undo-confirm");
  globalThis.window.confirm = () => true;
  assert.match(asked[0], /^Delete the imported data of FULL TRAINING\? The session leaves the calendar\./);
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.url, `/api/training-load/gpexe/teams/${TEAM}/candidates/${CAND}/undo-import`);
  assert.equal(post.body.reason, "Wrong athletes");
  assert.deepEqual(post.body.expected, { eventId: EVENT });
  s = section();
  assert.match(s, /The imported data is deleted\. To import it again, find new sessions in Imports with dates that include 09\.09\.2026\./);
  assert.doesNotMatch(s, /training-load-gpexe-open/, "no re-import button");
  assert.match(s, /data-action="training-load-calendar-clear-activity"[^>]*>Back to the day</);
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(calls.filter((c) => c.url.startsWith("/api/training-load/calendar")).length > weekReads, "the day is read again");
});

test("4. a coach reads plain sentences: a refusal is the server's own sentence, no code, no Technical details; a platform admin has them", async () => {
  const refuse = () => ({ status: 409, body: { error: "calendar_link_exists", message: "This session is attached to a calendar event. Remove it from the calendar event first, then delete it again." } });
  for (const admin of [false, true]) {
    await openSession({ admin, undo: refuse });
    await act("training-load-session-undo-open");
    typeReason("Wrong athletes");
    await act("training-load-gpexe-undo-confirm");
    const s = section();
    assert.match(s, /Nothing was removed\.<\/strong> This session is attached to a calendar event\. Remove it from the calendar event first, then delete it again\./);
    if (admin) assert.match(s, /Technical details[\s\S]*calendar_link_exists/);
    else {
      assert.doesNotMatch(s, /Technical details|calendar_link_exists|HTTP status/);
    }
  }
});

test("5. a lost answer is not confirmed: Check the result sends the SAME request; leaving asks", async () => {
  let n = 0;
  const calls = await openSession({ undo: () => (n++ === 0 ? { status: 502, body: null } : { status: 200, body: { undo: { removedCounts: preview.removedCounts } } }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  await act("training-load-gpexe-undo-confirm");
  assert.match(section(), /We can(?:'|&#0?39;)t tell yet whether the imported data was deleted/);
  assert.doesNotMatch(section(), /Technical details/, "a coach gets no technical details");
  const { importsUnloadShouldWarn } = await import("../gpexe-import-data.js");
  assert.ok(importsUnloadShouldWarn(), "leaving the page asks");
  await act("training-load-gpexe-undo-check");
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.requestKey, posts[1].body.requestKey, "the same key");
  assert.match(section(), /The imported data is deleted\./);
});

test("6. Cancel goes back to the offer; another session's open delete is not shown here", async () => {
  await openSession();
  await act("training-load-session-undo-open");
  await act("training-load-gpexe-undo-cancel");
  assert.match(section(), /data-action="training-load-session-undo-open"/);
  await act("training-load-session-undo-open");
  state.trainingLoad.calendar.selectedActivityId = "act-2";
  assert.doesNotMatch(renderTrainingLoadCalendarHtml(), /Delete imported data/);
});

test("7 (code review): a delete settled on one session never hides another session's offer", async () => {
  let n = 0;
  await openSession({ undo: () => (n++ === 0 ? { status: 502, body: null } : { status: 200, body: { undo: { removedCounts: preview.removedCounts } } }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  await act("training-load-gpexe-undo-confirm");
  assert.equal(state.trainingLoad.gpexe.undo.step, "unknown");
  // Another session (B) gets its own offer while A is not confirmed.
  const e = state.trainingLoad.calendar.importUndo;
  Object.assign(e, { activityId: "act-2", step: "offer", candidateId: "cand-b" });
  await act("training-load-gpexe-undo-check");
  assert.equal(state.trainingLoad.gpexe.undo.step, "done");
  assert.equal(e.step, "offer", "B's offer stays");
});

test("8 (code review): the back-in-Imports sentence when the server offered the session again with its review ready; the leave question says 'deleting'", async () => {
  await openSession({ undo: () => ({ status: 200, body: { undo: { removedCounts: preview.removedCounts, offeredAgain: true, previewReady: true } } }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  await act("training-load-gpexe-undo-confirm");
  assert.match(section(), /The imported data is deleted\. The session is back in Imports: correct the athlete links if they were wrong, then import it again there\./);
  let asked = "";
  await openSession({ undo: () => ({ status: 502, body: null }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  await act("training-load-gpexe-undo-confirm");
  const { confirmLeaveTrainingLoad } = await import("../training-load-actions.js");
  state.activeTab = "training-load";
  globalThis.window.confirm = (q) => { asked = q; return false; };
  try {
    assert.equal(confirmLeaveTrainingLoad("athletes"), false);
  } finally {
    globalThis.window.confirm = () => true;
  }
  assert.match(asked, /The result of deleting imported data is not confirmed/);
  assert.doesNotMatch(asked, /undo/i);
});

test("9 (code review): a delete settled from the session also reads an open Imports review of the same session again", async () => {
  const calls = await openSession();
  state.trainingLoad.gpexe.detail = { id: CAND, candidate: { id: CAND, status: "imported" } };
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  await act("training-load-gpexe-undo-confirm");
  const post = calls.findIndex((c) => c.method === "POST");
  assert.ok(calls.slice(post).some((c) => c.method === "GET" && c.url === `/api/training-load/gpexe/teams/${TEAM}/candidates/${CAND}`), "the review's candidate is read again");
});

test("10: while the delete is being sent, the coach cannot open another session or go back to the day", async () => {
  let release;
  await openSession({ undo: () => new Promise((r) => { release = () => r({ status: 200, body: { undo: { removedCounts: preview.removedCounts } } }); }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  const sending = act("training-load-gpexe-undo-confirm");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.trainingLoad.gpexe.undo.step, "sending");
  await act("training-load-calendar-select-activity", { activityId: "act-2" });
  assert.equal(state.trainingLoad.calendar.selectedActivityId, "act-1", "the session stays open");
  await act("training-load-calendar-clear-activity");
  assert.equal(state.trainingLoad.calendar.selectedActivityId, "act-1");
  release();
  await sending;
  assert.equal(state.trainingLoad.gpexe.undo.step, "done");
});

test("11 (code review): a delete being sent keeps the session through another day, Today, a filter change and the Athletes hand-off", async () => {
  let release;
  await openSession({ undo: () => new Promise((r) => { release = () => r({ status: 200, body: { undo: { removedCounts: preview.removedCounts } } }); }) });
  await act("training-load-session-undo-open");
  typeReason("Wrong athletes");
  const sending = act("training-load-gpexe-undo-confirm");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.trainingLoad.gpexe.undo.step, "sending");
  for (const [action, dataset] of [
    ["training-load-calendar-select-day", { date: "2026-09-10" }],
    ["training-load-calendar-today", {}],
    ["training-load-filter-confirm", {}],
    ["training-load-results-view-activity-in-calendar", { activityId: "act-2", date: "2026-09-10" }],
  ]) {
    await act(action, dataset);
    assert.equal(state.trainingLoad.calendar.selectedActivityId, "act-1", `${action} keeps the session`);
  }
  release();
  await sending;
  assert.match(section(), /The imported data is deleted\./);
});
