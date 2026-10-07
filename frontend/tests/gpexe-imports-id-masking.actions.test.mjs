// GPEXE athlete ids on every administrator Imports screen (owner order
// 2026-10-07, after PR #144): outside an explicitly closed Technical details
// section an administrator sees a GPEXE name, "Name not loaded (GPEXE athlete
// N)" or "GPEXE athlete N" - never the GPEXE id, in no title, row, summary,
// button, confirmation, warning, error, aria-label or screen-reader text. A
// coach keeps the screen as it was and gets no identity and no sign that one
// exists. Driven through handleTrainingLoadAction with a fake fetch, like the
// other Imports suites. Every id below is a made-up marker that occurs nowhere
// else in the fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = false;
let confirmQuestions = [];
let selectValues = {};
globalThis.document = {
  querySelector: (sel) => {
    const m = sel.match(/data-gpexe-link-select='([^']+)'/);
    return m && selectValues[m[1]] !== undefined ? { value: selectValues[m[1]] } : null;
  },
  querySelectorAll: () => [],
  body: { classList: { contains: () => false } },
};
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };

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
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM = "aaaaaaaa-0000-4000-8000-000000000001";
// Marker ids: none of these strings occurs in any value, date or name of the fixtures.
const ID = { named: "77104", noName: "77105", notLoaded: "77106", suppressed: "77107", linked: "77101", relink: "77108", changed: "77109" };
const ALL_IDS = Object.values(ID);
const member = { teamId: TEAM, membershipType: "team", status: "active" };
const ORG = {
  teams: [{ id: TEAM, name: "First Team", club_name: "Club" }],
  clubs: [],
  athletes: [
    { id: "ath-1", name: "Ana Example", memberships: [member] },
    { id: "ath-2", name: "Bo Example", memberships: [member] },
    { id: "ath-3", name: "Cy Example", memberships: [member] },
  ],
};
const lastSeen = { candidateId: "cand-1", gpexeTeamSessionId: "7001", sessionStartedAt: "2026-09-14T16:08:12Z", sessionLabel: "FULL TRAINING", sessionType: "FULL TRAINING", candidateStatus: "pending", lastSeenAt: "2026-09-18T10:00:00Z", evidence: "preview", sessionDrillsCount: 2 };
const sa = (id, over = {}) => ({ gpexeAthleteId: id, status: "unlinked", link: null, lastSeen, values: { duration: 74, distance: 5230, maxSpeed: 29.5 }, ...over });
const SOURCE = [
  sa(ID.linked, { status: "linked", link: { id: "link-1", athleteId: "ath-1", athleteName: "Ana Example", linkedAt: "2026-09-10T10:00:00Z" } }),
  sa(ID.named), sa(ID.noName), sa(ID.notLoaded), sa(ID.suppressed), sa(ID.relink), sa(ID.changed),
];
// The stored identities (what the server returns for an administrator): 77104 named, 77105 without a name.
// 77106 has none (never loaded or expired), 77107 is inside its 24-hour suppression (a count only).
const IDENTITIES = {
  identities: [{ gpexeAthleteId: ID.named, name: "Mira Zedova", birthDate: "2001-02-03" }, { gpexeAthleteId: ID.noName, name: null, birthDate: null }],
  pendingCount: 1, retryLaterCount: 1, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [],
};
const NO_IDENTITIES = { identities: [], pendingCount: 6, retryLaterCount: 0, maxPerLoad: 50, retentionDays: 14, birthDateConflicts: [] };

function status(viewer) {
  return { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "on" }, lastCheck: null, viewer, approvalAvailable: true };
}
const VIEWERS = {
  coach: { canApprove: true, approvalBasis: "team_grant", isPlatformAdmin: false },
  "club admin": { canApprove: false, approvalBasis: null, isPlatformAdmin: false, identityAdmin: true },
  "platform admin": { canApprove: true, approvalBasis: "platform_admin", isPlatformAdmin: true, identityAdmin: true },
};

