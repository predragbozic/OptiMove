// PR #587: the team's session time zone, set from the review of a session whose GPS units report more than one time zone.
// Offered only to a viewer the status marks with sessionTimezoneAdmin (a platform admin; the team's club admin in the club's
// workspace); a coach reads one sentence: ask the club's admin. Driven through handleTrainingLoadAction with a fake fetch.
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
const { setGpexePollDelayForTests, importsUnloadShouldWarn } = await import("../gpexe-import-data.js");

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
  renders = 0;
}

function status({ enabled = true, canApprove = true, admin = false, tzAdmin = admin } = {}) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled, message: enabled ? "Approved imports can write results and activities in this environment." : "Import writing is switched off in this environment: checks and previews are saved, but no result or activity can be written." },
    lastCheck: null,
    // PR #587: the server marks a platform admin (and the team's club admin in the club's workspace) with sessionTimezoneAdmin.
    viewer: { canApprove, approvalBasis: canApprove ? "team_grant" : null, isPlatformAdmin: admin, identityAdmin: admin, ...(tzAdmin ? { sessionTimezoneAdmin: true } : {}) },
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

function gpexeServer({ teamStatus = {}, candidates = [], onImports, onCandidate, onTimezone } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const [, team, rest] = m;
    if (rest === "/session-timezone") return onTimezone ? onTimezone(call, team) : { status: 200, body: { sessionTimezone: { current: null, history: [] } } };
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
const { handleTimezoneInput } = await import("../gpexe-timezone-data.js");
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const blocked = (n, o = {}) => ready(n, { status: "blocked", previewStatus: "blocked", blockedCode: "source_data_inconsistent", blockedSourceCode: "mixed_timezones", approvalBlockers: ["blocked"], ...o });
const mixedDetail = (c) => ({ status: 200, body: { candidate: { ...candidateDetail(c), preview: { version: 3, status: "blocked", blocked: { code: "mixed_timezones", message: "tracks report more than one timezone: Zone/A, Zone/B.", resolution: [] }, counts: {}, changesToImported: [], athletes: [], teamAthletesWithoutGpexeRecord: [], anomalies: [] } } } });
const tzCalls = () => fetchCalls.filter((c) => c.url.endsWith("/session-timezone"));
const open = (s) => s.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
// What she types or picks: the field's value goes into state the way the page's input listener sends it.
function type(selector, value) {
  handleTimezoneInput({ value, matches: (sel) => sel === selector });
}

async function openMixedReview(teamStatus, onTimezone) {
  resetState();
  const c = blocked(2);
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: teamStatus }, candidates: [c], onCandidate: () => mixedDetail(c), onTimezone }));
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
  return c;
}

