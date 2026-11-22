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
  state.builder.templateNotice = "";
  state.builder.templateWeekDeleteConfirm = 0;
  handlers.renderBuilder();
  const planId = state.builder.draft.plan.id;
  // A saved change whose new draft could not be read answers { reload: true }:
  // read it again rather than call it a failure (a retry would write twice).
  const readAgain = () => api(`/api/builder/plans/${encodeURIComponent(planId)}`);
  try {
    const answer = await request();
    setBuilderDraft(answer?.reload ? await readAgain() : answer);
    // The library's card says how many weeks the template has.
    invalidateTemplatesCache();
    if (selectWeek) state.builder.templateWeek = selectWeek(state.builder.draft);
  } catch (error) {
    const code = error?.data?.code || "";
    state.builder.templateWeekError = code === "weekly_template_weeks" ? "A weekly program has at most 52 weeks."
      : code === "weekly_template_last_week" ? "A weekly program keeps at least one week."
      : code === "edit_sessions_locked" ? "This week has sessions with results or a link to an event, so it can't be deleted."
      : error?.status === 404 || code === "week_not_found" || code === "not_weekly_template" ? "This week is no longer there. Reload the template."
      : code === "try_again" ? "The template is busy. Nothing was changed. Try again."
      : "";
    if (!state.builder.templateWeekError) {
      // No answer: the change may have been saved. Show the template as it is
      // now instead of inviting a second, duplicating try.
      try { setBuilderDraft(await readAgain()); } catch { /* keep what is shown */ }
      state.builder.templateWeekError = "No answer from the server. The template is shown as it is now: check the weeks before trying again.";
    }
  } finally {
    state.builder.templateWeekBusy = false;
    handlers.renderBuilder();
    // The chosen week's tab in view (the strip scrolls sideways on a phone).
    document.querySelector?.(".builder-week-tab.is-active")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
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

// The sentence a coach reads for a refusal: never a server sentence, an id or a code.
function assignRefusalText(error) {
  const code = error?.data?.code || "";
  if (code === "start_date") return "Choose the date of Day 1.";
  if (code === "try_again") return "The plans are busy. Nothing was saved. Try again.";
  if (code === "not_weekly_template") return "This template is no longer a weekly program. Close and open it again.";
  if (error?.status === 403) return "One of the athletes is not in your current workspace, or the template can't be assigned. Remove that athlete and assign again.";
  if (error?.status === 404) return "The template or one of the athletes was not found. Close, reload and assign again.";
  if (error?.status === 409) return "This assignment was already sent with other choices. Close and assign again.";
  return "The program could not be assigned. Check the date and the athletes, then assign again.";
}

async function sendAssign(handlers, { choice, choiceToken } = {}) {
  const assign = assignState();
  if (assign.sending || !assign.athleteIds.length) return;
  // A different choice than the one whose answer was lost is a new attempt.
  if ((choice || "") !== (assign.lastChoice || "")) assign.requestId = "";
  const askedBefore = Boolean(assign.conflict);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(assign.startDate || ""))) {
    assign.error = "Choose the date of Day 1.";
    handlers.renderBuilder();
    return;
  }
  assign.sending = true;
  assign.error = "";
  assign.lastChoice = choice || "";
  // One key per attempt (a choice is a new attempt), reused when the same
  // attempt is sent again after a lost answer.
  if (!assign.requestId) assign.requestId = crypto.randomUUID();
  handlers.renderBuilder();
  try {
    await handlers.flushBuilderAutosaves?.();
    let templateId = state.builder.draft.plan.id;
    if (assign.fromLibrary && state.builder.draft.plan.isEditDraft && state.builder.draft.plan.editSourcePlanId) {
      // Opened from the library only to assign: the saved template is
      // assigned, and the edit copy made to show it is not applied.
      templateId = state.builder.draft.plan.editSourcePlanId;
    } else if (state.builder.draft.plan.isEditDraft) {
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
      // Asked again after a choice: the plans changed since the coach looked.
      assign.changedAgain = Boolean(choice && askedBefore);
      assign.conflict = error.data;
      assign.requestId = "";
    } else if (error?.status && error.status < 500) {
      assign.error = assignRefusalText(error);
      assign.requestId = "";
    } else {
      // No answer: the same key is sent again by the same button, so it never writes twice.
      const again = choice === "replace" ? "Replace" : choice === "skip" ? "Skip weeks that already have a plan" : "Assign";
      assign.error = `No answer from the server. Press ${again} again: nothing is written twice. Or close: it may already be assigned, so check the athletes' weeks.`;
    }
  } finally {
    assign.sending = false;
    handlers.renderBuilder();
    if (assign.conflict) document.querySelector?.("[data-tw-conflict]")?.focus?.();
  }
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
    const fromLibrary = assign.fromLibrary;
    Object.assign(assign, { open: false, conflict: null, error: "", result: null, requestId: "", athleteIds: [], fromLibrary: false, changedAgain: false, lastChoice: "" });
    // Opened from the library only to assign: the edit copy made to show the
    // template is removed again, so no draft the coach never asked for stays.
    if (fromLibrary && state.builder.draft?.plan?.isEditDraft) {
      const draftId = state.builder.draft.plan.id;
      try {
        await queuedBuilderApi(`/api/builder/plans/${encodeURIComponent(draftId)}`, { method: "DELETE" });
        state.builder.draft = null;
        invalidateBuilderDraftsCache();
      } catch { /* the draft stays; it is listed under Continue where you left off */ }
    }
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
    assign.changedAgain = false;
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

export { currentTemplateWeek };
