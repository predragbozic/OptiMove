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

const { guideSteps } = await import("../gpexe-guide-steps.js");
const { attentionGroups } = await import("../gpexe-attention-groups.js");

const unlinked = (n) => ready(n, { reasons: [{ code: "athletes_not_linked", count: 2 }], counts: { created: 4, athletesNotImported: 2 } });
const review = (n) => ready(n, { reasons: [{ code: "athletes_need_manual_review", count: 1 }] });
const tz = (n) => ready(n, { status: "blocked", previewStatus: "blocked", blockedCode: "mixed_timezones", blockedSourceCode: "mixed_timezones", reasons: [] });
const done = (n) => ({ candidateId: `cand-${n}`, outcome: "imported" });
const budget = (n) => ({ candidateId: `cand-${n}`, outcome: "not_attempted", code: "batch_time_budget" });

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

test("U6a 2: Needs attention is grouped by reason - 6 unlinked, 2 manual review, 1 data problem - each group with one sentence, a count and ONE button; the sessions are folded inside", async () => {
  resetState();
  const list = [...[1, 2, 3, 4, 5, 6].map(unlinked), ...[7, 8].map(review), tz(9)];
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: list }));
  await openImports();
  const page = html();
  assert.match(page, /<h3>Needs attention \(9\)<\/h3>/);
  const groups = [...page.matchAll(/<div class="imports-attn-group" data-attention-group="([a-z]+)">([\s\S]*?)<details class="imports-attn-sessions">/g)].map((m) => ({ key: m[1], html: m[2] }));
  assert.deepEqual(groups.map((g) => g.key), ["unlinked", "review", "data"], "the order is the order of what unblocks most");
  assert.ok(!/class="primary-button[^"]*"[^>]*data-attention/.test(page) && !groups.some((g) => /primary-button/.test(g.html)), "only the state bar's button is primary");
  const counts = groups.map((g) => g.html.match(/imports-attn-count">([^<]+)</)[1]);
  assert.deepEqual(counts, ["6 sessions", "2 sessions", "1 session"]);
  for (const g of groups) assert.equal((g.html.match(/<button /g) || []).length, 1, `${g.key}: one button`);
  assert.match(groups[0].html, /data-action="training-load-gpexe-map-open"[^>]*>Link athletes</);
  assert.match(groups[1].html, /data-action="training-load-gpexe-open" data-candidate-id="cand-7">Open the first session</, "a group of several says it opens the first");
  assert.match(groups[2].html, /data-action="training-load-gpexe-open" data-candidate-id="cand-9">Details</);
  assert.equal((page.match(/<details class="imports-attn-sessions">/g) || []).length, 3, "the sessions are folded");
  assert.ok(!/<details class="imports-attn-sessions" open/.test(page));
  assert.ok(!/mixed_timezones/.test(page.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "")), "no raw code in the open");
  // The group's button opens its first session through the ordinary review.
  await act("training-load-gpexe-open", { candidateId: "cand-9" });
  assert.equal(gx().detail?.id, "cand-9");
});

test("U6a 3: attentionGroups classifies each kind once, in the order of what unblocks most, and leaves empty groups out", () => {
  resetState();
  const g = attentionGroups([review(2), tz(3), unlinked(1), ready(4, { snapshot: { available: false } }), ready(5)], state.trainingLoad.gpexe);
  assert.deepEqual(g.map((x) => [x.key, x.count]), [["unlinked", 1], ["fresh", 1], ["review", 1], ["data", 1]]);
  assert.deepEqual(attentionGroups([ready(5)], state.trainingLoad.gpexe), [], "a clean ready session is in no group");
});

