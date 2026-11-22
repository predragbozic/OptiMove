// ST-5 (docs/ai/session-type-plan.md sections 3, 5 and 17): the session's type and an athlete's own type on the Roster
// tab, the mark on an estimate saved under another type, and the estimate panel's "Compares with" as a set. Driven
// through the roster's own action handler with a fake fetch (the harness of the 5a3b suite).
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { emptyTrainingLoadState, state } = await import("../state.js");
const { renderActivityRosterHtml } = await import("../activity-roster-view.js");
const { handleActivityRosterAction, loadRosterForOpenActivity, rosterMayBeLeft } = await import("../activity-roster-actions.js");
const { resetActivityRoster } = await import("../activity-roster-data.js");
const { estimateLabelText } = await import("../activity-estimate.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = [
  { key: "training_session", label: "Full training", active: true },
  { key: "match", label: "Game", active: true },
  { key: "rtp_session", label: "RTP", active: true },
  { key: "testing_session", label: "Testing session", active: false },
];

// The server's world: the session's type and each athlete's exception; the roster answer is built from it on every read.
let world;
function payload() {
  const st = (id) => {
    const exception = world.exceptions[id] ?? null;
    return { effectiveKey: exception ?? world.sessionType, exception: exception ? { activityTypeKey: exception, reason: null, setBy: "Coach A", setAt: "2026-09-19T10:00:00Z" } : null, endedException: world.ended[id] ?? null };
  };
  return {
    activity: { id: "act-1", name: "Full training", activityTypeKey: world.sessionType, occurredLocalDate: "2026-09-18", startedAt: "2026-09-18T15:00:00Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: "act-1",
    viewer: world.viewer,
    completion: { status: "not_complete", revision: 0 },
    reasons: [],
    counts: { total: 3, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 },
    athletes: [
      { athleteId: "ath-1", name: "Ana Kovač", state: "measured", stateLabel: "Measured", group: "done", flags: [], decision: null, values: [{ metricKey: "duration", shortLabel: "Time", value: 60, unit: "min", entryMethod: "api_import" }], sessionType: st("ath-1") },
      { athleteId: "ath-2", name: "Bea Lukić", state: "measured", stateLabel: "Measured", group: "done", flags: [], decision: null, values: [{ metricKey: "duration", shortLabel: "Time", value: 50, unit: "min", entryMethod: "api_import" }], sessionType: st("ath-2") },
      { athleteId: "ath-3", name: "Cil Ilić", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: [], decision: null, values: [], sessionType: st("ath-3") },
    ],
    recordedOutsideRoster: [],
  };
}

let requests;
let onWrite;
let typesAnswer;
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ method, url, body });
  let result;
  if (method === "GET" && url === "/api/training-activity/session-types") result = typesAnswer();
  else if (method === "GET") result = { status: 200, body: payload() };
  else result = await onWrite(method, url, body);
  if (result instanceof Error) throw result;
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

// The real routes' rules, as far as the screen depends on them.
function realWrite(method, url, body) {
  const session = url.match(/^\/api\/training-activity\/act-1\/type$/);
  const athlete = url.match(/^\/api\/training-activity\/act-1\/roster\/([^/]+)\/type$/);
  const offered = (key) => TYPES.some((t) => t.key === key && t.active);
  if (session && method === "POST") {
    if (body.activityTypeKey === world.sessionType) return { status: 200, body: { changed: false, activityTypeKey: world.sessionType, endedExceptionAthleteIds: [] } };
    if (!offered(body.activityTypeKey)) return { status: 409, body: { error: "session_type_not_offered", message: "x" } };
    const previous = world.sessionType;
    world.sessionType = body.activityTypeKey;
    const ended = Object.keys(world.exceptions).filter((id) => world.exceptions[id] === world.sessionType);
    for (const id of ended) delete world.exceptions[id];
    return { status: 200, body: { changed: true, activityTypeKey: world.sessionType, previousActivityTypeKey: previous, endedExceptionAthleteIds: ended } };
  }
  if (athlete && method === "PUT") {
    const id = athlete[1];
    if (id === "ath-3") return { status: 409, body: { error: "athlete_has_no_record", message: "x" } };
    const key = body.activityTypeKey;
    if (key === world.sessionType) return { status: 409, body: { error: "same_as_session", message: "x" } };
    if (key !== null && !offered(key)) return { status: 409, body: { error: "session_type_not_offered", message: "x" } };
    const previous = world.exceptions[id] ?? null;
    if (previous === key) return { status: 200, body: { changed: false } };
    if (key === null) delete world.exceptions[id]; else world.exceptions[id] = key;
    return { status: 200, body: { changed: true, exceptionTypeKey: key, previousExceptionTypeKey: previous } };
  }
  return { status: 404, body: { error: "notFound" } };
}

