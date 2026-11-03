import { currentUserWorkspaceContextParts } from "./access.js";
import { state } from "./state.js";
import { addDaysIso, addMonthsIso, localDateIso } from "./utils.js";
import {
  CENTRAL_CALENDAR_EVENT_KINDS,
  CENTRAL_CALENDAR_KINDS,
  CENTRAL_CALENDAR_VIEWS,
  cancelCentralCalendarEvent,
  centralCalendarCheckSettles,
  centralCalendarErrorInfo,
  centralCalendarOutcomeUnknown,
  createCentralCalendarEvent,
  fetchCentralCalendarEvent,
  fetchCentralCalendarEventTypes,
  invalidateCentralCalendarCache,
  loadCentralCalendar,
  loadCentralCalendarDay,
  newCentralCalendarRequestKey,
  updateCentralCalendarEvent,
  writeCentralCalendarWeekMode,
} from "./central-calendar-data.js";
import {
  buildCentralCalendarEventRequest,
  centralCalendarEditFormFromEvent,
  centralCalendarFormTypesLoaded,
  newCentralCalendarCancelForm,
  newCentralCalendarCreateForm,
  newCentralCalendarEditForm,
  newCentralCalendarPendingForm,
  renderCentralCalendarAthleteListHtml,
  setCentralCalendarFormExpect,
  setCentralCalendarFormField,
  setCentralCalendarFormTarget,
} from "./central-calendar-event-form.js";
import { centralCalendarDisplayedDays } from "./central-calendar-view.js";

// Central calendar (K1b, K2a-2) - every data-action="central-calendar-*" of
// the screen (docs/ai/central-calendar-k1b-plan.md,
// docs/ai/central-calendar-k2a-2-plan.md). Navigation, the view and mode
// switches and the chips change the state slice and paint; a range change
// reads through central-calendar-data.js; the two drill-ins hand over to the
// shell (D5: an athlete's weekly plan on the day; D14: the Training Load
// activity). The only writes are the event form's (K2a-2): create, edit and
// cancel, each with a requestKey, never sent again by itself.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return ISO_DATE.test(String(value || ""));
}

// "phone" (<= 760 px, the app's own mobile breakpoint), "medium" (761-1023
// px) or "wide" (>= 1024 px, the time grid and the side panel). Without
// matchMedia (tests) the screen is wide.
export function centralCalendarLayout() {
  const win = globalThis.window;
  if (!win || typeof win.matchMedia !== "function") return "wide";
  try {
    if (win.matchMedia("(max-width: 760px)")?.matches) return "phone";
    if (win.matchMedia("(max-width: 1023px)")?.matches) return "medium";
  } catch {
    return "wide";
  }
  return "wide";
}

function closedPanel() {
  return { open: false, key: "", date: "", athletes: null, loading: false, error: "" };
}

// A repaint replaces the whole markup (the shell sets innerHTML). These two
// keep what a repaint would otherwise drop: each chip row's sideways scroll
// on a phone (keyed by the row's label) and the focused control (by its
// action and its key, date, team or kind), the Coach Home strips' pattern.
// K2a-2 adds the event form's field (by its data-cc-focus, with the caret)
// and the panel's own scroll (a sheet or the side column scrolls inside).
export function captureCentralCalendarView(root) {
  if (!root?.querySelectorAll) return null;
  const scroll = {};
  for (const row of root.querySelectorAll(".cc-chip-row")) {
    const label = row.getAttribute?.("aria-label");
    if (label && row.scrollLeft) scroll[label] = row.scrollLeft;
  }
  const panelScroll = root.querySelector?.(".cc-panel")?.scrollTop || 0;
  const active = globalThis.document?.activeElement;
  const inside = Boolean(active && root.contains?.(active));
  let field = null;
  if (inside && active.dataset?.ccFocus) {
    field = { key: active.dataset.ccFocus, start: null, end: null };
    try {
      if (typeof active.selectionStart === "number") field = { ...field, start: active.selectionStart, end: active.selectionEnd };
    } catch {
      // A date, time or checkbox input has no caret.
    }
  }
  const focus = !field && inside && active?.dataset?.action
    ? { action: active.dataset.action, key: active.dataset.key || "", date: active.dataset.date || "", teamId: active.dataset.teamId || "", kind: active.dataset.kind || "", eventKind: active.dataset.eventKind || "", view: active.dataset.view || "", mode: active.dataset.mode || "" }
    : null;
  return { scroll, focus, field, panelScroll };
}

export function restoreCentralCalendarView(root, snapshot) {
  if (!root?.querySelectorAll || !snapshot) return;
  for (const row of root.querySelectorAll(".cc-chip-row")) {
    const label = row.getAttribute?.("aria-label");
    if (label && snapshot.scroll[label]) row.scrollLeft = snapshot.scroll[label];
  }
  const panel = root.querySelector?.(".cc-panel");
  if (panel && snapshot.panelScroll) panel.scrollTop = snapshot.panelScroll;
  if (snapshot.field) {
    const input = root.querySelector?.(`[data-cc-focus="${cssValue(snapshot.field.key)}"]`);
    if (input && !input.disabled) {
      input.focus?.({ preventScroll: true });
      if (snapshot.field.start !== null) {
        try {
          input.setSelectionRange?.(snapshot.field.start, snapshot.field.end);
        } catch {
          // The input changed its type meanwhile.
        }
      }
    }
    return;
  }
  const focus = snapshot.focus;
  if (!focus) return;
  // The sheet's backdrop shares the close action with the Close button and
  // comes first in the markup: never the element to give the focus back to.
  const selector = [`[data-action="${cssValue(focus.action)}"]:not(.cc-sheet-backdrop)`];
  for (const [name, value] of [["key", focus.key], ["date", focus.date], ["team-id", focus.teamId], ["kind", focus.kind], ["event-kind", focus.eventKind], ["view", focus.view], ["mode", focus.mode]]) {
    if (value) selector.push(`[data-${name}="${cssValue(value)}"]`);
  }
  root.querySelector?.(selector.join(""))?.focus?.({ preventScroll: true });
}

