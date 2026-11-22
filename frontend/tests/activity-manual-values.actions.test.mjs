// ST-4: manual values on the Roster tab - "Enter values…" for an athlete without a device record, "Correct values…" for a
// measured one, only while the server offers them (viewer.manualValues); the form read, what a Save sends (an entry: every
// filled value; a correction: only what changed), the three outcomes with the same request key on Check result, the restore
// with its question, and every manual value marked as entered by hand (who and when, and the measured value it replaced).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
let confirmAnswer = true;
let confirmQuestions = [];
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

const { emptyTrainingLoadState, state } = await import("../state.js");
const { renderActivityRosterHtml } = await import("../activity-roster-view.js");
const { handleActivityRosterAction, rosterMayBeLeft } = await import("../activity-roster-actions.js");
const { loadActivityRoster, resetActivityRoster } = await import("../activity-roster-data.js");
const { valuesToSend, manualLineText } = await import("../activity-manual-values.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OCC = "11111111-0000-4000-8000-000000000001";
const COACH = { userId: "u-1", name: "Goran Babić", basis: "team_coach" };

function athletes() {
  return [
    { athleteId: "ath-1", name: "Ivan Marković", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: [], decision: null, values: [], manual: null },
    {
      athleteId: "ath-3", name: "Mira Lukić", state: "measured", stateLabel: "Measured", group: "done", flags: [], decision: null, manual: null,
      values: [{ metricKey: "total_distance", shortLabel: "Distance", value: 5000, unit: "m", entryMethod: "api_import" }],
    },
    {
      athleteId: "ath-4", name: "Ana Kovač", state: "manual_values", stateLabel: "Manual values", group: "done", flags: [], decision: null,
      manual: { kind: "entry", enteredBy: COACH, enteredAt: "2026-11-21T10:00:00Z", note: null },
      values: [{ metricKey: "total_distance", shortLabel: "Distance", value: 4200, unit: "m", entryMethod: "manual" }],
    },
    {
      athleteId: "ath-5", name: "Petar Kunić", state: "measured", stateLabel: "Measured", group: "done", flags: ["corrected"], decision: null,
      manual: { kind: "correction", enteredBy: COACH, enteredAt: "2026-11-21T10:00:00Z", note: "vest slipped" },
      values: [{ metricKey: "total_distance", shortLabel: "Distance", value: 6100, unit: "m", entryMethod: "manual", measuredValue: 5100 }],
    },
  ];
}

function payload({ manualValues = true } = {}) {
  return {
    activity: { id: "act-1", name: "Full training", occurredLocalDate: "2026-11-21", startedAt: "2026-11-21T15:00:00Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: "act-1",
    viewer: { basis: "team_coach", ...(manualValues ? { manualValues: true } : {}) },
    completion: { status: "not_complete", revision: 0 },
    reasons: [{ key: "illness", label: "Illness" }],
    counts: { total: 4, needsState: 1, needsReview: 0, recordedOutsideRoster: 0 },
    athletes: athletes(),
    recordedOutsideRoster: [],
  };
}

const VARS_ENTRY = [
  { metricDefinitionId: "def-dist", key: "total_distance", label: "Total distance", shortLabel: "Distance", unit: "m", editable: true, value: null, estimatedValue: 3900 },
  { metricDefinitionId: "def-time", key: "duration", label: "Duration", shortLabel: "Time", unit: "min", editable: true, value: null },
];
const VARS_CORR = [
  { metricDefinitionId: "def-dist", key: "total_distance", label: "Total distance", shortLabel: "Distance", unit: "m", editable: true, value: 5000, measuredValue: 5000 },
  { metricDefinitionId: "def-time", key: "duration", label: "Duration", shortLabel: "Time", unit: "min", editable: true, value: 60, measuredValue: 60 },
];
const formEntry = () => ({ activityId: "act-1", athleteId: "ath-1", athleteName: "Ivan Marković", mode: "entry", expectedOccasionId: null, manual: null, canRestore: false, variables: VARS_ENTRY });
const formCorr = () => ({ activityId: "act-1", athleteId: "ath-3", athleteName: "Mira Lukić", mode: "correction", expectedOccasionId: OCC, manual: null, canRestore: false, variables: VARS_CORR });

let requests = [];
function serve({ roster = () => payload(), form = () => ({ status: 200, body: formEntry() }), onWrite = () => ({ status: 201, body: {} }) } = {}) {
  requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ method, url, body });
    let result;
    if (method === "GET") result = url.includes("/manual-values?") ? await form(url) : { status: 200, body: roster() };
    else result = await onWrite(method, url, body, requests.length);
    if (result instanceof Error) throw result;
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

async function openRoster(options) {
  state.trainingLoad = emptyTrainingLoadState();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "team-1" } };
  state.deliberateNavigation = false;
  state.activeTab = "training-load";
  confirmAnswer = true;
  confirmQuestions = [];
  serve(options);
  state.trainingLoad.calendar.selectedActivityId = "act-1";
  resetActivityRoster("act-1");
  await loadActivityRoster("act-1", () => {});
  requests = [];
  return state.trainingLoad.calendar.roster;
}

