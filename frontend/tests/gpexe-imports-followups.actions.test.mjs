// Imports follow-ups before the first regular import: (1) when a search finishes, the source-athletes list is read
// again, so "Link athletes" and the next step are right without a reload; (2) a session that carries an open reason
// (no linked athlete) is never badged "Up to date" and never says "Nothing new to import". Driven through
// handleTrainingLoadAction with a fake fetch, like the other Imports suites.
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
const SRC = { list: [] };
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
      version: 3, status: c.previewStatus === "no_changes" ? "no_changes" : "ready", blocked: null,
      counts: { created: 4, changesToImported: 0 }, changesToImported: [],
      athletes: [{ gpexeAthleteId: "101", athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false,
        results: [{ externalId: "athlete_session:1:full", level: "full", drillIndex: null, outcome: "created", values: [{ metricDefinitionId: "def-distance", variableScope: "system", label: "Distance", unit: "m", value: "3000", sourceMetricKey: "athlete_session.total_distance", sourceValue: "3000", sourceUnit: "m", previous: null, change: "new" }] }], skippedValues: [] }],
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
const UNLINKED = (n) => ({ gpexeAthleteId: String(200 + n), status: "unlinked", link: null, lastSeen: null, values: { duration: 40, distance: 3000, maxSpeed: 27 } });
const noLinked = (over = {}) => row({ id: "cand-nl", status: "pending", previewStatus: "no_changes", approvalBlockers: [], reasons: [{ code: "no_linked_athlete", count: 1 }], ...over });
const CHECK = { id: "chk-1", status: "running", window: { from: "2026-10-05", to: "2026-10-06" }, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0 };
const DONE = { ...CHECK, status: "succeeded", startedAt: "2026-10-11T10:00:00Z", finishedAt: "2026-10-11T10:01:00Z", sessionsSeen: 1 };

test("1. when a search finishes, the source-athletes list is read again: Link athletes and the next step name the new unlinked GPEXE athletes without a reload", async () => {
  resetState();
  SRC.list = [UNLINKED(1)];
  responder = server({
    teamStatus: { enabled: true, canApprove: true },
    candidates: [row()],
    checks: { start: () => ({ status: 202, body: { check: CHECK } }), poll: () => ({ status: 200, body: { check: DONE } }) },
  });
  await openImports();
  assert.match(html(), /1 GPEXE athlete is not linked/);
  const reads = () => fetchCalls.filter((c) => c.method === "GET" && c.url.endsWith("/source-athletes")).length;
  const before = reads();
  SRC.list = [UNLINKED(1), UNLINKED(2), UNLINKED(3)];
  await act("training-load-gpexe-check");
  assert.ok(reads() > before, "the list was read again after the search");
  assert.match(html(), /3 GPEXE athletes are not linked/, "the next step names the three");
  assert.equal(fetchCalls.filter((c) => c.method !== "GET" && !c.url.endsWith("/checks")).length, 0, "GET only after the search start");
});

test("2. a failed re-read after a search marks the list as possibly out of date (like after a link change); the old list stays", async () => {
  resetState();
  SRC.list = [UNLINKED(1)];
  let fail = false;
  const inner = server({
    teamStatus: { enabled: true, canApprove: true },
    candidates: [row()],
    checks: { start: () => ({ status: 202, body: { check: CHECK } }), poll: () => ({ status: 200, body: { check: DONE } }) },
  });
  responder = (call) => (fail && call.url.endsWith("/source-athletes") ? { status: 503, body: { error: "database_busy" } } : inner(call));
  await openImports();
  fail = true;
  await act("training-load-gpexe-check");
  assert.ok(gx().sourceAthletesError, "the failed read is recorded");
  assert.equal(gx().sourceAthletes.length, 1, "the last list is kept");
});

test("3. a session with an open reason is never 'Up to date' and never 'Nothing new to import': its badge says Needs attention and its review gives the step", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [noLinked()] });
  await openImports();
  assert.equal(inboxBucket(noLinked(), gx()), "attention");
  await openCandidate("cand-nl");
  const review = html();
  assert.doesNotMatch(review, /Up to date</);
  assert.doesNotMatch(review, /Nothing new to import/);
  assert.match(review, /gpexe-badge is-blocked">Needs attention</);
  assert.match(review, /No linked athlete in this session yet - link the athletes under Link athletes/);
  assert.doesNotMatch(review, /training-load-gpexe-approve"/);
});

test("4. a session with nothing to do (no reason) still reads 'Up to date' with its sentence", async () => {
  resetState();
  responder = server({ teamStatus: { enabled: true, canApprove: true }, candidates: [noLinked({ id: "cand-ok", reasons: [] })] });
  await openImports();
  await openCandidate("cand-ok");
  const review = html();
  assert.match(review, /gpexe-badge is-uptodate">Up to date</);
  assert.match(review, /Nothing new to import - no action needed\./);
});
