// The one renderer of OptiMove's built-in icons (Data configuration visual
// polish, PR-1; docs/ai/data-configuration-visual-proposal.md section 3). A
// stored icon is the text `icon:<key>` in an `icon_url` column, never a URL or
// markup: only a key of frontend/icon-library.js draws its paths, and any other
// `icon:` value draws a neutral placeholder. The paths come from the generated
// library and are written into attributes escaped all the same.
import { ICON_ALIASES, ICON_CATEGORIES, ICONS } from "./icon-library.js";
import { escapeAttr } from "./utils.js";

export { ICON_CATEGORIES, ICONS };
export const ICON_PREFIX = "icon:";

const BY_KEY = new Map(ICONS.map((icon) => [icon.key, icon]));
// A dashed circle: an icon this library does not know (an older or unknown key).
const PLACEHOLDER = Object.freeze(["M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"]);

// The icon of a key or of an older alias (the Builder's former glyph codes);
// null for anything else.
export function iconByKey(key) {
  if (typeof key !== "string") return null;
  if (BY_KEY.has(key)) return BY_KEY.get(key);
  return Object.hasOwn(ICON_ALIASES, key) ? BY_KEY.get(ICON_ALIASES[key]) || null : null;
}
export const isLibraryKey = (key) => typeof key === "string" && BY_KEY.has(key);
export const storedIconValue = (key) => `${ICON_PREFIX}${key}`;
export const isStoredIconValue = (value) => typeof value === "string" && value.startsWith(ICON_PREFIX);
export const categoryLabel = (id) => ICON_CATEGORIES.find((c) => c.id === id)?.label || "";

// An icon as inline SVG, drawn as 24 x 24 strokes in the text colour. Without
// a label it is decoration (aria-hidden); with one it is an image of that name.
export function renderIconSvg(key, { size = 24, className = "", label = "" } = {}) {
  const icon = iconByKey(key);
  const px = Number.isInteger(size) && size >= 8 && size <= 96 ? size : 24;
  const a11y = label ? `role="img" aria-label="${escapeAttr(label)}"` : `aria-hidden="true"`;
  const classes = ["om-icon", icon ? "" : "om-icon-unknown", className].filter(Boolean).join(" ");
  return `<svg class="${escapeAttr(classes)}" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" focusable="false" ${a11y}>${(icon ? icon.paths : PLACEHOLDER).map((d) => `<path d="${escapeAttr(d)}"/>`).join("")}</svg>`;
}

// A stored `icon:<key>` value as an icon; "" for an empty or any other value.
// An older alias (`icon:dumbbell`) draws its icon here, while the server's
// reads name only a key of the library and answer null for an alias
// (backend/src/iconKeys.js): the server never writes one, so this is only the
// tolerant side of drawing a value written by hand.
export function renderStoredIconHtml(value, options = {}) {
  if (!isStoredIconValue(value)) return "";
  return renderIconSvg(value.slice(ICON_PREFIX.length), options);
}

// A metric definition's `icon_url` where the older screens draw it: a library
// icon for `icon:<key>`, an image for any other value (a URL, as before), the
// fallback markup when there is none.
export function renderMetricIconHtml(iconUrl, { className = "", fallback = "" } = {}) {
  if (isStoredIconValue(iconUrl)) return renderStoredIconHtml(iconUrl, { size: 16, className });
  if (iconUrl) return `<img src="${escapeAttr(iconUrl)}" alt=""${className ? ` class="${escapeAttr(className)}"` : ""} />`;
  return fallback;
}

// The icons a search shows: every word of the query must start a word of the
// icon's key, search words or category name; an empty query shows them all.
export function searchIcons({ query = "", category = "" } = {}) {
  const words = String(query || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  return ICONS.filter((icon) => {
    if (category && icon.category !== category) return false;
    if (!words.length) return true;
    const haystack = [icon.key, ...icon.key.split("-"), ...icon.words, ...icon.words.flatMap((w) => w.split(/[\s/-]+/)), categoryLabel(icon.category).toLowerCase(), ...categoryLabel(icon.category).toLowerCase().split(" ")];
    return words.every((word) => haystack.some((entry) => entry.startsWith(word)));
  });
}
