// GPEXE import from the app, phase F3a: the "GPEXE imports" view in Training
// Load -> Data & Analysis, driven through handleTrainingLoadAction with a
// fake fetch, the same way the other Training Load suites do. It proves what
// the screens send to the F1/F2 routes and how they show each answer - in
// particular that "not imported", "imported" and "outcome unknown" are never
// confused, and that changes to imported results must be accepted first.
import { test } from "node:test";
import assert from "node:assert/strict";

let queried = {};
let confirmAnswer = true;
let confirmQuestions = [];
globalThis.document = {
  querySelector: (sel) => queried[sel] || null,
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);
const ORG = { teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: TEAM_B, name: "U19", club_name: "Club" }], clubs: [], athletes: [] };

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

let renders;
function render() {
  renders += 1;
}

function resetState(workspace = { type: "club", scopeId: "club-1" }) {
  clearAllViewCache();
  state.currentUser = { id: "coach-1", activeWorkspace: workspace };
  state.trainingLoad = emptyTrainingLoadState();
  queried = {};
  confirmAnswer = true;
  confirmQuestions = [];
  renders = 0;
}

function status({ enabled = false, canApprove = true, settings = { gpexeTeamId: "980" } } = {}) {
  return {
    settings,
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck: null,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: false },
    approvalAvailable: true,
  };
}

function candidateSummary(overrides = {}) {
  return {
    id: "cand-1", gpexeTeamSessionId: "7001", label: "FULL TRAINING 14.09.", sessionStartedAt: "2026-09-14T16:08:12Z",
    status: "pending", previewStatus: "ready", counts: { created: 4, athletesNotImported: 1 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2026-10-14T00:00:00Z" }, approvalBlockers: [], ...overrides,
  };
}

function candidateDetail(overrides = {}) {
  const changes = overrides.changes ?? [];
  return {
    ...candidateSummary({ changesToImported: changes.length, ...(overrides.summary || {}) }),
    previewHash: overrides.previewHash ?? HASH,
    athletes: { "ath-1": { name: "Ana Example" }, "ath-2": { name: "Bo Example" } },
    approval: overrides.approval ?? null,
    preview: {
      version: 2, status: "ready", blocked: overrides.blocked ?? null,
      counts: { created: 4, changesToImported: changes.length },
      changesToImported: changes,
      athletes: [
        { gpexeAthleteId: "101", athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
          results: [{ externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "created", values: [{ metricKey: "gpexe_total_distance", label: "Total distance", unit: "m", previous: null, value: 3000, change: "new" }] }],
          skippedValues: [{ metricKey: "gpexe_burst_events", reason: "details_not_fetched" }] },
        { gpexeAthleteId: "104", athleteId: null, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null },
          notImported: { code: "athlete_not_linked", message: "This GPEXE athlete is not linked to an OptiMove athlete of the team." }, blocksSession: false, results: [], skippedValues: [] },
      ],
      teamAthletesWithoutGpexeRecord: [{ athleteId: "ath-2", participation: { status: "unknown" }, gps: { status: "no_record", reason: null } }],
      anomalies: [],
    },
  };
}

// A GPEXE server fake: per-team status/candidates/links, and handlers for
// candidate detail and approve.
function gpexeServer({ onApprove, onCandidate, onApproval, teamStatus = {}, checks } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus[team] || {}) };
    if (rest.startsWith("/candidates?") || rest === "/candidates") return { status: 200, body: { candidates: [candidateSummary({ label: `session of ${team}` })] } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [{ id: "link-1", gpexeAthleteId: "101", athleteId: "ath-1", athleteName: "Ana Example" }] } };
    if (rest === "/athlete-links" && call.method === "POST") return { status: 201, body: { link: { id: "link-2" } } };
    if (/\/athlete-links\/[^/]+\/unlink$/.test(rest)) return { status: 200, body: { ok: true } };
    if (/^\/candidates\/[^/]+\/approve$/.test(rest)) return onApprove(call);
    if (/^\/candidates\/[^/]+$/.test(rest)) return onCandidate ? onCandidate(call) : { status: 200, body: { candidate: candidateDetail() } };
    if (/^\/approvals\/[^/]+$/.test(rest)) return onApproval(call);
    if (rest === "/checks" && call.method === "POST") return checks.start(call);
    if (/^\/checks\/[^/]+$/.test(rest)) return checks.poll(call);
    return { status: 404, body: { error: "notFound" } };
  };
}

