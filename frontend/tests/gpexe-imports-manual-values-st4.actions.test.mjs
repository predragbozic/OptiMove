// ST-4 PR3 (docs/ai/session-type-plan.md section 8 and 16.2): the re-import question in the Session review - the athletes whose
// values were entered or corrected on the roster, kept by default, "Use GPEXE's values" per athlete as a reviewed choice.
// The harness is the J20-B leave-out suite's (gpexe-imports-leave-out-j20b.actions.test.mjs).
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

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const MARKER_SESSION = "9977001";
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};
const LINKED = [{ gpexeAthleteId: "101", status: "linked", link: { id: "link-1", athleteId: "ath-1", athleteName: "Ana Example", linkedAt: "2026-09-10T10:00:00Z" }, lastSeen: null, values: { duration: 40, distance: 3000, maxSpeed: 27 } }];

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
const ATHLETES = [["101", "ath-1", "Ana Example"], ["102", "ath-2", "Bea Example"], ["103", "ath-3", "Cy Example"]];
function athleteEntry([gid, aid]) {
  return { gpexeAthleteId: gid, athleteId: aid, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
    results: [{ externalId: `athlete_session:${gid}:full`, level: "full", drillIndex: null, outcome: "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }] }], skippedValues: [] };
}
function previewOf(leftOut = []) {
  return {
    version: 3, status: "ready", blocked: null, counts: { created: 4, changesToImported: 0 }, changesToImported: [],
    athletes: ATHLETES.map((a) => (leftOut.includes(a[0])
      ? { ...athleteEntry(a), notImported: { code: "left_out_by_coach", message: "You chose to leave this athlete out of this import." }, results: [] }
      : athleteEntry(a))),
    teamAthletesWithoutGpexeRecord: [], anomalies: [],
  };
}
let approval = null;
let manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }, { athleteId: "ath-2", kind: "correction", choice: "keep" }] };
function detailOf(c) {
  return { ...c, athletes: Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), approval, preview: { ...previewOf(approval?.excludedAthleteIds || []), ...(manualValues ? { manualValues } : {}) }, helperValues: {} };
}
const subsetHashOf = (ids) => `${"b".repeat(60)}${ids.join("").slice(-4).padStart(4, "0")}`;

function server({ teamStatus = {}, candidates = [], onApprove, onSubset } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: LINKED, units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest === "/candidates") return { status: 200, body: { candidates: team === TEAM_A ? candidates : [] } };
    const previewRoute = rest.match(/^\/candidates\/([^/]+)\/preview$/);
    if (previewRoute) return onSubset ? onSubset(call, previewRoute[1]) : { status: 404, body: { error: "notFound" } };
    const approve = rest.match(/^\/candidates\/([^/]+)\/approve$/);
    if (approve) return onApprove(call, approve[1]);
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      const c = candidates.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: detailOf(c) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset }, ...extra }, { renderTrainingLoad: render });
}
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const tick = (gid, checked = true) => act("training-load-gpexe-leave-out", { gpexeAthleteId: gid }, { checked });
const boxes = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-leave-out" data-gpexe-athlete-id="(\d+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);
const subsetOk = (call) => {
  const ids = call.body.excludedAthleteIds;
  const replace = call.body.replaceManualAthleteIds || [];
  return { status: 200, body: { subset: { excludedAthleteIds: ids, ...(replace.length ? { replaceManualAthleteIds: replace } : {}), previewHash: HASH, subsetHash: subsetHashOf([...ids, ...replace.map((x) => x.slice(-1))]), preview: previewOf(ids) }, importSwitch: { enabled: true } } };
};
const approvals = () => fetchCalls.filter((c) => c.url.endsWith("/approve"));
const subsets = () => fetchCalls.filter((c) => c.url.endsWith("/preview"));
const imported = (call, ids = []) => ({ status: 200, body: { outcome: "imported", commitConfirmation: "confirmed", approval: { id: "ap-1", basis: "team_grant", changesAccepted: 0, excludedAthleteIds: ids, subsetHash: ids.length ? subsetHashOf(ids) : null }, import: { counts: { results: 4, values: 8 } }, candidate: detailOf({ ...row(), status: "imported" }) } });

