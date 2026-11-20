// The athlete's Calendar (K4a, docs/ai/central-calendar-k4a-contract.md section 2, mockup 04): pure template strings
// over the slice of athlete-calendar-data.js. The head ("12 – 18 Oct" with the arrows and Today), on a phone the strip
// of the week's seven days, then the days that have something, each with its cards. Nothing here talks to the server.
import { athleteCalendarDayLabel, athleteCalendarDays, athleteCalendarShortWeekday, athleteCalendarWeek, athleteCalendarWeekLabel } from "./athlete-calendar-data.js";
import { renderCentralCalendarEventPlaceHtml } from "./central-calendar-event-details.js";
import { centralCalendarItemColorIndex, centralCalendarItemIconKey } from "./central-calendar-view.js";
import { renderIconSvg } from "./icon-render.js";
import { escapeAttr, escapeHtml, localDateIso, weekMondayIso } from "./utils.js";
import { athleteCalendarAnswerFor } from "./athlete-calendar-answers.js";
import { renderRpeAnswerLineHtml } from "./rpe-answer-change.js";

// An event wears its type's colour (the calendar's palette); her own plan the plan colour.
function stripeStyle(card) {
  if (card.kind !== "event") return "";
  const index = centralCalendarItemColorIndex({ kind: "event", eventTypeColorKey: card.eventTypeColorKey });
  return index < 0 ? "" : ` style="--ac-stripe: var(--cc-team-${index})"`;
}

function iconHtml(card) {
  const key = centralCalendarItemIconKey({ kind: card.kind, eventKind: card.eventKind, eventTypeIconKey: card.eventTypeIconKey });
  return `<span class="ac-card-icon">${renderIconSvg(key, { size: 18 })}</span>`;
}

function sessionsHtml(card) {
  if (!card.sessions.length) return "";
  return `<ul class="ac-sessions" role="list">${card.sessions.map((s) => `<li>${s.slot ? `<span class="ac-session-slot">${escapeHtml(s.slot)}</span> ` : ""}<span class="ac-session-text"><b>${escapeHtml(s.title)}</b>${s.time ? ` <span class="ac-muted">· ${escapeHtml(s.time)}</span>` : ""}</span></li>`).join("")}</ul>`;
}

function buttonHtml(button, card) {
  const data = [
    `data-action="athlete-calendar-card"`, `data-ac-action="${escapeAttr(button.action)}"`, `data-key="${escapeAttr(card.key)}"`, `data-date="${escapeAttr(card.date)}"`,
    `data-title="${escapeAttr(card.title || "")}"`,
    button.questionId ? `data-question-id="${escapeAttr(button.questionId)}"` : "",
    button.sessionId ? `data-session-id="${escapeAttr(button.sessionId)}"` : "",
    button.assignmentId ? `data-assignment-id="${escapeAttr(button.assignmentId)}"` : "",
  ].filter(Boolean).join(" ");
  return `<button type="button" class="plain-button ac-button${button.primary ? " cc-primary ac-button-primary" : ""}" ${data} aria-label="${escapeAttr(`${button.label}: ${card.title}`)}">${escapeHtml(button.label)}</button>`;
}

// K4b's room (contract 3): the "your answer" row, the card's last block. K4a writes "RPE given" (no value). K4b, on her
// own "RPE request" card only (Q-A: the card that holds the answer), writes "Your RPE: 7 · Change" while the question is
// open and "Your RPE: 7 · Answers closed at 22:00." once it closed - only from a row her own weekly read returned for
// that assignment (athlete-calendar-answers.js); without one, K4a's "RPE given" stays.
function answerHtml(card, weekStart) {
  if (card.answer !== "rpe-given") return `<div class="ac-answer" data-ac-answer hidden></div>`;
  const row = card.kind === "external" && !card.cancelled ? athleteCalendarAnswerFor(card.assignmentId, weekStart) : null;
  const line = row ? renderRpeAnswerLineHtml({ ...row, sessionName: card.title || row.sessionName }, {
    action: "athlete-calendar-rpe-change", extra: ` data-date="${escapeAttr(card.date)}" data-title="${escapeAttr(card.title || "")}"`,
  }) : "";
  if (line) return `<div class="ac-answer ac-answer-rpe" data-ac-answer>${line}</div>`;
  return `<div class="ac-answer" data-ac-answer><span class="ac-answer-mark" aria-hidden="true">✓</span> RPE given</div>`;
}

export function renderAthleteCalendarCardHtml(card, { weekStart = "" } = {}) {
  const top = [
    iconHtml(card),
    card.when ? `<span class="ac-card-when">${escapeHtml(card.when)}</span>` : "",
    `<span class="ac-card-word">${escapeHtml(card.word || "")}</span>`,
    card.cancelled ? `<span class="cc-badge cc-badge-cancelled"><span aria-hidden="true">✕</span> Cancelled</span>` : "",
  ].join("");
  const place = card.place ? renderCentralCalendarEventPlaceHtml({ place: card.place, location: null }) : "";
  return `<article class="ac-card ac-card-${escapeAttr(card.kind)}${card.cancelled ? " is-cancelled" : ""}" data-key="${escapeAttr(card.key)}"${stripeStyle(card)}>
      <span class="ac-card-stripe" aria-hidden="true"></span>
      <div class="ac-card-body">
        <p class="ac-card-top">${top}</p>
        <p class="ac-card-title">${escapeHtml(card.title || "")}</p>
        ${place}
        ${sessionsHtml(card)}
        ${answerHtml(card, weekStart)}
        ${card.buttons.length ? `<div class="ac-card-actions">${card.buttons.map((button) => buttonHtml(button, card)).join("")}</div>` : ""}
      </div>
    </article>`;
}

