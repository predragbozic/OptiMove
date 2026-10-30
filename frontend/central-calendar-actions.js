import { state } from "./state.js";
import { addDaysIso, addMonthsIso, localDateIso } from "./utils.js";
import {
  CENTRAL_CALENDAR_KINDS,
  CENTRAL_CALENDAR_VIEWS,
  loadCentralCalendar,
  loadCentralCalendarDay,
  writeCentralCalendarWeekMode,
} from "./central-calendar-data.js";

// Central calendar (K1b) - every data-action="central-calendar-*" of the
// screen (docs/ai/central-calendar-k1b-plan.md). Navigation, the view and
// mode switches and the chips change the state slice and paint; a range
// change reads through central-calendar-data.js; the two drill-ins hand
// over to the shell (D5: an athlete's weekly plan on the day; D14: the
// Training Load activity). Nothing here writes to the server (D3).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return ISO_DATE.test(String(value || ""));
}

// "phone" (<= 760 px, the app's own mobile breakpoint), "medium" (761-1023
// px) or "wide" (>= 1024 px, the time grid and the side panel). Without
// matchMedia (tests) the screen is wide.
export function centralCalendarLayout() {
  const win = globalThis.window;
  if (!win || typeof win.matchMedia !== "function") return "wide";
  try {
    if (win.matchMedia("(max-width: 760px)")?.matches) return "phone";
    if (win.matchMedia("(max-width: 1023px)")?.matches) return "medium";
  } catch {
    return "wide";
  }
  return "wide";
}

function closedPanel() {
  return { open: false, key: "", date: "", athletes: null, loading: false, error: "" };
}

// A repaint replaces the whole markup (the shell sets innerHTML). These two
// keep what a repaint would otherwise drop: each chip row's sideways scroll
// on a phone (keyed by the row's label) and the focused control (by its
// action and its key, date, team or kind), the Coach Home strips' pattern.
export function captureCentralCalendarView(root) {
  if (!root?.querySelectorAll) return null;
  const scroll = {};
  for (const row of root.querySelectorAll(".cc-chip-row")) {
    const label = row.getAttribute?.("aria-label");
    if (label && row.scrollLeft) scroll[label] = row.scrollLeft;
  }
  const active = globalThis.document?.activeElement;
  const focus = active?.dataset?.action && root.contains?.(active)
    ? { action: active.dataset.action, key: active.dataset.key || "", date: active.dataset.date || "", teamId: active.dataset.teamId || "", kind: active.dataset.kind || "", view: active.dataset.view || "", mode: active.dataset.mode || "" }
    : null;
  return { scroll, focus };
}

export function restoreCentralCalendarView(root, snapshot) {
  if (!root?.querySelectorAll || !snapshot) return;
  for (const row of root.querySelectorAll(".cc-chip-row")) {
    const label = row.getAttribute?.("aria-label");
    if (label && snapshot.scroll[label]) row.scrollLeft = snapshot.scroll[label];
  }
  const focus = snapshot.focus;
  if (!focus) return;
  // The sheet's backdrop shares the close action with the Close button and
  // comes first in the markup: never the element to give the focus back to.
  const selector = [`[data-action="${cssValue(focus.action)}"]:not(.cc-sheet-backdrop)`];
  for (const [name, value] of [["key", focus.key], ["date", focus.date], ["team-id", focus.teamId], ["kind", focus.kind], ["view", focus.view], ["mode", focus.mode]]) {
    if (value) selector.push(`[data-${name}="${cssValue(value)}"]`);
  }
  root.querySelector?.(selector.join(""))?.focus?.({ preventScroll: true });
}

