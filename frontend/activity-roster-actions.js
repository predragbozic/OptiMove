// Phase 5a3a: read-only interactions for the Activity Roster tab.
import { loadActivityRoster } from "./activity-roster-data.js";
import { state } from "./state.js";

function rosterState() {
  return state.trainingLoad.calendar.roster;
}

function maybeOpenRoster(activityId) {
  const roster = rosterState();
  if (roster.activityId !== activityId || !roster.data || roster.userPickedTab) return;
  if (Number(roster.data.counts?.needsState || 0) <= 0) return;
  state.trainingLoad.calendar.activityDetailTab = "roster";
  roster.autoTabFor = activityId;
}

export async function loadRosterForOpenActivity(activityId, render) {
  await loadActivityRoster(activityId, render);
  maybeOpenRoster(activityId);
  render?.();
}

export async function handleActivityRosterAction(action, { render }) {
  const type = action.dataset.action;
  if (!type?.startsWith("training-load-roster-")) return false;

  if (type === "training-load-roster-filter") {
    const filter = action.dataset.rosterFilter;
    if (["needs_state", "needs_review", "done", "all"].includes(filter)) rosterState().filter = filter;
    render();
    return true;
  }

  if (type === "training-load-roster-retry") {
    const activityId = state.trainingLoad.calendar.selectedActivityId;
    if (activityId && !rosterState().loading) await loadRosterForOpenActivity(activityId, render);
    return true;
  }

  return true;
}

// A <details> owns its native open/close behaviour. The captured toggle
// event persists the choice across app repaints without racing the browser.
export function activityRosterDisclosureToggled(panel) {
  const key = panel?.dataset?.rosterDisclosure;
  if (!key || panel.open === (panel.dataset.renderedOpen === "1")) return;
  const roster = rosterState();
  const opened = new Set(roster.openDisclosures || []);
  const closed = new Set(roster.closedDisclosures || []);
  if (panel.open) {
    opened.add(key);
    closed.delete(key);
  } else {
    opened.delete(key);
    closed.add(key);
  }
  roster.openDisclosures = [...opened];
  roster.closedDisclosures = [...closed];
}
