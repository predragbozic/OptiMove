// Central calendar (K2b-1d, docs/ai/central-calendar-k2b-plan.md section 21):
// an event's place and its details - in the event form (a library place or a
// one-off text, the type's default details), in the panel (the place for
// everyone who sees the card; the details and their values for the event's
// managers, T7) and in the small "Enter details" form (one more mode of the
// event form, "values", so it shares the K2a-2 write discipline of
// central-calendar-actions.js). The catalog is GET /api/calendar/events/types
// (`{ types, fields, locations, teamDefaults }`, K2b-1a); an event's details
// with their values are its manager's GET /api/calendar/events/:id (K2b-1b).
// Nothing here talks to the server.
import { calendarSettingsMapsUrl } from "./calendar-settings-data.js";
import { renderIconSvg } from "./icon-render.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const CENTRAL_CALENDAR_EVENT_FIELDS_MAX = 30;
export const CENTRAL_CALENDAR_VALUE_TEXT_MAX = 200;
// The select's own word for "a place that is not in the club's list".
export const OTHER_PLACE = "other";
// The words for a detail's kind (the Settings screen's, K2b-1c).
const KIND_WORDS = Object.freeze({ choice: "Choice", number: "Number", scale_1_5: "Scale 1 to 5", yes_no: "Yes or no", short_text: "Short text" });

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// ---------------------------------------------------------------------------
// The form's place and details
// ---------------------------------------------------------------------------
// The catalog the form offers: { fields, locations, teamDefaults }, never null.
export function centralCalendarCatalogOf(cal) {
  const catalog = cal?.eventCatalog || {};
  return {
    fields: Array.isArray(catalog.fields) ? catalog.fields : [],
    locations: Array.isArray(catalog.locations) ? catalog.locations : [],
    teamDefaults: catalog.teamDefaults && typeof catalog.teamDefaults === "object" ? catalog.teamDefaults : {},
  };
}

// The details a form can name: the catalog's live ones and, on an edit, the
// event's own chosen ones (an archived one included), by id.
function fieldInfoOf(form, catalog) {
  const info = new Map();
  for (const field of catalog.fields) info.set(String(field.id), { id: String(field.id), label: field.label, valueKind: field.valueKind, required: field.required === true, archived: false });
  for (const field of form.eventFields || []) {
    const id = String(field.fieldId);
    info.set(id, { id, label: field.label, valueKind: field.valueKind, required: field.required === true, archived: field.archived === true });
  }
  return info;
}

// The type's default details that are live in the catalog, in their order.
function typeDefaults(type, catalog) {
  const live = new Set(catalog.fields.map((field) => String(field.id)));
  return (type?.defaultFieldIds || []).map(String).filter((id) => live.has(id));
}

// A new event: the type's default details, and the team's default place
// when the event is a team's (or a club event for exactly one team).
export function initCentralCalendarCreateDetails(form, type, catalog) {
  form.draft.placeChoice = "";
  form.draft.location = "";
  form.draft.fieldIds = typeDefaults(type, catalog);
  form.placeTouched = false;
  form.fieldsTouched = false;
  form.addFieldId = "";
  applyCentralCalendarTeamPlace(form, catalog);
}

// The type changed on a new event: its default details follow until the
// coach touched the list (D19's behaviour of `expects`).
export function centralCalendarTypeChangedDetails(form, type, catalog) {
  if (form.mode === "create" && !form.fieldsTouched) form.draft.fieldIds = typeDefaults(type, catalog);
}

// The team whose default place a new event starts with: a team event's team,
// or the one team a club event is for; else none.
function placeTeamOf(form) {
  const owner = form.owner || {};
  if (owner.scope === "team") return owner.id;
  if (owner.scope !== "club") return "";
  const targets = form.draft.targets || [];
  const teams = targets.filter((target) => target.kind === "team");
  return teams.length === 1 && !targets.some((target) => target.kind === "club") ? String(teams[0].id) : "";
}

