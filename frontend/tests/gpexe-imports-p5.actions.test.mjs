// Imports P5 (manager, 2026-11-15): ONE help for Imports - "How importing works", a button in the Imports header that
// opens a modal (a sheet on a phone). It says once what the page's standing paragraphs used to say, with the viewer's
// own "who to ask"; the page keeps one sentence per action.
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
let clubAdmin = false;
function status({ lastSucceededCheck = null, lastCheck = null } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled: true, message: "" },
    lastCheck,
    lastSucceededCheck,
    viewer: { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: platform, ...(clubAdmin ? { identityAdmin: true } : {}) },
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


const help = () => (html().match(/<section class="gpexe-panel imports-help[\s\S]*?<\/section>/) || [""])[0];
async function openAs({ admin = false, club = false } = {}) {
  resetState();
  platform = admin;
  clubAdmin = club;
  installFetchMock(gpexeServer({ candidates: [row(1, daysAgo(2))] }));
  await openImports();
}

test("P5 1: one button in the Imports header opens How importing works, a modal; nothing is sent; Close and the same button close it", async () => {
  await openAs();
  assert.match(html(), /<div class="imports-head">[\s\S]*?data-action="training-load-gpexe-help" aria-haspopup="dialog" aria-expanded="false" aria-controls="imports-help">How importing works</);
  assert.equal(help(), "", "closed until asked for");
  const reads = fetchCalls.length;
  await act("training-load-gpexe-help");
  assert.match(help(), /id="imports-help" role="dialog" aria-modal="true" aria-labelledby="imports-help-title"/);
  assert.match(html(), /aria-expanded="true" aria-controls="imports-help">How importing works</);
  await act("training-load-gpexe-help");
  assert.equal(help(), "");
  assert.equal(fetchCalls.length, reads, "nothing is read or sent");
});

test("P5 2: it says each thing once: the search, the four marks with colour and glyph, Needs you, linking, Later, where imported sessions go", async () => {
  await openAs();
  await act("training-load-gpexe-help");
  const h = help();
  for (const [re, what] of [
    [/Find new sessions<\/strong> reads GPEXE for the days you choose\. It imports nothing; you choose what to import\./, "the search"],
    [/period-chip is-needs" aria-hidden="true">!<\/i> <strong>Needs you<\/strong>/, "!"],
    [/period-chip is-ready" aria-hidden="true">→<\/i> <strong>Ready<\/strong>/, "→"],
    [/period-chip is-done" aria-hidden="true">✓<\/i> <strong>Imported<\/strong>/, "✓"],
    [/period-chip is-out" aria-hidden="true">–<\/i> <strong>Stays out<\/strong>/, "–"],
    [/A day without a mark may not have been searched yet\./, "unmarked days"],
    [/<strong>Needs you<\/strong> groups the sessions by what they ask/, "Needs you"],
    [/<strong>Linking athletes<\/strong> tells OptiMove which athlete of your team a GPEXE athlete is, for this and every later session\. It is never guessed/, "linking"],
    [/<strong>Later<\/strong> puts a Ready session aside on this device only\./, "Later"],
    [/<strong>After importing<\/strong> a session shows with ✓ in the calendar here, and its results are in Training Load → Activities\./, "where they go"],
  ]) assert.match(h, re, what);
});

test("P5 3: who to ask: a coach the club administrator, a club admin OptiMove support, a platform admin nobody", async () => {
  for (const [opts, re] of [
    [{}, /imports-help-ask">Something you can(?:'|&#039;)t fix here\? Ask your club administrator\.</],
    [{ club: true }, /imports-help-ask">Something you can(?:'|&#039;)t fix here\? Contact OptiMove support\.</],
  ]) {
    await openAs(opts);
    await act("training-load-gpexe-help");
    assert.match(help(), re);
  }
  await openAs({ admin: true });
  await act("training-load-gpexe-help");
  assert.doesNotMatch(help(), /imports-help-ask/);
  platform = false; clubAdmin = false;
});

test("P5 4: the standing paragraphs it replaces are gone from the page", async () => {
  await openAs();
  for (const tab of ["ready", "athletes", "search"]) {
    await act("training-load-gpexe-tab", { importTab: tab });
    const page = html();
    assert.doesNotMatch(page, /Finding sessions does not import anything/, `${tab}: the search line`);
    assert.doesNotMatch(page, /Days without a mark may not have been searched yet/, `${tab}: the calendar note`);
    assert.doesNotMatch(page, /A link is never guessed/, `${tab}: the linking paragraph`);
  }
});

test("P5 5: Escape, the phone's Back and leaving Imports close it before the period sheet; opening it closes the sheet", async () => {
  await openAs();
  gx().period.open = true;
  await act("training-load-gpexe-help");
  assert.equal(gx().period.open, false, "one modal at a time");
  gx().period.open = true;
  assert.equal(period.closePeriodSheet(gx()), true);
  assert.equal(gx().helpOpen, false, "the help closes first");
  assert.equal(gx().period.open, true);
  assert.equal(period.closePeriodSheet(gx()), true);
  assert.equal(gx().period.open, false);
  assert.equal(period.closePeriodSheet(gx()), false);
});

test("P5 6: Tab stays inside the open help", async () => {
  const { trapPeriodSheetTab } = await import("../gpexe-period-drag.js");
  const first = { focus() { focused = this; } };
  const last = { focus() { focused = this; } };
  let focused = null;
  const sheet = { querySelectorAll: () => [first, last], contains: (el) => el === first || el === last };
  const doc = { activeElement: last, querySelector: (sel) => (sel === ".imports-help.is-open" ? sheet : null) };
  const ev = { key: "Tab", shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
  first.getAttribute = last.getAttribute = () => null;
  assert.equal(trapPeriodSheetTab(ev, doc), true);
  assert.equal(focused, first);
});
