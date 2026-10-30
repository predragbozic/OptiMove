import { test } from "node:test";
import assert from "node:assert/strict";

// FE-2: the BE-2 upload transport (docs/backend/r2-upload-api-v1.md) against
// a fake API and a fake XMLHttpRequest - initiation with the idempotency key,
// the PUT with progress and one whole retry, 412, renewal, cancellation
// through the server, completion with 202 polling, a timed-out completion,
// the error codes - plus the storage read, the local checks, the sentences
// and the two integration guards. Nothing here reaches a server.

const upload = await import("../exercise-media-upload.js");
const { formatBytes } = await import("../utils.js");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const account = (overrides = {}) => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000",
  availableBytes: "3800000000", limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"],
  overrideLimitBytes: null, revision: 1, ...overrides,
});
const file = (name, size, type) => ({ name, size, type });
const readyMedia = (mediaId = "media-1") => ({ source: "asset", mediaId, kind: "video", status: "ready", mimeType: "video/mp4", sizeBytes: "100", metadata: { durationSeconds: 4.2, width: 640, height: 360, videoCodec: "h264", audioCodec: null } });
const session = (overrides = {}) => ({
  uploadId: "up-1", mediaId: "media-1", status: "pending", expiresAt: minutesFromNow(10), errorCode: null,
  upload: { method: "PUT", url: "https://r2.example/pending/up-1?sig=1", headers: { "Content-Type": "video/mp4", "If-None-Match": "*" }, expiresAt: minutesFromNow(10) },
  reservation: { bytes: "100", expiresAt: minutesFromNow(10) }, ...overrides,
});
const edit = { type: "exercise_edit", exerciseId: "e1" };
const noSleep = { sleep: async () => {} };

// The API fake: a router of (method, path) -> reply; every call recorded.
function fakeApi(routes) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
    calls.push(call);
    const route = routes.find((entry) => entry.method === call.method && (typeof entry.path === "string" ? entry.path === call.url : entry.path.test(call.url)));
    if (!route) return { ok: false, status: 404, statusText: "Not found", json: async () => ({ error: "Resource not found.", code: "resource_not_found", retryable: false, details: {} }) };
    const reply = await route.reply(call, calls);
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    if (reply?.networkError) throw new TypeError("Failed to fetch");
    return { ok: true, status: reply?.httpStatus || 200, json: async () => reply };
  };
  return calls;
}

// A fake XMLHttpRequest the tests drive by hand.
class FakeXHR {
  static instances = [];
  static onSend = null;
  constructor() {
    this.headers = {};
    this.upload = {};
    this.withCredentials = true;
    this.status = 0;
    FakeXHR.instances.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(body) { this.body = body; this.sent = true; FakeXHR.onSend?.(this); }
  abort() { this.aborted = true; this.onabort?.(); }
  progress(loaded, total) { this.upload.onprogress?.({ loaded, total, lengthComputable: true }); }
  finish(status) { this.status = status; this.onload?.(); }
  fail() { this.onerror?.(); }
}
globalThis.XMLHttpRequest = FakeXHR;
const resetXhr = () => { FakeXHR.instances = []; FakeXHR.onSend = null; };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const initiate = (reply = () => session()) => ({ method: "POST", path: upload.UPLOADS_ROUTE, reply });
const status = (reply) => ({ method: "GET", path: /^\/api\/media\/uploads\/up-1$/, reply });
const complete = (reply) => ({ method: "POST", path: /^\/api\/media\/uploads\/up-1\/complete$/, reply });
const renew = (reply) => ({ method: "POST", path: /^\/api\/media\/uploads\/up-1\/renew$/, reply });
const cancel = (reply) => ({ method: "DELETE", path: /^\/api\/media\/uploads\/up-1$/, reply });
const completed = () => ({ uploadId: "up-1", mediaId: "media-1", status: "completed", expiresAt: minutesFromNow(10), errorCode: null, media: readyMedia() });

test("1. bytes read as the coach reads them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes("184000000"), "184 MB");
  assert.equal(formatBytes(1200000000), "1.2 GB");
  assert.equal(formatBytes(209715200), "209.7 MB");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes("nonsense"), "");
});

