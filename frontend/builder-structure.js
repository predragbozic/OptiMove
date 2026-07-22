import { renderImage } from "./media.js";
import { formatDate, weekDayName, escapeAttr, escapeHtml } from "./utils.js";

export function renderBuilderSessionModal(blockId) {
  return `
    <div class="builder-modal-overlay">
      <button class="builder-modal-backdrop" type="button" data-action="builder-close-session-modal" aria-label="Close add session"></button>
      <section class="panel builder-compact-modal" role="dialog" aria-modal="true" aria-label="Add session">
        <div class="builder-modal-head"><div><p class="eyebrow">Day and session structure</p><h3>Add session</h3><p class="muted">Both fields are optional. Use them only when the day needs a time or training phase.</p></div><button class="plain-button icon-button" type="button" data-action="builder-close-session-modal" aria-label="Close"><span class="button-icon">x</span></button></div>
        <form class="builder-session-modal-form" data-builder-form="add-session" data-block-id="${escapeAttr(blockId)}">
          <label class="search-field"><span>Time of day</span><select name="amPm"><option value="">No AM/PM</option><option>AM</option><option>PM</option></select></label>
          <label class="search-field"><span>Training phase</span><select name="bta"><option value="">No phase</option><option value="B">Before training</option><option value="T">Training</option><option value="A">After training</option></select></label>
          <p class="builder-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Add session</button>
        </form>
      </section>
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
  return `
    <form class="builder-node-form builder-inline-add-form" data-builder-form="add-node" data-session-id="${escapeAttr(session.id)}">
      <div class="builder-node-form-head"><strong>Add ${escapeHtml(label)}</strong><button class="text-action" type="button" data-action="builder-cancel-inline-add">Cancel</button></div>
      <input type="hidden" name="parentId" value="${escapeAttr(parentId)}">
      <input type="hidden" name="nodeType" value="${escapeAttr(type)}">
      <input name="name" placeholder="${escapeAttr(label)} name" required>
      <input name="color" type="color" value="#287e77" aria-label="Node color">
      <select name="iconUrl" aria-label="Node icon">${context.builderIconOptions()}</select>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add ${escapeHtml(label)}</button>
    </form>
  `;
}

function isInlineAddHere(session, parentId, context) {
  return context.inlineAddOpen && context.inlineAddSessionId === session.id && context.inlineAddParentId === parentId;
}

export function renderBuilderBlock(block, selectedSessionId, selectedNodeId, isWeekly = false, context) {
  const defaultDayName = isWeekly ? weekDayName(block.date) : "";
  const blockTitle = isWeekly ? block.name || defaultDayName : block.name || `Block ${block.index}`;
  return `
    <article class="builder-block">
      <div class="builder-block-head"><div><strong>${escapeHtml(blockTitle)}</strong>${block.date ? `<span>${escapeHtml(formatDate(block.date))}</span>` : block.note ? `<span>${escapeHtml(block.note)}</span>` : ""}</div>${isWeekly ? "" : `<button class="text-action danger-action" type="button" data-action="builder-delete-block" data-block-id="${escapeAttr(block.id)}">Delete</button>`}</div>
      ${isWeekly ? `<form class="builder-day-label-form" data-builder-form="update-block" data-builder-autosave data-block-id="${escapeAttr(block.id)}"><label class="search-field"><span>Day label</span><input name="name" value="${escapeAttr(block.name || "")}" placeholder="e.g. MD-1, Match day"></label><small>Optional: leave empty to show ${escapeHtml(defaultDayName)}.</small></form>` : ""}
      <div class="builder-sessions">
        ${block.sessions.length ? block.sessions.map((session) => `
          <div class="builder-session-row"><button class="builder-session ${session.id === selectedSessionId ? "is-active" : ""}" data-action="builder-select-session" data-session-id="${escapeAttr(session.id)}">
            <span>${escapeHtml(context.sessionLabel(session))}</span><span>${session.nodes.reduce((total, node) => total + node.items.length, 0)} exercises</span>
          </button><div class="builder-session-actions">${renderNodePasteButton(session.id, "", "session", context)}${renderBuilderAddTriggers(session, "", ALL_NODE_TYPES, context)}<button class="text-action danger-action" type="button" data-action="builder-delete-session" data-session-id="${escapeAttr(session.id)}">Delete</button></div></div>
          ${isInlineAddHere(session, "", context) ? renderBuilderInlineAddForm(session, "", context) : ""}
          ${renderBuilderNodeTree(session, "", selectedNodeId, context)}
        `).join("") : `<p class="muted">No sessions yet.</p>`}
      </div>
      <button class="plain-button builder-add-session" type="button" data-action="builder-open-session-modal" data-block-id="${escapeAttr(block.id)}">Add session</button>
    </article>
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
  return nodes.map((node) => `
    <div class="builder-node builder-node-${escapeAttr(node.type)}">
      <div class="builder-node-row">
        <button class="builder-node-button ${node.id === selectedNodeId ? "is-active" : ""}" data-action="builder-select-node" data-node-id="${escapeAttr(node.id)}" data-session-id="${escapeAttr(session.id)}" style="${node.color ? `--builder-node-color:${escapeAttr(node.color)}` : ""}">
          <span class="builder-node-name"><span class="builder-node-icon">${context.builderIconGlyph(node.iconUrl)}</span>${escapeHtml(node.name)}</span><small>${context.builderNodeMarker(node.type)}${node.type === "section" ? context.builderExerciseCountDots(node.items.length) : ""}</small>
        </button>
        ${node.type === "section" ? renderSectionPreviewTrigger(node, context) : ""}
        ${renderBuilderNodeMoveActions(node, true, session.id, context)}
      </div>
      ${node.type === "section" ? renderSectionPreviewPopover(node, context) : ""}
      ${renderNodePasteButton(session.id, node.id, node.type, context)}
      ${renderBuilderAddTriggers(session, node.id, validChildTypes(node.type), context)}
      ${isInlineAddHere(session, node.id, context) ? renderBuilderInlineAddForm(session, node.id, context) : ""}
      ${renderBuilderNodeTree(session, node.id, selectedNodeId, context)}
    </div>
  `).join("");
}

