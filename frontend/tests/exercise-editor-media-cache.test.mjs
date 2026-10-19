import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Pilot E5 (2026-10-19): the signed addresses are cached per (context,
// slot) and the resolver writes the cached object back onto a card, so a
// saved frame / Replace / Remove kept showing the previous object until the
// address expired or the page reloaded. A successful Save of an existing
// exercise now forgets exactly that exercise's context; a failed Save, a
// private copy and every other context keep their cache; an answer that
// lands after a forget is never kept.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const playback = await import("../media-playback.js");
const { STORAGE_ROUTE } = await import("../exercise-media-upload.js");
const { ACCESS_ROUTE, ACCESS_BATCH_ROUTE } = playback;

const content = document.querySelector("#content");
const state = { currentUser: { id: "u1" } };
const ctx = (id, type = "exercise") => ({ type, id });
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const asset = (mediaId, url) => ({ source: "asset", mediaId, url, expiresAt: minutesFromNow(10), mimeType: "image/jpeg" });

const account = () => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "710083", reservedBytes: "0", limitBytes: "1000000000",
  availableBytes: "999289917", limitSource: "override", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], revision: 1,
});
const detail = () => ({
  id: "e1", ownerScope: "user", canEdit: true, name: "R2 pilot test", videoUrl: "", imageUrl: "", tags: [],
  media: { video: { source: "asset", mediaId: "vid-old" }, image: { source: "asset", mediaId: "img-old" }, accessContext: ctx("e1") },
});

// The objects the server answers per (context, slot); `set` replaces them, as a Save does.
const objects = new Map();
const setObject = (context, slot, mediaId, url) => objects.set(`${context.type}/${context.id}/${slot}`, asset(mediaId, url));
const pick = (context, slot) => objects.get(`${context.type}/${context.id}/${slot}`) || null;

// The API fake: the storage, the detail, the save (ok or `patchStatus`), the two access routes (gated by `gate` when given).
function fakeApi({ patchStatus = 200, gate = null } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith(STORAGE_ROUTE)) return { ok: true, status: 200, json: async () => ({ accounts: [account()], selectedStorageAccountId: "acc-1" }) };
    // The access answers are composed when the request arrives (the objects of
    // that moment) and, with a gate, delivered only once the test releases it.
    if (call.url === ACCESS_BATCH_ROUTE) {
      const results = call.body.requests.map((request, index) => {
        const media = {};
        for (const slot of request.slots) {
          const entry = pick(request.context, slot);
          if (entry) media[slot] = entry;
        }
        return { index, media };
      });
      if (gate) await gate();
      return { ok: true, status: 200, json: async () => ({ results }) };
    }
    if (call.url === ACCESS_ROUTE) {
      const answer = {};
      for (const slot of call.body.slots) {
        const entry = pick(call.body.context, slot);
        if (entry) answer[slot] = entry;
      }
      if (gate) await gate();
      return { ok: true, status: 200, json: async () => answer };
    }
    if (call.url === "/api/exercises/e1" && call.method === "GET") return { ok: true, status: 200, json: async () => detail() };
    if (call.url === "/api/exercises/e1" && call.method === "PATCH") {
      if (patchStatus !== 200) return { ok: false, status: patchStatus, statusText: "Error", json: async () => ({ error: "saveFailed" }) };
      return { ok: true, status: 200, json: async () => ({ id: "e1" }) };
    }
    if (call.url === "/api/exercises/e1/copy" && call.method === "POST") return { ok: true, status: 200, json: async () => ({ id: "e2" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound" }) };
  };
  return calls;
}

const batchCalls = (calls) => calls.filter((call) => call.url === ACCESS_BATCH_ROUTE);
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const save = (h) => editor.handleExerciseEditorAction(state, h, { dataset: { action: "exercise-editor-save" } });
const card = (mediaId) => `<article class="exercise-card"><img class="exercise-thumb" data-media-id="${mediaId}" data-media-slot="image" data-media-access-context='{"type":"exercise","id":"e1"}' alt=""></article>`;

// The cache as the library left it before the editor opened: the old
// objects of e1, another exercise and a plan item.
async function seedCache() {
  playback.forgetMediaAccess();
  setObject(ctx("e1"), "image", "img-old", "https://r2.example/e1/old.jpg");
  setObject(ctx("e1"), "video", "vid-old", "https://r2.example/e1/old.mp4");
  setObject(ctx("e2"), "image", "img-e2", "https://r2.example/e2/a.jpg");
  setObject(ctx("p1", "plan_item"), "image", "img-old", "https://r2.example/p1/old.jpg");
  const answers = await playback.resolveMediaAccess([
    { context: ctx("e1"), slot: "image" }, { context: ctx("e1"), slot: "video" },
    { context: ctx("e2"), slot: "image" }, { context: ctx("p1", "plan_item"), slot: "image" },
  ]);
  assert.equal(answers.size, 4);
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "image").mediaId, "img-old");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").mediaId, "vid-old");
}

