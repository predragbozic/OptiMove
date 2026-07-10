import { api } from "./api.js";
import { state } from "./state.js";
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
