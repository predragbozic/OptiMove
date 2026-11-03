// Settings -> Calendar (K2b-1c): events and mutations.
//
// Rules that hold everywhere here: opening a form or typing sends nothing;
// one write at a time - while one is in flight or its answer was lost, every
// other write control is off; every write carries a fresh requestKey, and a
// lost answer is checked only by sending the very same request again (Check
// result), which the server replays and never saves twice; a stated refusal
// says "Nothing was saved" and keeps the form with its values. The section,
// the open form and an unconfirmed write survive a switch to another section
// or menu; a workspace switch, a sign-out and a reload ask first.
import { isCalendarColorKey } from "./calendar-colors.js";
import {
  CALENDAR_SETTINGS_LIMITS as LIMITS,
  CALENDAR_SETTINGS_SECTIONS,
  CALENDAR_VALUE_KINDS,
  calendarFieldById,
  calendarLocationById,
  calendarSettingsCheckSettles,
  calendarSettingsErrorInfo,
  calendarSettingsMapsUrl,
  calendarSettingsOutcomeUnknown,
  calendarSettingsPath,
  calendarTeamById,
  calendarTypeById,
  loadCalendarSettings,
  newCalendarSettingsRequestKey,
  patchCalendarSettings,
  replaceCalendarSettingsTypes,
  sendCalendarSettingsWrite,
} from "./calendar-settings-data.js";
import { CENTRAL_CALENDAR_EVENT_EXPECTS, CENTRAL_CALENDAR_EVENT_KINDS, centralCalendarCatalogChanged } from "./central-calendar-data.js";
import { closeIconPicker, focusIconPicker, handleIconPickerAction, iconPickerOpenFor, openIconPicker } from "./icon-picker.js";
import { isLibraryKey } from "./icon-render.js";
import { state } from "./state.js";

export const CALENDAR_SETTINGS_ICON_HOST = "calendar-settings";

function cs() {
  return state.calendarSettings;
}

function ask(question) {
  return Boolean(globalThis.window?.confirm?.(question));
}

function focusSoon(selector) {
  globalThis.document?.querySelector?.(selector)?.focus?.();
}

// The text rules the form says before a request does; the server decides
// (visible characters, its own invisible-character list).
const chars = (value) => [...String(value ?? "")].length;
const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const multiLine = (value) => String(value ?? "").replace(/\r\n?/g, "\n").trim();

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------
let localKey = 0;
const newOption = (label = "") => ({ key: `new-${++localKey}`, id: null, label, original: "", archived: false });

function typeDraft(type) {
  return {
    label: type?.label || "", kind: type?.kind || "", iconKey: type?.iconKey ?? null, colorKey: type?.colorKey ?? null,
    defaultExpects: CENTRAL_CALENDAR_EVENT_EXPECTS.filter((e) => (type?.defaultExpects || []).includes(e)),
    fieldIds: [...(type?.fieldIds || [])].map(String),
  };
}

function fieldDraft(field) {
  const number = (value) => (value === null || value === undefined ? "" : String(value));
  return {
    label: field?.label || "", valueKind: field?.valueKind || "", description: field?.description || "",
    unit: field?.unit || "", minValue: number(field?.minValue), maxValue: number(field?.maxValue),
    options: field
      ? (field.options || []).map((o) => ({ key: `o-${o.id}`, id: String(o.id), label: o.label, original: o.label, archived: o.archived === true }))
      : [newOption(), newOption()],
  };
}

const locationDraft = (place) => ({ name: place?.name || "", address: place?.address || "", note: place?.note || "" });
const teamDraft = (team) => ({ colorKey: team?.colorKey || "", defaultLocationId: team?.defaultLocationId ? String(team.defaultLocationId) : "" });

const DRAFTS = { type: typeDraft, field: fieldDraft, location: locationDraft, team: teamDraft };
const SUBJECTS = { type: calendarTypeById, field: calendarFieldById, location: calendarLocationById, team: calendarTeamById };
const SECTION_OF = { type: "types", field: "details", location: "places", team: "teams" };

function openForm(kind, id = "") {
  const subject = id ? SUBJECTS[kind](id) : null;
  if (id && !subject) return null;
  const draft = DRAFTS[kind](subject);
  return {
    kind, mode: id ? "edit" : "create", id: id ? String(id) : "", revision: subject?.revision ?? null,
    answered: kind === "field" && subject?.answered === true, valueKind: subject?.valueKind || "",
    draft, base: JSON.parse(JSON.stringify(draft)), errors: {}, error: "", addFieldId: "",
  };
}

export function calendarSettingsFormDirty(form = cs().form) {
  return Boolean(form) && JSON.stringify(form.draft) !== JSON.stringify(form.base);
}

// What an open form is about, for the questions that may be asked from
// another section: "the event type “Training”", "the new place".
const KIND_WORDS = Object.freeze({ type: "event type", field: "detail", location: "place", team: "team" });
function formSubject(form) {
  if (form.mode === "create") return `the new ${KIND_WORDS[form.kind]}`;
  return `the ${KIND_WORDS[form.kind]} “${subjectTitle(form.kind, SUBJECTS[form.kind](form.id)) || "item"}”`;
}

