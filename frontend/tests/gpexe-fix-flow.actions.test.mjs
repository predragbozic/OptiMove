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
function world({ sessions, unlinkedBy = {}, extraAthletes = {}, multiTrack = {}, changes = {}, links = [], switchOn = true, globalOn = true, onTracks, onTrackPut, onLink, onPreview, onApprove, onCheck, onCandidate } = {}) {
  const w = { sessions: sessions.map((s) => ({ ...s })), links: [...links], unlinkedBy, choices: {}, puts: [] };
  // Slice 2: an athlete GPEXE recorded on more than one track, until a choice is made (track: imported; none: left out by choice).
  // An athlete may appear on more than one track only once another athlete is linked (a recompute brings it: m.afterLinkOf).
  const trackAthletes = (s) => Object.entries(multiTrack[s.id] || {}).filter(([, m]) => !m.afterLinkOf || w.links.some((l) => l.gpexeAthleteId === m.afterLinkOf)).map(([g, m]) => {
    const ch = w.choices[`${s.id}:${g}`];
    // MT-B's trackChoice, as the coach's audience sends it (no choiceId).
    const tc = (kind, trackId, stale = false) => ({ kind, trackId, trackCount: m.tracks.length, stale });
    if (ch?.choice === "track") return { gpexeAthleteId: g, athleteId: m.athleteId, results: [], trackChoice: tc("track", ch.trackId) };
    if (ch?.choice === "none") return { gpexeAthleteId: g, athleteId: m.athleteId, gps: { status: "not_used_by_choice" }, notImported: { code: "no_track_by_choice" }, results: [], trackChoice: tc("none", null) };
    return { gpexeAthleteId: g, athleteId: m.athleteId, gps: { status: "needs_manual_review" }, notImported: { code: "multiple_tracks" }, results: [], ...(m.staleChoice ? { trackChoice: tc(m.staleChoice, m.staleChoice === "track" ? m.tracks[0].trackId : null, true) } : {}) };
  });
  const openTracks = (s) => trackAthletes(s).filter((a) => a.notImported?.code === "multiple_tracks").length;
  const preview = (s) => {
    const ids = (w.unlinkedBy[s.id] || []).filter((g) => !w.links.some((l) => l.gpexeAthleteId === g));
    const linkedHere = (w.unlinkedBy[s.id] || []).filter((g) => w.links.some((l) => l.gpexeAthleteId === g));
    return {
      version: 3, status: "ready", blocked: null, counts: s.counts, changesToImported: changes[s.id] || [], anomalies: [], unactivatedSourceMetricCount: 0,
      athletes: [
        { gpexeAthleteId: "900", athleteId: "ath-9", results: [] },
        ...linkedHere.map((g) => ({ gpexeAthleteId: g, athleteId: w.links.find((l) => l.gpexeAthleteId === g).athleteId, results: [] })),
        ...ids.map((g) => ({ gpexeAthleteId: g, athleteId: null, notImported: { code: "athlete_not_linked" }, results: [] })),
        ...(extraAthletes[s.id] || []),
        ...trackAthletes(s),
      ],
      teamAthletesWithoutGpexeRecord: ["ath-1", "ath-2", "ath-3"].filter((a) => !w.links.some((l) => l.athleteId === a)).map((athleteId) => ({ athleteId })),
    };
  };
  const summary = (s) => {
    const ids = (w.unlinkedBy[s.id] || []).filter((g) => !w.links.some((l) => l.gpexeAthleteId === g));
    const reasons = [...(ids.length ? [{ code: "athletes_not_linked", count: ids.length }] : s.reasons), ...(openTracks(s) ? [{ code: "athletes_need_manual_review", count: openTracks(s) }] : [])];
    return { ...s, reasons, counts: { ...s.counts, athletesNotImported: ids.length }, approvalBlockers: switchOn ? s.approvalBlockers : [...s.approvalBlockers, "team_import_switch_off"] };
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
    const tc = rest.match(/^\/candidates\/([^/?]+)\/track-choices(?:\/([^/?]+))?$/);
    if (tc && call.method === "GET") {
      if (onTracks) { const r = await onTracks(call, w); if (r) return r; }
      if (viewer.canApprove !== true) return { status: 404, body: { error: "notFound" } };
      return { status: 200, body: { candidateId: tc[1], athletes: Object.entries(multiTrack[tc[1]] || {}).map(([g, m]) => ({ gpexeAthleteId: g, tracks: m.tracks, choosable: m.choosable !== false, sumOffered: false, currentChoice: w.choices[`${tc[1]}:${g}`] ? { id: "choice-1", choice: w.choices[`${tc[1]}:${g}`].choice, stale: false } : null })) } };
    }
    if (tc && call.method === "PUT") {
      w.puts.push(call.body);
      if (onTrackPut) { const r = await onTrackPut(call, w); if (r) return r; }
      w.choices[`${tc[1]}:${tc[2]}`] = { choice: call.body.choice, trackId: call.body.trackId };
      return { status: 201, body: { choice: { id: "choice-1", choice: call.body.choice } } };
    }
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
  assert.match(group, /data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="unlinked">Fix this session</, "the group's own button, opening Fix");
  assert.ok(!/>Fix</.test(group), "no second Fix button for a coach");
  await fixFirst();
  const s = sheet();
  assert.match(s, /role="dialog" aria-modal="true" aria-labelledby="imports-fix-title"/);
  assert.match(s, /<p class="imports-fix-count">Step 1 of 2<\/p>\s*<\/div>/, "the step count is in the sticky head");
  assert.match(s, /<label><span>Team athlete<\/span>/, "the chooser's label does not repeat the sentence");
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
    assert.match(sheet(), /<option value="ath-1" disabled>Alex Example \(same name as another athlete\)<\/option>/, "the option says so before it is pressed");
    selectValues["101"] = "ath-1";
    await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
    assert.ok(!/Confirm link/.test(sheet()), "and the confirmation still refuses it");
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
  assert.match(s, /Find new sessions for 05\.09\.2026 to read this session again before importing\./);
  assert.match(s, /data-action="training-load-gpexe-fix-search"[^>]*>Find new sessions for 05\.09\.2026</);
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
  assert.match(group, /data-action="training-load-gpexe-open" data-candidate-id="cand-5" data-group="unlinked">Open the session<\/button><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="unlinked">Fix</);
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

test("Fix 11: Needs a look opens Fix for a coach; an athlete under another kind of review ends on See why and opens the full review", async () => {
  resetState();
  const w = world({ sessions: [row(5, { reasons: [{ code: "athletes_need_manual_review", count: 1 }], counts: { created: 2, athletesNotImported: 1 } })], extraAthletes: { "cand-5": [{ gpexeAthleteId: "104", athleteId: "ath-2", gps: { status: "needs_manual_review" }, notImported: { code: "whole_session_row_count" }, results: [] }] } });
  await open(w);
  const review = html().match(/data-attention-group="review"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.match(review, /data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="review">Open the session</, "slice 2: Needs a look opens Fix");
  await fixFirst("review");
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

test("Fix 16: the full review is one quiet link away on every step and end (never a main button); not on the See why screen", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  await fixFirst();
  let s = sheet();
  assert.match(s, /<p class="imports-fix-full"><button type="button" class="plain-button imports-fix-full-link gpexe-button" data-action="training-load-gpexe-fix-full"[^>]*>Open the full review</);
  assert.ok(!/primary-button imports-fix-full-link/.test(s));
  await linkTo("101", "ath-1");
  assert.match(sheet(), /Open the full review/, "on the end too");
  await act("training-load-gpexe-fix-full");
  assert.equal(gx().detail.fix, null);
  assert.match(html(), /gpexe-detail-overlay/);
});

// Slice 2: more than one track, and changes to imported results.
const TRACKS = [
  { trackId: "555001", startedAt: "2026-09-05T07:00:00Z", timezone: "Europe/Belgrade", wholeSessionSeconds: 2400, wholeSessionDistance: 3000, drillIndexes: [0] },
  { trackId: "555002", startedAt: "2026-09-05T07:45:00Z", timezone: "Europe/Belgrade", wholeSessionSeconds: 600, wholeSessionDistance: 800, drillIndexes: [] },
];
const multiWorld = (over = {}) => world({ sessions: [row(5, { reasons: [{ code: "athletes_need_manual_review", count: 1 }] })], multiTrack: { "cand-5": { "131": { athleteId: "ath-2", tracks: TRACKS } } }, ...over });
const trackPuts = () => fetchCalls.filter((c) => c.method === "PUT" && /track-choices\/131$/.test(c.url));
const trackGets = () => fetchCalls.filter((c) => c.method === "GET" && /track-choices$/.test(c.url));

test("Fix 17: an approver chooses the recording of an athlete GPEXE recorded on more than one track - one PUT, one recompute, then ready", async () => {
  resetState();
  const w = multiWorld();
  await open(w);
  await fixFirst("review");
  let s = sheet();
  assert.match(s, /GPEXE has 2 recordings of Blake Sample in this session\. Which one should be imported\?/);
  assert.match(s, /<span>Recording 1 · started \d{2}:\d{2} · 40 min · 3,000 m · 1 drill<\/span>/);
  assert.match(s, /<span>Recording 2 · started \d{2}:\d{2} · 10 min · 800 m · no drills<\/span>/);
  assert.match(s, /None of them: leave Blake Sample out of this import/);
  assert.ok(!/55500[12]</.test(s) && !/>[^<]*55500[12]/.test(visibleText(s)), "never a track id in what is read");
  assert.match(s, /data-action="training-load-gpexe-fix-track-save"[^>]*disabled[^>]*>Save the choice</, "nothing to save before a choice");
  assert.equal(trackGets().length, 1);
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  assert.equal(trackPuts().length, 0, "choosing sends nothing");
  await act("training-load-gpexe-fix-track-save");
  assert.equal(trackPuts().length, 1);
  const body = trackPuts()[0].body;
  assert.match(body.requestKey, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...body, requestKey: "k" }, { requestKey: "k", choice: "track", trackId: "555001", expectedChoiceId: null });
  assert.equal(posts(/\/preview$/).length, 1, "one recompute");
  s = sheet();
  assert.match(s, /This session is ready\./);
  assert.match(s, /data-action="training-load-gpexe-approve"[^>]*>Import 2 athletes</);
});

test("Fix 18: None of them leaves the athlete out by choice; the rest imports", async () => {
  resetState();
  const w = multiWorld();
  await open(w);
  await fixFirst("review");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "none" }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-track-save");
  assert.deepEqual({ ...trackPuts()[0].body, requestKey: "k" }, { requestKey: "k", choice: "none", expectedChoiceId: null });
  assert.match(sheet(), /This session is ready\./);
  assert.match(sheet(), /Import 1 athlete</);
});

test("Fix 19: a lost answer to the choice is Check the result with the same key and body - never sent again by itself; leaving asks", async () => {
  resetState();
  let lose = true;
  const w = multiWorld({ onTrackPut: () => (lose ? "lost" : null) });
  await open(w);
  await fixFirst("review");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555002" }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-track-save");
  let s = sheet();
  assert.match(s, /We can(?:'|&#039;)t tell whether the choice was saved\./);
  assert.match(s, /data-action="training-load-gpexe-fix-track-check"[^>]*>Check the result</);
  assert.ok(!/training-load-gpexe-fix-track-save/.test(s), "no second Save");
  assert.ok(/name="fix-track-131"[^>]*disabled/.test(s), "the choice is locked");
  assert.equal(trackPuts().length, 1);
  confirmAnswer = false;
  await act("training-load-gpexe-fix-close");
  assert.match(confirmQuestions.at(-1), /A change is still on its way/);
  assert.ok(gx().detail?.fix);
  lose = false;
  await act("training-load-gpexe-fix-track-check");
  assert.equal(trackPuts().length, 2);
  assert.deepEqual(trackPuts()[1].body, trackPuts()[0].body, "the same request key and body");
  assert.match(sheet(), /This session is ready\./);
});

test("Fix 20: someone who may not import reads no recordings; the end says whoever imports chooses - no Import, no code", async () => {
  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: false };
  const w = multiWorld();
  await open(w);
  await fixFirst("review");
  assert.equal(trackGets().length, 0, "the approver-only read is not asked");
  const s = sheet();
  assert.match(s, /This session is ready except for one athlete with more than one GPEXE recording: whoever imports chooses which one to use\. Ask your club administrator to import it\./);
  assert.ok(!/training-load-gpexe-approve/.test(s));
  assert.ok(!CODE.test(visibleText(s)));
});

test("Fix 21: Skip for now skips that athlete's recording; the end says the session imports without them", async () => {
  resetState();
  const w = multiWorld();
  await open(w);
  await fixFirst("review");
  await act("training-load-gpexe-fix-skip", { gpexeAthleteId: "131" });
  const s = sheet();
  assert.match(s, /This session can be imported without the athlete you skipped; their results are not imported\./);
  assert.ok(!/until linked/.test(s));
  assert.equal(trackPuts().length, 0);
});

test("Fix 22: changes to imported results are accepted in a step of their own by whoever imports, then sent with the import", async () => {
  resetState();
  const changes = { "cand-5": [{ athleteId: "ath-1", kind: "corrected" }, { athleteId: "ath-1", kind: "corrected" }] };
  let w = world({ sessions: [row(5, { changesToImported: 2 })], unlinkedBy: { "cand-5": ["101"] }, changes });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-3");
  let s = sheet();
  assert.match(s, /Step 2 of 2/);
  assert.match(s, /Importing this session affects 2 results that are already in OptiMove\./);
  assert.match(s, /<li>Alex Example: 2 results are replaced with newer GPEXE values<\/li>/);
  assert.match(s, /Open the full review below to see each value before you accept\. Nothing changes until you import\./);
  assert.match(s, /data-action="training-load-gpexe-fix-accept"[^>]*>Accept and continue</);
  await act("training-load-gpexe-fix-accept");
  s = sheet();
  assert.match(s, /This session is ready\. Importing also affects 2 results already in OptiMove\./, "said again beside Import");
  await act("training-load-gpexe-approve");
  assert.equal(posts(/\/approve$/).at(-1).body.acceptChanges, true, "the import carries the acceptance");

  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: false };
  w = world({ sessions: [row(5, { changesToImported: 2 })], unlinkedBy: { "cand-5": ["101"] }, changes });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-3");
  s = sheet();
  assert.ok(!/Accept the changes/.test(s), "only whoever imports accepts");
  assert.match(s, /This session is ready\. Ask your club administrator to import it\./);
});

test("Fix 23: a recordings read that fails is a step of its own; Try again reads once more", async () => {
  resetState();
  let fail = true;
  const w = multiWorld({ onTracks: () => (fail ? { status: 503, body: { error: "try_again" } } : null) });
  await open(w);
  await fixFirst("review");
  assert.match(sheet(), /The recordings of this session could not be read\. Try again\./);
  assert.ok(!CODE.test(visibleText(sheet())));
  fail = false;
  await act("training-load-gpexe-fix-tracks-reload");
  assert.equal(trackGets().length, 2);
  assert.match(sheet(), /GPEXE has 2 recordings of Blake Sample/);
});

test("Fix 24: a refused choice (409) says nothing was saved and reads the recordings again; a new choice gets a new key", async () => {
  resetState();
  let refuse = true;
  const w = multiWorld({ onTrackPut: () => (refuse ? { status: 409, body: { error: "choice_changed" } } : null) });
  await open(w);
  await fixFirst("review");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-track-save");
  assert.match(sheet(), /The recordings or the choice changed meanwhile\. Nothing was saved; choose again\./);
  assert.equal(trackGets().length, 2, "read again");
  refuse = false;
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-track-save");
  assert.notEqual(trackPuts()[1].body.requestKey, trackPuts()[0].body.requestKey);
  assert.match(sheet(), /This session is ready\./);
});

test("Fix 25: a recompute after a link brings an athlete on more than one track - the recordings are read and asked, never 'ready'", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, multiTrack: { "cand-5": { "131": { athleteId: "ath-2", tracks: TRACKS, afterLinkOf: "101" } } } });
  await open(w);
  await fixFirst();
  assert.equal(trackGets().length, 0, "no athlete on more than one track yet: nothing to read");
  await linkTo("101", "ath-3");
  assert.equal(trackGets().length, 1, "read after the recompute brought one");
  const s = sheet();
  assert.match(s, /GPEXE has 2 recordings of Blake Sample in this session/);
  assert.ok(!/This session is ready/.test(s));
});

