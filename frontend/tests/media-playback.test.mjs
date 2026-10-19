import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// FE-1: the media descriptor normalizer (media.js) and the short-lived
// access adapter (media-playback.js), against isolated fake answers in the
// shape of the owner's summary of the Codex contract - the backend is not
// implemented yet, so nothing here reaches a server.

const media = await import("../media.js");
const playback = await import("../media-playback.js");

const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();

// A fetch fake: every call recorded, answered by `answer(url, body)`.
function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options.method || "GET", body });
    const reply = await answer(String(url), body, calls.length);
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}

const row = (overrides = {}) => ({ id: "e1", name: "Dead Bug", image_url: "", video_url: "", ...overrides });

test("0. the descriptor: asset / legacy / none per slot, legacy fields only without a descriptor, the access context kept opaque", () => {
  const described = media.exerciseMediaOf(row({
    image_url: "https://legacy.example/ignored.jpg",
    video_url: "https://youtu.be/dQw4w9WgXcQ",
    media: { video: { source: "legacy", url: "https://youtu.be/dQw4w9WgXcQ" }, image: { source: "asset", assetId: "img-1" }, accessContext: { exerciseId: "e1" } },
  }));
  assert.deepEqual(described.image, { source: "asset", assetId: "img-1", url: "", kind: "asset" });
  assert.deepEqual(described.video, { source: "legacy", assetId: "", url: "https://youtu.be/dQw4w9WgXcQ", kind: "youtube" });
  assert.deepEqual(described.accessContext, { exerciseId: "e1" });
  assert.equal(media.hasAnyMedia(described), true);

  // "none" wins over a legacy column that still holds a value.
  const none = media.exerciseMediaOf(row({ image_url: "https://legacy.example/old.jpg", media: { video: { source: "none" }, image: { source: "none" }, accessContext: "ctx" } }));
  assert.equal(none.image.source, "none");
  assert.equal(none.video.source, "none");
  assert.equal(media.hasAnyMedia(none), false);

  // No descriptor: the legacy fields, in every spelling the render sites use.
  const legacy = media.exerciseMediaOf({ imageUrl: "https://drive.google.com/file/d/FILE_1/view", video: "https://cdn.example/clip.mp4" });
  assert.equal(legacy.image.kind, "drive");
  assert.equal(legacy.video.kind, "url");
  assert.equal(legacy.accessContext, null);
  // A legacy slot without its own url reads the row's column; an asset slot without an id is nothing.
  const partial = media.exerciseMediaOf(row({ video_url: "https://youtu.be/dQw4w9WgXcQ", media: { video: { source: "legacy" }, image: { source: "asset" } } }));
  assert.equal(partial.video.url, "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(partial.image.source, "none");

  // The open-media attributes: the legacy links as before, the asset ids and the context only for assets.
  assert.equal(media.mediaAccessAttributes(legacy), `data-image="https://drive.google.com/file/d/FILE_1/view" data-video="https://cdn.example/clip.mp4"`);
  const attributes = media.mediaAccessAttributes(described);
  assert.match(attributes, /^data-image="" data-video="https:\/\/youtu\.be\/dQw4w9WgXcQ" data-image-asset-id="img-1" data-media-access-context="/);
  assert.doesNotMatch(attributes, /data-video-asset-id/);
  const dom = new JSDOM(`<button ${attributes}></button>`);
  assert.deepEqual(media.decodeAccessContext(dom.window.document.querySelector("button").dataset.mediaAccessContext), { exerciseId: "e1" });
  assert.equal(media.decodeAccessContext(""), null);
  assert.equal(media.decodeAccessContext("{not json"), null);
  // An asset picture: no address, the id, the context, the public fallbacks.
  const picture = media.renderMediaImage(described, "thumb");
  assert.match(picture, /^<img class="thumb" alt="" data-media-asset-id="img-1" data-media-access-context="[^"]+">$/);
  assert.doesNotMatch(picture, / src=/);
  assert.equal(media.renderMediaImage(legacy, "thumb"), media.renderImage(legacy.image.url, "thumb"));
  assert.equal(media.renderMediaImage(none, "thumb"), "");
  dom.window.close();
});

test("1. the player's address: one request with the asset id and the context, reused while fresh, forgotten on demand or past its margin", async () => {
  playback.forgetMediaAccess();
  const calls = fakeFetch(() => ({ url: "https://r2.example/v1?sig=1", expiresAt: minutesFromNow(10) }));
  const first = await playback.loadPlayback("vid-1", { exerciseId: "e1" });
  assert.equal(first.url, "https://r2.example/v1?sig=1");
  assert.deepEqual(calls, [{ url: playback.ACCESS_ROUTE, method: "POST", body: { assetId: "vid-1", accessContext: { exerciseId: "e1" } } }]);
  const again = await playback.loadPlayback("vid-1", { exerciseId: "e1" });
  assert.equal(again.url, first.url);
  assert.equal(calls.length, 1, "a fresh address is not asked for again");
  assert.equal(playback.cachedMediaUrl("vid-1"), first.url);
  playback.forgetMediaAccess("vid-1");
  assert.equal(playback.cachedMediaUrl("vid-1"), "");
  await playback.loadPlayback("vid-1", null);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.accessContext, null);
  // An address inside its margin counts as expired.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: "https://r2.example/short", expiresAt: new Date(Date.now() + 5_000).toISOString() }) });
  await playback.loadPlayback("vid-short", "ctx");
  assert.equal(playback.cachedMediaUrl("vid-short"), "", "five seconds left is inside the 30 s margin");
  // No expiry in the answer: the contract's ten minutes are assumed.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ url: "https://r2.example/noexp" }) });
  const assumed = await playback.loadPlayback("vid-noexp", "ctx");
  assert.ok(assumed.expiresAt > Date.now() + playback.PLAYBACK_TTL_MS - 2_000);
  playback.forgetMediaAccess();
});

test("2. every failure carries a stable code: not_available, unavailable, refused, answer_unexpected, aborted", async () => {
  playback.forgetMediaAccess();
  const code = async (answer, options) => {
    fakeFetch(() => answer);
    try {
      await playback.loadPlayback("vid-x", "ctx", options);
      return "no error";
    } catch (error) {
      return error.code;
    }
  };
  assert.equal(await code({ status: 404, json: { error: "notFound" } }), "not_available");
  assert.equal(await code({ status: 403, json: { error: "forbidden" } }), "not_available");
  assert.equal(await code({ status: 503, json: { error: "busy" } }), "unavailable");
  assert.equal(await code({ status: 400, json: { error: "invalidBody" } }), "refused");
  assert.equal(await code({ expiresAt: minutesFromNow(10) }), "answer_unexpected");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await code({ url: "https://r2.example/late" }, { signal: controller.signal }), "aborted");
  assert.equal(playback.cachedMediaUrl("vid-x"), "", "nothing is cached after a failure");
  playback.forgetMediaAccess();
});

