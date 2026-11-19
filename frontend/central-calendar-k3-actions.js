// K3 (docs/ai/central-calendar-k3-plan.md section 2, the owner-approved mockup
// docs/design/calendar-k4/01): from an event's panel, *Plan the training*
// opens the Builder on the event's week for its athletes, with a band naming
// the event; the sessions of the event's day go into it; *Save and link*
// saves the plan and links them. The pure parts are central-calendar-k3.js;
// this module holds the requests, the state and the session memory.
//
// The manager's GO conditions (#646):
// - sessionStorage keeps ids and slot keys only, and is cleared on sign-out
//   and on a workspace change (clearK3Memory);
// - "linked" is never said without a confirmed attach answer: every attach of
//   up to 200 sessions has its own key and outcome, a partial success is said.
import { api } from "./api.js";
import { invalidateAthleteHomeCache } from "./athlete-home-data.js";
import { invalidateCoachHomeCache } from "./coach-home-data.js";
import { rememberCentralCalendarLink } from "./central-calendar-actions.js";
import {
  centralCalendarErrorInfo,
  invalidateCentralCalendarCache,
  newCentralCalendarRequestKey,
  sendCentralCalendarLinkWrite,
} from "./central-calendar-data.js";
import { centralCalendarSessionLinkGroups } from "./central-calendar-links.js";
import {
  k3EventCoversDay,
  k3EventHalf,
  k3EventWindow,
  k3HalfFits,
  k3LinkRun,
  k3LogicalIdsFor,
  k3PartRetriesOnStale,
  k3PlanCase,
  k3PlanCaseSheet,
  k3RetryRun,
  k3SaveAndLinkOutcome,
  k3SessionFit,
  k3SessionKey,
  k3SessionLabel,
  k3SettlePart,
  k3TimeFits,
} from "./central-calendar-k3.js";
import { state } from "./state.js";
import { weekMondayIso } from "./utils.js";

// The workspaces that plan from an event (v49's writer bases; the platform
// workspace makes no event).
export const K3_WORKSPACES = Object.freeze(new Set(["club", "team", "private_coach"]));
const WEEKLY_PLANS_MAX = 200;
const STORAGE_PREFIX = "optimove.k3.";

const workspaceType = () => state.currentUser?.activeWorkspace?.type || "";
const workspaceKey = () => {
  const ws = state.currentUser?.activeWorkspace;
  return ws?.type ? `${ws.type}:${ws.clubId || ws.teamId || ws.id || ""}` : "";
};

// ---------------------------------------------------------------------------
// The panel's button (2.1): a manager's planned training-kind event.
// ---------------------------------------------------------------------------
export function k3Offered(item) {
  return item?.kind === "event" && item.canManage === true && !item.cancelled && item.eventKind === "training"
    && K3_WORKSPACES.has(workspaceType());
}

// Whether the event already has linked trainings (the manager view): the
// button is then *Open the training*.
export function k3EventHasTrainings(cal, item) {
  const view = cal?.panelEvent && cal.panelEvent.key === item?.key ? cal.panelEvent.event : null;
  if (!view) return false;
  return centralCalendarSessionLinkGroups(view, item.date).groups.length > 0;
}

// ---------------------------------------------------------------------------
// The session memory (3.2): ids and slot keys only, never a name of a person.
// One entry per K3 context, under the signed-in user; read back when the same
// plan is opened again after a reload.
// ---------------------------------------------------------------------------
function storage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function storageKeyOf(context) {
  const userId = state.currentUser?.id;
  return userId && context?.anchorPlanId ? `${STORAGE_PREFIX}${userId}.${context.anchorPlanId}` : "";
}

function saveK3Memory(context) {
  const key = storageKeyOf(context);
  const store = storage();
  if (!key || !store) return;
  const entry = {
    eventId: String(context.eventId), eventKey: String(context.eventKey), date: String(context.date),
    workspace: context.workspace, planIds: [...context.planIds].map(String), outKeys: [...context.outKeys].map(String),
  };
  try {
    store.setItem(key, JSON.stringify(entry));
  } catch {}
}