test("Fix 26: an athlete on more than one track that the read says can't be chosen is never 'ready' for an approver: See why", async () => {
  resetState();
  const w = world({ sessions: [row(5, { reasons: [{ code: "athletes_need_manual_review", count: 1 }] })], multiTrack: { "cand-5": { "131": { athleteId: "ath-2", tracks: TRACKS, choosable: false } } } });
  await open(w);
  await fixFirst("review");
  const s = sheet();
  assert.ok(!/This session is ready/.test(s) && !/training-load-gpexe-approve/.test(s));
  assert.match(s, /This session needs a look in its full review\./);
});

test("Fix 27: a saved choice the review does not show yet (its recompute failed) is Update the review - never 'ready'", async () => {
  resetState();
  let fail = false;
  const w = multiWorld({ onPreview: () => (fail ? { status: 503, body: { error: "try_again" } } : null) });
  await open(w);
  await fixFirst("review");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  fail = true;
  // The choice is saved, but the recompute after it fails: the stored review still shows the athlete on two tracks.
  await act("training-load-gpexe-fix-track-save");
  let s = sheet();
  assert.ok(!/This session is ready/.test(s));
  assert.match(s, /The review could not be updated this time\. Update it again before importing\./);
  assert.match(s, /data-action="training-load-gpexe-review-update"/);
  fail = false;
  await act("training-load-gpexe-review-update");
  assert.match(sheet(), /This session is ready\./);
});

