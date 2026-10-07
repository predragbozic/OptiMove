// Phase 5a3b: individual and bulk roster decisions — every write outcome,
// the same requestKey on Check result, double clicks, hidden selections,
// stale decisions, bulk conflicts, Two states, measured after a decision,
// removal, 403/404/superseded, a session change while a request is out.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
let phone = false;
let confirmAnswer = true;
let confirmQuestions = [];
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: phone }) };

const { emptyTrainingLoadState, state } = await import("../state.js");
const { renderActivityRosterHtml } = await import("../activity-roster-view.js");
const { handleActivityRosterAction, rosterMayBeLeft, rosterUnloadShouldWarn, closeActivityRosterOverlay } = await import("../activity-roster-actions.js");
const { loadActivityRoster, resetActivityRoster, classifyWriteError } = await import("../activity-roster-data.js");
const { confirmLeaveTrainingLoad, handleTrainingLoadBeforeUnload, handleTrainingLoadAction } = await import("../training-load-actions.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function athletes() {
  return [
    { athleteId: "ath-1", name: "Ivan Marković", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: [], decision: null, values: [] },
    {
      athleteId: "ath-2", name: "Luka Jurić", state: "no_usable_device_record", stateLabel: "No usable device record", group: "needs_state", flags: [], decision: null,
      sourceReason: { sourceSystem: "gpexe", code: "needs_manual_review", label: "flagged this record for a manual check" }, values: [],
    },
    { athleteId: "ath-3", name: "Mira Lukić", state: "measured", stateLabel: "Measured", group: "done", flags: [], decision: null, values: [{ metricKey: "duration", shortLabel: "Time", value: 60, unit: "min", entryMethod: "api_import" }] },
    {
      athleteId: "ath-4", name: "Ana Kovač", state: "did_not_participate", stateLabel: "Did not participate", group: "done", flags: [], values: [],
      decision: { id: "d-4", kind: "did_not_participate", label: "Did not participate", reasonKey: "illness", decidedBy: { name: "Goran Babić" }, decidedAt: "2026-09-18T12:00:00Z" },
    },
    {
      athleteId: "ath-5", name: "Petar Kunić", state: "participated_no_values", stateLabel: "Participated · no device data", group: "needs_review", flags: ["measured_after_decision"],
      decision: { id: "d-5", kind: "participated_no_values", label: "Participated · no device data", decidedBy: { name: "Mira Coach" }, decidedAt: "2026-09-18T12:00:00Z" },
      values: [{ metricKey: "duration", shortLabel: "Time", value: 55, unit: "min", entryMethod: "api_import" }],
    },
    {
      athleteId: "ath-6", name: "Omar Sijarić", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: ["decisions_disagree"], decision: null, values: [],
      conflictingDecisions: [
        { id: "d-6a", kind: "participated_no_values", label: "Participated · no device data", decidedBy: { name: "Coach A" } },
        { id: "d-6b", kind: "did_not_participate", label: "Did not participate", reasonKey: "illness", decidedBy: { name: "Coach B" } },
      ],
    },
    { athleteId: "ath-7", name: "Sara Ilić", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: [], decision: null, values: [] },
  ];
}

function payload(overrides = {}) {
  return {
    activity: { id: "act-1", name: "Full training", occurredLocalDate: "2026-09-18", startedAt: "2026-09-18T15:00:00Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: "act-1",
    viewer: { basis: "team_coach" },
    completion: { status: "not_complete", revision: 0 },
    reasons: [{ key: "injury_contact", label: "Injury (contact)" }, { key: "illness", label: "Illness" }],
    counts: { total: 7, needsState: 4, needsReview: 1, recordedOutsideRoster: 0 },
    athletes: athletes(),
    recordedOutsideRoster: [],
    ...overrides,
  };
}

let requests = [];
// A fake server: GETs answer `get()`, writes go to `onWrite`.
function serve({ get = () => ({ status: 200, body: payload() }), onWrite = () => ({ status: 200, body: {} }) } = {}) {
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, url, body });
    const result = method === "GET" ? await get(url) : await onWrite(method, url, body, requests.length);
    if (result instanceof Error) throw result;
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