async function openImports() {
  await handleTrainingLoadAction(fakeAction({ action: "training-load-section", section: "imports" }), { renderTrainingLoad: render });
}

async function openCandidate(id = "cand-1") {
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-open", candidateId: id }), { renderTrainingLoad: render });
}

async function approve() {
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-approve" }), { renderTrainingLoad: render });
}

function approveCalls() {
  return fetchCalls.filter((c) => c.url.endsWith("/approve"));
}

// ---------------------------------------------------------------------------

test("GPEXE imports: a Data & Analysis sub-tab that loads status, candidates and links for the team, with the server's own switch sentence", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /data-section="imports"[^>]*>GPEXE imports</);
  assert.equal(state.trainingLoad.lastDataAnalysisSection, "imports");
  assert.equal(state.trainingLoad.gpexe.teamId, TEAM_A);
  const urls = fetchCalls.map((c) => c.url);
  for (const path of ["/status", "/candidates", "/athlete-links"]) assert.ok(urls.includes(`/api/training-load/gpexe/teams/${TEAM_A}${path}`), path);
  assert.match(html, /Import writing is off\./);
  assert.match(html, /checks and previews are saved, but no result or activity can be written/);
  assert.ok(!/backup/i.test(html), "the screen never says anything about a backup");
  assert.match(html, /training-load-filter-button[^>]*disabled/, "the shell filter does not apply here");
  assert.match(html, /session of/);
  assert.match(html, /Ana Example/);
});

test("GPEXE imports: in a team workspace only that team is shown; in a club workspace switching team reloads, and an answer for the old team is dropped", async () => {
  resetState({ type: "team", scopeId: TEAM_B });
  installFetchMock(gpexeServer({}));
  await openImports();
  assert.equal(state.trainingLoad.gpexe.teamId, TEAM_B);
  assert.ok(!/<select[^>]*training-load-gpexe-team/.test(renderTrainingLoadCoachHtml()));

  resetState();
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const base = gpexeServer({});
  installFetchMock(async (call) => {
    if (call.url === `/api/training-load/gpexe/teams/${TEAM_A}/status`) await oldGate;
    return base(call);
  });
  const first = openImports();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(renderTrainingLoadCoachHtml(), /<select[^>]*data-action="training-load-gpexe-team"/);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-team" }, { value: TEAM_B }), { renderTrainingLoad: render });
  releaseOld();
  await first;
  assert.equal(state.trainingLoad.gpexe.teamId, TEAM_B);
  assert.equal(state.trainingLoad.gpexe.candidates[0].label, `session of ${TEAM_B}`, "the older team's answer did not paint over the newer one");
});

test("GPEXE imports: the review shows participation and GPS apart, a left-out value is never a zero, and team athletes without a record are listed", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /role="dialog"/);
  assert.match(html, /Participation: recorded by GPEXE · GPS: Measured/);
  assert.match(html, /1 value\(s\) left out: drill details not in GPEXE yet\. A left-out value is not a zero\./);
  assert.ok(!/details_not_fetched/.test(html), "the reason code is not shown to the coach");
  assert.match(html, /GPEXE athlete 104/);
  assert.match(html, /Not imported: This GPEXE athlete is not linked/);
  assert.match(html, /Team athletes without a GPEXE record \(1\)/);
  assert.match(html, /Bo Example/);
  assert.match(html, /3,000 m/);
});