test("1. a club admin (sessionTimezoneAdmin, not a platform admin) sets the zone in the review; then one search for the session's day", async () => {
  const puts = [];
  await openMixedReview({ admin: false, tzAdmin: true }, (call) => {
    if (call.method === "PUT") {
      puts.push(call.body);
      return { status: 200, body: { sessionTimezone: { current: { timezone: call.body.timezone, setAt: "2026-11-17T09:00:00Z", reason: call.body.reason, setByName: "Club Admin" }, history: [] } } };
    }
    return { status: 200, body: { sessionTimezone: { current: null, history: [] } } };
  });
  let page = html();
  assert.match(page, /It is not imported until the team has a time zone\. Set the team(?:'|&#0?39;)s time zone, then find new sessions again with dates that include 02\.09\.2026\./);
  assert.match(page, /data-action="training-load-gpexe-tz-open"/);
  assert.equal(tzCalls().length, 0, "nothing is read before she asks");
  await act("training-load-gpexe-tz-open");
  page = html();
  assert.equal(tzCalls().length, 1);
  assert.match(page, /<strong>The team(?:'|&#0?39;)s time zone<\/strong>: not set/);
  assert.match(page, /data-gpexe-tz-zone/);
  // Nothing is sent without a zone and a reason.
  await act("training-load-gpexe-tz-save");
  assert.match(html(), /Choose a time zone\./);
  type("[data-gpexe-tz-zone]", "Europe/Sarajevo");
  await act("training-load-gpexe-tz-save");
  assert.match(html(), /Write why, for the record\./);
  assert.equal(puts.length, 0, "nothing sent while the form is incomplete");
  type("[data-gpexe-tz-reason]", "  Home matches in Sarajevo  ");
  await act("training-load-gpexe-tz-save");
  assert.deepEqual(puts, [{ timezone: "Europe/Sarajevo", reason: "Home matches in Sarajevo" }]);
  page = html();
  assert.match(page, /Saved\. The team(?:'|&#0?39;)s time zone is Europe\/Sarajevo\.<\/strong> Find new sessions for this session(?:'|&#0?39;)s day; then you can import it\./);
  assert.match(page, /data-action="training-load-gpexe-check" data-from="2026-09-02" data-to="2026-09-02">Find new sessions for 02\.09\.2026</);
  assert.match(page, /What to do:<\/strong> Find new sessions again with dates that include 02\.09\.2026, so this session is read in the team(?:'|&#0?39;)s time zone\./, "the step above follows the save");
  assert.ok(!/mixed_timezones|Zone\/A/.test(open(page)), "no code or server text in the open");
});

test("2. a coach (no sessionTimezoneAdmin): one sentence to ask the club's admin, no form, nothing read", async () => {
  await openMixedReview({ admin: false, tzAdmin: false });
  const page = html();
  assert.match(page, /It is not imported until the team has a time zone\. Ask your club(?:'|&#0?39;)s admin to set the team(?:'|&#0?39;)s time zone \(they can do it in this session(?:'|&#0?39;)s review\), then find new sessions again with dates that include 02\.09\.2026\./);
  assert.ok(!/training-load-gpexe-tz-|data-gpexe-tz-/.test(page), "no form, no button");
  await act("training-load-gpexe-tz-open");
  assert.equal(tzCalls().length, 0, "the action does nothing for her");
  assert.ok(!/mixed_timezones/.test(page), "a coach never gets the code");
});

test("3. a coded refusal: nothing was saved, in plain words; the form stays with what she typed; the 403's own sentence as it is", async () => {
  const answers = [
    [{ status: 409, body: { error: "gpexe_change_busy", message: "busy" } }, /A search or an import is running for this team\. Try again when it has finished\. Nothing was saved\./],
    [{ status: 400, body: { error: "invalid_timezone", message: "x" } }, /Choose a time zone from the list\. Nothing was saved\./],
    [{ status: 400, body: { error: "reason_required", message: "x" } }, /Write why, for the record\. Nothing was saved\./],
    [{ status: 403, body: { error: "forbidden", message: "Only a platform administrator, or the admin of this team's club working in the club's workspace, can see or set this team's time zone." } }, /Only a platform administrator, or the admin of this team(?:'|&#0?39;)s club working in the club(?:'|&#0?39;)s workspace, can see or set this team(?:'|&#0?39;)s time zone\./],
    [{ status: 404, body: { error: "notFound" } }, /This team is no longer available in this workspace\. Nothing was saved\./],
  ];
  for (const [answer, sentence] of answers) {
    await openMixedReview({ admin: false, tzAdmin: true }, (call) => (call.method === "PUT" ? answer : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
    await act("training-load-gpexe-tz-open");
    type("[data-gpexe-tz-zone]", "Europe/Sarajevo");
    type("[data-gpexe-tz-reason]", "Home games");
    await act("training-load-gpexe-tz-save");
    const page = html();
    assert.match(page, sentence);
    assert.equal(gx().tz.step, "open", "the form stays");
    assert.match(page, /<option value="Europe\/Sarajevo" selected>/);
    assert.match(page, />Home games<\/textarea>/);
    assert.ok(!/We can(?:'|&#0?39;)t tell/.test(page), "a refusal is never 'not confirmed'");
  }
});

test("4. a lost answer is never 'not saved': Check READS the zone (it never sends the save again)", async () => {
  for (const [current, saved] of [["Europe/Sarajevo", true], [null, false]]) {
    let puts = 0;
    await openMixedReview({ admin: false, tzAdmin: true }, (call) => {
      if (call.method === "PUT") {
        puts += 1;
        return { status: 502, body: null };
      }
      return { status: 200, body: { sessionTimezone: { current: puts ? (current ? { timezone: current } : null) : null, history: [] } } };
    });
    await act("training-load-gpexe-tz-open");
    type("[data-gpexe-tz-zone]", "Europe/Sarajevo");
    type("[data-gpexe-tz-reason]", "Home games");
    await act("training-load-gpexe-tz-save");
    let page = html();
    assert.match(page, /We can(?:'|&#0?39;)t tell whether the time zone was saved\. Check before saving it again\./);
    assert.ok(!/Nothing was saved/.test(page));
    // Closing the review keeps it for Check when she comes back.
    await act("training-load-gpexe-close");
    assert.equal(gx().tz?.step, "unknown");
    await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
    await act("training-load-gpexe-tz-check");
    assert.equal(puts, 1, "Check never sends the save again");
    page = html();
    if (saved) assert.match(page, /The team(?:'|&#0?39;)s time zone is Europe\/Sarajevo\./);
    else assert.match(page, /It was not saved: the team(?:'|&#0?39;)s time zone is still not set\. Save it again\./);
  }
});

test("5. a save the server confirmed stays saved when its details could not be read back (readError)", async () => {
  await openMixedReview({ admin: false, tzAdmin: true }, (call) => (call.method === "PUT"
    ? { status: 200, body: { sessionTimezone: { current: { timezone: "Europe/Sarajevo", setAt: null, reason: null, setByName: null }, history: null, readError: true } } }
    : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "Europe/Sarajevo");
  type("[data-gpexe-tz-reason]", "Home games");
  await act("training-load-gpexe-tz-save");
  assert.match(html(), /The team(?:'|&#0?39;)s time zone is Europe\/Sarajevo\./);
});

test("6. the zone in force is read when the form opens (another admin may have set it); a failed read changes nothing and offers Try again", async () => {
  let fail = true;
  await openMixedReview({ admin: false, tzAdmin: true }, () => (fail ? { status: 500, body: { error: "internal_error" } } : { status: 200, body: { sessionTimezone: { current: { timezone: "Europe/Stockholm" }, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  assert.match(html(), /The team(?:'|&#0?39;)s time zone could not be read\. Nothing was changed\./);
  fail = false;
  await act("training-load-gpexe-tz-open");
  let page = html();
  // Already set (UX review): she needs only the search; Change is there, not an open form.
  assert.match(page, /The team(?:'|&#0?39;)s time zone is Europe\/Stockholm\.<\/strong> You only need a new search/);
  assert.match(page, /What to do:<\/strong> Find new sessions again with dates that include 02\.09\.2026, so this session is read in the team(?:'|&#0?39;)s time zone\./);
  assert.ok(!/data-gpexe-tz-zone/.test(page), "no open form");
  await act("training-load-gpexe-tz-change");
  page = html();
  assert.match(page, /<option value="Europe\/Stockholm" selected>/, "the form opens on the zone in force");
  await act("training-load-gpexe-tz-cancel");
  assert.equal(gx().tz.step, "known", "Cancel goes back to the zone in force");
});

test("7. a platform admin has the form too; a form of another team is never shown; a save in flight keeps the review open", async () => {
  let release;
  await openMixedReview({ admin: true }, (call) => (call.method === "PUT"
    ? new Promise((r) => { release = () => r({ status: 200, body: { sessionTimezone: { current: { timezone: "UTC" }, history: [] } } }); })
    : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  assert.match(html(), /data-action="training-load-gpexe-tz-open"/);
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  const saving = act("training-load-gpexe-tz-save");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(html(), /Saving\.\.\./);
  await act("training-load-gpexe-close");
  assert.ok(gx().detail, "the review stays while the save is in flight");
  release();
  await saving;
  assert.equal(gx().tz.step, "saved");
  gx().tz.teamId = TEAM_B;
  assert.ok(!/The team(?:'|&#0?39;)s time zone is UTC/.test(html()), "another team's form is not this team's");
});

const { setTimezoneBoundForTests } = await import("../gpexe-timezone-data.js");

test("8 (code review): Next session waits for a save in flight - the button is off and the review stays", async () => {
  resetState();
  const [a, b] = [blocked(2), blocked(3)];
  let release;
  installFetchMock(gpexeServer({
    teamStatus: { [TEAM_A]: { tzAdmin: true } }, candidates: [a, b],
    onCandidate: (call, id) => mixedDetail(id === "cand-3" ? b : a),
    onTimezone: (call) => (call.method === "PUT" ? new Promise((r) => { release = () => r({ status: 200, body: { sessionTimezone: { current: { timezone: "UTC" }, history: [] } } }); }) : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }),
  }));
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  const saving = act("training-load-gpexe-tz-save");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(html(), /data-action="training-load-gpexe-group-next" disabled/);
  await act("training-load-gpexe-group-next");
  assert.equal(gx().detail?.id, "cand-2", "the review stays while the save is in flight");
  release();
  await saving;
  assert.equal(gx().tz.step, "saved");
  assert.equal(gx().detail?.id, "cand-2");
});

test("9 (code review): the app server's own 500 (a COMMIT whose answer was lost) is not confirmed, never 'Nothing was saved'", async () => {
  await openMixedReview({ tzAdmin: true }, (call) => (call.method === "PUT" ? { status: 500, body: { error: "Internal server error", message: "Something went wrong." } } : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  await act("training-load-gpexe-tz-save");
  assert.equal(gx().tz.step, "unknown");
  assert.match(html(), /We can(?:'|&#0?39;)t tell whether the time zone was saved/);
  assert.ok(!/Nothing was saved/.test(html()));
  // The pool's busy answer comes before any write: that one is a refusal.
  await openMixedReview({ tzAdmin: true }, (call) => (call.method === "PUT" ? { status: 503, body: { error: "database_busy" } } : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  await act("training-load-gpexe-tz-save");
  assert.match(html(), /OptiMove is busy right now\. Try again in a moment\. Nothing was saved\./);
});

test("10 (code review): a save that never answers ends as not confirmed at the client's bound", async () => {
  setTimezoneBoundForTests(20);
  // AbortSignal.timeout does not keep the process alive on its own: a timer of the test's does, until the bound fires.
  const keepAlive = setInterval(() => {}, 5);
  try {
    resetState();
    const c = blocked(2);
    installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: { tzAdmin: true } }, candidates: [c], onCandidate: () => mixedDetail(c) }));
    const answer = globalThis.fetch;
    globalThis.fetch = (url, options = {}) => (options.method === "PUT"
      ? new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))
      : answer(url, options));
    await act("training-load-section", { section: "imports" });
    await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
    await act("training-load-gpexe-tz-open");
    type("[data-gpexe-tz-zone]", "UTC");
    type("[data-gpexe-tz-reason]", "Test");
    await act("training-load-gpexe-tz-save");
    assert.equal(gx().tz.step, "unknown");
  } finally {
    clearInterval(keepAlive);
    setTimezoneBoundForTests(45_000);
  }
});

test("11 (code review): a result not confirmed keeps the team and warns on leaving the page", async () => {
  await openMixedReview({ tzAdmin: true }, (call) => (call.method === "PUT" ? { status: 502, body: null } : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  await act("training-load-gpexe-tz-save");
  await act("training-load-gpexe-close");
  assert.ok(importsUnloadShouldWarn(), "leaving the page asks");
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(gx().teamId, TEAM_A, "the team stays");
  assert.equal(gx().tz.step, "unknown");
});

test("12 (code review): a saved zone outlives Close - the row and the next review give the search step, not 'set it'", async () => {
  await openMixedReview({ tzAdmin: true }, (call) => (call.method === "PUT" ? { status: 200, body: { sessionTimezone: { current: { timezone: "UTC" }, history: [] } } } : { status: 200, body: { sessionTimezone: { current: null, history: [] } } }));
  await act("training-load-gpexe-tz-open");
  type("[data-gpexe-tz-zone]", "UTC");
  type("[data-gpexe-tz-reason]", "Test");
  await act("training-load-gpexe-tz-save");
  await act("training-load-gpexe-close");
  let page = html();
  assert.match(page, /Find new sessions again with dates that include 02\.09\.2026, so this session is read in the team(?:'|&#0?39;)s time zone/);
  assert.ok(!/Set the team(?:'|&#0?39;)s time zone, then/.test(page));
  await act("training-load-gpexe-open", { candidateId: "cand-2", group: "data" });
  page = html();
  assert.match(page, /data-action="training-load-gpexe-check" data-from="2026-09-02" data-to="2026-09-02">Find new sessions for 02\.09\.2026</);
});
