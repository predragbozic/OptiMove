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
