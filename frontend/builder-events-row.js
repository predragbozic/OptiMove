// K2c-3 (docs/ai/central-calendar-k3-plan.md section 6 with 7.1 / 7.2; the
// owner-approved mockups docs/design/calendar-k4/02 and 03): the events of a
// weekly plan's days in the Builder. Each day shows its events (Create event →
// opens the calendar's own form), each saved session chooses its event
// (`Event: [▾]`), and *Whole day* puts every fitting session of the day in one
// event. Every write is the calendar's own link command (attach / detach) with
// a requestKey, one at a time, kept in the calendar's memory of unconfirmed
// writes until its answer settles; a lost answer is *Result not confirmed* ·
// *Check result* (the same path, body and key). It replaces K2c-2's per-session
// "Make an event" panel (Q11).
import { api } from "./api.js";
import { rememberCentralCalendarLink } from "./central-calendar-actions.js";
import {
  centralCalendarErrorInfo,
  centralCalendarOutcomeUnknown,
  invalidateCentralCalendarCache,
  newCentralCalendarRequestKey,
  sendCentralCalendarLinkWrite,
} from "./central-calendar-data.js";
import { k3InOtherEvent, k3LogicalIdsFor, k3PlacedSessions, k3SelectorEvents, k3SessionFit, k3SessionKey, k3SessionLabel } from "./central-calendar-k3.js";
import { centralCalendarLinkCheckSettles, centralCalendarLinkRefusalText } from "./central-calendar-links.js";
import { state } from "./state.js";
import { addDaysIso } from "./utils.js";

export const BUILDER_EVENTS_WORKSPACES = Object.freeze(new Set(["club", "team", "private_coach"]));
export const EVENTS_LOAD_FAILED = "Events could not be loaded.";
export const SAVE_FIRST_QUESTION = "Save it (the athletes will see it) and continue?";
// A saved group plan opens again one athlete at a time (the Builder's edit
// draft, K3 plan 1.1 / Q3): said before the click, not found out after it.
export const SAVE_FIRST_GROUP_NOTE = "After saving, changes go to the athlete on screen only.";
const NOT_ON_CALENDAR = "This session isn't on the calendar yet: save the plan, then choose its event.";

const workspaceType = () => state.currentUser?.activeWorkspace?.type || "";

export function emptyBuilderEvents() {
  return { key: "", loading: false, error: "", events: [], planned: [], placed: new Map(), conflicts: new Set(), other: new Set(), write: null, pending: null, message: null, ask: null, made: null };
}

function rowState() {
  if (!state.builder.events) state.builder.events = emptyBuilderEvents();
  return state.builder.events;
}

// The row is shown on a weekly plan with a week, in a workspace that makes
// events, and not while K3's band plans one event (2.3: its own chips).
export function builderEventsOffered(draft = state.builder.draft) {
  const plan = draft?.plan;
  return Boolean(plan && plan.planType === "weekly" && !plan.isTemplate && plan.weekStart && BUILDER_EVENTS_WORKSPACES.has(workspaceType()) && !state.builder.k3);
}

// A never-saved plan has no live session: every write asks to save first.
export const builderPlanSaved = (draft = state.builder.draft) => Boolean(draft?.plan?.isEditDraft || (draft?.plan && draft.plan.status !== "draft"));

// The live plans (what the calendar's planned cards and links name).
export function builderLivePlanIds(draft = state.builder.draft) {
  const plan = draft?.plan || {};
  if (!builderPlanSaved(draft)) return [];
  const ids = new Set();
  ids.add(String(plan.isEditDraft ? plan.editSourcePlanId : plan.id));
  for (const p of draft?.batch?.plans || []) if (p?.id) ids.add(String(p.id));
  return [...ids].filter(Boolean);
}

// The plan's athletes as the calendar names them (UUIDs, from the roster).
export function builderPlanAthleteUuids(draft = state.builder.draft) {
  const byBuilderId = new Map((state.athletes || []).map((a) => [String(a.athlete_id), a]));
  const ids = [draft?.plan?.athleteId, ...((draft?.batch?.plans || []).map((p) => p.athleteId))].filter(Boolean).map(String);
  return [...new Set(ids.map((id) => byBuilderId.get(id)?.athlete_uuid).filter(Boolean).map(String))];
}

const weekOf = (draft) => {
  const from = String(draft?.plan?.weekStart || "").slice(0, 10);
  return from ? { from, to: addDaysIso(from, 6) } : null;
};