test("approve: changes to imported results are listed, and nothing is sent until they are accepted", async () => {
  resetState();
  const changes = [{ gpexeAthleteId: "101", athleteId: "ath-1", externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "corrected", effect: "replaces_current_values", newVersionBecomesCurrent: true,
    message: "GPEXE reports newer values; the imported values are replaced (the old ones stay in the history).",
    values: [{ metricKey: "gpexe_total_distance", label: "Total distance", unit: "m", previous: 3000, value: 3100, change: "changed" }] }];
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: candidateDetail({ changes }) } }),
    onApprove: () => ({ status: 200, body: { outcome: "imported", commitConfirmation: "confirmed", approval: { id: "appr-1" }, import: { counts: { corrected: 1 } }, candidate: candidateDetail({ changes, summary: { status: "imported" }, approval: { id: "appr-1", approvedAt: "2026-09-18T10:00:00Z", basis: "team_grant", import: { counts: { corrected: 1 } } } }) } }),
  }));
  await openImports();
  await openCandidate();
  let html = renderTrainingLoadCoachHtml();
  assert.match(html, /Changes to results that were already imported \(1\)/);
  assert.match(html, /<th scope="col">Before<\/th>/);
  assert.match(html, /3,000 m<\/td><td>3,100 m/);
  assert.match(html, /I accept the 1 change\(s\)/);

  await approve();
  assert.equal(approveCalls().length, 0, "not accepted: nothing sent");
  assert.match(renderTrainingLoadCoachHtml(), /Tick the box to accept those changes, then approve\./);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-accept" }, { checked: true }), { renderTrainingLoad: render });
  await approve();
  assert.equal(approveCalls().length, 1);
  assert.deepEqual(approveCalls()[0].body, { previewHash: HASH, acceptChanges: true });
  assert.match(confirmQuestions.at(-1), /It also changes 1 result\(s\) that were already imported/);
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /<strong>Imported\.<\/strong> 1 values replaced\./);
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "no second approval offered");
});

test("approve: a declined confirmation sends nothing; without changes no acceptChanges is sent", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onApprove: () => ({ status: 200, body: { outcome: "imported", commitConfirmation: "verified_after_commit_error", approval: { id: "appr-1" }, import: { counts: { created: 4 } }, candidate: null, candidateReadError: { error: "candidate_read_failed", message: "The import was committed; only reading the candidate afterwards failed. Open the candidate again to see it." } } }),
  }));
  await openImports();
  await openCandidate();
  confirmAnswer = false;
  await approve();
  assert.equal(approveCalls().length, 0);
  confirmAnswer = true;
  await approve();
  assert.deepEqual(approveCalls()[0].body, { previewHash: HASH });
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /<strong>Imported\.<\/strong>/);
  assert.match(html, /The database's confirmation did not arrive in time, but the server found the import committed\./);
  assert.match(html, /The import was committed; only reading the candidate afterwards failed/);
});

test("approve: 409 preview_changed says nothing was imported and offers to review again, which reloads the candidate", async () => {
  resetState();
  let detailLoads = 0;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => { detailLoads += 1; return { status: 200, body: { candidate: candidateDetail({ previewHash: detailLoads > 1 ? "b".repeat(64) : HASH }) } }; },
    onApprove: () => ({ status: 409, body: { error: "preview_changed", message: "What this import would do has changed since the preview was made; nothing was imported. Review the candidate again.", reviewAgain: { candidateId: "cand-1", href: "/api/training-load/gpexe/teams/x/candidates/cand-1" } } }),
  }));
  await openImports();
  await openCandidate();
  await approve();
  let html = renderTrainingLoadCoachHtml();
  assert.match(html, /Not imported: the data changed since you opened this session\. Review it again, then approve\./);
  assert.match(html, /<details class="gpexe-tech"><summary>Technical details<\/summary>[\s\S]*preview_changed/, "the code is only in the technical details");
  assert.ok(!/<p>[^<]*preview_changed/.test(html));
  assert.match(html, /data-action="training-load-gpexe-open" data-candidate-id="cand-1">Review again/);
  await openCandidate("cand-1");
  assert.equal(detailLoads, 2);
  assert.equal(state.trainingLoad.gpexe.detail.candidate.previewHash, "b".repeat(64));
  assert.equal(state.trainingLoad.gpexe.detail.outcome, null, "a fresh review, no stale answer");
});