test("Fix 28: an expired snapshot: the recordings are not read (the server would refuse); the search is the step", async () => {
  resetState();
  const w = multiWorld({ sessions: [row(5, { snapshot: { available: false }, reasons: [{ code: "athletes_need_manual_review", count: 1 }] })] });
  await open(w);
  await act("training-load-gpexe-fix", { candidateId: "cand-5", group: "fresh" });
  assert.equal(trackGets().length, 0);
  const s = sheet();
  assert.match(s, /data-action="training-load-gpexe-fix-search"/);
  assert.ok(!/training-load-gpexe-fix-tracks-reload/.test(s));
});

test("Fix 29: a coach who skipped a link reads it, and also that whoever imports chooses a recording", async () => {
  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: false };
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] }, multiTrack: { "cand-5": { "131": { athleteId: "ath-2", tracks: TRACKS } } } });
  await open(w);
  await fixFirst();
  await act("training-load-gpexe-fix-skip", { gpexeAthleteId: "101" });
  const s = sheet();
  assert.match(s, /This session can be imported without the athlete you skipped; their results are not imported until linked\. One athlete has more than one GPEXE recording: whoever imports chooses which one to use\. Ask your club administrator to import it\./);
});

test("Fix 30: choosing a recording keeps the focus on that radio (the repaint replaces it)", async () => {
  resetState();
  const w = multiWorld();
  await open(w);
  await fixFirst("review");
  const focused = [];
  const prev = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => ({ focus: () => focused.push(id) });
  try {
    await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555002" }, { renderTrainingLoad: render });
  } finally {
    globalThis.document.getElementById = prev;
  }
  assert.deepEqual(focused, ["fix-track-131-555002"]);
});