async function openRoster(options) {
  state.trainingLoad = emptyTrainingLoadState();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "team-1" } };
  state.deliberateNavigation = false;
  state.activeTab = "training-load";
  phone = false;
  confirmAnswer = true;
  confirmQuestions = [];
  serve(options);
  state.trainingLoad.calendar.selectedActivityId = "act-1";
  resetActivityRoster("act-1");
  await loadActivityRoster("act-1", () => {});
  requests = [];
  return state.trainingLoad.calendar.roster;
}

let renders = 0;
const render = () => { renders += 1; };
const act = (action, extra = {}) => handleActivityRosterAction({ dataset: { action, ...extra } }, { render });
const writes = () => requests.filter((r) => r.method !== "GET");
const gets = () => requests.filter((r) => r.method === "GET");
const html = () => renderActivityRosterHtml(state.trainingLoad.calendar.roster);

test("Participated · no device data saves at once with expectedDecisionId null, shows Saved and rereads the roster", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: { decision: { id: "d-new" }, athlete: {}, completion: {} } }) });
  assert.match(html(), /Each state is saved as soon as you choose it/);
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  const [w] = writes();
  assert.equal(w.method, "PUT");
  assert.equal(w.url, "/api/training-activity/act-1/roster/ath-1/decision");
  assert.deepEqual({ ...w.body, requestKey: "k" }, { kind: "participated_no_values", expectedDecisionId: null, requestKey: "k" });
  assert.match(w.body.requestKey, UUID);
  assert.equal(gets().length, 1, "one reread after the save");
  assert.equal(roster.notices.rows["ath-1"].text, "Saved: Ivan Marković — Participated · no device data.");
  assert.match(html(), /is-saved/);
  assert.equal(roster.unconfirmed, null);
  assert.deepEqual(roster.changedRows, [], "the coach's own save is not 'changed under the coach'");
});

test("double click sends one request; a write in flight locks every write control until it settles", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const first = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(writes().length, 1);
  assert.match(html(), /data-athlete-id="ath-1"[^>]*disabled/);
  assert.ok(roster.busy["ath-1"]);
  assert.match(html(), /data-action="training-load-roster-set" data-athlete-id="ath-7"[^>]*disabled/, "one command at a time");
  await act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  assert.equal(writes().length, 1);
  assert.equal(rosterUnloadShouldWarn(), true);
  release();
  await first;
  assert.doesNotMatch(html(), /data-action="training-load-roster-set" data-athlete-id="ath-7"[^>]*disabled/);
  assert.ok(!roster.busy["ath-1"]);
  assert.equal(rosterUnloadShouldWarn(), false);
});

test("Did not participate opens the reason list; tapping a reason saves with the reason and the trimmed note", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  await act("training-load-roster-absent", { athleteId: "ath-1" });
  assert.equal(roster.picker.scope, "row");
  assert.equal(roster.confirm, null, "no source record: no question first");
  assert.match(html(), /Why did Ivan Marković not participate\?/);
  assert.match(html(), /Injury \(contact\)[\s\S]*Illness/);
  assert.doesNotMatch(html(), />\s*injury_contact\s*</, "keys never shown as text");
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-note" }, value: "  felt sick  " }, { render });
  await act("training-load-roster-reason", { reasonKey: "illness" });
  const [w] = writes();
  assert.equal(w.body.kind, "did_not_participate");
  assert.equal(w.body.reasonKey, "illness");
  assert.equal(w.body.note, "felt sick");
  assert.equal(roster.picker, null, "the list closes after the save");
});

test("an athlete with a source record is asked before a single absence; a bulk absence leaves them out and names them", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  await act("training-load-roster-absent", { athleteId: "ath-2" });
  assert.equal(roster.picker, null);
  assert.equal(roster.confirm.type, "absent_anyway");
  assert.match(html(), /The device source has a record for Luka Jurić\. Mark Luka Jurić as not participating anyway\?/);
  assert.doesNotMatch(html(), /GPEXE has a record/);
  await act("training-load-roster-confirm-proceed", { athleteId: "ath-2" });
  assert.equal(roster.picker?.athleteId, "ath-2");
  await act("training-load-roster-picker-cancel");

  await act("training-load-roster-select-needing");
  await act("training-load-roster-bulk", { kind: "did_not_participate" });
  const h = html();
  assert.match(h, /Luka Jurić is left out: the device source has a record for Luka Jurić\. Set this state on the row\./);
  assert.match(h, /Apply to 2 athletes/);
  await act("training-load-roster-reason", { reasonKey: "illness" });
  await act("training-load-roster-bulk-apply");
  const [w] = writes();
  assert.deepEqual(w.body.athletes.map((a) => a.athleteId).sort(), ["ath-1", "ath-7"]);
  assert.equal(w.body.reasonKey, "illness");
});

