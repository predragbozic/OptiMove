// K5-5 (docs/ai/central-calendar-k5-plan.md, K5-5): "Open in calendar" - the way back to the central calendar from a
// module's own calendar (Tests' week, the Training Load calendar, Coach Home's day). One button for all three; app.js
// handles its action (openCentralCalendarOnDay). The central calendar is a coach's screen: the three places are coach
// screens (the athlete's Tests and Training Load take other paths), and the opener itself refuses athlete mode.
import { renderIconSvg } from "./icon-render.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateAtNoon(iso) {
  return new Date(`${iso}T12:00:00`);
}

// "Sun 22 Nov" and "Sunday 22 November 2026".
export function openInCalendarDayWords(iso) {
  const day = dateAtNoon(iso);
  return {
    short: new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(day),
    long: new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(day),
  };
}

// `view`: "week" (the week with that day selected) or "day" (its Day view). A Day-view link names its day on screen
// ("Open Sun 22 Nov in calendar", the UX review); both name the date to a screen reader. "" without a usable date.
export function renderOpenInCalendarHtml(date, { view = "week", quiet = false } = {}) {
  if (!ISO_DATE.test(String(date || ""))) return "";
  const day = view === "day";
  const words = openInCalendarDayWords(date);
  const label = day ? `Open ${words.short} in calendar` : "Open in calendar";
  const aria = day ? `Open ${words.long} in calendar` : `Open the week of ${words.long} in calendar`;
  const classes = ["plain-button", "open-in-calendar", quiet ? "is-quiet" : "compact-button"].join(" ");
  return `<button type="button" class="${classes}" data-action="open-in-central-calendar" data-date="${escapeAttr(date)}" data-view="${day ? "day" : "week"}" aria-label="${escapeAttr(aria)}">${renderIconSvg("calendar-event", { size: 16, className: "open-in-calendar-icon" })}<span>${escapeHtml(label)}</span></button>`;
}
