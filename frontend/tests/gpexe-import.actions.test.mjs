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
          results: [{ externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "created", values: [{ metricKey: "gpexe_total_distance", label: "TotDist", unit: "m", previous: null, value: 3000, change: "new" }] }],
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
  assert.match(html, /Left out \(1\) - a left-out value is not a zero:/);
  assert.match(html, /<li>Whole session · Bursts \(GPEXE definition not confirmed yet\) - drill details not in GPEXE yet<\/li>/, "each left-out value: level, metric and reason");
  const mainText = html.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
  for (const raw of ["details_not_fetched", "TotDist", "gpexe_total_distance", "gpexe_burst_events"]) assert.ok(!mainText.includes(raw), `${raw} only in Technical details`);
  assert.match(html, /<details class="gpexe-tech">[\s\S]*Distance = TotDist \(gpexe_total_distance\)/);
  assert.match(html, /<td>Distance<\/td><td>3,000 m<\/td>/);
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
    values: [{ metricKey: "gpexe_total_distance", label: "TotDist", unit: "m", previous: 3000, value: 3100, change: "changed" }] }];
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
  assert.match(html, /I accept the 1 change to results that were already imported\./);

  await approve();
  assert.equal(approveCalls().length, 0, "not accepted: nothing sent");
  assert.match(renderTrainingLoadCoachHtml(), /Tick the box to accept those changes, then approve\./);

  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-accept" }, { checked: true }), { renderTrainingLoad: render });
  await approve();
  assert.equal(approveCalls().length, 1);
  assert.deepEqual(approveCalls()[0].body, { previewHash: HASH, acceptChanges: true });
  assert.match(confirmQuestions.at(-1), /It also changes 1 result that was already imported\./);
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /<strong>Imported\.<\/strong> 1 result with values replaced\./);
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
      assert.match(html, /class="gpexe-success" role="status"><p><strong>Already imported\.<\/strong> Nothing more was written\./, "already imported is a success, not a refusal");
      assert.ok(!/class="gpexe-refused"/.test(html));
      assert.ok(!/data-action="training-load-gpexe-approve"/.test(html));
      assert.equal(state.trainingLoad.gpexe.uncertain["cand-1"], undefined, "the outcome is final now");
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
  assert.match(renderTrainingLoadCoachHtml(), /2 sessions in GPEXE: 1 new, 0 changed, 1 unchanged/);
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
  assert.match(html, /<strong>Already imported\.<\/strong> Nothing more was written\./);
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
  await new Promise((resolve) => setImmediate(resolve));
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /class="gpexe-next"[^>]*>Next step: 2 sessions need a decision - open one below\./);
  assert.ok(html.indexOf('class="gpexe-next"') < html.indexOf('class="gpexe-status"'), "the next step comes first");
  const mainScreen = html.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
  assert.ok(!/GPEXE team 980|Reads GPEXE team/.test(mainScreen), "the GPEXE team id is only in Technical details");
  assert.match(html, /<dt>GPEXE team id<\/dt><dd>980<\/dd>/);
  assert.ok(!/candidates/i.test(mainScreen.replace(/data-[a-z-]+="[^"]*"/g, "")), "no 'candidates' jargon");
  assert.match(html, />Check for new sessions</);
  assert.match(html, /<h3>Needs a decision \(2\)<\/h3>/);
  assert.match(html, /<h3>Can't be imported yet \(1\)<\/h3>/);
  assert.match(html, /<h3>Imported \(1\)<\/h3>/);
  assert.match(html, /Training A[\s\S]*Next: review it and approve the import\./);
  assert.match(html, /Training B[\s\S]*Next: review 2 changes to results already imported, then approve\./);
  assert.match(html, /Match C[\s\S]*Next: open it to see why it can&#039;t be imported yet\./);
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
  assert.ok(!/Ask a platform admin to check this import/.test(html), "not after one check");
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-verify" }), { renderTrainingLoad: render });
  assert.match(renderTrainingLoadCoachHtml(), /Still not confirmed after 3 checks\.<\/strong> Ask a platform admin to check this import/);
});

test("blocked sessions: the coach reads why and what to do; the server's message (with GPEXE ids) is only in Technical details", async () => {
  const cases = [
    { code: "unsupported_category", message: 'team_session 8002 category "OFFICIAL MATCH" is not importable in the pilot.', session: { categoryName: "OFFICIAL MATCH" },
      reason: /&quot;OFFICIAL MATCH&quot; sessions are not imported from GPEXE\./, step: /No action needed - it stays out of OptiMove\./ },
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

test("blocked sessions in the list: a session that stays out for good is not a decision and asks for nothing; every other block shows the detail's own step", async () => {
  resetState();
  const blockedCases = {
    "c-match": { code: "unsupported_category", message: 'team_session 8002 category "OFFICIAL MATCH" is not importable in the pilot.', categoryName: "OFFICIAL MATCH" },
    "c-thr": { code: "thresholds_not_valid_for_session", message: "thresholds 1473 do not cover session start." },
    "c-stats": { code: "session_stats_invalid", message: "team_session 8003 has is_stats_valid=false." },
    "c-none": { code: "no_importable_participants", message: "team_session 8004 has no importable athlete." },
    "c-data": { code: "track_missing", message: "track 9005 for athlete 104 was not fetched." },
    "c-conf": { code: "binding_conflict", message: "event bound to a different threshold set." },
  };
  const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } });
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) {
      return { status: 200, body: { candidates: [
        candidateSummary({ id: "c-ok", label: "Training OK" }),
        ...Object.keys(blockedCases).map((id) => candidateSummary({ id, label: `Session ${id}`, status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"], lastSeenAt: "2026-09-18T10:00:00Z" })),
      ] } };
    }
    const m = call.url.match(/\/candidates\/(c-[a-z]+)$/);
    if (m && blockedCases[m[1]]) {
      const k = blockedCases[m[1]];
      const detail = candidateDetail({ summary: { id: m[1], status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"] } });
      return { status: 200, body: { candidate: { ...detail, preview: { ...detail.preview, status: "blocked", blocked: { code: k.code, message: k.message }, session: { categoryName: k.categoryName || null }, athletes: [], teamAthletesWithoutGpexeRecord: [] } } } };
    }
    return base(call);
  });
  await openImports();
  await new Promise((resolve) => setImmediate(resolve));
  let html = renderTrainingLoadCoachHtml();

  // The match: its own collapsed group, badge "Not imported", no call to act.
  assert.match(html, /<h3>Needs a decision \(1\)<\/h3>/, "only the approvable session is a decision");
  assert.match(html, /<summary>Stays out of OptiMove \(1\)<\/summary>/);
  const out = html.slice(html.indexOf("<summary>Stays out of OptiMove"));
  assert.match(out, /Session c-match[\s\S]*Not imported[\s\S]*No action needed - it stays out of OptiMove\./);
  assert.ok(!/fix|Next:/.test(out.slice(0, out.indexOf("</details>"))), "the excluded session asks for nothing");

  // Every other block: "Can't be imported yet", and the row's next step is
  // exactly the detail's "What to do".
  assert.match(html, /<h3>Can't be imported yet \(5\)<\/h3>/);
  assert.match(html, /class="gpexe-next"[^>]*>Next step: 1 session needs a decision/);
  for (const id of ["c-thr", "c-stats", "c-none", "c-data", "c-conf"]) {
    const row = html.slice(html.indexOf(`data-candidate-id="${id}"`), html.indexOf("</button>", html.indexOf(`data-candidate-id="${id}"`)));
    const rowStep = row.match(/<span class="gpexe-candidate-next">Next: ([^<]+)<\/span>/)?.[1];
    assert.ok(rowStep, `${id}: a next step in the list`);
    await openCandidate(id);
    const detailHtml = renderTrainingLoadCoachHtml();
    const detailStep = detailHtml.match(/<strong>What to do:<\/strong> ([^<]+)<\/p>/)?.[1];
    assert.equal(rowStep.toLowerCase(), detailStep.toLowerCase(), `${id}: the list's next step is the detail's step`);
    assert.match(detailHtml, /<strong>Can't be imported yet\.<\/strong>/, id);
    assert.match(detailHtml, /gpexe-detail-meta">\s*<span class="gpexe-badge is-blocked">Can&#039;t be imported yet<\/span>/, `${id}: the review's badge is the list's`);
    assert.ok(!/gpexe-approve-note|Cannot be approved/.test(detailHtml), `${id}: no approve note under a block`);
    await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-close" }), { renderTrainingLoad: render });
  }

  // And the match's detail says the same as its row.
  await openCandidate("c-match");
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /<strong>Not imported\.<\/strong> &quot;OFFICIAL MATCH&quot; sessions are not imported from GPEXE\./);
  assert.match(html, /<strong>What to do:<\/strong> No action needed - it stays out of OptiMove\./);
  assert.match(html, /gpexe-detail-meta">\s*<span class="gpexe-badge is-excluded">Not imported<\/span>/, "the review's badge is the list's");
  assert.ok(!/gpexe-approve-note|Cannot be approved|Blocked - open it/.test(html), "the match asks for nothing");
});

test("when nothing needs a decision but some sessions can't be imported yet, the next-step line says so", async () => {
  resetState();
  const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } });
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) return { status: 200, body: { candidates: [candidateSummary({ id: "c-thr", status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"] })] } };
    if (call.url.endsWith("/candidates/c-thr")) {
      const d = candidateDetail();
      return { status: 200, body: { candidate: { ...d, id: "c-thr", status: "blocked", preview: { ...d.preview, status: "blocked", blocked: { code: "thresholds_missing", message: "x" }, athletes: [] } } } };
    }
    return base(call);
  });
  await openImports();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(renderTrainingLoadCoachHtml(), /class="gpexe-next"[^>]*>Next step: 1 session can&#039;t be imported yet - see what to do below\./);
});

test("after a check ends, a newly blocked session's reason is loaded and painted (not left on 'Loading why...')", async () => {
  resetState();
  let afterCheck = false;
  const base = gpexeServer({
    checks: {
      start: () => ({ status: 202, body: { check: { id: "chk-9", status: "running", window: { from: "2026-09-05", to: "2026-09-18" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }),
      poll: () => { afterCheck = true; return { status: 200, body: { check: { id: "chk-9", status: "succeeded", window: { from: "2026-09-05", to: "2026-09-18" }, finishedAt: "2026-09-18T10:00:00Z", sessionsSeen: 1, candidatesNew: 1, candidatesChanged: 0, candidatesUnchanged: 0, error: null } } }; },
    },
  });
  installFetchMock(async (call) => {
    if (/\/candidates(\?|$)/.test(call.url)) {
      return { status: 200, body: { candidates: afterCheck ? [candidateSummary({ id: "c-m", label: "GPEXE OFFICIAL MATCH", status: "blocked", previewStatus: "blocked", approvalBlockers: ["blocked"] })] : [] } };
    }
    if (call.url.endsWith("/candidates/c-m")) {
      const d = candidateDetail();
      return { status: 200, body: { candidate: { ...d, id: "c-m", status: "blocked", preview: { ...d.preview, status: "blocked", blocked: { code: "unsupported_category", message: "x" }, session: { categoryName: "OFFICIAL MATCH" }, athletes: [] } } } };
    }
    return base(call);
  });
  await openImports();
  // What the coach would see at each paint: the screen must be painted at
  // least once AFTER the reason arrived, or it stays on "Loading why...".
  let paintedWithReason = false;
  const paint = () => { if (/Stays out of OptiMove/.test(renderTrainingLoadCoachHtml())) paintedWithReason = true; };
  await handleTrainingLoadAction(fakeAction({ action: "training-load-gpexe-check" }), { renderTrainingLoad: paint });
  for (let i = 0; i < 20 && !paintedWithReason; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(paintedWithReason, "a paint happened after the blocked reason was loaded");
  assert.ok(fetchCalls.filter((c) => c.url.endsWith("/candidates/c-m")).length === 1, "the reason is read once");
});

// ---------------------------------------------------------------------------
// UX review of F3a (owner decision (b), 2026-09-19): linking an unknown GPEXE
// athlete is two steps with both sides shown, nothing is preselected, the
// session's values only help to find the athlete in GPEXE, and a review made
// before a link change is never approved. An uncertain outcome stays visible.
// ---------------------------------------------------------------------------

// Athlete 104 is not linked; GPEXE recorded a whole-session result and two
// drills for them. Team athletes without a record: Bo Example (ath-2) and
// Dario Example (ath-3, full name "Dario Petrov Example").
function linkDetail() {
  const d = candidateDetail();
  const values = [
    { metricKey: "gpexe_total_distance", label: "TotDist", unit: "m", previous: null, value: 5230, change: "added" },
    { metricKey: "gpexe_max_speed", label: "SPEEDmax", unit: "km/h", previous: null, value: 29.5, change: "added" },
    { metricKey: "gpexe_time_min", label: "TIME", unit: "min", previous: null, value: 74, change: "added" },
  ];
  const a104 = {
    ...d.preview.athletes[1],
    results: [
      { externalId: "athlete_session:4:full", level: "full", drillIndex: null, outcome: "not_imported", values },
      { externalId: "athlete_session:4:drill:0", level: "drill", drillIndex: 0, outcome: "not_imported", values: [] },
      { externalId: "athlete_session:4:drill:1", level: "drill", drillIndex: 1, outcome: "not_imported", values: [] },
    ],
  };
  return {
    ...d,
    athletes: { ...d.athletes, "ath-3": { name: "Dario Petrov Example" } },
    preview: {
      ...d.preview,
      athletes: [d.preview.athletes[0], a104],
      teamAthletesWithoutGpexeRecord: [
        { athleteId: "ath-2", participation: { status: "unknown" }, gps: { status: "no_record", reason: null } },
        { athleteId: "ath-3", participation: { status: "unknown" }, gps: { status: "no_record", reason: null } },
      ],
    },
  };
}

function linkPosts() {
  return fetchCalls.filter((c) => c.url.endsWith("/athlete-links") && c.method === "POST");
}

async function act(action, extra = {}) {
  await handleTrainingLoadAction(fakeAction({ action, ...extra }), { renderTrainingLoad: render });
}

test("link: no athlete is preselected, the session's values only help to find the athlete, and choosing alone sends nothing", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } }, onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) }));
  await openImports();
  await openCandidate();
  let html = renderTrainingLoadCoachHtml();
  const select = html.match(/<select class="gpexe-select" data-gpexe-link-select="104">([\s\S]*?)<\/select>/)[1];
  assert.match(select, /<option value="" selected>Choose an athlete of the team<\/option>/);
  assert.equal((select.match(/selected/g) || []).length, 1, "only the empty choice is selected");
  assert.match(html, /<strong>Find athlete 104 in GPEXE first\. Link only if you are sure\.<\/strong>/);
  assert.match(html, /to help you find them in GPEXE\. The values do not prove who it is\./);
  assert.match(html, /<span>Distance<\/span> <strong>5,230 m<\/strong>/);
  assert.match(html, /<span>Top speed<\/span> <strong>29\.5 km\/h<\/strong>/);
  assert.match(html, /<span>Time<\/span> <strong>74 min<\/strong>/);
  assert.match(html, /<span>Drills<\/span> <strong>2<\/strong>/);
  assert.ok(!/SPEEDmax|TotDist/.test(html.slice(html.indexOf('class="gpexe-link"'), html.indexOf("</ul>", html.indexOf('class="gpexe-link"')))));

  // Pressing "Link..." without a choice: nothing sent.
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  assert.equal(linkPosts().length, 0);
  assert.match(renderTrainingLoadCoachHtml(), /Choose the team athlete first\./);

  // A choice in the picker, then "Link...": still nothing sent - only the
  // confirmation is shown.
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  assert.equal(linkPosts().length, 0, "choosing an athlete does not link");
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /<details class="gpexe-athlete "\s+open>[\s\S]*gpexe-link-confirm/, "the athlete stays open while linking");
  assert.match(html, /data-action="training-load-gpexe-link-cancel"[^>]*>Cancel<\/button>/);
  assert.match(html, /data-action="training-load-gpexe-link-confirm"[^>]*>Confirm link<\/button>/);
});

test("link: the confirmation shows the exact GPEXE id and the athlete's full name together; Cancel sends nothing; Confirm sends exactly that link", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } }, onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) }));
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  let html = renderTrainingLoadCoachHtml();
  assert.match(html, /<p class="gpexe-link-pair"><strong>GPEXE athlete 104<\/strong> → <strong>Dario Petrov Example<\/strong><\/p>/);
  // The consequence covers this session AND every session imported later.
  assert.match(html, /<p>Link GPEXE athlete 104 to Dario Petrov Example\? After you check for new sessions and approve the import, athlete 104(?:'|&#039;)s results in this session, and in every GPEXE session imported later, will be imported as Dario Petrov Example\.<\/p>/);
  assert.match(html, /<p>You can unlink it before an import is approved\. Unlinking doesn(?:'|&#039;)t change results that are already imported: if the link turns out wrong after an import, those results can(?:'|&#039;)t be changed here — contact a platform administrator\.<\/p>/);
  assert.ok(!/Future GPEXE sessions/.test(html), "not only 'future' sessions");
  assert.ok(!/move their results|correct wrongly/.test(html), "no promise of a move or correct function");

  await act("training-load-gpexe-link-cancel");
  assert.equal(linkPosts().length, 0, "Cancel sends nothing");
  html = renderTrainingLoadCoachHtml();
  assert.ok(!/gpexe-link-confirm/.test(html));
  assert.match(html, /data-gpexe-link-select="104"/, "back to the picker");

  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  assert.equal(linkPosts().length, 1);
  assert.deepEqual(linkPosts()[0].body, { gpexeAthleteId: "104", athleteId: "ath-3" });
  assert.equal(confirmQuestions.length, 0, "no browser dialog: the confirmation is in the review");
});

test("link: after linking the old review can't be approved until a new check, and the wrong link can be removed right there", async () => {
  resetState();
  let checked = false;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: { ...linkDetail(), lastSeenAt: checked ? "2026-09-19T10:00:05Z" : "2026-09-18T08:00:00Z" } } }),
    checks: {
      start: () => ({ status: 202, body: { check: { id: "chk-l", status: "running", startedAt: "2026-09-19T10:00:00Z", window: { from: "2026-09-05", to: "2026-09-18" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }),
      poll: () => { checked = true; return { status: 200, body: { check: { id: "chk-l", status: "succeeded", startedAt: "2026-09-19T10:00:00Z", window: { from: "2026-09-05", to: "2026-09-18" }, finishedAt: "2026-09-19T10:00:10Z", sessionsSeen: 1, candidatesNew: 0, candidatesChanged: 1, candidatesUnchanged: 0, error: null } } }; },
    },
  }));
  await openImports();
  await openCandidate();
  assert.match(renderTrainingLoadCoachHtml(), /data-action="training-load-gpexe-approve"/, "approvable before the link");
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");

  let html = renderTrainingLoadCoachHtml();
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "no Approve on a review made before the link");
  assert.match(html, /Athlete links changed after this review was made\.<\/strong> Close it and check for new sessions/);
  assert.match(html, /GPEXE athlete 104 is now linked to Dario Petrov Example\./);
  assert.match(html, /data-action="training-load-gpexe-unlink" data-link-id="link-2"[^>]*>Unlink Dario Petrov Example<\/button>/, "the way back is right there");

  // Even a stray approve action sends nothing.
  await approve();
  assert.equal(approveCalls().length, 0);

  // Closing and reopening the same (old) review does not bring Approve back,
  // and the list says what to do.
  await act("training-load-gpexe-close");
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /class="gpexe-next"[^>]*>Next step: check for new sessions - athlete links changed after a review was made\./);
  assert.match(html, /Next: check for new sessions \(with dates that include [0-9.]+\) - athlete links changed after this review was made\./);
  await openCandidate();
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(renderTrainingLoadCoachHtml()));

  // A check that started after the link: the reviews are current again.
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-check");
  assert.ok(checked);
  await openCandidate();
  assert.match(renderTrainingLoadCoachHtml(), /data-action="training-load-gpexe-approve"/, "approvable again after the new check");
});

