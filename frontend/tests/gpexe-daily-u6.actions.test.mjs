// U6a: the daily Imports screen. One state bar with one main button, problems grouped by reason with one button each, the rest folded,
// the setup guide told the truth about linking, and a long selection that goes on by itself. (Header of the batch suite follows.)
// Imports phase 4b: choosing clean Ready sessions, one confirmation, ONE
// POST /imports for the whole selection, one understandable result per
// session (never "failed" or "nothing imported" for an unconfirmed one), and
// the local sessions calendar built from the candidates list alone. Driven
// through handleTrainingLoadAction with a fake fetch, like the other
// Training Load suites.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
let confirmQuestions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
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

const { handleTrainingLoadAction, confirmLeaveTrainingLoad, handleTrainingLoadBeforeUnload, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, calendarDayKey, calendarToggled, importsUnloadShouldWarn } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: TEAM_B, name: "U19", club_name: "Club" }],
  clubs: [],
  athletes: [{ id: "ath-1", name: "Ana Example", memberships: [{ teamId: TEAM_A, membershipType: "team", status: "active" }] }],
};

function fakeAction(dataset, extra = {}) {
  return { dataset, ...extra };
}

let renders;
function render() {
  renders += 1;
}

function resetState() {
  clearAllViewCache();
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  confirmAnswer = true;
  confirmQuestions = [];
  renders = 0;
}

function status({ enabled = true, canApprove = true } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck: null,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: false },
    approvalAvailable: true,
  };
}

// A clean Ready session as the list returns it (with its preview hash).
function ready(n, overrides = {}) {
  return {
    id: `cand-${n}`, gpexeTeamSessionId: `70${String(n).padStart(2, "0")}`, label: `FULL TRAINING ${n}`, sessionStartedAt: `2026-09-${String(n).padStart(2, "0")}T16:08:12Z`,
    status: "pending", previewStatus: "ready", previewHash: hashOf(n), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2026-10-14T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], lastSeenAt: "2026-09-22T10:00:00Z", ...overrides,
  };
}

function candidateDetail(c) {
  return { ...c, athletes: {}, approval: c.status === "imported" ? { id: `appr-${c.id}`, approvedAt: "2026-09-22T12:00:00Z", basis: "team_grant" } : null, preview: { version: 3, status: "ready", blocked: null, counts: c.counts, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [], unactivatedSourceMetricCount: 0 } };
}

function gpexeServer({ teamStatus = {}, candidates = [], onImports, onCandidate } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus[team] || {}) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates?") || rest === "/candidates") {
      const list = typeof candidates === "function" ? candidates(call, team) : candidates;
      return { status: 200, body: { candidates: team === TEAM_A ? list : [] } };
    }
    if (rest === "/imports" && call.method === "POST") return onImports ? onImports(call, team) : { status: 200, body: { results: [], summary: {} } };
    const detail = rest.match(/^\/candidates\/([^/?]+)$/);
    if (detail) {
      if (onCandidate) return onCandidate(call, detail[1]);
      const list = typeof candidates === "function" ? candidates(call, team) : candidates;
      const c = list.find((x) => x.id === detail[1]);
      return c ? { status: 200, body: { candidate: candidateDetail(c) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}, extra = {}) {
  await handleTrainingLoadAction(fakeAction({ action, ...dataset }, extra), { renderTrainingLoad: render });
}

async function openImports() {
  await act("training-load-section", { section: "imports" });
}

function pick(candidateId, checked = true) {
  return act("training-load-gpexe-pick", { candidateId }, { checked });
}

const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const candidatesReads = () => fetchCalls.filter((c) => c.method === "GET" && /\/candidates(\?|$)/.test(c.url)).length;
const importPosts = () => fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/imports"));
// The batch dialog's markup, when it is open.
function dialog() {
  const page = html();
  const start = page.indexOf('class="panel builder-athlete-picker gpexe-detail imports-batch"');
  assert.ok(start > 0, "the batch dialog is open");
  return page.slice(start);
}
function checkboxes(page = html()) {
  return [...page.matchAll(/<input type="checkbox" data-action="training-load-gpexe-pick" data-candidate-id="([^"]+)"[^>]*>/g)].map((m) => ({ id: m[1], checked: / checked/.test(m[0]), disabled: / disabled/.test(m[0]) }));
}
function result(summary = {}, results = []) {
  return { status: 200, body: { results, summary: { requested: results.length, imported: 0, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0, ...summary } } };
}



test("U6a 1: the state bar says connected / import on or off / last search and has ONE main button; no counts line and no second next-step line", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2)] }));
  await openImports();
  const page = html();
  const bar = page.slice(page.indexOf('class="imports-statusbar"'), page.indexOf("</section>", page.indexOf('class="imports-statusbar"')));
  assert.match(bar, /<strong>GPEXE<\/strong>/);
  assert.match(bar, /imports-state is-on">Connected</);
  assert.match(bar, /imports-state is-on">Import on</);
  assert.match(bar, /No search yet/);
  const primaries = bar.match(/class="primary-button gpexe-button"/g) || [];
  assert.equal(primaries.length, 1, "exactly one primary button");
  assert.match(bar, /class="primary-button gpexe-button" data-action="training-load-gpexe-import-ready" >Import 2 ready</);
  assert.match(bar, /class="plain-button gpexe-button" data-action="training-load-gpexe-check" >Find new sessions</);
  assert.ok(!/Needs you|class="gpexe-next"|imports-daily-counts/.test(page));
  assert.ok(!/Needs attention|imports-attn-group/.test(page), "no problem, no group title and no empty group");
  // Nothing ready: the one main button is the search.
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { enabled: false } }, candidates: [] }));
  await openImports();
  const off = html();
  assert.match(off, /imports-state is-off">Import off</);
  assert.match(off, /class="primary-button gpexe-button" data-action="training-load-gpexe-check" >Find new sessions</);
  assert.ok(!/training-load-gpexe-import-ready/.test(off));
});

test("U6a 5: the administrator's switch controls sit in one folded 'Import settings' card; the main screen keeps only the state; the dates say DD.MM.YYYY", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  gx().teamSwitch = { data: { canManage: true, enabled: false, mode: "pilot", canChangeMode: true, canRecordPrerequisites: true, conditions: [], history: [] }, busy: false, draft: "" };
  const page = html();
  const at = page.indexOf('<details class="gpexe-panel imports-settings"');
  assert.ok(at > 0, "the card is there");
  assert.ok(!/imports-settings"[^>]* open/.test(page.slice(at, at + 80)), "folded by default");
  assert.ok(page.indexOf('aria-label="Imports for this team"') > at, "the panel is inside the card");
  assert.match(page, /<span>From \(DD\.MM\.YYYY\)<\/span>/);
  assert.match(page, /<span>To \(DD\.MM\.YYYY\)<\/span>/);
  assert.ok(!/Linked athletes|GPEXE athletes linked to this team|gpexe-link-list/.test(page), "no list of linked athletes on the daily screen, folded or not");
  assert.match(page, /aria-label="Athlete links"[\s\S]*Link athletes/, "only the way in to the Link athletes screen");
});
