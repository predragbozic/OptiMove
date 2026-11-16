// Imports "Fix" flow, slice 1 (manager's GO, 2026-11-16): a session that needs a person is fixed one problem per screen -
// a) a result not confirmed, b) athletes not linked (one GPEXE athlete per step), c) a review out of date (never when the
// recompute after the link already ran), d) a new search - then "This session is ready" with the viewer's own end, and the
// next session of the group. Every step is the review's own request. Driven through handleTrainingLoadAction with a fake
// fetch, like the other Imports suites.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
let confirmQuestions = [];
const selectValues = {};
globalThis.document = {
  querySelector: (sel) => {
    const m = String(sel).match(/data-gpexe-link-select='([^']+)'/);
    return m ? { value: selectValues[m[1]] || "" } : null;
  },
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

let fetchCalls;
function installFetchMock(responder) {
  fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    fetchCalls.push(call);
    const result = await responder(call);
    if (result === "lost") throw new TypeError("Failed to fetch");
    return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
  };
}

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
const { closeFixFromKey } = await import("../gpexe-import-actions.js");

setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG = { teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }], clubs: [], athletes: [] };
const hashOf = (n) => String(n).padStart(2, "0").repeat(32);
const NAMES = { "ath-1": { name: "Alex Example" }, "ath-2": { name: "Blake Sample" }, "ath-3": { name: "Casey Test" }, "ath-9": { name: "Drew Linked" } };

let viewer;
function resetState() {
  clearAllViewCache();
  state.activeTab = "training-load";
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = "imports";
  confirmAnswer = true;
  confirmQuestions = [];
  for (const k of Object.keys(selectValues)) delete selectValues[k];
  viewer = { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: false };
}
function status({ enabled = true } = {}) {
  return { settings: { gpexeTeamId: "980" }, importSwitch: { enabled, message: "" }, lastCheck: null, viewer, approvalAvailable: true };
}

function row(n, o = {}) {
  return {
    id: `cand-${n}`, gpexeTeamSessionId: `70${String(n).padStart(2, "0")}`, label: `FULL TRAINING ${n}`, sessionStartedAt: `2026-09-${String(n).padStart(2, "0")}T16:08:12Z`,
    status: "pending", previewStatus: "ready", previewHash: hashOf(n), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
    snapshot: { available: true, expiresAt: "2099-01-01T00:00:00Z" }, approvalBlockers: [],
    blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [], lastSeenAt: "2026-09-22T10:00:00Z", ...o,
  };
}