test("link: a check that was already running when the link was made does not make the old review approvable", async () => {
  resetState();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }),
    checks: {
      start: () => ({ status: 202, body: { check: { id: "chk-r", status: "running", window: { from: "2026-09-05", to: "2026-09-18" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }),
      poll: async () => { await gate; return { status: 200, body: { check: { id: "chk-r", status: "succeeded", window: { from: "2026-09-05", to: "2026-09-18" }, finishedAt: "2026-09-19T10:00:00Z", sessionsSeen: 1, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 1, error: null } } }; },
    },
  }));
  await openImports();
  const checking = act("training-load-gpexe-check");
  await new Promise((resolve) => setImmediate(resolve));
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  release();
  await checking;
  await openCandidate();
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(renderTrainingLoadCoachHtml()), "the check started before the link");
});

test("unlink from the link notice removes exactly the link just made (after a question) and clears the notice", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } }, onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) }));
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  confirmAnswer = false;
  await act("training-load-gpexe-unlink", { linkId: "link-2" });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/unlink")).length, 0, "declined: nothing sent");
  assert.equal(confirmQuestions.at(-1), "Unlink GPEXE athlete 104 from Dario Petrov Example? In sessions not imported yet, athlete 104 will be left out until linked again. Results already imported stay with Dario Petrov Example; if they are wrong, they can't be changed here — contact a platform administrator.", "the link just made is named even if the link list does not have it yet");
  confirmAnswer = true;
  await act("training-load-gpexe-unlink", { linkId: "link-2" });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-links/link-2/unlink")).length, 1);
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!/is now linked to/.test(html));
  assert.match(html, /The link is removed\. Check for new sessions to update the review\./);
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "an unlink changes the links too");
});