// A session review naming every kind of athlete: a linked one, an unlinked one (link controls), a blocked step
// that names a GPEXE athlete to relink, and a change to an imported result of an athlete without an OptiMove name.
function candidateDetail() {
  const values = [{ metricKey: "gpexe_total_distance", label: "TotDist", unit: "m", previous: null, value: 5230, change: "added" }];
  return {
    id: "cand-1", gpexeTeamSessionId: "7001", label: "FULL TRAINING 14.09.", sessionStartedAt: "2026-09-14T16:08:12Z",
    status: "pending", previewStatus: "ready", counts: { created: 1, athletesNotImported: 1 }, changesToImported: 1,
    snapshot: { available: true, expiresAt: "2026-10-14T00:00:00Z" }, approvalBlockers: [], blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [],
    previewHash: "a".repeat(64), approval: null,
    athletes: { "ath-1": { name: "Ana Example" }, "ath-2": { name: "Bo Example" }, "ath-3": { name: "Cy Example" } },
    preview: {
      version: 2, status: "ready",
      blocked: { code: "identities_missing_from_source", message: "server text", resolution: [{ action: "relink_athlete", gpexeAthleteId: ID.relink, previousAthleteId: "ath-2", step: "server step" }] },
      counts: { created: 1, changesToImported: 1 },
      changesToImported: [{ externalId: "x", level: "full", drillIndex: null, outcome: "corrected", athleteId: null, gpexeAthleteId: ID.changed, message: "A value changed.", values }],
      athletes: [
        { gpexeAthleteId: ID.linked, athleteId: "ath-1", participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: null, blocksSession: false, results: [{ externalId: "y", level: "full", drillIndex: null, outcome: "created", values }], skippedValues: [] },
        { gpexeAthleteId: ID.named, athleteId: null, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: { code: "athlete_not_linked", message: "This GPEXE athlete is not linked to an OptiMove athlete of the team." }, blocksSession: false, results: [{ externalId: "z", level: "full", drillIndex: null, outcome: "not_imported", values }], skippedValues: [] },
        { gpexeAthleteId: ID.notLoaded, athleteId: null, participation: { status: "recorded_by_gpexe" }, gps: { status: "measured", reason: null }, notImported: { code: "athlete_not_linked", message: "This GPEXE athlete is not linked to an OptiMove athlete of the team." }, blocksSession: false, results: [], skippedValues: [] },
      ],
      teamAthletesWithoutGpexeRecord: [
        { athleteId: "ath-2", participation: { status: "unknown" }, gps: { status: "no_record", reason: null } },
        { athleteId: "ath-3", participation: { status: "unknown" }, gps: { status: "no_record", reason: null } },
      ],
      anomalies: [],
    },
  };
}

function server({ viewer, identities = IDENTITIES, onLink }) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: status(viewer) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: SOURCE, units: {}, lastSeenRule: "" } };
    if (rest.startsWith("/candidates?") || rest === "/candidates") return { status: 200, body: { candidates: [] } };
    if (rest === "/candidates/cand-1") return { status: 200, body: { candidate: candidateDetail(), importSwitch: { enabled: true } } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [{ id: "link-1", gpexeAthleteId: ID.linked, athleteId: "ath-1", athleteName: "Ana Example" }] } };
    if (rest === "/athlete-links" && call.method === "POST") return onLink ? onLink(call) : { status: 201, body: { link: { id: "link-new" } } };
    if (rest === "/athlete-identities") return typeof identities === "function" ? identities(call) : { status: 200, body: identities };
    return { status: 404, body: { error: "notFound" } };
  };
}