function dropK3Memory(context) {
  const key = storageKeyOf(context);
  const store = storage();
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {}
}

// Sign-out and a workspace change (the manager's GO): every K3 entry goes.
export function clearK3Memory() {
  const store = storage();
  if (!store) return;
  try {
    const keys = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => store.removeItem(key));
  } catch {}
}

function findK3Memory(planIds) {
  const store = storage();
  const userId = state.currentUser?.id;
  if (!store || !userId) return null;
  const wanted = new Set(planIds.filter(Boolean).map(String));
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (!key || !key.startsWith(`${STORAGE_PREFIX}${userId}.`)) continue;
      const entry = JSON.parse(store.getItem(key) || "null");
      if (!entry || entry.workspace !== workspaceKey() || !Array.isArray(entry.planIds)) continue;
      if (entry.planIds.some((id) => wanted.has(String(id)))) return { key, entry };
    }
  } catch {}
  return null;
}

// The plans a draft belongs to: its own id, the live plan of an edit draft,
// and its batch.
function draftPlanIds(draft) {
  const plan = draft?.plan || {};
  return [plan.id, plan.editSourcePlanId, ...((draft?.batch?.plans || []).map((p) => p.id))].filter(Boolean).map(String);
}

// The live plans a save leaves (the batch's published ids, the edit draft's
// source): what the calendar's planned cards name.
function livePlanIdsOf(draft, savedPlan = null) {
  const ids = new Set();
  const plan = draft?.plan || {};
  if (plan.isEditDraft && plan.editSourcePlanId) ids.add(String(plan.editSourcePlanId));
  else if (plan.id) ids.add(String(plan.id));
  for (const p of draft?.batch?.plans || []) if (p?.id) ids.add(String(p.id));
  if (savedPlan?.id) ids.add(String(savedPlan.id));
  return [...ids];
}

// ---------------------------------------------------------------------------
// The Builder's context: state.builder.k3.
// ---------------------------------------------------------------------------
function contextFromEvent(item, view, { athleteIds }) {
  const span = item.span || (view?.endDay && view.endDay !== view.day ? { from: view.day, to: view.endDay } : null);
  return {
    eventId: String(item.eventId || view?.id || ""),
    eventKey: String(item.key || ""),
    date: String(item.date || view?.day || ""),
    endDate: String(span?.to || item.date || view?.day || ""),
    span: span ? { from: String(span.from), to: String(span.to) } : null,
    title: String(item.title || view?.title || "").trim() || "Training",
    eventKind: item.eventKind || view?.eventKind || "training",
    eventTypeIconKey: item.eventTypeIconKey ?? null,
    eventTypeColorKey: item.eventTypeColorKey ?? null,
    startTime: String(item.startTime || view?.startTime || "").slice(0, 5),
    endTime: String(item.endTime || view?.endTime || "").slice(0, 5),
    placeName: String(item.place?.name || item.location || view?.place?.name || view?.location || "").trim(),
    expectsRpe: (item.expects || view?.expects || []).includes("rpe"),
    athleteIds: [...athleteIds].map(String),
    athleteCount: athleteIds.length,
    // Q5: a club admin planning a team's event makes the club's plans.
    clubPlan: workspaceType() === "club" && view?.ownerScope === "team",
    workspace: workspaceKey(),
    anchorPlanId: "",
    planIds: [],
    outKeys: [],
    saving: false,
    blocker: null,
    timeMessage: null,
    saved: null,
  };
}

function setPlans(context, draft) {
  const ids = new Set([...context.planIds, ...draftPlanIds(draft)]);
  context.planIds = [...ids];
  if (!context.anchorPlanId) context.anchorPlanId = livePlanIdsOf(draft)[0] || draftPlanIds(draft)[0] || "";
}

// Every draft the Builder takes (setBuilderDraft): the band stays with the
// plans of its context; another plan ends it (2.3); a plan of a remembered
// context (a reload) gets its band back once the event is read again.
let restoreGeneration = 0;
let renderBuilderRef = null;
export function setK3BuilderRender(render) {
  renderBuilderRef = render;
}

