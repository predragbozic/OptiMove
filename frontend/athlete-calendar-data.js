// The athlete's Calendar (K4a, docs/ai/central-calendar-k4a-contract.md section 2): her own week by days. One read of the
// K1a calendar API per shown week in her athlete workspace - GET /api/calendar for Monday to Sunday with
// include=athletes and no kinds (her events, her planned sessions, her RPE and test assignments, her activities) - plus
// her open questions (GET /api/calendar/questions/mine, the reader Home already uses, athlete-questions-data.js).
//
// What reaches the screen is an explicit card model (athleteCalendarCard): a field the server may add to a card later
// never reaches the page. A slower, older answer is dropped by a generation counter and by view-cache.js' context key
// (account + workspace + the week + her local date). The slice lives here, not in state.js. Nothing here writes.
import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { pickAthleteEventPlace } from "./athlete-home-events-data.js";
import { athleteOpenQuestionRows } from "./athlete-questions-data.js";
import { addDaysIso, localDateIso, weekMondayIso } from "./utils.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

export const ATHLETE_CALENDAR_NAMESPACE = "athlete-calendar";

const EVENT_KIND_WORDS = Object.freeze({ training: "Training", match: "Match", test: "Test", travel: "Travel", meeting: "Meeting", day_off: "Day off", camp: "Camp" });
// A session's place in the day (B/T/A), in the Weekly plan's words.
const BTA_WORDS = Object.freeze({ B: "Before", T: "Training", A: "After" });
const WEEKDAYS = Object.freeze(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

export function emptyAthleteCalendarState() {
  return { weekStart: "", selectedDate: "", status: "idle", data: null, error: "", canRetry: true, notice: "" };
}

let slice = emptyAthleteCalendarState();
let generation = 0;

export function athleteCalendarState() {
  return slice;
}

// A workspace switch or a sign-out: nothing of the old week stays, an answer on its way is dropped.
export function resetAthleteCalendar() {
  generation += 1;
  slice = emptyAthleteCalendarState();
}

export function invalidateAthleteCalendarCache() {
  invalidateCacheNamespace(ATHLETE_CALENDAR_NAMESPACE);
}

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

export function athleteCalendarWeek(weekStart) {
  const from = weekMondayIso(weekStart || localDateIso());
  return { from, to: addDaysIso(from, 6), days: Array.from({ length: 7 }, (_, index) => addDaysIso(from, index)) };
}

export function athleteCalendarContextKey(from, today) {
  return buildContextKey([...currentUserWorkspaceContextParts(), from, today]);
}

export function athleteCalendarUrl(from, to, today) {
  return `/api/calendar?${new URLSearchParams({ from, to, today, include: "athletes" }).toString()}`;
}

const dayParts = (iso) => {
  const [year, month, day] = String(iso).split("-").map(Number);
  return { year, month, day };
};

// "12 – 18 Oct"; across months "28 Sep – 4 Oct"; across years "29 Dec 2026 – 4 Jan 2027".
export function athleteCalendarWeekLabel(from) {
  const to = addDaysIso(from, 6);
  const a = dayParts(from);
  const b = dayParts(to);
  if (a.year !== b.year) return `${a.day} ${MONTHS[a.month - 1]} ${a.year} – ${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${MONTHS[a.month - 1]} – ${b.day} ${MONTHS[b.month - 1]}`;
  return `${a.day} – ${b.day} ${MONTHS[b.month - 1]}`;
}

// "Monday 12.10"; the screen adds "· today".
export function athleteCalendarDayLabel(iso) {
  const { month, day } = dayParts(iso);
  const index = (new Date(`${iso}T12:00:00`).getDay() + 6) % 7;
  return `${WEEKDAYS[index]} ${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
}

export function athleteCalendarShortWeekday(iso) {
  return WEEKDAYS[(new Date(`${iso}T12:00:00`).getDay() + 6) % 7].slice(0, 3);
}

// ---------------------------------------------------------------------------
// The card model
// ---------------------------------------------------------------------------

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const hhmm = (value) => (typeof value === "string" && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : null);
const id = (value) => (value === null || value === undefined || value === "" ? null : String(value));

// "10:00–11:30", "10:00", or null.
function timeRange(start, end) {
  const a = hhmm(start);
  if (!a) return null;
  const b = hhmm(end);
  return b ? `${a}–${b}` : a;
}

function slotWord(slot) {
  return BTA_WORDS[slot?.bta] || (slot?.amPm === "AM" || slot?.amPm === "PM" ? slot.amPm : null);
}

// Her own row of a card (the athlete's answer carries only hers).
const ownRow = (item) => (Array.isArray(item?.athletes) ? item.athletes[0] || null : null);

// Rate RPE for a planned session (contract Q3): only on today or a past day, while her answer is missing.
const rateable = (date, today, rpe) => rpe === "missing" && Boolean(date) && date <= today;

// The buttons, primary first (contract 2.2): Rate RPE when an open RPE question of the event exists, or a session's
// RPE is missing on today or a past day; then Open training; a wellness question is Wellness. One primary per card.
function buttons({ rpe, wellness, training, test }) {
  const list = [];
  if (rpe) list.push(rpe);
  if (wellness) list.push(wellness);
  if (training) list.push(training);
  if (test) list.push(test);
  return list.map((button, index) => ({ ...button, primary: index === 0 }));
}

// One card of the answer, as the screen shows it; null for a card she has nothing to see on (an unknown kind).
// `questions`: her open question rows (athlete-questions-data.js), matched to an event by its id.
export function athleteCalendarCard(item, { questions = [], today = localDateIso() } = {}) {
  const kind = item?.kind;
  const date = text(item?.date);
  const key = text(item?.key);
  if (!key || !date) return null;
  const cancelled = item.cancelled === true || item.status === "cancelled";
  const base = { key, date, cancelled, title: text(item.title), when: null, word: null, iconKind: kind, eventKind: null, eventTypeIconKey: null, eventTypeColorKey: null, place: null, sessions: [], buttons: [], answer: null };

  if (kind === "event") {
    const eventId = id(item.links?.eventId);
    const word = text(item.eventTypeLabel) || EVENT_KIND_WORDS[item.eventKind] || "Event";
    const sessions = cancelled ? [] : (Array.isArray(item.sessions) ? item.sessions : []).map((s) => ({
      slot: slotWord(s?.slot),
      title: text(s?.title) || "Training",
      // The time alone: "from the event" is never written (contract 2.2).
      time: hhmm(s?.time),
      sessionId: id(s?.sessionId),
      rpe: s?.rpe === "missing" || s?.rpe === "submitted" ? s.rpe : "not_asked",
    }));
    const open = cancelled || !eventId ? [] : athleteOpenQuestionRows(questions).filter((q) => q.eventId === eventId);
    const rpeQuestion = open.find((q) => q.kind === "rpe");
    const wellnessQuestion = open.find((q) => q.kind === "wellness");
    const missing = sessions.find((s) => s.sessionId && rateable(date, today, s.rpe));
    const firstSession = sessions.find((s) => s.sessionId);
    const rpe = rpeQuestion
      ? { action: "rate-question", label: "Rate RPE", questionId: rpeQuestion.questionId }
      : missing ? { action: "rate-session", label: "Rate RPE", sessionId: missing.sessionId } : null;
    return {
      ...base,
      kind: "event",
      eventId,
      word,
      title: base.title || word,
      when: timeRange(item.startTime, item.endTime),
      eventKind: text(item.eventKind),
      eventTypeIconKey: text(item.eventTypeIconKey),
      eventTypeColorKey: text(item.eventTypeColorKey),
      place: cancelled ? null : pickAthleteEventPlace(item.place, item.location),
      sessions,
      buttons: cancelled ? [] : buttons({
        rpe,
        wellness: wellnessQuestion ? { action: "rate-question", label: "Wellness", questionId: wellnessQuestion.questionId } : null,
        training: firstSession ? { action: "open-training", label: "Open training", sessionId: firstSession.sessionId } : null,
      }),
      // K4b's room (contract 3): only "RPE given" until K4b, never the value.
      answer: !cancelled && !rpe && sessions.some((s) => s.rpe === "submitted") ? "rpe-given" : null,
    };
  }

  if (kind === "planned") {
    const own = ownRow(item);
    const sessionId = id(own?.sessionId);
    const rpeState = own?.rpe === "missing" || own?.rpe === "submitted" ? own.rpe : "not_asked";
    const rpe = sessionId && rateable(date, today, rpeState) ? { action: "rate-session", label: "Rate RPE", sessionId } : null;
    return {
      ...base,
      kind: "planned",
      word: "My training",
      when: hhmm(item.startTime) || (item.slot?.amPm === "AM" || item.slot?.amPm === "PM" ? item.slot.amPm : null),
      title: base.title || "Training",
      buttons: cancelled ? [] : buttons({ rpe, training: sessionId ? { action: "open-training", label: "Open training", sessionId } : null }),
      answer: !rpe && rpeState === "submitted" ? "rpe-given" : null,
    };
  }

  if (kind === "external") {
    const own = ownRow(item);
    const assignmentId = id(own?.assignmentId);
    const rpe = !cancelled && assignmentId && own?.rpe === "missing" && date <= today
      ? { action: "rate-assignment", label: "Rate RPE", assignmentId } : null;
    return {
      ...base,
      kind: "external",
      word: "RPE request",
      when: hhmm(item.startTime),
      title: base.title || "RPE request",
      buttons: buttons({ rpe }),
      answer: !rpe && own?.rpe === "submitted" ? "rpe-given" : null,
    };
  }

  if (kind === "test") {
    const own = ownRow(item);
    const assignmentId = id(own?.assignmentId);
    return {
      ...base,
      kind: "test",
      word: "Test",
      when: hhmm(item.startTime),
      title: base.title || "Test",
      buttons: buttons({ test: !cancelled && assignmentId && date <= today ? { action: "open-test", label: "Open test", assignmentId } : null }),
    };
  }

  if (kind === "activity") {
    return { ...base, kind: "activity", word: "Recorded session", when: hhmm(item.startTime), title: base.title || "Recorded session" };
  }
  return null;
}

// The week by days: only days that have a card, in the week's order; the cards keep the server's order inside a day.
export function athleteCalendarDays(answer, { from, questions = [], today = localDateIso() } = {}) {
  const byDate = new Map();
  for (const day of Array.isArray(answer?.days) ? answer.days : []) {
    for (const item of Array.isArray(day?.items) ? day.items : []) {
      const card = athleteCalendarCard(item, { questions, today });
      if (!card) continue;
      if (!byDate.has(card.date)) byDate.set(card.date, []);
      byDate.get(card.date).push(card);
    }
  }
  return athleteCalendarWeek(from).days
    .filter((date) => byDate.get(date)?.length)
    .map((date) => ({ date, label: athleteCalendarDayLabel(date), today: date === today, cards: byDate.get(date) }));
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

function describeError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401) return { message: "Please sign in again.", canRetry: false };
  return { message: "The calendar could not be read.", canRetry: true };
}

// Reads the week of `weekStart` (her local today by default). `render` paints at every change of what is shown.
export async function loadAthleteCalendar({ render, weekStart, forceRefresh = false } = {}) {
  const today = localDateIso();
  const week = athleteCalendarWeek(weekStart || slice.weekStart || today);
  if (slice.weekStart !== week.from) {
    slice.data = null;
    slice.status = "idle";
  }
  slice.weekStart = week.from;
  if (!slice.selectedDate || slice.selectedDate < week.from || slice.selectedDate > week.to) {
    slice.selectedDate = today >= week.from && today <= week.to ? today : week.from;
  }
  slice.error = "";
  const run = ++generation;
  const mine = slice;
  const current = () => run === generation && slice === mine;
  const contextKey = athleteCalendarContextKey(week.from, today);
  return loadCachedView({
    namespace: ATHLETE_CALENDAR_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api(athleteCalendarUrl(week.from, week.to, today)),
    showLoading: () => {
      if (!current()) return;
      slice.status = "loading";
      render?.();
    },
    applyData: (data) => {
      if (!current()) return;
      Object.assign(slice, { status: "ready", data, error: "" });
      render?.();
    },
    applyError: (error) => {
      if (!current()) return;
      const described = describeError(error);
      // The week already on screen stays; only a week with nothing to show gets the error.
      if (slice.data) slice.notice = `${described.message} Showing the last loaded calendar.`;
      else Object.assign(slice, { status: "error", error: described.message, canRetry: described.canRetry });
      render?.();
    },
    getCurrentContextKey: () => (slice === mine ? athleteCalendarContextKey(slice.weekStart, localDateIso()) : ""),
  });
}
