// U4 (J19): the five-step setup guide on Imports and "Use OptiMove variables",
// driven through handleTrainingLoadAction with a fake fetch like the other
// Imports suites. The server decides everything; this suite proves what the
// screen reads, offers and sends: which system variables are offered, one
// POST /activations per variable with its own key, the stop at the first
// refusal, a lost answer repeated only by Check result with the same key.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = false;
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => confirmAnswer, matchMedia: () => ({ matches: false }) };

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
const { setGpexePollDelayForTests, clearPendingIdentityLoads, importsUnloadShouldWarn } = await import("../gpexe-import-data.js");
const { guideSteps } = await import("../gpexe-guide-steps.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
const CLUB = "bbbbbbbb-0000-4000-8000-000000000001";
const BINDING = "cccccccc-0000-4000-8000-000000000001";
const ORG = { teams: [{ id: TEAM, name: "First Team", club_id: CLUB, club_name: "Club" }], clubs: [{ id: CLUB, name: "Club" }], athletes: [] };

const mapping = (n, over = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, ownerScope: "system",
  sourceMetric: { id: `s${n}`, key: `key${n}`, apiFamily: "rest_v1", label: `Source ${n}` },
  target: { key: `t${n}`, label: `Variable ${n}` }, activeVersionId: `11111111-0000-4000-8000-00000000000${n}`, ...over,
});
// 1,2,3: offered. 4: hidden by the club. 5: already on. 6: another family. 7: the club's own. 8: no active version.
const MAPPINGS = [
  mapping(1), mapping(2), mapping(3),
  mapping(4, { targetHiddenInClub: true }),
  mapping(5),
  mapping(6, { sourceMetric: { id: "s6", key: "k6", apiFamily: "api", label: "Other family" } }),
  mapping(7, { ownerScope: "club" }),
  mapping(8, { activeVersionId: null }),
];
const ACTIVATIONS = [{ id: "act-5", versionId: "11111111-0000-4000-8000-000000000005", bindingId: BINDING }];
const VIEWERS = {
  admin: { canApprove: false, approvalBasis: null, isPlatformAdmin: false, identityAdmin: true },
  coach: { canApprove: false, approvalBasis: null, isPlatformAdmin: false },
};

