// Imports P4b (owner 2026-11-13, the coach prototype): "Later" puts a Ready session aside on this device only - nothing is
// sent, it is kept in localStorage per sign-in and team, it is out of the counts, the main button and Select all, Undo and
// Bring back return it, and a session that is no longer Ready is forgotten.
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
const imported = (n, day, over = {}) => row(n, day, { status: "imported", importedAt: at(day), ...over });
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

function gpexeServer({ teamStatus = {}, candidates = [], onCheck, truncated = false } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates, truncated } };
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


// A localStorage that can be refused (a private window, blocked site data).
const store = new Map();
let refuse = false;
globalThis.localStorage = {
  getItem: (k) => { if (refuse) throw new Error("denied"); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (refuse) throw new Error("denied"); store.set(k, String(v)); },
  removeItem: (k) => { if (refuse) throw new Error("denied"); store.delete(k); },
};
const KEY = `optimove.imports.later.coach-1.${TEAM_A}`;
const writes = () => fetchCalls.filter((c) => c.method !== "GET");
const readyTab = () => (html().match(/data-import-tab="ready">([^<]*)</) || [])[1];
const readyRows = () => [...html().matchAll(/data-action="training-load-gpexe-later" data-candidate-id="([^"]+)"/g)].map((m) => m[1]);
const { resetLaterTapForTests } = await import("../gpexe-import-actions.js");
const { reloadGpexeCandidates } = await import("../gpexe-import-data.js");
async function openReady(candidates) {
  resetLaterTapForTests();
  resetState();
  platform = false;
  installFetchMock(gpexeServer({ candidates }));
  await openImports();
  await act("training-load-gpexe-tab", { importTab: "ready" });
}

test("P4b 1: Later puts a Ready session aside on this device: nothing is sent, the row and the counts drop it, a notice offers Undo", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3))]);
  assert.deepEqual(readyRows(), ["cand-1", "cand-2"]);
  assert.equal(readyTab(), "Ready (2)");
  // Explained where it first appears, not only in the help.
  assert.equal((html().match(/imports-later-help">Later puts a session aside on this device only; it stays ready for everyone else\.</g) || []).length, 1);
  const before = fetchCalls.length;
  await act("training-load-gpexe-later", { candidateId: "cand-1" });
  assert.equal(fetchCalls.length, before, "nothing is sent");
  assert.deepEqual(readyRows(), ["cand-2"]);
  assert.equal(readyTab(), "Ready (1)");
  assert.match(html(), /imports-later-notice" role="status"><span>Put aside: [A-Z][a-z]{2} \d{2}\.\d{2}\. · [^<]+\.<\/span> <button[^>]*data-action="training-load-gpexe-later-back" data-candidate-id="cand-1">Undo</);
  assert.match(html(), /imports-lastsearch">[^<]* · 1 ready · 1 put aside</, "the banner never hides a session put aside");
  assert.match(html(), />Import 1 ready session</, "the main button never takes it");
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-1"], "kept per sign-in and team");
  await act("training-load-gpexe-later-back", { candidateId: "cand-1" });
  assert.deepEqual(readyRows(), ["cand-1", "cand-2"], "Undo brings it back");
  assert.equal(store.has(KEY), false);
  assert.doesNotMatch(html(), /imports-later-notice/);
  assert.equal(writes().length, 0);
});

test("P4b 2: the set-aside sessions are one line under Ready; Show lists them, each with Bring back; nothing else is ready says so", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2))]);
  await act("training-load-gpexe-later", { candidateId: "cand-1" });
  assert.match(html(), /Nothing else is ready to import\./);
  assert.match(html(), /1 session is put aside for later on this device\. <button[^>]*data-action="training-load-gpexe-later-show" aria-expanded="false">Show</);
  await act("training-load-gpexe-later-show");
  assert.match(html(), /imports-later-list[\s\S]*data-action="training-load-gpexe-later-back" data-candidate-id="cand-1">Bring back</);
  await act("training-load-gpexe-later-back", { candidateId: "cand-1" });
  assert.deepEqual(readyRows(), ["cand-1"]);
  assert.doesNotMatch(html(), /imports-later-aside/);
});

test("P4b 3: it lasts across a reload for the same sign-in and team, and never reaches another team or sign-in", async () => {
  store.clear(); refuse = false;
  store.set(KEY, JSON.stringify(["cand-2"]));
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3))]);
  assert.deepEqual(readyRows(), ["cand-1"], "read back after a reload");
  store.clear();
  store.set(`optimove.imports.later.someone-else.${TEAM_A}`, JSON.stringify(["cand-2"]));
  store.set("optimove.imports.later.coach-1.another-team", JSON.stringify(["cand-2"]));
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3))]);
  assert.deepEqual(readyRows(), ["cand-1", "cand-2"]);
});

