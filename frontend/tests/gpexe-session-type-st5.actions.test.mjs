// ST-5 (docs/ai/session-type-plan.md sections 4 and 17): the session type of an import, chosen in the Session review - the
// shown suggestion, a changed type, and a session of an unknown GPEXE category that waits for one. Driven through
// handleTrainingLoadAction with a fake fetch, like the other Imports suites (the harness is J20-B's).
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
    session: { ...session },
    athletes: ATHLETES.map((a) => (leftOut.includes(a[0])
      ? { ...athleteEntry(a), notImported: { code: "left_out_by_coach", message: "You chose to leave this athlete out of this import." }, results: [] }
      : athleteEntry(a))),
    teamAthletesWithoutGpexeRecord: [], anomalies: [],
  };
}
// What the stored preview says about the type (the team's suggestion, or none for an unknown category).
let session = { activityTypeKey: "training_session", activityTypeSource: "team_suggestion", categoryName: "FULL TRAINING" };
const TYPES = [
  { key: "training_session", label: "Full training", ownerScope: "system", active: true },
  { key: "match", label: "Game", ownerScope: "system", active: true },
  { key: "rtp_session", label: "RTP", ownerScope: "system", active: true },
  { key: "testing_session", label: "Testing session", ownerScope: "system", active: false },
];
let typesAnswer = () => ({ status: 200, body: { types: TYPES, canAdd: null } });
let approval = null;
function detailOf(c) {
  return { ...c, athletes: Object.fromEntries(ATHLETES.map(([, aid, name]) => [aid, { name }])), approval, preview: previewOf(approval?.excludedAthleteIds || []) , helperValues: {} };
}
const subsetHashOf = (ids) => `${"b".repeat(60)}${ids.join("").slice(-4).padStart(4, "0")}`;

function server({ teamStatus = {}, candidates = [], onApprove, onSubset } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url === "/api/training-activity/session-types") return typesAnswer();
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
// The real route: a choice is athletes left out, a session type, or both; a body with neither is not a choice review.
const subsetOk = (call) => {
  const ids = call.body.excludedAthleteIds || [];
  const typeKey = call.body.activityTypeKey;
  if (!ids.length && typeKey === undefined) return { status: 400, body: { error: "invalid_body" } };
  const preview = previewOf(ids);
  if (typeKey !== undefined) preview.session = { ...preview.session, activityTypeKey: typeKey, activityTypeSource: "choice" };
  return { status: 200, body: { subset: { excludedAthleteIds: ids, previewHash: HASH, subsetHash: `${subsetHashOf(ids).slice(0, 50)}${String(typeKey ?? "").padEnd(10, "0").slice(0, 10)}`, preview, ...(typeKey !== undefined ? { activityTypeKey: typeKey } : {}) }, importSwitch: { enabled: true } } };
};
const approvals = () => fetchCalls.filter((c) => c.url.endsWith("/approve"));
const subsets = () => fetchCalls.filter((c) => c.url.endsWith("/preview"));
const imported = (call, ids = []) => ({ status: 200, body: { outcome: "imported", commitConfirmation: "confirmed", approval: { id: "ap-1", basis: "team_grant", changesAccepted: 0, excludedAthleteIds: ids, subsetHash: ids.length ? subsetHashOf(ids) : null }, import: { counts: { results: 4, values: 8 } }, candidate: detailOf({ ...row(), status: "imported" }) } });

async function openReview(opts = {}, { unknown = false } = {}) {
  resetState();
  approval = null;
  typesAnswer = () => ({ status: 200, body: { types: TYPES, canAdd: null } });
  session = unknown ? { activityTypeKey: null, activityTypeSource: "none", categoryName: "GYM" }
    : { activityTypeKey: "training_session", activityTypeSource: "team_suggestion", categoryName: "FULL TRAINING" };
  if (unknown && !opts.candidates) opts = { ...opts, candidates: [row({ sessionType: "GYM", approvalBlockers: ["session_type_required"], reasons: [{ code: "session_type_required", count: 1 }], suggestedActivityTypeKey: null })] };
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row()], onSubset: async (call) => subsetOk(call), onApprove: async (call) => imported(call, call.body.excludedAthleteIds || []), ...opts });
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  // The session types are read beside the review (not awaited by the open).
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const pick = (value) => act("training-load-gpexe-session-type", {}, { value });
const typeSelect = (page = html()) => page.match(/<select data-action="training-load-gpexe-session-type"[^>]*>([\s\S]*?)<\/select>/);
const optionsOf = (page = html()) => [...(typeSelect(page)?.[1] || "").matchAll(/<option value="([^"]*)"( selected)?\s*>([^<]*)</g)].map((m) => [m[1], m[3], Boolean(m[2])]);

