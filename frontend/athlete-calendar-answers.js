// K4b on the athlete's Calendar (docs/ai/central-calendar-k4b-contract.md, the stream manager's Q-A of 2026-11-20):
// her own RPE answers of the shown week, for the line "Your RPE: 7 · Change" on her "RPE request" card.
//
// The calendar's own answer carries no value, no close time and no "changeable" (the athlete's card allowlist), so the
// week's GET /api/training-load/weekly - her own athlete-workspace read, the one the weekly sheet already uses - is read
// beside it, and only its scheduled_external rows that carry an answer are kept, by their externalAssignmentId. A card
// gets the line only when this read returned a row for its assignment: an id on the page alone never opens anything.
//
// Rules (the manager's conditions): no new route or field; a failed read hides only the line (the card keeps "RPE
// given"); a slower answer of an older read or another week is dropped (a generation counter); a workspace switch or a
// sign-out clears it (resetAthleteCalendarAnswers, from resetAthleteCalendar).
import { api } from "./api.js";

let answers = { weekStart: "", rows: new Map() };
let generation = 0;
let pending = Promise.resolve();

// The last started read, settled (never rejects): a confirmed answer awaits it so the line is fresh.
export function athleteCalendarAnswersSettled() {
  return pending;
}

const text = (value) => (typeof value === "string" ? value : "");

// One row of the weekly read, reduced to what the line and the change form use.
function answerRow(session, date) {
  const f = session?.feedback;
  if (!f || session.source !== "scheduled_external" || !session.rated || !session.externalAssignmentId) return null;
  return {
    externalAssignmentId: String(session.externalAssignmentId),
    source: "scheduled_external",
    rated: true,
    sessionName: text(session.sessionName),
    date: text(date),
    feedback: { rpe: f.rpe, durationMinutes: f.durationMinutes, srpe: f.srpe, note: text(f.note), submittedAt: f.submittedAt || "" },
    changeable: session.changeable === true,
    revision: Number(session.revision) || 0,
    closesAt: text(session.closesAt),
  };
}

export function athleteCalendarAnswerRows(weekly) {
  const rows = new Map();
  for (const day of Array.isArray(weekly?.days) ? weekly.days : []) {
    for (const session of Array.isArray(day?.sessions) ? day.sessions : []) {
      const row = answerRow(session, day.date);
      if (row) rows.set(row.externalAssignmentId, row);
    }
  }
  return rows;
}

// Her answer for an "RPE request" card of the shown week, or null.
export function athleteCalendarAnswerFor(assignmentId, weekStart) {
  if (!assignmentId || !weekStart || answers.weekStart !== weekStart) return null;
  return answers.rows.get(String(assignmentId)) || null;
}

export function resetAthleteCalendarAnswers() {
  generation += 1;
  answers = { weekStart: "", rows: new Map() };
}

// Reads the week of `weekStart` (a Monday). Never throws: a failure only empties the week's rows.
export function loadAthleteCalendarAnswers({ weekStart, render } = {}) {
  pending = readAnswers({ weekStart, render });
  return pending;
}

const signature = (state) => `${state.weekStart}|${JSON.stringify([...state.rows.entries()])}`;

async function readAnswers({ weekStart, render }) {
  const run = ++generation;
  if (answers.weekStart !== weekStart) answers = { weekStart, rows: new Map() };
  const before = signature(answers);
  try {
    const weekly = await api(`/api/training-load/weekly?weekStart=${encodeURIComponent(weekStart)}`);
    if (run !== generation) return;
    answers = { weekStart, rows: athleteCalendarAnswerRows(weekly) };
  } catch {
    if (run !== generation) return;
    answers = { weekStart, rows: new Map() };
  }
  // Paints only when her lines changed: the calendar's own read paints the cards, and a repaint that changes nothing
  // would only replace the page under her finger.
  if (signature(answers) !== before) render?.();
}