const render = () => {};
const act = (action, extra = {}, value) => handleActivityRosterAction({ dataset: { action, ...extra }, ...(value !== undefined ? { value } : {}) }, { render });
const writes = () => requests.filter((r) => r.method !== "GET");
const html = () => renderActivityRosterHtml(state.trainingLoad.calendar.roster);
function rowHtml(athleteId) {
  const page = html();
  const start = page.indexOf(`data-roster-row="${athleteId}"`);
  const next = page.indexOf("data-roster-row=", start + 20);
  return page.slice(start, next < 0 ? undefined : next);
}

test("1. the offer: Enter values… on a row without a device record, Correct values… on a measured row, Change values… / Change the correction… once written; nothing while the server does not offer it", async () => {
  await openRoster();
  assert.match(rowHtml("ath-1"), /data-action="training-load-roster-manual-open"[^>]*>Enter values…</);
  assert.match(rowHtml("ath-3"), />Correct values…</);
  assert.match(rowHtml("ath-4"), />Change values…</);
  assert.match(rowHtml("ath-5"), />Change the correction…</);
  await openRoster({ roster: () => payload({ manualValues: false }) });
  assert.doesNotMatch(html(), /training-load-roster-manual-open/);
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.equal(requests.length, 0, "an action the screen did not offer sends nothing");
});

test("2. manual values are marked as entered by hand: the state, who and when, the note, and a corrected value with the measured one", async () => {
  await openRoster();
  const entered = rowHtml("ath-4");
  assert.match(entered, /✎<\/span> Manual values/);
  assert.match(entered, /Values entered by Goran Babić on 21\.11\.2026\./);
  assert.match(entered, /4[,.]?200[^<]*<small class="tl-roster-est">man\.<\/small>/);
  const corrected = rowHtml("ath-5");
  assert.match(corrected, /Corrected by Goran Babić on 21\.11\.2026\./);
  assert.match(corrected, /Note: vest slipped/);
  assert.match(corrected, /<small class="tl-roster-est">corr\.<\/small>/);
  assert.match(corrected, /title="Corrected by Goran Babić on 21\.11\.2026\. \(measured: 5[,.]?100\)"/);
  assert.equal(manualLineText({ kind: "restore", enteredBy: { name: "X" }, enteredAt: "2026-11-21T10:00:00Z" }), "Measured values restored by X on 21.11.2026.");
});