test("Fix 31: the kinds of change say what happens - an older or different GPEXE version leaves the result as it is", async () => {
  resetState();
  const changes = { "cand-5": [{ athleteId: "ath-1", kind: "stale_resend_ignored" }, { athleteId: "ath-1", kind: "needs_review" }, { athleteId: "ath-1", kind: "supplemented" }] };
  const w = world({ sessions: [row(5, { changesToImported: 3 })], unlinkedBy: { "cand-5": ["101"] }, changes });
  await open(w);
  await fixFirst();
  await linkTo("101", "ath-3");
  const s = sheet();
  assert.match(s, /<li>Alex Example: 1 result stays as it is; GPEXE(?:'|&#039;)s values are saved aside<\/li>/);
  assert.ok(!/older values/.test(s), "a manual correction is flagged this way too: GPEXE's version is not called older");
  assert.match(s, /<li>Alex Example: 1 result stays as it is; GPEXE(?:'|&#039;)s different values are saved for review<\/li>/);
  assert.match(s, /<li>Alex Example: 1 result gets more values from GPEXE<\/li>/);
  assert.ok(!/kept as they are|marked for review|changes 3/.test(s));
});

test("Fix 32: after Update the review, a choice cleared elsewhere is read again and asked - not the same step again", async () => {
  resetState();
  let fail = false;
  const w = multiWorld({ onPreview: () => (fail ? { status: 503, body: { error: "try_again" } } : null) });
  await open(w);
  await fixFirst("review");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  fail = true;
  await act("training-load-gpexe-fix-track-save");
  assert.match(sheet(), /Update it again before importing/);
  // Another admin clears the choice: the review (recomputed) still shows two recordings, and the read has no choice.
  delete w.choices["cand-5:131"];
  fail = false;
  const reads = trackGets().length;
  await act("training-load-gpexe-review-update");
  assert.equal(trackGets().length, reads + 1, "read again after the update");
  assert.match(sheet(), /GPEXE has 2 recordings of Blake Sample/);
});

// MT-C: the full review row says, read-only, what the recording choice did; the platform admin's choice opens the Fix sheet.
const reviewRow = (name) => (html().match(new RegExp(`<tr class="gpexe-review-row is-(?!no_record)[^"]*" role="row">\\s*<th scope="row" data-label="Athlete" role="rowheader">${name}</th>[\\s\\S]*?</tr>`)) || [""])[0];

test("MT-C 1: after a choice the review row says which kind - one of N recordings used, or left out by choice - and never a track id", async () => {
  for (const [choice, label, note] of [["track", "One of 2 recordings used", null], ["none", "Left out by choice", /none of the recordings is used, as chosen/]]) {
    resetState();
    const w = multiWorld();
    w.choices["cand-5:131"] = { choice, trackId: choice === "track" ? "555002" : null };
    await open(w);
    await act("training-load-gpexe-open", { candidateId: "cand-5" });
    const row = reviewRow("Blake Sample");
    assert.match(row, new RegExp(`<span class="gpexe-badge is-track-choice">${label}</span>`), choice);
    if (note) assert.match(row, note);
    assert.ok(!/55500[12]/.test(visibleText(row)), "no track id");
    assert.doesNotMatch(row, /gpexe-choose-recording/, "a coach chooses in Fix, not here");
  }
});

test("MT-C 2: a choice that no longer applies is named as out of date; an athlete without a choice has no label", async () => {
  resetState();
  await open(world({ sessions: [row(5, { reasons: [{ code: "athletes_need_manual_review", count: 1 }] })], multiTrack: { "cand-5": { "131": { athleteId: "ath-2", tracks: TRACKS, staleChoice: "track" } } } }));
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  assert.match(reviewRow("Blake Sample"), /<span class="gpexe-badge is-track-choice">Recording choice out of date<\/span>/);
  assert.match(reviewRow("Blake Sample"), /GPEXE(?:'|&#039;)s recordings of this athlete changed after the choice was made, so it no longer applies\./);
  resetState();
  await open(multiWorld());
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  assert.doesNotMatch(reviewRow("Blake Sample"), /is-track-choice/);
});

test("MT-C 3: the platform admin's 'Choose a recording' opens the same Fix sheet (one chooser) - only on a row that still needs a choice, only while it can be imported", async () => {
  resetState();
  viewer = { canApprove: true, approvalBasis: "platform_admin", isPlatformAdmin: true };
  const w = multiWorld();
  await open(w);
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  assert.match(reviewRow("Blake Sample"), /<button type="button" class="plain-button gpexe-button gpexe-choose-recording" data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="">Choose a recording<\/button>/);
  assert.equal((html().match(/gpexe-choose-recording/g) || []).length, 1, "one button, on that row only");
  await act("training-load-gpexe-fix", { candidateId: "cand-5" });
  assert.match(sheet(), /GPEXE has 2 recordings of Blake Sample in this session\. Which one should be imported\?/);
  assert.equal(trackGets().length, 1, "the Fix module reads the recordings");
  // After the choice, the row names it and the button is gone.
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-fix-track-pick", gpexeAthleteId: "131" }, value: "555001" }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-track-save");
  await act("training-load-gpexe-fix-full");
  assert.match(reviewRow("Blake Sample"), /One of 2 recordings used/);
  assert.doesNotMatch(html(), /gpexe-choose-recording/);
  // A viewer who may not import never gets the button.
  resetState();
  viewer = { canApprove: false, approvalBasis: null, isPlatformAdmin: true };
  await open(multiWorld());
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  assert.doesNotMatch(html(), /gpexe-choose-recording/);
});

test("MT-C 4 (code review): while the review's answer is on its way the button waits; it keeps the review's group", async () => {
  resetState();
  viewer = { canApprove: true, approvalBasis: "platform_admin", isPlatformAdmin: true };
  await open(multiWorld());
  await act("training-load-gpexe-open", { candidateId: "cand-5", group: "review" });
  assert.match(reviewRow("Blake Sample"), /gpexe-choose-recording" data-action="training-load-gpexe-fix" data-candidate-id="cand-5" data-group="review">/, "the group goes with it");
  for (const set of [(d) => { d.approving = true; }, (d) => { d.updating = true; }, () => { gx().linkBusy = true; }]) {
    const d = gx().detail;
    set(d);
    assert.match(reviewRow("Blake Sample"), /gpexe-choose-recording"[^>]* disabled>Choose a recording</);
    d.approving = false; d.updating = false; gx().linkBusy = false;
  }
  assert.doesNotMatch(reviewRow("Blake Sample"), /gpexe-choose-recording"[^>]* disabled/);
});

// The pick of a link chooser is kept in state: a repaint between the pick and "Link..." (a read answering) never drops it.
test("Link pick: a repaint between the pick and Link... keeps the pick - in the Fix sheet and in the full review; it is drawn as chosen", async () => {
  for (const where of ["fix", "review"]) {
    resetState();
    const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
    await open(w);
    if (where === "fix") await fixFirst();
    else await act("training-load-gpexe-open", { candidateId: "cand-5" });
    // The pick: the select's change, as the browser sends it.
    await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value: "ath-1", matches: () => true }, { renderTrainingLoad: render });
    // A repaint draws the select from the pick (the page's select starts again from what the HTML says).
    const drawn = html();
    assert.match(drawn, /data-gpexe-link-select="101"[^>]*>[\s\S]*?<option value="ath-1" selected>/, `${where}: drawn as chosen`);
    assert.doesNotMatch(drawn, /data-gpexe-link-select="101"[^>]*>\s*<option value="" selected>/, `${where}: not drawn empty`);
    // The page's select is empty after a repaint that forgot it; Link... still asks to confirm the pick.
    selectValues["101"] = "";
    await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
    assert.deepEqual(state.trainingLoad.gpexe.linkConfirm && { g: state.trainingLoad.gpexe.linkConfirm.gpexeAthleteId, a: state.trainingLoad.gpexe.linkConfirm.athleteId }, { g: "101", a: "ath-1" }, `${where}: Link... confirms the kept pick`);
    assert.ok(!/Choose the team athlete first/.test(html()), `${where}: never asked to choose again`);
    // Linked: the pick is done with.
    await act("training-load-gpexe-link-confirm");
    assert.equal(state.trainingLoad.gpexe.linkPicks["101"], undefined, `${where}: the pick is cleared once linked`);
  }
});

test("Link pick: choosing nothing again clears the pick; a pick that is no longer a choice is not drawn; closing the review forgets it", async () => {
  resetState();
  const w = world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } });
  await open(w);
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  const pick = (value) => handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value, matches: () => true }, { renderTrainingLoad: render });
  await pick("ath-1");
  await pick("");
  assert.equal(state.trainingLoad.gpexe.linkPicks["101"], undefined);
  state.trainingLoad.gpexe.linkPicks["101"] = "ath-gone";
  assert.match(html(), /data-gpexe-link-select="101"[^>]*>\s*<option value="" selected>/, "an unknown pick is not drawn");
  await pick("ath-2");
  await act("training-load-gpexe-close");
  assert.deepEqual(state.trainingLoad.gpexe.linkPicks, {}, "closing the review forgets the picks");
});

test("Link pick (code review): a kept pick that is no longer a choice is not used by Link...; it asks to choose", async () => {
  resetState();
  await open(world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } }));
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  state.trainingLoad.gpexe.linkPicks["101"] = "ath-gone";
  selectValues["101"] = "";
  await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
  assert.equal(state.trainingLoad.gpexe.linkConfirm, null, "no confirmation for a pick the screen does not show");
  assert.equal(state.trainingLoad.gpexe.linkError?.code, "choose_athlete");
  assert.equal(state.trainingLoad.gpexe.linkPicks["101"], undefined, "the stale pick is dropped");
  // A pick linked to another GPEXE athlete meanwhile leaves the choices the same way.
  resetState();
  await open(world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101", "102"] } }));
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  const pick = (g, value) => handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: g }, value, matches: () => true }, { renderTrainingLoad: render });
  await pick("101", "ath-1");
  await pick("102", "ath-1");
  await act("training-load-gpexe-link", { gpexeAthleteId: "102" });
  await act("training-load-gpexe-link-confirm");
  selectValues["101"] = "";
  await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
  assert.equal(state.trainingLoad.gpexe.linkConfirm, null, "ath-1 is linked to 102 now: never offered for 101");
  assert.equal(state.trainingLoad.gpexe.linkError?.code, "choose_athlete");
});