test("uncertain outcome: it stays visible after the review is closed - in the list and when reopened - until a check confirms it", async () => {
  resetState();
  let imported = false;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: candidateDetail(imported ? { summary: { status: "imported", approvalBlockers: ["already_imported"] }, approval: { id: "appr-4", approvedAt: "2026-09-19T10:00:00Z", basis: "team_grant", import: { counts: { created: 4 } } } } : {}) } }),
    onApprove: () => ({ status: 503, body: { error: "import_outcome_unknown", message: "...", verify: { candidateId: "cand-1", approvalId: "appr-4", candidateHref: "/c", approvalHref: "/a" } } }),
    onApproval: () => (imported ? { status: 200, body: { approval: { id: "appr-4", candidateId: "cand-1", approvedAt: "2026-09-19T10:00:00Z", basis: "team_grant" } } } : { status: 404, body: { error: "notFound" } }),
  }));
  await openImports();
  await openCandidate();
  await approve();
  await act("training-load-gpexe-close");
  let html = renderTrainingLoadCoachHtml();
  assert.ok(!state.trainingLoad.gpexe.detail);
  const row = html.slice(html.indexOf('data-candidate-id="cand-1"'), html.indexOf("</button>", html.indexOf('data-candidate-id="cand-1"')));
  assert.match(row, /<span class="gpexe-badge is-unknown">Result not confirmed<\/span>/);
  assert.match(row, /Import result not confirmed yet - open it to check the result\./);
  assert.ok(!/Waiting for approval/.test(row), "not shown as simply waiting");
  assert.match(html, /class="gpexe-next"[^>]*>Next step: check the result of 1 import that could not be confirmed/);

  await openCandidate();
  html = renderTrainingLoadCoachHtml();
  assert.match(html, /We can't tell yet whether this session was imported\./, "reopened: the same uncertain outcome");
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html));
  assert.match(html, /data-action="training-load-gpexe-verify"/);

  imported = true;
  await act("training-load-gpexe-verify");
  assert.match(renderTrainingLoadCoachHtml(), /Checked: the import is in OptiMove\./);
  await act("training-load-gpexe-close");
  html = renderTrainingLoadCoachHtml();
  assert.ok(!/Result not confirmed/.test(html), "confirmed: the mark is gone");
  assert.equal(state.trainingLoad.gpexe.uncertain["cand-1"], undefined);
});