test("approve: after a 503 import_outcome_unknown, approval 404 + candidate pending is only 'not visible yet' - never 'not imported'; a confirmed import is final; approving again never duplicates", async () => {
  const verify = { candidateId: "cand-1", candidateHref: "/c", approvalId: "appr-9", approvalHref: "/a", imported: "...", notImported: "...", retry: "..." };
  for (const scenario of ["pending", "imported"]) {
    resetState();
    let approvals = 0;
    installFetchMock(gpexeServer({
      teamStatus: { [TEAM_A]: { enabled: true } },
      onCandidate: () => ({ status: 200, body: { candidate: candidateDetail((scenario === "imported" && approvals > 0) || approvals > 1 ? { summary: { status: "imported", approvalBlockers: ["already_imported"] }, approval: { id: "appr-9", approvedAt: "2026-09-18T10:00:00Z", basis: "team_grant", import: { counts: { created: 4 } } } } : {}) } }),
      onApprove: () => {
        approvals += 1;
        // The first approval's answer is lost (503); the server imports a
        // candidate only once, so a later approval is refused.
        return approvals === 1
          ? { status: 503, body: { error: "import_outcome_unknown", message: "The database did not confirm the import, and it could not be verified yet.", verify } }
          : { status: 409, body: { error: "already_imported", message: "This candidate has already been imported." } };
      },
      onApproval: () => (scenario === "imported"
        ? { status: 200, body: { approval: { id: "appr-9", candidateId: "cand-1", approvedAt: "2026-09-18T10:00:00Z", basis: "team_grant" } } }
        : { status: 404, body: { error: "notFound" } }),
    }));
    await openImports();
    await openCandidate();
    await approve();
    let html = renderTrainingLoadCoachHtml();
    assert.match(html, /We can't tell yet whether this session was imported\./, scenario);
    const outcomeBlock = html.slice(html.indexOf('class="gpexe-unknown"'));
    assert.ok(!/not imported/i.test(outcomeBlock.slice(0, outcomeBlock.indexOf("</div>"))), "an unknown outcome is never 'not imported'");
    assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "no approve button before the result is checked");
    assert.match(html, /<details class="gpexe-tech">[\s\S]*import_outcome_unknown[\s\S]*appr-9/, "the code and the approval id are in the technical details");
    await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
    assert.ok(fetchCalls.some((c) => c.url.endsWith("/approvals/appr-9")));
    html = renderTrainingLoadCoachHtml();
    if (scenario === "imported") {
      assert.match(html, /<strong>Imported\.<\/strong> Checked: the import is in OptiMove\./);
      assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "a confirmed import is final");
      assert.ok(!/data-action="training-load-gpexe-verify"/.test(html));
    } else {
      assert.equal(state.trainingLoad.gpexe.detail.outcome.verified, "not_visible_yet");
      assert.match(html, /The import is not visible yet; we are still checking the result\./);
      assert.ok(!/it was not imported/i.test(html));
      assert.match(html, /data-action="training-load-gpexe-verify"[^>]*>Check again/);
      // Approving again is offered and safe: here the first approval did
      // commit after all, and the server refuses a second one.
      assert.match(html, /data-action="training-load-gpexe-approve"/);
      await approve();
      assert.equal(approveCalls().length, 2);
      html = renderTrainingLoadCoachHtml();
      assert.match(html, /Already imported - another approval got there first\. Nothing more was written\./);
      assert.ok(!/data-action="training-load-gpexe-approve"/.test(html));
    }
  }
});

test("approve: a coach without the right sees why, and no approve button", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true, canApprove: false } } }));
  await openImports();
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /Approving needs a platform admin or an explicit approver grant/);
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html));
});

