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
