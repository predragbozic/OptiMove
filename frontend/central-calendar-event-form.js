import { CENTRAL_CALENDAR_EVENT_EXPECTS } from "./central-calendar-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Central calendar (K2a-2) - the event form: its state, its checks, the
// request body and its template (docs/ai/central-calendar-k2a-2-plan.md
// section 4). Three modes share one object in state.centralCalendar.form:
// "create", "edit" (opened from GET /api/calendar/events/:id) and "cancel"
// (the confirmation that names the event). Nothing here talks to the server;
// central-calendar-actions.js sends `buildCentralCalendarEventRequest`'s body
// and keeps the outcome on the same object (busy, unconfirmed, checkNote).

export const CENTRAL_CALENDAR_EVENT_LIMITS = Object.freeze({ title: 120, location: 120, notes: 2000, reason: 500, targets: 200, spanDays: 366 });
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// The roster rows a search shows at once; the rest are reached by typing.
const ATHLETE_ROWS = 60;

export const CENTRAL_CALENDAR_EXPECT_LABELS = Object.freeze({
  rpe: "RPE from the athletes",
  device_data: "GPS / device data",
  test_result: "A test result (a wellness check-in counts as a test)",
});

function blankDraft() {
  return { eventTypeId: "", title: "", day: "", endDay: "", startTime: "", endTime: "", location: "", notes: "", expects: [], targets: [], reason: "" };
}

function baseForm(mode, extra = {}) {
  return {
    mode,
    // The item the form came from (edit, cancel), so closing it returns to
    // that item's panel; "" for a new event.
    key: "", date: "", eventId: "", eventTitle: "",
    loading: false, loadError: "",
    // Whose event this is: { scope: "club" | "team" | "user", id, name }.
    owner: null,
    readOnlyType: false, readOnlyTargets: false,
    draft: blankDraft(), original: null, revision: 0,
    expectsTouched: false, titleAuto: true,
    athleteQuery: "", athletesOpen: false,
    errors: {}, error: "",
    busy: false, unconfirmed: false, checkNote: "", requestKey: "", sentBody: null, dirty: false,
    ...extra,
  };
}

const targetKey = (target) => `${target.kind}:${String(target.id).toLowerCase()}`;
const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

// The type's defaults and label (D19): pre-ticked, editable per event.
export function applyCentralCalendarEventType(form, type) {
  if (!type || form.draft.eventTypeId === type.id) return false;
  form.draft.eventTypeId = type.id;
  if (!form.expectsTouched) form.draft.expects = CENTRAL_CALENDAR_EVENT_EXPECTS.filter((expect) => (type.defaultExpects || []).includes(expect));
  if (form.titleAuto) form.draft.title = type.label || "";
  return true;
}

// A new event in the active workspace, on `day`: the first type preselected,
// a team workspace's own team (or the club's teams the Groups chips chose)
// as the first target.
export function newCentralCalendarCreateForm({ day, owner, types, targets = [] }) {
  const form = baseForm("create", { owner, loading: !types });
  form.draft.day = day;
  form.draft.targets = targets.map((target) => ({ ...target }));
  if (types?.length) applyCentralCalendarEventType(form, types[0]);
  return form;
}

// The types arrived after the form opened: the first is preselected unless
// the coach chose one meanwhile (the select is not drawn before they arrive).
export function centralCalendarFormTypesLoaded(form, types) {
  form.loading = false;
  if (form.mode === "create" && !form.draft.eventTypeId && types?.length) applyCentralCalendarEventType(form, types[0]);
  if (form.mode === "edit" && form.original && !(types || []).some((type) => type.id === form.original.eventTypeId)) form.readOnlyType = true;
}

// Edit, while GET /api/calendar/events/:id is read: the card it came from.
export function newCentralCalendarEditForm(item) {
  return baseForm("edit", {
    key: item.key, date: item.date, eventId: item.eventId || item.links?.eventId || "", eventTitle: item.title || "", loading: true,
  });
}

