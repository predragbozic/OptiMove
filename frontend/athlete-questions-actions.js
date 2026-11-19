// K2b-2a-3, the athlete's side of *Ask athletes* (docs/ai/central-calendar-k2b2a3-ui-contract.md sections 2–5): the soft
// prompt (shown at most once per question per app session, only on Home with nothing on top, never after a deep link),
// Answer now / Answer / Later / Escape, and the open path of a question notification.
//
// The prompt lives in its own host at the end of <body>, outside Home's content, so a repaint of Home (the parallel
// reads that land after it) never rebuilds it or takes its focus. It never locks the app: Escape, Later and the
// backdrop close it.
import { detached } from "./app-errors-capture.js";
import {
  athleteOpenQuestionRows, athleteQuestionsNow, athleteQuestionsReady, athleteQuestionsPromptable, findAthleteQuestion, markAthleteQuestionsPrompted,
  postponeAthleteQuestions, registerAthleteQuestionsPainter, setAthleteQuestionsNotice,
} from "./athlete-questions-data.js";
import { ATHLETE_QUESTIONS_PROMPT_LIMIT, ATHLETE_QUESTIONS_TITLE_ID, renderAthleteQuestionsPromptHtml } from "./athlete-questions-view.js";
import { state } from "./state.js";

// The GO's sentence (decision 3), then its next step (the UX review: one sentence and one step).
export const ATHLETE_QUESTION_NOT_OPEN = "This question isn't open right now. Open questions show here at the top of Home.";
export const ATHLETE_QUESTION_CLOSED = "This question has closed.";
// The form did not open, but the question is still listed (a failed read of the form's side, for example).
export const ATHLETE_QUESTION_NOT_OPENED = "The question couldn't be opened. Try Answer again.";
// The form did not open and the list could not be read either (an outage): nothing is claimed about the question.
export const ATHLETE_QUESTION_UNREACHABLE = "The question couldn't be opened right now. Try again in a moment.";
const HOST_ID = "athleteQuestionsPromptHost";
const BODY_CLASS = "athlete-questions-prompt-open";
const FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

let shownIds = [];
let promptDoc = null;
// What the prompt's clicks call (app.js sets it): the prompt lives outside #content, so the content's click handler
// never sees its buttons; the host has its own listener (code review, BLOCKER).
let promptHandlers = () => ({});
export function setAthleteQuestionsPromptHandlers(fn) {
  promptHandlers = typeof fn === "function" ? fn : () => ({});
}
// Every Home load takes a number; only the latest one may show the prompt, so an older load that settles after a deep
// link started never puts the prompt over the form that deep link opens (code review, MEDIUM).
let homeLoadSeq = 0;
export function beginAthleteHomeLoad() {
  homeLoadSeq += 1;
  return homeLoadSeq;
}

export function athleteQuestionsPromptOpen() {
  return shownIds.length > 0;
}

// Is something else on top of Home? An RPE form or Training Load's athlete overlays, a Tests form, the notification
// panel, the athlete's exit question, the media viewer, or any other modal dialog shown on the page (the page always
// carries a hidden media viewer and a hidden exit question, athlete.html: a dialog inside a [hidden] parent is not on top).
export function athleteQuestionsPromptBlocked(doc = globalThis.document) {
  const tl = state.trainingLoad || {};
  if (tl.rpeForm || tl.athleteWeeklyOpen || tl.showSessionList) return true;
  if (state.tests?.form) return true;
  if (state.notifications?.open) return true;
  if (state.athleteExitConfirmOpen) return true;
  const media = doc?.getElementById?.("mediaModal");
  if (media && !media.hidden) return true;
  const dialogs = [...(doc?.querySelectorAll?.('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') || [])];
  return dialogs.some((el) => !el.closest(`#${HOST_ID}`) && !el.closest("[hidden]"));
}

// After a read on Home (app open, a return to Home). `deepLink` is true when Home was opened by a notification click
// or another deep link: then the prompt is not shown. Answers true when it was shown.
export function maybeShowAthleteQuestionsPrompt({ doc = globalThis.document, athleteMode = true, deepLink = false, load = homeLoadSeq } = {}) {
  if (!athleteMode || deepLink || athleteQuestionsPromptOpen()) return false;
  if (load !== homeLoadSeq) return false;
  if (state.activeTab !== "athlete-home") return false;
  const rows = athleteQuestionsPromptable();
  if (!rows.length) return false;
  if (athleteQuestionsPromptBlocked(doc)) return false;
  const html = renderAthleteQuestionsPromptHtml(rows);
  let host = doc.getElementById(HOST_ID);
  if (!host) {
    host = doc.createElement("div");
    host.id = HOST_ID;
    host.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]");
      if (!action || !host.contains(action)) return;
      // The prompt is modal: its clicks go nowhere else.
      event.preventDefault();
      event.stopPropagation();
      // Not awaited by anyone: a rejection is reported (App health), never left unhandled.
      detached(handleAthleteQuestionsAction(action, promptHandlers()), action.dataset.action || "");
    });
    doc.body.appendChild(host);
  }
  host.innerHTML = html;
  promptDoc = doc;
  // Every row the prompt lists counts as shown (the rest, past the limit, stay for the card and a later prompt).
  shownIds = rows.slice(0, ATHLETE_QUESTIONS_PROMPT_LIMIT).map((row) => row.questionId);
  markAthleteQuestionsPrompted(shownIds);
  doc.body.classList.add(BODY_CLASS);
  host.querySelector("[data-action='athlete-questions-answer']")?.focus?.();
  return true;
}

