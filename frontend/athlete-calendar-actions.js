// The athlete's Calendar (K4a, docs/ai/central-calendar-k4a-contract.md sections 2.2-2.4): the week's arrows, Today, a
// phone's day strip, Try again, and the cards' buttons. What a button opens is app.js's (the handlers): an event
// question's form as Home opens it, a planned session's RPE in the Training Load form, a test, and the Weekly plan.
import { state } from "./state.js";
import { addDaysIso, localDateIso } from "./utils.js";
import { athleteCalendarState, athleteCalendarWeek, loadAthleteCalendar } from "./athlete-calendar-data.js";
import { athleteCalendarAnswerFor, athleteCalendarAnswersSettled } from "./athlete-calendar-answers.js";

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
  // Back to a remembered place: the scroll it had, once its week is drawn (contract 2.4).
  const y = athleteCalendarState().pendingScrollY;
  if (y !== null && y !== undefined) {
    athleteCalendarState().pendingScrollY = null;
    globalThis.requestAnimationFrame?.(() => globalThis.scrollTo?.(0, y));
  }
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
  // The Weekly plan's Back to calendar: the same step back as the phone's Back (app.js's history).
  if (type === "athlete-calendar-back") {
    await handlers.back?.();
    return true;
  }
  if (type === "athlete-calendar-retry") {
    await Promise.all([loadAthleteCalendar({ render, forceRefresh: true }), handlers.loadQuestions?.()]);
    render?.();
    return true;
  }
  // K4b: Change on her own "RPE request" card. The form opens only from the row her own weekly read returned for that
  // assignment and only while that row says it may change - never from the id on the page alone.
  if (type === "athlete-calendar-rpe-change") {
    const row = athleteCalendarAnswerFor(action.dataset.assignmentId || "", slice.weekStart);
    if (!row || !row.changeable) return true;
    await handlers.changeAnswer?.(row, { date: action.dataset.date || row.date, title: action.dataset.title || row.sessionName });
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
    else if (what === "open-training" && action.dataset.sessionId) await handlers.openTraining?.({ sessionId: action.dataset.sessionId, date: action.dataset.date || "", title: action.dataset.title || "" });
    return true;
  }
  return false;
}

// After a confirmed answer (contract 2.3): one sentence, and the week read again. K4b: a confirmed change says
// "Your answer was changed."; a change refused as closed reads the week again with no sentence (the form said it).
export async function athleteCalendarAnswered({ render, loadQuestions, notice = "Your answer was saved." } = {}) {
  const slice = athleteCalendarState();
  slice.notice = notice;
  render?.();
  await Promise.all([loadAthleteCalendar({ render, forceRefresh: true }), loadQuestions?.()]);
  // K4b: her answer's line too (its own read, started by loadAthleteCalendar).
  await athleteCalendarAnswersSettled();
  slice.notice = notice;
  render?.();
}
