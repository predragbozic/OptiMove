// K3 (Plan the training from an event) and K2c-3 (events in the Builder's
// day): the pure parts. Contract: docs/ai/central-calendar-k3-plan.md
// (sections 2, 6 and 7 with O14, O15, Q12, Q14); the look: the owner-approved
// mockups docs/design/calendar-k4/01-03. No DOM, no request, no state: the
// screens (wired after K4-0's Back) call these.
//
// 1. Which plan opens: the cases of GET /api/builder/weekly-plans (#650).
// 2. Whether a session fits an event: the same day, the half of the day
//    (O15, Q14) and the time window (O14, Q12).
// 3. Which Builder session is in which event: the manager view's links.
// 4. Save and link: the attaches of up to 200 sessions, each part with its
//    own key and outcome; never "linked" without a confirmed answer.
import { centralCalendarLinkCheckSettles, centralCalendarLinkRefusalText } from "./central-calendar-links.js";

const norm = (value) => String(value ?? "").trim().toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// 1. Which plan opens (K3 plan 2.2; Q3: case (a) waits for the Builder's batch
//    fix, and until then its sheet says so).
// ---------------------------------------------------------------------------

export const K3_CASE_A_SENTENCE = "Changes go to the athlete on screen only.";

// `answer`: the #650 answer ({ athletes: [{ athleteId, plannable, plan }] }).
// `nameOf(athleteId)`: the coach's roster name, used only for athletes who
// already have a plan the coach may open (case (c) names them).
// Returns { kind, ... }:
//   nobody      - no athlete of the event can be planned from this workspace;
//   new         - (b) none has a plan: a new batch for `athleteIds`;
//   openDraft   - (a') all share one batch that is still a draft: open it;
//   shared      - (a) all share one published batch: open it, one athlete at a time;
//   mixed       - (c) some have a plan: plan for the rest, or open one of the plans.
// `outside`: how many cannot be planned here (counted, never named);
// `blocked`: plans the coach may not open (counted, never named).
export function k3PlanCase(answer, { nameOf = () => "" } = {}) {
  const athletes = Array.isArray(answer?.athletes) ? answer.athletes : [];
  const outside = athletes.filter((a) => a?.plannable !== true).length;
  const plannable = athletes.filter((a) => a?.plannable === true);
  const without = plannable.filter((a) => !a.plan).map((a) => String(a.athleteId));
  const blocked = plannable.filter((a) => a.plan && a.plan.editable !== true).length;
  const openable = plannable.filter((a) => a.plan && a.plan.editable === true).map((a) => ({
    athleteId: String(a.athleteId),
    name: String(nameOf(a.athleteId) || "").trim(),
    planId: String(a.plan.planId),
    // An edit already open by this coach is where the work goes on.
    openPlanId: String(a.plan.openDraftId || a.plan.planId),
    batchId: a.plan.batchId ? String(a.plan.batchId) : null,
    status: a.plan.status === "draft" ? "draft" : "active",
  }));
  const base = { outside, blocked };
  if (!plannable.length) return { kind: "nobody", ...base };
  if (!blocked && !openable.length) return { kind: "new", ...base, athleteIds: without };
  // One shared plan: every plannable athlete has an openable plan of one
  // batch (or the event has one athlete with one plan).
  const batches = new Set(openable.map((p) => p.batchId || `plan:${p.planId}`));
  if (!without.length && !blocked && batches.size === 1) {
    const first = openable[0];
    const allDraft = openable.every((p) => p.status === "draft");
    return { kind: allDraft ? "openDraft" : "shared", ...base, openPlanId: first.openPlanId, athleteCount: openable.length };
  }
  return { kind: "mixed", ...base, athleteIds: without, withPlans: openable };
}