// A value inside a quoted attribute selector: CSS.escape where the browser
// has it, else the two characters that could end the string.
function cssValue(value) {
  const text = String(value);
  return typeof globalThis.CSS?.escape === "function" ? globalThis.CSS.escape(text) : text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// After a close the focus goes back to the card (or the month's compact
// card) the panel was opened from: the sheet is modal below 1024 px and the
// repaint destroyed the old element.
function focusCard(key) {
  if (!key) return;
  const value = cssValue(key);
  globalThis.document?.querySelector?.(`.cc-card[data-key="${value}"], .cc-mini[data-key="${value}"]`)?.focus?.({ preventScroll: true });
}

// Back and Escape close the event form or an open item panel first; false
// when there was nothing to close (or the calendar is not the open screen).
// With `render` the screen is drawn again and the focus returns to the card.
// A form that is saving, not confirmed or holds unsaved values asks first;
// a "No" keeps it and answers CENTRAL_CALENDAR_STAYED, so app.js's Back puts
// back the history entry it consumed (its BACK_STAYED, the same word).
export const CENTRAL_CALENDAR_STAYED = "stayed";

export function closeCentralCalendarPanel(render) {
  if (state.activeTab !== "central-calendar") return false;
  const cal = state.centralCalendar;
  if (cal.form) return closeEventForm(render) ? true : CENTRAL_CALENDAR_STAYED;
  if (!cal.panel.open) return false;
  const key = cal.panel.key;
  cal.panel = closedPanel();
  render?.();
  if (render) focusCard(key);
  return true;
}

function toggleValue(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) list.splice(index, 1);
  else list.push(value);
}

function movedAnchor(cal, direction) {
  if (cal.view === "month") return addMonthsIso(cal.anchor, direction);
  return addDaysIso(cal.anchor, direction * (cal.view === "week" ? 7 : 1));
}

// The weekly plan's own route reads plans by the roster row's business id
// (`athlete_id` / the source external id, routes/athletes.js), never by the
// UUID the calendar API names athletes with. The rail's roster
// (state.athletes) maps one to the other; an athlete not in it (left the
// team, archived, a dual member of another club) has no weekly-plan
// drill-in here (null) - the row is shown without a button.
export function centralCalendarRosterAthleteId(athleteUuid) {
  const row = (state.athletes || []).find((athlete) => String(athlete?.athlete_uuid || "") === String(athleteUuid));
  return row?.athlete_id || null;
}

// The view's lookup: every UUID of the roster that has a weekly-plan id.
export function centralCalendarRosterIndex() {
  const index = new Map();
  for (const athlete of state.athletes || []) {
    if (athlete?.athlete_uuid && athlete?.athlete_id) index.set(String(athlete.athlete_uuid), String(athlete.athlete_id));
  }
  return index;
}

// ---------------------------------------------------------------------------
// Events (K2a-2, docs/ai/central-calendar-k2a-2-plan.md section 4)
// ---------------------------------------------------------------------------
// Who may create (the K2a plan's 4.1): the owner of a club, a team or a
// private coach's workspace - the answer's own workspace decides, and the
// server decides again on the write. The platform workspace edits only
// (support); the athlete never reaches this screen.
const CREATE_WORKSPACES = new Set(["club", "team", "private_coach"]);
const NOT_AVAILABLE = "This event is no longer available in this workspace.";

export function centralCalendarCanCreateEvents() {
  return CREATE_WORKSPACES.has(state.centralCalendar.data?.workspace?.type);
}

// The workspace's athletes as the form's targets: the rail roster's UUID
// (the id the API takes) and name.
export function centralCalendarEventRoster() {
  return (state.athletes || []).filter((athlete) => athlete?.athlete_uuid).map((athlete) => ({ id: String(athlete.athlete_uuid), name: athlete.athlete || "" }));
}

function ask(question) {
  return Boolean(globalThis.window?.confirm?.(question));
}

const DISCARD_QUESTION = Object.freeze({ create: "Discard the new event you have not saved?", edit: "Discard the changes you have not saved?", cancel: "Discard the reason you have typed?" });

// The writes the coach left while their result was not known - in flight or
// not confirmed (the independent review of PR #306, HIGH-1). Memory only, by
// sign-in and workspace: the pattern of PR #146's unconfirmed identity load.
// While one waits, New event (for a create) and that event's own Edit /
// Cancel open "Check the earlier result" first, which sends the SAME body and
// key - never by itself; a settled answer removes it. A workspace switch keeps
// it under its own workspace (never shown in another); a reload or sign-out
// drops all of them (the page asks first).
const uncertainWrites = new Map();

// The sign-in and the active workspace (the view cache's own parts), never
// the calendar answer - a read that failed must not lose the entry.
function workspaceKeyOf() {
  const [userId, type, scopeId] = currentUserWorkspaceContextParts();
  return userId && type ? `${userId}|${type}:${scopeId ?? ""}` : "";
}

export function centralCalendarUncertainWrites() {
  return uncertainWrites.get(workspaceKeyOf()) || [];
}

function rememberUncertainWrite(form) {
  const key = workspaceKeyOf();
  if (!key || !form?.sentBody || !form.requestKey) return;
  const title = form.mode === "create" ? oneLineTitle(form.sentBody.title) : form.eventTitle;
  const entry = {
    mode: form.mode, eventId: form.eventId || "", eventTitle: title || "", requestKey: form.requestKey, sentBody: form.sentBody,
    key: form.key || "", date: form.mode === "create" ? form.sentBody.day : form.date, span: form.span || null, revision: form.revision,
  };
  uncertainWrites.set(key, [...(uncertainWrites.get(key) || []).filter((other) => other.requestKey !== form.requestKey), entry]);
}

function forgetUncertainWrite(requestKey) {
  for (const [key, list] of uncertainWrites) {
    const rest = list.filter((entry) => entry.requestKey !== requestKey);
    if (rest.length) uncertainWrites.set(key, rest);
    else uncertainWrites.delete(key);
  }
}

// Any workspace's: a reload or a sign-out drops them all.
function anyUncertainWrite() {
  return [...uncertainWrites.values()].some((list) => list.length > 0);
}

// Tests start over from here.
export function clearCentralCalendarUncertainWrites() {
  uncertainWrites.clear();
}

