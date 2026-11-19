// K2b-2a-3, the athlete's side of *Ask athletes* (docs/ai/central-calendar-k2b2a3-ui-contract.md; plan
// docs/ai/central-calendar-k2b2-plan.md 3.4): her open calendar questions, read from GET /api/calendar/questions/mine,
// and her *Later*, POST /api/calendar/questions/:questionId/later.
//
// - The read runs on entry into Home, after an answer, after a settled *Later* and on a question notification's
//   click; never per render and never on the minute's tick. One read at a time per context; a generation and the
//   context key (account + workspace) drop an answer that started before a reset or belongs to another context.
// - A failed read hides everything (no prompt, no card, no error line): the next entry into Home tries again.
// - What reaches the screen is an explicit pick of each row (athleteQuestionRows); an id that is not needed to open the
//   form never does, and none is ever drawn as text (D21).
// - *Later* closes the prompt at once; its request settles in the background and is never shown as an error.
import { api } from "./api.js";
import { currentUserWorkspaceContextParts } from "./access.js";
import { emptyAthleteQuestionsState, state } from "./state.js";
import { buildContextKey } from "./view-cache.js";

export const ATHLETE_QUESTIONS_URL = "/api/calendar/questions/mine";
export const athleteQuestionLaterUrl = (questionId) => `/api/calendar/questions/${encodeURIComponent(questionId)}/later`;
export const ATHLETE_QUESTION_ROW_KEYS = Object.freeze([
  "questionId", "kind", "eventId", "eventTitle", "eventDay", "eventStart", "opensAt", "closesAt", "formKind", "formId", "later",
]);
export const ATHLETE_QUESTIONS_TICK_MS = 60_000;

const g = () => state.athleteQuestions;
let generation = 0;
// Bumped only by a reset: a *Later* settling after a workspace switch changes nothing.
let epoch = 0;
let inFlight = null;
// The questions the prompt has shown in this app session (memory only; a reset or a page load clears it).
let promptedIds = new Set();
// The last render callback (Home's repaint), for the reads that follow an answer or a *Later*.
let lastRender = null;

// The clock (tests set it).
let clock = () => Date.now();
export function setAthleteQuestionsClock(fn) {
  clock = typeof fn === "function" ? fn : () => Date.now();
}
export const athleteQuestionsNow = () => clock();

export function athleteQuestionsContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

const text = (value) => (typeof value === "string" && value.trim() ? value : null);
const isoDay = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
const hhmm = (value) => (typeof value === "string" && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : null);
const instant = (value) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);

// The pick: one row per question, exactly ATHLETE_QUESTION_ROW_KEYS. A row without an id, a known kind, a window or a
// form id is left out (she could not answer it).
export function athleteQuestionRows(answer) {
  const rows = [];
  for (const q of Array.isArray(answer?.questions) ? answer.questions : []) {
    const kind = q?.kind === "rpe" || q?.kind === "wellness" ? q.kind : null;
    const formKind = q?.form?.kind === "rpe" || q?.form?.kind === "wellness" ? q.form.kind : null;
    const formId = formKind === "rpe" ? text(q.form.externalAssignmentId) : formKind === "wellness" ? text(q.form.assignmentId) : null;
    const questionId = text(q?.questionId);
    const opensAt = instant(q?.window?.opensAt);
    const closesAt = instant(q?.window?.closesAt);
    if (!questionId || !kind || formKind !== kind || !formId || !opensAt || !closesAt) continue;
    rows.push({
      // K4a: the event's id, so the athlete's Calendar puts Rate RPE on the event's card.
      questionId, kind, eventId: q?.eventId ? String(q.eventId) : null, eventTitle: text(q.eventTitle), eventDay: isoDay(q.eventDay), eventStart: hhmm(q.eventStart),
      opensAt, closesAt, formKind, formId, later: q.later === true,
    });
  }
  return rows;
}

// Open now: its window has not closed (the server listed only open ones; the clock moves on).
export function athleteOpenQuestionRows(rows, now = clock()) {
  return (Array.isArray(rows) ? rows : []).filter((row) => Date.parse(row.closesAt) > now);
}

export function athleteQuestionsReady() {
  return g()?.status === "ready";
}

// The rows the prompt may show: open, not *Later*-ed (here or on the server), not shown in this app session yet.
export function athleteQuestionsPromptable(now = clock()) {
  if (!athleteQuestionsReady()) return [];
  return athleteOpenQuestionRows(g().rows, now)
    .filter((row) => !row.later && !promptedIds.has(row.questionId))
    .sort((a, b) => Date.parse(a.closesAt) - Date.parse(b.closesAt));
}

export function markAthleteQuestionsPrompted(ids) {
  for (const id of ids) promptedIds.add(id);
}
export function athleteQuestionWasPrompted(id) {
  return promptedIds.has(id);
}

export function findAthleteQuestion(questionId) {
  if (!athleteQuestionsReady()) return null;
  return athleteOpenQuestionRows(g().rows).find((row) => row.questionId === questionId) || null;
}

// Is this assignment the form of an open question? (Home's own WELLNESS card is then not drawn twice.)
export function athleteQuestionHoldsAssignment(formKind, assignmentId) {
  if (!assignmentId || !athleteQuestionsReady()) return false;
  return athleteOpenQuestionRows(g().rows).some((row) => row.formKind === formKind && row.formId === String(assignmentId));
}

