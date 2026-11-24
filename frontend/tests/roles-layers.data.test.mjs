// Roles R4-4, PR B (docs/ai/roles-r4-4-screens-contract.md 5.2-5.6): the data side of Club roles and Person access
// (roles-layers-data.js) and the shared word rules (roles-layers-rules.js), against a fake server that keeps the R4-3
// routes' rules (backend/src/permissionLayersService.js): another club is the identical 404; a stale expectedRevision
// is version_changed with the current role; the same requestKey with the same body replays the saved answer WITHOUT
// customsStillHolding; a custom-word removal that names a custom not holding the word is custom_changed. Invented names.
import { before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installFetchMock } from "./support/fetch-mock.mjs";

let data;
let rules;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const OTHER = "11111111-0000-4000-8000-0000000000c2";
const COACH_ROLE = "22222222-0000-4000-8000-000000000001";
const ADMIN_ROLE = "22222222-0000-4000-8000-000000000002";
const USER = "33333333-0000-4000-8000-000000000001";
const USER2 = "33333333-0000-4000-8000-000000000002";
const CUSTOM1 = "44444444-0000-4000-8000-000000000001";
const CUSTOM2 = "44444444-0000-4000-8000-000000000002";
const TEAM = "55555555-0000-4000-8000-000000000001";

const CATALOG = {
  modules: [{ word: "organization", label: "Organization" }, { word: "calendar", label: "Calendar" }, { word: "imports", label: "Imports" }],
  permissions: [
    { word: "org.view", module: "organization", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, checked: true },
    { word: "staff.assign", module: "organization", scopeTypes: ["club"], platformOnly: false, systemRoleOnly: false, checked: true },
    { word: "roles.manage", module: "organization", scopeTypes: ["club"], platformOnly: false, systemRoleOnly: false, checked: true },
    { word: "calendar.edit", module: "calendar", scopeTypes: ["club", "team"], platformOnly: false, systemRoleOnly: false, checked: true },
    { word: "calendar.plan", module: "calendar", scopeTypes: ["team"], platformOnly: false, systemRoleOnly: false, checked: false },
    { word: "imports.run", module: "imports", scopeTypes: ["team"], platformOnly: false, systemRoleOnly: false, checked: true },
    { word: "platform.ops", module: "organization", scopeTypes: ["club"], platformOnly: true, systemRoleOnly: false, checked: true },
    { word: "club.owner", module: "organization", scopeTypes: ["club"], platformOnly: false, systemRoleOnly: true, checked: true },
  ],
  groups: [
    { key: "organization", label: "Organization", permissions: ["org.view", "staff.assign", "roles.manage", "platform.ops", "club.owner"] },
    { key: "calendar", label: "Calendar", permissions: ["calendar.edit", "calendar.plan"] },
    { key: "imports", label: "Imports", permissions: ["imports.run"] },
  ],
  held: ["org.view", "staff.assign", "roles.manage", "calendar.edit"],
  delegable: [],
};

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  data = await import("../roles-layers-data.js");
  rules = await import("../roles-layers-rules.js");
});

