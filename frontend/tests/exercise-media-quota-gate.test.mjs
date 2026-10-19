import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// E-1 (owner's decision 2026-10-19): the storage quota is the gate of the
// upload controls. An account at 0 B sees the editor of today whatever the
// guards say; an account with a limit (the pilot) sees the controls once the
// guards are on; a full account keeps Preview of its stored file and Remove;
// a club exercise is charged to the club's account, never the coach's own
// row by default; a storage answer that failed, is still loading, says the
// storage is off or refuses enables nothing; legacy links work as before.
// The guards are flipped only through the test setters.

const dom = new JSDOM('<main id="content"></main>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.File = dom.window.File;
globalThis.Event = dom.window.Event;
globalThis.URL.createObjectURL = () => "blob:preview";
globalThis.URL.revokeObjectURL = () => {};

const editor = await import("../exercise-editor.js");
const guards = await import("../exercise-media-upload.js");
const { STORAGE_ROUTE } = guards;

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const state = { currentUser: { id: "u1" } };
const handlers = (extra = {}) => ({ rerender() { content.innerHTML = state.exerciseEditor?.open ? editor.renderExerciseEditorHtml(state.exerciseEditor) : ""; }, async refreshAfterSave() {}, ...extra });
const withGuards = ({ transport = false, save = false } = {}) => { guards.setUploadTransportEnabled(transport); guards.setMediaSaveEnabled(save); };
const controlsOf = (slot) => [...content.querySelectorAll(`[data-exercise-media-slot="${slot}"] button, [data-exercise-media-slot="${slot}"] input`)].map((control) => control.textContent.trim() || `<input ${control.dataset.exerciseMediaFile ? "file" : control.dataset.exerciseEditorField || ""}>`);
const mediaMarkup = () => content.querySelector("[data-exercise-media-fields]").innerHTML;
const storageLine = () => content.querySelector("[data-exercise-media-storage]")?.textContent || null;
const save = () => editor.handleExerciseEditorAction(state, handlers(), { dataset: { action: "exercise-editor-save" } });
const action = (type, slot) => ({ dataset: { action: type, slot }, closest: (selector) => content.querySelector(`[data-exercise-media-slot="${slot}"]`)?.closest(selector) });
const open = async (id = "e1", options) => { await editor.openExerciseEditor(state, handlers(), id, options); await settle(); };
const close = () => editor.closeExerciseEditor(state, handlers());

const GB = 1_000_000_000;
const account = (overrides = {}) => ({
  storageAccountId: "acc-user", owner: { type: "user", id: "u1" }, usedBytes: "0", reservedBytes: "0", limitBytes: "0", availableBytes: "0",
  limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2, maxVideoBytes: "209715200", maxImageBytes: "10485760",
  allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"], overrideLimitBytes: null, revision: 1, ...overrides,
});
const zeroAccount = () => account();
const pilotAccount = () => account({ limitBytes: String(GB), availableBytes: String(GB), overrideLimitBytes: String(GB), limitSource: "override" });
const fullAccount = () => account({ limitBytes: String(GB), usedBytes: String(GB), availableBytes: "0", overrideLimitBytes: String(GB), limitSource: "override" });
const overAccount = () => account({ limitBytes: String(GB), usedBytes: "1200000000", availableBytes: "0", overLimit: true, overrideLimitBytes: String(GB), limitSource: "override" });
const clubAccount = (overrides = {}) => account({ storageAccountId: "acc-club", owner: { type: "club", id: "c1" }, ...overrides });
const usage = (accounts, selectedStorageAccountId = accounts[0]?.storageAccountId) => ({ accounts, selectedStorageAccountId });

const DRIVE = "https://drive.google.com/file/d/VID_1/view";
const YOUTUBE = "https://youtu.be/dQw4w9WgXcQ";
const detail = (overrides = {}) => ({ id: "e1", ownerScope: "user", canEdit: true, name: "Dead Bug", videoUrl: "", imageUrl: "", tags: [], ...overrides });
const legacy = () => detail({ videoUrl: DRIVE, imageUrl: YOUTUBE });
const storedVideo = () => detail({ imageUrl: DRIVE, media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "legacy", url: DRIVE }, accessContext: { type: "exercise", id: "e1" } } });

