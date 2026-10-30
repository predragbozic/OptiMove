import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

// jsdom has no media playback: play() is recorded with the address the
// element held at that moment and answers what the test sets.
const plays = [];
let playAnswer = () => Promise.resolve();
dom.window.HTMLMediaElement.prototype.play = function play() {
  plays.push({ src: this.getAttribute("src") || "", muted: this.muted });
  return playAnswer();
};
// A computer (the default here) or a phone, as media-modal.js asks for it.
const computer = () => { window.matchMedia = () => ({ matches: false }); };
const phone = () => { window.matchMedia = (query) => ({ matches: query === "(max-width: 760px)" }); };
computer();

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
  assert.ok(els.mediaModal.classList.contains("is-inline-video"), "on a computer: the picture's dialog");
  assert.equal(els.mediaModal.classList.contains("is-video"), false, "not the black video box");
  const video = body().querySelector("video.media-video");
  assert.ok(video);
  assert.equal(video.hasAttribute("src"), false, "no address until the server issued one");
  assert.equal(video.getAttribute("playsinline"), "");
  assert.equal(video.getAttribute("controls"), "");
  assert.equal(body().querySelector(".media-asset").dataset.mediaState, "loading");
  assert.match(body().querySelector(".media-status").textContent, /Preparing the video/);
  assert.ok(body().querySelector('.media-video-actions [data-action="enter-fullscreen"]'), "the full-screen button, under the player");
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
  const playsBefore = plays.length;
  modal.openMedia("Clip", "", "https://cdn.example/clip.mp4");
  const direct = body().querySelector("video.media-video");
  assert.ok(direct.hasAttribute("controls") && direct.hasAttribute("playsinline"));
  assert.equal(direct.getAttribute("preload"), "metadata");
  assert.equal(direct.hasAttribute("muted"), false, "a direct link is drawn as before");
  assert.ok(els.mediaModal.classList.contains("is-video"));
  assert.equal(els.mediaModal.classList.contains("is-inline-video"), false);
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
  assert.ok(els.mediaModal.classList.contains("is-video") && els.mediaModal.classList.contains("is-frame-video"), "the Drive player's layout as before");
  assert.equal(els.mediaModal.classList.contains("is-inline-video"), false);
  assert.equal(body().querySelector(".media-video-actions"), null);
  assert.equal(els.mediaModal.querySelector(".media-dialog").style.getPropertyValue("--media-aspect"), "");
  modal.closeMedia();
  modal.openMedia("Picture", "https://drive.google.com/file/d/IMG_1/view", "");
  assert.equal(els.mediaModal.classList.contains("is-video"), false);
  assert.equal(body().querySelector("img.media-image-full").getAttribute("src"), "https://drive.google.com/thumbnail?id=IMG_1&sz=w1000");
  modal.closeMedia();
  modal.openMedia("Nothing", "", "");
  assert.match(body().textContent, /No media available/);
  modal.closeMedia();
  assert.equal(calls.length, 1, "only the R2 opening asked the server");
  assert.equal(plays.length, playsBefore, "nothing but an R2 video is started by OptiMove");
  playback.forgetMediaAccess();
});

// Owner, 2026-10-29: on a computer or a tablet an R2 video opens like the
// picture (the light dialog with the title, the video where the picture
// would be), starts by itself without sound, and offers full screen; the
// dialog takes the video's shape. A phone keeps its full-screen player, muted
// and started too.

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const dialog = () => els.mediaModal.querySelector(".media-dialog");
const aspect = () => dialog().style.getPropertyValue("--media-aspect");
const posterRow = { name: "Dead Bug", media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "legacy", url: "https://drive.google.com/file/d/IMG_1/view" }, accessContext: context } };
const LEGACY_POSTER = "https://drive.google.com/thumbnail?id=IMG_1&sz=w1000";

function sizeOf(video, width, height) {
  Object.defineProperty(video, "videoWidth", { configurable: true, value: width });
  Object.defineProperty(video, "videoHeight", { configurable: true, value: height });
  video.dispatchEvent(new dom.window.Event("loadedmetadata"));
}

// The browser holds these pictures already (their size is known at once).
function knownPictures(sizes) {
  const proto = dom.window.HTMLImageElement.prototype;
  const keys = ["complete", "naturalWidth", "naturalHeight"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]);
  const of = (image) => sizes[image.getAttribute("src")];
  Object.defineProperty(proto, "complete", { configurable: true, get() { return Boolean(of(this)); } });
  Object.defineProperty(proto, "naturalWidth", { configurable: true, get() { return of(this)?.[0] || 0; } });
  Object.defineProperty(proto, "naturalHeight", { configurable: true, get() { return of(this)?.[1] || 0; } });
  return () => { for (const [key, descriptor] of saved) Object.defineProperty(proto, key, descriptor); };
}

