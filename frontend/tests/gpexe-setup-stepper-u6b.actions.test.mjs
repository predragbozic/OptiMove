// U6b: the setup stepper of the Imports screen, in the order of the agreed "GPS Import Flow" sketch
// (Connect GPEXE -> Choose team -> Variables -> Athletes -> Ready). One step is open at a time; the
// Athletes step starts with the first search and counts the suggested pairs (S6); Variables offers the
// OptiMove GPEXE set and "Choose my own" (S5: the drag-and-drop board in a club workspace, the Mappings screen in the platform workspace); Ready is a checklist (S7)
// whose backup line comes only from the dates an administrator reads. Driven through the real handlers
// with a fake fetch, like the other Imports suites. Every name below is a made-up marker.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => false, matchMedia: () => ({ matches: false }) };

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
  fetchCalls.push(call);
  const result = await responder(call);
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests, clearPendingIdentityLoads } = await import("../gpexe-import-data.js");
const { guideSteps, GUIDE_STEP_TITLES } = await import("../gpexe-guide-steps.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const CLUB = "bbbbbbbb-0000-4000-8000-000000000001";
const BINDING = "cccccccc-0000-4000-8000-000000000001";
const member = (id, name) => ({ id, name, memberships: [{ membershipType: "team", teamId: TEAM, status: "active" }] });
const ORG = { teams: [{ id: TEAM, name: "Zq <Team>", club_id: CLUB, club_name: "Club" }], clubs: [{ id: CLUB, name: "Club" }], athletes: [member("a1", "Zqone"), member("a2", "Zqtwo"), member("a3", "Zqthree"), member("a4", "Zqtwin"), member("a5", "Zqtwin")] };
const MAPPINGS = [1, 2].map((n) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, ownerScope: "system",
  sourceMetric: { id: `s${n}`, key: `key${n}`, apiFamily: "rest_v1", label: `Source ${n}` },
  target: { key: `t${n}`, label: `Variable ${n}` }, activeVersionId: `11111111-0000-4000-8000-00000000000${n}`,
}));
const VIEWERS = {
  admin: { canApprove: false, approvalBasis: null, isPlatformAdmin: true, identityAdmin: true },
  coach: { canApprove: false, approvalBasis: null, isPlatformAdmin: false },
  teamCoach: { canApprove: false, approvalBasis: null, isPlatformAdmin: false, identityLoad: true },
};
const athlete = (id, status) => ({ gpexeAthleteId: String(id), status, link: status === "linked" ? { id: `l${id}`, athleteId: `a${id}`, athleteName: "A", linkedAt: "2026-09-10T10:00:00Z" } : null, lastSeen: null, values: {} });

