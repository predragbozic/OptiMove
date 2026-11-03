// Settings -> Calendar (K2b-1c): what the club's administrator sees. Four
// sections, one on screen at a time (the owner's P4): Event types, Details,
// Places and Teams - each a list in the server's order, archived items folded
// away, and at most one open form. Plan: docs/ai/central-calendar-k2b-plan.md
// sections 8 and 20. Every text the club typed is escaped; no id is shown.
import { CALENDAR_COLOR_KEYS, CALENDAR_COLOR_LABELS, calendarColorIndex, calendarTeamColorIndexes } from "./calendar-colors.js";
import {
  CALENDAR_SETTINGS_LIMITS as LIMITS,
  CALENDAR_SETTINGS_SECTIONS,
  CALENDAR_VALUE_KINDS,
  calendarFieldById,
  calendarSettingsContext,
  calendarSettingsMapsUrl,
  calendarTypeById,
} from "./calendar-settings-data.js";
import { CALENDAR_SETTINGS_ICON_HOST, subjectTitle } from "./calendar-settings-actions.js";
import { CENTRAL_CALENDAR_EVENT_EXPECTS, CENTRAL_CALENDAR_EVENT_KINDS } from "./central-calendar-data.js";
import { CENTRAL_CALENDAR_EXPECT_LABELS, CENTRAL_CALENDAR_EXPECT_SHORT } from "./central-calendar-event-form.js";
import { CENTRAL_CALENDAR_EVENT_KIND_ICONS, CENTRAL_CALENDAR_EVENT_KIND_LABELS } from "./central-calendar-view.js";
import { iconPickerOpenFor, renderIconPickerHtml } from "./icon-picker.js";
import { isLibraryKey, renderIconSvg } from "./icon-render.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const SECTION_WORDS = Object.freeze({ types: "Event types", details: "Details", places: "Places", teams: "Teams" });
const VALUE_KIND_WORDS = Object.freeze({ choice: "Choice from a list", number: "Number", scale_1_5: "Scale 1 to 5", yes_no: "Yes or no", short_text: "Short text" });
// The owner's sentence (P3, 2026-11-03): who fills the details in, and where
// questions for athletes go (D40).
export const CALENDAR_SETTINGS_DETAILS_SENTENCE = "Details are filled in by the event's coach. Questions for athletes will be asked through Tests.";

const ARROW = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
const ARROW_UP = ARROW("M6 15l6-6l6 6");
const ARROW_DOWN = ARROW("M6 9l6 6l6-6");

