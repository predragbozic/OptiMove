// The view of Map by drag and drop (J18; contract section 3). Template
// strings only: every name from the source or from another person is escaped
// and cleaned. Built from the om-* components Imports uses (page header,
// tabs, light cards, badges, buttons); the phone sheet is the roster's.
import { escapeAttr, escapeHtml } from "./utils.js";
import {
  BOARD_ERROR, COLUMN_REASON, MAX_ROWS, boardContext, boardErrorText, boardState, cleanName, columnOf, columnUse, conversionWords, newRows, placementRefusal,
  preplacedRows, slotOf, variableOf,
} from "./metric-board-data.js";
import { sourceFieldDragAvailable } from "./metric-board-drag.js";

export const isPhone = () => Boolean(globalThis.matchMedia?.("(max-width: 760px)").matches);
const name = (value) => escapeHtml(cleanName(value));

const dateTime = (value) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dateOnly = (value) => dateTime(value).slice(0, 10);
const teamOf = (s) => s.teams.items.find((t) => t.teamId === s.teamId) || null;
const teamName = (s) => cleanName(s.board?.team?.name || teamOf(s)?.name || "this team");
const withUnit = (value, unit) => (value === null || value === undefined ? "No value" : `${escapeHtml(value)}${unit ? ` ${escapeHtml(unit)}` : ""}`);
const busy = (s) => Boolean(s.write) || s.loading;

const REQUIRED_HELP = "Required: if a session has no value here, OptiMove imports the rest and shows 'Required value missing' in the review.";
const OPTIONAL_HELP = "Optional: if a session has no value here, it is simply left out.";

// ---------------------------------------------------------------------------
// The frame: header, Which team?, tabs
// ---------------------------------------------------------------------------
function header(s) {
  const team = s.teamId ? teamOf(s) : null;
  return `
    <button class="plain-button ghost metric-variables-back" type="button" data-action="training-load-section" data-section="variables" data-dc-home>← Data configuration</button>
    <header class="om-page-header mb-header">
      <div>
        <p class="om-eyebrow">Data configuration</p>
        <h2 class="om-page-header__title" id="metric-board-title" tabindex="-1">Map by drag and drop</h2>
        <p class="muted mb-lead">After a search you see what GPEXE sent. ${sourceFieldDragAvailable() && !isPhone() ? "Drag a column onto your variable." : "Tap a column, then your variable."} OptiMove proposes the conversion and shows two athletes. Compare them with the GPEXE screen and confirm. That confirmation is the evidence.</p>
      </div>
      ${team ? `<div class="om-page-header__actions"><span class="om-badge om-badge--accent">${name(team.name)} — linked to GPEXE team ${escapeHtml(team.sourceTeamId)}</span>
        ${s.teams.items.length > 1 ? `<button type="button" class="om-btn om-btn--ghost" data-action="metric-board-change-team" ${s.write ? "disabled" : ""}>Change team</button>` : ""}</div>` : ""}
    </header>`;
}

function whichTeam(s) {
  if (s.teams.loading || !s.teams.loaded) return `<p class="muted" role="status">Loading the club's teams...</p>`;
  if (s.teams.error?.code === "notFound") return `<div class="om-empty" role="status"><p class="om-empty__title">${BOARD_ERROR.notFound}</p></div>`;
  if (s.teams.error) return `<div class="om-empty" role="status"><p class="om-empty__title">The teams could not be read.</p><div class="om-empty__actions"><button type="button" class="om-btn" data-action="metric-board-reload">Try again</button></div></div>`;
  if (s.teams.items.length === 0) {
    return `<div class="om-empty" role="status"><p class="om-empty__title">No team of your club is linked to GPEXE yet.</p><p class="om-empty__text">Link one in Settings &gt; Source connections.</p></div>`;
  }
  return `
    <section class="om-card" aria-labelledby="mb-which-team">
      <div class="om-card__header"><h3 class="om-card__title" id="mb-which-team">Which team?</h3></div>
      <ul class="mb-team-list">
        ${s.teams.items.map((t) => `<li><button type="button" class="om-btn mb-team" data-action="metric-board-team" data-team-id="${escapeAttr(t.teamId)}">${name(t.name)} — linked to GPEXE team ${escapeHtml(t.sourceTeamId)}</button></li>`).join("")}
      </ul>
    </section>`;
}

