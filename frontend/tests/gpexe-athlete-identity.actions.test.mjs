// GPEXE athlete names and dates of birth on the Link athletes screen
// (administrators only, owner order 2026-10-06), driven through
// handleTrainingLoadAction with a fake fetch like the other Imports suites.
// It proves what the screen sends (one POST with { requestKey } and nothing
// else, no request at all for a coach), how each answer is shown (counts
// only; a lost answer is "Result not confirmed" with Check result, never
// resent by itself), the warnings (a duplicate name, a date-of-birth
// conflict), the locks against the other writes, and that the identity lives
// only in memory and goes when the screen, the team or the workspace changes.
// Every name below is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let confirmAnswer = true;
let confirmQuestions = [];
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
// Any browser storage the screen touched would fail the suite.
const storageTrap = new Proxy({}, { get(_, key) { throw new Error(`browser storage touched: ${String(key)}`); } });
globalThis.window = { confirm: (q) => { confirmQuestions.push(q); return confirmAnswer; }, matchMedia: () => ({ matches: false }) };
for (const name of ["localStorage", "sessionStorage", "indexedDB", "caches"]) {
  Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`browser storage touched: ${name}`); } });
  Object.defineProperty(globalThis.window, name, { configurable: true, get() { throw new Error(`browser storage touched: window.${name}`); } });
}
void storageTrap;

let fetchCalls;
let responder;
globalThis.fetch = async (url, options = {}) => {
  const call = { url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined, cache: options.cache, signal: options.signal };
  fetchCalls.push(call);
  const result = await responder(call);
  if (result === "throw") throw new TypeError("network down");
  return { ok: result.status < 300, status: result.status, statusText: "", json: async () => result.body };
};

const { handleTrainingLoadAction, resetTrainingLoadForWorkspaceChange } = await import("../training-load-actions.js");
const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
const { emptyTrainingLoadState, state } = await import("../state.js");
const { clearAllViewCache } = await import("../view-cache.js");
const { setGpexePollDelayForTests } = await import("../gpexe-import-data.js");
setGpexePollDelayForTests(() => Promise.resolve());

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";
const member = (teamId) => ({ teamId, membershipType: "team", status: "active" });
const ORG = {
  teams: [{ id: TEAM_A, name: "First Team", club_name: "Club" }, { id: TEAM_B, name: "U19", club_name: "Club" }],
  clubs: [],
  athletes: [
    { id: "ath-1", name: "Ana Example", memberships: [member(TEAM_A)] },
    { id: "ath-2", name: "Bo Example", memberships: [member(TEAM_A)] },
  ],
};
const lastSeen = { candidateId: "cand-1", gpexeTeamSessionId: "7001", sessionStartedAt: "2026-09-14T16:08:12Z", sessionLabel: "FULL TRAINING", sessionType: "FULL TRAINING", candidateStatus: "pending", lastSeenAt: "2026-09-18T10:00:00Z", evidence: "preview", sessionDrillsCount: 2 };
const sa = (id, over = {}) => ({ gpexeAthleteId: id, status: "unlinked", link: null, lastSeen, values: { duration: 74, distance: 5230, maxSpeed: 29.5 }, ...over });
const SOURCE = [sa("104"), sa("105"), sa("106"), sa("107")];
const IDENTITIES = {
  identities: [
    { gpexeAthleteId: "104", name: "Mira Zedova", birthDate: "2001-02-03" },
    { gpexeAthleteId: "105", name: "Mira Zedova", birthDate: null },
    { gpexeAthleteId: "106", name: null, birthDate: "1999-12-31" },
  ],
  pendingCount: 1, maxPerLoad: 50, retentionDays: 14,
  birthDateConflicts: [{ gpexeAthleteId: "104", athleteId: "ath-1" }],
};
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function status(identityAdmin) {
  return {
    settings: { gpexeTeamId: "980" },
    importSwitch: { enabled: false, message: "Import writing is switched off in this environment." },
    lastCheck: null,
    viewer: { canApprove: identityAdmin, approvalBasis: identityAdmin ? "platform_admin" : null, isPlatformAdmin: identityAdmin, ...(identityAdmin ? { identityAdmin: true } : {}) },
    approvalAvailable: true,
  };
}