export function k3AdoptDraft(draft) {
  if (!draft?.plan) return;
  const context = state.builder.k3;
  const ids = draftPlanIds(draft);
  if (context) {
    if (ids.some((id) => context.planIds.includes(id))) {
      setPlans(context, draft);
      // "Add an exercise first" holds only until the plan has one.
      if (context.outcome?.state === "empty" && draftHasContent(draft)) context.outcome = null;
      saveK3Memory(context);
      return;
    }
    state.builder.k3 = null;
  }
  if (draft.plan.planType !== "weekly" || !K3_WORKSPACES.has(workspaceType())) return;
  const found = findK3Memory(ids);
  if (found) void restoreK3(found, draft);
}

async function restoreK3({ key, entry }, draft) {
  const builder = state.builder;
  const generation = ++restoreGeneration;
  let view = null;
  try {
    const data = await api(`/api/calendar/events/${encodeURIComponent(entry.eventId)}`);
    view = data?.event || null;
  } catch (error) {
    // A 404 (gone, or not this coach's): the memory is dropped silently.
    if (error?.status === 404 || error?.status === 403) {
      try {
        storage()?.removeItem(key);
      } catch {}
    }
    return;
  }
  if (generation !== restoreGeneration || state.builder !== builder || builder.k3 || !view || view.status === "cancelled" || view.canManage !== true) return;
  if (!draftPlanIds(builder.draft).some((id) => entry.planIds.includes(id))) return;
  const item = {
    key: entry.eventKey, eventId: entry.eventId, date: entry.date, title: view.title, eventKind: view.eventKind,
    startTime: view.startTime, endTime: view.endTime, place: view.place, location: view.location, expects: view.expects,
    span: view.endDay && view.endDay !== view.day ? { from: view.day, to: view.endDay } : null,
  };
  const athleteIds = [...new Set((view.targets || []).filter((t) => t.kind === "athlete").map((t) => String(t.id)))];
  const context = contextFromEvent(item, view, { athleteIds });
  context.athleteCount = Number(view.athleteCount) || athleteIds.length;
  context.planIds = entry.planIds.map(String);
  context.outKeys = (entry.outKeys || []).map(String);
  context.anchorPlanId = String(key.split(".").pop());
  setPlans(context, builder.draft);
  builder.k3 = context;
  renderBuilderRef?.();
}

// ---------------------------------------------------------------------------
// Opening the Builder from the panel (2.1, 2.2).
// ---------------------------------------------------------------------------
const shortDay = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${day} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
};
export const k3EventLabel = (context) => `${context.title} · ${shortDay(context.date)}`;

function rosterIndex() {
  const byUuid = new Map();
  for (const athlete of state.athletes || []) {
    if (athlete?.athlete_uuid) byUuid.set(String(athlete.athlete_uuid), athlete);
  }
  return byUuid;
}

async function readWeeklyPlans(weekStart, athleteIds) {
  const athletes = [];
  for (let i = 0; i < athleteIds.length; i += WEEKLY_PLANS_MAX) {
    const part = athleteIds.slice(i, i + WEEKLY_PLANS_MAX);
    const params = new URLSearchParams({ weekStart, athleteIds: part.join(",") });
    const answer = await api(`/api/builder/weekly-plans?${params.toString()}`);
    athletes.push(...(Array.isArray(answer?.athletes) ? answer.athletes : []));
  }
  return { athletes };
}

export function k3PanelState(cal) {
  return cal?.k3 || null;
}

const OPEN_FAILED = "The Builder couldn't be opened. Nothing was changed. Try again.";