const render = () => {};
function reset(viewer, opts = {}) {
  clearAllViewCache();
  state.currentUser = { id: "user-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  confirmAnswer = false;
  confirmQuestions = [];
  selectValues = {};
  fetchCalls = [];
  responder = server({ viewer, ...opts });
}
const act = (action, extra = {}, element = {}) => handleTrainingLoadAction({ dataset: { action, ...extra }, ...element }, { renderTrainingLoad: render });

// Everything a person or a screen reader gets outside Technical details: the text and every aria-label / title /
// alt / placeholder. Technical details are cut out first (the only place an id may appear).
const outsideTech = (html) => html.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");
function exposed(html) {
  const outside = outsideTech(html);
  const attrs = [...outside.matchAll(/\b(?:aria-label|aria-description|title|alt|placeholder)="([^"]*)"/g)].map((m) => m[1]);
  const text = outside.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/g, " ");
  return `${text}\n${attrs.join("\n")}`;
}
const insideTech = (html) => [...html.matchAll(/<details class="gpexe-tech">[\s\S]*?<\/details>/g)].map((m) => m[0]).join("\n");
function assertMasked(html, where, ids = ALL_IDS) {
  const out = exposed(html);
  for (const id of ids) assert.ok(!new RegExp(`\\b${id}\\b`).test(out), `${where}: GPEXE id ${id} is visible outside Technical details`);
}
function assertInTech(html, id, where) {
  assert.match(insideTech(html), new RegExp(`<dd>${id}</dd>`), `${where}: id ${id} is under Technical details`);
}

async function openImports() {
  await act("training-load-section", { section: "imports" });
}
async function openMapping() {
  await openImports();
  await act("training-load-gpexe-map-open");
}
async function openReview() {
  await openImports();
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
}
const pageHtml = () => renderTrainingLoadCoachHtml();