function server({ viewer = "admin", lastCheck = { id: "c", status: "succeeded" }, athletes = [], candidates = [], suggestions = null, activations = [], switchData = null, bound = true, links = [], candidate = null, previews = {}, onCheck = null }) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url.startsWith("/api/training-load/sources/gpexe/connections")) return { status: 200, body: { connections: [{ id: "conn-1", state: "verified", hostLabel: "GPEXE server3", boundTeams: bound ? [{ bindingId: BINDING, teamId: TEAM, state: "active" }] : [] }] } };
    const pv = call.url.match(/\/metrics\/mappings\/([^/]+)\/versions\/[^/]+\/preview\?candidateId=/);
    if (pv) return previews[pv[1]] ? { status: 200, body: previews[pv[1]] } : { status: 404, body: { error: "notFound" } };
    if (call.url.startsWith("/api/training-load/sources/metrics/mappings")) return { status: 200, body: { mappings: MAPPINGS, nextCursor: null } };
    if (call.url.startsWith("/api/training-load/sources/metrics/activations") && call.method === "GET") return { status: 200, body: { activations, nextCursor: null } };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "on" }, lastCheck, viewer: VIEWERS[viewer], teamImportSwitch: switchData ? { enabled: switchData.enabled, mode: switchData.mode } : { enabled: true, mode: "team" }, approvalAvailable: true } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes, units: {}, lastSeenRule: "" } };
    if (/^\/candidates\/[^/]+$/.test(rest) && candidate) return { status: 200, body: { candidate } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates } };
    if (rest === "/athlete-links") return { status: 200, body: { links } };
    if (rest === "/checks" && call.method === "POST") return onCheck ? onCheck(call) : { status: 404, body: { error: "notFound" } };
    if (rest.startsWith("/checks/")) return { status: 200, body: { check: { id: "k", status: "succeeded", startedAt: "2026-11-10T10:00:00Z" } } };
    if (rest === "/athlete-identities") return { status: 200, body: { identities: [], pendingCount: 0, retryLaterCount: 0, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [] } };
    if (rest === "/athlete-pair-suggestions") return suggestions ? { status: 200, body: suggestions } : { status: 404, body: { error: "notFound" } };
    if (rest === "/import-switch") return { status: 200, body: { importSwitch: switchData || { enabled: true, mode: "team", configured: true } } };
    return { status: 404, body: { error: "notFound" } };
  };
}
const ON = MAPPINGS.map((m) => ({ id: m.id, versionId: m.activeVersionId, mappingId: m.id }));
const tick = () => new Promise((r) => setTimeout(r, 20));
const render = () => {};
function reset(opts = {}) {
  clearAllViewCache();
  state.currentUser = { id: "user-1", activeWorkspace: { type: "club", scopeId: CLUB } };
  state.trainingLoad = emptyTrainingLoadState();
  state.activeTab = "training-load";
  clearPendingIdentityLoads();
  fetchCalls = [];
  responder = server(opts);
}
const act = (action, extra = {}) => handleTrainingLoadAction({ dataset: { action, ...extra } }, { renderTrainingLoad: render });
const open = async () => { await act("training-load-section", { section: "imports" }); await new Promise((r) => setTimeout(r, 30)); };
// IMP1: the stepper sits above the banner while Connect, Choose team or Variables is open; after that it lives in the
// Search tab. The helper reads it where it is, opening the Search tab when the stepper is not above the banner.
const findGuide = () => renderTrainingLoadCoachHtml().match(/<section class="gpexe-guide[\s\S]*?<\/section>/)?.[0] || "";
const guideHtml = () => {
  const above = findGuide();
  if (above) return above;
  if (state.trainingLoad.gpexe) state.trainingLoad.gpexe.tab = "search";
  return findGuide();
};
const openStep = (html) => html.match(/<li class="[^"]*gpexe-guide-current[^"]*"[\s\S]*?<\/div><\/li>/)?.[0] || "";
const facts = (over = {}) => ({ admin: true, conn: { status: "ready", connected: true, bound: true }, check: { status: "succeeded" }, candidates: [], sourceAthletes: [athlete(1, "linked")], vars: { status: "ready", total: 0, onCount: 2 }, teamSwitch: { enabled: true }, teamName: "First", ...over });

test("1. the steps follow the sketch: Connect GPEXE, Choose team, Variables, Athletes, Ready; a coach gets the administrator's three as one row", () => {
  assert.deepEqual(GUIDE_STEP_TITLES, ["Connect GPEXE", "Choose team", "Variables", "Athletes", "Ready"]);
  assert.deepEqual(guideSteps(facts()).steps.map((s) => `${s.id}:${s.title}:${s.state}`), ["1:Connect GPEXE:done", "2:Choose team:done", "3:Variables:done", "4:Athletes:done", "5:Ready:next"]);
  const coach = guideSteps({ ...facts(), admin: false, conn: undefined, vars: undefined });
  assert.deepEqual(coach.steps.map((s) => s.id), [1, 4, 5]);
  assert.equal(coach.steps[0].title, "Connect, team and variables");
  // Variables waits for the team; it is never "done" without a bound team.
  assert.equal(guideSteps(facts({ conn: { status: "ready", connected: true, bound: false } })).steps[2].state, "waiting");
});

test("2. one step is open: the first that is not done; another opens on a click; a variables write keeps Variables open and locks the others", async () => {
  reset({ athletes: [athlete(1, "unlinked")], activations: [] });
  await open();
  let html = guideHtml();
  assert.match(openStep(html), /Variables/, "Variables is the first step not done (two system variables are off)");
  assert.equal((html.match(/aria-current="step"/g) || []).length, 1);
  assert.match(html, /data-action="training-load-gpexe-guide-step" data-step="4"/);
  await act("training-load-gpexe-guide-step", { step: "4" });
  assert.match(openStep(guideHtml()), /Athletes/);
  await act("training-load-gpexe-guide-step", { step: "9" });
  assert.match(openStep(guideHtml()), /Athletes/, "an unknown step changes nothing");
  await act("training-load-gpexe-guide-step", { step: "3" });
  await act("training-load-gpexe-guide-vars-open");
  html = guideHtml();
  assert.match(openStep(html), /Switch on 2 OptiMove variables\?/);
  assert.match(html, /data-step="4" aria-expanded="false" disabled/, "the other steps are locked while the review is open... ");
  await act("training-load-gpexe-guide-step", { step: "4" });
  assert.match(openStep(guideHtml()), /Switch on 2 OptiMove variables\?/, "...and a click does not move away");
  await act("training-load-gpexe-guide-vars-cancel");
  assert.match(openStep(guideHtml()), /Use the OptiMove GPEXE set/, "the click during the review was not kept: Variables stays open after Back");
});

test("3. Variables (S5): the OptiMove GPEXE set is the primary; Choose my own opens the drag-and-drop board for the team in a club workspace (J18), Mappings in the platform workspace", async () => {
  reset({ athletes: [athlete(1, "linked")] });
  await open();
  const step = openStep(guideHtml());
  assert.match(step, /data-action="training-load-gpexe-guide-vars-open"[^>]*>Use the OptiMove GPEXE set</);
  assert.match(step, new RegExp(`data-action="training-load-section" data-section="board" data-mb-team-id="${TEAM}"[^>]*>Choose my own<`));
  const user = state.currentUser;
  state.currentUser = { ...user, activeWorkspace: { type: "platform" } };
  try {
    assert.match(openStep(guideHtml()), /data-action="training-load-section" data-section="mappings"[^>]*>Choose my own</);
  } finally { state.currentUser = user; }
});

test("4. Athletes before the first search: the search is the step's action for an administrator; a coach only reads that an administrator does it", () => {
  const admin = guideSteps(facts({ check: null, sourceAthletes: null, vars: { status: "ready", total: 0, onCount: 1 } }));
  const a4 = admin.steps.find((s) => s.id === 4);
  assert.deepEqual([a4.state, a4.action?.kind, a4.action?.label], ["next", "check", "Find new sessions"]);
  assert.match(a4.text, /OptiMove sees the GPEXE athletes/);
  const running = guideSteps(facts({ check: { status: "running" }, sourceAthletes: null })).steps.find((s) => s.id === 4);
  assert.deepEqual([running.state, running.action], ["running", null]);
  const coach = guideSteps({ admin: false, check: { status: "running" }, candidates: [], sourceAthletes: null }).steps.find((s) => s.id === 4);
  assert.equal(coach.action, null);
});

test("5. Athletes (S6): the exact pairs Review all would stage become Confirm N matches, the rest need a choice; the stepper keeps no name or date of birth", async () => {
  const s4 = (pairs, unlinked) => guideSteps(facts({ sourceAthletes: unlinked, pairs })).steps.find((x) => x.id === 4);
  const unlinked3 = [athlete(1, "unlinked"), athlete(2, "unlinked"), athlete(3, "unlinked")];
  const two = s4({ exact: 2, namesMissing: false }, unlinked3);
  assert.deepEqual([two.action.label, two.pairs.exact, two.pairs.choice], ["Confirm 2 matches", 2, 1]);
  assert.equal(s4({ exact: 1, namesMissing: false }, unlinked3).action.label, "Confirm 1 match");
  assert.equal(s4(null, unlinked3).action.label, "Link athletes", "no pairs read: the plain action");

  const ok = (exact) => ({ state: "ok", exact: exact.map(([g, a]) => ({ gpexeAthleteId: g, gpexeName: "Zqname", birthDate: "2000-01-01", athleteId: a, athleteName: "Zq" })), ambiguous: [], dateConflicts: [] });
  reset({ athletes: unlinked3, suggestions: ok([["1", "a1"], ["9", "a2"]]), activations: ON });
  await open();
  await tick();
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 1, "read once for the stepper");
  const step = openStep(guideHtml());
  assert.match(step, /1 athlete matches by name and date of birth\./, "a pair for a GPEXE athlete not in the list is not counted");
  assert.match(step, /2 athletes need your choice\./);
  assert.match(step, />Confirm 1 match</);
  assert.doesNotMatch(step, /Zqname|2000-01-01/);
  assert.equal(JSON.stringify(state.trainingLoad.gpexe.guidePairs).includes("Zqname"), false, "the stepper's state keeps ids only");
  assert.equal(JSON.stringify(state.trainingLoad.gpexe.guidePairs).includes("2000-01-01"), false);

  reset({ athletes: [athlete(1, "linked")] });
  await open();
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 0, "nothing to link: no read");
  reset({ athletes: [], candidates: [], lastCheck: null });
  await open();
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 0, "no search yet: no read");
});