function topLevelRule(selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `rule ${selector} must exist`);
  const media = css.lastIndexOf("\n@media", at);
  assert.ok(media < 0 || css.indexOf("\n}\n", media) < at, `${selector} applies at every width, inside no @media block`);
  return css.slice(at, css.indexOf("}", at));
}

test("6. on a computer an R2 video opens in the picture's dialog: the title, the poster, muted, started once its address is assigned; a refused start leaves the poster and the controls without a message", async () => {
  computer();
  playback.forgetMediaAccess();
  fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1?sig=1") : null)));
  const before = plays.length;
  modal.handleMediaAction(control(posterRow));
  assert.equal(els.mediaTitle.textContent, "Dead Bug", "the title header, as for a picture");
  assert.ok(els.mediaModal.classList.contains("is-inline-video"));
  assert.equal(els.mediaModal.classList.contains("is-video"), false);
  const video = body().querySelector(".media-asset video.media-video");
  assert.equal(video.getAttribute("poster"), LEGACY_POSTER, "the exercise picture is the poster");
  assert.equal(video.hasAttribute("muted"), true, "muted by default");
  assert.equal(video.muted, true);
  assert.equal(video.getAttribute("controls"), "", "the sound control stays in the player's own controls");
  assert.equal(video.getAttribute("playsinline"), "");
  assert.equal(video.getAttribute("preload"), "metadata");
  assert.equal(body().querySelector(".media-fullscreen-note"), null, "full screen is not entered by itself, so it is not announced");
  assert.equal(plays.length, before, "nothing to start before the address");
  await settle();
  assert.deepEqual(plays.slice(before), [{ src: "https://r2.example/vid-1?sig=1", muted: true }], "started once, muted, with its address");
  modal.closeMedia();
  playback.forgetMediaAccess();

  playAnswer = () => Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
  try {
    modal.handleMediaAction(control(posterRow));
    await settle();
    await settle();
    assert.equal(body().querySelector(".media-asset").dataset.mediaState, "ready", "a refused start is not an error");
    assert.equal(body().querySelector(".media-error"), null);
    assert.equal(body().querySelector("video.media-video").getAttribute("poster"), LEGACY_POSTER);
    assert.equal(body().querySelector("video.media-video").getAttribute("controls"), "");
    modal.closeMedia();
    playAnswer = () => { throw new Error("no media support"); };
    modal.handleMediaAction(control(posterRow));
    await settle();
    assert.equal(body().querySelector(".media-asset").dataset.mediaState, "ready", "a start that throws is not an error either");
  } finally {
    playAnswer = () => Promise.resolve();
    modal.closeMedia();
    playback.forgetMediaAccess();
  }
});

test("7. the dialog takes the video's shape once its size is known, upright or wide; before that a poster the browser already holds, else the default; nothing of it outlives the opening", async () => {
  computer();
  playback.forgetMediaAccess();
  fakeFetch(slotAnswer((slot) => asset(slot === "video" ? "vid-1" : "img-1", `https://r2.example/${slot === "video" ? "vid-1" : "img-1"}`)));
  modal.handleMediaAction(control(assetVideoRow));
  assert.equal(aspect(), "", "nothing known yet: the default shape");
  await settle();
  const video = body().querySelector("video.media-video");
  sizeOf(video, 720, 1280);
  assert.equal(aspect(), "0.5625", "a phone video held upright");
  sizeOf(video, 1920, 1080);
  assert.equal(aspect(), "1.7778", "a wide video");
  sizeOf(video, 0, 0);
  assert.equal(aspect(), "1.7778", "a size that cannot be read changes nothing");
  modal.closeMedia();
  assert.equal(aspect(), "", "Close leaves the dialog as the picture view expects it");

  // A poster the browser holds sizes the dialog before the video does; the
  // video's own size wins once known.
  let restore = knownPictures({ [LEGACY_POSTER]: [1080, 1350] });
  try {
    modal.handleMediaAction(control(posterRow));
    assert.equal(aspect(), "0.8000", "the known poster's shape at once");
    await settle();
    sizeOf(body().querySelector("video.media-video"), 720, 1280);
    assert.equal(aspect(), "0.5625");
    modal.closeMedia();
  } finally {
    restore();
  }
  // An R2 poster from the same answer, held by the browser, before the video's size.
  playback.forgetMediaAccess();
  restore = knownPictures({ "https://r2.example/img-1": [1280, 720] });
  try {
    modal.handleMediaAction(control({ name: "Plank", media: { video: { source: "asset", mediaId: "vid-1" }, image: { source: "asset", mediaId: "img-1" }, accessContext: context } }));
    assert.equal(aspect(), "");
    await settle();
    assert.equal(body().querySelector("video.media-video").poster, "https://r2.example/img-1");
    assert.equal(aspect(), "1.7778", "the R2 poster's shape");
    modal.closeMedia();
  } finally {
    restore();
  }
  // A poster the browser does not hold yet: the default until the video says.
  playback.forgetMediaAccess();
  modal.handleMediaAction(control(posterRow));
  await settle();
  assert.equal(aspect(), "", "no request and no guess");
  // A picture opened after a video gets the plain picture dialog.
  sizeOf(body().querySelector("video.media-video"), 720, 1280);
  modal.openMedia("Picture", "https://drive.google.com/file/d/IMG_1/view", "");
  assert.equal(aspect(), "", "opening something else in the same dialog resets the shape");
  assert.equal(els.mediaModal.classList.contains("is-inline-video"), false);
  assert.ok(body().querySelector("img.media-image-full"));
  modal.closeMedia();
  playback.forgetMediaAccess();
});