test("check: a refused start says what to do - wrong dates, no GPEXE access, no GPEXE team", async () => {
  const cases = [
    { status: 400, error: "invalid_window", text: /Check the dates: From must not be after To, To must not be in the future, and at most 31 days can be checked at once\./ },
    { status: 503, error: "gpexe_token_missing", text: /OptiMove has no access to GPEXE set up yet\. Ask a platform admin to set it up\./ },
    { status: 409, error: "gpexe_team_not_configured", text: /This team is not connected to a GPEXE team yet\. Ask a platform admin to connect it in Settings &gt; Data sources\./ },
  ];
  for (const k of cases) {
    resetState();
    installFetchMock(gpexeServer({ checks: { start: () => ({ status: k.status, body: { error: k.error, message: "server text" } }) } }));
    await openImports();
    await act("training-load-gpexe-check");
    const html = renderTrainingLoadCoachHtml();
    assert.match(html, k.text, k.error);
    assert.ok(!/Try again in a moment/.test(html.slice(html.indexOf('aria-label="Check GPEXE"'))), `${k.error}: not a generic "try again"`);
  }
});

// ---------------------------------------------------------------------------
// code-reviewer, F3a UX round: staleness is per session (a check only
// refreshes sessions inside its dates), a name shared by two athletes can't be
// confirmed, and a lost link answer closes the confirmation.
// ---------------------------------------------------------------------------