// ---------------------------------------------------------------------------
for (const role of ["club admin", "platform admin"]) {
  test(`${role}: the Imports page, Link athletes, the session review, the last link, confirmations, results, errors and the unlink question show no GPEXE id outside Technical details; a valid name, "Name provided"-less, not loaded, expired and suppressed athletes each have a label without the id`, async () => {
    reset(VIEWERS[role]);
    await openImports();
    let html = pageHtml();
    // The page's own linked list.
    assertMasked(html, `${role}: Imports page`);
    assert.match(outsideTech(html), /Name not loaded \(GPEXE athlete 1\)/, "the linked athlete without a stored identity, by its position");
    assert.ok(!/GPEXE: (GPEXE athlete|Name not)/.test(outsideTech(html)), "no doubled GPEXE wording");
    assertInTech(html, ID.linked, `${role}: Imports page linked list`);

    // Link athletes: rows, aria-labels, linked side.
    await act("training-load-gpexe-map-open");
    html = pageHtml();
    assertMasked(html, `${role}: Link athletes`);
    const visible = outsideTech(html);
    assert.match(visible, /<strong>Mira Zedova<\/strong>/, "a valid name");
    assert.match(visible, /<strong>Name not provided \(GPEXE athlete \d+\)<\/strong>/, "a stored identity without a name, with its place in the list");
    assert.match(visible, /<strong>Name not loaded \(GPEXE athlete 4\)<\/strong>/, "no stored identity (never loaded or expired)");
    assert.match(visible, /<strong>Name not loaded \(GPEXE athlete 5\)<\/strong>/, "inside its 24-hour suppression: no identity either");
    assert.match(visible, /1 athlete GPEXE had no record for is left out of loads for 24 hours/);
    for (const id of [ID.named, ID.noName, ID.notLoaded, ID.suppressed]) assertInTech(html, id, `${role}: Link athletes row`);
    const labels = [...outsideTech(html).matchAll(/aria-label="(Link the GPEXE athlete[^"]*)"/g)].map((m) => m[1]);
    assert.equal(new Set(labels).size, labels.length, "every select label is distinct");

    // A staged-choice error, the confirmation, the results.
    await act("training-load-gpexe-map-choose", { gpexeAthleteId: ID.notLoaded }, { value: "ath-2" });
    await act("training-load-gpexe-map-choose", { gpexeAthleteId: ID.named }, { value: "ath-2" });
    await act("training-load-gpexe-map-confirm");
    html = pageHtml();
    // Both rows are named, by their masked labels.
    assert.match(html, /chosen for (the GPEXE athlete [^.]+|GPEXE athlete \d+[^.]*) and (the GPEXE athlete [^.]+|GPEXE athlete \d+[^.]*)\. One athlete can be linked/);
    assertMasked(html, `${role}: staged-choice error`);
    // A choice that is not linkable any more (the athlete was linked meanwhile): its error names no id.
    const links = state.trainingLoad.gpexe.links;
    state.trainingLoad.gpexe.links = [...links, { id: "link-x", gpexeAthleteId: "70000", athleteId: "ath-2", athleteName: "Bo Example" }];
    await act("training-load-gpexe-map-confirm");
    html = pageHtml();
    assert.match(html, /is not linkable any more/);
    assertMasked(html, `${role}: not-linkable error`);
    state.trainingLoad.gpexe.links = links;
    await act("training-load-gpexe-map-choose", { gpexeAthleteId: ID.named }, { value: "ath-3" });
    await act("training-load-gpexe-map-confirm");
    html = pageHtml();
    assertMasked(html, `${role}: confirmation`);
    assertInTech(html, ID.notLoaded, `${role}: confirmation pair`);
    responder = server({ viewer: VIEWERS[role], onLink: (call) => (call.body.gpexeAthleteId === ID.named ? { status: 409, body: { error: "already_linked", message: "That GPEXE athlete or athlete is already linked." } } : { status: 502, body: "<html>" }) });
    await act("training-load-gpexe-map-send");
    html = pageHtml();
    assertMasked(html, `${role}: results (a refusal and a lost answer)`);
    assert.match(outsideTech(html), /not confirmed - the answer was lost/);
    await act("training-load-gpexe-map-done");
    await act("training-load-gpexe-map-close");

    // The unlink question (window.confirm) of the page's list.
    await act("training-load-gpexe-unlink", { linkId: "link-1" });
    const question = confirmQuestions.at(-1);
    assert.ok(question && !ALL_IDS.some((id) => question.includes(id)), `${role}: unlink question: ${question}`);

    // The session review: athlete rows, the link context, the link controls, a blocked step, a changed result.
    responder = server({ viewer: VIEWERS[role] });
    await act("training-load-gpexe-open", { candidateId: "cand-1" });
    html = pageHtml();
    assertMasked(html, `${role}: session review`);
    assert.match(outsideTech(html), /Link GPEXE athlete 6 \(name not loaded\) again to Bo Example/, "the blocked step names the athlete without its id");
    for (const id of [ID.named, ID.notLoaded]) assertInTech(html, id, `${role}: session review athlete`);
    assertInTech(html, ID.changed, `${role}: changed result`);
    assert.match(outsideTech(html), /Find the GPEXE athlete Mira Zedova in GPEXE first/, "the find sentence names the athlete by its GPEXE name");
    assert.match(outsideTech(html), /<span>Link GPEXE athlete 4 \(name not loaded\) to<\/span>/, "the select label");
    // With every team athlete already linked, the sentence that replaces the controls names no id either.
    const keep = state.trainingLoad.gpexe.detail.candidate.preview.teamAthletesWithoutGpexeRecord;
    state.trainingLoad.gpexe.detail.candidate.preview.teamAthletesWithoutGpexeRecord = [];
    const allLinked = pageHtml();
    assert.match(allLinked, /Every athlete of the team without a GPEXE record here is already linked/);
    assertMasked(allLinked, `${role}: every athlete already linked`);
    state.trainingLoad.gpexe.detail.candidate.preview.teamAthletesWithoutGpexeRecord = keep;
    // A link error (no athlete chosen), then the confirmation, then the last-link notice.
    await act("training-load-gpexe-link", { gpexeAthleteId: ID.notLoaded });
    html = pageHtml();
    assert.match(html, /Choose the team athlete first\./);
    assertMasked(html, `${role}: review link error`);
    selectValues[ID.notLoaded] = "ath-2";
    await act("training-load-gpexe-link", { gpexeAthleteId: ID.notLoaded });
    html = pageHtml();
    assert.match(outsideTech(html), /Confirm link/);
    assertMasked(html, `${role}: review link confirmation`);
    assertInTech(html, ID.notLoaded, `${role}: review link confirmation`);
    await act("training-load-gpexe-link-confirm");
    await act("training-load-gpexe-close");
    html = pageHtml();
    assert.match(outsideTech(html), /is now linked to Bo Example/);
    assertMasked(html, `${role}: last-link notice`);
  });
}