function server({ viewer = "admin", mappings = MAPPINGS, activations = ACTIVATIONS, onActivate, connections, lastCheck = null, athletes = [], candidates = [] }) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    if (call.url.startsWith("/api/training-load/sources/gpexe/connections")) return connections ? connections(call) : { status: 200, body: { connections: [{ id: "conn-1", state: "verified", hostLabel: "GPEXE server3", boundTeams: [{ bindingId: BINDING, teamId: TEAM, state: "active" }] }] } };
    if (call.url.startsWith("/api/training-load/sources/metrics/mappings")) return { status: 200, body: { mappings, nextCursor: null } };
    if (call.url.startsWith("/api/training-load/sources/metrics/activations") && call.method === "GET") return { status: 200, body: { activations, nextCursor: null } };
    if (call.url === "/api/training-load/sources/metrics/activations" && call.method === "POST") return onActivate ? onActivate(call) : { status: 201, body: { activations: [{ id: "new" }] } };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "on" }, lastCheck, viewer: VIEWERS[viewer], teamImportSwitch: { enabled: true, mode: "team" }, approvalAvailable: true } };
    if (rest === "/source-athletes") return { status: 200, body: { athletes, units: {}, lastSeenRule: "" } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest === "/athlete-identities") return { status: 200, body: { identities: [], pendingCount: 0, retryLaterCount: 0, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [] } };
    if (rest === "/import-switch") return { status: 200, body: { enabled: true, mode: "team", configured: true } };
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
const html = () => renderTrainingLoadCoachHtml();
const posts = () => fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/metrics/activations"));
const open = async () => { await act("training-load-section", { section: "imports" }); await new Promise((r) => setTimeout(r, 30)); };
const guideHtml = () => html().match(/<section class="gpexe-guide[\s\S]*?<\/section>/)?.[0] || "";

test("1. guideSteps: states come from the facts, a failed read is never done, a coach gets one merged sentence", () => {
  const base = { admin: true, conn: { status: "ready", connected: true, bound: true, reconnect: false }, check: { status: "succeeded" }, candidates: [], sourceAthletes: [{ status: "linked" }], vars: { status: "ready", total: 0, onCount: 2 }, teamSwitch: { enabled: true } };
  const st = (f) => guideSteps(f).steps.map((s) => `${s.id}:${s.state}`).join(" ");
  assert.equal(st(base), "1:done 2:done 3:done 4:done 5:next");
  assert.equal(st({ ...base, candidates: [{ status: "imported" }] }), "1:done 2:done 3:done 4:done 5:done");
  assert.equal(guideSteps({ ...base, candidates: [{ status: "imported" }] }).allDone, true);
  assert.equal(st({ ...base, conn: { status: "ready", connected: false, bound: false, reconnect: true }, check: null, sourceAthletes: null }), "1:next 2:waiting 3:waiting 4:waiting 5:waiting");
  assert.match(st({ ...base, conn: { status: "error" } }), /^1:unknown 2:unknown/);
  assert.equal(guideSteps({ ...base, conn: { status: "error" } }).allDone, false);
  assert.equal(st({ ...base, sourceAthletes: [{ status: "unlinked" }, { status: "linked" }] }), "1:done 2:done 3:done 4:next 5:waiting");
  assert.equal(st({ ...base, sourceAthletesError: { status: 500 } }), "1:done 2:done 3:done 4:unknown 5:waiting");
  const coach = guideSteps({ admin: false, check: null, candidates: [], sourceAthletes: null });
  assert.deepEqual(coach.steps.map((s) => s.id), [1, 3, 4, 5]);
  assert.equal(coach.steps[0].merged, true);
  assert.equal(coach.steps.find((s) => s.id === 3).action, null, "a coach has no Find sessions button");
  assert.equal(coach.variables, null);
  assert.match(guideSteps({ ...base, teamSwitch: { enabled: false }, sourceAthletes: [{ status: "linked" }] }).steps[4].text, /switched off for this team/);
});

test("2. the administrator's guide offers exactly the active system rest_v1 variables that are not hidden and not already on", async () => {
  reset();
  await open();
  const g = guideHtml();
  assert.match(g, /Set up GPEXE imports/);
  assert.match(g, /3 OptiMove variables are not switched on/);
  await act("training-load-gpexe-guide-vars-open");
  const card = guideHtml();
  assert.match(card, /Switch on 3 OptiMove variables\?/);
  for (const n of [1, 2, 3]) assert.match(card, new RegExp(`Variable ${n} from Source ${n}`));
  for (const n of [4, 5, 6, 7, 8]) assert.ok(!card.includes(`Variable ${n} `), `variable ${n} is not offered`);
  assert.equal(posts().length, 0, "opening the card sends nothing");
});

test("3. the coach's guide reads nothing of connections, mappings or activations and offers no variables button", async () => {
  reset({ viewer: "coach" });
  await open();
  assert.ok(!fetchCalls.some((c) => /sources\/(gpexe\/connections|metrics)/.test(c.url)), "no administrator read");
  const g = guideHtml();
  assert.match(g, /Connect and approve/);
  assert.ok(!/Use OptiMove variables/.test(g));
  assert.ok(!/training-load-gpexe-check/.test(g), "step 3 has no button for a coach");
});

test("4. Switch on sends one POST per variable in mapping-id order, each with its own key, Required and the guide's reason; nothing repeats", async () => {
  reset();
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  const sent = posts();
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((c) => c.body.mappingId), MAPPINGS.slice(0, 3).map((m) => m.id));
  assert.equal(new Set(sent.map((c) => c.body.requestKey)).size, 3, "own key each");
  for (const c of sent) {
    assert.deepEqual(c.body.bindings, [{ bindingId: BINDING, requirement: "required" }]);
    assert.equal(c.body.reason, "Switched on from the setup guide");
    assert.deepEqual(Object.keys(c.body).sort(), ["bindings", "mappingId", "reason", "requestKey", "versionId"]);
  }
  assert.equal(state.trainingLoad.gpexe.guide.write.done, true);
});

test("5. it stops at the first refusal with the server's sentence; later variables are never sent; the earlier one stays on", async () => {
  reset({ onActivate: (call) => (call.body.mappingId === MAPPINGS[1].id ? { status: 409, body: { error: "field_already_active", message: "This team already gets this field." } } : { status: 201, body: { activations: [{}] } }) });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.equal(posts().length, 2, "the third was not sent");
  const g = guideHtml();
  assert.match(g, /Stopped/);
  assert.match(g, /Variable 2 from Source 2: This team already gets this field\. 1 variable before it is on\. The rest were not tried\./);
  assert.ok(!/1 variable is on/.test(g), "the count is said once");
});