// The sheet's sentence and buttons for a case (screen 01, "some athletes
// already have a plan"); `null` when the Builder opens without a question.
export function k3PlanCaseSheet(planCase) {
  const outsideLine = planCase.outside
    ? `${plural(planCase.outside, "athlete of this event isn't", "athletes of this event aren't")} in your workspace; plan their training in their own workspace.`
    : "";
  if (planCase.kind === "nobody") {
    return { text: "None of this event's athletes can be planned from this workspace.", buttons: ["close"], note: "" };
  }
  if (planCase.kind === "new" || planCase.kind === "openDraft") {
    return outsideLine ? { text: outsideLine, buttons: ["continue", "cancel"], note: "" } : null;
  }
  if (planCase.kind === "shared") {
    return {
      text: `${plural(planCase.athleteCount, "athlete already has", "athletes already have")} this week's plan. ${K3_CASE_A_SENTENCE}`,
      buttons: ["openPlan", "cancel"],
      note: outsideLine,
    };
  }
  const named = planCase.withPlans.map((p) => p.name).filter(Boolean);
  const shown = named.slice(0, 3);
  const more = planCase.withPlans.length - shown.length;
  const list = shown.length ? `: ${shown.join(", ")}${more > 0 ? ` (and ${more} more)` : ""}` : "";
  const parts = [];
  if (planCase.athleteIds.length) parts.push(`${plural(planCase.athleteIds.length, "athlete has", "athletes have")} no plan for this week.`);
  if (planCase.withPlans.length) parts.push(`${planCase.withPlans.length} already ${planCase.withPlans.length === 1 ? "has" : "have"} one${list}.`);
  if (planCase.blocked) parts.push(`${plural(planCase.blocked, "athlete has a plan", "athletes have plans")} you can't open.`);
  const buttons = [];
  if (planCase.athleteIds.length) buttons.push("planForRest");
  if (planCase.withPlans.length) buttons.push("openExisting");
  buttons.push("cancel");
  return { text: parts.join(" "), buttons, note: outsideLine, planForCount: planCase.athleteIds.length };
}

export function k3PlanForLabel(n) {
  return `Plan for the ${n}`;
}

// ---------------------------------------------------------------------------
// 2. Whether a session fits an event (O11 the same day; O15 the half of the
//    day, with Q14 for a multi-day event; O14 the time window, with Q12).
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeOf = (value) => {
  const s = String(value ?? "").slice(0, 5);
  return HHMM.test(s) ? s : "";
};
const lastDayOf = (event) => String(event?.span?.to || event?.endDay || event?.date || event?.day || "");
const firstDayOf = (event) => String(event?.span?.from || event?.day || event?.date || "");

export function k3EventCoversDay(event, day) {
  const from = firstDayOf(event);
  const to = lastDayOf(event) || from;
  return Boolean(day) && Boolean(from) && day >= from && day <= to;
}

// The half of the day an event covers on `day`: "AM", "PM", "both", or null
// (no limit: the event has no time). One day: a start before 12:00 is AM, from
// 12:00 PM, and an end after 12:00 with a start before it covers both. A
// multi-day event (Q14): its first day by its start (it runs on to the end of
// that day: before 12:00 both, from 12:00 PM); the other days both.
export function k3EventHalf(event, day) {
  const start = timeOf(event?.startTime);
  const end = timeOf(event?.endTime);
  if (!start) return null;
  const multi = lastDayOf(event) && firstDayOf(event) && lastDayOf(event) !== firstDayOf(event);
  if (multi) {
    if (day !== firstDayOf(event)) return "both";
    return start < "12:00" ? "both" : "PM";
  }
  if (start >= "12:00") return "PM";
  return end && end > "12:00" ? "both" : "AM";
}

export function k3HalfFits(amPm, half) {
  if (amPm !== "AM" && amPm !== "PM") return true;
  if (!half || half === "both") return true;
  return amPm === half;
}

// The time window on `day` (O14): one day: start to end; no end: not before
// the start (Q12). A multi-day event: from its start on its first day, up to
// its end on its last day, none in between. No start: no window.
export function k3EventWindow(event, day) {
  const start = timeOf(event?.startTime);
  const end = timeOf(event?.endTime);
  if (!start) return null;
  const first = firstDayOf(event);
  const last = lastDayOf(event) || first;
  if (first === last) return { from: start, to: end || null };
  if (day === first) return { from: start, to: null };
  if (day === last) return end ? { from: null, to: end } : null;
  return null;
}

