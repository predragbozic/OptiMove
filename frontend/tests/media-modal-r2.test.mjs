import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// FE-1: the media modal with an R2 video or image - the short-lived address
// fetched for the row's context when the modal opens, assigned to the
// element and nowhere else, asked for once more when it fails, the error
// state with Try again - and the Google Drive, YouTube and direct-link
// markup exactly as before. Fake answers in the shape of the final Codex
// contract only; the backend is not implemented yet.

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="media-modal" id="mediaModal" hidden>
    <div class="media-backdrop" data-action="close-media"></div>
    <div class="media-dialog" role="dialog" aria-modal="true" aria-label="Exercise media">
      <div class="media-header"><h3 id="mediaTitle">Exercise media</h3><button class="plain-button" data-action="close-media">Close</button></div>
      <div class="media-body" id="mediaBody"></div>
    </div>
  </div>
  <div id="stage"></div>
</body></html>`, { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLImageElement = dom.window.HTMLImageElement;

const { els } = await import("../dom.js");
const media = await import("../media.js");
const playback = await import("../media-playback.js");
const modal = await import("../media-modal.js");
const { state } = await import("../state.js");

const stage = document.querySelector("#stage");
const body = () => els.mediaBody;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const minutesFromNow = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const asset = (mediaId, url) => ({ source: "asset", mediaId, url, expiresAt: minutesFromNow(10), mimeType: "video/mp4" });
const context = { type: "exercise", id: "e1" };

function fakeFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const bodyJson = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), body: bodyJson });
    const reply = await answer(String(url), bodyJson, calls.length);
    if (reply?.status && reply.status >= 400) return { ok: false, status: reply.status, statusText: "Error", json: async () => reply.json || {} };
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}

// The single route answered slot by slot; the batch route by request index.
const slotAnswer = (pick) => (url, requestBody) => {
  if (url === playback.ACCESS_BATCH_ROUTE) {
    return { results: requestBody.requests.map((request, index) => ({ index, media: Object.fromEntries(request.slots.map((slot) => [slot, pick(slot, request.context)]).filter(([, entry]) => entry)) })) };
  }
  return Object.fromEntries(requestBody.slots.map((slot) => [slot, pick(slot, requestBody.context)]).filter(([, entry]) => entry));
};

// An "open-media" control as the render sites draw it, from a row.
function control(row) {
  stage.innerHTML = `<button type="button" data-action="open-media" data-title="${row.name}" ${media.mediaAccessAttributes(media.exerciseMediaOf(row))}></button>`;
  return stage.firstElementChild;
}

const assetVideoRow = { name: "Dead Bug", media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "none" }, accessContext: context } };

test("1. an R2 video: the HTML5 player without an address, one request for the row's context, the address assigned to the element and kept nowhere else, gone with Close", async () => {
  playback.forgetMediaAccess();
  const calls = fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1?sig=1") : null)));
  modal.handleMediaAction(control(assetVideoRow));
  assert.equal(els.mediaModal.hidden, false);
  assert.ok(els.mediaModal.classList.contains("is-video"));
  const video = body().querySelector("video.media-video");
  assert.ok(video);
  assert.equal(video.hasAttribute("src"), false, "no address until the server issued one");
  assert.equal(video.getAttribute("playsinline"), "");
  assert.equal(video.getAttribute("controls"), "");
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "loading");
  assert.match(body().querySelector(".media-status").textContent, /Preparing the video/);
  assert.ok(body().querySelector('[data-action="enter-fullscreen"]'), "the full-screen button is the phone's gesture");
  await settle();
  assert.deepEqual(calls, [{ url: playback.ACCESS_ROUTE, body: { context, slots: ["video"] } }]);
  assert.equal(video.src, "https://r2.example/vid-1?sig=1");
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "ready");
  assert.equal(stage.innerHTML.includes("r2.example"), false, "the control carries the media id and the context, never the address");
  assert.match(stage.innerHTML, /data-video-media-id="vid-1"/);
  assert.equal(JSON.stringify(state).includes("r2.example"), false, "state never holds the address");
  modal.closeMedia();
  assert.equal(els.mediaModal.hidden, true);
  assert.equal(body().innerHTML, "");
  assert.equal(els.mediaModal.outerHTML.includes("r2.example"), false);
  playback.forgetMediaAccess();
});

test("2. an address that fails to load is asked for once more, where the video was; a second failure is the error state, and Try again starts over", async () => {
  playback.forgetMediaAccess();
  let issued = 0;
  const calls = fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", `https://r2.example/vid-1?sig=${++issued}`) : null)));
  modal.handleMediaAction(control(assetVideoRow));
  await settle();
  const video = body().querySelector("video.media-video");
  assert.equal(video.src, "https://r2.example/vid-1?sig=1");
  Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 42 });
  video.dispatchEvent(new dom.window.Event("error"));
  await settle();
  assert.equal(calls.length, 2, "forgotten and asked for again");
  assert.equal(video.src, "https://r2.example/vid-1?sig=2");
  video.dispatchEvent(new dom.window.Event("loadedmetadata"));
  assert.equal(video.currentTime, 42, "it resumes where it was");
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "ready");
  video.dispatchEvent(new dom.window.Event("error"));
  await settle();
  assert.equal(calls.length, 2, "a second failure is not a third request");
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "error");
  const error = body().querySelector(".media-error");
  assert.match(error.textContent, /can't be played right now/);
  const retry = error.querySelector('[data-action="media-retry"]');
  assert.ok(retry);
  assert.equal(modal.handleMediaAction(retry), true);
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "ready");
  assert.equal(body().querySelector("video.media-video").src, "https://r2.example/vid-1?sig=3");
  modal.closeMedia();
  playback.forgetMediaAccess();
});