test("no stored identity at all (none loaded, or the team has no binding): an administrator sees stable, distinct 'GPEXE athlete N' labels for the list on screen, never the id; the same with the identity read refused (404)", async () => {
  for (const identities of [NO_IDENTITIES, () => ({ status: 404, body: { error: "notFound" } })]) {
    reset(VIEWERS["club admin"], { identities });
    await openMapping();
    const html = pageHtml();
    assertMasked(html, "no identity");
    const strong = [...outsideTech(html).matchAll(/<li class="gpexe-map-row is-unlinked">[\s\S]*?<strong>([^<]*)<\/strong>/g)].map((m) => m[1]);
    assert.deepEqual(strong, ["GPEXE athlete 2", "GPEXE athlete 3", "GPEXE athlete 4", "GPEXE athlete 5", "GPEXE athlete 6", "GPEXE athlete 7"], "distinct positions of the list on screen");
    assert.ok(!/Name not loaded/.test(outsideTech(html)), "no snapshot: no 'Name not loaded'");
  }
});

test("a coach keeps the screens as before: the GPEXE ids stay in the text, no identity is ever requested, and nothing signals that a snapshot exists", async () => {
  reset(VIEWERS.coach);
  await openMapping();
  const html = pageHtml();
  assert.equal(fetchCalls.filter((c) => c.url.includes("/athlete-identities")).length, 0, "no identity request");
  assert.match(outsideTech(html), new RegExp(`<strong>GPEXE athlete ${ID.named}</strong>`));
  assert.ok(!/Name not loaded|Name not provided|GPEXE names and dates of birth|retry|24 hours/.test(html), "no sign of an identity or a snapshot");
  await act("training-load-gpexe-map-close");
  await act("training-load-gpexe-open", { candidateId: "cand-1" });
  const review = pageHtml();
  assert.match(outsideTech(review), new RegExp(`Find athlete ${ID.named} in GPEXE first`));
});

// ---------------------------------------------------------------------------
// The lifetime of the names in memory (code-reviewer M1 / security MEDIUM on 8bc6921).
const { confirmLeaveTrainingLoad, discardTrainingLoadLeaveDrafts } = await import("../training-load-actions.js");
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const identityList = () => state.trainingLoad.gpexe.identity.list;

test("leaving Training Load through the main navigation drops the GPEXE names, both through the leave check and the discard path", async () => {
  for (const leave of [() => confirmLeaveTrainingLoad("athletes"), () => discardTrainingLoadLeaveDrafts()]) {
    reset(VIEWERS["club admin"]);
    state.activeTab = "training-load";
    await openMapping();
    assert.ok(identityList()?.byId?.[ID.named], "the names are held while the Imports view is open");
    leave();
    assert.equal(identityList(), null, "no name stays in memory after leaving Training Load");
  }
  // Staying in Training Load (the same tab) keeps them.
  reset(VIEWERS["club admin"]);
  state.activeTab = "training-load";
  await openMapping();
  confirmLeaveTrainingLoad("training-load");
  assert.ok(identityList()?.byId?.[ID.named]);
});

test("an identity read still in flight when the administrator leaves Imports never brings the names back", async () => {
  const gate = deferred();
  reset(VIEWERS["club admin"], { identities: async () => { await gate.promise; return { status: 200, body: IDENTITIES }; } });
  const opening = openImports();
  await new Promise((r) => setImmediate(r));
  await act("training-load-section", { section: "today" });
  gate.resolve();
  await opening;
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(identityList(), null, "the late answer is dropped");
  assert.ok(!/Mira Zedova/.test(pageHtml()));
});