// Leaving the form (another item, Escape / Back, a workspace switch through
// app.js): a save in flight, a result not confirmed or unsaved values are
// asked about first. A move to another menu keeps the form (the slice stays).
// Left while its result is not known, a write is kept to check later.
// `final`: leaving the page itself, asked before its request - "sign-out"
// (true too) or "switch" (into or out of the athlete workspace, which loads
// the page again). Nothing can be checked after it, so a write kept to check
// counts too (in any workspace), form or not.
const FINAL_WORDS = Object.freeze({
  "sign-out": { verb: "Sign out", later: "It cannot be checked after signing out." },
  switch: { verb: "Switch", later: "It cannot be checked after this switch: the page is loaded again." },
});

export function centralCalendarMayBeLeft({ final = false } = {}) {
  const cal = state.centralCalendar;
  const form = cal?.form;
  const words = final ? FINAL_WORDS[final === true ? "sign-out" : final] || FINAL_WORDS["sign-out"] : null;
  const later = words ? words.later : "You can check it later under New event or the event.";
  const verb = words ? words.verb : "Leave";
  const waiting = () => Boolean(words) && anyUncertainWrite();
  if (!form) return waiting() ? ask(`The result of an event's save is not confirmed. ${later} ${verb} anyway?`) : true;
  let leave = true;
  if (form.busy) leave = ask(`An event is still being saved. ${verb} anyway? Its result will not be shown here. ${later}`);
  else if (form.unconfirmed) leave = form.pending && !words ? true : ask(`The last save of an event is not confirmed. ${verb} without checking? ${later}`);
  else if (form.dirty && DISCARD_QUESTION[form.mode]) leave = ask(DISCARD_QUESTION[form.mode]);
  else if (waiting()) leave = ask(`The result of an event's save is not confirmed. ${later} ${verb} anyway?`);
  if (leave && (form.busy || form.unconfirmed)) rememberUncertainWrite(form);
  return leave;
}

// app.js's "beforeunload": closing or reloading the page loses the only view
// of a save in flight or not confirmed (the form's or a write kept to check),
// and unsaved values. A navigation the app makes on purpose (a sign-out, a
// switch into or out of the athlete workspace) has asked already. The app's
// own probe (app-update.js `workInProgress`, an untrusted event) counts only
// what is being saved; unsaved values are asked about by its `mayLeave`.
export function handleCentralCalendarBeforeUnload(event) {
  if (state.deliberateNavigation) return false;
  const form = state.centralCalendar?.form;
  const saving = Boolean(form && (form.busy || form.unconfirmed)) || anyUncertainWrite();
  const unsaved = Boolean(form?.dirty) && event?.isTrusted !== false;
  if (!saving && !unsaved) return false;
  event.preventDefault();
  event.returnValue = "An event is not saved or its result is not confirmed.";
  return true;
}

// After the panel's content changed: a sheet's Close (the sheet is modal
// below 1024 px), else the open item's card, else New event.
function focusPanelStart(cal) {
  const doc = globalThis.document;
  const sheetClose = doc?.querySelector?.(".cc-sheet .cc-panel-close");
  if (sheetClose) {
    sheetClose.focus?.();
    return;
  }
  if (cal.form) {
    // The first field; a pending check has none - its Check result.
    (doc?.querySelector?.(".cc-panel [data-cc-focus]") || doc?.querySelector?.('.cc-panel [data-action="central-calendar-event-check-result"]') || doc?.querySelector?.(".cc-panel .cc-panel-close"))?.focus?.({ preventScroll: true });
    return;
  }
  if (cal.panel.open) focusCard(cal.panel.key);
  else doc?.querySelector?.(".cc-new-event")?.focus?.({ preventScroll: true });
}

// `rereadRender` paints the read below when the caller paints the rest itself
// (another item opened: `render` is null here, the handler draws the panel).
function closeEventForm(render, { asked = false, rereadRender = render } = {}) {
  const cal = state.centralCalendar;
  const form = cal.form;
  if (!form) return true;
  if (!asked && !centralCalendarMayBeLeft()) return false;
  cal.form = null;
  render?.();
  focusPanelStart(cal);
  // A save in flight or not confirmed may have landed: the calendar is read
  // again at once (never the cached answer from before it), and the write is
  // kept to check (centralCalendarMayBeLeft) before it is made a second time.
  if ((form.busy || form.unconfirmed) && !form.pending) void rereadAfterUncertainWrite(cal, rereadRender, form);
  return true;
}

// The line after leaving a write whose result is not known: whether the read
// worked, and where the write waits to be checked. A read that failed says so
// - never "the calendar was read again" over the last calendar loaded.
function uncertainNotice(form, { readFailed }) {
  const title = form.mode === "create" ? oneLineTitle(form.draft.title) : oneLineTitle(form.eventTitle);
  const what = form.mode === "create" ? `“${title || "the new event"}”` : form.mode === "cancel" ? `cancelling “${title || "the event"}”` : `the change to “${title || "the event"}”`;
  const how = form.mode === "create"
    ? "New event offers Check result first: use it before creating the event again."
    : `The event's Edit and Cancel offer Check result first: use it before ${form.mode === "cancel" ? "cancelling" : "changing"} the event again.`;
  return readFailed
    ? `The result of ${what} is not confirmed, and the calendar could not be read again, so it may not show the result yet. ${how}`
    : `The result of ${what} is not confirmed. The calendar was read again. ${how}`;
}

// A settled answer's line, when the read after it failed: the calendar on
// screen is the one from before the write.
const READ_FAILED_TAIL = " The calendar could not be read again, so it may not show this yet.";

function oneLineTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Whether the read just made failed: the calendar on screen (if any) is the
// last one loaded, not a fresh one (central-calendar-data.js sets these).
function readFailed(cal) {
  return Boolean(cal.error || cal.refreshError);
}

// The calendar read again after the coach left `form`'s write while its result
// was not known; the line says what the read gave. When the write's own answer
// settled meanwhile (lateAnswer), its line wins and this one is not written.
async function rereadAfterUncertainWrite(cal, render, form) {
  invalidateCentralCalendarCache();
  if (state.centralCalendar !== cal) return;
  await loadCentralCalendar({ render, forceRefresh: true });
  if (state.centralCalendar !== cal) return;
  if (!centralCalendarUncertainWrites().some((entry) => entry.requestKey === form.requestKey)) return;
  cal.notice = uncertainNotice(form, { readFailed: readFailed(cal) });
  render?.();
}

