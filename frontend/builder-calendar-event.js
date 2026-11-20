// K2c-2-F (docs/ai/central-calendar-k2c-plan.md 2.1, with the manager's GO in
// 2.2): "Make an event" from a Builder session - the pure parts. Which
// Builder plan and session may offer it, how the session is found on the
// calendar's own day read (the D16b planned group), the event's pre-filled
// fields, the one create request (K2c-2-B, `sessions` on create) and every
// sentence. No DOM, no request: builder-calendar-event-actions.js sends,
// builder-calendar-event-view.js draws.

// The workspaces that may create an event (v49's writer bases: a club's
// admin, a team's coach, a private coach). The platform workspace answers
// 403 workspace_required; the athlete never sees the Builder's coach tools.
export const BUILDER_EVENT_WORKSPACES = Object.freeze(new Set(["club", "team", "private_coach"]));

const norm = (value) => String(value ?? "").trim().toLowerCase();

// The plan whose sessions the calendar shows: the live plan of an edit
// draft, else the plan itself (a saved plan opened without an edit draft).
export function builderCalendarLivePlanId(draft) {
  const plan = draft?.plan || {};
  return String(plan.isEditDraft ? plan.editSourcePlanId || "" : plan.id || "");
}

// The button is offered on a weekly plan's session with a dated day, in a
// workspace that may create events.
export function builderCalendarEventOffered(draft, block, workspaceType) {
  const plan = draft?.plan;
  if (!plan || plan.planType !== "weekly" || plan.isTemplate) return false;
  if (!BUILDER_EVENT_WORKSPACES.has(workspaceType)) return false;
  return Boolean(block?.date);
}

// A plan never saved has no live session on the calendar: the button is off
// with this line.
export const SAVE_FIRST = "Save the plan first, then make the event.";
export function builderCalendarEventBlockedReason(draft) {
  const plan = draft?.plan || {};
  if (!plan.isEditDraft && (plan.status || "draft") === "draft") return SAVE_FIRST;
  return "";
}

// ---------------------------------------------------------------------------
// The match on the day read (2.1.3, decision 2 of 2.2)
// ---------------------------------------------------------------------------
// No card of this session (ux review MEDIUM-1 and -2): the edit draft cannot
// tell which cause it is, so the sentence names both with their next steps;
// the panel also offers Open in calendar (the day) to see what is there.
export const MATCH_SENTENCES = Object.freeze({
  apply: "This training isn't on the calendar yet. Apply your changes to the plan, or check that the plan is for athletes of this workspace on this day.",
  absent: "This training isn't on this workspace's calendar. Check that the plan is for athletes of this workspace on this day.",
  ambiguous: "This training matches more than one training on the calendar, so no event was made. Make it from the calendar instead.",
  linkedMany: "This training is already in the calendar. Open the calendar to see it.",
  // An event for this training was sent and its result is not confirmed (a
  // panel released by a plan change): never a second create beside it.
  pending: "An event for this training isn't confirmed yet. Check it in the calendar.",
});
export const linkedSentence = (title) => `This training is in the calendar as “${oneLine(title) || "an event"}”.`;

// `answer`: GET /api/calendar for the session's day. The planned card of
// this session is the one of its live plan, slot (AM / PM, B / T / A) and
// trimmed, case-insensitive name (D16b's key). A session already linked is
// folded under its event and is no planned card: an event card of that day
// holding the live plan is then the session's event - but the event card
// names no slot or name per folded session, so it counts as this session's
// only when the session is its day's one session in the Builder, or the
// event's title is the session's name (code review MEDIUM: another session
// of the same plan and day linked to an event is not this one).
//   { kind: "planned", card } | { kind: "linked", event } | { kind: "linked_many" }
//   | { kind: "ambiguous" } | { kind: "none", reason: "apply" | "absent" }
export function builderCalendarMatch({ draft, block, session, answer }) {
  const planId = builderCalendarLivePlanId(draft);
  const date = String(block?.date || "");
  const items = (answer?.days || []).filter((day) => day.date === date).flatMap((day) => day.items || []);
  const holdsPlan = (item) => Array.isArray(item?.links?.planIds) && item.links.planIds.map(String).includes(planId);
  const planned = items.filter((item) => item.kind === "planned" && holdsPlan(item)
    && (item.slot?.amPm ?? null) === (session?.amPm || null)
    && (item.slot?.bta ?? null) === (session?.bta || null)
    && norm(item.title) === norm(session?.name));
  if (planned.length > 1) return { kind: "ambiguous" };
  if (planned.length === 1) return { kind: "planned", card: planned[0] };
  const onlySession = (block?.sessions || []).length <= 1;
  const events = items.filter((item) => item.kind === "event" && !item.cancelled && holdsPlan(item)
    && (onlySession || norm(item.title) === norm(session?.name)));
  if (events.length === 1) return { kind: "linked", event: events[0] };
  if (events.length > 1) return { kind: "linked_many" };
  return { kind: "none", reason: draft?.plan?.isEditDraft ? "apply" : "absent" };
}

