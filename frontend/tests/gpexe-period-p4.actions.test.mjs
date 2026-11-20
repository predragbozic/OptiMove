// Imports P4 (owner 2026-11-13, the coach prototype): "Find new sessions" opens a calendar that chooses the period to
// search. One chip per session (colour + glyph), two taps (or a mouse drag) choose at most 31 days, "Search what's
// missing" starts at the end of the last successful search. Picking, turning a month and opening the panel send
// nothing; only a Search button starts a check, with exactly the days it names.
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

function status({ lastSucceededCheck = null, lastCheck = null } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled: true, message: "" },
    lastCheck,
    lastSucceededCheck,
    viewer: { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: false },
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

test("P4 1: two taps choose a period in either order; a future day and a day more than 31 days from the first are off", () => {
  const g = { period: period.emptyPeriod() };
  const now = new Date("2026-11-13T10:00:00");
  assert.equal(period.pickDay("2026-11-14", g, now), false, "tomorrow is off");
  assert.equal(period.pickDay("2026-11-10", g, now), true);
  assert.deepEqual(period.periodRange(g), { from: "2026-11-10", to: "2026-11-10", days: 1 }, "the first tap is one day");
  assert.equal(period.dayOff("2026-10-10", g, now), true, "32 days from the first: off");
  assert.equal(period.dayOff("2026-10-11", g, now), false, "31 days: on");
  assert.equal(period.pickDay("2026-10-10", g, now), false);
  assert.equal(period.pickDay("2026-11-02", g, now), true);
  assert.deepEqual(period.periodRange(g), { from: "2026-11-02", to: "2026-11-10", days: 9 }, "the second tap closes it, earlier first");
  assert.equal(period.dayOff("2026-10-10", g, now), false, "the cap only binds while the second day is awaited");
  period.pickDay("2026-11-05", g, now);
  assert.deepEqual(period.periodRange(g), { from: "2026-11-05", to: "2026-11-05", days: 1 }, "a third tap starts again");
  period.clearPeriod(g);
  assert.equal(period.periodRange(g), null);
});

test("P4 2: 'Search what's missing' runs from the last day of the last successful search to today, at most the latest 31 days; none without one", () => {
  const now = new Date("2026-11-13T10:00:00");
  assert.equal(period.missingWindow({ lastSucceededCheck: null }, now), null);
  assert.equal(period.missingWindow({}, now), null);
  assert.deepEqual(period.missingWindow({ lastSucceededCheck: { window: { from: "2026-11-01", to: "2026-11-12" } } }, now), { from: "2026-11-12", to: "2026-11-13", clipped: false });
  assert.deepEqual(period.missingWindow({ lastSucceededCheck: { window: { from: "2026-08-01", to: "2026-08-14" } } }, now), { from: "2026-10-14", to: "2026-11-13", clipped: true });
  assert.deepEqual(period.missingWindow({ lastSucceededCheck: { window: { from: "2026-11-13", to: "2026-11-14" } } }, now), { from: "2026-11-13", to: "2026-11-13", clipped: false }, "never from a future day");
});

test("P4 3: the chooser is always on the page (a computer); 'Find new sessions' opens and closes the phone's sheet and sends nothing; a running search turns every search button off", async () => {
  resetState();
  installFetchMock(gpexeServer({ candidates: [row(1, daysAgo(1))] }));
  await openImports();
  const before = fetchCalls.length;
  assert.match(panel(), /<section class="gpexe-panel imports-period" id="imports-period"/, "on the page, the sheet closed");
  assert.match(html(), /class="primary-button gpexe-button imports-find-phone" data-action="training-load-gpexe-period-toggle" aria-expanded="false" aria-controls="imports-period" >Find new sessions</);
  await act("training-load-gpexe-period-toggle");
  assert.match(panel(), /class="gpexe-panel imports-period is-open"/, "the phone's sheet is open");
  assert.match(panel(), /<h3 id="imports-period-title">Find new sessions<\/h3>[\s\S]*data-action="training-load-gpexe-period-toggle" aria-label="Close"/, "the sheet has its own Close");
  assert.match(html(), /aria-expanded="true" aria-controls="imports-period" >Find new sessions</);
  await act("training-load-gpexe-period-toggle");
  assert.ok(!/imports-period is-open/.test(panel()));
  assert.equal(fetchCalls.length, before, "nothing sent");
  gx().checkStarting = true;
  const p = panel();
  assert.ok((p.match(/data-action="training-load-gpexe-check"[^>]*>/g) || []).every((b) => / disabled>$/.test(b)), "every search button off while a search starts");
  assert.match(html(), /data-action="training-load-gpexe-period-toggle"[^>]*disabled>Finding\.\.\.</);
});

