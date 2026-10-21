import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// The media modal on a phone with an embedded player (Google Drive, YouTube,
// any other link): the player is shown and played inline, never behind the
// black cover that waits for full screen - iPhone Safari cannot put an iframe
// in full screen, so before this change a Drive video there could never be
// seen or tapped. A Drive video also gets a real link to the file in Drive.
// The R2 <video> path keeps its phone layout.

const dom = new JSDOM(`<!doctype html><html><body>
  <div class="media-modal" id="mediaModal" hidden>
    <div class="media-backdrop" data-action="close-media"></div>
    <div class="media-dialog" role="dialog" aria-modal="true" aria-label="Exercise media">
      <div class="media-header"><h3 id="mediaTitle">Exercise media</h3><button class="plain-button" data-action="close-media">Close</button></div>
      <div class="media-body" id="mediaBody"></div>
    </div>
  </div>
</body></html>`, { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.HTMLImageElement = dom.window.HTMLImageElement;

const { els } = await import("../dom.js");
const modal = await import("../media-modal.js");
const media = await import("../media.js");

const body = () => els.mediaBody;
const DRIVE_VIDEO = "https://drive.google.com/file/d/FILE_1/view?usp=sharing";
const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

// A phone viewport, and what the browser offers for full screen: an iPhone
// (no element full screen at all) or Android Chrome (full screen of any
// element, here answered by `answer`).
function phone({ fullscreen = false, answer = () => Promise.resolve() } = {}) {
  window.matchMedia = (query) => ({ matches: query === "(max-width: 760px)" });
  const requests = [];
  Object.defineProperty(document, "fullscreenEnabled", { configurable: true, get: () => fullscreen });
  if (fullscreen) {
    dom.window.Element.prototype.requestFullscreen = function requestFullscreen() {
      requests.push(this);
      return answer();
    };
  } else {
    delete dom.window.Element.prototype.requestFullscreen;
  }
  return requests;
}

function phoneBlockOf(selector, query) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `${selector} must exist in styles.css`);
  const blockStart = css.lastIndexOf("\n@media", at) + 1;
  assert.equal(css.slice(blockStart, css.indexOf("{", blockStart)).trim(), query, `${selector} lives in ${query}`);
  return css.slice(blockStart, css.indexOf("\n}\n", at));
}

function ruleOf(source, selector) {
  const at = source.indexOf(`${selector} {`);
  assert.ok(at >= 0, `rule ${selector} must exist`);
  return source.slice(at, source.indexOf("}", at));
}

test("1. a Drive video on an iPhone: the player is in the dialog with the Drive link under it, no full-screen note and no button that could do nothing", () => {
  const requests = phone({ fullscreen: false });
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  assert.equal(els.mediaModal.hidden, false);
  assert.ok(els.mediaModal.classList.contains("is-video"));
  assert.ok(els.mediaModal.classList.contains("is-frame-video"), "the inline-player layout, not the black box");
  const frame = body().querySelector("iframe.media-frame-video");
  assert.equal(frame.getAttribute("src"), "https://drive.google.com/file/d/FILE_1/preview?autoplay=1");
  assert.equal(frame.hasAttribute("hidden"), false);
  assert.equal(frame.getAttribute("title"), "Exercise video");
  assert.equal(requests.length, 0);
  const link = body().querySelector(".media-frame-actions a.media-drive-link");
  assert.ok(link, "a real link under the player");
  assert.equal(link.textContent.trim(), "Open in Google Drive");
  assert.equal(link.getAttribute("href"), "https://drive.google.com/file/d/FILE_1/view");
  assert.equal(link.getAttribute("target"), "_blank");
  assert.deepEqual(link.getAttribute("rel").split(/\s+/).sort(), ["noopener", "noreferrer"]);
  assert.equal(body().querySelector(".media-fullscreen-note"), null, "full screen is not entered, so it is not announced");
  assert.equal(body().querySelector('[data-action="enter-fullscreen"]'), null, "iPhone Safari cannot put a frame in full screen");
  assert.equal(body().innerHTML.includes("export=download"), false, "never the old download address");
  modal.closeMedia();
  assert.equal(els.mediaModal.classList.contains("is-frame-video"), false);
  assert.equal(els.mediaModal.classList.contains("is-video"), false);
});