// Whether the draft on screen still holds a session (a plan change in the
// series replaces the whole draft).
export function builderCalendarDraftHoldsSession(draft, sessionId) {
  return (draft?.blocks || []).some((block) => (block.sessions || []).some((session) => session.id === sessionId));
}

export function builderCalendarMatchSentence(match) {
  if (match.kind === "linked") return linkedSentence(match.event.title);
  if (match.kind === "linked_many") return MATCH_SENTENCES.linkedMany;
  if (match.kind === "ambiguous") return MATCH_SENTENCES.ambiguous;
  if (match.kind === "pending") return MATCH_SENTENCES.pending;
  if (match.kind === "none") return MATCH_SENTENCES[match.reason] || MATCH_SENTENCES.absent;
  return "";
}

// ---------------------------------------------------------------------------
// The form (2.1.4 as amended by 2.2: no RPE checkbox)
// ---------------------------------------------------------------------------
export const NO_TRAINING_TYPE = "This workspace has no Training event type. A club admin can add one in Settings → Calendar.";

// The workspace's types of kind `training`, in the catalog's order.
export function builderCalendarTrainingTypes(types) {
  return (Array.isArray(types) ? types : []).filter((type) => type?.kind === "training");
}

export function builderCalendarEventDraft({ card, session, types }) {
  const training = builderCalendarTrainingTypes(types);
  return {
    title: oneLine(card?.title) || oneLine(session?.name) || "Training",
    typeId: training[0]?.id ? String(training[0].id) : "",
    startTime: card?.startTime ? String(card.startTime).slice(0, 5) : "",
    endTime: "",
  };
}

export function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// A local check before sending (the server checks again).
export function builderCalendarEventFormError(form) {
  const title = oneLine(form?.title);
  if (!title) return "Give the event a title.";
  if (title.length > 120) return "The title can be at most 120 characters.";
  if (!form?.typeId) return NO_TRAINING_TYPE;
  if (form.endTime && !form.startTime) return "Add a start time, or leave the end time empty.";
  if (form.startTime && form.endTime && form.endTime <= form.startTime) return "The end time must be after the start time.";
  return "";
}

// The event expects RPE exactly when its training asks for it (decision 5 of
// 2.2): the type's other defaults stay as they are.
export function builderCalendarEventExpects(type, card) {
  const base = (Array.isArray(type?.defaultExpects) ? type.defaultExpects : []).filter((value) => value !== "rpe");
  return card?.rpe ? ["rpe", ...base] : base;
}

// The one create request (K2c-2-B): the group's athletes one by one as the
// targets (decision 4), the group's sessions linked in the same transaction,
// never aligned from here (`alignSessions: false`, decision 5).
export function builderCalendarEventBody({ form, card, type, day, requestKey, timezone }) {
  return {
    requestKey,
    eventTypeId: form.typeId,
    title: oneLine(form.title),
    day,
    ...(form.startTime ? { startTime: form.startTime } : {}),
    ...(form.endTime ? { endTime: form.endTime } : {}),
    timezone,
    expects: builderCalendarEventExpects(type, card),
    targets: (card?.athleteIds || []).map((id) => ({ kind: "athlete", id: String(id) })),
    sessions: { logicalSessionIds: (card?.links?.logicalSessionIds || []).map(String), alignSessions: false },
  };
}

