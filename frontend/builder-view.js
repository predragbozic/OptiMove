import { renderAthleteSwitcherStripHtml } from "./athlete-switcher.js";
import { k3BlockInEvent } from "./central-calendar-k3-actions.js";
import { renderK3BandHtml, renderK3DayMarkHtml, renderK3OutcomeHtml, renderK3SaveBarHtml, renderK3SavedHtml, renderK3SessionHtml, renderK3SessionNoteHtml } from "./central-calendar-k3-view.js";
import {
  builderExerciseCountDots,
  builderIconGlyph,
  builderIconOptions,
  builderNodeMarker,
  canPasteNodeType,
  exerciseNodeLabel,
  findBuilderNode,
  findBuilderSession,
  sessionLabel,
} from "./builder-helpers.js";
import { renderBuilderAddConfirmation, renderBuilderExerciseResults, renderBuilderStickyBar } from "./builder-exercises.js";
import { renderExerciseViewSwitcher } from "./exercise-view-modes.js";
import { autosizeTextareas } from "./textarea-autosize.js";
import { preserveBuilderItemEdits } from "./builder-item-edits.js";
import { renderBlockPickerModal, renderBuilderAthletePicker, renderBuilderInfoModal, renderCopyPlanModal, renderOverwriteDayConfirmHtml } from "./builder-modals.js";
import { builderFiltersToggleState, renderBuilderAddedPanelContent, renderBuilderSectionOverlay } from "./builder-section.js";
import { ensureBuilderEvents } from "./builder-events-row.js";
import { renderBuilderSessionsLockedHtml } from "./builder-sessions-locked.js";
import { currentTemplateWeek, dayOfBlock, isWeeklyTemplateDraft, renderTemplateWeekStripHtml, templateWeekBlocks } from "./builder-weekly-template-view.js";
import { renderBuilderEventsAskHtml, renderBuilderEventsRowHtml, renderBuilderSessionEventHtml, renderBuilderSessionEventNoteHtml } from "./builder-events-row-view.js";
import { renderPastelSwatches } from "./taxonomy-view.js";
import {
  ICON_CHECK,
  ICON_DOOR_EXIT,
  ICON_TRASH,
  ICON_X,
  renderBuilderAddBlockCard,
  renderBuilderBlock,
  renderBuilderStructureModal,
  renderBuilderTrainingLoadSettings,
  renderImportBlockIconButton,
} from "./builder-structure.js";
import { els } from "./dom.js";
import { renderImage } from "./media.js";
import { state } from "./state.js";
import {
  escapeAttr,
  escapeHtml,
  formatDate,
  initialsFor,
  localDateIso,
  weekMondayIso,
} from "./utils.js";

// Same figure + white-on-fill plus badge convention as ICON_ADD_ATHLETE/
// ICON_ADD_CLUB in organization-view.js - reused here rather than invented,
// so the three entry tiles read as the same "add" family as the rest of the app.
const ICON_ENTRY_WEEKLY = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="14" height="13.5" rx="2"></rect><path d="M7 2.5v4"></path><path d="M13 2.5v4"></path><path d="M3 9.5h14"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
const ICON_ENTRY_PROGRAM = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h6.5L16 6v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"></path><path d="M12.5 2.5V6H16"></path><path d="M7.5 10.5h5"></path><path d="M7.5 13.5h5"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;
const ICON_ENTRY_TEMPLATE = `<svg class="athlete-home-quick-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 2.5l6 3-6 3-6-3 6-3Z"></path><path d="M2.5 8.5l6 3 6-3"></path><path d="M2.5 12.5l6 3 6-3"></path><circle cx="18" cy="18" r="4.5" fill="currentColor" stroke="none"></circle><path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path></svg>`;

const BUILDER_ENTRY_TILES = [
  ["weekly", "Weekly plan", ICON_ENTRY_WEEKLY],
  ["program", "Program", ICON_ENTRY_PROGRAM],
  ["template", "Template", ICON_ENTRY_TEMPLATE],
];

