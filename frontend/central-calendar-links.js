// Central calendar (K2c-1, docs/ai/central-calendar-k2c-plan.md section 1.1):
// linking a Builder training or a recorded activity to a calendar event from
// the calendar's panels. The pure parts only - the suggestion rule over the
// calendar answer already loaded (nothing new is read for it), the grouping
// of the manager view's session links, the request bodies and every sentence
// the coach reads. Nothing here talks to the server or touches the state.

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
  if (item?.kind === "planned") return `${eventId}|planned|${[...(item.links?.logicalSessionIds || [])].map(String).sort().join(",")}`;
  if (item?.kind === "activity") return `${eventId}|activity|${String(item.links?.activityIds?.[0] || "")}`;
  return "";
}

// The reason a refused pair keeps on its row (`refused` maps a pair key to the
// code the server answered).
export function centralCalendarRefusedReason(code) {
  return code === "session_already_attached" || code === "activity_already_attached" ? "Already linked to another event." : "Can't be linked here.";
}
const refusalOf = (refused, key) => (refused?.get?.(key) ? centralCalendarRefusedReason(refused.get(key)) : "");

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
      if (covers(event, item)) out.trainings.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(event.eventId, item)) });
      else if (sharesAny(event, item)) out.partial += 1;
    } else if (item.kind === "activity" && (item.links?.activityIds || []).length && sharesAny(event, item)) {
      out.activities.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(event.eventId, item)) });
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
    if (covers(item, planned)) out.events.push({ item, refused: refusalOf(refused, centralCalendarRefusedPairKey(item.eventId, planned)) });
    else if (sharesAny(item, planned)) out.partial.push(item);
  }
  return out;
}

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

export function centralCalendarLinkRequest(act, { eventId, requestKey, expectedRevision, logicalSessionIds, linkIds, activityId, confirmDisableWithResults = false }) {
  const base = { requestKey, expectedRevision };
  if (act === "link-session") return { path: `${eventPath(eventId)}/sessions`, body: { ...base, logicalSessionIds: [...logicalSessionIds], alignSessions: false } };
  if (act === "unlink-sessions") return { path: `${eventPath(eventId)}/sessions/detach`, body: { ...base, linkIds: [...linkIds] } };
  if (act === "align") return { path: `${eventPath(eventId)}/sessions/align`, body: { ...base, confirmDisableWithResults } };
  if (act === "link-activity") return { path: `${eventPath(eventId)}/activities`, body: { ...base, activityId } };
  if (act === "unlink-activity") return { path: `${eventPath(eventId)}/activities/detach`, body: { ...base, activityId } };
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
export const CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED = "Some linked trainings can't be changed from here.";

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

const BUSY_WORDS = Object.freeze({ "link-session": "Linking…", "link-activity": "Linking…", "unlink-sessions": "Unlinking…", "unlink-activity": "Unlinking…", align: "Updating…" });
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
    const parts = [alignment.direction === "rpe_off" ? "The linked trainings no longer ask for RPE." : "The linked trainings now ask for RPE."];
    if (notAllowed > 0) parts.push(CENTRAL_CALENDAR_ALIGN_NOT_ALLOWED);
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
  "athlete_not_targeted", "activity_not_targeted"]);
export const centralCalendarLinkRefusalRereads = (info) => info.status === 404 || REREAD.has(info.code);

// The refusals that the read cannot predict: the pair is remembered and
// shown without its Link (the manager's GO, section 1.1.10). The two
// "not targeted" codes too (review M2): a card without its athletes cannot
// tell a linked athlete who is no target any more.
const UNPREDICTABLE = new Set(["session_not_available", "session_already_attached", "activity_not_available", "activity_already_attached",
  "athlete_not_targeted", "activity_not_targeted"]);
export const centralCalendarLinkRefusalRemembered = (info) => UNPREDICTABLE.has(info.code);

// Check result: these answers come only after the server read its request
// record (the replay precedes every check), so they settle the first write
// as not saved; any other answer leaves it not confirmed.
const SETTLED_ON_CHECK = new Set([
  "event_changed", "event_cancelled", "session_not_available", "session_outside_event", "athlete_not_targeted",
  "session_already_attached", "link_not_available", "nothing_to_align", "has_existing_results", "activity_not_available",
  "activity_superseded", "activity_outside_event", "activity_not_targeted", "activity_already_attached",
]);
export const centralCalendarLinkCheckSettles = (info) => info.status >= 400 && info.status < 500
  && (SETTLED_ON_CHECK.has(info.code) || String(info.code).startsWith("invalid_"));