test("2. the local checks: the slot's and the server's types, the per-file ceiling, the free space, the parallel cap; without a usage row only the type", () => {
  const a = account();
  assert.deepEqual(upload.validateFile(file("a.mp4", 1000, "video/mp4"), "video", a), { ok: true });
  assert.equal(upload.validateFile(file("a.mp4", 1000, "video/mp4"), "image", a).code, "unsupported_media");
  assert.equal(upload.validateFile(file("a.mov", 1000, "video/quicktime"), "video", a).code, "unsupported_media");
  assert.equal(upload.validateFile(file("a.webm", 1000, "video/webm"), "video", account({ allowedMimeTypes: ["video/mp4"] })).code, "unsupported_media");
  assert.equal(upload.validateFile(file("a.mp4", 209715201, "video/mp4"), "video", a).code, "file_too_large");
  assert.equal(upload.validateFile(file("a.mp4", 100000000, "video/mp4"), "video", account({ availableBytes: "99999999" })).code, "storage_quota_exceeded");
  assert.equal(upload.validateFile(file("a.mp4", 10, "video/mp4"), "video", account({ overLimit: true })).code, "storage_quota_exceeded");
  assert.equal(upload.validateFile(file("a.mp4", 10, "video/mp4"), "video", account({ activeUploads: 2 })).code, "parallel_upload_limit");
  assert.deepEqual(upload.validateFile(file("a.mp4", 10 ** 12, "video/mp4"), "video", null), { ok: true });
  assert.equal(upload.validateFile(null, "video", a).code, "invalid_file");
});

