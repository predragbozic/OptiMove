import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DELETE_CLIENT_BOUND_MS, openExerciseCollections } from "../exercise-collections.js";
import { renderExerciseBlocksHtml } from "../exercise-blocks.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const block = () => ({
  id: "block-one", name: "Speed", description: "", revision: 4, coverImageUrl: "", accessAll: false,
  blockPreview: "hidden", exercisePreview: "hidden",
  exercises: [{ id: "exercise-one", name: "Skip" }, { id: "exercise-two", name: "Bound" }], users: [{ id: "coach-one", name: "Coach" }],
});

// The editor against a fake of the block routes: GET list, GET options,
// PATCH and DELETE; `answer` decides the DELETE's answer.
async function openEditor({ answer = () => ({ ok: true, json: async () => ({ deleted: { id: "block-one" } }) }), confirm = () => true } = {}) {
  const dom = new JSDOM("<button id='opener'>Manage blocks</button>");
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const prompts = [];
  window.confirm = (text) => { prompts.push(text); return confirm(text); };
  let stored = block();
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined });
    if (options.method === "DELETE") return answer();
    if (options.method === "PATCH") {
      stored = { ...stored, ...JSON.parse(options.body), revision: stored.revision + 1 };
      return { ok: true, json: async () => ({ collection: stored }) };
    }
    return { ok: true, json: async () => String(url).includes("/options") ? { exercises: [], users: [] } : { collections: [stored] } };
  };
  let refreshed = 0;
  await openExerciseCollections(async () => { refreshed += 1; }, "block-one");
  return { dom, prompts, requests, refreshed: () => refreshed };
}

test("Delete block names the consequence, sends the loaded revision once and leaves the editor on a new block", async () => {
  const { dom, prompts, requests, refreshed } = await openEditor();
  // The draft's name is edited but not saved: the delete still sends the loaded block.
  const name = document.querySelector("[data-block-name]");
  name.value = "Speed renamed";
  name.dispatchEvent(new window.Event("input"));
  document.querySelector("[data-delete-block]").click();
  await settle();
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Delete the block “Speed”\?/);
  assert.match(prompts[0], /Its 2 exercises move to Other and become available to all coaches/);
  assert.match(prompts[0], /unsaved changes to this block are discarded/);
  assert.match(prompts[0], /cannot be restored/);
  const deletes = requests.filter((request) => request.method === "DELETE");
  assert.deepEqual(deletes, [{ url: "/api/exercise-collections/block-one", method: "DELETE", body: { expectedRevision: 4 } }]);
  assert.equal(refreshed(), 1);
  const status = document.querySelector(".exercise-block-deleted");
  assert.match(status.textContent, /“Speed” was deleted\. Its exercises are now in Other\./);
  assert.ok(status.compareDocumentPosition(document.querySelector("[data-block-select]")) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the notice sits above the form, in view");
  assert.equal(document.querySelector("[data-block-select]").value, "");
  assert.equal([...document.querySelectorAll("[data-block-select] option")].some((option) => option.value === "block-one"), false);
  assert.equal(document.querySelector("[data-delete-block]"), null);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("a declined confirmation sends nothing; a new block has no Delete", async () => {
  const { dom, requests } = await openEditor({ confirm: () => false });
  document.querySelector("[data-delete-block]").click();
  await settle();
  assert.equal(requests.some((request) => request.method === "DELETE"), false);
  assert.ok(document.querySelector("[data-delete-block]"));
  const select = document.querySelector("[data-block-select]");
  select.value = "";
  select.dispatchEvent(new window.Event("change"));
  assert.equal(document.querySelector("[data-delete-block]"), null);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("a refused or lost delete keeps the block and says why", async () => {
  for (const [answer, sentence] of [
    [() => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "staleRevision" }) }), /changed elsewhere\. Close and reopen it before deleting/],
    [() => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({ error: "notFound" }) }), /already deleted, or you no longer have permission/],
    [() => ({ ok: false, status: 500, statusText: "Error", json: async () => ({ error: "internalError" }) }), /Delete was not confirmed/],
    [() => { throw new TypeError("Failed to fetch"); }, /Delete was not confirmed/],
  ]) {
    const { dom, refreshed } = await openEditor({ answer });
    document.querySelector("[data-delete-block]").click();
    await settle();
    assert.match(document.querySelector("[role='alert']").textContent, sentence);
    assert.equal(document.querySelector("[data-block-select]").value, "block-one");
    assert.ok(document.querySelector("[data-delete-block]"));
    assert.equal(refreshed(), 0);
    document.querySelector("[data-close-collections]").click();
    dom.window.close();
  }
});

