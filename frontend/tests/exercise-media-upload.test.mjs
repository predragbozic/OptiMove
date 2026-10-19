import { test } from "node:test";
import assert from "node:assert/strict";

// FE-2: the storage read (BE-1's GET /api/media/storage), the local checks
// before a file is sent, the sentences for every code, and the seam that
// stays inert until BE-2 names the upload routes. Fake answers only.

const upload = await import("../exercise-media-upload.js");
const { formatBytes } = await import("../utils.js");

const account = (overrides = {}) => ({
  storageAccountId: "acc-1", owner: { type: "user", id: "u1" }, usedBytes: "1200000000", reservedBytes: "0", limitBytes: "5000000000",
  availableBytes: "3800000000", limitSource: "default", overLimit: false, activeUploads: 0, maxParallelUploads: 2,
  maxVideoBytes: "209715200", maxImageBytes: "10485760", allowedMimeTypes: ["video/mp4", "video/webm", "image/jpeg", "image/png", "image/webp"],
  overrideLimitBytes: null, revision: 1, ...overrides,
});
const file = (name, size, type) => ({ name, size, type });

function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || "GET", body: options.body });
    const reply = await answer(String(url));
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}

test("1. bytes read as the coach reads them", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes("184000000"), "184 MB");
  assert.equal(formatBytes(1200000000), "1.2 GB");
  assert.equal(formatBytes(209715200), "209.7 MB");
  assert.equal(formatBytes(10485760), "10.5 MB");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes("nonsense"), "");
  assert.equal(formatBytes(-1), "");
});

test("2. the local checks: the slot's and the server's types, the per-file ceiling, the free space, the parallel cap; without a usage row only the type", () => {
  const a = account();
  assert.deepEqual(upload.validateFile(file("a.mp4", 1000, "video/mp4"), "video", a), { ok: true });
  assert.deepEqual(upload.validateFile(file("a.webp", 1000, "image/webp"), "image", a), { ok: true });
  assert.equal(upload.validateFile(file("a.mp4", 1000, "video/mp4"), "image", a).code, "unsupported_media", "a video in the picture slot");
  assert.equal(upload.validateFile(file("a.mov", 1000, "video/quicktime"), "video", a).code, "unsupported_media");
  assert.equal(upload.validateFile(file("a.webm", 1000, "video/webm"), "video", account({ allowedMimeTypes: ["video/mp4"] })).code, "unsupported_media", "the server's allowlist narrows the slot's");
  assert.equal(upload.validateFile(file("a.mp4", 209715201, "video/mp4"), "video", a).code, "file_too_large");
  assert.equal(upload.validateFile(file("a.png", 10485761, "image/png"), "image", a).code, "file_too_large");
  assert.equal(upload.validateFile(file("a.mp4", 100000000, "video/mp4"), "video", account({ availableBytes: "99999999" })).code, "storage_quota_exceeded");
  assert.equal(upload.validateFile(file("a.mp4", 10, "video/mp4"), "video", account({ overLimit: true })).code, "storage_quota_exceeded");
  assert.equal(upload.validateFile(file("a.mp4", 10, "video/mp4"), "video", account({ activeUploads: 2 })).code, "parallel_upload_limit");
  assert.deepEqual(upload.validateFile(file("a.mp4", 10 ** 12, "video/mp4"), "video", null), { ok: true }, "no usage row: the server decides");
  assert.equal(upload.validateFile(file("a.gif", 10, "image/gif"), "image", null).code, "unsupported_media");
  assert.equal(upload.validateFile(null, "video", a).code, "invalid_file");
  assert.equal(upload.validateFile(file("a.mp4", 10, "video/mp4"), "poster", a).code, "invalid_file");
});

