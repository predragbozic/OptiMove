// Central calendar K2b-2a-2b - "Ask athletes": the pure parts shared by the
// event form and the event panel (docs/ai/central-calendar-k2b2a2-ui-contract.md
// sections 3 to 5 and 10). Nothing here talks to the server or the DOM (the
// panel's section is a template string): the
// window rule mirrored from the server's computeWindow (calendarQuestions.js,
// which stays the judge), the words of a window, the sentences of the
// refusals, and the form's question state with the body it sends.

import { escapeAttr, escapeHtml } from "./utils.js";

export const CC_QUESTION_KINDS = Object.freeze(["rpe", "wellness"]);
export const CC_QUESTION_WORDS = Object.freeze({ rpe: "RPE", wellness: "WELLNESS" });
export const CC_QUESTION_PROMPTS = Object.freeze({ rpe: "How hard was it?", wellness: "How are you feeling?" });
export const CC_WINDOW_KINDS = Object.freeze(["after_event", "next_morning", "custom"]);
export const CC_ONE_DAY = "Answers can be collected within one day for now.";

const AFTER_EVENT_OPENS = "18:00";
const DAY_END = "23:59";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ccAddDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The event's facts the window depends on: { day, endDay, startTime, endTime }.
export function ccQuestionEventOf(source) {
  return {
    day: String(source?.day || ""),
    endDay: String(source?.endDay || ""),
    startTime: String(source?.startTime || "").slice(0, 5),
    endTime: String(source?.endTime || "").slice(0, 5),
  };
}

// The window's day and times, or { error } with the server's code
// (invalid_window / window_one_day) - the same rule as computeWindow.
export function ccQuestionWindowRange(ev, window) {
  if (!DATE.test(ev.day)) return { error: "invalid_window" };
  const last = ev.endDay && ev.endDay >= ev.day ? ev.endDay : ev.day;
  if (window.kind === "after_event") {
    const start = TIME.test(ev.startTime) ? ev.startTime : "";
    const end = TIME.test(ev.endTime) ? ev.endTime : "";
    const opens = end || (start && start > AFTER_EVENT_OPENS ? start : AFTER_EVENT_OPENS);
    if (opens >= DAY_END) return { error: "invalid_window" };
    return { date: last, from: opens, to: DAY_END };
  }
  if (window.kind === "next_morning") return { date: ccAddDays(last, 1), from: "07:00", to: "12:00" };
  if (!DATE.test(window.date || "") || window.date < ev.day || window.date > ccAddDays(last, 1)) return { error: "invalid_window" };
  if (!TIME.test(window.from || "") || !TIME.test(window.to || "")) return { error: "invalid_window" };
  if (window.from >= window.to) return { error: "window_one_day" };
  return { date: window.date, from: window.from, to: window.to };
}

