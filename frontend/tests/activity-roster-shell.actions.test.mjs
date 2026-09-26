import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
let phone = false;
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: phone }) };

const { emptyTrainingLoadState, state } = await import("../state.js");
const { renderActivityRosterHtml, rosterTabLabel, rosterValueColumns } = await import("../activity-roster-view.js");
const { handleActivityRosterAction, loadRosterForOpenActivity, activityRosterDisclosureToggled } = await import("../activity-roster-actions.js");
const { loadActivityRoster, resetActivityRoster } = await import("../activity-roster-data.js");
const { renderTrainingLoadCalendarHtml } = await import("../training-load-calendar-view.js");

function resetState() {
  state.trainingLoad = emptyTrainingLoadState();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "team", scopeId: "team-1" } };
  phone = false;
}

function rosterPayload(overrides = {}) {
  const base = {
    activity: { id: "act-1", name: "Full training", occurredLocalDate: "2026-09-18", startedAt: "2026-09-18T15:00:00Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: "act-1",
    completion: { status: "needs_review" },
    reasons: [{ key: "illness", label: "Illness" }],
    counts: { total: 3, needsState: 1, needsReview: 1, recordedOutsideRoster: 1 },
    athletes: [
      {
        athleteId: "ath-1", name: "Ivan Marković", state: "unknown", stateLabel: "Unknown", group: "needs_state", flags: [],
        values: [{ metricKey: "duration", shortLabel: "Time", value: null, unit: "min", entryMethod: "api_import" }],
      },
      {
        athleteId: "ath-2", name: "Luka Jurić", state: "no_usable_device_record", stateLabel: "No usable device record", group: "needs_review", flags: [],
        sourceReason: { sourceSystem: "gpexe", code: "needs_manual_review", label: "flagged this record for a manual check" },
        values: [{ metricKey: "duration", shortLabel: "Time", value: 63, unit: "min", entryMethod: "api_import" }],
      },
      {
        athleteId: "ath-3", name: "Mira Lukić", state: "measured", stateLabel: "Measured", group: "done", flags: [],
        values: [
          { metricKey: "duration", shortLabel: "Time", value: 60, unit: "min", entryMethod: "api_import" },
          { metricKey: "heart_rate", shortLabel: "Average HR", value: 153, unit: "bpm", entryMethod: "api_import" },
        ],
      },
    ],
    recordedOutsideRoster: [{
      athleteId: "ath-4", name: "Petar Kunić", state: "measured", stateLabel: "Measured", flags: [],
      values: [{ metricKey: "heart_rate", shortLabel: "Average HR", value: 149, unit: "bpm", entryMethod: "api_import" }],
    }],
  };
  return { ...base, ...overrides, activity: { ...base.activity, ...(overrides.activity || {}) } };
}

function installFetch(handler) {
  globalThis.fetch = async (url) => {
    const result = await handler(url);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

test("read-only roster uses response metrics and neutral source wording without inventing GPS or membership reasons", () => {
  resetState();
  const roster = state.trainingLoad.calendar.roster;
  roster.activityId = "act-1";
  roster.data = rosterPayload();
  roster.applicable = true;
  const html = renderActivityRosterHtml(roster);

  assert.match(html, /Needs a state[\s\S]*1/);
  assert.match(html, /Average HR/);
  assert.match(html, /The device source flagged this record for a manual check/);
  assert.match(html, /Fix it there, then find new sessions in Imports/);
  assert.match(html, /Recorded, but not on this session's roster/);
  assert.match(html, /tl-roster-outside-head[\s\S]*Athlete[\s\S]*State[\s\S]*Average HR/);
  assert.match(html, /Petar Kunić/);
  assert.ok(!html.includes("GPS"));
  assert.ok(!html.includes("joined later"));
  assert.ok(!html.includes("left earlier"));
  assert.ok(!html.includes("gpexe flagged"), "raw source code never becomes the visible name");
  assert.ok(!html.includes("Set state"), "5a3a is read-only");
  assert.ok(rosterValueColumns(roster.data.athletes).some((column) => column.label === "Average HR"));
});

test("phone defaults to Needs a state, filtering repaints without a request, and disclosures persist", async () => {
  resetState();
  phone = true;
  const roster = state.trainingLoad.calendar.roster;
  roster.activityId = "act-1";
  roster.data = rosterPayload();
  roster.applicable = true;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("not expected"); };

  let html = renderActivityRosterHtml(roster);
  assert.match(html, /data-roster-filter="needs_state"[\s\S]*aria-pressed="true"/);
  assert.match(html, /Ivan Marković/);
  assert.ok(!html.includes("Mira Lukić"));

  let renders = 0;
  await handleActivityRosterAction({ dataset: { action: "training-load-roster-filter", rosterFilter: "all" } }, { render: () => { renders += 1; } });
  html = renderActivityRosterHtml(roster);
  assert.match(html, /Mira Lukić/);
  assert.equal(calls, 0);
  assert.equal(renders, 1);

  activityRosterDisclosureToggled({ open: true, dataset: { rosterDisclosure: "outside", renderedOpen: "0" } });
  assert.deepEqual(roster.openDisclosures, ["outside"]);
});

test("a roster with blocking rows automatically opens once, but a tab explicitly chosen while loading wins", async () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.selectedActivityId = "act-1";
  resetActivityRoster("act-1");
  installFetch(async () => ({ status: 200, body: rosterPayload({ activity: { id: "act-1" }, canonicalActivityId: "act-1" }) }));
  await loadRosterForOpenActivity("act-1", () => {});
  assert.equal(cal.activityDetailTab, "roster");
  assert.equal(cal.roster.autoTabFor, "act-1");

  cal.activityDetailTab = "overview";
  resetActivityRoster("act-2");
  cal.roster.userPickedTab = true;
  installFetch(async () => ({ status: 200, body: rosterPayload({ activity: { id: "act-2" }, canonicalActivityId: "act-2" }) }));
  await loadRosterForOpenActivity("act-2", () => {});
  assert.equal(cal.activityDetailTab, "overview");
});

test("a slower old roster answer cannot overwrite the newly opened activity", async () => {
  resetState();
  const pending = [];
  globalThis.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
  resetActivityRoster("act-old");
  const oldLoad = loadActivityRoster("act-old", () => {});
  resetActivityRoster("act-new");
  const newLoad = loadActivityRoster("act-new", () => {});
  pending[1].resolve({ ok: true, status: 200, json: async () => rosterPayload({ activity: { id: "act-new", name: "New" }, canonicalActivityId: "act-new" }) });
  await newLoad;
  pending[0].resolve({ ok: true, status: 200, json: async () => rosterPayload({ activity: { id: "act-old", name: "Old" }, canonicalActivityId: "act-old" }) });
  await oldLoad;
  assert.equal(state.trainingLoad.calendar.roster.activityId, "act-new");
  assert.equal(state.trainingLoad.calendar.roster.data.activity.name, "New");
});

test("retryable, missing and real 200 merged roster states stay distinct", async () => {
  resetState();
  resetActivityRoster("act-1");
  installFetch(async () => ({ status: 500, body: { error: "internal_error" } }));
  await loadActivityRoster("act-1", () => {});
  assert.match(renderActivityRosterHtml(state.trainingLoad.calendar.roster), /could not be loaded[\s\S]*Try again/);

  resetActivityRoster("act-2");
  state.trainingLoad.calendar.activityDetailTab = "roster";
  installFetch(async () => ({ status: 404, body: { error: "notFound" } }));
  await loadActivityRoster("act-2", () => {});
  assert.equal(state.trainingLoad.calendar.roster.applicable, false);
  assert.equal(state.trainingLoad.calendar.activityDetailTab, "overview", "a vanished initial tab cannot leave a blank panel selected");

  resetActivityRoster("act-3");
  const roster = state.trainingLoad.calendar.roster;
  installFetch(async () => ({ status: 200, body: rosterPayload({ activity: { id: "act-3" }, canonicalActivityId: "act-current" }) }));
  await loadActivityRoster("act-3", () => {});
  const html = renderActivityRosterHtml(roster);
  assert.match(html, /merged into another/);
  assert.match(html, /data-activity-id="act-current"/);
});

test("manual and estimated values never create 5a3a columns or appear in details", () => {
  resetState();
  const roster = state.trainingLoad.calendar.roster;
  roster.activityId = "act-1";
  const data = rosterPayload();
  data.athletes[2].values.push(
    { metricKey: "manual_load", label: "Manual load", value: 999, unit: "AU", entryMethod: "manual" },
    { metricKey: "estimated_load", label: "Estimated load", value: 888, unit: "AU", entryMethod: "estimated" },
  );
  roster.data = data;
  roster.applicable = true;
  const html = renderActivityRosterHtml(roster);
  assert.doesNotMatch(html, /Manual load|Estimated load|999|888/);
  assert.deepEqual(rosterValueColumns(data.athletes).map((column) => column.metricKey), ["heart_rate", "duration"]);
});

test("zero measured metrics keeps a two-column roster and a folded absence names reason and coach", () => {
  resetState();
  const roster = state.trainingLoad.calendar.roster;
  roster.activityId = "act-1";
  const data = rosterPayload({
    counts: { total: 1, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 },
    athletes: [{
      athleteId: "ath-5", name: "Long Athlete", state: "did_not_participate", stateLabel: "Did not participate", group: "done", flags: [], values: [],
      decision: { kind: "did_not_participate", label: "Did not participate", reasonKey: "illness", decidedBy: { name: "Coach One" }, decidedAt: "2026-09-18T12:00:00Z" },
    }],
    recordedOutsideRoster: [],
  });
  roster.data = data;
  roster.applicable = true;
  const html = renderActivityRosterHtml(roster);
  assert.match(html, /tl-roster-table has-no-metrics/);
  assert.match(html, /Illness — Coach One/);
  assert.match(html, /Review the roster and the data recorded for this session/);
  assert.doesNotMatch(html, /Each state is saved/);
});

test("phone tab label is compact while its accessible label keeps the meaning", () => {
  resetState();
  phone = true;
  const roster = state.trainingLoad.calendar.roster;
  roster.data = rosterPayload({ counts: { total: 15, needsState: 12, needsReview: 0, recordedOutsideRoster: 0 } });
  assert.equal(rosterTabLabel(roster), "Roster · 12");
  assert.equal(rosterTabLabel(roster, { accessible: true }), "Roster · 12 need a state");
});

test("an outside group auto-opens once on an empty roster but stays closed after the user closes it", () => {
  resetState();
  const roster = state.trainingLoad.calendar.roster;
  roster.activityId = "act-1";
  roster.data = rosterPayload({ athletes: [], counts: { total: 0, needsState: 0, needsReview: 0, recordedOutsideRoster: 1 } });
  roster.applicable = true;
  assert.match(renderActivityRosterHtml(roster), /class="tl-roster-outside"[^>]* open/);
  activityRosterDisclosureToggled({ open: false, dataset: { rosterDisclosure: "outside", renderedOpen: "1" } });
  assert.doesNotMatch(renderActivityRosterHtml(roster), /class="tl-roster-outside"[^>]* open/);
});

test("calendar shows Roster after Overview only when applicable and hides the separate metrics table on that tab", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-14";
  cal.selectedDate = "2026-09-18";
  cal.data = { dateFrom: "2026-09-14", dateTo: "2026-09-20", days: [{ date: "2026-09-18", items: [{ kind: "activity", activityId: "act-1", name: "Full training", occurredLocalDate: "2026-09-18" }] }] };
  cal.selectedActivityId = "act-1";
  cal.activityDetail = { activityId: "act-1", data: { canonicalActivityId: "act-1", facts: [], athleteNamesById: {}, components: [] }, loading: false, error: "" };
  cal.roster = { ...cal.roster, activityId: "act-1", data: rosterPayload(), applicable: true };
  cal.activityDetailTab = "roster";
  const html = renderTrainingLoadCalendarHtml();
  assert.ok(html.indexOf(">Overview<") < html.indexOf(">Roster · 1 needs a state<"));
  assert.match(html, /aria-label="Activity roster"/);
  assert.ok(!html.includes("Choose metrics"));
  assert.equal(rosterTabLabel(cal.roster), "Roster · 1 needs a state");
});

test("calendar does not flash a Roster tab while applicability is still loading", () => {
  resetState();
  const cal = state.trainingLoad.calendar;
  cal.weekStart = "2026-09-14";
  cal.selectedDate = "2026-09-18";
  cal.data = { dateFrom: "2026-09-14", dateTo: "2026-09-20", days: [{ date: "2026-09-18", items: [{ kind: "activity", activityId: "act-1", name: "Full training", occurredLocalDate: "2026-09-18" }] }] };
  cal.selectedActivityId = "act-1";
  cal.activityDetail = { activityId: "act-1", data: { canonicalActivityId: "act-1", facts: [], athleteNamesById: {}, components: [] }, loading: false, error: "" };
  cal.roster = { ...cal.roster, activityId: "act-1", data: null, loading: true, applicable: null, error: null };
  const html = renderTrainingLoadCalendarHtml();
  assert.doesNotMatch(html, /data-tl-calendar-detail-tab="roster"/);
});
