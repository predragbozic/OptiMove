import { builderIconGlyph } from "./builder-helpers.js";
import { renderImage } from "./media.js";
import { renderPastelSwatches } from "./taxonomy-view.js";
import { formatDate, weekDayName, escapeAttr, escapeHtml } from "./utils.js";

export const ICON_CHECK = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 12l5 5L20 6"></path></svg>`;
export const ICON_X = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>`;
// A door frame (open on the right) with an arrow passing through it - the
// standard "log out"/exit glyph, used for the workspace toolbar's Exit
// button instead of a plain X, matching the coach's reference image.
export const ICON_DOOR_EXIT = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><path d="M16 17l5-5-5-5"></path><path d="M21 12H9"></path></svg>`;
const ICON_COPY = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>`;
export const ICON_TRASH = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg>`;
// A clipboard with a page peeking out from behind it - reads as "paste"
// more clearly than a bare page-with-lines, matching the coach's reference
// image. Single shared constant - every paste button in the app uses this
// one icon, so this one change updates all of them at once.
const ICON_PASTE = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><rect x="4" y="5" width="12" height="16" rx="2"></rect><path d="M8 3.5h4a1 1 0 0 1 1 1V6H7V4.5a1 1 0 0 1 1-1Z"></path><path d="M12 10h9v10a1 1 0 0 1-1 1h-8"></path><path d="M15 14h3M15 17h3"></path></svg>`;
const ICON_PENCIL = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z"></path><path d="M13 7l4 4"></path></svg>`;
const ICON_IMPORT = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M12 3v11"></path><path d="M8 10l4 4 4-4"></path><path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path></svg>`;

function renderConfirmIconButton({ type = "submit", action = "", dataAttrs = "", label = "Add" } = {}) {
  return `<button class="plain-button builder-icon-action builder-confirm-icon" type="${type}" ${action ? `data-action="${escapeAttr(action)}"` : ""} ${dataAttrs} aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${ICON_CHECK}</button>`;
}

function renderCancelIconButton({ action, dataAttrs = "", label = "Cancel" }) {
  return `<button class="plain-button builder-icon-action builder-cancel-icon" type="button" data-action="${escapeAttr(action)}" ${dataAttrs} aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${ICON_X}</button>`;
}

export function renderCopyNodeIconButton(nodeId, label) {
  return `<button class="plain-button builder-icon-action builder-copy-icon" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(nodeId)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${ICON_COPY}</button>`;
}

function renderCopyBlockIconButton(blockId) {
  return `<button class="plain-button builder-icon-action builder-copy-icon" type="button" data-action="builder-copy-block" data-block-id="${escapeAttr(blockId)}" aria-label="Copy block" title="Copy block">${ICON_COPY}</button>`;
}

function renderCopyDayIconButton(dayId) {
  return `<button class="plain-button builder-icon-action builder-copy-icon" type="button" data-action="builder-copy-day" data-day-id="${escapeAttr(dayId)}" aria-label="Copy day" title="Copy day">${ICON_COPY}</button>`;
}

// Phase 2: opens the "pick a block from another plan" picker
// (builder-modals.js's renderBlockPickerModal) - once a block is chosen
// there it sets the clipboard the exact same way Copy day does, so the
// SAME renderPasteDayIconButton/builder-paste-day flow below handles it.
// Rendered ONCE at the outline panel's own header (frontend/builder-view.js),
// not per-day - unlike Copy/Paste day, this isn't tied to any one day, so
// showing it 7 times (once per weekly day) would just be 7 identical
// buttons doing the exact same thing.
export function renderImportBlockIconButton() {
  return `<button class="plain-button builder-icon-action builder-copy-icon" type="button" data-action="builder-open-block-picker" aria-label="Copy from another plan" title="Copy from another plan">${ICON_IMPORT}</button>`;
}