test("3. one sentence per code; a lost answer is never 'nothing was uploaded'", () => {
  const a = account();
  assert.equal(upload.describeUploadError("file_too_large", { slot: "video", file: file("a.mp4", 300000000, "video/mp4"), account: a }), "This file is 300 MB. The limit for one video is 209.7 MB.");
  assert.equal(upload.describeUploadError("storage_quota_exceeded", { slot: "video", file: file("a.mp4", 184000000, "video/mp4"), account: account({ availableBytes: "120000000" }) }), "This file needs 184 MB, but only 120 MB of your storage are free. Remove media you no longer use or ask an administrator for more storage.");
  assert.match(upload.describeUploadError("unsupported_media", { slot: "video" }), /MP4 or MOV videos/);
  // The on-device preparation's codes have their own sentences.
  assert.match(upload.describeUploadError("video_too_long", { slot: "video", detail: { durationSeconds: 51.2, maxSeconds: 30 } }), /51 seconds long\. The limit is 30 seconds/);
  assert.match(upload.describeUploadError("input_too_large", { slot: "video", detail: { size: 300000000, maxInputBytes: 100000000 } }), /300 MB\. Choose a video under 100 MB/);
  assert.match(upload.describeUploadError("conversion_unavailable", { slot: "video" }), /can't be prepared on this device/);
  assert.equal(upload.describeUploadError("preparation_cancelled", { slot: "video" }), "Preparation cancelled.");
  assert.match(upload.describeUploadError("media_verification_failed", { slot: "image" }), /could not be verified/);
  assert.match(upload.describeUploadError("upload_expired"), /permission expired/);
  assert.match(upload.describeUploadError("upload_rate_limit"), /Too many uploads/);
  assert.match(upload.describeUploadError("verification_timeout"), /Check again/);
  assert.match(upload.describeUploadError("upload_transport_disabled"), /not available yet/);
  assert.equal(upload.describeUploadError("cancelled"), "Upload cancelled.");
  assert.match(upload.describeUploadError("cancel_unconfirmed"), /once the server has confirmed/);
  for (const code of ["media_storage_busy", "media_storage_unavailable", "upload_not_present", "network", "timeout", "state_conflict"]) {
    const sentence = upload.describeUploadError(code);
    assert.match(sentence, /did not finish/, code);
    assert.doesNotMatch(sentence, /nothing was uploaded/i);
  }
  assert.deepEqual(upload.RESUMABLE_CODES.filter(upload.isResumableCode), [...upload.RESUMABLE_CODES]);
  assert.equal(upload.isResumableCode("media_verification_failed"), false);
});

test("4. the storage read: BE-1's row for a new exercise, BE-2's resolved owner for an existing one; the labels of Q8", async () => {
  const plain = fakeApi([{ method: "GET", path: upload.STORAGE_ROUTE, reply: () => ({ accounts: [account({ owner: { type: "club", id: "c1", name: "FK Example" }, storageAccountId: "acc-club" }), account()] }) }]);
  const own = await upload.readStorageUsage();
  assert.equal(plain[0].url, upload.STORAGE_ROUTE);
  assert.equal(own.selectedStorageAccountId, "");
  assert.equal(upload.chargedAccount(own, { userId: "u1" }).storageAccountId, "acc-1", "the signed-in user's own row");
  assert.equal(upload.chargedAccount(own, { userId: "someone-else" }), null, "never another user's row, never the first row");
  const targeted = fakeApi([{ method: "GET", path: `${upload.STORAGE_ROUTE}?exerciseId=e1`, reply: () => ({ accounts: [account({ owner: { type: "user", id: "owner-9" }, storageAccountId: "acc-owner" })], selectedStorageAccountId: "acc-owner" }) }]);
  const resolved = await upload.readStorageUsage({ exerciseId: "e1" });
  assert.equal(targeted[0].url, `${upload.STORAGE_ROUTE}?exerciseId=e1`);
  assert.equal(upload.chargedAccount(resolved, { userId: "u1" }).storageAccountId, "acc-owner", "the server's selection wins over the viewer's own row");
  assert.equal(upload.describeStorageAccount(account(), { ownerScope: "system" }), "personal storage (uploading administrator)");
  assert.equal(upload.describeStorageAccount(account()), "personal storage");
  assert.equal(upload.describeStorageAccount(account({ owner: { type: "club", id: "c1", name: "FK Example" } })), "club storage of FK Example");
  const code = async (reply) => {
    fakeApi([{ method: "GET", path: /storage/, reply: () => reply }]);
    try {
      await upload.readStorageUsage({ exerciseId: "e1" });
      return "no error";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(await code({ status: 503, json: { code: "media_storage_disabled" } }), "media_storage_disabled");
  assert.equal(await code({ status: 403, json: { code: "operation_not_allowed" } }), "operation_not_allowed");
  assert.equal(await code({ status: 404, json: { code: "resource_not_found" } }), "resource_not_found");
  assert.equal(await code({ status: 503, json: { code: "media_storage_unavailable" } }), "storage_unavailable");
  globalThis.fetch = async () => { throw new Error("network"); };
  await assert.rejects(upload.readStorageUsage(), (error) => error.code === "storage_unavailable");
});

test("5. the guards: the transport refuses and sends nothing while off; the save body gains nothing until BE-3, then the contract's media selection", async () => {
  upload.setUploadTransportEnabled(false);
  const calls = fakeApi([initiate()]);
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 10, "video/mp4"), slot: "video", context: edit }), (error) => error.code === "upload_transport_disabled");
  assert.equal(calls.length, 0);
  assert.equal(upload.isUploadTransportEnabled(), false);
  const media = { video: { state: "uploaded", mediaId: "m1" }, image: { state: "none", removedMediaId: "old" } };
  upload.setMediaSaveEnabled(false);
  assert.deepEqual(upload.applyMediaToSavePayload({ name: "x", videoUrl: "", imageUrl: "" }, media), { name: "x", videoUrl: "", imageUrl: "" }, "BE-3 absent: exactly today's body");
  assert.deepEqual(upload.mediaSavePayload(media), {});
  // H1: a slot that holds a stored R2 file sends no legacy field, whatever the guard says -
  // BE-3 would read a present (even empty) videoUrl as a legacy selection and detach the file.
  const stored = { video: { state: "stored", mediaId: "keep" }, image: { state: "none" } };
  assert.deepEqual(upload.applyMediaToSavePayload({ name: "x", videoUrl: "", imageUrl: "https://x/y.jpg" }, stored), { name: "x", imageUrl: "https://x/y.jpg" }, "the stored slot's key is omitted, the legacy slot's kept");
  assert.deepEqual(upload.applyMediaToSavePayload({ videoUrl: "https://old.example/retained.mp4", imageUrl: "" }, stored), { imageUrl: "" }, "a retained old link under a stored file is not resent either");
  const failedReplace = { video: { state: "failed", previous: { state: "stored", mediaId: "keep" } }, image: { state: "none" } };
  assert.deepEqual(upload.applyMediaToSavePayload({ videoUrl: "", imageUrl: "" }, failedReplace), { imageUrl: "" }, "a Replace that failed still holds the stored file");
  upload.setMediaSaveEnabled(true);
  assert.deepEqual(upload.applyMediaToSavePayload({ videoUrl: "", imageUrl: "" }, stored), { imageUrl: "" }, "BE-3 on: an untouched stored slot is omitted from both formats");
  upload.setMediaSaveEnabled(true);
  assert.deepEqual(upload.applyMediaToSavePayload({ name: "x", videoUrl: "", imageUrl: "" }, media), { name: "x", media: { video: { source: "asset", mediaId: "m1" }, image: { source: "none" } } }, "Q5: asset / none, never both formats for one slot");
  assert.deepEqual(upload.applyMediaToSavePayload({ videoUrl: "https://youtu.be/dQw4w9WgXcQ", imageUrl: "https://x/y.jpg" }, { video: { state: "none", removedMediaId: "old" }, image: { state: "stored", mediaId: "keep" } }),
    { media: { video: { source: "legacy", url: "https://youtu.be/dQw4w9WgXcQ" } } }, "a link that replaced a stored file; an untouched stored slot is omitted from both formats (H1)");
  assert.deepEqual(upload.applyMediaToSavePayload({ videoUrl: "https://youtu.be/x", imageUrl: "" }, { video: { state: "none" }, image: { state: "none" } }), { videoUrl: "https://youtu.be/x", imageUrl: "" }, "no R2 change: the legacy body as before");
  upload.setMediaSaveEnabled(false);
  assert.deepEqual(upload.uploadContextFor({ exerciseId: "e1" }), { type: "exercise_edit", exerciseId: "e1" });
  assert.deepEqual(upload.uploadContextFor({ isNew: true }), { type: "exercise_create" });
  assert.deepEqual(upload.uploadContextFor({ isCopy: true, exerciseId: "e1" }), { type: "exercise_create" });
});

