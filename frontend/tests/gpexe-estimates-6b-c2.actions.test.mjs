// 6b-C2: the session review names the estimates an import replaces with measured values (contract rule 6): the athlete
// and the variables, in plain words, never an id; nothing to accept and nothing that blocks. Driven through
// handleTrainingLoadAction with a fake fetch, like the other Imports suites (the harness is the follow-ups suite's).
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: () => confirmAnswer, matchMedia: () => ({ matches: false }) };

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  fetchCalls.push(call);
  const result = await responder(call);
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
const { loadEstimateTargets } = await import("../gpexe-estimate-link.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const MARKER_SESSION = "9977001";
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};
const SRC = { list: [] };

let renders = 0;
const render = () => { renders += 1; };
function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  fetchCalls = [];
  renders = 0;
}

function status({ enabled = false, canApprove = true, admin = false, lastCheck = null } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: admin, ...(admin ? { identityAdmin: true } : {}) },
    approvalAvailable: true,
  };
}

// A clean Ready session, as the list returns it since phase 4a / v33.
function row(overrides = {}) {
  return {
    id: "cand-1", gpexeTeamSessionId: MARKER_SESSION, label: "FULL TRAINING 05.10.", sessionStartedAt: "2026-10-05T16:08:12Z",
    status: "pending", previewStatus: "ready", previewHash: HASH, counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    firstSeenAt: "2026-10-05T18:00:00Z", lastSeenAt: "2026-10-06T18:00:00Z", importedAt: null,
    supersededByCandidateId: null, supersededByCheckId: null,
    snapshot: { available: true, expiresAt: "2026-11-05T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], ...overrides,
  };
}

let previewExtra = {};
function detailOf(c) {
  return {
    ...c,
    athletes: { "ath-1": { name: "Ana Example" } },
    approval: null,
    preview: {
      version: 3, status: c.previewStatus === "no_changes" ? "no_changes" : "ready", blocked: null,
      counts: { created: 4, changesToImported: 0 }, changesToImported: [],
      athletes: [{ gpexeAthleteId: "101", athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
        results: [{ externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }] }], skippedValues: [] }],
      teamAthletesWithoutGpexeRecord: [], anomalies: [], ...previewExtra,
    },
  };
}

function server({ teamStatus = {}, candidates = [], onApprove, onImports, checks } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: SRC.list, units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [{ id: "link-1", gpexeAthleteId: "101", athleteId: "ath-1", athleteName: "Ana Example" }] } };
    if (rest.startsWith("/candidates?") || rest === "/candidates") {
      // Like listCandidates(): a superseded row is listed only with ?includeSuperseded=true.
      const list = typeof candidates === "function" ? candidates(call) : candidates;
      const withSuperseded = rest === "/candidates?includeSuperseded=true";
      if (rest !== "/candidates" && !withSuperseded) return { status: 400, body: { error: "unexpected query in the test" } };
      const listed = withSuperseded ? list : list.filter((c) => c.status !== "superseded");
      return { status: 200, body: { candidates: team === TEAM_A ? listed : [] } };
    }
    if (rest === "/imports" && call.method === "POST") return onImports(call);
    const approve = rest.match(/^\/candidates\/([^/]+)\/approve$/);
    if (approve) return onApprove(call, approve[1]);
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      const list = typeof candidates === "function" ? candidates(call) : candidates;
      const c = list.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: detailOf(c) } } : { status: 404, body: { error: "notFound" } };
    }
    if (rest === "/checks" && call.method === "POST") return checks.start(call);
    const poll = rest.match(/^\/checks\/([^/]+)$/);
    if (poll) return checks.poll(call);
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset }, ...extra }, { renderTrainingLoad: render });
}
const openImports = () => act("training-load-section", { section: "imports" });
const openCandidate = (id) => act("training-load-gpexe-open", { candidateId: id });
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
function section(page, label) {
  const start = page.indexOf(`aria-label="${label}"`);
  if (start < 0) return "";
  const end = page.indexOf("</section>", start);
  return page.slice(start, end);
}
// The page with every closed Technical details block cut out.
const outsideTech = (page) => page.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");



const replacedSection = (page = html()) => section(page, "Estimates replaced by measured values");

async function openReview(extra, teamStatus = { enabled: true, canApprove: true }) {
  resetState();
  SRC.list = [];
  previewExtra = extra;
  responder = server({ teamStatus, candidates: [row()] });
  await openImports();
  await openCandidate("cand-1");
}