// The press: read the athletes' plans of the week, then open (or ask).
// `handlers.openBuilder(draft, context)` (app.js) enters the Builder.
export async function k3StartFromPanel(cal, item, handlers, render) {
  if (!k3Offered(item) || cal.k3?.busy) return;
  cal.k3 = { eventKey: item.key, busy: true, sheet: null, error: "" };
  render?.();
  const view = cal.panelEvent && cal.panelEvent.key === item.key ? cal.panelEvent.event : null;
  const athleteIds = [...new Set((item.athleteIds || []).map(String))];
  const weekStart = weekMondayIso(item.date);
  let answer;
  try {
    answer = athleteIds.length ? await readWeeklyPlans(weekStart, athleteIds) : { athletes: [] };
  } catch {
    if (state.centralCalendar !== cal) return;
    cal.k3 = { eventKey: item.key, busy: false, sheet: null, error: OPEN_FAILED };
    render?.();
    return;
  }
  if (state.centralCalendar !== cal) return;
  // An athlete the server lets this workspace plan but the coach's roster
  // cannot name (the Builder takes the roster's ids) is counted as outside.
  const roster = rosterIndex();
  const athletes = answer.athletes.map((a) => (a?.plannable === true && !roster.has(String(a.athleteId)) ? { athleteId: a.athleteId, plannable: false } : a));
  const planCase = k3PlanCase({ athletes }, { nameOf: (id) => roster.get(String(id))?.athlete || "" });
  const sheet = k3PlanCaseSheet(planCase);
  const target = { item, view, weekStart, planCase };
  if (sheet) {
    cal.k3 = { eventKey: item.key, busy: false, sheet: { ...sheet, planCase }, error: "", target };
    render?.();
    globalThis.document?.querySelector?.(".k3-sheet [data-k3-focus]")?.focus?.();
    return;
  }
  await k3Go(cal, target, planCase.kind === "new" ? { create: planCase.athleteIds } : { open: planCase }, handlers, render);
}

// A sheet's button (2.2).
export async function k3SheetAction(cal, act, dataset, handlers, render) {
  const panel = cal.k3;
  if (!panel?.sheet || panel.busy) return;
  const { planCase } = panel.sheet;
  const target = panel.target;
  if (act === "cancel" || act === "close") {
    cal.k3 = null;
    render?.();
    return;
  }
  if (act === "continue") {
    await k3Go(cal, target, planCase.kind === "new" ? { create: planCase.athleteIds } : { open: planCase }, handlers, render);
    return;
  }
  if (act === "plan-rest") {
    await k3Go(cal, target, { create: planCase.athleteIds }, handlers, render);
    return;
  }
  if (act === "open-plan") {
    await k3Go(cal, target, { open: planCase }, handlers, render);
    return;
  }
  if (act === "choose-existing") {
    cal.k3 = { ...panel, sheet: { ...panel.sheet, choosing: true } };
    render?.();
    globalThis.document?.querySelector?.(".k3-sheet [data-k3-focus]")?.focus?.();
    return;
  }
  if (act === "open-existing") {
    const chosen = (planCase.withPlans || []).find((p) => p.planId === dataset.planId);
    if (chosen) await k3Go(cal, target, { open: { openPlanId: chosen.openPlanId, planId: chosen.planId, status: chosen.status } }, handlers, render);
  }
}

async function openPlanDraft({ openPlanId, planId, status }) {
  const id = String(openPlanId || planId || "");
  // An own edit already open, or a draft: read it; a published plan: an edit
  // draft of it (the Builder's own Edit).
  if (status === "draft" || (planId && id !== String(planId))) return api(`/api/builder/plans/${encodeURIComponent(id)}`);
  return api(`/api/builder/plans/${encodeURIComponent(id)}/edit`, { method: "POST" });
}

async function k3Go(cal, target, how, handlers, render) {
  const { item, view, weekStart } = target;
  cal.k3 = { ...(cal.k3 || {}), eventKey: item.key, busy: true, error: "" };
  render?.();
  let draft;
  let athleteIds = [...new Set((item.athleteIds || []).map(String))];
  try {
    if (how.create) {
      const roster = rosterIndex();
      const builderIds = how.create.map((id) => roster.get(String(id))?.athlete_id).filter(Boolean).map(String);
      if (!builderIds.length) throw Object.assign(new Error("nobody"), { status: 400 });
      athleteIds = how.create.map(String);
      draft = await api("/api/builder/plans", {
        method: "POST",
        body: JSON.stringify({ planType: "weekly", weekStart, athleteIds: builderIds, name: `${String(item.title || "Training").trim() || "Training"} · ${shortDay(item.date)}` }),
      });
    } else {
      const { openPlanId, planId, status } = how.open;
      draft = await openPlanDraft({ openPlanId, planId, status });
    }
  } catch (error) {
    if (state.centralCalendar !== cal) return;
    // Someone made a plan meanwhile: the plans are read again (2.2).
    if (error?.status === 409 && how.create) {
      cal.k3 = null;
      await k3StartFromPanel(cal, item, handlers, render);
      return;
    }
    cal.k3 = { eventKey: item.key, busy: false, sheet: null, error: OPEN_FAILED };
    render?.();
    return;
  }
  if (state.centralCalendar !== cal) return;
  cal.k3 = null;
  const context = contextFromEvent(item, view, { athleteIds });
  context.athleteCount = athleteIds.length;
  setPlans(context, draft);
  saveK3Memory(context);
  await handlers.openBuilder?.(draft, context);
}

