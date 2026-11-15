// P4 (owner 2026-11-13, the coach prototype): "Find new sessions" opens a calendar that chooses the period to search.
// Local only: picking days, turning a month and opening or closing the panel send nothing. The search itself is the
// existing check start (gpexe-import-data.js startGpexeCheck) with the chosen from / to.
import { state } from "./state.js";

const g = () => state.trainingLoad.gpexe;

// At most 31 days can be searched at once (the server's limit, gpexeImportService.js resolveCheckWindow).
export const PERIOD_MAX_DAYS = 31;
const DAY_MS = 86_400_000;

// The day a value belongs to on the local clock (the clock the rows show), "" when it is not a date.
export function localDay(value) {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// The day the server searches a session under: the UTC day of its start (the GPEXE wall clock, stored as UTC; the
// check's window and its withdrawal compare `(session_started_at at time zone 'UTC')::date`, gpexeImportService.js).
// The chooser marks and lists a session on this day, so the day you tap is the day the search covers (code review);
// "" when the value is not a date.
export function sessionDay(value) {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// The last day that can be searched: the later of the browser's day and the UTC day. The chips use UTC days, and the
// server takes a window up to its UTC day + 1 (resolveCheckWindow), so neither side can be refused or unreachable.
export function todayDay(now = new Date()) {
  const local = localDay(now);
  const utc = now.toISOString().slice(0, 10);
  return local > utc ? local : utc;
}

const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const dayTime = (day) => new Date(`${day}T00:00:00Z`).getTime();
const addDays = (day, n) => new Date(dayTime(day) + n * DAY_MS).toISOString().slice(0, 10);

// Days from a to b, both counted (1 for the same day).
export function daysInPeriod(a, b) {
  return Math.round(Math.abs(dayTime(b) - dayTime(a)) / DAY_MS) + 1;
}

// The chooser's local state: `open` is the phone's sheet, `anchor` the first tap of two, `from` / `to` the chosen period.
export function emptyPeriod() {
  return { open: false, month: "", anchor: "", from: "", to: "" };
}

function p(gx = g()) {
  if (!gx.period) gx.period = emptyPeriod();
  return gx.period;
}

export function periodOf(gx = g()) {
  return p(gx);
}

// The chosen period, or null while none (or only its first day) is chosen.
export function periodRange(gx = g()) {
  const s = p(gx);
  return s.from && s.to ? { from: s.from, to: s.to, days: daysInPeriod(s.from, s.to) } : null;
}

// A day that can't be picked now: in the future, or - while the first day is waiting for the second - more than 31
// days (both counted) away from it.
export function dayOff(day, gx = g(), now = new Date()) {
  if (!isDay(day)) return true;
  if (day > todayDay(now)) return true;
  const s = p(gx);
  return Boolean(s.anchor) && daysInPeriod(s.anchor, day) > PERIOD_MAX_DAYS;
}

// A tap (or Enter) on a day: the first picks one day and waits for the second; the second closes the period. A day that
// is off does nothing.
export function pickDay(day, gx = g(), now = new Date()) {
  const s = p(gx);
  if (dayOff(day, gx, now)) return false;
  if (s.anchor) {
    const [from, to] = [s.anchor, day].sort();
    Object.assign(s, { anchor: "", from, to });
  } else {
    Object.assign(s, { anchor: day, from: day, to: day });
  }
  return true;
}

// A drag across days (a pointer gesture; two taps do the same): the period runs from where the drag started to the
// day under the pointer, within 31 days.
export function dragToDay(day, gx = g(), now = new Date()) {
  const s = p(gx);
  if (!s.anchor || dayOff(day, gx, now)) return false;
  const [from, to] = [s.anchor, day].sort();
  if (from === s.from && to === s.to) return false;
  Object.assign(s, { from, to });
  return true;
}

// The drag ended: a period that covers more than its first day is chosen; a press without a move stays the first tap.
export function endDrag(gx = g()) {
  const s = p(gx);
  if (s.anchor && s.from !== s.to) s.anchor = "";
}

export function clearPeriod(gx = g()) {
  Object.assign(p(gx), { anchor: "", from: "", to: "" });
}

// The phone's sheet: open or closed (on a computer the chooser is always on the page).
export function setPeriodOpen(open, gx = g()) {
  p(gx).open = Boolean(open);
}

// P5 (code review): leaving Imports and a wider layout close both the help and the sheet; true when either was open.
export function closeImportsOverlays(gx = g()) {
  if (!gx) return false;
  const was = Boolean(gx.helpOpen) || Boolean(p(gx).open);
  gx.helpOpen = false;
  p(gx).open = false;
  return was;
}

// Escape and the phone's Back close an open sheet first (app.js), and so do leaving Imports and a layout wider than a
// phone (a turned tablet); true when there was one to close.
// P5: the help ("How importing works") is closed by the same step, so Escape, Back, leaving Imports and a wider layout
// treat it like the sheet.
export function closePeriodSheet(gx = g()) {
  if (!gx) return false;
  if (gx.helpOpen) {
    gx.helpOpen = false;
    return true;
  }
  if (!p(gx).open) return false;
  p(gx).open = false;
  return true;
}

// The month on screen: the one turned to, else the month of the chosen (or suggested) period's end, else this month.
export function periodMonth(gx = g(), now = new Date(), suggestedTo = "") {
  const s = p(gx);
  return s.month || (s.to || suggestedTo || localDay(now)).slice(0, 7);
}

export function turnMonth(delta, gx = g(), now = new Date()) {
  const [y, m] = periodMonth(gx, now).split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  p(gx).month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// "Search what's missing": from the last day the last successful search covered (that day again - a session recorded
// later that day may be new) to today, at most the latest 31 days. Null without a successful search: then the first
// button searches the server's default 14 days.
export function missingWindow(status, now = new Date()) {
  const last = status?.lastSucceededCheck?.window?.to;
  if (!isDay(last)) return null;
  const today = todayDay(now);
  let from = last > today ? today : last;
  let clipped = false;
  if (daysInPeriod(from, today) > PERIOD_MAX_DAYS) {
    from = addDays(today, -(PERIOD_MAX_DAYS - 1));
    clipped = true;
  }
  return { from, to: today, clipped };
}