test("check now: sends the chosen window, follows the check until it ends, then reloads the candidates", async () => {
  resetState();
  let polls = 0;
  installFetchMock(gpexeServer({
    checks: {
      start: () => ({ status: 202, body: { check: { id: "chk-1", status: "running", window: { from: "2026-09-01", to: "2026-09-14" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }),
      poll: () => {
        polls += 1;
        return { status: 200, body: { check: { id: "chk-1", status: polls < 2 ? "running" : "succeeded", window: { from: "2026-09-01", to: "2026-09-14" }, finishedAt: "2026-09-18T10:00:00Z", sessionsSeen: 2, candidatesNew: 1, candidatesChanged: 0, candidatesUnchanged: 1, error: null } } };
      },
    },
  }));
  await openImports();
  const before = fetchCalls.filter((c) => c.url.includes("/candidates")).length;
  queried = { "[data-gpexe-field='from']": { value: "2026-09-01" }, "[data-gpexe-field='to']": { value: "2026-09-14" } };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-check" }), { renderTrainingLoad: render });
  const start = fetchCalls.find((c) => c.url.endsWith("/checks") && c.method === "POST");
  assert.deepEqual(start.body, { from: "2026-09-01", to: "2026-09-14" });
  assert.equal(polls, 2);
  assert.equal(state.trainingLoad.gpexe.check.status, "succeeded");
  assert.ok(fetchCalls.filter((c) => c.url.includes("/candidates")).length > before, "candidates reloaded after the check");
  assert.match(renderTrainingLoadCoachHtml(), /2 session\(s\): 1 new, 0 changed, 1 unchanged/);
});

test("athlete links: linking takes the athlete chosen in the picker; unlinking asks first", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  await openCandidate();
  assert.match(renderTrainingLoadCoachHtml(), /data-gpexe-link-select="104"[\s\S]*Bo Example/);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-link", gpexeAthleteId: "104" }), { renderTrainingLoad: render });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-links") && c.method === "POST").length, 0, "nothing chosen, nothing sent");
  queried = { "[data-gpexe-link-select='104']": { value: "ath-2" } };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-link", gpexeAthleteId: "104" }), { renderTrainingLoad: render });
  const link = fetchCalls.find((c) => c.url.endsWith("/athlete-links") && c.method === "POST");
  assert.deepEqual(link.body, { gpexeAthleteId: "104", athleteId: "ath-2" });
  assert.match(renderTrainingLoadCoachHtml(), /GPEXE athlete 104 is linked\. Check for new sessions to see it in the review\./);

  confirmAnswer = false;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-unlink", linkId: "link-1" }), { renderTrainingLoad: render });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/unlink")).length, 0);
  confirmAnswer = true;
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-unlink", linkId: "link-1" }), { renderTrainingLoad: render });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/link-1/unlink")).length, 1);
});

test("workspace switch: the GPEXE view starts over, and a check still being followed for the old workspace stops", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  const old = state.trainingLoad.gpexe;
  const oldGeneration = old.generation;
  resetTrainingLoadForWorkspaceChange();
  assert.equal(old.generation, oldGeneration + 1, "the old object's generation is bumped, so its polling stops");
  assert.equal(state.trainingLoad.gpexe.teamId, "");
  assert.equal(state.trainingLoad.gpexe.candidates, null);
});

// ---------------------------------------------------------------------------
// Internal review of F3a (code-reviewer): section loading from app.js, lost
// answers, a check left mid-way, closing while approving, refusal refresh.
// ---------------------------------------------------------------------------

test("entering Training Load or switching workspace while on 'imports' loads GPEXE, never the weekly loader", async () => {
  const { loadTrainingLoadSectionData } = await import("../training-load-actions.js");
  resetState({ type: "team", scopeId: TEAM_B });
  installFetchMock(gpexeServer({}));
  state.trainingLoad.section = "imports";
  resetTrainingLoadForWorkspaceChange();
  await loadTrainingLoadSectionData(state.trainingLoad.section, render);
  assert.ok(fetchCalls.some((c) => c.url === `/api/training-load/gpexe/teams/${TEAM_B}/status`));
  assert.ok(!fetchCalls.some((c) => c.url.startsWith("/api/training-load/weekly")));
  assert.ok(!/No team in this workspace/.test(renderTrainingLoadCoachHtml()));
  // app.js uses the same helper for the tab entry and the workspace switch.
  const { readFileSync } = await import("node:fs");
  const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(appSource, /loadTrainingLoadSectionData\(state\.trainingLoad\.section, renderTrainingLoad\)/);
  assert.ok(!/: loadTrainingLoadWeekly\(state\.trainingLoad\.section/.test(appSource), "no weekly fallback for every other section left in app.js");
});

test("approve: a lost answer (fetch throws) or a 502 without JSON is never 'nothing was imported', and the check reads the candidate", async () => {
  for (const kind of ["throw", "502"]) {
    resetState();
    let approved = false;
    const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } });
    installFetchMock(async (call) => {
      if (call.url.endsWith("/approve")) {
        approved = true;
        if (kind === "throw") throw new TypeError("Failed to fetch");
        return { status: 502, body: undefined };
      }
      if (/\/candidates\/cand-1$/.test(call.url) && approved) {
        return { status: 200, body: { candidate: candidateDetail({ summary: { status: "imported" }, approval: { id: "appr-5", approvedAt: "2026-09-18T10:00:00Z", basis: "team_grant", import: { counts: { created: 4 } } } }) } };
      }
      return base(call);
    });
    await openImports();
    await openCandidate();
    await approve();
    let html = renderTrainingLoadCoachHtml();
    assert.match(html, /We can't tell yet whether this session was imported\./, kind);
    assert.ok(!/Nothing was imported/.test(html), kind);
    assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), kind);
    await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
    assert.ok(!fetchCalls.some((c) => c.url.includes("/approvals/")), "no approval id to read after a lost answer");
    html = renderTrainingLoadCoachHtml();
    assert.match(html, /Checked: the import is in OptiMove\./, kind);
  }
});

