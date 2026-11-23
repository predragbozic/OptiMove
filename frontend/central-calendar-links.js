// Central calendar (K2c-1, docs/ai/central-calendar-k2c-plan.md section 1.1):
// linking a Builder training or a recorded activity to a calendar event from
// the calendar's panels. The pure parts only - the suggestion rule over the
// calendar answer already loaded (nothing new is read for it), the grouping
// of the manager view's session links, the request bodies and every sentence
// the coach reads. Nothing here talks to the server or touches the state.
import { k3EventHalf, k3HalfFits } from "./central-calendar-k3.js";

// The athletes an event reaches on its day. When the card carries its
// athletes (the day's read), a linked athlete who is no target any more
// (`targeted: false`, applyEventFold) does not count: the server refuses a
// link for them (athlete_not_targeted / activity_not_targeted).
function athleteSet(item) {
  if (item?.kind === "event" && Array.isArray(item.athletes) && item.athletes.length) {
    return new Set(item.athletes.filter((a) => a.targeted !== false).map((a) => String(a.athleteId)));
  }
  return new Set((item?.athleteIds || []).map(String));
}

// Every athlete of `inner` is one of `outer`'s (the attach is all or nothing
// and refuses a non-target: 409 athlete_not_targeted).
function covers(outer, inner) {
  const ids = inner?.athleteIds || [];
  if (!ids.length) return false;
  const reach = athleteSet(outer);
  return ids.every((id) => reach.has(String(id)));
}

function sharesAny(outer, inner) {
  const reach = athleteSet(outer);
  return (inner?.athleteIds || []).some((id) => reach.has(String(id)));
}

const dayItems = (data, date) => (data?.days || []).find((day) => day.date === date)?.items || [];

// An event the coach may link things to: a manager's planned event.
export function centralCalendarEventLinkable(item) {
  return item?.kind === "event" && item.canManage === true && item.cancelled !== true;
}

// The identity of a link the server refused for reasons the read cannot see
// (section 1.1.10): the event and the training's sessions, or the activity.
export function centralCalendarRefusedPairKey(eventId, item) {
  if (item?.kind === "external") return `${eventId}|external|${String(item.links?.externalScheduleId || "")}`;
  if (item?.kind === "planned") return `${eventId}|planned|${[...(item.links?.logicalSessionIds || [])].map(String).sort().join(",")}`;
  if (item?.kind === "activity") return `${eventId}|activity|${String(item.links?.activityIds?.[0] || "")}`;
  return "";
}

// The reason a refused pair keeps on its row (`refused` maps a pair key to
// { code, revision }: the server's code and the event's revision it was sent
// with).
const NOT_TARGETED = new Set(["athlete_not_targeted", "activity_not_targeted"]);
export function centralCalendarRefusedReason(code) {
  if (code === "session_already_attached" || code === "activity_already_attached") return "Already linked to another event.";
  if (NOT_TARGETED.has(code)) return "Some athletes are not in this event.";
  if (code === "schedule_already_referenced") return "Already in another event.";
  if (code === "rpe_from_sessions" || code === "rpe_from_question") return "This event already takes RPE another way.";
  return "Can't be linked here.";
}
// A "not targeted" refusal holds only while the event is as it was (review
// N1): a coach who adds the athletes to the event changes its revision, and
// the pair is offered again.
function refusalOf(refused, key, event) {
  const entry = refused?.get?.(key);
  if (!entry) return "";
  if (NOT_TARGETED.has(entry.code) && Number(entry.revision) !== Number(event?.revision)) return "";
  return centralCalendarRefusedReason(entry.code);
}

// The suggestions of an event card's panel (section 1.1.2): the planned cards
// of its day whose athletes are all the event's, the activity cards of its
// day with at least one of its athletes, and the count of the planned cards
// that share some athletes but not all (a quiet line). A pair refused before
// stays listed, without its Link (`refused`: the row's short reason).
export function centralCalendarLinkSuggestions(data, event, refused = new Map()) {
  const out = { trainings: [], activities: [], partial: 0 };
  if (!centralCalendarEventLinkable(event)) return out;
  for (const item of dayItems(data, event.date)) {
    if (item.kind === "planned" && (item.links?.logicalSessionIds || []).length) {
      if (covers(event, item)) out.trainings.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(event.eventId, item), event) });
      else if (sharesAny(event, item)) out.partial += 1;
    } else if (item.kind === "activity" && (item.links?.activityIds || []).length && sharesAny(event, item)) {
      out.activities.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(event.eventId, item), event) });
    }
  }
  return out;
}

