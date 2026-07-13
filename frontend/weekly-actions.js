import { state } from "./state.js";
import { addMonthsIso, localDateIso, monthStartIso } from "./utils.js";
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
    state.weekCalendarMonth = monthStartIso(today);
    state.selectedWeekDay = today;
    state.pendingScrollDate = today;
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-select") {
    state.selectedWeekIndex = Number(action.dataset.weekIndex) || 0;
    state.selectedWeekDay = "";
    state.navStack = [];
    renderWeeklyRoot(state.lastWeeklyData);
    return true;
  }
  if (type === "week-day-select") {
    const date = action.dataset.date || "";
    const weeks = state.lastWeeklyData?.weeks || [];
    const weekIndex = weekIndexForDate(weeks, date);
    if (weekIndex < 0) return true;
    state.selectedWeekIndex = weekIndex;
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