test("8. full screen in the dialog: the button under the player asks for the video's full screen, leaving it comes back to the dialog, and the end of the video still closes it", async () => {
  computer();
  playback.forgetMediaAccess();
  const requests = [];
  dom.window.Element.prototype.requestFullscreen = function requestFullscreen() { requests.push(this); return Promise.resolve(); };
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  try {
    fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1") : null)));
    modal.handleMediaAction(control(assetVideoRow));
    await settle();
    const video = body().querySelector("video.media-video");
    sizeOf(video, 1920, 1080);
    assert.equal(requests.length, 0, "a computer is not put in full screen by itself");
    const button = body().querySelector('.media-video-actions [data-action="enter-fullscreen"]');
    assert.equal(button.getAttribute("aria-label"), "Full screen");
    assert.equal(modal.handleMediaAction(button), true);
    assert.deepEqual(requests, [video], "the video itself goes full screen");
    modal.handleFullscreenChange();
    assert.equal(els.mediaModal.hidden, false, "back from full screen to the dialog");
    video.dispatchEvent(new dom.window.Event("webkitendfullscreen"));
    assert.equal(els.mediaModal.hidden, false, "Safari's own player, left, comes back to the dialog too");
    assert.equal(video.getAttribute("src"), "https://r2.example/vid-1");
    video.dispatchEvent(new dom.window.Event("ended"));
    assert.equal(els.mediaModal.hidden, true, "the end of the video closes the dialog, as before");
    assert.equal(els.mediaModal.classList.contains("is-inline-video"), false);
  } finally {
    delete dom.window.Element.prototype.requestFullscreen;
    delete document.fullscreenElement;
    modal.closeMedia();
    playback.forgetMediaAccess();
  }
});