let server;
let calls;
function newServer() {
  calls = [];
  server = {
    coach: { revision: 0, items: ["org.view", "calendar.edit"], defaults: ["org.view", "calendar.edit"], question: null },
    customs: [
      { customId: CUSTOM1, userId: USER, name: "Ana Test", roleId: COACH_ROLE, roleName: "Team coach", scopeType: "team", scopeId: TEAM, words: ["calendar.edit"] },
      { customId: CUSTOM2, userId: USER2, name: "Bo Test", roleId: COACH_ROLE, roleName: "Team coach", scopeType: "team", scopeId: TEAM, words: ["org.view"] },
    ],
    personCustom: null, // { id, revision, items }
    saved: new Map(),
    fail: null,
    loseAnswer: false,
  };
  const coachView = () => {
    const c = server.coach;
    return {
      roleId: COACH_ROLE, name: "Team coach", basicKey: "team_coach",
      state: c.question ? "question_pending" : c.revision ? "own_version" : "follows_default",
      version: c.revision ? { revision: c.revision } : null,
      effectiveItems: [...c.items],
      question: c.question, actions: { change: true, answer: Boolean(c.question) },
    };
  };
  const view = () => ({
    systemRoles: [coachView(), { roleId: ADMIN_ROLE, name: "Club admin", basicKey: "club_admin", state: "follows_default", version: null, effectiveItems: ["org.view", "staff.assign", "roles.manage"], question: null, actions: { change: false, answer: false } }],
    clubRoles: [], closedModules: ["imports"],
  });
  const personView = () => ({
    name: "Ana Test",
    holdings: [{
      roleId: COACH_ROLE, roleName: "Team coach", displayName: server.personCustom ? "Team coach (custom)" : "Team coach", scopeType: "team", scopeId: TEAM,
      source: "assignment", roleItems: [...server.coach.items],
      effectiveItems: server.personCustom ? [...server.personCustom.items] : [...server.coach.items],
      custom: server.personCustom ? { id: server.personCustom.id, live: true, revision: server.personCustom.revision, items: [...server.personCustom.items] } : null,
      stillHeldThrough: [],
    }],
    closedModules: ["imports"], customHistory: [],
  });
  const replayOr = (body, hash, run) => {
    const saved = server.saved.get(body.requestKey);
    if (saved) return saved.hash === hash ? { status: 200, body: saved.replay() } : { status: 409, body: { error: "request_key_reused" } };
    const out = run();
    if (out.status === 200) server.saved.set(body.requestKey, { hash, replay: out.replay });
    if (out.status === 200 && server.loseAnswer) { server.loseAnswer = false; return { throwNetworkError: true }; }
    return out;
  };
  return installFetchMock(async (call) => {
    calls.push(call);
    if (server.fail) { const f = server.fail; server.fail = null; return f; }
    const url = String(call.url);
    const body = call.body || {};
    let m;
    if (call.method === "GET") {
      if (url === `/api/organization/roles/clubs/${CLUB}/roles`) return { status: 200, body: view() };
      if (url === `/api/organization/roles/catalog?clubId=${CLUB}`) return { status: 200, body: CATALOG };
      if (url === `/api/organization/roles/clubs/${CLUB}/custom-drift`) return { status: 200, body: { customs: server.customs.map((c) => ({ ...c, words: [...c.words] })) } };
      if (url === `/api/organization/roles/users/${USER}/clubs/${CLUB}`) return { status: 200, body: personView() };
      return { status: 404, body: { error: "notFound" } };
    }
    if (url === `/api/organization/roles/${COACH_ROLE}/clubs/${CLUB}/version`) {
      return replayOr(body, JSON.stringify([body.expectedRevision, body.add, body.remove, body.reason]), () => {
        if (body.expectedRevision !== (server.coach.revision || null)) return { status: 409, body: { error: "version_changed", current: coachView() } };
        const c = server.coach;
        c.items = [...c.items.filter((w) => !body.remove.includes(w)), ...body.add];
        c.revision += 1;
        const still = server.customs.filter((x) => x.words.some((w) => body.remove.includes(w)));
        return { status: 200, body: { role: coachView(), customsStillHolding: still }, replay: () => ({ role: coachView() }) };
      });
    }
    if (url === `/api/organization/roles/${COACH_ROLE}/clubs/${CLUB}/version/answer`) {
      return replayOr(body, JSON.stringify([body.systemRevision, body.choice]), () => {
        const q = server.coach.question;
        if (!q || q.systemRevision !== body.systemRevision) return { status: 409, body: { error: "question_outdated", current: coachView() } };
        if (body.choice === "accept_default") { server.coach.items = [...server.coach.defaults]; server.coach.revision = 0; }
        server.coach.question = null;
        return { status: 200, body: { role: coachView() }, replay: () => ({ role: coachView() }) };
      });
    }
    if ((m = url.match(/^\/api\/organization\/roles\/([^/]+)\/clubs\/([^/]+)\/custom-word-removal$/))) {
      if (m[2] !== CLUB) return { status: 404, body: { error: "notFound" } };
      return replayOr(body, JSON.stringify([m[1], body.word, body.customIds, body.reason]), () => {
        const listed = server.customs.filter((x) => body.customIds.includes(x.customId));
        if (listed.length !== body.customIds.length || listed.some((x) => !x.words.includes(body.word))) return { status: 409, body: { error: "custom_changed" } };
        for (const x of listed) x.words = x.words.filter((w) => w !== body.word);
        server.customs = server.customs.filter((x) => x.words.length);
        return { status: 200, body: { removed: listed.length }, replay: () => ({}) };
      });
    }
    if (url === `/api/organization/roles/users/${USER}/clubs/${CLUB}/custom`) {
      return replayOr(body, JSON.stringify(body), () => {
        if (body.expectedRevision !== (server.personCustom?.revision ?? null)) return { status: 409, body: { error: "custom_changed" } };
        const base = server.personCustom ? server.personCustom.items : server.coach.items;
        const items = [...base.filter((w) => !body.remove.includes(w)), ...body.add];
        server.personCustom = { id: CUSTOM1, revision: (server.personCustom?.revision || 0) + 1, items };
        return { status: 200, body: { custom: server.personCustom }, replay: () => ({}) };
      });
    }
    if ((m = url.match(/^\/api\/organization\/roles\/users\/([^/]+)\/custom\/([^/]+)\/end$/))) {
      return replayOr(body, JSON.stringify([m[2], body.reason]), () => {
        if (!server.personCustom || server.personCustom.id !== m[2]) return { status: 404, body: { error: "notFound" } };
        server.personCustom = null;
        return { status: 200, body: { ended: true }, replay: () => ({}) };
      });
    }
    return { status: 404, body: { error: "notFound" } };
  });
}