function renderBuilderEntryTiles() {
  return `
    <section class="panel builder-setup-card builder-entry-tiles">
      <div class="section-heading">
        <div><p class="eyebrow">Program builder</p><h3>What are you creating?</h3><p class="muted">Pick one to jump straight into its setup.</p></div>
      </div>
      <div class="athlete-home-quick-actions-grid builder-entry-tiles-grid">
        ${BUILDER_ENTRY_TILES.map(([entryType, label, icon]) => `
          <button class="athlete-home-quick-action" type="button" data-action="builder-choose-entry-type" data-entry-type="${entryType}">
            ${icon}
            <span class="athlete-home-quick-action-label">${escapeHtml(label)}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function builderStructureContext() {
  return {
    builderExerciseCountDots,
    builderIconGlyph,
    builderIconOptions,
    builderNodeMarker,
    canPasteNodeType,
    clipboard: state.builder.clipboard,
    exerciseNodeLabel,
    findBuilderSession: (id) => findBuilderSession(state.builder.draft, id),
    selectedSessionId: state.builder.selectedSessionId,
    sessionLabel,
    inlineAddOpen: state.builder.inlineAddOpen,
    inlineAddType: state.builder.inlineAddType,
    inlineAddSessionId: state.builder.inlineAddSessionId,
    inlineAddParentId: state.builder.inlineAddParentId,
    previewSectionId: state.builder.previewSectionId,
    editNodeOpen: state.builder.editNodeOpen,
    builderNodePresets: state.builder.nodePresets || [],
    // A weekly program template's day: "Day 1".."Day 7" of its week, no
    // rename or delete of a single day (the template changes by whole weeks).
    templateDayOf: (block) => (isWeeklyTemplateDraft(state.builder.draft) ? dayOfBlock(block) : 0),
    blockAddOpen: state.builder.blockAddOpen,
    sessionQuickAdd: state.builder.sessionQuickAdd,
    // K2c-3: the day's events row, each session's Event: [▾] and its note.
    eventsRow: (block) => renderBuilderEventsRowHtml(block),
    sessionEvent: (block, session) => renderBuilderSessionEventHtml(block, session),
    sessionEventNote: (block, session) => renderBuilderSessionEventNoteHtml(block, session),
    // K3: the event's day, each session's In / Not in this event, its note.
    k3InEvent: (block) => k3BlockInEvent(state.builder.k3, block),
    k3DayMark: (block) => (state.builder.k3 ? renderK3DayMarkHtml(state.builder.k3, block) : ""),
    k3Session: (block, session) => (state.builder.k3 ? renderK3SessionHtml(state.builder.k3, block, session) : ""),
    k3SessionNote: (block, session) => (state.builder.k3 ? renderK3SessionNoteHtml(state.builder.k3, block, session) : ""),
  };
}

// The members of a group the coach may not open are only a count from the
// server (loadBuilderBatch's hiddenCount): said in one sentence, never drawn.
export function renderBuilderBatchHiddenNote(hiddenCount) {
  const n = Number(hiddenCount) || 0;
  if (n < 1) return "";
  return `<small class="builder-batch-hidden" data-builder-batch-hidden>${n} other athlete${n === 1 ? "" : "s"} in this group ${n === 1 ? "has a plan" : "have plans"} you can't open.</small>`;
}

export function renderBuilderBatchSwitcher(batchPlans, currentIndex) {
  if (!batchPlans.length || currentIndex < 0) return "";
  const current = batchPlans[currentIndex];
  // A reopened, published plan (an edit draft) saves to this athlete only (the
  // server does not sync an edit draft's batch), so it offers no
  // "Apply changes to all athletes" checkbox.
  const isEditDraft = Boolean(state.builder.draft?.plan?.isEditDraft);
  const syncChecked = state.builder.batchSync ? "checked" : "";
  return `
    <section class="builder-batch-switcher" aria-label="Batch athlete plans">
      <div class="builder-batch-summary">
        <p class="eyebrow">Group builder</p>
        <strong>${escapeHtml(current?.athleteName || current?.name || "Current copy")}</strong>
        <small>${currentIndex + 1} / ${batchPlans.length}</small>
        ${renderBuilderBatchHiddenNote(state.builder.draft?.batch?.hiddenCount)}
        <small data-builder-batch-status role="status" aria-live="polite" hidden></small>
      </div>
      <div class="builder-batch-controls">
        ${renderAthleteSwitcherStripHtml({
          items: batchPlans.map((plan) => {
            const athlete = state.athletes.find((row) => String(row.athlete_id) === String(plan.athleteId));
            return {
              key: plan.id,
              name: plan.athleteName || plan.name || "Program copy",
              imageUrl: athlete?.athlete_image_url || athlete?.image_url,
            };
          }),
          currentKey: current?.id,
          action: "builder-open-batch-plan",
          keyAttr: "data-plan-id",
          wrapArrows: false,
        })}
        <div class="builder-batch-mode">
          ${isEditDraft ? `<small data-builder-batch-edit-note>Changes go to this athlete only.</small>` : `
          <label class="builder-batch-sync">
            <input type="checkbox" data-action="builder-toggle-batch-sync" ${syncChecked}>
            <span>Apply changes to all athletes</span>
          </label>
          <small>Turn off before fine-tuning only this athlete.</small>`}
        </div>
      </div>
    </section>
  `;
}

// Who gets the changes of a reopened weekly batch member
// (docs/ai/builder-batch-edit-plan.md sections 4 and 10). Plain sentences,
// one question at a time, no ids or codes.
const BATCH_EDIT_REASON_TEXT = {
  changed_separately: "their plan was changed separately",
  has_results: "a session with results would be removed or moved",
  linked_to_event: "a session on the calendar would be removed or moved",
  being_edited: "their plan is open for editing (by you or another coach)",
  archived: "archived",
  not_editable: "you can't edit their plan",
};
// One list: everyone who will not get the changes, each with its reason.
// Athletes the coach is not shown are a count only.
function batchEditMemberLines(...groups) {
  const lines = [];
  let unnamed = 0;
  for (const group of groups) {
    for (const m of group?.named || []) {
      lines.push(`<li><strong>${escapeHtml(m.name)}</strong>: ${escapeHtml((m.reasons || []).map((r) => BATCH_EDIT_REASON_TEXT[r] || "can't take these changes").join("; "))}</li>`);
    }
    unnamed += Number(group?.unnamedCount || 0);
  }
  if (unnamed) lines.push(`<li>${unnamed} other athlete${unnamed === 1 ? "" : "s"} you can't edit</li>`);
  return lines.length ? `<ul class="builder-batch-edit-list">${lines.join("")}</ul>` : "";
}
const otherAthletes = (n) => `${n} other athlete${n === 1 ? "" : "s"}`;

export function renderBuilderBatchEditPanel(draft, batchPlans) {
  const choice = state.builder.batchEditChoice;
  const name = draft.plan.athleteName || "this athlete";
  // The group counts the members this coach may not open (hiddenCount, #664);
  // the question counts only those the change can reach.
  const hidden = Number(draft.batch?.hiddenCount) || 0;
  const count = batchPlans.length;
  const groupSize = count + hidden;
  const primary = (actionName, label) => `<button class="plain-button builder-batch-edit-primary" type="button" data-action="${actionName}">${label}</button>`;
  const only = `<button class="plain-button" type="button" data-action="builder-batch-edit-only">Only ${escapeHtml(name)}</button>`;
  const cancel = `<button class="plain-button" type="button" data-action="builder-batch-edit-cancel">Cancel</button>`;
  const actions = (...buttons) => `<div class="builder-batch-edit-actions">${buttons.join("")}</div>`;
  let body;
  if (!choice) {
    body = `<p>${escapeHtml(name)} is one of ${groupSize} athletes in this group. When you save, you choose who gets the changes.</p>`;
  } else if (choice.stage === "scope") {
    const question = hidden ? `Apply these changes to all ${count} athletes you can edit?` : `Apply these changes to all ${count} athletes?`;
    body = `<p><strong>${question}</strong></p>${actions(primary("builder-batch-edit-all", "All athletes"), only, cancel)}`;
  } else if (choice.stage === "ask") {
    const data = choice.data || {};
    const others = Number(data.applyCount || 0);
    const list = batchEditMemberLines(data.cannot, data.notChanged);
    body = !list && others
      // Only the earlier choice went out of date (nobody is left out now).
      ? `<p><strong>Something changed since you chose.</strong> Apply these changes to ${escapeHtml(name)} and ${otherAthletes(others)}?</p>${actions(primary("builder-batch-edit-others", `Apply to ${escapeHtml(name)} and ${otherAthletes(others)}`), only, cancel)}`
      : others
      ? `<p><strong>These athletes won't get the changes:</strong></p>${list}${actions(primary("builder-batch-edit-others", `Apply to ${escapeHtml(name)} and ${otherAthletes(others)}`), only, cancel)}`
      : `<p><strong>None of the other athletes can take these changes:</strong></p>${list}${actions(only, cancel)}`;
  } else if (choice.stage === "unconfirmed") {
    body = `<p><strong>Result not confirmed.</strong> The save may or may not have gone through.</p>${actions(primary("builder-batch-edit-check", "Check result"))}`;
  } else if (choice.stage === "notSaved") {
    body = `<p><strong>Not saved.</strong> Your changes are still here. Save again to choose who gets them.</p>${actions(primary("builder-batch-edit-again", "Save again"), cancel)}`;
  } else if (choice.stage === "busy") {
    body = `<p><strong>Nothing was saved.</strong> The plans were busy for a moment. Try again.</p>${actions(primary("builder-batch-edit-again", "Try again"), cancel)}`;
  } else if (choice.stage === "sourceChanged") {
    body = `<p><strong>This plan was saved by someone else after you opened it.</strong> Save your version for ${escapeHtml(name)} only, or cancel, close it and open it again.</p>${actions(only, cancel)}`;
  } else if (choice.stage === "closed") {
    body = `<p><strong>Your changes may already be saved.</strong> We can't tell which athletes got them. Open the group's plans to check.</p>${actions(primary("builder-batch-edit-done", "Open the plans"))}`;
  } else {
    const summary = choice.summary || {};
    const applied = Number(summary.applied || 1);
    const list = batchEditMemberLines(summary.notChanged);
    body = `<p><strong>${escapeHtml(draft.plan.name || "The plan")} saved for ${applied} athlete${applied === 1 ? "" : "s"}.</strong></p>${list ? `<p>These athletes didn't get the changes:</p>${list}` : ""}${actions(primary("builder-batch-edit-done", "Done"))}`;
  }
  return `<section class="builder-batch-edit" data-builder-batch-edit role="status" aria-live="polite">${body}</section>`;
}

export function renderBuilderEditDraftBatchNote() {
  return `<p class="builder-batch-edit-note" data-builder-batch-edit-note>Changes go to this athlete only.</p>`;
}

function renderBuilderDraftsPanel() {
  if (state.builder.draftsLoading) {
    return `<section class="panel builder-drafts-panel"><p class="muted">Loading drafts...</p></section>`;
  }
  const drafts = state.builder.drafts || [];
  if (!drafts.length) return "";
  const isOpen = state.builder.draftsOpen;
  const selectedKeys = new Set(state.builder.selectedDraftKeys || []);
  const allSelected = drafts.length > 0 && drafts.every((item) => selectedKeys.has(item.groupKey));
  const selectedCount = selectedKeys.size;
  return `
    <section class="panel builder-drafts-panel">
      <p class="muted" role="status" data-builder-draft-open-status hidden></p>
      <button class="builder-drafts-toggle" type="button" data-action="builder-toggle-drafts-panel" aria-expanded="${isOpen ? "true" : "false"}">
        <span><span class="eyebrow">Continue where you left off</span><strong>${drafts.length} unfinished draft${drafts.length === 1 ? "" : "s"}</strong></span>
        <span class="button-icon">${isOpen ? "&#8963;" : "&#8964;"}</span>
      </button>
      ${isOpen ? `
        <div class="builder-drafts-body">
          <div class="builder-drafts-bulk-row">
            <div class="builder-athlete-select-all">
              <button class="checkbox-toggle-all ${allSelected ? "is-checked" : ""}" type="button" data-action="builder-toggle-select-all-drafts" aria-label="${allSelected ? "Uncheck all drafts" : "Check all drafts"}">
                <span aria-hidden="true">${allSelected ? "&#10003;" : ""}</span>
              </button>
              <span class="muted">Select all</span>
            </div>
            ${selectedCount ? `<button class="plain-button builder-draft-discard danger-action" type="button" data-action="builder-discard-selected-drafts">Discard selected (${selectedCount})</button>` : ""}
          </div>
          <div class="builder-drafts-list">
            ${drafts.map((item) => {
              const typeLabel = item.planType === "weekly"
                ? `Weekly plan${item.weekStart ? ` - ${formatDate(item.weekStart)}` : ""}`
                : item.isTemplate ? "Template" : "Program";
              const athleteLabel = item.athleteNames?.length ? item.athleteNames.join(", ") : "";
              const isChecked = selectedKeys.has(item.groupKey);
              return `
                <div class="builder-draft-row">
                  <button class="checkbox-toggle-all ${isChecked ? "is-checked" : ""}" type="button" data-action="builder-toggle-select-draft" data-group-key="${escapeAttr(item.groupKey)}" aria-label="${isChecked ? "Uncheck" : "Check"} ${escapeAttr(item.name || typeLabel)}">
                    <span aria-hidden="true">${isChecked ? "&#10003;" : ""}</span>
                  </button>
                  <div class="builder-draft-info">
                    <strong>${escapeHtml(item.name || typeLabel)}</strong>
                    <small>${escapeHtml(typeLabel)}${athleteLabel ? ` &middot; ${escapeHtml(athleteLabel)}` : ""}</small>
                    <small class="muted">Last edited ${escapeHtml(formatDate(item.updatedAt))}</small>
                  </div>
                  <div class="builder-draft-actions">
                    <button class="plain-button" type="button" data-action="builder-open-draft" data-plan-id="${escapeAttr(item.openPlanId)}">Continue</button>
                    <button class="plain-button builder-draft-discard danger-action" type="button" data-action="builder-discard-draft" data-plan-ids="${escapeAttr((item.planIds || []).join(","))}">Discard</button>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      ` : ""}
    </section>
  `;
}

const BUILDER_SCROLL_SELECTORS = [".builder-section-modal", ".builder-exercise-results", ".builder-section-added"];
const BUILDER_BLOCK_GRID_SELECTOR = ".builder-block-grid";

// renderBuilder() replaces els.content's entire innerHTML on every call
// (renderBuilderInner() below), including .builder-block-grid - the row of
// block columns that scrolls horizontally. Reassigning innerHTML destroys
// and recreates that element, which resets scrollLeft to 0 with no DOM
// state to preserve it from. Every add/edit of a block, domain, category,
// or section routes through this same renderBuilder() call, so all of them
// need their horizontal position restored the same way.
//
// lastRenderedPlanId/lastRenderedBlockIds are intentionally module-level
// (not local to one call): by the time renderBuilder() runs, the mutation
// that triggered it has already updated state.builder.draft (setBuilderDraft
// happens before the render call in every action handler), so there is no
// "before" snapshot available within a single call to diff against - only
// what was remembered from the PREVIOUS render. Comparing against that is
// also what makes it safe to tell "one block was appended" apart from
// "a completely different plan was loaded into the Builder" (block count
// grew by exactly one AND every previous block is still present, vs. an
// unrelated set of ids) - the former gets the new block scrolled minimally
// into view, the latter intentionally does not restore a leftover scroll
// position from whatever plan was open before.
let lastRenderedPlanId = null;
let lastRenderedBlockIds = null;

function addedBlockId(previousIds, currentIds) {
  if (!previousIds || !previousIds.length) return null;
  if (currentIds.length !== previousIds.length + 1) return null;
  if (!previousIds.every((id) => currentIds.includes(id))) return null;
  return currentIds.find((id) => !previousIds.includes(id)) || null;
}

function captureBuilderScrollState() {
  const vertical = BUILDER_SCROLL_SELECTORS.map((selector) => {
    const el = els.content.querySelector(selector);
    return { selector, top: el ? el.scrollTop : null };
  });

  const grid = els.content.querySelector(BUILDER_BLOCK_GRID_SELECTOR);
  const currentPlanId = state.builder.draft?.plan?.id || null;
  const currentBlockIds = (state.builder.draft?.blocks || []).map((block) => block.id);
  const samePlan = currentPlanId !== null && currentPlanId === lastRenderedPlanId;
  const horizontal = grid
    ? { left: grid.scrollLeft, samePlan, addedBlockId: samePlan ? addedBlockId(lastRenderedBlockIds, currentBlockIds) : null }
    : null;

  lastRenderedPlanId = currentPlanId;
  lastRenderedBlockIds = currentBlockIds;

  return { vertical, horizontal };
}

function restoreBuilderScrollState(captured) {
  requestAnimationFrame(() => {
    captured.vertical.forEach(({ selector, top }) => {
      if (top === null) return;
      const el = els.content.querySelector(selector);
      if (el) el.scrollTop = top;
    });

    if (!captured.horizontal) return;
    const grid = els.content.querySelector(BUILDER_BLOCK_GRID_SELECTOR);
    if (!grid) return;

    if (captured.horizontal.addedBlockId) {
      const newBlockEl = [...grid.querySelectorAll("[data-block-id]")]
        .find((el) => el.dataset.blockId === captured.horizontal.addedBlockId);
      if (newBlockEl) {
        newBlockEl.scrollIntoView({ inline: "nearest", block: "nearest" });
        return;
      }
    }

    if (captured.horizontal.samePlan) grid.scrollLeft = captured.horizontal.left;
  });
}

function disablePendingMoveButtons() {
  if (!state.builder.itemMovePending) return;
  document.querySelectorAll('[data-action="builder-move-item"], [data-action="builder-delete-item"], [data-builder-item-drag]').forEach((button) => {
    button.disabled = true;
    button.title = "Moving...";
  });
}

export function renderBuilder() {
  preserveBuilderItemEdits(state.builder.draft);
  const scrollState = captureBuilderScrollState();
  renderBuilderInner();
  autosizeTextareas(els.content);
  restoreBuilderScrollState(scrollState);
  disablePendingMoveButtons();
  renderBuilderDiscardProgress();
  renderBuilderBatchSwitchProgress();
  renderBuilderDraftOpenProgress();
  if (state.builder.leaving) els.content.querySelector(".builder-workspace")?.setAttribute("inert", "");
  syncK3StickyHeights();
}

// K3 (2.7): what the page scrolls to stops under the sticky band and above the
// sticky Save and link bar, whatever their real height (a long title wraps).
function syncK3StickyHeights() {
  const root = globalThis.document?.documentElement;
  if (!root?.style) return;
  for (const [name, selector] of [["--k3-band-h", ".builder-workspace .k3-band"], ["--k3-save-h", ".k3-save-bar"]]) {
    const el = els.content?.querySelector?.(selector);
    if (el?.offsetHeight) root.style.setProperty(name, `${el.offsetHeight}px`);
    else root.style.removeProperty(name);
  }
}

export function renderBuilderDraftOpenProgress() {
  const pending = state.builder.openingDraftId;
  const start = els.content?.querySelector(".builder-start");
  if (!start) return;
  const panel = start.querySelector(".builder-drafts-panel");
  const status = panel?.querySelector("[data-builder-draft-open-status]");
  if (status) { status.hidden = !pending; status.textContent = pending ? "Opening draft..." : ""; }
  panel?.setAttribute("aria-busy", pending ? "true" : "false");
  start.querySelectorAll('[data-action="builder-open-draft"]').forEach((button) => {
    button.disabled = Boolean(pending);
    button.textContent = pending === button.dataset.planId ? "Opening..." : "Continue";
  });
  // Keep the progress announcement accessible while blocking competing actions.
  const targets = [...start.children].filter((child) => child !== panel);
  const body = panel?.querySelector(".builder-drafts-body");
  if (body) targets.push(body);
  for (const target of targets) {
    if (pending && !target.hasAttribute("inert")) { target.setAttribute("inert", ""); target.dataset.draftOpenInert = "true"; }
    if (!pending && target.dataset.draftOpenInert) { target.removeAttribute("inert"); delete target.dataset.draftOpenInert; }
  }
}

export function renderBuilderBatchSwitchProgress() {
  const pending = state.builder.batchSwitchPending;
  const switcher = els.content?.querySelector(".builder-batch-switcher");
  if (!switcher) return;
  switcher.setAttribute("aria-busy", pending ? "true" : "false");
  const status = switcher.querySelector("[data-builder-batch-status]");
  if (status) {
    status.hidden = !pending;
    status.textContent = pending ? (pending.stage === "saving" ? "Saving changes..." : `Opening ${pending.name}...`) : "";
  }
  switcher.querySelectorAll('[data-action="builder-open-batch-plan"]').forEach((button) => {
    button.disabled = Boolean(pending) || !button.dataset.planId;
  });
  const workspace = els.content.querySelector(".builder-workspace");
  if (!workspace) return;
  for (const child of workspace.children) {
    if (child === switcher) continue;
    if (pending && !child.hasAttribute("inert")) { child.setAttribute("inert", ""); child.dataset.batchInert = "true"; }
    if (!pending && child.dataset.batchInert) { child.removeAttribute("inert"); delete child.dataset.batchInert; }
  }
  const sync = switcher.querySelector('[data-action="builder-toggle-batch-sync"]');
  if (sync) sync.disabled = Boolean(pending);
}

export function renderBuilderDiscardProgress() {
  const pending = Boolean(state.builder.discardingDraftId);
  const status = els.content.querySelector("[data-builder-discard-status]");
  if (status) {
    status.hidden = !pending;
    status.textContent = pending ? "Discarding..." : "";
  }
  const button = els.content.querySelector('[data-action="builder-discard-current-draft"]');
  if (button) {
    button.disabled = pending;
    button.setAttribute("aria-busy", String(pending));
    // The description is the bar's tooltip (B3); a title would show a second, native one.
    button.setAttribute("aria-description", pending ? "Discarding changes..." : "Discard all changes in this draft.");
  }
}

// Dose/instruction edits, move up/down, and delete only change which exercises are
// in the currently open section and their order -- nothing else on screen needs to
// change. Patching just this panel (instead of the full renderBuilder(), which
// replaces the entire screen) means the search input, scroll position, and any
// other field the coach is mid-edit in are never touched by these actions.
// Returns false (caller should fall back to renderBuilder()) if the section editor
// isn't currently open.
export function renderBuilderSectionItems() {
  preserveBuilderItemEdits(state.builder.draft);
  const selectedNode = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
  const container = els.content.querySelector(".builder-section-added");
  if (!container || !selectedNode || selectedNode.type !== "section") return false;

  // A Tab between sibling fields on the same item (e.g. Sets -> Reps) moves focus
  // to the next field synchronously, before this async save even starts -- so by
  // the time we patch the DOM, the field the coach just tabbed into is already
  // focused. Capture and restore it (and the modal's scroll) around the patch so
  // neither gets stolen out from under them.
  const scrollEl = els.content.querySelector(".builder-section-modal");
  const scrollTop = scrollEl ? scrollEl.scrollTop : null;
  const active = document.activeElement;
  const activeForm = active?.closest?.(".builder-item");
  // Three different views can render a .builder-item[data-item-id] at once
  // (compact mobile card, single-item mobile edit form, desktop full form) -
  // on mobile the compact card and the desktop form share the very same
  // item id, and a plain "first match" query after the re-render would
  // silently grab the wrong (CSS-hidden) one instead of the form the coach
  // was actually typing in. Remember which of the three scopes the focused
  // form was inside, and re-query within that same scope only.
  const activeScopeEl = activeForm?.closest?.(".builder-added-list-compact, .builder-item-edit, .builder-added-list-desktop");
  const activeScopeClass = activeScopeEl?.classList.contains("builder-added-list-compact") ? "builder-added-list-compact"
    : activeScopeEl?.classList.contains("builder-item-edit") ? "builder-item-edit"
    : activeScopeEl?.classList.contains("builder-added-list-desktop") ? "builder-added-list-desktop"
    : "";
  const focusState = activeForm && container.contains(activeForm)
    ? { itemId: activeForm.dataset.itemId, fieldName: active.getAttribute("name"), start: active.selectionStart, end: active.selectionEnd, scopeClass: activeScopeClass }
    : null;

  container.innerHTML = renderBuilderAddedPanelContent(state, selectedNode);
  autosizeTextareas(container);
  disablePendingMoveButtons();

  if (scrollEl && scrollTop !== null) scrollEl.scrollTop = scrollTop;
  if (focusState) {
    const scopeEl = (focusState.scopeClass && container.querySelector(`.${focusState.scopeClass}`)) || container;
    const nextForm = scopeEl.querySelector(`.builder-item[data-item-id="${CSS.escape(focusState.itemId)}"]`);
    const nextField = nextForm?.querySelector(`[name="${CSS.escape(focusState.fieldName)}"]`);
    if (nextField) {
      nextField.focus({ preventScroll: true });
      if (typeof nextField.setSelectionRange === "function" && focusState.start !== null) {
        try { nextField.setSelectionRange(focusState.start, focusState.end); } catch {}
      }
    }
  }
  return true;
}

// Called after a successful add (builder-pick-exercise/add-custom-exercise,
// builder-actions.js). Patches exactly three things - the results list's
// "Added N×" badges, the sticky bar's count/thumbnails, and the inline add-
// confirmation banner - none of which share a DOM subtree with the search
// input, quick-dose fields, or filters, so this can never blur/reset them.
// Also refreshes the Added-mode panel (harmless no-op while it's hidden in
// Add-exercises mode) so its data is current whenever the coach does switch
// over. Returns false (caller falls back to renderBuilder()) if the section
// editor isn't open.
// Tile / Big / List switch in the section editor: repaints only the
// switcher and the results, so the quick Sets / Reps / Load fields, the
// search and the filters keep what the coach typed (they are read from the
// DOM when an exercise is added - a full renderBuilder() would clear them).
// Returns false (caller falls back to renderBuilder()) if the section editor
// isn't open.
export function renderBuilderExerciseViewChange() {
  const selectedNode = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
  const panel = els.content?.querySelector(".builder-section-panel");
  const resultsEl = panel?.querySelector(".builder-exercise-results");
  if (!resultsEl || !selectedNode || selectedNode.type !== "section") return false;
  const switcher = panel.querySelector(".builder-library-toolbar .exercise-view-switcher");
  if (switcher) switcher.outerHTML = renderExerciseViewSwitcher("builder", state.builder.exerciseView, "builder-exercise-view");
  resultsEl.innerHTML = renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedNode, { hasMore: state.builder.exerciseHasMore, loading: state.builder.exerciseLoading, failed: state.builder.exerciseLoadFailed, view: state.builder.exerciseView });
  return true;
}

// Filter panel folded / unfolded (phones) or a filter changed: repaints only
// the Filters button (its badge) and the panel's open mark, so the search,
// the quick Sets / Reps / Load and the filters keep what the coach typed.
// Returns false (caller falls back to renderBuilder()) if the section editor
// isn't open.
export function renderBuilderFiltersChange() {
  const panel = els.content?.querySelector(".builder-section-panel");
  const toggle = panel?.querySelector(".builder-filters-toggle");
  if (!toggle) return false;
  const next = builderFiltersToggleState(state.builder.exerciseFilters, state.builder.exerciseFiltersOpen);
  const opened = panel.dataset.filtersOpen !== "true" && next.expanded === "true";
  panel.dataset.filtersOpen = next.expanded;
  // Patched in place (never replaced), so a keyboard user keeps focus on it.
  toggle.className = next.className;
  toggle.setAttribute("aria-expanded", next.expanded);
  toggle.setAttribute("aria-label", next.label);
  toggle.innerHTML = next.inner;
  if (opened) revealBuilderLibraryControls(panel);
  return true;
}

// Landscape phones pin the search row only while the filter panel is closed
// (styles.css); opening it while the editor is scrolled down would put the
// panel - and the Filters button just tapped - back above the visible part.
// The editor is scrolled up to it then (below a pinned header, if any);
// nothing moves when it is already in view.
function revealBuilderLibraryControls(panel) {
  const modal = panel.closest?.(".builder-section-modal");
  const controls = panel.querySelector(".builder-library-controls");
  if (!modal || !controls) return;
  const head = panel.querySelector(".builder-section-panel-head");
  const headHeight = head && globalThis.getComputedStyle?.(head).position === "sticky" ? head.getBoundingClientRect().height : 0;
  const top = controls.getBoundingClientRect().top - modal.getBoundingClientRect().top + modal.scrollTop - headHeight;
  if (modal.scrollTop > top) modal.scrollTop = Math.max(0, top);
}

export function renderBuilderAddFeedback() {
  const selectedNode = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
  const panel = els.content.querySelector(".builder-section-panel");
  if (!panel || !selectedNode || selectedNode.type !== "section") return false;

  panel.dataset.mobileMode = state.builder.mobileMode;

  const resultsEl = panel.querySelector(".builder-exercise-results");
  if (resultsEl) resultsEl.innerHTML = renderBuilderExerciseResults(state.builder.exercises, state.markedExerciseIds, selectedNode, { hasMore: state.builder.exerciseHasMore, loading: state.builder.exerciseLoading, failed: state.builder.exerciseLoadFailed, view: state.builder.exerciseView });

  const confirmationSlot = panel.querySelector(".builder-add-confirmation");
  const confirmationHtml = renderBuilderAddConfirmation(state.builder.addConfirmation);
  if (confirmationSlot) {
    if (confirmationHtml) confirmationSlot.outerHTML = confirmationHtml;
    else confirmationSlot.remove();
  } else if (confirmationHtml && resultsEl) {
    resultsEl.insertAdjacentHTML("beforebegin", confirmationHtml);
  }

  const stickyEl = panel.querySelector(".builder-mobile-sticky-bar");
  if (stickyEl) stickyEl.outerHTML = renderBuilderStickyBar(selectedNode, state.builder.mobileMode);

  renderBuilderSectionItems();
  return true;
}

function renderBuilderInner() {
  const draft = state.builder.draft;
  const draftBatchPlans = Array.isArray(draft?.batch?.plans) ? draft.batch.plans : [];
  els.context.textContent = "Program builder";
  els.title.textContent = draft
    ? (draftBatchPlans.length + (Number(draft?.batch?.hiddenCount) || 0) > 1
      ? "Group builder"
      : (draft.plan.athleteName || (draft.plan.isTemplate ? "Reusable template" : "Draft")))
    : "New program";
  els.toolbar.innerHTML = "";
  if (!draft && !state.builder.entryType) {
    els.content.innerHTML = `
      <section class="content-section builder-start">
        ${renderBuilderDraftsPanel()}
        ${renderBuilderEntryTiles()}
      </section>
    `;
    return;
  }
  const k3 = state.builder.k3 || null;
  // K3: after Save and link the draft is gone; the band and the outcome stay.
  if (k3?.saved) {
    els.content.innerHTML = renderK3SavedHtml(k3);
    return;
  }
  // K2c-3: the week's events are read once per plan, week and athletes.
  ensureBuilderEvents();
  if (!draft) {
    const selectedAthleteIds = new Set((state.builder.createAthleteIds || []).map(String));
    const assignedAthletes = state.athletes.filter((athlete) => selectedAthleteIds.has(String(athlete.athlete_id)));
    const assignedAthlete = assignedAthletes[0];
    const selectedCount = assignedAthletes.length;
    const isWeekly = state.builder.planType === "weekly";
    const isTemplate = state.builder.entryType === "template";
    const weekStart = state.builder.weekStart || weekMondayIso(localDateIso());
    const heading = isWeekly ? "Create weekly plan" : (isTemplate ? "Create template" : "Create program");
    const subtitle = isWeekly
      ? "Choose an athlete and the week to plan."
      : (isTemplate ? "Reusable across athletes - leave it unassigned." : "Assign an athlete to build a program just for them.");
    const athleteTitle = selectedCount > 1
      ? `${selectedCount} athletes selected`
      : assignedAthlete?.athlete || (isWeekly ? "Choose athlete" : "Choose athlete or template");
    const athleteSubtitle = selectedCount > 1
      ? "Build once for all selected athletes, then fine-tune each copy."
      : assignedAthlete ? `ID ${assignedAthlete.athlete_id}` : "";
    els.content.innerHTML = `
      <section class="content-section builder-start">
        ${renderBuilderDraftsPanel()}
        <section class="panel builder-setup-card">
          <div class="section-heading">
            <div><button class="text-action builder-entry-back" type="button" data-action="builder-entry-back">&larr; Back</button><p class="eyebrow">Program builder</p><h3>${heading}</h3><p class="muted">${subtitle}</p></div>
          </div>
          <form class="builder-form builder-create-form" data-builder-form="create">
            <div class="builder-details-row">
              <label class="search-field"><span>${isWeekly ? "Weekly plan name (optional)" : "Program name"}</span><input name="name" ${isWeekly ? "" : "required"} value="${escapeAttr(state.builder.createName)}" placeholder="${isWeekly ? "e.g. Match week" : "e.g. Preseason strength block"}"></label>
              <div class="search-field builder-create-color-field"><span>Color</span>${renderPastelSwatches("color", state.builder.createColor, { allowCustom: true })}</div>
            </div>
            ${isWeekly ? "" : `<label class="search-field"><span>Cover image URL (optional)</span><input name="coverImageUrl" type="url" placeholder="https://..."></label>`}
            ${isTemplate ? renderTemplateKindFieldsHtml(state.builder.createTemplateKind) : ""}
            <input type="hidden" name="planType" value="${isWeekly ? "weekly" : "program"}">
            <input type="hidden" name="athleteId" value="${escapeAttr(state.builder.createAthleteId)}">
            ${isWeekly ? `<label class="search-field builder-week-start"><span>Any date in the planned week</span><input name="weekStart" data-builder-week-start type="date" value="${escapeAttr(weekStart)}" required><small>The weekly plan will begin on Monday ${escapeHtml(formatDate(weekStart))}.</small></label>` : ""}
            <div class="builder-assignment-row"><span class="builder-field-label">Athlete</span><button class="builder-athlete-trigger" type="button" data-action="builder-open-athlete-picker">
              ${assignedAthlete?.athlete_image_url || assignedAthlete?.image_url ? renderImage(assignedAthlete.athlete_image_url || assignedAthlete.image_url, "builder-athlete-avatar") : `<span class="builder-athlete-trigger-icon">${assignedAthlete ? escapeHtml(initialsFor(assignedAthlete.athlete)) : "+"}</span>`}<span><strong>${escapeHtml(athleteTitle)}</strong>${athleteSubtitle ? `<small>${escapeHtml(athleteSubtitle)}</small>` : ""}</span><span class="button-icon">></span>
            </button></div>
            ${state.builder.showNote ? `<label class="search-field"><span>Program note</span><textarea name="note" rows="2" placeholder="Optional coaching note"></textarea></label>` : `<button class="text-action builder-note-toggle" type="button" data-action="builder-toggle-note">Add note</button>`}
            <p class="builder-private-note">${isWeekly ? "Weekly plans are always assigned to the selected athlete." : "Private to your coach account until sharing and publishing are configured."}</p>
            <p class="builder-error" aria-live="polite"></p>
            <button class="plain-button builder-create-button" type="submit">${isWeekly ? "Create weekly plan" : "Create draft"}</button>
          </form>
        </section>
        ${state.builder.athletePickerOpen ? renderBuilderAthletePicker(state) : ""}
      </section>
    `;
    return;
  }

  const selectedSession = findBuilderSession(draft, state.builder.selectedSessionId);
  const selectedNode = findBuilderNode(draft, state.builder.selectedNodeId);
  const isWeekly = draft.plan.planType === "weekly";
  const isEditDraft = Boolean(draft.plan.isEditDraft);
  // A weekly program template (docs/ai/weekly-program-template-plan.md): one
  // template week on screen at a time, chosen in the week strip.
  const isWeeklyTemplate = isWeeklyTemplateDraft(draft);
  const shownBlocks = isWeeklyTemplate ? templateWeekBlocks(draft, currentTemplateWeek(state)) : draft.blocks;
  const saveLabel = "Save";
  const structureContext = builderStructureContext();
  const batchPlans = Array.isArray(draft.batch?.plans) ? draft.batch.plans : [];
  const batchIndex = batchPlans.findIndex((plan) => String(plan.id) === String(draft.plan.id));
  const hasBatch = batchPlans.length > 1 && batchIndex >= 0;
  // A reopened, published member of a group (an edit draft) is not in the
  // batch's list (loadBuilderBatch leaves edit drafts out), so no switcher is
  // drawn for it; say plainly that its changes reach this athlete only.
  // The group's size counts the members this coach may not open too (the
  // server sends them only as hiddenCount).
  const hiddenCount = Number(draft.batch?.hiddenCount) || 0;
  const isEditDraftOfBatch = isEditDraft && batchPlans.length + hiddenCount > 1 && !hasBatch
    && batchPlans.some((plan) => String(plan.id) === String(draft.plan.editSourcePlanId || ""));
  // Step 2: a reopened WEEKLY member asks at Save who gets the changes (the
  // panel below); a program batch keeps "Changes go to this athlete only."
  // Only when another member the coach may open could get the change (the
  // same rule as isBatchEditDraft in builder-actions.js); otherwise "Changes
  // go to this athlete only." and the hidden members' sentence.
  const batchEditPanel = isEditDraftOfBatch && isWeekly && batchPlans.length > 1 ? renderBuilderBatchEditPanel(draft, batchPlans) : "";
  if (batchEditPanel && state.builder.batchEditChoice?.stage === "done") {
    els.content.innerHTML = `<section class="content-section builder-workspace">${batchEditPanel}</section>`;
    return;
  }
  els.content.innerHTML = `
    <section class="content-section builder-workspace${k3 ? " has-k3" : ""}">
      ${k3 ? renderK3BandHtml(k3) : ""}
      ${k3 ? renderK3OutcomeHtml(k3) : ""}
      <header class="builder-program-bar">
        <div><p class="eyebrow">${isEditDraft ? "Editing original" : isWeekly ? "Weekly plan" : isWeeklyTemplate ? `Weekly program · ${Number(draft.plan.weekCount) || 1} week${Number(draft.plan.weekCount) === 1 ? "" : "s"}` : (draft.plan.isTemplate ? "Reusable template" : "Athlete program")}</p><form class="builder-plan-name-inline" data-builder-form="update-plan" data-builder-autosave><input name="name" class="builder-plan-title-input" value="${escapeAttr(draft.plan.name || "")}" placeholder="${isWeekly ? "e.g. Match week" : "Program name"}" aria-label="${isWeekly ? "Weekly plan name" : "Program name"}">${isWeekly ? "" : `<input name="coverImageUrl" type="url" class="builder-plan-cover-input" value="${escapeAttr(draft.plan.coverImageUrl || "")}" placeholder="Cover image URL (optional)" aria-label="Cover image URL">`}</form><p class="muted">${escapeHtml(isEditDraft ? "Changes are saved only when applied." : draft.plan.athleteName || "Private coach template")}</p></div>
        <div class="builder-program-actions">
          <span class="item-badge builder-status-chip${isEditDraft || (draft.plan.status || "draft") === "draft" ? " is-draft" : ""}">${isEditDraft ? "edit draft" : escapeHtml(draft.plan.status || "draft")}</span>
          <button class="plain-button icon-button builder-exit-button" type="button" data-action="builder-cancel" aria-label="Exit" aria-description="Exit and keep this draft for later.">${ICON_DOOR_EXIT}</button>
          ${draft.plan.isTemplate && !isWeekly && !isWeeklyTemplate ? `<button class="plain-button builder-assign-button" type="button" data-action="builder-duplicate-plan" data-plan-id="${escapeAttr(draft.plan.id)}" data-plan-type="program" data-intent="assign" data-is-edit-draft="${isEditDraft ? "true" : "false"}">${ICON_CHECK}<span>Assign to athlete</span></button>` : ""}
          ${draft.plan.status === "draft" && !k3 ? `<button class="plain-button icon-button builder-finish-button" type="button" data-action="builder-submit-plan" aria-label="${saveLabel}" aria-description="${isEditDraft ? "Apply changes to the original plan." : "Save and finish — marks this plan as active."}">${ICON_CHECK}</button>` : `<span class="builder-finished-label">Saved</span>`}
          ${draft.plan.status === "draft" ? `<button class="plain-button icon-button danger-action" type="button" data-action="builder-discard-current-draft" aria-label="Discard changes" aria-description="Discard all changes in this draft.">${ICON_X}</button>` : ""}
          <span class="builder-discard-status" data-builder-discard-status role="status" aria-live="polite" hidden></span>
        </div>
      </header>
      ${renderBuilderSessionsLockedHtml()}
      ${state.builder.assignResult ? renderBuilderAssignResultBanner(state.builder.assignResult) : ""}
      ${hasBatch ? renderBuilderBatchSwitcher(batchPlans, batchIndex)
        : batchEditPanel ? batchEditPanel + (hiddenCount > 0 ? `<p class="builder-batch-hidden-alone">${renderBuilderBatchHiddenNote(hiddenCount)}</p>` : "")
        : isEditDraftOfBatch ? renderBuilderEditDraftBatchNote() + (hiddenCount > 0 ? `<p class="builder-batch-hidden-alone">${renderBuilderBatchHiddenNote(hiddenCount)}</p>` : "")
        : batchIndex >= 0 && hiddenCount > 0 ? `<p class="builder-batch-hidden-alone">${renderBuilderBatchHiddenNote(hiddenCount)}</p>` : ""}
      ${state.builder.clipboard?.type ? `<div class="builder-copy-hint"><span>Copied ${escapeHtml(state.builder.clipboard.type === "cross-plan-block" ? "block" : state.builder.clipboard.type)}: <strong>${escapeHtml(state.builder.clipboard.name)}</strong>${state.builder.clipboard.itemCount ? ` (${state.builder.clipboard.itemCount} exercises)` : ""}</span><button class="text-action" type="button" data-action="builder-clear-clipboard">Clear</button></div>` : ""}
      ${isWeekly ? renderBuilderTrainingLoadSettings(draft) : ""}
      <div class="builder-layout">
        <section class="panel builder-outline">
          <div class="section-heading">
            <div><p class="eyebrow">Day and session structure</p><h3>${isWeekly ? "Seven-day plan" : isWeeklyTemplate ? `Week ${currentTemplateWeek(state)}` : "Blocks and sessions"}</h3></div>
            <div class="builder-outline-info-buttons">
              ${isWeekly ? renderImportBlockIconButton() : `<button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="program" aria-label="Program example"><span class="button-icon" aria-hidden="true">i</span><span class="builder-info-label">Program example</span></button>`}
              <button class="plain-button icon-button builder-info-button" type="button" data-action="builder-open-info" data-info="session" aria-label="Session example"><span class="button-icon" aria-hidden="true">i</span><span class="builder-info-label">Session example</span></button>
            </div>
          </div>
          ${isWeeklyTemplate ? renderTemplateWeekStripHtml(state) : ""}
          ${draft.blocks.length || !isWeekly ? `
            <div class="builder-block-grid">
              ${shownBlocks.map((block) => renderBuilderBlock(block, selectedSession?.id, selectedNode?.id, isWeekly, structureContext)).join("")}
              ${isWeekly || isWeeklyTemplate ? "" : renderBuilderAddBlockCard(structureContext)}
            </div>
          ` : `
            <div class="empty builder-outline-empty">
              <span class="builder-outline-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg></span>
              <strong>No days or blocks yet</strong>
              <p class="muted">Use the form above to add the first day or block, then build sessions inside it.</p>
            </div>`}
        </section>
      </div>
      ${k3 ? renderK3SaveBarHtml(k3, draft) : ""}
      ${renderBuilderEventsAskHtml()}
      ${state.builder.structureModalOpen && selectedSession ? renderBuilderStructureModal(selectedSession, selectedNode, structureContext) : ""}
      ${selectedNode?.type === "section" ? renderBuilderSectionOverlay(state, selectedNode) : ""}
      ${state.builder.infoOpen ? renderBuilderInfoModal(state.builder.infoOpen) : ""}
      ${renderCopyPlanModal(state)}
      ${renderOverwriteDayConfirmHtml(state)}
      ${renderBlockPickerModal(state)}
    </section>
  `;
}

// The create form of a template: Blocks (a program of named blocks) or a
// Weekly program (whole weeks of seven days, assigned from a date).
function renderTemplateKindFieldsHtml(kind) {
  const weekly = kind === "weekly";
  return `
    <fieldset class="builder-template-kind">
      <legend class="builder-field-label">Template type</legend>
      <label class="builder-template-kind-option"><input type="radio" name="templateKind" value="weekly" data-builder-template-kind ${weekly ? "checked" : ""}><span><strong>Weekly program</strong><small>Weeks of seven days. Assigned from a date into athletes' weekly plans.</small></span></label>
      <label class="builder-template-kind-option"><input type="radio" name="templateKind" value="blocks" data-builder-template-kind ${weekly ? "" : "checked"}><span><strong>Blocks</strong><small>Named blocks of sessions, in any order.</small></span></label>
      ${weekly ? `<label class="search-field builder-template-weeks"><span>Number of weeks</span><input name="weeks" type="number" min="1" max="52" value="4" required><small>You can add, duplicate or remove weeks later.</small></label>` : ""}
    </fieldset>
  `;
}

export function renderBuilderAssignResultBanner(result) {
  const entries = result.entries || [];
  return `
    <div class="builder-copy-hint builder-assign-result">
      <span>Assigned to ${entries.length} athlete${entries.length === 1 ? "" : "s"} - the template is unchanged and stays open.</span>
      <div class="builder-assign-result-links">
        ${entries.map((entry) => `<button class="plain-button compact-button" type="button" data-action="builder-edit-plan" data-plan-id="${escapeAttr(entry.planId)}">Open ${escapeHtml(entry.athleteName)}'s program</button>`).join("")}
      </div>
      <button class="text-action" type="button" data-action="builder-dismiss-assign-result">Dismiss</button>
    </div>
  `;
}
