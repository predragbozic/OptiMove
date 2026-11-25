// Roles R4-4, PR A: Settings > Clubs > a club's licence (docs/ai/roles-r4-4-screens-contract.md 5.1), through the real
// plain side (club-licence-actions.js, club-licence-data.js) and the COMPILED island (react-build/islands.js), against a
// fake server that keeps the R4-3 ceiling route's rules (backend/src/permissionLayersService.js getCeiling / setCeiling):
// another club is the identical 404, "organization" cannot close, a change that changes nothing is ceiling_unchanged
// with the current state, and the same requestKey with the same body replays the saved answer. Invented names only.
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";

let actions;
let rolesActions;
let data;
let orgView;
let state;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const OTHER = "11111111-0000-4000-8000-0000000000c2";
const CLUB2 = "11111111-0000-4000-8000-0000000000c3";
const MODULES = [
  { word: "organization", label: "Organization" }, { word: "athletes", label: "Athletes" }, { word: "calendar", label: "Calendar" },
  { word: "imports", label: "Imports" },
];
const EFFECTIVE = new Set(["organization"]);

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  actions = await import("../club-licence-actions.js");
  rolesActions = await import("../roles-actions.js");
  data = await import("../club-licence-data.js");
  orgView = await import("../organization-view.js");
  ({ state } = await import("../state.js"));
});

// The fake server: each club's closed parts and history, and the request records by requestKey. Like the real route
// (permissionRolesService.js runWrite): the first answer is the licence plus what changed (`closed`, `opened`); a replay
// answers the licence as it is now, WITHOUT `closed` / `opened`. `server.hold[clubId]` holds that club's next GET until
// released.
let server;
const CLUBS = new Set([CLUB, CLUB2]);
function newServer() {
  server = { closed: new Map([[CLUB, new Set()], [CLUB2, new Set()]]), history: new Map([[CLUB, []], [CLUB2, []]]), saved: new Map(), fail: null, hold: {} };
  return installFetchMock(async (call) => {
    // A planted answer for the next request (a function may wait before answering).
    if (server.fail) {
      const f = server.fail;
      server.fail = null;
      return typeof f === "function" ? f(call) : f;
    }
    const m = String(call.url).match(/^\/api\/organization\/roles\/clubs\/([^/]+)\/ceiling$/);
    if (!m || !CLUBS.has(m[1])) return { status: 404, body: { error: "notFound" } };
    const club = m[1];
    const closed = server.closed.get(club);
    const view = () => ({
      clubId: club,
      modules: MODULES.map((x) => ({ module: x.word, label: x.label, closed: closed.has(x.word), ceilingEffective: EFFECTIVE.has(x.word), reason: null, closedBy: null })),
      history: [...server.history.get(club)],
    });
    if (call.method === "GET") {
      if (server.hold[club]) await server.hold[club];
      return { status: 200, body: view() };
    }
    const body = call.body;
    const hash = JSON.stringify({ club, close: body.close, open: body.open, reason: body.reason });
    const replay = server.saved.get(body.requestKey);
    if (replay) return replay === hash ? { status: 200, body: { ...view(), replayed: true } } : { status: 409, body: { error: "request_key_reused", message: "x" } };
    if ((body.close || []).includes("organization")) return { status: 409, body: { error: "module_not_closable", message: "x" } };
    const toClose = body.close.filter((w) => !closed.has(w));
    const toOpen = body.open.filter((w) => closed.has(w));
    if (!toClose.length && !toOpen.length) return { status: 409, body: { error: "ceiling_unchanged", message: "x", current: view() } };
    for (const w of toClose) { closed.add(w); server.history.get(club).unshift({ module: w, action: "close", by: "u1", reason: body.reason, at: "2026-11-24T10:00:00Z" }); }
    for (const w of toOpen) { closed.delete(w); server.history.get(club).unshift({ module: w, action: "open", by: "u1", reason: body.reason, at: "2026-11-24T10:00:00Z" }); }
    server.saved.set(body.requestKey, hash);
    if (server.loseAnswer) { server.loseAnswer = false; return { throwNetworkError: true }; }
    if (server.readError) { server.readError = false; return { status: 200, body: { readError: true, clubId: club } }; }
    return { status: 200, body: { ...view(), closed: toClose, opened: toOpen } };
  });
}
const closedOf = (club) => server.closed.get(club);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle() { for (let i = 0; i < 6; i += 1) await tick(); }
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
function type(el, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}
const button = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(text));
const box = (root, module) => root.querySelector(`[data-licence-module="${module}"]`);

function hostFor(clubId = CLUB, name = "Test Club") {
  document.body.innerHTML = `<main><div class="club-licence-host" data-club-licence-host data-club-id="${clubId}" data-club-name="${name}"></div></main>`;
  return document.body.querySelector("main");
}