test("3. a refused access is the sentence and the code; a server that does not answer, or a row without a context, is the generic sentence", async () => {
  playback.forgetMediaAccess();
  fakeFetch(() => ({ status: 404, json: { error: "notFound" } }));
  modal.handleMediaAction(control(assetVideoRow));
  await settle();
  const box = body().querySelector(".media-asset");
  assert.equal(box.dataset.mediaState, "error");
  assert.match(box.querySelector(".media-error p").textContent, /not available to you/);
  assert.equal(box.querySelector(".media-technical code").textContent, "not_available");
  modal.closeMedia();
  fakeFetch(() => ({ status: 503, json: { error: "busy" } }));
  modal.handleMediaAction(control(assetVideoRow));
  await settle();
  assert.match(body().querySelector(".media-error p").textContent, /can't be played right now/);
  assert.equal(body().querySelector(".media-technical code").textContent, "unavailable");
  modal.closeMedia();
  const calls = fakeFetch(() => ({}));
  modal.handleMediaAction(control({ ...assetVideoRow, media: { ...assetVideoRow.media, accessContext: null } }));
  await settle();
  assert.equal(calls.length, 0, "without a context nothing is asked");
  assert.equal(body().querySelector(".media-technical code").textContent, "context_invalid");
  modal.closeMedia();
  playback.forgetMediaAccess();
});

test("4. an R2 image alone is shown through the resolver; the poster of an R2 video is its R2 image, from the same request or the cache", async () => {
  playback.forgetMediaAccess();
  const calls = fakeFetch(slotAnswer((slot) => asset(slot === "video" ? "vid-1" : "img-1", `https://r2.example/${slot === "video" ? "vid-1" : "img-1"}`)));
  modal.handleMediaAction(control({ name: "Plank", media: { video: { source: "none" }, image: { source: "asset", mediaId: "img-1" }, accessContext: context } }));
  assert.equal(els.mediaModal.classList.contains("is-video"), false);
  const image = body().querySelector("img.media-image-full");
  assert.equal(image.dataset.mediaId, "img-1");
  assert.equal(image.dataset.mediaSlot, "image");
  assert.equal(image.hasAttribute("src"), false);
  await settle();
  assert.equal(image.src, "https://r2.example/img-1");
  assert.deepEqual(calls.map((call) => call.url), [playback.ACCESS_BATCH_ROUTE]);
  assert.deepEqual(calls[0].body, { requests: [{ context, slots: ["image"] }] });
  modal.closeMedia();
  modal.handleMediaAction(control({ name: "Plank", media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "asset", mediaId: "img-1" }, accessContext: context } }));
  await settle();
  const video = body().querySelector("video.media-video");
  assert.equal(video.src, "https://r2.example/vid-1");
  assert.equal(video.poster, "https://r2.example/img-1", "the cached image address");
  assert.deepEqual(calls.map((call) => call.url), [playback.ACCESS_BATCH_ROUTE, playback.ACCESS_ROUTE]);
  assert.deepEqual(calls[1].body, { context, slots: ["video"] }, "the image was already cached, only the video is asked for");
  modal.closeMedia();
  playback.forgetMediaAccess();
  // Both missing: one request for both slots.
  modal.handleMediaAction(control({ name: "Plank", media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "asset", mediaId: "img-1" }, accessContext: context } }));
  await settle();
  assert.deepEqual(calls[2].body, { context, slots: ["video", "image"] });
  assert.equal(body().querySelector("video.media-video").poster, "https://r2.example/img-1");
  modal.closeMedia();
  playback.forgetMediaAccess();
});