test("P4 4: a day shows one chip per session in start-time order with colour and glyph, up to 3 then +N; 'stays out' a quiet grey mark (P4c) and its label names it", async () => {
  resetState();
  const day = prevDay(12);
  const quiet = prevDay(13);
  const many = prevDay(14);
  installFetchMock(gpexeServer({ candidates: [
    imported(1, day), needs(2, day), row(3, day),
    staysOut(4, quiet),
    row(5, many), row(6, many), row(7, many), row(8, many), row(9, many),
  ] }));
  await openImports();
  gx().period.month = PREV;
  const p = panel();
  const cell = dayCell(p, day);
  const chips = [...cell.matchAll(/period-chip is-(\w+)">([^<]+)</g)].map((m) => `${m[1]}${m[2]}`);
  assert.deepEqual(chips, ["done\u2713", "needs!", "ready\u2192"], "colour and glyph per state, in start-time order");
  assert.match(cell, /aria-label="[^"]*, 3 sessions: imported, needs you, ready"/);
  const crowded = dayCell(p, many);
  assert.equal((crowded.match(/period-chip is-ready/g) || []).length, 3, "three shown");
  assert.match(crowded, /period-chip is-more">\+2</, "then +N");
  const out = dayCell(p, quiet);
  assert.match(out, /period-chip is-out">\u2013</, "stays out: a quiet grey mark (P4c)");
  assert.match(out, /1 session: stays out/);
  assert.doesNotMatch(out, /nothing found yet/);
  assert.match(p, /<i class="period-chip is-needs">!<\/i> needs you/, "a legend names each glyph");
});

test("P4 5: the first tap offers its day and asks for the last; two taps make the range bar; Search sends exactly those days and closes the sheet; Clear sends nothing", async () => {
  resetState();
  const a = daysAgo(6);
  const b = daysAgo(2);
  installFetchMock(gpexeServer({ candidates: [] }));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  gx().period.month = b.slice(0, 7);
  await act("training-load-gpexe-period-day", { day: b });
  assert.match(panel(), /class="period-wait" role="status">Find new sessions for [0-9.]+, or tap another day to make the period longer \(at most 31 days\)\.</);
  await act("training-load-gpexe-period-day", { day: a });
  const p = panel();
  assert.ok(!/period-wait/.test(p));
  assert.match(p, /class="period-range-text">[^<]*5 days</);
  assert.match(p, new RegExp(`class="period-range-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check" data-from="${a}" data-to="${b}"[^>]*>Find new sessions for [^<]+</button><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-period-clear">Clear<`), "Search first, then Clear");
  assert.match(dayCell(p, a), /is-edge/);
  assert.match(dayCell(p, b), /aria-pressed="true"/);
  assert.equal((p.match(/class="primary-button gpexe-button/g) || []).length, 1, "one main action: the chosen days' Search");
  assert.match(p, /class="plain-button gpexe-button period-missing"/);
  await act("training-load-gpexe-period-clear");
  assert.ok(!/period-range"/.test(panel()));
  assert.equal(posts().length, 0, "picking and clearing send nothing");
  await act("training-load-gpexe-period-day", { day: a });
  await act("training-load-gpexe-period-day", { day: b });
  await act("training-load-gpexe-check", { from: a, to: b });
  assert.equal(posts().length, 1);
  assert.deepEqual(posts()[0].body, { from: a, to: b });
  assert.ok(!/imports-period is-open/.test(panel()), "the phone's sheet closes once the search starts");
});

test("P4 6b (code review): a failed latest search and a long gap never make the chooser's days contradict the bar", async () => {
  // The latest search failed: the bar names that search; the line beside the button names only days, never "the last search".
  resetState();
  const ok = { id: "chk-0", status: "succeeded", window: { from: daysAgo(18), to: daysAgo(5) }, finishedAt: new Date(Date.now() - 3600e3).toISOString() };
  installFetchMock(gpexeServer({ teamStatus: { lastSucceededCheck: ok, lastCheck: { id: "chk-1", status: "failed", window: { from: daysAgo(5), to: TODAY }, finishedAt: new Date().toISOString() } } }));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  const line = (panel().match(/id="period-missing-days">([^<]*)</) || [])[1];
  assert.match(line, /^From \d{2}\.\d{2}\.(\d{4})? to today\.$/);
  assert.doesNotMatch(html(), /[Ss]ince the last search/);
  // More than 31 days since the last successful search: the line says the latest 31 days, once, not "from" a day it never ended on.
  resetState();
  const old = { id: "chk-0", status: "succeeded", window: { from: daysAgo(70), to: daysAgo(60) }, finishedAt: new Date().toISOString() };
  installFetchMock(gpexeServer({ teamStatus: { lastSucceededCheck: old, lastCheck: old } }));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  assert.match(panel(), /id="period-missing-days">The latest 31 days; tap earlier days below to search them too\.</);
  assert.equal((panel().match(/The latest 31 days/g) || []).length, 1, "said once");
});

test("P4 6: 'Find new sessions' carries the end of the last successful search and today; without one it searches the server's 14 days", async () => {
  resetState();
  const last = daysAgo(5);
  const lastCheck = { id: "chk-0", status: "succeeded", window: { from: daysAgo(18), to: last }, finishedAt: new Date().toISOString() };
  installFetchMock(gpexeServer({ teamStatus: { lastSucceededCheck: lastCheck, lastCheck } }));
  await openImports();
  // The action has one name; the days are said beside it and agree with the bar, which names the days the search read.
  // dd.mm. this year, dd.mm.yyyy for an earlier year (periodText).
  const fmt = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4) === String(new Date().getFullYear()) ? "" : d.slice(0, 4)}`;
  assert.match(html(), new RegExp(`Last search [^<]*, for ${fmt(daysAgo(18)).replace(/\./g, "\\.")} – ${fmt(last).replace(/\./g, "\\.")}`));
  await act("training-load-gpexe-period-toggle");
  assert.match(panel(), new RegExp(`class="primary-button gpexe-button period-missing" data-action="training-load-gpexe-check" data-from="${last}" data-to="${TODAY}" aria-describedby="period-missing-days" >Find new sessions<`));
  assert.match(panel(), new RegExp(`id="period-missing-days">From ${fmt(last).replace(/\./g, "\\.")} to today\\.<`));
  await act("training-load-gpexe-check", { from: last, to: TODAY });
  assert.deepEqual(posts()[0].body, { from: last, to: TODAY });

  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  assert.match(panel(), /class="primary-button gpexe-button period-missing" data-action="training-load-gpexe-check"  aria-describedby="period-missing-days" >Find new sessions</);
  assert.match(panel(), /id="period-missing-days">The last 14 days\.</);
  await act("training-load-gpexe-check");
  assert.deepEqual(posts()[0].body, {}, "no dates: the server's default");
});

test("P4 7: the chosen days list the sessions already found on them, by date, each opening its review; days without sessions list nothing", async () => {
  resetState();
  const d1 = daysAgo(2);
  const d2 = daysAgo(1);
  installFetchMock(gpexeServer({ candidates: [needs(2, d1), row(3, d2)] }));
  await openImports();
  gx().period.month = d2.slice(0, 7);
  assert.ok(!/period-daylist"/.test(panel()), "nothing chosen, nothing listed");
  await act("training-load-gpexe-period-day", { day: d1 });
  await act("training-load-gpexe-period-day", { day: d2 });
  const p = panel();
  assert.match(p, /Already found on these days/);
  assert.match(p, /data-action="training-load-gpexe-open" data-candidate-id="cand-2"[^>]*><span>Full training 2 · \d\d:\d\d<\/span><span class="period-chip is-needs" aria-hidden="true">!<\/span><span class="period-daylist-state">needs you<\/span>/);
  assert.match(p, /data-candidate-id="cand-3"/);
  assert.ok(p.indexOf("cand-2") < p.indexOf("cand-3"), "by date");
  await act("training-load-gpexe-period-clear");
  await act("training-load-gpexe-period-day", { day: daysAgo(40) });
  assert.ok(!/period-daylist"/.test(panel()));
});

test("P4 8: Prev and Next turn the month locally", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  const before = fetchCalls.length;
  const month = () => (panel().match(/class="period-month"[^>]*>([^<]+)</) || [])[1];
  const now = month();
  await act("training-load-gpexe-period-month", { delta: "-1" });
  assert.notEqual(month(), now);
  await act("training-load-gpexe-period-month", { delta: "1" });
  assert.equal(month(), now);
  assert.equal(fetchCalls.length, before, "nothing sent");
});

test("P4 9: a mouse drag across days chooses the period and its closing click is not a tap; a finger never starts a drag", () => {
  resetState();
  state.trainingLoad.gpexe.period = period.emptyPeriod();
  const listeners = { root: {}, doc: {} };
  const root = { addEventListener: (t, fn) => { listeners.root[t] = fn; } };
  let under = null;
  const doc = { addEventListener: (t, fn) => { listeners.doc[t] = fn; }, elementFromPoint: () => under };
  const cell = (day) => ({ dataset: { day }, getAttribute: () => null, closest: function () { return this; } });
  let renders = 0;
  bindPeriodDrag(root, () => { renders += 1; }, doc);
  const a = daysAgo(5);
  const b = daysAgo(2);
  listeners.root.pointerdown({ pointerType: "mouse", button: 0, target: cell(a) });
  under = cell(a);
  listeners.doc.pointermove({ clientX: 0, clientY: 0 });
  assert.equal(period.periodRange(), null, "no move, no drag");
  under = cell(b);
  listeners.doc.pointermove({ clientX: 1, clientY: 1 });
  listeners.doc.pointerup({});
  assert.deepEqual(period.periodRange(), { from: a, to: b, days: 4 });
  assert.equal(period.periodOf().anchor, "", "the period is closed");
  assert.equal(takePeriodDragClick(), true, "the click that ends the drag is swallowed");
  assert.equal(takePeriodDragClick(), false, "only that one");
  assert.ok(renders >= 2);
  period.clearPeriod();
  listeners.root.pointerdown({ pointerType: "touch", button: 0, target: cell(a) });
  under = cell(b);
  listeners.doc.pointermove({ clientX: 1, clientY: 1 });
  listeners.doc.pointerup({});
  assert.equal(period.periodRange(), null, "touch: two taps only, the page keeps scrolling");
});

test("P4 10: an unconnected team has no chooser", async () => {
  resetState();
  installFetchMock(async (call) => {
    if (/\/status$/.test(call.url)) return { status: 200, body: { ...status(), settings: null } };
    return gpexeServer({})(call);
  });
  await openImports();
  gx().period.open = true;
  assert.equal(panel(), "");
  assert.ok(!/training-load-gpexe-period-toggle/.test(html()));
});

test("P4 11: a session near midnight UTC is marked on the day the server searches it under, whatever the browser's time zone", async () => {
  const keep = process.env.TZ;
  process.env.TZ = "Europe/Belgrade";
  try {
    resetState();
    installFetchMock(gpexeServer({ candidates: [row(1, prevDay(5), { sessionStartedAt: `${prevDay(5)}T23:30:00Z` })] }));
    await openImports();
    gx().period.month = PREV;
    const p = panel();
    assert.match(dayCell(p, prevDay(5)), /period-chip/, "on its UTC day (the search's)");
    assert.doesNotMatch(dayCell(p, prevDay(6)), /period-chip/, "not on the next local day");
  } finally {
    if (keep === undefined) delete process.env.TZ; else process.env.TZ = keep;
  }
});

test("P4 12: after a search from the chooser the chosen days are cleared, so the next look shows the days a session needs", async () => {
  resetState();
  let list = [];
  installFetchMock(gpexeServer({ candidates: [] }));
  await openImports();
  const a = daysAgo(6);
  const b = daysAgo(4);
  await act("training-load-gpexe-period-day", { day: a });
  await act("training-load-gpexe-period-day", { day: b });
  await act("training-load-gpexe-check", { from: a, to: b });
  assert.equal(period.periodRange(), null, "cleared once the search starts");
  const x = prevDay(20);
  list = [row(1, x, { approvalBlockers: ["not_confirmed_for_import"] })];
  installFetchMock(gpexeServer({ candidates: list }));
  await openImports();
  const p = panel();
  assert.match(p, new RegExp(`data-action="training-load-gpexe-check" data-from="${x}" data-to="${x}"`));
  assert.match(p, /These days hold the sessions that need finding again\./);
});

test("P4 13: the click that ends a drag is the only one swallowed - a later keyboard tap counts; a move with no button held ends the drag", async () => {
  resetState();
  state.trainingLoad.gpexe.period = period.emptyPeriod();
  const listeners = { root: {}, doc: {} };
  const root = { addEventListener: (t, fn) => { listeners.root[t] = fn; } };
  let under = null;
  const doc = { addEventListener: (t, fn) => { listeners.doc[t] = fn; }, elementFromPoint: () => under };
  const cell = (day) => ({ dataset: { day }, getAttribute: () => null, closest: function () { return this; } });
  bindPeriodDrag(root, () => {}, doc);
  installFetchMock(gpexeServer({}));
  const [a, b, c] = [daysAgo(5), daysAgo(3), daysAgo(1)];
  listeners.root.pointerdown({ pointerType: "mouse", button: 0, target: cell(a) });
  under = cell(b);
  listeners.doc.pointermove({ clientX: 1, clientY: 1, buttons: 1 });
  under = null;
  listeners.doc.pointerup({});
  await new Promise((r) => setTimeout(r, 0));
  await act("training-load-gpexe-period-day", { day: c });
  assert.deepEqual(period.periodRange(), { from: c, to: c, days: 1 }, "the keyboard tap counted");
  period.clearPeriod();
  listeners.root.pointerdown({ pointerType: "mouse", button: 0, target: cell(a) });
  under = cell(b);
  listeners.doc.pointermove({ clientX: 1, clientY: 1, buttons: 0 });
  assert.equal(period.periodRange(), null, "a lost pointerup: the drag ends, nothing is chosen");
  listeners.doc.pointermove({ clientX: 2, clientY: 2, buttons: 1 });
  assert.equal(period.periodRange(), null, "and it stays ended");
});

test("P4 14: nothing of the removed day filter or the From/To fields is left in the frontend", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const code = [...fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)), path.join(dir, "styles.css")];
  const tests = fs.readdirSync(path.join(dir, "tests")).filter((f) => f.endsWith(".mjs") && f !== "gpexe-period-p4.actions.test.mjs").map((f) => path.join(dir, "tests", f));
  const inCode = ["training-load-gpexe-cal-", "calendarToggled", "calendarFiltered", "imports-cal-", "imports-calendar", "data-gpexe-field", ".imports-banner .imports-dates"];
  // A test may still assert that a removed thing is absent; it may not drive or import it.
  const inTests = ["training-load-gpexe-cal-", "calendarToggled", "calendarFiltered", "setCalendarDay", 'class="imports-dates" open'];
  for (const [files, banned] of [[code, inCode], [tests, inTests]]) {
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      for (const word of banned) assert.ok(!text.includes(word), `${path.basename(file)} still has ${word}`);
    }
  }
});

test("P4 15: the phone's sheet is a dialog while open; a session opened from it closes it first; Escape and Back close it (closePeriodSheet)", async () => {
  resetState();
  const day = prevDay(8);
  installFetchMock(async (call) => {
    if (/\/candidates\/cand-1$/.test(call.url)) return { status: 200, body: { candidate: { ...row(1, day), athletes: {}, approval: null, preview: { version: 3, status: "ready", blocked: null, counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [], unactivatedSourceMetricCount: 0 } } } };
    return gpexeServer({ candidates: [row(1, day)] })(call);
  });
  await openImports();
  assert.match(panel(), /id="imports-period" aria-label="Find new sessions"/, "closed: a region, not a dialog");
  await act("training-load-gpexe-period-toggle");
  assert.match(panel(), /id="imports-period" role="dialog" aria-modal="true" aria-labelledby="imports-period-title"/);
  assert.match(panel(), /<h3 id="imports-period-title">Find new sessions<\/h3>/);
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  assert.equal(period.periodOf().open, false, "the review opens over the screen, not under the sheet");
  await act("training-load-gpexe-period-toggle");
  assert.equal(period.closePeriodSheet(gx()), true, "Escape / Back: closed");
  assert.equal(period.closePeriodSheet(gx()), false, "nothing more to close");
});

test("P4 16: 'today' is the later of the browser's and the UTC day, so a session of the UTC day can always be picked", () => {
  // 21:00 in New York (UTC-5) is 02:00Z the next day: the UTC day is today's last day.
  const keep = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const late = new Date("2026-11-14T02:00:00Z");
    assert.equal(period.localDay(late), "2026-11-13", "the browser's day");
    assert.equal(period.todayDay(late), "2026-11-14", "the UTC day is later");
    const g = { period: period.emptyPeriod() };
    assert.equal(period.dayOff("2026-11-14", g, late), false, "the UTC day is not in the future");
    assert.equal(period.dayOff("2026-11-15", g, late), true, "the day after is");
  } finally {
    if (keep === undefined) delete process.env.TZ; else process.env.TZ = keep;
  }
});

test("P4 17: while a group's own step leads the screen, the chooser's first button is quiet", async () => {
  resetState();
  installFetchMock(gpexeServer({ candidates: [needs(1, prevDay(9))] }));
  await openImports();
  const p = panel();
  assert.match(p, /class="plain-button gpexe-button period-missing"/, "the group's step is the one main action");
  assert.doesNotMatch(p, /class="primary-button/);
});

test("P4 18: leaving Imports closes the phone's sheet, so Escape and Back elsewhere are never spent on it", async () => {
  resetState();
  installFetchMock(gpexeServer({}));
  await openImports();
  await act("training-load-gpexe-period-toggle");
  assert.equal(period.periodOf().open, true);
  await act("training-load-section", { section: "overview" });
  assert.equal(period.closePeriodSheet(gx()), false, "already closed by leaving Imports");
});

test("P4 19: Tab and Shift+Tab stay inside the open sheet", async () => {
  const { trapPeriodSheetTab } = await import("../gpexe-period-drag.js");
  const focus = [];
  const btn = (name) => ({ name, getAttribute: () => null, focus() { focus.push(name); doc.activeElement = this; } });
  const [first, mid, last] = [btn("close"), btn("day"), btn("search")];
  const sheet = { querySelectorAll: () => [first, mid, last], contains: (el) => [first, mid, last].includes(el) };
  const doc = { activeElement: last, querySelector: (sel) => (sel === ".imports-period.is-open" ? sheet : null) };
  let prevented = 0;
  const ev = (shiftKey) => ({ key: "Tab", shiftKey, preventDefault: () => { prevented += 1; } });
  assert.equal(trapPeriodSheetTab(ev(false), doc), true);
  assert.deepEqual(focus, ["close"], "Tab from the last control goes to the first");
  assert.equal(trapPeriodSheetTab(ev(true), doc), true);
  assert.deepEqual(focus, ["close", "search"], "Shift+Tab from the first goes to the last");
  doc.activeElement = { outside: true };
  assert.equal(trapPeriodSheetTab(ev(false), doc), true, "focus outside the sheet comes back in");
  doc.activeElement = mid;
  assert.equal(trapPeriodSheetTab(ev(false), doc), false, "inside, Tab moves on by itself");
  assert.equal(trapPeriodSheetTab({ key: "Tab", shiftKey: false, preventDefault() {} }, { querySelector: () => null }), false, "no open sheet: nothing");
  assert.equal(prevented, 3);
});

test("P4 20: while a group's step leads, suggested days' Search is quiet too (one main action)", async () => {
  resetState();
  installFetchMock(gpexeServer({ candidates: [needs(1, prevDay(9)), row(2, prevDay(10), { approvalBlockers: ["not_confirmed_for_import"] })] }));
  await openImports();
  const p = panel();
  assert.match(p, /class="period-range"/, "the not-confirmed session's day is suggested");
  assert.doesNotMatch(p, /class="primary-button/, "nothing in the chooser competes with the group's step");
});

test("P4 21: the phone's Back closes the period sheet before any other step of the screen (a hidden athlete list, the week selector)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = src.indexOf("function handleAppBack()");
  const body = src.slice(start, src.indexOf("\n}\n", start));
  const sheet = body.indexOf("closePeriodSheet(");
  assert.ok(sheet > 0, "handleAppBack closes the sheet");
  for (const later of ["state.weekSelectorOpen", "state.athletesExpanded"]) {
    assert.ok(body.indexOf(later) > sheet, `the sheet closes before ${later}`);
  }
});

test("P4 22 (code review): a search started from the calendar on a computer brings the banner into view once - never again while it is polled or read after it", async () => {
  const run = async ({ fromCalendar, sheetOpen = false }) => {
    resetState();
    let reads = 0;
    const base = gpexeServer({ candidates: [], onCheck: () => ({ status: 202, body: { check: { id: "chk-1", status: "running", window: { from: daysAgo(3), to: TODAY }, startedAt: new Date().toISOString() } } }) });
    installFetchMock(async (call) => {
      if (/\/checks\/chk-1$/.test(call.url)) {
        reads += 1;
        return { status: 200, body: { check: { id: "chk-1", status: reads > 3 ? "succeeded" : "running", window: { from: daysAgo(3), to: TODAY }, startedAt: new Date().toISOString(), finishedAt: reads > 3 ? new Date().toISOString() : null, sessionsSeen: 0, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 0, error: null } } };
      }
      return base(call);
    });
    await openImports();
    if (sheetOpen) period.setPeriodOpen(true);
    let scrolls = 0;
    const banner = { scrollIntoView: () => { scrolls += 1; } };
    const saved = globalThis.document.querySelector;
    globalThis.document.querySelector = (sel) => (sel === ".imports-banner" ? banner : null);
    try {
      await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-check", from: daysAgo(3), to: TODAY }, closest: (sel) => (fromCalendar && sel === ".imports-period" ? {} : null) }, { renderTrainingLoad: render });
    } finally { globalThis.document.querySelector = saved; }
    assert.ok(reads >= 4, `the search was polled to its end (${reads} reads)`);
    return scrolls;
  };
  assert.equal(await run({ fromCalendar: true }), 1, "a computer's calendar: once, at the start");
  assert.equal(await run({ fromCalendar: true, sheetOpen: true }), 0, "a phone's sheet: the banner stays where it is");
  assert.equal(await run({ fromCalendar: false }), 0, "a step's own button elsewhere on the page: no scroll");
});

test("P4 23 (K5-4): chooseDay chooses one day whole through the same dayOff and the same days as a tap; a waiting first tap is not in the way; it never opens the sheet", () => {
  const now = new Date("2026-11-13T10:00:00");
  const g = { period: period.emptyPeriod() };
  assert.equal(period.chooseDay("2026-11-14", g, now), false, "a future day is refused (the same dayOff)");
  assert.equal(period.chooseDay("not-a-day", g, now), false, "a non-date is refused");
  assert.deepEqual(g.period, period.emptyPeriod(), "a refusal changes nothing");
  // A first tap 40 days before the day, left waiting from an earlier visit.
  assert.equal(period.pickDay("2026-10-04", g, now), true);
  assert.equal(period.dayOff("2026-11-13", g, now), true, "without the fourth argument the waiting tap still refuses a day 41 days away");
  assert.equal(period.chooseDay("2026-11-13", g, now), true, "the chosen day replaces the waiting tap");
  assert.deepEqual(g.period, { open: false, month: "2026-11", anchor: "", from: "2026-11-13", to: "2026-11-13" }, "exactly anchor, from, to and month; open as it was");
  assert.deepEqual(period.periodRange(g), { from: "2026-11-13", to: "2026-11-13", days: 1 });
  g.period.open = true;
  assert.equal(period.chooseDay("2026-11-01", g, now), true);
  assert.equal(g.period.open, true, "open is left as the caller set it");
  // A tap after a chosen day behaves as before: it starts a new first tap.
  assert.equal(period.pickDay("2026-11-05", g, now), true);
  assert.deepEqual(period.periodRange(g), { from: "2026-11-05", to: "2026-11-05", days: 1 });
  assert.equal(g.period.anchor, "2026-11-05");
});
