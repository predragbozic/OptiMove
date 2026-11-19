// K2c-2-F: the Builder's "Make an event" - the press, the day read, the one
// create with its sessions, Check result and the leave guards
// (docs/ai/central-calendar-k2c-plan.md 2.1, with the manager's GO in 2.2).
//
// State: state.builder.calendarEvent, the open panel of one session
//   { sessionId, date, phase: "reading" | "read_error" | "ready" | "sending" | "unconfirmed" | "done",
//     match, types, form, message, requestKey, sentBody, checking, checkNote, doneText, doneNotes, event, forget }
// and state.builder.calendarEventsMade, the in-memory "In calendar" badges.
// A create joins the calendar's memory of unconfirmed saves the moment it is
// sent (rememberCentralCalendarCreate) and leaves it once its answer settles.
// So the calendar's own guards cover it with no question of their own here:
// a sign-out, a reload or a switch into or out of the athlete workspace asks
// (centralCalendarMayBeLeft, its beforeunload and the app-update probe), and a
// switch between clubs or teams keeps it to check later in the calendar, with
// the same body and key. A lost answer stays there.
import { api } from "./api.js";
import {
  builderCalendarEventBody,
  builderCalendarEventCheckSettles,
  builderCalendarEventDoneNotes,
  builderCalendarEventDoneText,
  builderCalendarEventDraft,
  builderCalendarEventFormError,
  builderCalendarDraftHoldsSession,
  builderCalendarEventRefusalText,
  builderCalendarMadeKey,
  builderCalendarMatch,
  builderCalendarTrainingTypes,
  CHECK_STILL_NOT_CONFIRMED,
  REREAD_AFTER,
} from "./builder-calendar-event.js";
import { builderSavesPending, builderSavesSettled } from "./builder-actions.js";
import { centralCalendarUncertainWrites, rememberCentralCalendarCreate } from "./central-calendar-actions.js";
import {
  centralCalendarErrorInfo,
  centralCalendarOutcomeUnknown,
  centralCalendarUrl,
  createCentralCalendarEvent,
  invalidateCentralCalendarCache,
  newCentralCalendarRequestKey,
  readCentralCalendarCatalog,
} from "./central-calendar-data.js";
import { state } from "./state.js";
import { localDateIso } from "./utils.js";

let readGeneration = 0;

export function builderCalendarEventWorkspaceType() {
  return state.currentUser?.activeWorkspace?.type || "";
}

function findSession(sessionId) {
  for (const block of state.builder.draft?.blocks || []) {
    const session = (block.sessions || []).find((value) => value.id === sessionId);
    if (session) return { block, session };
  }
  return null;
}

const current = (rec) => state.builder.calendarEvent === rec;
const locked = (rec) => Boolean(rec && (rec.phase === "sending" || rec.phase === "unconfirmed"));

// After a step, focus goes to the panel's message, else its heading, so a
// phone scrolls to it and a screen reader reads it (mobile review LOW-3).
function focusPanel() {
  const doc = globalThis.document;
  const node = doc?.querySelector?.("[data-cc-builder-event-focus]") || doc?.querySelector?.("[data-cc-builder-event-heading]");
  node?.focus?.({ preventScroll: false });
}

function timezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The day of the session and the workspace's types, read fresh on each press
// (no cache: the answer decides what is offered); a slower answer of an
// earlier press never replaces a newer one.
async function readDay(rec, render) {
  const generation = ++readGeneration;
  rec.readGeneration = generation;
  rec.phase = "reading";
  render?.();
  let answer;
  let catalog;
  try {
    [answer, catalog] = await Promise.all([
      api(centralCalendarUrl(rec.date, rec.date, localDateIso(), { includeAthletes: true })),
      readCentralCalendarCatalog(state.centralCalendar),
    ]);
  } catch {
    answer = null;
  }
  if (!current(rec) || rec.readGeneration !== generation) return;
  const found = findSession(rec.sessionId);
  if (!answer || !catalog || catalog.error || !found) {
    rec.phase = "read_error";
    render?.();
    return;
  }
  rec.types = Array.isArray(catalog.types) ? catalog.types : [];
  rec.match = builderCalendarMatch({ draft: state.builder.draft, block: found.block, session: found.session, answer });
  // A create for this training still in the calendar's memory (sent from a
  // panel a plan change released, its result not confirmed): no form, so no
  // second create with a new key beside it (code review LOW).
  if (rec.match.kind === "planned" && createNotConfirmedFor(rec.match.card)) rec.match = { kind: "pending" };
  if (rec.match.kind === "planned") {
    const fresh = builderCalendarEventDraft({ card: rec.match.card, session: found.session, types: rec.types });
    const training = builderCalendarTrainingTypes(rec.types);
    if (!rec.form) rec.form = fresh;
    else if (!training.some((type) => String(type.id) === String(rec.form.typeId))) rec.form.typeId = fresh.typeId;
  }
  rec.phase = "ready";
  render?.();
  focusPanel();
}