function server({ admin = true, identities = IDENTITIES, onLoad = () => ({ status: 200, body: { requestKey: "k", outcome: "completed", loaded: 1, notFound: 0, notRead: 0, stopCode: null, unrecognisedBirthDates: 0, retentionDays: 14, replayed: false } }), onLink } = {}) {
  return async (call) => {
    if (call.url === "/api/organization") return { status: 200, body: ORG };
    const m = call.url.match(/^\/api\/training-load\/gpexe\/teams\/([^/]+)(\/.*)$/);
    if (!m) return { status: 404, body: { error: "notFound" } };
    const rest = m[2];
    if (rest === "/status") return { status: 200, body: status(admin) };
    if (rest === "/source-athletes") return { status: 200, body: { athletes: SOURCE, units: {}, lastSeenRule: "" } };
    if (rest.startsWith("/candidates")) return { status: 200, body: { candidates: [] } };
    if (rest === "/athlete-links" && call.method === "GET") return { status: 200, body: { links: [] } };
    if (rest === "/athlete-links" && call.method === "POST") return onLink ? onLink(call) : { status: 201, body: { link: { id: "link-new" } } };
    if (rest === "/athlete-identities") return typeof identities === "function" ? identities(call) : { status: 200, body: identities };
    if (rest === "/athlete-identities/loads") return onLoad(call);
    return { status: 404, body: { error: "notFound" } };
  };
}

let renders = 0;
const render = () => { renders += 1; };
function reset(workspace = { type: "club", scopeId: "club-1" }) {
  clearAllViewCache();
  state.currentUser = { id: "user-1", activeWorkspace: workspace };
  state.trainingLoad = emptyTrainingLoadState();
  confirmAnswer = true;
  confirmQuestions = [];
  fetchCalls = [];
}
const act = (action, extra = {}, element = {}) => handleTrainingLoadAction({ dataset: { action, ...extra }, ...element }, { renderTrainingLoad: render });
async function openMapping() {
  await act("training-load-section", { section: "imports" });
  await act("training-load-gpexe-map-open");
}
function mappingHtml() {
  const html = renderTrainingLoadCoachHtml();
  const start = html.indexOf('class="panel builder-athlete-picker gpexe-detail gpexe-map"');
  assert.ok(start > 0, "the Link athletes screen is open");
  return html.slice(start);
}
const identityCalls = () => fetchCalls.filter((c) => c.url.includes("/athlete-identities"));
const loadPosts = () => fetchCalls.filter((c) => c.url.endsWith("/athlete-identities/loads"));
const outsideTech = (html) => html.replace(/<details class="gpexe-tech">[\s\S]*?<\/details>/g, "");

// ---------------------------------------------------------------------------
test("a coach: the screen never asks for an identity (no request), shows no name panel, and keeps the GPEXE ids as before", async () => {
  reset({ type: "team", scopeId: TEAM_A });
  responder = server({ admin: false });
  await openMapping();
  assert.equal(identityCalls().length, 0, "no identity request for a coach");
  const html = mappingHtml();
  assert.ok(!/GPEXE names and dates of birth|Load GPEXE names|Born /.test(html));
  assert.match(html, /<strong>GPEXE athlete 104<\/strong>/);
});

test("an administrator: opening the screen reads the stored identities (no-store, no GPEXE request); a loaded row shows the GPEXE name and 'Born DD.MM.YYYY' with the id only under Technical details; 'Name not provided' and 'Date of birth not provided'; a row without an identity keeps its id", async () => {
  reset();
  responder = server();
  await openMapping();
  // The Imports view reads them for an administrator, and opening Link athletes reads them again.
  assert.equal(identityCalls().length, 2, "exactly two reads: with the Imports team, and when Link athletes opens");
  assert.ok(identityCalls().every((c) => c.method === "GET" && c.cache === "no-store"));
  const html = mappingHtml();
  const visible = outsideTech(html);
  // A GPEXE name shared by two athletes carries each one's place in the list.
  const first = visible.match(/<strong>Mira Zedova \(GPEXE athlete (\d+)\)<\/strong>\s*<span class="gpexe-map-born">Born 03\.02\.2001<\/span>/);
  const second = visible.match(/<strong>Mira Zedova \(GPEXE athlete (\d+)\)<\/strong>\s*<span class="gpexe-map-born">Date of birth not provided<\/span>/);
  assert.ok(first && second && first[1] !== second[1], "the two same-name athletes stay distinct");
  assert.match(visible, /<strong>Name not provided \(GPEXE athlete \d+\)<\/strong>\s*<span class="gpexe-map-born">Born 31\.12\.1999<\/span>/);
  assert.ok(!/GPEXE athlete 104|GPEXE athlete 105|GPEXE athlete 106/.test(visible), "a named row shows its id only under Technical details, also in its aria-label");
  assert.match(html, /<dt>GPEXE athlete id<\/dt><dd>104<\/dd>/);
  assert.match(visible, /<strong>Name not loaded \(GPEXE athlete \d+\)<\/strong>/, "with the identity view a row without an identity shows no id either");
  assert.match(visible, /1 GPEXE athlete has no name loaded yet/);
  assert.match(visible, /data-action="training-load-gpexe-identity-open"[^>]*>Load names and dates of birth<\/button>/);
});