test("3. a batch asks once per id, in requests of at most 50, shares a running request, leaves out what the server did not answer", async () => {
  playback.forgetMediaAccess();
  const ids = Array.from({ length: 120 }, (_, index) => `img-${index}`);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = fakeFetch(async (url, body) => {
    assert.equal(url, playback.ACCESS_BATCH_ROUTE);
    assert.ok(body.items.length <= playback.ACCESS_BATCH_LIMIT);
    await gate;
    // Every third id is left out (no right, or deleted); one comes back without an address.
    return { items: body.items.filter((item, index) => index % 3 !== 0).map((item, index) => ({ assetId: item.assetId, url: index === 0 ? null : `https://r2.example/${item.assetId}`, expiresAt: minutesFromNow(10) })) };
  });
  const items = ids.map((assetId) => ({ assetId, accessContext: "ctx" }));
  // The same ids asked twice while the first request runs: one set of requests.
  const [first, second] = await (async () => {
    const a = playback.resolveMediaAccess([...items, { assetId: "img-1", accessContext: "ctx" }, { assetId: "" }]);
    const b = playback.resolveMediaAccess(items.slice(0, 10));
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    return Promise.all([a, b]);
  })();
  assert.equal(calls.length, 3, "120 ids: 50 + 50 + 20");
  assert.deepEqual(calls.map((call) => call.body.items.length), [50, 50, 20]);
  assert.deepEqual(calls[0].body.items[1], { assetId: "img-1", accessContext: "ctx" });
  assert.equal(first.has("img-0"), false, "left out by the server");
  assert.equal(first.get("img-2"), "https://r2.example/img-2");
  assert.equal(first.has("img-1"), false, "an item without an address is not an address");
  assert.equal(second.get("img-2"), "https://r2.example/img-2", "the second caller shared the first request");
  // Cached ids are not asked again; only the missing ones go out.
  await playback.resolveMediaAccess(items.slice(0, 3));
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].body.items.map((item) => item.assetId), ["img-0", "img-1"]);
  // A failed batch gives nothing and throws nothing.
  globalThis.fetch = async () => { throw new Error("network"); };
  assert.equal((await playback.resolveMediaAccess([{ assetId: "img-new", accessContext: "ctx" }])).size, 0);
  playback.forgetMediaAccess();
});