test("1. the review shows the suggested type in a chooser of the active types, with where it comes from; nothing is sent until it changes, and the plain Import sends no type", async () => {
  await openReview();
  assert.deepEqual(optionsOf(), [["training_session", "Full training", true], ["match", "Game", false], ["rtp_session", "RTP", false]], "active types only; the suggestion selected");
  assert.match(html(), /Suggested for GPEXE &quot;FULL TRAINING&quot;\. Change it if this session was something else\./);
  assert.equal(fetchCalls.filter((c) => c.url === "/api/training-activity/session-types").length, 1);
  assert.equal(subsets().length, 0);
  await pick("training_session");
  assert.equal(subsets().length, 0, "picking the shown type again is no choice");
  await act("training-load-gpexe-approve");
  assert.deepEqual(approvals()[0].body, { previewHash: HASH }, "no choice: the approval as before ST-5");
});

test("2. a changed type is reviewed at once (one request with the type alone), then Import sends the type with the reviewed hash, once", async () => {
  await openReview();
  await pick("match");
  assert.equal(subsets().length, 1);
  assert.deepEqual(subsets()[0].body, { activityTypeKey: "match" });
  let page = html();
  assert.deepEqual(optionsOf(page).find((o) => o[2]), ["match", "Game", true]);
  assert.match(page, /Will be imported as Game\./);
  assert.match(page, /data-action="training-load-gpexe-approve"[^>]*>Import 3 athletes</);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 1);
  assert.deepEqual(Object.keys(approvals()[0].body).sort(), ["activityTypeKey", "previewHash", "subsetHash"], "no excludedAthleteIds for a type alone");
  assert.deepEqual([approvals()[0].body.previewHash, approvals()[0].body.activityTypeKey], [HASH, "match"]);
  assert.match(approvals()[0].body.subsetHash, /match00000$/, "the hash of the reviewed choice");
  // Back to the suggestion: the choice and its review are dropped.
  await openReview();
  await pick("match");
  await pick("training_session");
  assert.equal(gx().detail.typeChoice, null);
  assert.equal(gx().detail.subset, null);
  assert.match(html(), /data-action="training-load-gpexe-approve"[^>]*>Import 3 athletes</);
});

test("3. a session of an unknown category: listed with its step, no Import until a type is chosen, a forced approve sends nothing; the choice imports it", async () => {
  await openReview({}, { unknown: true });
  let page = html();
  assert.deepEqual(optionsOf(page)[0], ["", "Choose...", true]);
  assert.match(page, /OptiMove has no session type for GPEXE &quot;GYM&quot; yet\. After the import, OptiMove suggests your choice for the next session of that kind\./);
  assert.match(page, /Choose the session type above\. Then you can import it\./);
  assert.doesNotMatch(page, /data-action="training-load-gpexe-approve"/);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0, "never sent without a type");
  await pick("rtp_session");
  assert.deepEqual(subsets().at(-1).body, { activityTypeKey: "rtp_session" });
  page = html();
  assert.doesNotMatch(page, /<option value="" selected>/);
  assert.match(page, /data-action="training-load-gpexe-approve"[^>]*>Import 3 athletes</);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().at(-1).body.activityTypeKey, "rtp_session");
  // The list row says what to do.
  await openReview({}, { unknown: true });
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-tab", { tab: "attention" });
  assert.match(html(), /Choose the session type - open it and pick one, then import\./);
});

