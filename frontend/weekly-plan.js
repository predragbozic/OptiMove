import {
  addDaysIso,
  addMonthsIso,
  dateValue,
  endOfWeekIso,
  localDateIso,
  monthLabel,
  monthStartIso,
  startOfWeekIso,
} from "./utils.js";

export function allSlotItems(slots) {
  const result = [];
  ["AM", "PM"].forEach((amPm) => {
    ["B", "T", "A"].forEach((bta) => {
      result.push(...(slots?.[amPm]?.[bta] || []));
    });
  });
  return result;
}

export function groupItems(group) {
  return allSlotItems(group.slots || {});
}

export function flattenDayGroups(dayGroups = []) {
  return dayGroups.flatMap((group) => groupItems(group));
}

export function weekTotal(week) {
  return (week.days || []).reduce((sum, day) => sum + allSlotItems(day.slots).length, 0);
}

export function weekContainsDate(week, date) {
  return (week.days || []).some((day) => day.date === date);
}

export function weekIndexForDate(weeks, date) {
  if (!date) return -1;
  return weeks.findIndex((week) => weekContainsDate(week, date));
}

export function buildWeeklyCalendarMonths(weeks) {
  const dayMap = weeklyCalendarDayMap(weeks);
  const months = weeklyCalendarMonthRange(weeks);
  return months.map((month) => buildWeeklyCalendarMonth(month, dayMap));
}

export function weeklyCalendarDayMap(weeks) {
  const dayMap = new Map();
  weeks.forEach((week, weekIndex) => {
    (week.days || []).forEach((day) => {
      const itemCount = allSlotItems(day.slots).length;
      dayMap.set(day.date, {
        weekIndex,
        itemCount,
        hasItems: itemCount > 0,
      });
    });
  });
  return dayMap;
}

export function weeklyCalendarMonthRange(weeks) {
  const dayMap = weeklyCalendarDayMap(weeks);
  const datesWithItems = [...dayMap.entries()]
    .filter(([, meta]) => meta.hasItems)
    .map(([date]) => date)
    .sort();
  if (!datesWithItems.length) return [];

  const firstMonth = monthStartIso(datesWithItems[0]);
  const lastMonth = monthStartIso(datesWithItems[datesWithItems.length - 1]);
  const months = [];
  let cursor = firstMonth;
  while (cursor <= lastMonth) {
    months.push(cursor);
    cursor = addMonthsIso(cursor, 1);
  }
  return months;
}

export function clampMonth(month, firstMonth, lastMonth) {
  const value = monthStartIso(month || firstMonth);
  if (value < firstMonth) return firstMonth;
  if (value > lastMonth) return lastMonth;
  return value;
}

export function buildWeeklyCalendarMonth(monthStart, dayMap) {
  const monthEnd = addDaysIso(addMonthsIso(monthStart, 1), -1);
  const gridStart = startOfWeekIso(monthStart);
  const gridEnd = endOfWeekIso(monthEnd);
  const days = [];
  let cursor = gridStart;
  while (cursor <= gridEnd) {
    const meta = dayMap.get(cursor) || {};
    days.push({
      date: cursor,
      dayNumber: Number(cursor.slice(8, 10)),
      isOutside: cursor.slice(0, 7) !== monthStart.slice(0, 7),
      itemCount: meta.itemCount || 0,
      hasItems: Boolean(meta.hasItems),
      weekIndex: meta.weekIndex,
    });
    cursor = addDaysIso(cursor, 1);
  }
  return {
    label: monthLabel(monthStart),
    days,
  };
}

export function selectedWeeklyDay(week, selectedWeekDay) {
  if (selectedWeekDay && weekContainsDate(week, selectedWeekDay)) return selectedWeekDay;
  const today = localDateIso();
  return weekContainsDate(week, today) ? today : week.weekStart;
}

export function defaultWeekIndex(weeks) {
  if (!weeks.length) return 0;
  return weeks.length - 1;
}

export function todayWeekIndex(weeks) {
  if (!weeks.length) return 0;
  const today = localDateIso();
  const exactIndex = weeks.findIndex((week) => weekContainsDate(week, today));
  if (exactIndex >= 0) return exactIndex;

  let closestIndex = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  weeks.forEach((week, index) => {
    const distance = Math.abs(dateValue(week.weekStart) - dateValue(today));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  });
  return closestIndex;
}
