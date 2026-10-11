// The Imports screen after v33 (PR #153, the pre-import safety package): a
// candidate the last successful search did not confirm (the server's one
// word, approvalBlockers "not_confirmed_for_import") is never Ready to
// import and has no approval; a candidate withdrawn by a complete, successful
// search (superseded_by_check_id) says so and never looks new or ready; a
// replaced version stays hidden; the refusal candidate_not_actionable reads
// as one sentence; an administrator reads the two possible causes, a coach
// the one step, neither a code; a check that fails or whose answer is lost
// changes nothing of what is shown; no GPEXE id outside Technical details.
// Driven through handleTrainingLoadAction with a fake fetch, like the other
// Imports suites.
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
const { setGpexePollDelayForTests, inboxBucket, batchSelectable, candidateGroup, notConfirmedForImport, withdrawnByCheck, calendarDayKey } = await import("../gpexe-import-data.js");

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
const notConfirmed = (over = {}) => row({ id: "cand-nc", approvalBlockers: ["not_confirmed_for_import"], ...over });
const withdrawn = (over = {}) => row({ id: "cand-wd", status: "superseded", supersededByCheckId: "chk-withdrawer", approvalBlockers: ["not_confirmed_for_import"], ...over });
const replaced = (over = {}) => row({ id: "cand-old", status: "superseded", supersededByCandidateId: "cand-1", approvalBlockers: ["superseded_by_newer_data"], ...over });

