// Weekly program templates in the Builder (docs/ai/weekly-program-template-plan.md):
// the week strip's actions, the dated assign with its one question (Replace /
// Skip weeks that already have a plan / Cancel), and Save as template from
// chosen weeks. The view is builder-weekly-template-view.js.
import { api } from "./api.js";
import { matchingAthletes } from "./athlete-list-tools.js";
import { invalidateBuilderDraftsCache } from "./builder-data.js";
import { invalidateTemplatesCache } from "./program-library-data.js";
import { queuedBuilderApi, setBuilderDraft } from "./builder-actions.js";
import { currentTemplateWeek, weeklyAssignPreviewText } from "./builder-weekly-template-view.js";
import { state } from "./state.js";
import { localDateIso } from "./utils.js";

const planUrl = (suffix = "") => `/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}${suffix}`;

async function changeWeeks(handlers, request, { selectWeek } = {}) {
  if (state.builder.templateWeekBusy) return;
  state.builder.templateWeekBusy = true;
  state.builder.templateWeekError = "";
  state.builder.templateWeekDeleteConfirm = 0;
  handlers.renderBuilder();
  try {
    setBuilderDraft(await request());
    // The library's card says how many weeks the template has.
    invalidateTemplatesCache();
    if (selectWeek) state.builder.templateWeek = selectWeek(state.builder.draft);
  } catch (error) {
    state.builder.templateWeekError = error?.message && error.status && error.status < 500 ? error.message : "The week could not be changed. Try again.";
  } finally {
    state.builder.templateWeekBusy = false;
    handlers.renderBuilder();
  }
}

// Keeps the assign dialog's state for the template on screen.
function assignState() {
  const planId = state.builder.draft?.plan?.id || "";
  if (!state.builder.weeklyAssign || state.builder.weeklyAssign.planId !== planId) {
    state.builder.weeklyAssign = { planId, open: false, startDate: localDateIso(), athleteIds: [], requestId: "", sending: false, conflict: null, error: "", result: null };
  }
  return state.builder.weeklyAssign;
}

export function updateWeeklyAssignStartDate(input) {
  const assign = assignState();
  assign.startDate = input.value;
  // A new date is a new request: its key and any earlier question go.
  assign.requestId = "";
  const preview = input.closest("label")?.querySelector("[data-tw-start-preview]");
  if (preview) preview.textContent = weeklyAssignPreviewText(input.value, Number(state.builder.draft?.plan?.weekCount) || 1);
}

export function updateSaveWeeksName(input) {
  if (state.builder.saveWeeks) state.builder.saveWeeks.name = input.value;
}

async function sendAssign(handlers, { choice, choiceToken } = {}) {
  const assign = assignState();
  if (assign.sending || !assign.athleteIds.length) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(assign.startDate || ""))) {
    assign.error = "Choose the date of Day 1.";
    handlers.renderBuilder();
    return;
  }
  assign.sending = true;
  assign.error = "";
  // One key per attempt (a choice is a new attempt), reused when the same
  // attempt is sent again after a lost answer.
  if (!assign.requestId) assign.requestId = crypto.randomUUID();
  handlers.renderBuilder();
  try {
    await handlers.flushBuilderAutosaves?.();
    let templateId = state.builder.draft.plan.id;
    if (state.builder.draft.plan.isEditDraft) {
      // The athletes get the saved template: apply the open edit first (the
      // same step Builder's Assign to athlete takes).
      const applied = await queuedBuilderApi(planUrl("/submit"), { method: "POST", body: JSON.stringify({}) });
      setBuilderDraft(applied, { preserveBatch: false });
      templateId = applied.plan.id;
      assign.planId = templateId;
    }
    const result = await api(`/api/builder/plans/${encodeURIComponent(templateId)}/assign-weekly`, {
      method: "POST",
      body: JSON.stringify({ athleteIds: assign.athleteIds, startDate: assign.startDate, assignmentRequestId: assign.requestId, ...(choice ? { choice, choiceToken } : {}) }),
    });
    assign.result = result;
    assign.conflict = null;
    assign.requestId = "";
    invalidateBuilderDraftsCache();
  } catch (error) {
    if (error?.status === 409 && error.data?.code === "weekly_assign_conflicts") {
      assign.conflict = error.data;
      assign.requestId = "";
    } else if (error?.status && error.status < 500) {
      assign.error = error.message || "The program could not be assigned.";
      assign.requestId = "";
    } else {
      // No answer: the same key is sent again by Assign, so it never writes twice.
      assign.error = "No answer from the server. Assign again: nothing is written twice.";
    }
  } finally {
    assign.sending = false;
    handlers.renderBuilder();
    if (assign.conflict) document.querySelector?.("[data-tw-conflict]")?.focus?.();
  }
}