test("5. Google Drive, YouTube and a direct link are drawn exactly as before, with no request; a late answer never touches the next opening", async () => {
  playback.forgetMediaAccess();
  let release;
  const calls = fakeFetch(() => new Promise((resolve) => { release = () => resolve({ video: asset("vid-1", "https://r2.example/late") }); }));
  modal.handleMediaAction(control(assetVideoRow));
  modal.closeMedia();
  modal.openMedia("Clip", "", "https://cdn.example/clip.mp4");
  const direct = body().querySelector("video.media-video");
  assert.ok(direct.hasAttribute("controls") && direct.hasAttribute("playsinline"));
  assert.equal(direct.getAttribute("preload"), "metadata");
  assert.equal(direct.querySelector("source").getAttribute("src"), "https://cdn.example/clip.mp4");
  assert.equal(body().querySelector(".media-asset"), null, "a direct link is not an asset");
  release();
  await settle();
  assert.equal(body().querySelector(".media-asset"), null, "the late answer found another opening and was dropped");
  assert.equal(body().innerHTML.includes("r2.example"), false);
  modal.closeMedia();
  modal.openMedia("Tube", "", "https://youtu.be/dQw4w9WgXcQ");
  assert.equal(body().querySelector("iframe.media-frame-video").getAttribute("src"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
  modal.closeMedia();
  modal.openMedia("Drive", "https://drive.google.com/file/d/IMG_1/view", "https://drive.google.com/file/d/FILE_1/view?usp=sharing");
  assert.equal(body().querySelector("iframe.media-frame-video").getAttribute("src"), "https://drive.google.com/file/d/FILE_1/preview?autoplay=1");
  modal.closeMedia();
  modal.openMedia("Picture", "https://drive.google.com/file/d/IMG_1/view", "");
  assert.equal(els.mediaModal.classList.contains("is-video"), false);
  assert.equal(body().querySelector("img.media-image-full").getAttribute("src"), "https://drive.google.com/thumbnail?id=IMG_1&sz=w1000");
  modal.closeMedia();
  modal.openMedia("Nothing", "", "");
  assert.match(body().textContent, /No media available/);
  modal.closeMedia();
  assert.equal(calls.length, 1, "only the R2 opening asked the server");
  playback.forgetMediaAccess();
});
