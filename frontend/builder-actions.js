import { api } from "./api.js";
import { findBuilderNode } from "./builder-helpers.js";
import { emptyBuilderState, state } from "./state.js";
import { localDateIso, weekMondayIso } from "./utils.js";

function resetBuilderCopyState() {
  state.builder.copyPlanId = "";
  state.builder.copyPlanName = "";
  state.builder.copyAthleteId = "";
  state.builder.copyPlanType = "program";
  state.builder.copyWeekStart = "";
}

export async function handleBuilderPlanAction(action, handlers) {
  const type = action.dataset.action;
  if (type === "builder-edit-plan") {
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(action.dataset.planId || "")}/edit`, { method: "POST" });
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
      throw error;
    }
    return true;
  }
  if (type === "builder-duplicate-plan") {
    state.builder.copyPlanId = action.dataset.planId || "";
    state.builder.copyPlanName = action.closest(".section-heading")?.querySelector("h3")?.textContent || "Program";
    state.builder.copyAthleteId = "";
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
    state.builder.copyAthleteId = action.dataset.athleteId || "";
    await handlers.renderCopyPlanSource();
    return true;
  }
  if (type === "builder-confirm-duplicate-plan") {
    action.disabled = true;
    try {
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(state.builder.copyPlanId)}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ athleteId: state.builder.copyAthleteId, weekStart: state.builder.copyWeekStart }),
      });
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
      throw error;
    }
    return true;
  }
  return false;
}

export async function handleBuilderWorkspaceAction(action, handlers) {
  const type = action.dataset.action;
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
      state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(clipboard.nodeId)}/copy`, {
        method: "POST",
        body: JSON.stringify({ targetSessionId: action.dataset.sessionId, targetParentId: action.dataset.parentId || "" }),
      });
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
      state.builder.draft = await api(`/api/builder/nodes/${encodeURIComponent(action.dataset.nodeId || "")}/move`, {
        method: "POST",
        body: JSON.stringify({ direction: action.dataset.direction || "" }),
      });
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
    state.builder.createAthleteId = action.dataset.athleteId || "";
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
      state.builder.draft = await api(`/api/builder/plans/${encodeURIComponent(draft.plan.id)}/submit`, { method: "POST" });
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
    state.builder = emptyBuilderState();
    state.navStack = [];
    if (plan?.athleteId) state.selectedAthleteId = String(plan.athleteId);
    if (plan?.planType === "weekly") {
      state.activeTab = "weekly";
      state.weekSelectorOpen = false;
      handlers.renderTabs();
      handlers.renderLibraryNav();
      await handlers.loadWeekly();
      return true;
    }
    if (plan?.isTemplate || !plan?.athleteId) {
      state.activeTab = "templates";
      handlers.renderTabs();
      handlers.renderLibraryNav();
      await handlers.loadTemplates();
      return true;
    }
    state.activeTab = "programs";
    handlers.renderTabs();
    handlers.renderLibraryNav();
    await handlers.loadPrograms();
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
    await api(url, { method: "DELETE" });
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
