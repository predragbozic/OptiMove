import { state } from "./state.js";
import { addMonthsIso, localDateIso, monthStartIso, weekMondayIso } from "./utils.js";
import { todayWeekIndex, weekIndexForDate } from "./weekly-plan.js";

export function handleWeeklyAction(action, { moveWeek, renderWeeklyRoot }) {
  const type = action.dataset.action;
  if (type === "week-prev" || type === "week-next") {
    moveWeek(type === "week-prev" ? -1 : 1);
    return true;
  }
  if (type === "week-toggle") {
    state.weekSelectorOpen = !state.weekSelectorOpen;
    if (state.weekSelectorOpen) {
      const weeks = state.lastWeeklyData?.weeks || [];
      const activeWeek = weeks[Math.max(0, Math.min(weeks.length - 1, state.selectedWeekIndex))] || weeks[0];
      state.weekCalendarMonth = monthStartIso(activeWeek?.weekStart || localDateIso());
    }
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-calendar-close") {
    state.weekSelectorOpen = false;
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-calendar-prev" || type === "week-calendar-next") {
    state.weekCalendarMonth = addMonthsIso(state.weekCalendarMonth || localDateIso(), type === "week-calendar-prev" ? -1 : 1);
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-today") {
    const today = localDateIso();
    const weeks = state.lastWeeklyData?.weeks || [];
    state.selectedWeekIndex = todayWeekIndex(weeks);
    state.viewedWeekStart = weekMondayIso(today);
    state.weekCalendarMonth = monthStartIso(today);
    state.selectedWeekDay = today;
    state.pendingScrollDate = today;
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-select") {
    state.selectedWeekIndex = Number(action.dataset.weekIndex) || 0;
    state.viewedWeekStart = (state.lastWeeklyData?.weeks || [])[state.selectedWeekIndex]?.weekStart || "";
    state.selectedWeekDay = "";
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-day-select") {
    const date = action.dataset.date || "";
    if (!date) return true;
    const weeks = state.lastWeeklyData?.weeks || [];
    const weekIndex = weekIndexForDate(weeks, date);
    // A tapped day may fall in a week with no plan at all yet (never loaded
    // into `weeks`), so derive the target week directly from the date --
    // same pattern "week-today" already relies on -- instead of bailing out
    // when the lookup comes back empty.
    state.selectedWeekIndex = weekIndex >= 0 ? weekIndex : 0;
    state.viewedWeekStart = weekMondayIso(date);
    state.selectedWeekDay = date;
    state.pendingScrollDate = date;
    state.weekSelectorOpen = false;
    state.weekCalendarMonth = monthStartIso(date);
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  return false;
}