test("9. a phone held upright (360, 375, 390 px) opens an R2 video in the same picture dialog: muted, started with its address, never put in full screen by itself; the button asks for the video's full screen, leaving it keeps the dialog, the end closes it", async () => {
  const requests = [];
  dom.window.Element.prototype.requestFullscreen = function requestFullscreen() { requests.push(this); return Promise.resolve(); };
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  try {
    for (const px of [360, 375, 390]) {
      phone();
      Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
      playback.forgetMediaAccess();
      requests.length = 0;
      fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1") : null)));
      const before = plays.length;
      modal.handleMediaAction(control(posterRow));
      assert.ok(els.mediaModal.classList.contains("is-inline-video"), `${px}: the picture's dialog`);
      assert.equal(els.mediaModal.classList.contains("is-video"), false, `${px}: no black box`);
      assert.equal(els.mediaModal.classList.contains("is-frame-video"), false);
      assert.equal(els.mediaTitle.textContent, "Dead Bug");
      const video = body().querySelector(".media-asset video.media-video");
      assert.equal(video.getAttribute("poster"), LEGACY_POSTER);
      assert.equal(video.muted, true);
      assert.equal(video.hasAttribute("muted"), true);
      assert.equal(body().querySelector(".media-fullscreen-note"), null, `${px}: no note, full screen is not asked for by itself`);
      const button = body().querySelector('.media-video-actions [data-action="enter-fullscreen"]');
      assert.ok(button, `${px}: the full-screen button under the player`);
      await settle();
      assert.deepEqual(plays.slice(before), [{ src: "https://r2.example/vid-1", muted: true }], `${px}: started, muted, with its address`);
      sizeOf(video, 720, 1280);
      await settle();
      assert.deepEqual(requests, [], `${px}: no automatic full screen once the size is known`);
      assert.equal(aspect(), "0.5625", `${px}: the dialog takes the video's shape`);
      assert.equal(modal.handleMediaAction(button), true);
      assert.deepEqual(requests, [video], `${px}: the button asks for the video's own full screen`);
      modal.handleFullscreenChange();
      assert.equal(els.mediaModal.hidden, false, `${px}: back from full screen to the dialog`);
      video.dispatchEvent(new dom.window.Event("webkitendfullscreen"));
      assert.equal(els.mediaModal.hidden, false, `${px}: Safari's own player, left, comes back to the dialog`);
      video.dispatchEvent(new dom.window.Event("ended"));
      assert.equal(els.mediaModal.hidden, true, `${px}: the end of the video closes it`);
    }
  } finally {
    if (width) Object.defineProperty(window, "innerWidth", width); else delete window.innerWidth;
    delete dom.window.Element.prototype.requestFullscreen;
    delete document.fullscreenElement;
    modal.closeMedia();
    playback.forgetMediaAccess();
    computer();
  }
});

test("9b. a phone turned on its side (at most 500 px high) opens the same dialog, muted and started, with no full screen by itself", async () => {
  window.matchMedia = (query) => ({ matches: query === "(max-height: 500px)" });
  playback.forgetMediaAccess();
  const requests = [];
  dom.window.Element.prototype.requestFullscreen = function requestFullscreen() { requests.push(this); return Promise.resolve(); };
  try {
    fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1") : null)));
    const before = plays.length;
    modal.handleMediaAction(control(assetVideoRow));
    assert.ok(els.mediaModal.classList.contains("is-inline-video"));
    assert.equal(els.mediaModal.classList.contains("is-video"), false);
    assert.equal(body().querySelector(".media-fullscreen-note"), null);
    assert.ok(body().querySelector('.media-video-actions [data-action="enter-fullscreen"]'));
    await settle();
    assert.deepEqual(plays.slice(before), [{ src: "https://r2.example/vid-1", muted: true }]);
    sizeOf(body().querySelector("video.media-video"), 1280, 720);
    assert.equal(requests.length, 0);
    assert.equal(aspect(), "1.7778");
  } finally {
    delete dom.window.Element.prototype.requestFullscreen;
    modal.closeMedia();
    playback.forgetMediaAccess();
    computer();
  }
});

test("9c. an iPhone (no element full screen): the button is off until the video's size is known (Safari's player refuses a video without it), then opens Safari's own player for the video, never by itself; leaving it keeps the dialog", async () => {
  phone();
  playback.forgetMediaAccess();
  delete dom.window.Element.prototype.requestFullscreen;
  const entered = [];
  // WebKit refuses its player before the metadata (InvalidStateError).
  dom.window.HTMLVideoElement.prototype.webkitEnterFullscreen = function webkitEnterFullscreen() {
    if (!(this.readyState >= 1)) throw new Error("InvalidStateError");
    entered.push(this);
  };
  try {
    fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", "https://r2.example/vid-1") : null)));
    modal.handleMediaAction(control(assetVideoRow));
    const button = () => body().querySelector('.media-video-actions [data-action="enter-fullscreen"]');
    assert.equal(button().disabled, true, "off while the video is prepared");
    await settle();
    const video = body().querySelector("video.media-video");
    assert.equal(video.getAttribute("src"), "https://r2.example/vid-1");
    assert.equal(button().disabled, true, "still off: the address is there, the size is not");
    Object.defineProperty(video, "readyState", { configurable: true, value: 1 });
    sizeOf(video, 720, 1280);
    await settle();
    assert.equal(button().disabled, false, "on once the size is known");
    assert.deepEqual(entered, [], "not by itself");
    modal.handleMediaAction(button());
    assert.deepEqual(entered, [video], "the button opens Safari's player for the video");
    video.dispatchEvent(new dom.window.Event("webkitendfullscreen"));
    assert.equal(els.mediaModal.hidden, false, "leaving it comes back to the dialog");
    assert.equal(video.getAttribute("src"), "https://r2.example/vid-1");
    // A failed address: the error state turns it off, the next size on again.
    video.dispatchEvent(new dom.window.Event("error"));
    assert.equal(button().disabled, true, "off while a new address is fetched");
    await settle();
    sizeOf(video, 720, 1280);
    assert.equal(button().disabled, false);
    video.dispatchEvent(new dom.window.Event("error"));
    await settle();
    assert.equal(body().querySelector(".media-asset").dataset.mediaState, "error");
    assert.equal(button().disabled, true, "off in the error state");
  } finally {
    delete dom.window.HTMLVideoElement.prototype.webkitEnterFullscreen;
    modal.closeMedia();
    playback.forgetMediaAccess();
    computer();
  }
});