test("6. a successful upload: initiation with the idempotency key, the raw File PUT with exactly the returned headers and progress, completion", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const calls = fakeApi([initiate(), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => { xhr.progress(50, 100); xhr.finish(200); };
  const progress = [];
  const chosen = file("squat.mp4", 100, "video/mp4");
  const result = await upload.startUpload({ file: chosen, slot: "video", context: edit }, { ...noSleep, onProgress: (p) => progress.push(p) });
  assert.deepEqual(result, { uploadId: "up-1", mediaId: "media-1", status: "completed", media: readyMedia() });
  const [initiation, completion] = calls;
  assert.equal(initiation.url, upload.UPLOADS_ROUTE);
  assert.match(initiation.headers["Idempotency-Key"], UUID);
  assert.equal(initiation.headers["Content-Type"], "application/json");
  assert.deepEqual(initiation.body, { context: { type: "exercise_edit", exerciseId: "e1" }, kind: "video", purpose: "exercise_video", file: { name: "squat.mp4", mimeType: "video/mp4", sizeBytes: "100" } });
  const xhr = FakeXHR.instances[0];
  assert.equal(xhr.method, "PUT");
  assert.equal(xhr.url, "https://r2.example/pending/up-1?sig=1");
  assert.deepEqual(xhr.headers, { "Content-Type": "video/mp4", "If-None-Match": "*" }, "exactly the returned headers, never Content-Length");
  assert.equal(xhr.withCredentials, false, "nothing of OptiMove's session goes to R2");
  assert.equal(xhr.body, chosen, "the raw File, no FormData");
  assert.deepEqual(progress, [{ sent: 50, total: 100 }]);
  assert.equal(completion.url, "/api/media/uploads/up-1/complete");
  assert.deepEqual(completion.body, {});
  assert.equal(calls.length, 2, "no status poll after a 200 completion");
  // The contexts: a new exercise or a copy upload into the user's own quota; FE-1's access context is refused before any request.
  resetXhr();
  const create = fakeApi([initiate((call) => { assert.deepEqual(call.body.context, { type: "exercise_create" }); return session(); }), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: file("a.png", 10, "image/png"), slot: "image", context: { type: "exercise_create" } }, noSleep);
  assert.equal(create[0].body.purpose, "exercise_image");
  await assert.rejects(upload.startUpload({ file: chosen, slot: "video", context: { type: "exercise", id: "e1" } }, noSleep), (error) => error.code === "invalid_request");
  assert.equal(create.length, 2, "the FE-1 context never reached the server");
  // A header the browser owns in the server's answer is never set by hand.
  resetXhr();
  fakeApi([initiate(() => session({ upload: { ...session().upload, headers: { "Content-Type": "video/mp4", "If-None-Match": "*", "Content-Length": "100", Authorization: "x" } } })), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: chosen, slot: "video", context: edit }, noSleep);
  assert.deepEqual(Object.keys(FakeXHR.instances[0].headers), ["Content-Type", "If-None-Match"]);
});

test("7. an interrupted PUT: the status decides, then one whole PUT of the same File with the same permission; a second interruption is upload_interrupted, resumable", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const calls = fakeApi([initiate(), status(() => session()), complete(() => completed())]);
  let sends = 0;
  FakeXHR.onSend = (xhr) => { sends += 1; if (sends === 1) xhr.fail(); else xhr.finish(200); };
  const chosen = file("a.mp4", 100, "video/mp4");
  const result = await upload.startUpload({ file: chosen, slot: "video", context: edit }, noSleep);
  assert.equal(result.status, "completed");
  assert.equal(FakeXHR.instances.length, 2);
  assert.equal(FakeXHR.instances[1].body, chosen);
  assert.equal(FakeXHR.instances[1].url, FakeXHR.instances[0].url);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "GET /api/media/uploads/up-1", "POST /api/media/uploads/up-1/complete"]);
  resetXhr();
  fakeApi([initiate(), status(() => session())]);
  FakeXHR.onSend = (xhr) => xhr.fail();
  await assert.rejects(upload.startUpload({ file: chosen, slot: "video", context: edit }, noSleep), (error) => error.code === "upload_interrupted" && error.uploadId === "up-1" && UUID.test(error.idempotencyKey) && upload.isResumableCode(error.code));
  assert.equal(FakeXHR.instances.length, 2, "one retry, never a loop");
  // A failed PUT whose status says the object did arrive needs no second PUT.
  resetXhr();
  fakeApi([initiate(), status(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.fail();
  assert.equal((await upload.startUpload({ file: chosen, slot: "video", context: edit }, noSleep)).status, "completed");
  assert.equal(FakeXHR.instances.length, 1);
});

test("8. 412 means the object already exists: straight to completion, nothing overwritten", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const calls = fakeApi([initiate(), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(412);
  const result = await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep);
  assert.equal(result.mediaId, "media-1");
  assert.equal(FakeXHR.instances.length, 1);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "POST /api/media/uploads/up-1/complete"]);
});