// ---------------------------------------------------------------------------
// The Builder's side (2.3 - 2.5).
// ---------------------------------------------------------------------------
export function k3Context() {
  return state.builder?.k3 || null;
}

export function k3BlockInEvent(context, block) {
  if (!context || !block?.date) return false;
  return k3EventCoversDay(eventShape(context), block.date);
}

function eventShape(context) {
  return { day: context.date, span: context.span, startTime: context.startTime, endTime: context.endTime };
}

// A session's state in the event: in (by default), out (the coach's choice),
// or outside (the other half of the day: never linked, O15).
export function k3SessionState(context, block, session) {
  if (!k3BlockInEvent(context, block)) return null;
  const key = k3SessionKey(block.date, session);
  const event = eventShape(context);
  if (!k3HalfFits(session.amPm, k3EventHalf(event, block.date))) return { key, state: "outside", amPm: session.amPm };
  return { key, state: context.outKeys.includes(key) ? "out" : "in" };
}

export function k3ToggleSession(key) {
  const context = k3Context();
  if (!context || context.saving || context.saved) return;
  const out = new Set(context.outKeys);
  if (out.has(key)) out.delete(key);
  else out.add(key);
  context.outKeys = [...out];
  context.blocker = null;
  saveK3Memory(context);
}

// The half a new session on the event's day starts in (2.4).
export function k3DefaultAmPm(block) {
  const context = k3Context();
  if (!k3BlockInEvent(context, block)) return "";
  const half = k3EventHalf(eventShape(context), block.date);
  return half === "AM" || half === "PM" ? half : "";
}

// O14: a session in the event takes only a time inside the event's window.
// Returns the sentence when `time` is refused, "" otherwise.
export function k3TimeRefusal(sessionId, time) {
  const context = k3Context();
  if (!context || !time) return "";
  for (const block of state.builder.draft?.blocks || []) {
    const session = (block.sessions || []).find((s) => s.id === sessionId);
    if (!session) continue;
    const st = k3SessionState(context, block, session);
    if (!st || st.state !== "in") return "";
    const window = k3EventWindow(eventShape(context), block.date);
    if (k3TimeFits(time, window)) return "";
    const range = window?.to ? `${window.from}–${window.to}` : `from ${window?.from}`;
    return `${context.title} is ${range}, so this session's time must be in it.`;
  }
  return "";
}

export function k3SetTimeMessage(sessionId, text) {
  const context = k3Context();
  if (context) context.timeMessage = text ? { sessionId, text } : null;
}

// The sessions of the event's day(s) that will be linked, and the ones the
// half leaves out (named in the outcome).
function plannedSessions(context, draft) {
  const inKeys = [];
  const outsideNames = [];
  const misfits = [];
  for (const block of draft?.blocks || []) {
    for (const session of block.sessions || []) {
      const st = k3SessionState(context, block, session);
      if (!st) continue;
      if (st.state === "outside") {
        outsideNames.push(`${k3SessionLabel(session)} (${session.amPm})`);
        continue;
      }
      if (st.state !== "in") continue;
      const fit = k3SessionFit({ name: session.name, amPm: session.amPm, time: session.time }, eventShape(context), block.date);
      if (!fit.fits && fit.reason === "time") misfits.push({ sessionId: session.id, text: fit.text });
      else inKeys.push(st.key);
    }
  }
  return { inKeys: [...new Set(inKeys)], outsideNames, misfits };
}

