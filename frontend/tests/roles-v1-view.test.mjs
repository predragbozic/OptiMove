// Roles V-1 (docs/ai/roles-v-steps-plan.md sections 2.1 and 2.2): what a view workspace (club_view / team_view) shows of
// Data configuration and Tags & Presets - read only, in the reduced (coach) view, never a write control. Every route
// still decides again (backend/tests/roles-v-sweep.test.mjs tests 5 and 6). Invented names only.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

let state;
let variablesContext;
let renderTrainingLoadCoachHtml;
let renderTaxonomyPanelHtml;
let renderVariablesHtml;

const CLUB = "11111111-0000-4000-8000-0000000000c1";
const TEAM = "22222222-0000-4000-8000-0000000000t1".replace("t", "a");
const CLUB_VIEW = { type: "club_view", scopeId: CLUB, label: "Test Club", role: "role_holder" };
const TEAM_VIEW = { type: "team_view", scopeId: TEAM, clubId: CLUB, label: "Test Team", role: "role_holder" };
const as = (activeWorkspace, permissions) => {
  state.currentUser = { id: "u1", name: "Viewer A", activeWorkspace, availableWorkspaces: [activeWorkspace], clubs: [], teams: [], permissions };
};

before(async () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent", "MutationObserver", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: key === "window" ? dom.window : dom.window[key], configurable: true, writable: true });
  }
  ({ state } = await import("../state.js"));
  ({ variablesContext } = await import("../metric-variables-data.js"));
  ({ renderTrainingLoadCoachHtml } = await import("../training-load-view.js"));
  ({ renderTaxonomyPanelHtml } = await import("../taxonomy-view.js"));
  ({ renderVariablesHtml } = await import("../metric-variables-view.js"));
});

test("1. variablesContext: a view workspace with variables.view reads its club in the reduced view, read only; without the word, nothing", () => {
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  assert.deepEqual(variablesContext(), { owner: "club", clubId: CLUB, clubName: "Test Club", view: "coach", readOnly: true, teamName: "", basis: null });
  as(TEAM_VIEW, ["org.view", "variables.view"]);
  const team = variablesContext();
  assert.equal(team.clubId, CLUB, "a team view reads its team's club");
  assert.equal(team.readOnly, true);
  assert.equal(team.teamName, "Test Team");
  as(CLUB_VIEW, ["org.view", "presets.use"]);
  assert.equal(variablesContext(), null);
  as({ ...TEAM_VIEW, clubId: undefined }, ["org.view", "variables.view"]);
  assert.equal(variablesContext(), null, "a team view without its club reads nothing");
  // The coach workspaces keep their own context.
  as({ type: "club", scopeId: CLUB, label: "Test Club" }, ["variables.view"]);
  assert.equal(variablesContext().view, "admin");
  assert.equal(variablesContext().readOnly, undefined);
});

test("2. Training Load in a view workspace: only the Data configuration space, no Schedule, Data & Analysis or Filter", () => {
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  state.trainingLoad.section = "variables";
  const box = document.createElement("div");
  box.innerHTML = renderTrainingLoadCoachHtml();
  const tabs = [...box.querySelectorAll(".training-load-tab")].map((b) => b.textContent.trim());
  assert.deepEqual(tabs, ["Data configuration"]);
  assert.equal(box.querySelector('[data-section="schedule"]'), null);
  assert.equal(box.querySelector('[data-action="training-load-filter-open"]'), null);
  // A coach workspace keeps every space.
  as({ type: "club", scopeId: CLUB, label: "Test Club" }, ["variables.view"]);
  box.innerHTML = renderTrainingLoadCoachHtml();
  assert.deepEqual([...box.querySelectorAll(".training-load-tab")].map((b) => b.textContent.trim()), ["Schedule", "Data & Analysis", "Data configuration"]);
});

test("3. the Variables list of a view workspace offers no New variable and says it only reads", () => {
  as(CLUB_VIEW, ["org.view", "variables.view"]);
  const s = state.trainingLoad.variables;
  s.view = "variables";
  s.form = null;
  s.detail = { ...(s.detail || {}), id: null };
  s.scope = "own";
  s.list = { ...(s.list || {}), loaded: true, loading: false, error: "", items: [], nextCursor: null };
  const box = document.createElement("div");
  box.innerHTML = renderVariablesHtml();
  assert.equal(box.querySelector('[data-action="metric-variables-create-open"]'), null);
  assert.match(box.textContent, /You can look at them here/);
});

test("4. Tags & Presets in a view workspace: the rows, no Add, no remove and no positions; a coach workspace keeps them", () => {
  state.taxonomy.nodePresets = [{ id: "p1", node_type: "domain", name: "Speed block", color: "#FFD3D3" }];
  state.taxonomy.templateTags = [{ id: "t1", name: "Pre-season" }];
  state.taxonomy.libraryRows = { domain: [], category: [], section: [], tag: [{ id: "l1", name: "Agility" }], attractor: [] };
  state.taxonomy.addOpenKind = "template-tag";
  as(CLUB_VIEW, ["org.view", "presets.use"]);
  const box = document.createElement("div");
  box.innerHTML = renderTaxonomyPanelHtml({ clubs: [], teams: [] });
  for (const name of ["Speed block", "Pre-season", "Agility"]) assert.match(box.textContent, new RegExp(name));
  assert.equal(box.querySelectorAll('[data-action="taxonomy-toggle-add"]').length, 0, "no Add");
  assert.equal(box.querySelectorAll('[data-action="taxonomy-remove"]').length, 0, "no remove");
  assert.equal(box.querySelectorAll("form").length, 0, "no add form, even when one was open");
  assert.match(box.textContent, /an administrator of the club adds and changes them/);
  assert.equal(box.textContent.includes("Positions"), false, "no positions (the Athletes module's)");
  as({ type: "club", scopeId: CLUB, label: "Test Club" }, ["presets.use"]);
  box.innerHTML = renderTaxonomyPanelHtml({ clubs: [], teams: [] });
  assert.ok(box.querySelectorAll('[data-action="taxonomy-toggle-add"]').length > 0, "a coach keeps Add");
  assert.ok(box.querySelectorAll('[data-action="taxonomy-remove"]').length > 0, "and remove");
  assert.ok(box.textContent.includes("Positions"), "and the positions");
  state.taxonomy.addOpenKind = "";
});

test("5. the tags and presets are read again after a workspace switch: onWorkspaceChanged resets them to the initial shape", async () => {
  const { emptyTaxonomyState } = await import("../state.js");
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const body = src.match(/async function onWorkspaceChanged\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /state\.taxonomy = emptyTaxonomyState\(\);/);
  assert.deepEqual(emptyTaxonomyState(), { loaded: false, error: "", nodePresets: [], templateTags: [], libraryRows: { domain: [], category: [], section: [], tag: [], attractor: [] }, addOpenKind: "" });
  assert.notEqual(emptyTaxonomyState().libraryRows, emptyTaxonomyState().libraryRows, "a fresh object each time");
});