// The name of the team whose default place a new event starts at.
function placeTeamName(form) {
  const owner = form.owner || {};
  if (owner.scope === "team") return owner.name || "";
  return (form.draft.targets || []).find((target) => target.kind === "team")?.name || "";
}

// Until the coach touches the place, a new event's place is its team's default.
export function applyCentralCalendarTeamPlace(form, catalog) {
  if (form.mode !== "create" || form.placeTouched) return;
  const teamId = placeTeamOf(form);
  const locationId = teamId ? catalog.teamDefaults[teamId] : "";
  const live = locationId && catalog.locations.some((place) => String(place.id) === String(locationId));
  form.draft.placeChoice = live ? String(locationId) : "";
  form.placeFromTeam = Boolean(live);
}

// An edit: the event's place and its chosen details as the manager's view
// gives them.
export function initCentralCalendarEditDetails(form, event) {
  const locationId = event.locationId ? String(event.locationId) : "";
  form.draft.placeChoice = locationId || (event.location ? OTHER_PLACE : "");
  form.draft.location = locationId ? "" : String(event.location || "");
  form.eventPlace = event.place && event.place.source === "library" ? { id: locationId, name: event.place.name || "", address: event.place.address || "" } : null;
  form.eventFields = Array.isArray(event.fields) ? event.fields : [];
  form.draft.fieldIds = form.eventFields.map((field) => String(field.fieldId));
  form.placeTouched = true;
  form.fieldsTouched = false;
  form.addFieldId = "";
}

export function setCentralCalendarPlaceChoice(form, value) {
  if (form.draft.placeChoice === value) return false;
  form.draft.placeChoice = value;
  form.placeTouched = true;
  form.placeFromTeam = false;
  form.dirty = true;
  return true;
}

// The one-off text. Where the club has no places (a private coach, a club
// that has not added any) it is the only place control, so typing it is the
// choice of "Another place"; typing never brings back a team's default.
export function setCentralCalendarPlaceText(form, value) {
  form.draft.location = value;
  if (!form.draft.placeChoice) form.draft.placeChoice = OTHER_PLACE;
  form.placeTouched = true;
  form.placeFromTeam = false;
  form.dirty = true;
}

// The details list: add (the picker's choice), remove, move, or replace it
// by the new type's defaults (an edit whose type changed, 18.7).
export function changeCentralCalendarFields(form, change, { id = "", direction = "", type = null, catalog } = {}) {
  const list = form.draft.fieldIds;
  if (change === "add") {
    const fieldId = form.addFieldId;
    if (!fieldId || list.includes(fieldId) || list.length >= CENTRAL_CALENDAR_EVENT_FIELDS_MAX) return false;
    if (!catalog.fields.some((field) => String(field.id) === fieldId)) return false;
    list.push(fieldId);
    form.addFieldId = "";
  } else if (change === "remove") {
    const at = list.indexOf(id);
    if (at < 0) return false;
    list.splice(at, 1);
  } else if (change === "move") {
    const at = list.indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= list.length) return false;
    [list[at], list[to]] = [list[to], list[at]];
  } else if (change === "replace") {
    const next = typeDefaults(type, catalog);
    if (sameList(next, list)) return false;
    form.draft.fieldIds = next;
  } else {
    return false;
  }
  form.fieldsTouched = true;
  form.dirty = true;
  return true;
}

// The place and the details of the request: `{ errors, create, edit }` -
// what a create adds to its body, what an edit adds (only what changed).
export function centralCalendarDetailsRequest(form, { max }) {
  const errors = {};
  const d = form.draft;
  const choice = String(d.placeChoice || "");
  const text = oneLine(d.location);
  if (choice === OTHER_PLACE && text.length > max) errors.location = `At most ${max} characters.`;
  const create = {};
  if (choice && choice !== OTHER_PLACE) create.locationId = choice;
  else if (choice === OTHER_PLACE && text) create.location = text;
  if (form.fieldsTouched) create.fieldIds = [...d.fieldIds];
  const edit = {};
  const o = form.original || {};
  const before = String(o.placeChoice || "");
  const beforeText = oneLine(o.location);
  const library = (value) => Boolean(value) && value !== OTHER_PLACE;
  if (choice !== before || (choice === OTHER_PLACE && text !== beforeText)) {
    if (library(choice)) edit.locationId = choice;
    else if (choice === OTHER_PLACE && text) edit.location = text;
    else if (library(before)) edit.locationId = null;
    else if (before === OTHER_PLACE) edit.location = null;
  }
  if (!sameList(d.fieldIds, o.fieldIds || [])) edit.fieldIds = [...d.fieldIds];
  return { errors, create, edit };
}

