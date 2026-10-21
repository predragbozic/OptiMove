import { els } from "./dom.js";
import {
  decodeAccessContext,
  getDriveId,
  imageSources,
  normalizeAccessContext,
  renderAssetImage,
  renderImage,
  toDrivePreviewUrl,
  toDriveViewUrl,
  toImageUrl,
  toYouTubeEmbedUrl,
  withAutoplayParam,
} from "./media.js";
import { forgetMediaAccess, loadPlayback, resolvePendingThumbnails } from "./media-playback.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Every opening gets its own number, so an answer that lands after the
// modal closed or opened something else is dropped (FE-1, the R2 player).
let opening = 0;
let playbackAbort = null;
let retryPlayback = null;

// `access` is the R2 part of the media (FE-1): `videoMediaId` /
// `imageMediaId` name the objects and `accessContext` ({ type, id }) is what
// the server authorizes the row by; the addresses are fetched here, now, for
// that context, and never stored. Google Drive, YouTube and direct links
// keep the two URL arguments as before.
export function openMedia(title, imageUrl, videoUrl, access = {}) {
  if (!els.mediaModal || !els.mediaBody || !els.mediaTitle) return;
  const session = ++opening;
  stopPlayback();
  const videoMediaId = String(access.videoMediaId || "").trim();
  const imageMediaId = String(access.imageMediaId || "").trim();
  const accessContext = normalizeAccessContext(access.accessContext);
  const imagePreviewUrl = toDrivePreviewUrl(imageUrl);
  const hasImage = imageSources(imageUrl).length > 0;
  const cleanVideoUrl = String(videoUrl || "").trim();
  const videoEmbed = videoMediaId ? renderAssetVideo(imageUrl) : videoEmbedMarkup(cleanVideoUrl, imageUrl);
  els.mediaTitle.textContent = title || "Exercise media";
  els.mediaModal.classList.toggle("is-video", Boolean(videoEmbed));
  els.mediaBody.innerHTML = `
    ${videoEmbed
      ? videoEmbed
      : imageMediaId
        ? renderAssetImage(imageMediaId, accessContext, "media-image-full")
        : hasImage
          ? renderImage(imageUrl, "media-image-full", "", imagePreviewUrl)
          : imagePreviewUrl
            ? `<iframe class="media-frame" src="${escapeAttr(imagePreviewUrl)}" allowfullscreen></iframe>`
            : ""}
    ${!videoEmbed && !imageMediaId && !hasImage && !imagePreviewUrl ? `<div class="empty">No media available.</div>` : ""}
  `;
  markFrameVideo();
  els.mediaModal.hidden = false;
  if (videoMediaId) {
    wireAssetPlayback(session, { context: accessContext, withPoster: Boolean(imageMediaId) });
    return;
  }
  if (imageMediaId) void resolvePendingThumbnails(els.mediaBody);
  wireVideoFallback(cleanVideoUrl, session);
  if (videoEmbed && isMobileViewport()) enterMediaFullscreen(true);
}