// A small world: sessions, their GPEXE athletes and the team's links. A link changes what a recompute says.
function world({ sessions, unlinkedBy = {}, extraAthletes = {}, links = [], switchOn = true, globalOn = true, onLink, onPreview, onApprove, onCheck, onCandidate } = {}) {
  const w = { sessions: sessions.map((s) => ({ ...s })), links: [...links], unlinkedBy };
  const preview = (s) => {
    const ids = (w.unlinkedBy[s.id] || []).filter((g) => !w.links.some((l) => l.gpexeAthleteId === g));
    const linkedHere = (w.unlinkedBy[s.id] || []).filter((g) => w.links.some((l) => l.gpexeAthleteId === g));
    return {
      version: 3, status: "ready", blocked: null, counts: s.counts, changesToImported: [], anomalies: [], unactivatedSourceMetricCount: 0,
      athletes: [
        { gpexeAthleteId: "900", athleteId: "ath-9", results: [] },
        ...linkedHere.map((g) => ({ gpexeAthleteId: g, athleteId: w.links.find((l) => l.gpexeAthleteId === g).athleteId, results: [] })),
        ...ids.map((g) => ({ gpexeAthleteId: g, athleteId: null, notImported: { code: "athlete_not_linked" }, results: [] })),
        ...(extraAthletes[s.id] || []),
      ],
      teamAthletesWithoutGpexeRecord: ["ath-1", "ath-2", "ath-3"].filter((a) => !w.links.some((l) => l.athleteId === a)).map((athleteId) => ({ athleteId })),
    };
  };
  const summary = (s) => {
    const ids = (w.unlinkedBy[s.id] || []).filter((g) => !w.links.some((l) => l.gpexeAthleteId === g));
    return { ...s, reasons: ids.length ? [{ code: "athletes_not_linked", count: ids.length }] : s.reasons, counts: { ...s.counts, athletesNotImported: ids.length }, approvalBlockers: switchOn ? s.approvalBlockers : [...s.approvalBlockers, "team_import_switch_off"] };
  };
  const detail = (s) => ({ ...summary(s), athletes: NAMES, preview: preview(s), approval: s.status === "imported" ? { id: `appr-${s.id}`, import: {} } : null });
  w.server = async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: { ...status({ enabled: globalOn }), ...(switchOn ? {} : { teamImportSwitch: { enabled: false, mode: "team" } }) } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: w.links } };
    if (rest === "/athlete-links" && call.method === "POST") {
      if (onLink) { const r = await onLink(call, w); if (r) return r; }
      const link = { id: `link-${w.links.length + 1}`, gpexeAthleteId: call.body.gpexeAthleteId, athleteId: call.body.athleteId };
      w.links.push(link);
      return { status: 201, body: { link } };
    }
    if (rest.startsWith("/candidates?") || rest === "/candidates") return { status: 200, body: { candidates: w.sessions.map(summary) } };
    if (rest === "/checks" && call.method === "POST") {
      if (onCheck) return onCheck(call, w);
      // As the real check: the sessions it saw are seen again after it started.
      for (const x of w.sessions) if (x.sessionStartedAt.slice(0, 10) >= call.body.from && x.sessionStartedAt.slice(0, 10) <= call.body.to) x.lastSeenAt = "2026-09-22T11:00:30Z";
      return { status: 202, body: { check: { id: "chk-1", status: "running", window: { from: call.body.from, to: call.body.to }, startedAt: "2026-09-22T11:00:00Z", sessionsSeen: 1, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 1, error: null } } };
    }
    // The real check runs, then is polled until it ends.
    if (rest === "/checks/chk-1") return { status: 200, body: { check: { id: "chk-1", status: "succeeded", startedAt: "2026-09-22T11:00:00Z", finishedAt: "2026-09-22T11:01:00Z", sessionsSeen: 1, candidatesNew: 0, candidatesChanged: 0, candidatesUnchanged: 1, error: null } } };
    const pre = rest.match(/^\/candidates\/([^/?]+)\/preview$/);
    if (pre) {
      if (onPreview) { const r = await onPreview(call, w); if (r) return r; }
      const s = w.sessions.find((x) => x.id === pre[1]);
      return { status: 200, body: { candidate: detail(s) } };
    }
    const ap = rest.match(/^\/candidates\/([^/?]+)\/approve$/);
    if (ap) {
      if (onApprove) { const r = await onApprove(call, w); if (r) return r; }
      const s = w.sessions.find((x) => x.id === ap[1]);
      s.status = "imported";
      s.state = "imported";
      return { status: 200, body: { approval: { id: `appr-${s.id}` }, import: {}, candidate: detail(s) } };
    }
    const d = rest.match(/^\/candidates\/([^/?]+)$/);
    if (d) {
      if (onCandidate) { const r = await onCandidate(call, w); if (r) return r; }
      const s = w.sessions.find((x) => x.id === d[1]);
      return s ? { status: 200, body: { candidate: detail(s) } } : { status: 404, body: { error: "notFound" } };
    }
    return { status: 404, body: { error: "notFound" } };
  };
  return w;
}

const render = () => {};
async function act(action, dataset = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset } }, { renderTrainingLoad: render });
}
const html = () => renderTrainingLoadCoachHtml();
const gx = () => state.trainingLoad.gpexe;
const sheet = () => (html().match(/<section class="gpexe-panel imports-fix is-open"[\s\S]*?<\/section>/) || [""])[0];
const posts = (re) => fetchCalls.filter((c) => c.method === "POST" && re.test(c.url));
const visibleText = (h) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
// A server word (snake_case code) or a raw GPEXE id must never reach the coach's or the club admin's screen.
const CODE = /\b[a-z]+_[a-z_]+\b/;

async function open(w) {
  installFetchMock(w.server);
  await act("training-load-section", { section: "imports" });
}
async function fixFirst(group = "unlinked") {
  const btn = html().match(new RegExp(`data-action="training-load-gpexe-fix" data-candidate-id="([^"]+)" data-group="${group}"`));
  assert.ok(btn, `a Fix opening for ${group}`);
  await act("training-load-gpexe-fix", { candidateId: btn[1], group });
}
async function linkTo(gpexeAthleteId, athleteId) {
  selectValues[gpexeAthleteId] = athleteId;
  await act("training-load-gpexe-link", { gpexeAthleteId });
  await act("training-load-gpexe-link-confirm");
}