// The waiting write to check first, if any: a create before New event, an
// edit or a cancel of the same event before its Edit / Cancel.
function pendingEntryFor({ mode, eventId = "" }) {
  const list = centralCalendarUncertainWrites();
  if (mode === "create") return list.find((entry) => entry.mode === "create") || null;
  return list.find((entry) => entry.mode !== "create" && entry.eventId && entry.eventId === eventId) || null;
}

function openPendingCheck(cal, entry, render) {
  if (cal.form || !entry) return;
  cal.form = newCentralCalendarPendingForm(entry);
  render?.();
  focusPanelStart(cal);
}

// "Forget it without checking…" on a pending check: after a question that
// names what may already have happened, the write is no longer waited for.
const FORGET_QUESTION = Object.freeze({
  create: "Forget this save without checking? If the event was created, creating it again makes a second one: look for it in the calendar first.",
  edit: "Forget this save without checking? If the change was saved, the event already has it: look at the event first.",
  cancel: "Forget this save without checking? If the event was cancelled, it already shows as cancelled: look at the event first.",
});

function forgetPendingCheck(cal, render) {
  const form = cal.form;
  if (!form?.pending || form.busy) return;
  if (!ask(FORGET_QUESTION[form.mode])) return;
  forgetUncertainWrite(form.requestKey);
  cal.form = null;
  cal.notice = "";
  render?.();
  focusPanelStart(cal);
}

// The types are read once per workspace (the slice is reset on a switch).
// A new form reads the types again when Settings -> Calendar changed them
// while the last form was open (centralCalendarCatalogChanged).
function dropStaleEventTypes(cal) {
  if (!cal.eventTypesStale || cal.form) return;
  cal.eventTypes = null;
  cal.eventTypesStale = false;
}

async function ensureEventTypes(cal) {
  if (cal.eventTypes) return { types: cal.eventTypes };
  try {
    const data = await fetchCentralCalendarEventTypes();
    const types = Array.isArray(data?.types) ? data.types : [];
    if (state.centralCalendar === cal) cal.eventTypes = types;
    return { types };
  } catch (error) {
    return { error: centralCalendarErrorInfo(error) };
  }
}

function typesErrorOf(info) {
  if (info.status === 401) return { text: "Please sign in again.", retry: false };
  if (info.status === 403 || info.status === 404) return { text: "Events cannot be created in this workspace.", retry: false };
  return { text: "The event types could not be read.", retry: true };
}

function workspaceOwner(cal) {
  const ws = cal.data?.workspace || {};
  const teams = cal.data?.teams || [];
  const label = state.currentUser?.activeWorkspace?.label || "";
  if (ws.type === "club") return { scope: "club", id: String(ws.scopeId), name: label };
  if (ws.type === "team") return { scope: "team", id: String(ws.scopeId), name: teams.find((team) => team.teamId === ws.scopeId)?.name || label };
  return { scope: "user", id: String(state.currentUser?.id || ""), name: "" };
}

// A new event's day: the Day view's day, the selected day when it is shown,
// today when it is shown, else the first displayed day.
function newEventDay(cal) {
  if (cal.view === "day") return cal.anchor;
  const days = centralCalendarDisplayedDays(cal.view, cal.anchor);
  const today = localDateIso();
  if (days.includes(cal.selectedDate)) return cal.selectedDate;
  if (days.includes(today)) return today;
  return days[0] || today;
}

async function loadCreateTypes(form, cal, render) {
  const result = await ensureEventTypes(cal);
  if (state.centralCalendar !== cal || cal.form !== form) return;
  if (result.error) {
    const failure = typesErrorOf(result.error);
    form.loading = false;
    form.loadError = failure.text;
    form.loadRetry = failure.retry;
  } else if (!result.types.length) {
    form.loading = false;
    form.loadError = "No event types are available in this workspace.";
    form.loadRetry = false;
  } else {
    centralCalendarFormTypesLoaded(form, result.types);
  }
  render?.();
  focusPanelStart(cal);
}

async function openCreateForm(render) {
  const cal = state.centralCalendar;
  if (!centralCalendarCanCreateEvents() || cal.form) return;
  // A create the coach left unconfirmed is checked first (HIGH-1): a second
  // one could be a duplicate.
  const waiting = pendingEntryFor({ mode: "create" });
  if (waiting) return openPendingCheck(cal, waiting, render);
  dropStaleEventTypes(cal);
  const owner = workspaceOwner(cal);
  const teams = cal.data?.teams || [];
  // A team workspace's own team; a club's teams the Groups chips chose.
  const targets = owner.scope === "team"
    ? [{ kind: "team", id: owner.id, name: owner.name }]
    : owner.scope === "club"
      ? teams.filter((team) => cal.filters.teamIds.includes(team.teamId)).map((team) => ({ kind: "team", id: team.teamId, name: team.name || "" }))
      : [];
  const form = newCentralCalendarCreateForm({ day: newEventDay(cal), owner, types: cal.eventTypes, targets });
  form.loading = !cal.eventTypes;
  cal.form = form;
  render?.();
  if (form.loading) await loadCreateTypes(form, cal, render);
  else focusPanelStart(cal);
}