test("Change unfolds the choices; Remove this state asks, then DELETEs the current decision id", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  assert.match(html(), /data-action="training-load-roster-change" data-athlete-id="ath-4"/);
  assert.doesNotMatch(html(), /data-action="training-load-roster-remove"/);
  await act("training-load-roster-change", { athleteId: "ath-4" });
  assert.match(html(), /training-load-roster-remove/);
  await act("training-load-roster-remove", { athleteId: "ath-4" });
  assert.match(html(), /Remove the state of Ana Kovač\?[^<]*returns to &quot;Unknown&quot;[^<]*The earlier entry is kept/);
  assert.equal(writes().length, 0);
  await act("training-load-roster-confirm-proceed", { athleteId: "ath-4" });
  const [w] = writes();
  assert.equal(w.method, "DELETE");
  assert.equal(w.url, "/api/training-activity/act-1/roster/ath-4/decision");
  assert.equal(w.body.expectedDecisionId, "d-4");
  assert.match(w.body.requestKey, UUID);
  assert.equal(roster.notices.rows["ath-4"].text, "Saved: Ana Kovač — state removed.");
});

test("measured values after a decision offer only Use measured values, with an inline confirmation naming the removed state", async () => {
  await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  const h = html();
  const row = h.slice(h.indexOf('data-roster-row="ath-5"'), h.indexOf('data-roster-row="ath-4"'));
  assert.match(row, /Use measured values/);
  assert.doesNotMatch(row, /training-load-roster-set|training-load-roster-change|Keep this decision|type="checkbox"/);
  await act("training-load-roster-use-measured", { athleteId: "ath-5" });
  assert.match(html(), /Use the measured values for Petar Kunić\? The state &quot;Participated · no device data&quot; set by Mira Coach will be removed\./);
  assert.equal(writes().length, 0, "nothing is sent before the confirmation");
  await act("training-load-roster-confirm-proceed", { athleteId: "ath-5" });
  const [w] = writes();
  assert.equal(w.method, "DELETE");
  assert.equal(w.body.expectedDecisionId, "d-5");
});

test("Two states: both states and who set them, no checkbox, one choice replaces both", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  const h = html();
  const row = h.slice(h.indexOf('data-roster-row="ath-6"'), h.indexOf('data-roster-row="ath-7"'));
  assert.match(row, /Two states/);
  assert.match(row, /Participated · no device data \(Coach A\) \/ Did not participate · Illness \(Coach B\)/);
  assert.doesNotMatch(row, /type="checkbox"/);
  await act("training-load-roster-select-needing");
  assert.ok(!roster.selected.includes("ath-6"), "Select the N skips Two states");
  assert.match(html(), /Select the 3 that need a state|3 selected/);
  await act("training-load-roster-clear-selection");

  await act("training-load-roster-set", { athleteId: "ath-6", kind: "participated_no_values" });
  assert.match(html(), /It replaces both states\./);
  assert.equal(writes().length, 0);
  await act("training-load-roster-confirm-proceed", { athleteId: "ath-6" });
  assert.equal(writes()[0].body.expectedDecisionId, "d-6a");

  await act("training-load-roster-absent", { athleteId: "ath-6" });
  await act("training-load-roster-reason", { reasonKey: "illness" });
  assert.equal(writes().length, 1, "a reason on a Two states row asks first");
  assert.match(html(), /Replace both states of Omar Sijarić with "Did not participate · Illness"\?/);
  await act("training-load-roster-picker-confirm");
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].body.expectedDecisionId, "d-6a");
});

