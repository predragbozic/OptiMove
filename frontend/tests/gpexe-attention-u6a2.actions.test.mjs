// U6a-2: the daily Imports screen closer to the agreed "GPS Import Flow" proposal - the sessions that need a person grouped
// by what is in the way (one sentence, one button, the sessions folded), the review stepping through its group, the
// "Ready" / "Needs you" counts, the day line of a row, the leave note of a search, the shorter confirmation and the result
// that points to Activities, mixed time zones as a data problem, and guide step 4. Driven through handleTrainingLoadAction
// with a fake fetch, like the other Imports suites.
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

function status({ enabled = true, canApprove = true, admin = false } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck: null,
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: admin, identityAdmin: admin },
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
const groupKeys = (page = html()) => [...page.matchAll(/data-attention-group="([a-z]+)"/g)].map((m) => m[1]);
const groupHtml = (key, page = html()) => {
  const at = page.indexOf(`data-attention-group="${key}"`);
  assert.ok(at > 0, `group ${key} is shown`);
  const end = page.indexOf('class="imports-attn-group"', at + 10);
  return page.slice(at, end > 0 ? end : page.indexOf('aria-label="Ready to import"', at));
};
const unlinked = (n, o = {}) => ready(n, { previewStatus: "ready", counts: { created: 2, athletesNotImported: 1 }, reasons: [{ code: "athletes_not_linked", count: 1 }], ...o });
const blocked = (n, o = {}) => ready(n, { status: "blocked", previewStatus: "blocked", blockedCode: "source_data_inconsistent", blockedSourceCode: "mixed_timezones", approvalBlockers: ["blocked"], ...o });
const notConfirmed = (n, o = {}) => ready(n, { approvalBlockers: ["not_confirmed_for_import"], ...o });
const manual = (n, o = {}) => ready(n, { counts: { created: 2, athletesNotImported: 1 }, reasons: [{ code: "athletes_need_manual_review", count: 1 }], ...o });

test("1. the sessions that need a person are grouped by what is in the way, in a fixed order, each with one sentence, a count and ONE button; a group of several is folded", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), blocked(2), manual(3), unlinked(4), notConfirmed(5), unlinked(6), ready(7)] }));
  await openImports();
  const page = html();
  assert.deepEqual(groupKeys(page), ["unlinked", "fresh", "review", "data"]);
  const u = groupHtml("unlinked", page);
  assert.match(u, /<h4>Athletes not linked<\/h4><span class="imports-attn-count">2 sessions<\/span>/);
  assert.match(u, /These sessions have athletes who are not linked to a team athlete yet\. Link them from their rows, session by session\./);
  assert.equal((u.match(/<div class="imports-attn-actions">[\s\S]*?<\/div>/)[0].match(/<button/g) || []).length, 1, "one button");
  assert.match(u, /data-action="training-load-gpexe-open" data-candidate-id="cand-4" data-group="unlinked">Link athletes</);
  assert.match(u, /<details class="imports-attn-sessions"><summary>Show the 2 sessions<\/summary>/, "several sessions are folded");
  assert.match(u, /data-candidate-id="cand-6" data-group="unlinked"/, "a row inside the group opens the review in the group");
  const f = groupHtml("fresh", page);
  assert.match(f, /data-action="training-load-gpexe-check" data-from="2026-09-05" data-to="2026-09-05" >Find again for 05\.09\.2026</);
  assert.match(f, /The last search did not confirm this session/, "a group of one is spoken of in the singular");
  assert.ok(!/<details class="imports-attn-sessions">/.test(f), "a group of one shows its session");
  assert.match(groupHtml("review", page), /data-candidate-id="cand-3" data-group="review">Open the session</);
  assert.match(page, /<h4>Needs a look<\/h4>/);
  assert.match(groupHtml("data", page), /data-candidate-id="cand-2" data-group="data">See why</);
  assert.match(page, /<h3>Needs you \(5\)<\/h3>/);
  assert.match(page, /<h3>Ready to import \(2\)<\/h3>/);
});

test("2. (D4) the state bar counts 'Ready: N' and 'Needs you: N' from the whole list - a day picked in the calendar does not change them; with nothing to do there is no 'Needs you'", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2), unlinked(3)] }));
  await openImports();
  const bar = () => html().match(/<div class="imports-statusbar"[\s\S]*?<div class="imports-actions">/)[0];
  assert.match(bar(), /<span class="imports-pill is-ready">Ready: 2<\/span><span class="imports-pill is-needs">Needs you: 1<\/span>/);
  await act("training-load-gpexe-cal-day", { day: calendarDayKey(ready(1).sessionStartedAt) });
  assert.match(bar(), /Ready: 2<\/span><span class="imports-pill is-needs">Needs you: 1</, "the day filter does not change the counts");
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  assert.match(bar(), /Ready: 1<\/span>/);
  assert.ok(!/Needs you/.test(bar()));
});