function headHtml(slice, today) {
  const week = athleteCalendarWeek(slice.weekStart || today);
  const thisWeek = today >= week.from && today <= week.to;
  return `<div class="ac-head">
      <button type="button" class="plain-button ac-nav-arrow" data-action="athlete-calendar-week" data-delta="-1" aria-label="Previous week">&lsaquo;</button>
      <h3 class="ac-period" aria-live="polite">${escapeHtml(athleteCalendarWeekLabel(week.from))}</h3>
      <button type="button" class="plain-button ac-nav-arrow" data-action="athlete-calendar-week" data-delta="1" aria-label="Next week">&rsaquo;</button>
      <button type="button" class="plain-button ac-today" data-action="athlete-calendar-today"${thisWeek ? ' aria-disabled="true"' : ""}>Today</button>
    </div>`;
}

// Phones (contract 2.6, Q5): the seven days, today highlighted, a dot on a day that has something.
function stripHtml(slice, days, today) {
  const week = athleteCalendarWeek(slice.weekStart || today);
  const busy = new Set(days.map((day) => day.date));
  return `<div class="ac-strip" role="group" aria-label="Days of the week">${week.days.map((date) => {
    const classes = ["ac-strip-day", date === today ? "is-today" : "", date === slice.selectedDate ? "is-selected" : ""].filter(Boolean).join(" ");
    const label = `${athleteCalendarDayLabel(date)}${date === today ? ", today" : ""}${busy.has(date) ? "" : ", nothing planned"}`;
    return `<button type="button" class="${classes}" data-action="athlete-calendar-day" data-date="${escapeAttr(date)}" aria-pressed="${date === slice.selectedDate ? "true" : "false"}"${date === today ? ' aria-current="date"' : ""} aria-label="${escapeAttr(label)}">
        <small>${escapeHtml(athleteCalendarShortWeekday(date))}</small><b>${Number(date.slice(8, 10))}</b><i class="ac-strip-dot${busy.has(date) ? " is-busy" : ""}" aria-hidden="true"></i>
      </button>`;
  }).join("")}</div>`;
}

function bodyHtml(slice, days, today) {
  if (slice.status === "error") {
    return `<div class="ac-state" role="alert"><p>${escapeHtml(slice.error || "The calendar could not be read.")}</p>${slice.canRetry ? `<button type="button" class="plain-button ac-button" data-action="athlete-calendar-retry">Try again</button>` : ""}</div>`;
  }
  if (slice.status !== "ready" || !slice.data) return `<p class="muted ac-state" role="status">Loading calendar…</p>`;
  if (!days.length) {
    const week = athleteCalendarWeek(slice.weekStart || today);
    const other = !(today >= week.from && today <= week.to);
    return `<div class="ac-state ac-empty"><p>Nothing planned this week.</p>${other ? `<button type="button" class="plain-button ac-button" data-action="athlete-calendar-today">Today</button>` : ""}</div>`;
  }
  return `<div class="ac-days">${days.map((day) => `<section class="ac-day" data-ac-day="${escapeAttr(day.date)}" aria-labelledby="ac-day-${escapeAttr(day.date)}">
      <h4 class="ac-day-label" id="ac-day-${escapeAttr(day.date)}"><b>${escapeHtml(day.label)}</b>${day.today ? " · today" : ""}</h4>
      ${day.cards.map((card) => renderAthleteCalendarCardHtml(card, { weekStart: slice.weekStart })).join("")}
    </section>`).join("")}</div>`;
}

// `questions`: her open question rows; `today`: her local date (tests pass it).
export function renderAthleteCalendarHtml(slice, { questions = [], today = localDateIso() } = {}) {
  const days = slice?.status === "ready" ? athleteCalendarDays(slice.data, { from: slice.weekStart, questions, today }) : [];
  return `<section class="athlete-calendar" aria-label="Calendar">
      ${headHtml(slice, today)}
      ${stripHtml(slice, days, today)}
      ${slice?.notice ? (slice.notice === "Your answer was saved." || slice.notice === "Your answer was changed."
        ? `<p class="ac-notice is-saved" role="status"><span aria-hidden="true">✓</span> ${escapeHtml(slice.notice)}</p>`
        : `<p class="ac-notice" role="status">${escapeHtml(slice.notice)}</p>`) : ""}
      ${bodyHtml(slice, days, today)}
    </section>`;
}

// The Weekly plan opened by Open training (contract 2.3, mockup 04 step 2): Back to calendar, beside the day and the
// training's title - the title only while the plan shows that day's week (`shownWeekStart`), never over another week.
export function renderAthleteCalendarBackBarHtml(marker, shownWeekStart = "") {
  if (!marker) return "";
  const where = !shownWeekStart || weekMondayIso(marker.date) === shownWeekStart ? [marker.label, marker.title].filter(Boolean).join(" · ") : "";
  return `<div class="ac-backbar">
      <button type="button" class="plain-button ac-button" data-action="athlete-calendar-back"><span aria-hidden="true">‹</span> Back to calendar</button>
      ${where ? `<span class="ac-muted ac-backbar-where">${escapeHtml(where)}</span>` : ""}
    </div>`;
}