// ---------------------------------------------------------------------------
// The outcomes (2.1.6)
// ---------------------------------------------------------------------------
export const RESULT_NOT_CONFIRMED = "We couldn't confirm the event was made.";
export const CHECK_NEVER_TWICE = "Checking never makes a second event.";
export const FINISH_FIRST = "Finish the event being made first.";
export const WAITING_FOR_SAVE = "Saving your changes first…";
export const CHECK_STILL_NOT_CONFIRMED = "Still not confirmed. Check again in a moment.";

export function builderCalendarEventDoneText(title, day) {
  return `Event made: “${oneLine(title) || "the event"}”, ${formatDay(day)}.`;
}

export function builderCalendarEventDoneNotes(alignment) {
  const notes = [];
  if (alignment?.notAllowed > 0) notes.push("Some of these trainings belong to another coach's plan and were left as they are.");
  if (alignment?.switchOff > 0) notes.push("RPE requests are switched off in Training Load, so athletes will not be asked until they are switched on.");
  return notes;
}

// One plain sentence per refusal; never a code or an id.
const REFUSALS = Object.freeze({
  session_already_attached: "This training is already in another event. Open the calendar to see it.",
  session_not_available: "This training can't be added to an event from this workspace. Nothing was saved.",
  session_outside_event: "This training is not on the event's day any more. Nothing was saved.",
  athlete_not_targeted: "Some athletes of this training can't be part of an event of this workspace. Nothing was saved.",
  target_not_available: "Some athletes of this training are not in this workspace on that day. Nothing was saved.",
  invalid_targets: "This training has no athletes to invite. Nothing was saved.",
  type_not_available: "This event type is no longer available. Choose another one.",
  invalid_type: "This event type is no longer available. Choose another one.",
  invalid_align: "This could not be sent. Nothing was saved; try again.",
  invalid_sessions: "This could not be sent. Nothing was saved; try again.",
  rpe_from_sessions: "This could not be sent. Nothing was saved; try again.",
  try_again: "The calendar is busy. Nothing was saved; try again in a moment.",
  request_key_reused: "This could not be sent. Nothing was saved; try again.",
  workspace_required: "Open your club's or team's workspace to make events. Nothing was saved.",
  invalid_title: "Give the event a title of at most 120 characters. Nothing was saved.",
  invalid_time: "Check the start and end times. Nothing was saved.",
  invalid_day: "Check the day. Nothing was saved.",
});
export function builderCalendarEventRefusalText(info) {
  if (REFUSALS[info?.code]) return REFUSALS[info.code];
  if (info?.status === 401) return "Please sign in again. Nothing was saved.";
  if (info?.status === 403) return "Events can't be made in this workspace. Nothing was saved.";
  if (info?.status === 404) return "This training is not available any more. Nothing was saved.";
  return "Nothing was saved. Try again.";
}

// Refusals after which the day is read again, so the panel shows what is
// true now (for "already in another event": the event's line).
export const REREAD_AFTER = Object.freeze(new Set([
  "session_already_attached", "session_not_available", "session_outside_event", "athlete_not_targeted", "target_not_available",
]));

// Check result sends the same request again. These answers come after the
// server's request record showed that nothing was saved under the key (the
// replay precedes every check of the create) or concern the body itself: they
// settle the first write as "Nothing was saved". Any other answer (busy, no
// access, signed out, a server error) leaves it not confirmed.
const SETTLED_ON_CHECK = Object.freeze(new Set([
  "session_already_attached", "session_not_available", "session_outside_event", "athlete_not_targeted", "target_not_available",
  "type_not_available", "invalid_type", "invalid_targets", "invalid_sessions", "invalid_align", "rpe_from_sessions",
  "invalid_title", "invalid_day", "invalid_time", "invalid_timezone", "invalid_expects", "invalid_request_key",
]));
export const builderCalendarEventCheckSettles = (info) => info?.status >= 400 && info.status < 500 && SETTLED_ON_CHECK.has(info.code);

// "Wed 18.11.2026" (the Builder's day words; the browser's local date, no
// time zone shift for a plain ISO day).
export function formatDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!match) return String(iso || "");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()];
  return `${weekday} ${match[3]}.${match[2]}.${match[1]}`;
}

// The in-memory "In calendar" badge of a session made into an event in this
// Builder (2.1.8): the live plan, the day, the slot and the name.
export function builderCalendarMadeKey(draft, block, session) {
  return [builderCalendarLivePlanId(draft), block?.date || "", session?.amPm || "", session?.bta || "", norm(session?.name)].join("|");
}