async function openReview(opts = {}) {
  resetState();
  approval = null;
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row()], onSubset: async (call) => subsetOk(call), onApprove: async (call) => imported(call, call.body.excludedAthleteIds || []), ...opts });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
}


const useGpexe = (athleteId, checked = true) => act("training-load-gpexe-use-gpexe", { athleteId }, { checked });
const useBoxes = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-use-gpexe" data-athlete-id="([^"]+)"( checked)?/g)].map((m) => [m[1], Boolean(m[2])]);

test("1. the review lists the athletes with values entered or corrected on the roster, kept by default (every box unticked); a plain import sends no choice", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }, { athleteId: "ath-2", kind: "correction", choice: "keep" }] };
  await openReview();
  const page = html();
  assert.match(page, /2 athletes have values you entered\./);
  assert.match(page, /Your values are kept unless you tick Use GPEXE(?:'|&#0?39;)s values\. Replaced values stay in the history\./);
  assert.match(page, /Ana Example <span class="muted">· values entered on the roster/);
  assert.match(page, /Bea Example <span class="muted">· values corrected on the roster/);
  assert.deepEqual(useBoxes(page), [["ath-1", false], ["ath-2", false]]);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  assert.equal(approvals()[0].body.replaceManualAthleteIds, undefined, "keep is the default: no choice is sent");
  assert.equal(subsets().length, 0);
});

test("2. Use GPEXE's values is a reviewed choice: ticked, the import waits for Review your choice; the review sends the athletes; the import sends exactly the reviewed choice and its hash", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }, { athleteId: "ath-2", kind: "correction", choice: "keep" }] };
  await openReview();
  await useGpexe("ath-1");
  let page = html();
  assert.deepEqual(useBoxes(page), [["ath-1", true], ["ath-2", false]]);
  assert.match(page, /Using GPEXE(?:'|&#0?39;)s values for 1 athlete: Ana Example\./);
  assert.match(page, />Review your choice</);
  // The import is not sent before the review.
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
  await act("training-load-gpexe-subset-review");
  assert.equal(subsets().length, 1);
  assert.deepEqual(subsets()[0].body, { excludedAthleteIds: [], replaceManualAthleteIds: ["ath-1"] });
  page = html();
  assert.match(page, /Reviewed with your choice: 3 athletes will be imported\./);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  const body = approvals()[0].body;
  assert.deepEqual(body.replaceManualAthleteIds, ["ath-1"]);
  assert.deepEqual(body.excludedAthleteIds, []);
  assert.equal(body.subsetHash, gx().detail?.subset?.subsetHash ?? body.subsetHash);
  assert.match(body.subsetHash, /^b{60}/);
});

test("3. a change of the choice drops the review (it is made again, never reused); unticking every box goes back to the plain import", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }, { athleteId: "ath-2", kind: "correction", choice: "keep" }] };
  await openReview();
  await useGpexe("ath-1");
  await act("training-load-gpexe-subset-review");
  assert.equal(gx().detail.subset.status, "ready");
  await useGpexe("ath-2");
  assert.equal(gx().detail.subset, null, "a changed choice drops the review");
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
  await useGpexe("ath-1", false);
  await useGpexe("ath-2", false);
  assert.match(html(), /data-action="training-load-gpexe-approve"/);
  assert.doesNotMatch(html(), />Review your choice</);
});

test("4. an athlete the server does not list cannot be chosen; a viewer who may not approve gets no choice; a session without roster values shows no block", async () => {
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }] };
  await openReview();
  await useGpexe("ath-3");
  assert.deepEqual(gx().detail.useGpexe || [], [], "not listed: ignored");
  manualValues = { athletes: [{ athleteId: "ath-1", kind: "entry", choice: "keep" }] };
  await openReview({ teamStatus: { enabled: true, canApprove: false } });
  assert.equal(useBoxes().length, 0);
  await useGpexe("ath-1");
  assert.deepEqual(gx().detail.useGpexe || [], []);
  manualValues = null;
  await openReview();
  assert.doesNotMatch(html(), /values you entered/);
});