export function k3TimeFits(time, window) {
  const t = timeOf(time);
  if (!t || !window) return true;
  if (window.from && t < window.from) return false;
  if (window.to && t > window.to) return false;
  return true;
}

function windowText(window) {
  if (!window) return "";
  if (window.from && window.to) return `${window.from}–${window.to}`;
  if (window.from) return `from ${window.from}`;
  return `until ${window.to}`;
}

function halfWords(half) {
  return half === "AM" ? "in the morning" : "in the afternoon";
}

// Whether `session` ({ name, amPm, time }) on `day` may join `event`, and if
// not, why and the one sentence (screens 01 and 02). `reason`: "day" | "half"
// | "time".
export function k3SessionFit(session, event, day) {
  if (!k3EventCoversDay(event, day)) return { fits: false, reason: "day", text: "A session can only join an event of its own day." };
  const half = k3EventHalf(event, day);
  if (!k3HalfFits(session?.amPm, half)) {
    return { fits: false, reason: "half", text: `${k3SessionLabel(session)} (${session.amPm}) stays out: the event is ${halfWords(half)}.` };
  }
  const window = k3EventWindow(event, day);
  if (!k3TimeFits(session?.time, window)) {
    return {
      fits: false,
      reason: "time",
      text: `${k3SessionLabel(session)} is at ${timeOf(session.time)}, outside the event (${windowText(window)}). Change its time first.`,
    };
  }
  return { fits: true, reason: "", text: "" };
}

// The mark on a linked session that no longer fits (the event moved): the
// words and the one action (screen 02, step 3). Nothing changes by itself.
export function k3OutsideMark(fit, event, day) {
  if (fit.fits) return null;
  if (fit.reason === "half") {
    return { text: "Outside the event's half of the day", action: k3EventHalf(event, day) === "PM" ? "moveToPm" : "moveToAm" };
  }
  if (fit.reason === "time") return { text: `Outside the event's time (${windowText(k3EventWindow(event, day))})`, action: "useEventTime" };
  return null;
}

// The events the Event list offers a session (screen 02, step 2): that day's
// events of the session's half; a non-managed one is listed, locked.
export function k3SelectorEvents(events, session, day) {
  return (events || [])
    .filter((event) => event && !event.cancelled && k3EventCoversDay(event, day) && k3HalfFits(session?.amPm, k3EventHalf(event, day)))
    .map((event) => ({ event, locked: event.canManage !== true }));
}

// The time shown on a session line (O12 / O14): its own, else the event's.
export function k3SessionTimeText(session, event) {
  const own = timeOf(session?.time);
  if (own) return own;
  const start = timeOf(event?.startTime);
  return start ? `${start} · from the event` : "";
}

export function k3SessionLabel(session) {
  const name = String(session?.name ?? "").trim();
  if (name) return name;
  return { B: "Before training", T: "Training", A: "After training" }[session?.bta] || "This session";
}

// ---------------------------------------------------------------------------
// 3. Which Builder session is in which event (6.1): the manager view's links
//    (linkFacts: planId, day, amPm, bta, sessionName, state, id), matched to a
//    Builder session by its D16b key (day, AM/PM, B/T/A, trimmed lower-case
//    name) over the plans of the batch.
// ---------------------------------------------------------------------------

export function k3SessionKey(day, session) {
  return [String(day || ""), session?.amPm || "", session?.bta || "", norm(session?.name ?? session?.sessionName)].join("|");
}