async function openLicence(clubId = CLUB) {
  const root = hostFor(clubId);
  await actions.syncClubLicence(root);
  await settle();
  const toggle = button(root, "Show");
  if (toggle) click(toggle);
  await settle();
  return root;
}

beforeEach(() => {
  data.resetClubLicence();
});

test("1. the island reads the chosen club's licence once, folded; opened it shows every part with its state in words", async () => {
  const calls = newServer();
  closedOf(CLUB).add("imports");
  const root = hostFor();
  await actions.syncClubLicence(root);
  await settle();
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
  assert.match(root.textContent, /Test Club's licence/);
  assert.match(root.textContent, /3 of 4 parts included/);
  assert.ok(!root.querySelector("[data-licence-module]"), "folded");
  click(button(root, "Show"));
  await settle();
  assert.equal(box(root, "imports").checked, false);
  assert.equal(box(root, "athletes").checked, true);
  assert.equal(box(root, "organization").disabled, true, "Organization is always included");
  assert.match(root.textContent, /Always included/);
  assert.match(root.textContent, /Not included/);
  assert.match(root.textContent, /This part does not follow the licence yet/, "Q12: a part not effective yet says so");
  // A paint of Settings again reads nothing more.
  await actions.syncClubLicence(root);
  await settle();
  assert.equal(calls.filter((c) => c.method === "GET").length, 1);
});

test("2. Save sends ONE request with the parts to close and to open, a reason and a requestKey; nothing without a reason", async () => {
  const calls = newServer();
  closedOf(CLUB).add("imports");
  const root = await openLicence();
  click(box(root, "calendar"));
  await settle();
  click(box(root, "imports"));
  await settle();
  assert.match(root.textContent, /Take out: Calendar\. Put back: Imports\./);
  click(button(root, "Save licence (2 changes)"));
  await settle();
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no reason, no request");
  assert.match(root.textContent, /Write a reason/);
  type(root.querySelector("textarea"), "  Season change  ");
  await settle();
  click(button(root, "Save licence"));
  await settle();
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body.close, ["calendar"]);
  assert.deepEqual(posts[0].body.open, ["imports"]);
  assert.equal(posts[0].body.reason, "Season change");
  assert.match(posts[0].body.requestKey, /^[0-9a-f-]{36}$/);
  assert.match(root.textContent, /Licence saved – taken out: Calendar; put back: Imports\./);
  assert.equal(box(root, "calendar").checked, false);
  assert.equal(box(root, "imports").checked, true);
  assert.ok(!root.querySelector("[data-licence-save]"), "no draft left");
  assert.match(root.textContent, /History \(2\)/);
});

test("3. a lost answer: Result not confirmed; Check result sends the SAME body and key; a 404 or a busy server keeps it unconfirmed", async () => {
  const calls = newServer();
  const root = await openLicence();
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "Licence ended");
  await settle();
  server.fail = { throwNetworkError: true };
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /Result not confirmed/);
  assert.equal(box(root, "athletes").disabled, true, "every other write is off while unconfirmed");
  const first = calls.filter((c) => c.method === "POST")[0].body;
  // A 404 and a 503 come before the request record: still not confirmed.
  for (const answer of [{ status: 404, body: { error: "notFound" } }, { status: 503, body: { error: "outcome_unknown" } }]) {
    server.fail = answer;
    click(button(root, "Check result"));
    await settle();
    assert.match(root.textContent, /Result not confirmed/, JSON.stringify(answer));
  }
  click(button(root, "Check result"));
  await settle();
  const posts = calls.filter((c) => c.method === "POST");
  assert.ok(posts.every((p) => JSON.stringify(p.body) === JSON.stringify(first)), "the same request every time");
  assert.doesNotMatch(root.textContent, /Result not confirmed/);
  assert.match(root.textContent, /Licence saved/);
  assert.equal(closedOf(CLUB).has("calendar"), true);
  assert.equal(server.history.get(CLUB).length, 1, "written once");
});

test("3b. written, answer lost: Check result gets the replay (no list of changes) and still says what was saved", async () => {
  const calls = newServer();
  const root = await openLicence();
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "Licence ended");
  await settle();
  server.loseAnswer = true;
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /Result not confirmed/);
  click(button(root, "Check result"));
  await settle();
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);
  assert.equal(server.history.get(CLUB).length, 1, "written once: the second was the replay");
  assert.match(root.textContent, /Licence saved – taken out: Calendar\./);
  assert.doesNotMatch(root.textContent, /0 parts/);
  assert.equal(box(root, "calendar").checked, false);
});