export function k3SaveSummary(context, draft) {
  const { inKeys } = plannedSessions(context, draft);
  const athletes = context.athleteCount;
  const sessions = inKeys.length;
  const s = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  return sessions
    ? `Saving publishes the plan to ${s(athletes, "athlete", "athletes")} and links ${s(sessions, "session", "sessions")} to the event.`
    : `Saving publishes the plan to ${s(athletes, "athlete", "athletes")}. No session is put in the event.`;
}

// *Use the event's time* (O14): clears the session's own time (one Builder PATCH).
export function k3UseEventTimeRequest(sessionId) {
  return { path: `/api/builder/sessions/${encodeURIComponent(sessionId)}`, body: { time: "" } };
}

function calendarRead(context) {
  const params = new URLSearchParams({ from: context.date, to: context.endDate || context.date, include: "athletes" });
  return api(`/api/calendar?${params.toString()}`);
}

function eventCardOf(answer, context) {
  for (const day of answer?.days || []) {
    const card = (day.items || []).find((it) => it.kind === "event" && String(it.eventId) === context.eventId);
    if (card) return card;
  }
  return null;
}

const plannedOf = (answer) => (answer?.days || []).flatMap((day) => (day.items || []).filter((it) => it.kind === "planned"));

function linkSpec(context, part, revision) {
  return {
    act: "link-session", wire: "link-session", requestKey: part.requestKey,
    path: `/api/calendar/events/${encodeURIComponent(context.eventId)}/sessions`,
    body: { requestKey: part.requestKey, expectedRevision: revision, logicalSessionIds: [...part.ids], alignSessions: context.expectsRpe },
    eventId: context.eventId, eventKey: context.eventKey, eventTitle: context.title, date: context.date,
    panelKey: context.eventKey, name: "The planned training",
  };
}

// One part sent (or sent again with its own key: Check result).
async function sendPart(context, part, revision, { check = false } = {}) {
  const spec = part.spec || linkSpec(context, part, revision);
  // In the calendar's memory of unconfirmed writes from its send (2.5): its
  // leave guards count it, and the event's panel offers Check result.
  const forget = rememberCentralCalendarLink(spec);
  let data = null;
  let info = null;
  try {
    data = await sendCentralCalendarLinkWrite(spec.path, spec.body);
  } catch (error) {
    info = centralCalendarErrorInfo(error);
  }
  const settled = k3SettlePart({ ...part, spec }, { data, info, check });
  if (settled.state !== "unknown") forget();
  return settled;
}

async function runParts(context, run, revision, { check = false } = {}) {
  const parts = [];
  let current = revision;
  let reread = false;
  for (const part of run.parts) {
    if (part.state !== "pending" && !(check && part.state === "unknown")) {
      parts.push(part);
      continue;
    }
    let settled = await sendPart(context, part, current, { check });
    if (!check && k3PartRetriesOnStale(settled) && !reread) {
      reread = true;
      try {
        const card = eventCardOf(await calendarRead(context), context);
        if (card) {
          current = Number(card.revision) || current;
          const fresh = { ...part, requestKey: newCentralCalendarRequestKey(), spec: null };
          settled = await sendPart(context, fresh, current);
        }
      } catch {}
    }
    parts.push(settled);
  }
  return { parts, revision: current };
}

function finish(context, { save, run, notFound = false, sessionCount, athleteCount, outsideNames = [] }) {
  const outcome = k3SaveAndLinkOutcome({ save, run, sessionCount, athleteCount, eventTitle: k3EventLabel(context), notFound });
  const note = outsideNames.length ? `${outsideNames.join(", ")} ${outsideNames.length === 1 ? "stays" : "stay"} out: the event is ${k3EventHalf(eventShape(context), context.date) === "PM" ? "in the afternoon" : "in the morning"}.` : "";
  return { ...outcome, note };
}

