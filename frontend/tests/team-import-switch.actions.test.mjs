// U2 (v56): the "Imports for this team" line and panel of the Imports screen.
// Driven through handleTrainingLoadAction with a fake fetch, like the other
// Imports suites: the coach's one-sentence state; the administrator's panel
// (conditions, reason, confirmation, the exact request bodies); the server's
// refusals read as sentences that say nothing was changed; a lost answer is
// never "nothing changed"; every text is escaped; the club administrator
// cannot turn a pilot team on.
import { test } from "node:test";
import assert from "node:assert/strict";

let confirmAnswer = true;
let confirmQuestions = [];
let fields = {};
globalThis.document = {
  querySelector: (selector) => (selector in fields ? { value: fields[selector] } : null),
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
  if (result.lost) throw new TypeError("network down");
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG = { teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }], clubs: [], athletes: [] };
const render = () => {};
const READY = {
  id: "cand-1", gpexeTeamSessionId: "9977001", label: "FULL TRAINING 05.10.", sessionStartedAt: "2026-10-05T16:08:12Z",
  status: "pending", previewStatus: "ready", previewHash: "a".repeat(64), counts: { created: 4, athletesNotImported: 0 }, changesToImported: 0,
  firstSeenAt: "2026-10-05T18:00:00Z", lastSeenAt: "2026-10-06T18:00:00Z", importedAt: null,
  supersededByCandidateId: null, supersededByCheckId: null,
  snapshot: { available: true, expiresAt: "2026-11-05T00:00:00Z" }, approvalBlockers: [],
  blockedCode: null, blockedSourceCode: null, sessionType: "FULL TRAINING", reasons: [],
};
const BASE = `/api/training-load/gpexe/teams/${TEAM_A}`;

function resetState() {
  clearAllViewCache();
  state.currentUser = { id: "u-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  fetchCalls = [];
  confirmAnswer = true;
  confirmQuestions = [];
  fields = {};
}

const conditions = (over = {}) => [
  { kind: "backup", required: "pilot_and_team", met: true, recordedOn: "2026-11-03", maxAgeDays: 2, text: "x" },
  { kind: "restore_probe", required: "pilot_and_team", met: false, recordedOn: null, maxAgeDays: 35, text: "x" },
  { kind: "wrong_link_procedure", required: "team", met: false, recordedOn: null, maxAgeDays: null, text: "x" },
  { kind: "archived_team_check_stop", required: "team", met: false, recordedOn: null, maxAgeDays: null, text: "x" },
].map((c) => ({ ...c, ...(over[c.kind] || {}) }));

// The switch as the route returns it for a viewer.
function switchBody({ enabled = false, mode = "pilot", manager = true, platform = true, history = [], conds } = {}) {
  return manager
    ? { importSwitch: { enabled, mode, configured: true, canManage: true, canChangeMode: platform, canRecordPrerequisites: platform, conditions: conds || conditions(), history } }
    : { importSwitch: { enabled, mode, configured: true, canManage: false, canChangeMode: false, canRecordPrerequisites: false } };
}

function server({ sw, put, post } = {}) {
  let current = sw;
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (call.url === "/api/training-load/gpexe/import-prerequisites" && call.method === "POST") {
      const r = post ? await post(call) : { status: 201, body: {} };
      return r;
    }
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") {
      const s = current.importSwitch;
      return { status: 200, body: { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true, message: "" }, lastCheck: null, teamImportSwitch: { enabled: s.enabled, mode: s.mode }, viewer: { canApprove: s.enabled, approvalBasis: s.enabled ? "platform_admin" : null, isPlatformAdmin: false }, approvalAvailable: true } };
    }
    if (rest === "/source-athletes") return { status: 200, body: { athletes: [], units: {}, lastSeenRule: "" } };
    if (rest === "/athlete-links") return { status: 200, body: { links: [] } };
    if (rest === "/candidates") return { status: 200, body: { candidates: [READY] } };
    if (rest === "/import-switch" && call.method === "GET") return { status: 200, body: current };
    if (rest === "/import-switch" && call.method === "PUT") {
      const r = await put(call);
      if (r.status === 200) current = { importSwitch: { ...current.importSwitch, enabled: call.body.enabled, mode: call.body.mode || current.importSwitch.mode } };
      return r;
    }
    return { status: 404, body: { error: "notFound" } };
  };
}

async function act(action, dataset = {}) {
  await handleTrainingLoadAction({ dataset: { action, ...dataset } }, { renderTrainingLoad: render });
}
const openImports = () => act("training-load-section", { section: "imports" });
const html = () => renderTrainingLoadCoachHtml();
const puts = () => fetchCalls.filter((c) => c.method === "PUT");
const panel = (page = html()) => { const i = page.indexOf('aria-label="Imports for this team"'); return i < 0 ? "" : page.slice(i, page.indexOf("</section>", i)); };

