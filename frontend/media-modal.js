import { els } from "./dom.js";
import {
  decodeAccessContext,
  getDriveId,
  imageSources,
  renderAssetImage,
  renderImage,
  toDrivePreviewUrl,
  toImageUrl,
  toYouTubeEmbedUrl,
  withAutoplayParam,
} from "./media.js";
import { forgetMediaAccess, loadPlayback, resolveMediaAccess, resolvePendingThumbnails } from "./media-playback.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Every opening gets its own number, so an answer that lands after the
// modal closed or opened something else is dropped (FE-1, the R2 player).
let opening = 0;
let playbackAbort = null;
let retryPlayback = null;

// `access` is the R2 part of the media (FE-1): `videoAssetId` /
// `imageAssetId` name the objects and `accessContext` is the row's opaque
// context; their addresses are fetched here, now, and never stored. Google
// Drive, YouTube and direct links keep the two URL arguments as before.
export function openMedia(title, imageUrl, videoUrl, access = {}) {
  if (!els.mediaModal || !els.mediaBody || !els.mediaTitle) return;
  const session = ++opening;
  stopPlayback();
  const videoAssetId = String(access.videoAssetId || "").trim();
  const imageAssetId = String(access.imageAssetId || "").trim();
  const accessContext = access.accessContext ?? null;
  const imagePreviewUrl = toDrivePreviewUrl(imageUrl);
  const hasImage = imageSources(imageUrl).length > 0;
  const cleanVideoUrl = String(videoUrl || "").trim();
  const videoEmbed = videoAssetId ? renderAssetVideo(imageUrl) : videoEmbedMarkup(cleanVideoUrl, imageUrl);
  els.mediaTitle.textContent = title || "Exercise media";
  els.mediaModal.classList.toggle("is-video", Boolean(videoEmbed));
  els.mediaBody.innerHTML = `
    ${videoEmbed
      ? videoEmbed
      : imageAssetId
        ? renderAssetImage(imageAssetId, accessContext, "media-image-full")
        : hasImage
          ? renderImage(imageUrl, "media-image-full", "", imagePreviewUrl)
          : imagePreviewUrl
            ? `<iframe class="media-frame" src="${escapeAttr(imagePreviewUrl)}" allowfullscreen></iframe>`
            : ""}
    ${!videoEmbed && !imageAssetId && !hasImage && !imagePreviewUrl ? `<div class="empty">No media available.</div>` : ""}
  `;
  els.mediaModal.hidden = false;
  if (videoAssetId) {
    wireAssetPlayback(session, { assetId: videoAssetId, posterAssetId: imageAssetId, accessContext });
    return;
  }
  if (imageAssetId) void resolvePendingThumbnails(els.mediaBody);
  wireVideoFallback(cleanVideoUrl);
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
    return renderVideoFrame(toDrivePreviewUrl(raw, { autoplay: true }));
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

function renderVideoFrame(src) {
  return `
    <iframe class="media-frame media-frame-video" src="${escapeAttr(src)}" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>
    <p class="media-fullscreen-note">Opening video in full screen</p>
    <button class="media-fullscreen-button" data-action="enter-fullscreen" type="button" aria-label="Full screen"></button>
  `;
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

// Fetches the video's short-lived address, assigns it, and asks for a new
// one once when the address fails to load (expired, revoked); a second
// failure is the error state with Try again. Every step checks that this
// opening is still the one on screen.
function wireAssetPlayback(session, { assetId, posterAssetId, accessContext }) {
  const video = els.mediaBody?.querySelector(".media-asset .media-video");
  if (!video) return;
  const live = () => session === opening && !els.mediaModal.hidden && video.isConnected;
  video.addEventListener("ended", closeMedia, { once: true });
  // iPhone Safari leaves its own full-screen player through this event.
  video.addEventListener("webkitendfullscreen", closeMedia, { once: true });
  video.addEventListener("loadedmetadata", () => {
    if (live() && isMobileViewport()) enterMediaFullscreen(true);
  }, { once: true });
  if (posterAssetId) {
    void resolveMediaAccess([{ assetId: posterAssetId, accessContext }]).then((urls) => {
      const url = urls.get(posterAssetId);
      if (url && live()) video.poster = url;
    });
  }
  let attempts = 0;
  const onError = () => {
    if (!live()) return;
    forgetMediaAccess(assetId);
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
      const { url } = await loadPlayback(assetId, accessContext, { signal: controller.signal });
      if (!live() || controller.signal.aborted) return;
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
    forgetMediaAccess(assetId);
    void load();
  };
  void load();
}

function stopPlayback() {
  playbackAbort?.abort();
  playbackAbort = null;
  retryPlayback = null;
}

function wireVideoFallback(videoUrl) {
  const video = els.mediaBody?.querySelector(".media-video");
  if (!video) return;
  let settled = false;
  const fallbackSrc = video.dataset.fallbackSrc || toDrivePreviewUrl(videoUrl);
  video.addEventListener("ended", closeMedia, { once: true });
  const showFallback = () => {
    if (settled || !fallbackSrc || !els.mediaBody || els.mediaModal.hidden) return;
    settled = true;
    els.mediaBody.innerHTML = renderVideoFrame(withAutoplayParam(fallbackSrc));
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
      videoAssetId: action.dataset.videoAssetId || "",
      imageAssetId: action.dataset.imageAssetId || "",
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

export function handleFullscreenChange() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fullscreenElement && els.mediaModal?.classList.contains("is-video") && !els.mediaModal.hidden) {
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
  els.mediaModal.classList.remove("is-video");
  els.mediaBody.innerHTML = "";
}