// "Sat 21.11."
export function ccShortDay(iso) {
  if (!DATE.test(iso || "")) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

function onDay(iso, today) {
  if (today && iso === today) return "today";
  if (today && iso === ccAddDays(today, 1)) return "tomorrow";
  return `on ${ccShortDay(iso)}`;
}

// The window's words: the choice's own quiet line in the form, the panel's
// "After the event, 18:00–23:59 today".
export function ccWindowWords(range, { today = "" } = {}) {
  if (!range || range.error) return "";
  return `${range.from}–${range.to} ${onDay(range.date, today)}`;
}
export const CC_WINDOW_LABELS = Object.freeze({ after_event: "After the event", next_morning: "Next morning", custom: "Custom" });

export function ccPanelWindowText(window, { today = "" } = {}) {
  if (!window) return "";
  const range = { date: window.date, from: window.from, to: window.to };
  if (window.kind === "custom") return `${ccShortDay(window.date)}, ${window.from}–${window.to}`;
  return `${CC_WINDOW_LABELS[window.kind] || "Window"}, ${ccWindowWords(range, { today })}`;
}

// The client's own check before a send (the server stays the judge).
export function ccWindowFieldError(ev, window) {
  const range = ccQuestionWindowRange(ev, window);
  if (!range.error) return "";
  if (window.kind === "after_event") return "The event ends too late to ask after it the same day. Choose Next morning or Custom.";
  if (window.kind === "custom") {
    if (!DATE.test(window.date || "") || window.date < ev.day || window.date > ccAddDays(ev.endDay || ev.day, 1)) return "Choose one of the event's days or the day after.";
    if (!TIME.test(window.from || "") || !TIME.test(window.to || "")) return "Choose both times.";
    return `The end time must be after the start time. ${CC_ONE_DAY}`;
  }
  return "This time to ask doesn't fit the event.";
}

// The window on the wire: only a custom one carries its date and times.
export function ccWindowWire(window) {
  if (window.kind === "custom") return { kind: "custom", date: window.date, from: window.from, to: window.to };
  return { kind: window.kind };
}

// ---------------------------------------------------------------------------
// The sentences (one plain sentence and one next step; never a code or id)
// ---------------------------------------------------------------------------
export const CC_FORM_QUESTION_TEXT = Object.freeze({
  rpe_from_sessions: "RPE comes from this event's linked trainings. Untick RPE, or unlink the trainings first.",
  rpe_already_linked: "This event already collects RPE through another request. Untick RPE.",
  rpe_from_question: "This event already asks athletes for RPE. Remove that question first.",
  wellness_already_scheduled: "Today's WELLNESS already covers this day. Untick WELLNESS, or choose another day.",
  wellness_not_available: "The WELLNESS check-in isn't available right now. Untick WELLNESS to save.",
  questions_answered: "Athletes have already answered this event's questions, so its day, time and athletes can't change. Keep them, or remove the answered questions first.",
  question_already_asked: "This event already asks this question. The event was read again.",
  window_one_day: "Answers can be collected within one day for now. Choose an end time after the start time.",
  invalid_window: "This time to ask doesn't fit the event. Choose Next morning or Custom.",
  invalid_question: "Nothing was saved. Try again.",
  no_athletes: "Nobody on this event can be asked on that day. Check the event's athletes, or untick the questions.",
  questions_off: "Questions for athletes are not turned on for this club.",
  rpe_already_answered: "Athletes have already answered this event's RPE. Remove the session link or keep the event's own RPE.",
});

export const CC_PANEL_QUESTION_TEXT = Object.freeze({
  questions_answered: "Athletes have already answered, so this time can't change. Use Stop question to end it.",
  rpe_from_sessions: "RPE comes from the linked trainings, so it can't be asked here.",
  rpe_already_linked: "This event already collects RPE through another request.",
  rpe_from_question: "This event already asks athletes for RPE.",
  wellness_already_scheduled: "Today's WELLNESS already covers this day. Choose another day.",
  wellness_not_available: "The WELLNESS check-in isn't available right now.",
  question_already_asked: "This question is already asked. The event was read again.",
  window_one_day: "Answers can be collected within one day for now. Choose an end time after the start time.",
  invalid_window: "This time doesn't fit the event. Choose another one.",
  no_athletes: "Nobody on this event can be asked on that day.",
  questions_off: "Questions for athletes are not turned on for this club.",
  event_changed: "This event was changed meanwhile. The calendar was read again: try again.",
  event_cancelled: "This event is cancelled, so nothing can be asked.",
  try_again: "The calendar is busy. Nothing was saved; try again in a moment.",
  request_key_reused: "This could not be sent. Nothing was saved; try again.",
});

// The codes a Check result may settle on: given after the request record (the
// question commands run in the event's runner) or by the body's own checks.
export const CC_QUESTION_SETTLED_CODES = Object.freeze([
  "questions_off", "rpe_from_sessions", "rpe_already_linked", "rpe_from_question", "wellness_already_scheduled", "wellness_not_available",
  "question_already_asked", "questions_answered", "no_athletes", "invalid_window", "window_one_day", "invalid_question", "rpe_already_answered",
]);

// ---------------------------------------------------------------------------
// The form's question state
// ---------------------------------------------------------------------------
const pick = (on, window = { kind: "after_event" }) => ({ on, window: { kind: window.kind, date: window.date || "", from: window.from || "", to: window.to || "" } });

// A new event: the type's questions ticked, After the event.
export function ccNewFormQuestions(type) {
  const defaults = Array.isArray(type?.defaultQuestions) ? type.defaultQuestions : [];
  return {
    available: true, touched: false, liveRead: "none", live: [], answered: {}, confirmClose: false,
    picks: Object.fromEntries(CC_QUESTION_KINDS.map((kind) => [kind, pick(defaults.includes(kind))])),
    base: null,
  };
}

// A type chosen on a new event: its questions, while the coach has not
// touched the section.
export function ccApplyTypeQuestions(questions, type) {
  if (!questions || questions.touched || questions.base) return;
  const defaults = Array.isArray(type?.defaultQuestions) ? type.defaultQuestions : [];
  for (const kind of CC_QUESTION_KINDS) questions.picks[kind] = pick(defaults.includes(kind));
}

// An edit: the event's live questions as GET .../questions gives them.
export function ccEditFormQuestions(read) {
  const live = (read?.questions || []).filter((q) => q.status === "live");
  const questions = {
    available: true, touched: false, liveRead: "ok", live, confirmClose: false,
    answered: Object.fromEntries(live.map((q) => [q.kind, q.counts?.answered || 0])),
    picks: Object.fromEntries(CC_QUESTION_KINDS.map((kind) => {
      const q = live.find((entry) => entry.kind === kind);
      return [kind, q ? pick(true, q.window) : pick(false)];
    })),
  };
  questions.base = JSON.parse(JSON.stringify(questions.picks));
  return questions;
}

export function ccQuestionsChanged(questions) {
  if (!questions?.base) return Boolean(questions?.touched);
  return JSON.stringify(questions.picks) !== JSON.stringify(questions.base);
}

// The answered questions this save would close early (unticked).
export function ccQuestionsClosingEarly(questions) {
  if (!questions?.base) return [];
  return CC_QUESTION_KINDS.filter((kind) => questions.base[kind]?.on && !questions.picks[kind]?.on && (questions.answered[kind] || 0) > 0);
}

// What the request carries: `questions` only when the section is shown and
// the coach changed it (an untouched create lets the server ask the type's
// defaults; an untouched edit leaves the live questions as they are).
export function ccQuestionsRequest(questions, ev, { create }) {
  if (!questions?.available) return { errors: {}, part: {} };
  const changed = create ? questions.touched : ccQuestionsChanged(questions);
  if (!changed) return { errors: {}, part: {} };
  const errors = {};
  const list = [];
  for (const kind of CC_QUESTION_KINDS) {
    const p = questions.picks[kind];
    if (!p.on) continue;
    // An answered question that stays keeps its window as it is.
    const locked = !create && (questions.answered[kind] || 0) > 0;
    const error = locked ? "" : ccWindowFieldError(ev, p.window);
    if (error) errors[`question:${kind}`] = error;
    list.push({ kind, window: ccWindowWire(p.window) });
  }
  return { errors, part: Object.keys(errors).length ? null : { questions: list } };
}

// ---------------------------------------------------------------------------
// The event panel's section "Questions for athletes" (contract section 4)
// ---------------------------------------------------------------------------
const STATUS_WORDS = Object.freeze({
  closed_early: "Closed early — the answers given stay.",
  event_cancelled: "Event cancelled — the answers given stay.",
});

// The event's facts from its card (the span is the event's days).
export function ccQuestionEventOfCard(item) {
  return ccQuestionEventOf({ day: item?.span?.from || item?.date, endDay: item?.span?.to || "", startTime: item?.startTime, endTime: item?.endTime });
}

// Whether the section offers Ask for a kind now: its read done (not loading,
// failed or hidden), the event not cancelled, the kind not live, and for RPE no
// other channel (linked trainings, or the event's own RPE request).
export function ccPanelAskOffered(item, pq, kind, { rpeFromSessions = false, rpeFromRequest = false } = {}) {
  if (!pq || pq.key !== item?.key || pq.loading || pq.error || pq.hidden || !pq.read || item.cancelled) return false;
  if (ccPanelQuestionList(pq.read).some((q) => q.kind === kind && q.status === "live")) return false;
  return kind !== "rpe" || (!rpeFromSessions && !rpeFromRequest);
}

// The questions in their order (RPE first), the live and the ended ones the
// read names.
export function ccPanelQuestionList(read) {
  const list = Array.isArray(read?.questions) ? read.questions : [];
  return CC_QUESTION_KINDS.flatMap((kind) => list.filter((q) => q.kind === kind));
}

export function ccRemoveStepText(question) {
  const word = CC_QUESTION_WORDS[question.kind] || "";
  const answered = Number(question.counts?.answered) || 0;
  if (!answered) return { text: `Remove the ${word} question? Athletes won't be asked.`, button: "Remove question" };
  return { text: `Stop the ${word} question? ${answered} ${answered === 1 ? "answer is" : "answers are"} kept; nobody else can answer.`, button: "Stop question" };
}

export function ccQuestionDoneText(act, { kind = "", closed = false } = {}) {
  if (act === "question-ask") return `${CC_QUESTION_WORDS[kind] || "The question"} asked. Athletes will be notified.`;
  if (act === "question-move") return "Time moved. Athletes will be notified.";
  const word = CC_QUESTION_WORDS[kind] || "The";
  return closed ? `${word} question stopped.` : `${word} question removed.`;
}

export function ccPanelRefusalText(info, act = "") {
  if (info.status === 401) return "Please sign in again. Nothing was saved.";
  if (info.status === 404) return act === "question-ask" ? "Questions can't be asked for this event now. Nothing was saved." : "This question isn't available any more.";
  if (info.status === 403) return "Events cannot be changed in this workspace. Nothing was saved.";
  return CC_PANEL_QUESTION_TEXT[info.code] || "Nothing was saved. Try again.";
}

// The refusals after which the event and its questions are read again.
const PANEL_REREAD = new Set(["question_already_asked", "event_changed", "event_cancelled", "questions_off", "questions_answered", "rpe_from_sessions", "rpe_already_linked", "rpe_from_question"]);
export const ccPanelRefusalRereads = (info) => info.status === 404 || PANEL_REREAD.has(info.code);
// The refusals that keep the open step, so another time can be chosen.
const KEEP_STEP = new Set(["window_one_day", "invalid_window", "wellness_already_scheduled", "no_athletes", "try_again", "request_key_reused"]);
export const ccPanelRefusalKeepsStep = (info) => KEEP_STEP.has(info.code);

// Check result: settled only by an answer the server gives after its request
// record (as the event's writes); anything else stays not confirmed.
export function ccQuestionCheckSettles(info, settles) {
  return info.status >= 400 && info.status < 500 && (settles(info) || String(info.code || "").startsWith("invalid_"));
}

function windowChoiceHtml(step, ev, today) {
  const name = `ccQuestionStepWindow-${step.act}`;
  const choices = CC_WINDOW_KINDS.map((wk) => {
    const range = wk === "custom" ? null : ccQuestionWindowRange(ev, { kind: wk });
    const quiet = wk === "custom" ? "" : range?.error ? "Doesn't fit this event" : ccWindowWords(range, { today });
    return `<label class="cc-question-choice"><input type="radio" name="${name}" value="${wk}"${step.window.kind === wk ? " checked" : ""} data-cc-qstep-window="1"><span>${escapeHtml(CC_WINDOW_LABELS[wk])}${quiet ? ` <span class="cc-check-note">${escapeHtml(quiet)}</span>` : ""}</span></label>`;
  }).join("");
  const last = ev.endDay && ev.endDay >= ev.day ? ev.endDay : ev.day;
  const custom = step.window.kind === "custom"
    ? `<div class="cc-question-custom">
        <label class="cc-field" for="ccQuestionStep-date"><span class="cc-field-label">Day</span><input id="ccQuestionStep-date" type="date" value="${escapeAttr(step.window.date)}"${ev.day ? ` min="${escapeAttr(ev.day)}" max="${escapeAttr(ccAddDays(last, 1))}"` : ""} data-cc-qstep-part="date"></label>
        <label class="cc-field" for="ccQuestionStep-from"><span class="cc-field-label">From</span><input id="ccQuestionStep-from" type="time" value="${escapeAttr(step.window.from)}" data-cc-qstep-part="from"></label>
        <label class="cc-field" for="ccQuestionStep-to"><span class="cc-field-label">To</span><input id="ccQuestionStep-to" type="time" value="${escapeAttr(step.window.to)}" data-cc-qstep-part="to"></label>
        <span class="cc-field-hint">${escapeHtml(CC_ONE_DAY)}</span>
      </div>`
    : "";
  return `<fieldset class="cc-question-when"><legend>When to ask</legend>${choices}${custom}</fieldset>`;
}

const qButton = (act, label, { attrs = "", off = false, primary = false } = {}) =>
  `<button type="button" class="plain-button${primary ? " cc-primary" : ""} cc-panel-button cc-question-button" data-action="central-calendar-question" data-act="${act}"${attrs}${off ? " disabled" : ""}>${escapeHtml(label)}</button>`;

function stepHtml(step, { ev, today, busy, question = null }) {
  const off = busy;
  const error = step.error ? `<p class="cc-field-error" role="alert">${escapeHtml(step.error)}</p>` : "";
  if (step.act === "remove") {
    const words = ccRemoveStepText(question);
    return `<div class="cc-inline-confirm" role="group" aria-labelledby="ccQuestionStepText">
        <p id="ccQuestionStepText">${escapeHtml(words.text)}</p>${error}
        <div class="cc-form-actions">${qButton("send", busy ? "Saving…" : words.button, { off, primary: true })}${qButton("step-cancel", "Keep it", { off })}</div>
      </div>`;
  }
  const send = step.act === "ask" ? "Ask athletes" : "Save time";
  return `<div class="cc-question-step" data-cc-question-step role="group" aria-label="${escapeAttr(step.act === "ask" ? `Ask ${CC_QUESTION_WORDS[step.kind]}` : "Move time")}">
      ${step.act === "ask" ? `<p class="cc-panel-note"><strong>${escapeHtml(CC_QUESTION_WORDS[step.kind])}</strong> — ${escapeHtml(CC_QUESTION_PROMPTS[step.kind])}</p>` : ""}
      ${windowChoiceHtml(step, ev, today)}${error}
      <div class="cc-form-actions">${qButton("send", busy ? "Saving…" : send, { off, primary: true })}${qButton("step-cancel", "Not now", { off })}</div>
    </div>`;
}

// K4b: an RPE answer the athlete changed reads "Changed 21:40" beside the name.
function changedAtText(iso) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "Changed";
  return `Changed ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
function namesHtml(label, people, open) {
  const list = Array.isArray(people) ? people : [];
  const name = (p) => `${escapeHtml(p?.name || "Athlete")}${p?.changed ? ` <span class="cc-question-changed">· ${escapeHtml(changedAtText(p.lastChangedAt))}</span>` : ""}`;
  const body = list.length ? `<ul class="cc-question-names" role="list">${list.map((p) => `<li>${name(p)}</li>`).join("")}</ul>` : `<p class="cc-panel-note">Nobody.</p>`;
  return `<details class="cc-question-list"${open ? " open" : ""}><summary>${escapeHtml(`${label} (${list.length})`)}</summary>${body}</details>`;
}

// `pq`: the panel's read ({ key, loading, error, retry, hidden, read });
// `step`: the open inline step; `busy`: a write of this panel in flight;
// `off`: every control off (a write in flight or not confirmed anywhere);
// `feedback`: this section's line and its Check result (rendered by the view).
// The panel's status line while a question waits for answers (the type's own
// "nothing is expected" would contradict it - the UX review).
export function ccPanelQuestionsWaiting(pq, item) {
  return Boolean(pq && pq.key === item?.key && !pq.hidden && ccPanelQuestionList(pq.read).some((q) => q.status === "live"));
}
export const CC_WAITING_SENTENCE = "Waiting for athletes' answers: see Questions and RPE.";

// `feedbackAt` ({ kind, questionId }): the command the line belongs to - drawn
// in that question's row, else in the row of its kind's live question, else
// beside that kind's Ask; only a line with no such place stays at the top.
// `inSection`: drawn inside the event panel's collapsible Questions section, whose header names it - this heading
// stays only for screen readers and as the focus target after a write.
export function renderCentralCalendarQuestionsHtml(item, pq, { step = null, busy = false, off = false, feedback = "", feedbackAt = null, rpeFromSessions = false, rpeFromRequest = false, today = "", inSection = false } = {}) {
  const head = `<h4 class="${inSection ? "visually-hidden" : "cc-panel-subtitle"}" id="ccQuestionsTitle" tabindex="-1">Questions for athletes</h4>`;
  // A command left not confirmed keeps its Check result here, whatever the read says.
  if (!pq || pq.key !== item.key || pq.hidden) return feedback ? `<section class="cc-panel-questions" aria-labelledby="ccQuestionsTitle">${head}${feedback}</section>` : "";
  if (pq.loading) return `<section class="cc-panel-questions" aria-labelledby="ccQuestionsTitle">${head}${feedback}<p class="cc-panel-note" role="status">Loading the questions…</p></section>`;
  if (pq.error) {
    return `<section class="cc-panel-questions" aria-labelledby="ccQuestionsTitle">${head}${feedback}<p class="cc-panel-note" role="alert">${escapeHtml(pq.error)}</p>${pq.retry === false ? "" : `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-questions-retry">Try again</button>`}</section>`;
  }
  const ev = ccQuestionEventOfCard(item);
  const questions = ccPanelQuestionList(pq.read);
  const liveKinds = new Set(questions.filter((q) => q.status === "live").map((q) => q.kind));
  const askableKinds = item.cancelled ? [] : CC_QUESTION_KINDS.filter((kind) => !liveKinds.has(kind));
  const atRow = feedback && feedbackAt
    ? questions.find((q) => feedbackAt.questionId && q.id === feedbackAt.questionId) || questions.find((q) => q.kind === feedbackAt.kind && q.status === "live") || null
    : null;
  const atAsk = feedback && feedbackAt && !atRow && askableKinds.includes(feedbackAt.kind) ? feedbackAt.kind : "";
  const topFeedback = feedback && !atRow && !atAsk ? feedback : "";
  const rows = questions.map((q) => {
    const c = q.counts || {};
    const asked = Number(c.asked) || 0;
    const answered = Number(c.answered) || 0;
    const all = asked > 0 && answered >= asked;
    const status = STATUS_WORDS[q.status] ? `<p class="cc-panel-note cc-question-status">${escapeHtml(STATUS_WORDS[q.status])}</p>` : "";
    const notAnswered = Array.isArray(q.notAnswered) ? q.notAnswered : [];
    const own = step && step.questionId === q.id ? step : null;
    // An answered question is stopped, not removed: its button says what its step does.
    const buttons = q.status === "live" && !own
      ? `<div class="cc-question-actions">${qButton("move-open", "Move time", { attrs: ` data-question-id="${escapeAttr(q.id)}"`, off: off || Boolean(step) || answered > 0 })}${qButton("remove-open", answered > 0 ? "Stop question" : "Remove question", { attrs: ` data-question-id="${escapeAttr(q.id)}"`, off: off || Boolean(step) })}</div>`
      : "";
    return `<li class="cc-question-row">
        <p class="cc-question-head"><strong>${escapeHtml(CC_QUESTION_WORDS[q.kind] || "")}</strong> · ${escapeHtml(`${answered}/${asked} answered`)}${all ? ' <span class="cc-question-done" aria-label="all answered">✓</span>' : ""}</p>
        <p class="cc-panel-note cc-question-window">${escapeHtml(ccPanelWindowText(q.window, { today }))}</p>
        ${status}
        ${namesHtml("Answered", q.answered, false)}
        ${namesHtml("Later", q.later, false)}
        ${q.status === "live" ? namesHtml("Not answered yet", notAnswered, notAnswered.length > 0) : namesHtml("Did not answer", notAnswered, false)}
        ${q.status === "live" && answered > 0 && !own ? `<p class="cc-field-hint">Athletes have already answered, so the time can't move.</p>` : ""}
        ${atRow === q ? feedback : ""}
        ${buttons}
        ${own ? stepHtml(own, { ev, today, busy, question: q }) : ""}
      </li>`;
  });
  // Each kind's Ask is its own block: a line it sent sits above its button.
  const asks = askableKinds.map((kind) => {
    const line = atAsk === kind ? `<div class="cc-question-ask-feedback">${feedback}</div>` : "";
    const open = step && step.act === "ask" && step.kind === kind;
    let body;
    if (kind === "rpe" && rpeFromSessions) body = `<p class="cc-panel-note">RPE comes from the linked trainings.</p>`;
    else if (kind === "rpe" && rpeFromRequest) body = `<p class="cc-panel-note">RPE comes from the event's RPE request.</p>`;
    else if (open) body = stepHtml(step, { ev, today, busy });
    else body = qButton("ask-open", `Ask ${CC_QUESTION_WORDS[kind]}`, { attrs: ` data-kind="${kind}"`, off: off || Boolean(step) });
    return `<div class="cc-question-ask${open || line ? " is-wide" : ""}">${line}${body}</div>`;
  });
  if (!rows.length && !askableKinds.length && !feedback) return "";
  return `<section class="cc-panel-questions" aria-labelledby="ccQuestionsTitle"${busy ? ' aria-busy="true"' : ""}>
      ${head}
      ${topFeedback}
      ${rows.length ? `<ul class="cc-question-rows" role="list">${rows.join("")}</ul>` : ""}
      ${asks.length ? `<div class="cc-question-asks">${asks.join("")}</div>` : ""}
    </section>`;
}
