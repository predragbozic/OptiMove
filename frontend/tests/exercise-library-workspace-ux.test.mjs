import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderExerciseLibraryHtml, renderExerciseOwnerOptions } from "../exercise-library.js";
import { exerciseSearchUrl } from "../exercise-data.js";
import { state, emptyExerciseFilters, emptyExerciseOptions } from "../state.js";
import { clearAllViewCache } from "../view-cache.js";

const initialDom = new JSDOM("<body></body>");
globalThis.document = initialDom.window.document;
globalThis.window = initialDom.window;
const { loadExercises, handleExerciseLibraryAction, resetExercisesForWorkspaceChange } = await import("../exercise-actions.js");
const { els } = await import("../dom.js");
initialDom.window.close();

const mine = { id: "my-id", name: "Same Name", email: "mine@test.local" };
const other = { id: "other-id", name: "Same Name", email: "other@test.local" };

function setup(admin = false) {
  const dom = new JSDOM('<body><div id="toolbar"></div><main id="content"></main></body>');
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  els.toolbar = document.querySelector("#toolbar");
  els.content = document.querySelector("#content");
  state.currentUser = { id: mine.id, activeWorkspace: { type: admin ? "platform" : "private_coach" }, platformRoles: ["platform_admin"] };
  state.exerciseSearch = { filters: emptyExerciseFilters(), options: { ...emptyExerciseOptions(), purposes: ["Strength"], ...(admin ? { owners: [mine] } : {}) }, term: "", limit: 30 };
  state.markedExercises = new Map();
  state.markedExerciseIds = new Set();
  state.activeTab = "exercises";
  clearAllViewCache();
  return dom;
}

const handlers = () => ({ setLoading() {}, renderExercises() {} });

test("all advanced filters live inside the existing disclosure and use the normal controls", async () => {
  const dom = setup(true);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ exercises: [], canManageCollections: true }) });
  await loadExercises(handlers());
  const panel = document.querySelector("details.builder-exercise-filters");
  for (const key of ["kind", "visibility", "hidden", "owner", "searchIn"]) {
    const control = document.querySelector(`[data-exercise-filter="${key}"]`);
    assert.ok(panel.contains(control), key);
    assert.ok(control.classList.contains("builder-text-input"), key);
  }
  assert.equal(els.toolbar.firstElementChild.querySelector("input").id, "exerciseSearch");
  assert.equal(panel.querySelectorAll('input[type="checkbox"]').length, 0);
  assert.match(panel.textContent, /System \+ my exercises[\s\S]*System exercises[\s\S]*My private exercises/);
  dom.window.close();
});

test("normal search matches name/code; broad tag/classification search is explicit and owner selection is scoped", () => {
  let url = new URL(exerciseSearchUrl("Proba", 30), "https://test.local");
  assert.equal(url.searchParams.get("searchIn"), "name");
  assert.equal(url.searchParams.get("kind"), "accessible");
  url = new URL(exerciseSearchUrl("Proba", 30, { searchIn: "all", owner: other.id }), "https://test.local");
  assert.equal(url.searchParams.get("searchIn"), "all");
  assert.equal(url.searchParams.get("kind"), "private");
  assert.equal(url.searchParams.get("owner"), other.id);
});

test("owner lookup is on demand and same-name accounts are distinguished with email", async () => {
  const dom = setup(true);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url.includes("/owners?") ? { owners: [mine, other], hasMore: false } : { exercises: [] } };
  };
  await loadExercises(handlers());
  assert.equal(requests.filter((url) => url.includes("/owners?")).length, 0);
  const input = document.querySelector("[data-exercise-owner-search]");
  input.value = "Same";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(requests.filter((url) => url.includes("/owners?search=Same")).length, 1);
  const options = [...document.querySelector('[data-exercise-filter="owner"]').options];
  assert.match(options[1].textContent, /My account.*mine@test.local/);
  assert.match(options[2].textContent, /other@test.local/);
  const ownerSelect = document.querySelector('[data-exercise-filter="owner"]');
  ownerSelect.value = other.id;
  ownerSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(state.exerciseSearch.filters.kind, "private");
  assert.equal(document.querySelector('[data-exercise-filter="kind"]').value, "private");
  const html = renderExerciseOwnerOptions([{ id: '"bad', name: "<script>", email: "x@test.local" }]);
  assert.doesNotMatch(html, /<script>/);
  dom.window.close();
});

test("workspace switch removes admin filters, stale results and editors without changing the real role", () => {
  const dom = setup(true);
  state.exerciseSearch.filters.owner = other.id;
  state.exerciseSearch.filters.kind = "all";
  state.exerciseSearch.canManageCollections = true;
  state.lastExerciseResults = [{ id: "foreign" }];
  state.exerciseEditor.open = true;
  document.body.insertAdjacentHTML("beforeend", '<section class="exercise-classification-overlay"></section>');
  resetExercisesForWorkspaceChange();
  assert.equal(state.exerciseSearch.options.owners, undefined);
  assert.equal(state.exerciseSearch.filters.owner, undefined);
  assert.equal(state.exerciseSearch.canManageCollections, false);
  assert.deepEqual(state.lastExerciseResults, []);
  assert.equal(state.exerciseEditor.open, false);
  assert.equal(document.querySelector(".exercise-classification-overlay"), null);
  assert.deepEqual(state.currentUser.platformRoles, ["platform_admin"]);
  dom.window.close();
});

test("every layout offers private Delete but never exposes system Edit from stale admin row flags", () => {
  for (const view of ["details", "tile", "big", "list"]) {
    const render = (exercise) => renderExerciseLibraryHtml({ exercises: [exercise], itemIds: ["item"], markedExerciseIds: new Set(), search: { view, filters: {}, canManageCollections: false }, tagEditor: {} });
    assert.match(render({ id: "mine", owner_scope: "user", can_edit: true }), /exercise-delete/);
    assert.doesNotMatch(render({ id: "system", owner_scope: "system", can_edit: true }), /exercise-delete|exercise-edit-open|exercise-archive/);
  }
});

test("permanent Delete Cancel never writes; confirmation sends the explicit API and clears local marks", async () => {
  const dom = setup();
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => options.method === "DELETE" ? { deleted: true } : { exercises: [] } };
  };
  const action = { dataset: { action: "exercise-delete", exerciseId: "mine" } };
  window.confirm = () => false;
  await handleExerciseLibraryAction(action, handlers());
  assert.equal(requests.length, 0);
  state.markedExercises.set("mine", { id: "mine" });
  state.markedExerciseIds.add("mine");
  window.confirm = () => true;
  await handleExerciseLibraryAction(action, handlers());
  assert.equal(requests[0].url, "/api/exercises/mine/permanent");
  assert.equal(requests[0].method, "DELETE");
  assert.equal(state.markedExercises.has("mine"), false);
  assert.equal(state.markedExerciseIds.has("mine"), false);
  dom.window.close();
});

test("mobile header constrains the workspace label and keeps status on its own row", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace-toggle-label\s*\{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/s);
  assert.match(css, /grid-template-columns: 40px minmax\(0, 1fr\) repeat\(3, 40px\)/);
  assert.match(css, /\.topbar-actions \.status-pill\s*\{[^}]*grid-column: 1 \/ -1/s);
});