function tabs(s) {
  const tab = (id, label) => `<button type="button" class="om-tab ${s.tab === id ? "is-active" : ""}" ${s.tab === id ? 'aria-current="page"' : ""} data-action="metric-board-tab" data-board-tab="${id}" ${s.write ? "disabled" : ""}>${label}</button>`;
  return `<nav class="om-tabs mb-tabs" aria-label="Map by drag and drop">${tab("map", "Map")}${tab("history", "History")}</nav>`;
}

// ---------------------------------------------------------------------------
// The board: columns on the left, variables on the right
// ---------------------------------------------------------------------------
function columnHtml(s, c, drag) {
  const board = s.board;
  const use = columnUse(s, c.fieldId);
  const unitLine = c.unitProven ? `GPEXE sends values in ${escapeHtml(c.unit)}` : c.expectedUnit ? `Expected ${escapeHtml(c.expectedUnit)}, not confirmed` : "Unit not confirmed";
  const values = c.rawA !== null || c.rawB !== null
    ? `<span class="mb-col-vals" aria-label="${escapeAttr(`${cleanName(board.pair.labels[0])}: ${c.rawA ?? "no value"}; ${cleanName(board.pair.labels[1])}: ${c.rawB ?? "no value"}`)}">${withUnit(c.rawA, c.unitProven ? c.unit : "")}<br>${withUnit(c.rawB, c.unitProven ? c.unit : "")}</span>` : "";
  const tech = `<details class="mb-tech"><summary>Technical details</summary><code>${escapeHtml(c.key)}</code></details>`;
  const main = `<span class="mb-col-main"><strong>${name(c.label)}</strong><small>${unitLine}</small></span>`;
  if (!c.placeable && !use) {
    return `<li class="mb-col-item"><div class="mb-col is-off"><span class="mb-col-main"><strong>${name(c.label)}</strong><small>${unitLine}</small><small class="mb-reason">${escapeHtml(COLUMN_REASON[c.reason] || "This column cannot be placed.")}</small></span>${values}</div>${tech}</li>`;
  }
  if (use) {
    const badge = use === "on" ? `<span class="om-badge om-badge--success">On</span>` : use === "new" ? `<span class="om-badge om-badge--accent">Placed</span>` : `<span class="om-badge om-badge--info">Placed</span>`;
    const why = use === "on" ? "Already on for the team. Switch it off on the right to place it again." : "Placed. Remove it on the right to place it elsewhere.";
    const usedMain = `<span class="mb-col-main"><strong>${name(c.label)}</strong><small>${unitLine}</small><small>${why}</small></span>`;
    return `<li class="mb-col-item"><div class="mb-col is-used">${usedMain}${badge}${values}</div>${tech}</li>`;
  }
  const picked = s.picked === c.fieldId;
  return `<li class="mb-col-item">
    <button type="button" class="mb-col ${picked ? "is-picked" : ""}" data-action="metric-board-pick" data-field-id="${escapeAttr(c.fieldId)}" aria-pressed="${picked}"
      aria-label="${escapeAttr(`${cleanName(c.label)}, ${c.unit}, choose a variable for it`)}" ${busy(s) ? "disabled" : ""} ${drag ? `draggable="true" data-mb-drag-field` : ""}>
      ${drag ? `<span class="mb-grip" aria-hidden="true">⋮⋮</span>` : ""}${main}${values}
    </button>${tech}</li>`;
}