test("6. a lost answer is Result not confirmed; Check result repeats the SAME key once, then goes on; nothing is resent by itself; leaving is guarded", async () => {
  let failSecondOnce = true;
  reset({ onActivate: (call) => {
    if (call.body.mappingId === MAPPINGS[1].id && failSecondOnce) { failSecondOnce = false; return { status: 502, body: "<html>" }; }
    return { status: 201, body: { activations: [{}] } };
  } });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.equal(posts().length, 2, "stopped at the lost answer");
  assert.match(guideHtml(), /Result not confirmed/);
  assert.equal(importsUnloadShouldWarn(), true, "leaving asks first");
  const lostKey = posts()[1].body.requestKey;
  await act("training-load-gpexe-guide-vars-send"); // a stale click while unconfirmed
  assert.equal(posts().length, 2, "no new write while unconfirmed");
  await act("training-load-gpexe-guide-vars-check");
  const after = posts();
  assert.equal(after[2].body.requestKey, lostKey, "the same key");
  assert.equal(after[2].body.mappingId, MAPPINGS[1].id);
  assert.equal(after.length, 4, "then the third variable with a new key");
  assert.notEqual(after[3].body.requestKey, lostKey);
  assert.equal(importsUnloadShouldWarn(), false);
});

test("7. an incomplete or failed read offers nothing; a connection that is not bound shows no variables button", async () => {
  reset({ activations: ACTIVATIONS });
  responder = async (call) => (call.url.includes("/metrics/activations") && call.method === "GET" ? { status: 500, body: { error: "internal_error" } } : server({})(call));
  await open();
  assert.match(guideHtml(), /Could not be checked/);
  assert.ok(!/training-load-gpexe-guide-vars-open/.test(guideHtml()));
  reset({ connections: () => ({ status: 200, body: { connections: [{ id: "conn-1", state: "verified", boundTeams: [] }] } }) });
  await open();
  assert.ok(!/training-load-gpexe-guide-vars-open/.test(guideHtml()), "not bound yet: no variables button");
  assert.ok(!fetchCalls.some((c) => c.url.includes("/metrics/mappings")), "no mapping read before a binding exists");
});

test("8. the guide folds when everything is done and Show setup reopens it; a variable name is escaped", async () => {
  reset({
    mappings: [mapping(1)], activations: [{ id: "a1", mappingId: mapping(1).id, versionId: mapping(1).activeVersionId, bindingId: BINDING }], lastCheck: { id: "chk", status: "succeeded" },
    athletes: [{ gpexeAthleteId: "9", status: "linked", link: { id: "l", athleteId: "a", athleteName: "A", linkedAt: "2026-09-10T10:00:00Z" }, lastSeen: null, values: {} }],
    candidates: [{ id: "c1", status: "imported", gpexeTeamSessionId: "1", sessionStartedAt: "2026-09-14T16:08:12Z", sessionLabel: "S", candidateStatus: "imported" }],
  });
  await open();
  assert.match(guideHtml(), /GPEXE setup is complete/);
  await act("training-load-gpexe-guide-toggle");
  assert.match(guideHtml(), /Set up GPEXE imports/);
  assert.match(guideHtml(), /Hide setup/);
  await act("training-load-gpexe-guide-toggle");
  assert.match(guideHtml(), /GPEXE setup is complete/);
  reset({ activations: [], mappings: [mapping(1, { target: { key: "t", label: "<img src=x onerror=1>" } })] });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  assert.ok(!guideHtml().includes("<img src=x"));
  assert.match(guideHtml(), /&lt;img src=x onerror=1&gt;/);
});

test("9. a list that never ends (more than ten pages) is an incomplete read: nothing is offered", async () => {
  reset();
  const base = responder;
  responder = async (call) => (call.url.startsWith("/api/training-load/sources/metrics/mappings") ? { status: 200, body: { mappings: [MAPPINGS[0]], nextCursor: "more" } } : base(call));
  await open();
  assert.match(guideHtml(), /Could not be checked/);
  assert.ok(!/training-load-gpexe-guide-vars-open/.test(guideHtml()));
  assert.equal(fetchCalls.filter((c) => c.url.startsWith("/api/training-load/sources/metrics/mappings")).length, 10, "the read is bounded");
});

test("10. the review cannot be opened again while a write is unconfirmed", async () => {
  reset({ onActivate: () => ({ status: 502, body: "<html>" }) });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.ok(state.trainingLoad.gpexe.guide.write.unknown);
  const before = JSON.stringify(state.trainingLoad.gpexe.guide.write);
  await act("training-load-gpexe-guide-vars-open");
  assert.equal(JSON.stringify(state.trainingLoad.gpexe.guide.write), before, "the unconfirmed result is kept");
});

test("11. after a fully successful run the card says so and offers Close - never the review again", async () => {
  reset();
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  const g = guideHtml();
  assert.match(g, /3 OptiMove variables are switched on\./);
  assert.ok(!/guide-vars-send/.test(g) && !/Switch on \d+ (OptiMove )?variables\?/.test(g), "no review card, no send button");
  assert.match(g, /guide-vars-close/);
  await act("training-load-gpexe-guide-vars-close");
  assert.ok(!/switched on\.<\/strong>/.test(guideHtml()));
});

