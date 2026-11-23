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
const { valuesToSend, manualLineText, parseTypedNumber } = await import("../activity-manual-values.js");

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
    {
      athleteId: "ath-8", name: "Dino Perić", state: "participated_no_values", stateLabel: "Participated · no device data", group: "done", flags: [], values: [], manual: null,
      decision: { id: "d-8", kind: "participated_no_values", label: "Participated · no device data", decidedBy: { name: "Mira Coach" }, decidedAt: "2026-11-21T12:00:00Z" },
    },
  ];
}

function payload({ manualValues = true, estimates = false } = {}) {
  return {
    activity: { id: "act-1", name: "Full training", occurredLocalDate: "2026-11-21", startedAt: "2026-11-21T15:00:00Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: "act-1",
    viewer: { basis: "team_coach", ...(manualValues ? { manualValues: true } : {}), ...(estimates ? { estimates: true } : {}) },
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
  assert.match(entered, /4[,.]?200[^<]*<small class="tl-roster-est">manual<\/small>/);
  const corrected = rowHtml("ath-5");
  assert.match(corrected, /● <\/span>|●<\/span>/);
  assert.match(corrected, /Measured · corrected/, "a corrected record is never shown as the device's values alone");
  assert.match(corrected, /Values corrected by Goran Babić on 21\.11\.2026\./);
  assert.match(corrected, /Note: vest slipped/);
  assert.match(corrected, /<small class="tl-roster-est">corrected<\/small>/);
  assert.match(corrected, /title="Values corrected by Goran Babić on 21\.11\.2026\. \(measured: 5100\)"/);
  assert.equal(manualLineText({ kind: "restore", enteredBy: { name: "X" }, enteredAt: "2026-11-21T10:00:00Z" }), "Measured values restored by X on 21.11.2026.");
});

test("3. an entry: the form is read, the estimate shown beside it; Save sends every filled value with a new UUID key and no expected occasion; the roster is read again and the row says it is saved", async () => {
  let saved = null;
  await openRoster({ onWrite: (method, url, body) => { saved = { url, body }; return { status: 201, body: { kind: "entry" } }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.ok(requests.some((r) => r.method === "GET" && /\/api\/training-activity\/act-1\/manual-values\?athleteId=ath-1$/.test(r.url)));
  let row = rowHtml("ath-1");
  assert.match(row, /Enter values for Ivan Marković/);
  assert.match(row, /Estimate now: 3900/, "no thousands separator in the panel: a shown number can be typed back");
  assert.doesNotMatch(row, /3,900/);
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
  assert.match(row, /Values saved for Ivan Marković\. They are shown as entered by hand, never as measured\./);
  assert.ok(requests.filter((r) => r.method === "GET").length >= 2, "the roster was read again");
});

test("3b. numbers: '3,900' is refused locally (3900 or 3.9?), '0x10' and '1e3' are not numbers, '4100,5' and '-2.5' are; a note's line break is sent as a space; invalid_note reads as a sentence", async () => {
  assert.deepEqual(parseTypedNumber("4100,5"), { value: 4100.5 });
  assert.deepEqual(parseTypedNumber("-2.5"), { value: -2.5 });
  for (const bad of ["0x10", "1e3", "3.9.1", "", " ", "abc"]) assert.ok(parseTypedNumber(bad).problem, bad);
  assert.match(parseTypedNumber("3,900").problem, /3900[\s\S]*3\.9/);
  let n = 0;
  await openRoster({ onWrite: () => { n += 1; return n === 1 ? { status: 400, body: { error: "invalid_note", message: "x" } } : { status: 201, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "3,900");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 0, "an ambiguous number is never sent");
  assert.match(rowHtml("ath-1"), /Total distance: write it without a comma for thousands \(3900\), or with a point for a decimal \(3\.9\)\./);
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "3900");
  await act("training-load-roster-manual-note", {}, "no vest\nslipped");
  await act("training-load-roster-manual-save");
  assert.equal(writes()[0].body.note, "no vest slipped");
  assert.deepEqual(writes()[0].body.values, [{ metricDefinitionId: "def-dist", value: 3900 }]);
  assert.match(rowHtml("ath-1"), /Keep the note to one line of at most 500 characters\./);
  assert.doesNotMatch(rowHtml("ath-1"), /It could not be saved/);
});

test("3c. a saved value cannot be removed by emptying its field: refused locally with the field's name, nothing sent; an unchanged pre-filled value is not sent again", async () => {
  const form = () => ({ status: 200, body: { ...formEntry(), athleteId: "ath-4", expectedOccasionId: OCC, variables: [{ ...VARS_ENTRY[0], value: 4200 }, VARS_ENTRY[1]] } });
  await openRoster({ form, onWrite: () => ({ status: 201, body: {} }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-4" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "");
  await act("training-load-roster-manual-input", { metricId: "def-time" }, "60");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 0);
  assert.match(rowHtml("ath-4"), /Total distance: a saved value can(?:'|&#0?39;)t be removed here\. Type a value, or Cancel\./);
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4200");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 1);
  assert.deepEqual(writes()[0].body.values, [{ metricDefinitionId: "def-time", value: 60 }], "the unchanged distance is kept by the server, not resent");
  assert.equal(writes()[0].body.expectedOccasionId, OCC);
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
  assert.match(rowHtml("ath-3"), /Duration: enter a number\./, "the form names a variable by its full label");
  await act("training-load-roster-manual-input", { metricId: "def-time" }, "60");
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "5150");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 1);
  assert.equal(saved.expectedOccasionId, OCC);
  assert.deepEqual(saved.values, [{ metricDefinitionId: "def-dist", value: 5150 }], "only the changed value");
  assert.deepEqual(valuesToSend({ form: { mode: "correction", variables: VARS_CORR }, inputs: { "def-dist": "5000", "def-time": "60" } }).values, []);
  // An entry whose fields already hold saved values: nothing changed is "Change a value first.", not "Enter at least one".
  const savedEntry = { form: { mode: "entry", variables: [{ ...VARS_ENTRY[0], value: 3800 }, VARS_ENTRY[1]] }, inputs: { "def-dist": "3800", "def-time": "" } };
  assert.equal(valuesToSend(savedEntry).problem, "Change a value first.");
  assert.equal(valuesToSend({ form: { mode: "entry", variables: VARS_ENTRY }, inputs: { "def-dist": "", "def-time": "" } }).problem, "Enter at least one value.");
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

test("6. a stale refusal says nothing was saved, reads the form again at once (keeping what was typed), frees the key, and the next Save sends the new occasion with a new key", async () => {
  let n = 0;
  let forms = 0;
  const NEW = "22222222-0000-4000-8000-000000000002";
  await openRoster({
    // Meanwhile another coach saved 3800 m and 55 min.
    form: () => { forms += 1; return { status: 200, body: { ...formEntry(), expectedOccasionId: forms > 1 ? NEW : null, variables: forms > 1 ? [{ ...VARS_ENTRY[0], value: 3800 }, { ...VARS_ENTRY[1], value: 55 }] : VARS_ENTRY } }; },
    onWrite: () => { n += 1; return n === 1 ? { status: 409, body: { error: "values_changed", message: "x" } } : { status: 201, body: {} }; },
  });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  assert.match(rowHtml("ath-1"), /This athlete(?:'|&#0?39;)s values changed since you opened them\. Nothing was saved\. Fields you changed keep what you typed; the others now show the current values\./);
  assert.doesNotMatch(rowHtml("ath-1"), /values_changed/, "no code on the screen");
  assert.equal(forms, 2, "the form was read again");
  assert.match(rowHtml("ath-1"), /value="4000"/, "what was typed is kept");
  assert.match(rowHtml("ath-1"), /Now saved: 3800/, "the kept field names what is saved now");
  assert.match(rowHtml("ath-1"), /value="55"/, "an untouched field shows the current value");
  assert.equal((rowHtml("ath-1").match(/Now saved:/g) || []).length, 1, "only the kept field carries the hint");
  await act("training-load-roster-manual-save");
  assert.equal(writes().length, 2);
  assert.equal(writes()[1].body.expectedOccasionId, NEW);
  assert.deepEqual(writes()[1].body.values, [{ metricDefinitionId: "def-dist", value: 4000 }], "the current value of the untouched field is not sent");
  assert.notEqual(writes()[1].body.requestKey, writes()[0].body.requestKey);
});

test("7. restore: offered only after a correction; asked inline first (two buttons, never a modal); sends the restore with the current occasion", async () => {
  const form = () => ({ status: 200, body: { ...formCorr(), athleteId: "ath-5", canRestore: true, manual: { kind: "correction", enteredBy: COACH, enteredAt: "2026-11-21T10:00:00Z" } } });
  await openRoster({ form, onWrite: () => ({ status: 201, body: {} }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-5" });
  assert.match(rowHtml("ath-5"), /data-action="training-load-roster-manual-restore-ask"[^>]*>Restore measured values…</);
  // A restore without the question first sends nothing.
  await act("training-load-roster-manual-restore");
  assert.equal(writes().length, 0);
  await act("training-load-roster-manual-restore-ask");
  assert.match(rowHtml("ath-5"), /Use the measured values again for Petar Kunić\? Your corrected values stop counting\./);
  assert.match(rowHtml("ath-5"), />Keep my correction</);
  await act("training-load-roster-manual-restore-keep");
  assert.doesNotMatch(rowHtml("ath-5"), /Your corrected values stop counting/);
  assert.equal(writes().length, 0, "kept");
  assert.equal(confirmQuestions.length, 0, "no modal question");
  await act("training-load-roster-manual-restore-ask");
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

test("8. one panel at a time: opening the manual values closes an idle estimate; while a manual result is not confirmed no estimate opens (where it otherwise would) and no roster decision is sent", async () => {
  await openRoster({ roster: () => payload({ estimates: true }) });
  const r = state.trainingLoad.calendar.roster;
  // The estimate is offered on Dino's row and opens normally.
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  assert.equal(r.estimate?.athleteId, "ath-8", "the estimate opens when nothing else is busy");
  await act("training-load-roster-manual-open", { athleteId: "ath-8" });
  assert.equal(r.estimate, null, "an idle estimate closes");
  assert.equal(r.manual?.athleteId, "ath-8");
  r.manual.unconfirmed = { command: { method: "POST", path: "/x", body: {} }, checks: 0 };
  const before = requests.length;
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  assert.equal(r.estimate, null, "no estimate over an unconfirmed manual result");
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(requests.length, before, "no roster decision is sent meanwhile");
});

test("9. an unconfirmed manual result stays visible under every filter (its Check result is the only live control)", async () => {
  await openRoster({ onWrite: () => new TypeError("Failed to fetch") });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  assert.match(html(), /training-load-roster-manual-check/);
  await act("training-load-roster-filter", { rosterFilter: "done" });
  assert.match(html(), /training-load-roster-manual-check/, "still there under Done");
});

test("10. a stale answer after the roster was reset is dropped: no notice, no panel", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await openRoster({ onWrite: async () => { await gate; return { status: 201, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  const saving = act("training-load-roster-manual-save");
  await new Promise((r) => setTimeout(r, 0));
  resetActivityRoster("act-1");
  release();
  await saving;
  const r = state.trainingLoad.calendar.roster;
  assert.equal(r.manual, null);
  assert.equal(r.notices?.rows?.["ath-1"], undefined);
});

test("11. Check result refused as busy (409 try_again) or gone (404) stays NOT confirmed with the same key; a 503 try_again on the first save is a plain refusal; a second Check while one runs sends nothing", async () => {
  let n = 0;
  await openRoster({
    onWrite: () => {
      n += 1;
      if (n === 1) return new TypeError("Failed to fetch");
      if (n === 2) return { status: 409, body: { error: "try_again", message: "x" } };
      if (n === 3) return { status: 404, body: { error: "notFound" } };
      return { status: 200, body: {} };
    },
  });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  const key = writes()[0].body.requestKey;
  await act("training-load-roster-manual-check");
  assert.match(rowHtml("ath-1"), /still not confirmed/);
  await act("training-load-roster-manual-check");
  assert.match(rowHtml("ath-1"), /can(?:'|&#0?39;)t check this here any more/);
  const r = state.trainingLoad.calendar.roster;
  r.manual.sending = true;
  const before = writes().length;
  await act("training-load-roster-manual-check");
  assert.equal(writes().length, before, "no second Check while one runs");
  r.manual.sending = false;
  await act("training-load-roster-manual-check");
  assert.deepEqual(writes().map((w) => w.body.requestKey), [key, key, key, key]);
  assert.equal(r.manual, null, "settled");
  // A 503 try_again on the first send wrote nothing: refused, the key is freed.
  await openRoster({ onWrite: () => ({ status: 503, body: { error: "try_again", message: "busy" } }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-input", { metricId: "def-dist" }, "4000");
  await act("training-load-roster-manual-save");
  assert.match(rowHtml("ath-1"), /The server was busy and saved nothing\./);
  assert.equal(state.trainingLoad.calendar.roster.manual.unconfirmed, null);
});

test("14. Remove these values (ST-4 PR2): offered only for values entered on the roster (never for a correction, never before an entry); asked inline first; sends the removal with the current occasion and its own key; a nothing_to_remove refusal says so", async () => {
  const ENTRY = "33333333-0000-4000-8000-000000000003";
  const form = () => ({ status: 200, body: { ...formEntry(), expectedOccasionId: ENTRY, manual: { kind: "entry", enteredBy: COACH, enteredAt: "2026-11-21T10:00:00Z" }, variables: VARS_ENTRY.map((v) => ({ ...v, value: 3000 })) } });
  await openRoster({ form, onWrite: () => ({ status: 201, body: {} }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.match(rowHtml("ath-1"), /data-action="training-load-roster-manual-remove-ask"[^>]*>Remove these values…</);
  // Without the question first nothing is sent.
  await act("training-load-roster-manual-remove");
  assert.equal(writes().length, 0);
  await act("training-load-roster-manual-remove-ask");
  assert.match(rowHtml("ath-1"), /Remove the values entered for Ivan Marković\? They stay in the history, and Ivan Marković needs a state again\./);
  await act("training-load-roster-manual-remove-keep");
  assert.equal(writes().length, 0, "kept");
  assert.equal(confirmQuestions.length, 0, "no modal question");
  await act("training-load-roster-manual-remove-ask");
  await act("training-load-roster-manual-remove");
  assert.equal(writes().length, 1);
  assert.match(writes()[0].url, /\/manual-values\/remove$/);
  assert.deepEqual(Object.keys(writes()[0].body).sort(), ["athleteId", "expectedOccasionId", "requestKey"]);
  assert.equal(writes()[0].body.expectedOccasionId, ENTRY);
  assert.match(rowHtml("ath-1"), /Values removed for Ivan Marković\. They stay in the history\. Choose a state for Ivan Marković now\./);
  // A refusal names it.
  await openRoster({ form, onWrite: () => ({ status: 409, body: { error: "nothing_to_remove", message: "x" } }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-remove-ask");
  let gone = false;
  await openRoster({ form: () => (gone ? { status: 200, body: { ...formEntry(), expectedOccasionId: null, manual: null } } : form()), onWrite: () => { gone = true; return { status: 409, body: { error: "nothing_to_remove", message: "x" } }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-remove-ask");
  await act("training-load-roster-manual-remove");
  assert.match(rowHtml("ath-1"), /There are no entered values to remove\./);
  assert.doesNotMatch(rowHtml("ath-1"), /manual-remove-ask/, "the form is read again: nothing left to remove is not offered again");
  // A lost answer: Check result repeats the removal with the same key.
  let n = 0;
  await openRoster({ form, onWrite: () => { n += 1; return n === 1 ? new TypeError("Failed to fetch") : { status: 201, body: {} }; } });
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  await act("training-load-roster-manual-remove-ask");
  await act("training-load-roster-manual-remove");
  await act("training-load-roster-manual-check");
  assert.equal(writes().length, 2);
  assert.match(writes()[1].url, /\/manual-values\/remove$/);
  assert.equal(writes()[1].body.requestKey, writes()[0].body.requestKey, "the same key");
  // Not offered for a correction, nor before an entry exists.
  await openRoster({ form: () => ({ status: 200, body: formCorr() }) });
  await act("training-load-roster-manual-open", { athleteId: "ath-3" });
  assert.doesNotMatch(rowHtml("ath-3"), /manual-remove/);
  await openRoster();
  await act("training-load-roster-manual-open", { athleteId: "ath-1" });
  assert.doesNotMatch(rowHtml("ath-1"), /manual-remove/);
});