function renderBuilderStructureEditor(session, selectedNode, context) {
  if (selectedNode?.type === "section") {
    return `
      <div class="builder-selected-section">
        <div><p class="eyebrow">Selected section</p><strong>${escapeHtml(selectedNode.name)}</strong><p class="muted">Sections contain exercises and cannot contain another structural level.</p></div>
        <div class="builder-section-editor-actions">${renderBuilderNodeMoveActions(selectedNode, false, "", context)}<button class="plain-button" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy section</button><button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete section</button></div>
      </div>
      <button class="plain-button builder-open-section" type="button" data-action="builder-open-section-panel">Open section exercise editor</button>
    `;
  }
  return `
    <form class="builder-node-form" data-builder-form="add-node" data-session-id="${escapeAttr(session.id)}">
      <div class="builder-node-form-head"><strong>${selectedNode ? `Add below ${escapeHtml(selectedNode.name)}` : "Add first level"}</strong>${selectedNode ? `<span class="builder-node-form-actions">${renderBuilderNodeMoveActions(selectedNode, false, "", context)}<button class="text-action" type="button" data-action="builder-copy-node" data-node-id="${escapeAttr(selectedNode.id)}">Copy ${escapeHtml(selectedNode.type)}</button>${renderNodePasteButton(session.id, selectedNode.id, selectedNode.type, context)}<button class="text-action danger-action" type="button" data-action="builder-delete-node" data-node-id="${escapeAttr(selectedNode.id)}">Delete ${escapeHtml(selectedNode.type)}</button></span>` : ""}</div>
      <input type="hidden" name="parentId" value="${escapeAttr(selectedNode?.id || "")}">
      <select name="nodeType">${context.nodeTypeOptions(selectedNode?.type)}</select>
      <input name="name" placeholder="${selectedNode?.type === "domain" ? "Category or section name" : selectedNode?.type === "category" ? "Section name" : "Domain, category or section name"}" required>
      <input name="color" type="color" value="#287e77" aria-label="Node color">
      <select name="iconUrl" aria-label="Node icon">${context.builderIconOptions()}</select>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add</button>
    </form>
    ${selectedNode ? `
      <div class="empty">${selectedNode.type === "domain" ? "Add a category or section below this domain." : "Add a section below this category."}</div>
    ` : `<div class="empty">Create or select a domain, category or section before adding exercises.</div>`}
  `;
}

function renderNodePasteButton(sessionId, parentId, parentType, context) {
  const clipboard = context.clipboard;
  if (!clipboard?.type || !context.canPasteNodeType(clipboard.type, parentType)) return "";
  return `<button class="text-action builder-paste-node" type="button" data-action="builder-paste-node" data-session-id="${escapeAttr(sessionId)}" data-parent-id="${escapeAttr(parentId)}">Paste ${escapeHtml(clipboard.type)}</button>`;
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