const locked = () => Boolean(state.calendarSettings.command);
const disabledIf = (condition) => (condition ? " disabled" : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function clubName(clubId) {
  const club = (state.currentUser?.clubs || []).find((row) => String(row?.id) === String(clubId));
  return club?.name || "";
}

function colorDot(index, { label = "" } = {}) {
  const style = index >= 0 ? ` style="--cs-color: var(--cc-team-${index})"` : "";
  return `<span class="cs-dot${index >= 0 ? "" : " is-none"}"${style}${label ? ` role="img" aria-label="${escapeAttr(label)}"` : ` aria-hidden="true"`}></span>`;
}

function typeIconHtml(type, size = 22) {
  const key = isLibraryKey(type?.iconKey) ? type.iconKey : CENTRAL_CALENDAR_EVENT_KIND_ICONS[type?.kind] || "calendar-event";
  const index = calendarColorIndex(type?.colorKey);
  return `<span class="cs-type-icon${index >= 0 ? " has-color" : ""}"${index >= 0 ? ` style="--cs-color: var(--cc-team-${index})"` : ""} aria-hidden="true">${renderIconSvg(key, { size })}</span>`;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------
export function renderCalendarSettingsPanelHtml() {
  const ctx = calendarSettingsContext();
  const d = state.calendarSettings;
  if (!ctx) {
    return `<section class="panel data-sources calendar-settings"><p class="muted data-sources-empty">Calendar settings are not available in this workspace.</p></section>`;
  }
  const name = clubName(ctx.clubId);
  let body;
  if (d.data && d.clubId === ctx.clubId) body = sectionHtml(d);
  else if (d.error) body = `<div class="data-sources-error" role="alert"><p>${escapeHtml(d.error)}</p><div class="data-sources-form-actions"><button class="plain-button" type="button" data-action="calendar-settings-retry">Try again</button></div></div>`;
  else body = `<p class="muted" role="status">Loading the calendar settings…</p>`;
  return `
    <section class="panel data-sources calendar-settings" aria-labelledby="cs-title">
      ${iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST) ? renderIconPickerHtml() : ""}
      <div class="data-sources-head">
        ${name ? `<p class="eyebrow">${escapeHtml(name)}</p>` : ""}
        <h3 id="cs-title">Calendar</h3>
        <p class="muted">The event types, details, places and team colours coaches use when they plan this club's events.</p>
      </div>
      ${tabsHtml(d)}
      ${commandBannerHtml(d)}
      ${noticeHtml(d)}
      ${d.data && d.error ? `<p class="data-sources-error cs-reread-error" role="alert">${escapeHtml(d.error)} <button class="plain-button compact-button" type="button" data-action="calendar-settings-retry">Try again</button></p>` : ""}
      ${body}
    </section>`;
}

function tabsHtml(d) {
  const counts = d.data ? {
    types: d.data.types.filter((t) => !t.archived).length,
    details: d.data.fields.filter((f) => !f.archived).length,
    places: d.data.locations.filter((l) => !l.archived).length,
    teams: d.data.teams.length,
  } : null;
  return `<div class="cs-tabs" role="group" aria-label="Calendar settings sections">
    ${CALENDAR_SETTINGS_SECTIONS.map((section) => `<button type="button" class="cs-tab${d.section === section ? " is-active" : ""}" data-action="calendar-settings-section" data-calendar-settings-section="${section}"${d.section === section ? ` aria-current="true"` : ""}>${escapeHtml(SECTION_WORDS[section])}${counts ? `<span class="cs-tab-count" aria-label="${escapeAttr(`, ${counts[section]}`)}">${counts[section]}</span>` : ""}</button>`).join("")}
  </div>`;
}

function noticeHtml(d) {
  if (!d.notice) return "";
  const error = d.noticeTone === "error";
  return `<div class="${error ? "data-sources-error" : "data-sources-notice"} cs-notice" data-calendar-settings-notice tabindex="-1" role="${error ? "alert" : "status"}">
      <p>${escapeHtml(d.notice)}</p>
      <button class="plain-button ghost compact-button cs-notice-close" type="button" data-action="calendar-settings-dismiss-notice" aria-label="Dismiss this message">Dismiss</button>
    </div>`;
}

// A write that is not a form's (archive, restore, a move): its state at the
// top. A form's own write shows inside the form.
function commandBannerHtml(d) {
  const cmd = d.command;
  if (!cmd || cmd.form) return "";
  if (cmd.busy) return `<p class="data-sources-notice cs-busy" role="status">${escapeHtml(commandBusyText(cmd))}</p>`;
  if (cmd.unconfirmed) return unconfirmedHtml(cmd, commandWhat(cmd));
  return "";
}

const VERB_WORDS = Object.freeze({ archive: "Archiving", restore: "Restoring", order: "Moving", create: "Adding", save: "Saving" });
function commandBusyText(cmd) {
  return `${VERB_WORDS[cmd.verb] || "Saving"} “${cmd.title || "the item"}”…`;
}
function commandWhat(cmd) {
  const title = `“${cmd.title || "the item"}”`;
  return {
    archive: `Archiving ${title}`, restore: `Restoring ${title}`, order: `Moving ${title} ${cmd.direction}`,
    create: `Adding ${title}`, save: `The changes to ${title}`,
  }[cmd.verb] || "The change";
}

function unconfirmedHtml(cmd, what) {
  return `<div class="data-sources-error cs-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> ${escapeHtml(`${what} may or may not have been saved: the answer was lost. Check result asks again with the same request; it never saves twice.`)}</p>
      ${cmd.checkNote ? `<p>${escapeHtml(cmd.checkNote)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="calendar-settings-check-result"${disabledIf(cmd.busy)}>${cmd.busy ? "Checking…" : "Check result"}</button>
        <button class="plain-button ghost" type="button" data-action="calendar-settings-drop-unconfirmed"${disabledIf(cmd.busy)}>Close without checking</button>
      </div>
    </div>`;
}

function sectionHtml(d) {
  if (d.section === "details") return detailsHtml(d);
  if (d.section === "places") return placesHtml(d);
  if (d.section === "teams") return teamsHtml(d);
  return typesHtml(d);
}

function sectionHead(id, title, intro, addKind, addLabel, d) {
  const formOpen = d.form?.kind === addKind && d.form.mode === "create";
  return `<div class="cs-section-head">
      <div>
        <h4 id="${id}">${escapeHtml(title)}</h4>
        <p class="muted">${escapeHtml(intro)}</p>
      </div>
      ${addKind ? `<button class="plain-button data-sources-primary" type="button" data-action="calendar-settings-new" data-kind="${addKind}"${disabledIf(locked() || formOpen)}>${escapeHtml(addLabel)}</button>` : ""}
    </div>`;
}

function archivedHtml(d, list, rows, rowHtml, words) {
  if (!rows.length) return "";
  const open = d.showArchived[list];
  return `<div class="cs-archived">
      <button class="plain-button ghost cs-archived-toggle" type="button" data-action="calendar-settings-toggle-archived" data-list="${list}" aria-expanded="${open}">${open ? `Hide archived ${words}` : `Show archived ${words} (${rows.length})`}</button>
      ${open ? `<ul class="cs-list cs-list-archived">${rows.map(rowHtml).join("")}</ul>` : ""}
    </div>`;
}

function restoreButton(kind, row) {
  return `<button class="plain-button" type="button" data-action="calendar-settings-restore" data-kind="${kind}" data-id="${escapeAttr(row.id)}"${disabledIf(locked())} aria-label="${escapeAttr(`Restore “${subjectTitle(kind, row)}”`)}">Restore</button>`;
}
function editButton(kind, row, idKey = "id") {
  const id = row[idKey];
  const editing = state.calendarSettings.form?.kind === kind && state.calendarSettings.form.id === String(id);
  return `<button class="plain-button" type="button" data-action="calendar-settings-edit" data-kind="${kind}" data-id="${escapeAttr(id)}"${disabledIf(locked() || editing)} aria-label="${escapeAttr(`Edit “${subjectTitle(kind, row)}”`)}">Edit</button>`;
}
function archiveButton(kind, row) {
  return `<button class="plain-button ghost" type="button" data-action="calendar-settings-archive" data-kind="${kind}" data-id="${escapeAttr(row.id)}"${disabledIf(locked())} aria-label="${escapeAttr(`Archive “${subjectTitle(kind, row)}”`)}">Archive</button>`;
}
const usedBy = (n) => (n ? `Used by ${plural(n, "event", "events")}` : "Not used by any event yet");

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------
function typeMeta(type) {
  const expects = (type.defaultExpects || []).map((e) => CENTRAL_CALENDAR_EXPECT_SHORT[e]).filter(Boolean);
  const details = (type.fieldIds || []).length;
  return [
    `Base kind: ${CENTRAL_CALENDAR_EVENT_KIND_LABELS[type.kind] || "Event"}`,
    expects.length ? `Collects ${expects.join(", ")}` : "Collects nothing",
    details ? plural(details, "detail", "details") : "No details",
    usedBy(type.eventCount || 0),
  ].join(" · ");
}

function typesHtml(d) {
  const live = d.data.types.filter((t) => !t.archived);
  const archived = d.data.types.filter((t) => t.archived);
  const form = d.form?.kind === "type" ? d.form : null;
  const row = (type, index) => {
    const editing = form?.mode === "edit" && form.id === String(type.id);
    const title = subjectTitle("type", type);
    return `<li class="cs-row${editing ? " is-editing" : ""}">
        <div class="cs-row-line">
          ${typeIconHtml(type)}
          <div class="cs-row-main">
            <p class="cs-row-title">${escapeHtml(type.label)}</p>
            <p class="cs-row-meta">${escapeHtml(typeMeta(type))}</p>
          </div>
          <div class="cs-row-actions">
            <button class="plain-button cs-icon-button" type="button" data-action="calendar-settings-type-move" data-id="${escapeAttr(type.id)}" data-direction="up" aria-label="${escapeAttr(`Move “${title}” up`)}"${disabledIf(locked() || index === 0)}>${ARROW_UP}</button>
            <button class="plain-button cs-icon-button" type="button" data-action="calendar-settings-type-move" data-id="${escapeAttr(type.id)}" data-direction="down" aria-label="${escapeAttr(`Move “${title}” down`)}"${disabledIf(locked() || index === live.length - 1)}>${ARROW_DOWN}</button>
            ${editButton("type", type)}
            ${live.length > 1 ? archiveButton("type", type) : ""}
          </div>
        </div>
        ${editing ? typeFormHtml(form, d) : ""}
      </li>`;
  };
  const archivedRow = (type) => `<li class="cs-row is-archived">
      <div class="cs-row-line">
        ${typeIconHtml(type)}
        <div class="cs-row-main"><p class="cs-row-title">${escapeHtml(type.label)}</p><p class="cs-row-meta">${escapeHtml(`Archived · ${usedBy(type.eventCount || 0)}`)}</p></div>
        <div class="cs-row-actions">${restoreButton("type", type)}</div>
      </div>
    </li>`;
  return `<div class="cs-section" aria-labelledby="cs-types-title">
      ${sectionHead("cs-types-title", "Event types", "What coaches choose from when they plan an event, in this order. The first one is offered first.", "type", "Add a type", d)}
      ${form?.mode === "create" ? typeFormHtml(form, d) : ""}
      <ol class="cs-list">${live.map(row).join("")}</ol>
      ${live.length === 1 ? `<p class="muted cs-hint">The club keeps at least one event type, so the last one cannot be archived.</p>` : ""}
      ${archivedHtml(d, "types", archived, archivedRow, "types")}
    </div>`;
}

// ---------------------------------------------------------------------------
// The forms' parts
// ---------------------------------------------------------------------------
function fieldErrorHtml(form, name) {
  const error = form.errors?.[name];
  return error ? `<span class="cs-field-error" id="cs-${form.kind}-${name}-error">${escapeHtml(error)}</span>` : "";
}
function invalid(form, name) {
  return form.errors?.[name] ? ` aria-invalid="true" aria-describedby="cs-${form.kind}-${name}-error"` : "";
}
function textInput(form, name, label, { max, hint = "", required = false, first = false, readonly = false, inputmode = "", textarea = false } = {}) {
  const id = `cs-${form.kind}-${name}`;
  const value = form.draft[name] ?? "";
  const common = `id="${id}" data-cs-field="${name}"${first ? " data-cs-first" : ""}${invalid(form, name)}${readonly ? " readonly" : ""}${required ? " required" : ""}`;
  const control = textarea
    ? `<textarea ${common} rows="3" maxlength="${max}">${escapeHtml(value)}</textarea>`
    : `<input type="text" ${common} value="${escapeAttr(value)}"${max ? ` maxlength="${max}"` : ""}${inputmode ? ` inputmode="${inputmode}"` : ""} autocomplete="off" spellcheck="${inputmode ? "false" : "true"}">`;
  return `<div class="cs-field">
      <label for="${id}">${escapeHtml(label)}${required ? "" : ` <span class="muted">(optional)</span>`}</label>
      ${hint ? `<span class="cs-field-hint">${escapeHtml(hint)}</span>` : ""}
      ${control}
      ${fieldErrorHtml(form, name)}
    </div>`;
}

function formShell(form, d, title, inner) {
  const cmd = d.command?.form === form ? d.command : null;
  const frozen = Boolean(cmd);
  const pickerOpen = iconPickerOpenFor(CALENDAR_SETTINGS_ICON_HOST);
  return `<form class="data-sources-form cs-form" data-calendar-settings-form="${form.kind}" novalidate autocomplete="off" aria-labelledby="cs-form-title"${pickerOpen ? " inert" : ""}>
      <p class="data-sources-form-title" id="cs-form-title">${escapeHtml(title)}</p>
      <fieldset class="cs-form-body"${disabledIf(frozen)}>
        ${inner}
      </fieldset>
      ${form.error ? `<p class="data-sources-error cs-form-error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${cmd?.unconfirmed ? unconfirmedHtml(cmd, commandWhat(cmd)) : ""}
      ${cmd?.unconfirmed ? "" : `<div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="submit"${disabledIf(frozen)}>${cmd?.busy ? "Saving…" : form.mode === "create" ? "Add" : "Save changes"}</button>
        <button class="plain-button ghost" type="button" data-action="calendar-settings-cancel"${disabledIf(frozen)}>Cancel</button>
      </div>`}
    </form>`;
}

function colorFieldset(form, { auto = false, legend = "Colour", hint = "" } = {}) {
  const current = form.draft.colorKey || "";
  const option = (value, label, index) => {
    const id = `cs-${form.kind}-color-${value || "none"}`;
    return `<label class="cs-swatch" for="${id}">
        <input type="radio" id="${id}" name="cs-${form.kind}-color" value="${escapeAttr(value)}" data-cs-field="colorKey"${current === value ? " checked" : ""}>
        ${colorDot(index)}<span class="cs-swatch-word">${escapeHtml(label)}</span>
      </label>`;
  };
  return `<fieldset class="cs-fieldset cs-swatches">
      <legend>${escapeHtml(legend)}</legend>
      ${hint ? `<span class="cs-field-hint">${escapeHtml(hint)}</span>` : ""}
      <div class="cs-swatch-grid">
        ${option("", auto ? "Automatic" : "No colour", -1)}
        ${CALENDAR_COLOR_KEYS.map((key) => option(key, CALENDAR_COLOR_LABELS[key], calendarColorIndex(key))).join("")}
      </div>
    </fieldset>`;
}

function typeFormHtml(form, d) {
  const create = form.mode === "create";
  const type = create ? null : calendarTypeById(form.id);
  const draft = form.draft;
  const kindRow = create
    ? `<div class="cs-field">
        <label for="cs-type-kind">Base kind</label>
        <span class="cs-field-hint">How the calendar treats these events. It can't be changed later.</span>
        <select id="cs-type-kind" data-cs-field="kind"${invalid(form, "kind")}>
          <option value=""${draft.kind ? "" : " selected"}>Choose a base kind</option>
          ${CENTRAL_CALENDAR_EVENT_KINDS.map((kind) => `<option value="${kind}"${draft.kind === kind ? " selected" : ""}>${escapeHtml(CENTRAL_CALENDAR_EVENT_KIND_LABELS[kind])}</option>`).join("")}
        </select>
        ${fieldErrorHtml(form, "kind")}
      </div>`
    : `<p class="cs-fact"><span class="muted">Base kind</span> ${escapeHtml(CENTRAL_CALENDAR_EVENT_KIND_LABELS[type?.kind] || "Event")} <span class="muted">(fixed)</span></p>`;
  const iconKey = isLibraryKey(draft.iconKey) ? draft.iconKey : null;
  const kindForIcon = create ? draft.kind : type?.kind;
  const preview = { iconKey, kind: kindForIcon, colorKey: draft.colorKey };
  const iconRow = `<div class="cs-field cs-icon-field">
      <span class="cs-label">Icon</span>
      <div class="cs-icon-choice">
        ${typeIconHtml(preview, 24)}
        <span>${iconKey ? escapeHtml(iconKey) : "The base kind's icon"}</span>
        <button class="plain-button" type="button" data-action="calendar-settings-type-icon">${iconKey ? "Change icon" : "Choose icon"}</button>
      </div>
    </div>`;
  const expects = `<fieldset class="cs-fieldset">
      <legend>Collected after it</legend>
      <span class="cs-field-hint">A new event of this type starts with these ticked; the coach can change them for that event.</span>
      ${CENTRAL_CALENDAR_EVENT_EXPECTS.map((expect) => `<label class="cs-check"><input type="checkbox" data-cs-expect="${expect}"${draft.defaultExpects.includes(expect) ? " checked" : ""}> <span>${escapeHtml(CENTRAL_CALENDAR_EXPECT_LABELS[expect])}</span></label>`).join("")}
    </fieldset>`;
  return formShell(form, d, create ? "New event type" : `Edit “${subjectTitle("type", type)}”`, `
      ${textInput(form, "label", "Name", { max: LIMITS.typeLabel, required: true, first: true })}
      ${kindRow}
      ${iconRow}
      ${colorFieldset(form, { legend: "Colour", hint: "Tints the type's icon on the calendar." })}
      ${expects}
      ${typeDetailsHtml(form, d)}
    `);
}

function typeDetailsHtml(form, d) {
  const listed = form.draft.fieldIds;
  const options = d.data.fields.filter((f) => !f.archived && !listed.includes(String(f.id)));
  const items = listed.map((id, index) => {
    const field = calendarFieldById(id);
    const label = field ? field.label : "A detail that is no longer available";
    return `<li class="cs-mini-row">
        <span class="cs-mini-main">${escapeHtml(label)}${field?.archived ? ` <span class="muted">(archived)</span>` : ""}</span>
        <span class="cs-mini-actions">
          <button class="plain-button cs-icon-button" type="button" data-action="calendar-settings-type-field-move" data-id="${escapeAttr(id)}" data-direction="up" aria-label="${escapeAttr(`Move “${label}” up`)}"${disabledIf(index === 0)}>${ARROW_UP}</button>
          <button class="plain-button cs-icon-button" type="button" data-action="calendar-settings-type-field-move" data-id="${escapeAttr(id)}" data-direction="down" aria-label="${escapeAttr(`Move “${label}” down`)}"${disabledIf(index === listed.length - 1)}>${ARROW_DOWN}</button>
          <button class="plain-button ghost" type="button" data-action="calendar-settings-type-field-remove" data-id="${escapeAttr(id)}" aria-label="${escapeAttr(`Remove “${label}”`)}">Remove</button>
        </span>
      </li>`;
  }).join("");
  return `<fieldset class="cs-fieldset"${form.errors?.fieldIds ? ` aria-describedby="cs-type-fieldIds-error"` : ""}>
      <legend>Details to fill in</legend>
      <span class="cs-field-hint">A new event of this type starts with these details, in this order; the coach can change them for that event.</span>
      ${listed.length ? `<ol class="cs-mini-list">${items}</ol>` : `<p class="muted cs-empty-line">No details yet.</p>`}
      ${listed.length < LIMITS.typeFields ? `<div class="cs-add-row">
        <label class="visually-hidden" for="cs-type-add-field">Detail to add</label>
        <select id="cs-type-add-field" data-cs-add-field>
          <option value="">${options.length ? "Choose a detail to add" : "No other detail to add"}</option>
          ${options.map((f) => `<option value="${escapeAttr(f.id)}"${form.addFieldId === String(f.id) ? " selected" : ""}>${escapeHtml(f.label)}</option>`).join("")}
        </select>
        <button class="plain-button" type="button" data-action="calendar-settings-type-field-add"${disabledIf(!options.length)}>Add detail</button>
      </div>` : `<p class="muted cs-empty-line">${escapeHtml(`At most ${LIMITS.typeFields} details.`)}</p>`}
      ${fieldErrorHtml(form, "fieldIds")}
    </fieldset>`;
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------
function numberWords(field) {
  const unit = field.unit ? ` ${field.unit}` : "";
  const min = field.minValue;
  const max = field.maxValue;
  const range = min !== null && max !== null ? `${min} to ${max}${unit}` : min !== null ? `at least ${min}${unit}` : max !== null ? `at most ${max}${unit}` : field.unit ? `in ${field.unit}` : "";
  return range ? `Number, ${range}` : "Number";
}

function fieldKindWords(field) {
  if (field.valueKind === "number") return numberWords(field);
  if (field.valueKind === "choice") {
    const live = (field.options || []).filter((o) => !o.archived).map((o) => o.label);
    return `Choice: ${live.join(", ")}`;
  }
  return VALUE_KIND_WORDS[field.valueKind] || "Detail";
}

function detailsHtml(d) {
  const live = d.data.fields.filter((f) => !f.archived);
  const archived = d.data.fields.filter((f) => f.archived);
  const form = d.form?.kind === "field" ? d.form : null;
  const row = (field) => {
    const editing = form?.mode === "edit" && form.id === String(field.id);
    const meta = [field.required ? "Required" : "Optional", field.answered ? "Has answers" : "", usedBy(field.eventCount || 0)].filter(Boolean).join(" · ");
    return `<li class="cs-row${editing ? " is-editing" : ""}">
        <div class="cs-row-line">
          <div class="cs-row-main">
            <p class="cs-row-title">${escapeHtml(field.label)}</p>
            <p class="cs-row-meta">${escapeHtml(fieldKindWords(field))}</p>
            ${field.description ? `<p class="cs-row-note">${escapeHtml(field.description)}</p>` : ""}
            <p class="cs-row-meta">${escapeHtml(meta)}</p>
          </div>
          <div class="cs-row-actions">${editButton("field", field)}${archiveButton("field", field)}</div>
        </div>
        ${editing ? fieldFormHtml(form, d) : ""}
      </li>`;
  };
  const archivedRow = (field) => `<li class="cs-row is-archived"><div class="cs-row-line">
      <div class="cs-row-main"><p class="cs-row-title">${escapeHtml(field.label)}</p><p class="cs-row-meta">${escapeHtml(`Archived · ${fieldKindWords(field)}`)}</p></div>
      <div class="cs-row-actions">${restoreButton("field", field)}</div>
    </div></li>`;
  return `<div class="cs-section" aria-labelledby="cs-details-title">
      ${sectionHead("cs-details-title", "Details", "Facts a coach records about an event, such as the weather, the surface or the score.", "field", "Add a detail", d)}
      <p class="cs-fact cs-filled-by">${escapeHtml(CALENDAR_SETTINGS_DETAILS_SENTENCE)}</p>
      ${form?.mode === "create" ? fieldFormHtml(form, d) : ""}
      ${live.length ? `<ul class="cs-list">${live.map(row).join("")}</ul>` : `<p class="muted cs-empty-line">No details yet.</p>`}
      ${archivedHtml(d, "details", archived, archivedRow, "details")}
    </div>`;
}

function fieldFormHtml(form, d) {
  const create = form.mode === "create";
  const field = create ? null : calendarFieldById(form.id);
  const kind = create ? form.draft.valueKind : form.valueKind;
  const answered = form.answered;
  const kindRow = create
    ? `<div class="cs-field">
        <label for="cs-field-valueKind">Answer</label>
        <span class="cs-field-hint">What kind of answer the coach gives. It can't be changed later.</span>
        <select id="cs-field-valueKind" data-cs-field="valueKind"${invalid(form, "valueKind")}>
          <option value=""${kind ? "" : " selected"}>Choose the kind of answer</option>
          ${CALENDAR_VALUE_KINDS.map((k) => `<option value="${k}"${kind === k ? " selected" : ""}>${escapeHtml(VALUE_KIND_WORDS[k])}</option>`).join("")}
        </select>
        ${fieldErrorHtml(form, "valueKind")}
      </div>`
    : `<p class="cs-fact"><span class="muted">Answer</span> ${escapeHtml(VALUE_KIND_WORDS[kind] || "Detail")} <span class="muted">(fixed)</span></p>`;
  const numberRows = kind === "number" ? `<div class="cs-field-group">
      ${textInput(form, "unit", "Unit", { max: LIMITS.unit, hint: "For example °C, min or km.", readonly: answered, inputmode: "text" })}
      ${textInput(form, "minValue", "Lowest value", { max: 16, readonly: answered, inputmode: "decimal" })}
      ${textInput(form, "maxValue", "Highest value", { max: 16, readonly: answered, inputmode: "decimal" })}
    </div>` : "";
  const required = field?.required === true;
  return formShell(form, d, create ? "New detail" : `Edit “${subjectTitle("field", field)}”`, `
      ${answered ? `<p class="data-sources-warn cs-frozen">This detail already has answers: its meaning can't change. Add options, or archive it and create a new one.</p>` : ""}
      ${textInput(form, "label", "Name", { max: LIMITS.fieldLabel, required: true, first: !answered, readonly: answered })}
      ${textInput(form, "description", "Hint for the coach", { max: LIMITS.fieldDescription, hint: "One line, for example: “The pitch the session was on.”", first: answered })}
      ${kindRow}
      ${numberRows}
      ${kind === "choice" ? optionsHtml(form) : ""}
      <p class="cs-fact"><span class="muted">Filled by</span> coach · ${required ? "Required" : "Optional"}</p>
    `);
}

function optionsHtml(form) {
  const answered = form.answered;
  const visible = form.draft.options.filter((o) => !o.archived).length;
  const errors = form.errors?.optionLabels || {};
  const rows = form.draft.options.map((option, index) => {
    const id = `cs-option-${option.key}`;
    const error = errors[option.key];
    const readonly = Boolean(option.id) && answered;
    const action = option.id
      ? option.archived
        ? `<button class="plain-button" type="button" data-action="calendar-settings-option-show" data-option-key="${escapeAttr(option.key)}" aria-label="${escapeAttr(`Show “${option.original}” again`)}">Show again</button>`
        : `<button class="plain-button ghost" type="button" data-action="calendar-settings-option-hide" data-option-key="${escapeAttr(option.key)}" aria-label="${escapeAttr(`Hide “${option.original}”`)}"${disabledIf(visible <= LIMITS.minOptions)}>Hide</button>`
      : `<button class="plain-button ghost" type="button" data-action="calendar-settings-option-remove" data-option-key="${escapeAttr(option.key)}" aria-label="${escapeAttr(`Remove option ${index + 1}`)}"${disabledIf(visible <= LIMITS.minOptions)}>Remove</button>`;
    return `<li class="cs-mini-row${option.archived ? " is-hidden" : ""}">
        <span class="cs-mini-main">
          <label class="visually-hidden" for="${id}">${escapeHtml(`Option ${index + 1}`)}</label>
          <input type="text" id="${id}" data-cs-option="${escapeAttr(option.key)}" value="${escapeAttr(option.label)}" maxlength="${LIMITS.optionLabel}" autocomplete="off"${readonly || option.archived ? " readonly" : ""}${error ? ` aria-invalid="true" aria-describedby="${id}-error"` : ""}>
          ${option.archived ? `<span class="muted cs-hidden-word">Hidden: old answers keep it, new events can't choose it.</span>` : ""}
          ${error ? `<span class="cs-field-error" id="${id}-error">${escapeHtml(error)}</span>` : ""}
        </span>
        <span class="cs-mini-actions">${action}</span>
      </li>`;
  }).join("");
  return `<fieldset class="cs-fieldset"${form.errors?.options ? ` aria-describedby="cs-field-options-error"` : ""}>
      <legend>Options</legend>
      <span class="cs-field-hint">${escapeHtml(`The coach picks one. ${LIMITS.minOptions} to ${LIMITS.options} options, each up to ${LIMITS.optionLabel} characters.`)}</span>
      <ol class="cs-mini-list">${rows}</ol>
      ${visible < LIMITS.options ? `<button class="plain-button" type="button" data-action="calendar-settings-option-add">Add an option</button>` : ""}
      ${fieldErrorHtml(form, "options")}
    </fieldset>`;
}

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------
function mapsLink(address, name, label = `Open “${name}” in maps (opens a new tab)`) {
  return `<a class="cs-maps" href="${escapeAttr(calendarSettingsMapsUrl(address))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeAttr(label)}">Open in maps</a>`;
}

function placesHtml(d) {
  const live = d.data.locations.filter((l) => !l.archived);
  const archived = d.data.locations.filter((l) => l.archived);
  const form = d.form?.kind === "location" ? d.form : null;
  const teamNames = (ids) => (ids || []).map((id) => d.data.teams.find((t) => String(t.teamId) === String(id))?.name).filter(Boolean);
  const row = (place) => {
    const editing = form?.mode === "edit" && form.id === String(place.id);
    const teams = teamNames(place.defaultOfTeamIds);
    const meta = [teams.length ? `Default place of ${teams.join(", ")}` : "", usedBy(place.eventCount || 0)].filter(Boolean).join(" · ");
    return `<li class="cs-row${editing ? " is-editing" : ""}">
        <div class="cs-row-line">
          <div class="cs-row-main">
            <p class="cs-row-title">${escapeHtml(place.name)}</p>
            ${place.address ? `<p class="cs-row-address">${escapeHtml(place.address)} ${mapsLink(place.address, place.name)}</p>` : `<p class="cs-row-meta">No address</p>`}
            ${place.note ? `<p class="cs-row-note">${escapeHtml(place.note)}</p>` : ""}
            <p class="cs-row-meta">${escapeHtml(meta)}</p>
          </div>
          <div class="cs-row-actions">${editButton("location", place)}${archiveButton("location", place)}</div>
        </div>
        ${editing ? placeFormHtml(form, d) : ""}
      </li>`;
  };
  const archivedRow = (place) => `<li class="cs-row is-archived"><div class="cs-row-line">
      <div class="cs-row-main"><p class="cs-row-title">${escapeHtml(place.name)}</p><p class="cs-row-meta">${escapeHtml(place.address ? `Archived · ${place.address}` : "Archived")}</p></div>
      <div class="cs-row-actions">${restoreButton("location", place)}</div>
    </div></li>`;
  return `<div class="cs-section" aria-labelledby="cs-places-title">
      ${sectionHead("cs-places-title", "Places", "The club's venues. A coach picks one for an event; its address and note show on the event.", "location", "Add a place", d)}
      ${form?.mode === "create" ? placeFormHtml(form, d) : ""}
      ${live.length ? `<ul class="cs-list">${live.map(row).join("")}</ul>` : `<p class="muted cs-empty-line">No places yet.</p>`}
      ${archivedHtml(d, "places", archived, archivedRow, "places")}
    </div>`;
}

function placeFormHtml(form, d) {
  const create = form.mode === "create";
  const place = create ? null : d.data.locations.find((l) => String(l.id) === form.id);
  const address = String(form.draft.address || "").trim();
  return formShell(form, d, create ? "New place" : `Edit “${subjectTitle("location", place)}”`, `
      ${textInput(form, "name", "Name", { max: LIMITS.locationName, required: true, first: true })}
      ${textInput(form, "address", "Address", { max: LIMITS.address, hint: "Street, number and town, as a map would find it." })}
      <p class="cs-maps-preview" data-cs-maps-preview${address ? "" : " hidden"}>${mapsLink(address || " ", "", "Open in maps the address typed above (opens a new tab)")} <span class="muted">to check the address.</span></p>
      ${textInput(form, "note", "Note", { max: LIMITS.note, hint: "For example the entrance, parking or the changing room.", textarea: true })}
      ${!create && (place?.eventCount || 0) ? `<p class="cs-field-hint">${escapeHtml(`A change shows on every event at this place (${plural(place.eventCount, "event", "events")}), past ones included.`)}</p>` : ""}
    `);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
function teamsHtml(d) {
  const teams = d.data.teams;
  const colors = calendarTeamColorIndexes(teams);
  const form = d.form?.kind === "team" ? d.form : null;
  const placeName = (id) => d.data.locations.find((l) => String(l.id) === String(id));
  const row = (team) => {
    const editing = form?.id === String(team.teamId);
    const index = colors.get(team.teamId) ?? -1;
    const colorWord = team.colorKey ? CALENDAR_COLOR_LABELS[team.colorKey] || "Chosen" : `${CALENDAR_COLOR_LABELS[CALENDAR_COLOR_KEYS[index]] || "Automatic"} (automatic)`;
    const place = team.defaultLocationId ? placeName(team.defaultLocationId) : null;
    const placeWord = place ? `${place.name}${place.archived ? " (archived: not offered)" : ""}` : "None";
    return `<li class="cs-row${editing ? " is-editing" : ""}">
        <div class="cs-row-line">
          ${colorDot(index)}
          <div class="cs-row-main">
            <p class="cs-row-title">${escapeHtml(team.name || "Team")}</p>
            <p class="cs-row-meta">${escapeHtml(`Colour: ${colorWord} · Default place: ${placeWord}`)}</p>
          </div>
          <div class="cs-row-actions">${editButton("team", team, "teamId")}</div>
        </div>
        ${editing ? teamFormHtml(form, d, team) : ""}
      </li>`;
  };
  return `<div class="cs-section" aria-labelledby="cs-teams-title">
      ${sectionHead("cs-teams-title", "Teams", "Each team's colour on the calendar, and the place its new events start with. A team without a chosen colour gets an automatic one.", "", "", d)}
      ${teams.length ? `<ul class="cs-list">${teams.map(row).join("")}</ul>` : `<p class="muted cs-empty-line">The club has no active team.</p>`}
    </div>`;
}

function teamFormHtml(form, d, team) {
  const places = d.data.locations;
  const current = form.draft.defaultLocationId;
  const options = places.filter((l) => !l.archived || String(l.id) === current);
  return formShell(form, d, `Edit “${team.name || "Team"}”`, `
      ${colorFieldset(form, { auto: true, legend: "Colour on the calendar", hint: "Automatic: the next colour no other team chose." })}
      <div class="cs-field">
        <label for="cs-team-defaultLocationId">Default place <span class="muted">(optional)</span></label>
        <span class="cs-field-hint">A new event of this team starts at this place; the coach can change it.</span>
        <select id="cs-team-defaultLocationId" data-cs-field="defaultLocationId"${invalid(form, "defaultLocationId")}>
          <option value=""${current ? "" : " selected"}>No default place</option>
          ${options.map((l) => `<option value="${escapeAttr(l.id)}"${String(l.id) === current ? " selected" : ""}>${escapeHtml(`${l.name}${l.archived ? " (archived)" : ""}`)}</option>`).join("")}
        </select>
        ${places.some((l) => !l.archived) ? "" : `<span class="cs-field-hint">The club has no place yet: add one under Places.</span>`}
        ${fieldErrorHtml(form, "defaultLocationId")}
      </div>
    `);
}
