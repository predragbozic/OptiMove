// "My training" (owner, 2026-11-16): the athlete's own recorded sessions and values, read-only. The entry shows only on
// the server's word; a session lists the whole session's values, then each drill in its order; an estimate says
// "Estimated", the date and the coach, never how it was estimated.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { state, emptyMyTrainingState } = await import("../state.js");
const view = await import("../my-training-view.js");
const data = await import("../my-training-data.js");
const actions = await import("../my-training-actions.js");

let calls;
function serve(handler) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = await handler(String(url));
    return { ok: r.status < 300, status: r.status, statusText: "", json: async () => r.body };
  };
}
const value = (id, key, n, extra = {}) => ({ factKind: "metric_value", detail: { metricDefinitionId: id, valueNumeric: n, valueBoolean: null, valueText: null, unitAtCapture: null, level: "session", componentId: null, drillOrdinal: null, drillKey: null, valueKey: key, ...extra } });
const drill = (id, key, n, drillKey, drillOrdinal, componentId = null) => value(id, key, n, { level: "drill", drillKey, drillOrdinal, componentId });

test("1. the entry: hidden until the server says yes; a failed read hides nothing and shows nothing; once yes it stays", async () => {
  state.myTraining = emptyMyTrainingState();
  assert.equal(view.renderMyTrainingHomeEntryHtml(), "", "not read yet");
  serve(() => ({ status: 200, body: { hasRecordedSessions: false } }));
  assert.equal(await data.loadMyTrainingAvailability(), false);
  assert.equal(view.renderMyTrainingHomeEntryHtml(), "");
  serve(() => ({ status: 500, body: { error: "internal_error" } }));
  assert.equal(await data.loadMyTrainingAvailability(), false, "a failed read keeps the last answer");
  serve(() => ({ status: 200, body: { hasRecordedSessions: true } }));
  assert.equal(await data.loadMyTrainingAvailability(), true);
  assert.match(view.renderMyTrainingHomeEntryHtml(), /data-target-tab="my-training"[\s\S]*My training/);
  serve(() => ({ status: 200, body: { hasRecordedSessions: false } }));
  assert.equal(await data.loadMyTrainingAvailability(), true, "once yes, it stays");
  serve(() => ({ status: 500, body: {} }));
  assert.equal(await data.loadMyTrainingAvailability(), true);
  data.resetMyTraining();
  assert.equal(state.myTraining.available, null, "a workspace switch forgets it");
});

test("2. Home names her last session once the list is read", () => {
  state.myTraining = emptyMyTrainingState();
  state.myTraining.available = true;
  assert.match(view.renderMyTrainingHomeEntryHtml(), /Your recorded sessions and values/);
  state.myTraining.list.rows = [{ activityId: "a1", name: "Team training", localDate: "2026-11-04", recordedBy: "device" }];
  assert.match(view.renderMyTrainingHomeEntryHtml(), /Last: Team training · Wed 04\.11\.2026/);
});

test("3. the list: the last year, newest first, a page at a time with the server's cursor; plain words for how it was recorded", async () => {
  state.myTraining = emptyMyTrainingState();
  serve((url) => (url.includes("cursor=")
    ? { status: 200, body: { rows: [{ activityId: "a3", name: "", localDate: "2026-10-01", recordedBy: null }], nextCursor: null } }
    : { status: 200, body: { rows: [{ activityId: "a1", name: "Team training", localDate: "2026-11-04", recordedBy: "device" }, { activityId: "a2", name: "Gym", localDate: "2026-11-02", recordedBy: "coach" }], nextCursor: { localDate: "2026-11-02", activityId: "a2", participantId: "p2" } } }));
  await data.loadMyTrainingList({}, () => {});
  const first = new URL(calls[0], "http://x");
  assert.equal(first.pathname, "/api/training-activity");
  assert.equal(first.searchParams.get("limit"), "30");
  assert.ok(first.searchParams.get("dateFrom") < first.searchParams.get("dateTo"));
  let html = view.renderMyTrainingHtml();
  assert.match(html, /Recorded by a device/);
  assert.match(html, /Entered by your coach/);
  assert.match(html, /data-action="my-training-more"/);
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-more" } }, { render: () => {} });
  assert.deepEqual(JSON.parse(new URL(calls[1], "http://x").searchParams.get("cursor")), { localDate: "2026-11-02", activityId: "a2", participantId: "p2" });
  html = view.renderMyTrainingHtml();
  assert.equal((html.match(/data-action="my-training-open"/g) || []).length, 3);
  assert.match(html, /Training session/, "a session without a name");
  assert.match(html, /No values recorded/);
  assert.doesNotMatch(html, /my-training-more/, "no more pages");
});

