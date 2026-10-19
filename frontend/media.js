import { escapeAttr, escapeHtml } from "./utils.js";

export function toDrivePreviewUrl(url, options = {}) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const driveId = getDriveId(raw);
  const previewUrl = driveId ? `https://drive.google.com/file/d/${driveId}/preview` : raw;
  return options.autoplay ? withAutoplayParam(previewUrl) : previewUrl;
}

export function withAutoplayParam(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  return raw.includes("?") ? `${raw}&autoplay=1` : `${raw}?autoplay=1`;
}

export function toImageUrl(url) {
  return imageSources(url)[0] || "";
}

export function renderImage(url, className, alt = "", previewUrl = "") {
  const sources = imageSources(url);
  if (!sources.length) return "";
  const fallbacks = sources.slice(1);
  return `<img class="${escapeAttr(className)}" src="${escapeAttr(sources[0])}" alt="${escapeAttr(alt)}"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}${previewUrl ? ` data-preview-url="${escapeAttr(previewUrl)}"` : ""}>`;
}

export function renderMediaThumb(url, fallbackLabel = "Image") {
  const previewUrl = toDrivePreviewUrl(url);
  return `${renderImage(url, "media-thumb", "", previewUrl)}${fallbackLabel ? `<span class="media-fallback">${escapeHtml(fallbackLabel)}</span>` : ""}`;
}

export function imageSources(url) {
  const raw = String(url || "").trim();
  if (!raw) return [];
  const driveId = getDriveId(raw);
  if (!driveId) return [raw];
  return [
    `https://drive.google.com/thumbnail?id=${driveId}&sz=w1000`,
    `https://lh3.googleusercontent.com/d/${driveId}=w1000`,
    `https://drive.google.com/uc?export=view&id=${driveId}`,
  ];
}

// A YouTube video's 11-character id from the usual link forms (watch?v=,
// youtu.be/, /shorts/, /embed/, /live/), or "" for anything else - only
// YouTube's own hosts are accepted, never an id-looking path on another site.
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com", "youtu.be"]);

export function getYouTubeId(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch {
    return "";
  }
  if (!["https:", "http:"].includes(parsed.protocol) || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return "";
  const candidate = parsed.hostname.toLowerCase() === "youtu.be"
    ? parsed.pathname.split("/")[1]
    : parsed.searchParams.get("v") || (parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/) || [])[1];
  return /^[A-Za-z0-9_-]{11}$/.test(candidate || "") ? candidate : "";
}

export function toYouTubeEmbedUrl(url, options = {}) {
  const id = getYouTubeId(url);
  if (!id) return "";
  const embed = `https://www.youtube-nocookie.com/embed/${id}`;
  return options.autoplay ? withAutoplayParam(embed) : embed;
}

// Thumbnail images a video link offers without any API call: YouTube's
// public cover images and Google Drive's thumbnail (Drive answers only for a
// file shared with "anyone with the link"). The caller falls back to the
// exercise's initials when none loads. `large` is for a picture across a
// card (Big, Details): Drive's 1000 px thumbnail. YouTube keeps its 16:9
// cover first either way - its larger covers are 4:3 with black bars around
// the video (above and below a 16:9 one, beside a vertical one), which no
// frame could crop away without knowing the video's shape.
export function videoThumbnailSources(url, { large = false } = {}) {
  const youTubeId = getYouTubeId(url);
  if (youTubeId) return [`https://i.ytimg.com/vi/${youTubeId}/mqdefault.jpg`, `https://i.ytimg.com/vi/${youTubeId}/hqdefault.jpg`];
  const driveId = getDriveId(url);
  const width = large ? "w1000" : "w640";
  if (driveId) return [`https://drive.google.com/thumbnail?id=${driveId}&sz=${width}`, `https://lh3.googleusercontent.com/d/${driveId}=${width}`];
  return [];
}