test("1. the review names each athlete whose estimates the import replaces, with the variables in the preview's own words; one heading with the count; nothing to accept", async () => {
  await openReview({ supersededEstimates: [
    { athleteId: "ath-1", metricDefinitionId: "def-distance" },
    { athleteId: "ath-1", metricDefinitionId: "def-other" },
  ] });
  const sec = replacedSection();
  assert.ok(sec, "the section is there");
  assert.match(sec, /Estimates replaced by measured values \(2\)/);
  assert.match(sec, /<strong>Ana Example<\/strong> · Distance, Variable/, "a variable the preview does not label reads as Variable");
  assert.match(sec, /nothing needs to be accepted/);
  assert.doesNotMatch(sec, /type="checkbox"/, "never a checkbox");
  assert.doesNotMatch(sec, /def-|ath-1/, "never an id");
  assert.doesNotMatch(outsideTech(html()).replace(/data-[a-z-]+="[^"]*"/g, ""), /ath-1|def-(distance|other)/, "no id anywhere a coach reads");
});

test("2. one estimate reads in the singular; no estimate shows no section", async () => {
  await openReview({ supersededEstimates: [{ athleteId: "ath-1", metricDefinitionId: "def-distance" }] });
  assert.match(section(html(), "Estimates replaced by measured values"), /An estimate is replaced by a measured value/);
  await openReview({});
  assert.equal(replacedSection(), "");
  assert.doesNotMatch(html(), /replaced by a measured value/);
});

test("3. a club variable of another club stays as the preview names it; the approval needs no extra step for the replaced estimates", async () => {
  await openReview({ supersededEstimates: [{ athleteId: "ath-1", metricDefinitionId: "def-club" }] });
  // The preview's own values name a club variable of another club "Club variable" (the coach's projection).
  state.trainingLoad.gpexe.detail.candidate.preview.athletes[0].results[0].values.push({ metricDefinitionId: "def-club", variableScope: "club", label: "Club variable", unit: "m", value: "1", change: "new" });
  assert.match(replacedSection(), /Ana Example<\/strong> · Club variable/);
  assert.doesNotMatch(html(), /data-gpexe-accept/, "nothing to accept: replaced estimates are not changes to accept");
});

// ---------------------------------------------------------------------------
// The link from an imported session's review to the Roster tab's estimate (decision (A)).
// ---------------------------------------------------------------------------

const ACT = "act-1";
function rosterBody({ estimates = true, canDecideRoster = true, states = { "ath-1": "participated_no_values" } } = {}) {
  const athletes = Object.entries(states).map(([athleteId, s]) => ({
    athleteId, name: athleteId === "ath-1" ? "Ana Example" : "Bo Example", state: s,
    stateLabel: s === "participated_no_values" ? "Participated · no device data" : "Measured", group: "done", flags: [], values: [],
    decision: s === "participated_no_values" ? { id: `d-${athleteId}`, kind: s, label: "Participated · no device data", decidedBy: { name: "Coach" }, decidedAt: "2026-10-05T18:00:00Z" } : null,
  }));
  return {
    activity: { id: ACT, name: "Full training", occurredLocalDate: "2026-10-05", startedAt: "2026-10-05T16:08:12Z", timezone: "Europe/Belgrade" },
    canonicalActivityId: ACT, viewer: { basis: "team_coach", canDecideRoster, ...(estimates ? { estimates: true } : {}) },
    completion: { status: "not_complete", revision: 0 }, reasons: [],
    counts: { total: athletes.length, needsState: 0, needsReview: 0, recordedOutsideRoster: 0 }, athletes, recordedOutsideRoster: [],
  };
}
const importedRow = () => row({ status: "imported", importedAt: "2026-10-06T10:00:00Z", approvalBlockers: ["already_imported"], previewHash: null });

async function openImportedReview({ roster = rosterBody(), extra = {}, preview = {} } = {}) {
  resetState();
  SRC.list = [];
  previewExtra = preview;
  const inner = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [importedRow()] });
  responder = async (call) => {
    if (call.url === `/api/training-activity/${ACT}/roster`) return typeof roster === "function" ? roster(call) : { status: 200, body: roster };
    if (call.url.startsWith(`/api/training-activity/${ACT}/estimates/proposal`)) return { status: 200, body: { activityId: ACT, athleteId: "ath-1", athleteName: "Ana Example", minutes: { default: 45, used: 45 }, variables: [], methods: { proportional: { available: true, reason: null, values: [] }, copy_athlete: { available: false, reason: "no_source", values: [], sources: [] }, team_average: { available: false, reason: "too_few", values: [] }, scale_recording: { available: false, reason: "scale_not_chosen", values: [] } } } };
    if (call.url.startsWith("/api/training-activity/") || call.url.startsWith("/api/training-load/calendar")) return { status: 404, body: { error: "notFound" } };
    const r = await inner(call);
    // The imported candidate's detail names its approval and activity, as getCandidate does.
    if (r.body?.candidate) r.body.candidate = { ...r.body.candidate, approval: { id: "appr-1", import: { activityId: ACT } }, ...extra };
    return r;
  };
  await openImports();
  await openCandidate("cand-1");
  // The roster read is fired alongside the review: let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}