test("approve: only a 4xx with a JSON error, or the server's own internal_error, counts as 'nothing was imported'", async () => {
  const { isDefiniteRefusal } = await import("../gpexe-import-data.js");
  assert.equal(isDefiniteRefusal({ status: 409, data: { error: "preview_changed" } }), true);
  assert.equal(isDefiniteRefusal({ status: 403, data: { error: "not_an_approver" } }), true);
  assert.equal(isDefiniteRefusal({ status: 500, data: { error: "internal_error" } }), true);
  assert.equal(isDefiniteRefusal({ status: 500, data: { error: "serverError" } }), false);
  assert.equal(isDefiniteRefusal({ status: 503, data: { error: "import_outcome_unknown" } }), false);
  assert.equal(isDefiniteRefusal({ status: 502, data: null }), false);
  assert.equal(isDefiniteRefusal({ status: 0, data: null }), false);
});

test("check: leaving the tab mid-check and coming back resumes it, and a finished check unlocks Check now", async () => {
  resetState();
  let serverCheck = { id: "chk-1", status: "running", window: { from: "2026-09-05", to: "2026-09-18" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 };
  const base = gpexeServer({
    checks: {
      start: () => ({ status: 202, body: { check: serverCheck } }),
      poll: () => ({ status: 200, body: { check: serverCheck } }),
    },
  });
  installFetchMock(async (call) => {
    if (call.url.endsWith("/status")) return { status: 200, body: { ...status(), lastCheck: serverCheck } };
    return base(call);
  });
  await openImports();
  // During the first wait between polls the coach goes to Overview.
  setGpexePollDelayForTests(async () => { state.trainingLoad.section = "overview"; });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-check" }), { renderTrainingLoad: render });
  setGpexePollDelayForTests(() => Promise.resolve());
  assert.equal(state.trainingLoad.gpexe.check.status, "running", "left while running");
  serverCheck = { ...serverCheck, status: "succeeded", finishedAt: "2026-09-18T10:00:00Z", sessionsSeen: 1, candidatesNew: 1 };
  await openImports();
  assert.equal(state.trainingLoad.gpexe.check.status, "succeeded");
  assert.ok(/data-action="training-load-gpexe-check" >Check for new sessions/.test(renderTrainingLoadCoachHtml()), "the check button is enabled again");
});

test("check: a failed poll does not leave Check now disabled", async () => {
  resetState();
  const running = { id: "chk-2", status: "running", window: { from: "2026-09-05", to: "2026-09-18" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 };
  installFetchMock(gpexeServer({
    checks: { start: () => ({ status: 202, body: { check: running } }), poll: () => ({ status: 500, body: { error: "serverError" } }) },
  }));
  await openImports();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-check" }), { renderTrainingLoad: render });
  assert.ok(/data-action="training-load-gpexe-check" >Check for new sessions/.test(renderTrainingLoadCoachHtml()));
});

test("approve: the dialog cannot be closed while the approval is running, so its answer is never lost", async () => {
  resetState();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onApprove: async () => {
      await gate;
      return { status: 503, body: { error: "import_outcome_unknown", message: "...", verify: { candidateId: "cand-1", approvalId: "appr-7", candidateHref: "/c", approvalHref: "/a" } } };
    },
  }));
  await openImports();
  await openCandidate();
  const approving = approve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(renderTrainingLoadCoachHtml(), /data-action="training-load-gpexe-close"[^>]*disabled/);
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-close" }), { renderTrainingLoad: render });
  assert.ok(state.trainingLoad.gpexe.detail, "still open");
  release();
  await approving;
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /We can't tell yet whether this session was imported\./);
  assert.match(html, /data-action="training-load-gpexe-verify"/);
});