test("link: a check whose dates leave out the session does not make its old review approvable", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    // The session is outside the check's dates: GPEXE does not return it, so
    // its review keeps the lastSeenAt from before the link.
    onCandidate: () => ({ status: 200, body: { candidate: { ...linkDetail(), lastSeenAt: "2026-08-28T08:00:00Z" } } }),
    checks: {
      start: () => ({ status: 202, body: { check: { id: "chk-w", status: "running", startedAt: "2026-09-19T10:00:00Z", window: { from: "2026-09-06", to: "2026-09-19" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }),
      poll: () => ({ status: 200, body: { check: { id: "chk-w", status: "succeeded", startedAt: "2026-09-19T10:00:00Z", window: { from: "2026-09-06", to: "2026-09-19" }, finishedAt: "2026-09-19T10:00:10Z", sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: null } } }),
    },
  }));
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-check");
  assert.equal(state.trainingLoad.gpexe.check.status, "succeeded");
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "the check did not see this session");
  assert.match(html, /Athlete links changed after this review was made\./);
  await approve();
  assert.equal(approveCalls().length, 0);
});

test("link: two team athletes with the same name can't be confirmed without telling them apart", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => { const d = linkDetail(); return { status: 200, body: { candidate: { ...d, athletes: { ...d.athletes, "ath-2": { name: "Dario" }, "ath-3": { name: "Dario" } } } } }; },
  }));
  await openImports();
  await openCandidate();
  assert.match(renderTrainingLoadCoachHtml(), /<option value="ath-3">Dario \(same name as another athlete\)<\/option>/);
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!/gpexe-link-confirm/.test(html), "no confirmation for an ambiguous name");
  assert.match(html, /More than one athlete of the team is called Dario\. Give them different names in Settings &gt; Athletes first, then link\./);
  assert.equal(linkPosts().length, 0);
});