// `eventViews`: [{ event, view }] for the managed events of the week (view =
// GET /api/calendar/events/:id). `planIds`: the batch's live plan ids.
// Returns Map(sessionKey -> { eventId, linkIds: [...] }); a session whose
// links name two events is reported under `conflicts` (never guessed).
export function k3PlacedSessions(eventViews, planIds) {
  const plans = new Set((planIds || []).map(String));
  const placed = new Map();
  const conflicts = new Set();
  for (const { event, view } of eventViews || []) {
    const eventId = String(event?.eventId || event?.id || view?.id || "");
    for (const link of view?.sessionLinks || []) {
      // An unnamed session is linked too (its name is ""): only a link with no
      // live session (orphaned) is left out.
      if (!plans.has(String(link.planId)) || link.state === "orphaned") continue;
      const key = k3SessionKey(link.day, { amPm: link.amPm || "", bta: link.bta || "", name: link.sessionName ?? "" });
      const entry = placed.get(key);
      if (entry && entry.eventId !== eventId) {
        conflicts.add(key);
        continue;
      }
      if (!entry) placed.set(key, { eventId, linkIds: [String(link.id)] });
      else entry.linkIds.push(String(link.id));
    }
  }
  for (const key of conflicts) placed.delete(key);
  return { placed, conflicts };
}

// A live session that is neither a planned card of the day nor in a managed
// event's links is in an event the coach does not manage (6.1). `planned`:
// the day's planned cards (kind "planned"); `sessions`: [{ day, amPm, bta,
// name }].
export function k3InOtherEvent(sessions, planned, placed, planIds) {
  const plans = new Set((planIds || []).map(String));
  const plannedKeys = new Set();
  for (const card of planned || []) {
    if (card?.kind !== "planned" || !(card.athletes || []).some((a) => plans.has(String(a.planId)))) continue;
    plannedKeys.add(k3SessionKey(card.date, { amPm: card.slot?.amPm || "", bta: card.slot?.bta || "", name: card.title }));
  }
  return new Set((sessions || []).map((s) => k3SessionKey(s.day, s)).filter((key) => !plannedKeys.has(key) && !placed.has(key)));
}

// The logical ids to link for the sessions marked in the event (2.5 step 2):
// the planned cards of the batch's plans whose key is one of `keys`.
export function k3LogicalIdsFor(planned, keys, planIds) {
  const plans = new Set((planIds || []).map(String));
  const wanted = new Set(keys || []);
  const ids = [];
  const found = new Set();
  for (const card of planned || []) {
    if (card?.kind !== "planned") continue;
    const key = k3SessionKey(card.date, { amPm: card.slot?.amPm || "", bta: card.slot?.bta || "", name: card.title });
    if (!wanted.has(key)) continue;
    for (const a of card.athletes || []) {
      if (plans.has(String(a.planId)) && a.logicalSessionId) {
        ids.push(String(a.logicalSessionId));
        found.add(key);
      }
    }
  }
  return { ids: [...new Set(ids)], missing: [...wanted].filter((key) => !found.has(key)) };
}

// ---------------------------------------------------------------------------
// 4. Save and link (2.5): the attaches of up to 200 logical ids each, every
//    part with its own requestKey and outcome. "Linked" only when every part
//    has a confirmed answer; a partial success is said, never hidden.
// ---------------------------------------------------------------------------

export const K3_ATTACH_MAX = 200;

export function k3LinkRun(ids, makeKey) {
  const unique = [...new Set((ids || []).map(String))];
  const parts = [];
  for (let i = 0; i < unique.length; i += K3_ATTACH_MAX) {
    parts.push({ ids: unique.slice(i, i + K3_ATTACH_MAX), requestKey: makeKey(), state: "pending", attached: 0, alreadyAttached: 0, info: null });
  }
  return { parts };
}