function keyOf(draft) {
  const week = weekOf(draft);
  return week ? [workspaceType(), state.currentUser?.activeWorkspace?.scopeId || "", week.from, builderLivePlanIds(draft).join(","), builderPlanAthleteUuids(draft).join(",")].join("|") : "";
}

// The Builder's sessions as the calendar matches them (day, AM/PM, B/T/A, name).
function draftSessions(draft) {
  const out = [];
  for (const block of draft?.blocks || []) {
    if (!block.date) continue;
    for (const session of block.sessions || []) out.push({ day: block.date, block, session, key: k3SessionKey(block.date, session), amPm: session.amPm || "", bta: session.bta || "", name: session.name || "" });
  }
  return out;
}

let generation = 0;
let renderRef = null;
export function setBuilderEventsRender(render) {
  renderRef = render;
}
const paint = () => renderRef?.();

// Read the week when the plan, its week or its athletes changed (a render
// asks; one read per key; a slower, older answer is dropped).
export function ensureBuilderEvents() {
  const draft = state.builder.draft;
  if (!builderEventsOffered(draft)) return;
  const row = rowState();
  const key = keyOf(draft);
  if (!key || row.key === key) return;
  row.key = key;
  // After this render (a read paints): one read per key, which a caller may wait for.
  row.loadPromise = new Promise((resolve) => queueMicrotask(() => loadBuilderEvents().then(resolve, resolve)));
}

// The week as read for the plan on screen now (a read started by a render included).
async function weekReadNow() {
  const row = rowState();
  ensureBuilderEvents();
  if (row.loadPromise) await row.loadPromise;
  if (row.loading) await loadBuilderEvents();
}

export async function loadBuilderEvents() {
  const draft = state.builder.draft;
  const row = rowState();
  const week = weekOf(draft);
  if (!week) return;
  const mine = ++generation;
  const builder = state.builder;
  const athleteIds = builderPlanAthleteUuids(draft);
  row.loading = true;
  row.error = "";
  paint();
  try {
    const params = new URLSearchParams({ from: week.from, to: week.to, kinds: "event,planned", include: "athletes" });
    if (athleteIds.length) params.set("athleteIds", athleteIds.join(","));
    const answer = await api(`/api/calendar?${params.toString()}`);
    const items = (answer?.days || []).flatMap((day) => (day.items || []).map((item) => ({ ...item, date: item.date || day.date })));
    const events = items.filter((item) => item.kind === "event" && !item.cancelled);
    const planned = items.filter((item) => item.kind === "planned");
    const planIds = builderLivePlanIds(draft);
    // The manager view of each managed event that holds a session of this plan.
    const holding = new Map();
    for (const event of events) {
      if (event.canManage === true && (event.links?.planIds || []).some((id) => planIds.includes(String(id)))) holding.set(String(event.eventId), event);
    }
    const views = await Promise.all([...holding.values()].map(async (event) => ({ event, view: await api(`/api/calendar/events/${encodeURIComponent(event.eventId)}`).then((data) => data?.event || data) })));
    if (mine !== generation || state.builder !== builder) return;
    const { placed, conflicts } = k3PlacedSessions(views, planIds);
    // A session in no managed event and no planned card is in an event the coach
    // does not manage - said only when such an event is on its day.
    const lockedDays = new Set(events.filter((e) => e.canManage !== true).map((e) => e.date));
    const candidates = builderPlanSaved(draft) ? draftSessions(draft).filter((s) => lockedDays.has(s.day)) : [];
    const other = k3InOtherEvent(candidates.map((s) => ({ day: s.day, amPm: s.amPm, bta: s.bta, name: s.name })), planned, placed, planIds);
    Object.assign(row, { loading: false, error: "", events, planned, placed, conflicts, other });
  } catch {
    if (mine !== generation || state.builder !== builder) return;
    row.loading = false;
    row.error = EVENTS_LOAD_FAILED;
  }
  paint();
}

export function builderDayEvents(day) {
  return (rowState().events || []).filter((event) => {
    const from = event.span?.from || event.date;
    const to = event.span?.to || event.date;
    return day >= from && day <= to;
  }).filter((event, i, all) => all.findIndex((e) => String(e.eventId) === String(event.eventId)) === i);
}

// The event a session is in: a managed one's id, "other" (an event the coach
// does not manage), or "" (none).
export function builderSessionEvent(day, session) {
  const row = rowState();
  const key = k3SessionKey(day, session);
  if (row.placed.has(key)) return row.placed.get(key).eventId;
  if (row.other.has(key)) return "other";
  return "";
}