beforeEach(() => {
  newServer();
  data.resetClubRoles();
  data.resetPerson();
});

const posts = () => calls.filter((c) => c.method === "POST");

test("1. rules: the word locks in their order, and the groups leave out platform-only and other roles' words", () => {
  const ctx = { catalog: CATALOG, closedModules: ["imports"] };
  assert.equal(rules.wordLock("imports.run", ctx), "Not in your club's licence");
  assert.equal(rules.wordLock("calendar.plan", ctx), "Not available yet");
  assert.equal(rules.wordLock("roles.manage", { ...ctx, basicKey: "club_admin" }), "A Club admin always has this");
  assert.equal(rules.wordLock("club.owner", ctx), "You don't have this yourself");
  assert.equal(rules.wordLock("club.owner", { ...ctx, platform: true }), "");
  assert.equal(rules.wordLock("club.owner", { ...ctx, ticked: true }), "", "a word already ticked can be taken away");
  assert.equal(rules.wordLock("calendar.edit", ctx), "");
  const groups = rules.roleWordGroups(CATALOG, { basicKey: "team_coach", scopeTypes: ["team"] });
  assert.deepEqual(groups.map((g) => [g.key, g.words]), [["organization", ["org.view"]], ["calendar", ["calendar.edit", "calendar.plan"]], ["imports", ["imports.run"]]]);
  const admin = rules.roleWordGroups(CATALOG, { basicKey: "club_admin", scopeTypes: ["club"] });
  assert.ok(admin[0].words.includes("club.owner") && !admin[0].words.includes("platform.ops"));
  assert.deepEqual(rules.itemChanges(["a", "b"], ["b", "c"]), { add: ["c"], remove: ["a"] });
});

test("2. rules: every refusal is one plain sentence with no code or server text", () => {
  for (const code of ["notFound", "version_changed", "custom_changed", "question_outdated", "closed_by_club_ceiling", "permission_not_held", "club_admin_requires", "admin_not_narrowable", "self_custom", "custom_exists", "try_again", "request_key_reused", "zzz"]) {
    const text = rules.layersRefusalText({ code, status: 409, message: "SQL detail 42501", words: [] });
    assert.ok(text && !text.includes(code) && !text.includes("42501"), code);
  }
  assert.doesNotMatch(rules.layersRefusalText({ code: "error", status: 400, message: "reason is required", words: [] }), /reason is required/);
  assert.equal(rules.layersCheckSettles({ code: "version_changed", status: 409 }), true);
  assert.equal(rules.layersCheckSettles({ code: "notFound", status: 404 }), false);
  assert.equal(rules.layersCheckSettles({ code: "try_again", status: 503 }), false);
});