test("3. an entry: the form is read, the estimate shown beside it; Save sends every filled value with a new UUID key and no expected occasion; the roster is read again and the row says it is saved", async () => {
  let saved = null;
  await openRoster({ onWrite: (method, url, body) => { saved = { url, body }; return { status: 201, body: { kind: "entry" } }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.ok(requests.some((r) => r.method === "GET" && /\/api\/training-activity\/act-1\/manual-values\?athleteId=ath-1$/.test(r.url)));
  let row = rowHtml("ath-1");
  assert.match(row, /Enter values for Ivan Marković/);
  assert.match(row, /Estimate now: 3[,.]?900/);
  assert.match(row, /inputmode="decimal"/);
  // Nothing typed: Save says why, sends nothing.
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 0);
  assert.match(rowHtml("ath-1"), /Enter at least one value\./);
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4100,5");
  await act("training-load-roster-manual-note", {}, "  no vest  ");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 1);
  assert.match(saved.url, /\/api\/training-activity\/act-1\/manual-values$/);
  assert.match(saved.body.requestKey, UUID);
  assert.deepEqual(saved.body, { requestKey: saved.body.requestKey, athleteId: "ath-1", expectedOccasionId: null, values: [{ metricDefinitionId: "def-dist", value: 4100.5 }], note: "no vest" });
  assert.equal(state.trainingLoad.calendar.roster.manual, null, "the panel closes");
  row = rowHtml("ath-1");
  assert.match(row, /Values saved for Ivan Marković\. They are shown as entered by hand, never as measured by GPEXE\./);
  assert.ok(requests.filter((r) => r.method === "GET").length >= 2, "the roster was read again");
});

test("4. a correction sends only the changed values and the current occasion; unchanged values are refused locally; a number that is not one is named", async () => {
  let saved = null;
  await openRoster({ form: () => ({ status: 200, body: formCorr() }), onWrite: (m, url, body) => { saved = body; return { status: 201, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-3" });
  assert.match(rowHtml("ath-3"), /Correct values for Mira Lukić/);
  assert.match(rowHtml("ath-3"), /The measured values are kept\./);
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 0);
  assert.match(rowHtml("ath-3"), /Change a value first\./);
  await act("training-load-roster-manual-input", { metricId: "def-time" }, "abc");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 0);
  assert.match(rowHtml("ath-3"), /Time: enter a number\./);
  await act("training-load-roster-manual-input", { metricId: "def-time" }, "60");
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "5150");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 1);
  assert.equal(saved.expectedOccasionId, OCC);
  assert.deepEqual(saved.values, [{ metricDefinitionId: "def-dist", value: 5150 }], "only the changed value");
  assert.deepEqual(valuesToSend({ form: { mode: "correction", variables: VARS_CORR }, inputs: { "def-dist": "5000", "def-time": "60" } }).values, []);
});

test("5. a lost answer is not confirmed: the panel keeps the request, leaving asks, and Check result sends the SAME request (key included)", async () => {
  let n = 0;
  await openRoster({ onWrite: () => { n += 1; return n === 1 ? new TypeError("Failed to fetch") : { status: 200, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  assert.match(rowHtml("ath-1"), /Result not confirmed/);
  assert.match(rowHtml("ath-1"), /training-load-roster-manual-check/);
  confirmAnswer = false;
  assert.equal(rosterMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /Values you entered are not confirmed yet/);
  // Another write cannot start meanwhile.
  await act("training-load-roster-manual-cancel");
  assert.ok(state.trainingLoad.calendar.roster.manual, "not closable over an unconfirmed result");
  await act("training-load-roster-manual-check");
  assert.equal(writes().length, 2);
  assert.deepEqual(writes()[1].body, writes()[0].body, "the identical request");
  assert.equal(state.trainingLoad.calendar.roster.manual, null);
});

test("6. a refusal says nothing was saved in the coach's words, frees the key, and the next Save gets a new key", async () => {
  let n = 0;
  await openRoster({ onWrite: () => { n += 1; return n === 1 ? { status: 409, body: { error: "values_changed", message: "x" } } : { status: 201, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  assert.match(rowHtml("ath-1"), /This athlete(?:'|&#0?39;)s values changed since you opened them\. Nothing was saved\./);
  assert.doesNotMatch(rowHtml("ath-1"), /values_changed/, "no code on the screen");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 2);
  assert.notEqual(writes()[1].body.requestKey, writes()[0].body.requestKey);
});

test("7. restore: offered only after a correction; asked first; sends the restore with the current occasion", async () => {
  const form = () => ({ status: 200, body: { ...formCorr(), athleteId: "ath-5", canRestore: true, manual: { kind: "correction", enteredBy: COACH, enteredAt: "2026-11-21T10:00:00Z" } } });
  await openRoster({ form, onWrite: () => ({ status: 201, body: {} }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-5" });
  assert.match(rowHtml("ath-5"), /data-action="training-load-roster-manual-restore"[^>]*>Restore measured values</);
  confirmAnswer = false;
  await act("training-load-roster-manual-restore");
  assert.equal(writes().length, 0, "declined");
  assert.match(confirmQuestions.at(-1), /Use the measured values again for Petar Kunić\? Your corrected values are kept as history\./);
  confirmAnswer = true;
  await act("training-load-roster-manual-restore");
  assert.equal(writes().length, 1);
  assert.match(writes()[0].url, /\/manual-values\/restore$/);
  assert.deepEqual(Object.keys(writes()[0].body).sort(), ["athleteId", "expectedOccasionId", "requestKey"]);
  assert.match(rowHtml("ath-5"), /Measured values restored for Petar Kunić\./);
  // Not offered without a correction.
  await openRoster({ form: () => ({ status: 200, body: formCorr() }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-3" });
  assert.doesNotMatch(rowHtml("ath-3"), /manual-restore/);
});

test("8. one panel at a time: opening the manual values closes an open estimate; while a manual save runs no estimate opens", async () => {
  await openRoster();
  const r = state.trainingLoad.calendar.roster;
  r.estimate = { athleteId: "ath-1", sending: false, unconfirmed: null };
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.equal(r.estimate, null);
  r.manual.sending = true;
  await act("training-load-roster-estimate-open", { athleteId: "ath-1" });
  assert.equal(r.estimate, null);
  assert.match(html(), /training-load-roster-manual-open|Saving…/);
});