function createNotConfirmedFor(card) {
  const ids = new Set((card?.links?.logicalSessionIds || []).map(String));
  return centralCalendarUncertainWrites().some((write) => write.mode === "create"
    && (write.sentBody?.sessions?.logicalSessionIds || []).some((id) => ids.has(String(id))));
}

// The inputs of the open panel, mirrored into its form (a re-render keeps
// what the coach typed).
export function handleBuilderCalendarEventInput(target) {
  const field = target?.dataset?.builderEventField;
  if (!field) return false;
  const rec = state.builder.calendarEvent;
  if (rec?.form && rec.phase === "ready") rec.form[field] = String(target.value ?? "");
  return true;
}

function collectFields(rec) {
  const nodes = globalThis.document?.querySelectorAll?.("[data-builder-event-field]") || [];
  for (const node of nodes) {
    if (rec.form && node.dataset.builderEventField in rec.form) rec.form[node.dataset.builderEventField] = String(node.value ?? "");
  }
}

async function send(rec, render) {
  if (rec.phase !== "ready" || rec.match?.kind !== "planned") return;
  collectFields(rec);
  const problem = builderCalendarEventFormError(rec.form);
  if (problem) {
    rec.message = problem;
    render?.();
    focusPanel();
    return;
  }
  const type = builderCalendarTrainingTypes(rec.types).find((value) => String(value.id) === String(rec.form.typeId));
  rec.requestKey = newCentralCalendarRequestKey();
  rec.sentBody = builderCalendarEventBody({ form: rec.form, card: rec.match.card, type, day: rec.date, requestKey: rec.requestKey, timezone: timezone() });
  rec.message = "";
  rec.phase = "sending";
  rec.forget = rememberCentralCalendarCreate({ sentBody: rec.sentBody, requestKey: rec.requestKey });
  render?.();
  await deliver(rec, render, { check: false });
}

// One send of the saved body and key: the first one, or Check result.
async function deliver(rec, render, { check }) {
  let answer;
  try {
    answer = await createCentralCalendarEvent(rec.sentBody);
  } catch (error) {
    const info = centralCalendarErrorInfo(error);
    rec.checking = false;
    if (centralCalendarOutcomeUnknown(info) || (check && !builderCalendarEventCheckSettles(info))) {
      rec.phase = "unconfirmed";
      rec.checkNote = check ? CHECK_STILL_NOT_CONFIRMED : "";
      // Still kept in the calendar's memory (since the send).
      if (current(rec)) {
        render?.();
        focusPanel();
      }
      return;
    }
    // A stated refusal: nothing was saved under this key, which is never
    // sent again (the next press makes a new one).
    rec.forget?.();
    rec.forget = null;
    rec.phase = "ready";
    rec.message = builderCalendarEventRefusalText(info);
    rec.offerCalendar = info.code === "session_already_attached";
    if (!current(rec)) return;
    if (info.code === "type_not_available" || info.code === "invalid_type") {
      if (state.centralCalendar) {
        state.centralCalendar.eventTypes = null;
        state.centralCalendar.eventCatalog = null;
      }
    }
    if (REREAD_AFTER.has(info.code) || info.code === "type_not_available" || info.code === "invalid_type") {
      const message = rec.message;
      await readDay(rec, render);
      rec.message = message;
    }
    render?.();
    focusPanel();
    return;
  }
  rec.forget?.();
  rec.forget = null;
  rec.checking = false;
  rec.phase = "done";
  const event = answer?.event || {};
  rec.event = { id: String(event.id || ""), day: String(event.day || rec.sentBody.day).slice(0, 10) };
  rec.doneText = builderCalendarEventDoneText(rec.sentBody.title, rec.sentBody.day);
  rec.doneNotes = builderCalendarEventDoneNotes(answer?.alignment);
  invalidateCentralCalendarCache();
  // The badge only in the Builder this create belongs to (not after a switch).
  if (current(rec) && rec.madeKey && !state.builder.calendarEventsMade?.includes(rec.madeKey)) {
    state.builder.calendarEventsMade = [...(state.builder.calendarEventsMade || []), rec.madeKey];
  }
  if (current(rec)) {
    render?.();
    focusPanel();
  }
}