test("bulk: only rows without a state are selectable, a filter change keeps hidden ticks and names them, the request carries only the ticked athletes", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: { decisions: [{}, {}, {}], athletes: [], completion: {} } }) });
  let h = html();
  for (const id of ["ath-1", "ath-2", "ath-7"]) assert.match(h, new RegExp(`type="checkbox" data-action="training-load-roster-pick" data-athlete-id="${id}"`));
  for (const id of ["ath-3", "ath-4", "ath-5", "ath-6"]) assert.doesNotMatch(h, new RegExp(`data-action="training-load-roster-pick" data-athlete-id="${id}"`));
  await act("training-load-roster-select-needing");
  assert.deepEqual([...roster.selected].sort(), ["ath-1", "ath-2", "ath-7"]);
  await act("training-load-roster-filter", { rosterFilter: "done" });
  assert.equal(roster.selected.length, 3, "the filter keeps the selection");
  h = html();
  assert.match(h, /3 selected · 3 not in this filter/);
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  h = html();
  assert.match(h, /Set "Participated · no device data" for 3 athletes\?/);
  assert.match(h, /Ivan Marković \(not shown in this filter\), Luka Jurić \(not shown in this filter\), Sara Ilić \(not shown in this filter\)/);
  assert.equal(writes().length, 0);
  await act("training-load-roster-bulk-apply");
  const [w] = writes();
  assert.equal(w.method, "POST");
  assert.equal(w.url, "/api/training-activity/act-1/roster/decisions");
  assert.deepEqual(w.body.athletes.map((a) => a.athleteId).sort(), ["ath-1", "ath-2", "ath-7"]);
  assert.ok(w.body.athletes.every((a) => a.expectedDecisionId === null));
  assert.equal(w.body.reasonKey, undefined);
  assert.equal(roster.notices.top.text, "Saved for 3 athletes.");
  assert.deepEqual(roster.selected, []);
});

test("bulk conflict: nobody changes silently, the changed athlete is named with the current state and unticked, Apply to the other N sends only the rest", async () => {
  const conflict = {
    status: 409,
    body: { error: "bulk_conflict", failed: [{ athleteId: "ath-2", error: "measured_record_exists", current: { athleteId: "ath-2", state: "measured", decision: null, currentDecisionIds: [] } }] },
  };
  let first = true;
  const changed = payload();
  changed.athletes[1] = { ...changed.athletes[1], state: "measured", stateLabel: "Measured", group: "done", sourceReason: null };
  const roster = await openRoster({
    get: () => ({ status: 200, body: first ? payload() : changed }),
    onWrite: () => { if (first) { first = false; return conflict; } return { status: 200, body: { decisions: [{}, {}] } }; },
  });
  await act("training-load-roster-select-needing");
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  await act("training-load-roster-bulk-apply");
  assert.match(roster.notices.top.text, /^Nothing was saved\. 1 athlete changed: Luka Jurić \(now Measured\)\.$/);
  assert.equal(roster.notices.top.action.label, "Apply to the other 2");
  assert.ok(!roster.selected.includes("ath-2"));
  assert.ok(roster.changedRows.includes("ath-2"), "the row that changed under the coach is marked after the reread");
  assert.match(html(), /is-changed/);
  await act("training-load-roster-bulk-retry");
  const second = writes()[1];
  assert.deepEqual(second.body.athletes.map((a) => a.athleteId).sort(), ["ath-1", "ath-7"]);
  assert.notEqual(second.body.requestKey, writes()[0].body.requestKey);
});

test("a lost answer is Result not confirmed, never a failure; Check result repeats the same command with the same requestKey", async () => {
  let fail = true;
  const roster = await openRoster({ onWrite: () => (fail ? new TypeError("Failed to fetch") : { status: 200, body: { decision: {} } }) });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.ok(roster.unconfirmed);
  assert.deepEqual(roster.unconfirmed.athleteIds, ["ath-1"]);
  let h = html();
  assert.match(h, /Result not confirmed\. Do not choose another state until this result is checked\./);
  assert.doesNotMatch(h, /Nothing was saved/);
  assert.match(h, /Check result/);
  assert.equal(rosterUnloadShouldWarn(), true);
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(writes().length, 1, "the locked row takes no new command");
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  assert.equal(roster.picker, null, "no bulk until the result is checked");
  fail = false;
  await act("training-load-roster-check-result");
  assert.equal(writes().length, 2);
  assert.deepEqual(writes()[1].body, writes()[0].body, "same body, same requestKey");
  assert.equal(roster.unconfirmed, null);
  assert.equal(roster.notices.rows["ath-1"].tone, "saved");
});