// The API fake: the storage answer (an object, or { status, json } for a refusal, or "hang" to never answer), the detail, every call recorded.
function fakeApi({ storage = usage([zeroAccount()]), exercise = detail() } = {}) {
  const calls = [];
  const pending = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    if (call.url.startsWith(STORAGE_ROUTE)) {
      if (storage === "hang") return new Promise((resolve) => pending.push(resolve));
      if (storage?.status) return { ok: false, status: storage.status, statusText: "Error", json: async () => storage.json || {} };
      return { ok: true, status: 200, json: async () => storage };
    }
    if (call.url.startsWith("/api/exercises/") || call.url === "/api/exercises") return { ok: true, status: 200, json: async () => (call.method === "GET" ? exercise : { id: "e1" }) };
    return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "notFound", code: "resource_not_found" }) };
  };
  calls.release = (answer) => { for (const resolve of pending.splice(0)) resolve({ ok: true, status: 200, json: async () => answer }); };
  return calls;
}

test("1. an account at 0 B sees the media fields of today: with both guards on the markup is byte-identical to the markup with both guards off, for a legacy exercise; a stored file keeps Preview, and Remove comes from the save guard alone", async () => {
  withGuards();
  fakeApi({ exercise: legacy() });
  await open();
  const today = mediaMarkup();
  close();
  withGuards({ transport: true, save: true });
  const calls = fakeApi({ storage: usage([zeroAccount()]), exercise: legacy() });
  await open();
  assert.equal(mediaMarkup(), today, "0 B: not one byte differs from the editor of today");
  assert.equal(calls.filter((call) => call.url.startsWith(STORAGE_ROUTE)).length, 1, "the storage was read once and showed nothing");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
  assert.equal(storageLine(), null);
  assert.doesNotMatch(mediaMarkup(), /Upload|Replace|frame/i);
  close();
  // A stored R2 file on a 0 B account: Preview as before; Remove only by the save guard; never Replace or a file input.
  fakeApi({ storage: usage([zeroAccount()]), exercise: storedVideo() });
  await open();
  assert.deepEqual(controlsOf("video"), ["Preview", "Remove"]);
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] [data-action="open-media"]').dataset.videoMediaId, "vid-1");
  close();
  withGuards({ transport: true });
  fakeApi({ storage: usage([zeroAccount()]), exercise: storedVideo() });
  await open();
  assert.deepEqual(controlsOf("video"), ["Preview"], "save guard off: Preview only, as FE-2 shipped it");
  close();
  // Defensive: a limit of 0 is never an upload, even if an answer claimed free bytes.
  withGuards({ transport: true, save: true });
  fakeApi({ storage: usage([account({ limitBytes: "0", availableBytes: "5000000" })]) });
  await open();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "limit 0 with free bytes claimed: nothing");
  assert.equal(storageLine(), null);
  close();
  withGuards();
});

test("2. a pilot account (a limit above 0) sees the upload controls and the storage line once the guards are on; a new exercise or a copy also needs the save guard", async () => {
  withGuards({ transport: true, save: true });
  fakeApi({ storage: usage([pilotAccount()]) });
  await open();
  assert.deepEqual(controlsOf("video"), ["Upload video...", "Use a link", "<input file>"]);
  assert.deepEqual(controlsOf("image"), ["Upload picture...", "Use a link", "<input file>"]);
  assert.equal(storageLine(), "Storage (personal storage): 0 B used of 1 GB · 1 GB free · one video up to 209.7 MB, one picture up to 10.5 MB");
  close();
  withGuards({ transport: true });
  fakeApi({ storage: usage([pilotAccount()]) });
  await open();
  assert.deepEqual(controlsOf("video"), ["Upload video...", "Use a link", "<input file>"], "an existing exercise: the transport guard alone offers (FE-2), the quota allows");
  assert.equal(storageLine(), null, "the storage line waits for the save guard too (owner, 2026-10-19)");
  close();
  // The storage line of a pilot account under each guard alone: never.
  withGuards({ save: true });
  fakeApi({ storage: usage([pilotAccount()]) });
  await open();
  assert.equal(storageLine(), null, "save guard alone: no line");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "save guard alone: no upload either");
  close();
  await open("");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "a new exercise waits for the save guard");
  close();
  withGuards({ transport: true, save: true });
  fakeApi({ storage: usage([pilotAccount()]) });
  await open("");
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 2, "a new exercise with both guards: the coach's own 1 GB row");
  close();
  withGuards();
});

