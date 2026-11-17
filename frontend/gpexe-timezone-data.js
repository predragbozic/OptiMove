// Imports: the team's session time zone, set from the review of a session whose GPS units report more than one time zone
// (mixed_timezones). Over the routes of PR #587: GET / PUT /api/training-load/gpexe/teams/:teamId/session-timezone.
// Offered only to a viewer the status marks with viewer.sessionTimezoneAdmin (a platform admin; the team's club admin in
// the club's workspace); the server decides again on every request. Settings > Data sources keeps its own form for a
// platform admin (data-sources-*.js).
//
// A save has three outcomes: saved (an answer), not saved (a coded refusal), or not confirmed (no answer, an uncoded 5xx).
// Not confirmed is never shown as "not saved": Check reads the zone again (a read only, it never sends the save again).
import { api } from "./api.js";
import { state } from "./state.js";

const BASE = "/api/training-load/gpexe/teams";
export const TIMEZONE_REASON_MAX = 500;
// A request still open after this is a lost answer (a stalled phone connection never settles on its own).
let requestBoundMs = 45_000;
export function setTimezoneBoundForTests(ms) {
  requestBoundMs = ms;
}
function bounded(options = {}) {
  const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(requestBoundMs) : undefined;
  return signal ? { ...options, signal } : options;
}

const g = () => state.trainingLoad.gpexe;
const path = (teamId) => `${BASE}/${encodeURIComponent(teamId)}/session-timezone`;

function errorInfo(error) {
  return { status: error?.status ?? 0, code: error?.data?.error || "", message: error?.data?.message || "" };
}

// "Nothing was saved" only for the refusals the route itself gives before any write (PR #587), and the pool's busy answer.
// Every other answer - no answer, a gateway, ANY other 5xx (the global handler's own 500 has a code too: a COMMIT whose
// answer was lost lands there) - may have saved, so it is not confirmed (code review).
function definiteRefusal(info) {
  if (info.status === 400) return info.code === "reason_required" || info.code === "invalid_timezone";
  if (info.status === 409) return info.code === "gpexe_change_busy";
  if (info.status === 403 || info.status === 404) return true;
  return info.status === 503 && info.code === "database_busy";
}

// A write in flight, or a check of a lost answer: the review stays, as for an import or an undo.
export function timezoneBusy(gx = g()) {
  return gx?.tz?.step === "saving" || gx?.tz?.step === "checking";
}
// What the screen must not drop: a write in flight or its outcome not confirmed (team change, leaving the page).
export function timezoneHeld(gx = g()) {
  return timezoneBusy(gx) || gx?.tz?.step === "unknown";
}
// The zone is known to be set (read, or saved here): every such session of the team needs only a new search.
export function timezoneSet(gx = g()) {
  const tz = timezoneFor(gx);
  return Boolean(tz && (tz.step === "saved" || tz.step === "known"));
}

export function timezoneAdmin(gx = g()) {
  return gx?.status?.viewer?.sessionTimezoneAdmin === true;
}

// The form of the open review's team, or null (another team's form is never shown).
export function timezoneFor(gx = g()) {
  return gx?.tz && gx.tz.teamId === gx.teamId ? gx.tz : null;
}

// Cancel: the form closes; a zone already set stays shown as set.
export function closeTimezone(gx = g()) {
  const tz = timezoneFor(gx);
  if (!tz || timezoneBusy(gx)) return false;
  if (tz.current) {
    tz.step = "known";
    tz.problem = "";
    tz.error = null;
  } else gx.tz = null;
  return true;
}

// Change a zone that is already set: the form opens on it.
export function changeTimezone(gx = g()) {
  const tz = timezoneFor(gx);
  if (!tz || (tz.step !== "known" && tz.step !== "saved")) return false;
  tz.step = "open";
  tz.timezone = tz.current || "";
  tz.reason = "";
  tz.problem = "";
  tz.error = null;
  return true;
}