test("5b. the count equals what Review all stages: a pair whose OptiMove athlete shares a name with another is not promised (code review LOW)", async () => {
  reset({ athletes: [athlete(1, "unlinked")], suggestions: { state: "ok", exact: [{ gpexeAthleteId: "1", athleteId: "a4" }], ambiguous: [], dateConflicts: [] }, activations: ON });
  await open();
  await tick();
  const step = openStep(guideHtml());
  assert.match(step, />Link athletes</);
  assert.doesNotMatch(step, /Confirm 1 match/);
});

test("6. names not loaded: a viewer the server lets load them is pointed to Link athletes; anyone else reads that an administrator can", () => {
  const unlinked = [athlete(1, "unlinked")];
  const missing = { exact: 0, namesMissing: true };
  const can = guideSteps(facts({ sourceAthletes: unlinked, pairs: missing, identityLoad: true })).steps.find((x) => x.id === 4);
  const cannot = guideSteps(facts({ sourceAthletes: unlinked, pairs: missing, identityLoad: false })).steps.find((x) => x.id === 4);
  assert.deepEqual([can.pairs.canLoadNames, cannot.pairs.canLoadNames], [true, false]);
});

test("7. Ready (S7): a checklist with the team's name, the switch, the recorded backup (administrators only) and the first import", async () => {
  const ready = (over) => guideSteps(facts(over)).steps.find((x) => x.id === 5).checklist;
  const mark = (c) => (c.ok === null ? "." : c.ok ? "+" : "-");
  const on = ready({ switchData: { conditions: [{ kind: "backup", met: true, recordedOn: "2026-11-10", maxAgeDays: 2 }] } });
  assert.deepEqual(on.map((c) => `${mark(c)}${c.text}`), [
    "+GPEXE account connected", "+GPEXE team chosen for First", "+OptiMove variables switched on", "+Every GPEXE athlete linked",
    "+Import on for First", ".Last backup recorded 10.11.2026", "-No session imported yet",
  ], "with import on, the backup is information only (ux review)");
  const off = { enabled: false };
  const fresh = ready({ teamSwitch: off, switchData: { conditions: [{ kind: "backup", met: true, recordedOn: "2026-11-10", maxAgeDays: 2 }] } }).find((c) => c.id === "backup");
  assert.deepEqual([fresh.ok, fresh.text], [true, "Backup recorded on 10.11.2026 (needed to switch import on)"]);
  const stale = ready({ teamSwitch: off, switchData: { conditions: [{ kind: "backup", met: false, recordedOn: "2026-11-01", maxAgeDays: 2 }] } }).find((c) => c.id === "backup");
  assert.deepEqual([stale.ok, stale.text], [false, "Backup is older than 2 days (recorded on 01.11.2026) (needed to switch import on)"], "a stale backup is never ticked");
  assert.equal(ready({ teamSwitch: off, switchData: { conditions: [{ kind: "backup", met: false, recordedOn: null, maxAgeDays: 2 }] } }).find((c) => c.id === "backup").text, "No backup recorded (needed to switch import on)");
  assert.equal(ready({}).some((c) => c.id === "backup"), false, "no recorded dates read: no backup line, never a claim");
  assert.equal(ready({ teamSwitch: { enabled: false } }).find((c) => c.id === "switch").text, "Import off for First");
  const coach = guideSteps({ admin: false, check: { status: "succeeded" }, candidates: [{ status: "imported" }], sourceAthletes: [athlete(1, "linked")], teamSwitch: { enabled: true }, teamName: "First" }).steps.find((x) => x.id === 5).checklist;
  assert.equal(coach[0].text, "GPEXE connected by an administrator", "a coach is never told the variables were checked (ux review)");
  assert.deepEqual(coach.map((c) => c.id), ["setup", "athletes", "switch", "imported"]);

  reset({ athletes: [athlete(1, "linked")], activations: ON, switchData: { enabled: true, mode: "team", configured: true, conditions: [{ kind: "backup", met: true, recordedOn: "2026-11-10", maxAgeDays: 2 }] } });
  await open();
  const step = openStep(guideHtml());
  assert.match(step, /Ready/);
  assert.match(step, /Import on for Zq &lt;Team&gt;/, "the team's name is escaped");
  assert.match(step, /Last backup recorded 10\.11\.2026/);
  assert.doesNotMatch(step, /<Team>/);
});

