// The weekly "create plan" refused because the week already holds a plan (409): offer "Open that draft".
// The plan's id comes from GET /api/builder/weekly-plans (no backend change); the action is offered only when that read
// returns a plan of this athlete and week the caller may open. Nothing of a plan the read does not return is shown.
import { api } from "./api.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const WEEKLY_EXISTING_FALLBACK = "This athlete already has a weekly plan for that week.";

// The athlete's UUID from the roster row the Builder id names (the read takes UUIDs).
function athleteUuidOf(rosterId) {
  const row = (state.athletes || []).find((entry) => String(entry?.athlete_id) === String(rosterId));
  const uuid = String(row?.athlete_uuid || "");
  return UUID.test(uuid) ? uuid : "";
}

// Returns { planId, openPlanId, status } or null. Never throws: a failed read means "no action".
export async function findExistingWeeklyPlan(rosterAthleteId, weekStart) {
  const uuid = athleteUuidOf(rosterAthleteId);
  if (!uuid || !weekStart) return null;
  try {
    const params = new URLSearchParams({ weekStart, athleteIds: uuid });
    const answer = await api(`/api/builder/weekly-plans?${params.toString()}`);
    const entry = (Array.isArray(answer?.athletes) ? answer.athletes : []).find((a) => String(a?.athleteId).toLowerCase() === uuid.toLowerCase());
    const plan = entry?.plannable === true ? entry.plan : null;
    if (!plan || plan.editable !== true || !plan.planId) return null;
    return { planId: String(plan.planId), openPlanId: plan.openDraftId ? String(plan.openDraftId) : "", status: plan.status === "draft" ? "draft" : "active", weekStart };
  } catch {
    return null;
  }
}

// An own edit already open, or a draft: read it; a published plan: an edit draft of it (the Builder's own Edit).
export async function openExistingWeeklyPlan({ planId, openPlanId, status }) {
  const id = String(openPlanId || planId);
  if (status === "draft" || openPlanId) return api(`/api/builder/plans/${encodeURIComponent(id)}`);
  return api(`/api/builder/plans/${encodeURIComponent(id)}/edit`, { method: "POST" });
}

// The message and, when a plan can be opened, its button (44 px target; see .builder-page-error-action).
export function renderWeeklyExistingHtml(message, existing) {
  const text = escapeHtml(message || WEEKLY_EXISTING_FALLBACK);
  const button = existing
    ? `<button type="button" class="plain-button builder-page-error-action" data-action="weekly-open-existing" data-plan-id="${escapeAttr(existing.planId)}">Open that ${existing.status === "draft" ? "draft" : "plan"}</button>`
    : "";
  return `<div class="builder-error builder-page-error" role="alert"><p>${text}</p>${button}</div>`;
}
