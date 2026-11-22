// Weekly program templates (docs/ai/weekly-program-template-plan.md, part WT-B):
// the dated assign into the athletes' weekly plans, with its one question
// (Replace / Skip weeks that already have a plan / Back). The view is
// builder-weekly-assign-view.js.
import { api } from "./api.js";
import { matchingAthletes } from "./athlete-list-tools.js";
import { invalidateBuilderDraftsCache } from "./builder-data.js";
import { queuedBuilderApi, setBuilderDraft } from "./builder-actions.js";
import { weeklyAssignPreviewText } from "./builder-weekly-assign-view.js";
import { state } from "./state.js";
import { localDateIso } from "./utils.js";

const planUrl = (suffix = "") => `/api/builder/plans/${encodeURIComponent(state.builder.draft.plan.id)}${suffix}`;

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

export async function handleWeeklyAssignAction(action, handlers) {
  const type = action.dataset.action || "";
  if (!type.startsWith("builder-tw-assign-")) return false;
  if (!state.builder.draft) return true;
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
  return false;
}
