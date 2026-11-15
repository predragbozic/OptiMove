// Imports P4c (owner, 2026-11-15): a coach and a club admin get no Imported or Stays out list - those sessions live in
// the calendar (✓ and a grey – mark, the chosen days' list opening each review). One quiet line counts the month the
// calendar shows; a full list read says older sessions may not be shown. A platform admin keeps the tabs.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

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
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
const period = await import("../gpexe-period-data.js");
const { bindPeriodDrag, takePeriodDragClick } = await import("../gpexe-period-drag.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG = { teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }], clubs: [], athletes: [] };
const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const two = (n) => String(n).padStart(2, "0");
const localIso = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const TODAY = localIso(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return localIso(d); };
// Fixed past days in one month: the previous month's 10th to 14th.
const PREV = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return localIso(d).slice(0, 7); })();
const prevDay = (n) => `${PREV}-${two(n)}`;
// A session at noon UTC on a day: the day the server searches it under (sessionDay).
const at = (day, hour = 12) => `${day}T${two(hour)}:00:00Z`;

function row(n, day, overrides = {}) {
  return {
    id: `cand-${n}`, gpexeTeamSessionId: `70${two(n)}`, label: `FULL TRAINING ${n}`, sessionStartedAt: at(day, 8 + (n % 10)),
    status: "pending", previewStatus: "ready", previewHash: hashOf(n), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2099-01-01T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], lastSeenAt: at(day), ...overrides,
  };
}
const needs = (n, day) => row(n, day, { counts: { created: 4, athletesNotImported: 2 }, reasons: [{ code: "athletes_not_linked", count: 2 }] });
const imported = (n, day) => row(n, day, { status: "imported", importedAt: at(day) });
const staysOut = (n, day) => row(n, day, { previewStatus: "blocked", status: "blocked", blockedCode: "unsupported_session_type" });

let platform = false;
function status({ lastSucceededCheck = null, lastCheck = null } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled: true, message: "" },
    lastCheck,
    lastSucceededCheck,
    viewer: { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: platform },
    approvalAvailable: true,
  };
}

function gpexeServer({ teamStatus = {}, candidates = [], onCheck } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates } };
    if (rest === "/checks" && call.method === "POST") {
      return onCheck ? onCheck(call) : { status: 202, body: { check: { id: "chk-1", status: "succeeded", window: { from: call.body?.from || daysAgo(13), to: call.body?.to || TODAY }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: null } } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

function resetState() {
  clearAllViewCache();
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
}
const render = () => {};
async function act(action, dataset = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset } }, { renderTrainingLoad: render });
}
async function openImports() {
  await act("training-load-section", { section: "imports" });
}
const gx = () => state.trainingLoad.gpexe;
const html = () => renderTrainingLoadCoachHtml();
const panel = () => { const h = html(); const i = h.indexOf('<section class="gpexe-panel imports-period'); return i < 0 ? "" : h.slice(i, h.indexOf("</section>", i)); };
const posts = () => fetchCalls.filter((c) => c.url.endsWith("/checks") && c.method === "POST");
const dayCell = (p, day) => (p.match(new RegExp(`<button type="button" class="period-day[^"]*" data-action="training-load-gpexe-period-day" data-day="${day}"[^>]*>[\\s\\S]*?</button>`)) || [""])[0];


const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] + (ym.slice(0, 4) === String(new Date().getFullYear()) ? "" : ` ${ym.slice(0, 4)}`);
const tabs = () => [...html().matchAll(/data-import-tab="(\w+)"/g)].map((m) => m[1]);
const line = () => (html().match(/<p class="muted imports-month-line">[\s\S]*?<\/p>/) || [""])[0];
const THIS = TODAY.slice(0, 7);