// A plan change in the series replaces the draft: a panel whose session is
// gone is released. A create in it stays in the calendar's memory since its
// send, so it is checked in the calendar; its answer still settles there.
function releaseIfGone() {
  const rec = state.builder.calendarEvent;
  if (rec && !builderCalendarDraftHoldsSession(state.builder.draft, rec.sessionId)) state.builder.calendarEvent = null;
}

// Escape (app.js): the open panel closes, unless a create is on its way or
// not confirmed. Returns whether it closed one.
export function closeBuilderCalendarEventPanel(renderBuilder) {
  const rec = state.builder.calendarEvent;
  if (!rec || locked(rec)) return false;
  state.builder.calendarEvent = null;
  renderBuilder?.();
  return true;
}

// The Builder's actions of this feature (`builder-calendar-event-*`).
export async function handleBuilderCalendarEventAction(action, { renderBuilder, openCalendarAt } = {}) {
  const type = action?.dataset?.action || "";
  if (!type.startsWith("builder-calendar-event-")) return false;
  releaseIfGone();
  const rec = state.builder.calendarEvent;
  if (type === "builder-calendar-event-open") {
    if (locked(rec)) return true;
    const sessionId = action.dataset.sessionId || "";
    if (rec && rec.sessionId === sessionId) {
      state.builder.calendarEvent = null;
      renderBuilder?.();
      return true;
    }
    const found = findSession(sessionId);
    if (!found?.block?.date) return true;
    const next = {
      sessionId, date: String(found.block.date).slice(0, 10), phase: "reading", match: null, types: [], form: null, message: "",
      madeKey: builderCalendarMadeKey(state.builder.draft, found.block, found.session),
    };
    state.builder.calendarEvent = next;
    // A Builder save still on its way: the day is read once it has landed,
    // so the match sees the plan as saved.
    if (builderSavesPending()) {
      next.phase = "saving";
      renderBuilder?.();
      await builderSavesSettled();
      if (!current(next)) return true;
    }
    await readDay(next, renderBuilder);
    return true;
  }
  if (!rec) return true;
  if (type === "builder-calendar-event-close") {
    if (locked(rec)) return true;
    state.builder.calendarEvent = null;
    renderBuilder?.();
    return true;
  }
  if (type === "builder-calendar-event-retry") {
    if (rec.phase === "read_error") await readDay(rec, renderBuilder);
    return true;
  }
  if (type === "builder-calendar-event-send") {
    await send(rec, renderBuilder);
    return true;
  }
  if (type === "builder-calendar-event-check") {
    if (rec.phase !== "unconfirmed" || rec.checking) return true;
    rec.checking = true;
    renderBuilder?.();
    await deliver(rec, renderBuilder, { check: true });
    return true;
  }
  if (type === "builder-calendar-event-open-calendar") {
    if (locked(rec)) return true;
    let target = { date: rec.date, key: "" };
    if (rec.phase === "done" && rec.event?.id) target = { date: rec.event.day, key: `event:${rec.event.id}:${rec.event.day}` };
    else if (rec.match?.kind === "linked") target = { date: rec.date, key: String(rec.match.event.key || "") };
    openCalendarAt?.(target);
    return true;
  }
  return true;
}

// A workspace switch (app.js onWorkspaceChanged): the panel and the "In
// calendar" badges are the old workspace's (code review LOW). A create not
// confirmed is not lost: it is kept in the calendar's memory under that
// workspace since its send.
export function resetBuilderCalendarEventForWorkspaceChange() {
  readGeneration += 1;
  state.builder.calendarEvent = null;
  state.builder.calendarEventsMade = [];
}

// Tests start over from here.
export function resetBuilderCalendarEventForTests() {
  readGeneration = 0;
}