test("8. a later failed or running search never undoes Athletes: what is linked stays done (code review MEDIUM)", () => {
  for (const status of ["failed", "running"]) {
    const r = guideSteps(facts({ check: { status }, sourceAthletes: [athlete(1, "linked")], candidates: [{ status: "imported" }] }));
    const a4 = r.steps.find((x) => x.id === 4);
    assert.equal(a4.state, "done", status);
    assert.equal(a4.action, null);
    assert.equal(r.steps[4].checklist.find((c) => c.id === "athletes").ok, true);
  }
  // no evidence of a search yet: a coach is offered the search too (the server lets the team's coach search; ux review)
  const coach = guideSteps({ admin: false, check: null, candidates: [], sourceAthletes: null, conn: undefined });
  assert.equal(coach.steps.find((x) => x.id === 4).state, "waiting", "the administrator's part first");
  const coachReady = guideSteps({ admin: false, check: null, candidates: [{ status: "pending" }], sourceAthletes: [], teamSwitch: { enabled: true } }).steps.find((x) => x.id === 4);
  assert.equal(coachReady.action?.kind, "check", "nothing seen yet: the instruction comes with its button");
});

test("9. the counts follow a search finished in the stepper and come back after Link athletes closes (code review MEDIUM)", async () => {
  const oneExact = { state: "ok", exact: [{ gpexeAthleteId: "1", athleteId: "a1" }], ambiguous: [], dateConflicts: [] };
  const unlinked3 = [athlete(1, "unlinked"), athlete(2, "unlinked"), athlete(3, "unlinked")];
  // Nothing seen before the first search; the search shows three athletes to link.
  const seen = [];
  reset({ athletes: seen, lastCheck: null, suggestions: oneExact, activations: ON, onCheck: () => { seen.push(...unlinked3); return { status: 201, body: { check: { id: "k", status: "running", startedAt: "2026-11-10T10:00:00Z" } } }; } });
  await open();
  await tick();
  assert.doesNotMatch(guideHtml(), /Confirm 1 match/, "before the first search there is nothing to count");
  await act("training-load-gpexe-check");
  await tick();
  assert.match(openStep(guideHtml()), />Confirm 1 match</, "read again when the search succeeded");
  await act("training-load-gpexe-map-open");
  await tick();
  await act("training-load-gpexe-map-close");
  await tick();
  assert.match(guideHtml(), /Confirm 1 match/, "Link athletes cleared its own list; the stepper keeps its counts");

  // Names loaded inside Link athletes: back in the stepper the counts follow (read again on Close).
  const later = { state: "no_identities_loaded", exact: [], ambiguous: [], dateConflicts: [] };
  reset({ athletes: unlinked3, suggestions: later, activations: ON });
  await open();
  await tick();
  assert.match(openStep(guideHtml()), />Link athletes</);
  await act("training-load-gpexe-map-open");
  await tick();
  Object.assign(later, { state: "ok", exact: [{ gpexeAthleteId: "2", athleteId: "a2" }] });
  await act("training-load-gpexe-map-close");
  await tick();
  assert.match(openStep(guideHtml()), />Confirm 1 match</);
});