test("outcome_unknown and an uncoded 5xx are not confirmed; internal_error and roster_busy are Nothing was saved with Try again", async () => {
  assert.equal(classifyWriteError({ status: 503, data: { error: "outcome_unknown" } }).outcome, "unconfirmed");
  assert.equal(classifyWriteError({ status: 502, data: null }).outcome, "unconfirmed");
  assert.equal(classifyWriteError({ status: 504, data: { error: "gateway" } }).outcome, "unconfirmed");
  assert.equal(classifyWriteError({}).outcome, "unconfirmed");
  assert.equal(classifyWriteError({ status: 500, data: { error: "internal_error" } }).outcome, "refused");
  assert.equal(classifyWriteError({ status: 503, data: { error: "roster_busy" } }).outcome, "refused");
  assert.equal(classifyWriteError({ status: 409, data: { error: "decision_changed" } }).outcome, "refused");

  let answer = { status: 503, body: { error: "roster_busy", message: "The session is being changed. Try again." } };
  const roster = await openRoster({ onWrite: () => answer });
  await act("training-load-roster-select-needing");
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  await act("training-load-roster-bulk-apply");
  assert.equal(roster.notices.top.text, "This session or the server is busy right now. Try again. Nothing was saved.");
  assert.equal(roster.selected.length, 3, "roster_busy keeps the selection");
  assert.doesNotMatch(html(), /The session is being changed/, "server text never reaches the coach");
  answer = { status: 500, body: { error: "internal_error", message: "Nothing was saved. Try again." } };
  await act("training-load-roster-try-again");
  assert.equal(writes().length, 2);
  assert.notEqual(writes()[1].body.requestKey, writes()[0].body.requestKey, "a refused key is not reused");
  assert.equal(roster.notices.top.text, "Nothing was saved. Try again.");
  assert.match(html(), /Technical details[\s\S]*internal_error/);
});

test("decision_changed names who changed the athlete and the current state; the roster is read again once", async () => {
  const roster = await openRoster({
    onWrite: () => ({
      status: 409,
      body: { error: "decision_changed", current: { athleteId: "ath-1", state: "did_not_participate", decision: { kind: "did_not_participate", label: "Did not participate", reasonKey: "illness", decidedBy: { name: "Goran Babić" } }, currentDecisionIds: ["d-x"] } },
    }),
  });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(roster.notices.rows["ath-1"].text, "Goran Babić changed Ivan Marković a moment ago (now: Did not participate · Illness). Nothing was saved.");
  assert.equal(gets().length, 1);
});

test("unknown_reason keeps the reason list open with the typed note; nothing_to_clear names the current state", async () => {
  let answer = { status: 400, body: { error: "unknown_reason" } };
  const roster = await openRoster({ onWrite: () => answer });
  await act("training-load-roster-absent", { athleteId: "ath-1" });
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-note" }, value: "note kept" }, { render });
  await act("training-load-roster-reason", { reasonKey: "illness" });
  assert.equal(roster.picker?.scope, "row");
  assert.equal(roster.picker.note, "note kept");
  assert.equal(roster.picker.error, "This reason is no longer available. Choose another. Nothing was saved.");
  await act("training-load-roster-picker-cancel");

  answer = { status: 409, body: { error: "nothing_to_clear", current: { athleteId: "ath-4", state: "unknown", decision: null, currentDecisionIds: [] } } };
  await act("training-load-roster-change", { athleteId: "ath-4" });
  await act("training-load-roster-remove", { athleteId: "ath-4" });
  await act("training-load-roster-confirm-proceed", { athleteId: "ath-4" });
  assert.equal(roster.notices.rows["ath-4"].text, "Ana Kovač has no state to remove any more (now: Unknown). Nothing was saved.");
});

