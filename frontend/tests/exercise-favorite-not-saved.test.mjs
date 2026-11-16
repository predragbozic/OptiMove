// A favorite that could not be saved is said beside the star that was pressed - one sentence and "Try again" - in
// the library's card, the library's icon row and the Builder's result; the star keeps its state; nothing is left as
// an unhandled rejection (api.js has already reported the failed call once). Invented data only.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<main id="content"></main>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state, emptyBuilderState } = await import("../state.js");
const { handleExerciseLibraryAction, favoriteNotSavedHtml } = await import("../exercise-actions.js");
const originalFetch = globalThis.fetch;
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
after(() => { globalThis.fetch = originalFetch; process.off("unhandledRejection", onUnhandled); });
const settle = () => new Promise((r) => setTimeout(r, 20));
const SENTENCE = "The favorite was not saved. Try again";
const STAR = (favorite) => `<button type="button" data-action="exercise-toggle-favorite" data-exercise-id="ex-1" data-favorite="${favorite}">star</button>`;
const PLACES = { "library card": "exercise-card-actions", "library icon row": "exercise-view-actions", "builder result": "builder-exercise-mini-actions" };
let calls;
let renders;
const handlers = { setLoading: () => {}, renderExercises: () => { renders += 1; }, renderBuilder: () => {} };
const mount = (cls, favorite = "false") => {
  document.body.innerHTML = `<article><div class="${cls}">${STAR(favorite)}<button type="button" data-action="exercise-toggle-mark">mark</button></div></article><article><div class="${cls}" id="other">${STAR("false").replace("ex-1", "ex-2")}</div></article>`;
  return document.querySelector(`.${cls}`);
};
const press = async (el) => { const handled = await handleExerciseLibraryAction(el, handlers); await settle(); return handled; };

beforeEach(() => {
  state.activeTab = "exercises";
  state.builder = emptyBuilderState();
  calls = []; renders = 0; unhandled.length = 0;
  globalThis.fetch = async (path, options = {}) => { calls.push(`${options.method || "GET"} ${path}`); throw new TypeError("Failed to fetch"); };
});

for (const [place, cls] of Object.entries(PLACES)) {
  test(`${place}: a failed save says so beside the star, once, with Try again; the star keeps its state; no unhandled rejection`, async () => {
    const actions = mount(cls);
    const star = actions.querySelector('[data-action="exercise-toggle-favorite"]');
    assert.equal(await press(star), true);
    assert.deepEqual(calls, ["POST /api/exercises/ex-1/favorite"]);
    assert.deepEqual(unhandled, []);
    const note = actions.querySelector(".exercise-favorite-failed");
    assert.equal(note.getAttribute("role"), "status");
    assert.equal(note.textContent.trim(), SENTENCE);
    assert.equal(actions.lastElementChild, note, "inside the actions it belongs to, after them");
    assert.equal(star.dataset.favorite, "false", "the star is as it was");
    assert.equal(document.querySelector("#other .exercise-favorite-failed"), null, "only at the exercise that was pressed");
    assert.equal(renders, 0, "nothing else on the screen is redrawn");
    // Try again repeats the same press; failing again leaves one note, not two.
    const retry = note.querySelector("button");
    assert.deepEqual([retry.dataset.action, retry.dataset.exerciseId, retry.dataset.favorite, retry.textContent], ["exercise-toggle-favorite", "ex-1", "false", "Try again"]);
    await press(retry);
    assert.deepEqual(calls, ["POST /api/exercises/ex-1/favorite", "POST /api/exercises/ex-1/favorite"]);
    assert.equal(actions.querySelectorAll(".exercise-favorite-failed").length, 1);
    assert.deepEqual(unhandled, []);
    // The server answers: the note goes and the list is refreshed.
    globalThis.fetch = async (path, options = {}) => { calls.push(`${options.method || "GET"} ${path}`); return { ok: true, status: 200, json: async () => ({ ok: true, exercises: [], ids: [] }) }; };
    await press(actions.querySelector(".exercise-favorite-failed button"));
    assert.equal(calls[2], "POST /api/exercises/ex-1/favorite");
    assert.equal(actions.querySelector(".exercise-favorite-failed"), null);
    assert.deepEqual(unhandled, []);
  });
}

test("removing a favorite that fails: the retry removes again; the saved change whose refresh fails is still no unhandled rejection", async () => {
  const actions = mount("exercise-view-actions", "true");
  await press(actions.querySelector('[data-action="exercise-toggle-favorite"]'));
  assert.deepEqual(calls, ["DELETE /api/exercises/ex-1/favorite"]);
  assert.equal(actions.querySelector(".exercise-favorite-failed button").dataset.favorite, "true");
  assert.equal(actions.querySelector(".exercise-favorite-failed").textContent.trim(), "The favorite was not removed. Try again", "a star that was on says what did not happen");
  // The save succeeds and every later request fails.
  globalThis.fetch = async (path, options = {}) => { calls.push(`${options.method || "GET"} ${path}`); if (String(path).endsWith("/favorite")) return { ok: true, status: 200, json: async () => ({ ok: true }) }; throw new TypeError("Failed to fetch"); };
  await press(actions.querySelector(".exercise-favorite-failed button"));
  assert.deepEqual(unhandled, []);
  assert.equal(document.querySelector(".exercise-favorite-failed"), null, "the save itself did not fail");
  // The same in the Builder, whose list rejects when it cannot be refreshed (and says so in its own place).
  state.activeTab = "builder";
  state.builder = emptyBuilderState({ selectedNodeId: "section-1" });
  const result = mount("builder-exercise-mini-actions");
  await press(result.querySelector('[data-action="exercise-toggle-favorite"]'));
  assert.equal(state.builder.exerciseLoadFailed, true, "the list did fail to refresh");
  assert.deepEqual(unhandled, []);
  assert.equal(result.querySelector(".exercise-favorite-failed"), null);
});

test("the sentence: the app's own spelling, escaped ids, and a 44 px Try again that never widens the actions", async () => {
  assert.equal(favoriteNotSavedHtml(`x"><img src=x>`, true).includes("<img"), false);
  assert.match(favoriteNotSavedHtml("ex-1", true), /data-favorite="true"/);
  for (const file of ["exercise-library.js", "builder-exercises.js"]) assert.match(await readFile(new URL(`../${file}`, import.meta.url), "utf8"), /Mark as favorite/, "the spelling the star already uses");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const rule = (selector) => { const at = css.indexOf(selector === ".exercise-favorite-failed" ? `${selector} {` : `${selector},`); assert.ok(at > 0, selector); return css.slice(at, css.indexOf("}", at)); };
  assert.match(rule(".exercise-favorite-failed"), /flex: 1 0 100%/);
  assert.match(rule(".exercise-favorite-failed"), /min-width: 0/);
  assert.match(rule(".exercise-favorite-failed .text-action"), /min-height: 44px/);
  assert.match(rule(".exercise-favorite-failed .text-action"), /min-width: 44px/);
  assert.match(css, /:is\(\.exercise-card-actions, \.exercise-view-actions, \.builder-exercise-mini-actions\):has\(> \.exercise-favorite-failed\) \{ flex-wrap: wrap; \}/);
  // No press of the star is started without its control: the message needs to know where it was pressed.
  assert.match(await readFile(new URL("../exercise-actions.js", import.meta.url), "utf8"), /void toggleExerciseFavorite\(action\.dataset\.exerciseId, action\.dataset\.favorite === "true", handlers, action\);/);
});