test("a duplicate GPEXE name is warned on both rows; choosing an OptiMove athlete whose date of birth differs warns on the row and in the confirmation; nothing is linked before the final Link", async () => {
  reset();
  responder = server();
  await openMapping();
  let html = outsideTech(mappingHtml());
  assert.equal((html.match(/Check: another GPEXE athlete has the same name/g) || []).length, 2);
  assert.ok(!/differs from the one in this athlete's OptiMove profile/.test(html), "no conflict before a choice");
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "104" }, { value: "ath-1" });
  html = outsideTech(mappingHtml());
  assert.match(html, /the date of birth in GPEXE differs from the one in this athlete's OptiMove profile/);
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "104" }, { value: "ath-2" });
  assert.ok(!/differs from the one/.test(outsideTech(mappingHtml())), "another athlete: no conflict");
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "104" }, { value: "ath-1" });
  await act("training-load-gpexe-map-confirm");
  html = mappingHtml();
  assert.match(html, /<strong>Mira Zedova \(GPEXE athlete \d+\)<\/strong> <span class="muted">\(Born 03\.02\.2001\)<\/span> → <strong>Ana Example<\/strong><span class="gpexe-map-caution" role="note">Check: another GPEXE athlete has the same name\.<\/span><span class="muted gpexe-map-born">Last seen [^<]*<\/span><span class="gpexe-map-caution" role="note">Check: the date of birth in GPEXE differs/);
  assert.match(html, /OptiMove warns only when both dates of birth are known and differ\. No warning does not mean they match\./);
  assert.equal(fetchCalls.filter((c) => c.url.endsWith("/athlete-links") && c.method === "POST").length, 0, "nothing linked before Link");
  await act("training-load-gpexe-map-send");
  const posts = fetchCalls.filter((c) => c.url.endsWith("/athlete-links") && c.method === "POST");
  assert.deepEqual(posts.map((c) => c.body), [{ gpexeAthleteId: "104", athleteId: "ath-1" }], "the link route gets the id as always, never a name or date");
});