function videoEmbedMarkup(videoUrl, imageUrl = "") {
  const raw = String(videoUrl || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  const poster = toImageUrl(imageUrl);
  const youTubeEmbed = toYouTubeEmbedUrl(raw, { autoplay: true });
  if (youTubeEmbed) return renderVideoFrame(youTubeEmbed);
  if (driveId) {
    return renderVideoFrame(toDrivePreviewUrl(raw, { autoplay: true }), { driveViewUrl: toDriveViewUrl(raw) });
  }
  if (/\.(mp4|webm|mov)(\?|#|$)/i.test(raw)) {
    return `
      <video class="media-video" controls playsinline preload="metadata"${poster ? ` poster="${escapeAttr(poster)}"` : ""}>
        <source src="${escapeAttr(raw)}">
      </video>
    `;
  }
  return renderVideoFrame(toDrivePreviewUrl(raw, { autoplay: true }));
}

// An embedded player (Google Drive, YouTube, any other link) is always shown
// and played inline (is-frame-video): iPhone Safari cannot put an iframe in
// full screen, so the player never waits behind a cover for it. Under it, in
// a bar that covers none of the player's controls: a link to the same file
// in Drive for a Drive video, for when Drive's own player fails inside the
// frame (Safari blocks Drive's cookies there), and the full-screen button,
// only where the browser can do it.
function renderVideoFrame(src, { driveViewUrl = "" } = {}) {
  const fullscreen = canFullscreenFrame()
    ? `<button class="media-fullscreen-button" data-action="enter-fullscreen" type="button" aria-label="Full screen"></button>`
    : "";
  const driveLink = driveViewUrl
    ? `<a class="media-drive-link" href="${escapeAttr(driveViewUrl)}" target="_blank" rel="noopener noreferrer">Open in Google Drive</a>`
    : "";
  const actions = `${driveLink}${fullscreen}`;
  return `
    <iframe class="media-frame media-frame-video" src="${escapeAttr(src)}" title="Exercise video" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
    ${actions ? `<div class="media-frame-actions">${actions}</div>` : ""}
  `;
}

function canFullscreenFrame() {
  const root = document.documentElement;
  return Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled)
    && typeof (root?.requestFullscreen || root?.webkitRequestFullscreen) === "function";
}

function markFrameVideo() {
  els.mediaModal.classList.toggle("is-frame-video", Boolean(els.mediaBody.querySelector(".media-frame-video")));
}

// An R2 video: the same HTML5 player as a direct link, without an address
// until the server has issued one (wireAssetPlayback). The poster is the
// legacy image when there is one; an asset image is set once resolved.
function renderAssetVideo(imageUrl) {
  const poster = toImageUrl(imageUrl);
  return `
    <div class="media-asset" data-media-state="loading">
      <video class="media-video" controls playsinline preload="metadata"${poster ? ` poster="${escapeAttr(poster)}"` : ""}></video>
      <p class="media-status" role="status">Preparing the video...</p>
    </div>
    <p class="media-fullscreen-note">Opening video in full screen</p>
    <button class="media-fullscreen-button" data-action="enter-fullscreen" type="button" aria-label="Full screen"></button>
  `;
}

const PLAYBACK_MESSAGES = {
  not_available: "This video is not available to you.",
  timeout: "The video took too long to prepare. Check your connection and try again.",
};
const PLAYBACK_FAILED = "The video can't be played right now.";

function setAssetState(state, message = "", code = "") {
  const box = els.mediaBody?.querySelector(".media-asset");
  if (!box) return;
  box.dataset.mediaState = state;
  const status = box.querySelector(".media-status");
  if (status) status.textContent = state === "loading" ? "Preparing the video..." : "";
  box.querySelector(".media-error")?.remove();
  if (state !== "error") return;
  box.insertAdjacentHTML("beforeend", `
    <div class="media-error" role="alert">
      <p>${escapeHtml(message || PLAYBACK_FAILED)}</p>
      <button class="plain-button compact-button media-retry" type="button" data-action="media-retry">Try again</button>
      ${code ? `<details class="media-technical"><summary>Technical details</summary><code>${escapeHtml(code)}</code></details>` : ""}
    </div>
  `);
}

// Fetches the context's video address (and its image as the poster, in the
// same request), assigns it, and asks for a new one once when the address
// fails to load (expired, revoked); a second failure is the error state with
// Try again. Every step checks that this opening is still the one on screen.
function wireAssetPlayback(session, { context, withPoster }) {
  const video = els.mediaBody?.querySelector(".media-asset .media-video");
  if (!video) return;
  const live = () => session === opening && !els.mediaModal.hidden && video.isConnected;
  video.addEventListener("ended", closeMedia, { once: true });
  // iPhone Safari leaves its own full-screen player through this event.
  video.addEventListener("webkitendfullscreen", closeMedia, { once: true });
  video.addEventListener("loadedmetadata", () => {
    if (live() && isMobileViewport()) enterMediaFullscreen(true);
  }, { once: true });
  let attempts = 0;
  const onError = () => {
    if (!live()) return;
    forgetMediaAccess(context, "video");
    if (attempts < 2) {
      void load();
      return;
    }
    setAssetState("error", PLAYBACK_FAILED, "media_playback_failed");
  };
  const load = async () => {
    if (!live()) return;
    attempts += 1;
    setAssetState("loading");
    playbackAbort?.abort();
    const controller = new AbortController();
    playbackAbort = controller;
    const resume = Number(video.currentTime) || 0;
    try {
      const { url, poster } = await loadPlayback(context, { withPoster, signal: controller.signal });
      if (!live() || controller.signal.aborted) return;
      if (poster) video.poster = poster;
      video.addEventListener("error", onError, { once: true });
      if (resume) {
        video.addEventListener("loadedmetadata", () => {
          try { video.currentTime = resume; } catch { /* the browser decides */ }
        }, { once: true });
      }
      video.src = url;
      setAssetState("ready");
    } catch (error) {
      if (!live() || controller.signal.aborted) return;
      setAssetState("error", PLAYBACK_MESSAGES[error?.code] || PLAYBACK_FAILED, error?.code || "media_access_failed");
    }
  };
  retryPlayback = () => {
    attempts = 0;
    forgetMediaAccess(context, "video");
    void load();
  };
  void load();
}

function stopPlayback() {
  playbackAbort?.abort();
  playbackAbort = null;
  retryPlayback = null;
}

// The fallback belongs to its own opening: a timer left by a direct link
// that was closed never replaces a video opened after it.
function wireVideoFallback(videoUrl, session) {
  const video = els.mediaBody?.querySelector(".media-video");
  if (!video) return;
  let settled = false;
  const fallbackSrc = video.dataset.fallbackSrc || toDrivePreviewUrl(videoUrl);
  video.addEventListener("ended", closeMedia, { once: true });
  const showFallback = () => {
    if (settled || session !== opening || !fallbackSrc || !els.mediaBody || els.mediaModal.hidden) return;
    settled = true;
    els.mediaBody.innerHTML = renderVideoFrame(withAutoplayParam(fallbackSrc));
    markFrameVideo();
  };
  video.addEventListener("loadedmetadata", () => {
    settled = true;
  }, { once: true });
  video.addEventListener("error", showFallback, { once: true });
  setTimeout(showFallback, 2200);
}

export function enterMediaFullscreen(silent = false) {
  const target = els.mediaBody?.querySelector(".media-frame-video, .media-video") || els.mediaModal?.querySelector(".media-dialog");
  if (!target) return;
  // iPhone Safari has no requestFullscreen on any element; a <video> enters
  // its own full-screen player through webkitEnterFullscreen (metadata loaded).
  if (target.tagName === "VIDEO" && typeof target.requestFullscreen !== "function" && typeof target.webkitEnterFullscreen === "function") {
    try {
      target.webkitEnterFullscreen();
    } catch (error) {
      if (!silent) console.warn(error);
    }
    return;
  }
  const request = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(target);
    if (result?.catch && silent) result.catch(() => {});
  } catch (error) {
    if (!silent) console.warn(error);
  }
}