test("3. a club's version: the first change sends expectedRevision null, the next the revision; a reason is required", async () => {
  await data.loadClubRoles(CLUB);
  assert.equal(data.clubRoles.view.systemRoles.length, 2);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  await data.saveClubRole();
  assert.equal(posts().length, 0, "no reason, nothing sent");
  assert.match(data.clubRoles.notice, /Write a reason/);
  data.clubRoles.reason = "Coaches plan only";
  await data.saveClubRole();
  assert.deepEqual(posts()[0].body.expectedRevision, null);
  assert.deepEqual(posts()[0].body.remove, ["calendar.edit"]);
  assert.match(data.clubRoles.notice, /Saved for this club: Team coach/);
  assert.equal(data.systemRoleOf(COACH_ROLE).state, "own_version");
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "Back";
  await data.saveClubRole();
  assert.equal(posts()[1].body.expectedRevision, 1);
});

test("4. a stale revision is version_changed: the newest role is shown and the draft kept", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  server.coach.revision = 3; // someone else changed it
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  await data.saveClubRole();
  assert.match(data.clubRoles.notice, /Someone changed this meanwhile/);
  assert.equal(data.systemRoleOf(COACH_ROLE).version.revision, 3);
  assert.ok(!data.clubRoles.draft.includes("calendar.edit"), "the draft survives");
  assert.equal(data.clubRoles.command, null);
});

test("5. a lost answer is not confirmed; Check result sends the same body and key, and the replay settles it", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  server.loseAnswer = true;
  await data.saveClubRole();
  assert.equal(data.clubRoles.command.unconfirmed, true);
  assert.equal(data.writeOpen(data.clubRoles), true);
  data.closeClubRole();
  assert.equal(data.clubRoles.openRoleId, COACH_ROLE, "an unconfirmed write keeps the editor open");
  await data.saveClubRole(undefined, { check: true });
  assert.equal(posts().length, 2);
  assert.deepEqual(posts()[1].body, posts()[0].body);
  assert.equal(data.clubRoles.command, null);
  assert.match(data.clubRoles.notice, /Saved for this club/);
  assert.equal(data.clubRoles.stillHolding, null, "the replay carries no customsStillHolding");
});

test("6. Check result answered 404 or busy stays not confirmed", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  server.loseAnswer = true;
  await data.saveClubRole();
  server.fail = { status: 503, body: { error: "try_again" } };
  await data.saveClubRole(undefined, { check: true });
  assert.equal(data.clubRoles.command.unconfirmed, true);
  assert.match(data.clubRoles.notice, /Still not confirmed/);
  server.fail = { status: 404, body: { error: "notFound" } };
  await data.saveClubRole(undefined, { check: true });
  assert.equal(data.clubRoles.command.unconfirmed, true);
});

test("7. Take it from them too: one request per word, naming only the customs that hold that word", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.toggleClubRoleWord("org.view");
  data.clubRoles.reason = "Narrow";
  await data.saveClubRole();
  const sh = data.clubRoles.stillHolding;
  assert.deepEqual(sh.words, ["calendar.edit", "org.view"]);
  assert.equal(data.clubRoles.removalReason, "Removed from Team coach in this club");
  await data.removeFromCustoms();
  const removals = posts().filter((c) => c.url.endsWith("/custom-word-removal"));
  assert.equal(removals.length, 2);
  assert.deepEqual(removals.map((c) => [c.body.word, c.body.customIds]), [["calendar.edit", [CUSTOM1]], ["org.view", [CUSTOM2]]]);
  assert.equal(data.clubRoles.stillHolding, null);
  assert.equal(server.customs.length, 0);
});