test("link: a lost answer closes the confirmation, treats the links as changed and points to the link list", async () => {
  resetState();
  const base = gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } }, onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) });
  installFetchMock(async (call) => {
    if (call.url.endsWith("/athlete-links") && call.method === "POST") return { status: 502, body: undefined };
    return base(call);
  });
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  const html = renderTrainingLoadCoachHtml();
  assert.ok(!/gpexe-link-confirm/.test(html), "the confirmation is closed");
  assert.match(html, /We can(?:'|&#039;)t tell whether the link was made\. Check the list &quot;GPEXE athletes linked to this team&quot; on the GPEXE imports page, and unlink it there if it is wrong\./);
  assert.ok(!/data-action="training-load-gpexe-approve"/.test(html), "the link may have been made: no Approve on the old review");
});

// ---------------------------------------------------------------------------
// ux-design-reviewer (PR #111 agent), F3a final texts: where the coach is told
// what a link does and that results already imported can't be changed here.
// ---------------------------------------------------------------------------

const ADMIN = "can't be changed here — contact a platform administrator.";

test("approve: a calm note to check the athletes shows when the session imports a linked athlete", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } }));
  await openImports();
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  const approveArea = html.slice(html.indexOf('class="gpexe-approve"'));
  assert.match(approveArea, /<p class="muted gpexe-approve-names">Check that each athlete is the right person\. Results imported under the wrong athlete can(?:'|&#039;)t be changed here — contact a platform administrator\.<\/p>/);
  assert.ok(approveArea.indexOf("gpexe-approve-names") < approveArea.indexOf('data-action="training-load-gpexe-approve"'), "before the Approve button");
  assert.ok(!/gpexe-warning/.test(approveArea.slice(0, approveArea.indexOf("</div>"))), "not styled as a warning");
});

