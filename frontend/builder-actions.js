import { api } from "./api.js";
import { findBuilderNode, findBuilderSession } from "./builder-helpers.js";
import { emptyBuilderState, state } from "./state.js";
import { localDateIso, weekMondayIso } from "./utils.js";

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
    await handlers.loadWeekly();
    return;
  }
  if (plan?.isTemplate || !plan?.athleteId) {
    state.activeTab = "templates";
    handlers.renderTabs();
    handlers.renderLibraryNav();
    await handlers.loadTemplates();
    return;
  }
  state.activeTab = "programs";
  handlers.renderTabs();
  handlers.renderLibraryNav();
  await handlers.loadPrograms();
}

export async function handleBuilderPlanAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-edit-plan") {
    const planId = action.dataset.planId || "";
    const batchPlans = state.builder.draft?.batch?.plans || [];
    const isBatchPlanSwitch = batchPlans.some((plan) => String(plan.id) === String(planId));
    action.disabled = true;
    try {
      setBuilderDraft(await api(`/api/builder/plans/${encodeURIComponent(planId)}/edit`, { method: "POST" }), {
        preserveBatch: isBatchPlanSwitch,
      });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
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
      setBuilderDraft(await api(`/api/builder/plans/${encodeURIComponent(state.builder.copyPlanId)}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ athleteId: athleteIds[0] || "", athleteIds, weekStart: state.builder.copyWeekStart }),
      }), { preserveBatch: false });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
      resetBuilderCopyState();
      state.activeTab = "builder";
      state.navStack = [];
      handlers.renderTabs();
      handlers.renderLibraryNav();
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
      setBuilderDraft(await api(`/api/builder/plans/${encodeURIComponent(planId)}`));
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
      state.builder.exerciseQuery = "";
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
    await handlers.loadBuilderDrafts();
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
    await handlers.loadBuilderDrafts();
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
      setBuilderDraft(await api(`/api/builder/plans/${encodeURIComponent(planId)}`));
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
  if (type === "builder-open-session-modal") {
    state.builder.sessionModalBlockId = action.dataset.blockId || "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-session-modal") {
    state.builder.sessionModalBlockId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-close-structure-modal") {
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-open-custom-exercise") {
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
      setBuilderDraft(await api(`/api/builder/nodes/${encodeURIComponent(clipboard.nodeId)}/copy`, {
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
      setBuilderDraft(await api(`/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}/move`, {
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
  if (type === "builder-add-structure") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = true;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-session") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = "";
    state.builder.sectionPickerOpen = false;
    state.builder.addNodeOpen = false;
    state.builder.structureModalOpen = false;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-select-node") {
    state.builder.selectedSessionId = action.dataset.sessionId || "";
    state.builder.selectedNodeId = action.dataset.nodeId || "";
    state.builder.sectionPickerOpen = findBuilderNode(state.builder.draft, state.builder.selectedNodeId)?.type === "section";
    state.builder.addNodeOpen = true;
    state.builder.structureModalOpen = !state.builder.sectionPickerOpen;
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
      await handlers.loadWeekly();
    } else if (state.activeTab === "programs") {
      state.selectedProgramId = null;
      await handlers.loadPrograms();
    } else {
      state.selectedTemplateId = null;
      await handlers.loadTemplates();
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
    if (!section || section.type !== "section") return true;
    action.disabled = true;
    try {
      setBuilderDraft(await api(`/api/builder/nodes/${encodeURIComponent(section.id)}/exercises`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({
          exerciseId: action.dataset.exerciseId || "",
          sets: panel?.querySelector("[name='sets']")?.value || "",
          reps: panel?.querySelector("[name='reps']")?.value || "",
          load: panel?.querySelector("[name='load']")?.value || "",
        })),
      }));
      handlers.renderBuilder();
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
    handlers.renderBuilder();
    try {
      setBuilderDraft(await api(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}/move`, {
        method: "POST",
        body: JSON.stringify(withBatchSyncPayload({ direction: action.dataset.direction })),
      }));
      handlers.renderBuilder();
    } catch (error) {
      await handlers.refreshBuilderDraft();
      throw error;
    }
    return true;
  }
  if (type === "builder-delete-item") {
    if (!window.confirm("Remove this exercise from the program?")) return true;
    await api(withBatchSyncUrl(`/api/builder/items/${encodeURIComponent(action.dataset.itemId)}`), { method: "DELETE" });
    await handlers.refreshBuilderDraft();
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
    setBuilderDraft(created, { preserveBatch: false });
    state.builder.selectedSessionId = "";
    state.builder.selectedNodeId = "";
    state.builder.athletePickerOpen = false;
    state.builder.sectionPickerOpen = false;
    state.builder.createAthleteId = "";
    state.builder.createAthleteIds = [];
    state.builder.planType = "program";
    state.builder.weekStart = "";
    state.builder.addNodeOpen = false;
    await handlers.loadBuilderExercises();
    return;
  }
  if (!draft) return;
  if (mode === "add-block") {
    setBuilderDraft(await api(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/blocks`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "update-block") {
    setBuilderDraft(await api(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "add-session") {
    setBuilderDraft(await api(`/api/builder/blocks/${encodeURIComponent(form.dataset.blockId)}/sessions`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    const lastBlock = state.builder.draft.blocks.find((block) => block.id === form.dataset.blockId);
    state.builder.selectedSessionId = lastBlock?.sessions.at(-1)?.id || state.builder.selectedSessionId;
    state.builder.selectedNodeId = "";
    state.builder.sessionModalBlockId = "";
    state.builder.structureModalOpen = false;
  }
  if (mode === "add-node") {
    setBuilderDraft(await api(`/api/builder/sessions/${encodeURIComponent(form.dataset.sessionId)}/nodes`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    const session = findBuilderSession(state.builder.draft, form.dataset.sessionId);
    const added = session?.nodes.at(-1);
    state.builder.selectedSessionId = form.dataset.sessionId;
    state.builder.selectedNodeId = added?.id || "";
  }
  if (mode === "add-exercise") {
    if (!data.exerciseId) return;
    setBuilderDraft(await api(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/exercises`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  if (mode === "add-custom-exercise") {
    setBuilderDraft(await api(`/api/builder/nodes/${encodeURIComponent(form.dataset.nodeId)}/custom-exercise`, { method: "POST", body: JSON.stringify(withBatchSyncPayload(data)) }));
    state.builder.customExerciseOpen = false;
  }
  if (mode === "update-item") {
    setBuilderDraft(await api(`/api/builder/items/${encodeURIComponent(form.dataset.itemId)}`, { method: "PATCH", body: JSON.stringify(withBatchSyncPayload(data)) }));
  }
  handlers.renderBuilder();
}
