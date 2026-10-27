// Training Load -> Data configuration -> Variables: the markup. Every text that
// came from the server or the coach is escaped; ids live only in data-
// attributes and under Technical details.
import {
  AGGREGATIONS, CONDITION_KINDS, LEVELS, LIMITS, OPERATORS, UNIT_SUGGESTIONS,
  aggregationLabel, conditionSummary, levelLabel, rangeSummary, readinessText, variablesContext, variablesState,
} from "./metric-variables-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const fmtDate = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }).replaceAll("/", ".");
};
const cut = (item, text) => `${escapeHtml(text || "")}${item?.truncated ? "…" : ""}`;

export function renderVariablesHtml() {
  const ctx = variablesContext();
  if (!ctx) return `<section class="metric-variables"><p class="empty">Variables are available in the platform workspace, in a club workspace and in a team workspace of a club.</p></section>`;
  const s = variablesState();
  return `
    <section class="metric-variables" aria-labelledby="metric-variables-title">
      ${s.form ? renderFormHtml(s, ctx) : s.detail.id ? renderDetailHtml(s, ctx) : renderListHtml(s, ctx)}
    </section>
  `;
}

function scopeIntro(s, ctx) {
  if (ctx.owner === "system") return "System variables: shared by all clubs. A platform administrator can map any club's source data to them.";
  if (s.scope === "system") {
    return ctx.view === "coach" ? "System variables, for reference: shared by all clubs and changed only by a platform administrator."
      : "System variables, for reference: managed in the platform workspace; this club's own mappings cannot target them.";
  }
  if (ctx.view === "coach") return "Variables of this team's club, shared by all its teams. As a coach of the team you can rename, archive and restore them; each change applies to every team of the club. An administrator of the club creates them and changes how they are measured.";
  return `Variables of ${escapeHtml(ctx.clubName || "this club")}: this club's own source data can be mapped to them.`;
}

