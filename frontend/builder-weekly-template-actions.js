// Weekly program templates in the Builder (docs/ai/weekly-program-template-plan.md,
// part WT-A): the week strip's actions (select, add, duplicate, move, delete with
// a confirmation). The view is builder-weekly-template-view.js.
import { api } from "./api.js";
import { queuedBuilderApi, setBuilderDraft } from "./builder-actions.js";
import { invalidateTemplatesCache } from "./program-library-data.js";
import { currentTemplateWeek } from "./builder-weekly-template-view.js";
import { state } from "./state.js";

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

const WEEK_ACTIONS = new Set(["builder-tw-select-week", "builder-tw-add-week", "builder-tw-duplicate-week", "builder-tw-move-week",
  "builder-tw-delete-week", "builder-tw-delete-week-cancel", "builder-tw-delete-week-confirm"]);

export async function handleWeeklyTemplateAction(action, handlers) {
  const type = action.dataset.action || "";
  if (!WEEK_ACTIONS.has(type)) return false;
  if (!state.builder.draft) return true;
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
  return false;
}

export { currentTemplateWeek };