let renders = 0;
const render = () => { renders += 1; };
async function openRoster({ viewer = { basis: "team_coach" }, sessionType = "training_session", exceptions = {}, ended = {}, write = realWrite } = {}) {
  world = { sessionType, exceptions: { ...exceptions }, ended, viewer };
  onWrite = write;
  typesAnswer = () => ({ status: 200, body: { types: TYPES, canAdd: null } });
  requests = [];
  state.trainingLoad = emptyTrainingLoadState();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "team-1" } };
  state.activeTab = "training-load";
  state.trainingLoad.calendar.selectedActivityId = "act-1";
  resetActivityRoster("act-1");
  await loadRosterForOpenActivity("act-1", render);
  await new Promise((resolve) => setTimeout(resolve, 0));
  requests = [];
  return state.trainingLoad.calendar.roster;
}
const act = (action, extra = {}, value) => handleActivityRosterAction({ dataset: { action, ...extra }, value }, { render });
const writes = () => requests.filter((r) => r.method !== "GET");
const html = () => renderActivityRosterHtml(state.trainingLoad.calendar.roster);
const selectOf = (page, marker) => page.match(new RegExp(`<select data-action="${marker}"[^>]*>([\\s\\S]*?)</select>`));
const options = (page, marker) => [...(selectOf(page, marker)?.[1] || "").matchAll(/<option value="([^"]*)"( selected)?\s*>([^<]*)</g)].map((m) => [m[1], m[3], Boolean(m[2])]);

test("1. the header shows the session's type in a chooser of the active types; a change is saved at once, the roster is read again, and Undo sets the previous type back", async () => {
  const roster = await openRoster();
  assert.deepEqual(options(html(), "training-load-roster-session-type"), [["training_session", "Full training", true], ["match", "Game", false], ["rtp_session", "RTP", false]]);
  await act("training-load-roster-session-type", {}, "match");
  const [w] = writes();
  assert.deepEqual([w.method, w.url, w.body.activityTypeKey], ["POST", "/api/training-activity/act-1/type", "match"]);
  assert.match(w.body.requestKey, UUID);
  assert.equal(requests.filter((r) => r.method === "GET" && r.url.endsWith("/roster")).length, 1, "one reread after the save");
  let page = html();
  assert.match(page, /Session type saved: Game\./);
  assert.deepEqual(options(page, "training-load-roster-session-type").find((o) => o[2]), ["match", "Game", true]);
  assert.match(page, /data-action="training-load-roster-type-undo"/);
  await act("training-load-roster-type-undo");
  assert.deepEqual(writes().map((x) => x.body.activityTypeKey), ["match", "training_session"]);
  assert.notEqual(writes()[0].body.requestKey, writes()[1].body.requestKey, "the undo is a new request");
  assert.equal(world.sessionType, "training_session");
  // The same type again sends nothing.
  await act("training-load-roster-session-type", {}, "training_session");
  assert.equal(writes().length, 2);
  assert.equal(roster.types.busy, null);
});