test("8. the O3 question: Use the new default sends the question's revision; an outdated one shows the newest", async () => {
  server.coach.revision = 1;
  server.coach.items = ["org.view"];
  server.coach.question = { systemRevision: 4, defaultChanges: { added: ["calendar.edit"], removed: [] } };
  await data.loadClubRoles(CLUB);
  server.coach.question = { systemRevision: 5, defaultChanges: { added: ["calendar.edit"], removed: [] } };
  await data.answerClubRole(COACH_ROLE, "accept_default");
  assert.equal(posts()[0].body.systemRevision, 4);
  assert.match(data.clubRoles.notice, /question has changed/);
  assert.equal(data.systemRoleOf(COACH_ROLE).question.systemRevision, 5);
  await data.answerClubRole(COACH_ROLE, "accept_default");
  assert.match(data.clubRoles.notice, /now follows OptiMove's default/);
  assert.equal(data.systemRoleOf(COACH_ROLE).state, "follows_default");
});

test("9. another club's answer settles nothing; a switch during an unconfirmed write is refused", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  let release;
  server.fail = new Promise((resolve) => { release = resolve; });
  const pending = data.saveClubRole();
  data.resetClubRoles(); // the workspace changed
  release({ status: 200, body: { role: { roleId: COACH_ROLE } } });
  await pending;
  assert.equal(data.clubRoles.notice, "");
  assert.equal(data.clubRoles.view, null);
  await data.loadClubRoles(OTHER);
  assert.equal(data.clubRoles.error, "This is no longer available.", "another club is the identical 404");
  // An unconfirmed write keeps its club: a load of another club does nothing.
  data.resetClubRoles();
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  server.loseAnswer = true;
  await data.saveClubRole();
  await data.loadClubRoles(OTHER);
  assert.equal(data.clubRoles.clubId, CLUB);
  assert.equal(data.clubRolesNeedLoad(OTHER), false);
});

test("10. a saved version whose read failed reads the club's roles again", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  server.fail = { status: 200, body: { readError: true, roleId: COACH_ROLE } };
  const gets = () => calls.filter((c) => c.method === "GET").length;
  const before = gets();
  await data.saveClubRole();
  assert.equal(gets(), before + 1);
  assert.match(data.clubRoles.notice, /Saved for this club/);
});

test("11. a person's custom: the first save sends expectedRevision null and re-reads; Back to the role ends it", async () => {
  await data.loadPersonClub(CLUB);
  assert.equal(data.person.drift.length, 2);
  await data.loadPerson(USER);
  const key = data.holdingKey(data.person.view.holdings[0]);
  data.editHolding(key);
  data.togglePersonWord("calendar.edit");
  data.person.reason = "Only views";
  await data.savePersonCustom();
  const save = posts()[0];
  assert.equal(save.body.expectedRevision, null);
  assert.deepEqual([save.body.roleId, save.body.scopeType, save.body.scopeId], [COACH_ROLE, "team", TEAM]);
  assert.deepEqual(save.body.remove, ["calendar.edit"]);
  assert.match(data.person.notice, /Saved: Team coach \(custom\) for Ana Test/);
  assert.equal(data.person.view.holdings[0].custom.live, true, "read again");
  data.person.endKey = key;
  data.person.endReason = "";
  await data.endPersonCustom();
  assert.equal(posts().length, 1, "no reason, nothing sent");
  data.person.endReason = "Back to normal";
  await data.endPersonCustom();
  assert.match(posts()[1].url, new RegExp(`/users/${USER}/custom/${CUSTOM1}/end$`));
  assert.match(data.person.notice, /back to Team coach/);
  assert.equal(data.person.view.holdings[0].custom, null);
});

test("12. a person's custom changed meanwhile is custom_changed with one plain sentence", async () => {
  await data.loadPersonClub(CLUB);
  await data.loadPerson(USER);
  data.editHolding(data.holdingKey(data.person.view.holdings[0]));
  server.personCustom = { id: CUSTOM1, revision: 2, items: ["org.view"] };
  data.togglePersonWord("calendar.edit");
  data.person.reason = "x";
  await data.savePersonCustom();
  assert.match(data.person.notice, /Someone changed this meanwhile/);
  assert.doesNotMatch(data.person.notice, /custom_changed/);
});

