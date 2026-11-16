// #540 wiring (manager, 2026-11-15): the frontend reads the server's `state` (keeping its own two facts), `truncated` in
// place of the copied 200-row limit, and - only when the server cut the list - the calendar read for an older month and
// the chosen older days on their own. GET only; nothing is read for a complete list.
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

function gpexeServer({ teamStatus = {}, candidates = [], onCheck, truncated = false, calendar = null, older = null } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: status(teamStatus) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest.startsWith("/candidates?from=")) { const q = new URL(rest, "http://x").searchParams; return older ? older(q.get("from"), q.get("to")) : { status: 404, body: { error: "notFound" } }; }
    if (rest.startsWith("/calendar?")) { const q = new URL(rest, "http://x").searchParams; return calendar ? calendar(q.get("from"), q.get("to")) : { status: 404, body: { error: "notFound" } }; }
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


const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] + (ym.slice(0, 4) === String(new Date().getFullYear()) ? "" : ` ${ym.slice(0, 4)}`);
const tabs = () => [...html().matchAll(/data-import-tab="(\w+)"/g)].map((m) => m[1]);
const line = () => (html().match(/<p class="muted imports-month-line">[\s\S]*?<\/p>/) || [""])[0];
// The month's facts, said inside the calendar under its month name.
const facts = () => (html().match(/<p class="muted period-month-facts">([^<]*)<\/p>/) || [null, ""])[1];
const THIS = TODAY.slice(0, 7);


const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
const gets = (part) => fetchCalls.filter((c) => c.method === "GET" && c.url.includes(part)).map((c) => c.url.replace(/^.*\/teams\/[^/]+/, ""));
const { candidateState } = await import("../../backend/src/gpexeImportState.js");
const { inboxBucket } = await import("../gpexe-import-data.js");
// The newest sessions, cut by the server: the list starts on daysAgo(5).
const recent = () => [0, 1, 2, 3, 4, 5].map((d) => row(d + 1, daysAgo(d)));
const D = (n) => prevDay(n);

test("#540 1: inboxBucket reads the server's state and keeps the browser's two facts; with no browser fact it equals the rule without state", () => {
  const quiet = { uncertain: {}, linkSeq: 0, linkCheckStartedAt: null, recomputedAtLinkSeq: {} };
  const cases = [
    row(1, D(1)), needs(2, D(1)), imported(3, D(1)), staysOut(4, D(1)),
    row(5, D(1), { previewStatus: "no_changes" }),
    row(6, D(1), { status: "superseded", supersededByCheckId: "k" }),
    row(7, D(1), { status: "imported", importUndoneAt: at(D(1)) }),
    row(8, D(1), { approvalBlockers: ["not_confirmed_for_import"] }),
  ];
  for (const c of cases) {
    const withState = { ...c, state: candidateState(c) };
    for (const gx of [quiet, { ...quiet, uncertain: { [c.id]: true } }, { ...quiet, linkSeq: 1 }]) {
      assert.equal(inboxBucket(withState, gx), inboxBucket(c, gx), `${c.id} ${JSON.stringify(gx.uncertain)} ${gx.linkSeq}`);
    }
  }
  // The server's word wins over what the browser would derive: a summary the server calls "needs".
  assert.equal(inboxBucket({ ...row(9, D(1)), state: "needs" }, quiet), "attention");
});

test("#540 2: a list the server did not cut reads no calendar and no older days, whatever the month or the days", async () => {
  resetState(); platform = false;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: false, calendar: () => ({ status: 200, body: { days: [] } }) }));
  await openImports();
  await act("training-load-gpexe-period-month", { delta: "-1" });
  await act("training-load-gpexe-period-day", { day: D(8) });
  await act("training-load-gpexe-period-day", { day: D(12) });
  await settle();
  assert.deepEqual(gets("/calendar"), []);
  assert.deepEqual(gets("/candidates?from="), []);
});