test("403, 404 and a merged session lock every write control and offer the safe next step", async () => {
  for (const [answer, text, action] of [
    [{ status: 403, body: { error: "not_a_team_coach" } }, "Your access changed before this choice was saved. Nothing was saved.", "training-load-calendar-clear-activity"],
    [{ status: 404, body: { error: "notFound" } }, "This session is not available any more. Nothing was saved.", "training-load-calendar-clear-activity"],
    [{ status: 409, body: { error: "activity_superseded", canonicalActivityId: "act-current" } }, "This session was merged into another. Nothing was saved.", "training-load-calendar-select-activity"],
  ]) {
    const roster = await openRoster({ onWrite: () => answer });
    await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
    assert.ok(roster.writeLock);
    const h = html();
    assert.match(h, new RegExp(text.replace(/[.?]/g, "\\$&")));
    assert.match(h, new RegExp(`data-action="${action}"`));
    assert.doesNotMatch(h, /training-load-roster-set|type="checkbox"/, "no write control while locked");
    await act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
    assert.equal(writes().length, 1);
    assert.equal(gets().length, 0, "no reread after 403/404/superseded");
  }
  assert.match(html(), /data-activity-id="act-current"/);
});

test("a session change while a write is out asks first; if left anyway, the late answer never touches the new session", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const pending = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  confirmAnswer = false;
  assert.equal(rosterMayBeLeft(), false);
  assert.equal(confirmLeaveTrainingLoad("athletes"), false);
  const event = { preventDefault() { this.prevented = true; } };
  assert.equal(handleTrainingLoadBeforeUnload(event), true);
  confirmAnswer = true;
  const handled = await handleTrainingLoadAction({ dataset: { action: "training-load-calendar-clear-activity" } }, { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate() {} });
  assert.equal(handled, true);
  assert.match(confirmQuestions.at(-1), /still being saved/);
  assert.equal(roster.activityId, null);
  resetActivityRoster("act-2");
  release();
  await pending;
  const now = state.trainingLoad.calendar.roster;
  assert.equal(now.activityId, "act-2");
  assert.equal(Object.keys(now.busy).length, 0);
  assert.equal(Object.keys(now.notices.rows).length, 0);
  assert.equal(gets().length, 0, "no reread of a session that is no longer open");
});

test("a failed reread after a confirmed save keeps the saved outcome and offers Try again", async () => {
  let reads = 0;
  const roster = await openRoster({
    get: () => { reads += 1; return reads === 1 ? { status: 200, body: payload() } : { status: 500, body: { error: "internal_error" } }; },
    onWrite: () => ({ status: 200, body: {} }),
  });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(roster.notices.rows["ath-1"].tone, "saved");
  assert.equal(roster.refreshFailed, true);
  assert.ok(roster.data, "the roster on screen stays");
  const h = html();
  assert.match(h, /Saved, but the roster could not be refreshed\./);
  assert.doesNotMatch(h, /Nothing was saved/);
  assert.match(h, /training-load-roster-refresh/);
});

test("phone: one sticky action by priority (unconfirmed → selection → need a state), Set state… opens one sheet, Escape closes it", async () => {
  const roster = await openRoster({ onWrite: () => new TypeError("offline") });
  phone = true;
  await act("training-load-roster-filter", { rosterFilter: "done" });
  let h = html();
  assert.match(h, /tl-roster-sticky[\s\S]*4 athletes need a state[\s\S]*Show them/);
  await act("training-load-roster-select-needing");
  h = html();
  assert.match(h, /tl-roster-sticky[\s\S]*3 selected · 3 not in this filter[\s\S]*Set state…/);
  assert.doesNotMatch(h, /Show them/);
  await act("training-load-roster-set-state");
  h = html();
  assert.equal((h.match(/class="tl-roster-sheet"/g) || []).length, 1);
  assert.match(h, /tl-roster-sheet[\s\S]*Participated · no device data[\s\S]*Did not participate/);
  await act("training-load-roster-bulk-kind", { kind: "did_not_participate" });
  h = html();
  assert.equal((h.match(/class="tl-roster-sheet"/g) || []).length, 1, "the reason list is in the same sheet");
  assert.match(h, /Apply to 2 athletes/);
  assert.ok(closeActivityRosterOverlay());
  assert.equal(roster.picker, null);
  await act("training-load-roster-clear-selection");
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  h = html();
  assert.match(h, /tl-roster-sticky[\s\S]*1 result is not confirmed[\s\S]*Check result/);
  assert.doesNotMatch(h, /Set state…/);
  phone = false;
});

test("a viewer without a decision basis sees states without any write control", async () => {
  await openRoster({ get: () => ({ status: 200, body: payload({ viewer: {} }) }) });
  const h = html();
  assert.doesNotMatch(h, /training-load-roster-set|training-load-roster-pick|Use measured values|tl-roster-sticky/);
  assert.match(h, /Two states/);
});