// The events a planned card's panel offers (section 1.1.2): the manager's
// planned events of its day that reach all of its athletes; `partial` the
// manageable events that share some of its athletes but not all (each gets
// a quiet line).
export function centralCalendarEventsForPlanned(data, planned, refused = new Map()) {
  const out = { events: [], partial: [] };
  if (planned?.kind !== "planned" || !(planned.links?.logicalSessionIds || []).length) return out;
  for (const item of dayItems(data, planned.date)) {
    if (!centralCalendarEventLinkable(item)) continue;
    if (covers(item, planned)) out.events.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(item.eventId, planned), item) });
    else if (sharesAny(item, planned)) out.partial.push(item);
  }
  return out;
}

// K5-3 (docs/ai/central-calendar-k5-plan.md, "Add to the event?"): the events a LONE activity or RPE request card
// (one that folded into no event, so it is its own card on the day) may be added to. Never done automatically: the
// panel asks. The rule, over the calendar answer already loaded (nothing new is read):
// - the event is a manager's planned event of kind training or match on the same day;
// - an activity: at least one of its athletes is a target of the event (the server's attachActivity rule), and its
//   start falls in the half of the day the event covers (K4 O15, k3EventHalf; no start or no event time: no limit);
// - an RPE request: every one of its athletes is a target of the event (the only case in which the event card folds
//   it, calendarQuery's scheduleFold), the event refers to no RPE schedule yet (a PATCH would replace it) and has no
//   linked training (RPE comes from those: rpe_from_sessions). Its time is when the RPE opens, not when it trained,
//   so no half-of-day rule.
// A test schedule is never offered (owner's A2: a test schedule fits only an event of kind test). A pair the server
// refused for a reason the read cannot see stays listed without its Add (`refused`).
export const CENTRAL_CALENDAR_ADD_EVENT_KINDS = Object.freeze(["training", "match"]);

function halfOfStart(value) {
  const s = String(value ?? "").slice(0, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return null;
  return s < "12:00" ? "AM" : "PM";
}

export function centralCalendarAddToEventKind(item) {
  if (!item || item.cancelled === true || !(item.athleteIds || []).length) return "";
  if (item.kind === "activity" && item.links?.activityIds?.[0]) return "activity";
  if (item.kind === "external" && item.links?.externalScheduleId) return "rpe";
  return "";
}

export function centralCalendarAddToEventOffers(data, item, refused = new Map()) {
  const what = centralCalendarAddToEventKind(item);
  if (!what) return [];
  const out = [];
  for (const event of dayItems(data, item.date)) {
    if (!centralCalendarEventLinkable(event) || !CENTRAL_CALENDAR_ADD_EVENT_KINDS.includes(event.eventKind)) continue;
    if (what === "activity") {
      if (!sharesAny(event, item) || !k3HalfFits(halfOfStart(item.startTime), k3EventHalf(event, item.date))) continue;
    } else {
      if (!covers(event, item) || event.links?.externalScheduleId || (event.links?.logicalSessionIds || []).length) continue;
    }
    out.push({ item: event, refused: refusalOf(refused, centralCalendarRefusedPairKey(event.eventId, item), event) });
  }
  out.sort((a, b) => String(a.item.startTime || "99:99").localeCompare(String(b.item.startTime || "99:99")) || String(a.item.title || "").localeCompare(String(b.item.title || "")));
  return out;
}

// The event's name in the question: its title and, when it has one, its start ("Training 10:00").
export function centralCalendarAddToEventName(event) {
  const title = String(event?.title ?? "").replace(/\s+/g, " ").trim() || "the event";
  const time = String(event?.startTime ?? "").slice(0, 5);
  return /^\d\d:\d\d$/.test(time) && !title.includes(time) ? `${title} ${time}` : title;
}
export const centralCalendarAddToEventQuestion = (event) => `Add to “${centralCalendarAddToEventName(event)}”?`;
export const CENTRAL_CALENDAR_ADD_TO_EVENT_HINT = Object.freeze({
  activity: "The activity then shows inside the event. Unlink in the event undoes it.",
  rpe: "The event then collects this RPE request. Edit the event to remove it.",
});
export const centralCalendarAddToEventDone = (event) => `Added to “${centralCalendarAddToEventName(event)}”.`;

const normalizedName = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// The manager view's live session links of one day, grouped as the coach sees
// them (one Builder batch = one row): by day, slot (with its order) and
// current session name; the orphaned ones (the Builder session is gone) apart.
// The manager view names no plan owner, and a plan is one athlete's, so two
// same-named trainings of two owners in one slot and order stay one row
// (section 1.2, the deviation from the review's F5).
export function centralCalendarSessionLinkGroups(event, date) {
  const groups = new Map();
  const orphaned = [];
  const orphanedTrainings = new Set();
  for (const link of event?.sessionLinks || []) {
    if (date && link.day !== date) continue;
    if (link.state === "orphaned") {
      orphaned.push(String(link.id));
      orphanedTrainings.add([link.day, link.amPm || "", link.bta || "", normalizedName(link.sessionNameAtLink)].join("|"));
      continue;
    }
    const key = [link.day, link.amPm || "", link.bta || "", Number(link.order) || 0, normalizedName(link.sessionName)].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        key, day: link.day, slot: { amPm: link.amPm || null, bta: link.bta || null, order: link.order || 0 },
        name: String(link.sessionName ?? "").trim(), renamedFrom: "", linkIds: [], athletes: new Set(),
      });
    }
    const group = groups.get(key);
    group.linkIds.push(String(link.id));
    if (link.athleteId) group.athletes.add(String(link.athleteId));
    if (link.state === "renamed" && !group.renamedFrom) group.renamedFrom = String(link.sessionNameAtLink ?? "").trim();
  }
  const list = [...groups.values()].map((group) => ({ ...group, linkIds: group.linkIds.sort(), athleteCount: group.athletes.size || group.linkIds.length }));
  list.sort((a, b) => (a.slot.amPm || "").localeCompare(b.slot.amPm || "") || a.name.localeCompare(b.name));
  return { groups: list, orphaned: orphaned.sort(), orphanedCount: orphanedTrainings.size };
}