test("3. a full account (nothing free, or over its limit) keeps Preview of its stored video and Remove, loses Upload and Replace, and the storage line says why", async () => {
  withGuards({ transport: true, save: true });
  for (const full of [fullAccount(), overAccount()]) {
    fakeApi({ storage: usage([full]), exercise: storedVideo() });
    await open();
    assert.deepEqual(controlsOf("video"), ["Preview", "Remove"], "Preview and Remove, no Replace");
    assert.equal(content.querySelector('[data-exercise-media-slot="video"] [data-action="open-media"]').dataset.videoMediaId, "vid-1");
    assert.deepEqual(controlsOf("image"), ["<input imageUrl>"], "the link slot is the field of today (the FE-2 faces come only with an upload on offer), so no Replace with a file");
    assert.equal(content.querySelector('[data-exercise-editor-field="imageUrl"]').value, DRIVE);
    assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0);
    assert.match(storageLine(), /0 B free · .* · Storage is full: remove media you no longer use or ask an administrator for more storage\.$/);
    assert.doesNotMatch(mediaMarkup(), /frame/i, "no frame picker without room");
    close();
  }
  // Defensive: over the limit is never an upload, even if an answer claimed free bytes.
  fakeApi({ storage: usage([account({ limitBytes: String(GB), usedBytes: "1200000000", availableBytes: "100", overLimit: true, limitSource: "override" })]) });
  await open();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "over the limit with free bytes claimed: nothing");
  assert.match(storageLine(), /Storage is full/);
  close();
  withGuards();
});

test("4. Remove never depends on free space, and keeps its semantics: a stored file removed on a full account is dropped from the exercise on Save as { source: \"none\" } (the object stays), a link is cleared at once; before BE-3 a stored file cannot be removed at all", async () => {
  withGuards({ transport: true, save: true });
  let calls = fakeApi({ storage: usage([fullAccount()]), exercise: storedVideo() });
  await open();
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "none");
  assert.equal(state.exerciseEditor.media.video.removedMediaId, "vid-1");
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "image"));
  assert.equal(state.exerciseEditor.data.imageUrl, "", "a link is cleared at once");
  await save();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body.media, { video: { source: "none" } }, "the stored file leaves as an explicit selection");
  assert.equal("videoUrl" in patch.body, false, "never both formats for one slot");
  assert.equal(patch.body.imageUrl, "", "a removed link is a legacy field change, as FE-2 always sent it");
  assert.equal(calls.filter((call) => call.url.startsWith("/api/media/uploads")).length, 0, "removing needs no quota and no upload route");
  // Before BE-3 (save guard off) a stored file is not removable, whatever the quota.
  withGuards({ transport: true });
  calls = fakeApi({ storage: usage([pilotAccount()]), exercise: storedVideo() });
  await open();
  assert.deepEqual(controlsOf("video"), ["Preview", "<input file>"]);
  await editor.handleExerciseEditorAction(state, handlers(), action("exercise-media-remove", "video"));
  assert.equal(state.exerciseEditor.media.video.state, "stored", "refused before BE-3");
  close();
  withGuards();
});