export function parseImageFallbacks(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function getDriveId(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const fileMatch = raw.match(/drive\.google\.com\/file\/d\/([^/?]+)/);
  if (fileMatch) return fileMatch[1];
  const ucMatch = raw.match(/[?&]id=([^&]+)/);
  if (raw.includes("drive.google.com") && ucMatch) return ucMatch[1];
  const lhMatch = raw.match(/lh3\.googleusercontent\.com\/d\/([^/?]+)/);
  if (lhMatch) return lhMatch[1];
  return "";
}

// ---------------------------------------------------------------------------
// The media descriptor (R2 media, FE-1).
//
// The API contract delivers, on exercise list and detail rows, Builder and
// program items and a block's coverSlides, a `media` descriptor:
// `media.video` and `media.image`, each with `source` "asset" (an object in
// R2, named by its `mediaId` and reachable only through a short-lived URL the
// server issues for the row's context - media-playback.js), "legacy" (a
// Google Drive, YouTube or direct link, shown exactly as before) or "none";
// and `media.accessContext`, the `{ type, id }` the server authorizes an
// access request by. A row without a descriptor (an older payload) is read
// from its legacy URL fields. Every render site reads media through
// exerciseMediaOf() and nothing else, so a change of the descriptor's field
// names is one function here.
// ---------------------------------------------------------------------------

const NO_MEDIA = Object.freeze({ source: "none", mediaId: "", url: "", kind: "" });

// The access context of a row: `{ type, id }`, both non-empty, or null.
export function normalizeAccessContext(value) {
  if (!value || typeof value !== "object") return null;
  const type = typeof value.type === "string" ? value.type.trim() : "";
  const id = typeof value.id === "string" ? value.id.trim() : Number.isFinite(value.id) ? String(value.id) : "";
  return type && id ? { type, id } : null;
}

// The kind of a legacy link: the player and the covers tell them apart.
export function legacyMediaKind(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (getYouTubeId(raw)) return "youtube";
  if (getDriveId(raw)) return "drive";
  return "url";
}

function legacyUrlOf(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeMediaSlot(slot, rowUrl) {
  const described = Boolean(slot) && typeof slot === "object";
  const source = described ? String(slot.source || "").trim() : "";
  if (source === "asset") {
    const mediaId = typeof slot.mediaId === "string" ? slot.mediaId.trim() : "";
    return mediaId ? { source: "asset", mediaId, url: "", kind: "asset" } : NO_MEDIA;
  }
  if (source === "none") return NO_MEDIA;
  const url = source === "legacy" && typeof slot.url === "string" && slot.url.trim() ? slot.url.trim() : rowUrl;
  return url ? { source: "legacy", mediaId: "", url, kind: legacyMediaKind(url) } : NO_MEDIA;
}

export function exerciseMediaOf(row) {
  const descriptor = row?.media && typeof row.media === "object" ? row.media : null;
  return {
    video: normalizeMediaSlot(descriptor?.video, legacyUrlOf(row, ["video", "video_url", "videoUrl"])),
    image: normalizeMediaSlot(descriptor?.image, legacyUrlOf(row, ["image", "image_url", "imageUrl"])),
    accessContext: normalizeAccessContext(descriptor?.accessContext),
  };
}

export function hasAnyMedia(media) {
  return media.video.source !== "none" || media.image.source !== "none";
}

// The access context travels through a data attribute as JSON and comes back
// normalized ({ type, id }) or null.
export function encodeAccessContext(context) {
  const normalized = normalizeAccessContext(context);
  return normalized ? JSON.stringify(normalized) : "";
}

export function decodeAccessContext(value) {
  if (!value) return null;
  try {
    return normalizeAccessContext(JSON.parse(value));
  } catch {
    return null;
  }
}

// The data attributes of an "open-media" control: the legacy links as before
// (data-image / data-video, the modal's own inputs) and, for an R2 asset,
// its media id and the row's access context - never a URL to the object.
export function mediaAccessAttributes(media) {
  const parts = [`data-image="${escapeAttr(media.image.url)}"`, `data-video="${escapeAttr(media.video.url)}"`];
  if (media.video.source === "asset") parts.push(`data-video-media-id="${escapeAttr(media.video.mediaId)}"`);
  if (media.image.source === "asset") parts.push(`data-image-media-id="${escapeAttr(media.image.mediaId)}"`);
  if (media.video.source === "asset" || media.image.source === "asset") {
    parts.push(`data-media-access-context="${escapeAttr(encodeAccessContext(media.accessContext))}"`);
  }
  return parts.join(" ");
}

// An <img> for an R2 asset: no address until the resolver (media-playback.js)
// has asked the server for the row's `slot` in a batch; data-fallbacks are
// the public addresses to try should it get none.
export function renderAssetImage(mediaId, accessContext, className, { alt = "", fallbacks = [], attributes = "", slot = "image" } = {}) {
  return `<img class="${escapeAttr(className)}" alt="${escapeAttr(alt)}" data-media-id="${escapeAttr(mediaId)}" data-media-slot="${escapeAttr(slot)}" data-media-access-context="${escapeAttr(encodeAccessContext(accessContext))}"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}${attributes ? ` ${attributes}` : ""}>`;
}

// A row's picture by its image slot: an asset through the resolver, a legacy
// link exactly as renderImage() always drew it, nothing for "none".
export function renderMediaImage(media, className, { alt = "", previewUrl = "" } = {}) {
  const slot = media.image;
  if (slot.source === "asset") return renderAssetImage(slot.mediaId, media.accessContext, className, { alt });
  if (slot.source === "legacy") return renderImage(slot.url, className, alt, previewUrl);
  return "";
}

// renderMediaThumb() for a descriptor: the same markup for a legacy link, the
// asset picture plus the same fallback label for an asset.
export function renderMediaThumbOf(media, fallbackLabel = "Image") {
  if (media.image.source === "asset") {
    return `${renderAssetImage(media.image.mediaId, media.accessContext, "media-thumb")}${fallbackLabel ? `<span class="media-fallback">${escapeHtml(fallbackLabel)}</span>` : ""}`;
  }
  return renderMediaThumb(media.image.url, fallbackLabel);
}