export function centralCalendarActivityLinksOf(event, date) {
  return (event?.activityLinks || []).filter((link) => !date || link.day === date);
}

// ---------------------------------------------------------------------------
// The requests (section 1.1.5)
// ---------------------------------------------------------------------------
const EVENTS_BASE = "/api/calendar/events";
const eventPath = (eventId) => `${EVENTS_BASE}/${encodeURIComponent(eventId)}`;

export function centralCalendarLinkRequest(act, { eventId, requestKey, expectedRevision, logicalSessionIds, linkIds, activityId, externalScheduleId, confirmDisableWithResults = false }) {
  const base = { requestKey, expectedRevision };
  if (act === "link-session") return { path: `${eventPath(eventId)}/sessions`, body: { ...base, logicalSessionIds: [...logicalSessionIds], alignSessions: false } };
  if (act === "unlink-sessions") return { path: `${eventPath(eventId)}/sessions/detach`, body: { ...base, linkIds: [...linkIds] } };
  if (act === "align") return { path: `${eventPath(eventId)}/sessions/align`, body: { ...base, confirmDisableWithResults } };
  if (act === "link-activity") return { path: `${eventPath(eventId)}/activities`, body: { ...base, activityId } };
  if (act === "unlink-activity") return { path: `${eventPath(eventId)}/activities/detach`, body: { ...base, activityId } };
  // K5-3: the event takes the RPE request through its own edit route (PATCH, the event form's field).
  if (act === "add-rpe") return { path: eventPath(eventId), method: "PATCH", body: { ...base, externalScheduleId } };
  return null;
}

// ---------------------------------------------------------------------------
// The sentences (sections 1.1.3 - 1.1.6)
// ---------------------------------------------------------------------------
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const quoted = (value, fallback) => `“${String(value ?? "").replace(/\s+/g, " ").trim() || fallback}”`;

// The Align row (the manager's decision M6): no number - the card's count is
// per Builder session and per day, the route changes the whole event. A first
// press shows the step's sentence and its two buttons; only the second sends.
export function centralCalendarAlignLine(event) {
  const n = Number(event?.alignment?.pending) || 0;
  if (n < 1) return null;
  if ((event.expects || []).includes("rpe")) {
    return {
      text: "The linked trainings do not ask for RPE yet.", button: "Ask for RPE in the linked trainings",
      step: "Athletes of the linked trainings will be asked for RPE after each training.", confirm: "Ask for RPE",
    };
  }
  return {
    text: "The linked trainings still ask for RPE, which this event does not collect.", button: "Stop asking for RPE in the linked trainings",
    step: "Athletes of the linked trainings will no longer be asked for RPE.", confirm: "Stop asking",
  };
}
export const CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED = "Some linked trainings can't be changed from here. Their plan's coach can change them in the Builder.";

