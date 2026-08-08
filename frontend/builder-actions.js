import { api } from "./api.js";
import { invalidateBuilderDraftsCache, loadBuilderNodePresets } from "./builder-data.js";
import { findBuilderNode, findBuilderSession } from "./builder-helpers.js";
import { invalidateCoachHomeCache } from "./coach-home-data.js";
import { emptyBuilderState, state } from "./state.js";
import { localDateIso, weekMondayIso } from "./utils.js";

// After adding an exercise, jump straight to it in the "Added to section" strip
// instead of leaving the coach to scroll/search for it themselves. Blurring first
// matters on mobile: the added-items strip is hidden by CSS while focus stays
// inside the exercise library, so without this it would try to scroll to a
// panel that's still display:none.
function scrollToLastAddedItem(nodeId) {
  const node = findBuilderNode(state.builder.draft, nodeId);
  const lastItem = node?.items?.at(-1);
  if (!lastItem) return;
  const active = document.activeElement;
  if (active?.closest?.(".builder-section-library")) active.blur();
  requestAnimationFrame(() => {
    const el = document.querySelector(`.builder-section-added [data-item-id="${CSS.escape(lastItem.id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  });
}

function renderBuilderPreservingAthleteListScroll(handlers) {
  const list = document.querySelector("[data-builder-athlete-list]");
  const scrollTop = list?.scrollTop || 0;
  handlers.renderBuilder();
  const nextList = document.querySelector("[data-builder-athlete-list]");
  if (nextList) nextList.scrollTop = scrollTop;
}

function resetBuilderCopyState() {
  state.builder.copyPlanId = "";
  state.builder.copyPlanName = "";
  state.builder.copyAthleteId = "";
  state.builder.copyAthleteIds = [];
  state.builder.copyPlanType = "program";
  state.builder.copyWeekStart = "";
}

function getBuilderBatchId(draft = state.builder.draft) {
  return (
    draft?.batch?.id ||
    draft?.plan?.batchId ||
    draft?.plan?.builderBatchId ||
    draft?.plan?.builder_batch_id ||
    ""
  );
}

function shouldSyncBuilderBatch() {
  const batchPlans = state.builder.draft?.batch?.plans || [];
  return Boolean(state.builder.batchSync && (batchPlans.length > 1 || getBuilderBatchId()));
}

function setBuilderDraft(nextDraft, options = {}) {
  if (!nextDraft) {
    state.builder.draft = nextDraft;
    return nextDraft;
  }
  const previousDraft = state.builder.draft;
  const previousBatch = previousDraft?.batch;
  const previousBatchId = getBuilderBatchId(previousDraft);
  state.builder.draft = nextDraft;
  if (
    options.preserveBatch !== false &&
    previousBatch?.plans?.length > 1 &&
    !(state.builder.draft.batch?.plans?.length > 1)
  ) {
    state.builder.draft.batch = previousBatch;
  }
  if (previousBatchId && state.builder.draft?.plan && !getBuilderBatchId(state.builder.draft)) {
    state.builder.draft.plan.batchId = previousBatchId;
  }
  return state.builder.draft;
}

function withBatchSyncPayload(payload = {}) {
  return shouldSyncBuilderBatch() ? { ...payload, syncBatch: true } : payload;
}

// Builder mutations (rename, move, dose/instruction edits, ...) all replace the
// whole draft with whatever the server returns. If two of these are in flight at
// once, their responses can land out of order and the older one silently reverts
// the newer edit. Running them through a single queue keeps requests -- and their
// responses -- in submission order, so nothing gets clobbered.
let builderMutationQueue = Promise.resolve();
function queuedBuilderApi(url, options) {
  const result = builderMutationQueue.then(() => api(url, options));
  builderMutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function withBatchSyncUrl(url) {
  return shouldSyncBuilderBatch() ? `${url}${url.includes("?") ? "&" : "?"}syncBatch=1` : url;
}

function isNotFoundError(error) {
  return error?.status === 404 || /not found/i.test(error?.message || "");
}

function forgetBatchPlan(planId) {
  const batch = state.builder.draft?.batch;
  if (!batch?.plans) return;
  batch.plans = batch.plans.filter((plan) => String(plan.id) !== String(planId));
}

async function exitBuilderToPlanContext(plan, handlers) {
  state.builder = emptyBuilderState();
  state.navStack = [];
  if (plan?.athleteId) state.selectedAthleteId = String(plan.athleteId);
  if (plan?.planType === "weekly") {
    state.activeTab = "weekly";
    state.weekSelectorOpen = false;
    handlers.renderTabs();
    handlers.renderLibraryNav();
    // Same reasoning as the templates branch below - this exit always
    // follows a delete/submit/save that can change what Calendar shows for
    // this exact athlete; never trust a cached pre-exit payload here.
    await handlers.loadWeekly({ forceRefresh: true });
    // Home's "today" overview (GET /api/athletes/today) is a same-day
    // rollup of exactly this data across every athlete, not just this one -
    // invalidate rather than force-load, since Home is very likely not even
    // the active tab right now; the next time it IS entered, it must not
    // still show pre-mutation counts.
    invalidateCoachHomeCache();
    return;
  }
  if (plan?.isTemplate || !plan?.athleteId) {
    state.activeTab = "templates";
    handlers.renderTabs();
    handlers.renderLibraryNav();
    // Every path into exitBuilderToPlanContext follows a delete/submit/save
    // that can change this plan's row in the template list - never trust a
    // cached pre-exit list here.
    await handlers.loadTemplates({ forceRefresh: true });
    return;
  }
  state.activeTab = "programs";
  handlers.renderTabs();
  handlers.renderLibraryNav();
  // Same reasoning as the weekly branch above - this exit always follows a
  // delete/submit/save that can change this exact athlete's specific-program
  // list; never trust a cached pre-exit payload here.
  await handlers.loadPrograms({ forceRefresh: true });
}

export async function handleBuilderPlanAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-edit-plan") {
    const planId = action.dataset.planId || "";
    const batchPlans = state.builder.draft?.batch?.plans || [];
    const isBatchPlanSwitch = batchPlans.some((plan) => String(plan.id) === String(planId));
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}/edit`, { method: "POST" }), {
        preserveBatch: isBatchPlanSwitch,
      });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      if (isNotFoundError(error)) {
        forgetBatchPlan(planId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  if (type === "builder-duplicate-plan") {
    state.builder.copyPlanId = action.dataset.planId || "";
    state.builder.copyPlanName = action.closest(".section-heading")?.querySelector("h3")?.textContent || "Program";
    state.builder.copyAthleteId = "";
    state.builder.copyAthleteIds = [];
    state.builder.copyPlanType = action.dataset.planType === "weekly" ? "weekly" : "program";
    state.builder.copyWeekStart = state.builder.copyPlanType === "weekly" ? weekMondayIso(localDateIso()) : "";
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-close-copy-plan") {
    resetBuilderCopyState();
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-select-copy-athlete") {
    const athleteId = action.dataset.athleteId || "";
    if (!athleteId) {
      state.builder.copyAthleteIds = [];
      state.builder.copyAthleteId = "";
    } else {
      const current = new Set((state.builder.copyAthleteIds || []).map(String));
      if (current.has(String(athleteId))) current.delete(String(athleteId));
      else current.add(String(athleteId));
      state.builder.copyAthleteIds = [...current];
      state.builder.copyAthleteId = state.builder.copyAthleteIds[0] || "";
    }
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-confirm-duplicate-plan") {
    action.disabled = true;
    try {
      const athleteIds = state.builder.copyAthleteIds?.length
        ? state.builder.copyAthleteIds
        : (state.builder.copyAthleteId ? [state.builder.copyAthleteId] : []);
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(state.builder.copyPlanId)}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ athleteId: athleteIds[0] || "", athleteIds, weekStart: state.builder.copyWeekStart }),
      }), { preserveBatch: false });
      // /duplicate always creates a brand new status='draft' row (see
      // backend/src/routes/builder.js) - the cached drafts list must never
      // be missing it just because it happened to be cached before this copy.
      invalidateBuilderDraftsCache();
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      resetBuilderCopyState();
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      if (isNotFoundError(error)) {
        forgetBatchPlan(state.builder.copyPlanId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  if (type === "builder-open-draft") {
    const planId = action.dataset.planId || "";
    if (!planId) return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}`));
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      void loadBuilderNodePresets().catch(() => {});
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-discard-draft") {
    const planIds = (action.dataset.planIds || "").split(",").filter(Boolean);
    if (!planIds.length) return true;
    const confirmLabel = planIds.length > 1 ? "this draft for all selected athletes" : "this draft";
    if (!window.confirm(`Discard ${confirmLabel}? This cannot be undone.`)) return true;
    action.disabled = true;
    for (const id of planIds) {
      await api(`/api/builder/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
    }
    state.builder.selectedDraftKeys = [];
    // Just deleted one or more drafts - the cached drafts list must never
    // keep showing them.
    await handlers.loadBuilderDrafts({ forceRefresh: true });
    return true;
  }
  if (type === "builder-toggle-drafts-panel") {
    state.builder.draftsOpen = !state.builder.draftsOpen;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-select-draft") {
    const groupKey = action.dataset.groupKey || "";
    if (!groupKey) return true;
    const current = new Set(state.builder.selectedDraftKeys || []);
    if (current.has(groupKey)) current.delete(groupKey);
    else current.add(groupKey);
    state.builder.selectedDraftKeys = [...current];
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-select-all-drafts") {
    const groupKeys = (state.builder.drafts || []).map((item) => item.groupKey).filter(Boolean);
    const selected = new Set(state.builder.selectedDraftKeys || []);
    const allSelected = groupKeys.length > 0 && groupKeys.every((key) => selected.has(key));
    state.builder.selectedDraftKeys = allSelected ? [] : groupKeys;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-discard-selected-drafts") {
    const selected = new Set(state.builder.selectedDraftKeys || []);
    const selectedDrafts = (state.builder.drafts || []).filter((item) => selected.has(item.groupKey));
    if (!selectedDrafts.length) return true;
    if (!window.confirm(`Discard ${selectedDrafts.length} selected draft${selectedDrafts.length === 1 ? "" : "s"}? This cannot be undone.`)) return true;
    action.disabled = true;
    for (const item of selectedDrafts) {
      for (const id of item.planIds || []) {
        await api(`/api/builder/plans/${encodeURIComponent(id)}`, { method: "DELETE" });
      }
    }
    state.builder.selectedDraftKeys = [];
    // Just deleted one or more drafts - the cached drafts list must never
    // keep showing them.
    await handlers.loadBuilderDrafts({ forceRefresh: true });
    return true;
  }
  if (type === "builder-open-batch-plan") {
    const planId = action.dataset.planId || "";
    if (!planId || String(state.builder.draft?.plan?.id) === String(planId)) return true;
    action.disabled = true;
    try {
      const batchPlans = state.builder.draft?.batch?.plans || [];
      if (batchPlans.length && !batchPlans.some((plan) => String(plan.id) === String(planId))) {
        action.disabled = false;
        state.builder.error = "";
        handlers.renderBuilder();
        return true;
      }
      setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(planId)}`));
      state.builder.error = "";
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      await handlers.loadBuilderExercises();
    } catch (error) {
      action.disabled = false;
      if (isNotFoundError(error)) {
        forgetBatchPlan(planId);
        state.builder.error = "That athlete copy is no longer available in this group.";
        handlers.renderBuilder();
        return true;
      }
      throw error;
    }
    return true;
  }
  return false;
}

export async function handleBuilderWorkspaceAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-toggle-batch-sync") {
    state.builder.batchSync = Boolean(action.checked);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-set-plan-type") {
    state.builder.planType = action.dataset.planType === "weekly" ? "weekly" : "program";
    state.builder.weekStart ||= weekMondayIso(localDateIso());
    state.builder.athletePickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-info") {
    state.builder.infoOpen = action.dataset.info || "session";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-info") {
    state.builder.infoOpen = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-session-quick-add") {
    const blockId = action.dataset.blockId || "";
    state.builder.sessionQuickAdd = state.builder.sessionQuickAdd.blockId === blockId
      ? { blockId: "", amPm: "", bta: "", time: "" }
      : { blockId, amPm: "", bta: "", time: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-pick-session-am-pm") {
    const value = action.dataset.value || "";
    state.builder.sessionQuickAdd.amPm = state.builder.sessionQuickAdd.amPm === value ? "" : value;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-pick-session-bta") {
    const value = action.dataset.value || "";
    state.builder.sessionQuickAdd.bta = state.builder.sessionQuickAdd.bta === value ? "" : value;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-quick-add-session") {
    const blockId = action.dataset.blockId || "";
    const { amPm, bta, time } = state.builder.sessionQuickAdd;
    const payload = withBatchSyncPayload({ amPm, bta, time });
    const draft = setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(blockId)}/sessions`, { method: "POST", body: JSON.stringify(payload) }));
    const updatedBlock = draft?.blocks.find((block) => block.id === blockId);
    state.builder.selectedSessionId = updatedBlock?.sessions.at(-1)?.id || state.builder.selectedSessionId;
    state.builder.selectedNodeId = "";
    state.builder.sessionQuickAdd = { blockId: "", amPm: "", bta: "", time: "" };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-structure-modal") {
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-custom-exercise") {
    const doseInputs = document.querySelectorAll("[data-builder-new-dose]");
    const dose = { sets: "", reps: "", load: "" };
    doseInputs.forEach((input) => {
      if (input.name in dose) dose[input.name] = input.value;
    });
    state.builder.customExerciseDose = dose;
    state.builder.customExerciseOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-custom-exercise") {
    state.builder.customExerciseOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-copy-node") {
    const node = findBuilderNode(state.builder.draft, action.dataset.nodeId || state.builder.selectedNodeId);
    if (!node) return true;
    state.builder.clipboard = { type: node.type, nodeId: node.id, name: node.name, itemCount: node.items.length };
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-clear-clipboard") {
    state.builder.clipboard = null;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-paste-node") {
    const clipboard = state.builder.clipboard;
    if (!clipboard) return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(clipboard.nodeId)}/copy`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ targetSessionId: action.dataset.sessionId, targetParentId: action.dataset.parentId || "" })),
      }));
      state.builder.selectedSessionId = action.dataset.sessionId || "";
      state.builder.selectedNodeId = "";
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-move-node") {
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}/move`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ direction: action.dataset.direction || "" })),
      }));
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      throw error;
    }
    return true;
  }
  if (type === "builder-finish-section") {
    state.builder.selectedNodeId = "";
    state.builder.customExerciseOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-note") {
    state.builder.showNote = !state.builder.showNote;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-athlete-picker") {
    state.builder.athletePickerOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-athlete-picker") {
    state.builder.athletePickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-athlete") {
    const athleteId = action.dataset.athleteId || "";
    if (!athleteId) {
      state.builder.createAthleteIds = [];
      state.builder.createAthleteId = "";
    } else {
      const current = new Set((state.builder.createAthleteIds || []).map(String));
      if (current.has(String(athleteId))) current.delete(String(athleteId));
      else current.add(String(athleteId));
      state.builder.createAthleteIds = [...current];
      state.builder.createAthleteId = state.builder.createAthleteIds[0] || "";
    }
    renderBuilderPreservingAthleteListScroll(handlers);
    return true;
  }
  if (type === "builder-toggle-select-all-athletes") {
    const athleteIds = (state.athletes || []).map((athlete) => String(athlete.athlete_id)).filter(Boolean);
    const selectedIds = new Set((state.builder.createAthleteIds || []).map(String));
    const allSelected = athleteIds.length > 0 && athleteIds.every((id) => selectedIds.has(id));
    state.builder.createAthleteIds = allSelected ? [] : athleteIds;
    state.builder.createAthleteId = state.builder.createAthleteIds[0] || "";
    renderBuilderPreservingAthleteListScroll(handlers);
    return true;
  }
  if (type === "builder-confirm-athlete-picker") {
    state.builder.athletePickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-section-panel") {
    state.builder.sectionPickerOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-section-panel") {
    state.builder.sectionPickerOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-start-inline-add") {
    state.builder.inlineAddSessionId = action.dataset.sessionId || "";
    state.builder.inlineAddParentId = action.dataset.parentId || "";
    state.builder.inlineAddType = action.dataset.nodeType || "domain";
    state.builder.inlineAddOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-cancel-inline-add") {
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-add-block") {
    state.builder.blockAddOpen = !state.builder.blockAddOpen;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-copy-block") {
    const blockId = action.dataset.blockId || "";
    const block = (state.builder.draft?.blocks || []).find((candidate) => candidate.id === blockId);
    if (!block) return true;
    state.builder.clipboard = { type: "block", blockId: block.id, name: block.name || `Block ${block.index}` };
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-paste-block") {
    const clipboard = state.builder.clipboard;
    if (!clipboard || clipboard.type !== "block") return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(clipboard.blockId)}/copy`, { method: "POST" }));
      state.builder.blockAddOpen = false;
      handlers.renderBuilder();
    } catch (error) {
      action.disabled = false;
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-toggle-section-preview") {
    const nodeId = action.dataset.nodeId || "";
    state.builder.previewSectionId = state.builder.previewSectionId === nodeId ? "" : nodeId;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-toggle-node-edit") {
    const nodeId = action.dataset.nodeId || "";
    state.builder.editNodeOpen = state.builder.editNodeOpen === nodeId ? "" : nodeId;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-session") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.sectionPickerOpen = false;
    state.builder.addNodeOpen = false;
    state.builder.structureModalOpen = false;
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-node") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = action.dataset.nodeId || "";
    state.builder.sectionPickerOpen = findBuilderNode(state.builder.draft, state.builder.selectedNodeId)?.type === "section";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = !state.builder.sectionPickerOpen;
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
    handlers.renderBuilder();
    return true;
  }
  return false;
}

export async function handleBuilderDraftAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-submit-plan") {
    const draft = state.builder.draft;
    if (!draft) return true;
    action.disabled = true;
    try {
      const currentDraft = state.builder.draft || draft;
      const result = await api(`/api/builder/plans/${encodeURIComponent(currentDraft.plan.id)}/submit`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({})),
      });
      // This plan has left 'draft' status either way - the cached drafts
      // list (see loadBuilderDrafts) must never keep showing it once the
      // user next lands on that empty-state picker.
      invalidateBuilderDraftsCache();
      if (result?.deleted && result?.empty) {
        await exitBuilderToPlanContext(draft.plan, handlers);
        return true;
      }
      setBuilderDraft(result);
      handlers.renderBuilder();
    } catch (error) {
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-cancel") {
    const plan = state.builder.draft?.plan;
    if (plan?.isEditDraft) {
      if (!window.confirm("Discard these changes and keep the original unchanged?")) return true;
      await api(`/api/builder/plans/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
    }
    await exitBuilderToPlanContext(plan, handlers);
    return true;
  }
  if (type === "builder-delete-source-plan") {
    const planId = action.dataset.planId || "";
    const objectLabel = action.dataset.objectLabel || "program";
    if (!planId || !window.confirm(`Delete this ${objectLabel} and all of its contents? This cannot be undone.`)) return true;
    action.disabled = true;
    await api(`/api/builder/plans/${encodeURIComponent(planId)}`, { method: "DELETE" });
    if (state.activeTab === "weekly") {
      state.weekSelectorOpen = false;
      // Just deleted this plan - the cached Calendar payload for this
      // athlete must never keep showing it.
      await handlers.loadWeekly({ forceRefresh: true });
      // Home's "today" overview rolls up exactly this data across every
      // athlete - invalidate so the next visit reflects the deletion,
      // whether or not Home happens to be the active tab right now.
      invalidateCoachHomeCache();
    } else if (state.activeTab === "programs") {
      state.selectedProgramId = null;
      // Just deleted this plan - the cached specific-programs payload for
      // this athlete must never keep showing it.
      await handlers.loadPrograms({ forceRefresh: true });
    } else {
      state.selectedTemplateId = null;
      // Just deleted this plan - the cached list must never keep showing it.
      await handlers.loadTemplates({ forceRefresh: true });
    }
    return true;
  }
  const deleteTargets = {
    "builder-delete-plan": ["draft program", `/api/builder/plans/${encodeURIComponent(state.builder.draft?.plan.id || "")}`],
    "builder-delete-block": ["block and its contents", `/api/builder/blocks/${encodeURIComponent(action.dataset.blockId || "")}`],
    "builder-delete-session": ["session and its contents", `/api/builder/sessions/${encodeURIComponent(action.dataset.sessionId || "")}`],
    "builder-delete-node": ["selected node and its contents", `/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}`],
  };
  if (deleteTargets[type]) {
    const [label, url] = deleteTargets[type];
    if (!window.confirm(`Delete this ${label}? This cannot be undone.`)) return true;
    await api(type === "builder-delete-plan" ? url : withBatchSyncUrl(url), { method: "DELETE" });
    if (type === "builder-delete-plan") {
      // The just-deleted plan may well have been the one showing in the
      // cached drafts list (unless it was an is_edit_draft row, already
      // excluded from that list server-side) - invalidate unconditionally
      // rather than re-deriving which case this was, so the next re-entry
      // into the empty-state picker can never show a plan that's gone.
      invalidateBuilderDraftsCache();
      state.builder = emptyBuilderState();
      handlers.renderBuilder();
      return true;
    }
    state.builder.selectedNodeId = "";
    state.builder.selectedSessionId = "";
    await handlers.refreshBuilderDraft();
    return true;
  }
  return false;
}