test("approve: no athlete note when no athlete is imported through a link (unlinked or left out)", async () => {
  resetState();
  const d = candidateDetail();
  const leftOut = { ...d.preview.athletes[0], notImported: { code: "athlete_not_in_team", message: "The linked OptiMove athlete is no longer an active member of the team." } };
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { enabled: true } },
    onCandidate: () => ({ status: 200, body: { candidate: { ...d, preview: { ...d.preview, athletes: [leftOut, d.preview.athletes[1]] } } } }),
  }));
  await openImports();
  await openCandidate();
  const html = renderTrainingLoadCoachHtml();
  assert.match(html, /data-action="training-load-gpexe-approve"/);
  assert.ok(!/gpexe-approve-names|Check that each athlete is the right person/.test(html));
});

test("approve: the final question names how many athletes and what is written", async () => {
  resetState();
  confirmAnswer = false;
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: true } } }));
  await openImports();
  await openCandidate();
  await approve();
  assert.equal(confirmQuestions.at(-1), "Import this session for 1 athlete under the names shown? This writes their results and the activity.");
  assert.equal(approveCalls().length, 0);
});

test("unlink: the question names the GPEXE id and the athlete from the link list", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  confirmAnswer = false;
  await act("training-load-gpexe-unlink", { linkId: "link-1" });
  assert.equal(confirmQuestions.at(-1), `Unlink GPEXE athlete 101 from Ana Example? In sessions not imported yet, athlete 101 will be left out until linked again. Results already imported stay with Ana Example; if they are wrong, they ${ADMIN}`);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/unlink")).length, 0, "declined: nothing sent");
  confirmAnswer = true;
  await act("training-load-gpexe-unlink", { linkId: "link-1" });
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-links/link-1/unlink")).length, 1);
});