test("3c. a save whose read-back failed (readError) says saved and reads the licence again", async () => {
  const calls = newServer();
  const root = await openLicence();
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "Licence ended");
  await settle();
  server.readError = true;
  const gets = calls.filter((c) => c.method === "GET").length;
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /Licence saved – taken out: Calendar\./);
  assert.equal(calls.filter((c) => c.method === "GET").length, gets + 1, "read again");
  assert.equal(box(root, "calendar").checked, false, "the fresh state");
});

test("4. someone else made the same change meanwhile: ceiling_unchanged settles with the current state, no draft left", async () => {
  newServer();
  const root = await openLicence();
  click(box(root, "athletes"));
  await settle();
  type(root.querySelector("textarea"), "Test");
  await settle();
  closedOf(CLUB).add("athletes"); // someone else closed it meanwhile
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /Nothing changed – the licence was already like this\./);
  assert.equal(box(root, "athletes").checked, false, "the current state from the answer");
  assert.ok(!root.querySelector("[data-licence-save]"));
});

test("5. a refusal never confirms anything: try_again and a 404 say so in one sentence and keep no command", async () => {
  newServer();
  const root = await openLicence();
  click(box(root, "athletes"));
  await settle();
  type(root.querySelector("textarea"), "Test");
  await settle();
  server.fail = { status: 409, body: { error: "try_again", message: "busy" } };
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /The server is busy\. Nothing was written\./);
  assert.equal(data.licence.command, null);
  assert.equal(box(root, "athletes").disabled, false, "the draft can be sent again");
  server.fail = { status: 404, body: { error: "notFound" } };
  click(button(root, "Save licence"));
  await settle();
  assert.match(root.textContent, /This club is not available any more\./);
  assert.doesNotMatch(root.textContent, /notFound|try_again/, "no code on screen");
});

test("6. a club the caller may not see reads as not available, with Try again", async () => {
  newServer();
  const root = await openLicence(OTHER);
  assert.match(root.textContent, /This club is not available\./);
  assert.ok(button(root, "Try again"));
});

test("7. leaving with an open licence write asks (the roles guards); without one it does not", async () => {
  newServer();
  const asked = [];
  window.confirm = (q) => { asked.push(q); return false; };
  assert.equal(rolesActions.rolesMayBeLeft({ final: "switch" }), true);
  assert.equal(asked.length, 0);
  const root = await openLicence();
  click(box(root, "athletes"));
  await settle();
  type(root.querySelector("textarea"), "Test");
  await settle();
  server.fail = { throwNetworkError: true };
  click(button(root, "Save licence"));
  await settle();
  assert.equal(rolesActions.rolesMayBeLeft({ final: "switch" }), false);
  assert.match(asked[0], /^The last licence change is not confirmed\. Switch without checking\?/);
  const event = { preventDefault() { this.prevented = true; }, returnValue: undefined };
  rolesActions.handleRolesBeforeUnload(event);
  assert.equal(event.prevented, true);
});

test("8. a paint without the host unmounts the island; another club's host reads that club", async () => {
  const calls = newServer();
  const root = await openLicence();
  assert.ok(root.querySelector("[data-club-licence]"));
  document.body.innerHTML = "<main></main>";
  await actions.syncClubLicence(document.body.querySelector("main"));
  assert.ok(!document.querySelector("[data-club-licence]"));
  const again = hostFor(OTHER, "Other Club");
  await actions.syncClubLicence(again);
  await settle();
  assert.ok(calls.some((c) => c.url.includes(OTHER)), "the other club is read");
});

test("9. Settings > Clubs draws the host only for a platform administrator on a chosen club (and not on a chosen team)", () => {
  state.currentUser = { id: "u1", activeWorkspace: { type: "platform", scopeId: null, label: "Platform administration" } };
  const base = { clubs: [{ id: CLUB, name: "Test Club" }], teams: [{ id: "t1", club_id: CLUB, name: "Test Team" }], athletes: [], users: [] };
  state.organization = { ...state.organization, section: "clubs", selectedClubId: CLUB, selectedTeamId: "" };
  assert.match(orgView.renderOrganizationBrowser({ ...base, isPlatformAdmin: true }), /data-club-licence-host data-club-id="11111111-0000-4000-8000-0000000000c1" data-club-name="Test Club"/);
  assert.doesNotMatch(orgView.renderOrganizationBrowser({ ...base, isPlatformAdmin: false }), /data-club-licence-host/);
  state.organization.selectedClubId = "";
  assert.doesNotMatch(orgView.renderOrganizationBrowser({ ...base, isPlatformAdmin: true }), /data-club-licence-host/);
  state.organization.selectedClubId = CLUB;
  state.organization.selectedTeamId = "t1";
  assert.doesNotMatch(orgView.renderOrganizationBrowser({ ...base, isPlatformAdmin: true }), /data-club-licence-host/);
});