function slotHtml(s, v, drag) {
  const board = s.board;
  const slot = slotOf(s, v);
  const unit = v.unit ? `<span class="om-badge mb-unit">${escapeHtml(v.unit)}</span>` : "";
  const head = (sub) => `<span class="mb-slot-main"><strong>${name(v.label)}</strong><small>${sub}</small></span>`;
  const col = slot.column ? name(slot.column.label) : "a column";
  const off = busy(s) ? "disabled" : "";
  if (slot.kind === "on") {
    return `<li class="mb-slot is-on">${head(`From ${col}`)}${unit}<span class="om-badge om-badge--success">On for ${name(teamName(s))}</span>
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-switch-off-open" data-activation-id="${escapeAttr(slot.on.activationId)}" ${off}>Switch off</button></li>`;
  }
  if (slot.kind === "new") {
    const p = slot.placed;
    const state_ = p.placement?.placeable !== true ? `<span class="om-badge om-badge--warning">Cannot be saved</span>`
      : p.checked ? `<span class="om-badge om-badge--success">Compared</span>` : `<span class="om-badge om-badge--warning">${p.again ? "Compare again" : "Not compared yet"}</span>`;
    return `<li class="mb-slot is-new">${head(`From ${col} · not saved yet`)}${unit}${state_}
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-compare" data-field-id="${escapeAttr(p.fieldId)}" ${off}>${p.checked ? "View check" : "Compare"}</button>
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-remove" data-field-id="${escapeAttr(p.fieldId)}" ${off}>Remove</button></li>`;
  }
  if (slot.kind === "preplaced") {
    const badge = slot.pre.badge === "club_mapping" ? "Your club's mapping" : "OptiMove mapping";
    const replaces = slot.pre.replaces?.length ? " · replaces what is on" : "";
    return `<li class="mb-slot is-pre">${head(`From ${col} · no check needed${replaces}`)}${unit}<span class="om-badge om-badge--info">${badge}</span>
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-pre-remove" data-version-id="${escapeAttr(slot.pre.mappingVersionId)}" ${off}>Remove</button></li>`;
  }
  if (slot.kind === "removed" || slot.kind === "replaceable") {
    const badge = slot.pre.badge === "club_mapping" ? "Your club's mapping" : "OptiMove mapping";
    const sub = slot.kind === "removed" ? `From ${col} · removed from this save` : `From ${col} · would replace what is on for ${name(teamName(s))}`;
    return `<li class="mb-slot is-idle">${head(sub)}${unit}<span class="om-badge">${badge}</span>
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-pre-add" data-version-id="${escapeAttr(slot.pre.mappingVersionId)}" ${off}>Add</button></li>`;
  }
  if (slot.kind === "switchedOff") {
    return `<li class="mb-slot is-idle">${head(`Switched off by ${name(slot.off.endedBy || "an administrator")} on ${escapeHtml(dateOnly(slot.off.endedAt))}`)}${unit}
      <button type="button" class="om-btn om-btn--ghost mb-slot-act" data-action="metric-board-off-add" data-version-id="${escapeAttr(slot.off.mappingVersionId)}" ${off}>Add</button></li>`;
  }
  // Empty.
  if (!v.placeable) {
    const why = v.ownerScope === "system" ? "OptiMove does not fill this variable from a column of this session." : "A column cannot fill this variable.";
    return `<li class="mb-slot is-off">${head(why)}${unit}</li>`;
  }
  const picked = s.picked ? columnOf(board, s.picked) : null;
  const sub = picked ? `Fill from ${name(picked.label)}` : drag ? "Empty · drag a column here" : "Empty · choose a column for it";
  // On a phone a column is chosen first and its variable in the sheet: the empty slot is not a control there.
  if (isPhone()) return `<li class="mb-slot is-empty"><div class="mb-slot-open">${head(sub)}${unit}</div></li>`;
  return `<li class="mb-slot is-empty ${picked ? "is-target" : ""}" ${drag ? `data-mb-drop-variable data-variable-id="${escapeAttr(v.id)}"` : ""}>
    <button type="button" class="mb-slot-open" data-action="metric-board-place" data-variable-id="${escapeAttr(v.id)}" ${picked && !busy(s) ? "" : 'aria-disabled="true"'}
      aria-label="${escapeAttr(`${cleanName(v.label)}, ${v.unit || "no unit"}${picked ? `, fill from ${cleanName(picked.label)}` : ", empty"}`)}">${head(sub)}${unit}</button></li>`;
}