const eventShape = (event) => ({ day: event.span?.from || event.date, span: event.span || null, startTime: event.startTime, endTime: event.endTime });

export function builderSelectorChoices(day, session) {
  return k3SelectorEvents(builderDayEvents(day), session, day);
}

// ---------------------------------------------------------------------------
// The writes.
// ---------------------------------------------------------------------------
export const builderEventsBusy = () => Boolean(rowState().write || rowState().pending || rowState().ask);

function eventById(eventId) {
  return (rowState().events || []).find((event) => String(event.eventId) === String(eventId)) || null;
}

function attachSpec(event, ids) {
  const requestKey = newCentralCalendarRequestKey();
  return {
    act: "link-session", wire: "link-session", requestKey,
    path: `/api/calendar/events/${encodeURIComponent(event.eventId)}/sessions`,
    body: { requestKey, expectedRevision: Number(event.revision) || 0, logicalSessionIds: [...ids], alignSessions: (event.expects || []).includes("rpe") },
    eventId: String(event.eventId), eventKey: event.key, eventTitle: event.title || "", date: event.date, panelKey: event.key, name: "A Builder session",
  };
}

function detachSpec(event, linkIds) {
  const requestKey = newCentralCalendarRequestKey();
  return {
    act: "unlink-sessions", wire: "unlink-sessions", requestKey,
    path: `/api/calendar/events/${encodeURIComponent(event.eventId)}/sessions/detach`,
    body: { requestKey, expectedRevision: Number(event.revision) || 0, linkIds: [...linkIds] },
    eventId: String(event.eventId), eventKey: event.key, eventTitle: event.title || "", date: event.date, panelKey: event.key, name: "A Builder session",
  };
}

// One command: "ok" | "refused" (info) | "unknown" (kept to check).
async function send(spec, { check = false } = {}) {
  const forget = rememberCentralCalendarLink(spec);
  try {
    await sendCentralCalendarLinkWrite(spec.path, spec.body);
    forget();
    return { state: "ok" };
  } catch (error) {
    const info = centralCalendarErrorInfo(error);
    if (centralCalendarOutcomeUnknown(info) || (check && !centralCalendarLinkCheckSettles(info))) return { state: "unknown", info };
    forget();
    return { state: "refused", info };
  }
}

const eventName = (event) => {
  const time = String(event?.startTime || "").slice(0, 5);
  return `${String(event?.title || "the event").trim()}${time ? ` ${time}` : ""}`;
};

function say(at, text, tone = "warning", extra = {}) {
  rowState().message = { at, text, tone, ...extra };
}

// The session's own time or half must fit the event (O14 / O15): refused
// before any request, with the one fix (*Use the event's time*).
function fitRefusal(session, event, day) {
  const fit = k3SessionFit({ name: session.name, amPm: session.amPm, time: session.time }, eventShape(event), day);
  return fit.fits ? null : fit;
}