test("#540 3: a cut list: an older month shows the server's calendar (chips and counts), once; the cap note goes when it arrives", async () => {
  resetState(); platform = false;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true, calendar: () => ({ status: 200, body: { days: [
    { day: D(10), chips: ["imported", "needs", "imported"], counts: { needs: 1, ready: 0, imported: 3, out: 0 } },
    { day: D(11), chips: ["out"], counts: { needs: 0, ready: 0, imported: 0, out: 1 } },
  ], truncated: false } }) }));
  await openImports();
  gx().period.month = TODAY.slice(0, 7);
  await act("training-load-gpexe-period-month", { delta: "-1" });
  await settle();
  const [y, m] = PREV.split("-").map(Number);
  const prevRead = `/calendar?from=${PREV}-01&to=${PREV}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  assert.deepEqual(gets("/calendar").filter((u) => u.includes(`from=${PREV}-`)), [prevRead], "the older month, its whole days");
  const cell = dayCell(panel(), D(10));
  assert.deepEqual([...cell.matchAll(/period-chip is-(\w+)">([^<]+)</g)].map((x) => x[1]), ["done", "needs", "done", "more"], "the server's first three, then +1");
  assert.match(cell, /aria-label="[^"]*, 4 sessions: imported, needs you, imported, imported"/);
  assert.match(dayCell(panel(), D(11)), /period-chip is-out/);
  assert.doesNotMatch(panel(), /Older sessions may not be shown/);
  assert.match(facts(), /^3 imported · 1 stays out \(not imported\) ·/, "the calendar counts the server's month");
  await act("training-load-gpexe-period-month", { delta: "1" });
  await act("training-load-gpexe-period-month", { delta: "-1" });
  await settle();
  assert.equal(gets("/calendar").filter((u) => u === prevRead).length, 1, "read once per month");
});

test("#540 4: a cut list: older chosen days are read on their own (at most to the list's first day) and listed, each opening its review", async () => {
  resetState(); platform = false;
  let release;
  const held = new Promise((r) => { release = r; });
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true,
    calendar: () => ({ status: 200, body: { days: [{ day: D(10), chips: ["imported", "needs"], counts: { needs: 1, ready: 0, imported: 1, out: 0 } }] } }),
    older: async () => { await held; return { status: 200, body: { candidates: [imported(51, D(10)), needs(52, D(10))], truncated: false } }; } }));
  await openImports();
  gx().period.month = PREV;
  await act("training-load-gpexe-period-day", { day: D(8) });
  await act("training-load-gpexe-period-day", { day: D(12) });
  await settle();
  assert.deepEqual(gets("/candidates?from="), [`/candidates?from=${D(8)}&to=${D(8)}`, `/candidates?from=${D(8)}&to=${D(12)}`], "the first tap is a one-day period; the second makes it longer");
  assert.match(panel(), /Reading 2 older sessions on these days\.\.\./, "said while they are read");
  release();
  await settle();
  const p = panel();
  assert.match(p, /data-action="training-load-gpexe-open" data-candidate-id="cand-51"[\s\S]*?>imported</);
  assert.match(p, /data-action="training-load-gpexe-open" data-candidate-id="cand-52"[\s\S]*?>needs you</);
  assert.doesNotMatch(p, /Reading \d+ older/);
});

test("#540 5: a cut list whose calendar read fails keeps saying older sessions may not be shown; nothing is invented", async () => {
  resetState(); platform = false;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true, calendar: () => ({ status: 500, body: { error: "internal_error" } }) }));
  await openImports();
  gx().period.month = TODAY.slice(0, 7);
  await act("training-load-gpexe-period-month", { delta: "-1" });
  await settle();
  assert.match(panel(), /period-cap">Older sessions may not be shown\.</);
  assert.doesNotMatch(dayCell(panel(), D(10)), /period-chip/);
});

test("#540 6 (code review): a list reload drops the answer to the older-days read it replaced, even for the same days", async () => {
  resetState(); platform = false;
  const { reloadGpexeCandidates } = await import("../gpexe-import-data.js");
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  let n = 0;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true,
    older: async () => { n += 1; if (n === 1) { await heldA; return { status: 200, body: { candidates: [imported(52, D(10))] } }; } return { status: 200, body: { candidates: [needs(52, D(10))] } }; } }));
  await openImports();
  gx().period.month = PREV;
  await act("training-load-gpexe-period-day", { day: D(10) });
  await settle();
  await reloadGpexeCandidates(() => {});
  await settle();
  releaseA();
  await settle();
  assert.match(panel(), /data-candidate-id="cand-52"[\s\S]*?>needs you</, "the newer answer stays");
});

test("#540 7 (code review): an older read the server cut keeps the calendar's marks for the days it did not list, and says some are not listed", async () => {
  resetState(); platform = false;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true,
    calendar: () => ({ status: 200, body: { days: [{ day: D(8), chips: ["needs"], counts: { needs: 1, ready: 0, imported: 0, out: 0 } }, { day: D(10), chips: ["out"], counts: { needs: 0, ready: 0, imported: 0, out: 1 } }, { day: D(12), chips: ["ready"], counts: { needs: 0, ready: 1, imported: 0, out: 0 } }] } }),
    older: () => ({ status: 200, body: { candidates: [row(60, D(12))], truncated: true } }) }));
  await openImports();
  gx().period.month = PREV;
  await act("training-load-gpexe-period-day", { day: D(8) });
  await act("training-load-gpexe-period-day", { day: D(12) });
  await settle();
  const p = panel();
  assert.match(dayCell(p, D(8)), /period-chip is-needs/, "the day the cut read did not reach keeps its mark");
  assert.match(dayCell(p, D(10)), /period-chip is-out/, "so does a day between its first day and its first listed day");
  assert.match(p, /data-candidate-id="cand-60"/, "the listed one opens");
  assert.match(p, /2 older sessions are not listed here\./);
});

test("#540 8 (code review): suggested days on a cut list are read without choosing them, and nothing waits forever", async () => {
  resetState(); platform = false;
  // The oldest listed session needs finding again (not confirmed), so its day is suggested.
  const list = [...recent().slice(0, 5), row(6, daysAgo(5), { approvalBlockers: ["not_confirmed_for_import"] })];
  installFetchMock(gpexeServer({ candidates: list, truncated: true,
    calendar: () => ({ status: 200, body: { days: [{ day: daysAgo(5), chips: ["needs", "ready"], counts: { needs: 1, ready: 1, imported: 0, out: 0 } }] } }),
    older: () => ({ status: 200, body: { candidates: [row(6, daysAgo(5), { approvalBlockers: ["not_confirmed_for_import"] }), row(61, daysAgo(5))] } }) }));
  await openImports();
  // In the app the first paint comes before the reads; here the render is a no-op, so paint, then read.
  html();
  const { ensurePeriodData } = await import("../gpexe-import-data.js");
  await ensurePeriodData(() => {});
  await settle();
  assert.deepEqual(gets("/candidates?from="), [`/candidates?from=${daysAgo(5)}&to=${daysAgo(5)}`], "the suggested day is read");
  const p = panel();
  assert.match(p, /data-candidate-id="cand-6"/);
  assert.match(p, /data-candidate-id="cand-61"/);
  assert.doesNotMatch(p, /Reading \d+ older/);
});

test("#540 9 (code review): a failed older read of one day is read again when the day is chosen again", async () => {
  resetState(); platform = false;
  let n = 0;
  installFetchMock(gpexeServer({ candidates: recent(), truncated: true,
    older: () => { n += 1; return n === 1 ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: { candidates: [row(70, D(8))] } }; } }));
  await openImports();
  gx().period.month = PREV;
  await act("training-load-gpexe-period-day", { day: D(8) });
  await settle();
  await act("training-load-gpexe-period-clear");
  await act("training-load-gpexe-period-day", { day: D(8) });
  await settle();
  assert.equal(gets(`/candidates?from=${D(8)}&to=${D(8)}`).length, 2);
  assert.match(panel(), /data-candidate-id="cand-70"/);
});

test("#540 10 (code review): on the list's first day, a listed session the browser moved to Needs you (a link change) still counts as listed", async () => {
  resetState(); platform = false;
  const list = [...recent().slice(0, 5), { ...row(6, daysAgo(5)), state: "ready" }];
  installFetchMock(gpexeServer({ candidates: list, truncated: true,
    calendar: () => ({ status: 200, body: { days: [{ day: daysAgo(5), chips: ["ready"], counts: { needs: 0, ready: 1, imported: 0, out: 0 } }] } }) }));
  await openImports();
  gx().period.month = daysAgo(5).slice(0, 7);
  gx().linkSeq = 1; // a link made since the last search: the row reads Needs you
  html();
  const { ensurePeriodData } = await import("../gpexe-import-data.js");
  await ensurePeriodData(() => {});
  await settle();
  const cell = dayCell(panel(), daysAgo(5));
  assert.deepEqual([...cell.matchAll(/period-chip is-(\w+)/g)].map((x) => x[1]), ["needs"], "one session, one mark");
});
