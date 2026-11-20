// K4b: the athlete changes their own RPE answer while the question is open
// (contract docs/ai/central-calendar-k4b-contract.md, section 6; mockup
// docs/design/calendar-k4/05-k4b-change-rpe.html). The pieces the Training
// Load views and actions share: the answer line on a rated row and on Home,
// the change form's state, and what each answer of
// POST /api/training-load/external-assignments/:id/rpe/change does to it.
// The server decides (training_load.change_external_rpe); `changeable` is only
// its display hint.
import { escapeAttr, escapeHtml, localDateIso } from "./utils.js";

export const RPE_CHANGE_UNCONFIRMED = "We can't tell yet whether your change was saved.";
export const RPE_CHANGE_LOCKED = "This answer can no longer be changed. The question is closed.";
export const RPE_CHANGE_BUSY = "Nothing was saved. Try again.";
export const RPE_CHANGE_NOT_FOUND = "This RPE request is no longer available.";
export const RPE_CHANGE_COACH_SEES = "Your coach sees that it was changed.";

const pad = (n) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// "22:00" on the device's today, "Sun 22:00" on another day.
export function rpeChangeTimeText(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return localDateIso(at) === localDateIso(now) ? time : `${WEEKDAYS[at.getDay()]} ${time}`;
}

// The closed line's time: "at 22:00" on the device's today, "on 12.10 at 22:00" on another day (a past week's card
// names its date, never a weekday that could be read as the next one).
export function rpeClosedTimeText(iso, now = new Date()) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return localDateIso(at) === localDateIso(now) ? `at ${time}` : `on ${pad(at.getDate())}.${pad(at.getMonth() + 1)} at ${time}`;
}

function isExternalRated(session) {
  return Boolean(session?.rated && session.source === "scheduled_external" && session.externalAssignmentId && session.feedback);
}

// The answer line of a rated external row: "Your RPE: 7 · Change" with the
// deadline while it may change; "Your RPE: 7 · Answers closed at 22:00." (on
// another day "closed on 12.10 at 22:00.") once the window has passed; "" for
// every other row (the caller keeps its own
// summary).
// `action`: the button's data-action (the Calendar's own, which opens the form from its own read; extra: its dataset).
export function renderRpeAnswerLineHtml(session, { now = new Date(), action = "training-load-rpe-change-open", extra = "" } = {}) {
  if (!isExternalRated(session)) return "";
  const rpe = escapeHtml(String(session.feedback.rpe));
  if (session.changeable) {
    const until = rpeChangeTimeText(session.closesAt, now);
    return `<div class="training-load-rpe-answer">
        <span class="training-load-rpe-answer-value">Your RPE: ${rpe}</span>
        <button type="button" class="plain-button compact-button training-load-rpe-change" data-action="${escapeAttr(action)}" data-assignment-id="${escapeAttr(session.externalAssignmentId)}"${extra} aria-label="${escapeAttr(`Change your RPE, ${session.sessionName || "session"}`)}">Change</button>
        ${until ? `<span class="muted training-load-rpe-answer-until">You can change it until ${escapeHtml(until)}.</span>` : ""}
      </div>`;
  }
  const closes = session.closesAt ? new Date(session.closesAt) : null;
  if (closes && !Number.isNaN(closes.getTime()) && closes.getTime() <= now.getTime()) {
    return `<div class="training-load-rpe-answer"><span class="training-load-rpe-answer-value">Your RPE: ${rpe}</span> <span class="muted">· Answers closed ${escapeHtml(rpeClosedTimeText(session.closesAt, now))}.</span></div>`;
  }
  return "";
}

// Home: today's answers the athlete may still change (mockup step 2).
export function renderRpeAnswerChangeHomeHtml(athleteToday, { now = new Date() } = {}) {
  const rows = (athleteToday?.sessions || []).filter((s) => isExternalRated(s) && s.changeable);
  if (!rows.length) return "";
  return `<section class="panel training-load-home-answers" aria-label="Your answers today">
      <p class="eyebrow">Your answers today</p>
      ${rows.map((s) => `<div class="training-load-home-answer">
          <p class="training-load-home-answer-name">${escapeHtml(s.sessionName || "Session")}</p>
          ${renderRpeAnswerLineHtml(s, { now })}
        </div>`).join("")}
    </section>`;
}