test("9. a permission close to its expiry is renewed before the PUT, and the renewed address is used", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const soon = new Date(Date.now() + 30_000).toISOString();
  const calls = fakeApi([
    initiate(() => session({ upload: { ...session().upload, expiresAt: soon } })),
    renew(() => session({ upload: { ...session().upload, url: "https://r2.example/pending/up-1?sig=2", expiresAt: minutesFromNow(10) } })),
    complete(() => completed()),
  ]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "POST /api/media/uploads/up-1/renew", "POST /api/media/uploads/up-1/complete"]);
  assert.equal(FakeXHR.instances[0].url, "https://r2.example/pending/up-1?sig=2");
  // A renewal the server refuses (the window is over) ends the attempt with upload_expired.
  resetXhr();
  fakeApi([initiate(() => session({ upload: { ...session().upload, expiresAt: soon } })), renew(() => ({ status: 409, json: { code: "upload_expired" } }))]);
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep), (error) => error.code === "upload_expired");
  assert.equal(FakeXHR.instances.length, 0);
});

test("10. cancel: the request stops AND the server is told; a cancel that came too late returns the ready media", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const calls = fakeApi([initiate(), cancel(() => ({ uploadId: "up-1", mediaId: "media-1", status: "cancelled", expiresAt: minutesFromNow(10), errorCode: null }))]);
  const controller = new AbortController();
  FakeXHR.onSend = () => setTimeout(() => controller.abort(), 0);
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { ...noSleep, signal: controller.signal }),
    (error) => error.code === "cancelled" && error.cancelOutcome === "cancelled" && error.uploadId === "up-1");
  assert.equal(FakeXHR.instances[0].aborted, true);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "DELETE /api/media/uploads/up-1"]);
  // The server could not confirm: the sentence says the space is released once it does.
  resetXhr();
  fakeApi([initiate(), cancel(() => ({ status: 503, json: { code: "media_storage_busy", retryable: true } }))]);
  const second = new AbortController();
  FakeXHR.onSend = () => setTimeout(() => second.abort(), 0);
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { ...noSleep, signal: second.signal }), (error) => error.code === "cancel_unconfirmed");
  // Too late: 409 upload_already_completed -> the ready media.
  resetXhr();
  fakeApi([initiate(), cancel(() => ({ status: 409, json: { code: "upload_already_completed" } })), status(() => completed())]);
  const third = new AbortController();
  FakeXHR.onSend = () => setTimeout(() => third.abort(), 0);
  const late = await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { ...noSleep, signal: third.signal });
  assert.equal(late.status, "completed");
  assert.deepEqual(upload.cancelUpload && (await upload.cancelUpload("up-1")), { outcome: "completed", errorCode: null });
});