test("13. drift: one tap asks (names, editable reason), the second sends the role's customs that hold the word", async () => {
  await data.loadPersonClub(CLUB);
  data.askDriftRemove(COACH_ROLE, "org.view");
  assert.equal(posts().length, 0, "asking sends nothing");
  assert.deepEqual(data.person.driftAsk.names, ["Bo Test"]);
  assert.equal(data.person.driftAsk.reason, "Removed from Team coach in this club");
  data.person.driftAsk = { ...data.person.driftAsk, reason: "Not needed any more" };
  await data.removeDriftWord();
  const p = posts()[0];
  assert.deepEqual(p.body.customIds, [CUSTOM2]);
  assert.equal(p.body.reason, "Not needed any more");
  assert.equal(data.person.notice, "Taken from 1 person: org.view.".replace("org.view", rules.wordsText(["org.view"])));
  assert.equal(data.person.driftAsk, null);
  assert.deepEqual(data.person.drift.map((c) => c.customId), [CUSTOM1]);
  data.askDriftRemove(COACH_ROLE, "imports.run");
  assert.equal(data.person.driftAsk, null, "no custom holds it: nothing to ask");
  data.askDriftRemove(COACH_ROLE, "calendar.edit");
  data.cancelDriftAsk();
  await data.removeDriftWord();
  assert.equal(posts().length, 1, "cancelled: nothing sent");
});

test("15. the club's roles are read again after an R3 write (the R3 list read marks them stale); the list stays meanwhile", async () => {
  const rolesData = await import("../roles-data.js");
  await data.loadClubRoles(CLUB);
  assert.equal(data.clubRolesNeedLoad(CLUB), false);
  const view = data.clubRoles.view;
  // R3's list read runs on entry and after every own-role write (roles-actions.js).
  const { state } = await import("../state.js");
  state.currentUser = { id: "u-admin", activeWorkspace: { type: "club", scopeId: CLUB }, clubs: [{ id: CLUB, role: "club_admin" }] };
  try { await rolesData.loadRoles(); } finally { state.currentUser = null; }
  assert.equal(data.clubRolesNeedLoad(CLUB), true);
  assert.equal(data.clubRoles.view, view, "still shown until the new read");
  await data.loadClubRoles(CLUB);
  assert.equal(data.clubRolesNeedLoad(CLUB), false);
});

test("16. Access is read again when it is marked stale: drift and the chosen person", async () => {
  await data.loadPersonClub(CLUB);
  await data.loadPerson(USER);
  server.customs.push({ customId: "44444444-0000-4000-8000-000000000009", userId: USER2, name: "Bo Test", roleId: COACH_ROLE, roleName: "Team coach", scopeType: "team", scopeId: TEAM, words: ["calendar.edit"] });
  server.personCustom = { id: CUSTOM1, revision: 1, items: ["org.view"] };
  await data.refreshPerson();
  assert.equal(data.person.drift.length, 2, "not stale: nothing read");
  data.markPersonStale();
  await data.refreshPerson();
  assert.equal(data.person.drift.length, 3);
  assert.equal(data.person.view.holdings[0].custom.live, true);
});

test("17. Take it from them too: the caller's own custom is never listed; a cut list says so; the words add up", async () => {
  const me = (await import("../state.js")).state;
  me.currentUser = { id: USER };
  try {
    await data.loadClubRoles(CLUB);
    data.openClubRole(COACH_ROLE);
    data.toggleClubRoleWord("calendar.edit");
    data.toggleClubRoleWord("org.view");
    data.clubRoles.reason = "Narrow";
    server.fail = null;
    await data.saveClubRole();
    assert.deepEqual(data.clubRoles.stillHolding.list.map((c) => c.customId), [CUSTOM2], "the caller's own custom is left out");
    assert.deepEqual(data.clubRoles.stillHolding.words, ["org.view"]);
    data.clubRoles.stillHolding = { ...data.clubRoles.stillHolding, truncated: true };
    await data.removeFromCustoms();
    assert.match(data.clubRoles.notice, /^Taken from 1 person: .+\. More people may still have it/);
  } finally {
    me.currentUser = null;
  }
});