test("2. an athlete's own type: chosen in the row's Details, saved at once, said on the row; 'As the session' clears it; the session's own type is not offered", async () => {
  await openRoster();
  let page = html();
  assert.deepEqual(options(page, 'training-load-roster-athlete-type" data-athlete-id="ath-1').map((o) => o.slice(0, 2)), [["", "As the session (Full training)"], ["match", "Game"], ["rtp_session", "RTP"]]);
  await act("training-load-roster-athlete-type", { athleteId: "ath-1" }, "rtp_session");
  const [w] = writes();
  assert.deepEqual([w.method, w.url, w.body.activityTypeKey], ["PUT", "/api/training-activity/act-1/roster/ath-1/type", "rtp_session"]);
  page = html();
  assert.match(page, /Saved: Ana Kovač did RTP in this session\./);
  assert.match(page, /Did RTP in this session — Coach A, 19\.09\.2026\./, "the row says it without opening Details");
  await act("training-load-roster-athlete-type", { athleteId: "ath-1" }, "");
  assert.equal(writes()[1].body.activityTypeKey, null);
  assert.match(html(), /Saved: Ana Kovač has the session&#039;s type again\.|Saved: Ana Kovač has the session's type again\./);
  assert.equal(world.exceptions["ath-1"], undefined);
  // A forged pick of the session's own type sends nothing.
  await act("training-load-roster-athlete-type", { athleteId: "ath-1" }, "training_session");
  assert.equal(writes().length, 2);
});

test("3. refusals say what happened and that nothing was saved: an athlete without a record, a type no longer offered", async () => {
  await openRoster();
  await act("training-load-roster-athlete-type", { athleteId: "ath-3" }, "rtp_session");
  assert.match(html(), /This athlete has no values in this session yet\. Use &quot;Estimate values…&quot; in the athlete&#039;s row first, then set the type\. Nothing was saved\./);
  await openRoster({ write: () => ({ status: 409, body: { error: "session_type_not_offered", message: "x" } }) });
  await act("training-load-roster-session-type", {}, "match");
  const page = html();
  assert.match(page, /That session type is no longer offered\. Choose another\. Nothing was saved\./);
  assert.doesNotMatch(page, /training-load-roster-type-undo/);
  assert.deepEqual(options(page, "training-load-roster-session-type").find((o) => o[2]), ["training_session", "Full training", true], "the chooser shows what is saved");
});

test("4. a lost answer is 'not confirmed': Check result repeats the same request with the same key; meanwhile every write control is off and leaving asks", async () => {
  let answer = () => new Error("network");
  const roster = await openRoster({ write: (...args) => { const r = answer(...args); return r; } });
  await act("training-load-roster-session-type", {}, "match");
  let page = html();
  assert.match(page, /We can&#039;t tell yet whether the session type was saved|We can't tell yet whether the session type was saved/);
  assert.ok(roster.types.unconfirmed);
  assert.match(selectOf(page, "training-load-roster-session-type")[0], /disabled/);
  assert.match(page, /data-action="training-load-roster-athlete-type" data-athlete-id="ath-1"[^>]*disabled/);
  await act("training-load-roster-athlete-type", { athleteId: "ath-1" }, "rtp_session");
  assert.equal(writes().length, 1, "no second command while the first is not confirmed");
  answer = realWrite;
  await act("training-load-roster-type-check");
  assert.equal(writes().length, 2);
  assert.deepEqual(writes()[1].body, writes()[0].body, "the same request, the same key");
  assert.equal(roster.types.unconfirmed, null);
  assert.match(html(), /Session type saved: Game\./);
  assert.equal(typeof rosterMayBeLeft, "function");
});

test("5. a session type change that removes an athlete's equal own type says so and offers no Undo (it would not bring the own type back)", async () => {
  await openRoster({ exceptions: { "ath-1": "match" } });
  await act("training-load-roster-session-type", {}, "match");
  const page = html();
  assert.match(page, /Session type saved: Game\. 1 athlete&#039;s own type was the same and was removed\.|Session type saved: Game\. 1 athlete's own type was the same and was removed\./);
  assert.doesNotMatch(page, /training-load-roster-type-undo/);
});

test("6. a viewer who does not decide reads the type as text; a type a merge or a move removed is said on the row; the estimate label carries the mark; an unread list still names the type", async () => {
  await openRoster({ viewer: {}, ended: { "ath-2": { activityTypeKey: "rtp_session", cause: "merge", endedAt: "2026-09-19T10:00:00Z" } } });
  let page = html();
  assert.equal(selectOf(page, "training-load-roster-session-type"), null);
  assert.match(page, /Session type<\/span> <strong>Full training<\/strong>/);
  assert.doesNotMatch(page, /training-load-roster-athlete-type/);
  assert.match(page, /The athlete&#039;s own type \(RTP\) was removed when two sessions were merged|The athlete's own type \(RTP\) was removed when two sessions were merged/);
  assert.equal(estimateLabelText({ method: "team_average", athleteCount: 3, estimatedBy: "Coach A", estimatedAt: "2026-09-19T10:00:00Z", calculatedWhenType: { key: "training_session", label: "Full training" } }),
    `Estimate · team average (3 athletes) · Coach A, 19.09.2026 · calculated when the athlete's type was Full training; use "Change the estimate…" to recalculate`);
  assert.doesNotMatch(estimateLabelText({ method: "team_average", athleteCount: 3 }), /calculated when/);
  await openRoster();
  typesAnswer = () => ({ status: 500, body: { error: "internal_error" } });
  state.trainingLoad.calendar.roster.types = null;
  await loadRosterForOpenActivity("act-1", render);
  await new Promise((resolve) => setTimeout(resolve, 0));
  page = html();
  assert.match(page, /The session types could not be read\./);
  assert.deepEqual(options(page, "training-load-roster-session-type"), [["training_session", "Training session", true]]);
});