// Edit: the event as GET /api/calendar/events/:id gives it to a manager.
// `names` resolves the owner's name from what the screen holds (the
// workspace's label, the answer's teams[]); a target's own name is the
// fallback.
export function centralCalendarEditFormFromEvent(form, event, { types, readOnly = false, names = {} } = {}) {
  const draft = {
    eventTypeId: event.eventTypeId || "",
    title: event.title || "",
    day: event.day || "",
    endDay: event.endDay || "",
    startTime: event.startTime || "",
    endTime: event.endTime || "",
    location: event.location || "",
    notes: event.notes || "",
    expects: CENTRAL_CALENDAR_EVENT_EXPECTS.filter((expect) => (event.expects || []).includes(expect)),
    targets: (event.targets || []).map((target) => ({ kind: target.kind, id: String(target.id), name: target.name || "" })),
    reason: "",
  };
  form.loading = false;
  form.loadError = "";
  form.eventId = event.id;
  form.eventTitle = event.title || "";
  form.revision = event.revision;
  form.draft = draft;
  form.original = { ...draft, targets: draft.targets.map((target) => ({ ...target })), expects: [...draft.expects] };
  form.expectsTouched = true;
  form.titleAuto = false;
  form.owner = ownerOfEvent(event, names);
  form.readOnlyTargets = readOnly;
  form.readOnlyType = readOnly || !(types || []).some((type) => type.id === draft.eventTypeId);
  form.eventTypeLabel = event.eventTypeLabel || "";
  return form;
}

function ownerOfEvent(event, names) {
  const named = (kind, id) => (event.targets || []).find((target) => target.kind === kind && String(target.id) === String(id))?.name || "";
  if (event.ownerScope === "club") return { scope: "club", id: String(event.ownerClubId), name: names.club?.(String(event.ownerClubId)) || named("club", event.ownerClubId) };
  if (event.ownerScope === "team") return { scope: "team", id: String(event.ownerTeamId), name: names.team?.(String(event.ownerTeamId)) || named("team", event.ownerTeamId) };
  return { scope: "user", id: String(event.ownerUserId || ""), name: "" };
}

