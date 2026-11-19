// K2b-2a-3, the athlete's side of *Ask athletes* (docs/ai/central-calendar-k2b2a3-ui-contract.md sections 2, 6 and 7):
// pure template strings for the soft prompt and the card at the top of Home, over state.athleteQuestions. Nothing here
// talks to the server. No id, code or count of anyone else is ever drawn as text: ids live only in data-* attributes.
import { athleteOpenQuestionRows, athleteQuestionsNow, registerAthleteQuestionsPainter } from "./athlete-questions-data.js";
import { state } from "./state.js";
import { addDaysIso, escapeAttr, escapeHtml, localDateIso } from "./utils.js";

export const ATHLETE_QUESTIONS_TITLE_ID = "athleteQuestionsTitle";
export const ATHLETE_QUESTIONS_PROMPT_TITLE_ID = "athleteQuestionsPromptTitle";
export const ATHLETE_QUESTIONS_PROMPT_LEAD_ID = "athleteQuestionsPromptLead";
// The prompt lists at most this many rows; the rest are on Home's card.
export const ATHLETE_QUESTIONS_PROMPT_LIMIT = 3;

// The words of a kind (the coach screens' own lines, K2b-2a-2 contract 3.2).
export function athleteQuestionAsk(kind) {
  return kind === "wellness" ? "How are you feeling?" : "How hard was it?";
}

// "Today", "Tomorrow", "Yesterday", else "Sat 21.11.".
export function athleteQuestionDayWord(iso, today) {
  if (!iso) return "";
  if (iso === today) return "Today";
  if (today && iso === addDaysIso(today, 1)) return "Tomorrow";
  if (today && iso === addDaysIso(today, -1)) return "Yesterday";
  const date = new Date(`${iso}T12:00:00`);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short" }).format(date);
  return `${weekday} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
}

// "Training · Today 17:00".
export function athleteQuestionEventLine(row, today) {
  const when = [athleteQuestionDayWord(row.eventDay, today), row.eventStart].filter(Boolean).join(" ");
  return [row.eventTitle || "Event", when].filter(Boolean).join(" · ");
}

const pad = (n) => String(n).padStart(2, "0");

// The time to answer, in the device's time: "Answer by 23:59 today." / "… tomorrow." / "… on Sun 22.11.";
// under an hour: "Answer in the next 25 minutes.".
export function athleteQuestionDueText(closesAt, now = athleteQuestionsNow()) {
  const closes = new Date(closesAt);
  const left = closes.getTime() - now;
  if (left < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.ceil(left / 60000));
    return `Answer in the next ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  const time = `${pad(closes.getHours())}:${pad(closes.getMinutes())}`;
  const today = localDateIso(new Date(now));
  const day = localDateIso(closes);
  if (day === today) return `Answer by ${time} today.`;
  if (day === addDaysIso(today, 1)) return `Answer by ${time} tomorrow.`;
  // The day word ends with its own full stop ("Sun 22.11.").
  return `Answer by ${time} on ${athleteQuestionDayWord(day, today)}`;
}

// ---------------------------------------------------------------------------
// The prompt (section 2): one question → Answer now / Later; several → one Answer per row and one Later for all.
// The backdrop is a sibling of the sheet, so a click inside the sheet never reaches its action.
// ---------------------------------------------------------------------------
export function renderAthleteQuestionsPromptHtml(rows, now = athleteQuestionsNow()) {
  if (!rows?.length) return "";
  const today = localDateIso(new Date(now));
  const shown = rows.slice(0, ATHLETE_QUESTIONS_PROMPT_LIMIT);
  const more = rows.length - shown.length;
  const single = rows.length === 1;
  const body = single
    ? `
      <p class="athlete-questions-ask" id="${ATHLETE_QUESTIONS_PROMPT_LEAD_ID}">${escapeHtml(athleteQuestionAsk(shown[0].kind))}</p>
      <p class="athlete-questions-event">${escapeHtml(athleteQuestionEventLine(shown[0], today))}</p>
      <p class="athlete-questions-due">${escapeHtml(athleteQuestionDueText(shown[0].closesAt, now))}</p>
      <div class="athlete-questions-actions">
        <button type="button" class="athlete-questions-primary" data-action="athlete-questions-answer" data-question-id="${escapeAttr(shown[0].questionId)}">Answer now</button>
        <button type="button" class="plain-button athlete-questions-later" data-action="athlete-questions-later">Later</button>
      </div>`
    : `
      <p class="athlete-questions-lead" id="${ATHLETE_QUESTIONS_PROMPT_LEAD_ID}">Answer now or later from Home.</p>
      <ul class="athlete-questions-list">
        ${shown.map((row) => rowHtml(row, today, now)).join("")}
      </ul>
      ${more > 0 ? `<p class="muted athlete-questions-more">and ${more} more on Home</p>` : ""}
      <div class="athlete-questions-actions">
        <button type="button" class="plain-button athlete-questions-later" data-action="athlete-questions-later">Later</button>
      </div>`;
  return `
    <div class="athlete-questions-prompt">
      <div class="athlete-questions-backdrop" data-action="athlete-questions-later" aria-hidden="true"></div>
      <section class="athlete-questions-sheet" role="dialog" aria-modal="true" aria-labelledby="${ATHLETE_QUESTIONS_PROMPT_TITLE_ID}" aria-describedby="${ATHLETE_QUESTIONS_PROMPT_LEAD_ID}">
        <h2 class="athlete-questions-title" id="${ATHLETE_QUESTIONS_PROMPT_TITLE_ID}">${single ? "Your coach has a question" : `Your coach has ${rows.length} questions`}</h2>
        ${body}
      </section>
    </div>
  `;
}

