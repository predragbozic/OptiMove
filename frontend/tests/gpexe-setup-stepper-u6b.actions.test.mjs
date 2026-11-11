// U6b: the setup stepper of the Imports screen, in the order of the agreed "GPS Import Flow" sketch
// (Connect GPEXE -> Choose team -> Variables -> Athletes -> Ready). One step is open at a time; the
// Athletes step starts with the first search and counts the suggested pairs (S6); Variables offers the
// OptiMove GPEXE set and "Choose my own" (S5, the Mappings screen for now); Ready is a checklist (S7)
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
const ORG = { teams: [{ id: TEAM, name: "Zq <Team>", club_id: CLUB, club_name: "Club" }], clubs: [{ id: CLUB, name: "Club" }], athletes: [] };
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

function server({ viewer = "admin", lastCheck = { id: "c", status: "succeeded" }, athletes = [], candidates = [], suggestions = null, activations = [], switchData = null, bound = true }) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url.startsWith("/api/training-load/sources/gpexe/connections")) return { status: 200, body: { connections: [{ id: "conn-1", state: "verified", hostLabel: "GPEXE server3", boundTeams: bound ? [{ bindingId: BINDING, teamId: TEAM, state: "active" }] : [] }] } };
    if (call.url.startsWith("/api/training-load/sources/metrics/mappings")) return { status: 200, body: { mappings: MAPPINGS, nextCursor: null } };
    if (call.url.startsWith("/api/training-load/sources/metrics/activations") && call.method === "GET") return { status: 200, body: { activations, nextCursor: null } };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "on" }, lastCheck, viewer: VIEWERS[viewer], teamImportSwitch: switchData ? { enabled: switchData.enabled, mode: switchData.mode } : { enabled: true, mode: "team" }, approvalAvailable: true } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes, units: {}, lastSeenRule: "" } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest === "/athlete-identities") return { status: 200, body: { identities: [], pendingCount: 0, retryLaterCount: 0, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [] } };
    if (rest === "/athlete-pair-suggestions") return suggestions ? { status: 200, body: suggestions } : { status: 404, body: { error: "notFound" } };
    if (rest === "/import-switch") return { status: 200, body: { importSwitch: switchData || { enabled: true, mode: "team", configured: true } } };
    return { status: 404, body: { error: "notFound" } };
  };
}
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
const guideHtml = () => renderTrainingLoadCoachHtml().match(/<section class="gpexe-guide[\s\S]*?<\/section>/)?.[0] || "";
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

test("3. Variables (S5): the OptiMove GPEXE set is the primary; Choose my own opens Data configuration > Mappings", async () => {
  reset({ athletes: [athlete(1, "linked")] });
  await open();
  const step = openStep(guideHtml());
  assert.match(step, /data-action="training-load-gpexe-guide-vars-open"[^>]*>Use the OptiMove GPEXE set</);
  assert.match(step, /data-action="training-load-section" data-section="mappings"[^>]*>Choose my own</);
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

test("5. Athletes (S6): the exact pairs become Confirm N matches, the rest need a choice; without names the step says who can load them; the suggestions are read once a search has athletes to link", async () => {
  const sugg = (exact, state = "ok") => ({ status: "ready", data: { state, exact: exact.map((id) => ({ gpexeAthleteId: String(id), athleteId: `a${id}` })), ambiguous: [], dateConflicts: [] } });
  const unlinked3 = [athlete(1, "unlinked"), athlete(2, "unlinked"), athlete(3, "unlinked")];
  const s = guideSteps(facts({ sourceAthletes: unlinked3, suggestions: sugg([1, 2, 9]) })).steps.find((x) => x.id === 4);
  assert.equal(s.action.label, "Confirm 2 matches", "a pair for an athlete not in the list is not counted");
  assert.deepEqual([s.pairs.exact, s.pairs.choice], [2, 1]);
  const one = guideSteps(facts({ sourceAthletes: unlinked3, suggestions: sugg([3]) })).steps.find((x) => x.id === 4);
  assert.equal(one.action.label, "Confirm 1 match");
  const none = guideSteps(facts({ sourceAthletes: unlinked3, suggestions: sugg([], "no_identities_loaded") })).steps.find((x) => x.id === 4);
  assert.equal(none.action.label, "Link athletes");
  assert.equal(none.pairs.namesMissing, true);

  reset({ athletes: unlinked3, suggestions: { state: "ok", exact: [{ gpexeAthleteId: "1", gpexeName: "Zqname", birthDate: "2000-01-01", athleteId: "a1", athleteName: "Zq" }], ambiguous: [], dateConflicts: [] }, activations: MAPPINGS.map((m) => ({ id: m.id, versionId: m.activeVersionId, mappingId: m.id })) });
  await open();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 1, "read once for the stepper");
  const step = openStep(guideHtml());
  assert.match(step, /Athletes/);
  assert.match(step, /1 athlete matches by name and date of birth\./);
  assert.match(step, /2 athletes need your choice\./);
  assert.match(step, />Confirm 1 match</);
  assert.doesNotMatch(step, /Zqname|2000-01-01/, "no name or date of birth in the stepper");

  // An identity administrator whose viewer has no identityLoad flag (a server before #494) can still load the names.
  reset({ athletes: unlinked3, suggestions: { state: "no_identities_loaded", exact: [], ambiguous: [], dateConflicts: [] }, activations: MAPPINGS.map((m) => ({ id: m.id, versionId: m.activeVersionId, mappingId: m.id })) });
  await open();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(openStep(guideHtml()), /Load the GPEXE names and dates of birth in Link athletes/);

  reset({ athletes: [athlete(1, "linked")] });
  await open();
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 0, "nothing to link: no read");
  reset({ athletes: unlinked3, lastCheck: null });
  await open();
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-pair-suggestions")).length, 0, "no search yet: no read");
});

test("6. names not loaded: a viewer the server lets load them is pointed to Link athletes; anyone else reads that an administrator can", () => {
  const unlinked = [athlete(1, "unlinked")];
  const missing = { status: "ready", data: { state: "no_identities_loaded", exact: [], ambiguous: [], dateConflicts: [] } };
  const can = guideSteps(facts({ sourceAthletes: unlinked, suggestions: missing, identityLoad: true })).steps.find((x) => x.id === 4);
  const cannot = guideSteps(facts({ sourceAthletes: unlinked, suggestions: missing, identityLoad: false })).steps.find((x) => x.id === 4);
  assert.deepEqual([can.pairs.canLoadNames, cannot.pairs.canLoadNames], [true, false]);
});

test("7. Ready (S7): a checklist with the team's name, the switch, the recorded backup (administrators only) and the first import", async () => {
  const ready = (over) => guideSteps(facts(over)).steps.find((x) => x.id === 5).checklist;
  const items = ready({ switchData: { conditions: [{ kind: "backup", met: true, recordedOn: "2026-11-10", maxAgeDays: 2 }] } });
  assert.deepEqual(items.map((c) => `${c.ok ? "+" : "-"}${c.text}`), [
    "+GPEXE account connected", "+Team bound to its GPEXE team", "+OptiMove variables switched on", "+Every GPEXE athlete linked",
    "+Import on for First", "+Backup recorded on 10.11.2026", "-Import your first session below",
  ]);
  const stale = ready({ switchData: { conditions: [{ kind: "backup", met: false, recordedOn: "2026-11-01", maxAgeDays: 2 }] } }).find((c) => c.id === "backup");
  assert.deepEqual([stale.ok, stale.text], [false, "Backup is older than 2 days (recorded on 01.11.2026)"], "a stale backup is never ticked");
  assert.equal(ready({ switchData: { conditions: [{ kind: "backup", met: false, recordedOn: null, maxAgeDays: 2 }] } }).find((c) => c.id === "backup").text, "No backup recorded");
  assert.equal(ready({}).some((c) => c.id === "backup"), false, "no recorded dates read: no backup line, never a claim");
  assert.equal(ready({ teamSwitch: { enabled: false } }).find((c) => c.id === "switch").text, "Import off for First");
  const coach = guideSteps({ admin: false, check: { status: "succeeded" }, candidates: [{ status: "imported" }], sourceAthletes: [athlete(1, "linked")], teamSwitch: { enabled: true }, teamName: "First" }).steps.find((x) => x.id === 5).checklist;
  assert.deepEqual(coach.map((c) => c.id), ["setup", "athletes", "switch", "imported"]);

  reset({ athletes: [athlete(1, "linked")], activations: MAPPINGS.map((m) => ({ id: m.id, versionId: m.activeVersionId, mappingId: m.id })), switchData: { enabled: true, mode: "team", configured: true, conditions: [{ kind: "backup", met: true, recordedOn: "2026-11-10", maxAgeDays: 2 }] } });
  await open();
  const step = openStep(guideHtml());
  assert.match(step, /Ready/);
  assert.match(step, /Import on for Zq &lt;Team&gt;/, "the team's name is escaped");
  assert.match(step, /Backup recorded on 10\.11\.2026/);
  assert.doesNotMatch(step, /<Team>/);
});