// `Event:` changed for one session: none → E (attach), E → none (detach),
// A → B (detach, then attach: two writes, the partial outcome said, Q9).
export async function chooseSessionEvent(day, sessionId, value) {
  const row = rowState();
  if (builderEventsBusy() || row.loading) return;
  const draft = state.builder.draft;
  const item = draftSessions(draft).find((s) => s.session.id === sessionId && s.day === day);
  if (!item) return;
  const at = `session:${sessionId}`;
  row.message = null;
  if (!builderPlanSaved(draft)) {
    row.ask = { kind: "session", day, sessionId, sessionKey: item.key, value };
    paint();
    return;
  }
  const current = builderSessionEvent(day, item.session);
  if (current === "other" || String(current) === String(value)) return;
  const target = value ? eventById(value) : null;
  if (value && (!target || target.canManage !== true)) return;
  if (target) {
    const fit = fitRefusal(item.session, target, day);
    if (fit) {
      say(at, fit.text, "warning", { useEventTime: fit.reason === "time" ? sessionId : "" });
      paint();
      return;
    }
  }
  const from = current ? eventById(current) : null;
  row.write = { at };
  paint();
  try {
    if (from) {
      const linkIds = row.placed.get(item.key)?.linkIds || [];
      const detach = detachSpec(from, linkIds);
      const out = await send(detach);
      if (out.state !== "ok") {
        const done = target
          ? `${k3SessionLabel(item.session)} is out of ${eventName(from)}, but not put in ${eventName(target)}. Choose ${eventName(target)} again.`
          : `${k3SessionLabel(item.session)} is out of ${eventName(from)}.`;
        return finishWrite(at, out, { spec: detach, done });
      }
      if (!target) {
        await loadBuilderEvents();
        say(at, `${k3SessionLabel(item.session)} is out of ${eventName(from)}.`, "ok");
        return;
      }
      await loadBuilderEvents();
    }
    const fresh = eventById(target.eventId) || target;
    const { ids } = k3LogicalIdsFor(row.planned, [item.key], builderLivePlanIds(draft));
    if (!ids.length) {
      say(at, from ? `Taken out of ${eventName(from)}, but not put in ${eventName(fresh)}. ${NOT_ON_CALENDAR}` : NOT_ON_CALENDAR);
      return;
    }
    const spec = attachSpec(fresh, ids);
    const out = await send(spec);
    if (out.state === "ok") {
      await loadBuilderEvents();
      say(at, `${k3SessionLabel(item.session)} is in ${eventName(fresh)}.`, "ok");
      return;
    }
    if (from && out.state === "refused") {
      say(at, `Taken out of ${eventName(from)}, but not put in ${eventName(fresh)}. ${centralCalendarLinkRefusalText(out.info)}`, "warning", { retry: { day, sessionId, value } });
      return;
    }
    finishWrite(at, out, { spec, done: `${k3SessionLabel(item.session)} is in ${eventName(fresh)}.` });
  } finally {
    row.write = null;
    invalidateCentralCalendarCache();
    paint();
  }
}

// `done`: the sentence a confirmed Check result says (what is true now).
function finishWrite(at, out, { spec, done = "" }) {
  const row = rowState();
  if (out.state === "unknown") {
    row.pending = { at, spec, done };
    say(at, "We couldn't confirm the result. Checking never links twice.", "warning");
    return;
  }
  say(at, centralCalendarLinkRefusalText(out.info || {}), "warning");
  if (out.info?.code === "event_changed") void loadBuilderEvents();
}

// *Whole day* (O10): one attach with every saved session of the day that fits
// the event and is in no other event; the others are named.
export async function chooseWholeDay(day, value) {
  const row = rowState();
  if (builderEventsBusy() || row.loading || !value) return;
  const draft = state.builder.draft;
  const at = `day:${day}`;
  row.message = null;
  if (!builderPlanSaved(draft)) {
    row.ask = { kind: "day", day, value };
    paint();
    return;
  }
  const event = eventById(value);
  if (!event || event.canManage !== true) return;
  const keys = [];
  const left = [];
  for (const item of draftSessions(draft).filter((s) => s.day === day)) {
    const current = builderSessionEvent(day, item.session);
    if (String(current) === String(event.eventId)) continue;
    if (current) {
      left.push(`${k3SessionLabel(item.session)} stays in ${current === "other" ? "an event you don't manage" : eventName(eventById(current))}.`);
      continue;
    }
    const fit = fitRefusal(item.session, event, day);
    if (fit) {
      left.push(fit.text);
      continue;
    }
    keys.push(item.key);
  }
  const { ids, missing } = k3LogicalIdsFor(row.planned, keys, builderLivePlanIds(draft));
  if (missing.length) left.push(NOT_ON_CALENDAR);
  if (!ids.length) {
    say(at, left.length ? left.join(" ") : `Every session of this day is already in ${eventName(event)}.`, left.length ? "warning" : "ok");
    paint();
    return;
  }
  const spec = attachSpec(event, ids);
  row.write = { at };
  paint();
  try {
    const out = await send(spec);
    if (out.state === "ok") {
      await loadBuilderEvents();
      say(at, [`${keys.length - missing.length} ${keys.length - missing.length === 1 ? "session is" : "sessions are"} in ${eventName(event)}.`, ...left].join(" "), left.length ? "warning" : "ok");
      return;
    }
    finishWrite(at, out, { spec, done: `${keys.length - missing.length} ${keys.length - missing.length === 1 ? "session is" : "sessions are"} in ${eventName(event)}.` });
  } finally {
    row.write = null;
    invalidateCentralCalendarCache();
    paint();
  }
}

