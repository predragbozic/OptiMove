// The athlete's Calendar (K4a, docs/ai/central-calendar-k4a-contract.md sections 2.2-2.4): the week's arrows, Today, a
// phone's day strip, Try again, and the cards' buttons. What a button opens is app.js's (the handlers): an event
// question's form as Home opens it, a planned session's RPE in the Training Load form, a test, and the Weekly plan.
import { state } from "./state.js";
import { addDaysIso, localDateIso } from "./utils.js";
import { athleteCalendarState, athleteCalendarWeek, loadAthleteCalendar } from "./athlete-calendar-data.js";

// The tab's entry (the rail, Home's See all): this week unless a week is asked for; read again on every entry, so an
// answer given elsewhere shows (one read per entry).
export async function enterAthleteCalendar({ render, weekStart = "", loadQuestions } = {}) {
  const slice = athleteCalendarState();
  if (weekStart) slice.weekStart = athleteCalendarWeek(weekStart).from;
  else if (!slice.weekStart) slice.weekStart = athleteCalendarWeek(localDateIso()).from;
  render?.();
  await Promise.all([
    loadAthleteCalendar({ render, forceRefresh: true }),
    loadQuestions?.(),
  ]);
  render?.();
}

// A phone's strip: the list scrolls to the day (a day with nothing has no section: the list stays).
export function scrollAthleteCalendarToDay(date, doc = globalThis.document) {
  const section = doc?.querySelector?.(`.athlete-calendar [data-ac-day="${date}"]`);
  section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  return Boolean(section);
}

// handlers: { render, loadQuestions, rateQuestion(questionId), rateSession(sessionId, date), rateAssignment(assignmentId, date),
//   openTest(assignmentId), openTraining({ sessionId, date }) }. Answers true when the action was the Calendar's.
export async function handleAthleteCalendarAction(action, handlers = {}) {
  const type = action?.dataset?.action;
  const slice = athleteCalendarState();
  const render = handlers.render;
  if (type === "athlete-calendar-week") {
    const delta = Number(action.dataset.delta) || 0;
    const from = addDaysIso(athleteCalendarWeek(slice.weekStart || localDateIso()).from, 7 * Math.sign(delta));
    slice.weekStart = from;
    slice.selectedDate = "";
    slice.notice = "";
    await loadAthleteCalendar({ render, weekStart: from });
    return true;
  }
  if (type === "athlete-calendar-today") {
    const today = localDateIso();
    slice.notice = "";
    slice.selectedDate = today;
    await loadAthleteCalendar({ render, weekStart: today });
    scrollAthleteCalendarToDay(today);
    return true;
  }
  if (type === "athlete-calendar-day") {
    const date = action.dataset.date || "";
    if (!date) return true;
    slice.selectedDate = date;
    render?.();
    scrollAthleteCalendarToDay(date);
    return true;
  }
  if (type === "athlete-calendar-retry") {
    await Promise.all([loadAthleteCalendar({ render, forceRefresh: true }), handlers.loadQuestions?.()]);
    render?.();
    return true;
  }
  if (type === "athlete-calendar-card") {
    const what = action.dataset.acAction || "";
    if (what === "rate-question" && action.dataset.questionId) {
      const answered = await handlers.rateQuestion?.(action.dataset.questionId);
      // The question's own sentence (closed, not opened, unreachable) is written for Home; the Calendar says it too.
      if (answered === false) {
        const notice = state.athleteQuestions?.notice || "";
        if (notice) slice.notice = notice;
        render?.();
      }
    }
    else if (what === "rate-session" && action.dataset.sessionId) await handlers.rateSession?.(action.dataset.sessionId, action.dataset.date || "");
    else if (what === "rate-assignment" && action.dataset.assignmentId) await handlers.rateAssignment?.(action.dataset.assignmentId, action.dataset.date || "");
    else if (what === "open-test" && action.dataset.assignmentId) await handlers.openTest?.(action.dataset.assignmentId);
    else if (what === "open-training" && action.dataset.sessionId) await handlers.openTraining?.({ sessionId: action.dataset.sessionId, date: action.dataset.date || "" });
    return true;
  }
  return false;
}

// After a confirmed answer (contract 2.3): one sentence, and the week read again.
export async function athleteCalendarAnswered({ render, loadQuestions } = {}) {
  const slice = athleteCalendarState();
  slice.notice = "Your answer was saved.";
  render?.();
  await Promise.all([loadAthleteCalendar({ render, forceRefresh: true }), loadQuestions?.()]);
  slice.notice = "Your answer was saved.";
  render?.();
}