test("5. a club exercise is charged to the club's account: the server's selection decides, and the coach's own 1 GB never substitutes for a club at 0 B", async () => {
  withGuards({ transport: true, save: true });
  let calls = fakeApi({ storage: usage([zeroAccount(), clubAccount({ limitBytes: String(5 * GB), availableBytes: String(5 * GB), limitSource: "override" })], "acc-club"), exercise: detail({ ownerScope: "club" }) });
  await open();
  assert.equal(calls.find((call) => call.url.startsWith(STORAGE_ROUTE)).url, `${STORAGE_ROUTE}?exerciseId=e1`, "the target-aware read");
  assert.deepEqual(controlsOf("video"), ["Upload video...", "Use a link", "<input file>"], "the club has room: offered, although the coach's own row is at 0 B");
  assert.match(storageLine(), /^Storage \(club storage/);
  close();
  calls = fakeApi({ storage: usage([pilotAccount(), clubAccount()], "acc-club"), exercise: detail({ ownerScope: "club" }) });
  await open();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "the club is at 0 B: nothing, the coach's own 1 GB does not count");
  assert.equal(storageLine(), null);
  close();
  withGuards();
});

test("6. a storage answer that failed, is still loading, says the storage is off (503) or refuses (403) enables nothing, and a programmatic choose sends nothing; the controls appear only once a good answer is in", async () => {
  withGuards({ transport: true, save: true });
  for (const storage of [{ status: 500, json: {} }, { status: 503, json: { code: "media_storage_disabled" } }, { status: 403, json: { code: "operation_not_allowed" } }]) {
    const calls = fakeApi({ storage });
    await open();
    assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, `status ${storage.status}: no upload control`);
    assert.equal(content.querySelector(".exercise-media-storage"), null, `status ${storage.status}: no storage line, no Read again`);
    assert.ok(content.querySelector('[data-exercise-editor-field="videoUrl"]'), "the link field of today");
    await editor.chooseExerciseMediaFile(state, handlers(), "video", { name: "clip.mp4", size: 100, type: "video/mp4" });
    await settle();
    assert.equal(state.exerciseEditor.media.video.state, "none", "a programmatic choose does nothing");
    assert.equal(calls.filter((call) => call.url.startsWith("/api/media/uploads")).length, 0, "nothing sent");
    close();
  }
  // Still loading: nothing until the answer; then the controls.
  const calls = fakeApi({ storage: "hang" });
  await open();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "while the storage read is in flight nothing is offered");
  assert.equal(content.querySelector(".exercise-media-storage"), null);
  calls.release(usage([pilotAccount()]));
  await settle();
  await settle();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 2, "the good answer brings the controls");
  // Defensive: a failed read with stale data from before, or a read in flight with old data, names no account.
  const storage = state.exerciseEditor.media.storage;
  Object.assign(storage, { error: "unreadable" });
  handlers().rerender();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "an error flag beats stale data");
  assert.equal(editor.chargedStorageAccount(state.exerciseEditor), null);
  Object.assign(storage, { error: "", loading: true });
  handlers().rerender();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 0, "a read in flight beats stale data");
  Object.assign(storage, { loading: false });
  handlers().rerender();
  assert.equal(content.querySelectorAll("[data-exercise-media-file]").length, 2, "and the settled good answer offers again");
  close();
  withGuards();
});

test("7. legacy links keep working under the gate: on a 0 B account with both guards on the Drive and YouTube links are in their fields and Preview as before, and the save body is the body of today", async () => {
  withGuards({ transport: true, save: true });
  const calls = fakeApi({ storage: usage([zeroAccount()]), exercise: legacy() });
  await open();
  assert.equal(content.querySelector('[data-exercise-editor-field="videoUrl"]').value, DRIVE);
  assert.equal(content.querySelector('[data-exercise-editor-field="imageUrl"]').value, YOUTUBE);
  state.exerciseEditor.data.name = "Dead Bug (renamed)";
  await save();
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch.body.videoUrl, DRIVE);
  assert.equal(patch.body.imageUrl, YOUTUBE);
  assert.equal("media" in patch.body, false, "no media selection: nothing of R2 reaches the exercise");
  assert.equal(state.exerciseEditor.open, false);
  // The same links on a pilot account: the FE-2 faces, Preview carrying the URL, Replace offered.
  fakeApi({ storage: usage([pilotAccount()]), exercise: legacy() });
  await open();
  assert.equal(content.querySelector('[data-exercise-media-slot="video"] [data-action="open-media"]').dataset.video, DRIVE);
  assert.deepEqual(controlsOf("video"), ["Preview", "Edit link", "Replace with a file...", "Remove", "<input file>"]);
  close();
  withGuards();
});