test("3. (J20 section 8) the group's button opens its first session; the review says where it is in the group and Next session steps to the next one as the list is now; the last one offers no Next", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [unlinked(4), manual(5), unlinked(6), unlinked(8)] }));
  await openImports();
  await act("training-load-gpexe-open", { candidateId: "cand-4", group: "unlinked" });
  let page = html();
  assert.match(page, /Session 1 of 3 in &quot;Athletes not linked&quot;/);
  assert.match(page, /data-action="training-load-gpexe-group-next" >Next session</);
  await act("training-load-gpexe-group-next");
  assert.equal(gx().detail.id, "cand-6", "the next of the same group, never the manual-review session between them");
  assert.equal(gx().detail.group, "unlinked");
  assert.match(html(), /Session 2 of 3 in &quot;Athletes not linked&quot;/);
  await act("training-load-gpexe-group-next");
  assert.equal(gx().detail.id, "cand-8");
  page = html();
  assert.match(page, /This is the last session in &quot;Athletes not linked&quot;\./);
  assert.ok(!/training-load-gpexe-group-next/.test(page), "the last one offers no Next");
  assert.match(page, /class="imports-group-nav"[\s\S]*?data-action="training-load-gpexe-close" >Back to Imports</);
  // A session opened from the plain list (no group) shows no group line.
  await act("training-load-gpexe-close");
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  assert.ok(!/imports-group-nav/.test(html()));
  await act("training-load-gpexe-group-next");
  assert.equal(gx().detail.id, "cand-5", "Next does nothing outside a group");
});

test("4. Next session is off while something of the review must still be seen (an approval, an update, a link), and the handler refuses it too", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [unlinked(4), unlinked(6)] }));
  await openImports();
  await act("training-load-gpexe-open", { candidateId: "cand-4", group: "unlinked" });
  const holds = [
    () => { gx().detail.approving = true; },
    () => { gx().detail.verifying = true; },
    () => { gx().detail.updating = true; },
    () => { gx().linkBusy = true; },
    () => { gx().undo = { id: "cand-4", step: "sending", requestKey: "k" }; },
    // An undo whose result is not confirmed: its Check the result lives in this review.
    () => { gx().undo = { id: "cand-4", step: "unknown", requestKey: "k" }; },
    // J20-C: attendance states being saved after the import, or sent and not confirmed.
    () => { gx().detail.states = { ...gx().detail.states, saving: true, groups: {} }; },
    () => { gx().detail.states = { ...gx().detail.states, saving: false, groups: { a: { status: "sent" } } }; },
    () => { gx().detail.states = { ...gx().detail.states, saving: false, groups: { a: { status: "unknown" } } }; },
  ];
  const original = gx().detail.states || { choices: {}, groups: {} };
  gx().detail.states = original;
  for (const hold of holds) {
    hold();
    assert.match(html(), /data-action="training-load-gpexe-group-next" disabled>/);
    await act("training-load-gpexe-group-next");
    assert.equal(gx().detail.id, "cand-4", "not moved");
    Object.assign(gx().detail, { approving: false, verifying: false, updating: false, states: original });
    gx().linkBusy = false;
    gx().undo = null;
  }
  // A states group that can't be checked from here (unknown with a code) offers nothing more and does not hold it.
  gx().detail.states = { ...original, saving: false, groups: { a: { status: "unknown", code: "try_again" } } };
  assert.match(html(), /data-action="training-load-gpexe-group-next" >Next session</);
  // Saved states do not hold it.
  gx().detail.states = { ...(original || {}), saving: false, groups: { a: { status: "saved" } } };
  assert.match(html(), /data-action="training-load-gpexe-group-next" >Next session</);
});

test("5. (D5) a row reads 'Tue 01.09. · <name>' with the time beside it, on the local clock", async () => {
  resetState();
  const iso = "2026-11-03T16:08:12Z";
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1, { sessionStartedAt: iso, label: "FULL TRAINING MD-4" })] }));
  await openImports();
  const d = new Date(iso);
  const two = (n) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  assert.ok(html().includes(`<strong>${day} ${two(d.getDate())}.${two(d.getMonth() + 1)}. · FULL TRAINING MD-4</strong>\n          <span class="muted">${two(d.getHours())}:${two(d.getMinutes())}</span>`));
});