export function centralCalendarPartialLine(n) {
  if (n < 1) return "";
  return n === 1 ? "1 more training that day has athletes this event does not include." : `${n} more trainings that day have athletes this event does not include.`;
}

export const CENTRAL_CALENDAR_ORPHANED_META = "Unlink to clear it; nothing else changes.";
export const CENTRAL_CALENDAR_LINKED_HINT = "A linked training shows inside this event on the calendar. Unlink undoes it.";
export const CENTRAL_CALENDAR_LINKS_LOAD_FAILED = "Linked trainings and activities could not be loaded.";
export function centralCalendarPlannedPartialLine(event) {
  return `“${String(event?.title ?? "").replace(/\s+/g, " ").trim() || "This event"}” does not include all of these athletes. Add them to the event, then link.`;
}

export function centralCalendarOrphanedLine(n) {
  return n === 1 ? "1 linked training was deleted in the Builder." : `${n} linked trainings were deleted in the Builder.`;
}

export const CENTRAL_CALENDAR_LINK_EMPTY = "No training or activity on this day can be linked to this event.";

const BUSY_WORDS = Object.freeze({ "add-activity": "Adding…", "add-rpe": "Adding…", "link-session": "Linking…", "link-activity": "Linking…", "unlink-sessions": "Unlinking…", "unlink-activity": "Unlinking…", align: "Updating…" });
export const centralCalendarLinkBusyWord = (act) => BUSY_WORDS[act] || "Saving…";

// The notice after a confirmed write. `event` is the event card after the
// calendar was read again (its `alignment.pending` decides the tail of a link
// of a training, the manager's GO (c)).
export function centralCalendarLinkDoneText(act, { name = "", data = null, event = null } = {}) {
  if (act === "link-session") {
    const head = `Linked ${quoted(name, "the training")}.`;
    const align = centralCalendarAlignLine(event);
    if (!align) return head;
    return (event.expects || []).includes("rpe")
      ? `${head} These trainings do not ask for RPE yet: use Ask for RPE in the linked trainings.`
      : `${head} These trainings still ask for RPE: use Stop asking for RPE in the linked trainings.`;
  }
  if (act === "unlink-sessions") return `Unlinked ${quoted(name, "the training")}.`;
  if (act === "link-activity") return `Linked ${quoted(name, "the activity")}.`;
  if (act === "unlink-activity") return "Unlinked the activity.";
  if (act === "align") {
    const alignment = data?.alignment || {};
    const changed = Number(alignment.changed) || 0;
    const notAllowed = Number(alignment.notAllowed) || 0;
    if (changed === 0 && notAllowed > 0) return CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED;
    // A partial Align (review N2): only the trainings this workspace manages
    // changed; the row says the rest and is not offered again.
    const whose = notAllowed > 0 ? "The linked trainings you manage" : "The linked trainings";
    const parts = [alignment.direction === "rpe_off" ? `${whose} no longer ask for RPE.` : `${whose} now ask for RPE.`];
    if ((Number(alignment.switchOff) || 0) > 0) parts.push("RPE requests are switched off in Training Load, so athletes will not be asked until they are switched on.");
    return parts.join(" ");
  }
  return "Saved.";
}

// The question of the server's own gate (409 has_existing_results), shown in
// the Align row with [Stop asking] and [Not now].
export function centralCalendarResultsQuestion(count) {
  const n = Number(count) || 0;
  return `Stop asking for RPE in the linked trainings? ${n > 0 ? `${plural(n, "RPE answer was", "RPE answers were")} already given` : "RPE answers were already given"}; they are kept.`;
}