// `focus`: "card" (Home's card title, or Home's heading when the card has gone), "none" (the form takes it).
export function closeAthleteQuestionsPrompt({ focus = "none" } = {}) {
  const doc = promptDoc || globalThis.document;
  const host = doc?.getElementById?.(HOST_ID);
  if (host) host.innerHTML = "";
  doc?.body?.classList?.remove?.(BODY_CLASS);
  const wasOpen = athleteQuestionsPromptOpen();
  shownIds = [];
  if (!wasOpen || !doc) return wasOpen;
  if (focus === "card") (doc.getElementById(ATHLETE_QUESTIONS_TITLE_ID) || doc.querySelector(".athlete-home-header h3"))?.focus?.();
  return true;
}

// Later (the button, the backdrop, Escape): the prompt closes at once; one POST per question shown, in the background.
function laterFromPrompt(handlers) {
  const ids = [...shownIds];
  closeAthleteQuestionsPrompt({ focus: "card" });
  const settled = postponeAthleteQuestions(ids);
  handlers?.render?.();
  // The card is drawn again by the render: its title takes the focus, and again after the read that follows the
  // answer repaints Home (a repaint drops the focus to the page) - unless she moved on meanwhile.
  const focusCard = () => (globalThis.document?.getElementById?.(ATHLETE_QUESTIONS_TITLE_ID)
    || globalThis.document?.querySelector?.(".athlete-home-header h3"))?.focus?.();
  focusCard();
  return settled.then(() => {
    const active = globalThis.document?.activeElement;
    if (!active || active === globalThis.document?.body) focusCard();
  });
}

// Answer now / Answer (the prompt or the card): the existing form of the question, by its form's id.
// handlers: { openRpe(externalAssignmentId), openWellness(assignmentId), rpeFormOpenFor(externalAssignmentId), render }
export async function answerAthleteQuestion(questionId, handlers = {}) {
  closeAthleteQuestionsPrompt({ focus: "none" });
  const row = findAthleteQuestion(questionId);
  if (!row) {
    setAthleteQuestionsNotice(ATHLETE_QUESTION_NOT_OPEN);
    handlers.render?.();
    return false;
  }
  setAthleteQuestionsNotice("");
  if (row.formKind === "wellness") {
    await handlers.openWellness?.(row.formId);
    return true;
  }
  await handlers.openRpe?.(row.formId);
  if (handlers.rpeFormOpenFor && !handlers.rpeFormOpenFor(row.formId)) {
    await handlers.reload?.();
    // "Closed" only from a read that succeeded (the re-review: a failed read must never claim it).
    const notice = !athleteQuestionsReady() ? ATHLETE_QUESTION_UNREACHABLE
      : findAthleteQuestion(questionId) ? ATHLETE_QUESTION_NOT_OPENED : ATHLETE_QUESTION_CLOSED;
    setAthleteQuestionsNotice(notice);
    handlers.render?.();
    return false;
  }
  return true;
}

export async function handleAthleteQuestionsAction(action, handlers = {}) {
  const type = action?.dataset?.action;
  if (type === "athlete-questions-later") {
    if (!athleteQuestionsPromptOpen()) return true;
    await laterFromPrompt(handlers);
    return true;
  }
  if (type === "athlete-questions-answer") {
    await answerAthleteQuestion(action.dataset.questionId || "", handlers);
    return true;
  }
  return false;
}

// The keyboard while the prompt is open: Escape = Later; Tab and Shift+Tab stay inside the sheet. Answers true when it
// handled the key (the caller's other Escape handling must not run).
export function handleAthleteQuestionsKeydown(event, handlers = {}) {
  if (!athleteQuestionsPromptOpen()) return false;
  if (event.key === "Escape") {
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    laterFromPrompt(handlers);
    return true;
  }
  if (event.key !== "Tab") return false;
  const doc = promptDoc || globalThis.document;
  const sheet = doc?.querySelector?.(`#${HOST_ID} [role="dialog"]`);
  const items = [...(sheet?.querySelectorAll?.(FOCUSABLE) || [])];
  if (!items.length) return false;
  const first = items[0];
  const last = items[items.length - 1];
  const active = doc.activeElement;
  if (event.shiftKey && (active === first || !sheet.contains(active))) {
    event.preventDefault?.();
    last.focus();
    return true;
  }
  if (!event.shiftKey && (active === last || !sheet.contains(active))) {
    event.preventDefault?.();
    first.focus();
    return true;
  }
  return false;
}

// The phone's Back while the prompt is open (app.js handleBrowserBack, through athleteQuestionsBrowserBack): the same as
// Escape, Later. Answers true only when
// the prompt was open, so Back otherwise keeps its own meaning (the exit question would else open hidden behind it).
export function athleteQuestionsBack(handlers = {}) {
  if (!athleteQuestionsPromptOpen()) return false;
  laterFromPrompt(handlers);
  return true;
}

// A question notification's click (section 5): Home, read without the prompt (handlers.loadHome), then the question's
// form, or one sentence at the top of Home when it is not listed.
export async function openCalendarQuestion(questionId, handlers = {}) {
  closeAthleteQuestionsPrompt({ focus: "none" });
  await handlers.loadHome?.();
  if (!findAthleteQuestion(questionId)) {
    setAthleteQuestionsNotice(ATHLETE_QUESTION_NOT_OPEN);
    handlers.render?.();
    return false;
  }
  return answerAthleteQuestion(questionId, handlers);
}

// The minute's tick: a prompt whose questions have all closed closes by itself (the focus to the card's title, or Home's
// heading when the card has gone).
registerAthleteQuestionsPainter(() => {
  if (!athleteQuestionsPromptOpen()) return;
  const open = new Set(athleteOpenQuestionRows(state.athleteQuestions?.rows, athleteQuestionsNow()).map((row) => row.questionId));
  if (!shownIds.some((id) => open.has(id))) closeAthleteQuestionsPrompt({ focus: "card" });
});