test("6. (D8) mixed time zones: a data problem in plain words for everyone; the code only in an administrator's Technical details", async () => {
  for (const admin of [false, true]) {
    resetState();
    installFetchMock(gpexeServer({
      teamStatus: { [TEAM_A]: { admin } },
      candidates: [blocked(2)],
      onCandidate: (call, id) => ({ status: 200, body: { candidate: { ...candidateDetail(blocked(2)), preview: { version: 3, status: "blocked", blocked: { code: "mixed_timezones", message: "tracks report more than one timezone: Zone/A, Zone/B.", resolution: [] }, counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [] } } } }),
    }));
    await openImports();
    const list = html();
    assert.match(groupHtml("data", list), /Problem in the GPEXE data/);
    assert.match(list, /Nothing to do for now\. It is not imported until this is settled; your administrator can see the details\./);
    assert.ok(!/mixed_timezones|Zone\/A/.test(list.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "")), "no code in the open");
    await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
    const review = html();
    assert.match(review, /GPEXE reports this session(?:'|&#0?39;)s GPS devices in more than one time zone/);
    const open = review.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
    assert.ok(!/mixed_timezones|Zone\/A/.test(open), "no code or server text in the open");
    if (admin) assert.match(review, /<details class="gpexe-tech">[\s\S]*mixed_timezones/, "an administrator has the code");
    else assert.ok(!/mixed_timezones/.test(review), "a coach never gets the code");
  }
});

test("7. (D3) while a search runs the screen says it may be left; the sentence goes when the search ends", async () => {
  resetState();
  let poll = { status: 200, body: { check: { id: "chk-1", status: "running", window: { from: "2026-09-01", to: "2026-09-14" }, startedAt: "2026-09-14T10:00:00Z", sessionsSeen: 1, candidatesNew: 1, candidatesChanged: 0, candidatesUnchanged: 0 } } };
  const base = gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] });
  installFetchMock(async (call) => {
    if (call.url.endsWith("/checks") && call.method === "POST") return { status: 202, body: poll.body };
    if (/\/checks\/chk-1$/.test(call.url)) return poll;
    return base(call);
  });
  await openImports();
  let polls = 0;
  setGpexePollDelayForTests(() => { polls += 1; if (polls > 1) poll = { status: 200, body: { check: { ...poll.body.check, status: "succeeded", finishedAt: "2026-09-14T10:02:00Z" } } }; return Promise.resolve(); });
  try {
    await act("training-load-gpexe-check");
  } finally {
    setGpexePollDelayForTests(() => Promise.resolve());
  }
  assert.ok(polls >= 1);
  assert.ok(!/You can leave this page/.test(html()), "gone once the search has ended");
  gx().check = { ...poll.body.check, status: "running" };
  assert.match(html(), /You can leave this page\. The search goes on in OptiMove, and the sessions are here when you come back\./);
});

test("8. (D7) the confirmation is one question naming the team; the result says how many were imported and points to Activities", async () => {
  resetState();
  let list = [ready(1), ready(2)];
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: () => list,
    onImports: (call) => {
      list = list.map((c) => ({ ...c, status: "imported", importedAt: "2026-09-22T12:00:00Z" }));
      return result({ imported: 2 }, call.body.candidateIds.map((id) => ({ candidateId: id, outcome: "imported", approvalId: `appr-${id}`, commitConfirmation: "confirmed" })));
    },
  }));
  await openImports();
  await act("training-load-gpexe-import-ready");
  assert.match(dialog(), /<strong>Import 2 sessions into First Team\? Their values appear in Training Load right away\.<\/strong>/);
  await act("training-load-gpexe-batch-send");
  const d = dialog();
  assert.match(d, /<p class="imports-batch-summary" role="status">Imported 2 sessions\.<\/p>/);
  assert.match(d, /You can see them in Training Load → Activities\./);
  assert.match(d, /data-action="training-load-section" data-section="today">Open Activities</);
  await act("training-load-section", { section: "today" });
  assert.equal(state.trainingLoad.section, "today", "Open Activities leaves Imports for Activities");
});