test("10. HIGH (code review): a club switched while the first club's read is under way never shows its parts under the new name; Save goes to the club on screen", async () => {
  const calls = newServer();
  closedOf(CLUB).add("imports");
  let release;
  server.hold[CLUB] = new Promise((r) => { release = r; });
  await actions.syncClubLicence(hostFor(CLUB, "Test Club"));
  await settle();
  const root = hostFor(CLUB2, "Second Club");
  await actions.syncClubLicence(root);
  await settle();
  delete server.hold[CLUB];
  release();
  await settle();
  assert.ok(calls.some((c) => c.method === "GET" && c.url.includes(CLUB2)), "the club on screen is read");
  click(button(root, "Show"));
  await settle();
  assert.match(root.textContent, /Second Club's licence/);
  assert.equal(box(root, "imports").checked, true, "Second Club's own parts, not Test Club's");
  click(box(root, "athletes"));
  await settle();
  type(root.querySelector("textarea"), "Second club only");
  await settle();
  click(button(root, "Save licence"));
  await settle();
  const post = calls.find((c) => c.method === "POST");
  assert.ok(post.url.includes(CLUB2) && !post.url.includes(CLUB + "/"), post.url);
  assert.equal(closedOf(CLUB2).has("athletes"), true);
  assert.equal(closedOf(CLUB).has("athletes"), false);
});

test("11. a club switched while a save is not confirmed: the open write stays on screen under its own club, nothing of it is drawn under the new name, and no draft goes anywhere", async () => {
  const calls = newServer();
  let root = await openLicence(CLUB);
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "Test");
  await settle();
  server.fail = { throwNetworkError: true };
  click(button(root, "Save licence"));
  await settle();
  root = hostFor(CLUB2, "Second Club");
  await actions.syncClubLicence(root);
  await settle();
  assert.doesNotMatch(root.textContent, /Second Club's licence/, "never the other club's name over this write");
  assert.match(root.textContent, /Test Club's licence/);
  assert.match(root.textContent, /open change of Test Club's licence/);
  assert.match(root.textContent, /Result not confirmed/);
  assert.ok(!calls.some((c) => c.method === "GET" && c.url.includes(CLUB2)), "not read while the write is open");
  // Checking settles the write of Test Club; then Second Club is read.
  click(button(root, "Check result"));
  await settle();
  assert.equal(closedOf(CLUB).has("calendar"), true);
  assert.ok(calls.some((c) => c.method === "GET" && c.url.includes(CLUB2)), "read once the write is settled");
  assert.match(root.textContent, /Second Club's licence/);
  assert.match(root.textContent, /Test Club's licence: Licence saved – taken out: Calendar\./, "the outcome of Test Club's write is shown, under its name");
  assert.ok(calls.filter((c) => c.method === "POST").every((c) => c.url.includes(CLUB + "/")), "every write went to Test Club");
});

test("11b. a check of the other club's write that settles as a refusal still says so, under that club's name", async () => {
  newServer();
  let root = await openLicence(CLUB);
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "Test");
  await settle();
  server.fail = { throwNetworkError: true };
  click(button(root, "Save licence"));
  await settle();
  root = hostFor(CLUB2, "Second Club");
  await actions.syncClubLicence(root);
  await settle();
  server.fail = { status: 409, body: { error: "request_key_reused", message: "x" } };
  click(button(root, "Check result"));
  await settle();
  assert.match(root.textContent, /Second Club's licence/);
  assert.match(root.textContent, /Test Club's licence: This change was already sent with other content\./);
});

test("12. an answer for a state replaced by a workspace switch settles nothing of the new state", async () => {
  newServer();
  let root = await openLicence(CLUB);
  click(box(root, "calendar"));
  await settle();
  type(root.querySelector("textarea"), "First");
  await settle();
  let release;
  server.fail = async () => { await new Promise((r) => { release = r; }); return { status: 200, body: { readError: true, clubId: CLUB } }; };
  click(button(root, "Save licence"));
  await settle();
  data.resetClubLicence();
  root = await openLicence(CLUB);
  click(box(root, "athletes"));
  await settle();
  const draft = data.licence.draftClosed;
  release();
  await settle();
  assert.deepEqual(data.licence.draftClosed, draft, "the new draft is kept");
  assert.equal(data.licence.command, null);
});

test("13. leaving Settings unmounts the island at once", async () => {
  newServer();
  const root = await openLicence(CLUB);
  const host = root.querySelector("[data-club-licence-host]");
  const islands = await import("../react-build/islands.js");
  assert.equal(islands.isIslandMounted(host), true);
  actions.leaveClubLicence();
  assert.equal(islands.isIslandMounted(host), false);
});