// Only rendered on days OTHER than the one currently in the clipboard when
// the clipboard holds a same-plan day (pasting a day onto itself is
// meaningless, and the backend already rejects it) - a cross-plan-block
// clipboard has no such self-collision (its id belongs to a different
// plan entirely), so it shows on every weekly day.
function renderPasteDayIconButton(dayId, context) {
  const clipboard = context.clipboard;
  if (clipboard?.type === "day") {
    if (clipboard.dayId === dayId) return "";
  } else if (clipboard?.type !== "cross-plan-block") {
    return "";
  }
  const title = `Paste "${clipboard.name || "day"}"`;
  return `<button class="plain-button builder-icon-action builder-paste-icon" type="button" data-action="builder-paste-day" data-day-id="${escapeAttr(dayId)}" aria-label="${escapeAttr(title)}" title="${escapeAttr(title)}">${ICON_PASTE}</button>`;
}

export function renderDeleteIconButton(action, dataAttrs, label) {
  return `<button class="plain-button builder-icon-action builder-delete-icon" type="button" data-action="${escapeAttr(action)}" ${dataAttrs} aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">${ICON_TRASH}</button>`;
}

const SESSION_TIME_PICKS = [
  { label: "AM", value: "AM" },
  { label: "PM", value: "PM" },
];
const SESSION_PHASE_PICKS = [
  { label: "Before training", value: "B" },
  { label: "Training", value: "T" },
  { label: "After training", value: "A" },
];