function boardCards(s) {
  const board = s.board;
  const drag = sourceFieldDragAvailable() && !isPhone();
  const club = board.variables.filter((v) => v.ownerScope === "club");
  const system = board.variables.filter((v) => v.ownerScope === "system");
  const list = (items) => items.map((v) => slotHtml(s, v, drag)).join("");
  return `
    <div class="mb-cols">
      <section class="om-card mb-card" aria-labelledby="mb-columns-title">
        <div class="om-card__header"><h3 class="om-card__title" id="mb-columns-title">GPEXE columns</h3></div>
        <p class="muted mb-note">From the session of ${escapeHtml(dateTime(board.session.startedAt))}. ${drag ? "Drag a column, or tap it and then tap a variable." : "Tap a column, then a variable."}</p>
        <p class="mb-pair">Showing <strong>${name(board.pair.labels[0])}</strong> and <span><strong>${name(board.pair.labels[1])}</strong>.</span>
          ${board.pair.count > 1 ? `<button type="button" class="om-btn om-btn--ghost" data-action="metric-board-other-athletes" ${busy(s) ? "disabled" : ""}>Other athletes</button>` : ""}</p>
        <ul class="mb-list">${board.columns.map((c) => columnHtml(s, c, drag)).join("")}</ul>
      </section>
      <section class="om-card mb-card" aria-labelledby="mb-variables-title">
        <div class="om-card__header"><h3 class="om-card__title" id="mb-variables-title">Variables</h3></div>
        <p class="muted mb-note">OptiMove's variables are here at once. Your club can add its own.</p>
        ${club.length ? `<p class="om-eyebrow">Your club's variables</p><ul class="mb-list">${list(club)}</ul>` : `<p class="muted">Your club has no variable of its own yet. Create one in Variables.</p>`}
        ${system.length ? `<p class="om-eyebrow">OptiMove's variables</p><ul class="mb-list">${list(system)}</ul>` : ""}
      </section>
    </div>`;
}

// ---------------------------------------------------------------------------
// The panel: the conversion and two athletes
// ---------------------------------------------------------------------------
function athletesHtml(s, p, column) {
  const [a, b] = s.board.pair.labels;
  const unit = p.displayUnits[0];
  const rows = [[a, p.values.a, p.display[unit].a], [b, p.values.b, p.display[unit].b]];
  const shown = (v) => (unit === "mm:ss" ? escapeHtml(v) : `${escapeHtml(v)} ${escapeHtml(unit)}`);
  if (isPhone()) {
    return `<div class="mb-athletes">${rows.map(([label, v, d]) => `
      <div class="mb-athlete"><strong>${name(label)}</strong>
        <span><small>GPEXE sends</small>${withUnit(v.raw, p.sourceUnit)}</span>
        <span><small>OptiMove stores</small><b>${withUnit(v.stored, p.targetUnit)}</b></span>
        <span><small>The GPEXE screen should show</small><b>${shown(d)}</b></span></div>`).join("")}</div>`;
  }
  return `<div class="mb-tablewrap"><table class="mb-table" aria-label="${escapeAttr(`Two athletes, ${cleanName(column.label)}`)}">
    <thead><tr><th scope="col">Athlete</th><th scope="col">GPEXE sends</th><th scope="col">OptiMove stores</th><th scope="col">The GPEXE screen should show</th></tr></thead>
    <tbody>${rows.map(([label, v, d]) => `<tr><th scope="row">${name(label)}</th><td>${withUnit(v.raw, p.sourceUnit)}</td><td class="mb-big">${withUnit(v.stored, p.targetUnit)}</td><td class="mb-big">${shown(d)}</td></tr>`).join("")}</tbody>
  </table></div>`;
}

function panelBody(s) {
  const panel = s.panel;
  const column = columnOf(s.board, panel.fieldId);
  const variable = variableOf(s.board, panel.targetId);
  const title = `<h3 class="om-card__title" id="mb-panel-title" tabindex="-1">${name(column?.label)} → ${name(variable?.label)}</h3>`;
  if (panel.loading) return `${title}<p class="muted" role="status">Reading two athletes...</p>`;
  if (panel.error) {
    return `${title}<p class="mb-refusal" role="alert">${escapeHtml(boardErrorText(panel.error))}</p>
      <div class="om-card__actions"><button type="button" class="om-btn" data-action="metric-board-cancel">Back</button></div>`;
  }
  const p = panel.placement;
  if (p.placeable !== true) {
    return `${title}<p class="mb-refusal" role="alert">${escapeHtml(placementRefusal(p, { column, variable }))}</p>
      <details class="mb-tech"><summary>Technical details</summary><code>${escapeHtml(p.code || "")}</code></details>
      <div class="om-card__actions"><button type="button" class="om-btn" data-action="metric-board-cancel">Back</button></div>`;
  }
  const placed = s.placements[panel.fieldId] || {};
  const session = dateTime(s.board.session.startedAt);
  return `${title}
    <p>Proposed conversion: <span class="mb-conv">${escapeHtml(conversionWords(p.conversion, p.sourceUnit, p.targetUnit))}</span></p>
    ${p.collisions?.length ? `<p class="mb-replaces">Saving this replaces what is on for ${name(teamName(s))} now: ${p.collisions.map((c) => `${name(columnOf(s.board, c.fieldId)?.label)} → ${name(variableOf(s.board, c.variableId)?.label)}`).join(", ")}.</p>` : ""}
    ${athletesHtml(s, p, column)}
    <div class="mb-help"><strong>What to watch for</strong><ul>
      <li>Open the same session in GPEXE (${escapeHtml(session)}) and find these two athletes.</li>
      <li>Compare the last column with what GPEXE shows. Seconds may differ by one. Distance and speed may differ in the last digit.</li>
      <li>If it does not match, do not tick it. Remove it, or choose another column or another variable.</li></ul></div>
    <label class="mb-check"><input type="checkbox" data-mb-tick ${placed.checked ? "checked" : ""}><span>Matches GPEXE for both athletes</span></label>
    <label class="mb-check"><input type="checkbox" data-mb-required data-field-id="${escapeAttr(panel.fieldId)}" ${placed.requirement !== "optional" ? "checked" : ""}><span>Required<small>${REQUIRED_HELP} ${OPTIONAL_HELP}</small></span></label>
    <div class="om-card__actions">
      <button type="button" class="om-btn om-btn--primary" data-action="metric-board-keep">Keep this placement</button>
      <button type="button" class="om-btn om-btn--ghost" data-action="metric-board-cancel">Cancel</button>
    </div>`;
}

function panelHtml(s) {
  if (!s.panel) {
    if (isPhone()) return "";
    return `<section class="om-card mb-panel is-empty"><h3 class="om-card__title">${sourceFieldDragAvailable() ? "Drag a column onto a variable" : "Tap a column, then a variable"}</h3><p class="muted">The check for two athletes appears here.</p></section>`;
  }
  if (isPhone()) return sheet("mb-panel-title", panelBody(s), "metric-board-dismiss");
  return `<section class="om-card mb-panel" aria-labelledby="mb-panel-title">${panelBody(s)}</section>`;
}

// The one bottom sheet of a phone (the roster's pattern: a backdrop, a dialog, the page behind does not scroll).
// `labelledBy` and `cancelAction` are this file's own constants; `body` is HTML already escaped by its builder.
function sheet(labelledBy, body, cancelAction) {
  return `<div class="mb-sheet-backdrop" data-action="${cancelAction}"></div>
    <section class="mb-sheet" role="dialog" aria-modal="true" aria-labelledby="${labelledBy}">${body}</section>`;
}

// On a phone, tapping a column opens "Fill which variable?".
function targetsSheet(s) {
  const column = columnOf(s.board, s.picked);
  if (!column) return "";
  const usable = s.board.variables.filter((v) => v.placeable && slotOf(s, v).kind === "empty");
  const same = usable.filter((v) => v.unit === column.unit);
  const other = usable.filter((v) => v.unit !== column.unit);
  const item = (v, note) => `<li><button type="button" class="om-btn mb-target" data-action="metric-board-place" data-variable-id="${escapeAttr(v.id)}">${name(v.label)}<small>${escapeHtml(note)}</small></button></li>`;
  const body = `<h3 class="om-card__title" id="mb-targets-title" tabindex="-1">Fill which variable?</h3>
    <p class="muted">${name(column.label)} · GPEXE sends values in ${escapeHtml(column.unit)}</p>
    ${usable.length === 0 ? `<p class="muted">No variable is free for this column. Create one in Variables.</p>` : `<ul class="mb-list">
      ${same.map((v) => item(v, `Same unit · ${v.unit}`)).join("")}${other.map((v) => item(v, `Converted from ${column.unit} · ${v.unit || "no unit"}`)).join("")}</ul>`}
    <div class="om-card__actions"><button type="button" class="om-btn om-btn--ghost" data-action="metric-board-unpick">Back</button></div>`;
  return sheet("mb-targets-title", body, "metric-board-unpick");
}

// ---------------------------------------------------------------------------
// Saving: the board's one button, the review card, the outcome
// ---------------------------------------------------------------------------
function rowsCount(s) { return newRows(s).length + preplacedRows(s).length; }

function saveBar(s) {
  const count = rowsCount(s);
  const label = `Save and switch on for ${name(teamName(s))}`;
  return `<div class="mb-savebar ${count === 0 ? "is-idle" : ""}">
    <button type="button" class="om-btn om-btn--primary" data-action="metric-board-review" ${count > 0 && count <= MAX_ROWS && !busy(s) ? "" : "disabled"} aria-describedby="mb-savebar-note">${label}</button>
    <span class="muted" id="mb-savebar-note">${count === 0 ? "Place a column first." : count > MAX_ROWS ? `A save holds at most ${MAX_ROWS} rows. Remove ${count - MAX_ROWS} first.` : `${count} ${count === 1 ? "row" : "rows"} to switch on.`}</span>
  </div>`;
}

function reviewBody(s) {
  const fresh = newRows(s);
  const pre = preplacedRows(s);
  const unticked = fresh.filter((p) => !p.checked);
  const team = teamOf(s);
  const unit = (p) => p.placement.displayUnits[0];
  const shown = (p, v) => (unit(p) === "mm:ss" ? escapeHtml(v) : `${escapeHtml(v)} ${escapeHtml(unit(p))}`);
  const [a, b] = s.board.pair.labels;
  const freshHtml = fresh.map((p) => {
    const c = columnOf(s.board, p.fieldId);
    const v = variableOf(s.board, p.targetId);
    const pl = p.placement;
    const line = (label, val, d) => `<li>${name(label)}: GPEXE sends ${withUnit(val.raw, pl.sourceUnit)} · OptiMove stores ${withUnit(val.stored, pl.targetUnit)} · the GPEXE screen should show ${shown(p, d)}</li>`;
    return `<li class="mb-review-row"><strong>${name(c?.label)} → ${name(v?.label)}</strong>
      <span class="om-badge ${p.checked ? "om-badge--success" : "om-badge--warning"}">${p.checked ? "Compared" : "Not compared yet"}</span>
      <small>${escapeHtml(conversionWords(pl.conversion, pl.sourceUnit, pl.targetUnit))} · ${p.requirement === "optional" ? "Optional" : "Required"}</small>
      <ul class="mb-review-values">${line(a, pl.values.a, pl.display[unit(p)].a)}${line(b, pl.values.b, pl.display[unit(p)].b)}</ul>
      ${pl.collisions?.length ? `<small>Replaces what is on now: ${pl.collisions.map((x) => `${name(columnOf(s.board, x.fieldId)?.label)} → ${name(variableOf(s.board, x.variableId)?.label)}`).join(", ")}.</small>` : ""}
      ${p.checked ? "" : `<button type="button" class="om-btn om-btn--ghost" data-action="metric-board-compare" data-field-id="${escapeAttr(p.fieldId)}">Compare</button>`}</li>`;
  }).join("");
  const group = (label, rows) => (rows.length ? `<p class="om-eyebrow">${label}</p><ul class="mb-review-list">${rows.map((p) => `<li class="mb-review-row"><strong>${name(columnOf(s.board, p.fieldId)?.label)} → ${name(variableOf(s.board, p.variableId)?.label)}</strong>
      <small>${p.requirement === "optional" ? "Optional" : "Required"}${p.replaces.length ? " · replaces what is on now" : ""}</small></li>`).join("")}</ul>` : "");
  const send = `<button type="button" class="om-btn om-btn--primary" data-action="metric-board-save" ${unticked.length === 0 && !s.write ? "" : "disabled"} aria-describedby="mb-review-note">Save and switch on for ${name(teamName(s))}</button>`;
  // One new row and nothing else: the panel's own summary and the send, not a second form.
  const single = fresh.length === 1 && pre.length === 0;
  return `<h3 class="om-card__title" id="mb-review-title" tabindex="-1">${single ? "Switch this on?" : "Review before saving"}</h3>
    <p class="muted">GPEXE · ${name(team?.name || teamName(s))} — linked to GPEXE team ${escapeHtml(team?.sourceTeamId || s.board.team.sourceTeamId)}</p>
    ${fresh.length ? `${single ? "" : `<p class="om-eyebrow">New columns</p>`}<ul class="mb-review-list">${freshHtml}</ul>` : ""}
    ${group("OptiMove mappings (no check needed)", pre.filter((p) => p.badge !== "club_mapping"))}
    ${group("Your club's mappings (no check needed)", pre.filter((p) => p.badge === "club_mapping"))}
    <p class="muted" id="mb-review-note">${unticked.length ? `Tick every new column to save: ${unticked.map((p) => name(columnOf(s.board, p.fieldId)?.label)).join(", ")}.`
    : "Saved with it: who confirmed, when, and the two athletes' values of the columns you checked. That is the evidence. The values are kept for 90 days, then removed."}</p>
    ${s.write?.kind === "save" ? writeHtml(s) : ""}
    <div class="om-card__actions">${send}<button type="button" class="om-btn om-btn--ghost" data-action="metric-board-review-close" ${s.write ? "disabled" : ""}>Back</button></div>`;
}
function reviewHtml(s) {
  if (!s.review) return "";
  if (isPhone()) return sheet("mb-review-title", reviewBody(s), "metric-board-review-close");
  return `<section class="om-card mb-panel mb-review" aria-labelledby="mb-review-title">${reviewBody(s)}</section>`;
}

function writeHtml(s) {
  const w = s.write;
  if (!w) return "";
  if (w.unconfirmed) {
    return `<div class="mb-notice is-warning" role="alert" id="mb-outcome" tabindex="-1"><p><strong>Result not confirmed.</strong> OptiMove did not get an answer. Check result sends the same request again: it is never saved twice.</p>
      ${w.note ? `<p>${escapeHtml(w.note)}</p>` : ""}
      <div class="om-card__actions"><button type="button" class="om-btn om-btn--primary" data-action="metric-board-check-result" ${w.sending ? "disabled" : ""}>Check result</button></div></div>`;
  }
  return `<p class="mb-notice" role="status">${w.kind === "switch-off" ? "Switching off..." : "Saving..."}</p>`;
}

function savedHtml(s) {
  const saved = s.saved;
  if (!saved) return "";
  const list = (rows) => rows.map((r) => `${name(r.column)} → ${name(r.variable)}`).join(", ");
  const free = s.board.columns.some((c) => c.placeable && !columnUse(s, c.fieldId));
  return `<div class="mb-notice is-success" role="status" id="mb-outcome" tabindex="-1"><p><strong>Saved.</strong> Switched on for ${name(saved.team)}: ${list(saved.rows)}.
    ${saved.checked.length ? `Checked by you on ${escapeHtml(dateOnly(saved.at))} with two athletes: ${saved.checked.map((r) => name(r.column)).join(", ")}.` : ""}
    ${saved.plain.length ? `Mappings with no check needed: ${saved.plain.map((r) => name(r.column)).join(", ")}.` : ""}</p>
    <p>To use them, run <button type="button" class="om-btn om-btn--ghost mb-inline" data-action="training-load-section" data-section="imports">Find new sessions</button> in Imports again, with dates that include ${escapeHtml(dateOnly(saved.sessionAt))}. Sessions found from then on can be imported with these variables.${free ? ` ${sourceFieldDragAvailable() && !isPhone() ? "Drag" : "Choose"} the next column.` : ""}</p></div>`;
}

function switchOffHtml(s) {
  const x = s.switchOff;
  if (!x) return "";
  const team = teamOf(s);
  const body = `<p id="mb-switch-off-title" tabindex="-1"><strong>Switch off ${name(x.label)} for ${name(teamName(s))}${team ? ` — linked to GPEXE team ${escapeHtml(team.sourceTeamId)}` : ""}?</strong> Sessions found from then on are imported without it.</p>
    ${s.write?.kind === "switch-off" ? writeHtml(s) : ""}
    <div class="om-card__actions"><button type="button" class="om-btn om-btn--danger" data-action="metric-board-switch-off" ${s.write ? "disabled" : ""}>Switch off</button>
      <button type="button" class="om-btn om-btn--ghost" data-action="metric-board-switch-off-cancel" ${s.write ? "disabled" : ""}>Keep it on</button></div>`;
  if (isPhone()) return sheet("mb-switch-off-title", body, "metric-board-dismiss");
  return `<div class="mb-notice is-warning" role="group" aria-labelledby="mb-switch-off-title">${body}</div>`;
}

function mapTab(s) {
  if (s.loading && !s.board) return `<p class="muted" role="status">Reading the saved session...</p>`;
  if (s.error) {
    const linkAthletes = s.error.code === "not_enough_athletes";
    const search = ["candidate_too_large", "board_too_large", "no_stored_session", "snapshot_expired", "candidate_source_mismatch", "candidate_not_importable", "session_start_unknown"].includes(s.error.code);
    return `<div class="om-empty" role="status"><p class="om-empty__title">${escapeHtml(boardErrorText(s.error))}</p>
      <div class="om-empty__actions">
        ${search || linkAthletes ? `<button type="button" class="om-btn om-btn--primary" data-action="training-load-section" data-section="imports">${linkAthletes ? "Open Imports to link athletes" : "Open Imports to search"}</button>` : ""}
        ${s.error.code === "pair_out_of_range" ? `<button type="button" class="om-btn" data-action="metric-board-first-athletes">Back to the first athletes</button>` : `<button type="button" class="om-btn" data-action="metric-board-reload">Try again</button>`}
      </div></div>`;
  }
  if (!s.board) return "";
  const phoneSheet = isPhone() ? (s.switchOff ? switchOffHtml(s) : s.review ? reviewHtml(s) : s.panel ? panelHtml(s) : s.picked ? targetsSheet(s) : "") : "";
  // A write says what it is doing where the admin is: in the review, in the Switch off question, else here.
  const writeHere = s.write && !(s.write.kind === "save" && s.review) && !(s.write.kind === "switch-off" && s.switchOff);
  return `
    ${savedHtml(s)}
    ${s.notice ? `<p class="mb-notice is-warning" role="alert" ${s.saved || s.write ? "" : 'id="mb-outcome" tabindex="-1"'}>${escapeHtml(s.notice)}</p>` : ""}
    ${writeHere ? writeHtml(s) : ""}
    ${isPhone() ? "" : switchOffHtml(s)}
    ${boardCards(s)}
    ${isPhone() ? "" : s.review ? reviewHtml(s) : panelHtml(s)}
    ${s.review && !isPhone() ? "" : saveBar(s)}
    ${phoneSheet}`;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function historyRow(r) {
  const conv = conversionWords(r.conversion, r.sourceUnit, r.targetUnit);
  const values = r.valuesState === "present"
    ? `<ul class="mb-review-values"><li>Athlete A: GPEXE sent ${withUnit(r.values.a.raw, r.sourceUnit)} · OptiMove stored ${withUnit(r.values.a.stored, r.targetUnit)}</li><li>Athlete B: GPEXE sent ${withUnit(r.values.b.raw, r.sourceUnit)} · OptiMove stored ${withUnit(r.values.b.stored, r.targetUnit)}</li></ul>`
    : `<small>${r.valuesState === "expired" ? "Values removed after 90 days" : r.valuesState === "erased" ? "Values erased" : "Not compared"}</small>`;
  return `<li class="mb-review-row"><strong>${name(r.column?.label)} → ${name(r.variable?.label)}</strong>
    <span class="om-badge ${r.checked ? "om-badge--success" : "om-badge--info"}">${r.checked ? "Compared with two athletes" : r.kind === "system_mapping" ? "OptiMove mapping" : "Your club's mapping"}</span>
    <small>${escapeHtml(conv)}</small>${values}</li>`;
}
function historyTab(s) {
  const h = s.history;
  if (h.loading && !h.loaded) return `<p class="muted" role="status">Reading the history...</p>`;
  if (h.error) return `<div class="om-empty" role="status"><p class="om-empty__title">${escapeHtml(boardErrorText(h.error))}</p><div class="om-empty__actions"><button type="button" class="om-btn" data-action="metric-board-history-reload">Try again</button></div></div>`;
  if (h.loaded && h.items.length === 0) return `<div class="om-empty" role="status"><p class="om-empty__title">Nothing was saved from this board yet.</p><p class="om-empty__text">Every save appears here: who confirmed, when, and what was compared.</p></div>`;
  return `<ul class="mb-history">${h.items.map((c) => `
    <li class="om-card"><div class="om-card__header"><h3 class="om-card__title">${escapeHtml(dateTime(c.confirmedAt))} · ${name(c.confirmedBy || "an administrator")}</h3></div>
      <p class="muted">Session of ${escapeHtml(dateTime(c.sessionStartedAt))}</p>
      <ul class="mb-review-list">${c.rows.map(historyRow).join("")}</ul></li>`).join("")}</ul>
    ${h.nextCursor ? `<button type="button" class="om-btn" data-action="metric-board-history-more" ${h.loadingMore ? "disabled" : ""}>Show older</button>` : ""}`;
}

export function renderBoardHtml() {
  const s = boardState();
  if (!boardContext()) return `<section class="mb-screen"><div class="om-empty" role="status"><p class="om-empty__title">${BOARD_ERROR.notFound}</p></div></section>`;
  const sheetOpen = isPhone() && (s.switchOff || s.review || s.panel || s.picked);
  return `<section class="mb-screen ${sheetOpen ? "has-sheet" : ""}" data-mb-board>
    ${header(s)}
    ${!s.teamId ? whichTeam(s) : `${tabs(s)}${s.tab === "history" ? historyTab(s) : mapTab(s)}`}
    <p class="visually-hidden" aria-live="polite" id="mb-live">${escapeHtml(s.live || "")}</p>
  </section>`;
}
