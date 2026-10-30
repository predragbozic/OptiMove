// Data configuration's tiles (PR-1; proposal sections 4 and 5): the square
// before a name that says what it is at a glance, in the coach Home's visual
// language. A domain is a filled tile, a category an outlined one, a variable
// a soft one with its own icon (the neutral dashed circle without, never an
// icon of the library), a source field a
// neutral tile with an icon for its kind of value. A club's domain or category
// takes the club colour, as Home does for club things, and shows its own icon
// when it has one (V4, J6.1), else the kind's own symbol; the tile's shape
// still says domain or category. Decoration only: the name and the badges
// beside it carry the meaning.
import { isLibraryKey, renderIconSvg } from "./icon-render.js";

const sized = (size) => (size ? ` dc-tile-${size}` : "");

export function variableTileHtml(item, { size = "" } = {}) {
  return `<span class="dc-tile dc-tile-variable${item?.icon ? "" : " is-empty"}${sized(size)}" aria-hidden="true">${renderIconSvg(item?.icon || "")}</span>`;
}

export function nodeTileHtml(kind, node, { size = "" } = {}) {
  const domain = kind === "domain";
  const club = node?.ownerScope === "club" ? " is-club" : "";
  const icon = isLibraryKey(node?.icon) ? node.icon : domain ? "stack" : "folder";
  return `<span class="dc-tile ${domain ? "dc-tile-domain" : "dc-tile-category"}${club}${sized(size)}" aria-hidden="true">${renderIconSvg(icon)}</span>`;
}

// A source field's kind of value: a zone, a count of events, or by its unit a
// distance, a time or a speed; any other number is a number.
const DISTANCE_UNITS = new Set(["m", "km"]);
const TIME_UNITS = new Set(["s", "min", "h", "ms"]);
const SPEED_UNITS = new Set(["km/h", "m/s"]);
export function fieldShapeIcon(revision) {
  if (!revision) return "number";
  if (revision.valueShape === "zone_distance" || revision.parameterKind === "zone_bounds") return "chart-bar";
  const unit = revision.sourceUnit || revision.expectedSourceUnit || "";
  if (revision.valueShape === "event_count" || revision.parameterKind === "event_threshold" || unit === "count") return "bolt";
  if (DISTANCE_UNITS.has(unit)) return "distance";
  if (TIME_UNITS.has(unit)) return "stopwatch";
  if (SPEED_UNITS.has(unit)) return "speed";
  return "number";
}
export function fieldTileHtml(revision, { size = "" } = {}) {
  return `<span class="dc-tile dc-tile-field${sized(size)}" aria-hidden="true">${renderIconSvg(fieldShapeIcon(revision))}</span>`;
}

// "Opens another screen", as on Home.
export const CHEVRON_HTML = `<svg class="dc-chevron" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6l-6 6"/></svg>`;

// Back to the start screen (layout C), from each of its screens.
export const HOME_BACK = `<button class="plain-button ghost metric-variables-back" type="button" data-action="metric-classification-view" data-view="home">← Data configuration</button>`;