// One plain sentence per refusal (section 1.1.6); no code or id.
const REFUSALS = Object.freeze({
  event_changed: "This event was changed meanwhile. The calendar was read again: try again.",
  event_cancelled: "This event is cancelled, so nothing can be linked to it.",
  session_not_available: "This training can't be linked to this event: it may have changed in the Builder, or its plan belongs to another club or team. Nothing was saved.",
  session_outside_event: "This training is not on the event's day. Nothing was saved.",
  athlete_not_targeted: "Some athletes of this training are not part of this event. Add them to the event first, or link another training.",
  session_already_attached: "This training is already linked to another event you can't open here. Ask that event's organiser to unlink it. Nothing was saved.",
  link_not_available: "This link was already removed. The calendar was read again.",
  nothing_to_align: "No linked training needs to change. The calendar was read again.",
  activity_not_available: "This activity can't be linked to this event here. Nothing was saved.",
  activity_superseded: "This activity was merged into another one. The calendar was read again: link that one.",
  activity_outside_event: "This activity is not on the event's day. Nothing was saved.",
  activity_not_targeted: "No athlete of this activity is part of this event. Nothing was saved.",
  activity_already_attached: "This activity is already linked to another event you can't open here. Ask that event's organiser to unlink it. Nothing was saved.",
  // RPE channels (K2b-2a-1, RPE-1): the event's RPE comes from one place only.
  rpe_already_linked: "This event already collects RPE through another schedule; remove it first. Nothing was saved.",
  rpe_already_answered: "Athletes have already answered this event's own RPE question, so trainings can't take it over. Keep the event's RPE, or link the training to another event. Nothing was saved.",
  rpe_from_question: "This event already asks athletes for RPE; remove that question first. Nothing was saved.",
  // K5-3: an RPE request added to an event (PATCH).
  rpe_from_sessions: "This event takes RPE from its linked trainings, so it can't take this RPE request. Nothing was saved.",
  schedule_not_available: "This RPE request can't be added to this event here. Nothing was saved.",
  schedule_already_referenced: "This RPE request already belongs to another event. Nothing was saved.",
  try_again: "The calendar is busy. Nothing was saved; try again in a moment.",
  request_key_reused: "This could not be sent. Nothing was saved; try again.",
});

export function centralCalendarLinkRefusalText(info) {
  if (info.status === 401) return "Please sign in again. Nothing was saved.";
  if (info.status === 404) return "This event is not available any more.";
  if (info.status === 403) return "Events cannot be changed in this workspace. Nothing was saved.";
  return REFUSALS[info.code] || "Nothing was saved. Try again.";
}

// The refusals after which the calendar is read again (what is shown changed,
// or the read cannot tell this pair will be refused - section 1.1.10).
const REREAD = new Set(["event_changed", "event_cancelled", "link_not_available", "nothing_to_align", "activity_superseded",
  "session_not_available", "session_already_attached", "activity_not_available", "activity_already_attached",
  "athlete_not_targeted", "activity_not_targeted", "schedule_not_available", "schedule_already_referenced", "rpe_from_sessions", "rpe_from_question"]);
export const centralCalendarLinkRefusalRereads = (info) => info.status === 404 || REREAD.has(info.code);

// The refusals that the read cannot predict: the pair is remembered and
// shown without its Link (the manager's GO, section 1.1.10). The two
// "not targeted" codes too (review M2): a card without its athletes cannot
// tell a linked athlete who is no target any more.
const UNPREDICTABLE = new Set(["session_not_available", "session_already_attached", "activity_not_available", "activity_already_attached",
  "athlete_not_targeted", "activity_not_targeted", "schedule_not_available", "schedule_already_referenced", "rpe_from_sessions", "rpe_from_question"]);
export const centralCalendarLinkRefusalRemembered = (info) => UNPREDICTABLE.has(info.code);

// Check result: these answers come only after the server read its request
// record (the replay precedes every check), so they settle the first write
// as not saved; any other answer leaves it not confirmed.
const SETTLED_ON_CHECK = new Set([
  "event_changed", "event_cancelled", "session_not_available", "session_outside_event", "athlete_not_targeted",
  "session_already_attached", "link_not_available", "nothing_to_align", "has_existing_results", "activity_not_available",
  "activity_superseded", "activity_outside_event", "activity_not_targeted", "activity_already_attached",
  "rpe_already_linked", "rpe_already_answered", "rpe_from_question",
  "rpe_from_sessions", "schedule_not_available", "schedule_already_referenced",
]);
export const centralCalendarLinkCheckSettles = (info) => info.status >= 400 && info.status < 500
  && (SETTLED_ON_CHECK.has(info.code) || String(info.code).startsWith("invalid_"));