test("Fix 1: a coach's group button opens the sheet - Step 1 of 2, one sentence, the chooser with nothing preselected, Skip for now and ×; never an id or a code", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101", "102"] } });
  await open(w);
  const group = html().match(/data-attention-group="unlinked"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(group, /data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="unlinked">Link athletes</, "the group's own button, opening Fix");
  assert.ok(!/>Fix</.test(group), "no second Fix button for a coach");
  await fixFirst();
  const s = sheet();
  assert.match(s, /role="dialog" aria-modal="true" aria-labelledby="imports-fix-title"/);
  assert.match(s, /<p class="imports-fix-count">Step 1 of 2<\/p>/);
  assert.match(s, /<option value="" selected>Choose an athlete of the team<\/option>/);
  assert.equal((s.match(/ selected/g) || []).length, 1, "nothing else is preselected");
  assert.match(s, /data-action="training-load-gpexe-fix-skip" data-gpexe-athlete-id="101"[^>]*>Skip for now</);
  assert.match(s, /class="plain-button imports-fix-close gpexe-button" data-action="training-load-gpexe-fix-close" aria-label="Close"/);
  assert.match(html(), /<div class="imports-fix-backdrop" data-action="training-load-gpexe-fix-close" aria-hidden="true"><\/div>/, "a real backdrop");
  assert.ok(!/gpexe-detail-overlay/.test(html()), "the full review is not under it");
  const text = visibleText(s);
  assert.ok(!/\b10[12]\b/.test(text), "no GPEXE id in what the coach reads");
  assert.ok(!CODE.test(text), `no server code: ${text.match(CODE)}`);
  assert.ok(!/Technical details/.test(s));
});

test("Fix 2: Link -> Confirm link sends one link and ONE recompute; step c is skipped silently; the next athlete is Step 2 of 2", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101", "102"] } });
  await open(w);
  await fixFirst();
  selectValues["101"] = "ath-1";
  await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
  assert.match(sheet(), /Confirm link/, "Link... only asks");
  assert.equal(posts(/athlete-links$/).length, 0, "nothing sent before Confirm link");
  await act("training-load-gpexe-link-confirm");
  assert.equal(posts(/athlete-links$/).length, 1);
  assert.deepEqual(posts(/athlete-links$/)[0].body, { gpexeAthleteId: "101", athleteId: "ath-1" });
  assert.equal(posts(/\/preview$/).length, 1, "one recompute");
  const s = sheet();
  assert.match(s, /Step 2 of 2/);
  assert.match(s, /data-gpexe-athlete-id="102"/);
  assert.ok(!/Update the review/.test(s), "(c) is never a step after the recompute ran");
});

test("Fix 3: a name two team athletes share can't be confirmed; Skip for now skips that athlete, not the session, and the end names it", async () => {
  resetState();
  const names = { ...NAMES };
  NAMES["ath-3"] = { name: "Alex Example" };
  try {
    const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
    await open(w);
    await fixFirst();
    selectValues["101"] = "ath-1";
    await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
    assert.ok(!/Confirm link/.test(sheet()), "no confirmation for a shared name");
    assert.match(sheet(), /More than one athlete of the team is called Alex Example/);
    await act("training-load-gpexe-fix-skip", { gpexeAthleteId: "101" });
    const s = sheet();
    assert.equal(gx().detail.id, "cand-5", "the same session");
    assert.match(s, /This session can be imported without the athlete you skipped; their results are not imported until linked\./);
    assert.ok(!/This session is ready/.test(s), "never \"ready\" as if nothing was left");
    assert.match(s, /data-action="training-load-gpexe-approve"[^>]*>Import 1 athlete</);
    assert.equal(posts(/athlete-links$/).length, 0);
  } finally {
    Object.assign(NAMES, names);
  }
});

test("Fix 4: the end per viewer - an approver imports here; a coach without the right is told who imports; a club admin too; with importing off it says so - never an Import button that will be refused", async () => {
  // Approver: Import, through the review's own approval (one question, one request).
  resetState();
  let w = world({ sessions: [row(5), row(6)], unlinkedBy: { "cand-5": ["101"], "cand-6": ["103"] } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  assert.match(sheet(), /This session is ready\./);
  await act("training-load-gpexe-approve");
  assert.equal(posts(/\/approve$/).length, 1);
  assert.match(sheet(), /This session is imported\./);
  assert.match(sheet(), /data-action="training-load-gpexe-fix-next"[^>]*>Next session in the group</);
  await act("training-load-gpexe-fix-next");
  assert.equal(gx().detail.id, "cand-6", "the next session of the group, in the sheet");
  assert.ok(gx().detail.fix);

  // A coach who may not import.
  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: false };
  w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  let s = sheet();
  assert.match(s, /This session is ready\. Ask your club administrator to import it\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
  assert.ok(!CODE.test(visibleText(s)));

  // A club admin who may not import (identityAdmin: who to ask is OptiMove support).
  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: false, identityAdmin: true };
  w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  s = sheet();
  assert.match(s, /This session is ready\. Contact OptiMove support to import it\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
  assert.ok(!CODE.test(visibleText(s)) && !/Technical details/.test(s), "no code for the club admin");

  // The team's switch is off.
  resetState();
  w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, switchOn: false });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  s = sheet();
  assert.match(s, /This session is ready\. Importing is switched off for this team; ask your club administrator to turn it on\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
});

test("Fix 5: a recompute that fails leaves step c, Update the review; it sends the review's own recompute", async () => {
  resetState();
  let fail = true;
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, onPreview: () => (fail ? { status: 503, body: { error: "try_again" } } : null) });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  let s = sheet();
  assert.match(s, /Step 2 of 2/, "the step count only grows");
  assert.match(s, /The review could not be updated this time\. Update it again before importing\./);
  assert.ok(!CODE.test(visibleText(s)), "no code for the coach");
  fail = false;
  await act("training-load-gpexe-review-update");
  assert.equal(posts(/\/preview$/).length, 2);
  s = sheet();
  assert.match(s, /This session is ready\./);
});