export async function handleBuilderItemAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-pick-exercise") {
    const section = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const panel = action.closest(".builder-section-panel");
    const doseInput = (name) => panel?.querySelector(`[data-builder-new-dose][name="${name}"]`);
    if (!section || section.type !== "section") return true;
    action.disabled = true;
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(section.id)}/exercises`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({
          exerciseId: action.dataset.exerciseId || "",
          sets: doseInput("sets")?.value || "",
          reps: doseInput("reps")?.value || "",
          load: doseInput("load")?.value || "",
        })),
      }));
      if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
      scrollToLastAddedItem(section.id);
    } catch (error) {
      handlers.renderBuilderError(error);
    }
    return true;
  }
  if (type === "builder-move-item") {
    const node = findBuilderNode(state.builder.draft, state.builder.selectedNodeId);
    const currentIndex = node?.items.findIndex((item) => item.id === action.dataset.itemId) ?? -1;
    const targetIndex = currentIndex + (action.dataset.direction === "up" ? -1 : 1);
    if (!node || currentIndex < 0 || targetIndex < 0 || targetIndex >= node.items.length) return true;
    [node.items[currentIndex], node.items[targetIndex]] = [node.items[targetIndex], node.items[currentIndex]];
    if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    try {
      setBuilderDraft(await queuedBuilderApi(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}/move`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ direction: action.dataset.direction })),
      }));
      if (!handlers.renderBuilderSectionItems?.()) handlers.renderBuilder();
    } catch (error) {
      await handlers.refreshBuilderDraft();
      throw error;
    }
    return true;
  }
  if (type === "builder-delete-item") {
    if (!window.confirm("Remove this exercise from the program?")) return true;
    await api(withBatchSyncUrl(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}`), { method: "DELETE" });
    await handlers.refreshBuilderDraft({ sectionItemsOnly: true });
    return true;
  }
  return false;
}

export async function submitBuilderForm(form, handlers) {
  const mode = form.dataset.builderForm;
  const data = Object.fromEntries(new FormData(form));
  const draft = state.builder.draft;
  if (mode === "create") {
    const athleteIds = state.builder.createAthleteIds?.length
      ? state.builder.createAthleteIds
      : (data.athleteId ? [data.athleteId] : []);
    data.athleteIds = athleteIds;
    data.athleteId = athleteIds[0] || "";
    const created = await api("/api/builder/plans", { method: "POST", body: JSON.stringify(data) });
    // A brand new draft now exists - the cached drafts list (shown again
    // whenever this account next has no draft open) must never be missing
    // it just because it happened to be cached before this create.
    invalidateBuilderDraftsCache();
    setBuilderDraft(created, { preserveBatch: false });
    state.builder.selectedSessionId = "";
    state.builder.selectedNodeId = "";
    state.builder.athletePickerOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.createAthleteId = "";
    state.builder.createAthleteIds = [];
    state.builder.planType = "weekly";
    state.builder.weekStart = "";
    state.builder.addNodeOpen = false;
    await handlers.loadBuilderExercises();
    return;
  }
  if (!draft) return;
  if (mode === "add-block") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/blocks`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    state.builder.blockAddOpen = false;
  }
  if (mode === "update-block") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-plan") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-node") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-session") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "add-node") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}/nodes`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    const session = findBuilderSession(state.builder.draft, form.dataset.sessionId);
    const added = session?.nodes.at(-1);
    state.builder.selectedSessionId = form.dataset.sessionId;
    state.builder.selectedNodeId = added?.id || "";
    state.builder.inlineAddOpen = false;
    state.builder.inlineAddType = "";
    state.builder.inlineAddSessionId = "";
    state.builder.inlineAddParentId = "";
  }
  if (mode === "add-exercise") {
    if (!data.exerciseId) return;
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/exercises`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    scrollToLastAddedItem(form.dataset.nodeId);
  }
  if (mode === "add-custom-exercise") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/custom-exercise`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    state.builder.customExerciseOpen = false;
    scrollToLastAddedItem(form.dataset.nodeId);
  }
  if (mode === "update-item") {
    setBuilderDraft(await queuedBuilderApi(`/api/builder/items/${encodeURIComponent(form.dataset.itemId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
    if (handlers.renderBuilderSectionItems?.()) return;
  }
  handlers.renderBuilder();
}