test("12. a refused variable is not offered again; the others go on; it is listed with where to switch it on", async () => {
  reset({ onActivate: (call) => (call.body.mappingId === MAPPINGS[1].id ? { status: 409, body: { error: "variable_hidden", message: "The club hides this variable." } } : { status: 201, body: { activations: [{}] } }) });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.equal(posts().length, 2);
  await act("training-load-gpexe-guide-vars-close");
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  const ids = posts().map((c) => c.body.mappingId);
  assert.equal(ids.filter((id) => id === MAPPINGS[1].id).length, 1, "the refused one is never sent again");
  assert.ok(ids.includes(MAPPINGS[2].id), "the one after it is sent");
  assert.match(guideHtml(), /Variable 2 from Source 2/);
  assert.match(guideHtml(), /Data configuration > Mappings/);
});

test("13. a variable already on through another version of the same mapping is not offered", async () => {
  reset({ activations: [{ id: "x", mappingId: MAPPINGS[2].id, versionId: "99999999-0000-4000-8000-000000000009", bindingId: BINDING }, ...ACTIVATIONS] });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  assert.match(guideHtml(), /Switch on 2 OptiMove variables\?/);
  assert.ok(!guideHtml().includes("Variable 3 "));
});

test("14. a double click on Switch on sends each variable once; an empty offer sends nothing", async () => {
  reset();
  await open();
  await act("training-load-gpexe-guide-vars-open");
  const a = act("training-load-gpexe-guide-vars-send");
  const b = act("training-load-gpexe-guide-vars-send");
  await Promise.all([a, b]);
  assert.equal(posts().length, 3);
  reset({ mappings: [], activations: [] });
  await open();
  await act("training-load-gpexe-guide-vars-send");
  assert.equal(posts().length, 0);
});

test("15. the team cannot be changed while the switch-on runs or is unconfirmed (the marker survives)", async () => {
  reset({ onActivate: () => ({ status: 502, body: "<html>" }) });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.ok(state.trainingLoad.gpexe.guide.write.unknown);
  assert.match(html(), /aria-label="Team"[^>]*disabled|disabled[^>]*aria-label="Team"|gpexe-team-row/);
  await handleTrainingLoadAction({ dataset: { action: "training-load-gpexe-team" }, value: "other-team" }, { renderTrainingLoad: render });
  assert.ok(state.trainingLoad.gpexe.guide.write.unknown, "the unconfirmed marker is still there");
  assert.equal(String(state.trainingLoad.gpexe.teamId), TEAM);
});

test("16. a refusal that may follow a committed write (404) says so; an older read never overwrites a newer one", async () => {
  reset({ onActivate: () => ({ status: 404, body: { error: "notFound", message: "Not found." } }) });
  await open();
  await act("training-load-gpexe-guide-vars-open");
  await act("training-load-gpexe-guide-vars-send");
  assert.match(guideHtml(), /may have been switched on: check the Mappings screen/);
  const { loadGuideVariables } = await import("../gpexe-guide-data.js");
  reset();
  await open();
  const base = responder;
  const gates = [];
  responder = (call) => (call.url.startsWith("/api/training-load/sources/metrics/mappings")
    ? new Promise((resolve) => gates.push((mappings) => resolve({ status: 200, body: { mappings, nextCursor: null } })))
    : base(call));
  const first = loadGuideVariables(render);
  const second = loadGuideVariables(render);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(gates.length, 2);
  gates[1]([MAPPINGS[0]]);
  await second;
  gates[0](MAPPINGS.slice(0, 3));
  await first;
  assert.equal(state.trainingLoad.gpexe.guide.vars.items.length, 1, "the newest read wins");
});

test("17. guideSteps edge cases: a bound connection that needs reconnect, an empty athlete list, nothing to switch on", () => {
  const base = { admin: true, check: { status: "succeeded" }, candidates: [], sourceAthletes: [], teamSwitch: { enabled: true } };
  const st = (f) => guideSteps(f).steps.map((s) => `${s.id}:${s.state}`).join(" ");
  assert.match(st({ ...base, conn: { status: "ready", connected: false, bound: false, reconnect: true }, vars: { status: "ready", total: 0, onCount: 0 } }), /^1:next 2:waiting/);
  assert.match(st({ ...base, conn: { status: "ready", connected: true, bound: true }, vars: { status: "ready", total: 0, onCount: 0 } }), /4:waiting/);
  const none = guideSteps({ ...base, conn: { status: "ready", connected: true, bound: true }, vars: { status: "ready", total: 0, onCount: 0 } });
  assert.equal(none.variables.state, "none");
  assert.equal(none.allDone, false);
  const failed = guideSteps({ ...base, conn: { status: "error" }, vars: { status: "idle" } });
  assert.equal(failed.variables.state, "unknown");
  assert.equal(failed.steps[0].action.kind, "retry");
});
