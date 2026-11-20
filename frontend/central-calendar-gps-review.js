// Central calendar K5-4 (docs/ai/central-calendar-k5-4-contract.md): the day marks "N GPS sessions to review".
//
// The calendar only reads, and leads to Imports; it writes nothing into Imports and duplicates none of its rules. The
// one read is the mapping stream's Imports calendar, GET /api/training-load/gpexe/teams/:teamId/calendar?from&to: per
// UTC day the counts of the server's own state rule (gpexeImportState.js) - numbers and state words only, never a name,
// an id or a value.
// - Only in a team workspace, for that team (contract 1.2); nowhere else, and never for an athlete.
// - One read per team per shown range, cached in memory until the workspace, the user or the calendar's refresh drops
//   it; never polled; a late answer of a dropped range is not drawn.
// - Every refusal (the route's identical 404), error or odd answer is silent: no mark and no message.
// A UI economy only: the route decides access again on every read.
import { api } from "./api.js";
import { todayDay } from "./gpexe-period-data.js";
import { state } from "./state.js";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const cache = new Map();
let generation = 0;

// Drops every mark read: a workspace change, the calendar's refresh (realtime or manual), a sign-out.
export function clearGpsReview() {
  cache.clear();
  generation += 1;
}

// The read's context from the calendar's own answer: its workspace and its days (a month's grid, or the week a week or
// a day view reads). Null where the calendar never asks.
function contextOf(cal) {
  const workspace = cal?.data?.workspace;
  if (workspace?.type !== "team" || !workspace.scopeId) return null;
  const from = String(cal.data.from || "");
  const to = String(cal.data.to || "");
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return null;
  const teamId = String(workspace.scopeId);
  const userId = String(state.currentUser?.id || "");
  return { teamId, from, to, key: `${userId}|team:${teamId}|${from}..${to}` };
}

// The answer, kept only as what the marks need: per day the waiting count (needs + ready). Anything that is not the
// route's shape is no answer at all (silent).
function readAnswer(body, ctx) {
  if (!body || typeof body !== "object" || !Array.isArray(body.days)) return null;
  const days = new Map();
  let lastDay = "";
  for (const day of body.days) {
    if (!day || !ISO_DAY.test(String(day.day || "")) || !day.counts || typeof day.counts !== "object") return null;
    // Only the two words the mark counts; any other key or word is ignored (contract R3).
    const waiting = ["needs", "ready"].reduce((n, word) => n + (Number.isInteger(day.counts[word]) && day.counts[word] > 0 ? day.counts[word] : 0), 0);
    days.set(day.day, waiting);
    if (day.day > lastDay) lastDay = day.day;
  }
  return { days, lastDay, truncated: body.truncated === true, from: ctx.from, to: ctx.to };
}

// After each calendar answer: one read for the shown range, unless it is already read or in flight.
export function ensureGpsReview(cal, render) {
  const ctx = contextOf(cal);
  if (!ctx) return null;
  const known = cache.get(ctx.key);
  if (known) return known.promise || null;
  const entry = { status: "loading", answer: null, promise: null };
  cache.set(ctx.key, entry);
  const asked = generation;
  const path = `/api/training-load/gpexe/teams/${encodeURIComponent(ctx.teamId)}/calendar?from=${ctx.from}&to=${ctx.to}`;
  entry.promise = api(path).then((body) => readAnswer(body, ctx), () => null).then((answer) => {
    entry.promise = null;
    entry.answer = answer;
    entry.status = answer ? "ok" : "none";
    // A dropped range (another workspace, a refresh) is never drawn.
    if (asked !== generation || cache.get(ctx.key) !== entry) return;
    // Only an answer with something to show repaints the calendar: a refusal, an error or a range with nothing waiting
    // leaves the screen exactly as it is (no repaint under the coach's pointer for nothing).
    const somethingToShow = Boolean(answer) && (answer.truncated || [...answer.days.values()].some((n) => n > 0));
    if (somethingToShow && state.centralCalendar === cal) render?.();
  });
  return entry.promise;
}

// The mark of one shown day: null (none), { count, plus } or { uncertain: true } (contract 1.4).
// - A day is exact when the answer was not cut, or the day comes before the cut answer's last day.
// - The cut answer's last day may be split: "N+", or the uncertain mark at 0.
// - A shown day after the cut answer's last day, up to today, is uncertain; a future day never is.
export function gpsReviewMark(cal, date, now = new Date()) {
  const ctx = contextOf(cal);
  if (!ctx || !ISO_DAY.test(String(date || ""))) return null;
  const answer = cache.get(ctx.key)?.answer;
  if (!answer || date < answer.from || date > answer.to) return null;
  const n = answer.days.get(date);
  if (!answer.truncated) return n > 0 ? { count: n, plus: false } : null;
  if (n !== undefined && date < answer.lastDay) return n > 0 ? { count: n, plus: false } : null;
  if (n !== undefined && date === answer.lastDay) return n > 0 ? { count: n, plus: true } : { uncertain: true };
  if (answer.lastDay && date < answer.lastDay) return null;
  if (date > todayDay(now)) return null;
  return { uncertain: true };
}

// The marks belong to "GPS imports": shown with no kind chosen, or with GPS imports chosen (K5-2); never under another
// kind or an event type, and never when the groups chosen leave the workspace's team out.
export function gpsReviewMarksShown(cal) {
  const ctx = contextOf(cal);
  if (!ctx) return false;
  const kinds = cal.filters?.kinds || [];
  const eventKinds = cal.filters?.eventKinds || [];
  const teamIds = cal.filters?.teamIds || [];
  if (eventKinds.length) return false;
  if (kinds.length && !kinds.includes("gps")) return false;
  if (teamIds.length && !teamIds.includes(ctx.teamId)) return false;
  return true;
}

// Back to calendar on Imports (contract 3.2, the K4a pattern): shown only on the very history step the mark's click
// pushed - the step's own entry, claimed by the first push after the click - so another step at the same depth never
// shows it.
let returnMarker = null;
export function setImportsReturn({ day }) {
  returnMarker = ISO_DAY.test(String(day || "")) ? { day, entry: null, notChosen: false } : null;
}
export function claimImportsReturn(entry) {
  if (returnMarker && !returnMarker.entry && entry) returnMarker.entry = entry;
}
// The entry's outcome (central-calendar-imports-entry.js): "as-is" means Imports opened without the day chosen (busy,
// or a day the chooser refused), and the band says so in the calendar's own words.
export function setImportsReturnOutcome(outcome) {
  if (returnMarker) returnMarker.notChosen = outcome === "as-is";
}
export function importsReturnFor(topEntry) {
  return returnMarker && returnMarker.entry && returnMarker.entry === topEntry ? { day: returnMarker.day, notChosen: returnMarker.notChosen } : null;
}

// The mark's words (contract 1.4, mockup 04): the GPS icon and the number only.
export function gpsReviewWords(mark) {
  if (!mark) return "";
  if (mark.uncertain) return "GPS sessions may be waiting";
  return `${mark.count}${mark.plus ? "+" : ""} GPS ${mark.count === 1 && !mark.plus ? "session" : "sessions"} to review`;
}