async function loadEditEvent(form, cal, render) {
  const [typesResult, eventResult] = await Promise.all([
    ensureEventTypes(cal),
    fetchCentralCalendarEvent(form.eventId).then((data) => ({ event: data?.event || null }), (error) => ({ error: centralCalendarErrorInfo(error) })),
  ]);
  if (state.centralCalendar !== cal || cal.form !== form) return;
  if (eventResult.error?.status === 404 || (eventResult.event && eventResult.event.canManage !== true)) {
    // The identical 404 (ADR-006), or a reader's view: never a hint why.
    await settleAndReload(cal, render, { notice: eventResult.error ? NOT_AVAILABLE : "This event can no longer be changed in this workspace.", panelKey: form.key, panelDate: form.date });
    return;
  }
  if (eventResult.error || !eventResult.event) {
    form.loading = false;
    form.loadError = eventResult.error?.status === 401 ? "Please sign in again." : "The event could not be read.";
    form.loadRetry = eventResult.error?.status !== 401;
    render?.();
    return;
  }
  const ws = cal.data?.workspace || {};
  const teams = cal.data?.teams || [];
  const label = state.currentUser?.activeWorkspace?.label || "";
  centralCalendarEditFormFromEvent(form, eventResult.event, {
    types: typesResult.types || [],
    typesFailed: Boolean(typesResult.error),
    // The platform workspace edits as support: its lists are not the
    // event's own workspace's, so the type and the targets stay as they are.
    readOnly: ws.type === "platform",
    names: {
      club: (id) => (ws.type === "club" && String(ws.scopeId) === id ? label : ""),
      team: (id) => teams.find((team) => String(team.teamId) === id)?.name || "",
    },
  });
  render?.();
  focusPanelStart(cal);
}

async function openEditForm(item, render) {
  const cal = state.centralCalendar;
  if (cal.form || item?.kind !== "event" || item.canManage !== true || item.cancelled) return;
  const form = newCentralCalendarEditForm(item);
  if (!form.eventId) return;
  const waiting = pendingEntryFor({ mode: "edit", eventId: form.eventId });
  if (waiting) return openPendingCheck(cal, waiting, render);
  dropStaleEventTypes(cal);
  cal.form = form;
  render?.();
  await loadEditEvent(form, cal, render);
}

function openCancelForm(item, render) {
  const cal = state.centralCalendar;
  if (cal.form || item?.kind !== "event" || item.canManage !== true || item.cancelled) return;
  const form = newCentralCalendarCancelForm(item);
  if (!form.eventId) return;
  const waiting = pendingEntryFor({ mode: "cancel", eventId: form.eventId });
  if (waiting) return openPendingCheck(cal, waiting, render);
  cal.form = form;
  render?.();
  focusPanelStart(cal);
}

// The form is closed and the calendar read again (a settled answer, a refusal
// that changes what is shown, or a stranger's 404); the item's panel stays
// open on its key when it is still there, the one line says why. When that
// read fails the line says so (`readFailedNotice`, else READ_FAILED_TAIL):
// the calendar on screen is the one from before.
async function settleAndReload(cal, render, { notice, readFailedNotice = "", panelKey = "", panelDate = "" } = {}) {
  cal.form = null;
  if (panelKey && panelDate) cal.panel = { open: true, key: panelKey, date: panelDate, athletes: null, loading: false, error: "" };
  else cal.panel = closedPanel();
  invalidateCentralCalendarCache();
  render?.();
  await loadCentralCalendar({ render, forceRefresh: true });
  if (state.centralCalendar !== cal) return;
  cal.notice = readFailed(cal) ? readFailedNotice || `${notice}${READ_FAILED_TAIL}` : notice;
  render?.();
  focusPanelStart(cal);
  if (cal.panel.open) await loadCentralCalendarDay({ render, forceRefresh: true });
}

const WRITES = Object.freeze({
  create: (form) => createCentralCalendarEvent(form.sentBody),
  edit: (form) => updateCentralCalendarEvent(form.eventId, form.sentBody),
  cancel: (form) => cancelCentralCalendarEvent(form.eventId, form.sentBody),
});

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// The form's Save / Create event / Cancel event (app.js routes the form's
// submit here). A fresh requestKey for every new send; only Check result
// sends the same one again.
export async function submitCentralCalendarEventForm({ render } = {}) {
  const cal = state.centralCalendar;
  const form = cal.form;
  if (!form || form.busy || form.unconfirmed || form.loading || form.loadError) return;
  const { body, errors, unchanged } = buildCentralCalendarEventRequest(form, { timezone: browserTimeZone() });
  form.errors = errors;
  form.error = "";
  if (unchanged) {
    form.error = "Nothing changed: change a field, or Close.";
    render?.();
    return;
  }
  if (!body) {
    form.error = "Check the marked fields.";
    render?.();
    globalThis.document?.querySelector?.('.cc-event-form [aria-invalid="true"], .cc-event-form .cc-field-error')?.closest?.(".cc-field, .cc-fieldset")?.querySelector?.("input, select, textarea")?.focus?.();
    return;
  }
  form.requestKey = newCentralCalendarRequestKey();
  form.sentBody = { requestKey: form.requestKey, ...body };
  await sendEventForm(render);
}

async function sendEventForm(render) {
  const cal = state.centralCalendar;
  const form = cal.form;
  if (!form || form.busy || !form.sentBody) return;
  // A Check result: the same request again, after an answer that was lost.
  const check = form.unconfirmed;
  const current = () => state.centralCalendar === cal && cal.form === form;
  form.busy = true;
  form.error = "";
  render?.();
  let data;
  try {
    data = await WRITES[form.mode](form);
  } catch (error) {
    const info = centralCalendarErrorInfo(error);
    if (!current()) return lateAnswer(cal, render, form, { info, check });
    form.busy = false;
    await refused(form, info, render, { check });
    return;
  }
  if (!current()) return lateAnswer(cal, render, form, { data, check });
  form.busy = false;
  await saved(form, data, render, { check });
}

// Whether an answer settles what happened to the write: a success, or a stated
// refusal (on a Check result, only one given after the request record).
function answerSettles({ info = null, check = false }) {
  if (!info) return true;
  return !(centralCalendarOutcomeUnknown(info) || (check && !centralCalendarCheckSettles(info)));
}

// The coach left the form while its write was in flight. An answer that does
// not settle it changes nothing (the write still waits to be checked). One
// that does is no longer waited for - in any workspace - and, in the one on
// screen, the calendar is read again and the line says what happened. A form
// the coach has open meanwhile is left alone, unless it is the pending check
// of this very write.
async function lateAnswer(cal, render, form, outcome) {
  if (!answerSettles(outcome)) return;
  forgetUncertainWrite(form.requestKey);
  if (state.centralCalendar !== cal) return;
  if (cal.form?.pending && cal.form.requestKey === form.requestKey && !cal.form.busy) cal.form = null;
  const notice = outcome.info ? notDoneText(form, outcome.info) : savedText(form, outcome.data);
  invalidateCentralCalendarCache();
  await loadCentralCalendar({ render, forceRefresh: true });
  if (state.centralCalendar !== cal) return;
  cal.notice = readFailed(cal) ? `${notice}${READ_FAILED_TAIL}` : notice;
  render?.();
}