test("leaving Imports while a name load is in flight keeps its key: a lost answer is 'not confirmed' with the same requestKey, the names are not read back, and Check result repeats that key", async () => {
  const gate = deferred();
  const keys = [];
  reset(VIEWERS["club admin"]);
  const base = responder;
  responder = async (call) => {
    if (call.url.endsWith("/athlete-identities/loads")) {
      keys.push(call.body.requestKey);
      if (keys.length === 1) { await gate.promise; return { status: 502, body: "<html>" }; }
      return { status: 200, body: { loaded: 1, notFound: 0, notRead: 0, replayed: true } };
    }
    return base(call);
  };
  await openMapping();
  await act("training-load-gpexe-identity-open");
  const sending = act("training-load-gpexe-identity-send");
  await new Promise((r) => setImmediate(r));
  const key = state.trainingLoad.gpexe.identity.requestKey;
  assert.ok(key && state.trainingLoad.gpexe.identity.sending);
  await act("training-load-section", { section: "today" });
  assert.equal(identityList(), null, "the names go at once");
  assert.equal(state.trainingLoad.gpexe.identity.requestKey, key, "the key of the load in flight stays");
  const reads = fetchCalls.filter((c) => c.url.endsWith("/athlete-identities")).length;
  gate.resolve();
  await sending;
  const identity = state.trainingLoad.gpexe.identity;
  assert.equal(identity.list, null, "a late outcome brings no name back");
  assert.ok(identity.unconfirmed, "a lost answer is not confirmed");
  assert.equal(identity.requestKey, key, "with the same key");
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-identities")).length, reads, "no names read after leaving");
  // Back on Imports: the marker is still there, and Check result sends the same key.
  await openMapping();
  assert.ok(state.trainingLoad.gpexe.identity.unconfirmed, "the marker survives the return");
  await act("training-load-gpexe-identity-check");
  assert.deepEqual(keys, [key, key], "Check result repeats the same requestKey; never a new load");
});

test("with the source-athletes read refused, the review's unlinked athletes stay distinct and show no id", async () => {
  reset(VIEWERS["club admin"], { identities: NO_IDENTITIES });
  const base = responder;
  responder = async (call) => (call.url.endsWith("/source-athletes") ? { status: 500, body: { error: "internal_error" } } : base(call));
  await openReview();
  const html = pageHtml();
  assertMasked(html, "review without the source-athletes list");
  const names = [...outsideTech(html).matchAll(/<summary[^>]*>[\s\S]*?<strong>([^<]*)<\/strong>/g)].map((m) => m[1]).filter((n) => /GPEXE athlete/.test(n));
  assert.ok(names.length >= 2, `two unlinked athletes are named: ${names.join(" | ")}`);
  assert.equal(new Set(names).size, names.length, "never one shared label");
  assert.ok(names.every((n) => /^GPEXE athlete \d+$/.test(n)), "a number, never a bare 'GPEXE athlete'");
});

test("a status without the identity right (a role revoked meanwhile) drops the names the view held; identityOf answers nothing for such a viewer", async () => {
  reset(VIEWERS["club admin"]);
  await openMapping();
  assert.ok(identityList()?.byId?.[ID.named]);
  await act("training-load-gpexe-map-close");
  responder = server({ viewer: VIEWERS.coach });
  const { loadGpexeTeam } = await import("../gpexe-import-data.js");
  await loadGpexeTeam(render);
  assert.equal(identityList(), null, "nothing of the identity stays");
  const { identityOf } = await import("../gpexe-import-data.js");
  state.trainingLoad.gpexe.identity = { ...state.trainingLoad.gpexe.identity, available: true, list: { byId: { [ID.named]: { name: "Mira Zedova", birthDate: null } } } };
  assert.equal(identityOf(ID.named), null, "never for a viewer without the right, whatever the state holds");
});

test("a name load that succeeds after the administrator left Imports records its counts but reads no name back", async () => {
  const gate = deferred();
  reset(VIEWERS["club admin"]);
  const base = responder;
  responder = async (call) => {
    if (call.url.endsWith("/athlete-identities/loads")) { await gate.promise; return { status: 200, body: { loaded: 1, notFound: 0, notRead: 0 } }; }
    return base(call);
  };
  await openMapping();
  await act("training-load-gpexe-identity-open");
  const sending = act("training-load-gpexe-identity-send");
  await new Promise((r) => setImmediate(r));
  await act("training-load-section", { section: "today" });
  const reads = fetchCalls.filter((c) => c.url.endsWith("/athlete-identities")).length;
  gate.resolve();
  await sending;
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  const identity = state.trainingLoad.gpexe.identity;
  assert.equal(identity.list, null, "no name comes back into memory");
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-identities")).length, reads, "no identity read after leaving");
  assert.equal(identity.requestKey, null, "the load is settled: its key is done");
  assert.equal(identity.unconfirmed, null);
});
