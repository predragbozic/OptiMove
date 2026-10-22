import { state } from "./state.js";
import { addDaysIso, addMonthsIso, localDateIso } from "./utils.js";
import {
  renderCoachHomeDayHtml,
  renderCoachHomeExerciseItemsHtml,
  renderCoachHomeExerciseMoreHtml,
  renderCoachHomeExercisesHtml,
  renderCoachHomeProgramsHtml,
} from "./coach-home.js";
import {
  coachHomeCursorDate,
  coachHomeGridRange,
  coachHomeSelectedDate,
  loadCoachHomeDay,
  loadCoachHomeExercises,
  loadCoachHomePrograms,
  loadCoachHomeTrainingDays,
  loadMoreCoachHomeExercises,
} from "./coach-home-data.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TRACKS = new Set(["plan", "load", "day", "exercises", "programs"]);

// A control is found again after a card is drawn anew by the data
// attributes that name it, so a click on the calendar or an arrow keeps the
// keyboard where it was.
const FOCUS_KEYS = ["action", "date", "step", "direction", "track", "library", "exerciseId", "templateId", "athleteId", "mode"];

function focusSignature(element) {
  if (!element?.dataset?.action) return null;
  return Object.fromEntries(FOCUS_KEYS.map((key) => [key, element.dataset[key] || ""]));
}

function findBySignature(root, signature) {
  if (!signature) return null;
  return [...root.querySelectorAll("[data-action]")].find((element) => FOCUS_KEYS.every((key) => (element.dataset[key] || "") === signature[key])) || null;
}

// What a redraw would lose: each strip's scroll position (with what it held,
// renderCarousel's trackKey) and the focused control (only when the focus is
// inside `root`).
export function captureCoachHomeView(root) {
  const scroll = {};
  root?.querySelectorAll?.("[data-coach-home-track]").forEach((track) => {
    scroll[track.dataset.coachHomeTrack] = { left: track.scrollLeft, key: track.dataset.coachHomeTrackKey || "" };
  });
  const active = root?.ownerDocument?.activeElement;
  const hadFocus = Boolean(active && active !== root && root.contains(active));
  return { scroll, hadFocus, focus: hadFocus ? focusSignature(active) : null };
}

export function restoreCoachHomeView(root, snapshot, { fallbackFocus = "" } = {}) {
  if (!root || !snapshot) return;
  root.querySelectorAll("[data-coach-home-track]").forEach((track) => {
    const kept = snapshot.scroll[track.dataset.coachHomeTrack];
    if (kept?.left && kept.key === (track.dataset.coachHomeTrackKey || "")) track.scrollLeft = kept.left;
  });
  if (!snapshot.hadFocus) return;
  const target = findBySignature(root, snapshot.focus) || (fallbackFocus ? root.querySelector(fallbackFocus) : null);
  target?.focus({ preventScroll: true });
}

// The arrows follow the strip: off at either end (aria-disabled, so a
// focused arrow keeps the focus), both hidden when every card fits.
export function syncCoachHomeCarousel(carousel) {
  const track = carousel?.querySelector("[data-coach-home-track]");
  if (!track) return;
  const max = track.scrollWidth - track.clientWidth;
  const [previous, next] = carousel.querySelectorAll('[data-action="coach-home-scroll"]');
  previous?.setAttribute("aria-disabled", track.scrollLeft <= 1 ? "true" : "false");
  next?.setAttribute("aria-disabled", track.scrollLeft >= max - 1 ? "true" : "false");
  carousel.classList.toggle("is-static", max <= 1);
}

// Within one screen of the strip's end: time to fetch the next page.
function nearEnd(track) {
  return track.scrollLeft + track.clientWidth >= track.scrollWidth - track.clientWidth;
}

export function bindCoachHomeCarousels(root, { onNearEnd } = {}) {
  root?.querySelectorAll?.("[data-coach-home-carousel]").forEach((carousel) => {
    const track = carousel.querySelector("[data-coach-home-track]");
    if (!track) return;
    syncCoachHomeCarousel(carousel);
    if (nearEnd(track)) onNearEnd?.(track.dataset.coachHomeTrack);
    if (track.dataset.coachHomeBound) return;
    track.dataset.coachHomeBound = "true";
    const view = track.ownerDocument.defaultView;
    let frame = 0;
    track.addEventListener("scroll", () => {
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        syncCoachHomeCarousel(carousel);
        if (nearEnd(track)) onNearEnd?.(track.dataset.coachHomeTrack);
      });
    }, { passive: true });
    // A wider or narrower window changes how many cards fit.
    if (view.ResizeObserver) new view.ResizeObserver(() => syncCoachHomeCarousel(carousel)).observe(track);
  });
}

function scrollCoachHomeTrack(root, name, direction) {
  if (!TRACKS.has(name)) return;
  const track = root?.querySelector(`[data-coach-home-track="${name}"]`);
  if (!track) return;
  const reduce = track.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  const left = direction * track.clientWidth;
  if (typeof track.scrollBy === "function") track.scrollBy({ left, behavior: reduce ? "auto" : "smooth" });
  else track.scrollLeft += left;
}

// The markup each card was last drawn from: the same answer again (a cached
// read, then the same from the network) leaves the card - and a tap or a
// swipe already on it - alone.
const drawnSections = new WeakMap();

function replaceSection(root, name, html, { onNearEnd, fallbackFocus = "" } = {}) {
  const current = root?.querySelector?.(`[data-coach-home-section="${name}"]`);
  if (!current) return false;
  const markup = html.trim();
  if (drawnSections.get(current) === markup) return true;
  const snapshot = captureCoachHomeView(current);
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = markup;
  const next = template.content.firstElementChild;
  drawnSections.set(next, markup);
  current.replaceWith(next);
  restoreCoachHomeView(next, snapshot, { fallbackFocus });
  bindCoachHomeCarousels(next, { onNearEnd });
  return true;
}