test("9d. a new address after an error restarts a video that was playing or had not started yet, never one the coach paused; the dialog's shape is read only from this opening's video", async () => {
  computer();
  playback.forgetMediaAccess();
  let issued = 0;
  fakeFetch(slotAnswer((slot) => (slot === "video" ? asset("vid-1", `https://r2.example/vid-1?sig=${++issued}`) : null)));
  const playing = (video, paused, time) => {
    Object.defineProperty(video, "paused", { configurable: true, value: paused });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: time });
  };
  try {
    const before = plays.length;
    modal.handleMediaAction(control(assetVideoRow));
    await settle();
    const video = body().querySelector("video.media-video");
    assert.equal(plays.length - before, 1);
    playing(video, false, 12);
    video.dispatchEvent(new dom.window.Event("error"));
    await settle();
    assert.equal(video.getAttribute("src"), "https://r2.example/vid-1?sig=2");
    assert.deepEqual(plays.slice(before + 1), [{ src: "https://r2.example/vid-1?sig=2", muted: true }], "it was playing: it goes on");
    modal.closeMedia();

    const second = plays.length;
    modal.handleMediaAction(control(assetVideoRow));
    await settle();
    const paused = body().querySelector("video.media-video");
    const issuedBefore = issued;
    playing(paused, true, 30);
    paused.dispatchEvent(new dom.window.Event("error"));
    await settle();
    assert.equal(issued, issuedBefore + 1, "a new address was asked for");
    assert.equal(paused.getAttribute("src"), `https://r2.example/vid-1?sig=${issued}`, "and assigned where it was");
    assert.equal(plays.length - second, 1, "paused by the coach: it stays paused");
    modal.closeMedia();

    const third = plays.length;
    modal.handleMediaAction(control(assetVideoRow));
    await settle();
    const neverStarted = body().querySelector("video.media-video");
    playing(neverStarted, true, 0);
    neverStarted.dispatchEvent(new dom.window.Event("error"));
    await settle();
    assert.equal(plays.length - third, 2, "the first address failed before it played: the new one starts");

    // The shape listener of a replaced video changes nothing.
    modal.openMedia("Picture", "https://drive.google.com/file/d/IMG_1/view", "");
    sizeOf(neverStarted, 720, 1280);
    assert.equal(aspect(), "");
  } finally {
    modal.closeMedia();
    playback.forgetMediaAccess();
  }
});