// A DELETE that is never answered, until the request is aborted (or the
// test lets it go with `release`).
const hanging = (requests) => (url, options) => new Promise((_, reject) => {
  const fail = () => reject(new DOMException("The operation was aborted.", "AbortError"));
  requests.push({ url: String(url), release: fail });
  options.signal?.addEventListener("abort", fail);
});
const microtasks = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

test("a delete whose answer never comes is not confirmed after the client bound, and the editor can close", async () => {
  const pending = [];
  const { dom, refreshed } = await openEditor({ answer: () => null });
  const plain = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => (options.method === "DELETE" ? hanging(pending)(url, options) : plain(url, options));
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    document.querySelector("[data-delete-block]").click();
    await microtasks();
    assert.equal(document.querySelector("[data-delete-block]").textContent, "Deleting...");
    assert.equal(document.querySelector("[data-delete-block]").disabled, true);
    mock.timers.tick(DELETE_CLIENT_BOUND_MS);
    await microtasks();
  } finally { mock.timers.reset(); }
  assert.equal(pending.length, 1);
  assert.match(document.querySelector("[role='alert']").textContent, /Delete was not confirmed/);
  assert.equal(document.querySelector("[data-block-select]").value, "block-one");
  assert.equal(document.querySelector("[data-delete-block]").disabled, false);
  assert.equal(refreshed(), 0);
  document.querySelector("[data-close-collections]").click();
  assert.equal(document.querySelector(".exercise-collections-overlay"), null, "Close works again");
  dom.window.close();
});

test("a second click while a delete is in flight sends nothing more", async () => {
  const pending = [];
  const { dom } = await openEditor();
  const plain = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => (options.method === "DELETE" ? hanging(pending)(url, options) : plain(url, options));
  const first = document.querySelector("[data-delete-block]");
  first.click();
  await microtasks();
  first.click();
  document.querySelector("[data-delete-block]").click();
  await microtasks();
  assert.equal(pending.length, 1);
  pending[0].release();
  await settle();
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("renaming is the name field plus Save, which keeps the block's exercises and users", async () => {
  const { dom, requests } = await openEditor();
  assert.match(document.body.textContent, /To rename this block, change its name and save/);
  const name = document.querySelector("[data-block-name]");
  name.value = "Speed and agility";
  name.dispatchEvent(new window.Event("input"));
  document.querySelector("[data-save-block]").click();
  await settle();
  const patch = requests.find((request) => request.method === "PATCH");
  assert.equal(patch.url, "/api/exercise-collections/block-one");
  assert.equal(patch.body.name, "Speed and agility");
  assert.equal(patch.body.expectedRevision, 4);
  assert.deepEqual(patch.body.exerciseIds, ["exercise-one", "exercise-two"]);
  assert.deepEqual(patch.body.userIds, ["coach-one"]);
  document.querySelector("[data-close-collections]").click();
  dom.window.close();
});

test("each administrator block card says Edit block", () => {
  const html = renderExerciseBlocksHtml({ blocks: [{ id: "b", name: "Speed", exerciseCount: 1, coverImageUrl: "" }],
    other: { id: "other", name: "Other", exerciseCount: 0, coverImageUrl: "" }, canManageCollections: true });
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('[data-collection-id="b"]').textContent, "Edit block");
  dom.window.close();
});