test("3. one sentence per code, with the numbers the coach needs", () => {
  const a = account();
  assert.equal(upload.describeUploadError("file_too_large", { slot: "video", file: file("a.mp4", 300000000, "video/mp4"), account: a }), "This file is 300 MB. The limit for one video is 209.7 MB.");
  assert.equal(upload.describeUploadError("file_too_large", { slot: "image", file: file("a.png", 12000000, "image/png"), account: a }), "This file is 12 MB. The limit for one picture is 10.5 MB.");
  assert.equal(upload.describeUploadError("storage_quota_exceeded", { slot: "video", file: file("a.mp4", 184000000, "video/mp4"), account: account({ availableBytes: "120000000" }) }), "This file needs 184 MB, but only 120 MB of your storage are free. Remove media you no longer use or ask an administrator for more storage.");
  assert.equal(upload.describeUploadError("unsupported_media", { slot: "video" }), "Only MP4 or WebM video files can be uploaded.");
  assert.equal(upload.describeUploadError("unsupported_media", { slot: "image" }), "Only JPG, PNG or WebP pictures can be uploaded.");
  assert.match(upload.describeUploadError("parallel_upload_limit"), /Another upload is still running/);
  assert.match(upload.describeUploadError("media_verification_failed"), /could not be verified/);
  assert.match(upload.describeUploadError("media_storage_disabled"), /switched off/);
  assert.match(upload.describeUploadError("upload_contract_pending"), /not available yet/);
  assert.equal(upload.describeUploadError("cancelled"), "Upload cancelled.");
  for (const code of ["media_storage_busy", "storage_unavailable", "timeout", "anything_else"]) {
    const sentence = upload.describeUploadError(code);
    assert.match(sentence, /did not finish/, code);
    assert.doesNotMatch(sentence, /nothing was uploaded/i, "a lost answer is never 'nothing was uploaded'");
  }
});

test("4. the storage read: one GET, the accounts; the flag off and the wrong workspace are their own codes, the rest unavailable", async () => {
  const calls = fakeFetch(() => ({ accounts: [account()] }));
  const usage = await upload.readStorageUsage();
  assert.deepEqual(calls, [{ url: upload.STORAGE_ROUTE, method: "GET", body: undefined }]);
  assert.equal(usage.accounts.length, 1);
  assert.equal(upload.chargedAccount(usage.accounts).owner.type, "user");
  assert.equal(upload.chargedAccount([account({ owner: { type: "club", id: "c1" } }), account()]).owner.type, "user", "the coach's own account first");
  assert.equal(upload.chargedAccount([account({ owner: { type: "club", id: "c1", name: "FK Example" } })]).owner.type, "club", "else the first");
  assert.equal(upload.describeStorageAccount(account({ owner: { type: "club", id: "c1", name: "FK Example" } })), "club storage of FK Example");
  assert.equal(upload.describeStorageAccount(account()), "personal storage");
  assert.equal(upload.chargedAccount(undefined), null);
  const code = async (reply) => {
    fakeFetch(() => reply);
    try {
      await upload.readStorageUsage();
      return "no error";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(await code({ status: 503, json: { error: "Media storage is disabled.", code: "media_storage_disabled" } }), "media_storage_disabled");
  assert.equal(await code({ status: 403, json: { error: "Operation not allowed.", code: "operation_not_allowed" } }), "operation_not_allowed");
  assert.equal(await code({ status: 503, json: { error: "Storage is busy.", code: "media_storage_busy" } }), "storage_unavailable");
  assert.equal(await code({ status: 500, json: {} }), "storage_unavailable");
  globalThis.fetch = async () => { throw new Error("network"); };
  await assert.rejects(upload.readStorageUsage(), (error) => error.code === "storage_unavailable");
  fakeFetch(() => ({ nothing: true }));
  assert.deepEqual(await upload.readStorageUsage(), { accounts: [] }, "an answer without accounts is an empty list");
});

test("5. the seam is inert until BE-2: startUpload refuses locally and sends nothing; the save body gains nothing", async () => {
  const calls = fakeFetch(() => ({}));
  assert.equal(upload.UPLOAD_CONTRACT, "pending");
  let progressed = 0;
  await assert.rejects(
    upload.startUpload({ file: file("a.mp4", 10, "video/mp4"), slot: "video", context: { type: "exercise", id: "e1" } }, { onProgress: () => { progressed += 1; }, signal: new AbortController().signal }),
    (error) => error.code === "upload_contract_pending",
  );
  assert.equal(calls.length, 0, "no request");
  assert.equal(progressed, 0);
  assert.deepEqual(upload.mediaSavePayload({ video: { state: "uploaded", mediaId: "m1" }, image: { state: "none", removedMediaId: "old" } }), {});
});