// The link half of Save and link (2.5 steps 2 - 3), also *Try linking again*.
async function linkSaved(context, { keys, outsideNames }) {
  const saved = context.saved;
  let answer;
  try {
    answer = await calendarRead(context);
  } catch {
    return finish(context, { save: "saved", notFound: true, sessionCount: keys.length, athleteCount: context.athleteCount, outsideNames });
  }
  const card = eventCardOf(answer, context);
  if (!card || card.cancelled) {
    const info = { status: card ? 409 : 404, code: card ? "event_cancelled" : "not_found" };
    saved.run = { parts: [{ ids: [], requestKey: "", state: "refused", info }] };
    return finish(context, { save: "saved", run: saved.run, sessionCount: 0, athleteCount: context.athleteCount, outsideNames });
  }
  const planned = plannedOf(answer);
  const { ids } = k3LogicalIdsFor(planned, keys, saved.planIds);
  if (!ids.length) return finish(context, { save: "saved", notFound: true, sessionCount: keys.length, athleteCount: context.athleteCount, outsideNames });
  const run = k3LinkRun(ids, newCentralCalendarRequestKey);
  const athletes = new Set();
  for (const p of planned) for (const a of p.athletes || []) if (ids.includes(String(a.logicalSessionId))) athletes.add(String(a.athleteId));
  saved.sessionCount = keys.length;
  saved.athleteCount = athletes.size || context.athleteCount;
  const done = await runParts(context, run, Number(card.revision) || 0);
  saved.run = done;
  saved.revision = done.revision;
  return finish(context, { save: "saved", run: done, sessionCount: saved.sessionCount, athleteCount: saved.athleteCount, outsideNames });
}

export const K3_EMPTY_PLAN = "Add an exercise or a named section first: a plan without them isn't saved.";
export const K3_DELETED_EMPTY = "The plan was empty, so it wasn't saved and nothing was linked to the event.";

// The server's own rule for a weekly draft worth saving
// (planHasWeeklyTrainingContentWithClient): an exercise, or a named section.
function draftHasContent(draft) {
  return (draft?.blocks || []).some((block) => (block.sessions || []).some((session) => (session.nodes || []).some((node) => (node.items || []).length > 0 || String(node.name || "").trim())));
}

// *Save and link* (2.5). `submit()` is the Builder's own Save and finish
// (builder-actions.js); it resolves { plan } or throws.
export async function k3SaveAndLink({ submit, render }) {
  const context = k3Context();
  const draft = state.builder.draft;
  if (!context || !draft || context.saving || context.saved) return;
  const { inKeys, outsideNames, misfits } = plannedSessions(context, draft);
  // The server deletes a weekly draft with no exercise and no named section
  // instead of saving it: said before any request, the draft stays.
  if (!draftHasContent(draft)) {
    context.outcome = { state: "empty", tone: "warning", text: K3_EMPTY_PLAN, actions: [] };
    render?.();
    return;
  }
  // O14: a session in the event with its own time outside the window is
  // refused before any request (2.5, 7.1).
  if (misfits.length) {
    context.blocker = misfits[0];
    render?.();
    return;
  }
  context.blocker = null;
  context.saving = true;
  context.outcome = null;
  render?.();
  let plan;
  try {
    plan = await submit();
  } catch (error) {
    context.saving = false;
    const unknown = !error?.status || error.status >= 500;
    context.outcome = finish(context, { save: unknown ? "unconfirmed" : "not_saved", athleteCount: context.athleteCount });
    render?.();
    return;
  }
  invalidateCoachHomeCache();
  invalidateAthleteHomeCache();
  invalidateCentralCalendarCache();
  if (plan?.deleted) {
    // Emptied meanwhile (another tab): the server deleted the draft.
    state.builder.draft = null;
    context.saving = false;
    context.saved = { planIds: [], livePlanId: "", keys: [], outsideNames: [], run: { parts: [] } };
    context.outcome = { state: "deleted_empty", tone: "error", text: K3_DELETED_EMPTY, actions: ["backToCalendar"] };
    render?.();
    return;
  }
  const planIds = livePlanIdsOf(draft, plan?.plan || plan);
  context.saved = { planIds, livePlanId: String((plan?.plan || plan)?.id || planIds[0] || ""), keys: inKeys, outsideNames, run: { parts: [] } };
  // The edit draft is gone with the save: nothing of it may be sent again.
  state.builder.draft = null;
  state.builder.selectedSessionId = "";
  state.builder.selectedNodeId = "";
  context.planIds = [...new Set([...context.planIds, ...planIds])];
  saveK3Memory(context);
  if (!inKeys.length) {
    context.saving = false;
    context.outcome = finish(context, { save: "nothing_to_link", athleteCount: context.athleteCount, outsideNames });
    render?.();
    return;
  }
  context.outcome = { state: "linking", tone: "busy", text: "Linking…", actions: [] };
  render?.();
  context.outcome = await linkSaved(context, { keys: inKeys, outsideNames });
  context.saving = false;
  invalidateCentralCalendarCache();
  render?.();
}