// ---------------------------------------------------------------------------
// The form's template parts
// ---------------------------------------------------------------------------
function placeLine(place) {
  return place.address ? `${place.name} — ${place.address}` : place.name;
}

// One control: the club's places, "Another place…" (the one-off text, shown
// under it) or none. A private coach has no places: the text alone.
export function renderCentralCalendarPlaceFieldHtml(form, catalog, { fieldId, errorHtml, invalidAttrs, max, trusted = true }) {
  const d = form.draft;
  const choice = String(d.placeChoice || "");
  // The text alone ("Place", optional) where there are no places; under
  // "Another place…" the text the coach chose to give (UX review, LOW).
  const textInput = (label, { optional = true, hint = "" } = {}) => `<label class="cc-field" for="${fieldId("location")}">
      <span class="cc-field-label">${escapeHtml(label)}${optional ? ` <span class="cc-field-optional">(optional)</span>` : ""}</span>
      <input id="${fieldId("location")}" type="text" name="location" value="${escapeAttr(d.location || "")}" data-cc-event-field="location" data-cc-focus="field:location" maxlength="${max}" autocomplete="off"${invalidAttrs(form, "location")}>
      ${hint ? `<span class="cc-field-hint">${escapeHtml(hint)}</span>` : ""}
      ${errorHtml(form, "location")}
    </label>`;
  const places = catalog.locations;
  const archived = form.eventPlace && form.eventPlace.id && !places.some((place) => String(place.id) === form.eventPlace.id) ? form.eventPlace : null;
  if (!places.length && !archived) return textInput("Place");
  const chosen = places.find((place) => String(place.id) === choice) || (archived && archived.id === choice ? archived : null);
  const teamName = form.placeFromTeam ? placeTeamName(form) : "";
  const hint = chosen
    ? `${form.placeFromTeam ? `${teamName ? `${teamName}'s` : "The team's"} default place. ` : ""}${chosen.address ? `Address: ${chosen.address}` : "No address."}`
    : choice === OTHER_PLACE ? "A place that is not in the club's list, for this event only." : "";
  return `<div class="cc-field">
      <label class="cc-field-label" for="${fieldId("placeChoice")}">Place <span class="cc-field-optional">(optional)</span></label>
      <select id="${fieldId("placeChoice")}" data-cc-event-place data-cc-focus="field:placeChoice"${invalidAttrs(form, "placeChoice")}>
        <option value=""${choice ? "" : " selected"}>No place</option>
        <optgroup label="The club's places">
          ${archived ? `<option value="${escapeAttr(archived.id)}"${choice === archived.id ? " selected" : ""}>${escapeHtml(`${placeLine(archived)}${trusted ? " (archived)" : ""}`)}</option>` : ""}
          ${places.map((place) => `<option value="${escapeAttr(place.id)}"${String(place.id) === choice ? " selected" : ""}>${escapeHtml(placeLine(place))}</option>`).join("")}
        </optgroup>
        <option value="${OTHER_PLACE}"${choice === OTHER_PLACE ? " selected" : ""}>Another place…</option>
      </select>
      ${hint ? `<span class="cc-field-hint">${escapeHtml(hint)}</span>` : ""}
      ${errorHtml(form, "placeChoice")}
    </div>
    ${choice === OTHER_PLACE ? textInput("Another place", { optional: false, hint: "Leave it empty for no place." }) : ""}`;
}

const ARROW = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;