test("11. completion 202: the status is polled with the contract's increasing delays until it is completed; a failed verification carries its code", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  let polls = 0;
  const calls = fakeApi([
    initiate(),
    complete(() => ({ httpStatus: 202, uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null })),
    status(() => (++polls < 4 ? { uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null } : completed())),
  ]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  const delays = [];
  const result = await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result.media.status, "ready");
  assert.deepEqual(delays, [1000, 2000, 4000]);
  assert.equal(calls.filter((call) => call.method === "GET").length, 4);
  resetXhr();
  polls = 0;
  fakeApi([initiate(), complete(() => ({ httpStatus: 202, uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null })),
    status(() => (++polls < 2 ? { uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null } : { uploadId: "up-1", mediaId: "media-1", status: "failed", expiresAt: minutesFromNow(10), errorCode: "media_verification_failed" }))]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep), (error) => error.code === "media_verification_failed" && !upload.isResumableCode(error.code));
  // The budget: still verifying after it is verification_timeout, with the upload id for Check again.
  resetXhr();
  fakeApi([initiate(), complete(() => ({ httpStatus: 202, uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null })),
    status(() => ({ uploadId: "up-1", mediaId: "media-1", status: "verifying", expiresAt: minutesFromNow(10), errorCode: null }))]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  let clock = 0;
  await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { sleep: async (ms) => { clock += ms; }, now: () => clock }),
    (error) => error.code === "verification_timeout" && error.uploadId === "up-1");
});

