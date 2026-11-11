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
const { setGpexePollDelayForTests, importsChooseToggled } = await import("../gpexe-import-data.js");
const { readFileSync } = await import("node:fs");

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
const tabRow = () => html().match(/<nav class="om-tabs imports-tabs"[\s\S]*?<\/nav>/)?.[0] || "";
const activeTab = () => html().match(/data-imports-tab="(\w+)"/)?.[1];
const unlinked = (n) => ready(n, { reasons: [{ code: "athletes_not_linked", count: 1 }], counts: { created: 2, athletesNotImported: 1 } });

test("IMP1 1: one row of six tabs with counts, in order; one tab's content at a time; a tab sends nothing", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2), unlinked(3)] }));
  await openImports();
  const labels = [...tabRow().matchAll(/data-import-tab="(\w+)">([^<]*)</g)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(labels, ["attention=Needs you (1)", "ready=Ready (2)", "imported=Imported (0)", "out=Stays out (0)", "athletes=Athletes", "search=Search"]);
  assert.equal(activeTab(), "attention", "something needs the coach: Needs you opens first");
  assert.match(tabRow(), /class="om-tab is-active" aria-current="page" data-action="training-load-gpexe-tab" data-import-tab="attention"/);
  assert.ok(html().includes('aria-label="Needs attention"') && !html().includes('aria-label="Ready to import"'), "only the open tab's list is drawn");
  const calls = fetchCalls.length;
  await act("training-load-gpexe-tab", { importTab: "ready" });
  assert.equal(fetchCalls.length, calls, "a tab is local: no request");
  assert.equal(activeTab(), "ready");
  assert.ok(html().includes('aria-label="Ready to import"') && !html().includes('aria-label="Needs attention"'));
  await act("training-load-gpexe-tab", { importTab: "nonsense" });
  assert.equal(activeTab(), "ready", "an unknown tab changes nothing");
});

test("IMP1 2: with nothing that needs the coach Ready opens first; the default is fixed at the first paint, so a search that adds a problem never moves the tab", async () => {
  resetState();
  let list = [ready(1)];
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: () => list }));
  await openImports();
  assert.equal(activeTab(), "ready");
  list = [ready(1), unlinked(2)];
  await act("training-load-gpexe-superseded"); // a reload of the list, as after a search
  await act("training-load-gpexe-superseded");
  assert.match(tabRow(), /Needs you \(1\)/);
  assert.equal(activeTab(), "ready", "the tab stays where it was");
  // Another team starts on its own default.
  await act("training-load-gpexe-team", {}, { value: "bbbbbbbb-0000-4000-8000-000000000002" });
  assert.equal(gx().tab, "", "another team: its own default");
  assert.equal(activeTab(), "ready", "the new team's list is empty: Ready");
  assert.equal(gx().tab, "", "an empty list fixes nothing yet: the first search decides");
});

test("IMP1 3: the banner says what the last search found and has ONE main button, the search; no 'waiting in GPEXE' (OptiMove does not look by itself yet)", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), unlinked(2)] }));
  await openImports();
  const banner = html().slice(html().indexOf('imports-banner'), html().indexOf("</section>", html().indexOf('imports-banner')));
  assert.match(banner, /<p class="imports-facts imports-lastsearch">No search yet · 1 ready · 1 needs you<\/p>/);
  assert.equal((banner.match(/primary-button/g) || []).length + (banner.match(/plain-button gpexe-button" data-action="training-load-gpexe-check"/g) || []).length, 1, "one button");
  assert.doesNotMatch(banner, /waiting in GPEXE|new sessions are waiting/);
  assert.doesNotMatch(banner, /Technical details|does not import anything|Pilot mode/, "no long sentence and no Technical details up front");
});

test("IMP1 4: Ready: the light list with a 'Ready' pill per row, 'Import N ready sessions' under it; the checkboxes wait in 'Choose sessions', which opens itself while sessions are chosen", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2)] }));
  await openImports();
  let page = html();
  assert.equal((page.match(/<span class="imports-row-pill is-ready">Ready<\/span>/g) || []).length, 2);
  const list = page.indexOf('<ul class="gpexe-candidate-list">');
  const button = page.indexOf('data-action="training-load-gpexe-import-ready"');
  assert.ok(list > 0 && button > list, "the Import button is under the list");
  assert.match(page, />Import 2 ready sessions</);
  assert.match(page, /<details class="imports-choose" data-rendered-open="0" >\s*<summary>Choose sessions<\/summary>/);
  assert.doesNotMatch(page, /data-action="training-load-gpexe-pick"/, "no checkbox while 'Choose sessions' is folded");
  const calls = fetchCalls.length;
  importsChooseToggled(true);
  page = html();
  assert.equal((page.match(/data-action="training-load-gpexe-pick"/g) || []).length, 2, "a checkbox per clean Ready session");
  assert.match(page, /imports-choose" data-rendered-open="1" open>/);
  assert.equal(fetchCalls.length, calls, "opening it sends nothing");
  await act("training-load-gpexe-pick", { candidateId: "cand-1" }, { checked: true });
  gx().chooseOpen = null;
  assert.match(html(), /imports-choose" data-rendered-open="1" open>/, "a selection keeps it open");
});

test("IMP1 5: the guide sits above the banner while setup is unfinished, and in the Search tab once set up; 'Search & settings' only for whoever has Import settings", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  gx().guide = gx().guide || {};
  assert.match(tabRow(), /data-import-tab="search">Search</);
  gx().teamSwitch = { data: { canManage: true, enabled: true, mode: "pilot", canChangeMode: true, canRecordPrerequisites: true, conditions: [], history: [] }, busy: false, draft: "" };
  assert.match(tabRow(), /data-import-tab="search">Search &amp; settings</);
  await act("training-load-gpexe-tab", { importTab: "search" });
  const page = html();
  assert.ok(page.indexOf('<details class="gpexe-panel imports-settings"') > page.indexOf('data-imports-tab="search"'), "Import settings is in the tab");
  assert.ok(page.indexOf("<strong>GPEXE</strong>") > page.indexOf('data-imports-tab="search"'), "the source's facts are in the tab");
});

test("IMP1 6: the CSS is coach-side only, its main button fill stays inside Imports, and the panel titles are kept for a screen reader", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("Design IMP1: the Imports screen"), css.indexOf("/* End of design IMP1. */"));
  assert.ok(block.length > 1000);
  // Selector lines (a property line is "  name: value;"; a comment line starts with spaces and words).
  const selectors = block.split("\n").slice(1).filter((l) => /^\s*body:|^\s*\./.test(l) && /[{,]$/.test(l));
  assert.ok(selectors.length > 20);
  for (const sel of selectors) assert.ok(sel.trim().startsWith("body:not(.athlete-mode):not(.login-mode) "), sel);
  assert.match(block, /\.gpexe-imports \.primary-button \{[^}]*background: var\(--accent\);/);
  assert.doesNotMatch(block, /(^|\n)\s*(body:not\(\.athlete-mode\):not\(\.login-mode\) )?\.primary-button\b/, "no bare .primary-button rule");
  assert.match(block, /\.imports-tab-panel \.imports-tab-title \{[^}]*clip: rect\(0 0 0 0\);/);
  assert.match(block, /\.imports-tab-panel \.gpexe-candidate-list > li \{\n  border-bottom: 1px solid var\(--line\);/);
});