function rowHtml(row, today, now) {
  const ask = athleteQuestionAsk(row.kind);
  const event = athleteQuestionEventLine(row, today);
  return `
    <li class="athlete-questions-row">
      <div class="athlete-questions-row-text">
        <p class="athlete-questions-ask">${escapeHtml(ask)}</p>
        <p class="athlete-questions-event">${escapeHtml(event)}</p>
        <p class="athlete-questions-due">${escapeHtml(athleteQuestionDueText(row.closesAt, now))}</p>
      </div>
      <button type="button" class="athlete-questions-answer" data-action="athlete-questions-answer" data-question-id="${escapeAttr(row.questionId)}" aria-label="${escapeAttr(`Answer: ${ask} ${event}`)}">Answer</button>
    </li>`;
}

// ---------------------------------------------------------------------------
// The card at the top of Home (section 6): every open question, one Answer each; the notice line above them.
// ---------------------------------------------------------------------------
export function renderAthleteQuestionsCardHtml(slice = state.athleteQuestions, now = athleteQuestionsNow()) {
  const rows = slice?.status === "ready" ? athleteOpenQuestionRows(slice.rows, now) : [];
  const notice = slice?.notice || "";
  if (!rows.length && !notice) return "";
  const today = localDateIso(new Date(now));
  return `
    <section class="panel athlete-questions-card"${rows.length ? ` aria-labelledby="${ATHLETE_QUESTIONS_TITLE_ID}"` : ""}>
      ${notice ? `<p class="athlete-questions-notice" role="status">${escapeHtml(notice)}</p>` : ""}
      ${rows.length ? `
        <h3 class="athlete-questions-card-title" id="${ATHLETE_QUESTIONS_TITLE_ID}" tabindex="-1">Questions from your coach</h3>
        <ul class="athlete-questions-list">
          ${rows.map((row) => rowHtml(row, today, now)).join("")}
        </ul>` : ""}
    </section>
  `;
}

// The minute's tick (athlete-questions-data.js) replaces only the card, in place; a focused Answer keeps the focus on
// the same question's button, or the card's title when that row has gone. Without the card on the page: nothing.
export function repaintAthleteQuestionsCard(doc = globalThis.document) {
  const card = doc?.querySelector?.("section.athlete-questions-card");
  if (!card) return false;
  const active = doc.activeElement;
  const inside = Boolean(active && card.contains(active));
  const focusQuestion = inside ? active.getAttribute("data-question-id") : null;
  const template = doc.createElement("template");
  template.innerHTML = renderAthleteQuestionsCardHtml().trim();
  const next = template.content.firstElementChild;
  if (next) card.replaceWith(next);
  else card.remove();
  if (!inside) return true;
  const target = (focusQuestion && [...(next?.querySelectorAll("[data-question-id]") || [])].find((el) => el.getAttribute("data-question-id") === focusQuestion))
    || next?.querySelector(`#${ATHLETE_QUESTIONS_TITLE_ID}`)
    || doc.querySelector(".athlete-home-header h3");
  target?.focus?.();
  return true;
}
registerAthleteQuestionsPainter(() => repaintAthleteQuestionsCard());