// Leaving a review (Close, Next session): what was only being typed goes; a zone known to be set, a write in flight and a
// result not confirmed stay with the team (code review).
export function leaveTimezoneReview(gx = g()) {
  if (gx?.tz && (gx.tz.step === "open" || gx.tz.step === "readFailed")) gx.tz = gx.tz.current ? { ...gx.tz, step: "known", problem: "", error: null } : null;
}

// Opens the form and reads the zone in force (another administrator may have set it since the search).
export async function openTimezone(render, gx = g()) {
  const teamId = gx.teamId;
  if (!teamId || !timezoneAdmin(gx)) return;
  const tz = { teamId, step: "loading", current: null, timezone: "", reason: "", problem: "", error: null, saved: "" };
  gx.tz = tz;
  render();
  try {
    const answer = await api(path(teamId), bounded());
    if (gx.tz !== tz) return;
    tz.current = answer?.sessionTimezone?.current?.timezone || null;
    // Already set (another admin, or before this session was found): she needs only the search (UX review).
    tz.step = tz.current ? "known" : "open";
  } catch (error) {
    if (gx.tz !== tz) return;
    tz.step = "readFailed";
    tz.error = errorInfo(error);
  }
  render();
}

// The typed values stay in state, so a repaint while she types keeps them.
export function handleTimezoneInput(target, gx = g()) {
  if (target?.matches?.("[data-gpexe-tz-zone]")) {
    if (timezoneFor(gx)) gx.tz.timezone = String(target.value ?? "");
    return true;
  }
  if (!target?.matches?.("[data-gpexe-tz-reason]")) return false;
  if (timezoneFor(gx)) gx.tz.reason = String(target.value ?? "");
  return true;
}

// The local check before anything is sent: a zone, and a reason of at most 500 characters.
export function timezoneProblem(tz) {
  if (!String(tz?.timezone || "").trim()) return "Choose a time zone.";
  const reason = String(tz?.reason || "").trim();
  if (!reason) return "Write why, for the record.";
  if (reason.length > TIMEZONE_REASON_MAX) return `The reason is too long (at most ${TIMEZONE_REASON_MAX} characters).`;
  return "";
}

export async function saveTimezone(render, gx = g()) {
  const tz = timezoneFor(gx);
  if (!tz || tz.step !== "open") return;
  tz.problem = timezoneProblem(tz);
  if (tz.problem) {
    render();
    return;
  }
  const timezone = tz.timezone.trim();
  tz.step = "saving";
  tz.error = null;
  render();
  try {
    const answer = await api(path(tz.teamId), bounded({ method: "PUT", body: JSON.stringify({ timezone, reason: tz.reason.trim() }) }));
    if (gx.tz !== tz) return;
    // A save confirmed by the server stays saved even when its details could not be read back (readError).
    tz.saved = answer?.sessionTimezone?.current?.timezone || timezone;
    tz.current = tz.saved;
    tz.step = "saved";
  } catch (error) {
    if (gx.tz !== tz) return;
    const info = errorInfo(error);
    tz.error = info;
    tz.step = definiteRefusal(info) ? "open" : "unknown";
  }
  render();
}

// After a lost answer: read the zone again. The save is never sent again from here.
export async function checkTimezone(render, gx = g()) {
  const tz = timezoneFor(gx);
  if (!tz || tz.step !== "unknown") return;
  tz.step = "checking";
  render();
  try {
    const answer = await api(path(tz.teamId), bounded());
    if (gx.tz !== tz) return;
    const current = answer?.sessionTimezone?.current?.timezone || null;
    tz.current = current;
    if (current && current === tz.timezone.trim()) {
      tz.saved = current;
      tz.step = "saved";
      tz.error = null;
    } else {
      tz.step = "open";
      tz.error = { status: 0, code: "not_saved_after_check", message: "" };
    }
  } catch {
    if (gx.tz !== tz) return;
    tz.step = "unknown";
  }
  render();
}