export function setAthleteQuestionsNotice(notice) {
  g().notice = notice || "";
}

// A workspace switch (or a sign-out): nothing of the old context stays, an answer on its way is dropped, and the app
// session's prompt memory starts again.
export function resetAthleteQuestions() {
  generation += 1;
  epoch += 1;
  inFlight = null;
  promptedIds = new Set();
  stopAthleteQuestionsTick();
  state.athleteQuestions = emptyAthleteQuestionsState();
}

// The read. `render` paints Home again (only while Home is on screen; the caller's own check). Resolves when the read
// has settled; never throws.
export function loadAthleteQuestions({ render } = {}) {
  if (render) lastRender = render;
  const contextKey = athleteQuestionsContextKey();
  if (inFlight && inFlight.contextKey === contextKey && inFlight.generation === generation) return inFlight.promise;
  const run = ++generation;
  const current = () => run === generation && athleteQuestionsContextKey() === contextKey;
  if (g().contextKey !== contextKey) state.athleteQuestions = { ...emptyAthleteQuestionsState(), contextKey };
  // A notice belongs to the step that set it: every new read starts without one.
  g().notice = "";
  const promise = (async () => {
    try {
      const answer = await api(ATHLETE_QUESTIONS_URL);
      if (!current()) return;
      Object.assign(g(), { status: "ready", rows: athleteQuestionRows(answer), contextKey });
      startAthleteQuestionsTick();
    } catch {
      if (!current()) return;
      Object.assign(g(), { status: "hidden", rows: [], contextKey });
    } finally {
      if (inFlight?.generation === run) inFlight = null;
    }
    render?.();
  })();
  inFlight = { contextKey, generation: run, promise };
  return promise;
}

// A form's successful submit (the RPE form, the WELLNESS form): the answered question leaves the rows at once, and the
// list is read again - only when she had an open calendar question (#633's LOW (c)): an answer of a form that is no
// question's, with none open, sends nothing.
export function athleteQuestionsAnswered(formId) {
  if (g()?.status === "idle") return;
  const rows = g().rows || [];
  // A read on its way is still replaced (it may list the answered question).
  if (!rows.length && !inFlight) return;
  if (formId) g().rows = rows.filter((row) => row.formId !== String(formId));
  inFlight = null;
  return loadAthleteQuestions({ render: lastRender });
}

const newRequestKey = () => globalThis.crypto.randomUUID();
const codeOf = (error) => error?.data?.error || "";

// *Later* for the questions shown: locally at once (later, prompted), then one POST each with its own fresh key, in
// sequence. A row the server says is not hers or not open is dropped and the list read again; a lost or busy answer
// counts as done locally. Never throws.
export function postponeAthleteQuestions(questionIds) {
  const ids = [...new Set(questionIds.filter(Boolean))];
  markAthleteQuestionsPrompted(ids);
  for (const row of g().rows) if (ids.includes(row.questionId)) row.later = true;
  const run = epoch;
  return (async () => {
    let readAgain = false;
    for (const id of ids) {
      try {
        await api(athleteQuestionLaterUrl(id), { method: "POST", body: JSON.stringify({ requestKey: newRequestKey() }) });
        readAgain = true;
      } catch (error) {
        const settledRefusal = error?.status === 404 || (error?.status === 409 && codeOf(error) === "question_not_open");
        if (settledRefusal) {
          if (run === epoch) g().rows = g().rows.filter((row) => row.questionId !== id);
          readAgain = true;
        }
        // Anything else (try_again, outcome_unknown, no answer, a 5xx): done locally, nothing shown, nothing sent again.
      }
    }
    if (readAgain && run === epoch) {
      inFlight = null;
      await loadAthleteQuestions({ render: lastRender });
    }
  })();
}

// The minute's tick: while Home is open, the card's rows are filtered again by the clock with no request; when the
// visible set changed, the registered painters replace only the card (and close a prompt whose questions all closed).
let tickTimer = null;
let tickSignature = "";
const painters = new Set();
export function registerAthleteQuestionsPainter(paint) {
  if (typeof paint === "function") painters.add(paint);
}
// The open rows, and what their time-to-answer words depend on: the minutes left under an hour, else the device's
// day (so "Answer in the next 5 minutes" and "today" stay true without a read).
const pad2 = (n) => String(n).padStart(2, "0");
const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const signatureOf = () => {
  if (!athleteQuestionsReady()) return "";
  const now = clock();
  const rows = athleteOpenQuestionRows(g().rows, now).map((row) => {
    const left = Date.parse(row.closesAt) - now;
    return `${row.questionId}:${left < 60 * 60 * 1000 ? Math.ceil(left / 60000) : ""}`;
  });
  return `${localDay(now)}|${rows.join(",")}`;
};
export function stopAthleteQuestionsTick() {
  if (tickTimer !== null) globalThis.clearInterval(tickTimer);
  tickTimer = null;
}
export function startAthleteQuestionsTick() {
  stopAthleteQuestionsTick();
  tickSignature = signatureOf();
  tickTimer = globalThis.setInterval(athleteQuestionsTick, ATHLETE_QUESTIONS_TICK_MS);
  tickTimer?.unref?.();
}
export function athleteQuestionsTick() {
  if (state.activeTab !== "athlete-home") {
    stopAthleteQuestionsTick();
    return false;
  }
  const next = signatureOf();
  if (next === tickSignature) return false;
  tickSignature = next;
  for (const paint of painters) paint();
  return true;
}