test("Fix 6: a result not confirmed is step 1 and nothing else is offered; Check the result reads, never sends an approval", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  gx().uncertain["cand-5"] = { kind: "unknown", error: { status: 0 }, checks: 0 };
  await act("training-load-gpexe-tab", { importTab: "attention" });
  await fixFirst("unknown");
  let s = sheet();
  assert.match(s, /Step 1 of 1/);
  assert.match(s, /Check the result before doing anything else\./);
  assert.match(s, /data-action="training-load-gpexe-verify"[^>]*>Check the result</);
  assert.ok(!/gpexe-link-select/.test(s), "no link step while a result is not confirmed");
  w.sessions[0].status = "imported";
  await act("training-load-gpexe-verify");
  assert.equal(posts(/\/approve$/).length, 0, "never resent by itself");
  s = sheet();
  assert.match(s, /This session is imported\./);
  assert.match(s, /data-action="training-load-gpexe-fix-close"[^>]*>Back to Imports</);
});

test("Fix 7: Needs a new search searches the session's own day; the sheet goes on with what the search found", async () => {
  resetState();
  const w = world({ sessions: [row(5, { snapshot: { available: false } })] });
  await open(w);
  // The fresh group's own button searches all the dates it names; a coach opens Fix from the session's row.
  assert.match(html(), /class="gpexe-candidate" data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="fresh"/);
  await act("training-load-gpexe-fix", { candidateId: "cand-5", group: "fresh" });
  let s = sheet();
  assert.match(s, /Search GPEXE again for 05\.09\.2026 to read this session before importing\./);
  assert.match(s, /data-action="training-load-gpexe-fix-search"[^>]*>Search 05\.09\.2026</);
  w.sessions[0].snapshot = { available: true, expiresAt: "2099-01-01T00:00:00Z" };
  await act("training-load-gpexe-fix-search");
  assert.deepEqual(posts(/\/checks$/).map((c) => c.body), [{ from: "2026-09-05", to: "2026-09-05" }]);
  s = sheet();
  assert.match(s, /This session is ready\./);
});

test("Fix 8: the platform admin keeps the review and gets Fix beside it; rows open the review", async () => {
  resetState();
  viewer = { canApprove: true, approvalBasis: "platform_admin", isPlatformAdmin: true };
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  const group = html().match(/data-attention-group="unlinked"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(group, /data-action="training-load-gpexe-open" data-candidate-id="cand-5" data-group="unlinked">Link athletes<\/button><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="unlinked">Fix</);
  assert.match(html(), /class="gpexe-candidate" data-action="training-load-gpexe-open" data-candidate-id="cand-5"/);
});

test("Fix 9: leaving with a link on its way asks first; while an import is running the sheet does not close (×, Escape)", async () => {
  resetState();
  let release;
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, onLink: () => new Promise((r) => { release = r; }).then(() => null) });
  await open(w);
  await fixFirst();
  selectValues["101"] = "ath-1";
  await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
  const sent = act("training-load-gpexe-link-confirm");
  await Promise.resolve();
  confirmAnswer = false;
  await act("training-load-gpexe-fix-close");
  assert.equal(confirmQuestions.length, 1);
  assert.match(confirmQuestions[0], /A change is still on its way\. Close anyway\?/);
  assert.ok(gx().detail?.fix, "declined: still open");
  release();
  await sent;
  // An import in flight: × is disabled and Escape keeps it.
  gx().detail.approving = true;
  assert.match(sheet(), /data-action="training-load-gpexe-fix-close" aria-label="Close" disabled/);
  assert.equal(closeFixFromKey(render), true, "Escape is handled");
  assert.ok(gx().detail?.fix, "and the sheet stays");
  gx().detail.approving = false;
  confirmAnswer = true;
  assert.equal(closeFixFromKey(render), true);
  assert.equal(gx().detail, null, "closed");
});