test("10. Variables (S4): two athletes' values for a variable already on, a count and a range for one not on yet; nothing before a search", async () => {
  const cand = { id: "cand-1", status: "pending", sessionStartedAt: "2026-11-10T16:00:00Z", gpexeTeamSessionId: "5", sessionLabel: "S", reasons: [] };
  const detail = {
    id: "cand-1",
    athletes: { a1: { name: "Zqone" }, a2: { name: "Zqtwo" }, a3: { name: "Zqthree" } },
    preview: { version: 3, athletes: ["a1", "a2", "a3"].map((id, n) => ({ athleteId: id, results: [{ level: "session", outcome: "created", values: [{ sourceMetricKey: "key1", mappingVersionId: MAPPINGS[0].activeVersionId, value: 6500 + n, unit: "m" }] }] })) },
  };
  const previews = { [MAPPINGS[1].id]: { preview: { targetUnit: "min", levels: { session: { athletesWithValue: 13, minCanonical: "45", maxCanonical: "96.5" } } } } };
  const half = [{ id: "act", versionId: MAPPINGS[0].activeVersionId, mappingId: MAPPINGS[0].id }];
  reset({ athletes: [athlete(1, "linked")], candidates: [cand], candidate: detail, previews, activations: half });
  await open();
  await tick();
  const step = openStep(guideHtml());
  assert.match(step, /From the session of 10\.11\.2026:/);
  assert.match(step, /Variable 1 from Source 1<\/strong><span class="muted gpexe-guide-sample-values"><span class="gpexe-guide-pair">Zqone 6\u2009500 m<\/span> \u00b7 <span class="gpexe-guide-pair">Zqtwo 6\u2009501 m<\/span><\/span>/, "two athletes, never a third; each pair kept together");
  assert.doesNotMatch(step, /Zqthree/);
  assert.match(step, /Variable 2 from Source 2<\/strong><span class="muted gpexe-guide-sample-values"><span class="gpexe-guide-pair">13 athletes \u00b7 45\u201396\.5 min</);
  assert.equal(fetchCalls.filter((c) => /\/preview\?candidateId=cand-1$/.test(c.url)).length, 1, "one aggregate read per variable not on");

  reset({ athletes: [athlete(1, "linked")], candidates: [], activations: half });
  await open();
  await tick();
  assert.doesNotMatch(guideHtml(), /From the session of/, "no saved session: no sample and no read");
  assert.equal(fetchCalls.filter((c) => /\/preview\?/.test(c.url)).length, 0);

  // fewer than three athletes with a value: a count only (OD3)
  reset({ athletes: [athlete(1, "linked")], candidates: [cand], candidate: detail, activations: half, previews: { [MAPPINGS[1].id]: { preview: { targetUnit: "min", levels: { session: { athletesWithValue: 2, minCanonical: null, maxCanonical: null } } } } } });
  await open();
  await tick();
  assert.match(openStep(guideHtml()), /2 athletes have a value/);
});