test("P4b 4: a session that is no longer Ready (imported, gone) is forgotten after the next list read", async () => {
  store.clear(); refuse = false;
  store.set(KEY, JSON.stringify(["cand-1", "cand-9"]));
  await openReady([imported(1, daysAgo(2)), row(2, daysAgo(3))]);
  assert.equal(store.has(KEY), false, "neither is Ready any more");
});

test("P4b 5: when storage is refused, Later still works until the page reloads", async () => {
  store.clear(); refuse = true;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3))]);
  await act("training-load-gpexe-later", { candidateId: "cand-2" });
  assert.deepEqual(readyRows(), ["cand-1"]);
  refuse = false;
  assert.equal(store.size, 0);
});

test("P4b 6: Later leaves the batch selection; Select all and Import never take a session put aside", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3)), row(3, daysAgo(4))]);
  await act("training-load-gpexe-later", { candidateId: "cand-3" });
  assert.match(html(), />Import 2 ready sessions</);
  await act("training-load-gpexe-import-ready");
  assert.deepEqual(Object.keys(gx().batch?.selected || {}).sort(), ["cand-1", "cand-2"]);
});

test("P4b 7 (code review HIGH): a link change and a list read do not forget a session put aside; only the server's final state does", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3))]);
  await act("training-load-gpexe-later", { candidateId: "cand-2" });
  gx().linkSeq += 1;
  gx().linkCheckStartedAt = null; // every row now reads "Needs you" until the next search
  await reloadGpexeCandidates(() => {});
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-2"], "kept");
  // The server says it is imported: forgotten.
  installFetchMock(gpexeServer({ candidates: [row(1, daysAgo(2)), imported(2, daysAgo(3))] }));
  await reloadGpexeCandidates(() => {});
  assert.equal(store.has(KEY), false);
});

test("P4b 8 (code review MEDIUM, #540): a session missing from a list the server cut, or a list with replaced versions, is kept; from a complete list it is forgotten", async () => {
  store.clear(); refuse = false;
  store.set(KEY, JSON.stringify(["cand-x"]));
  resetLaterTapForTests();
  resetState();
  platform = false;
  installFetchMock(gpexeServer({ candidates: Array.from({ length: 200 }, (_, i) => row(i + 1, daysAgo(i % 30))), truncated: true }));
  await openImports();
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-x"], "the server cut the list: maybe only older");
  gx().includeSuperseded = true;
  installFetchMock(gpexeServer({ candidates: [row(1, daysAgo(2))] }));
  await reloadGpexeCandidates(() => {});
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-x"], "with the replaced versions the list is not the plain one");
  gx().includeSuperseded = false;
  await reloadGpexeCandidates(() => {});
  assert.equal(store.has(KEY), false, "a complete list without it: gone");
});

test("P4b 9: in Choose sessions there is no Later, and Select all leaves out a session put aside", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3)), row(3, daysAgo(4))]);
  await act("training-load-gpexe-later", { candidateId: "cand-3" });
  gx().chooseOpen = true;
  assert.doesNotMatch(html(), /data-action="training-load-gpexe-later" /, "no Later in checkbox mode");
  await act("training-load-gpexe-batch-select");
  assert.deepEqual(Object.keys(gx().batch.selected).sort(), ["cand-1", "cand-2"]);
});

test("P4b 10: no Later while an import is being sent; a second tap right after the first is not a second Later", async () => {
  store.clear(); refuse = false;
  await openReady([row(1, daysAgo(2)), row(2, daysAgo(3)), row(3, daysAgo(4))]);
  gx().batch = { ...(gx().batch || {}), sending: true, selected: {} };
  assert.match(html(), /data-action="training-load-gpexe-later" data-candidate-id="cand-1" disabled/);
  await act("training-load-gpexe-later", { candidateId: "cand-1" });
  assert.equal(store.has(KEY), false, "refused while sending");
  gx().batch.sending = false;
  await act("training-load-gpexe-later", { candidateId: "cand-1" });
  await act("training-load-gpexe-later", { candidateId: "cand-2" });
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-1"], "the repeat tap is ignored");
  resetLaterTapForTests();
  await act("training-load-gpexe-later", { candidateId: "cand-2" });
  assert.deepEqual(JSON.parse(store.get(KEY)), ["cand-1", "cand-2"]);
});
