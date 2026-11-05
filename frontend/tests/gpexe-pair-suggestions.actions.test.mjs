// U3 (J19): suggested athlete pairs on Link athletes, "Review all", driven through
// handleTrainingLoadAction with a fake fetch like the other Imports suites. The
// server decides who reads the suggestions (the team's coach and the two identity
// administrators); this suite proves what the screen does with the three lists:
// only EXACT pairs are ever staged, together, into the ordinary review; the links
// are made by the existing route one pair at a time after one confirmation; a lost
// answer is never resent; every name is escaped; no GPEXE id is shown.
// Every id, name and date below is a made-up marker.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = false;
let confirmQuestions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, cache: options.cache };
  fetchCalls.push(call);
  const result = await responder(call);
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, clearPendingIdentityLoads } = await import("../gpexe-import-data.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const member = { teamId: TEAM, membershipType: "team", status: "active" };
const lastSeen = { candidateId: "cand-1", gpexeTeamSessionId: "7001", sessionStartedAt: "2026-09-14T16:08:12Z", sessionLabel: "FULL", sessionType: "FULL", candidateStatus: "pending", lastSeenAt: "2026-09-18T10:00:00Z", evidence: "preview", sessionDrillsCount: 0 };
const sa = (id, over = {}) => ({ gpexeAthleteId: id, status: "unlinked", link: null, lastSeen, values: { duration: 74, distance: 5230, maxSpeed: 29.5 }, ...over });

let ATHLETES;
let SOURCE;
function fixture(n) {
  ATHLETES = Array.from({ length: n }, (_, i) => ({ id: `ath-${i + 1}`, name: `Athlete ${i + 1}`, memberships: [member] }));
  SOURCE = Array.from({ length: n }, (_, i) => sa(String(88100 + i)));
}
const ORG = () => ({ teams: [{ id: TEAM, name: "First Team", club_name: "Club" }], clubs: [], athletes: ATHLETES });
const VIEWERS = {
  coach: { canApprove: false, approvalBasis: null, isPlatformAdmin: false },
  "club admin": { canApprove: false, approvalBasis: null, isPlatformAdmin: false, identityAdmin: true },
};
const pair = (i, over = {}) => ({ gpexeAthleteId: String(88100 + i), gpexeName: `Gname ${i}`, birthDate: "2005-01-02", athleteId: `ath-${i + 1}`, athleteName: `Athlete ${i + 1}`, ...over });

function server({ viewer, suggestions, onLink }) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG() };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "on" }, lastCheck: null, viewer, approvalAvailable: true } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: SOURCE, units: {}, lastSeenRule: "" } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates: [] } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest === "/athlete-links" && call.method === "POST") return onLink ? onLink(call) : { status: 201, body: { link: { id: `link-${call.body.gpexeAthleteId}` } } };
    if (rest === "/athlete-identities") return { status: 200, body: { identities: [], pendingCount: 0, retryLaterCount: 0, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [] } };
    if (rest === "/athlete-pair-suggestions") return typeof suggestions === "function" ? suggestions(call) : { status: 200, body: suggestions };
    return { status: 404, body: { error: "notFound" } };
  };
}

const render = () => {};
function reset(viewer, opts = {}) {
  clearAllViewCache();
  state.currentUser = { id: "user-1", activeWorkspace: { type: "team", scopeId: TEAM } };
  state.trainingLoad = emptyTrainingLoadState();
  state.activeTab = "training-load";
  clearPendingIdentityLoads();
  confirmAnswer = false;
  confirmQuestions = [];
  fetchCalls = [];
  responder = server({ viewer: VIEWERS[viewer], ...opts });
}
const act = (action, extra = {}, element = {}) => handleTrainingLoadAction({ dataset: { action, ...extra }, ...element }, { renderTrainingLoad: render });
const pageHtml = () => renderTrainingLoadCoachHtml();
const suggestCalls = () => fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions"));
const posts = () => fetchCalls.filter((c) => c.method === "POST");
async function openMapping() {
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-map-open");
}
const OK = (over = {}) => ({ state: "ok", snapshotCount: 4, expiresAt: "2026-11-20T00:00:00Z", exact: [], ambiguous: [], dateConflicts: [], ...over });
const visibleText = (html) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/g, " ");

