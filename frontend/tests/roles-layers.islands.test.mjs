// Roles R4-4, PR B: the COMPILED Club roles and Person access islands (react-build/islands.js) with the shared word
// list, as pure views over invented props: state with a glyph and words, the locks' sentences, a closed module folded,
// the O3 question, Take it from them too, "(custom)" and "Still has it through", and the blocked sentences.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let islands;

const CATALOG = {
  modules: [{ word: "organization", label: "Organization" }, { word: "calendar", label: "Calendar" }, { word: "imports", label: "Imports" }],
  permissions: [
    { word: "org.view", module: "organization", scopeTypes: ["club", "team"], checked: true },
    { word: "staff.assign", module: "organization", scopeTypes: ["club"], checked: true },
    { word: "roles.manage", module: "organization", scopeTypes: ["club"], checked: true },
    { word: "calendar.edit", module: "calendar", scopeTypes: ["club", "team"], checked: true },
    { word: "calendar.plan", module: "calendar", scopeTypes: ["team"], checked: false },
    { word: "imports.run", module: "imports", scopeTypes: ["team"], checked: true },
  ],
  groups: [
    { key: "organization", label: "Organization", permissions: ["org.view", "staff.assign", "roles.manage"] },
    { key: "calendar", label: "Calendar", permissions: ["calendar.edit", "calendar.plan"] },
    { key: "imports", label: "Imports", permissions: ["imports.run"] },
  ],
  held: ["org.view", "staff.assign", "roles.manage"],
  delegable: [],
};
const COACH = { roleId: "r-coach", name: "Team coach", basicKey: "team_coach", scopeTypes: ["team"], state: "own_version", version: { revision: 2 }, effectiveItems: ["org.view"], question: null, actions: { change: true, answer: false } };
const ADMIN = { roleId: "r-admin", name: "Club admin", basicKey: "club_admin", scopeTypes: ["club"], state: "follows_default", version: null, effectiveItems: ["org.view", "staff.assign", "roles.manage"], question: null, actions: { change: false, answer: false } };