test("Link pick (code review): opening the chooser (a click with the same value) changes nothing and never repaints", async () => {
  resetState();
  await open(world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101"] } }));
  await act("training-load-gpexe-open", { candidateId: "cand-5" });
  selectValues["101"] = "";
  await act("training-load-gpexe-link", { gpexeAthleteId: "101" });
  assert.equal(state.trainingLoad.gpexe.linkError?.code, "choose_athlete");
  let renders = 0;
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value: "", matches: () => true }, { renderTrainingLoad: () => { renders += 1; } });
  assert.equal(renders, 0, "no repaint");
  assert.equal(state.trainingLoad.gpexe.linkError?.code, "choose_athlete", "the hint stays until something is picked");
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value: "ath-1", matches: () => true }, { renderTrainingLoad: () => { renders += 1; } });
  assert.equal(state.trainingLoad.gpexe.linkError, null, "a pick answers the hint");
  const before = renders;
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value: "ath-1", matches: () => true }, { renderTrainingLoad: () => { renders += 1; } });
  assert.equal(renders, before, "the same pick again: no repaint");
});

test("Link pick (code review): Skip for now in the Fix sheet forgets that athlete's pick", async () => {
  resetState();
  await open(world({ sessions: [row(5)], unlinkedBy: { "cand-5": ["101", "102"] } }));
  await fixFirst();
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-link-pick", gpexeAthleteId: "101" }, value: "ath-1", matches: () => true }, { renderTrainingLoad: render });
  await act("training-load-gpexe-fix-skip", { gpexeAthleteId: "101" });
  assert.equal(state.trainingLoad.gpexe.linkPicks["101"], undefined);
});