test("unlink: a link not in the list gets the generic question, and still only that link is sent", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  confirmAnswer = false;
  await act("training-load-gpexe-unlink", { linkId: "link-unknown" });
  assert.equal(confirmQuestions.at(-1), `Unlink this GPEXE athlete? Their next GPEXE sessions will be left out until linked again. Results already imported ${ADMIN}`);
  assert.ok(!/undefined|null/.test(confirmQuestions.at(-1)));
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/unlink")).length, 0);
  confirmAnswer = true;
  await act("training-load-gpexe-unlink", { linkId: "link-unknown" });
  assert.deepEqual(fetchCalls.filter((c) => c.url.endsWith("/unlink")).map((c) => c.url), [`/api/training-load/gpexe/teams/${TEAM_A}/athlete-links/link-unknown/unlink`]);
});

test("texts shown in the review never point to a list 'below' - the link list is behind the dialog", async () => {
  // (a) every team athlete without a record is already linked
  resetState();
  const d = candidateDetail();
  installFetchMock(gpexeServer({ onCandidate: () => ({ status: 200, body: { candidate: d } }) }));
  await openImports();
  state.trainingLoad.gpexe.links = [{ id: "link-9", gpexeAthleteId: "109", athleteId: "ath-2", athleteName: "Bo Example" }];
  await openCandidate();
  let html = renderTrainingLoadCoachHtml();
  assert.match(html, /If athlete 104 is one of them, close this review and check "GPEXE athletes linked to this team"\./);

  // (b) a lost answer to a link and (c) to an unlink
  resetState();
  const base = gpexeServer({ onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) });
  installFetchMock(async (call) => {
    if (call.url.endsWith("/athlete-links") && call.method === "POST") return { status: 502, body: undefined };
    if (call.url.endsWith("/unlink")) return { status: 502, body: undefined };
    return base(call);
  });
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  html = renderTrainingLoadCoachHtml();
  const dialog = () => { const h = renderTrainingLoadCoachHtml(); return h.slice(h.indexOf('class="gpexe-detail-body"')); };
  assert.ok(!/ below/.test(dialog().replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "").replace(/Do the step below/g, "")), "no 'below' in the dialog after a lost link answer");
  await act("training-load-gpexe-unlink", { linkId: "link-1" });
  assert.match(dialog(), /We can(?:'|&#039;)t tell whether the link was removed\. Check the list &quot;GPEXE athletes linked to this team&quot; on the GPEXE imports page\./);
  assert.ok(!/linked to this team&quot; below/.test(renderTrainingLoadCoachHtml()));
});
test("unlink from the link notice names the pair even when the link list could not be read again", async () => {
  resetState();
  let linked = false;
  const base = gpexeServer({ onCandidate: () => ({ status: 200, body: { candidate: linkDetail() } }) });
  installFetchMock(async (call) => {
    if (call.url.endsWith("/athlete-links") && call.method === "POST") { linked = true; return base(call); }
    if (call.url.endsWith("/athlete-links") && call.method === "GET" && linked) return { status: 502, body: undefined };
    return base(call);
  });
  await openImports();
  await openCandidate();
  queried = { "[data-gpexe-link-select='104']": { value: "ath-3" } };
  await act("training-load-gpexe-link", { gpexeAthleteId: "104" });
  await act("training-load-gpexe-link-confirm");
  assert.ok(!state.trainingLoad.gpexe.links.some((l) => l.id === "link-2"), "the list was not read again");
  confirmAnswer = false;
  await act("training-load-gpexe-unlink", { linkId: "link-2" });
  assert.match(confirmQuestions.at(-1), /^Unlink GPEXE athlete 104 from Dario Petrov Example\? /);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/unlink")).length, 0);
});

test("a team with no GPEXE connection points the coach at the tab that actually holds it", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { settings: null } } }));
  await openImports();
  const html = renderTrainingLoadCoachHtml();
  // Both places that name the location, not just the refusal text a check
  // answers with (covered above).
  assert.match(html, /A platform admin connects it in Settings &gt; Data sources\./);
  assert.match(html, /connect this team to its GPEXE team \(Settings &gt; Data sources\)/);
});