test("9. (D7) a result that is not all imported keeps the counts line and offers Activities only when something was imported", async () => {
  resetState();
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [ready(1), ready(2)],
    onImports: (call) => result({ refused: 2 }, call.body.candidateIds.map((id) => ({ candidateId: id, outcome: "refused", code: "preview_changed" }))),
  }));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  const d = dialog();
  assert.match(d, /2 not imported\./);
  assert.ok(!/Open Activities/.test(d));
});

test("10. a stale review (links changed after it) is its own group whose button opens the review that updates itself; no dates are set for it", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1), ready(2, { lastSeenAt: "2026-09-25T10:00:00Z" })] }));
  await openImports();
  gx().linkSeq = 1;
  gx().linkCheckStartedAt = "2026-09-25T09:00:00Z";
  const page = html();
  assert.deepEqual(groupKeys(page), ["stale"]);
  assert.match(groupHtml("stale", page), /data-candidate-id="cand-1" data-group="stale">Update the review</);
  assert.ok(!/<details class="imports-dates" open>/.test(page), "no search is asked for");
  await act("training-load-gpexe-open", { candidateId: "cand-1", group: "stale" });
  assert.match(html(), /data-action="training-load-gpexe-review-update">Update the review</);
});

test("11. (D2) the search button keeps its name, and the line under the bar says a search imports nothing", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [] }));
  await openImports();
  const page = html();
  assert.match(page, /data-action="training-load-gpexe-check" >Find new sessions</);
  const bar = page.indexOf('class="imports-statusbar"');
  const line = page.indexOf("Finding sessions does not import anything; you choose what to import.");
  assert.ok(bar > 0 && line > bar && line < page.indexOf('class="imports-dates"'), "right under the bar, before the dates");
  assert.equal(page.split("does not import anything").length, 2, "said once");
});

test("12. guide step 4 is not done while a session still lists an athlete as not linked, even when the athletes list has none; it points to the group, not to a search", async () => {
  const { guideSteps } = await import("../gpexe-guide-steps.js");
  const base = { admin: true, conn: { status: "ready", connected: true, bound: true }, check: { status: "succeeded" }, sourceAthletes: [{ status: "linked" }], links: [], teamSwitch: null, vars: null };
  const done = guideSteps({ ...base, candidates: [ready(1)] }).steps.find((s) => s.id === 4);
  assert.equal(done.state, "done");
  const open = guideSteps({ ...base, candidates: [unlinked(2)] }).steps.find((s) => s.id === 4);
  assert.equal(open.state, "next");
  assert.match(open.text, /1 session still has athletes that are not linked\. Open it under "Athletes not linked" below/);
  assert.equal(open.action, null, "no Link athletes screen for it (every listed athlete is linked) and no search");
  const imported = guideSteps({ ...base, candidates: [unlinked(3, { status: "imported" })] }).steps.find((s) => s.id === 4);
  assert.equal(imported.state, "done", "an imported session no longer counts");
  const some = guideSteps({ ...base, sourceAthletes: [{ status: "unlinked" }, { status: "linked" }], candidates: [unlinked(2)] }).steps.find((s) => s.id === 4);
  assert.equal(some.action?.kind, "link", "an athlete still unlinked in the list keeps the Link athletes button");
});

test("13. the group a review steps through is the one it was opened with: a link that moves the other sessions to 'Review out of date' does not end it, and Next skips a session that no longer needs anyone", async () => {
  resetState();
  let list = [unlinked(4), unlinked(6), unlinked(8), unlinked(9)];
  const base = gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: () => list });
  installFetchMock(async (call) => {
    if (call.method === "POST" && call.url.endsWith("/athlete-links")) return { status: 201, body: { link: { id: "link-1" } } };
    if (call.method === "GET" && call.url.endsWith("/athlete-links")) return { status: 200, body: { links: [] } };
    if (call.method === "POST" && /\/candidates\/cand-4\/preview$/.test(call.url)) return { status: 200, body: { candidate: candidateDetail({ ...unlinked(4), reasons: [], counts: { created: 3, athletesNotImported: 0 } }) } };
    return base(call);
  });
  await openImports();
  await act("training-load-gpexe-open", { candidateId: "cand-4", group: "unlinked" });
  assert.deepEqual(gx().detail.groupIds, ["cand-4", "cand-6", "cand-8", "cand-9"]);
  // A real link from the review: the links change, so the other sessions are now "Review out of date".
  gx().linkConfirm = { gpexeAthleteId: "104", athleteId: "ath-1", athleteName: "Ana Example" };
  await act("training-load-gpexe-link-confirm");
  assert.ok(fetchCalls.some((c) => c.method === "POST" && c.url.endsWith("/athlete-links")), "the link was sent");
  assert.match(html(), /Session 1 of 4 in &quot;Athletes not linked&quot;[\s\S]*?data-action="training-load-gpexe-group-next" >Next session</, "the stepping goes on after the link");
  // cand-6 is imported meanwhile (it no longer needs anyone): Next goes past it.
  list = list.map((c) => (c.id === "cand-6" ? { ...c, status: "imported", importedAt: "2026-09-22T12:00:00Z" } : c));
  gx().candidates = gx().candidates.map((c) => (c.id === "cand-6" ? { ...c, status: "imported", importedAt: "2026-09-22T12:00:00Z" } : c));
  await act("training-load-gpexe-group-next");
  assert.equal(gx().detail.id, "cand-8", "the next one that still needs a person, never back to the start");
  assert.match(html(), /Session 3 of 4/);
});