// The cancel confirmation, from the event's card (its id, title, day and
// revision are on the card; nothing is read first).
export function newCentralCalendarCancelForm(item) {
  const form = baseForm("cancel", {
    key: item.key, date: item.date, eventId: item.eventId || item.links?.eventId || "",
    eventTitle: item.title || "", revision: item.revision,
  });
  form.span = item.span || null;
  return form;
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------
function oneLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
function multiLine(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}
function lengthError(value, max, { required = false, requiredText = "Required." } = {}) {
  if (!value) return required ? requiredText : "";
  return value.length > max ? `At most ${max} characters.` : "";
}
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// The body of the form (without its requestKey, added when it is sent) and
// its field errors; `body` is null while a field is wrong, `unchanged` when
// an edit changes nothing.
export function buildCentralCalendarEventRequest(form, { timezone = "UTC" } = {}) {
  const errors = {};
  if (form.mode === "cancel") {
    const reason = multiLine(form.draft.reason);
    const message = lengthError(reason, CENTRAL_CALENDAR_EVENT_LIMITS.reason);
    if (message) errors.reason = message;
    const body = { expectedRevision: form.revision, ...(reason ? { reason } : {}) };
    return { errors, body: Object.keys(errors).length ? null : body, unchanged: false };
  }
  const d = form.draft;
  const title = oneLine(d.title);
  const location = oneLine(d.location);
  const notes = multiLine(d.notes);
  const day = String(d.day || "");
  const endDay = String(d.endDay || "");
  const startTime = String(d.startTime || "");
  const endTime = String(d.endTime || "");
  if (!d.eventTypeId) errors.eventTypeId = "Choose a type.";
  const titleError = lengthError(title, CENTRAL_CALENDAR_EVENT_LIMITS.title, { required: true, requiredText: "Give the event a title." });
  if (titleError) errors.title = titleError;
  if (!ISO_DATE.test(day)) errors.day = "Choose the day.";
  if (endDay && !ISO_DATE.test(endDay)) errors.endDay = "Choose a valid day, or leave it empty.";
  else if (endDay && ISO_DATE.test(day) && endDay < day) errors.endDay = "The last day cannot be before the first.";
  else if (endDay && ISO_DATE.test(day) && daysBetween(day, endDay) > CENTRAL_CALENDAR_EVENT_LIMITS.spanDays) errors.endDay = `An event spans at most ${CENTRAL_CALENDAR_EVENT_LIMITS.spanDays} days.`;
  if (startTime && !TIME.test(startTime)) errors.startTime = "Use a time like 17:30.";
  if (endTime && !TIME.test(endTime)) errors.endTime = "Use a time like 19:00.";
  else if (endTime && !startTime) errors.endTime = "An end time needs a start time.";
  else if (endTime && startTime && (!endDay || endDay === day) && endTime <= startTime) errors.endTime = "The end must be after the start.";
  const locationError = lengthError(location, CENTRAL_CALENDAR_EVENT_LIMITS.location);
  if (locationError) errors.location = locationError;
  const notesError = lengthError(notes, CENTRAL_CALENDAR_EVENT_LIMITS.notes);
  if (notesError) errors.notes = notesError;
  if (!form.readOnlyTargets) {
    if (!d.targets.length) errors.targets = "Choose at least one group or athlete.";
    else if (d.targets.length > CENTRAL_CALENDAR_EVENT_LIMITS.targets) errors.targets = `At most ${CENTRAL_CALENDAR_EVENT_LIMITS.targets} targets.`;
  }
  const expects = CENTRAL_CALENDAR_EVENT_EXPECTS.filter((expect) => d.expects.includes(expect));
  const targets = d.targets.map((target) => ({ kind: target.kind, id: target.id }));
  if (Object.keys(errors).length) return { errors, body: null, unchanged: false };

  if (form.mode === "create") {
    const body = { eventTypeId: d.eventTypeId, title, day, timezone, expects, targets };
    if (endDay && endDay !== day) body.endDay = endDay;
    if (startTime) body.startTime = startTime;
    if (endTime) body.endTime = endTime;
    if (location) body.location = location;
    if (notes) body.notes = notes;
    return { errors, body, unchanged: false };
  }

  // Edit: only what changed; an emptied optional field is sent as null.
  const o = form.original;
  const body = { expectedRevision: form.revision };
  const orNull = (value) => value || null;
  if (!form.readOnlyType && d.eventTypeId !== o.eventTypeId) body.eventTypeId = d.eventTypeId;
  if (title !== oneLine(o.title)) body.title = title;
  if (day !== o.day) body.day = day;
  const nextEnd = endDay && endDay !== day ? endDay : "";
  const prevEnd = o.endDay && o.endDay !== o.day ? o.endDay : "";
  if (nextEnd !== prevEnd || (o.endDay && !prevEnd && day !== o.day)) body.endDay = orNull(nextEnd);
  if (startTime !== o.startTime) body.startTime = orNull(startTime);
  if (endTime !== o.endTime) body.endTime = orNull(endTime);
  if (location !== oneLine(o.location)) body.location = orNull(location);
  if (notes !== multiLine(o.notes)) body.notes = orNull(notes);
  if (!sameSet(expects, o.expects)) body.expects = expects;
  if (!form.readOnlyTargets && !sameSet(d.targets.map(targetKey), o.targets.map(targetKey))) body.targets = targets;
  const unchanged = Object.keys(body).length === 1;
  return { errors, body: unchanged ? null : body, unchanged };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
// A field's new value; true when the form must be drawn again (a choice that
// changes other fields or counts), false when the input already shows it.
export function setCentralCalendarFormField(form, field, value, { types } = {}) {
  if (!(field in form.draft) || field === "targets" || field === "expects") return false;
  if (form.draft[field] === value) return false;
  form.dirty = true;
  if (field === "eventTypeId") {
    const type = (types || []).find((entry) => entry.id === value);
    if (type) return applyCentralCalendarEventType(form, type);
    form.draft.eventTypeId = value;
    return true;
  }
  if (field === "title") form.titleAuto = false;
  form.draft[field] = value;
  return false;
}

export function setCentralCalendarFormExpect(form, expect, checked) {
  if (!CENTRAL_CALENDAR_EVENT_EXPECTS.includes(expect)) return false;
  const has = form.draft.expects.includes(expect);
  if (has === checked) return false;
  form.draft.expects = checked ? CENTRAL_CALENDAR_EVENT_EXPECTS.filter((e) => e === expect || form.draft.expects.includes(e)) : form.draft.expects.filter((e) => e !== expect);
  form.expectsTouched = true;
  form.dirty = true;
  return true;
}

export function setCentralCalendarFormTarget(form, target, checked) {
  if (form.readOnlyTargets || !target?.id || !["athlete", "team", "club"].includes(target.kind)) return false;
  const key = targetKey(target);
  const index = form.draft.targets.findIndex((entry) => targetKey(entry) === key);
  if ((index >= 0) === checked) return false;
  if (checked) form.draft.targets.push({ kind: target.kind, id: String(target.id), name: target.name || "" });
  else form.draft.targets.splice(index, 1);
  form.dirty = true;
  return true;
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------
function fieldId(name) {
  return `ccEvent-${name}`;
}

function errorHtml(form, name) {
  const message = form.errors?.[name];
  return message ? `<span class="cc-field-error" id="${fieldId(name)}-error">${escapeHtml(message)}</span>` : "";
}

function invalidAttrs(form, name) {
  return form.errors?.[name] ? ` aria-invalid="true" aria-describedby="${fieldId(name)}-error"` : "";
}

function textFieldHtml(form, name, label, { type = "text", max = 0, hint = "", required = false, autocomplete = "off" } = {}) {
  const value = form.draft[name] ?? "";
  return `<label class="cc-field" for="${fieldId(name)}">
      <span class="cc-field-label">${escapeHtml(label)}${required ? "" : ` <span class="cc-field-optional">(optional)</span>`}</span>
      <input id="${fieldId(name)}" type="${type}" name="${name}" value="${escapeAttr(value)}" data-cc-event-field="${name}" data-cc-focus="field:${name}"${max ? ` maxlength="${max}"` : ""} autocomplete="${autocomplete}"${invalidAttrs(form, name)}>
      ${hint ? `<span class="cc-field-hint">${escapeHtml(hint)}</span>` : ""}
      ${errorHtml(form, name)}
    </label>`;
}

function checkHtml({ checked, attrs, label, focus, note = "" }) {
  return `<label class="cc-check"><input type="checkbox"${checked ? " checked" : ""} ${attrs} data-cc-focus="${escapeAttr(focus)}"><span class="cc-check-label">${escapeHtml(label)}${note ? ` <span class="cc-check-note">${escapeHtml(note)}</span>` : ""}</span></label>`;
}

function typeFieldHtml(form, types) {
  if (form.readOnlyType) {
    return `<div class="cc-field"><span class="cc-field-label">Type</span><p class="cc-field-static">${escapeHtml(form.eventTypeLabel || "")}</p>${form.mode === "edit" ? `<span class="cc-field-hint">The type can be changed in the event's own workspace.</span>` : ""}</div>`;
  }
  return `<label class="cc-field" for="${fieldId("eventTypeId")}">
      <span class="cc-field-label">Type</span>
      <select id="${fieldId("eventTypeId")}" name="eventTypeId" data-cc-event-field="eventTypeId" data-cc-focus="field:eventTypeId"${invalidAttrs(form, "eventTypeId")}>
        ${form.draft.eventTypeId ? "" : `<option value="" selected>Choose a type</option>`}
        ${(types || []).map((type) => `<option value="${escapeAttr(type.id)}"${type.id === form.draft.eventTypeId ? " selected" : ""}>${escapeHtml(type.label)}</option>`).join("")}
      </select>
      ${errorHtml(form, "eventTypeId")}
    </label>`;
}

function expectsHtml(form, types) {
  const type = (types || []).find((entry) => entry.id === form.draft.eventTypeId);
  const defaults = type ? CENTRAL_CALENDAR_EVENT_EXPECTS.filter((expect) => (type.defaultExpects || []).includes(expect)) : [];
  const fromType = type && sameSet(defaults, form.draft.expects)
    ? `As every ${type.label} event; change it for this event only.`
    : type ? `Changed for this event (a ${type.label} event usually expects ${defaults.length ? defaults.map((e) => CENTRAL_CALENDAR_EXPECT_LABELS[e].split(" (")[0]).join(", ") : "nothing"}).` : "";
  return `<fieldset class="cc-fieldset">
      <legend>What do you expect after it?</legend>
      ${CENTRAL_CALENDAR_EVENT_EXPECTS.map((expect) => checkHtml({
        checked: form.draft.expects.includes(expect), attrs: `data-cc-event-expect="${expect}"`, label: CENTRAL_CALENDAR_EXPECT_LABELS[expect], focus: `expect:${expect}`,
      })).join("")}
      <span class="cc-field-hint">${escapeHtml(fromType || "Nothing ticked: nothing is waited for after this event.")}</span>
    </fieldset>`;
}

// Who the event is for, by its owner (plan section 1.2): a club event - the
// club, its teams, athletes; a team event - the team, athletes; a private
// coach's - athletes. `roster` is the workspace's athletes ({ id, name }).
function targetsHtml(form, { teams, roster }) {
  const chosen = new Set(form.draft.targets.map(targetKey));
  const owner = form.owner || { scope: "user" };
  if (form.readOnlyTargets) {
    const names = form.draft.targets.map((target) => target.name || (target.kind === "athlete" ? "Athlete" : target.kind === "team" ? "Team" : "Club"));
    return `<div class="cc-fieldset cc-fieldset-static"><span class="cc-field-label">For</span><p class="cc-field-static">${escapeHtml(names.join(", ") || "-")}</p><span class="cc-field-hint">Who the event is for is changed in the event's own workspace.</span></div>`;
  }
  const rows = [];
  if (owner.scope === "club") {
    rows.push(checkHtml({ checked: chosen.has(targetKey({ kind: "club", id: owner.id })), attrs: `data-cc-event-target="club" data-target-id="${escapeAttr(owner.id)}" data-target-name="${escapeAttr(owner.name || "")}"`, label: `The whole club${owner.name ? ` (${owner.name})` : ""}`, focus: `target:club:${owner.id}` }));
    for (const team of teams || []) {
      rows.push(checkHtml({ checked: chosen.has(targetKey({ kind: "team", id: team.teamId })), attrs: `data-cc-event-target="team" data-target-id="${escapeAttr(team.teamId)}" data-target-name="${escapeAttr(team.name || "")}"`, label: team.name || "Team", focus: `target:team:${team.teamId}` }));
    }
  } else if (owner.scope === "team") {
    rows.push(checkHtml({ checked: chosen.has(targetKey({ kind: "team", id: owner.id })), attrs: `data-cc-event-target="team" data-target-id="${escapeAttr(owner.id)}" data-target-name="${escapeAttr(owner.name || "")}"`, label: `The whole team${owner.name ? ` (${owner.name})` : ""}`, focus: `target:team:${owner.id}` }));
  }
  // A chosen club or team target the lists above do not hold (an edit of an
  // event whose team left the list): kept, shown, and can be unticked.
  const listed = new Set(rows.length ? [targetKey({ kind: owner.scope === "club" ? "club" : "team", id: owner.id }), ...(owner.scope === "club" ? (teams || []).map((team) => targetKey({ kind: "team", id: team.teamId })) : [])] : []);
  const rosterIds = new Set((roster || []).map((athlete) => targetKey({ kind: "athlete", id: athlete.id })));
  const extras = form.draft.targets.filter((target) => (target.kind === "athlete" ? !rosterIds.has(targetKey(target)) : !listed.has(targetKey(target))));
  const chosenAthletes = form.draft.targets.filter((target) => target.kind === "athlete").length;
  const query = form.athleteQuery.trim().toLowerCase();
  const matches = (roster || []).filter((athlete) => !query || String(athlete.name || "").toLowerCase().includes(query));
  const shown = matches.slice(0, ATHLETE_ROWS);
  const athletesList = form.athletesOpen
    ? `<div class="cc-athlete-picker" id="ccEventAthletes">
        <label class="cc-field cc-athlete-search" for="${fieldId("athleteSearch")}">
          <span class="cc-field-label">Find an athlete</span>
          <input id="${fieldId("athleteSearch")}" type="search" value="${escapeAttr(form.athleteQuery)}" data-cc-event-athlete-search data-cc-focus="athlete-search" autocomplete="off">
        </label>
        ${owner.scope === "user" ? `<div class="cc-form-row"><button type="button" class="plain-button cc-form-small" data-action="central-calendar-event-all-athletes">Choose all my athletes</button>${chosenAthletes ? `<button type="button" class="plain-button cc-form-small" data-action="central-calendar-event-no-athletes">Clear athletes</button>` : ""}</div>` : ""}
        ${shown.length ? `<div class="cc-check-list" role="group" aria-label="Athletes">${shown.map((athlete) => checkHtml({
          checked: chosen.has(targetKey({ kind: "athlete", id: athlete.id })), attrs: `data-cc-event-target="athlete" data-target-id="${escapeAttr(athlete.id)}" data-target-name="${escapeAttr(athlete.name || "")}"`,
          label: athlete.name || "Athlete", focus: `target:athlete:${athlete.id}`,
        })).join("")}</div>` : `<p class="cc-field-hint">${(roster || []).length ? "No athlete matches." : "No athletes in this workspace's list."}</p>`}
        ${matches.length > shown.length ? `<p class="cc-field-hint">${matches.length - shown.length} more - type a name to find them.</p>` : ""}
      </div>`
    : "";
  return `<fieldset class="cc-fieldset"${form.errors?.targets ? ` aria-describedby="${fieldId("targets")}-error"` : ""}>
      <legend>Who is it for?</legend>
      ${rows.join("")}
      <button type="button" class="plain-button cc-form-small cc-athletes-toggle" data-action="central-calendar-event-athletes" aria-expanded="${form.athletesOpen ? "true" : "false"}" aria-controls="ccEventAthletes">${form.athletesOpen ? "Hide athletes" : "Choose athletes"}${chosenAthletes ? ` (${chosenAthletes} chosen)` : ""}</button>
      ${athletesList}
      ${extras.length ? `<div class="cc-check-list" role="group" aria-label="Also chosen">${extras.map((target) => checkHtml({
        checked: true, attrs: `data-cc-event-target="${escapeAttr(target.kind)}" data-target-id="${escapeAttr(target.id)}" data-target-name="${escapeAttr(target.name || "")}"`,
        label: target.name || "Athlete", focus: `target:${target.kind}:${target.id}`, note: target.kind === "athlete" ? "not in this workspace's list" : "",
      })).join("")}</div>` : ""}
      ${errorHtml(form, "targets")}
    </fieldset>`;
}

function unconfirmedHtml(form) {
  if (!form.unconfirmed) return "";
  return `<div class="cc-unconfirmed" role="alert">
      <p class="cc-unconfirmed-title">Result not confirmed</p>
      <p class="cc-panel-note">The answer was lost, so it is not known whether this was saved. Check result sends the same request again; it is never saved twice.</p>
      ${form.checkNote ? `<p class="cc-panel-note">${escapeHtml(form.checkNote)}</p>` : ""}
      <div class="cc-form-actions">
        <button type="button" class="plain-button cc-primary" data-action="central-calendar-event-check-result"${form.busy ? " disabled" : ""}>${form.busy ? "Checking…" : "Check result"}</button>
        <button type="button" class="plain-button" data-action="central-calendar-event-form-close"${form.busy ? " disabled" : ""}>Close without checking</button>
      </div>
    </div>`;
}

function headHtml(title) {
  return `<header class="cc-panel-head">
      <h3 class="cc-panel-title" id="ccPanelTitle">${escapeHtml(title)}</h3>
      <button type="button" class="plain-button icon-button cc-panel-close" data-action="central-calendar-event-form-close" aria-label="Close">&times;</button>
    </header>`;
}

function spanText(form, longDate) {
  const span = form.span;
  if (span && span.to && span.to !== span.from) return `${longDate(span.from)} - ${longDate(span.to)}`;
  return longDate(form.date);
}

// The form in the panel's place. `ctx`: { types, typesError, teams, roster,
// longDate } - the workspace's types, its teams (the calendar answer's
// teams[]) and athletes, and the date formatter of the view.
export function renderCentralCalendarEventFormHtml(form, ctx = {}) {
  const locked = form.busy || form.unconfirmed;
  if (form.mode === "cancel") {
    return `${headHtml("Cancel this event?")}
      <form class="cc-event-form" data-cc-event-form novalidate>
        <p class="cc-cancel-name"><strong>${escapeHtml(form.eventTitle || "Event")}</strong><br><span class="cc-panel-note">${escapeHtml(spanText(form, ctx.longDate || ((iso) => iso)))}</span></p>
        <p class="cc-panel-note">The event stays in the calendar, struck through, for you and for its athletes. A cancelled event cannot be changed again.</p>
        <fieldset class="cc-form-fields"${locked ? " disabled" : ""}>
          <label class="cc-field" for="${fieldId("reason")}">
            <span class="cc-field-label">Reason <span class="cc-field-optional">(optional, coaches only)</span></span>
            <textarea id="${fieldId("reason")}" name="reason" rows="3" maxlength="${CENTRAL_CALENDAR_EVENT_LIMITS.reason}" data-cc-event-field="reason" data-cc-focus="field:reason"${invalidAttrs(form, "reason")}>${escapeHtml(form.draft.reason)}</textarea>
            ${errorHtml(form, "reason")}
          </label>
        </fieldset>
        ${form.error ? `<p class="cc-form-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
        ${unconfirmedHtml(form)}
        ${form.unconfirmed ? "" : `<div class="cc-form-actions">
          <button type="submit" class="plain-button cc-danger"${form.busy ? " disabled" : ""}>${form.busy ? "Cancelling…" : "Cancel event"}</button>
          <button type="button" class="plain-button" data-action="central-calendar-event-form-close"${form.busy ? " disabled" : ""}>Keep event</button>
        </div>`}
      </form>`;
  }
  const title = form.mode === "edit" ? "Edit event" : "New event";
  if (form.loading) return `${headHtml(title)}<p class="cc-panel-note" role="status">${form.mode === "edit" ? "Loading the event…" : "Loading the event types…"}</p>`;
  if (form.loadError) {
    return `${headHtml(title)}<p class="cc-form-error" role="alert">${escapeHtml(form.loadError)}</p>
      ${form.loadRetry ? `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-event-form-retry">Try again</button>` : ""}`;
  }
  const types = ctx.types || [];
  return `${headHtml(title)}
    <form class="cc-event-form" data-cc-event-form novalidate>
      <fieldset class="cc-form-fields"${locked ? " disabled" : ""}>
        ${typeFieldHtml(form, types)}
        ${textFieldHtml(form, "title", "Title", { max: CENTRAL_CALENDAR_EVENT_LIMITS.title, required: true })}
        <div class="cc-form-grid">
          ${textFieldHtml(form, "day", "Day", { type: "date", required: true })}
          ${textFieldHtml(form, "endDay", "Last day", { type: "date", hint: "For a camp, a trip or days off." })}
          ${textFieldHtml(form, "startTime", "Starts", { type: "time" })}
          ${textFieldHtml(form, "endTime", "Ends", { type: "time" })}
        </div>
        ${textFieldHtml(form, "location", "Place", { max: CENTRAL_CALENDAR_EVENT_LIMITS.location })}
        ${targetsHtml(form, ctx)}
        ${expectsHtml(form, types)}
        <label class="cc-field" for="${fieldId("notes")}">
          <span class="cc-field-label">Notes <span class="cc-field-optional">(optional, coaches only)</span></span>
          <textarea id="${fieldId("notes")}" name="notes" rows="3" maxlength="${CENTRAL_CALENDAR_EVENT_LIMITS.notes}" data-cc-event-field="notes" data-cc-focus="field:notes"${invalidAttrs(form, "notes")}>${escapeHtml(form.draft.notes)}</textarea>
          ${errorHtml(form, "notes")}
        </label>
      </fieldset>
      ${form.error ? `<p class="cc-form-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${unconfirmedHtml(form)}
      ${form.unconfirmed ? "" : `<div class="cc-form-actions">
        <button type="submit" class="plain-button cc-primary"${form.busy ? " disabled" : ""}>${form.busy ? "Saving…" : form.mode === "edit" ? "Save changes" : "Create event"}</button>
        <button type="button" class="plain-button" data-action="central-calendar-event-form-close"${form.busy ? " disabled" : ""}>Close</button>
      </div>`}
    </form>`;
}