test("the load: the confirmation says at most how many, read-only and 14 days before anything is sent; Load names sends ONE POST with { requestKey } only (a double click too); the answer is shown as counts only; the identities are read again", async () => {
  reset();
  let release;
  const held = new Promise((r) => { release = r; });
  responder = server({ onLoad: async () => { await held; return { status: 200, body: { requestKey: "k", outcome: "partial", loaded: 2, notFound: 1, notRead: 3, stopCode: "source_unavailable", unrecognisedBirthDates: 1, retentionDays: 14, replayed: false } }; } });
  await openMapping();
  await act("training-load-gpexe-identity-open");
  assert.equal(loadPosts().length, 0, "opening the confirmation sends nothing");
  const html = outsideTech(mappingHtml());
  assert.match(html, /Load the names and dates of birth of 1 athlete from GPEXE\?/);
  assert.match(html, /at most 50 athletes per load/);
  assert.match(html, /This only reads from GPEXE: nothing is changed there, and no athlete is linked\./);
  assert.match(html, /deletes the names and dates of birth from its database after at most 14 days \(a database backup taken meanwhile can keep them longer\), shows them only to administrators/);
  const first = act("training-load-gpexe-identity-send");
  const second = act("training-load-gpexe-identity-send");
  assert.match(outsideTech(mappingHtml()), /Loading names from GPEXE\.\.\./);
  release();
  await Promise.all([first, second]);
  assert.equal(loadPosts().length, 1, "a double click sends one request");
  assert.deepEqual(Object.keys(loadPosts()[0].body), ["requestKey"]);
  assert.match(loadPosts()[0].body.requestKey, KEY);
  assert.equal(loadPosts()[0].cache, "no-store");
  assert.ok(loadPosts()[0].signal, "bounded on the client");
  const after = outsideTech(mappingHtml());
  assert.match(after, /Read 2 athletes from GPEXE\. Where GPEXE gives no name or date of birth, the athlete(&#039;|')s row says so\. GPEXE has no record for 1 athlete; it stays without a name and can be loaded again after 24 hours\. GPEXE stopped answering before every athlete was read\. 3 athletes are still without a name - load again to read them\. 1 date of birth was in a form OptiMove does not accept and is shown as not provided\./);
  const notice = after.match(/<p class="gpexe-notice" role="status">([^<]*)<\/p>/)[1];
  assert.ok(!/Mira|Zedova|104|2001/.test(notice), "the result names counts only");
  assert.ok(identityCalls().filter((c) => c.method === "GET").length >= 2, "the identities are read again after the load");
  assert.ok(fetchCalls.findLastIndex((c) => c.url.endsWith("/athlete-identities")) > fetchCalls.findIndex((c) => c.url.endsWith("/athlete-identities/loads")), "a read follows the load");
});

test("a lost answer is 'Result not confirmed' with Check result: nothing is resent by itself, every link control is off meanwhile, Check result repeats the same requestKey, 'still running' keeps the marker, and the saved answer clears it", async () => {
  reset();
  let mode = "throw";
  responder = server({ onLoad: (call) => {
    if (mode === "throw") return "throw";
    if (mode === "running") return { status: 409, body: { error: "identity_load_running", message: "still running", replayed: true } };
    return { status: 200, body: { requestKey: call.body.requestKey, outcome: "completed", loaded: 1, notFound: 0, notRead: 0, stopCode: null, unrecognisedBirthDates: null, retentionDays: 14, replayed: true } };
  } });
  await openMapping();
  await act("training-load-gpexe-identity-open");
  await act("training-load-gpexe-identity-send");
  assert.equal(loadPosts().length, 1);
  const key = loadPosts()[0].body.requestKey;
  let html = mappingHtml();
  assert.match(outsideTech(html), /<strong>Result not confirmed\.<\/strong> The answer was lost/);
  assert.match(html, /data-action="training-load-gpexe-identity-check">Check result<\/button>/);
  assert.match(html, /data-action="training-load-gpexe-map-choose"[^>]*disabled/, "choosing is off while the result is not confirmed");
  assert.match(html, /data-action="training-load-gpexe-map-confirm" disabled/);
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "107" }, { value: "ath-2" });
  assert.deepEqual(state.trainingLoad.gpexe.mapping.choices, {}, "a stale choose is ignored");
  await act("training-load-gpexe-identity-open");
  await act("training-load-gpexe-identity-send");
  assert.equal(loadPosts().length, 1, "no new load while the result is not confirmed");
  mode = "running";
  await act("training-load-gpexe-identity-check");
  assert.equal(loadPosts().length, 2);
  assert.equal(loadPosts()[1].body.requestKey, key, "Check result repeats the same key");
  assert.match(outsideTech(mappingHtml()), /The load is still running, or its result is not settled yet/);
  mode = "ok";
  await act("training-load-gpexe-identity-check");
  assert.equal(loadPosts()[2].body.requestKey, key);
  html = outsideTech(mappingHtml());
  assert.ok(!/Result not confirmed/.test(html));
  assert.match(html, /Read 1 athlete from GPEXE\./);
  // The next load gets a new key.
  await act("training-load-gpexe-identity-open");
  await act("training-load-gpexe-identity-send");
  assert.notEqual(loadPosts()[3].body.requestKey, key);
});