// The form is the screen's only place for typing: a second form opens only
// after the first one's unsaved values are given up (asked).
function mayReplaceForm() {
  const form = cs().form;
  if (!form || !calendarSettingsFormDirty(form)) return true;
  return ask(`Discard your unsaved changes to ${formSubject(form)}?`);
}

// ---------------------------------------------------------------------------
// Building a request from a form: { body, errors } or { unchanged }
// ---------------------------------------------------------------------------
function textError(value, max, { required = false, line = true } = {}) {
  if (!value) return required ? "Required." : "";
  if (chars(value) > max) return `Use at most ${max} characters.`;
  if (line && /\n/.test(value)) return "Use one line.";
  return "";
}

// "" = no value; NaN = not a number the server takes.
function parseNumber(raw) {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) return "";
  if (!/^-?\d+(\.\d+)?$/.test(text)) return Number.NaN;
  const value = Number(text);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e9 || Math.round(value * 1000) / 1000 !== value) return Number.NaN;
  return value;
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function buildType(form) {
  const d = form.draft;
  const label = oneLine(d.label);
  const errors = {};
  const labelError = textError(label, LIMITS.typeLabel, { required: true });
  if (labelError) errors.label = labelError;
  if (form.mode === "create" && !CENTRAL_CALENDAR_EVENT_KINDS.includes(d.kind)) errors.kind = "Choose a base kind.";
  if (d.fieldIds.length > LIMITS.typeFields) errors.fieldIds = `At most ${LIMITS.typeFields} details.`;
  // A detail chosen in the list but never added would silently be left out.
  const pending = form.addFieldId && !d.fieldIds.includes(form.addFieldId) ? calendarFieldById(form.addFieldId) : null;
  if (pending) errors.addFieldId = `You chose “${oneLine(pending.label)}” but did not add it: press Add detail, or choose nothing.`;
  if (Object.keys(errors).length) return { errors };
  const iconKey = isLibraryKey(d.iconKey) ? d.iconKey : null;
  const colorKey = isCalendarColorKey(d.colorKey) ? d.colorKey : null;
  if (form.mode === "create") {
    return { body: { label, kind: d.kind, iconKey, colorKey, defaultExpects: d.defaultExpects, fieldIds: d.fieldIds } };
  }
  const b = form.base;
  const body = {};
  if (label !== oneLine(b.label)) body.label = label;
  // Only what the form changed: a saved icon or colour this bundle does not
  // know (a newer server) is never sent back as null.
  if ((d.iconKey ?? null) !== (b.iconKey ?? null)) body.iconKey = iconKey;
  if ((d.colorKey ?? null) !== (b.colorKey ?? null)) body.colorKey = colorKey;
  if (!sameList(d.defaultExpects, b.defaultExpects)) body.defaultExpects = d.defaultExpects;
  if (!sameList(d.fieldIds, b.fieldIds)) body.fieldIds = d.fieldIds;
  if (!Object.keys(body).length) return { unchanged: true };
  return { body: { expectedRevision: form.revision, ...body } };
}