test("14. 'Find again for …' names the dates the search will use (clipped to the latest 31 days) and sends exactly those", async () => {
  resetState();
  const expired = (n, day) => ready(n, { sessionStartedAt: day, snapshot: { available: false, expiresAt: "2026-08-31T00:00:00Z" } });
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [expired(1, "2026-08-01T10:00:00Z"), expired(2, "2026-09-14T10:00:00Z")] }));
  await openImports();
  const f = groupHtml("fresh");
  assert.match(f, /data-from="2026-08-15" data-to="2026-09-14" >Find again for 15\.08\.2026 - 14\.09\.2026</);
  const starts = [];
  const base = gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [] });
  installFetchMock(async (call) => {
    if (call.method === "POST" && call.url.endsWith("/checks")) { starts.push(call.body); return { status: 409, body: { error: "check_already_running" } }; }
    return base(call);
  });
  await act("training-load-gpexe-check", { from: "2026-08-15", to: "2026-09-14" });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].from, "2026-08-15");
  assert.equal(starts[0].to, "2026-09-14");
});

test("15. a stale review asks for no search until updating it failed", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [ready(1)] }));
  await openImports();
  gx().linkSeq = 1;
  gx().linkCheckStartedAt = "2026-09-25T09:00:00Z";
  await act("training-load-gpexe-open", { candidateId: "cand-1", group: "stale" });
  const note = () => (html().match(/<p class="gpexe-warning gpexe-approve-note"[\s\S]*?<\/p>/) || [""])[0];
  assert.match(note(), /Approving waits until the review is updated\./);
  assert.ok(!/find new sessions/i.test(note()));
  gx().detail.updateError = { status: 503, code: "try_again" };
  assert.match(note(), /Update the review again, or close it and find new sessions \(with dates that include 01\.09\.2026\)/);
});

test("16. with nothing ready, the first group's button is the one main action when it is a step the person can take now; otherwise the search or Import N ready stays the main one", async () => {
  const primaries = (page) => (page.match(/class="primary-button gpexe-button"/g) || []).length;
  for (const [list, groupMain] of [[[unlinked(4)], true], [[ready(1), unlinked(4)], false], [[notConfirmed(5)], false], [[blocked(2)], false]]) {
    resetState();
    installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: list }));
    await openImports();
    const page = html();
    const groupBtn = page.match(/<div class="imports-attn-actions"><button type="button" class="(\w+)-button/)[1];
    const findBtn = page.match(/class="(\w+)-button gpexe-button" data-action="training-load-gpexe-check" /)[1];
    assert.equal(groupBtn, groupMain ? "primary" : "plain", JSON.stringify(list.map((c) => c.id)));
    if (groupMain) assert.equal(findBtn, "plain");
    assert.equal(primaries(page.slice(0, page.indexOf('aria-label="Ready to import"'))), 1, "one main action");
  }
});

test("17. Back to Imports at the end of a group waits for what the dialog's Close waits for, and nothing more", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [unlinked(4), unlinked(6)] }));
  await openImports();
  await act("training-load-gpexe-open", { candidateId: "cand-6", group: "unlinked" });
  const back = () => html().match(/data-action="training-load-gpexe-close" (disabled)?>Back to Imports</)[1] || "";
  assert.match(html(), /This is the last session in &quot;Athletes not linked&quot;\./);
  assert.equal(back(), "");
  gx().detail.states = { ...(gx().detail.states || { choices: {} }), saving: true, groups: {} };
  assert.equal(back(), "", "states being saved do not hold Close (they stop with it, J20-C test 25)");
  gx().detail.approving = true;
  assert.equal(back(), "disabled");
});