async function openSaveWeeks(handlers) {
  const plan = state.builder.draft.plan;
  state.builder.saveWeeks = { open: true, loading: true, plans: [], planIds: [String(plan.id)], name: "", athleteName: plan.athleteName || "", sending: false, error: "" };
  handlers.renderBuilder();
  try {
    const result = await api(`/api/athletes/${encodeURIComponent(plan.athleteId)}/plans`);
    const save = state.builder.saveWeeks;
    if (!save?.open) return;
    save.plans = (result.plans || []).filter((row) => row.plan_type === "weekly").sort((a, b) => String(a.week_start).localeCompare(String(b.week_start)));
    save.planIds = save.planIds.filter((id) => save.plans.some((row) => String(row.plan_id) === id));
  } catch {
    if (state.builder.saveWeeks) state.builder.saveWeeks.error = "The athlete's weeks could not be loaded. Close and try again.";
  } finally {
    if (state.builder.saveWeeks) state.builder.saveWeeks.loading = false;
    handlers.renderBuilder();
  }
}

export async function handleWeeklyTemplateAction(action, handlers) {
  const type = action.dataset.action || "";
  if (!type.startsWith("builder-tw-")) return false;
  const draft = state.builder.draft;
  if (!draft) return true;
  if (type === "builder-tw-select-week") {
    state.builder.templateWeek = Number(action.dataset.week) || 1;
    state.builder.templateWeekDeleteConfirm = 0;
    state.builder.templateWeekError = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-add-week") {
    await changeWeeks(handlers, () => queuedBuilderApi(planUrl("/weeks"), { method: "POST", body: JSON.stringify({}) }), { selectWeek: (d) => d.plan.weekCount });
    return true;
  }
  if (type === "builder-tw-duplicate-week") {
    const week = Number(action.dataset.week);
    await changeWeeks(handlers, () => queuedBuilderApi(planUrl("/weeks"), { method: "POST", body: JSON.stringify({ copyFrom: week }) }), { selectWeek: (d) => d.plan.weekCount });
    return true;
  }
  if (type === "builder-tw-move-week") {
    const week = Number(action.dataset.week);
    const to = Number(action.dataset.to);
    await changeWeeks(handlers, () => queuedBuilderApi(planUrl(`/weeks/${week}/move`), { method: "POST", body: JSON.stringify({ to }) }), { selectWeek: () => to });
    return true;
  }
  if (type === "builder-tw-delete-week") {
    state.builder.templateWeekDeleteConfirm = Number(action.dataset.week);
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-delete-week-cancel") {
    state.builder.templateWeekDeleteConfirm = 0;
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-delete-week-confirm") {
    const week = Number(action.dataset.week);
    await changeWeeks(handlers, () => queuedBuilderApi(planUrl(`/weeks/${week}`), { method: "DELETE" }), { selectWeek: (d) => Math.min(week, d.plan.weekCount) });
    return true;
  }
  if (type === "builder-tw-assign-open") {
    const assign = assignState();
    Object.assign(assign, { open: true, conflict: null, error: "", result: null, requestId: "" });
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-assign-close") {
    const assign = assignState();
    if (assign.sending) return true;
    Object.assign(assign, { open: false, conflict: null, error: "", result: null, requestId: "", athleteIds: [] });
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-assign-toggle") {
    const assign = assignState();
    const id = String(action.dataset.athleteId || "");
    const set = new Set(assign.athleteIds.map(String));
    if (set.has(id)) set.delete(id); else set.add(id);
    assign.athleteIds = [...set];
    assign.requestId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-assign-toggle-all") {
    const assign = assignState();
    const shown = matchingAthletes(state.athletes || [], "builder-tw-assign").map((a) => String(a.athlete_id)).filter(Boolean);
    const set = new Set(assign.athleteIds.map(String));
    const all = shown.length > 0 && shown.every((id) => set.has(id));
    for (const id of shown) { if (all) set.delete(id); else set.add(id); }
    assign.athleteIds = [...set];
    assign.requestId = "";
    handlers.renderBuilder();
    return true;
  }
  if (type === "builder-tw-assign-submit") {
    await sendAssign(handlers);
    return true;
  }
  if (type === "builder-tw-assign-choice") {
    const assign = assignState();
    const conflict = assign.conflict;
    if (!conflict) return true;
    await sendAssign(handlers, { choice: action.dataset.choice === "replace" ? "replace" : "skip", choiceToken: conflict.choiceToken });
    return true;
  }
  if (type === "builder-tw-assign-back") {
    const assign = assignState();
    assign.conflict = null;
    assign.requestId = "";
    handlers.renderBuilder();
    return true;
  }
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
      const created = await api("/api/builder/weekly-templates", { method: "POST", body: JSON.stringify({ name, planIds: save.planIds }) });
      invalidateBuilderDraftsCache();
      invalidateTemplatesCache();
      state.builder.saveWeeks = null;
      state.builder.templateWeek = 1;
      setBuilderDraft(created, { preserveBatch: false });
      state.builder.selectedSessionId = "";
      state.builder.selectedNodeId = "";
    } catch (error) {
      save.error = error?.status && error.status < 500 ? (error.message || "The template could not be saved.") : "The template could not be saved. Try again.";
    } finally {
      if (state.builder.saveWeeks) state.builder.saveWeeks.sending = false;
      handlers.renderBuilder();
    }
    return true;
  }
  return false;
}

export { currentTemplateWeek };