test("1. a saved exercise: its context is forgotten after the server confirmed the save, the redrawn card asks once and shows the new object, the player asks again; the other exercise and the plan item keep their addresses", async () => {
  const calls = fakeApi();
  await seedCache();
  await editor.openExerciseEditor(state, handlers(), "e1");
  assert.equal(state.exerciseEditor.open, true);
  // The Save replaces both objects on the server.
  setObject(ctx("e1"), "image", "img-new", "https://r2.example/e1/new.jpg");
  setObject(ctx("e1"), "video", "vid-new", "https://r2.example/e1/new.mp4");
  const before = batchCalls(calls).length;
  let seenAtRefresh = null;
  const h = handlers({
    async refreshAfterSave() {
      // Like the app: the list is read again and the row drawn with the new object before the resolver runs.
      seenAtRefresh = { image: playback.cachedMediaAccess(ctx("e1"), "image"), video: playback.cachedMediaAccess(ctx("e1"), "video") };
      content.innerHTML = card("img-new");
      await playback.resolvePendingThumbnails(content);
    },
  });
  await save(h);
  assert.equal(state.exerciseEditor.open, false, "the editor closed");
  assert.deepEqual(seenAtRefresh, { image: null, video: null }, "both slots of e1 forgotten before the row is drawn again");
  const image = content.querySelector("img");
  assert.equal(image.src, "https://r2.example/e1/new.jpg");
  assert.equal(image.dataset.mediaId, "img-new");
  const asked = batchCalls(calls).slice(before);
  assert.equal(asked.length, 1, "one batch for the redrawn card");
  assert.deepEqual(asked[0].body.requests, [{ context: { type: "exercise", id: "e1" }, slots: ["image"] }], "only e1 is asked again");
  assert.equal(playback.cachedMediaAccess(ctx("e2"), "image").mediaId, "img-e2", "another exercise keeps its address");
  assert.equal(playback.cachedMediaAccess(ctx("p1", "plan_item"), "image").mediaId, "img-old", "a plan item keeps its own snapshot's address");
  // The player of e1 asks the server again instead of playing the replaced video.
  const played = await playback.loadPlayback(ctx("e1"));
  assert.equal(played.mediaId, "vid-new");
  assert.equal(calls.filter((call) => call.url === ACCESS_ROUTE).length, 1);
});

test("2. a failed Save keeps the editor open with the error and keeps every address: nothing is forgotten, nothing is asked again", async () => {
  const calls = fakeApi({ patchStatus: 500 });
  await seedCache();
  await editor.openExerciseEditor(state, handlers(), "e1");
  let refreshed = false;
  const before = calls.length;
  await save(handlers({ async refreshAfterSave() { refreshed = true; } }));
  assert.equal(state.exerciseEditor.open, true, "the editor stays open");
  assert.ok(state.exerciseEditor.error, "the error is shown");
  assert.equal(refreshed, false);
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "image").mediaId, "img-old");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").mediaId, "vid-old");
  assert.deepEqual(calls.slice(before).map((call) => `${call.method} ${call.url}`), ["PATCH /api/exercises/e1"], "only the save was sent");
});

test("3. a private copy leaves the source exercise's addresses alone: the copy is a new context, the source did not change", async () => {
  fakeApi();
  await seedCache();
  await editor.openExerciseEditor(state, handlers(), "e1", { copy: true });
  assert.equal(state.exerciseEditor.isCopy, true);
  await save(handlers());
  assert.equal(state.exerciseEditor.open, false);
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "image").mediaId, "img-old");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").mediaId, "vid-old");
});

test("4. an answer that lands after the context was forgotten is handed to its caller but never kept: the next resolve asks the server again (the batch and the single route alike)", async () => {
  // Every access request waits at the gate until the test releases it.
  const waiting = [];
  const gate = () => new Promise((resolve) => waiting.push(resolve));
  const release = async () => { while (!waiting.length) await new Promise((resolve) => setTimeout(resolve, 0)); waiting.shift()(); };
  const calls = fakeApi({ gate });
  playback.forgetMediaAccess();
  setObject(ctx("e1"), "image", "img-old", "https://r2.example/e1/old.jpg");
  setObject(ctx("e1"), "video", "vid-old", "https://r2.example/e1/old.mp4");
  // The batch: in flight when the Save forgets e1 and the server holds the new object.
  const pending = playback.resolveMediaAccess([{ context: ctx("e1"), slot: "image" }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  playback.forgetMediaAccess(ctx("e1"));
  setObject(ctx("e1"), "image", "img-new", "https://r2.example/e1/new.jpg");
  await release();
  const answers = await pending;
  assert.equal(answers.get(playback.accessKey(ctx("e1"), "image")).mediaId, "img-old", "the caller gets the answer it asked for");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "image"), null, "but it is not kept");
  const again = playback.resolveMediaAccess([{ context: ctx("e1"), slot: "image" }]);
  await release();
  await again;
  assert.equal(batchCalls(calls).length, 2, "the next resolve asks again");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "image").mediaId, "img-new");
  // The single route of the player: the same rule.
  const playing = playback.loadPlayback(ctx("e1"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  playback.forgetMediaAccess(ctx("e1"), "video");
  setObject(ctx("e1"), "video", "vid-new", "https://r2.example/e1/new.mp4");
  await release();
  assert.equal((await playing).mediaId, "vid-old");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video"), null);
  const played = playback.loadPlayback(ctx("e1"));
  await release();
  assert.equal((await played).mediaId, "vid-new");
  assert.equal(playback.cachedMediaAccess(ctx("e1"), "video").mediaId, "vid-new");
  assert.equal(calls.filter((call) => call.url === ACCESS_ROUTE).length, 2);
});