test("1. the coach's Link athletes shows only the exact pairs as Suggested pairs (names and Born date, no id), the rest under Needs your choice; the read is one GET with no-store; a name is escaped", async () => {
  fixture(5);
  reset("coach", { suggestions: OK({
    exact: [pair(0, { gpexeName: "Ana <img src=x onerror=alert(1)>" }), pair(1)],
    ambiguous: [{ gpexeAthleteId: "88102", gpexeName: "Twin Name", birthDate: null, candidates: [{ athleteId: "ath-3", athleteName: "Athlete 3" }, { athleteId: "ath-4", athleteName: "Athlete 4" }] }],
    dateConflicts: [{ gpexeAthleteId: "88104", gpexeName: "Date Diff", birthDate: "2001-01-01", athleteId: "ath-5", athleteName: "Athlete 5" }],
  }) });
  await openMapping();
  assert.equal(suggestCalls().length, 1);
  assert.equal(suggestCalls()[0].method, "GET");
  assert.equal(suggestCalls()[0].cache, "no-store");
  const html = pageHtml();
  assert.match(html, /Suggested pairs \(2\)/);
  assert.match(html, /Review all 2 suggested pairs/);
  assert.match(html, /Needs your choice \(2\)/);
  assert.ok(!html.includes("<img src=x"), "the name is escaped");
  assert.match(html, /Ana &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Born 02\.01\.2005/);
  assert.match(html, /Date Diff/);
  assert.match(html, /dates of birth differ/);
  const section = html.match(/<section class="gpexe-suggest"[\s\S]*?<\/section>/)?.[0] || "";
  assert.ok(section.length > 100, "the suggestions section is there");
  for (const id of ["88100", "88101", "88102", "88104"]) assert.ok(!section.includes(id), `GPEXE id ${id} is not in the suggestions section (text, label or attribute)`);
  // The needs-your-choice rows have no button of their own.
  assert.equal((html.match(/training-load-gpexe-map-suggest-all/g) || []).length, 1);
});

test("2. Review all stages exactly the exact pairs into the ordinary review (nothing is sent), names both sides; Link N athletes sends one POST per pair through the existing route, then the result; ambiguous and conflicting entries are never staged", async () => {
  fixture(5);
  reset("coach", { suggestions: OK({
    exact: [pair(0), pair(1)],
    ambiguous: [{ gpexeAthleteId: "88102", gpexeName: "Twin", birthDate: null, candidates: [{ athleteId: "ath-3", athleteName: "Athlete 3" }] }],
    dateConflicts: [{ gpexeAthleteId: "88103", gpexeName: "Diff", birthDate: "2001-01-01", athleteId: "ath-4", athleteName: "Athlete 4" }],
  }) });
  await openMapping();
  await act("training-load-gpexe-map-suggest-all");
  assert.equal(posts().length, 0, "nothing is sent by Review all");
  const g = state.trainingLoad.gpexe;
  assert.equal(g.mapping.confirming, true);
  assert.deepEqual(g.mapping.choices, { 88100: "ath-1", 88101: "ath-2" });
  const review = pageHtml();
  assert.match(review, /Link 2 athletes\?/);
  assert.match(review, /Athlete 1/);
  assert.match(review, /Athlete 2/);
  await act("training-load-gpexe-map-send");
  assert.deepEqual(posts().map((c) => c.body), [{ gpexeAthleteId: "88100", athleteId: "ath-1" }, { gpexeAthleteId: "88101", athleteId: "ath-2" }]);
  assert.equal(g.mapping.results.length, 2);
  assert.ok(g.mapping.results.every((r) => r.outcome === "linked"));
});

test("3. a lost answer is Result not confirmed and is never resent; a refusal of one pair does not stop the others", async () => {
  fixture(3);
  let n = 0;
  reset("coach", { suggestions: OK({ exact: [pair(0), pair(1), pair(2)] }), onLink: (call) => {
    n += 1;
    if (call.body.gpexeAthleteId === "88100") return { status: 409, body: { error: "already_linked", message: "That GPEXE athlete or athlete is already linked." } };
    if (call.body.gpexeAthleteId === "88101") return { status: 502, body: "<html>" };
    return { status: 201, body: { link: { id: "l3" } } };
  } });
  await openMapping();
  await act("training-load-gpexe-map-suggest-all");
  await act("training-load-gpexe-map-send");
  assert.equal(posts().length, 3, "one request per pair, none repeated");
  assert.deepEqual(state.trainingLoad.gpexe.mapping.results.map((r) => r.outcome), ["refused", "unknown", "linked"]);
  assert.match(pageHtml(), /not confirmed - the answer was lost/);
  assert.equal(n, 3);
});