test("4. a type and athletes left out are one review: nothing is asked until Review, the request carries both, and the approval sends both", async () => {
  await openReview();
  await tick("103");
  await pick("match");
  assert.equal(subsets().length, 0, "with a tick the one Review step covers both");
  assert.match(html(), /data-action="training-load-gpexe-subset-review"[^>]*>Review without them</);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
  await act("training-load-gpexe-subset-review");
  assert.deepEqual(subsets()[0].body, { excludedAthleteIds: ["103"], activityTypeKey: "match" });
  await act("training-load-gpexe-approve");
  assert.deepEqual([approvals()[0].body.excludedAthleteIds, approvals()[0].body.activityTypeKey], [["103"], "match"]);
  // Changing the type after the review makes it stale: Import waits for a new review.
  await openReview();
  await tick("103");
  await act("training-load-gpexe-subset-review");
  await pick("rtp_session");
  assert.doesNotMatch(html(), /data-action="training-load-gpexe-approve"/);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0, "a review made for another type is never approved");
});

test("5. a refused choice says why and offers the step; a type no longer offered is not imported", async () => {
  await openReview({ onSubset: async () => ({ status: 409, body: { error: "session_type_not_offered", message: "x" } }) });
  await pick("match");
  const page = html();
  assert.match(page, /That session type is no longer offered\. Choose another\./);
  assert.match(page, /data-action="training-load-gpexe-subset-review"[^>]*>Try again</);
  assert.doesNotMatch(page, /data-action="training-load-gpexe-approve"/);
  await act("training-load-gpexe-approve");
  assert.equal(approvals().length, 0);
});

test("6. who chooses: only a viewer who may import; a reviewer without the right reads the type as text, and an unknown category as 'Not chosen yet'", async () => {
  await openReview({ teamStatus: { enabled: true, canApprove: false } });
  assert.equal(typeSelect(), null);
  assert.match(html(), /Session type<\/span> <strong>Full training<\/strong>/);
  await pick("match");
  assert.equal(subsets().length, 0, "a forged change from a viewer without the right sends nothing");
  await openReview({ teamStatus: { enabled: true, canApprove: false } }, { unknown: true });
  assert.match(html(), /Session type<\/span> <strong>Not chosen yet<\/strong>/);
});

test("7. the type list could not be read: the review still shows the suggestion, says so and reads again on request", async () => {
  await openReview();
  typesAnswer = () => ({ status: 500, body: { error: "internal_error" } });
  state.trainingLoad.gpexe.sessionTypes = null;
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let page = html();
  assert.match(page, /The session types could not be read\./);
  assert.deepEqual(optionsOf(page), [["training_session", "Training session", true]], "the suggestion stays, named from its key");
  typesAnswer = () => ({ status: 200, body: { types: TYPES, canAdd: null } });
  await act("training-load-gpexe-session-types-again");
  page = html();
  assert.doesNotMatch(page, /could not be read/);
  assert.equal(optionsOf(page).length, 3);
});

test("8. an unconfirmed approval keeps the type it was sent with: the reopened review restores it and reviews it again before any retry", async () => {
  await openReview({ onApprove: async () => ({ status: 503, body: { error: "import_outcome_unknown", message: "x" } }) });
  await pick("match");
  await act("training-load-gpexe-approve");
  assert.equal(gx().uncertain["cand-1"]?.chosenType, "match");
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.equal(gx().detail.typeChoice, "match", "never the suggestion in its place");
  assert.equal(gx().detail.subset, null, "the reviewed hash is not kept");
});

test("9. an imported session shows its type's name from the list, which is read once for it", async () => {
  await openReview({ candidates: [row({ status: "imported", importedAt: "2026-10-07T10:00:00Z" })] });
  session = { activityTypeKey: "match", activityTypeSource: "imported_session", categoryName: "FULL TRAINING" };
  await act("training-load-gpexe-close");
  fetchCalls.length = 0;
  gx().sessionTypes = null;
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fetchCalls.filter((c) => c.method === "GET" && c.url === "/api/training-activity/session-types").length, 1);
  assert.match(html(), /Session type<\/span> <strong>Game<\/strong>/);
});