function renderListHtml(s, ctx) {
  const list = s.list;
  const canCreate = ctx.view !== "coach" && (ctx.owner === "system" || s.scope === "own");
  return `
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title">Variables</h2>
        <p class="muted">${scopeIntro(s, ctx)}</p>
      </div>
      ${canCreate ? `<button class="plain-button data-sources-primary" type="button" data-action="metric-variables-create-open">New variable</button>` : ""}
    </div>
    ${s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : ""}
    <div class="metric-variables-controls">
      ${ctx.owner === "club" ? `
        <div class="metric-variables-segmented" role="group" aria-label="Whose variables">
          <button type="button" class="plain-button compact-button ${s.scope === "own" ? "is-active" : ""}" aria-pressed="${s.scope === "own"}" data-action="metric-variables-scope" data-scope="own">This club</button>
          <button type="button" class="plain-button compact-button ${s.scope === "system" ? "is-active" : ""}" aria-pressed="${s.scope === "system"}" data-action="metric-variables-scope" data-scope="system">System (reference)</button>
        </div>` : ""}
      <label class="search-field metric-variables-state"><span>Show</span>
        <select data-metric-variables-filter="state">
          ${[["active", "Active"], ["archived", "Archived"], ["all", "Active and archived"]].map(([value, label]) => `<option value="${value}" ${s.stateFilter === value ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </label>
    </div>
    ${list.loading && !list.loaded ? `<p class="muted" role="status">Loading variables...</p>` : ""}
    ${list.error ? `<div class="error" role="alert"><p>${escapeHtml(list.error)}</p><button class="plain-button" type="button" data-action="metric-variables-reload">Try again</button></div>` : ""}
    ${list.loaded && !list.items.length && !list.error ? `<p class="empty">${emptyListText(s, ctx, canCreate)}</p>` : ""}
    ${list.items.length ? `<ul class="metric-variables-list">${list.items.map(renderListItemHtml).join("")}</ul>` : ""}
    ${list.nextCursor ? `<button class="plain-button" type="button" data-action="metric-variables-more" ${list.loadingMore ? "disabled" : ""}>${list.loadingMore ? "Loading..." : "Show more"}</button>` : ""}
  `;
}

function emptyListText(s, ctx, canCreate) {
  if (s.stateFilter === "archived") return "No archived variables.";
  if (ctx.owner === "club" && s.scope === "system") return "There are no system variables yet.";
  if (ctx.view === "coach") return "This club has no variables of its own yet. An administrator of the club creates them.";
  if (ctx.owner === "club") return "This club has no variables of its own yet. Check System (reference) first (a platform administrator maps this club's data to them), and create one here only for a measure that list does not have.";
  return canCreate ? "No variables yet. Create the first one with New variable." : "No variables yet.";
}

function renderListItemHtml(item) {
  const current = item.currentVersion || {};
  const facts = [
    current.unit ? escapeHtml(current.unit) : "",
    (item.levels || []).map(levelLabel).map(escapeHtml).join(" and "),
    current.dailyAggregationMethod ? `per day: ${escapeHtml(aggregationLabel(current.dailyAggregationMethod))}` : "",
    current.condition ? escapeHtml(conditionSummary(current.condition)) : "",
    current.versionNumber ? `version ${escapeHtml(String(current.versionNumber))}` : "",
  ].filter(Boolean).join(" · ");
  return `
    <li>
      <button type="button" class="metric-variables-item" data-action="metric-variables-open" data-variable-id="${escapeAttr(item.id)}">
        <span class="metric-variables-item-name">${cut(item, item.label)}${item.shortLabel ? ` <span class="muted">(${escapeHtml(item.shortLabel)})</span>` : ""}</span>
        <span class="metric-variables-item-facts muted">${facts}</span>
        ${item.state === "archived" ? `<span class="item-badge">Archived</span>` : ""}
      </button>
    </li>
  `;
}

function renderDetailHtml(s, ctx) {
  const d = s.detail;
  const item = d.variable;
  const back = `<button class="plain-button ghost metric-variables-back" type="button" data-action="metric-variables-back">← All variables</button>`;
  if (d.loading && !item) return `${back}<p class="muted" role="status">Loading the variable...</p>`;
  if (d.error && !item) return `${back}<div class="error" role="alert"><p>${escapeHtml(d.error)}</p><button class="plain-button" type="button" data-action="metric-variables-open" data-variable-id="${escapeAttr(d.id)}">Try again</button></div>`;
  if (!item) return back;
  const current = item.currentVersion || {};
  // What this caller may do now is the server's answer (`actions`, J3b.2),
  // never worked out here from a role.
  const actions = item.actions || [];
  const reduced = ctx.view === "coach";
  return `
    ${back}
    <div class="metric-variables-head">
      <div>
        <h2 id="metric-variables-title">${cut(item, item.label)}</h2>
        ${item.shortLabel ? `<p class="muted">Short name: ${escapeHtml(item.shortLabel)}</p>` : ""}
      </div>
      ${renderActionsHtml(actions)}
    </div>
    ${s.notice ? `<p class="metric-variables-notice" role="status">${escapeHtml(s.notice)}</p>` : ""}
    ${item.state === "archived" ? `<p class="muted">${reduced
      ? "Archived: kept with its recorded values and its history; no new values can be entered for it until it is restored."
      : "Archived: kept with its recorded values and its history; until it is restored, no new values can be entered for it, it gets no new version and no new mapping can use it."}</p>` : ""}
    ${actionsNoteHtml(item, actions, ctx)}
    ${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}
    ${reduced ? renderReducedTechHtml(item) : `
    <dl class="metric-variables-facts">
      <div><dt>Unit</dt><dd>${escapeHtml(current.unit || "")}</dd></div>
      <div><dt>Recorded for</dt><dd>${(item.levels || []).map(levelLabel).map(escapeHtml).join(" and ")}</dd></div>
      <div><dt>Per day</dt><dd>${escapeHtml(aggregationLabel(current.dailyAggregationMethod))}</dd></div>
      <div><dt>Allowed values</dt><dd>${escapeHtml(rangeSummary(current))}</dd></div>
      <div><dt>Condition</dt><dd>${escapeHtml(conditionSummary(current.condition))}</dd></div>
      <div><dt>Mapping</dt><dd>${escapeHtml(readinessText(item.mappingTarget))}</dd></div>
    </dl>
    ${d.error ? `<p class="error" role="alert">${escapeHtml(d.error)}</p>` : ""}
    <h3>Versions</h3>
    <ol class="metric-variables-versions">
      ${(item.versions || []).map((version) => renderVersionHtml(version)).join("")}
    </ol>
    ${d.nextCursor ? `<button class="plain-button" type="button" data-action="metric-variables-more-versions" ${d.loadingMore ? "disabled" : ""}>${d.loadingMore ? "Loading..." : "Show older versions"}</button>` : ""}
    <details class="data-sources-tech"><summary>Technical details</summary><dl>
      <div><dt>Key</dt><dd>${cut({ truncated: false }, item.key)}</dd></div>
      <div><dt>Owner</dt><dd>${escapeHtml(item.ownerScope || "")}</dd></div>
      <div><dt>Variable id</dt><dd>${escapeHtml(item.id)}</dd></div>
      <div><dt>Current version id</dt><dd>${escapeHtml(current.id || "")}</dd></div>
      <div><dt>Created</dt><dd>${escapeHtml(fmtDate(item.createdAt))}</dd></div>
    </dl></details>`}
  `;
}

const ACTION_BUTTONS = [
  ["rename", "metric-variables-rename-open", "Rename"],
  ["newVersion", "metric-variables-version-open", "New version"],
  ["archive", "metric-variables-archive-open", "Archive"],
  ["restore", "metric-variables-restore-open", "Restore"],
];
function renderActionsHtml(actions) {
  const buttons = ACTION_BUTTONS.filter(([name]) => actions.includes(name));
  if (!buttons.length) return "";
  // The first action offered is the primary one; Archive is never primary.
  return `<div class="metric-variables-actions">${buttons.map(([name, action, label], index) => `<button class="plain-button ${index === 0 && name !== "archive" ? "data-sources-primary" : "ghost"}" type="button" data-action="${action}">${label}</button>`).join("")}</div>`;
}

// Why an action this caller might expect is not offered (from the answer only).
function actionsNoteHtml(item, actions, ctx) {
  const coach = ctx.view === "coach";
  if (item.editable === false) {
    if (item.state !== "active") return "";
    return `<p class="muted">${coach ? "Read only: system variables are shared by all clubs and changed only by a platform administrator." : "Read only here: system variables are changed in the platform workspace."}</p>`;
  }
  // Only an active mapping takes Archive away from an active variable (J3b.2).
  if (item.state === "active" && !actions.includes("archive")) {
    if (!coach) return `<p class="muted">An active mapping uses this variable, so it cannot get a new version or be archived now.</p>`;
    return `<p class="muted">A data source is mapped to this variable (an active mapping), so it cannot be archived now${actions.includes("rename") ? "" : ", and only an administrator of the club can rename it"}.</p>`;
  }
  if (item.state === "archived" && !actions.includes("restore")) {
    return `<p class="muted">An administrator archived this variable, so only an administrator can restore it.</p>`;
  }
  return "";
}

// The reduced view of a team workspace (Q7): no versions, levels or mapping
// readiness, which the server does not send there.
function renderReducedTechHtml(item) {
  return `
    <details class="data-sources-tech"><summary>Technical details</summary><dl>
      <div><dt>Key</dt><dd>${escapeHtml(item.key || "")}</dd></div>
      <div><dt>Owner</dt><dd>${escapeHtml(item.ownerScope || "")}</dd></div>
      <div><dt>Variable id</dt><dd>${escapeHtml(item.id)}</dd></div>
    </dl></details>`;
}

function renderVersionHtml(version) {
  return `
    <li class="metric-variables-version">
      <p><strong>Version ${escapeHtml(String(version.versionNumber))}</strong>${version.current ? ` <span class="item-badge">Current</span>` : ""} <span class="muted">${escapeHtml(fmtDate(version.createdAt))}</span></p>
      <p class="muted">${[
        escapeHtml(version.unit || ""),
        version.dailyAggregationMethod ? `per day: ${escapeHtml(aggregationLabel(version.dailyAggregationMethod))}` : "",
        escapeHtml(rangeSummary(version)),
        escapeHtml(conditionSummary(version.condition)),
      ].filter(Boolean).join(" · ")}</p>
      ${version.reason ? `<p>Reason: ${escapeHtml(version.reason)}</p>` : ""}
    </li>
  `;
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------
const fieldError = (form, field) => (form.errors[field] ? `<span class="metric-variables-field-error" id="mv-err-${field}">${escapeHtml(form.errors[field])}</span>` : "");
const described = (form, field, hint = "", note = "") => {
  const ids = [note ? `mv-note-${field}` : "", hint ? `mv-hint-${field}` : "", form.errors[field] ? `mv-err-${field}` : ""].filter(Boolean).join(" ");
  return ids ? ` aria-describedby="${ids}"` : "";
};
const invalid = (form, field) => (form.errors[field] ? ` aria-invalid="true"` : "");

// A token (a unit, a key) is case-sensitive: a phone must not capitalise or
// correct it.
const TOKEN_ATTRS = ` autocapitalize="none" autocorrect="off" spellcheck="false"`;
// `note`: what the coach must not miss (what replacing loses, a name saved
// meanwhile), shown above the ordinary hint and read first. `wide`: the field
// takes the whole row of its grid.
function textInput(form, field, label, { max, required = false, hint = "", note = "", list = "", token = false, wide = false } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field${wide ? " metric-variables-wide" : ""}"><span>${escapeHtml(label)}${required ? "" : ` <span class="muted">(optional)</span>`}</span>
      <input type="text" data-mv-field="${field}" value="${escapeAttr(form.draft[field] ?? "")}" ${max ? `maxlength="${max}"` : ""} ${list ? `list="${list}"` : ""} autocomplete="off"${token ? TOKEN_ATTRS : ""} ${locked ? "disabled" : ""}${described(form, field, hint, note)}${invalid(form, field)}>
      ${note ? `<span class="metric-variables-field-note" id="mv-note-${field}">${escapeHtml(note)}</span>` : ""}
      ${hint ? `<span class="muted" id="mv-hint-${field}">${escapeHtml(hint)}</span>` : ""}
      ${fieldError(form, field)}
    </label>
  `;
}
// A phone's decimal pad has no minus sign, so only a value that can never be
// negative (the seconds of an effort) gets it.
function decimalInput(form, field, label, { required = false, unsigned = false } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field"><span>${escapeHtml(label)}${required ? "" : ` <span class="muted">(optional)</span>`}</span>
      <input type="text" ${unsigned ? `inputmode="decimal"` : ""}${TOKEN_ATTRS} data-mv-field="${field}" value="${escapeAttr(form.draft[field] ?? "")}" autocomplete="off" ${locked ? "disabled" : ""}${described(form, field)}${invalid(form, field)}>
      ${fieldError(form, field)}
    </label>
  `;
}
function selectInput(form, field, label, options, { placeholder = "", structural = false, hint = "" } = {}) {
  const locked = form.busy || form.unconfirmed;
  return `
    <label class="search-field"><span>${escapeHtml(label)}</span>
      <select data-mv-field="${field}" ${structural ? "data-mv-structural" : ""} ${locked ? "disabled" : ""}${described(form, field, hint)}${invalid(form, field)}>
        ${placeholder ? `<option value="" ${form.draft[field] ? "" : "selected"}>${escapeHtml(placeholder)}</option>` : ""}
        ${options.map((o) => `<option value="${escapeAttr(o.value)}" ${form.draft[field] === o.value ? "selected" : ""}>${escapeHtml(o.label)}</option>`).join("")}
      </select>
      ${hint ? `<span class="muted" id="mv-hint-${field}">${escapeHtml(hint)}</span>` : ""}
      ${fieldError(form, field)}
    </label>
  `;
}

const CONDITION_HINT = {
  zone_between: "The variable measures what happens while the value is inside the zone, for example the distance run at 19.8-25.2 km/h.",
  zone_one_sided: "The variable measures what happens while the value is above (or below) the level, for example the distance run above 25.2 km/h.",
  event_threshold: "The variable counts efforts past the threshold that last at least the given time, for example accelerations of at least 3 m/s2 for at least 0.5 s.",
};
function renderConditionHtml(form) {
  const d = form.draft;
  const kinds = d.conditionKind === "unsupported" ? [{ value: "unsupported", label: "Choose again: stored in another format" }, ...CONDITION_KINDS] : CONDITION_KINDS;
  const event = d.conditionKind === "event_threshold";
  const parts = [selectInput(form, "conditionKind", "Type", kinds, { structural: true, hint: CONDITION_HINT[d.conditionKind] || "" })];
  if (d.conditionKind === "zone_between") {
    parts.push(decimalInput(form, "conditionLower", "From (level)", { required: true }), decimalInput(form, "conditionUpper", "To (level)", { required: true }));
  } else if (d.conditionKind === "zone_one_sided" || event) {
    parts.push(selectInput(form, "conditionOperator", event ? "Counted when the value is" : "Inside the zone when the value is", OPERATORS), decimalInput(form, "conditionValue", event ? "Threshold" : "Level", { required: true }));
    if (event) parts.push(decimalInput(form, "conditionDuration", "For at least (seconds)", { required: true, unsigned: true }));
  }
  if (["zone_between", "zone_one_sided", "event_threshold"].includes(d.conditionKind)) {
    parts.push(textInput(form, "conditionUnit", event ? "Unit of the threshold" : "Unit of the levels", { max: LIMITS.unit, required: true, list: "mv-unit-suggestions", token: true, hint: event ? "Usually not the variable's unit: m/s2 for a count of accelerations." : "Usually not the variable's unit: km/h for a distance zone measured in m." }));
  }
  return `<fieldset class="metric-variables-fieldset"><legend>Condition</legend><p class="muted">Optional: a zone the value is measured in, or an effort the variable counts.</p><div class="metric-variables-grid">${parts.join("")}</div></fieldset>`;
}

function renderFormHtml(s, ctx) {
  const form = s.form;
  if (form.mode === "rename" || form.mode === "archive" || form.mode === "restore") return renderChangeFormHtml(form, ctx);
  const create = form.mode === "create";
  const locked = form.busy || form.unconfirmed;
  const title = create ? (ctx.owner === "system" ? "New system variable" : "New variable for this club") : `New version of ${escapeHtml(form.variableLabel)}`;
  const hint = form.keyHint;
  const keyLine = hint.loading ? "Making the key..." : hint.required ? "No key can be made from this name (a key uses only the letters a-z, digits and underscores): enter one below."
    : hint.key ? `Key: ${escapeHtml(hint.key)}${hint.taken ? " - already used here; enter another key below." : ""}` : "The key is made from the name.";
  return `
    <form class="data-sources-form metric-variables-form" data-metric-variables-form="${create ? "create" : "version"}" novalidate autocomplete="off">
      <h2 id="metric-variables-title">${title}</h2>
      ${create ? "" : `<p class="muted">A new version replaces how the variable is measured from now on; earlier values keep the version they were recorded with. Every field below is saved as shown. The name and Recorded for stay as they are.</p>`}
      <p class="muted">Do not enter athlete names, ids, dates of birth or measured values.</p>
      <datalist id="mv-unit-suggestions">${UNIT_SUGGESTIONS.map((unit) => `<option value="${escapeAttr(unit)}"></option>`).join("")}</datalist>
      ${create ? `
        <fieldset class="metric-variables-fieldset"><legend>Name</legend><div class="metric-variables-grid">
          ${textInput(form, "label", "Name", { max: LIMITS.label, required: true })}
          ${textInput(form, "shortLabel", "Short name", { max: LIMITS.shortLabel, hint: "Shown where space is short, for example TotDist." })}
          ${textInput(form, "description", "Description", { max: LIMITS.description })}
        </div></fieldset>` : ""}
      <fieldset class="metric-variables-fieldset"><legend>Measurement</legend><div class="metric-variables-grid">
        ${textInput(form, "unit", "Unit", { max: LIMITS.unit, required: true, list: "mv-unit-suggestions", token: true, hint: "A short unit without spaces, for example m, km/h or count." })}
        ${selectInput(form, "dailyAggregationMethod", "Combine a day's values", AGGREGATIONS, { placeholder: "Choose...", hint: "When an athlete has several values on one day: Sum for distance, time and counts; Highest for top speed." })}
        ${decimalInput(form, "minValue", "Lowest allowed value")}
        ${decimalInput(form, "maxValue", "Highest allowed value")}
      </div>
      <p class="muted">A value outside the allowed values is refused. Leave them empty for no limit.</p>
      ${create ? `
        <div class="metric-variables-levels" role="group" aria-labelledby="mv-levels-label"${form.errors.levels ? ` aria-describedby="mv-err-levels"` : ""}>
          <span id="mv-levels-label">Recorded for</span>
          ${LEVELS.map((level) => `<label class="checkbox-row"><input type="checkbox" data-mv-level="${level.value}" ${form.draft.levels.includes(level.value) ? "checked" : ""} ${locked ? "disabled" : ""}> ${escapeHtml(level.label)}</label>`).join("")}
          ${fieldError(form, "levels")}
          <span class="muted">Session: one value for the whole session. Drill: one value for each drill; choose it if drill values will be mapped to it.</span>
        </div>` : ""}
      </fieldset>
      ${renderConditionHtml(form)}
      ${create ? "" : textInput(form, "reason", "Reason for the new version", { max: LIMITS.reason })}
      ${create ? `
        <details class="data-sources-tech" ${form.errors.key || hint.required || hint.taken ? "open" : ""}><summary>Technical details</summary>
          <p class="muted" data-mv-key-hint aria-live="polite">${keyLine}</p>
          ${textInput(form, "key", "Custom key", { max: LIMITS.key, token: true, hint: "Leave empty to use the key made from the name. It cannot be changed later." })}
        </details>` : ""}
      ${create && !form.unconfirmed ? `<p class="muted">After you create it, the name, short name, description, key and Recorded for cannot be changed, and the variable cannot be deleted. Unit, how a day's values are combined, allowed values and condition can be changed later with a new version.</p>` : ""}
      ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${form.unconfirmed ? `
        <div class="metric-variables-unconfirmed" role="alert">
          <p><strong>Result not confirmed.</strong> No confirmation arrived, so it is not known whether it was saved. Check result sends the same request again: it is never saved twice.</p>
          ${form.checkNote ? `<p>${escapeHtml(form.checkNote)}</p>` : ""}
          <div class="data-sources-form-actions">
            <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-check-result" ${form.busy ? "disabled" : ""}>${form.busy ? "Checking..." : "Check result"}</button>
            <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Close without checking</button>
          </div>
        </div>` : `
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="submit" ${form.busy ? "disabled" : ""}>${form.busy ? "Saving..." : create ? "Create variable" : "Save new version"}</button>
          <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Cancel</button>
        </div>`}
    </form>
  `;
}

// ---------------------------------------------------------------------------
// The R2 forms: a new name, an archive, a restore (J3b.2)
// ---------------------------------------------------------------------------
function unconfirmedHtml(form) {
  return `
    <div class="metric-variables-unconfirmed" role="alert">
      <p><strong>Result not confirmed.</strong> No confirmation arrived, so it is not known whether it was saved. Check result sends the same request again: it is never saved twice.</p>
      ${form.checkNote ? `<p>${escapeHtml(form.checkNote)}</p>` : ""}
      <div class="data-sources-form-actions">
        <button class="plain-button data-sources-primary" type="button" data-action="metric-variables-check-result" ${form.busy ? "disabled" : ""}>${form.busy ? "Checking..." : "Check result"}</button>
        <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Close without checking</button>
      </div>
    </div>`;
}

const CHANGE_TITLE = { rename: "Rename", archive: "Archive", restore: "Restore" };
const CHANGE_SUBMIT = { rename: ["Save names", "Saving..."], archive: ["Archive variable", "Archiving..."], restore: ["Restore variable", "Restoring..."] };

// One name of a rename. A locked name (one the form cannot show exactly as
// saved: cut by the read, or on several lines) is read only and is never sent
// until the coach chooses to replace it; a name someone else changed meanwhile
// (a 409 variable_changed) says so.
const NAME_NOUN = { label: "name", shortLabel: "short name", description: "description" };
const LOCK_WHY = {
  cut: (noun, max) => `The saved ${noun} may be longer than the ${max} characters shown here. It stays as it is unless you replace it.`,
  lines: (noun) => `The saved ${noun} is on several lines. It stays as it is unless you replace it with one line.`,
  spaces: (noun) => `The saved ${noun} has spacing the form cannot keep (such as two spaces in a row). It stays as it is unless you replace it.`,
};
const REPLACE_NOTE = {
  cut: (noun, max) => `This field holds only the first ${max} characters; if the saved ${noun} is longer, the rest is not in it. Saving replaces the whole saved ${noun}, any hidden part too, with what you type here.`,
  cut_lines: (noun, max) => `This field holds only the first ${max} characters; if the saved ${noun} is longer, the rest is not in it, and its lines are joined into one here. Saving replaces the whole saved ${noun}, any hidden part too, with what you type here.`,
  lines: (noun) => `The lines are joined into one here. Saving replaces the whole saved ${noun} with what you type here.`,
  spaces: (noun) => `The spacing is tidied here. Saving replaces the whole saved ${noun} with what you type here.`,
};
function nameField(form, field, label, { max, required = false, hint = "", wide = false }) {
  const noun = NAME_NOUN[field];
  const conflict = form.conflict?.[field];
  const conflictText = !conflict ? ""
    : conflict.same ? "Saved now: the same as your text."
    : conflict.edited ? `Saved now: ${conflict.now ? `"${conflict.now}"` : "empty"}. Your text replaces it when you save.`
    : "Changed meanwhile: this is the saved value now.";
  const lock = form.locked?.[field];
  if (lock) {
    const off = form.busy || form.unconfirmed;
    return `
      <div class="search-field metric-variables-locked${wide ? " metric-variables-wide" : ""}" role="group" aria-labelledby="mv-label-${field}">
        <span id="mv-label-${field}">${escapeHtml(label)}${required ? "" : ` <span class="muted">(optional)</span>`}</span>
        <p class="metric-variables-locked-text" id="mv-locked-${field}">${escapeHtml(form.original[field])}${lock === "cut" ? "…" : ""}</p>
        ${conflictText ? `<span class="metric-variables-field-note">${escapeHtml(conflictText)}</span>` : ""}
        <span class="metric-variables-field-note" id="mv-why-${field}">${escapeHtml(LOCK_WHY[lock](noun, max))}</span>
        <button class="plain-button ghost" type="button" data-action="metric-variables-name-replace" data-mv-name="${field}" aria-describedby="mv-why-${field}" ${off ? "disabled" : ""}>Replace ${noun}</button>
      </div>`;
  }
  const replacing = form.replacing?.[field] ? REPLACE_NOTE[form.replacing[field]](noun, max) : "";
  return textInput(form, field, label, { max, required, hint, wide, note: [conflictText, replacing].filter(Boolean).join(" ") });
}
// What the archive form promises about a later restore (Q8): a coach may undo
// only a coach's archive, and the archive's basis is the strongest role the
// user holds (J3b.3). Unknown roles: both cases are said.
function restorePromise(ctx) {
  if (ctx.view !== "coach" || ctx.basis === "club_admin" || ctx.basis === "platform_admin") return "Only an administrator can restore it later; a coach cannot.";
  if (ctx.basis === "team_coach") return "A coach of this club's teams or an administrator can restore it later.";
  return "Archived by a coach, it can be restored by a coach of this club's teams or an administrator; archived by an administrator of the club, only by an administrator.";
}

function renderChangeFormHtml(form, ctx) {
  const coach = ctx.view === "coach";
  const [submitLabel, busyLabel] = CHANGE_SUBMIT[form.mode];
  let body = "";
  // Who a change reaches: every team of the club, or every club for a system variable.
  const reach = ctx.owner === "system" ? "every club" : "every team of the club";
  if (form.mode === "rename") {
    body = `
      <p class="muted">Only the names change, for ${reach}. The key, how the variable is measured and every recorded value stay as they are. Dashboards and lists show the new name.</p>
      ${form.conflict ? `<p class="metric-variables-conflict" role="alert" tabindex="-1">Someone changed this variable while you were editing, so nothing was saved. The changes you made are kept; every other name below is the one saved now. Check them and save again.</p>` : ""}
      <fieldset class="metric-variables-fieldset"><legend>Names</legend><div class="metric-variables-grid">
        ${nameField(form, "label", "Name", { max: LIMITS.label, required: true })}
        ${nameField(form, "shortLabel", "Short name", { max: LIMITS.shortLabel, hint: "Shown where space is short. Leave it empty to remove it." })}
        ${nameField(form, "description", "Description", { max: LIMITS.description, hint: "Leave it empty to remove it.", wide: true })}
      </div></fieldset>`;
  } else if (form.mode === "archive") {
    body = `
      <p class="metric-variables-field-note">Archiving affects ${reach}: until it is restored, no new values can be entered for it and it cannot be added to a dashboard. Values already recorded, its history and the dashboards that already show it stay as they are.${coach ? "" : " It also gets no new version, and no new mapping can use it."}</p>
      <p class="muted">${restorePromise(ctx)}</p>
      ${textInput(form, "reason", "Reason", { max: LIMITS.reason, required: true, hint: "Saved with the change, for example: replaced by the drill variable." })}`;
  } else {
    body = `
      <p class="metric-variables-field-note">The variable becomes active again for ${reach}: new values can be entered for it and it can be added to dashboards.${coach ? "" : " It can get new versions and be used by mappings again."}</p>
      ${textInput(form, "reason", "Reason", { max: LIMITS.reason })}`;
  }
  return `
    <form class="data-sources-form metric-variables-form" data-metric-variables-form="${form.mode}" novalidate autocomplete="off">
      <h2 id="metric-variables-title">${CHANGE_TITLE[form.mode]} ${escapeHtml(form.variableLabel)}</h2>
      <p class="muted">Do not enter athlete names, ids, dates of birth or measured values.</p>
      ${body}
      ${form.error ? `<p class="error" role="alert">${escapeHtml(form.error)}</p>` : ""}
      ${form.unconfirmed ? unconfirmedHtml(form) : `
        <div class="data-sources-form-actions">
          <button class="plain-button data-sources-primary" type="submit" ${form.busy ? "disabled" : ""}>${form.busy ? busyLabel : submitLabel}</button>
          <button class="plain-button ghost" type="button" data-action="metric-variables-cancel" ${form.busy ? "disabled" : ""}>Cancel</button>
        </div>`}
    </form>
  `;
}