test("P4c 1: a coach gets no Imported or Stays out tab; a tab kept from before falls back; nothing extra is read", async () => {
  resetState();
  platform = false;
  installFetchMock(gpexeServer({ candidates: [imported(1, prevDay(10)), staysOut(2, prevDay(11)), row(3, daysAgo(1))] }));
  await openImports();
  assert.deepEqual(tabs(), ["attention", "ready", "athletes", "search"]);
  gx().tab = "imported";
  assert.match(html(), /data-imports-tab="ready"/, "a kept Imported tab falls back to Ready");
  assert.doesNotMatch(html(), /training-load-gpexe-superseded/, "the replaced versions are the platform admin's only");
  const reads = fetchCalls.length;
  await act("training-load-gpexe-period-month", { delta: "-1" });
  assert.equal(fetchCalls.length, reads, "paging the calendar reads nothing");
});

test("P4c 2: the quiet line counts the month the calendar shows and follows paging; empty months say so", async () => {
  resetState();
  platform = false;
  installFetchMock(gpexeServer({ candidates: [imported(1, prevDay(10)), imported(2, prevDay(10)), staysOut(3, prevDay(11)), imported(4, daysAgo(0)), row(5, prevDay(12))] }));
  await openImports();
  gx().period.month = PREV;
  assert.match(line(), new RegExp(`imports-month-desk">2 imported · 1 stays out in ${monthName(PREV)} · pick a day in the calendar to open one<`));
  assert.match(line(), /data-action="training-load-gpexe-period-toggle"[^>]*>2 imported · 1 stays out in [^<]+ · open the calendar</, "on a phone the line opens the calendar sheet");
  await act("training-load-gpexe-period-month", { delta: "1" });
  assert.equal(gx().period.month, THIS);
  assert.match(line(), new RegExp(`1 imported in ${monthName(THIS)} ·`), "the line follows the month shown");
  gx().period.month = "2020-01";
  assert.match(line(), /imports-month-desk">Nothing imported in January 2020</);
});

test("P4c 3: the line's phone button opens the calendar sheet", async () => {
  resetState();
  platform = false;
  installFetchMock(gpexeServer({ candidates: [imported(1, daysAgo(0))] }));
  await openImports();
  assert.equal(gx().period.open, false);
  await act("training-load-gpexe-period-toggle");
  assert.equal(gx().period.open, true);
  assert.match(line(), /aria-expanded="true"/);
});

test("P4c 4: imported and stays-out sessions are in the chosen days' list, each opening its review", async () => {
  resetState();
  platform = false;
  const d = prevDay(10);
  installFetchMock(gpexeServer({ candidates: [imported(1, d), staysOut(2, d)] }));
  await openImports();
  gx().period.month = PREV;
  await act("training-load-gpexe-period-day", { day: d });
  const p = panel();
  assert.match(p, /data-action="training-load-gpexe-open" data-candidate-id="cand-1"[\s\S]*?period-chip is-done[\s\S]*?>imported</);
  assert.match(p, /data-action="training-load-gpexe-open" data-candidate-id="cand-2"[\s\S]*?period-chip is-out[\s\S]*?>stays out</);
  assert.match(p, /<i class="period-chip is-out">\u2013<\/i> stays out/, "the legend names the grey mark");
});

test("P4c 5: a full list read (200 rows) says older sessions may not be shown; 199 does not", async () => {
  for (const [n, shown] of [[200, true], [199, false]]) {
    resetState();
    platform = false;
    installFetchMock(gpexeServer({ candidates: Array.from({ length: n }, (_, i) => imported(i + 1, daysAgo(i % 40))) }));
    await openImports();
    assert.equal(/period-cap">Older sessions may not be shown\.</.test(panel()), shown, `${n} rows`);
  }
});

test("P4c 6: a platform admin keeps the Imported and Stays out tabs and the replaced versions, and gets no month line", async () => {
  resetState();
  platform = true;
  installFetchMock(gpexeServer({ candidates: [imported(1, prevDay(10)), staysOut(2, prevDay(11))] }));
  await openImports();
  assert.deepEqual(tabs(), ["attention", "ready", "imported", "out", "athletes", "search"]);
  assert.equal(line(), "");
  gx().tab = "out";
  assert.match(html(), /training-load-gpexe-superseded/);
  platform = false;
});
