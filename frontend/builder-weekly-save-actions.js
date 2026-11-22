// Weekly program templates (docs/ai/weekly-program-template-plan.md, part WT-C):
// Save as template from an athlete's chosen weeks. The view is
// builder-weekly-save-view.js.
import { api } from "./api.js";
import { invalidateBuilderDraftsCache } from "./builder-data.js";
import { setBuilderDraft } from "./builder-actions.js";
import { invalidateTemplatesCache } from "./program-library-data.js";
import { state } from "./state.js";

export function updateSaveWeeksName(input) {
  if (state.builder.saveWeeks) state.builder.saveWeeks.name = input.value;
}

async function openSaveWeeks(handlers) {
  const plan = state.builder.draft.plan;
  // The week on screen is chosen to start with (its saved plan when this is an edit draft).
  const current = String(plan.isEditDraft && plan.editSourcePlanId ? plan.editSourcePlanId : plan.id);
  state.builder.saveWeeks = { open: true, loading: true, plans: [], planIds: [current], currentPlanId: current, name: "", athleteName: plan.athleteName || "", sending: false, error: "" };
  handlers.renderBuilder();
  try {
    const result = await api(`/api/athletes/${encodeURIComponent(plan.athleteId)}/plans`);
    const save = state.builder.saveWeeks;
    if (!save?.open) return;
    // Newest first: the weeks a coach reuses are usually the recent ones.
    save.plans = (result.plans || []).filter((row) => row.plan_type === "weekly").sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)));
    save.planIds = save.planIds.filter((id) => save.plans.some((row) => String(row.plan_id) === id));
  } catch {
    if (state.builder.saveWeeks) state.builder.saveWeeks.error = "The athlete's weeks could not be loaded. Close and try again.";
  } finally {
    if (state.builder.saveWeeks) state.builder.saveWeeks.loading = false;
    handlers.renderBuilder();
  }
}

export async function handleSaveWeeksAction(action, handlers) {
  const type = action.dataset.action || "";
  if (!type.startsWith("builder-tw-save-")) return false;
  if (!state.builder.draft) return true;
  if (type === "builder-tw-save-open") {
    await openSaveWeeks(handlers);
    return true;
  }
  if (type === "builder-tw-save-close") {
    if (state.builder.saveWeeks?.sending) return true;
    state.builder.saveWeeks = null;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-save-toggle") {
    const save = state.builder.saveWeeks;
    if (!save) return true;
    const id = String(action.dataset.planId || "");
    const set = new Set(save.planIds.map(String));
    if (set.has(id)) set.delete(id); else set.add(id);
    save.planIds = [...set];
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-save-submit") {
    const save = state.builder.saveWeeks;
    if (!save || save.sending || !save.planIds.length) return true;
    const name = String(document.querySelector?.("[data-tw-save-name]")?.value ?? save.name ?? "").trim();
    save.name = name;
    if (!name) {
      save.error = "Give the template a name.";
      handlers.renderBuilder();
      return true;
    }
    save.sending = true;
    save.error = "";
    handlers.renderBuilder();
    try {
      await handlers.flushBuilderAutosaves?.();
      let created = await api("/api/builder/weekly-templates", { method: "POST", body: JSON.stringify({ name, planIds: save.planIds }) });
      if (created?.reload) created = await api(`/api/builder/plans/${encodeURIComponent(created.planId)}`);
      invalidateBuilderDraftsCache();
      invalidateTemplatesCache();
      state.builder.saveWeeks = null;
      setBuilderDraft(created, { preserveBatch: false });
      state.builder.templateWeek = 1;
      state.builder.templateNotice = `Saved as the template “${name}”. It is a draft: change it here, then save it.`;
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
    } catch (error) {
      save.error = error?.status === 404 ? "One of the weeks is no longer available. Close and choose again."
        : error?.data?.code === "try_again" ? "The plans are busy. Nothing was saved. Try again."
        : error?.status && error.status < 500 ? "The template could not be saved. Check the name and the weeks."
        : "No answer from the server. The template may have been saved: look under Continue where you left off before saving again.";
    } finally {
      if (state.builder.saveWeeks) state.builder.saveWeeks.sending = false;
      handlers.renderBuilder();
    }
    return true;
  }
  return false;
}