test("11. Connect and Choose team open Settings > Source connections (navigation only, nothing sent); the open step's name carries its number", async () => {
  const r = guideSteps(facts({ conn: { status: "ready", connected: true, bound: false } }));
  assert.equal(r.steps[1].action.kind, "settings");
  assert.match(r.steps[1].text, /Choose the GPEXE team for First/);
  assert.equal(guideSteps(facts({ conn: { status: "ready", connected: false, bound: false } })).steps[0].action.kind, "settings");
  reset({ bound: false, athletes: [] });
  await open();
  const html = guideHtml();
  assert.match(openStep(html), /data-tab="organization" data-settings-section="sourceConnections"[^>]*>Open Source connections</);
  assert.match(html, /<span class="visually-hidden">Step 1: <\/span><strong>Connect GPEXE/);
  assert.doesNotMatch(html, /server3/, "no host name in the stepper");
});

test("8b. a coach's merged row uses the same evidence as Athletes: linked athletes count, even after a failed search (code re-review LOW)", () => {
  const r = guideSteps({ admin: false, check: { status: "failed" }, candidates: [], sourceAthletes: [athlete(1, "linked")], teamSwitch: { enabled: true } });
  assert.equal(r.steps[0].state, "done");
  assert.equal(r.steps.find((x) => x.id === 5).checklist.find((c) => c.id === "setup").ok, true);
});