test("Fix 10: a lost link answer keeps the existing pattern - the review is treated as made with the old links, nothing is resent", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, onLink: () => "lost" });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  assert.equal(posts(/athlete-links$/).length, 1, "sent once, never again by itself");
  const s = sheet();
  assert.match(s, /We can(?:'|&#039;)t tell whether the link was made\./);
  assert.ok(!CODE.test(visibleText(s)));
});

test("Fix 11: a kind outside slice 1 has no Fix; a session that ends outside it says See why and opens the full review", async () => {
  resetState();
  const w = world({ sessions: [row(5, { reasons: [{ code: "athletes_need_manual_review", count: 1 }], counts: { created: 2, athletesNotImported: 1 } }), row(6, { changesToImported: 2 })], unlinkedBy: { "cand-6": ["101"] } });
  await open(w);
  const review = html().match(/data-attention-group="review"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.ok(!/training-load-gpexe-fix/.test(review), "Needs a look keeps the review");
  await fixFirst();
  await linkTo("101", "ath-1");
  assert.match(sheet(), /This session needs a look in its full review\./);
  await act("training-load-gpexe-fix-full");
  assert.equal(gx().detail.fix, null);
  assert.match(html(), /gpexe-detail-overlay/, "the full review");
});

test("Fix 12: a session that needs a search AND has an unlinked athlete: after the link (its recompute is refused) the next step is the search, never Update the review", async () => {
  resetState();
  const w = world({ sessions: [row(5, { snapshot: { available: false } })], unlinkedBy: { "cand-5": ["101"] }, onPreview: (call, wd) => (wd.sessions[0].snapshot.available ? null : { status: 409, body: { error: "snapshot_expired_check_again" } }) });
  await open(w);
  await act("training-load-gpexe-fix", { candidateId: "cand-5", group: "fresh" });
  await linkTo("101", "ath-1");
  let s = sheet();
  assert.match(s, /data-action="training-load-gpexe-fix-search"/);
  assert.ok(!/Update the review/.test(s));
  assert.match(s, /Step 2 of 2/);
  w.sessions[0].snapshot = { available: true, expiresAt: "2099-01-01T00:00:00Z" };
  await act("training-load-gpexe-fix-search");
  s = sheet();
  assert.match(s, /This session is ready\./);
});

test("Fix 13: an athlete left out for another reason than a link: the sheet never says ready - See why opens the full review", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, extraAthletes: { "cand-5": [{ gpexeAthleteId: "104", athleteId: "ath-2", notImported: { code: "athlete_needs_manual_review" }, results: [] }] } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  const s = sheet();
  assert.match(s, /This session needs a look in its full review\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
});

test("Fix 14: a refused import says nothing was imported before See why; the global switch off is not called the team's", async () => {
  resetState();
  let w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, onApprove: () => ({ status: 409, body: { error: "candidate_not_actionable" } }) });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  await act("training-load-gpexe-approve");
  let s = sheet();
  assert.match(s, /class="gpexe-refused" role="alert">Not imported/);
  assert.match(s, /data-action="training-load-gpexe-fix-full"[^>]*>See why</);
  assert.ok(!CODE.test(visibleText(s)), "no code for the coach");

  resetState();
  w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, globalOn: false });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  s = sheet();
  assert.match(s, /This session is ready\. Importing is switched off; ask your club administrator to turn it on\./);
  assert.ok(!/for this team/.test(s) && !/training-load-gpexe-approve/.test(s));
});

test("Fix 15: a lost link answer for one athlete is not shown on the next athlete's step", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101", "102"] }, onLink: (call, wd) => { wd.links.push({ id: "link-x", gpexeAthleteId: call.body.gpexeAthleteId, athleteId: call.body.athleteId }); return "lost"; } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  const s = sheet();
  assert.match(s, /data-gpexe-athlete-id="102"/, "the link was made: the next athlete");
  assert.ok(!/We can(?:'|&#039;)t tell/.test(s), "the uncertainty about 101 is not shown on 102");
});

test("Fix 13b: a session reason other than a missing link (the preview clean) also ends on See why, never ready", async () => {
  resetState();
  const w = world({ sessions: [row(5, { reasons: [{ code: "athletes_not_in_team", count: 1 }] })], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-1");
  const s = sheet();
  assert.match(s, /This session needs a look in its full review\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
});