// One part's answer. `data`: a 200 body; `info`: centralCalendarErrorInfo of a
// refusal or a lost answer; `check`: this was a Check result (the same key).
// A lost answer, a 5xx or outcome_unknown leaves the part "unknown"; on a Check
// result only the answers given after the request record settle it.
export function k3SettlePart(part, { data = null, info = null, check = false } = {}) {
  if (data) {
    return { ...part, state: "linked", attached: Number(data.attached) || 0, alreadyAttached: Number(data.alreadyAttached) || 0, info: null };
  }
  const lost = !info || info.code === "no_answer" || info.code === "outcome_unknown" || (info.status >= 500 && info.code !== "try_again");
  if (lost) return { ...part, state: "unknown", info };
  if (check && !centralCalendarLinkCheckSettles(info)) return { ...part, state: "unknown", info };
  return { ...part, state: "refused", info };
}

// A part refused with event_changed is read again and sent once more with a
// fresh key and the new revision (the revision is not the coach's choice).
export const k3PartRetriesOnStale = (part) => part.state === "refused" && part.info?.code === "event_changed";

// The parts to send again: unknown ones with their own key (Check result,
// never a second link); refused ones only on *Try linking again*, each with a
// new key.
export function k3RetryRun(run, makeKey) {
  return {
    parts: run.parts.map((part) => (part.state === "refused" ? { ...part, requestKey: makeKey(), state: "pending", info: null } : part)),
  };
}

// The outcome of Save and link (screen 01, step 3; plan 2.5). `save`:
// "saved" | "not_saved" | "unconfirmed" | "nothing_to_link". `eventTitle`,
// `athleteCount`: for the sentence.
export function k3SaveAndLinkOutcome({ save, run = { parts: [] }, sessionCount = 0, athleteCount = 0, eventTitle = "the event", notFound = false }) {
  if (save === "not_saved") return { state: "not_saved", tone: "error", text: "The plan wasn't saved, so nothing was linked to the event.", actions: ["tryAgain"] };
  if (save === "unconfirmed") {
    return { state: "save_unconfirmed", tone: "warning", text: "We couldn't confirm the plan was saved. If it was, link it from the event in the calendar.", actions: ["tryAgain", "backToCalendar"] };
  }
  if (save === "nothing_to_link") return { state: "saved_nothing", tone: "ok", text: "Saved. No session was put in the event.", actions: ["backToCalendar"] };
  if (notFound) return { state: "saved_not_found", tone: "warning", text: "Saved, but the training isn't on the calendar yet, so it wasn't linked.", actions: ["tryLinking", "backToCalendar"] };
  const parts = run.parts || [];
  const linked = parts.filter((p) => p.state === "linked");
  const unknown = parts.filter((p) => p.state === "unknown");
  const refused = parts.filter((p) => p.state === "refused");
  const pending = parts.filter((p) => p.state === "pending");
  if (!parts.length) return { state: "saved_nothing", tone: "ok", text: "Saved. No session was put in the event.", actions: ["backToCalendar"] };
  if (pending.length) return { state: "linking", tone: "busy", text: "Linking…", actions: [] };
  if (linked.length === parts.length) {
    return {
      state: "linked",
      tone: "ok",
      text: `Saved. ${plural(sessionCount, "session", "sessions")} for ${plural(athleteCount, "athlete", "athletes")} ${sessionCount === 1 ? "is" : "are"} in ${eventTitle}.`,
      actions: ["backToCalendar", "keepEditing"],
    };
  }
  const total = parts.reduce((n, p) => n + p.ids.length, 0);
  const done = linked.reduce((n, p) => n + p.ids.length, 0);
  const lead = linked.length ? `Saved. ${done} of ${total} links are confirmed.` : "Saved.";
  if (unknown.length) {
    return { state: linked.length ? "partial_unknown" : "unconfirmed", tone: "warning", text: linked.length ? `${lead} We couldn't confirm the rest. Checking never links twice.` : "Saved. We couldn't confirm the link. Checking never links twice.", actions: ["checkResult"] };
  }
  const reason = centralCalendarLinkRefusalText(refused[0].info || {});
  return { state: linked.length ? "partial_refused" : "refused", tone: "warning", text: `${lead} ${linked.length ? "The rest weren't linked. " : ""}${reason}`, actions: ["tryLinking", "backToCalendar"] };
}