test("10. styles.css: the dialog follows --media-aspect within the picture's bounds at every width, the video fills it without bars, and the full-screen button is a 44 px target under the player", () => {
  const dialogRule = topLevelRule(".media-modal.is-inline-video .media-dialog");
  assert.match(dialogRule, /--media-aspect: 1\.7778;/, "16:9 until the video says otherwise");
  assert.match(dialogRule, /--media-video-max-height: min\(76vh, calc\(92vh - \d+px\)\);/, "at most 76vh high, as the picture");
  assert.match(dialogRule, /width: max\(min\(300px, 100vw - 24px\), min\(980px, 100vw - 24px, calc\(var\(--media-video-max-height\) \* var\(--media-aspect\) \+ 28px\)\)\);/, "as wide as the shape asks, within 980 px and the modal's edges");
  assert.match(topLevelRule(".media-modal.is-inline-video"), /padding: 12px;/, "the edges the width is bounded by, so a phone never cuts the dialog");
  const videoRule = topLevelRule(".media-modal.is-inline-video .media-video");
  assert.match(videoRule, /aspect-ratio: var\(--media-aspect\);/);
  assert.match(videoRule, /max-height: var\(--media-video-max-height\);/);
  assert.match(videoRule, /height: auto;/);
  const buttonRule = topLevelRule(".media-video-actions .media-fullscreen-button");
  assert.match(buttonRule, /width: 44px;/);
  assert.match(buttonRule, /height: 44px;/);
  assert.match(buttonRule, /position: relative;/, "in the row under the player, never over its controls");
  const titleRule = topLevelRule(".media-modal.is-inline-video .media-header h3");
  assert.match(titleRule, /-webkit-line-clamp: 2;/, "a long name keeps to the two lines the reserve counts");
  assert.match(titleRule, /overflow: hidden;/);
  const closeRule = topLevelRule(".media-modal.is-inline-video .media-header .plain-button");
  assert.match(closeRule, /min-width: 44px;/);
  assert.match(closeRule, /min-height: 44px;/, "Close is a 44 px target where the video is the dialog's main use");
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const headerRules = [...plain.matchAll(/([^{}]*is-inline-video[^{}]*\.media-header[^{}]*)\{/g)].map((match) => match[1].trim());
  assert.deepEqual(headerRules.sort(), [
    ".media-modal.is-inline-video .media-header",
    ".media-modal.is-inline-video .media-header .plain-button",
    ".media-modal.is-inline-video .media-header h3",
    ".media-modal.is-inline-video .media-header h3",
  ], "the header keeps the picture view's title and Close, made compact only on a short screen");
  const dynamic = css.slice(css.indexOf("@supports (height: 1dvh) {"), css.indexOf("\n}\n", css.indexOf("@supports (height: 1dvh) {")));
  assert.match(dynamic, /\.media-modal\.is-inline-video \.media-dialog \{\s*--media-video-max-height: min\(76dvh, calc\(92dvh - 160px\)\);\s*max-height: 92dvh;/, "the same bounds against what is seen, where the browser knows dvh");
  assert.match(dialogRule, /calc\(92vh - 160px\)/, "the same reserve in both");
  // A phone turned on its side: the same dialog, compact, the video as high as the screen allows.
  const shortAt = css.indexOf("\n@media (max-height: 500px) {\n  .media-modal.is-inline-video {");
  assert.ok(shortAt >= 0, "a short-screen block for the R2 dialog");
  const short = css.slice(shortAt, css.indexOf("\n}\n", shortAt));
  assert.match(short, /\.media-modal\.is-inline-video \{\s*padding: 8px;/);
  assert.match(short, /\.media-modal\.is-inline-video \.media-dialog \{\s*--media-video-max-height: max\(120px, calc\(100vh - 16px - 124px\)\);\s*max-height: calc\(100vh - 16px\);\s*width: max\(min\(300px, 100vw - 16px\), min\(980px, 100vw - 16px, calc\(var\(--media-video-max-height\) \* var\(--media-aspect\) \+ 16px\)\)\);/);
  assert.match(short, /\.media-modal\.is-inline-video \.media-header h3 \{\s*font-size: 17px;\s*-webkit-line-clamp: 1;/, "one line of title");
  assert.match(short, /\.media-modal\.is-inline-video \.media-body \{\s*padding: 8px;/);
  const shortDynamic = css.slice(css.indexOf("@supports (height: 1dvh) {\n  @media (max-height: 500px) {"));
  assert.match(shortDynamic, /^@supports \(height: 1dvh\) \{\s*@media \(max-height: 500px\) \{\s*\.media-modal\.is-inline-video \.media-dialog \{\s*--media-video-max-height: max\(120px, calc\(100dvh - 16px - 124px\)\);\s*max-height: calc\(100dvh - 16px\);/, "and against what is seen, where the browser knows dvh");
  assert.ok(css.indexOf("@supports (height: 1dvh) {\n  @media (max-height: 500px) {") > shortAt, "the dvh variant comes after the plain one, so it wins");
  assert.equal(/max-width: 640px\)[^@]*is-inline-video/.test(css), false, "no phone-width rule touches the R2 dialog");
  const disabledRule = topLevelRule(".media-video-actions .media-fullscreen-button:disabled");
  assert.match(disabledRule, /opacity: 0\.45;/, "the button is seen to be off until the video's size is known");
  assert.match(disabledRule, /cursor: not-allowed;/);
  assert.match(topLevelRule('.media-modal.is-inline-video .media-asset[data-media-state="error"]'), /min-height: 190px;/, "the error fits even a wide, short video box");
  assert.equal(/\.media-fullscreen-note/.test(css), false, "no rule is left for the note the R2 video no longer shows");
  assert.equal(/is-video:not\(\.is-frame-video\) \.media-fullscreen-button/.test(css), false, "nor for a button the phone's black box no longer holds");
});