function renderSessionQuickAdd(block, context) {
  const quickAdd = context.sessionQuickAdd || {};
  const isOpen = quickAdd.blockId === block.id;
  if (!isOpen) {
    return `<button class="builder-add-session-trigger" type="button" data-action="builder-toggle-session-quick-add" data-block-id="${escapeAttr(block.id)}" aria-label="Add session"><span aria-hidden="true">+</span></button>`;
  }
  const renderGroup = (picks, field) => picks.map((pick) => {
    const isActive = quickAdd[field] === pick.value;
    return `
      <button class="chip ${isActive ? "is-active" : ""}" type="button" data-action="builder-pick-session-${field === "amPm" ? "am-pm" : "bta"}" data-block-id="${escapeAttr(block.id)}" data-value="${escapeAttr(pick.value)}">
        ${isActive ? `<span class="builder-chip-check" aria-hidden="true">&#10003;</span>` : ""}${escapeHtml(pick.label)}
      </button>
    `;
  }).join("");
  return `
    <div class="builder-session-quick-add">
      <p class="builder-quick-add-title">New session - pick what applies</p>
      <div class="builder-session-quick-add-group">
        <span class="builder-quick-add-label">Time of day</span>
        <div class="builder-session-quick-add-row">${renderGroup(SESSION_TIME_PICKS, "amPm")}</div>
      </div>
      <div class="builder-session-quick-add-group">
        <span class="builder-quick-add-label">Training phase</span>
        <div class="builder-session-quick-add-row">${renderGroup(SESSION_PHASE_PICKS, "bta")}</div>
      </div>
      <div class="builder-session-quick-add-group">
        <span class="builder-quick-add-label">Specific time (optional)</span>
        <input class="builder-text-input builder-quick-add-time" type="time" value="${escapeAttr(quickAdd.time || "")}" data-builder-quick-add-time aria-label="Specific session time (optional)">
      </div>
      <div class="builder-session-quick-add-actions">
        ${renderConfirmIconButton({ type: "button", action: "builder-quick-add-session", dataAttrs: `data-block-id="${escapeAttr(block.id)}"`, label: "Add session" })}
        ${renderCancelIconButton({ action: "builder-toggle-session-quick-add", dataAttrs: `data-block-id="${escapeAttr(block.id)}"`, label: "Cancel" })}
      </div>
    </div>
  `;
}

export function renderBuilderStructureModal(session, selectedNode, context) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-structure-modal" aria-label="Close session parts"></button>
      <section class="panel builder-structure-modal" role="dialog" aria-modal="true" aria-label="Add session parts">
        <div class="builder-modal-head"><div><p class="eyebrow">${escapeHtml(context.sessionLabel(session))}</p><h3>Add session parts</h3><p class="muted">Build a path with Exercise domain, Exercise category, and Exercise section. An Exercise section can also be added directly.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-structure-modal" aria-label="Close"><span class="button-icon">x</span></button></div>
        ${renderBuilderStructureEditor(session, selectedNode, context)}
      </section>
    </div>
  `;
}

const ALL_NODE_TYPES = ["domain", "category", "section"];

function validChildTypes(parentType) {
  if (parentType === "domain") return ["category", "section"];
  if (parentType === "category") return ["section"];
  if (parentType === "section") return [];
  return ALL_NODE_TYPES;
}

function renderBuilderAddTriggers(session, parentId, validTypes, context) {
  if (!validTypes.length) return "";
  return `
    <div class="builder-add-node-triggers" role="group" aria-label="Add to ${escapeAttr(context.sessionLabel(session))}">
      ${validTypes.map((type) => `
        <button class="builder-add-node-trigger" type="button" data-action="builder-start-inline-add" data-session-id="${escapeAttr(session.id)}" data-parent-id="${escapeAttr(parentId)}" data-node-type="${type}" title="Add ${escapeAttr(context.exerciseNodeLabel(type))}" aria-label="Add ${escapeAttr(context.exerciseNodeLabel(type))}">
          <span class="builder-node-level builder-node-level-${type}">
            <i class="builder-pyramid-top ${type === "section" ? "is-active" : ""}"></i>
            <i class="builder-pyramid-middle ${type === "category" ? "is-active" : ""}"></i>
            <i class="builder-pyramid-base ${type === "domain" ? "is-active" : ""}"></i>
          </span>
          <span class="builder-add-node-plus" aria-hidden="true">+</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderBuilderInlineAddForm(session, parentId, context) {
  const type = ALL_NODE_TYPES.includes(context.inlineAddType) ? context.inlineAddType : "domain";
  const label = context.exerciseNodeLabel(type);
  const presets = context.builderNodePresets || [];
  return `
    <form class="builder-node-form builder-inline-add-form" data-builder-form="add-node" data-session-id="${escapeAttr(session.id)}">
      <div class="builder-node-form-head"><strong>Add ${escapeHtml(label)}</strong></div>
      <input type="hidden" name="parentId" value="${escapeAttr(parentId)}">
      <input type="hidden" name="nodeType" value="${escapeAttr(type)}">
      <input class="builder-text-input" name="name" placeholder="${escapeAttr(label)} name" required autocomplete="off" data-builder-preset-name-input>
      ${renderPresetPicker(type, presets)}
      ${renderPastelSwatches("color", "", { allowCustom: true, collapsed: true })}
      <input class="builder-text-input" name="iconUrl" type="url" placeholder="Icon URL (optional)" aria-label="Node icon URL">
      <input class="builder-text-input" name="shortNote" maxlength="60" placeholder="Short note (optional, shown on the calendar)" aria-label="Short note">
      <textarea class="builder-text-input" name="note" rows="2" placeholder="Note (optional, shown when you open this ${escapeAttr(label.toLowerCase())})" aria-label="Note"></textarea>
      <p class="builder-error" aria-live="polite"></p>
      <div class="builder-inline-add-actions">
        ${renderConfirmIconButton({ label: `Add ${label}` })}
        ${renderCancelIconButton({ action: "builder-cancel-inline-add", label: "Cancel" })}
      </div>
    </form>
  `;
}

function renderBuilderNodeIcon(iconUrl, context) {
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) {
    return `<img class="builder-node-icon-image" src="${escapeAttr(iconUrl)}" alt="">`;
  }
  return context.builderIconGlyph(iconUrl);
}

// Replaces the plain-text <datalist> presets used to have (no way to show an
// icon in a native datalist option) with a small collapsible list, each row
// showing the same icon (renderBuilderNodeIcon) the preset will render as
// once it's actually placed in the tree/seen in the Calendar - same
// collapsed-until-clicked interaction as the pastel color picker
// (.pastel-palette-collapsed, taxonomy-view.js) right next to it in these
// same forms. Picking a row sets the name/color/icon fields directly from
// the preset's own data (not by re-matching typed text), so it works
// identically whether this is the add-node form or the edit-node form (the
// edit form has never had a nodeType hidden field for the older
// text-match-based applyBuilderNodePresetMatch to key off of).
function renderPresetPickerIcon(iconUrl) {
  if (iconUrl && /^https?:\/\//i.test(iconUrl)) {
    return `<img class="builder-node-icon-image" src="${escapeAttr(iconUrl)}" alt="">`;
  }
  return builderIconGlyph(iconUrl);
}

function renderPresetPicker(nodeType, presets) {
  const typePresets = (presets || []).filter((preset) => preset.node_type === nodeType);
  if (!typePresets.length) return "";
  return `
    <div class="builder-preset-picker">
      <button type="button" class="text-action builder-preset-picker-trigger" data-action="builder-toggle-preset-picker">Pick from presets</button>
      <div class="builder-preset-picker-list">
        ${typePresets.map((preset) => `
          <button type="button" class="builder-preset-picker-option" data-action="builder-pick-preset" data-name="${escapeAttr(preset.name)}" data-color="${escapeAttr(preset.color || "")}" data-icon-url="${escapeAttr(preset.icon_url || "")}">
            <span class="builder-node-icon">${renderPresetPickerIcon(preset.icon_url)}</span>
            <span>${escapeHtml(preset.name)}</span>
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

function isInlineAddHere(session, parentId, context) {
  return context.inlineAddOpen && context.inlineAddSessionId === session.id && context.inlineAddParentId === parentId;
}

export function renderBuilderBlock(block, selectedSessionId, selectedNodeId, isWeekly = false, context) {
  const defaultDayName = isWeekly ? weekDayName(block.date) : "";
  const kicker = isWeekly ? defaultDayName : `Block ${block.index}`;
  const secondary = isWeekly ? (block.date ? formatDate(block.date) : "") : (block.note || "");
  const namePlaceholder = isWeekly ? "e.g. MD-1, Match day" : `Block ${block.index}`;
  const nameLabel = isWeekly ? "Day label" : "Block name";
  return `
    <article class="builder-block">
      <div class="builder-block-head">
        <div class="builder-block-head-text">
          ${kicker ? `<span class="builder-block-kicker">${escapeHtml(kicker)}</span>` : ""}
          <form class="builder-day-label-inline" data-builder-form="update-block" data-builder-autosave data-block-id="${escapeAttr(block.id)}"><input name="name" class="builder-block-title-input" value="${escapeAttr(block.name || "")}" placeholder="${escapeAttr(namePlaceholder)}" aria-label="${escapeAttr(nameLabel)}"></form>
          ${secondary ? `<span class="builder-block-secondary">${escapeHtml(secondary)}</span>` : ""}
        </div>
        ${isWeekly
          ? `<div class="builder-block-head-actions">${renderCopyDayIconButton(block.id)}${renderPasteDayIconButton(block.id, context)}</div>`
          : `<div class="builder-block-head-actions">${renderCopyBlockIconButton(block.id)}${renderDeleteIconButton("builder-delete-block", `data-block-id="${escapeAttr(block.id)}"`, "Delete block")}</div>`}
      </div>
      <div class="builder-sessions">
        ${block.sessions.length ? block.sessions.map((session) => `
          <div class="builder-session-row"><button class="builder-session ${session.id === selectedSessionId ? "is-active" : ""}" data-action="builder-select-session" data-session-id="${escapeAttr(session.id)}">
            ${session.name ? `<strong class="builder-session-name">${escapeHtml(session.name)}</strong>` : ""}
            <span class="builder-session-badge-row"><span>${escapeHtml(context.sessionLabel(session))}</span><span>${session.nodes.reduce((total, node) => total + node.items.length, 0)} exercises</span></span>
          </button><div class="builder-session-actions"><form class="builder-session-time-inline" data-builder-form="update-session" data-builder-autosave data-session-id="${escapeAttr(session.id)}"><input type="text" name="name" class="builder-text-input builder-session-name-input" value="${escapeAttr(session.name || "")}" placeholder="Session name (optional)" aria-label="Session name (optional)" title="Session name (optional) - shown alongside the AM/PM and training-phase labels, not instead of them"><input type="time" name="time" class="builder-text-input builder-session-time-input" value="${escapeAttr(session.time || "")}" aria-label="Specific session time (optional)" title="Specific session time (optional)"></form>${renderBuilderAddTriggers(session, "", ALL_NODE_TYPES, context)}${renderDeleteIconButton("builder-delete-session", `data-session-id="${escapeAttr(session.id)}"`, "Delete session")}${renderNodePasteButton(session.id, "", "session", context)}</div></div>
          ${isInlineAddHere(session, "", context) ? renderBuilderInlineAddForm(session, "", context) : ""}
          ${renderBuilderNodeTree(session, "", selectedNodeId, context)}
        `).join("") : `<p class="muted">No sessions yet.</p>`}
      </div>
      ${renderSessionQuickAdd(block, context)}
    </article>
  `;
}

export function renderBuilderAddBlockCard(context) {
  if (!context.blockAddOpen) {
    return `
      <button class="builder-add-block-card" type="button" data-action="builder-toggle-add-block" aria-label="Add block">
        <span class="builder-add-block-plus" aria-hidden="true">+</span>
        <span>Add block</span>
      </button>
      ${context.clipboard?.type === "block" ? `
        <button class="builder-add-block-card builder-paste-block-card" type="button" data-action="builder-paste-block" aria-label="Paste block: ${escapeAttr(context.clipboard.name || "Block")}">
          ${ICON_PASTE}
          <span>Paste "${escapeHtml(context.clipboard.name || "Block")}"</span>
        </button>
      ` : ""}
    `;
  }
  return `
    <form class="builder-add-block-card is-open" data-builder-form="add-block">
      <div class="builder-block-head-text">
        <span class="builder-block-kicker">New block</span>
        <input class="builder-text-input" name="name" placeholder="Day 1, MD-2, or Block name" autofocus>
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <div class="builder-add-block-actions">
        ${renderConfirmIconButton({ label: "Add block" })}
        ${renderCancelIconButton({ action: "builder-toggle-add-block", label: "Cancel" })}
      </div>
    </form>
  `;
}

function renderSectionPreviewTrigger(node, context) {
  const isOpen = context.previewSectionId === node.id;
  return `
    <button class="builder-section-preview-trigger" type="button" data-action="builder-toggle-section-preview" data-node-id="${escapeAttr(node.id)}" aria-label="Preview exercises in ${escapeAttr(node.name)}" aria-expanded="${isOpen ? "true" : "false"}">
      <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><circle cx="9" cy="10" r="1.4"></circle><path d="M5 17l4.3-4.3a1.4 1.4 0 0 1 2 0L15 16.5"></path><path d="M13.5 15l1.3-1.3a1.4 1.4 0 0 1 2 0L19.5 16.5"></path></svg>
    </button>
  `;
}

function renderSectionPreviewPopover(node, context) {
  const isOpen = context.previewSectionId === node.id;
  const items = node.items || [];
  return `
    <div class="builder-section-preview-popover ${isOpen ? "is-open" : ""}">
      ${items.length ? items.slice(0, 8).map((item) => `
        <span class="builder-section-preview-thumb" title="${escapeAttr(item.title || "Exercise")}">
          ${item.imageUrl ? renderImage(item.imageUrl, "builder-section-preview-image") : `<span class="builder-section-preview-fallback">${escapeHtml((item.title || "?").slice(0, 1).toUpperCase())}</span>`}
        </span>
      `).join("") : `<span class="muted builder-section-preview-empty">No exercises yet</span>`}
    </div>
  `;
}

function renderBuilderNodeTree(session, parentId, selectedNodeId, context) {
  const nodes = session.nodes.filter((node) => node.parentId === parentId);
  const parentType = parentId ? (session.nodes.find((candidate) => candidate.id === parentId)?.type || "session") : "session";
  return nodes.map((node) => `
    <div class="builder-node builder-node-${escapeAttr(node.type)}">
      <div class="builder-node-row">
        <button class="builder-node-button ${node.id === selectedNodeId ? "is-active" : ""}" data-action="builder-select-node" data-node-id="${escapeAttr(node.id)}" data-session-id="${escapeAttr(session.id)}" style="${node.color ? `--builder-node-color:${escapeAttr(node.color)}` : ""}">
          <span class="builder-node-name"><span class="builder-node-icon">${renderBuilderNodeIcon(node.iconUrl, context)}</span><span class="builder-node-name-text">${escapeHtml(node.name)}</span></span><small>${context.builderNodeMarker(node.type)}${node.type === "section" ? context.builderExerciseCountDots(node.items.length) : ""}</small>
        </button>
      </div>
      <div class="builder-node-row-actions">
        ${node.type === "section" ? renderSectionPreviewTrigger(node, context) : ""}
        ${renderBuilderAddTriggers(session, node.id, validChildTypes(node.type), context)}
        ${renderBuilderNodeMoveActions(node, true, session.id, context)}
        ${renderCopyNodeIconButton(node.id, `Copy ${node.type}`)}
        ${renderDeleteIconButton("builder-delete-node", `data-node-id="${escapeAttr(node.id)}"`, `Delete ${node.type}`)}
        ${node.type === "section"
          ? renderNodePasteButton(session.id, parentId, parentType, context, "Paste as sibling here")
          : renderNodePasteButton(session.id, node.id, node.type, context)}
      </div>
      ${node.type === "section" ? renderSectionPreviewPopover(node, context) : ""}
      ${isInlineAddHere(session, node.id, context) ? renderBuilderInlineAddForm(session, node.id, context) : ""}
      ${renderBuilderNodeTree(session, node.id, selectedNodeId, context)}
    </div>
  `).join("");
}

export function renderNodeEditForm(node, label, isOpen = false, presets = []) {
  const toggleButton = `<button class="plain-button builder-icon-action" type="button" data-action="builder-toggle-node-edit" data-node-id="${escapeAttr(node.id)}" aria-label="${isOpen ? "Done editing" : `Edit ${escapeAttr(label)} name, color and icon`}" title="${isOpen ? "Done" : "Edit name, color, icon"}">${isOpen ? ICON_CHECK : ICON_PENCIL}</button>`;
  if (!isOpen) {
    return `<div class="builder-node-edit-heading"><span class="builder-node-edit-name">${escapeHtml(node.name)}</span>${toggleButton}</div>`;
  }
  return `
    <form class="builder-node-form builder-node-edit-form" data-builder-form="update-node" data-builder-autosave data-node-id="${escapeAttr(node.id)}">
      <div class="builder-node-form-head"><strong>Editing ${escapeHtml(label)}</strong>${toggleButton}</div>
      <input class="builder-text-input" name="name" value="${escapeAttr(node.name || "")}" placeholder="Name" aria-label="${escapeAttr(label)} name" autocomplete="off">
      ${renderPresetPicker(node.type, presets)}
      ${renderPastelSwatches("color", node.color || "", { allowCustom: true, collapsed: true })}
      <input class="builder-text-input" name="iconUrl" type="url" value="${escapeAttr(node.iconUrl || "")}" placeholder="Icon URL (optional)" aria-label="${escapeAttr(label)} icon URL">
      <input class="builder-text-input" name="shortNote" maxlength="60" value="${escapeAttr(node.shortNote || "")}" placeholder="Short note (optional, shown on the calendar)" aria-label="${escapeAttr(label)} short note">
      <textarea class="builder-text-input" name="note" rows="2" placeholder="Note (optional, shown when you open this ${escapeAttr(label.toLowerCase())})" aria-label="${escapeAttr(label)} note">${escapeHtml(node.note || "")}</textarea>
    </form>
  `;
}

function renderBuilderStructureEditor(session, selectedNode, context) {
  const presets = context.builderNodePresets || [];
  if (!selectedNode) {
    return `<div class="empty">Use the + buttons in the tree to add a domain, category, or section.</div>`;
  }
  const isSection = selectedNode.type === "section";
  const label = context.exerciseNodeLabel(selectedNode.type);
  const hint = isSection
    ? "Sections contain exercises and cannot contain another structural level."
    : selectedNode.type === "domain"
      ? "Use the + buttons in the tree to add a category or section below this domain."
      : "Use the + buttons in the tree to add a section below this category.";
  return `
    <div class="builder-selected-section">
      <div>
        <p class="eyebrow">Selected ${escapeHtml(label)}</p>
        ${renderNodeEditForm(selectedNode, label, context.editNodeOpen === selectedNode.id, presets)}
        ${context.editNodeOpen !== selectedNode.id && selectedNode.note ? `<p class="builder-node-note">${escapeHtml(selectedNode.note)}</p>` : ""}
        <p class="muted">${escapeHtml(hint)}</p>
      </div>
      <div class="builder-section-editor-actions">${renderBuilderNodeMoveActions(selectedNode, false, "", context)}${renderCopyNodeIconButton(selectedNode.id, `Copy ${selectedNode.type}`)}${renderNodePasteButton(session.id, selectedNode.id, selectedNode.type, context)}${renderDeleteIconButton("builder-delete-node", `data-node-id="${escapeAttr(selectedNode.id)}"`, `Delete ${selectedNode.type}`)}</div>
    </div>
    ${isSection ? `<button class="plain-button builder-open-section" type="button" data-action="builder-open-section-panel">Open section exercise editor</button>` : ""}
  `;
}

function renderNodePasteButton(sessionId, parentId, parentType, context, label) {
  const clipboard = context.clipboard;
  if (!clipboard?.type || !context.canPasteNodeType(clipboard.type, parentType)) return "";
  const title = label || `Paste ${clipboard.type}`;
  return `<button class="plain-button builder-icon-action builder-paste-icon" type="button" data-action="builder-paste-node" data-session-id="${escapeAttr(sessionId)}" data-parent-id="${escapeAttr(parentId)}" aria-label="${escapeAttr(title)}" title="${escapeAttr(title)}">${ICON_PASTE}</button>`;
}

function renderBuilderNodeMoveActions(node, compact = false, sessionId = "", context) {
  const session = context.findBuilderSession(sessionId || context.selectedSessionId);
  const siblings = (session?.nodes || [])
    .filter((candidate) => candidate.parentId === node.parentId)
    .sort((left, right) => left.order - right.order);
  const index = siblings.findIndex((candidate) => candidate.id === node.id);
  const buttonClass = compact ? "plain-button builder-node-move-icon" : "text-action";
  const upLabel = compact ? "&uarr;" : "Move up";
  const downLabel = compact ? "&darr;" : "Move down";
  return `<span class="builder-node-move-actions ${compact ? "is-compact" : ""}"><button class="${buttonClass}" type="button" data-action="builder-move-node" data-node-id="${escapeAttr(node.id)}" data-direction="up" aria-label="Move ${escapeAttr(node.type)} up" title="Move up" ${index <= 0 ? "disabled" : ""}>${upLabel}</button><button class="${buttonClass}" type="button" data-action="builder-move-node" data-node-id="${escapeAttr(node.id)}" data-direction="down" aria-label="Move ${escapeAttr(node.type)} down" title="Move down" ${index < 0 || index >= siblings.length - 1 ? "disabled" : ""}>${downLabel}</button></span>`;
}