test("4. an empty year and a failed read say so in one sentence (the failed one with Try again)", async () => {
  state.myTraining = emptyMyTrainingState();
  serve(() => ({ status: 200, body: { rows: [], nextCursor: null } }));
  await data.loadMyTrainingList({}, () => {});
  assert.match(view.renderMyTrainingHtml(), /No recorded sessions in the last 12 months\./);
  state.myTraining = emptyMyTrainingState();
  serve(() => ({ status: 500, body: {} }));
  await data.loadMyTrainingList({}, () => {});
  assert.match(view.renderMyTrainingHtml(), /Your sessions could not be loaded\.[\s\S]*data-action="my-training-retry"/);
});

test("5. a session: the whole session first, then each drill in its order (two drills without a component are two), names from the session", () => {
  const facts = [
    drill("v1", "k3", 5, "dB", 2),
    drill("v1", "k2", 4, "dA", 1, "c1"),
    value("v2", "k1", 3000),
    drill("v2", "k4", 7, "dC", 3),
  ];
  const groups = view.drillGroups(facts.filter((f) => f.detail.level === "drill"), [{ id: "c1", name: "Small-sided game" }]);
  assert.deepEqual(groups.map((g) => g.title), ["Small-sided game", "Drill 2", "Drill 3"]);
  state.myTraining = emptyMyTrainingState();
  state.myTraining.list.rows = [{ activityId: "a1", name: "Team training", localDate: "2026-11-04" }];
  state.myTraining.openId = "a1";
  state.myTraining.detail = { activityId: "a1", loading: false, error: "", data: { myAttendance: "participated", recordedBy: "device", facts, components: [{ id: "c1", name: "Small-sided game" }], variableNamesById: { v1: { label: "Max speed", unit: "km/h" }, v2: { label: "Total distance", unit: "m" } } } };
  const html = view.renderMyTrainingHtml();
  const order = [...html.matchAll(/<h4>([^<]*)<\/h4>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["Whole session", "Small-sided game", "Drill 2", "Drill 3"]);
  assert.match(html, /3,000 m/);
  assert.match(html, /data-value-key="k4"/);
  assert.match(html, /data-action="my-training-back"/);
  // The whole session reads first; each drill folds under its name with its count (UX review).
  assert.equal((html.match(/<details class="panel my-training-values my-training-drill">/g) || []).length, 3);
  assert.doesNotMatch(html, /<details[^>]* open/, "drills start folded");
  assert.match(html, /<summary><h4>Small-sided game<\/h4><span class="muted">1 value<\/span><\/summary>/);
});

test("6 (owner, 2026-11-16): only measured values - an estimated value is never shown, whatever the server sends", () => {
  const estimated = value("v1", "k1", 40, { entryMethod: "estimate" });
  estimated.estimate = { method: "team_average", estimatedBy: "Coach Example", estimatedAt: "2026-11-05T09:00:00.000Z" };
  const labelled = value("v2", "k2", 9, {});
  labelled.estimate = { method: "own_average", estimatedBy: "Coach Example", estimatedAt: "2026-11-05T09:00:00.000Z" };
  const measured = value("v3", "k3", 3000, { unitAtCapture: "m" });
  state.myTraining = emptyMyTrainingState();
  state.myTraining.openId = "a1";
  state.myTraining.detail = { activityId: "a1", loading: false, error: "", data: { facts: [estimated, labelled, measured], components: [], variableNamesById: { v1: { label: "Duration" }, v2: { label: "Bursts" }, v3: { label: "Total distance" } } } };
  const html = view.renderMyTrainingHtml();
  assert.match(html, /Total distance[\s\S]*3,000 m/);
  assert.doesNotMatch(html, /Duration|Bursts|data-value-key="k1"|data-value-key="k2"/);
  assert.doesNotMatch(html, /estimat|Coach Example|team_average|own_average/i);
  state.myTraining.detail.data.facts = [estimated];
  assert.match(view.renderMyTrainingHtml(), /No values were recorded for you in this session\./, "only an estimate: nothing measured");
});

test("7. values in plain form: a count has no unit word; yes/no; attendance and her rating in one sentence each", () => {
  assert.equal(view.formatMyValue({ valueNumeric: 7 }, "count"), "7");
  assert.equal(view.formatMyValue({ valueNumeric: 21.6667 }, "km/h"), "21.67 km/h");
  assert.equal(view.formatMyValue({ valueNumeric: null, valueBoolean: true }, null), "Yes");
  state.myTraining = emptyMyTrainingState();
  state.myTraining.openId = "a1";
  state.myTraining.detail = { activityId: "a1", loading: false, error: "", data: { myAttendance: "participated_no_device_data", facts: [{ factKind: "rpe", detail: { rpe: 7, durationMinutes: 60, srpe: 420 } }], components: [], variableNamesById: {} } };
  const html = view.renderMyTrainingHtml();
  assert.match(html, /You took part; no device data was recorded for you\./);
  assert.match(html, /How hard it felt: 7 of 10 \(RPE\) · 60 min/);
  assert.doesNotMatch(html, /No values were recorded/);
});

test("8. opening a session reads it once and adds one Back step; Back (button or phone) returns to the list", async () => {
  state.activeTab = "my-training";
  state.myTraining = emptyMyTrainingState();
  serve(() => ({ status: 200, body: { facts: [], components: [], variableNamesById: {} } }));
  let pushes = 0;
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-open", activityId: "a1" } }, { render: () => {}, pushHistory: () => { pushes += 1; } });
  assert.deepEqual(calls, ["/api/training-activity/a1"]);
  assert.equal(pushes, 1);
  assert.equal(state.myTraining.openId, "a1");
  assert.equal(actions.handleMyTrainingBack(() => {}), true, "phone Back closes the session");
  assert.equal(state.myTraining.openId, "");
  assert.equal(actions.handleMyTrainingBack(() => {}), false, "then Back is the app's again");
  serve(() => ({ status: 404, body: { error: "Activity not found." } }));
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-open", activityId: "gone" } }, { render: () => {} });
  assert.match(view.renderMyTrainingHtml(), /This session is no longer available\./);
});

test("9 (code review): a value keeps the unit it was captured in, even after the variable's unit changed", () => {
  state.myTraining = emptyMyTrainingState();
  state.myTraining.openId = "a1";
  state.myTraining.detail = { activityId: "a1", loading: false, error: "", data: { facts: [value("v1", "k1", 3000, { unitAtCapture: "m" })], components: [], variableNamesById: { v1: { label: "Total distance", unit: "km" } } } };
  const html = view.renderMyTrainingHtml();
  assert.match(html, /3,000 m/);
  assert.doesNotMatch(html, /3,000 km/);
  state.myTraining.detail.data.facts = [value("v1", "k1", 5)];
  assert.match(view.renderMyTrainingHtml(), /5 km/, "without a captured unit: the variable's");
});

test("10 (code review): an availability answer that lands after a workspace switch is not kept", async () => {
  state.myTraining = emptyMyTrainingState();
  let release;
  globalThis.fetch = () => new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, statusText: "", json: async () => ({ hasRecordedSessions: true }) }); });
  const pending = data.loadMyTrainingAvailability();
  await new Promise((r) => setTimeout(r, 0));
  data.resetMyTraining();
  release();
  await pending;
  assert.equal(state.myTraining.available, null);
});