function detailOf(c) {
  return {
    ...c,
    athletes: { "ath-1": { name: "Ana Example" } },
    approval: null,
    preview: {
      version: 2, status: c.previewStatus === "no_changes" ? "no_changes" : "ready", blocked: null,
      counts: { created: 4, changesToImported: 0 }, changesToImported: [],
      athletes: [{ gpexeAthleteId: "101", athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
        results: [{ externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "created", values: [{ metricKey: "gpexe_total_distance", label: "TotDist", unit: "m", previous: null, value: 3000 }] }], skippedValues: [] }],
      teamAthletesWithoutGpexeRecord: [], anomalies: [],
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
    if (rest === "/source-athletes") return { status: 200, body: { athletes: LINKED, units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
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
const readySection = (page = html()) => section(page, "Ready to import");
const attentionSection = (page = html()) => section(page, "Needs attention");
const checkboxes = (page = html()) => [...page.matchAll(/data-action="training-load-gpexe-pick" data-candidate-id="([^"]+)"/g)].map((m) => m[1]);
// The page with every closed Technical details block cut out.
const outsideTech = (page) => page.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
const CODES = /not_observed|not_confirmed_for_import|candidate_not_actionable|drill_parameter|superseded_by_check|superseded_by_candidate|last_seen/;
const COACH_STEP = (day) => new RegExp(`Find new sessions again \\(with dates that include ${day}\\), then review it\\.`);
const COACH_NOTE = (day) => new RegExp(`Not confirmed for import yet\\. Find new sessions again \\(with dates that include ${day}\\), then review it\\.`);
const ADMIN_CAUSES = "no successful search has confirmed this session yet, or GPEXE returned drill data for fewer than two of its drills, so OptiMove could not confirm its drill results";
const ADMIN_STEP_TAIL = "\\. If it stays like this, check in GPEXE that the session(?:'|&#039;)s drills are set up and have data\\.";
const ADMIN_WORDS = /fewer than two|successful search has confirmed|drills are set up|could not confirm its drill results/;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayLabel = (iso) => { const [y, m, d] = calendarDayKey(iso).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

// ---------------------------------------------------------------------------
test("1. Ready to import: a pending session the last successful search did not confirm is listed under Needs attention with the one step, never under Ready, with no checkbox even when the switch is on and the viewer may approve", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row(), notConfirmed({ label: "FULL TRAINING 06.10.", sessionStartedAt: "2026-10-06T16:08:12Z" })] });
  await openImports();
  const page = html();
  assert.match(readySection(page), /Ready to import \(1\)/);
  assert.ok(readySection(page).includes('data-candidate-id="cand-1"') && !readySection(page).includes('data-candidate-id="cand-nc"'), "the unconfirmed session is not in Ready");
  assert.match(attentionSection(page), /Needs attention \(1\)/);
  assert.ok(attentionSection(page).includes('data-candidate-id="cand-nc"'));
  assert.match(attentionSection(page), COACH_STEP("06.10.2026"), "the row names the action and the dates; its badge says the status");
  assert.doesNotMatch(attentionSection(page), /Not confirmed for import yet\./, "the row does not repeat the badge");
  assert.match(attentionSection(page), /gpexe-badge is-pending">Not confirmed for import</, "not 'Waiting for approval'");
  // The dates are pre-filled for the session that needs finding again (as for an expired one).
  assert.match(page, /The dates are set to include the sessions that need finding again \(06\.10\.2026\)\./);
  assert.match(page, /value="2026-10-06"/);
  assert.deepEqual(checkboxes(page), ["cand-1"], "no checkbox for the unconfirmed session");
  assert.equal(inboxBucket(notConfirmed(), gx()), "attention");
  assert.equal(batchSelectable(notConfirmed(), gx()), false);
  assert.equal(batchSelectable(row(), gx()), true);
  await act("training-load-gpexe-batch-select");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1"], "Select all never takes the unconfirmed session");
  assert.doesNotMatch(outsideTech(page), CODES, "no code on the page");
});

test("2. not observed: the same word on a session that would otherwise read 'up to date' makes it Needs attention, not Imported; its review carries the badge and the sentence, no 'Nothing new to import' and no Approve button", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [notConfirmed({ previewStatus: "no_changes", counts: { created: 0, unchanged: 4 } })] });
  await openImports();
  const page = html();
  assert.match(attentionSection(page), /Needs attention \(1\)/);
  assert.doesNotMatch(section(page, "Imported"), /cand-nc/);
  assert.doesNotMatch(page, /Nothing new to import/);
  await openCandidate("cand-nc");
  const review = html();
  assert.match(review, /role="dialog"/);
  assert.match(review, /gpexe-badge is-pending">Not confirmed for import</);
  assert.doesNotMatch(review, /Up to date</);
  assert.match(review, COACH_NOTE("05.10.2026"));
  assert.doesNotMatch(review, /training-load-gpexe-approve"/, "no approval");
  assert.doesNotMatch(review, /Nothing new to import/);
  assert.doesNotMatch(outsideTech(review), CODES);
});

test("3. candidate_not_actionable: a refused approval reads as one sentence and nothing is shown as imported; in a batch the refused session reads the same with Open and is never counted as imported", async () => {
  resetState();
  let approvePosts = 0;
  responder = server({
    teamStatus: { enabled: true, canApprove: true },
    candidates: [row()],
    onApprove: () => { approvePosts += 1; return { status: 409, body: { error: "candidate_not_actionable", message: "This session is not confirmed for import yet; find new sessions again." } }; },
    onImports: (call) => ({ status: 200, body: { results: call.body.candidateIds.map((candidateId) => ({ candidateId, outcome: "refused", code: "candidate_not_actionable", approvalId: null })), summary: { requested: 1, imported: 0, alreadyImported: 0, refused: 1, unknown: 0, notAttempted: 0 } } }),
  });
  await openImports();
  await openCandidate("cand-1");
  await act("training-load-gpexe-approve");
  assert.equal(approvePosts, 1);
  const review = html();
  assert.match(review, /Not imported: this session is not confirmed for import\. Find new sessions again, then review it\./);
  assert.doesNotMatch(review, /gpexe-badge is-imported/);
  assert.doesNotMatch(review, /newer data/);
  assert.doesNotMatch(outsideTech(review), CODES);
  // The batch path.
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-pick", { candidateId: "cand-1" }, { checked: true });
  await act("training-load-gpexe-batch-review");
  await act("training-load-gpexe-batch-send");
  const batch = html();
  assert.match(batch, /Not imported: this session is not confirmed for import - find new sessions again, then review it\./);
  assert.match(batch, />Open</);
  assert.doesNotMatch(batch, /1 imported/);
  assert.doesNotMatch(outsideTech(batch), CODES);
});

test("4. a withdrawn session (superseded by a complete, successful search) is never Ready, new or Needs attention: the default read asks for no superseded row, so it is listed only after 'Show replaced or no longer found versions' as 'No longer found' with the sentence; its review says the same and has no approval and no 'newer data'; the calendar does not count it", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row(), withdrawn({ label: "FULL TRAINING 06.10.", sessionStartedAt: "2026-10-06T16:08:12Z" })] });
  await openImports();
  let page = html();
  assert.equal(candidateGroup(withdrawn(), gx()), "withdrawn");
  assert.equal(inboxBucket(withdrawn(), gx()), "hidden");
  assert.ok(withdrawnByCheck(withdrawn()) && !withdrawnByCheck(replaced()));
  assert.doesNotMatch(readySection(page), /cand-wd/);
  assert.equal(attentionSection(page), "", "no attention bucket at all");
  assert.doesNotMatch(page, /cand-wd/, "hidden until the switch");
  assert.match(page, new RegExp(`${dayLabel("2026-10-05T16:08:12Z")}, 1 session found`), "the published session's day is marked");
  assert.match(page, new RegExp(`${dayLabel("2026-10-06T16:08:12Z")}, nothing found yet`), "the withdrawn session's day is not counted");
  assert.match(page, /Show replaced or no longer found versions</, "the toggle names the section");
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/candidates")) && !fetchCalls.some((c) => c.url.includes("includeSuperseded")), "the default read asks for no superseded row");
  await act("training-load-gpexe-superseded");
  page = html();
  assert.ok(fetchCalls.some((c) => c.url.endsWith("/candidates?includeSuperseded=true")), "the switch reads the superseded rows");
  assert.match(page, /Replaced or no longer found versions \(1\)/);
  assert.match(page, /gpexe-badge is-superseded">No longer found</);
  assert.match(page, /The last successful search no longer found this session in GPEXE, so it can(?:'|&#039;)t be imported\. If it is back in GPEXE, find new sessions again \(with dates that include 06\.10\.2026\)\./);
  assert.doesNotMatch(page, /newer data/);
  await openCandidate("cand-wd");
  const review = html();
  assert.match(review, /gpexe-badge is-superseded">No longer found</);
  assert.match(review, /The last successful search no longer found this session in GPEXE/);
  assert.doesNotMatch(review, /training-load-gpexe-approve"/);
  assert.doesNotMatch(review, /newer data|Open the newer version|Waiting for approval/);
  assert.doesNotMatch(outsideTech(review), CODES);
});

test("5. a replaced version (superseded by newer content) stays as before: hidden, 'Replaced', 'GPEXE has newer data' - and never Ready or new", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [row(), replaced({ label: "FULL TRAINING 05.10. (older)" })] });
  await openImports();
  let page = html();
  assert.doesNotMatch(page, /cand-old/);
  assert.match(readySection(page), /Ready to import \(1\)/);
  await act("training-load-gpexe-superseded");
  page = html();
  assert.match(page, /gpexe-badge is-superseded">Replaced</);
  assert.doesNotMatch(page, /No longer found/);
  await openCandidate("cand-old");
  const review = html();
  assert.match(review, /GPEXE has newer data for this session\. Open the newer version\./);
  assert.doesNotMatch(review, /training-load-gpexe-approve"/);
  assert.doesNotMatch(review, /No longer found/);
});

test("6. administrator against coach: an administrator reads the two possible causes, a coach the one step; neither reads a code, a proof or the other's sentence", async () => {
  for (const admin of [false, true]) {
    resetState();
    responder = server({ teamStatus: { enabled: false, canApprove: true, admin }, candidates: [notConfirmed()] });
    await openImports();
    const page = html();
    const ADMIN_NOTE = new RegExp(`Not confirmed for import: ${ADMIN_CAUSES}\\. Find new sessions again \\(with dates that include 05\\.10\\.2026\\)${ADMIN_STEP_TAIL}`);
    // The row names the action alone for everyone; the causes wait in the administrator's review note.
    assert.match(attentionSection(page), COACH_STEP("05.10.2026"));
    assert.doesNotMatch(page, ADMIN_WORDS, "no cause in the list, for anyone");
    assert.doesNotMatch(page, /separate drills|computed/);
    await openCandidate("cand-nc");
    const review = html();
    if (admin) { assert.match(review, ADMIN_NOTE); assert.doesNotMatch(review, /separate drills|computed|completed search/); }
    else { assert.match(review, COACH_NOTE("05.10.2026")); assert.doesNotMatch(review, ADMIN_WORDS); }
    assert.doesNotMatch(outsideTech(review), CODES, "no code for anyone");
    assert.doesNotMatch(outsideTech(review), /fingerprint|staging|finaliz/i);
  }
});

test("7. a search that fails, and one whose answer is lost, change nothing of what is shown: the Ready session stays Ready with its checkbox, the list is read again (GET only) and shows the same rows; only the search's own box reports the failure", async () => {
  resetState();
  const list = [row(), notConfirmed({ label: "FULL TRAINING 06.10.", sessionStartedAt: "2026-10-06T16:08:12Z" })];
  let pollAnswer = { status: 200, body: { check: { id: "chk-1", status: "failed", window: { from: "2026-10-05", to: "2026-10-06" }, startedAt: "2026-10-11T10:00:00Z", finishedAt: "2026-10-11T10:01:00Z", sessionsSeen: 1, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 1, error: { code: "drill_set_incomplete", message: "The source did not answer every drill of a session; that session was not recorded and the check stopped." } } } };
  responder = server({
    teamStatus: { enabled: true, canApprove: true },
    candidates: list,
    checks: { start: () => ({ status: 202, body: { check: { id: "chk-1", status: "running", window: { from: "2026-10-05", to: "2026-10-06" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 } } }), poll: () => pollAnswer },
  });
  await openImports();
  await act("training-load-gpexe-pick", { candidateId: "cand-1" }, { checked: true });
  const before = readySection();
  const attentionBefore = attentionSection();
  const writes = () => fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/checks"));
  await act("training-load-gpexe-check");
  const afterFailed = html();
  assert.match(afterFailed, /did not finish|could not|stopped/i, "the search's own box reports it");
  assert.equal(readySection(afterFailed), before, "the Ready section is unchanged");
  assert.equal(attentionSection(afterFailed), attentionBefore, "the attention section is unchanged");
  assert.deepEqual(Object.keys(gx().batch.selected), ["cand-1"], "the selection stays");
  assert.equal(writes().length, 0, "nothing but the one check start was sent");
  // The answer to the poll is lost.
  pollAnswer = { status: 500, body: { error: "internal_error" } };
  await act("training-load-gpexe-check");
  const afterLost = html();
  assert.equal(readySection(afterLost), before);
  assert.equal(attentionSection(afterLost), attentionBefore);
  assert.equal(writes().length, 0);
  assert.doesNotMatch(outsideTech(afterLost), CODES);
});

test("8. no GPEXE id outside Technical details: the session id of an unconfirmed, a withdrawn and a replaced row appears in no list row, badge, sentence, review heading or note", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true, admin: true }, candidates: [notConfirmed({ label: null }), withdrawn({ id: "cand-wd" }), replaced({ id: "cand-old" })] });
  await openImports();
  await act("training-load-gpexe-superseded");
  assert.ok(!outsideTech(html()).includes(MARKER_SESSION), "the list");
  assert.match(html(), />GPEXE session</, "a label-less session is titled without its id");
  for (const id of ["cand-nc", "cand-wd", "cand-old"]) {
    await openCandidate(id);
    assert.ok(!outsideTech(html()).includes(MARKER_SESSION), `the review of ${id}`);
    await act("training-load-gpexe-close");
  }
});