// "Details to fill in after the event" (D36): the chosen ones in order, each
// with its kind and Required mark; add one from the catalog; on an edit
// whose type changed, "Replace with the new type's details" (18.7).
export function renderCentralCalendarDetailsFieldHtml(form, catalog, { types, fieldId, errorHtml, trusted = true }) {
  const info = fieldInfoOf(form, catalog);
  const list = form.draft.fieldIds;
  const offer = trusted ? catalog.fields.filter((field) => !list.includes(String(field.id))) : [];
  const type = (types || []).find((entry) => entry.id === form.draft.eventTypeId);
  const typeChanged = form.mode === "edit" && form.original && form.draft.eventTypeId !== form.original.eventTypeId;
  const replace = trusted && typeChanged && type && !sameList(typeDefaults(type, catalog), list);
  // Nothing chosen and nothing to choose (a private coach, a club with no
  // details): no section (UX review, LOW).
  if (!list.length && !offer.length && !replace && !form.errors?.fieldIds) return "";
  const rows = list.map((id, index) => {
    const field = info.get(id) || { label: "A detail that is no longer available", valueKind: "" };
    const words = [KIND_WORDS[field.valueKind] || "", field.required ? "Required" : "", field.archived ? "Archived" : ""].filter(Boolean).join(" · ");
    return `<li class="cc-detail-row">
        <span class="cc-detail-main"><span class="cc-detail-name">${escapeHtml(field.label)}</span>${words ? `<span class="cc-detail-kind">${escapeHtml(words)}</span>` : ""}</span>
        <span class="cc-detail-actions">
          <button type="button" class="plain-button cc-icon-button" data-action="central-calendar-event-field-move" data-field-id="${escapeAttr(id)}" data-direction="up" aria-label="${escapeAttr(`Move “${field.label}” up`)}"${index === 0 ? " disabled" : ""}>${ARROW("M6 15l6-6l6 6")}</button>
          <button type="button" class="plain-button cc-icon-button" data-action="central-calendar-event-field-move" data-field-id="${escapeAttr(id)}" data-direction="down" aria-label="${escapeAttr(`Move “${field.label}” down`)}"${index === list.length - 1 ? " disabled" : ""}>${ARROW("M6 9l6 6l6-6")}</button>
          <button type="button" class="plain-button cc-form-small" data-action="central-calendar-event-field-remove" data-field-id="${escapeAttr(id)}" aria-label="${escapeAttr(`Remove “${field.label}”`)}">Remove</button>
        </span>
      </li>`;
  }).join("");
  return `<fieldset class="cc-fieldset"${form.errors?.fieldIds ? ` aria-describedby="${fieldId("fieldIds")}-error"` : ""}>
      <legend>Details to fill in after the event</legend>
      <span class="cc-field-hint">After the event, open it in the calendar and choose Enter details. RPE, GPS and test results are under Collected after it.</span>
      ${list.length ? `<ol class="cc-detail-list">${rows}</ol>` : `<p class="cc-field-hint">No details for this event.</p>`}
      ${replace ? `<span class="cc-field-hint">Changing the type keeps this event's details.</span>
      <button type="button" class="plain-button cc-form-small" data-action="central-calendar-event-fields-replace">Replace with the new type's details</button>` : ""}
      ${offer.length && list.length < CENTRAL_CALENDAR_EVENT_FIELDS_MAX ? `<div class="cc-form-row cc-detail-add">
        <label class="visually-hidden" for="${fieldId("addField")}">Detail to add</label>
        <select id="${fieldId("addField")}" data-cc-event-add-field data-cc-focus="field:addField">
          <option value="">Add a detail…</option>
          ${offer.map((field) => `<option value="${escapeAttr(field.id)}"${form.addFieldId === String(field.id) ? " selected" : ""}>${escapeHtml(field.label)}</option>`).join("")}
        </select>
        <button type="button" class="plain-button cc-form-small" data-action="central-calendar-event-field-add">Add</button>
      </div>` : ""}
      ${errorHtml(form, "fieldIds")}
    </fieldset>`;
}

// ---------------------------------------------------------------------------
// The panel: the place for every viewer, the details for a manager
// ---------------------------------------------------------------------------
export function renderCentralCalendarEventPlaceHtml(item) {
  const place = item.place;
  if (!place) return item.location ? `<p class="cc-panel-place">${renderIconSvg("map-pin", { size: 16 })}<span>${escapeHtml(item.location)}</span></p>` : "";
  if (place.source === "one_off") return place.text ? `<p class="cc-panel-place">${renderIconSvg("map-pin", { size: 16 })}<span>${escapeHtml(place.text)}</span></p>` : "";
  return `<div class="cc-panel-place cc-panel-place-library">${renderIconSvg("map-pin", { size: 16 })}<div class="cc-panel-place-text">
      <p class="cc-panel-place-name">${escapeHtml(place.name || "")}</p>
      ${place.address ? `<p class="cc-panel-place-address">${escapeHtml(place.address)} <a class="cc-maps" href="${escapeAttr(calendarSettingsMapsUrl(place.address))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(`Open in maps: “${place.name || place.address}” (opens a new tab)`)}">Open in maps</a></p>` : ""}
      ${place.note ? `<p class="cc-panel-place-note">${escapeHtml(place.note)}</p>` : ""}
    </div></div>`;
}

// A value in words, by the detail's kind.
export function centralCalendarValueText(field) {
  const value = field.value;
  if (value === null || value === undefined || value === "") return "";
  if (field.valueKind === "choice") return (field.options || []).find((option) => String(option.id) === String(value))?.label || "";
  if (field.valueKind === "yes_no") return value === true ? "Yes" : "No";
  if (field.valueKind === "scale_1_5") return `${value} of 5`;
  if (field.valueKind === "number") return field.unit ? `${value} ${field.unit}` : String(value);
  return String(value);
}

// The manager's details (T7): read once when the panel opens (`view` is the
// panel's event read: { key, loading, error, event }).
export function renderCentralCalendarEventDetailsHtml(item, view) {
  if (item.kind !== "event" || item.canManage !== true || !item.details || item.details.selected < 1) return "";
  if (!view || view.key !== item.key || view.loading) return `<div class="cc-panel-details"><h4 class="cc-panel-subtitle">Details</h4><p class="cc-panel-note" role="status">Loading the details…</p></div>`;
  if (view.error || !view.event) {
    return `<div class="cc-panel-details"><h4 class="cc-panel-subtitle">Details</h4><p class="cc-panel-note" role="alert">${escapeHtml(view.error || "The details could not be read.")}</p>
      <button type="button" class="plain-button cc-panel-button" data-action="central-calendar-details-retry">Try again</button></div>`;
  }
  const fields = view.event.fields || [];
  if (!fields.length) return "";
  const filled = fields.filter((field) => centralCalendarValueText(field)).length;
  const missingRequired = fields.filter((field) => field.required && !field.archived && !centralCalendarValueText(field)).length;
  return `<div class="cc-panel-details">
      <h4 class="cc-panel-subtitle">Details</h4>
      <p class="cc-panel-note">${escapeHtml(`${filled} of ${fields.length} filled in${missingRequired ? ` · ${missingRequired} required ${missingRequired === 1 ? "detail is" : "details are"} still empty` : ""}.`)}</p>
      <dl class="cc-detail-values">
        ${fields.map((field) => {
          const text = centralCalendarValueText(field);
          return `<div class="cc-detail-value"><dt>${escapeHtml(field.label)}${field.required ? ` <span class="cc-field-optional">(required)</span>` : ""}</dt><dd${text ? "" : ` class="is-empty"`}>${escapeHtml(text || "Not filled in")}</dd></div>`;
        }).join("")}
      </dl>
      ${item.cancelled ? "" : `<button type="button" class="plain-button cc-panel-button" data-action="central-calendar-enter-details" data-key="${escapeAttr(item.key)}" data-date="${escapeAttr(item.date)}">Enter details</button>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// The "Enter details" form (mode "values")
// ---------------------------------------------------------------------------
// The value of a field as its input holds it: always a string.
function inputValueOf(field) {
  const value = field.value;
  if (value === null || value === undefined) return "";
  if (field.valueKind === "yes_no") return value === true ? "yes" : "no";
  return String(value);
}

export function fillCentralCalendarValuesForm(form, event) {
  form.eventId = String(event.id);
  form.eventTitle = event.title || form.eventTitle || "";
  form.revision = event.revision;
  form.fields = (event.fields || []).map((field) => ({ ...field, fieldId: String(field.fieldId) }));
  form.draft.values = Object.fromEntries(form.fields.map((field) => [field.fieldId, inputValueOf(field)]));
  form.original = { values: { ...form.draft.values } };
  form.loading = false;
  form.loadError = "";
}

export function setCentralCalendarValue(form, fieldId, value) {
  if (!(fieldId in form.draft.values) || form.draft.values[fieldId] === value) return false;
  form.draft.values[fieldId] = value;
  form.dirty = true;
  if (form.errors?.[`value:${fieldId}`]) {
    form.errors = { ...form.errors };
    delete form.errors[`value:${fieldId}`];
  }
  return true;
}

// A typed number as the number it reads as (a comma is a decimal point, at
// most three decimals), else the trimmed text.
function numberOrText(raw) {
  const text = String(raw).trim().replace(",", ".");
  return /^-?\d{1,9}(\.\d{1,3})?$/.test(text) ? Number(text) : text;
}

// The command's body: only the changed values; an emptied one is null.
export function buildCentralCalendarValuesRequest(form) {
  const errors = {};
  const values = [];
  for (const field of form.fields) {
    const raw = String(form.draft.values[field.fieldId] ?? "");
    const was = String(form.original.values[field.fieldId] ?? "");
    // Spaces alone, spaces around the same text, or the same number written
    // another way ("2,5" for 2.5) are no change.
    const same = field.valueKind === "short_text" ? oneLine(raw) === oneLine(was)
      : field.valueKind === "number" ? numberOrText(raw) === numberOrText(was)
        : raw.trim() === was.trim();
    if (same) continue;
    const key = `value:${field.fieldId}`;
    if (raw.trim() === "") {
      values.push({ fieldId: field.fieldId, value: null });
      continue;
    }
    if (field.valueKind === "choice") values.push({ fieldId: field.fieldId, value: raw });
    else if (field.valueKind === "yes_no") values.push({ fieldId: field.fieldId, value: raw === "yes" });
    else if (field.valueKind === "scale_1_5") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 5) errors[key] = "Choose 1 to 5.";
      else values.push({ fieldId: field.fieldId, value: n });
    } else if (field.valueKind === "number") {
      // A comma is a decimal point; at most three decimals (K2b-1b's rule).
      const read = numberOrText(raw);
      const n = typeof read === "number" ? read : Number.NaN;
      const min = field.minValue;
      const max = field.maxValue;
      if (!Number.isFinite(n)) errors[key] = "Use a number with at most three decimals.";
      else if ((min !== null && min !== undefined && n < min) || (max !== null && max !== undefined && n > max)) errors[key] = boundsText(field);
      else values.push({ fieldId: field.fieldId, value: n });
    } else {
      const text = oneLine(raw);
      if (!text) values.push({ fieldId: field.fieldId, value: null });
      else if ([...text].length > CENTRAL_CALENDAR_VALUE_TEXT_MAX) errors[key] = `At most ${CENTRAL_CALENDAR_VALUE_TEXT_MAX} characters.`;
      else values.push({ fieldId: field.fieldId, value: text });
    }
  }
  if (Object.keys(errors).length) return { errors, body: null, unchanged: false };
  if (!values.length) return { errors, body: null, unchanged: true };
  return { errors, body: { expectedRevision: form.revision, values }, unchanged: false };
}

function boundsText(field) {
  const unit = field.unit ? ` ${field.unit}` : "";
  const min = field.minValue;
  const max = field.maxValue;
  if (min !== null && min !== undefined && max !== null && max !== undefined) return `Use a number from ${min} to ${max}${unit}.`;
  if (min !== null && min !== undefined) return `Use a number of at least ${min}${unit}.`;
  if (max !== null && max !== undefined) return `Use a number of at most ${max}${unit}.`;
  return "Use a number.";
}

// One input per detail, by its kind; clearing one removes its value.
export function renderCentralCalendarValuesFieldsHtml(form) {
  return form.fields.map((field) => {
    const key = `value:${field.fieldId}`;
    const id = `ccValue-${field.fieldId}`;
    const value = form.draft.values[field.fieldId] ?? "";
    const error = form.errors?.[key];
    const invalid = error ? ` aria-invalid="true" aria-describedby="${id}-error"` : "";
    const data = `data-cc-event-value="${escapeAttr(field.fieldId)}" data-cc-focus="value:${escapeAttr(field.fieldId)}"`;
    const label = `${escapeHtml(field.label)}${field.required ? ` <span class="cc-field-optional">(required)</span>` : ""}`;
    const hint = [field.description || "", field.valueKind === "number" ? boundsHint(field) : ""].filter(Boolean).join(" ");
    let control;
    if (field.valueKind === "choice") {
      control = `<select id="${id}" ${data}${invalid}><option value=""${value ? "" : " selected"}>Not filled in</option>${(field.options || []).map((option) => `<option value="${escapeAttr(option.id)}"${String(option.id) === value ? " selected" : ""}>${escapeHtml(option.label)}${option.hidden ? " (hidden)" : ""}</option>`).join("")}</select>`;
    } else if (field.valueKind === "yes_no" || field.valueKind === "scale_1_5") {
      const choices = field.valueKind === "yes_no" ? [["yes", "Yes"], ["no", "No"], ["", "Not filled in"]] : [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"], ["", "Not filled in"]];
      control = `<div class="cc-value-choices" role="radiogroup" aria-labelledby="${id}-label"${invalid}>${choices.map(([v, text]) => `<label class="cc-value-choice"><input type="radio" name="${id}" value="${v}" ${data}${value === v ? " checked" : ""}><span>${escapeHtml(text)}</span></label>`).join("")}</div>`;
      return `<div class="cc-field cc-value-field"><span class="cc-field-label" id="${id}-label">${label}</span>${hint ? `<span class="cc-field-hint">${escapeHtml(hint)}</span>` : ""}${control}${error ? `<span class="cc-field-error" id="${id}-error">${escapeHtml(error)}</span>` : ""}</div>`;
    } else if (field.valueKind === "number") {
      const decimalPad = typeof field.minValue === "number" && field.minValue >= 0;
      control = `<input id="${id}" type="text"${decimalPad ? ` inputmode="decimal"` : ""} value="${escapeAttr(value)}" ${data} maxlength="16" autocomplete="off"${invalid}>`;
    } else {
      control = `<input id="${id}" type="text" value="${escapeAttr(value)}" ${data} maxlength="${CENTRAL_CALENDAR_VALUE_TEXT_MAX}" autocomplete="off"${invalid}>`;
    }
    return `<div class="cc-field cc-value-field"><label class="cc-field-label" for="${id}">${label}</label>${hint ? `<span class="cc-field-hint">${escapeHtml(hint)}</span>` : ""}${control}${error ? `<span class="cc-field-error" id="${id}-error">${escapeHtml(error)}</span>` : ""}</div>`;
  }).join("");
}

function boundsHint(field) {
  const unit = field.unit ? ` ${field.unit}` : "";
  const min = field.minValue;
  const max = field.maxValue;
  if (min !== null && min !== undefined && max !== null && max !== undefined) return `From ${min} to ${max}${unit}.`;
  if (min !== null && min !== undefined) return `At least ${min}${unit}.`;
  if (max !== null && max !== undefined) return `At most ${max}${unit}.`;
  return field.unit ? `In ${field.unit}.` : "";
}