test("stated outcomes: an abandoned load, a refused credential and an unusable connection are sentences with a fresh key next time; outcome_unknown and an uncoded 5xx are not confirmed; a 404 on the read shows nothing, a 404 on the load clears the panel", async () => {
  for (const [answer, expected] of [
    [{ status: 409, body: { error: "identity_load_abandoned", message: "x" } }, /The last load did not finish and saved nothing/],
    [{ status: 409, body: { error: "identity_load_running", message: "x" } }, /Another load of GPEXE names is running for this team, possibly started by another administrator\. Nothing was started\./],
    [{ status: 409, body: { error: "source_auth_rejected", message: "x" } }, /GPEXE refused the connection(&#039;|')s credential/],
    [{ status: 409, body: { error: "source_connection_unavailable", reason: "connection_not_usable", message: "x" } }, /test or reconnect it in Settings &gt; Source connections/],
    [{ status: 503, body: { error: "outcome_unknown", message: "x" } }, /Result not confirmed/],
    [{ status: 502, body: "<html>" }, /Result not confirmed/],
  ]) {
    reset();
    responder = server({ onLoad: () => answer });
    await openMapping();
    await act("training-load-gpexe-identity-open");
    await act("training-load-gpexe-identity-send");
    assert.match(outsideTech(mappingHtml()), expected, JSON.stringify(answer.body));
  }
  reset();
  responder = server({ identities: () => ({ status: 404, body: { error: "notFound" } }) });
  await openMapping();
  assert.ok(!/GPEXE names and dates of birth/.test(mappingHtml()), "a 404 shows nothing of the identity");
  reset();
  responder = server({ onLoad: () => ({ status: 404, body: { error: "notFound" } }) });
  await openMapping();
  await act("training-load-gpexe-identity-open");
  await act("training-load-gpexe-identity-send");
  const html = outsideTech(mappingHtml());
  assert.ok(!/Mira Zedova/.test(html), "the names go");
  assert.match(html, /GPEXE names are not available for this team any more/);
});

test("locks: while a link is sent, or its confirmation is open, the load button is off and the confirmation does not open; while a name load runs, Close, choosing and Review are off", async () => {
  reset();
  let release;
  const held = new Promise((r) => { release = r; });
  responder = server({ onLoad: async () => { await held; return { status: 200, body: { loaded: 0, notFound: 0, notRead: 0, stopCode: null, unrecognisedBirthDates: 0, retentionDays: 14 } }; } });
  await openMapping();
  const gx = state.trainingLoad.gpexe;
  gx.linkBusy = true;
  assert.match(mappingHtml(), /data-action="training-load-gpexe-identity-open" disabled/);
  await act("training-load-gpexe-identity-open");
  assert.equal(gx.identity.confirming, false);
  gx.linkBusy = false;
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "107" }, { value: "ath-2" });
  await act("training-load-gpexe-map-confirm");
  assert.equal(gx.mapping.confirming, true);
  await act("training-load-gpexe-identity-open");
  assert.equal(gx.identity.confirming, false, "not while the link confirmation is open");
  await act("training-load-gpexe-map-back");
  await act("training-load-gpexe-identity-open");
  const sending = act("training-load-gpexe-identity-send");
  const html = mappingHtml();
  assert.match(html, /data-action="training-load-gpexe-map-close" aria-label="Close" disabled/);
  assert.match(html, /data-action="training-load-gpexe-map-confirm" disabled/);
  await act("training-load-gpexe-map-close");
  assert.equal(gx.mapping.open, true, "Close is refused while a load runs");
  release();
  await sending;
});

test("the identity lives only in the Imports view's memory: closing Link athletes keeps it for the other Imports screens; leaving Imports, a team switch and a workspace switch drop it; no browser storage is ever touched (a static scan of the three Imports modules agrees)", async () => {
  reset();
  // Team B answers its own list (one athlete foreign to team A), so a stale team A list would show.
  const TEAM_B_IDENTITIES = { ...IDENTITIES, identities: [{ gpexeAthleteId: "999", name: "Other Team", birthDate: null }] };
  responder = server({ identities: (call) => ({ status: 200, body: call.url.includes(TEAM_B) ? TEAM_B_IDENTITIES : IDENTITIES }) });
  await openMapping();
  assert.ok(state.trainingLoad.gpexe.identity.list);
  await act("training-load-gpexe-map-close");
  assert.ok(state.trainingLoad.gpexe.identity.list, "the Imports view keeps the names for its other screens");
  await act("training-load-section", { section: "today" });
  assert.equal(state.trainingLoad.gpexe.identity.list, null, "leaving Imports drops them");
  await act("training-load-section", { section: "imports" });
  assert.ok(state.trainingLoad.gpexe.identity.list, "entering Imports again reads the stored names again (no GPEXE request)");
  await act("training-load-gpexe-team", {}, { value: TEAM_B });
  assert.equal(state.trainingLoad.gpexe.teamId, TEAM_B);
  const teamBIds = Object.keys(state.trainingLoad.gpexe.identity.list?.byId || {});
  assert.ok(teamBIds.every((id) => id === "999"), `a team switch drops the other team's names: ${teamBIds.join(",")}`);
  resetTrainingLoadForWorkspaceChange();
  assert.equal(state.trainingLoad.gpexe.identity.list, null, "a workspace switch drops them");
  for (const file of ["gpexe-import-data.js", "gpexe-import-view.js", "gpexe-import-actions.js"]) {
    const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|caches\.|serviceWorker/, file);
  }
});

