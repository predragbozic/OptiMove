import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

// Settings -> Storage -> Import from Google Drive: the platform administrator
// chooses the prepared folder (manifest.json + videos/ + images/), the screen
// matches it against what the server says is used and not yet copied, and
// uploads the rest through PR #202's import routes - each file checked first,
// two at a time, every repeat with the file's own Idempotency-Key, so a lost
// answer never copies a file twice. A fake server and a fake R2 PUT only.

const dom = new JSDOM('<main id="content"></main><input id="elsewhere">', { pretendToBeVisual: true, url: "https://optimove.test/" });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;

const data = await import("../drive-import-data.js");
const view = await import("../drive-import-view.js");
const actions = await import("../drive-import-actions.js");
const storageView = await import("../media-storage-admin-view.js");
const storageData = await import("../media-storage-admin-data.js");
const { state } = await import("../state.js");

const content = document.querySelector("#content");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let renders = 0;
const render = () => { renders += 1; content.innerHTML = storageView.renderStorageAdminPanelHtml(state.organization.data); };
const instant = async () => {};
const until = async (condition, label) => {
  for (let i = 0; i < 2000 && !condition(); i += 1) await settle();
  assert.ok(condition(), label);
};

function reset({ platformAdmin = true, workspace = "platform", accounts = [platformAccount()] } = {}) {
  state.organization = { data: { users: [], clubs: [], teams: [], athletes: [], isPlatformAdmin: platformAdmin }, section: "storage" };
  state.currentUser = { id: "admin-1", activeWorkspace: { type: workspace } };
  state.storageAdmin = { ...storageData.emptyStorageAdmin(), policy: { defaultLimitBytes: "0", maxVideoBytes: "209715200", maxImageBytes: "10485760", maxParallelUploads: 2, allowedMimeTypes: ["video/mp4"] }, revision: 1, accounts };
  state.driveImport = data.emptyDriveImport();
  state.deliberateNavigation = false;
  localStorage.clear();
  actions.handleDriveImportPointer({ type: "pointerup" });
  document.activeElement?.blur?.();
  renders = 0;
}
function platformAccount(overrides = {}) {
  return { storageAccountId: "acc-p", owner: { type: "platform", id: null }, usedBytes: "0", reservedBytes: "0", limitBytes: "15000000000", availableBytes: "15000000000",
    limitSource: "override", overLimit: false, activeUploads: 0, maxParallelUploads: 2, maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4"], overrideLimitBytes: "15000000000", revision: 1, ...overrides };
}
// What the administrator reads: the card's text without its Technical details.
function visibleText(root = content) {
  const copy = root.cloneNode(true);
  for (const element of copy.querySelectorAll(".storage-admin-technical")) element.remove();
  return copy.textContent;
}

// ---- The prepared folder ------------------------------------------------------

const ID = (n) => `1DriveFile${String(n).padStart(16, "0")}`;
function preparedFile(path, content, mime) {
  const file = new File([content], path.split("/").pop(), { type: mime });
  Object.defineProperty(file, "webkitRelativePath", { value: `OptiMove-R2-uvoz/${path}` });
  return file;
}
const sha = (content) => createHash("sha256").update(content).digest("hex");
// n videos (and optional images): the folder's files and its manifest.
function folder({ videos = [1, 2, 3], images = [], extra = {}, manifestText = null, tamper = null } = {}) {
  const files = [];
  const manifest = { videos: {}, images: {} };
  for (const n of videos) {
    const content = `video-${n}-${"x".repeat(n * 10)}`;
    manifest.videos[ID(n)] = { ok: true, file: `videos/${ID(n)}.mp4`, bytes: Buffer.byteLength(content), sha256: sha(content), mimeType: "video/mp4", exercises: [{ name: `Exercise ${n}` }, { name: "Other" }] };
    files.push(preparedFile(`videos/${ID(n)}.mp4`, tamper?.[n] ?? content, "video/mp4"));
  }
  for (const n of images) {
    const content = `image-${n}`;
    manifest.images[ID(n)] = { ok: true, file: `images/${ID(n)}.jpg`, bytes: Buffer.byteLength(content), sha256: sha(content), mimeType: "image/jpeg", exercises: [{ name: `Picture ${n}` }] };
    files.push(preparedFile(`images/${ID(n)}.jpg`, content, "image/jpeg"));
  }
  Object.assign(manifest.videos, extra);
  files.push(preparedFile("manifest.json", manifestText ?? JSON.stringify(manifest), "application/json"));
  return files;
}
const statusFor = (videos, images = [], copied = []) => ({
  videos: videos.map((n) => ({ driveFileId: ID(n), rows: 2, copied: copied.includes(n), mediaId: null })),
  images: images.map((n) => ({ driveFileId: ID(n), rows: 1, copied: false, mediaId: null })),
  platformStorageAccountId: "acc-p",
});

// ---- A fake import server and a fake R2 PUT -------------------------------------

const reply = (statusCode, body) => ({ ok: statusCode < 400, status: statusCode, statusText: "", json: async () => body });
const refusal = (statusCode, code, retryable = false) => reply(statusCode, { error: code, code, retryable, details: {} });

// Every fake request in flight, whichever test's server started it: a test that
// counts paints first waits for the previous test's un-awaited reads to land.
const inflight = new Set();
async function quiet() {
  for (let round = 0; round < 50; round += 1) {
    while (inflight.size) await Promise.allSettled([...inflight]);
    await settle();
    await settle();
    if (!inflight.size) return;
  }
  assert.fail("fake requests never settled");
}

function fakeServer({ status = statusFor([1, 2, 3]), accounts = null, on = {} } = {}) {
  const server = { calls: [], uploads: new Map(), byKey: new Map(), copied: new Set(), active: 0, maxActive: 0, seq: 0, status, platformId: status.platformStorageAccountId, account: platformAccount() };
  // The server's own start of an import (the same key -> the same session).
  server.start = (call) => {
    const body = call.body;
    if (server.byKey.has(call.key)) return reply(201, server.uploads.get(server.byKey.get(call.key)));
    if (server.copied.has(`${body.kind}:${body.driveFileId}`)) return refusal(409, "already_copied");
    const id = `up-${++server.seq}`;
    const upload = { uploadId: id, mediaId: `media-${server.seq}`, status: "pending", driveFileId: body.driveFileId, kind: body.kind,
      upload: { method: "PUT", url: `https://r2.test/pending/${id}`, headers: { "Content-Type": body.file.mimeType, "If-None-Match": "*" } } };
    server.uploads.set(id, upload);
    server.byKey.set(call.key, id);
    server.active += 1;
    server.maxActive = Math.max(server.maxActive, server.active);
    return reply(201, upload);
  };
  const handle = async (url, options = {}) => {
    const path = new URL(String(url), "https://optimove.test").pathname;
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { method, path, key: options.headers?.["Idempotency-Key"], body };
    server.calls.push(call);
    if (path.endsWith("/drive-import/status")) return on.status ? on.status(call) : reply(200, { ...server.status, platformStorageAccountId: server.platformId });
    if (path.endsWith("/storage-accounts") && method === "POST") { server.platformId = "acc-p"; return reply(200, server.account); }
    if (path.endsWith("/storage-accounts")) return reply(200, { accounts: accounts ?? (server.platformId ? [server.account] : []), nextCursor: null });
    if (path.endsWith(`/storage-accounts/${server.platformId}`)) return (await on.account?.(call, server)) || reply(200, server.account);
    if (path.endsWith("/storage-policy")) return reply(200, { policy: state.storageAdmin.policy, revision: 1 });
    if (path.endsWith("/drive-import/uploads") && method === "POST") return (await on.initiate?.(call, server)) || server.start(call);
    const complete = path.match(/\/drive-import\/uploads\/([^/]+)\/complete$/);
    if (complete && method === "POST") {
      const scripted = await on.complete?.(call, server);
      if (scripted) return scripted;
      const upload = server.uploads.get(decodeURIComponent(complete[1]));
      if (!upload) return refusal(404, "resource_not_found");
      if (upload.status !== "completed") { upload.status = "completed"; server.active -= 1; }
      server.copied.add(`${upload.kind}:${upload.driveFileId}`);
      return reply(200, { uploadId: upload.uploadId, mediaId: upload.mediaId, status: "completed", media: { source: "asset", mediaId: upload.mediaId } });
    }
    const cancel = path.match(/\/drive-import\/uploads\/([^/]+)$/);
    if (cancel && method === "DELETE") {
      const scripted = await on.cancel?.(call, server);
      if (scripted) return scripted;
      const upload = server.uploads.get(decodeURIComponent(cancel[1]));
      if (!upload) return refusal(404, "resource_not_found");
      upload.status = "cancelled";
      server.active -= 1;
      return reply(200, { uploadId: upload.uploadId, status: "cancelled" });
    }
    return refusal(404, "resource_not_found");
  };
  globalThis.fetch = (url, options) => {
    const pending = handle(url, options);
    inflight.add(pending);
    pending.then(() => inflight.delete(pending), () => inflight.delete(pending));
    return pending;
  };
  return server;
}

class FakeXHR {
  static puts = [];
  static outcomes = [];
  static held = [];
  constructor() { this.upload = {}; this.headers = {}; }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(body) {
    FakeXHR.puts.push({ url: this.url, headers: this.headers, size: body?.size });
    const outcome = FakeXHR.outcomes.length ? FakeXHR.outcomes.shift() : 200;
    this.body = body;
    if (outcome === "hang") return; // never answers: only an abort ends it
    if (outcome === "hold") { FakeXHR.held.push(this); return; }
    setTimeout(() => this.finish(outcome), 0);
  }
  finish(status) {
    this.upload.onprogress?.({ loaded: this.body?.size || 0, total: this.body?.size || 0, lengthComputable: true });
    this.status = status;
    if (status === 0) this.onerror?.(); else this.onload?.();
  }
  abort() { this.onabort?.(); }
}
globalThis.XMLHttpRequest = FakeXHR;
function resetPuts(outcomes = []) { FakeXHR.puts = []; FakeXHR.outcomes = [...outcomes]; FakeXHR.held = []; }

async function chooseFolder(files) {
  await data.chooseDriveImportFolder(files, render);
}
const imports = (server) => server.calls.filter((call) => call.path.endsWith("/drive-import/uploads") && call.method === "POST");
const completions = (server) => server.calls.filter((call) => /\/complete$/.test(call.path));
const cancels = (server) => server.calls.filter((call) => call.method === "DELETE");
const click = (type) => actions.handleDriveImportAction({ dataset: { action: type } }, { render });

// ---- Tests --------------------------------------------------------------------------

test("1. the folder: a manifest is required and checked; only files the server uses and has not copied are queued; the rest is reported by exercise name, ids under Technical details", async () => {
  reset();
  await assert.rejects(data.readImportFolder(folder().filter((file) => file.name !== "manifest.json")), (error) => error.code === "manifest_missing");
  await assert.rejects(data.readImportFolder(folder({ manifestText: "{not json" })), (error) => error.code === "manifest_unreadable");
  await assert.rejects(data.readImportFolder(folder({ extra: { [ID(9)]: { ok: true, file: "videos/x.mp4", bytes: 5, sha256: "abc", mimeType: "video/mp4" } } })), (error) => error.code === "manifest_unreadable", "a bad checksum shape");
  fakeServer({ status: statusFor([1, 2, 3, 4, 5, 8], [7], [2]) });
  // 8: the manifest names it, the folder does not hold it.
  const named = { ok: true, file: `videos/${ID(8)}.mp4`, bytes: 5, sha256: "a".repeat(64), mimeType: "video/mp4", exercises: [{ name: "Missing one" }] };
  await chooseFolder(folder({ videos: [1, 2, 3, 6], images: [7], extra: { [ID(5)]: { ok: false, error: "not_a_video", exercises: [{ name: "Bad one" }] }, [ID(8)]: named } }));
  const imp = state.driveImport;
  assert.equal(imp.folderName, "OptiMove-R2-uvoz");
  assert.deepEqual(imp.items.map((item) => item.id), [`video:${ID(1)}`, `video:${ID(3)}`, `image:${ID(7)}`], "copied (2), unprepared (5) and unused (6) are not queued");
  assert.equal(imp.items[0].name, "Exercise 1");assert.equal(imp.items[0].more, 1);
  assert.equal(imp.report.copied.video, 1);
  assert.deepEqual(imp.report.notPrepared.map((entry) => [entry.driveFileId, entry.reason, entry.name]), [[ID(5), "not_a_video", "Bad one"]]);
  assert.deepEqual(imp.report.missing.map((entry) => [entry.driveFileId, entry.reason]), [[ID(4), "not_prepared"], [ID(8), "file_missing"]]);
  assert.equal(imp.report.unused, 1);
  const text = visibleText();
  assert.match(text, /2 videos and 1 picture to copy/);
  assert.match(text, /3 files cannot be copied from this folder/);
  assert.match(text, /Video · Bad one/);assert.match(text, /Video · Missing one/);assert.match(text, /A file used in 2 places/);
  assert.match(text, /their exercises keep playing from Google Drive/);
  assert.match(text, /Start import \(3\)/);
  for (const n of [1, 3, 4, 5, 7, 8]) assert.ok(!text.includes(ID(n)), `no Drive id ${n} outside Technical details`);
  assert.ok(content.querySelector(".drive-import-problems .storage-admin-technical").textContent.includes(ID(5)), "the id is under Technical details");
});

test("2. only a platform administrator in the platform workspace sees the card; a server without the import is named plainly", async () => {
  reset({ platformAdmin: false });
  render();
  assert.doesNotMatch(content.innerHTML, /drive-import-card/);
  assert.equal(await click("drive-import-start"), true, "claimed and ignored");
  assert.equal(state.driveImport.running, false);
  reset({ workspace: "club" });
  render();
  assert.doesNotMatch(content.innerHTML, /drive-import-card/);
  // A plan already on screen (the role was revoked, or the workspace switched since): nothing starts.
  reset();
  const server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  for (const lose of [() => { state.organization.data.isPlatformAdmin = false; }, () => { state.organization.data.isPlatformAdmin = true; state.currentUser.activeWorkspace = { type: "club" }; }]) {
    lose();
    assert.equal(await click("drive-import-start"), true);
    assert.equal(state.driveImport.running, false);
    assert.equal(imports(server).length, 0, "nothing sent");
  }
  reset();
  fakeServer({ on: { status: () => refusal(404, "resource_not_found") } });
  await data.loadDriveImportStatus(render);
  assert.match(content.textContent, /This server does not offer the import yet/);
  assert.doesNotMatch(content.textContent, /PR #/);
  fakeServer({ on: { status: () => refusal(403, "operation_not_allowed") } });
  await data.loadDriveImportStatus(render);
  assert.match(content.textContent, /platform administrator access/);
});

test("3. the import: each file checked, started with its own kept key, uploaded, completed; two at a time; keys forgotten once copied; a done sentence", async () => {
  reset();resetPuts();
  const server = fakeServer({ status: statusFor([1, 2, 3, 4]) });
  await chooseFolder(folder({ videos: [1, 2, 3, 4] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.deepEqual(state.driveImport.items.map((item) => item.state), ["copied", "copied", "copied", "copied"]);
  assert.equal(server.maxActive <= 2, true, `at most two at a time (${server.maxActive})`);
  assert.equal(imports(server).length, 4);assert.ok(imports(server).every((call) => /^[0-9a-f-]{36}$/.test(call.key)));
  assert.equal(new Set(imports(server).map((call) => call.key)).size, 4, "a key per file");
  assert.deepEqual(imports(server)[0].body, { kind: "video", driveFileId: ID(1), file: { name: `${ID(1)}.mp4`, sizeBytes: String(state.driveImport.items[0].bytes), mimeType: "video/mp4" } });
  assert.equal(FakeXHR.puts.length, 4);assert.equal(FakeXHR.puts[0].headers["If-None-Match"], "*");
  assert.equal(completions(server).length, 4);
  assert.equal(localStorage.getItem("optimove.driveImport.keys"), "{}", "nothing left to repeat");
  assert.match(content.textContent, /4 of 4 copied/);
  assert.match(content.textContent, /Done: 4 files copied\. Their exercises now play the copies\./);
  assert.equal(state.driveImport.running, false);
});

test("4. a file that is not the one the manifest describes is refused before any request; Continue leaves it for preparing again", async () => {
  reset();resetPuts();
  const server = fakeServer({ status: statusFor([1, 2]) });
  await chooseFolder(folder({ videos: [1, 2], tamper: { 2: "video-2-yyyyyyyyyyyyyyyyyyyy" } }));
  await data.runDriveImport(render, { sleep: instant });
  const [first, second] = state.driveImport.items;
  assert.equal(first.state, "copied");
  assert.equal(second.state, "failed");assert.equal(second.error, "file_changed");
  assert.equal(imports(server).length, 1, "nothing sent for the changed file");
  assert.equal(data.requeueFailedImports(), 0, "a changed file needs preparing again, not a repeat");
  assert.match(content.textContent, /not the one the manifest describes/);
  assert.match(content.textContent, /1 not copied/);
  assert.doesNotMatch(content.textContent, /Continue \(/, "no Continue for a file that needs preparing again");
  assert.ok(!visibleText().includes(ID(2)), "the failed file is named by its exercise, not its id");
  assert.match(visibleText(), /Video · Exercise 2 \(and 1 other exercise\)/);
});

test("5. safe repeats: a lost start answer repeats with the same key; bytes already there (412) complete; 'still verifying' is asked again; an unknown completion repeats the completion, never a new import", async () => {
  reset();resetPuts([412]);
  let lost = 1, verifying = 1, unknown = 1;
  const server = fakeServer({ status: statusFor([1]), on: {
    initiate: () => (lost-- > 0 ? Promise.reject(new TypeError("Failed to fetch")) : null),
    complete: () => {
      if (verifying-- > 0) return { ok: true, status: 202, statusText: "", json: async () => ({ uploadId: "up-1", status: "verifying" }) };
      if (unknown-- > 0) return refusal(503, "import_outcome_unknown", true);
      return null;
    },
  } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  const [item] = state.driveImport.items;
  assert.equal(item.state, "copied", item.error);
  const keys = imports(server).map((call) => call.key);
  assert.equal(keys.length, 2);assert.equal(keys[0], keys[1], "the repeat after a lost answer uses the same key");
  assert.equal(server.uploads.size, 1, "one import, never two");
  assert.equal(completions(server).length, 3, "202, unknown, then completed");
});

test("6. already copied counts as done; another import of the file in flight waits, is asked again later, then is 'not confirmed' for Continue", async () => {
  reset();resetPuts();
  let inFlight = 0;
  const slept = [];
  const server = fakeServer({ status: statusFor([1, 2]), on: {
    initiate: (call) => {
      if (call.body.driveFileId === ID(1)) return refusal(409, "already_copied");
      inFlight += 1;
      return refusal(409, "import_in_progress");
    },
  } });
  await chooseFolder(folder({ videos: [1, 2] }));
  await data.runDriveImport(render, { sleep: async (ms) => { slept.push(ms); } });
  const [first, second] = state.driveImport.items;
  assert.equal(first.state, "already");
  assert.equal(second.state, "unconfirmed");assert.equal(second.error, "import_in_progress");
  assert.equal(inFlight, data.IMPORT_IN_PROGRESS_RETRIES + 1, "asked again a few times");
  assert.equal(slept.filter((ms) => ms === data.IMPORT_IN_PROGRESS_DELAY_MS).length, data.IMPORT_IN_PROGRESS_RETRIES, "a minute apart");
  assert.match(content.textContent, /still open on the server/);
  assert.match(content.textContent, /Not confirmed/);
  assert.match(content.textContent, /Continue \(1\)/);
  assert.equal(data.requeueFailedImports(), 1, "Continue puts it back");
  assert.equal(second.state, "queued");
  assert.ok(imports(server).length >= 2);
});

test("7. a stop code stops the run (nothing new starts) and says why; after the limit is raised Continue goes on", async () => {
  reset();resetPuts();
  let full = true;
  const server = fakeServer({ status: statusFor([1, 2, 3]), on: { initiate: () => (full ? refusal(429, "storage_quota_exceeded") : null) } });
  await chooseFolder(folder({ videos: [1, 2, 3] }));
  await data.runDriveImport(render, { concurrency: 1, sleep: instant });
  assert.equal(state.driveImport.stopCode, "storage_quota_exceeded");
  assert.equal(imports(server).length, 1, "the first refusal stops the run");
  assert.deepEqual(state.driveImport.items.map((item) => item.state), ["failed", "queued", "queued"]);
  assert.match(content.textContent, /system storage is full/i);
  assert.match(content.textContent, /Raise its limit below/);
  assert.match(content.textContent, /Continue \(3\)/);
  full = false;
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the run ends");
  assert.deepEqual(state.driveImport.items.map((item) => item.state), ["copied", "copied", "copied"]);
  assert.equal(state.driveImport.stopCode, "");
});

test("8. a key survives a reload (kept in this browser) and continues the same import; an ended session gets a new key", async () => {
  reset();resetPuts();
  const server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  const item = state.driveImport.items[0];
  const kept = data.keyFor(item);
  // A reload: the screen is new, the key is read back for the same file.
  state.driveImport = data.emptyDriveImport();
  await chooseFolder(folder({ videos: [1] }));
  const fresh = state.driveImport.items[0];
  assert.equal(data.keyFor(fresh), kept);
  // The earlier attempt with that key was cancelled on the server: a new key, one new import.
  server.byKey.set(kept, "up-old");server.uploads.set("up-old", { uploadId: "up-old", status: "cancelled", driveFileId: ID(1), kind: "video" });
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(fresh.state, "copied");
  const keys = imports(server).map((call) => call.key);
  assert.equal(keys[0], kept);assert.notEqual(keys[1], kept);
});

test("9. Pause: the files on their way finish, nothing new starts; Continue resumes; the leave guard asks only while running and never on a deliberate navigation", async () => {
  reset();resetPuts();
  fakeServer({ status: statusFor([1, 2, 3]) });
  await chooseFolder(folder({ videos: [1, 2, 3] }));
  const run = data.runDriveImport(render, { concurrency: 1, sleep: instant });
  const asked = { prevented: false, preventDefault() { this.prevented = true; } };
  actions.handleDriveImportBeforeUnload(asked);
  assert.equal(asked.prevented, true, "running: the browser asks");
  state.deliberateNavigation = true;
  const signingOut = { prevented: false, preventDefault() { this.prevented = true; } };
  actions.handleDriveImportBeforeUnload(signingOut);
  assert.equal(signingOut.prevented, false, "sign-out is not held back");
  state.deliberateNavigation = false;
  await click("drive-import-pause");
  await run;
  const states = state.driveImport.items.map((item) => item.state);
  assert.equal(states.filter((s) => s === "copied").length, 1, "the file on its way finished");
  assert.deepEqual(states.slice(1), ["queued", "queued"]);
  const idle = { prevented: false, preventDefault() { this.prevented = true; } };
  actions.handleDriveImportBeforeUnload(idle);
  assert.equal(idle.prevented, false);
  assert.match(content.textContent, /Paused\. Choose Continue to go on\./);
  assert.match(content.textContent, /Continue \(2\)/);
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the run ends");
  assert.deepEqual(state.driveImport.items.map((item) => item.state), ["copied", "copied", "copied"]);
});

test("10. without system storage nothing can start; Create system storage creates it and the card shows it; the folder input goes through the actions", async () => {
  reset({ accounts: [] });
  const server = fakeServer({ status: { ...statusFor([1]), platformStorageAccountId: null } });
  server.platformId = null;
  await data.loadDriveImportStatus(render);
  assert.match(content.textContent, /does not exist yet/);
  assert.ok(content.querySelector("[data-drive-import-folder]").disabled, "no folder before system storage exists");
  // Even with a plan (a folder chosen some other way), nothing starts before system storage exists.
  await chooseFolder(folder({ videos: [1] }));
  assert.ok(content.querySelector('[data-action="drive-import-start"]').disabled);
  assert.match(content.textContent, /Create OptiMove system storage first/);
  await click("drive-import-start");
  assert.equal(state.driveImport.running, false);
  assert.equal(imports(server).length, 0, "nothing sent");
  await click("drive-import-create-account");
  assert.ok(server.calls.some((call) => call.method === "POST" && call.path.endsWith("/storage-accounts") && call.body.owner.type === "platform"));
  assert.match(content.textContent, /OptiMove system storage was created/);
  assert.match(content.textContent, /OptiMove system storage: 0 B used/);
  assert.ok(!content.querySelector("[data-drive-import-folder]").disabled);
  const input = document.createElement("input");input.setAttribute("data-drive-import-folder", "");
  Object.defineProperty(input, "files", { value: folder({ videos: [1] }) });
  assert.equal(await actions.handleDriveImportChange({ target: input }, { render }), true);
  assert.equal(state.driveImport.items.length, 1);
  assert.equal(await actions.handleDriveImportChange({ target: document.createElement("input") }, { render }), false, "another input is not claimed");
  // A server without it: a sentence, not a button that does nothing.
  reset({ accounts: [] });
  fakeServer({ status: { ...statusFor([1]), platformStorageAccountId: null } }).platformId = null;
  globalThis.fetch = ((inner) => async (url, options = {}) => (options.method === "POST" && String(url).endsWith("/storage-accounts") ? refusal(400, "invalid_request") : inner(url, options)))(globalThis.fetch);
  await data.loadDriveImportStatus(render);
  await click("drive-import-create-account");
  assert.match(content.textContent, /This server does not offer OptiMove system storage yet/);
  assert.match(content.textContent, /Create system storage/);
});

test("11. a lost answer after the server started the import: the repeat with the same key gets the same import, one upload", async () => {
  reset();resetPuts();
  let lostAfterWrite = 1;
  const server = fakeServer({ status: statusFor([1]), on: {
    initiate: (call, s) => {
      if (lostAfterWrite-- > 0) { s.start(call); return Promise.reject(new TypeError("Failed to fetch")); }
      return null;
    },
  } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "copied");
  const keys = imports(server).map((call) => call.key);
  assert.equal(keys.length, 2);assert.equal(keys[0], keys[1]);
  assert.equal(server.uploads.size, 1, "the server holds one import");
  assert.equal(FakeXHR.puts.length, 1);
});

test("12. completion refusals: an upload the server did not see is sent again under the same key; a session in another state starts anew under a new key", async () => {
  reset();resetPuts();
  let notPresent = 1;
  const server = fakeServer({ status: statusFor([1]), on: { complete: () => (notPresent-- > 0 ? refusal(409, "upload_not_present") : null) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "copied");
  assert.equal(new Set(imports(server).map((call) => call.key)).size, 1, "the same key");
  assert.equal(server.uploads.size, 1);assert.equal(FakeXHR.puts.length, 2, "the bytes sent again");
  reset();resetPuts();
  let conflict = 1;
  const second = fakeServer({ status: statusFor([1]), on: { complete: () => (conflict-- > 0 ? refusal(409, "state_conflict") : null) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "copied");
  const keys = imports(second).map((call) => call.key);
  assert.equal(keys.length, 2);assert.notEqual(keys[0], keys[1], "a new key: a new import");
});

test("13. an upload that never gets through: a fresh permission under the same key, then the session is cancelled to free its slot; the cancel's answer decides the state", async () => {
  // One failed PUT: the same key gives a fresh permission, the second PUT goes through.
  reset();resetPuts([0]);
  let server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "copied");
  assert.equal(imports(server).length, 2);assert.equal(imports(server)[0].key, imports(server)[1].key);
  assert.equal(server.uploads.size, 1);
  // Both PUTs fail: cancelled -> not copied, a new key next time, Continue may repeat it.
  reset();resetPuts([0, 0]);
  server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  let [item] = state.driveImport.items;
  assert.equal(cancels(server).length, 1, "the session is cancelled");
  assert.equal(item.state, "failed");assert.equal(item.error, "upload_interrupted");
  assert.equal(item.key, "", "a new key next time");
  assert.ok(data.isRetryable(item));
  // The cancel says it completed meanwhile: copied.
  reset();resetPuts([0, 0]);
  server = fakeServer({ status: statusFor([1]), on: { cancel: () => refusal(409, "upload_already_completed") } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "copied");
  // No answer to the cancel: not confirmed, the key kept.
  reset();resetPuts([0, 0]);
  server = fakeServer({ status: statusFor([1]), on: { cancel: () => Promise.reject(new TypeError("Failed to fetch")) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  [item] = state.driveImport.items;
  assert.equal(item.state, "unconfirmed");assert.ok(item.key, "the key is kept");
  assert.match(content.textContent, /1 not confirmed/);
  assert.doesNotMatch(content.textContent, /not copied/);
});

test("14. a PUT that never answers is aborted after its bound: the upload is treated as interrupted, not left hanging", async () => {
  reset();resetPuts(["hang", "hang"]);
  const server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  const bounds = [];
  await data.runDriveImport(render, { sleep: instant, putBound: (bytes) => { bounds.push(bytes); return 5; } });
  const [item] = state.driveImport.items;
  assert.deepEqual(bounds, [item.bytes, item.bytes], "a bound per PUT, from the file's size");
  assert.equal(item.state, "failed");assert.equal(item.error, "upload_interrupted");
  assert.equal(cancels(server).length, 1);
  assert.ok(data.putBoundMs(10_000_000) > data.putBoundMs(1_000), "a bigger file gets longer");
});

test("15. sign-out (401) stops the run with the sentence to sign in again; storage's parallel limit puts the file back in the queue instead of failing it", async () => {
  reset();resetPuts();
  let server = fakeServer({ status: statusFor([1, 2]), on: { initiate: () => refusal(401, "authentication_required") } });
  await chooseFolder(folder({ videos: [1, 2] }));
  await data.runDriveImport(render, { concurrency: 1, sleep: instant });
  assert.equal(state.driveImport.stopCode, "authentication_required");
  assert.equal(imports(server).length, 1);
  assert.match(content.textContent, /Sign in again, open Settings → Storage and choose the same folder/);
  reset();resetPuts();
  let busy = 2;
  const slept = [];
  server = fakeServer({ status: statusFor([1]), on: { initiate: () => (busy-- > 0 ? refusal(429, "parallel_upload_limit", true) : null) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { concurrency: 1, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(state.driveImport.items[0].state, "copied");
  assert.equal(slept.filter((ms) => ms === data.IMPORT_PARALLEL_BACKOFF_MS).length, 2);
  assert.equal(new Set(imports(server).map((call) => call.key)).size, 1, "the same key throughout");
  // Always busy: after the bounded waits the file waits for Continue.
  reset();resetPuts();
  server = fakeServer({ status: statusFor([1]), on: { initiate: () => refusal(429, "parallel_upload_limit", true) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { concurrency: 1, sleep: instant });
  const [item] = state.driveImport.items;
  assert.equal(item.state, "failed");assert.equal(item.error, "parallel_upload_limit");
  assert.equal(imports(server).length, data.IMPORT_PARALLEL_RETRIES + 1);
  assert.ok(data.isRetryable(item));
});

test("16. a transient failure that never clears: the file is 'not confirmed', never 'not copied', and Continue asks again with the same key", async () => {
  reset();resetPuts();
  let down = true;
  const server = fakeServer({ status: statusFor([1]), on: { complete: () => (down ? Promise.reject(new TypeError("Failed to fetch")) : null) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  const [item] = state.driveImport.items;
  assert.equal(item.state, "unconfirmed");
  assert.equal(completions(server).length, data.IMPORT_RETRY_DELAYS_MS.length + 1);
  assert.match(visibleText(), /Not confirmed/);
  assert.match(visibleText(), /may or may not be copied/);
  assert.doesNotMatch(visibleText(), /Not copied/);
  const key = item.key;
  down = false;
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the run ends");
  assert.equal(item.state, "copied");
  assert.equal(imports(server).at(-1).key, key, "the same import");
  assert.equal(server.uploads.size, 1);
});

test("27. the server's 'verification outcome unknown' (a lost claim COMMIT, #203) is 'not confirmed', never 'not copied'; Continue completes the same import with the same key", async () => {
  reset();resetPuts();
  let unknown = true;
  const server = fakeServer({ status: statusFor([1]), on: { complete: () => (unknown ? refusal(503, "verification_outcome_unknown", true) : null) } });
  await chooseFolder(folder({ videos: [1] }));
  await data.runDriveImport(render, { sleep: instant });
  const [item] = state.driveImport.items;
  assert.equal(item.state, "unconfirmed", item.error);
  assert.equal(completions(server).length, data.IMPORT_RETRY_DELAYS_MS.length + 1, "asked again with the same session before giving up");
  assert.match(visibleText(), /Not confirmed/);
  assert.doesNotMatch(visibleText(), /Not copied/);
  const key = item.key;
  unknown = false;
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the run ends");
  assert.equal(item.state, "copied");
  assert.equal(imports(server).at(-1).key, key, "the same import");
  assert.equal(server.uploads.size, 1, "one import, never two");
});

test("17. a running import never paints the rest of the tab: progress is patched in place (same Pause button, open <details> stay open), a change of state replaces the card alone and waits for a pointer, nothing is painted off screen, and an open limit form survives the end of the run", async () => {
  reset();resetPuts(["hold", "hold", "hold", "hold"]);
  fakeServer({ status: statusFor([1, 2, 3, 4]) });
  await chooseFolder(folder({ videos: [1, 2, 3, 4] }));
  // The previous test's run ends with an account read nobody awaits: let it land before counting paints.
  await quiet();
  render();
  const paintsAtStart = renders;
  await click("drive-import-start");
  await until(() => FakeXHR.held.length === 2, "two uploads on their way");
  assert.equal(renders, paintsAtStart, "the start replaced the card, not the tab");
  const pause = content.querySelector('[data-action="drive-import-pause"]');
  assert.ok(pause, "Pause is shown");
  // The second upload's Technical details opened by the administrator (it stays on its way below).
  const details = content.querySelector(`[data-drive-import-details="tech:video:${ID(2)}"]`);
  details.open = true;
  actions.handleDriveImportToggle({ target: details });
  FakeXHR.held.shift().finish(200);
  await until(() => FakeXHR.held.length === 2, "the next file is on its way");
  assert.equal(renders, paintsAtStart, "no paint of the tab while files move on");
  assert.ok(pause.isConnected, "the Pause button is the same element");
  assert.match(content.querySelector("[data-drive-import-counts]").textContent, /1 of 4 copied/);
  const reopened = content.querySelector(`[data-drive-import-details="tech:video:${ID(2)}"]`);
  assert.notEqual(reopened, details, "the list was redrawn (a file left it)");
  assert.equal(reopened.open, true, "an open <details> stays open");
  // A change of the run's own state (here: a notice) replaces the card alone; a field elsewhere keeps its focus.
  const field = document.querySelector("#elsewhere");
  field.focus();
  const paints = actions.importRenders(render);
  const cardBefore = content.querySelector("[data-drive-import-card]");
  state.driveImport.notice = "changed";
  paints.render();
  assert.equal(renders, paintsAtStart);
  assert.notEqual(content.querySelector("[data-drive-import-card]"), cardBefore, "the card was replaced");
  assert.match(content.querySelector("[data-drive-import-card]").textContent, /changed/);
  assert.equal(document.activeElement, field, "the field keeps its focus");
  field.blur();
  // ... and not while a pointer is down: right after it is up.
  actions.handleDriveImportPointer({ type: "pointerdown" });
  const cardHeld = content.querySelector("[data-drive-import-card]");
  state.driveImport.notice = "changed again";
  paints.render();
  assert.equal(content.querySelector("[data-drive-import-card]"), cardHeld, "held while the pointer is down");
  actions.handleDriveImportPointer({ type: "pointerup" });
  await settle();
  assert.notEqual(content.querySelector("[data-drive-import-card]"), cardHeld);
  assert.match(content.querySelector("[data-drive-import-card]").textContent, /changed again/);
  state.driveImport.notice = "";
  // Another Settings section on screen: the run paints nothing there.
  content.innerHTML = "<p>Another section</p>";
  FakeXHR.held.shift().finish(200);
  await until(() => FakeXHR.held.length === 2, "the run goes on off screen");
  assert.equal(content.innerHTML, "<p>Another section</p>");
  assert.equal(renders, paintsAtStart);
  render();
  // A limit form open below when the run ends: the card alone again, never the tab.
  state.storageAdmin.limitEdit = { scope: "panel", accountId: "acc-p", mode: "set", draft: { limitGb: "15" }, error: "", busy: false };
  const paintsBeforeEnd = renders;
  await click("drive-import-pause");
  assert.equal(renders, paintsBeforeEnd, "Pause replaces the card alone");
  while (FakeXHR.held.length) { FakeXHR.held.shift().finish(200); await settle(); }
  await until(() => !state.driveImport.running, "the run ends");
  await settle();
  assert.equal(renders, paintsBeforeEnd, "the end of the run did not paint the tab over the open form");
  assert.match(content.querySelector("[data-drive-import-card]").textContent, /Paused\. Choose Continue to go on\./);
  // Without a form open, the end of a run paints the tab (the system storage row changes too).
  state.storageAdmin.limitEdit = null;
  resetPuts();
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the second run ends");
  assert.ok(renders > paintsBeforeEnd, "the tab is painted at the end");
  assert.match(content.textContent, /Done: 4 files copied/);
  // A paint after the run while a field is being typed in: the card alone.
  const idlePaints = actions.importRenders(render);
  field.focus();
  const paintsWhileTyping = renders;
  idlePaints.render();
  assert.equal(renders, paintsWhileTyping, "not the tab while typing");
  field.blur();
  idlePaints.render();
  assert.equal(renders, paintsWhileTyping + 1);
  // ... and nothing at all while another section is on screen.
  content.innerHTML = "<p>Another section</p>";
  idlePaints.render();
  assert.equal(renders, paintsWhileTyping + 1);
  assert.equal(content.innerHTML, "<p>Another section</p>");
});

test("18. the system storage account past the list's first page is read by id, shown, and put back after the list is read again; too little room names the limit to set", async () => {
  reset({ accounts: [] });
  const server = fakeServer({ status: statusFor([1, 2]), accounts: [] });
  server.account = platformAccount({ usedBytes: "1000", limitBytes: "1010", availableBytes: "10" });
  await chooseFolder(folder({ videos: [1, 2] }));
  assert.ok(server.calls.some((call) => call.path.endsWith("/storage-accounts/acc-p")), "read by id");
  assert.equal(state.storageAdmin.accounts[0]?.storageAccountId, "acc-p");
  assert.match(content.textContent, /OptiMove system storage: 1 KB used of 1 KB; 10 B free\./);
  assert.match(content.textContent, /The files still to upload need 46 B, more than is free\. Set the limit of OptiMove system storage below to at least 1 KB/);
  assert.ok(content.querySelector('[data-action="drive-import-start"]'), "Start stays offered: the server refuses when storage is full");
  // The list is read again (first page only): the account is put back on the next paint.
  await storageData.loadStorageAdmin(render);
  assert.equal(state.storageAdmin.accounts.length, 0);
  actions.ensureDriveImportStatus(render);
  await until(() => state.storageAdmin.accounts.length === 1, "put back");
  actions.ensureDriveImportStatus(render);
  await settle();
  assert.equal(server.calls.filter((call) => call.path.endsWith("/storage-accounts/acc-p")).length, 2, "read once per list read, not on every paint");
});

test("19. Check what is already copied reads the status again and rebuilds the plan from the chosen folder; a workspace switch stops the run and reads the status again later", async () => {
  reset();resetPuts();
  const server = fakeServer({ status: statusFor([1, 2]) });
  await chooseFolder(folder({ videos: [1, 2] }));
  assert.equal(state.driveImport.items.length, 2);
  server.status = statusFor([1, 2], [], [2]);
  await click("drive-import-status");
  assert.deepEqual(state.driveImport.items.map((item) => item.driveFileId), [ID(1)], "copied elsewhere meanwhile: out of the plan");
  assert.equal(state.driveImport.report.copied.video, 1);
  resetPuts(["hold"]);
  await click("drive-import-start");
  await until(() => FakeXHR.held.length === 1, "on its way");
  data.resetDriveImportForWorkspaceChange();
  assert.equal(state.driveImport.running, false);
  assert.equal(state.driveImport.items[0].state, "unconfirmed");
  assert.equal(state.driveImport.status, null, "read again in the platform workspace");
  // The upload on its way answers after all; the stopped run ends without starting anything new.
  FakeXHR.held.shift().finish(200);
  await until(() => state.driveImport.items[0].state === "copied", "its own outcome still lands");
  assert.equal(state.driveImport.running, false);
});

test("20. app.js wires the actions, the folder input, the leave guard, the repaint listeners and the workspace reset; the CSS keeps touch targets and inputs at 16px", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /await handleDriveImportAction\(action, \{ render: renderDataSourcesSurface \}\)/);
  assert.match(app, /await handleDriveImportChange\(event, \{ render: renderDataSourcesSurface \}\)/);
  assert.match(app, /ensureDriveImportStatus\(renderDataSourcesSurface\)/);
  assert.match(app, /addEventListener\("beforeunload", handleDriveImportBeforeUnload\)/);
  assert.match(app, /addEventListener\("toggle", handleDriveImportToggle, true\)/);
  for (const type of ["pointerdown", "pointerup", "pointercancel"]) assert.match(app, new RegExp(`addEventListener\\("${type}", handleDriveImportPointer, true\\)`));
  assert.doesNotMatch(app, /handleDriveImportFocusOut/);
  assert.match(app, /async function onWorkspaceChanged\(\) \{\s+resetExercisesForWorkspaceChange\(\);\s+resetDriveImportForWorkspaceChange\(\);/);
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\) \{\s*\/\*[^*]*\*\/\s*\.storage-admin-technical > summary, \.drive-import-problems > summary, \.drive-import-failed > summary \{ display: list-item;[^}]*min-height: 44px/);
  assert.match(css, /\.drive-import-folder \{[^}]*min-height: 44px/);
  assert.match(css, /\.drive-import-folder-input \{[^}]*font-size: 16px/);
  assert.match(css, /\.drive-import-card \{ overflow-wrap: anywhere; \}/);
  assert.match(css, /\.drive-import-computer-note \{[^}]*font-size: 16px;[^}]*font-weight: 600/);
  assert.match(css, /\.drive-import-primary:disabled \{ opacity: 1;[^}]*color: var\(--muted\)/, "a switched-off Start stays legible");
  assert.doesNotMatch(css, /drive-import-phone-note/, "the width-only phone note is gone: the touch check decides");
});

test("21. a pointer held on the 'not copied' list keeps that list (and its summary) through a change, which lands right after the pointer is up; a focused summary keeps its focus; a hold expires; a second finger does not count", async () => {
  reset();resetPuts([200, "hold", "hold"]);
  state.storageAdmin.policy.maxParallelUploads = 1; // one file at a time: a fixed order
  const refuse = new Set([ID(1), ID(2)]);
  fakeServer({ status: statusFor([1, 2, 3]), on: { complete: (call, s) => {
    const upload = s.uploads.get(decodeURIComponent(call.path.split("/").at(-2)));
    return refuse.has(upload?.driveFileId) ? refusal(415, "unsupported_media") : null;
  } } });
  await chooseFolder(folder({ videos: [1, 2, 3] }));
  render();
  await click("drive-import-start");
  await until(() => FakeXHR.held.length === 1 && state.driveImport.items[0].state === "failed", "one refused, the next on its way");
  const summary = content.querySelector('[data-drive-import-details="failed"] > summary');
  assert.match(summary.textContent, /1 not copied/);
  summary.focus();
  actions.handleDriveImportPointer({ type: "pointerdown", button: 0, isPrimary: true });
  FakeXHR.held.shift().finish(200); // the second file: refused too
  await until(() => state.driveImport.items[1].state === "failed" && FakeXHR.held.length === 1, "the second file is refused, the third on its way");
  await settle();
  assert.ok(summary.isConnected, "not redrawn under the pointer");
  assert.match(summary.textContent, /1 not copied/);
  assert.match(content.querySelector("[data-drive-import-counts]").textContent, /2 not copied/, "the counts still move");
  actions.handleDriveImportPointer({ type: "pointerup", isPrimary: true });
  await settle();
  const redrawn = content.querySelector('[data-drive-import-details="failed"] > summary');
  assert.notEqual(redrawn, summary, "redrawn right after");
  assert.match(redrawn.textContent, /2 not copied/);
  assert.equal(document.activeElement, redrawn, "the focused summary keeps its focus");
  // A second finger does not hold anything; a hold with no pointerup expires.
  const paints = actions.importRenders(render);
  actions.handleDriveImportPointer({ type: "pointerdown", isPrimary: false });
  let card = content.querySelector("[data-drive-import-card]");
  state.driveImport.notice = "second finger";
  paints.render();
  assert.notEqual(content.querySelector("[data-drive-import-card]"), card, "not held by a second finger");
  actions.handleDriveImportPointer({ type: "pointerdown", button: 0 });
  card = content.querySelector("[data-drive-import-card]");
  state.driveImport.notice = "held";
  paints.render();
  assert.equal(content.querySelector("[data-drive-import-card]"), card, "held");
  await new Promise((resolve) => setTimeout(resolve, actions.POINTER_HOLD_MS + 150));
  assert.notEqual(content.querySelector("[data-drive-import-card]"), card, "a hold expires without a pointerup");
  actions.handleDriveImportPointer({ type: "pointerup" });
  state.driveImport.notice = "";
  FakeXHR.held.shift().finish(200);
  await until(() => !state.driveImport.running, "the run ends");
});

test("22. a file the browser can no longer read is 'missing from the folder' (prepare or choose again), and a failure no server refusal decided is 'not confirmed'", async () => {
  reset();resetPuts();
  let server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  const [item] = state.driveImport.items;
  item.file.arrayBuffer = () => Promise.reject(new dom.window.DOMException("gone", "NotReadableError"));
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(item.state, "failed");assert.equal(item.error, "file_missing");
  assert.equal(data.isRetryable(item), false);
  assert.equal(imports(server).length, 0);
  reset();resetPuts();
  server = fakeServer({ status: statusFor([1]) });
  await chooseFolder(folder({ videos: [1] }));
  let thrown = false;
  const brittle = () => {
    if (!thrown && state.driveImport.items[0].state === "completing") { thrown = true; throw new Error("paint failed"); }
    render();
  };
  await data.runDriveImport(brittle, { sleep: instant });
  assert.equal(state.driveImport.items[0].state, "unconfirmed");
  assert.match(content.textContent, /Not confirmed/);
  await click("drive-import-start");
  await until(() => !state.driveImport.running, "the run ends");
  assert.equal(state.driveImport.items[0].state, "copied");
  assert.equal(server.uploads.size, 1, "the same import");
});

test("23. a failed read of the system storage account says so and offers Try again; nothing asks again by itself", async () => {
  reset({ accounts: [] });
  let failing = true;
  const server = fakeServer({ status: statusFor([1]), accounts: [], on: { account: () => (failing ? refusal(503, "media_storage_unavailable", true) : null) } });
  await chooseFolder(folder({ videos: [1] }));
  assert.match(content.textContent, /OptiMove system storage could not be read\./);
  const tryAgain = Array.from(content.querySelectorAll('[data-action="drive-import-status"]')).find((b) => b.textContent.trim() === "Try again");
  assert.ok(tryAgain, "Try again is offered");
  assert.ok(tryAgain.parentElement.classList.contains("storage-admin-actions"), "in the action row that gives it a 44 px target, not inline in the sentence");
  assert.equal(tryAgain.closest("p"), null, "not inside the paragraph");
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.match(css, /\.storage-admin-actions \.plain-button, \.storage-admin-actions \.text-action \{ min-height: 44px; min-width: 44px; \}/);
  const reads = () => server.calls.filter((call) => call.path.endsWith("/storage-accounts/acc-p")).length;
  assert.equal(reads(), 1);
  actions.ensureDriveImportStatus(render);
  await settle();
  assert.equal(reads(), 1, "no read by itself");
  failing = false;
  await click("drive-import-status");
  assert.equal(reads(), 2);
  assert.match(content.textContent, /OptiMove system storage: 0 B used of 15 GB/);
});

test("24. a status answer that lands after a workspace switch is dropped", async () => {
  reset();
  let answer;
  fakeServer({ on: { status: () => new Promise((resolve) => { answer = resolve; }) } });
  const loading = data.loadDriveImportStatus(render);
  await until(() => typeof answer === "function", "the read is on its way");
  data.resetDriveImportForWorkspaceChange();
  answer(refusal(403, "operation_not_allowed"));
  await loading;
  assert.equal(state.driveImport.statusError, "");
  assert.equal(state.driveImport.status, null);
  assert.equal(state.driveImport.loadingStatus, false);
});

test("25. byte progress is not a live region (a screen reader is not flooded); the notice and the done sentence are; card actions keep an open limit form", async () => {
  reset();resetPuts();
  const server = fakeServer({ status: statusFor([1, 2]) });
  await chooseFolder(folder({ videos: [1, 2] }));
  assert.equal(content.querySelector("[data-drive-import-counts]").closest("[role=status],[aria-live]"), null);
  await data.runDriveImport(render, { sleep: instant });
  assert.equal(content.querySelector(".drive-import-done").getAttribute("role"), "status");
  state.driveImport.notice = "Paused. Choose Continue to go on.";
  render();
  assert.equal(Array.from(content.querySelectorAll('.drive-import-progress [role="status"]')).map((element) => element.textContent).join(), "Paused. Choose Continue to go on.");
  // "Check what is already copied" and a folder choice with the limit form open: the card alone.
  state.driveImport.notice = "";
  state.storageAdmin.limitEdit = { scope: "panel", accountId: "acc-p", mode: "set", draft: { limitGb: "15" }, error: "", busy: false };
  await until(() => state.storageAdmin.accounts.length === 1 && !server.calls.at(-1).path.endsWith("/status"), "the run's last account read landed");
  await settle();
  render();
  const before = renders;
  await click("drive-import-status");
  const input = document.createElement("input");input.setAttribute("data-drive-import-folder", "");
  Object.defineProperty(input, "files", { value: folder({ videos: [1, 2] }) });
  await actions.handleDriveImportChange({ target: input }, { render });
  assert.equal(renders, before, "the tab (and the open form) is not painted again");
  assert.match(content.querySelector("[data-drive-import-card]").textContent, /2 videos and 0 pictures to copy/, "the card shows the new plan");
  assert.equal(state.driveImport.items.length, 2);
});

test("26. on a touch device (phone or tablet) the import is shown but switched off, with the reason next to its buttons (described for screen readers); nothing can start or read a folder there; a computer is unaffected", async () => {
  const coarse = { on: true };
  const realMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = (query) => ({ media: query, matches: query === view.COMPUTER_ONLY_QUERY && coarse.on, addEventListener() {}, removeEventListener() {} });
  try {
    reset();resetPuts();
    const server = fakeServer({ status: statusFor([1, 2]) });
    await data.loadDriveImportStatus(render);
    const folderInput = () => content.querySelector("[data-drive-import-folder]");
    const note = () => content.querySelector("#drive-import-computer-note");
    assert.ok(folderInput().disabled, "the folder button is switched off");
    assert.match(folderInput().closest("label").className, /is-disabled/);
    assert.match(folderInput().closest("label").textContent, /Choose the prepared folder/, "still shown");
    assert.equal(note()?.textContent, "Import works only on a computer. A phone or tablet cannot choose the prepared folder.");
    assert.equal(folderInput().getAttribute("aria-describedby"), "drive-import-computer-note", "the reason is announced with the control");
    assert.doesNotMatch(content.textContent, /Your browser asks to upload/, "no folder-dialog hint on a phone");
    // A plan already on screen (chosen on another device in this browser's state): Start is shown, switched off, described.
    await chooseFolder(folder({ videos: [1, 2] }));
    const start = content.querySelector('[data-action="drive-import-start"]');
    assert.ok(start, "Start is shown");
    assert.ok(start.disabled);
    assert.equal(start.getAttribute("aria-describedby"), "drive-import-computer-note");
    assert.ok(content.querySelector(`#${start.getAttribute("aria-describedby")}`), "it points at the visible note");
    assert.doesNotMatch(content.textContent, /Create OptiMove system storage first/, "not the system-storage sentence: storage exists");
    await click("drive-import-start");
    assert.equal(state.driveImport.running, false);
    assert.equal(imports(server).length, 0, "nothing sent");
    const input = document.createElement("input");input.setAttribute("data-drive-import-folder", "");
    Object.defineProperty(input, "files", { value: folder({ videos: [1] }) });
    const planBefore = state.driveImport.items.length;
    assert.equal(await actions.handleDriveImportChange({ target: input }, { render }), true, "claimed and ignored");
    assert.equal(state.driveImport.items.length, planBefore, "no folder is read on a touch device");
    // A computer: everything as before, no note.
    coarse.on = false;
    render();
    assert.equal(folderInput().disabled, false);
    assert.equal(folderInput().hasAttribute("aria-describedby"), false);
    assert.equal(note(), null);
    assert.equal(content.querySelector('[data-action="drive-import-start"]').disabled, false);
    assert.match(content.textContent, /Your browser asks to upload/);
    await click("drive-import-start");
    await until(() => !state.driveImport.running, "the run ends");
    assert.deepEqual(state.driveImport.items.map((item) => item.state), ["copied", "copied"]);
  } finally {
    globalThis.matchMedia = realMatchMedia;
  }
});