// The section is named by its heading (aria-labelledby).
function targetsSection(page = html()) {
  const start = page.indexOf('class="gpexe-estimate-targets"');
  return start < 0 ? "" : page.slice(start, page.indexOf("</section>", start));
}

test("4. an imported session's review lists who took part without device data, each with Estimate values in Activities, only while the server says estimates are on", async () => {
  await openImportedReview({ roster: rosterBody({ states: { "ath-1": "participated_no_values", "ath-2": "measured" } }) });
  const sec = targetsSection();
  assert.match(sec, /Ana Example/);
  assert.doesNotMatch(sec, /Bo Example/, "a measured athlete gets no link");
  assert.equal((sec.match(/data-action="training-load-estimate-in-activities"/g) || []).length, 1);
  assert.match(sec, /Estimate values in Activities/);
  assert.equal(fetchCalls.filter((c) => c.method !== "GET").length, 0, "the review only reads");

  await openImportedReview({ roster: rosterBody({ estimates: false }) });
  assert.equal(targetsSection(), "", "estimates off: no link");

  await openImportedReview({ roster: () => ({ status: 503, body: { error: "database_busy" } }) });
  assert.equal(targetsSection(), "", "a failed read shows no link");
});

test("5. the link closes the review and opens the estimate panel independently of attendance permission", async () => {
  await openImportedReview({ roster: rosterBody({ canDecideRoster: false }) });
  await act("training-load-estimate-in-activities", { athleteId: "ath-1" });
  assert.equal(gx().detail, null, "the review is closed");
  const cal = state.trainingLoad.calendar;
  assert.equal(cal.selectedActivityId, ACT);
  assert.equal(cal.activityDetailTab, "roster");
  assert.equal(cal.roster.estimate?.athleteId, "ath-1", "the estimate panel is open for the athlete");
  assert.ok(fetchCalls.some((c) => c.url.startsWith(`/api/training-activity/${ACT}/estimates/proposal`)), "the proposal was read");
  assert.equal(fetchCalls.filter((c) => c.method !== "GET").length, 0, "nothing is written by following the link");
});

test("6. attendance states still being saved: the link asks first, and a No keeps the review", async () => {
  await openImportedReview();
  gx().detail.states = { ...(gx().detail.states || {}), saving: true, groups: {} };
  confirmAnswer = false;
  try {
    await act("training-load-estimate-in-activities", { athleteId: "ath-1" });
    assert.ok(gx().detail, "the review stays");
    assert.notEqual(state.trainingLoad.calendar.selectedActivityId, ACT);
  } finally {
    confirmAnswer = true;
  }
  await act("training-load-estimate-in-activities", { athleteId: "ath-1" });
  assert.equal(gx().detail, null, "after a Yes it goes");
});

test("7. an athlete the review does not list, or an import that was undone, gets no navigation", async () => {
  await openImportedReview();
  await act("training-load-estimate-in-activities", { athleteId: "ath-9" });
  assert.ok(gx().detail, "an unknown athlete changes nothing");
  await openImportedReview({ extra: { importUndoneAt: "2026-10-07T10:00:00Z" } });
  assert.equal(targetsSection(), "", "an undone import offers no estimate");
});

// The internal reviews of 6b-C2.
test("8. an undo made in the same review removes the link, and the action no longer navigates", async () => {
  await openImportedReview();
  assert.ok(targetsSection(), "the link is there before the undo");
  gx().undo = { id: "cand-1", step: "done" };
  gx().detail.candidate = { ...gx().detail.candidate, importUndoneAt: "2026-10-07T10:00:00Z" };
  assert.equal(targetsSection(), "", "no link after the undo");
  await act("training-load-estimate-in-activities", { athleteId: "ath-1" });
  assert.ok(gx().detail, "the review stays");
  assert.notEqual(state.trainingLoad.calendar.selectedActivityId, ACT);
});