test("with the identity view, no GPEXE id appears outside Technical details: not in a loaded row, not in a row without a name (GPEXE's 404 included), not in an aria-label, the confirmation, the results, an error sentence or the unlink question", async () => {
  reset();
  // 107 has no identity (never loaded, or GPEXE answered 404 - which is never stored).
  responder = server({ onLink: () => ({ status: 409, body: { error: "already_linked", message: "That GPEXE athlete or athlete is already linked." } }) });
  await openMapping();
  const ids = ["104", "105", "106", "107"];
  const visibleText = (html) => outsideTech(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/g, " ");
  const ariaLabels = (html) => [...outsideTech(html).matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  const noIdOutside = (html, where) => {
    const text = visibleText(html);
    const labels = ariaLabels(html).join(" | ");
    for (const id of ids) {
      assert.ok(!new RegExp(`\\b${id}\\b`).test(text), `${where}: id ${id} outside Technical details`);
      assert.ok(!new RegExp(`\\b${id}\\b`).test(labels), `${where}: id ${id} in an aria-label`);
    }
  };
  let html = mappingHtml();
  noIdOutside(html, "the list");
  // Two athletes without a name (106: "Name not provided", 107: not loaded) never share one select label.
  const labels = ariaLabels(html).filter((l) => l.startsWith("Link the GPEXE athlete"));
  assert.equal(new Set(labels).size, labels.length, `every select label is distinct: ${labels.join(" | ")}`);
  assert.match(outsideTech(html), /<strong>Name not loaded \(GPEXE athlete \d+\)<\/strong>/, "a row without an identity is named without its id");
  for (const id of ids) assert.match(html, new RegExp(`<dt>GPEXE athlete id</dt><dd>${id}</dd>`), `id ${id} is under Technical details`);
  // A stale choice: the error sentence names no id.
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "107" }, { value: "ath-2" });
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "104" }, { value: "ath-2" });
  await act("training-load-gpexe-map-confirm");
  html = mappingHtml();
  assert.match(html, /chosen for the GPEXE athlete [^.]+ and [^.]+\. One athlete can be linked to one GPEXE athlete only\./);
  noIdOutside(html, "the error sentence");
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "104" }, { value: "" });
  await act("training-load-gpexe-map-confirm");
  html = mappingHtml();
  noIdOutside(html, "the confirmation");
  await act("training-load-gpexe-map-send");
  html = mappingHtml();
  noIdOutside(html, "the results");
  // The unlink question on this screen.
  state.trainingLoad.gpexe.links = [{ id: "link-9", gpexeAthleteId: "106", athleteId: "ath-1", athleteName: "Ana Example" }];
  confirmAnswer = false;
  await act("training-load-gpexe-unlink", { linkId: "link-9" });
  const question = confirmQuestions.at(-1);
  assert.ok(question && !/\b106\b/.test(question), question);
});

test("athletes GPEXE had no record for in the last 24 hours are a count only: a sentence, never a row identity or an id", async () => {
  reset();
  responder = server({ identities: { ...IDENTITIES, pendingCount: 0, retryLaterCount: 2 } });
  await openMapping();
  const html = outsideTech(mappingHtml());
  assert.match(html, /2 athletes GPEXE had no record for are left out of loads for 24 hours, then can be loaded again\./);
  assert.match(html, /or GPEXE had no record for it in the last 24 hours/);
  assert.match(html, /<strong>Name not loaded \(GPEXE athlete \d+\)<\/strong>/, "the athlete's row is still unnamed");
});

test("a stale Review click while the name confirmation is open opens nothing (only one confirmation at a time)", async () => {
  reset();
  responder = server();
  await openMapping();
  await act("training-load-gpexe-identity-open");
  await act("training-load-gpexe-map-choose", { gpexeAthleteId: "107" }, { value: "ath-2" });
  await act("training-load-gpexe-map-confirm");
  assert.equal(state.trainingLoad.gpexe.mapping.confirming, false);
  assert.equal(state.trainingLoad.gpexe.identity.confirming, true);
});

test("names are escaped: markup in a GPEXE name is shown as text, never as HTML", async () => {
  reset();
  responder = server({ identities: { ...IDENTITIES, identities: [{ gpexeAthleteId: "104", name: "<img src=x onerror=alert(1)>", birthDate: null }], birthDateConflicts: [] } });
  await openMapping();
  const html = mappingHtml();
  assert.ok(!html.includes("<img src=x"), "no raw markup");
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