before(async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  islands = await import("../react-build/islands.js");
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const host = () => { const el = document.createElement("div"); document.body.append(el); return el; };
const noop = () => {};
const clubProps = (over = {}) => ({
  clubName: "FK Primer", view: { systemRoles: [COACH, ADMIN], clubRoles: [{ roleId: "r-own", name: "Video analyst" }], closedModules: ["imports"] },
  catalog: CATALOG, r2Roles: [{ id: "r-coach", holderCount: 3, actions: { copy: true } }, { id: "r-admin", holderCount: 1, actions: {} }, { id: "r-own", holderCount: 0, actions: { change: true, archive: true } }],
  canCreate: true, onOpen: noop, onCopy: noop, onCheck: noop, onOwnOpen: noop, onOwnNew: noop, onOwnCopy: noop, onOwnArchive: noop,
  onClose: noop, onToggle: noop, onReason: noop, onSave: noop, onAnswer: noop, onRemovalReason: noop, onRemove: noop,
  draft: null, changes: { add: [], remove: [] }, reason: "", removalReason: "", stillHolding: null, ...over,
});

test("1. the list: each built-in role's state with a glyph and words, people counts, the licence line, the club's own roles", () => {
  const el = host();
  islands.mountIsland(el, islands.ClubRoles, clubProps());
  const text = el.textContent;
  assert.match(text, /✎ Changed for this club/);
  assert.match(text, /= Same as OptiMove's default/);
  assert.match(text, /3 people/);
  assert.match(text, /Only OptiMove changes this role/);
  assert.match(text, /does not include: Imports/);
  assert.match(text, /FK Primer's own roles/);
  assert.match(text, /Video analyst/);
  assert.ok(el.querySelector('[data-club-role="r-coach"]').textContent.includes("Copy as a new role"));
  assert.ok(!el.querySelector('[data-club-role="r-admin"]').textContent.includes("Copy as a new role"));
  assert.doesNotMatch(text, /r-coach|r-admin/, "no id on screen");
  islands.unmountIsland(el);
});

test("2. the word list: closed module folded with its sentence, the locks' sentences, a club admin's required words", async () => {
  const el = host();
  islands.mountIsland(el, islands.ClubRoles, clubProps({ openRoleId: "r-coach" }));
  assert.match(el.textContent, /Team coach in FK Primer/);
  const imports = el.querySelector('[data-role-words-group="imports"]');
  assert.match(imports.textContent, /⊘ Not in your club's licence/);
  assert.equal(imports.querySelector("[data-role-word]"), null, "a closed module is folded");
  click(imports.querySelector("button"));
  await tick();
  assert.equal(imports.querySelector('[data-role-word="imports.run"]').disabled, true);
  const plan = el.querySelector('[data-role-word="calendar.plan"]');
  assert.equal(plan.disabled, true);
  assert.match(plan.closest("li").textContent, /Not available yet/);
  assert.match(el.querySelector('[data-role-word="calendar.edit"]').closest("li").textContent, /You don't have this yourself/);
  assert.equal(el.querySelector('[data-role-word="org.view"]').disabled, false);
  islands.mountIsland(el, islands.ClubRoles, clubProps({ openRoleId: "r-admin" }));
  assert.match(el.textContent, /You can read this role but not change it/);
  assert.match(el.querySelector('[data-role-word="roles.manage"]').closest("li").textContent, /A Club admin always has this/);
  islands.unmountIsland(el);
});

test("3. a change shows what changes, a reason and Save naming the club; a tick goes back through onToggle", () => {
  const toggled = [];
  const el = host();
  islands.mountIsland(el, islands.ClubRoles, clubProps({ openRoleId: "r-coach", draft: [], changes: { add: [], remove: ["org.view"] }, onToggle: (w) => toggled.push(w) }));
  const save = el.querySelector("[data-club-roles-save]");
  assert.match(save.textContent, /Take away: /);
  assert.match(save.textContent, /Save for FK Primer \(1 change\)/);
  click(el.querySelector('[data-role-word="org.view"]'));
  assert.deepEqual(toggled, ["org.view"]);
  islands.unmountIsland(el);
});

test("4. the O3 question: two answers, the default's changes in words, the words read-only", () => {
  const answers = [];
  const el = host();
  const pending = { ...COACH, state: "question_pending", question: { systemRevision: 5, defaultChanges: { added: ["calendar.edit"], removed: [] } }, actions: { change: true, answer: true } };
  islands.mountIsland(el, islands.ClubRoles, clubProps({ view: { systemRoles: [pending, ADMIN], clubRoles: [], closedModules: [] }, openRoleId: "r-coach", onAnswer: (id, c) => answers.push([id, c]) }));
  const q = el.querySelector("[data-club-roles-question]");
  assert.match(q.textContent, /OptiMove changed this role/);
  const [use, keep] = q.querySelectorAll("button");
  assert.equal(use.textContent, "Use the new default");
  assert.equal(keep.textContent, "Keep ours");
  click(keep);
  assert.deepEqual(answers, [["r-coach", "keep_mine"]]);
  assert.equal(el.querySelector('[data-role-word="org.view"]').disabled, true, "no change while the question waits");
  islands.unmountIsland(el);
});

test("5. Take it from them too: who still holds what, a prefilled reason; Result not confirmed offers Check result", () => {
  const removed = [];
  const checks = [];
  const el = host();
  const stillHolding = { roleId: "r-coach", roleName: "Team coach", words: ["calendar.edit"], list: [{ customId: "c1", name: "Ana Test", words: ["calendar.edit"] }], truncated: false };
  islands.mountIsland(el, islands.ClubRoles, clubProps({ openRoleId: "r-coach", stillHolding, removalReason: "Removed from Team coach in this club", onRemove: () => removed.push(1), command: { unconfirmed: true, busy: false }, onCheck: () => checks.push(1) }));
  const still = el.querySelector("[data-club-roles-still]");
  assert.match(still.textContent, /1 person with a custom version of Team coach still have/);
  assert.match(still.textContent, /Ana Test/);
  assert.equal(still.querySelector("textarea").value, "Removed from Team coach in this club");
  assert.match(el.textContent, /Result not confirmed/);
  const check = [...el.querySelectorAll("button")].find((b) => b.textContent === "Check result");
  click(check);
  assert.deepEqual(checks, [1]);
  assert.equal([...still.querySelectorAll("button")].find((b) => b.textContent === "Take it from them too").disabled, true, "no second write while one is not confirmed");
  islands.unmountIsland(el);
  assert.deepEqual(removed, []);
});

const personProps = (over = {}) => ({
  clubName: "FK Primer", people: [{ id: "u1", name: "Ana Test" }, { id: "u2", name: "Bo Test" }], userId: "u1", selfId: "me", catalog: CATALOG,
  view: {
    name: "Ana Test", closedModules: [], customHistory: [],
    holdings: [{ roleId: "r-coach", roleName: "Team coach", scopeType: "team", scopeId: "t1", source: "assignment", roleItems: ["org.view", "calendar.edit"], custom: { id: "c1", live: true, revision: 1, items: ["org.view"], added: [], removed: ["calendar.edit"] }, stillHeldThrough: [{ word: "org.view", roles: ["Video analyst"] }] }],
  },
  teams: [{ id: "t1", name: "U19" }], drift: [], editKey: "", endKey: "", draft: null, changes: { add: [], remove: [] }, reason: "", endReason: "",
  onPick: noop, onCheck: noop, onDriftRemove: noop, onEdit: noop, onCancel: noop, onToggle: noop, onReason: noop, onSave: noop, onAskEnd: noop, onEndReason: noop, onEnd: noop,
  ...over,
});

test("6. a person's roles: \"(custom)\", what differs, Still has it through, Change and Back to the role", () => {
  const el = host();
  islands.mountIsland(el, islands.PersonAccess, personProps());
  const h = el.querySelector("[data-person-holding]");
  assert.match(h.textContent, /Team coach \(custom\)/);
  assert.match(h.textContent, /Team · U19/);
  assert.match(h.textContent, /Taken away for Ana Test: /);
  assert.match(h.textContent, /Still has it through Video analyst/);
  const labels = [...h.querySelectorAll("button")].map((b) => b.textContent);
  assert.ok(labels.includes("Change for Ana Test") && labels.includes("Back to Team coach"));
  assert.equal(el.querySelector("select").options.length, 3);
  islands.unmountIsland(el);
});

test("7. blocked: the caller's own access, and a club administrator unless a platform admin", () => {
  const el = host();
  islands.mountIsland(el, islands.PersonAccess, personProps({ selfId: "u1" }));
  assert.match(el.textContent, /You can't change your own access\./);
  assert.ok(![...el.querySelectorAll("button")].some((b) => /Change for/.test(b.textContent)));
  const adminView = { name: "Bo Test", closedModules: [], customHistory: [], holdings: [{ roleId: "r-admin", roleName: "Club admin", scopeType: "club", scopeId: "club", source: "basic", roleItems: ["org.view"], custom: null, stillHeldThrough: [] }] };
  islands.mountIsland(el, islands.PersonAccess, personProps({ userId: "u2", view: adminView }));
  assert.match(el.textContent, /Only OptiMove can change a club administrator\./);
  islands.mountIsland(el, islands.PersonAccess, personProps({ userId: "u2", view: adminView, platform: true }));
  assert.doesNotMatch(el.textContent, /Only OptiMove can change/);
  islands.unmountIsland(el);
});

test("8. drift: who still has what, with Take it from them too per word", () => {
  const removed = [];
  const el = host();
  islands.mountIsland(el, islands.PersonAccess, personProps({ drift: [{ customId: "c1", userId: "u1", name: "Ana Test", roleId: "r-coach", roleName: "Team coach", words: ["calendar.edit"] }], onDriftRemove: (r, w) => removed.push([r, w]) }));
  const drift = el.querySelector("[data-person-drift]");
  assert.match(drift.textContent, /1 person still has permissions their role no longer gives/);
  click([...drift.querySelectorAll("button")].find((b) => b.textContent === "Take it from them too"));
  assert.deepEqual(removed, [["r-coach", "calendar.edit"]]);
  islands.unmountIsland(el);
});