// Draws one card of Home again from state.coachHome, in place: "day" (the
// calendar and its list), "exercises", "programs", or "exercises-more" (a
// further page appended to the exercise strip without redrawing it).
export function renderCoachHomeSection(root, section, { rows = [], appended = [], onNearEnd } = {}) {
  if (section === "day") {
    return replaceSection(root, "day", renderCoachHomeDayHtml({ rows, home: state.coachHome }), { fallbackFocus: ".coach-home-cal-day.is-selected" });
  }
  if (section === "programs") return replaceSection(root, "programs", renderCoachHomeProgramsHtml(state.coachHome.programs), { onNearEnd });
  if (section === "exercises-more") {
    const track = root?.querySelector?.('[data-coach-home-track="exercises"]');
    if (!track) return renderCoachHomeSection(root, "exercises", { rows, onNearEnd });
    // "Load more exercises" had the focus: it goes on to the first new
    // exercise (or the button again after another failure), across the
    // "Loading more..." line in between.
    // The card no longer matches the markup it was drawn from: its next
    // redraw must happen, whatever the markup.
    drawnSections.delete(track.closest('[data-coach-home-section="exercises"]'));
    const status = track.querySelector("[data-coach-home-more]");
    if (status?.contains(root.ownerDocument.activeElement)) track.dataset.coachHomeRefocus = "true";
    status?.remove();
    const firstNew = track.children.length;
    track.insertAdjacentHTML("beforeend", `${renderCoachHomeExerciseItemsHtml(appended)}${renderCoachHomeExerciseMoreHtml(state.coachHome.exercises)}`);
    const refocus = track.dataset.coachHomeRefocus ? track.children[firstNew]?.querySelector("button") : null;
    if (refocus) {
      delete track.dataset.coachHomeRefocus;
      refocus.focus({ preventScroll: true });
    }
    syncCoachHomeCarousel(track.closest("[data-coach-home-carousel]"));
    return true;
  }
  if (section === "exercises") return replaceSection(root, "exercises", renderCoachHomeExercisesHtml(state.coachHome.exercises), { onNearEnd });
  return false;
}

// A day chosen from the month view on a phone folds it back to that day's
// week, so the day's athletes come right under it (a computer always shows
// the month and ignores the flag).
function selectCoachHomeDay(date, { onChange }) {
  const today = localDateIso();
  const before = coachHomeGridRange(today);
  const value = date === today ? "" : date;
  state.coachHome.calendar = { selected: value, cursor: value, expanded: false };
  onChange?.("day");
  if (date !== today) void loadCoachHomeDay(date, { onChange });
  if (coachHomeGridRange(today).from !== before.from) void loadCoachHomeTrainingDays({ onChange });
}

function stepCoachHomeCalendar(unit, direction, { onChange }) {
  const base = coachHomeCursorDate();
  const cursor = unit === "week" ? addDaysIso(base, 7 * direction) : addMonthsIso(base, direction);
  state.coachHome.calendar = { ...state.coachHome.calendar, cursor };
  onChange?.("day");
  void loadCoachHomeTrainingDays({ onChange });
}

// Back to one week (phones): the chosen day's week when that day is in the
// month on screen, else the week the month view was anchored on.
function toggleCoachHomeCalendar({ onChange }) {
  const calendar = state.coachHome.calendar;
  const expanded = !calendar.expanded;
  let cursor = calendar.cursor;
  if (!expanded && coachHomeSelectedDate().slice(0, 7) === coachHomeCursorDate().slice(0, 7)) cursor = calendar.selected;
  state.coachHome.calendar = { ...calendar, expanded, cursor };
  onChange?.("day");
}

// Home's own controls (the arrows, the calendar, the retries). Opening an
// athlete, a library, an exercise or a program leaves Home and stays in
// app.js with the rest of the navigation. Returns true when handled.
export function handleCoachHomeAction(action, { root, onChange } = {}) {
  const type = action?.dataset?.action;
  if (type === "coach-home-scroll") {
    if (action.getAttribute("aria-disabled") !== "true") scrollCoachHomeTrack(root, action.dataset.track, Number(action.dataset.direction) < 0 ? -1 : 1);
    return true;
  }
  if (type === "coach-home-day-select") {
    if (ISO_DATE.test(action.dataset.date || "")) selectCoachHomeDay(action.dataset.date, { onChange });
    return true;
  }
  if (type === "coach-home-day-today") {
    selectCoachHomeDay(localDateIso(), { onChange });
    return true;
  }
  if (type === "coach-home-calendar-step") {
    stepCoachHomeCalendar(action.dataset.step === "week" ? "week" : "month", Number(action.dataset.direction) < 0 ? -1 : 1, { onChange });
    return true;
  }
  if (type === "coach-home-calendar-toggle") {
    toggleCoachHomeCalendar({ onChange });
    return true;
  }
  if (type === "coach-home-days-retry") {
    void loadCoachHomeTrainingDays({ onChange, forceRefresh: true });
    return true;
  }
  if (type === "coach-home-day-retry") {
    void loadCoachHomeDay(coachHomeSelectedDate(), { onChange, forceRefresh: true });
    return true;
  }
  if (type === "coach-home-library-retry") {
    if (action.dataset.library === "programs") void loadCoachHomePrograms({ onChange, forceRefresh: true });
    else void loadCoachHomeExercises({ onChange, forceRefresh: true });
    return true;
  }
  if (type === "coach-home-exercises-more") {
    void loadMoreCoachHomeExercises({ onChange });
    return true;
  }
  return false;
}