// *Check result*: the same path, body and key; only a settling answer ends it.
export async function checkBuilderEventsResult() {
  const row = rowState();
  const pending = row.pending;
  if (!pending || row.write) return;
  row.write = { at: pending.at, check: true };
  paint();
  try {
    const out = await send(pending.spec, { check: true });
    if (out.state === "unknown") {
      say(pending.at, "Still not confirmed. Check again in a moment.", "warning");
      return;
    }
    row.pending = null;
    if (out.state === "ok") {
      await loadBuilderEvents();
      say(pending.at, pending.done || "Done: the calendar was read again.", "ok");
      return;
    }
    say(pending.at, centralCalendarLinkRefusalText(out.info || {}), "warning");
    void loadBuilderEvents();
  } finally {
    row.write = null;
    invalidateCentralCalendarCache();
    paint();
  }
}

export function dismissBuilderEventsMessage() {
  rowState().message = null;
}

// "This plan isn't saved yet" (6.4): *Save and continue* saves (the Builder's
// own Save and finish), opens the saved plan again in the Builder (Q10), reads
// the week again and does what was asked.
export async function answerSaveFirst(yes, { submit, reopen }) {
  const row = rowState();
  const ask = row.ask;
  if (!ask) return;
  if (!yes) {
    row.ask = null;
    paint();
    return;
  }
  row.ask = { ...ask, busy: true };
  paint();
  const at = ask.kind === "day" ? `day:${ask.day}` : `session:${ask.sessionId}`;
  let result;
  try {
    result = await submit();
  } catch (error) {
    row.ask = null;
    say(at, !error?.status || error.status >= 500
      ? "We couldn't confirm the plan was saved. Nothing was linked."
      : "The plan wasn't saved, so nothing was linked.", "warning");
    paint();
    return;
  }
  const plan = result?.plan || result;
  if (result?.deleted || !plan?.id) {
    row.ask = null;
    say(at, "Add an exercise or a named section first: a plan without them isn't saved.", "warning");
    paint();
    return;
  }
  try {
    await reopen(plan.id);
  } catch {
    // Saved, but not opened again here: the row is released and says so.
    row.ask = null;
    say(at, "Saved. The plan couldn't be opened again here: open it again from the Weekly plan, then choose the event.", "warning");
    paint();
    return;
  }
  row.ask = null;
  await weekReadNow();
  // The session's ids changed with the reopened edit draft: find it again by its slot.
  if (ask.kind === "day") await chooseWholeDay(ask.day, ask.value);
  else {
    const again = draftSessions(state.builder.draft).find((s) => s.day === ask.day && (s.key === ask.sessionKey || s.session.id === ask.sessionId));
    if (again) await chooseSessionEvent(ask.day, again.session.id, ask.value);
  }
  paint();
}

// The note on a linked session whose own time or half no longer fits its
// event (7.1 / 7.2): nothing changes by itself.
export function builderSessionOutside(day, session) {
  const id = builderSessionEvent(day, session);
  if (!id || id === "other") return null;
  const event = eventById(id);
  if (!event) return null;
  return fitRefusal(session, event, day) ? { event, fit: fitRefusal(session, event, day) } : null;
}

// After a create from the Builder (6.3, setCentralCalendarBuilderReturn).
export function builderEventMade(event) {
  const row = rowState();
  row.key = "";
  if (event) {
    const time = [String(event.startTime || "").slice(0, 5), String(event.endTime || "").slice(0, 5)].filter(Boolean).join("–");
    row.made = { text: `The event ${String(event.title || "").trim() || "Training"}${time ? ` · ${time}` : ""} is in the calendar.`, day: event.day };
  }
}

export const builderEventsResetForWorkspaceChange = () => {
  if (state.builder) state.builder.events = emptyBuilderEvents();
  generation += 1;
};

// The targets of an event made from the Builder (Q8): the team when the
// plan's athletes are exactly the team workspace's roster, else the athletes.
export function builderEventTargets(draft = state.builder.draft) {
  const ws = state.currentUser?.activeWorkspace || {};
  const uuids = builderPlanAthleteUuids(draft);
  const roster = (state.athletes || []).map((a) => String(a.athlete_uuid)).filter(Boolean);
  if (ws.type === "team" && uuids.length && uuids.length === roster.length && roster.every((id) => uuids.includes(id))) {
    return [{ kind: "team", id: String(ws.scopeId), name: ws.label || "" }];
  }
  const names = new Map((state.athletes || []).map((a) => [String(a.athlete_uuid), a.athlete || ""]));
  return uuids.map((id) => ({ kind: "athlete", id, name: names.get(id) || "" }));
}
