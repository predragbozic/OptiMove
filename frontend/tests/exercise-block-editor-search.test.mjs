import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { OPTION_SEARCH_DELAY_MS, openExerciseCollections } from "../exercise-collections.js";

const microtasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

// The block editor against a fake of its two reads; each options read is
// answered with what its search asked for.
async function openEditor() {
  const dom = new JSDOM("<button id='opener'>Manage blocks</button>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  window.confirm = () => true;
  const searches = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url), "http://app.test");
    if (address.pathname.endsWith("/options")) {
      const term = address.searchParams.get("exerciseSearch") || "";
      searches.push({ exercises: term, users: address.searchParams.get("userSearch") || "" });
      return { ok: true, json: async () => ({ exercises: [{ id: `match-${term || "all"}`, name: `Match ${term || "all"}` }], users: [] }) };
    }
    return { ok: true, json: async () => ({ collections: [] }) };
  };
  await openExerciseCollections(async () => {});
  return { dom, searches };
}

test("typing filters the block's exercise choices without a Search button: one read after the pause, the field keeps focus and caret", async () => {
  const { dom, searches } = await openEditor();
  assert.equal(document.querySelector("[data-find-kind]"), null, "no Search button");
  assert.equal(searches.length, 1, "the editor's first read");
  const before = { field: document.querySelector("[data-search-kind='exercises']"), modal: document.querySelector(".exercise-editor-modal") };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const field = document.querySelector("[data-search-kind='exercises']");
    field.focus();
    for (const value of ["s", "sk", "ski"]) {
      field.value = value;
      field.setSelectionRange(value.length, value.length);
      field.dispatchEvent(new window.Event("input"));
      mock.timers.tick(OPTION_SEARCH_DELAY_MS - 50);
    }
    await microtasks();
    assert.equal(searches.length, 1, "nothing is read while the coach is still typing");
    mock.timers.tick(50);
    await microtasks();
  } finally { mock.timers.reset(); }
  assert.deepEqual(searches.at(-1), { exercises: "ski", users: "" });
  assert.equal(searches.length, 2, "one read for the whole word");
  assert.match(document.querySelector("[data-pick-kind='exercises']").closest("label").textContent, /Match ski/);
  const field = document.querySelector("[data-search-kind='exercises']");
  // Only the choice lists change: the field and the scrolling form are the
  // same elements, so a phone keeps its keyboard and its scroll position.
  assert.equal(field, before.field);
  assert.equal(document.querySelector(".exercise-editor-modal"), before.modal);
  assert.equal(document.activeElement, field, "typing goes on in the same field");
  assert.equal(field.value, "ski");
  assert.equal(field.selectionStart, 3);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("Enter searches at once, and the user picker filters the same way", async () => {
  const { dom, searches } = await openEditor();
  const users = document.querySelector("[data-search-kind='users']");
  users.value = "coach";
  users.dispatchEvent(new window.Event("input"));
  users.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await microtasks();
  assert.deepEqual(searches.at(-1), { exercises: "", users: "coach" });
  assert.equal(searches.length, 2);
  // The pending pause was cancelled by Enter: no second read for the same word.
  await new Promise((resolve) => setTimeout(resolve, OPTION_SEARCH_DELAY_MS + 50));
  assert.equal(searches.length, 2);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("a choice ticked in a filtered list is kept and counted", async () => {
  const { dom } = await openEditor();
  const field = document.querySelector("[data-search-kind='exercises']");
  field.value = "ski";
  field.dispatchEvent(new window.Event("input"));
  field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await microtasks();
  const pick = document.querySelector("[data-pick-kind='exercises'][data-id='match-ski']");
  pick.checked = true;
  pick.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(document.querySelector("[data-add-selected='exercises']").textContent, "Add selected (1)");
  assert.equal(document.querySelector("[data-add-selected='exercises']").disabled, false);
  document.querySelector("[data-add-selected='exercises']").click();
  assert.match(document.querySelector("[data-remove-kind='exercises']").textContent, /Match ski/);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("a search after a shown message still replaces only the lists, and the message goes", async () => {
  const { dom } = await openEditor();
  document.querySelector("[data-save-block]").click();
  assert.match(document.querySelector("[data-block-error]").textContent, /Enter a block name/);
  const field = document.querySelector("[data-search-kind='exercises']");
  field.value = "ski";
  field.dispatchEvent(new window.Event("input"));
  field.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
  await microtasks();
  assert.equal(document.querySelector("[data-search-kind='exercises']"), field, "the field is never replaced");
  assert.equal(document.querySelector("[data-block-error]"), null);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});