test("9b. a later failed search keeps the counts (one evidence rule for the steps and the counts; code re-review LOW)", async () => {
  const oneExact = { state: "ok", exact: [{ gpexeAthleteId: "1", athleteId: "a1" }], ambiguous: [], dateConflicts: [] };
  reset({ athletes: [athlete(1, "unlinked"), athlete(2, "unlinked")], suggestions: oneExact, activations: ON, onCheck: () => ({ status: 201, body: { check: { id: "k", status: "running", startedAt: "2026-11-10T10:00:00Z" } } }) });
  let failed = false;
  const failedCheck = { id: "k", status: "failed", startedAt: "2026-11-10T10:00:00Z" };
  responder = ((base) => async (call) => {
    if (call.url.includes("/checks/")) { failed = true; return { status: 200, body: { check: failedCheck } }; }
    const answer = await base(call);
    // After the failed search the server's latest check is that failed one.
    if (failed && call.url.endsWith("/status")) return { ...answer, body: { ...answer.body, lastCheck: failedCheck } };
    return answer;
  })(responder);
  await open();
  await tick();
  assert.match(openStep(guideHtml()), />Confirm 1 match</);
  await act("training-load-gpexe-check");
  await tick();
  assert.match(guideHtml(), /Confirm 1 match/, "the failed search did not clear the counts");
});

test("10b. a sample is the value of exactly that variable: two mappings of one GPEXE field never show each other's values (code re-review LOW)", async () => {
  const twin = [MAPPINGS[0], { ...MAPPINGS[1], sourceMetric: MAPPINGS[0].sourceMetric }];
  const cand = { id: "cand-1", status: "pending", sessionStartedAt: "2026-11-10T16:00:00Z", gpexeTeamSessionId: "5", sessionLabel: "S", reasons: [] };
  const value = (versionId, v, unit) => ({ sourceMetricKey: "key1", mappingVersionId: versionId, value: v, unit });
  const detail = {
    id: "cand-1", athletes: { a1: { name: "Zqone" }, a2: { name: "Zqtwo" } },
    preview: { version: 3, athletes: ["a1", "a2"].map((id) => ({ athleteId: id, results: [{ level: "session", outcome: "created", values: [value(twin[1].activeVersionId, 6.5, "km"), value(twin[0].activeVersionId, 6500, "m")] }] })) },
  };
  reset({ athletes: [athlete(1, "linked")], candidates: [cand], candidate: detail, activations: ON });
  responder = ((base) => async (call) => (call.url.startsWith("/api/training-load/sources/metrics/mappings") && !call.url.includes("/preview") ? { status: 200, body: { mappings: twin, nextCursor: null } } : base(call)))(responder);
  await open();
  await tick();
  await act("training-load-gpexe-guide-step", { step: "3" });
  const step = openStep(guideHtml());
  assert.match(step, /Variable 1 from Source 1<\/strong><span[^>]*><span class="gpexe-guide-pair">Zqone 6\u2009500 m</);
  assert.match(step, /Variable 2 from Source 1<\/strong><span[^>]*><span class="gpexe-guide-pair">Zqone 6\.5 km</);
});

test("12. placement in IMP1's tabs: above the banner while Variables is open; once it is done, only in the Search tab, for an administrator and a coach alike", async () => {
  const above = () => findGuide();
  const tabPanel = () => renderTrainingLoadCoachHtml().match(/<div class="imports-tab-panel" data-imports-tab="([^"]+)">([\s\S]*)/);
  // Variables not switched on yet: the stepper is above the tabs, whatever tab is chosen.
  reset({ athletes: [athlete(1, "unlinked")] });
  await open();
  await tick();
  assert.match(above(), /Set up GPEXE imports/);
  assert.ok(renderTrainingLoadCoachHtml().indexOf("gpexe-guide") < renderTrainingLoadCoachHtml().indexOf("imports-tabs"), "above the tabs");
  for (const viewer of ["admin", "coach"]) {
    reset({ viewer, athletes: [athlete(1, "unlinked")], activations: ON });
    await open();
    await tick();
    const [, tab, panel] = tabPanel();
    assert.notEqual(tab, "search", `${viewer}: the list tab is the default`);
    assert.doesNotMatch(panel, /gpexe-guide/, `${viewer}: not in the list tab`);
    assert.ok(renderTrainingLoadCoachHtml().indexOf("gpexe-guide") === -1, `${viewer}: not above the banner once Variables is done`);
    await act("training-load-gpexe-tab", { importTab: "search" });
    const [, now, searchPanel] = tabPanel();
    assert.equal(now, "search");
    assert.match(searchPanel, /<section class="gpexe-guide/, `${viewer}: in the Search tab`);
    assert.match(searchPanel, /Athletes/);
  }
});