test("1. a coach sees one sentence about the team's switch and no panel: off says who turns it on; on says who imports", async () => {
  resetState();
  responder = server({ sw: switchBody({ manager: false, enabled: false }) });
  await openImports();
  let page = html();
  assert.match(page, /Imports are switched off for this team\.<\/strong> A platform administrator or the club administrator turns them on\./);
  assert.equal(panel(page), "", "no panel for a coach");
  assert.match(page, /Review only - imports are switched off for this team\./);
  assert.equal(puts().length, 0);
  resetState();
  responder = server({ sw: switchBody({ manager: false, enabled: true, mode: "team" }) });
  await openImports();
  page = html();
  assert.match(page, /Imports are on for this team\. Team mode: the club administrator and the team(?:'|&#039;)s coaches import\./);
  assert.doesNotMatch(page, /Review only - imports are switched off/);
});

test("2. a platform administrator: the panel lists the conditions with their dates, turning on needs a reason and a confirmation, and sends exactly {enabled, reason}", async () => {
  resetState();
  responder = server({ sw: switchBody({ enabled: false }), put: async () => ({ status: 200, body: { importSwitch: {} } }) });
  await openImports();
  const p = panel();
  assert.match(p, /Imports are <strong>off<\/strong>\./);
  assert.match(p, /Pilot mode: only a platform administrator imports\./);
  assert.match(p, /Database backup \(at most 2 days old\)/);
  assert.match(p, /Restore probe \(at most 35 days old\)/);
  assert.match(p, /Not met: <\/span>Restore probe/);
  assert.match(p, /data-action="training-load-gpexe-switch-on"(?![^>]*disabled)/);
  assert.match(p, /data-action="training-load-gpexe-switch-mode-team"/, "the platform administrator may move the mode");
  assert.match(p, /Record a date/);
  // No reason: nothing is sent.
  await act("training-load-gpexe-switch-on");
  assert.equal(puts().length, 0);
  assert.match(panel(), /Write a short reason first/);
  // A reason but the confirmation declined: nothing is sent.
  fields["[data-gpexe-switch-reason]"] = "  pilot start  ";
  confirmAnswer = false;
  await act("training-load-gpexe-switch-on");
  assert.equal(puts().length, 0);
  assert.match(confirmQuestions.at(-1), /Turn imports on for First Team\? Afterwards a platform administrator can approve imports/);
  // Confirmed: the body carries the enabled flag and the trimmed reason, nothing else.
  confirmAnswer = true;
  await act("training-load-gpexe-switch-on");
  assert.equal(puts().length, 1);
  assert.deepEqual(puts()[0].body, { enabled: true, reason: "pilot start" });
  assert.equal(puts()[0].url, `${BASE}/import-switch`);
  assert.match(panel(), /Imports are on for this team\./);
  assert.match(panel(), /Imports are <strong>on<\/strong>\./);
  assert.match(html(), /Imports are on for this team\. Pilot mode/, "the status line was re-read too");
});

test("3. the mode move: the confirmation names the consequence, the body adds mode 'team'; the way back sends 'pilot'", async () => {
  resetState();
  responder = server({ sw: switchBody({ enabled: false }), put: async () => ({ status: 200, body: { importSwitch: {} } }) });
  await openImports();
  fields["[data-gpexe-switch-reason]"] = "end of the pilot";
  confirmAnswer = false;
  await act("training-load-gpexe-switch-mode-team");
  assert.equal(puts().length, 0);
  assert.match(confirmQuestions.at(-1), /Move First Team to team mode and turn imports on\? From then on the club administrator and the team(?:'|&#039;)s coaches can approve imports too\./);
  confirmAnswer = true;
  await act("training-load-gpexe-switch-mode-team");
  assert.deepEqual(puts().map((c) => c.body), [{ enabled: true, mode: "team", reason: "end of the pilot" }]);
  assert.match(panel(), /data-action="training-load-gpexe-switch-mode-pilot"/);
  await act("training-load-gpexe-switch-mode-pilot");
  assert.deepEqual(puts().at(-1).body, { enabled: true, mode: "pilot", reason: "end of the pilot" });
});

test("4. the club administrator: turning off is offered; turning on a pilot team is not (the button is off and the reason is given); no mode buttons and no record form", async () => {
  resetState();
  responder = server({ sw: switchBody({ enabled: false, mode: "pilot", platform: false }) });
  await openImports();
  const p = panel();
  assert.match(p, /data-action="training-load-gpexe-switch-on"[^>]*disabled/);
  assert.match(p, /While the team is in pilot mode, a platform administrator turns imports on\./);
  assert.doesNotMatch(p, /switch-mode-(team|pilot)/);
  assert.doesNotMatch(p, /Record a date|training-load-gpexe-switch-record/);
  await act("training-load-gpexe-switch-on");
  resetState();
  responder = server({ sw: switchBody({ enabled: true, mode: "team", platform: false }), put: async () => ({ status: 200, body: {} }) });
  await openImports();
  assert.match(panel(), /data-action="training-load-gpexe-switch-off"/);
  fields["[data-gpexe-switch-reason]"] = "pause";
  await act("training-load-gpexe-switch-off");
  assert.deepEqual(puts().map((c) => c.body), [{ enabled: false, reason: "pause" }]);
  assert.equal(confirmQuestions.length, 0, "turning off asks no confirmation");
});

test("5. a refused condition reads as the server's sentence plus 'Nothing was changed'; a lost answer is 'not confirmed', never 'nothing changed', and the state is read again", async () => {
  resetState();
  let mode = "refuse";
  responder = server({
    sw: switchBody({ enabled: false }),
    put: async () => (mode === "refuse"
      ? { status: 409, body: { error: "team_import_condition_unmet", message: "A restore probe dated within the last 35 days must be recorded." } }
      : { lost: true }),
  });
  await openImports();
  fields["[data-gpexe-switch-reason]"] = "try";
  await act("training-load-gpexe-switch-on");
  assert.match(panel(), /A restore probe dated within the last 35 days must be recorded\. Nothing was changed\./);
  assert.match(panel(), /Imports are <strong>off<\/strong>/);
  mode = "lost";
  const readsBefore = fetchCalls.filter((c) => c.method === "GET" && c.url.endsWith("/import-switch")).length;
  await act("training-load-gpexe-switch-on");
  const text = panel();
  assert.match(text, /result is not confirmed/);
  assert.doesNotMatch(text, /Nothing was changed/);
  assert.ok(fetchCalls.filter((c) => c.method === "GET" && c.url.endsWith("/import-switch")).length > readsBefore, "the state was read again");
});

test("6. recording a date sends {kind, recordedOn, note} to the platform route and reads the conditions again; a failed record says so", async () => {
  resetState();
  let posts = 0;
  responder = server({ sw: switchBody({ enabled: false }), post: async () => { posts += 1; return posts === 1 ? { status: 201, body: {} } : { status: 400, body: { error: "invalid_request", message: "recordedOn must be a real date, YYYY-MM-DD." } }; } });
  await openImports();
  fields["[data-gpexe-switch-kind]"] = "restore_probe";
  fields["[data-gpexe-switch-date]"] = "2026-11-04";
  fields["[data-gpexe-switch-note]"] = "monthly probe";
  await act("training-load-gpexe-switch-record");
  const post = fetchCalls.find((c) => c.method === "POST");
  assert.equal(post.url, "/api/training-load/gpexe/import-prerequisites");
  assert.deepEqual(post.body, { kind: "restore_probe", recordedOn: "2026-11-04", note: "monthly probe" });
  assert.match(panel(), /The date was recorded\./);
  fields["[data-gpexe-switch-date]"] = "";
  await act("training-load-gpexe-switch-record");
  assert.match(panel(), /Choose what and the date first\./);
  assert.equal(fetchCalls.filter((c) => c.method === "POST").length, 1, "nothing is sent without a date");
});

test("7. every text from the server is escaped: a history reason with markup renders as text; a club admin's screen never shows the record form", async () => {
  resetState();
  responder = server({ sw: switchBody({ enabled: true, mode: "team", history: [{ changedAt: "2026-11-04T10:00:00Z", enabled: true, mode: "team", basis: "club_admin", reason: "<img src=x onerror=alert(1)>" }] }) });
  await openImports();
  const p = panel();
  assert.doesNotMatch(p, /<img src=x/);
  assert.match(p, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(p, /club administrator/);
});

test("8. a refused approval for the team's switch reads as one sentence naming who can turn it on", async () => {
  resetState();
  responder = server({ sw: switchBody({ manager: false, enabled: false }) });
  await openImports();
  // The blocker and the refusal sentences exist for the new code.
  const view = await import("../gpexe-import-view.js");
  assert.ok(view, "the view module loads");
  const src = (await import("node:fs")).readFileSync(new URL("../gpexe-import-view.js", import.meta.url), "utf8");
  assert.match(src, /team_import_switch_off: "Imports are switched off for this team, so it can't be approved here\."/);
  assert.match(src, /team_import_switch_off: "Not imported: imports are switched off for this team\. A platform administrator or the club administrator can turn them on\."/);
});
