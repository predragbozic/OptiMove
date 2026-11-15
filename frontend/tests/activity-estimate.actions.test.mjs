// 6b-C1: estimates on the Roster tab - the action only on a Participated · no device data row while the server says the save
// is on, the proposal, the three outcomes with the same request key on Check result, and the label beside every estimate.
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


const { estimateLabelText } = await import("../activity-estimate.js");

const PND = {
  athleteId: "ath-8", name: "Dino Perić", state: "participated_no_values", stateLabel: "Participated · no device data", group: "done", flags: [], values: [],
  decision: { id: "d-8", kind: "participated_no_values", label: "Participated · no device data", decidedBy: { name: "Mira Coach" }, decidedAt: "2026-09-18T12:00:00Z" },
};
const VARS = [
  { metricDefinitionId: "def-dist", key: "total_distance", label: "Total distance", shortLabel: "Distance", unit: "m", aggregation: "sum", estimable: true, reason: null },
  { metricDefinitionId: "def-time", key: "duration", label: "Duration", shortLabel: "Time", unit: "min", aggregation: "sum", estimable: true, reason: null },
];
function proposalBody({ minutes = 45, source = null } = {}) {
  return {
    activityId: "act-1", athleteId: "ath-8", athleteName: "Dino Perić", minutes: { default: 45, used: minutes }, variables: VARS,
    methods: {
      proportional: { available: false, reason: "too_few_sessions", values: [] },
      copy_athlete: source
        ? { available: true, reason: null, sourceAthleteId: source, sources: [{ athleteId: "ath-3", name: "Mira Lukić" }], values: [{ metricDefinitionId: "def-dist", value: 4100, reason: null, basis: { sourceAthleteId: source } }] }
        : { available: true, reason: "choose_source", sourceAthleteId: null, sources: [{ athleteId: "ath-3", name: "Mira Lukić" }], values: [] },
      team_average: { available: true, reason: null, values: [{ metricDefinitionId: "def-dist", value: 3500, reason: null, basis: { athletes: 4 } }, { metricDefinitionId: "def-time", value: 52.5, reason: null, basis: { athletes: 4 } }] },
      scale_recording: { available: false, reason: "scale_not_chosen", values: [] },
    },
  };
}
const withEstimates = (extra = []) => payload({ viewer: { basis: "team_coach", estimates: true }, athletes: [...athletes(), PND, ...extra] });
function server({ rosterBody = withEstimates(), proposal = (url) => ({ status: 200, body: proposalBody({ minutes: Number(new URL(url, "http://x").searchParams.get("minutes")) || 45, source: new URL(url, "http://x").searchParams.get("sourceAthleteId") }) }), onWrite } = {}) {
  return { get: (url) => (url.includes("/estimates/proposal") ? proposal(url) : { status: 200, body: rosterBody }), onWrite };
}
const posts = () => requests.filter((r) => r.method === "POST");
const proposalGets = () => requests.filter((r) => r.method === "GET" && r.url.includes("/estimates/proposal"));