test("9. the approve handler never sends an approval for a not-confirmed or withdrawn review, even when a stale review still holds one; a summary without the server's blockers is read as not confirmed (fail-closed)", async () => {
  resetState();
  let posts = 0;
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [notConfirmed(), withdrawn()], onApprove: () => { posts += 1; return { status: 409, body: { error: "candidate_not_actionable" } }; } });
  await openImports();
  for (const id of ["cand-nc", "cand-wd"]) {
    await openCandidate(id);
    await act("training-load-gpexe-approve");
    assert.equal(posts, 0, `${id}: nothing sent`);
    await act("training-load-gpexe-close");
  }
  assert.equal(notConfirmedForImport(row({ approvalBlockers: undefined })), true, "no blockers field: not confirmed");
  assert.equal(inboxBucket(row({ approvalBlockers: undefined }), gx()), "attention");
});

test("10. the source card's 'listed below' line counts the visible rows only: with nothing but a withdrawn session (not listed by the default read) and no recorded search it says 'No sessions found yet', never 'listed below' - and the same once the superseded rows are shown", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: false, canApprove: true }, candidates: [withdrawn()] });
  await openImports();
  let page = html();
  assert.match(page, /No sessions found yet\./);
  assert.doesNotMatch(page, /are listed below/);
  await act("training-load-gpexe-superseded");
  page = html();
  assert.match(page, /No sessions found yet\./, "a hidden version is not a found session");
  assert.match(page, /Replaced or no longer found versions \(1\)/);
});