test("11: the in-app Back closes the session at once; a double tap ends on her list; phone Back closes an open session", async () => {
  state.activeTab = "my-training";
  state.myTraining = emptyMyTrainingState();
  serve(() => ({ status: 200, body: { facts: [], components: [], variableNamesById: {} } }));
  let pushes = 0;
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-open", activityId: "a1" } }, { render: () => {}, pushHistory: () => { pushes += 1; } });
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-back" } }, { render: () => {} });
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-back" } }, { render: () => {} });
  assert.equal(state.myTraining.openId, "", "closed by the first tap; the second changes nothing");
  assert.equal(state.activeTab, "my-training");
  assert.equal(pushes, 1);
  await actions.handleMyTrainingAction({ dataset: { action: "my-training-open", activityId: "a1" } }, { render: () => {}, pushHistory: () => { pushes += 1; } });
  assert.equal(actions.handleMyTrainingBack(() => {}), true, "phone Back closes it");
  assert.equal(actions.handleMyTrainingBack(() => {}), false, "on her list Back is the app's");
});

test("14: a text value goes under its label; the list has its heading, and an empty year says how sessions arrive", async () => {
  state.myTraining = emptyMyTrainingState();
  state.myTraining.openId = "a1";
  state.myTraining.detail = { activityId: "a1", loading: false, error: "", data: { facts: [value("v1", "k1", null, { valueText: "Felt strong in the second half of the session" })], components: [], variableNamesById: { v1: { label: "Comment" } } } };
  assert.match(view.renderMyTrainingHtml(), /class="my-training-value is-text"/);
  state.myTraining = emptyMyTrainingState();
  serve(() => ({ status: 200, body: { rows: [], nextCursor: null } }));
  await data.loadMyTrainingList({}, () => {});
  const html = view.renderMyTrainingHtml();
  assert.match(html, /<h3 class="my-training-title">My training<\/h3>/);
  assert.match(html, /Sessions appear here after a device or your coach records them\./);
});