function buildField(form) {
  const d = form.draft;
  const kind = form.mode === "create" ? d.valueKind : form.valueKind;
  const errors = {};
  const label = oneLine(d.label);
  const description = oneLine(d.description);
  const unit = String(d.unit ?? "").trim();
  const labelError = textError(label, LIMITS.fieldLabel, { required: true });
  if (labelError) errors.label = labelError;
  const descriptionError = textError(description, LIMITS.fieldDescription);
  if (descriptionError) errors.description = descriptionError;
  if (form.mode === "create" && !CALENDAR_VALUE_KINDS.includes(kind)) errors.valueKind = "Choose what kind of answer it takes.";
  let minValue = "";
  let maxValue = "";
  if (kind === "number") {
    if (unit && (chars(unit) > LIMITS.unit || /\s/.test(unit))) errors.unit = `Use 1 to ${LIMITS.unit} characters without spaces.`;
    minValue = parseNumber(d.minValue);
    maxValue = parseNumber(d.maxValue);
    if (Number.isNaN(minValue)) errors.minValue = "Use a number with at most three decimals.";
    if (Number.isNaN(maxValue)) errors.maxValue = "Use a number with at most three decimals.";
    if (!errors.minValue && !errors.maxValue && minValue !== "" && maxValue !== "" && minValue > maxValue) errors.maxValue = "The highest value cannot be below the lowest.";
  }
  // An option's name as it will be saved: an existing one keeps its name
  // when it has answers or is hidden (a hidden option is never renamed).
  const options = kind === "choice"
    ? d.options.map((o) => {
      const label = oneLine(o.label);
      const keepsName = Boolean(o.id) && (form.answered || o.archived);
      return { ...o, label: keepsName ? o.original : label, renamed: Boolean(o.id) && !keepsName && label !== o.original };
    })
    : [];
  if (kind === "choice") {
    // A name is unique among the options offered once every rename, hide,
    // show and add is applied (a hidden option's name is free again, as the
    // database's index says). The clash is marked on the options this form
    // changed: a new one, a renamed one, one shown again.
    const optionErrors = {};
    const baseOf = new Map((form.base.options || []).map((o) => [o.id, o]));
    const touched = (o) => !o.id || o.renamed || (baseOf.get(o.id)?.archived ?? o.archived) !== o.archived;
    for (const option of options) {
      if (!touched(option) || option.archived) continue;
      const error = textError(option.label, LIMITS.optionLabel, { required: true });
      if (error) optionErrors[option.key] = error;
    }
    const byName = new Map();
    for (const option of options.filter((o) => !o.archived && o.label)) {
      const name = option.label.toLowerCase();
      byName.set(name, [...(byName.get(name) || []), option]);
    }
    for (const clash of byName.values()) {
      if (clash.length < 2) continue;
      for (const option of clash.filter(touched)) optionErrors[option.key] ||= "Two options have this name.";
    }
    const visible = options.filter((o) => !o.archived).length;
    if (visible < LIMITS.minOptions) errors.options = `Keep at least ${LIMITS.minOptions} options to choose from.`;
    if (visible > LIMITS.options) errors.options = `At most ${LIMITS.options} options can be offered.`;
    if (Object.keys(optionErrors).length) errors.optionLabels = optionErrors;
  }
  if (Object.keys(errors).length) return { errors };
  if (form.mode === "create") {
    const body = { label, valueKind: kind, required: false };
    if (description) body.description = description;
    if (kind === "number") {
      if (unit) body.unit = unit;
      if (minValue !== "") body.minValue = minValue;
      if (maxValue !== "") body.maxValue = maxValue;
    }
    if (kind === "choice") body.options = options.map((o) => o.label);
    return { body };
  }
  const b = form.base;
  const body = {};
  if (label !== oneLine(b.label)) body.label = label;
  if (description !== oneLine(b.description)) body.description = description || null;
  if (kind === "number") {
    if (unit !== String(b.unit ?? "").trim()) body.unit = unit || null;
    const was = (raw) => { const v = parseNumber(raw); return v === "" ? null : v; };
    if ((minValue === "" ? null : minValue) !== was(b.minValue)) body.minValue = minValue === "" ? null : minValue;
    if ((maxValue === "" ? null : maxValue) !== was(b.maxValue)) body.maxValue = maxValue === "" ? null : maxValue;
  }
  if (kind === "choice") {
    const ops = { add: [], rename: [], hide: [], show: [] };
    for (const option of options) {
      if (!option.id) {
        if (!option.archived) ops.add.push(option.label);
        continue;
      }
      const before = b.options.find((o) => o.id === option.id);
      if (option.renamed) ops.rename.push({ id: option.id, label: option.label });
      if (before && option.archived !== before.archived) ops[option.archived ? "hide" : "show"].push(option.id);
    }
    if (ops.add.length || ops.rename.length || ops.hide.length || ops.show.length) {
      body.options = Object.fromEntries(Object.entries(ops).filter(([, list]) => list.length));
    }
  }
  if (!Object.keys(body).length) return { unchanged: true };
  return { body: { expectedRevision: form.revision, ...body } };
}

function buildLocation(form) {
  const d = form.draft;
  const name = oneLine(d.name);
  const address = oneLine(d.address);
  const note = multiLine(d.note);
  const errors = {};
  const nameError = textError(name, LIMITS.locationName, { required: true });
  if (nameError) errors.name = nameError;
  const addressError = textError(address, LIMITS.address);
  if (addressError) errors.address = addressError;
  const noteError = textError(note, LIMITS.note, { line: false });
  if (noteError) errors.note = noteError;
  if (Object.keys(errors).length) return { errors };
  if (form.mode === "create") {
    return { body: { name, ...(address ? { address } : {}), ...(note ? { note } : {}) } };
  }
  const b = form.base;
  const body = {};
  if (name !== oneLine(b.name)) body.name = name;
  if (address !== oneLine(b.address)) body.address = address || null;
  if (note !== multiLine(b.note)) body.note = note || null;
  if (!Object.keys(body).length) return { unchanged: true };
  return { body: { expectedRevision: form.revision, ...body } };
}

function buildTeam(form) {
  const d = form.draft;
  const b = form.base;
  const body = {};
  if (d.colorKey !== b.colorKey) body.colorKey = isCalendarColorKey(d.colorKey) ? d.colorKey : null;
  if (d.defaultLocationId !== b.defaultLocationId) body.defaultLocationId = d.defaultLocationId || null;
  if (!Object.keys(body).length) return { unchanged: true };
  return { body: { expectedRevision: form.revision ?? 0, ...body } };
}

const BUILDERS = { type: buildType, field: buildField, location: buildLocation, team: buildTeam };
const COLLECTION = { type: "types", field: "fields", location: "locations", team: "teams" };

// The command a form's request becomes.
function formCommand(form, body) {
  const requestKey = newCalendarSettingsRequestKey();
  const create = form.mode === "create";
  const method = create ? "POST" : form.kind === "team" ? "PUT" : "PATCH";
  const subject = create ? null : SUBJECTS[form.kind](form.id);
  return {
    verb: create ? "create" : "save", kind: form.kind, id: form.id, form,
    title: create ? oneLine(body.label ?? body.name ?? "") : subjectTitle(form.kind, subject),
    method, path: calendarSettingsPath(COLLECTION[form.kind], create ? "" : form.id), body: { requestKey, ...body },
    busy: false, unconfirmed: false, checkNote: "",
  };
}

