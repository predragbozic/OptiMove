// U6a-1: the daily Imports screen, presentation part. One state bar (source, connected, import on/off, last search) with ONE main
// button; the administrator's switch controls in a folded "Import settings" card that stays as the person left it; the notes that
// qualify the main button under it; the list of linked athletes only where Link athletes cannot be used. Driven through
// handleTrainingLoadAction with a fake fetch, like the other Training Load suites. (The attention groups and the batch series are
// U6a-2 and U6a-3, with their own tests.)
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

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, importSettingsToggled } = await import("../gpexe-import-data.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";

const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: "bbbbbbbb-0000-4000-8000-000000000002", name: "U19", club_name: "Club" }],
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

function gpexeServer({ teamStatus = {}, candidates = [], onImports, onCandidate, sourcesFail = false, links = [] } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/status") return { status: 200, body: status(teamStatus[team] || {}) };
    if (rest === "/source-athletes" && sourcesFail) return { status: 500, body: { error: "internal_error", message: "" } };
    if (/^\/athlete-links\/[^/]+\/unlink$/.test(rest) && call.method === "POST") return { status: 200, body: { ok: true } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: { duration: "min", distance: "m", maxSpeed: "km/h" }, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links } };
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


const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;





test("U6a-1 1: the state bar says connected / import on or off / last search and has ONE main button; no counts line and no second next-step line", async () => {
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

test("U6a-1 2: the administrator's switch controls sit in one folded 'Import settings' card; the main screen keeps only the state; the date fields carry no format the browser may not show", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  gx().teamSwitch = { data: { canManage: true, enabled: false, mode: "pilot", canChangeMode: true, canRecordPrerequisites: true, conditions: [], history: [] }, busy: false, draft: "" };
  const page = html();
  const at = page.indexOf('<details class="gpexe-panel imports-settings"');
  assert.ok(at > 0, "the card is there");
  assert.ok(!/imports-settings"[^>]* open/.test(page.slice(at, at + 80)), "folded by default");
  assert.ok(page.indexOf('aria-label="Imports for this team"') > at, "the panel is inside the card");
  assert.match(page, /<span>From<\/span><input type="date"/);
  assert.match(page, /<span>To<\/span><input type="date"/);
  assert.ok(!/DD\.MM\.YYYY/.test(page), "a native date field shows the browser's own format, so no label promises another");
  assert.ok(!/Linked athletes|GPEXE athletes linked to this team|gpexe-link-list/.test(page), "no list of linked athletes on the daily screen, folded or not");
  assert.match(page, /aria-label="Athlete links"[\s\S]*<h3>GPEXE athletes<\/h3>[\s\S]*Link athletes/, "only the way in to the Link athletes screen");
});

test("U6a-1 3: the Import settings card stays as the person left it across repaints, and opens itself on an error, a notice or while busy", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  gx().teamSwitch = { data: { canManage: true, enabled: true, mode: "pilot", canChangeMode: true, canRecordPrerequisites: true, conditions: [], history: [] }, busy: false, draft: "" };
  const card = () => html().match(/<details class="gpexe-panel imports-settings"[^>]*>/)[0];
  assert.doesNotMatch(card(), / open>/, "folded by default");
  importSettingsToggled(true);
  assert.match(card(), /data-rendered-open="1" open>/, "opened by the person");
  await openImports();
  gx().teamSwitch = { data: { canManage: true, enabled: true, mode: "pilot", canChangeMode: true, canRecordPrerequisites: true, conditions: [], history: [] }, busy: false, draft: "" };
  assert.match(card(), / open>/, "still open after a repaint and a reload of Imports");
  importSettingsToggled(false);
  assert.doesNotMatch(card(), / open>/);
  for (const extra of [{ error: { status: 400, code: "invalid_request" } }, { notice: "Saved." }, { busy: true }]) {
    Object.assign(gx().teamSwitch, { error: null, notice: "", busy: false }, extra);
    assert.match(card(), / open>/, `opens itself: ${Object.keys(extra)[0]}`);
  }
});

test("U6a-1 4: while the GPEXE athletes read has failed, Link athletes is off and the links are listed here with Unlink, which works", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)], sourcesFail: true, links: [{ id: "link-1", gpexeAthleteId: "101", athleteId: "ath-1", athleteName: "Ana Example" }] }));
  await openImports();
  const page = html();
  assert.match(page, /data-action="training-load-gpexe-map-open" disabled/, "Link athletes is off");
  assert.match(page, /The sessions, the search and the links below still work\./);
  assert.match(page, /data-action="training-load-gpexe-unlink" data-link-id="link-1" >Unlink</, "an enabled Unlink for the link");
  await act("training-load-gpexe-unlink", { linkId: "link-1" });
  assert.equal(fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/athlete-links/link-1/unlink")).length, 1);
  // With the read working, the list is not on the daily page (it is on Link athletes).
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)], links: [{ id: "link-1", gpexeAthleteId: "101", athleteId: "ath-1", athleteName: "Ana Example" }] }));
  await openImports();
  assert.ok(!/data-action="training-load-gpexe-unlink"/.test(html()));
});

test("U6a-1 5: the notes of the main button sit right under it; with a day filtered and more than 50 ready, no note says all of them are imported; the review-only reason is said once", async () => {
  resetState();
  const many = Array.from({ length: 51 }, (_, i) => ready(i + 1, { sessionStartedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T16:08:12Z`, gpexeTeamSessionId: `9${String(i + 1).padStart(3, "0")}` }));
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: many }));
  await openImports();
  await act("training-load-gpexe-cal-day", { day: "2026-09-01" });
  const page = html();
  assert.match(page, />Import first 50 ready</);
  assert.ok(!/imports all 51/.test(page));
  assert.match(page, /Import first 50 ready takes ready sessions of every date, not only of the day you picked\./);
  assert.match(page, /1 more session stays for the next batch\./);
  const bar = page.indexOf('class="imports-statusbar"');
  const notes = page.indexOf('class="imports-daily"');
  assert.ok(bar < notes && notes < page.indexOf('class="muted imports-found"'), "the notes follow the button, inside the source card");
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { canApprove: false } }, candidates: [ready(1)] }));
  await openImports();
  const ro = html();
  assert.equal((ro.match(/[Aa]n approver imports these/g) || []).length, 1, "the review-only reason appears once");
  // A day filter on a day without a ready session never hides the reason (it is read from the whole list).
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { canApprove: false } }, candidates: [ready(1), ready(2, { previewStatus: "blocked", status: "blocked", blockedCode: "mixed_timezones" })] }));
  await openImports();
  await act("training-load-gpexe-cal-day", { day: "2026-09-02" });
  assert.equal((html().match(/[Aa]n approver imports these/g) || []).length, 1, "said once, with the day filtered");
});