function formTitle(form, event = null) {
  return oneLineTitle(event?.title || (form.mode === "create" ? form.sentBody?.title || form.draft.title : form.eventTitle)) || "The event";
}

function savedText(form, data, { check = false } = {}) {
  const title = formTitle(form, data?.event || null);
  const words = { create: `“${title}” was created.`, edit: `Changes to “${title}” were saved.`, cancel: `“${title}” was cancelled.` };
  return `${check ? "Checked: " : ""}${words[form.mode]}`;
}

// A settled refusal of a write the coach no longer has open as a form (a late
// answer, a pending check): what was not done, and why when the code says.
function notDoneText(form, info, { check = false } = {}) {
  const title = formTitle(form);
  const head = { create: `“${title}” was not created.`, edit: `The change to “${title}” was not saved.`, cancel: `“${title}” was not cancelled.` }[form.mode];
  const why = info.status === 404
    ? form.mode === "create" ? " Events cannot be created in this workspace now." : ` ${NOT_AVAILABLE}`
    : info.code === "event_changed" ? " The event was changed meanwhile; make your change again."
      : info.code === "event_cancelled" ? " The event was cancelled meanwhile."
        : " Nothing was saved; you can make it again.";
  return `${check ? "Checked: " : ""}${head}${why}`;
}

// The sentence of a stated refusal: nothing was saved.
const FIELD_OF_CODE = Object.freeze({
  invalid_type: "eventTypeId", type_not_available: "eventTypeId", invalid_title: "title", invalid_day: "day", invalid_time: "endTime",
  invalid_location: "location", invalid_notes: "notes", invalid_targets: "targets", target_not_available: "targets", invalid_expects: "expects",
  invalid_reason: "reason",
});
const FIELD_TEXT = Object.freeze({
  invalid_type: "Choose a type.",
  type_not_available: "This type is not available here any more. Choose another one.",
  invalid_title: "Use 1 to 120 visible characters.",
  invalid_day: "Check the days.",
  invalid_time: "Check the times: an end needs a start and comes after it.",
  invalid_location: "Use at most 120 visible characters.",
  invalid_notes: "Use at most 2000 characters.",
  invalid_targets: "Choose at least one group or athlete.",
  target_not_available: "One of the chosen groups or athletes is not available in this workspace on that day.",
  invalid_expects: "Choose from the list.",
  invalid_reason: "Use at most 500 characters.",
});

export function centralCalendarEventErrorText(info) {
  if (info.status === 401) return "Please sign in again. Nothing was saved.";
  if (info.code === "workspace_required") return "Open the club's workspace to create or change its events. Nothing was saved.";
  if (info.status === 403) return "Events cannot be created or changed in this workspace. Nothing was saved.";
  if (info.code === "try_again") return "The calendar is busy. Nothing was saved; try again in a moment.";
  if (info.code === "nothing_to_change") return "Nothing changed: change a field, or Close.";
  if (info.code === "invalid_timezone") return "Your device's time zone is not one OptiMove knows. Nothing was saved.";
  if (FIELD_OF_CODE[info.code]) return "Check the marked fields. Nothing was saved.";
  return "Nothing was saved. Try again.";
}