test("18. a removal refused as custom_changed drops the offer and says what happened", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  await data.saveClubRole();
  assert.ok(data.clubRoles.stillHolding);
  server.fail = { status: 409, body: { error: "custom_changed" } };
  await data.removeFromCustoms();
  assert.equal(data.clubRoles.stillHolding, null);
  assert.match(data.clubRoles.notice, /Someone changed these people's access meanwhile/);
  assert.doesNotMatch(data.clubRoles.notice, /newest version is shown/);
  assert.equal(data.person.stale, true);
  data.dismissStillHolding();
});

test("19. an O3 answer whose read failed reads the club's roles again", async () => {
  server.coach.revision = 1;
  server.coach.question = { systemRevision: 4, defaultChanges: { added: [], removed: [] } };
  await data.loadClubRoles(CLUB);
  const gets = () => calls.filter((c) => c.method === "GET").length;
  const before = gets();
  server.fail = { status: 200, body: { readError: true, roleId: COACH_ROLE } };
  await data.answerClubRole(COACH_ROLE, "keep_mine");
  assert.equal(gets(), before + 1);
});

test("14. a person of no role here reads one plain sentence; an older read never replaces a newer one", async () => {
  await data.loadPersonClub(CLUB);
  await data.loadPerson(USER2);
  assert.equal(data.person.noRole, true, "a 404 is a plain answer");
  assert.equal(data.person.error, "", "not a failure with Try again");
  let release;
  server.fail = new Promise((resolve) => { release = resolve; });
  const older = data.loadPerson(USER);
  await data.loadPerson(USER2);
  release({ status: 200, body: { name: "Ana Test", holdings: [] } });
  await older;
  assert.equal(data.person.userId, USER2);
  assert.equal(data.person.view, null);
});

test("20. a read begun before a save that lands after it cannot undo the save: the roles are read once more", async () => {
  await data.loadClubRoles(CLUB);
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.clubRoles.reason = "x";
  // An entry read starts and is held; the save goes through meanwhile.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const before = JSON.parse(JSON.stringify((await (await fetch(`/api/organization/roles/clubs/${CLUB}/roles`)).json())));
  server.fail = held;
  const slow = data.loadClubRoles(CLUB);
  await data.saveClubRole();
  assert.equal(data.systemRoleOf(COACH_ROLE).state, "own_version");
  release({ status: 200, body: before }); // the old view, from before the save
  await slow;
  assert.equal(data.clubRoles.stale, true, "the late old answer is read over");
  assert.equal(data.clubRolesNeedLoad(CLUB), true);
  await data.loadClubRoles(CLUB);
  assert.equal(data.systemRoleOf(COACH_ROLE).state, "own_version");
});

test("21. several words taken: one sentence names them all with no single count", async () => {
  await data.loadClubRoles(CLUB);
  server.customs = [{ customId: CUSTOM1, userId: USER, name: "Ana Test", roleId: COACH_ROLE, roleName: "Team coach", scopeType: "team", scopeId: TEAM, words: ["calendar.edit", "org.view"] }, { customId: CUSTOM2, userId: USER2, name: "Bo Test", roleId: COACH_ROLE, roleName: "Team coach", scopeType: "team", scopeId: TEAM, words: ["org.view"] }];
  data.openClubRole(COACH_ROLE);
  data.toggleClubRoleWord("calendar.edit");
  data.toggleClubRoleWord("org.view");
  data.clubRoles.reason = "x";
  await data.saveClubRole();
  await data.removeFromCustoms();
  assert.equal(data.clubRoles.notice, `Taken from them: ${rules.wordsText(["calendar.edit", "org.view"])}.`);
});