test("12. a completion that times out is an unknown state: the status is read before anything is repeated; a session still pending gets one more completion", async () => {
  upload.setUploadTransportEnabled(true);
  const original = upload.CLIENT_BOUNDS.completion;
  upload.CLIENT_BOUNDS.completion = 20;
  try {
    resetXhr();
    const calls = fakeApi([initiate(), complete((call) => new Promise((resolve, reject) => { call.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); })), status(() => completed())]);
    FakeXHR.onSend = (xhr) => xhr.finish(200);
    const result = await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "POST /api/media/uploads/up-1/complete", "GET /api/media/uploads/up-1"]);
    // The completion never landed: the status says pending, so complete is sent once more.
    resetXhr();
    let completions = 0;
    const again = fakeApi([initiate(), complete((call) => (++completions === 1 ? new Promise((resolve, reject) => { call.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); }) : completed())), status(() => session())]);
    FakeXHR.onSend = (xhr) => xhr.finish(200);
    assert.equal((await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep)).status, "completed");
    assert.deepEqual(again.map((call) => `${call.method} ${call.url}`), ["POST /api/media/uploads", "POST /api/media/uploads/up-1/complete", "GET /api/media/uploads/up-1", "POST /api/media/uploads/up-1/complete"]);
  } finally {
    upload.CLIENT_BOUNDS.completion = original;
  }
});

test("13. idempotency: a lost initiation is retried with the same key; a resumed attempt reuses its key; a new attempt gets a new one; a conflict and a quota refusal are their codes", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  let initiations = 0;
  const calls = fakeApi([initiate(() => (++initiations === 1 ? { networkError: true } : session())), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep);
  const keys = calls.filter((call) => call.url === upload.UPLOADS_ROUTE).map((call) => call.headers["Idempotency-Key"]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the same key after a lost answer");
  resetXhr();
  const resumed = fakeApi([initiate(), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, { ...noSleep, idempotencyKey: keys[0] });
  assert.equal(resumed[0].headers["Idempotency-Key"], keys[0], "a resumed attempt continues the same session");
  resetXhr();
  const fresh = fakeApi([initiate(), complete(() => completed())]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep);
  assert.notEqual(fresh[0].headers["Idempotency-Key"], keys[0], "a new attempt is a new key");
  for (const [reply, code] of [[{ status: 409, json: { code: "idempotency_conflict" } }, "idempotency_conflict"], [{ status: 429, json: { code: "storage_quota_exceeded" } }, "storage_quota_exceeded"], [{ status: 403, json: { code: "operation_not_allowed" } }, "operation_not_allowed"], [{ status: 503, json: { code: "media_storage_disabled" } }, "media_storage_disabled"]]) {
    resetXhr();
    fakeApi([initiate(() => reply)]);
    await assert.rejects(upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep), (error) => error.code === code);
    assert.equal(FakeXHR.instances.length, 0, `${code}: no PUT`);
  }
  // Initiation that answers an already completed session: no PUT, the media.
  resetXhr();
  fakeApi([initiate(() => completed())]);
  assert.equal((await upload.startUpload({ file: file("a.mp4", 100, "video/mp4"), slot: "video", context: edit }, noSleep)).mediaId, "media-1");
  assert.equal(FakeXHR.instances.length, 0);
  upload.setUploadTransportEnabled(false);
});

// The editor's fallback for a frame of a Drive copy (exercise-editor.js,
// uploadExerciseMedia) retries as a picture only when the reservation itself
// was refused - nothing sent - which this transport marks by an empty uploadId.
test("14. a frame whose reservation is refused (404) rejects with an empty uploadId after one request and no PUT; a refusal after the reservation carries its upload id", async () => {
  upload.setUploadTransportEnabled(true);
  resetXhr();
  const calls = fakeApi([initiate(() => ({ status: 404, json: { code: "resource_not_found" } }))]);
  const frame = { file: file("frame.jpg", 10, "image/jpeg"), slot: "image", context: edit, purpose: "video_frame", sourceMediaId: "vid-1", frameTimeSeconds: 10 };
  await assert.rejects(upload.startUpload(frame, noSleep), (error) => error.code === "resource_not_found" && error.uploadId === "");
  assert.equal(calls.length, 1, "one request");
  assert.equal(calls[0].body.purpose, "video_frame");
  assert.equal(FakeXHR.instances.length, 0, "no PUT");
  resetXhr();
  fakeApi([initiate(), complete(() => ({ status: 404, json: { code: "resource_not_found" } }))]);
  FakeXHR.onSend = (xhr) => xhr.finish(200);
  await assert.rejects(upload.startUpload(frame, noSleep), (error) => error.code === "resource_not_found" && error.uploadId === "up-1");
  upload.setUploadTransportEnabled(false);
});