export function handleMediaAction(action) {
  const type = action.dataset.action;
  if (type === "open-media") {
    openMedia(action.dataset.title || "Exercise media", action.dataset.image || "", action.dataset.video || "", {
      videoMediaId: action.dataset.videoMediaId || "",
      imageMediaId: action.dataset.imageMediaId || "",
      accessContext: decodeAccessContext(action.dataset.mediaAccessContext || ""),
    });
    return true;
  }
  if (type === "media-retry") {
    retryPlayback?.();
    return true;
  }
  if (type === "enter-fullscreen") {
    enterMediaFullscreen();
    return true;
  }
  if (type === "close-media") {
    closeMedia();
    return true;
  }
  return false;
}

// Leaving full screen closes a <video>'s small box, which shows nothing
// inline; an embedded player stays, with its Drive link, inline.
export function handleFullscreenChange() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fullscreenElement && els.mediaModal?.classList.contains("is-video") && !els.mediaModal.classList.contains("is-frame-video") && !els.mediaModal.hidden) {
    closeMedia();
  }
}

function isMobileViewport() {
  return window.matchMedia?.("(max-width: 760px)").matches || window.innerWidth <= 760;
}

export function closeMedia() {
  if (!els.mediaModal || !els.mediaBody) return;
  opening += 1;
  stopPlayback();
  // The short-lived address leaves with the element.
  els.mediaBody.querySelector("video[src]")?.removeAttribute("src");
  els.mediaModal.hidden = true;
  els.mediaModal.classList.remove("is-video", "is-frame-video");
  els.mediaBody.innerHTML = "";
}