// A value inside a quoted attribute selector: CSS.escape where the browser
// has it, else the two characters that could end the string.
function cssValue(value) {
  const text = String(value);
  return typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(text) : text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// After a close the focus goes back to the card (or the month's compact
// card) the panel was opened from: the sheet is modal below 1024 px and the
// repaint destroyed the old element.
function focusCard(key) {
  if (!key) return;
  const value = cssValue(key);
  globalThis.document?.querySelector?.(`.cc-card[data-key="${value}"], .cc-mini[data-key="${value}"]`)?.focus?.({ preventScroll: true });
}

// Back and Escape close an open item panel first; false when there was
// nothing to close (or the calendar is not the open screen). With `render`
// the screen is drawn again and the focus returns to the card.
export function closeCentralCalendarPanel(render) {
  if (state.activeTab !== "central-calendar") return false;
  const cal = state.centralCalendar;
  if (!cal.panel.open) return false;
  const key = cal.panel.key;
  cal.panel = closedPanel();
  render?.();
  if (render) focusCard(key);
  return true;
}

function toggleValue(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  else list.push(value);
}

function movedAnchor(cal, direction) {
  if (cal.view === "month") return addMonthsIso(cal.anchor, direction);
  return addDaysIso(cal.anchor, direction * (cal.view === "week" ? 7 : 1));
}

// The weekly plan's own route reads plans by the roster row's business id
// (`athlete_id` / the source external id, routes/athletes.js), never by the
// UUID the calendar API names athletes with. The rail's roster
// (state.athletes) maps one to the other; an athlete not in it (left the
// team, archived, a dual member of another club) has no weekly-plan
// drill-in here (null) - the row is shown without a button.
export function centralCalendarRosterAthleteId(athleteUuid) {
  const row = (state.athletes || []).find((athlete) => String(athlete?.athlete_uuid || "") === String(athleteUuid));
  return row?.athlete_id || null;
}

// The view's lookup: every UUID of the roster that has a weekly-plan id.
export function centralCalendarRosterIndex() {
  const index = new Map();
  for (const athlete of state.athletes || []) {
    if (athlete?.athlete_uuid && athlete?.athlete_id) index.set(String(athlete.athlete_uuid), String(athlete.athlete_id));
  }
  return index;
}

export async function handleCentralCalendarAction(action, { render, openWeeklyPlanForAthleteOnDate, openTrainingLoad } = {}) {
  const type = action?.dataset?.action || "";
  if (!type.startsWith("central-calendar-")) return false;
  const cal = state.centralCalendar;
  const today = localDateIso();
  if (!cal.anchor) cal.anchor = today;

  if (type === "central-calendar-prev" || type === "central-calendar-next") {
    cal.anchor = movedAnchor(cal, type === "central-calendar-prev" ? -1 : 1);
    cal.selectedDate = cal.anchor;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-today") {
    cal.anchor = today;
    cal.selectedDate = today;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-view") {
    const view = action.dataset.view;
    if (!CENTRAL_CALENDAR_VIEWS.includes(view) || view === cal.view) return true;
    // Day shows the day a phone's strip or the month grid pointed at.
    if (view === "day" && isIsoDate(cal.selectedDate)) cal.anchor = cal.selectedDate;
    cal.view = view;
    if (!isIsoDate(cal.selectedDate)) cal.selectedDate = cal.anchor;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-mode") {
    const mode = action.dataset.mode === "grid" ? "grid" : "list";
    cal.weekMode = mode;
    writeCentralCalendarWeekMode(mode);
    render?.();
    return true;
  }
  if (type === "central-calendar-select-day") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    cal.selectedDate = date;
    cal.panel = closedPanel();
    render?.();
    // A phone's month: the chosen day's list sits under the grid, near or
    // below the fold - bring its title to the top so the tap visibly did
    // something and the day's cards follow it.
    if (cal.view === "month") globalThis.document?.querySelector?.(".cc-day-title")?.scrollIntoView?.({ block: "start" });
    return true;
  }
  if (type === "central-calendar-open-day") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    cal.view = "day";
    cal.anchor = date;
    cal.selectedDate = date;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-open-item") {
    const key = action.dataset.key || "";
    const date = action.dataset.date;
    if (!key || !isIsoDate(date)) return true;
    // The open item again folds the panel.
    if (cal.panel.open && cal.panel.key === key) {
      cal.panel = closedPanel();
      render?.();
      return true;
    }
    cal.panel = { open: true, key, date, athletes: null, loading: true, error: "" };
    render?.();
    // The sheet is modal below 1024 px: the focus moves to its Close.
    globalThis.document?.querySelector?.(".cc-sheet .cc-panel-close")?.focus?.();
    await loadCentralCalendarDay({ render });
    return true;
  }
  if (type === "central-calendar-close-panel") {
    const key = cal.panel.key;
    cal.panel = closedPanel();
    render?.();
    focusCard(key);
    return true;
  }
  if (type === "central-calendar-toggle-team") {
    const teamId = action.dataset.teamId || "";
    if (teamId) toggleValue(cal.filters.teamIds, teamId);
    render?.();
    return true;
  }
  if (type === "central-calendar-toggle-kind") {
    const kind = action.dataset.kind || "";
    if (CENTRAL_CALENDAR_KINDS.includes(kind)) toggleValue(cal.filters.kinds, kind);
    render?.();
    return true;
  }
  if (type === "central-calendar-clear-filters") {
    cal.filters = { teamIds: [], kinds: [] };
    render?.();
    return true;
  }
  if (type === "central-calendar-retry") {
    await loadCentralCalendar({ render, forceRefresh: true });
    return true;
  }
  if (type === "central-calendar-retry-athletes") {
    await loadCentralCalendarDay({ render, forceRefresh: true });
    return true;
  }
  if (type === "central-calendar-open-training-load") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    await openTrainingLoad?.({ activityId: action.dataset.activityId || null, date });
    return true;
  }
  if (type === "central-calendar-open-athlete") {
    const athleteUuid = action.dataset.athleteId || "";
    const date = action.dataset.date;
    if (!athleteUuid || !isIsoDate(date)) return true;
    const rosterAthleteId = centralCalendarRosterAthleteId(athleteUuid);
    if (!rosterAthleteId) return true;
    await openWeeklyPlanForAthleteOnDate?.(rosterAthleteId, date);
    return true;
  }
  return false;
}
