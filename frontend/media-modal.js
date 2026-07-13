import { els } from "./dom.js";
import {
  getDriveId,
  imageSources,
  renderImage,
  toDrivePreviewUrl,
  toImageUrl,
  withAutoplayParam,
} from "./media.js";
import { escapeAttr } from "./utils.js";

export function openMedia(title, imageUrl, videoUrl) {
  if (!els.mediaModal || !els.mediaBody || !els.mediaTitle) return;
  const imagePreviewUrl = toDrivePreviewUrl(imageUrl);
  const hasImage = imageSources(imageUrl).length > 0;
  const cleanVideoUrl = String(videoUrl || "").trim();
  const videoEmbed = videoEmbedMarkup(cleanVideoUrl, imageUrl);
  els.mediaTitle.textContent = title || "Exercise media";
  els.mediaModal.classList.toggle("is-video", Boolean(videoEmbed));
  els.mediaBody.innerHTML = `
    ${videoEmbed
      ? videoEmbed
      : hasImage
        ? renderImage(imageUrl, "media-image-full", "", imagePreviewUrl)
        : imagePreviewUrl
          ? `<iframe class="media-frame" src="${escapeAttr(imagePreviewUrl)}" allowfullscreen></iframe>`
          : ""}
    ${!videoEmbed && !hasImage && !imagePreviewUrl ? `<div class="empty">No media available.</div>` : ""}
  `;
  els.mediaModal.hidden = false;
  wireVideoFallback(cleanVideoUrl);
  if (videoEmbed && isMobileViewport()) enterMediaFullscreen(true);
}

function videoEmbedMarkup(videoUrl, imageUrl = "") {
  const raw = String(videoUrl || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  const poster = toImageUrl(imageUrl);
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
  const request = target?.requestFullscreen || target?.webkitRequestFullscreen || target?.msRequestFullscreen;
  if (!target || !request) return;
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
    openMedia(action.dataset.title || "Exercise media", action.dataset.image || "", action.dataset.video || "");
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
  els.mediaModal.hidden = true;
  els.mediaModal.classList.remove("is-video");
  els.mediaBody.innerHTML = "";
}
