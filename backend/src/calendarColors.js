// The closed palette of the central calendar (K2b-1, D38; plan
// docs/ai/central-calendar-k2b-plan.md section 2.5). The same list is
// calendar.color_key_ok() in migration v51 and the frontend's palette; a test
// proves the three agree. The first eight are the automatic team colours.
export const CALENDAR_COLOR_KEYS = Object.freeze([
  "teal", "rust", "indigo", "plum", "green", "amber", "rose", "sky", "slate", "olive", "coral", "violet",
]);

export function isCalendarColorKey(value) {
  return typeof value === "string" && CALENDAR_COLOR_KEYS.includes(value);
}