test("the action is offered only on a Participated · no device data row, and only while the server says the save is on", async () => {
  await openRoster(server({ rosterBody: payload({ athletes: [...athletes(), PND] }) }));
  assert.ok(!/training-load-roster-estimate-open/.test(html()), "flag off: no action");
  await openRoster(server());
  const page = html();
  const buttons = [...page.matchAll(/data-action="training-load-roster-estimate-open" data-athlete-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ["ath-8"], "only the Participated · no device data row (never Unknown, Measured or an absence)");
  assert.match(page, /Estimate values…/);
});

test("open: one proposal read; the methods with their numbers, an unavailable one disabled with its reason, the first available chosen", async () => {
  const roster = await openRoster(server());
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  assert.equal(proposalGets().length, 1);
  assert.equal(proposalGets()[0].url, "/api/training-activity/act-1/estimates/proposal?athleteId=ath-8");
  assert.equal(roster.estimate.method, "team_average");
  const page = html();
  assert.match(page, /Estimate values for Dino Perić/);
  assert.match(page, /Distance 3,500 m · Time 52.5 min/);
  assert.match(page, /id="tl-estimate-proportional"[^>]*disabled/);
  assert.match(page, /Fewer than 3 of this athlete(?:'|&#039;)s sessions in the last 90 days/);
  assert.match(page, /No scale was chosen for this athlete before the import/);
  assert.match(page, /An estimate is always labelled and is never counted as measured/);
});

test("save: one POST with a fresh request key and only the method's fields; Saved, the panel closes and the roster is read again", async () => {
  const roster = await openRoster(server({ onWrite: () => ({ status: 201, body: { method: "team_average", estimates: [] } }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-save");
  const [w] = posts();
  assert.equal(w.url, "/api/training-activity/act-1/estimates");
  assert.deepEqual(Object.keys(w.body).sort(), ["athleteId", "method", "requestKey"]);
  assert.equal(w.body.method, "team_average");
  assert.match(w.body.requestKey, UUID);
  assert.equal(roster.estimate, null);
  assert.match(roster.notices.rows["ath-8"].text, /Estimate saved for Dino Perić/);
  assert.ok(requests.some((r) => r.method === "GET" && r.url.endsWith("/roster")), "the roster is read again");
});

test("copy from an athlete: choosing the source reads the numbers again; the save carries sourceAthleteId and no minutes", async () => {
  await openRoster(server({ onWrite: () => ({ status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-source" }, value: "ath-3" }, { render });
  assert.equal(proposalGets().at(-1).url, "/api/training-activity/act-1/estimates/proposal?athleteId=ath-8&sourceAthleteId=ath-3");
  assert.match(html(), /Distance 4,100 m/);
  await act("training-load-roster-estimate-save");
  const [w] = posts();
  assert.equal(w.body.method, "copy_athlete");
  assert.equal(w.body.sourceAthleteId, "ath-3");
  assert.ok(!("minutes" in w.body));
});

test("a note is sent trimmed; a refusal (409 or 503 try_again) says nothing was saved and frees the key; the next save takes a new one", async () => {
  let n = 0;
  const roster = await openRoster(server({ onWrite: () => (++n === 1 ? { status: 409, body: { error: "measured_exists" } } : n === 2 ? { status: 409, body: { error: "try_again" } } : { status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-note" }, value: "  left at half time  " }, { render });
  await act("training-load-roster-estimate-save");
  assert.match(html(), /A measured value arrived meanwhile/);
  assert.equal(roster.estimate.requestKey, null, "the key is free again");
  assert.equal(roster.estimate.unconfirmed, null);
  await act("training-load-roster-estimate-save");
  assert.match(html(), /The server was busy and saved nothing/);
  assert.equal(roster.estimate.unconfirmed, null, "a first save refused with try_again wrote nothing");
  await act("training-load-roster-estimate-save");
  const keys = posts().map((p) => p.body.requestKey);
  assert.equal(new Set(keys).size, 3, "a new key per attempt after a refusal");
  assert.equal(posts()[0].body.note, "left at half time");
});

test("a lost answer is Result not confirmed: the leave check asks, Escape does not close it, Check result sends the same command and key once", async () => {
  let n = 0;
  const roster = await openRoster(server({ onWrite: () => (++n === 1 ? new TypeError("network") : { status: 200, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-save");
  assert.ok(roster.estimate.unconfirmed);
  assert.match(html(), /Result not confirmed/);
  assert.match(html(), /training-load-roster-estimate-check/);
  confirmAnswer = false;
  assert.equal(rosterMayBeLeft(), false);
  assert.match(confirmQuestions.at(-1), /An estimate is not confirmed yet/);
  assert.equal(rosterUnloadShouldWarn(), true);
  assert.equal(closeActivityRosterOverlay(), false, "Escape keeps an unconfirmed estimate");
  await act("training-load-roster-estimate-cancel");
  assert.ok(roster.estimate, "Cancel cannot drop an unconfirmed result");
  await act("training-load-roster-estimate-save");
  assert.equal(posts().length, 1, "no new save while the result is not confirmed");
  await act("training-load-roster-estimate-check");
  assert.equal(posts().length, 2);
  assert.deepEqual(posts()[1].body, posts()[0].body, "the same command, the same key");
  assert.equal(roster.estimate, null);
});

test("labels: an estimated value shows est. and its label (cell title, Details); a copy without a source name says another athlete; a measured value has none", async () => {
  const estimated = (method, extra) => ({ metricKey: "total_distance", shortLabel: "Distance", value: 3500, unit: "m", entryMethod: "estimate", estimate: { method, estimatedBy: "Mira Coach", estimatedAt: "2026-09-18T12:30:00Z", ...extra } });
  const rosterBody = withEstimates([
    { ...PND, athleteId: "ath-9", name: "Eva Jurić", values: [estimated("team_average", { athleteCount: 4 })] },
    { ...PND, athleteId: "ath-10", name: "Nik Kos", values: [estimated("copy_athlete", {})] },
  ]);
  await openRoster(server({ rosterBody }));
  const page = html();
  assert.match(page, /tl-roster-cell is-estimate"[^>]*title="Estimate · team average \(4 athletes\) · Mira Coach, 18\.09\.2026"/);
  assert.match(page, /<span class="tl-roster-cell is-estimate"[^>]*>[^<]*<small class="tl-roster-est">est\.<\/small><\/span>/, "the cell itself is marked");
  assert.match(page, /Estimate · copied from another athlete · Mira Coach/);
  assert.match(page, /Change the estimate…/, "a row that has an estimate offers to change it");
  const measuredRow = page.slice(page.indexOf('data-roster-row="ath-3"'), page.indexOf('data-roster-row="ath-3"') + 1500);
  assert.ok(!/est\./.test(measuredRow.split("tl-roster-row-more")[0]), "a measured value carries no estimate mark");
});

// The UX review of 6b-C1 (MEDIUMs): Save only for what the coach can see and has chosen.
function propProposal(url, { requiredWhenNoMinutes = false } = {}) {
  const q = new URL(url, "http://x").searchParams;
  const minutes = q.get("minutes") === null ? null : Number(q.get("minutes"));
  const body = proposalBody({ minutes: minutes ?? 45 });
  body.minutes = { default: requiredWhenNoMinutes ? null : 45, used: minutes ?? (requiredWhenNoMinutes ? null : 45) };
  body.methods.proportional = minutes === null && requiredWhenNoMinutes
    ? { available: false, reason: "minutes_required", values: [] }
    : { available: true, reason: null, values: [{ metricDefinitionId: "def-dist", value: 80 * (minutes ?? 45), reason: null, basis: { minutes: minutes ?? 45, ratePerMinute: 80, sessions: 3 } }] };
  return { status: 200, body };
}
const saveButton = () => (html().match(/<button[^>]*data-action="training-load-roster-estimate-save"[^>]*>/) || [""])[0];

test("UX M1: Copy with no athlete chosen offers no Save and says to choose one; a click sends nothing", async () => {
  const roster = await openRoster(server({ onWrite: () => ({ status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-method", { method: "copy_athlete" });
  assert.equal(roster.estimate.method, "copy_athlete");
  assert.match(saveButton(), /disabled/);
  assert.match(html(), /Choose an athlete to copy from\./);
  await act("training-load-roster-estimate-save");
  assert.equal(posts().length, 0, "nothing is sent without a source");
});

test("UX M2: with the session's duration unknown, Own average is still choosable: the minutes, Update, then Save with those minutes", async () => {
  const roster = await openRoster(server({ proposal: (url) => propProposal(url, { requiredWhenNoMinutes: true }), onWrite: () => ({ status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  assert.doesNotMatch(html(), /id="tl-estimate-proportional"[^>]*disabled/, "the method can be chosen");
  assert.match(html(), /Enter the minutes the athlete trained, then Update\./);
  await act("training-load-roster-estimate-method", { method: "proportional" });
  assert.match(html(), /id="tl-estimate-minutes"/);
  assert.match(saveButton(), /disabled/);
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-minutes" }, value: "40" }, { render });
  await act("training-load-roster-estimate-update");
  assert.match(proposalGets().at(-1).url, /minutes=40/);
  assert.equal(roster.estimate.proposal.methods.proportional.available, true);
  assert.doesNotMatch(saveButton(), /disabled/);
  await act("training-load-roster-estimate-save");
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.minutes, 40);
});

test("UX M3: minutes typed without Update are never saved: the panel asks for Update, and Save then carries exactly the minutes shown", async () => {
  const roster = await openRoster(server({ proposal: (url) => propProposal(url), onWrite: () => ({ status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-method", { method: "proportional" });
  assert.match(html(), /Distance 3,600 m/, "the numbers for 45 min");
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-minutes" }, value: "30" }, { render });
  await act("training-load-roster-estimate-save");
  assert.equal(posts().length, 0, "not saved with numbers the coach has not seen");
  assert.match(html(), /Press Update to see the values for these minutes\./);
  assert.match(saveButton(), /disabled/);
  await act("training-load-roster-estimate-update");
  assert.match(html(), /Distance 2,400 m/, "the numbers for 30 min");
  await act("training-load-roster-estimate-save");
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].body.minutes, 30);
  assert.equal(roster.estimate, null);
});

// The code review of 6b-C1.
test("HIGH 1: a Check result refused before the server looks the key up (409 try_again, 403) stays not confirmed with the same key; a later Check result settles it", async () => {
  let n = 0;
  const roster = await openRoster(server({ onWrite: () => (++n === 1 ? new TypeError("network") : n === 2 ? { status: 409, body: { error: "try_again" } } : n === 3 ? { status: 403, body: { error: "not_a_team_coach" } } : { status: 200, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-save");
  const key = posts()[0].body.requestKey;
  await act("training-load-roster-estimate-check");
  assert.ok(roster.estimate.unconfirmed, "try_again on Check result: still not confirmed");
  assert.doesNotMatch(html(), /saved nothing/);
  assert.match(html(), /still not confirmed/);
  await act("training-load-roster-estimate-check");
  assert.ok(roster.estimate.unconfirmed, "403 on Check result: still not confirmed");
  await act("training-load-roster-estimate-check");
  assert.equal(roster.estimate, null, "the replay settles it");
  assert.deepEqual(posts().map((p) => p.body.requestKey), [key, key, key, key], "always the same key");
});

test("HIGH 2: the click that opens the Copy from list changes nothing, so it reads nothing and does not repaint; a real change reads once", async () => {
  await openRoster(server());
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-method", { method: "copy_athlete" });
  const before = proposalGets().length;
  renders = 0;
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-source" }, value: "" }, { render });
  assert.equal(proposalGets().length, before);
  assert.equal(renders, 0, "no repaint while the native list opens");
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-source" }, value: "ath-3" }, { render });
  assert.equal(proposalGets().length, before + 1);
  renders = 0;
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-source" }, value: "ath-3" }, { render });
  assert.equal(proposalGets().length, before + 1, "the same athlete again reads nothing");
  assert.equal(renders, 0);
});

test("MEDIUM: one command at a time - an unconfirmed estimate locks the roster's own writes, and a roster write in flight or not confirmed locks the estimate", async () => {
  let n = 0;
  const roster = await openRoster(server({ onWrite: () => (++n === 1 ? new TypeError("network") : { status: 200, body: { decision: { id: "d-x" }, athlete: {}, completion: {} } }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-save");
  assert.ok(roster.estimate.unconfirmed);
  assert.match(html(), /data-action="training-load-roster-change" data-athlete-id="ath-8"[^>]*disabled/, "Change is locked");
  await act("training-load-roster-set", { athleteId: "ath-1", kind: "participated_no_values" });
  assert.equal(writes().length, 1, "no roster write while the estimate is not confirmed");
  // The other way: a roster result not confirmed keeps the estimate closed.
  roster.estimate = null;
  roster.unconfirmed = { requestKey: "k", command: {}, ctx: { athleteIds: ["ath-1"] }, athleteIds: ["ath-1"], names: ["Ivan"], label: "x", checks: 0, checking: false, code: "" };
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  assert.equal(roster.estimate, null, "no estimate while a roster result is not confirmed");
});

test("estimateLabelText: each method in the coach's words, never an id", () => {
  const base = { estimatedBy: "Ana Coach", estimatedAt: "2026-11-11T09:00:00Z" };
  assert.equal(estimateLabelText({ ...base, method: "proportional", minutes: 75, sessionCount: 5 }), "Estimate · own average × 75 min (5 sessions) · Ana Coach, 11.11.2026");
  assert.equal(estimateLabelText({ ...base, method: "team_average", athleteCount: 14 }), "Estimate · team average (14 athletes) · Ana Coach, 11.11.2026");
  assert.equal(estimateLabelText({ ...base, method: "copy_athlete", sourceAthleteName: "Bea Example" }), "Estimate · copied from Bea Example · Ana Coach, 11.11.2026");
  assert.equal(estimateLabelText({ ...base, method: "copy_athlete" }), "Estimate · copied from another athlete · Ana Coach, 11.11.2026");
  assert.equal(estimateLabelText({ ...base, method: "scale_recording", recordedMinutes: 20, targetMinutes: 40 }), "Estimate · recorded 20 of 40 min, scaled · Ana Coach, 11.11.2026");
  assert.equal(estimateLabelText(null), "Estimate");
});

// The narrow re-reviews of 6b-C1 (LOW).
test("LOW: minutes the server rounds (40.123 read as 40.12) do not trap the panel in Press Update", async () => {
  const rounding = (url) => {
    const answer = propProposal(url);
    const used = answer.body.minutes.used;
    answer.body.minutes.used = Math.round(used * 100) / 100;
    return answer;
  };
  await openRoster(server({ proposal: rounding, onWrite: () => ({ status: 201, body: {} }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-method", { method: "proportional" });
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-estimate-minutes" }, value: "40.123" }, { render });
  await act("training-load-roster-estimate-update");
  assert.doesNotMatch(html(), /Press Update to see the values/);
  assert.doesNotMatch(saveButton(), /disabled/);
});

test("LOW: a Check result answered 403 or 404 says asking again cannot help, never 'try again in a moment'", async () => {
  let n = 0;
  await openRoster(server({ onWrite: () => (++n === 1 ? new TypeError("network") : { status: 404, body: { error: "not_found" } }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  await act("training-load-roster-estimate-save");
  await act("training-load-roster-estimate-check");
  assert.match(html(), /You can&#039;t check this here any more|You can't check this here any more/);
  assert.doesNotMatch(html(), /could not answer yet/);
});

test("LOW: a refused first save reads the roster again and keeps the panel with the refusal", async () => {
  await openRoster(server({ onWrite: () => ({ status: 409, body: { error: "measured_exists" } }) }));
  await act("training-load-roster-estimate-open", { athleteId: "ath-8" });
  const rosterReads = () => requests.filter((q) => q.method === "GET" && /\/roster(\?|$)/.test(q.url)).length;
  const before = rosterReads();
  await act("training-load-roster-estimate-save");
  assert.equal(rosterReads(), before + 1, "one roster read after the refusal");
  assert.match(html(), /tl-estimate-error/);
});