function checkNoteText(info) {
  if (centralCalendarOutcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here.";
  if (info.status === 404) return "The check could not be done: this event is not available in this workspace now. The result is still not confirmed.";
  if (info.status === 403) return "The check could not be done: this workspace cannot change events now. The result is still not confirmed.";
  if (info.code === "request_key_reused") return "The check could not be done. Close without checking, then look for the event in the calendar before saving it again.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

async function refused(form, info, render, { check = false } = {}) {
  const cal = state.centralCalendar;
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened to the first write is still not known,
  // so nothing here may say "Nothing was saved" or unlock the form.
  if (centralCalendarOutcomeUnknown(info) || (check && !centralCalendarCheckSettles(info))) {
    form.unconfirmed = true;
    form.checkNote = check ? checkNoteText(info) : "";
    render?.();
    globalThis.document?.querySelector?.('[data-action="central-calendar-event-check-result"]')?.focus?.();
    return;
  }
  // Settled: nothing was saved under this key.
  forgetUncertainWrite(form.requestKey);
  form.unconfirmed = false;
  form.checkNote = "";
  if (form.pending) {
    // A pending check has no fields to mark: it closes with what was not done.
    await settleAndReload(cal, render, { notice: notDoneText(form, info, { check: true }), panelKey: form.key, panelDate: form.date });
    return;
  }
  if (info.status === 404) {
    await settleAndReload(cal, render, { notice: form.mode === "create" ? "Events cannot be created in this workspace now. Nothing was saved." : NOT_AVAILABLE });
    return;
  }
  if (info.code === "event_changed" || info.code === "event_cancelled") {
    // The form was made from an event that changed or was cancelled: it
    // closes, the calendar is read again, and the panel shows it as it is -
    // or, when that read fails, the line says it could not be read.
    await settleAndReload(cal, render, {
      notice: info.code === "event_changed" ? "Nothing was saved: this event was changed meanwhile. It is shown as it is now; make your change again." : "Nothing was saved: this event was cancelled meanwhile and can no longer be changed.",
      readFailedNotice: info.code === "event_changed" ? "Nothing was saved: this event was changed meanwhile, and the calendar could not be read again. Read it again to see the event as it is now before changing it." : "",
      panelKey: form.key, panelDate: form.date,
    });
    return;
  }
  const field = FIELD_OF_CODE[info.code];
  if (field && fieldShown(form, field)) {
    form.errors = { ...form.errors, [field]: FIELD_TEXT[info.code] };
    form.error = centralCalendarEventErrorText(info);
  } else {
    // The refused field is not on this form (a cancel's, or a read-only
    // type or targets): its sentence is the form's own line.
    form.error = field ? `${FIELD_TEXT[info.code]} Nothing was saved.` : centralCalendarEventErrorText(info);
  }
  render?.();
}

function fieldShown(form, field) {
  if (form.mode === "cancel") return field === "reason";
  if (field === "targets") return !form.readOnlyTargets;
  if (field === "eventTypeId") return !form.readOnlyType;
  return field !== "reason";
}

async function saved(form, data, render, { check = false } = {}) {
  const cal = state.centralCalendar;
  const event = data?.event || null;
  forgetUncertainWrite(form.requestKey);
  const notice = savedText(form, data, { check });
  cal.form = null;
  // The event's panel on the day the coach was on when it is still one of
  // the event's days, else its first day; the range follows that day.
  const eventId = event?.id || form.eventId;
  const from = event?.day || form.draft.day || form.date;
  const to = event?.endDay || from;
  const day = form.date && form.date >= from && form.date <= to ? form.date : from;
  if (eventId && day) {
    if (!centralCalendarDisplayedDays(cal.view, cal.anchor).includes(day)) cal.anchor = day;
    cal.selectedDate = day;
  }
  await settleAndReload(cal, render, { notice, panelKey: eventId && day ? `event:${eventId}:${day}` : "", panelDate: day });
}

function findItemOnDay(cal, key, date) {
  if (!key || !isIsoDate(date)) return null;
  return (cal.data?.days || []).find((day) => day.date === date)?.items?.find((item) => item.key === key) || null;
}

// The form's fields (app.js routes "input" and "change" here): the value goes
// into the draft; a choice that changes other fields or counts (the type,
// a target, an expectation, the athlete search) draws the form again, a typed
// value does not (the input already shows it). A sent form is locked: its
// body is fixed until its result is known. Returns whether the target was
// the form's.
export function handleCentralCalendarInput(target, { render } = {}) {
  if (!target?.closest?.("[data-cc-event-form]")) return false;
  const cal = state.centralCalendar;
  const form = cal?.form;
  if (!form || form.busy || form.unconfirmed) return true;
  const dataset = target.dataset || {};
  if (dataset.ccEventField) {
    if (setCentralCalendarFormField(form, dataset.ccEventField, String(target.value ?? ""), { types: cal.eventTypes })) render?.();
    return true;
  }
  if (dataset.ccEventExpect) {
    if (setCentralCalendarFormExpect(form, dataset.ccEventExpect, Boolean(target.checked))) render?.();
    return true;
  }
  if (dataset.ccEventTarget) {
    if (setCentralCalendarFormTarget(form, { kind: dataset.ccEventTarget, id: dataset.targetId || "", name: dataset.targetName || "" }, Boolean(target.checked))) render?.();
    return true;
  }
  if ("ccEventAthleteSearch" in dataset) {
    const query = String(target.value ?? "");
    if (form.athleteQuery !== query) {
      form.athleteQuery = query;
      // Only the list is drawn again: the search input, its caret and a
      // phone's keyboard (and an input method's composition) stay as they are.
      const list = globalThis.document?.querySelector?.("#ccEventAthleteList");
      if (list) list.innerHTML = renderCentralCalendarAthleteListHtml(form, centralCalendarEventRoster());
      else render?.();
    }
    return true;
  }
  return true;
}

// app.js's keydown on the content: Enter in the athlete search finds, it
// never submits the event form (HTML's implicit submission would create or
// save the event before the athletes are chosen).
export function handleCentralCalendarKeydown(event) {
  if (event?.key !== "Enter" || !event.target?.matches?.("[data-cc-event-athlete-search]")) return false;
  event.preventDefault();
  // A phone's Search key: the keyboard goes away so the filtered list shows.
  try {
    if (globalThis.window?.matchMedia?.("(pointer: coarse)")?.matches) event.target.blur?.();
  } catch {
    // No matchMedia: a computer, the keyboard stays.
  }
  return true;
}

export async function handleCentralCalendarAction(action, { render, openWeeklyPlanForAthleteOnDate, openTrainingLoad } = {}) {
  const type = action?.dataset?.action || "";
  if (!type.startsWith("central-calendar-")) return false;
  const cal = state.centralCalendar;
  const today = localDateIso();
  if (!cal.anchor) cal.anchor = today;

  if (type === "central-calendar-prev" || type === "central-calendar-next") {
    cal.anchor = movedAnchor(cal, type === "central-calendar-prev" ? -1 : 1);
    cal.selectedDate = cal.anchor;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-today") {
    cal.anchor = today;
    cal.selectedDate = today;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-view") {
    const view = action.dataset.view;
    if (!CENTRAL_CALENDAR_VIEWS.includes(view) || view === cal.view) return true;
    // Day shows the day a phone's strip or the month grid pointed at.
    if (view === "day" && isIsoDate(cal.selectedDate)) cal.anchor = cal.selectedDate;
    cal.view = view;
    if (!isIsoDate(cal.selectedDate)) cal.selectedDate = cal.anchor;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-mode") {
    const mode = action.dataset.mode === "grid" ? "grid" : "list";
    cal.weekMode = mode;
    writeCentralCalendarWeekMode(mode);
    render?.();
    return true;
  }
  if (type === "central-calendar-select-day") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    cal.selectedDate = date;
    cal.panel = closedPanel();
    render?.();
    // A phone's month: the chosen day's list sits under the grid, near or
    // below the fold - bring its title to the top so the tap visibly did
    // something and the day's cards follow it.
    if (cal.view === "month") globalThis.document?.querySelector?.(".cc-day-title")?.scrollIntoView?.({ block: "start" });
    return true;
  }
  if (type === "central-calendar-open-day") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    cal.view = "day";
    cal.anchor = date;
    cal.selectedDate = date;
    cal.panel = closedPanel();
    render?.();
    await loadCentralCalendar({ render });
    return true;
  }
  if (type === "central-calendar-open-item") {
    const key = action.dataset.key || "";
    const date = action.dataset.date;
    if (!key || !isIsoDate(date)) return true;
    // The event form gives way only after its own question (K2a-2).
    if (cal.form && !closeEventForm(null, { rereadRender: render })) return true;
    // The open item again folds the panel.
    if (cal.panel.open && cal.panel.key === key) {
      cal.panel = closedPanel();
      render?.();
      return true;
    }
    cal.panel = { open: true, key, date, athletes: null, loading: true, error: "" };
    render?.();
    // The sheet is modal below 1024 px: the focus moves to its Close.
    globalThis.document?.querySelector?.(".cc-sheet .cc-panel-close")?.focus?.();
    await loadCentralCalendarDay({ render });
    return true;
  }
  if (type === "central-calendar-close-panel") {
    // The sheet's backdrop closes the event form the same way as its Close.
    if (cal.form) {
      closeEventForm(render);
      return true;
    }
    const key = cal.panel.key;
    cal.panel = closedPanel();
    render?.();
    focusCard(key);
    return true;
  }
  if (type === "central-calendar-toggle-team") {
    const teamId = action.dataset.teamId || "";
    if (teamId) toggleValue(cal.filters.teamIds, teamId);
    render?.();
    return true;
  }
  if (type === "central-calendar-toggle-kind") {
    const kind = action.dataset.kind || "";
    if (CENTRAL_CALENDAR_KINDS.includes(kind)) {
      toggleValue(cal.filters.kinds, kind);
      // Events chosen: every event passes, so the event types are cleared.
      if (kind === "event" && cal.filters.kinds.includes("event")) cal.filters.eventKinds = [];
    }
    render?.();
    return true;
  }
  if (type === "central-calendar-toggle-event-kind") {
    const eventKind = action.dataset.eventKind || "";
    if (CENTRAL_CALENDAR_EVENT_KINDS.includes(eventKind)) {
      toggleValue(cal.filters.eventKinds, eventKind);
      // Narrowing to some event types turns Events off, so every pressed chip
      // changes the list (Events would let every event through anyway).
      if (cal.filters.eventKinds.length) cal.filters.kinds = cal.filters.kinds.filter((kind) => kind !== "event");
    }
    render?.();
    return true;
  }
  if (type === "central-calendar-all-groups") {
    cal.filters.teamIds = [];
    render?.();
    return true;
  }
  if (type === "central-calendar-all-types") {
    cal.filters.kinds = [];
    cal.filters.eventKinds = [];
    render?.();
    return true;
  }
  if (type === "central-calendar-toggle-filters") {
    cal.filtersOpen = !cal.filtersOpen;
    render?.();
    return true;
  }
  if (type === "central-calendar-clear-filters") {
    cal.filters = { teamIds: [], kinds: [], eventKinds: [] };
    render?.();
    return true;
  }
  // --- Events (K2a-2) ---
  if (type === "central-calendar-new-event") {
    await openCreateForm(render);
    return true;
  }
  if (type === "central-calendar-edit-event" || type === "central-calendar-cancel-event") {
    const item = findItemOnDay(cal, action.dataset.key, action.dataset.date);
    if (type === "central-calendar-edit-event") await openEditForm(item, render);
    else openCancelForm(item, render);
    return true;
  }
  if (type === "central-calendar-event-form-close") {
    closeEventForm(render);
    return true;
  }
  if (type === "central-calendar-event-check-result") {
    if (cal.form?.unconfirmed && !cal.form.busy) await sendEventForm(render);
    return true;
  }
  // The screen's line of writes left unconfirmed: one opens its pending check.
  if (type === "central-calendar-event-pending") {
    const entry = centralCalendarUncertainWrites().find((other) => other.requestKey === action.dataset.requestKey);
    if (entry && !cal.form) openPendingCheck(cal, entry, render);
    return true;
  }
  if (type === "central-calendar-event-forget") {
    forgetPendingCheck(cal, render);
    return true;
  }
  if (type === "central-calendar-event-form-retry") {
    const form = cal.form;
    if (!form?.loadError || !form.loadRetry) return true;
    form.loadError = "";
    form.loading = true;
    render?.();
    if (form.mode === "edit") await loadEditEvent(form, cal, render);
    else await loadCreateTypes(form, cal, render);
    return true;
  }
  if (type === "central-calendar-event-athletes") {
    const form = cal.form;
    if (!form || form.busy || form.unconfirmed) return true;
    form.athletesOpen = !form.athletesOpen;
    render?.();
    // On a touch screen the keyboard would cover the list just opened: the
    // search is focused only where a pointer and a real keyboard are.
    let coarse = false;
    try {
      coarse = Boolean(globalThis.window?.matchMedia?.("(pointer: coarse)")?.matches);
    } catch {
      coarse = false;
    }
    if (form.athletesOpen && !coarse) globalThis.document?.querySelector?.('[data-cc-focus="athlete-search"]')?.focus?.({ preventScroll: true });
    return true;
  }
  if (type === "central-calendar-event-all-athletes" || type === "central-calendar-event-no-athletes") {
    const form = cal.form;
    if (!form || form.busy || form.unconfirmed || form.readOnlyTargets) return true;
    const all = type === "central-calendar-event-all-athletes";
    const athletes = all ? centralCalendarEventRoster() : form.draft.targets.filter((target) => target.kind === "athlete");
    for (const athlete of athletes) setCentralCalendarFormTarget(form, { kind: "athlete", id: athlete.id, name: athlete.name }, all);
    render?.();
    return true;
  }
  if (type === "central-calendar-retry") {
    await loadCentralCalendar({ render, forceRefresh: true });
    return true;
  }
  if (type === "central-calendar-retry-athletes") {
    await loadCentralCalendarDay({ render, forceRefresh: true });
    return true;
  }
  if (type === "central-calendar-open-training-load") {
    const date = action.dataset.date;
    if (!isIsoDate(date)) return true;
    await openTrainingLoad?.({ activityId: action.dataset.activityId || null, date });
    return true;
  }
  if (type === "central-calendar-open-athlete") {
    const athleteUuid = action.dataset.athleteId || "";
    const date = action.dataset.date;
    if (!athleteUuid || !isIsoDate(date)) return true;
    const rosterAthleteId = centralCalendarRosterAthleteId(athleteUuid);
    if (!rosterAthleteId) return true;
    await openWeeklyPlanForAthleteOnDate?.(rosterAthleteId, date);
    return true;
  }
  return false;
}