export function subjectTitle(kind, subject) {
  if (!subject) return "";
  return oneLine(kind === "location" || kind === "team" ? subject.name : subject.label);
}

// ---------------------------------------------------------------------------
// One write at a time
// ---------------------------------------------------------------------------
const NOT_AVAILABLE = "Nothing was saved: this is not available in this workspace now. The settings were read again.";
const CHANGED = Object.freeze({
  type_changed: "Nothing was saved: this type was changed meanwhile. It is shown as it is now; make your change again.",
  field_changed: "Nothing was saved: this detail was changed meanwhile. It is shown as it is now; make your change again.",
  location_changed: "Nothing was saved: this place was changed meanwhile. It is shown as it is now; make your change again.",
  team_changed: "Nothing was saved: this team's settings were changed meanwhile. They are shown as they are now; make your change again.",
  order_changed: "Nothing was saved: the list of types changed meanwhile. It is shown as it is now; move the type again.",
  type_archived: "Nothing was saved: this type is archived. Restore it first.",
  field_archived: "Nothing was saved: this detail is archived. Restore it first.",
  location_archived: "Nothing was saved: this place is archived. Restore it first.",
  type_live: "Nothing was saved: this type is not archived (someone restored it meanwhile).",
  field_live: "Nothing was saved: this detail is not archived (someone restored it meanwhile).",
  location_live: "Nothing was saved: this place is not archived (someone restored it meanwhile).",
});
const LABEL_TAKEN = Object.freeze({
  type: "Another event type already has this name.",
  field: "Another detail already has this name.",
  location: "Another place already has this name.",
});
const RESTORE_TAKEN = Object.freeze({
  type: "Nothing was saved: an active (not archived) type already has this name. Rename that one first, then restore this one.",
  field: "Nothing was saved: an active (not archived) detail already has this name. Rename that one first, then restore this one.",
  location: "Nothing was saved: an active (not archived) place already has this name. Rename that one first, then restore this one.",
});
// A refused field of the body, where the form shows it.
const FIELD_OF_CODE = Object.freeze({
  invalid_label: "label", invalid_kind: "kind", invalid_icon: "iconKey", invalid_color: "colorKey", invalid_fields: "fieldIds",
  invalid_expects: "defaultExpects", invalid_value_kind: "valueKind", invalid_unit: "unit", invalid_option: "options",
  invalid_description: "description", invalid_name: "name", invalid_address: "address", invalid_note: "note",
  invalid_location: "defaultLocationId", invalid_number: "maxValue", too_few_options: "options", too_many: "options",
  field_not_available: "fieldIds", location_not_available: "defaultLocationId", option_not_available: "options",
});
const FIELD_TEXT = Object.freeze({
  invalid_label: "Use 1 to 60 visible characters on one line.",
  invalid_name: "Use 1 to 80 visible characters on one line.",
  invalid_kind: "Choose a base kind.",
  invalid_icon: "Choose an icon from the library, or no icon.",
  invalid_color: "Choose a colour from the palette, or none.",
  invalid_fields: "Check the list of details.",
  invalid_expects: "Choose from the list.",
  invalid_value_kind: "Choose what kind of answer it takes.",
  invalid_unit: "Use 1 to 30 characters without spaces.",
  invalid_option: "Each option is 1 to 40 visible characters, and no two are the same.",
  invalid_description: "Use at most 200 visible characters on one line.",
  invalid_address: "Use at most 200 visible characters on one line.",
  invalid_note: "Use at most 500 visible characters.",
  invalid_location: "Choose a place from the list.",
  invalid_number: "Use numbers with at most three decimals; the highest cannot be below the lowest.",
  too_few_options: "Keep at least 2 options to choose from.",
  too_many: "That is more than the limit allows.",
  field_not_available: "One of these details is not available any more (it may have been archived). The list was read again.",
  location_not_available: "This place is not available any more (it may have been archived). The list was read again.",
  option_not_available: "One of these options is not available any more. The detail was read again.",
});

export function calendarSettingsErrorText(info) {
  if (info.status === 401) return "Please sign in again. Nothing was saved.";
  if (info.code === "try_again") return "The calendar settings are busy. Nothing was saved; try again in a moment.";
  if (info.code === "nothing_to_change") return "Nothing changed: change something, or Cancel.";
  if (info.code === "last_type") return "Nothing was saved: the club keeps at least one event type. Add or restore another type first.";
  if (FIELD_OF_CODE[info.code]) return "Check the marked fields. Nothing was saved.";
  return "Nothing was saved. Try again.";
}