test("under a group filter the just-saved row stays where the thumb is, with its notice, until the filter changes", async () => {
  const saved = payload();
  saved.athletes[0] = { ...saved.athletes[0], state: "participated_no_values", stateLabel: "Participated · no device data", group: "done", decision: { id: "d-new", kind: "participated_no_values", label: "Participated · no device data", decidedBy: { name: "You" }, decidedAt: "2026-09-27T10:00:00Z" } };
  let reads = 0;
  const roster = await openRoster({
    get: () => { reads += 1; return { status: 200, body: reads === 1 ? payload() : saved }; },
    onWrite: () => ({ status: 200, body: {} }),
  });
  await act("training-load-roster-filter", { rosterFilter: "needs_state" });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  let h = html();
  assert.equal(roster.data.athletes[0].group, "done");
  assert.match(h, /data-roster-row="ath-1"[\s\S]*Saved: Ivan Marković/);
  assert.doesNotMatch(h, /Changed since you last looked/);
  assert.doesNotMatch(h, /data-roster-row="ath-4"/, "other Done rows stay filtered out");
  await act("training-load-roster-filter", { rosterFilter: "needs_state" });
  assert.doesNotMatch(html(), /data-roster-row="ath-1"/, "the filter change releases the row");
});

test("while one result is not confirmed, no write starts on any other row and the unconfirmed slot survives", async () => {
  let fail = true;
  const roster = await openRoster({ onWrite: () => (fail ? new TypeError("offline") : { status: 200, body: { decision: {} } }) });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.deepEqual(roster.unconfirmed.athleteIds, ["ath-1"]);
  fail = false;
  assert.match(html(), /data-action="training-load-roster-set" data-athlete-id="ath-7"[^>]*disabled/);
  await act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  await act("training-load-roster-change", { athleteId: "ath-4" });
  await act("training-load-roster-remove", { athleteId: "ath-4" });
  assert.equal(writes().length, 1, "no second command while a result is unconfirmed");
  assert.deepEqual(roster.unconfirmed.athleteIds, ["ath-1"], "the unconfirmed slot is not overwritten");
  await act("training-load-roster-check-result");
  assert.equal(writes().length, 2);
  assert.equal(roster.unconfirmed, null);
});

test("a write answer that arrives after the same session was closed and opened again is dropped", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const pending = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  confirmAnswer = true;
  await handleTrainingLoadAction({ dataset: { action: "training-load-calendar-clear-activity" } }, { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate() {} });
  resetActivityRoster("act-1");
  await loadActivityRoster("act-1", () => {});
  const getsBefore = gets().length;
  release();
  await pending;
  assert.equal(roster.notices.rows["ath-1"], undefined, "no stale Saved notice in the fresh view");
  assert.equal(Object.keys(roster.busy).length, 0);
  assert.equal(gets().length, getsBefore, "no extra reread from the old write");
});

test("a write already in flight when another result becomes unconfirmed can never exist: writes are serialized, and the slot survives a Check result that is itself unconfirmed", async () => {
  const deferred = [];
  const roster = await openRoster({ onWrite: () => new Promise((resolve) => deferred.push(resolve)) });
  const a = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  const b = act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  await b;
  assert.equal(deferred.length, 1, "the second command is never sent while the first is in flight");
  deferred[0](new TypeError("offline"));
  await a;
  assert.deepEqual(roster.unconfirmed.athleteIds, ["ath-1"]);
  const key = roster.unconfirmed.requestKey;
  const c = act("training-load-roster-check-result");
  deferred[1](new TypeError("offline"));
  await c;
  assert.deepEqual(roster.unconfirmed.athleteIds, ["ath-1"]);
  assert.equal(roster.unconfirmed.requestKey, key);
  assert.equal(roster.unconfirmed.checks, 1);
});

test("re-opening the same session from Results while a write is in flight keeps the write and its answer", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const pending = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  confirmAnswer = false;
  await handleTrainingLoadAction({ dataset: { action: "training-load-results-view-activity-in-calendar", activityId: "act-1", date: "2026-09-18" } }, { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate() {} });
  assert.ok(roster.busy["ath-1"], "the same session keeps its roster state");
  release();
  await pending;
  assert.equal(roster.notices.rows["ath-1"].tone, "saved");
});