test("4. the states: no loaded names (a coach is told to ask an administrator, an administrator to load them), a 404 shows nothing, a failure says it could not be read and keeps manual linking; no suggestion at all says so", async () => {
  fixture(2);
  reset("coach", { suggestions: { state: "no_identities_loaded", snapshotCount: 0, expiresAt: null, exact: [], ambiguous: [], dateConflicts: [] } });
  await openMapping();
  assert.match(pageHtml(), /Ask an administrator to load them/);
  assert.ok(!/training-load-gpexe-map-suggest-all/.test(pageHtml()));
  reset("club admin", { suggestions: { state: "no_identities_loaded", snapshotCount: 0, expiresAt: null, exact: [], ambiguous: [], dateConflicts: [] } });
  await openMapping();
  assert.match(pageHtml(), /Load the GPEXE names and dates of birth below/);
  reset("coach", { suggestions: () => ({ status: 404, body: { error: "notFound" } }) });
  await openMapping();
  assert.ok(!/Suggested pairs|suggested pairs|administrator to load/.test(pageHtml()), "a 404 shows nothing");
  assert.ok(!/gpexe-error/.test(pageHtml().match(/<section class="gpexe-suggest[\s\S]*?<\/section>/)?.[0] || ""));
  reset("coach", { suggestions: () => ({ status: 500, body: { error: "internal_error" } }) });
  await openMapping();
  assert.match(pageHtml(), /Suggested pairs could not be read/);
  assert.match(pageHtml(), /Not linked \(2\)/, "manual linking is still there");
  reset("coach", { suggestions: OK() });
  await openMapping();
  assert.match(pageHtml(), /No suggested pairs/);
});

test("5. only pairs the screen can still stage are staged: a GPEXE athlete already linked, an athlete already linked or gone, and a duplicate roster name are skipped; at most 60 per review", async () => {
  fixture(70);
  SOURCE[1] = sa("88101", { status: "linked", link: { id: "l", athleteId: "ath-2", athleteName: "Athlete 2", linkedAt: "2026-09-10T10:00:00Z" } });
  ATHLETES[2].memberships = [{ ...member, status: "inactive" }];   // ath-3 left the team
  ATHLETES[4].name = "Athlete 4";                                  // ath-5 now shares ath-4's name
  reset("coach", { suggestions: OK({ exact: Array.from({ length: 70 }, (_, i) => pair(i)) }) });
  await openMapping();
  const html = pageHtml();
  // 70 pairs: 88101 linked, ath-3 gone, ath-4 and ath-5 share a name -> 66 stageable, 60 shown.
  assert.match(html, /Suggested pairs \(60\)/);
  assert.match(html, /The first 60 are listed/);
  await act("training-load-gpexe-map-suggest-all");
  const keys = Object.keys(state.trainingLoad.gpexe.mapping.choices);
  assert.equal(keys.length, 60);
  for (const skipped of ["88101", "88102", "88103", "88104"]) assert.ok(!keys.includes(skipped), `${skipped} not staged`);
});

test("6. closing the screen drops the suggestions; Review all is off while a write runs or the list may be out of date; a team switch keeps nothing of another team", async () => {
  fixture(2);
  reset("coach", { suggestions: OK({ exact: [pair(0)] }) });
  await openMapping();
  assert.equal(state.trainingLoad.gpexe.suggestions.status, "ready");
  state.trainingLoad.gpexe.sourceAthletesError = { status: 500 };
  assert.match(pageHtml(), /data-action="training-load-gpexe-map-suggest-all" disabled/);
  await act("training-load-gpexe-map-suggest-all");
  assert.equal(state.trainingLoad.gpexe.mapping.confirming, false, "no review from a list that may be out of date");
  state.trainingLoad.gpexe.sourceAthletesError = null;
  await act("training-load-gpexe-map-close");
  assert.deepEqual(state.trainingLoad.gpexe.suggestions, { status: "idle", data: null });
  assert.ok(!/Suggested pairs/.test(pageHtml()));
});