function checkNoteText(info) {
  if (calendarSettingsOutcomeUnknown(info)) return "No answer again. The result is still not confirmed.";
  if (info.status === 401) return "The check could not be done: you are signed out. Sign in again in a new tab, then Check result here.";
  if (info.status === 403 || info.status === 404) return "The check could not be done: these settings are not available in this workspace now. The result is still not confirmed.";
  if (info.code === "request_key_reused") return "The check could not be done. Close without checking: the settings are read again, so you can see what is saved.";
  if (info.code === "try_again") return "The check could not be done: the server was busy. The result is still not confirmed; Check result again in a moment.";
  return "The check could not be done. The result is still not confirmed; Check result again in a moment.";
}

const ARCHIVE_TAIL = Object.freeze({
  type: "Coaches can no longer choose it for a new event; the events that have it keep it.",
  field: "Coaches can no longer add it to an event; the events that have it keep it and its answers.",
  location: "Coaches can no longer choose it for an event; the events that have it keep it.",
});

function savedText(cmd, data) {
  const name = (row) => subjectTitle(cmd.kind, row) || cmd.title || "The item";
  const row = data?.[cmd.kind] || null;
  const title = name(row);
  const text = {
    create: `“${title}” was added.`,
    save: `Changes to “${title}” were saved.`,
    archive: `“${title}” was archived. ${ARCHIVE_TAIL[cmd.kind] || ""}`.trim(),
    restore: `“${title}” was restored.`,
    order: `“${cmd.title}” was moved ${cmd.direction}.`,
  }[cmd.verb];
  return `${cmd.checked ? "Checked: " : ""}${text}`;
}

function setNotice(text, tone = "ok") {
  const d = cs();
  d.notice = text;
  d.noticeTone = tone;
}

async function reread(render) {
  cs().stale = true;
  await loadCalendarSettings(render);
}

async function runCommand(cmd, render) {
  const d = cs();
  if (d.command && d.command !== cmd) return;
  if (cmd.busy) return;
  const check = cmd.unconfirmed;
  d.command = cmd;
  cmd.busy = true;
  if (!check) setNotice("");
  render?.();
  let data = null;
  let info = null;
  try {
    data = await sendCalendarSettingsWrite(cmd);
  } catch (error) {
    info = calendarSettingsErrorInfo(error);
  }
  // A workspace switch replaced the slice: this answer belongs to nothing on
  // screen any more (the switch asked first).
  if (state.calendarSettings !== d || d.command !== cmd) return;
  cmd.busy = false;
  if (!info) return settled(cmd, data, render, { check });
  // A lost answer, or a Check result answered before the server read its
  // request record: what happened is still not known - nothing here may
  // say "Nothing was saved" or unlock the screen.
  if (calendarSettingsOutcomeUnknown(info) || (check && !calendarSettingsCheckSettles(info))) {
    cmd.unconfirmed = true;
    cmd.checkNote = check ? checkNoteText(info) : "";
    render?.();
    focusSoon('[data-action="calendar-settings-check-result"]');
    return;
  }
  return refused(cmd, info, render, { check });
}

async function settled(cmd, data, render, { check }) {
  const d = cs();
  d.command = null;
  if (cmd.form && d.form === cmd.form) d.form = null;
  if (data?.types) replaceCalendarSettingsTypes(data.types);
  for (const kind of ["type", "field", "location", "team"]) if (data?.[kind]) patchCalendarSettings(kind, data[kind]);
  cmd.checked = check;
  setNotice(savedText(cmd, data));
  // The calendar and its event form hold their own copy of the catalog.
  centralCalendarCatalogChanged();
  render?.();
  // A move keeps the focus on the moved row, a saved edit goes back to its
  // row's Edit; anything else to the notice that says what happened.
  if (cmd.verb === "order") focusSoon(`[data-action="calendar-settings-type-move"][data-id="${cmd.id}"]:not([disabled])`);
  else if (cmd.verb === "save") focusSoon(`[data-action="calendar-settings-edit"][data-kind="${cmd.kind}"][data-id="${cmd.id}"]`);
  else focusSoon("[data-calendar-settings-notice]");
  await reread(render);
}