// *Check result*: the unknown parts with their own key and body.
export async function k3CheckResult({ render }) {
  const context = k3Context();
  const saved = context?.saved;
  if (!saved || context.saving) return;
  context.saving = true;
  render?.();
  const done = await runParts(context, saved.run, saved.revision || 0, { check: true });
  saved.run = done;
  context.saving = false;
  context.outcome = finish(context, { save: "saved", run: done, sessionCount: saved.sessionCount, athleteCount: saved.athleteCount, outsideNames: saved.outsideNames });
  invalidateCentralCalendarCache();
  render?.();
}

// *Try linking again*: the refused parts with new keys and the event read
// again (an already linked slot answers alreadyAttached: never a second link).
export async function k3TryLinking({ render }) {
  const context = k3Context();
  const saved = context?.saved;
  if (!saved || context.saving) return;
  context.saving = true;
  context.outcome = { state: "linking", tone: "busy", text: "Linking…", actions: [] };
  render?.();
  const hasParts = saved.run.parts.some((p) => p.ids.length);
  if (!hasParts) {
    context.outcome = await linkSaved(context, { keys: saved.keys, outsideNames: saved.outsideNames });
  } else {
    let revision = saved.revision || 0;
    try {
      const card = eventCardOf(await calendarRead(context), context);
      if (card) revision = Number(card.revision) || revision;
    } catch {}
    const retry = k3RetryRun(saved.run, newCentralCalendarRequestKey);
    retry.parts = retry.parts.map((p) => (p.state === "pending" ? { ...p, spec: null } : p));
    const done = await runParts(context, retry, revision);
    saved.run = done;
    saved.revision = done.revision;
    context.outcome = finish(context, { save: "saved", run: done, sessionCount: saved.sessionCount, athleteCount: saved.athleteCount, outsideNames: saved.outsideNames });
  }
  context.saving = false;
  invalidateCentralCalendarCache();
  render?.();
}

// *Keep editing*: the saved plan opened again as an edit draft (Q10).
export async function k3KeepEditing({ adopt, render }) {
  const context = k3Context();
  const saved = context?.saved;
  if (!saved?.livePlanId || context.saving) return;
  context.saving = true;
  render?.();
  try {
    const draft = await api(`/api/builder/plans/${encodeURIComponent(saved.livePlanId)}/edit`, { method: "POST" });
    context.saved = null;
    context.outcome = null;
    context.saving = false;
    adopt(draft);
  } catch {
    context.saving = false;
    context.outcome = { ...(context.outcome || {}), error: "The plan couldn't be opened again. Try again." };
  }
  render?.();
}

// The band ends with its plan (2.3) or a workspace switch.
export function k3End() {
  const context = k3Context();
  if (context) dropK3Memory(context);
  if (state.builder) state.builder.k3 = null;
}

// Whether a session's own time no longer fits the event (the mark of 7.1).
export function k3SessionTimeMark(context, block, session) {
  const st = k3SessionState(context, block, session);
  if (!st || st.state !== "in" || !session.time) return null;
  const window = k3EventWindow(eventShape(context), block.date);
  return k3TimeFits(session.time, window) ? null : window;
}

export const k3EventShape = eventShape;
export const k3EventRangeText = (context) => [context.startTime, context.endTime].filter(Boolean).join("–");