test("U6a 4: guide step 4 is not 'every GPEXE athlete is linked' while a session still lists an athlete as not linked", () => {
  const base = { admin: true, conn: { status: "ready", connected: true, bound: true }, check: { status: "succeeded" }, sourceAthletes: [{ status: "linked" }], links: [], teamSwitch: null, vars: null };
  const clean = guideSteps({ ...base, candidates: [ready(1)] });
  assert.equal(clean.steps.find((s) => s.id === 4).state, "done", "no open reason: done");
  const open = guideSteps({ ...base, candidates: [unlinked(1), ready(2)] });
  const s4 = open.steps.find((s) => s.id === 4);
  assert.equal(s4.state, "next");
  assert.match(s4.text, /Every athlete is linked now, but 1 session was reviewed before that/);
  assert.equal(s4.action?.kind, "check", "nothing is left to link: the way on is a new search, never a Link athletes button with nothing in it");
  const stillUnlinked = guideSteps({ ...base, sourceAthletes: [{ status: "unlinked" }], candidates: [unlinked(1)] }).steps.find((s) => s.id === 4);
  assert.equal(stillUnlinked.action?.kind, "link", "an athlete that is still not linked is linked first");
  assert.equal(guideSteps({ ...base, admin: false, candidates: [unlinked(1)] }).steps.find((s) => s.id === 4).action, null, "a coach gets the sentence only");
  // An imported or undone session no longer counts.
  const old = guideSteps({ ...base, candidates: [{ ...unlinked(1), status: "imported" }, { ...unlinked(2), importUndoneAt: "2026-11-01T00:00:00Z" }] });
  assert.equal(old.steps.find((s) => s.id === 4).state, "done");
  assert.equal(open.allDone, false);
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

function seriesServer(rounds, seen) {
  return gpexeServer({
    teamStatus: { [TEAM_A]: {} },
    candidates: [1, 2, 3, 4, 5, 6].map(ready),
    onImports: (call) => {
      seen.push(call.body);
      const next = rounds[Math.min(seen.length - 1, rounds.length - 1)];
      if (typeof next === "function") return next(call);
      return result({ imported: next.filter((r) => r.outcome === "imported").length, notAttempted: next.filter((r) => r.outcome === "not_attempted").length }, next);
    },
  });
}

test("U6a 6: a long selection goes on by itself - each round sends exactly the sessions the server did not try, with the hashes they were chosen with - until all are decided", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), budget(6)], [done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  assert.equal(seen.length, 0, "nothing is sent before the confirmation");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 3, "three requests");
  assert.deepEqual(seen[0].candidateIds, ["cand-1", "cand-2", "cand-3", "cand-4", "cand-5", "cand-6"]);
  assert.deepEqual(seen[1].candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"]);
  assert.deepEqual(seen[2].candidateIds, ["cand-6"]);
  for (const body of seen) for (const id of body.candidateIds) assert.equal(body.previewHashes[id], hashOf(Number(id.slice(5))), "the hash the session was chosen with");
  assert.equal(gx().batch.results.length, 6);
  assert.ok(gx().batch.results.every((r) => r.outcome === "imported"));
  assert.equal(gx().batch.summary.imported, 6, "the summary is the sum of the answers' own summaries");
  assert.equal(gx().batch.sending, false);
  assert.deepEqual(gx().batch.progress, { total: 6, done: 6, rounds: 3 });
});

test("U6a 7: the series stops at the first refusal that needs a person, at an unconfirmed result, and when a round decides nothing; what is left stays selected", async () => {
  for (const [name, firstRound] of [
    ["a refusal that needs a person", [done(1), { candidateId: "cand-2", outcome: "refused", code: "preview_changed" }, budget(3), budget(4), budget(5), budget(6)]],
    ["an unconfirmed result", [done(1), { candidateId: "cand-2", outcome: "import_outcome_unknown", code: "import_outcome_unknown" }, budget(3), budget(4), budget(5), budget(6)]],
    ["a round that decided nothing", [budget(1), budget(2), budget(3), budget(4), budget(5), budget(6)]],
  ]) {
    resetState();
    const seen = [];
    installFetchMock(seriesServer([firstRound], seen));
    await openImports();
    await act("training-load-gpexe-import-ready");
    await act("training-load-gpexe-batch-send");
    assert.equal(seen.length, 1, `${name}: no second request`);
    assert.equal(gx().batch.sending, false, name);
  }
});

test("U6a 8: a busy server (try_again) or a server fault does not count as a person's refusal - the series goes on with the sessions that were not tried", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), { candidateId: "cand-2", outcome: "refused", code: "try_again" }, budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"], "the busy one waits for the list, it is not resent by itself");
});