async function refused(cmd, info, render, { check }) {
  const d = cs();
  d.command = null;
  const form = cmd.form && d.form === cmd.form ? cmd.form : null;
  const prefix = check ? "Checked: " : "";
  const code = info.code;
  if (info.status === 403 || info.status === 404 || code === "workspace_required") {
    d.form = null;
    setNotice(`${prefix}${NOT_AVAILABLE}`, "error");
    await reread(render);
    return;
  }
  if (CHANGED[code]) {
    if (code === "order_changed" && Array.isArray(info.current)) replaceCalendarSettingsTypes(info.current);
    else if (info.current) patchCalendarSettings(cmd.kind, info.current);
    if (form) d.form = null;
    setNotice(`${prefix}${CHANGED[code]}`, "error");
    render?.();
    await reread(render);
    return;
  }
  if (code === "field_answered" && form) {
    // The detail got its first answer meanwhile: its meaning is frozen. The
    // frozen parts go back to their saved values; the rest stays.
    if (info.current) patchCalendarSettings("field", info.current);
    const current = info.current || calendarFieldById(form.id);
    form.answered = true;
    if (current) {
      const saved = fieldDraft(current);
      for (const part of ["label", "unit", "minValue", "maxValue"]) {
        form.draft[part] = saved[part];
        form.base[part] = saved[part];
      }
      form.revision = current.revision ?? form.revision;
      for (const option of form.draft.options) if (option.id) option.label = option.original;
    }
    form.error = `${prefix}Nothing was saved. This detail already has answers: its name, unit, limits and option names can no longer change. They are back to their saved values; save again to keep your other changes.`;
    render?.();
    return;
  }
  if (code === "label_taken") {
    // An edit of a detail that renames, shows or adds options but keeps its
    // own name: the taken name is an option's.
    const optionTaken = form?.kind === "field" && form.mode === "edit" && cmd.body.options && !("label" in cmd.body);
    if (optionTaken) {
      form.errors = { ...form.errors, options: "Another option of this detail already has one of these names." };
      form.error = `${prefix}Check the marked fields. Nothing was saved.`;
    } else if (form) {
      form.errors = { ...form.errors, [form.kind === "location" ? "name" : "label"]: LABEL_TAKEN[cmd.kind] };
      form.error = `${prefix}Check the marked fields. Nothing was saved.`;
    } else {
      setNotice(`${prefix}${RESTORE_TAKEN[cmd.kind] || "Nothing was saved: the name is taken."}`, "error");
    }
    render?.();
    return;
  }
  const field = FIELD_OF_CODE[code];
  if (form) {
    if (field) form.errors = { ...form.errors, [field]: FIELD_TEXT[code] };
    form.error = `${prefix}${calendarSettingsErrorText(info)}`;
    render?.();
    if (["field_not_available", "location_not_available", "option_not_available"].includes(code)) await reread(render);
    return;
  }
  setNotice(`${prefix}${field ? `${FIELD_TEXT[code]} Nothing was saved.` : calendarSettingsErrorText(info)}`, "error");
  render?.();
}

// ---------------------------------------------------------------------------
// Leaving
// ---------------------------------------------------------------------------
// A workspace switch, a sign-out or the app's reload: what is in flight, not
// confirmed or not saved is asked about first ("final" leaves the page).
export function calendarSettingsMayBeLeft({ final = false } = {}) {
  const d = cs();
  const verb = final === "sign-out" || final === true ? "Sign out" : final === "switch" ? "Switch" : "Leave";
  if (d.command?.busy) return ask(`A calendar setting is still being saved. ${verb} anyway? Its result will not be shown here.`);
  if (d.command?.unconfirmed) return ask(`The last calendar setting's save is not confirmed. ${verb} without checking?`);
  if (calendarSettingsFormDirty(d.form)) return ask(`Discard the calendar setting you have not saved? ${verb} anyway?`);
  return true;
}

// app.js's "beforeunload": closing or reloading the page loses a save in
// flight, an unconfirmed result and unsaved values.
export function handleCalendarSettingsBeforeUnload(event) {
  if (state.deliberateNavigation) return false;
  const d = cs();
  const saving = Boolean(d.command);
  const unsaved = calendarSettingsFormDirty(d.form) && event?.isTrusted !== false;
  if (!saving && !unsaved) return false;
  event.preventDefault();
  event.returnValue = "A calendar setting is not saved or its result is not confirmed.";
  return true;
}

// ---------------------------------------------------------------------------
// Clicks
// ---------------------------------------------------------------------------
function liveTypes() {
  return (cs().data?.types || []).filter((type) => !type.archived);
}