test("a bulk never runs while a row write is in flight, and a row write never runs while a bulk is", async () => {
  const deferred = [];
  const roster = await openRoster({ onWrite: () => new Promise((resolve) => deferred.push(resolve)) });
  await act("training-load-roster-select-needing");
  const single = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  assert.equal(roster.picker, null, "the bulk panel does not open during a write");
  assert.equal(deferred.length, 1);
  deferred[0]({ status: 200, body: {} });
  await single;
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  const bulk = act("training-load-roster-bulk-apply");
  await act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  assert.equal(deferred.length, 2, "no row write during the bulk");
  deferred[1]({ status: 200, body: { decisions: [] } });
  await bulk;
});

test("Cancel of an inline confirmation stays live while writes are locked", async () => {
  const roster = await openRoster({ onWrite: () => ({ status: 200, body: {} }) });
  await act("training-load-roster-change", { athleteId: "ath-4" });
  await act("training-load-roster-remove", { athleteId: "ath-4" });
  assert.ok(roster.confirm);
  roster.unconfirmed = { requestKey: "k", command: {}, ctx: {}, athleteIds: ["ath-1"], names: [], label: "", checks: 0, checking: false, code: "" };
  const h = html();
  assert.match(h, /training-load-roster-confirm-proceed" data-athlete-id="ath-4" disabled/);
  assert.match(h, /training-load-roster-confirm-cancel" >/);
  await act("training-load-roster-confirm-cancel");
  assert.equal(roster.confirm, null);
});

test("Try again is off while another write is in flight and keeps its notice", async () => {
  let calls = 0;
  let release;
  const roster = await openRoster({ onWrite: () => { calls += 1; if (calls === 1) return { status: 503, body: { error: "roster_busy" } }; if (calls === 2) return new Promise((r) => { release = () => r({ status: 200, body: {} }); }); return { status: 200, body: {} }; } });
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(roster.notices.rows["ath-1"].action.label, "Try again");
  const p = act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  assert.match(html(), /training-load-roster-try-again"\s+data-athlete-id="ath-1"[^>]*disabled/);
  await act("training-load-roster-try-again", { athleteId: "ath-1" });
  assert.equal(writes().length, 2);
  assert.ok(roster.retry);
  assert.ok(roster.notices.rows["ath-1"]);
  release();
  await p;
  await act("training-load-roster-try-again", { athleteId: "ath-1" });
  assert.equal(writes().length, 3);
});

test("a row write after a bulk conflict does not leave a dead Apply to the other N", async () => {
  let first = true;
  const roster = await openRoster({
    onWrite: () => { if (first) { first = false; return { status: 409, body: { error: "bulk_conflict", failed: [{ athleteId: "ath-2", error: "not_on_roster" }] } }; } return { status: 200, body: {} }; },
  });
  await act("training-load-roster-select-needing");
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  await act("training-load-roster-bulk-apply");
  assert.equal(roster.notices.top.action.action, "training-load-roster-bulk-retry");
  await act("training-load-roster-set", { athleteId: "ath-7", kind: "participated_no_values" });
  assert.ok(!roster.notices.top?.action, "the stale offer is gone");
  assert.equal(roster.retryBulk, null);
});

test("re-clicking the open session in the calendar keeps a write in flight", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  const p = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  confirmAnswer = false;
  await handleTrainingLoadAction({ dataset: { action: "training-load-calendar-select-activity", activityId: "act-1" } }, { renderTrainingLoad: render, openWeeklyPlanForAthleteOnDate() {} });
  assert.ok(roster.busy["ath-1"]);
  assert.equal(confirmQuestions.length, 0);
  release();
  await p;
  assert.equal(roster.notices.rows["ath-1"].tone, "saved");
});

test("a row write does not mark or close an open bulk picker", async () => {
  let release;
  const roster = await openRoster({ onWrite: () => new Promise((r) => { release = () => r({ status: 200, body: {} }); }) });
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-pick", athleteId: "ath-7" }, checked: true }, { render });
  await act("training-load-roster-bulk", { kind: "participated_no_values" });
  assert.equal(roster.picker?.scope, "bulk");
  const p = act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(roster.picker.sending, false);
  release();
  await p;
  assert.equal(roster.picker?.scope, "bulk", "the group picker stays open");
});