test("2. a Drive video on Android: full screen is still asked for on open and the button stays, but the inline player is there whether the request succeeds or fails", async () => {
  let requests = phone({ fullscreen: true });
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  const frame = body().querySelector("iframe.media-frame-video");
  assert.deepEqual(requests, [frame], "the frame itself is asked for full screen");
  assert.ok(body().querySelector('.media-frame-actions [data-action="enter-fullscreen"]'), "the button sits beside the Drive link");
  assert.equal(body().querySelector(".media-fullscreen-note"), null);
  modal.closeMedia();
  requests = phone({ fullscreen: true, answer: () => Promise.reject(new Error("denied")) });
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requests.length, 1);
  assert.ok(els.mediaModal.classList.contains("is-frame-video"));
  assert.ok(body().querySelector("iframe.media-frame-video"), "a refused full screen leaves the player in place");
  assert.ok(body().querySelector("a.media-drive-link"));
  modal.closeMedia();
});

test("3. YouTube and any other embedded link use the same inline layout, without a Drive link; the full-screen button sits in the bar under the player, never over it", () => {
  phone({ fullscreen: false });
  modal.openMedia("Tube", "", "https://youtu.be/dQw4w9WgXcQ");
  assert.ok(els.mediaModal.classList.contains("is-frame-video"));
  assert.equal(body().querySelector("iframe.media-frame-video").getAttribute("src"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
  assert.equal(body().querySelector(".media-drive-link"), null);
  assert.equal(body().querySelector(".media-fullscreen-note"), null);
  assert.equal(body().querySelector(".media-frame-actions"), null, "nothing for the bar on an iPhone");
  modal.closeMedia();
  phone({ fullscreen: true });
  modal.openMedia("Other", "", "https://player.example/embed/42");
  assert.ok(els.mediaModal.classList.contains("is-frame-video"));
  assert.equal(body().querySelector(".media-drive-link"), null);
  assert.ok(body().querySelector('.media-frame-actions [data-action="enter-fullscreen"]'));
  assert.equal(body().querySelector(':scope > [data-action="enter-fullscreen"]'), null, "no button floating over the player");
  modal.closeMedia();
});

test("3b. a browser that reports full screen but cannot request it for an element gets no button", () => {
  phone({ fullscreen: false });
  Object.defineProperty(document, "webkitFullscreenEnabled", { configurable: true, get: () => true });
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  assert.equal(body().querySelector('[data-action="enter-fullscreen"]'), null);
  assert.ok(body().querySelector("a.media-drive-link"));
  modal.closeMedia();
  delete document.webkitFullscreenEnabled;
});

test("4. a direct link that falls back to a frame takes the inline layout too; an R2 video keeps its phone layout, note and button", () => {
  phone({ fullscreen: false });
  modal.openMedia("Clip", "", "https://cdn.example/clip.mp4");
  assert.equal(els.mediaModal.classList.contains("is-frame-video"), false, "a <video> is not a frame");
  body().querySelector("video.media-video").dispatchEvent(new dom.window.Event("error"));
  assert.ok(body().querySelector("iframe.media-frame-video"));
  assert.ok(els.mediaModal.classList.contains("is-frame-video"));
  modal.closeMedia();
  globalThis.fetch = () => new Promise(() => {});
  modal.openMedia("Dead Bug", "", "", { videoMediaId: "vid-1", accessContext: { type: "exercise", id: "e1" } });
  assert.ok(els.mediaModal.classList.contains("is-video"));
  assert.equal(els.mediaModal.classList.contains("is-frame-video"), false);
  assert.ok(body().querySelector(".media-asset video.media-video"));
  assert.match(body().querySelector(".media-fullscreen-note").textContent, /Opening video in full screen/);
  assert.ok(body().querySelector('[data-action="enter-fullscreen"]'));
  modal.closeMedia();
});

test("4b. leaving full screen keeps an embedded player and its Drive link on screen; an R2 video's small box still closes", () => {
  phone({ fullscreen: true });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  modal.handleFullscreenChange();
  assert.equal(els.mediaModal.hidden, false, "back from full screen to the inline player");
  assert.ok(body().querySelector("iframe.media-frame-video"));
  assert.ok(body().querySelector("a.media-drive-link"));
  modal.closeMedia();
  globalThis.fetch = () => new Promise(() => {});
  modal.openMedia("Dead Bug", "", "", { videoMediaId: "vid-1", accessContext: { type: "exercise", id: "e1" } });
  modal.handleFullscreenChange();
  assert.equal(els.mediaModal.hidden, true, "the R2 path is unchanged");
  delete document.fullscreenElement;
});

test("4c. closing a direct link and opening a Drive video at once: the direct link's late fallback never replaces the Drive player; left open, it still falls back", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  phone({ fullscreen: false });
  modal.openMedia("Clip", "", "https://cdn.example/clip.mp4");
  modal.closeMedia();
  modal.openMedia("Dead Bug", "", DRIVE_VIDEO);
  t.mock.timers.tick(2300);
  assert.equal(body().querySelector("iframe.media-frame-video").getAttribute("src"), "https://drive.google.com/file/d/FILE_1/preview?autoplay=1");
  assert.ok(body().querySelector("a.media-drive-link"), "the Drive link is still there");
  modal.closeMedia();
  modal.openMedia("Clip", "", "https://cdn.example/clip.mp4");
  t.mock.timers.tick(2300);
  assert.equal(body().querySelector("iframe.media-frame-video").getAttribute("src"), "https://cdn.example/clip.mp4?autoplay=1");
  assert.ok(els.mediaModal.classList.contains("is-frame-video"));
  modal.closeMedia();
});

test("5. toDriveViewUrl: the file's view page for every Drive link form, nothing for anything else", () => {
  assert.equal(media.toDriveViewUrl("https://drive.google.com/file/d/FILE_1/view?usp=sharing"), "https://drive.google.com/file/d/FILE_1/view");
  assert.equal(media.toDriveViewUrl("https://drive.google.com/open?id=FILE_2"), "https://drive.google.com/file/d/FILE_2/view");
  assert.equal(media.toDriveViewUrl("https://drive.google.com/uc?export=download&id=FILE_3"), "https://drive.google.com/file/d/FILE_3/view");
  assert.equal(media.toDriveViewUrl("https://youtu.be/dQw4w9WgXcQ"), "");
  assert.equal(media.toDriveViewUrl(""), "");
});

test("6. styles.css: on a phone the black cover and the 140 px box are only for a <video>; a frame fills the screen, upright or turned, with the Close bar above it and 44 px targets", () => {
  assert.equal(css.includes(".media-modal.is-video .media-body::after"), false, "no cover over every video any more");
  assert.equal(/is-frame-video[^{]*::after/.test(css.replaceAll(":not(.is-frame-video)", "")), false, "nothing is drawn over a frame");
  const native = phoneBlockOf(".media-modal.is-video:not(.is-frame-video) .media-dialog", "@media (max-width: 640px)");
  for (const rule of native.slice(native.indexOf("{") + 1).matchAll(/([^{}]+)\{[^}]*\}/g)) {
    const selector = rule[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector.startsWith(".media-modal") && /::after|height: 140px|bottom: 48px/.test(rule[0])) {
      assert.ok(selector.includes(":not(.is-frame-video)"), `${selector} must leave a frame alone`);
    }
  }
  const block = phoneBlockOf(".media-modal.is-video.is-frame-video .media-dialog", "@media (max-width: 640px), (max-height: 500px)");
  assert.equal(block.includes(":not(.is-frame-video)"), false, "the turned-phone block holds the frame layout only, never the <video> box");
  const dialog = ruleOf(block, ".media-modal.is-video.is-frame-video .media-dialog");
  assert.match(dialog, /width: 100%;/);
  assert.match(dialog, /height: 100%;/);
  assert.match(dialog, /max-height: 100%;/);
  assert.match(ruleOf(block, ".media-modal.is-video.is-frame-video .media-header"), /position: relative;/);
  assert.match(ruleOf(block, ".media-modal.is-video.is-frame-video .media-header .plain-button"), /min-height: 44px;/);
  const padding = ruleOf(block, ".media-modal.is-video.is-frame-video");
  for (const side of ["top", "right", "bottom", "left"]) assert.match(padding, new RegExp(`env\\(safe-area-inset-${side}, 0px\\)`));
  assert.match(ruleOf(css, ".media-drive-link"), /min-height: 44px;/);
  assert.match(ruleOf(css, ".media-modal.is-frame-video .media-frame-video"), /flex: 1 1 0;/);
});