export async function handleCalendarSettingsAction(action, { render } = {}) {
  const type = action?.dataset?.action || "";
  if (type.startsWith("icon-picker-")) {
    if (!iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST)) return false;
    return handleIconPickerAction(action, {
      render,
      apply: (key) => {
        const form = cs().form;
        if (form?.kind === "type" && !cs().command) form.draft.iconKey = key;
      },
    });
  }
  if (!type.startsWith("calendar-settings-")) return false;
  const d = cs();
  const id = action.dataset.id || "";
  const locked = Boolean(d.command);

  if (type === "calendar-settings-section") {
    const section = action.dataset.calendarSettingsSection || "";
    if (!CALENDAR_SETTINGS_SECTIONS.includes(section) || section === d.section) return true;
    d.section = section;
    setNotice("");
    render?.();
    focusSoon(`[data-calendar-settings-section="${section}"]`);
    return true;
  }
  if (type === "calendar-settings-retry") {
    await reread(render);
    return true;
  }
  if (type === "calendar-settings-toggle-archived") {
    const list = action.dataset.list || "";
    if (list in d.showArchived) d.showArchived[list] = !d.showArchived[list];
    render?.();
    return true;
  }
  if (type === "calendar-settings-check-result") {
    if (d.command?.unconfirmed && !d.command.busy) await runCommand(d.command, render);
    return true;
  }
  if (type === "calendar-settings-drop-unconfirmed") {
    if (!d.command?.unconfirmed || d.command.busy) return true;
    if (!ask("Close without checking? The change may or may not be saved. The settings are read again, so you can see what is saved now.")) return true;
    if (d.command.form && d.form === d.command.form) d.form = null;
    d.command = null;
    setNotice("Not checked. The settings were read again: look whether your change is there before making it again.");
    // It may have been saved: the calendar reads its catalog again too.
    centralCalendarCatalogChanged();
    await reread(render);
    return true;
  }
  if (type === "calendar-settings-dismiss-notice") {
    setNotice("");
    render?.();
    return true;
  }

  // Everything below writes or opens a form: never while a write runs or its
  // answer is not confirmed.
  if (locked) return true;
  if (type === "calendar-settings-new" || type === "calendar-settings-edit") {
    const kind = action.dataset.kind || "";
    if (!DRAFTS[kind]) return true;
    if (!mayReplaceForm()) return true;
    const form = openForm(kind, type === "calendar-settings-edit" ? id : "");
    if (!form) return true;
    if (iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST)) closeIconPicker();
    d.form = form;
    d.section = SECTION_OF[kind];
    setNotice("");
    render?.();
    focusSoon(`[data-calendar-settings-form] [data-cs-first]`);
    return true;
  }
  if (type === "calendar-settings-cancel") {
    if (iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST)) closeIconPicker();
    const form = d.form;
    d.form = null;
    render?.();
    if (form?.mode === "edit") focusSoon(`[data-action="calendar-settings-edit"][data-kind="${form.kind}"][data-id="${form.id}"]`);
    else if (form) focusSoon(`[data-action="calendar-settings-new"][data-kind="${form.kind}"]`);
    return true;
  }
  if (type === "calendar-settings-archive" || type === "calendar-settings-restore") {
    const kind = action.dataset.kind || "";
    const subject = SUBJECTS[kind]?.(id);
    if (!subject || kind === "team") return true;
    const verb = type === "calendar-settings-archive" ? "archive" : "restore";
    if (d.form?.id === id && d.form.kind === kind) {
      if (!mayReplaceForm()) return true;
      d.form = null;
    }
    await runCommand({
      verb, kind, id, form: null, title: subjectTitle(kind, subject), method: "POST",
      path: calendarSettingsPath(COLLECTION[kind], id, verb),
      body: { requestKey: newCalendarSettingsRequestKey(), expectedRevision: subject.revision },
      busy: false, unconfirmed: false, checkNote: "",
    }, render);
    return true;
  }
  if (type === "calendar-settings-type-move") {
    // A move changes the revision of the types it moves: never under an open
    // type's edit form (its save would be refused as changed meanwhile).
    if (d.form?.kind === "type" && d.form.mode === "edit") return true;
    const list = liveTypes();
    const at = list.findIndex((row) => String(row.id) === id);
    const direction = action.dataset.direction === "up" ? "up" : "down";
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= list.length) return true;
    const ids = list.map((row) => String(row.id));
    [ids[at], ids[to]] = [ids[to], ids[at]];
    await runCommand({
      verb: "order", kind: "type", id, direction, form: null, title: subjectTitle("type", list[at]), method: "POST",
      path: calendarSettingsPath("types", "", "order"), body: { requestKey: newCalendarSettingsRequestKey(), typeIds: ids },
      busy: false, unconfirmed: false, checkNote: "",
    }, render);
    return true;
  }

  // Inside the open form.
  const form = d.form;
  if (!form) return true;
  if (type === "calendar-settings-type-icon") {
    if (form.kind !== "type") return true;
    openIconPicker({
      host: CALENDAR_SETTINGS_ICON_HOST, title: "Choose the type's icon", current: form.draft.iconKey,
      returnFocus: '[data-action="calendar-settings-type-icon"]',
    });
    render?.();
    focusIconPicker();
    return true;
  }
  if (type === "calendar-settings-type-field-add") {
    const fieldId = form.addFieldId;
    const field = calendarFieldById(fieldId);
    if (form.kind !== "type" || !field || field.archived || form.draft.fieldIds.includes(fieldId)) {
      focusSoon("#cs-type-add-field");
      return true;
    }
    if (form.draft.fieldIds.length >= LIMITS.typeFields) {
      form.errors = { ...form.errors, fieldIds: `At most ${LIMITS.typeFields} details.` };
      render?.();
      return true;
    }
    form.draft.fieldIds.push(fieldId);
    form.addFieldId = "";
    render?.();
    focusSoon("#cs-type-add-field");
    return true;
  }
  if (type === "calendar-settings-type-field-remove" || type === "calendar-settings-type-field-move") {
    const list = form.draft.fieldIds;
    const at = list.indexOf(id);
    if (form.kind !== "type" || at < 0) return true;
    if (type === "calendar-settings-type-field-remove") {
      list.splice(at, 1);
      render?.();
      focusSoon("#cs-type-add-field");
      return true;
    }
    const to = action.dataset.direction === "up" ? at - 1 : at + 1;
    if (to < 0 || to >= list.length) return true;
    [list[at], list[to]] = [list[to], list[at]];
    render?.();
    focusSoon(`[data-action="calendar-settings-type-field-move"][data-id="${id}"][data-direction="${action.dataset.direction}"]:not([disabled])`);
    return true;
  }
  if (type === "calendar-settings-option-add") {
    if (form.kind !== "field") return true;
    const option = newOption();
    form.draft.options.push(option);
    render?.();
    focusSoon(`[data-cs-option="${option.key}"]`);
    return true;
  }
  if (type === "calendar-settings-option-remove") {
    if (form.kind !== "field") return true;
    const key = action.dataset.optionKey || "";
    form.draft.options = form.draft.options.filter((o) => o.id || o.key !== key);
    render?.();
    focusSoon('[data-action="calendar-settings-option-add"]');
    return true;
  }
  if (type === "calendar-settings-option-hide" || type === "calendar-settings-option-show") {
    const option = form.draft.options.find((o) => o.key === (action.dataset.optionKey || ""));
    if (form.kind !== "field" || !option?.id) return true;
    option.archived = type === "calendar-settings-option-hide";
    // A hidden option keeps its saved name (it is never renamed and hidden at once).
    if (option.archived) option.label = option.original;
    render?.();
    focusSoon(`[data-option-key="${option.key}"][data-action^="calendar-settings-option-"]`);
    return true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Typing and choosing (app.js routes "input" and "change" here)
// ---------------------------------------------------------------------------
const DRAFT_FIELDS = new Set(["label", "name", "address", "note", "description", "unit", "minValue", "maxValue", "kind", "valueKind", "colorKey", "defaultLocationId"]);

export function handleCalendarSettingsInput(target, { render } = {}) {
  const el = target?.closest?.("[data-cs-field],[data-cs-expect],[data-cs-option],[data-cs-add-field]");
  if (!el || !el.closest?.("[data-calendar-settings-form]")) return false;
  const form = cs().form;
  if (!form || cs().command) return true;
  const value = String(el.value ?? "");
  if (el.dataset.csAddField !== undefined) {
    form.addFieldId = value;
    if (form.errors?.addFieldId) {
      form.errors = { ...form.errors };
      delete form.errors.addFieldId;
    }
    return true;
  }
  if (el.dataset.csExpect) {
    const expect = el.dataset.csExpect;
    const on = el.checked === true;
    const set = new Set(form.draft.defaultExpects || []);
    if (on) set.add(expect);
    else set.delete(expect);
    form.draft.defaultExpects = CENTRAL_CALENDAR_EVENT_EXPECTS.filter((e) => set.has(e));
    return true;
  }
  if (el.dataset.csOption) {
    const option = form.draft.options?.find((o) => o.key === el.dataset.csOption);
    if (option && !(option.id && form.answered)) option.label = value;
    return true;
  }
  const field = el.dataset.csField;
  if (!DRAFT_FIELDS.has(field) || !(field in form.draft)) return true;
  if (form.answered && ["label", "unit", "minValue", "maxValue"].includes(field)) return true;
  if (field === "colorKey") {
    if (el.type === "radio" && !el.checked) return true;
    form.draft.colorKey = form.kind === "team" ? (isCalendarColorKey(value) ? value : "") : (isCalendarColorKey(value) ? value : null);
    return true;
  }
  if ((field === "kind" || field === "valueKind") && form.mode !== "create") return true;
  const changed = form.draft[field] !== value;
  form.draft[field] = value;
  if (field === "address") showMapsPreview(form);
  if (form.errors?.[field]) {
    form.errors = { ...form.errors };
    delete form.errors[field];
  }
  // A new type's base kind shows its icon while no icon is chosen; a new
  // detail's kind decides which fields the form has.
  if (changed && (field === "kind" || field === "valueKind")) {
    if (field === "valueKind" && value === "choice" && form.draft.options.length < LIMITS.minOptions) {
      while (form.draft.options.length < LIMITS.minOptions) form.draft.options.push(newOption());
    }
    render?.();
    focusSoon(`#cs-${form.kind}-${field}`);
  }
  return true;
}

// The place form's "Open in maps" follows the address as it is typed, in
// place (a repaint would take the focus from the field being typed in).
function showMapsPreview(form) {
  const preview = globalThis.document?.querySelector?.("[data-cs-maps-preview]");
  if (!preview) return;
  const address = oneLine(form.draft.address);
  preview.hidden = !address;
  const link = preview.querySelector?.("a");
  if (link && address) link.setAttribute("href", calendarSettingsMapsUrl(address));
}

// ---------------------------------------------------------------------------
// Saving a form
// ---------------------------------------------------------------------------
export async function submitCalendarSettingsForm(formEl, { render } = {}) {
  const d = cs();
  const form = d.form;
  if (!form || d.command || iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST)) return;
  // The browser may fill a field without an input event (autofill): the
  // values on screen are read once more.
  for (const el of formEl?.querySelectorAll?.("[data-cs-field],[data-cs-option]") || []) {
    if (el.type === "radio" && !el.checked) continue;
    if (el.type === "checkbox") continue;
    handleCalendarSettingsInput(el, {});
  }
  const { body, errors, unchanged } = BUILDERS[form.kind](form);
  form.errors = errors || {};
  form.error = "";
  if (unchanged) {
    form.error = "Nothing changed: change something, or Cancel.";
    render?.();
    return;
  }
  if (!body) {
    form.error = "Check the marked fields.";
    render?.();
    focusSoon('[data-calendar-settings-form] [aria-invalid="true"]');
    return;
  }
  await runCommand(formCommand(form, body), render);
}