// The change form's own fields, on top of emptyRpeForm()'s.
export function rpeChangeFormFields(session) {
  const f = session.feedback || {};
  return {
    mode: "change",
    rpe: Number(f.rpe),
    durationMinutes: Number(f.durationMinutes),
    note: f.note || "",
    original: { rpe: Number(f.rpe), durationMinutes: Number(f.durationMinutes), note: f.note || "", submittedAt: f.submittedAt || "" },
    expectedRevision: Number(session.revision ?? f.revision ?? 0),
    closesAt: session.closesAt || "",
    requestKey: "",
    unconfirmed: false,
    locked: false,
  };
}

// Nothing differs from the saved answer (the note compared after the trim the server makes).
export function rpeChangeIsUnchanged(form) {
  const o = form?.original;
  if (!o) return false;
  return Number(form.rpe) === o.rpe && Number(form.durationMinutes) === o.durationMinutes && String(form.note || "").trim() === String(o.note || "").trim();
}

// The request body; a result not confirmed sends the same key again (Check result).
export function rpeChangeRequestBody(form, newKey) {
  if (!form.unconfirmed || !form.requestKey) form.requestKey = newKey();
  return {
    requestKey: form.requestKey,
    rpe: form.rpe,
    durationMinutes: Number(form.durationMinutes),
    note: String(form.note || "").trim(),
    expectedRevision: form.expectedRevision,
  };
}

function refill(form, feedback) {
  if (!feedback) return;
  form.rpe = Number(feedback.rpe);
  form.durationMinutes = Number(feedback.durationMinutes);
  form.note = feedback.note || "";
  form.original = { rpe: Number(feedback.rpe), durationMinutes: Number(feedback.durationMinutes), note: feedback.note || "", submittedAt: feedback.submittedAt || form.original?.submittedAt || "" };
  form.expectedRevision = Number(feedback.revision ?? form.expectedRevision ?? 0);
  if (feedback.closesAt) form.closesAt = feedback.closesAt;
}

// What an answer does to the form. Returns "saved", "unchanged", "locked", "kept"
// (the form stays with a sentence) or "unconfirmed".
export function applyRpeChangeAnswer(form, { result = null, error = null } = {}) {
  form.saving = false;
  if (result) {
    form.unconfirmed = false;
    form.requestKey = "";
    if (result.outcome === "unchanged") return "unchanged";
    form.savedFeedback = result.feedback;
    form.error = "";
    return "saved";
  }
  const status = error?.status;
  const data = error?.data || {};
  if (status === 409 && data.error === "answer_locked") {
    form.unconfirmed = false;
    form.requestKey = "";
    form.locked = true;
    form.error = RPE_CHANGE_LOCKED;
    if (data.feedback) refill(form, data.feedback);
    return "locked";
  }
  if (status === 409 && data.error === "answer_changed") {
    form.unconfirmed = false;
    form.requestKey = "";
    refill(form, data.feedback);
    form.error = data.message || "Your answer was changed on another screen. Check it and try again.";
    return "kept";
  }
  if (status === 404) {
    form.unconfirmed = false;
    form.requestKey = "";
    form.locked = true;
    form.error = RPE_CHANGE_NOT_FOUND;
    return "locked";
  }
  if (status === 409 && data.error === "try_again") {
    // A Check result that met a busy server says nothing about the first attempt, which may still commit: it stays
    // not confirmed, with the same key. Only a first attempt refused as busy saved nothing.
    if (form.unconfirmed) {
      form.error = RPE_CHANGE_UNCONFIRMED;
      return "unconfirmed";
    }
    form.requestKey = "";
    form.error = RPE_CHANGE_BUSY;
    return "kept";
  }
  if (status === 400 || (status === 409 && data.error === "request_key_reused") || (status === 409 && data.error === "not_answered")) {
    form.unconfirmed = false;
    form.requestKey = "";
    form.error = data.message || "Nothing was saved.";
    return "kept";
  }
  // No answer, a 5xx, outcome_unknown: never "nothing was saved". Check result repeats the same key.
  form.unconfirmed = true;
  form.error = RPE_CHANGE_UNCONFIRMED;
  return "unconfirmed";
}