test("9. a No to Activities' own question (another session's roster write is not confirmed) keeps the review as it is", async () => {
  await openImportedReview();
  const cal = state.trainingLoad.calendar;
  cal.selectedActivityId = "other";
  cal.roster = { ...cal.roster, activityId: "other", unconfirmed: { command: {} } };
  confirmAnswer = false;
  try {
    await act("training-load-estimate-in-activities", { athleteId: "ath-1" });
  } finally {
    confirmAnswer = true;
  }
  assert.ok(gx().detail, "the review stays open");
  assert.equal(cal.selectedActivityId, "other", "Activities is unchanged");
  assert.ok(cal.roster.unconfirmed, "the other roster's unconfirmed write is kept");
});

test("10. a slower, older roster read never replaces a newer one", async () => {
  await openImportedReview();
  const detail = gx().detail;
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let n = 0;
  const inner = responder;
  responder = async (call) => {
    if (call.url === `/api/training-activity/${ACT}/roster`) {
      n += 1;
      if (n === 1) { await slow; return { status: 200, body: rosterBody({ states: { "ath-1": "measured" } }) }; }
      return { status: 200, body: rosterBody() };
    }
    return inner(call);
  };
  const first = loadEstimateTargets(detail, render);
  await loadEstimateTargets(detail, render);
  release();
  await first;
  assert.deepEqual(detail.estimateTargets.athletes.map((a) => a.athleteId), ["ath-1"], "the newer answer stays");
});

test("11. after the import the replacement line is in the past tense; an athlete who already has an estimate is offered Change the estimate", async () => {
  const r = rosterBody();
  r.athletes[0].values = [{ metricKey: "distance", value: 3000, unit: "m", entryMethod: "estimate", estimate: { method: "team_average" } }];
  await openImportedReview({ roster: r, preview: { supersededEstimates: [{ athleteId: "ath-1", metricDefinitionId: "def-distance" }] } });
  const replacedText = replacedSection();
  assert.match(replacedText, /An estimate was replaced by a measured value/);
  assert.match(replacedText, /replaced them in this import/);
  assert.doesNotMatch(replacedText, /when you import/);
  const sec = targetsSection();
  assert.match(sec, />Change the estimate in Activities</);
  // Label in name: the visible text whole at the start of the accessible name.
  for (const m of sec.matchAll(/aria-label="([^"]+)"[^>]*>([^<]+)<\/button>/g)) assert.ok(m[1].startsWith(m[2]), `${m[1]} starts with ${m[2]}`);
  assert.match(sec, /aria-label="Change the estimate in Activities, Ana Example"/);
  assert.match(sec, /Estimated/);
  // An undone import says nothing about the replaced estimates.
  await openImportedReview({ extra: { importUndoneAt: "2026-10-07T10:00:00Z" }, preview: { supersededEstimates: [{ athleteId: "ath-1", metricDefinitionId: "def-distance" }] } });
  assert.equal(replacedSection(), "");
});

test("8b. each undo signal alone removes the link: the undo done in this review (before the session is read again), and an undone session whose import outcome is still on screen", async () => {
  await openImportedReview();
  gx().undo = { id: "cand-1", step: "done" };
  assert.equal(targetsSection(), "", "the undo's own state is enough");
  gx().undo = { id: "cand-1", step: "unknown" };
  assert.equal(targetsSection(), "", "an undo whose result is not confirmed too");
  await openImportedReview();
  gx().detail.outcome = { kind: "imported", result: { import: { activityId: ACT } } };
  gx().detail.candidate = { ...gx().detail.candidate, importUndoneAt: "2026-10-07T10:00:00Z" };
  assert.equal(targetsSection(), "", "the session's undone mark is enough, even with the import's outcome on screen");
});

test("12. right after an import made in this review (the session not read again yet), the replacement line is already in the past tense", async () => {
  await openReview({ supersededEstimates: [{ athleteId: "ath-1", metricDefinitionId: "def-distance" }] });
  assert.match(replacedSection(), /when you import/, "pending: the future");
  gx().detail.outcome = { kind: "imported", result: { approval: { id: "appr-1" }, import: { activityId: "act-1" } } };
  assert.match(replacedSection(), /replaced them in this import/);
  assert.doesNotMatch(replacedSection(), /when you import/);
});
