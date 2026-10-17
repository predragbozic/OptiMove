import { imageSources, videoThumbnailSources } from "./media.js";
import { escapeAttr, escapeHtml, initialsFor } from "./utils.js";

// How exercises are laid out in the Exercise Library and in the Builder's
// section editor. "details" is the full library card (the original layout,
// with aim, notes, tags and every action), offered only in the library.
// The coach's choice is a per-browser convenience: kept in localStorage,
// read once when the state is created, and the screen still works when
// storage is unavailable (private window, blocked site data).
export const EXERCISE_VIEW_MODES = {
  library: ["tile", "big", "list", "details"],
  builder: ["tile", "big", "list"],
};

const DEFAULT_VIEW = { library: "details", builder: "list" };
const STORAGE_KEY = { library: "optimove.exerciseView.library", builder: "optimove.exerciseView.builder" };
const VIEW_LABELS = { tile: "Tile", big: "Big", list: "List", details: "Details" };

const VIEW_ICONS = {
  tile: `<rect x="3" y="4" width="7" height="6" rx="1"></rect><path d="M13 6h8M13 9h5"></path><rect x="3" y="14" width="7" height="6" rx="1"></rect><path d="M13 16h8M13 19h5"></path>`,
  big: `<rect x="3" y="3" width="18" height="12" rx="1.5"></rect><path d="M3 19h12"></path>`,
  list: `<rect x="3" y="4.5" width="4" height="3" rx=".6"></rect><path d="M10 6h11"></path><rect x="3" y="10.5" width="4" height="3" rx=".6"></rect><path d="M10 12h11"></path><rect x="3" y="16.5" width="4" height="3" rx=".6"></rect><path d="M10 18h11"></path>`,
  details: `<rect x="3" y="3" width="18" height="18" rx="2"></rect><rect x="6" y="6" width="12" height="6" rx="1"></rect><path d="M6 15h12M6 18h8"></path>`,
};

export function normalizeExerciseView(surface, view) {
  return EXERCISE_VIEW_MODES[surface]?.includes(view) ? view : DEFAULT_VIEW[surface];
}

export function readExerciseViewPreference(surface) {
  try {
    return normalizeExerciseView(surface, globalThis.localStorage?.getItem(STORAGE_KEY[surface]));
  } catch {
    return DEFAULT_VIEW[surface];
  }
}

export function saveExerciseViewPreference(surface, view) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY[surface], normalizeExerciseView(surface, view));
  } catch {
    // Storage unavailable: the choice holds for this page only.
  }
}

export function renderExerciseViewSwitcher(surface, current, action) {
  const active = normalizeExerciseView(surface, current);
  return `
    <div class="exercise-view-switcher" role="group" aria-label="Exercise view">
      ${EXERCISE_VIEW_MODES[surface].map((view) => `
        <button type="button" class="exercise-view-button ${view === active ? "is-active" : ""}" data-action="${escapeAttr(action)}" data-view="${escapeAttr(view)}" aria-pressed="${view === active ? "true" : "false"}" aria-label="${escapeAttr(VIEW_LABELS[view])} view" title="${escapeAttr(VIEW_LABELS[view])}">
          <svg viewBox="0 0 24 24" class="exercise-view-icon-svg" aria-hidden="true">${VIEW_ICONS[view]}</svg><span>${escapeHtml(VIEW_LABELS[view])}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function imageAttributes(sources) {
  const fallbacks = sources.slice(1);
  return `src="${escapeAttr(sources[0])}" alt="" loading="lazy" decoding="async"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}`;
}

// A blurred copy of a picture that fills its frame behind it, so a picture
// shown whole (Big, Details) never sits in empty bars. Decorative: it walks
// the same sources as the picture and, when none loads, is hidden by the
// app's image error handler (image-missing).
export function renderExerciseThumbBackdrop(sources) {
  return sources.length ? `<img class="exercise-thumb-backdrop" ${imageAttributes(sources)} aria-hidden="true">` : "";
}

// The picture of an exercise: its own image first, then the cover image of
// its video (YouTube, Google Drive), and when none of them loads (no media,
// a private Drive file, a broken link) its initials - never an empty frame.
// The browser walks data-fallbacks on each load error (handleImageError in
// app.js) and finally swaps in the initials from data-fallback-initials.
// `backdrop`: a picture across a card - larger video covers, shown whole
// over its blurred copy.
export function renderExerciseThumb(exercise, className, { backdrop = false } = {}) {
  const name = exercise.name || exercise.title || "Exercise";
  const initials = initialsFor(name).toUpperCase() || "?";
  const sources = [
    ...imageSources(exercise.image_url || exercise.imageUrl || exercise.image || ""),
    ...videoThumbnailSources(exercise.video_url || exercise.videoUrl || exercise.video || "", { large: backdrop }),
  ];
  if (!sources.length) return `<span class="${escapeAttr(className)} exercise-thumb-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
  return `${backdrop ? renderExerciseThumbBackdrop(sources) : ""}<img class="${escapeAttr(className)}" ${imageAttributes(sources)} data-fallback-initials="${escapeAttr(initials)}">`;
}

// Called by the app's image error handler once an exercise picture has no
// source left: swaps the <img> for the exercise's initials, in the same
// size (same class), and drops its blurred copy. Returns false for any
// other image.
export function replaceExerciseThumbWithInitials(image) {
  if (image?.dataset?.fallbackInitials === undefined) return false;
  const fallback = image.ownerDocument.createElement("span");
  fallback.className = `${image.className} exercise-thumb-fallback`;
  fallback.setAttribute("aria-hidden", "true");
  fallback.textContent = image.dataset.fallbackInitials || "?";
  if (image.previousElementSibling?.classList.contains("exercise-thumb-backdrop")) image.previousElementSibling.remove();
  image.replaceWith(fallback);
  return true;
}

// Closes every open "⋯" menu of an exercise card except the one whose own
// button was just pressed - a click anywhere else (or on one of its items)
// folds it, so at most one menu is ever open.
export function closeExerciseViewMenus(target, root = globalThis.document) {
  const own = target?.closest?.(".exercise-view-menu > summary")?.parentElement || null;
  root?.querySelectorAll?.(".exercise-view-menu[open]").forEach((menu) => {
    if (menu !== own) menu.removeAttribute("open");
  });
}