test("approve: a 409 already_imported refreshes the candidate, so no Approve button is left next to the refusal", async () => {
  resetState();
  let refused = false;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: candidateDetail(refused ? { summary: { status: "imported", approvalBlockers: ["already_imported"] }, approval: { id: "appr-1", approvedAt: "2026-09-18T10:00:00Z", basis: "platform_admin", import: { counts: {} } } } : {}) } }),
    onApprove: () => { refused = true; return { status: 409, body: { error: "already_imported", message: "This candidate has already been imported." } }; },
  }));
  await openImports();
  await openCandidate();
  await approve();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /Already imported - another approval got there first\. Nothing more was written\./);
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html));
});

test("dates are shown on the local clock: day and time from the same clock", async () => {
  resetState();
  const utcLate = "2026-09-16T22:30:00Z";
  const local = new Date(utcLate);
  const expected = `${String(local.getDate()).padStart(2, "0")}.${String(local.getMonth() + 1).padStart(2, "0")}.${local.getFullYear()} ${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  const base = gpexeServer({});
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) return { status: 200, body: { candidates: [candidateSummary({ sessionStartedAt: utcLate })] } };
    return base(call);
  });
  await openImports();
  assert.ok(renderTrainingLoadCoachHtml().includes(expected), expected);
});

test("approve: after a lost answer a still-pending candidate is never 'checked: not imported' - the first approval may still be running", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onApprove: () => { throw new TypeError("Failed to fetch"); },
  }));
  await openImports();
  await openCandidate();
  await approve();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!/it was not imported/.test(html), "a single read after a lost answer proves nothing");
  assert.match(html, /The import is not visible yet; we are still checking the result\./);
  assert.match(html, /data-action="training-load-gpexe-approve"/, "approving again is offered: the server refuses a duplicate");
  assert.equal(state.trainingLoad.gpexe.detail.outcome.verified, "not_visible_yet");
});

test("main screen speaks to the coach: check for new sessions, needs a decision, imported, and one next step per session", async () => {
  resetState();
  const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } });
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) {
      return { status: 200, body: { candidates: [
        candidateSummary({ id: "c-new", label: "Training A" }),
        candidateSummary({ id: "c-chg", label: "Training B", changesToImported: 2 }),
        candidateSummary({ id: "c-blk", label: "Match C", status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"] }),
        candidateSummary({ id: "c-imp", label: "Training D", status: "imported", approvalBlockers: ["already_imported"] }),
      ] } };
    }
    return base(call);
  });
  await openImports();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /class="gpexe-next"[^>]*>Next step: 3 session\(s\) need a decision - open one below\./);
  assert.match(html, />Check for new sessions</);
  assert.match(html, /<h3>Needs a decision \(3\)<\/h3>/);
  assert.match(html, /<h3>Imported \(1\)<\/h3>/);
  assert.match(html, /Training A[\s\S]*Next: review it and approve the import\./);
  assert.match(html, /Training B[\s\S]*Next: review 2 change\(s\) to results already imported, then approve\./);
  assert.match(html, /Match C[\s\S]*Next: open it - something must be fixed before it can be imported\./);
  for (const code of ["preview_changed", "changes_need_acceptance", "import_outcome_unknown", "already_imported", "snapshot_expired_check_again"]) {
    assert.ok(!html.includes(code), `no API code on the main screen: ${code}`);
  }
});

test("blocked steps speak to the coach: no field names or runbook paths in the main text, the server's wording only in Technical details", async () => {
  resetState();
  const serverStep = 'Make the OptiMove athlete (previousAthleteId) an active member of the team again, then press "Check now". Or a platform admin undoes the earlier import of this session (docs/runbooks/gpexe-undo-imported-session.md; for a persistent database that needs its own approval first), and the session is checked again.';
  installFetchMock(gpexeServer({
    onCandidate: () => ({ status: 200, body: { candidate: candidateDetail({
      summary: { status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"] },
      blocked: { code: "identities_missing_from_source", message: "Results imported earlier would be left behind.", gpexeAthleteIds: ["101"],
        resolution: [{ gpexeAthleteId: "101", previousAthleteId: "ath-1", cause: "athlete_not_in_team", action: "restore_team_membership", step: serverStep }] },
    }) } }),
  }));
  await openImports();
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  const ol = html.slice(html.indexOf("<ol>"), html.indexOf("</ol>"));
  assert.match(ol, /Make Ana Example an active member of the team again, then check for new sessions\. Or ask a platform admin to undo the earlier import\./);
  assert.ok(!/previousAthleteId|docs\/runbooks|Check now/.test(ol), ol);
  assert.match(html, /Technical details[\s\S]*restore_team_membership: [\s\S]*docs\/runbooks\/gpexe-undo-imported-session\.md/);
});

test("a failed outcome check is listed in Technical details", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onApprove: () => ({ status: 503, body: { error: "import_outcome_unknown", message: "...", verify: { candidateId: "cand-1", approvalId: "appr-3", candidateHref: "/c", approvalHref: "/a" } } }),
    onApproval: () => ({ status: 500, body: { error: "internal_error" } }),
  }));
  await openImports();
  await openCandidate();
  await approve();
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /Still not clear\. Check again in a moment\./);
  assert.match(html, /Technical details[\s\S]*Check error<\/dt><dd>500 internal_error/);
});

test("blocked sessions: the coach reads why and what to do; the server's message (with GPEXE ids) is only in Technical details", async () => {
  const cases = [
    { code: "unsupported_category", message: 'team_session 8002 category "OFFICIAL MATCH" is not importable in the pilot.', session: { categoryName: "OFFICIAL MATCH" },
      reason: /&quot;OFFICIAL MATCH&quot; sessions are not imported from GPEXE\./, step: /Nothing to do - it stays out of OptiMove\./ },
    { code: "thresholds_not_valid_for_session", message: "thresholds 1473 (valid 2025-01-01 – open) do not cover session start 2024-12-01T10:00:00.000Z.",
      reason: /thresholds \(speed and power zones\) are missing or don(?:'|&#039;)t cover this session(?:'|&#039;)s date\./, step: /Check the team thresholds in GPEXE, then check for new sessions\./ },
    { code: "track_missing", message: "track 9005 for athlete 104 was not fetched.",
      reason: /GPEXE sent incomplete or inconsistent data for this session\./, step: /Check for new sessions again later\./ },
    { code: "binding_conflict", message: "event 3f2c... is bound to a different threshold set.",
      reason: /conflicts with data already in OptiMove/, step: /Ask a platform admin to look at it/ },
  ];
  for (const k of cases) {
    resetState();
    installFetchMock(gpexeServer({
      onCandidate: () => ({ status: 200, body: { candidate: { ...candidateDetail({ summary: { status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"], label: "GPEXE OFFICIAL MATCH 2026-09-16T17:00:00" } }),
        preview: { ...candidateDetail().preview, status: "blocked", blocked: { code: k.code, message: k.message }, session: k.session || {}, athletes: [], teamAthletesWithoutGpexeRecord: [] } } } }),
    }));
    await openImports();
    await openCandidate();
    const html = renderTrainingLoadCoachHtml();
    const block = html.slice(html.indexOf('class="gpexe-blocked"'), html.indexOf('<details class="gpexe-tech">', html.indexOf('class="gpexe-blocked"')));
    assert.match(block, k.reason, k.code);
    assert.match(block, k.step, k.code);
    assert.ok(!block.includes(k.message) && !block.includes(k.code), `${k.code}: no server message or code in the main text`);
    assert.ok(html.includes(`<dt>Server message</dt><dd>${k.message.replaceAll('"', "&quot;")}</dd>`), `${k.code}: server message in Technical details`);
    assert.match(html, /aria-label="GPEXE OFFICIAL MATCH"/, "no raw timestamp in the session title");
  }
});

test("an up-to-date session reads as up to date, not as waiting with athletes left out", async () => {
  resetState();
  const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } });
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) return { status: 200, body: { candidates: [candidateSummary({ id: "c-same", label: "Training E", previewStatus: "no_changes", counts: { created: 0, unchanged: 5, athletesNotImported: 3 } })] } };
    return base(call);
  });
  await openImports();
  const html = renderTrainingLoadCoachHtml();
  const group = html.slice(html.indexOf("Up to date - nothing new (1)"));
  assert.match(group, /<span class="gpexe-badge is-uptodate">Up to date<\/span>/);
  assert.match(group, /Nothing new to import - no action needed\./);
  assert.ok(!/left out|Waiting for approval/.test(group.slice(0, group.indexOf("</details>"))));
  assert.match(html, /<h3>Needs a decision \(0\)<\/h3>/);
});