test("U6a 9: Stop ends the series after the request in flight; the rest is not sent", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([async () => { await act("training-load-gpexe-batch-stop"); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); }, [done(3), done(4), done(5), done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1);
  assert.equal(gx().batch.results.length, 6);
  assert.equal(gx().batch.stopRequested, false);
});

test("U6a 10: leaving Imports in the middle ends the series without another request; one click on Import ready sends what is left", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    () => { resetTrainingLoadForWorkspaceChange(); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); },
    [done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 1, "the answer of a page that was left starts no new request");
  // Back on the screen: the server still lists the four as Ready; one click sends exactly those.
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [3, 4, 5, 6].map(ready), onImports: (call) => { seen.push(call.body); return result({}, [done(3), done(4), done(5), done(6)]); } }));
  resetState();
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"]);
});

test("U6a 11: a lost answer in a later round marks only that round's sessions as not confirmed; the leave guard asks while the series runs", async () => {
  resetState();
  const seen = [];
  let guardWhileSending;
  installFetchMock(seriesServer([
    [done(1), done(2), budget(3), budget(4), budget(5), budget(6)],
    () => { guardWhileSending = importsUnloadShouldWarn(); throw new TypeError("network down"); },
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.equal(guardWhileSending, true, "the leave guard asks while the series runs");
  assert.equal(seen.length, 2);
  assert.deepEqual(gx().batch.unknown.candidateIds, ["cand-3", "cand-4", "cand-5", "cand-6"], "only the lost request's sessions");
  assert.ok(!gx().uncertain["cand-1"] && !gx().uncertain["cand-2"], "the sessions answered earlier are not marked");
  assert.equal(importsUnloadShouldWarn(), true, "and it keeps asking until the result is confirmed");
});

test("U6a 12: the summary of a long series is counted from each session's final result, never summed over the rounds", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], [done(3), done(4), done(5), budget(6)], [done(6)]], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.deepEqual(gx().batch.summary, { requested: 6, imported: 6, alreadyImported: 0, refused: 0, unknown: 0, notAttempted: 0 });
  assert.ok(!/not tried/.test(dialog() || ""), "no 'not tried' on a series that finished");
});

test("U6a 13: a refusal in a later round (the switch turned off) shows what the earlier round did and why the series stopped, and the list is read again", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([[done(1), done(2), budget(3), budget(4), budget(5), budget(6)], () => ({ status: 409, body: { error: "import_switch_off", message: "Importing is switched off." } })], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  const readsBefore = candidatesReads();
  await act("training-load-gpexe-batch-send");
  assert.equal(seen.length, 2);
  const panel = dialog();
  assert.match(panel, /The series stopped\./, "the reason is shown in the result panel");
  assert.match(panel, /Imported\./, "and what the first round did");
  assert.ok(candidatesReads() > readsBefore, "the list is read again after sessions were imported in round 1");
});

test("U6a 14: confirming a move to another part of the app while a series runs stops it after the request in flight, and the question says so", async () => {
  resetState();
  const seen = [];
  installFetchMock(seriesServer([
    () => { assert.equal(confirmLeaveTrainingLoad("calendar"), true); return result({}, [done(1), done(2), budget(3), budget(4), budget(5), budget(6)]); },
    [done(3), done(4), done(5), done(6)],
  ], seen));
  await openImports();
  await act("training-load-gpexe-import-ready");
  await act("training-load-gpexe-batch-send");
  assert.match(confirmQuestions.at(-1), /it stops after the request in flight; what is left stays under Imports/);
  assert.equal(seen.length, 1, "no second round after the person agreed to leave");
});

test("U6a 15: a result that is not confirmed is the first group; the guide never offers Link athletes when nothing is left to link", async () => {
  resetState();
  installFetchMock(gpexeServer({ teamStatus: { [TEAM_A]: {} }, candidates: [unlinked(1), review(2), ready(3)] }));
  await openImports();
  gx().uncertain["cand-2"] = { kind: "unknown", error: { status: 503, code: "import_outcome_unknown" }, verify: null, checks: 0 };
  const keys = attentionGroups(gx().candidates, gx()).map((g) => g.key);
  assert.equal(keys[0], "unknown");
});