test("4. the pictures on screen get their addresses in one batch; an unanswered one moves to its fallbacks, and with none left it ends in the app's error path", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM(`<main>
    ${media.renderAssetImage("img-a", { exerciseId: "a" }, "thumb")}
    ${media.renderAssetImage("img-b", "ctx-b", "thumb", { fallbacks: ["https://cover.example/b1.jpg", "https://cover.example/b2.jpg"] })}
    ${media.renderAssetImage("img-c", null, "thumb")}
    <img class="thumb" src="https://legacy.example/d.jpg" alt="">
  </main>`);
  const doc = dom.window.document;
  const calls = fakeFetch((url, body) => ({ items: body.items.filter((item) => item.assetId === "img-a").map((item) => ({ assetId: item.assetId, url: "https://r2.example/a", expiresAt: minutesFromNow(10) })) }));
  const errors = [];
  doc.addEventListener("error", (event) => errors.push(event.target.className), true);
  assert.equal(await playback.resolvePendingThumbnails(doc), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.items, [{ assetId: "img-a", accessContext: { exerciseId: "a" } }, { assetId: "img-b", accessContext: "ctx-b" }, { assetId: "img-c", accessContext: null }]);
  const [a, b, c] = doc.querySelectorAll("img");
  assert.equal(a.src, "https://r2.example/a");
  assert.equal(b.src, "https://cover.example/b1.jpg", "the first public fallback");
  assert.deepEqual(JSON.parse(b.dataset.fallbacks), ["https://cover.example/b2.jpg"]);
  assert.equal(b.dataset.mediaAssetId, undefined, "from here on an ordinary picture");
  assert.equal(c.hasAttribute("src"), false);
  assert.equal(c.dataset.mediaAssetId, undefined);
  assert.deepEqual(errors, ["thumb"], "only the picture with nothing left was handed to the error path");
  // Nothing pending any more: no request.
  assert.equal(await playback.resolvePendingThumbnails(doc), 0);
  assert.equal(calls.length, 1);
  playback.forgetMediaAccess();
  dom.window.close();
});

test("5. a picture whose address failed to load asks for a new one once, never twice", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM(`<main>${media.renderAssetImage("img-a", "ctx", "thumb")}</main>`);
  const image = dom.window.document.querySelector("img");
  let issued = 0;
  const calls = fakeFetch((url, body) => ({ items: body.items.map((item) => ({ assetId: item.assetId, url: `https://r2.example/a?sig=${++issued}`, expiresAt: minutesFromNow(10) })) }));
  await playback.resolvePendingThumbnails(dom.window.document);
  assert.equal(image.src, "https://r2.example/a?sig=1");
  assert.equal(playback.retryExpiredMediaImage(image), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 2, "the cached address was forgotten and a new one asked for");
  assert.equal(image.src, "https://r2.example/a?sig=2");
  assert.equal(playback.retryExpiredMediaImage(image), false, "a second failure is left to the fallbacks");
  assert.equal(calls.length, 2);
  assert.equal(playback.retryExpiredMediaImage(dom.window.document.createElement("img")), false, "an ordinary picture is not ours");
  playback.forgetMediaAccess();
  dom.window.close();
});

test("6. the installed resolver asks for every new picture on the next frame, in one request", async () => {
  playback.forgetMediaAccess();
  const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  const doc = dom.window.document;
  const calls = fakeFetch((url, body) => ({ items: body.items.map((item) => ({ assetId: item.assetId, url: `https://r2.example/${item.assetId}`, expiresAt: minutesFromNow(10) })) }));
  const uninstall = playback.installThumbnailResolver(doc.body);
  doc.querySelector("main").innerHTML = `${media.renderAssetImage("img-1", "ctx", "thumb")}${media.renderAssetImage("img-2", "ctx", "thumb")}`;
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.items.map((item) => item.assetId), ["img-1", "img-2"]);
  assert.deepEqual([...doc.querySelectorAll("img")].map((image) => image.src), ["https://r2.example/img-1", "https://r2.example/img-2"]);
  uninstall();
  doc.querySelector("main").insertAdjacentHTML("beforeend", media.renderAssetImage("img-3", "ctx", "thumb"));
  await new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0)));
  assert.equal(calls.length, 1, "uninstalled: nothing asked");
  playback.forgetMediaAccess();
  dom.window.close();
});
