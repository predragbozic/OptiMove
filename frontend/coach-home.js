import { renderImage } from "./media.js";
import { athleteMatches, sortAthletes } from "./athlete-list-tools.js";
import { ICON_CALENDAR } from "./athlete-home.js";
import { ICON_ADD_ATHLETE } from "./organization-view.js";
import { escapeAttr, escapeHtml, programInitials } from "./utils.js";

const ICON_LOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="9" cy="7" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="14" cy="10" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="19" cy="6" r="1.3" fill="currentColor" stroke="none"></circle><path d="M4 12l5-5 5 3 5-4"></path><path d="M4 21v-6"></path><path d="M9 21v-9"></path><path d="M14 21v-7"></path><path d="M19 21v-11"></path></svg>`;
// One chevron for every Home row that opens something else - the admin's
// workspace rows and the coach's Today row share it, so "this row is an
// action" reads the same on both screens, with or without hover.
const ICON_CHEVRON_RIGHT = `<svg class="coach-home-workspace-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>`;

const WORKSPACE_ICONS = {
  private_coach: `<circle cx="12" cy="7" r="3"></circle><path d="M5 21v-3a7 7 0 0 1 14 0v3"></path>`,
  club: `<path d="M12 3l8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3z"></path><circle cx="12" cy="11" r="3"></circle>`,
  team: `<circle cx="9" cy="7" r="3"></circle><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-4-5.7"></path>`,
  athlete: `<circle cx="12" cy="7" r="3"></circle><path d="M5 21v-3a7 7 0 0 1 14 0v3"></path>`,
};

function renderWorkspaceButton(entry) {
  const kind = entry.type === "club" ? "Club" : entry.type === "team" ? "Team" : entry.type === "athlete" ? "Athlete" : "Private";
  return `<button class="coach-home-workspace" type="button" data-action="workspace-select" data-workspace-type="${escapeAttr(entry.type)}" data-workspace-scope-id="${escapeAttr(entry.scopeId || "")}">
    <svg class="coach-home-workspace-icon" viewBox="0 0 24 24" aria-hidden="true">${WORKSPACE_ICONS[entry.type] || WORKSPACE_ICONS.private_coach}</svg>
    <span class="coach-home-workspace-label"><strong>${escapeHtml(coachHomeWorkspaceLabel(entry))}</strong><small>${kind}</small></span>
    ${ICON_CHEVRON_RIGHT}
  </button>`;
}

function renderWorkspaceList(workspaces) {
  const clubIds = new Set(workspaces.filter((entry) => entry.type === "club").map((entry) => entry.scopeId));
  const roots = workspaces.filter((entry) => entry.type !== "team" || !entry.clubId || !clubIds.has(entry.clubId));
  return roots.map((entry) => {
    const teams = entry.type === "club" ? workspaces.filter((team) => team.type === "team" && team.clubId === entry.scopeId) : [];
    return `<li>${renderWorkspaceButton(entry)}${teams.length ? `<ul class="coach-home-workspace-teams" aria-label="${escapeAttr(coachHomeWorkspaceLabel(entry))} teams">${teams.map((team) => `<li>${renderWorkspaceButton(team)}</li>`).join("")}</ul>` : ""}</li>`;
  }).join("");
}

export function coachHomeWorkspaceLabel(workspace) {
  if (workspace?.type === "private_coach") return "Private coaching";
  if (workspace?.type === "platform") return "Platform administration";
  return workspace?.label || "Home";
}

function renderPickerDialog(rows, picker) {
  return `<dialog class="coach-home-picker" aria-labelledby="coachHomePickerTitle">
        <header><h3 id="coachHomePickerTitle">${picker.mode === "load" ? "Training Load" : picker.mode === "today" ? "Today" : "Training Plan"}</h3><button class="plain-button icon-button" type="button" data-action="coach-home-picker-close" aria-label="Close athlete list" title="Close">&times;</button></header>
        <input type="search" data-coach-home-search placeholder="Search athletes" aria-label="Search athletes" value="${escapeAttr(picker.query || "")}">
        <div class="coach-home-picker-list">${renderCoachHomeAthleteRows(rows, picker)}</div>
      </dialog>`;
}

// The coach's three workflows. Rendered only once the roster loaded with at
// least one athlete: with nobody to pick, every trigger would open the
// picker's own "No athletes in this workspace." dead end, and the Today row
// would count "0 / 0".
function renderWorkflowsHtml(rows, picker) {
  const withTraining = rows.filter((row) => row.hasTrainingToday);
  return `<div class="coach-home-actions">
        <button type="button" aria-haspopup="dialog" data-action="coach-home-picker-open" data-mode="plan">${ICON_CALENDAR}<span>Training Plan</span></button>
        <button type="button" aria-haspopup="dialog" data-action="coach-home-picker-open" data-mode="load">${ICON_LOAD}<span>Training Load</span></button>
      </div>
      <button class="coach-home-today" type="button" aria-haspopup="dialog" data-action="coach-home-picker-open" data-mode="today"><span class="coach-home-today-label"><strong>Today</strong><span>${withTraining.length} / ${rows.length} athletes training</span></span>${ICON_CHEVRON_RIGHT}</button>
      ${picker.mode ? renderPickerDialog(rows, picker) : ""}`;
}

// The roster loaded and holds no athlete: the one action that changes that
// (the same home-add-athlete the header's round button sends).
function renderEmptyStateHtml() {
  return `<div class="coach-home-state coach-home-state-empty">
        <p class="coach-home-state-title">No athletes in this workspace yet.</p>
        <p class="muted">Add your first athlete to plan training and track training load.</p>
        <button class="plain-button coach-home-state-button" type="button" data-action="home-add-athlete">${ICON_ADD_ATHLETE}<span>Add athlete</span></button>
      </div>`;
}

// GET /api/athletes/today failed: the message and one way back
// (coach-home-retry re-runs loadCoachHome with forceRefresh - app.js). Never
// the workflows: their "0 / 0" would read as a real, empty roster.
function renderErrorStateHtml(error) {
  return `<div class="coach-home-state coach-home-state-error" role="alert">
        <p class="coach-home-state-title">Today's overview could not be loaded.</p>
        <p class="builder-error">${escapeHtml(error)}</p>
        <button class="plain-button coach-home-state-button" type="button" data-action="coach-home-retry">Try again</button>
      </div>`;
}

export function renderCoachHomeHtml({ rows = [], error = "", user, picker = {} }) {
  const workspace = user?.activeWorkspace;
  const platform = workspace?.type === "platform";
  const workspaces = (user?.availableWorkspaces || []).filter((entry) => entry.type !== "platform");
  const body = platform
    ? `${error ? `<p class="builder-error" role="alert">${escapeHtml(error)}</p>` : ""}${workspaces.length ? `<ul class="coach-home-workspaces">${renderWorkspaceList(workspaces)}</ul>` : `<p class="muted">No coaching workspaces available.</p>`}`
    : error ? renderErrorStateHtml(error) : rows.length ? renderWorkflowsHtml(rows, picker) : renderEmptyStateHtml();
  return `<section class="content-section coach-home">
    <header class="coach-home-header"><h2>${escapeHtml(coachHomeWorkspaceLabel(workspace))}</h2>
      ${!platform ? `<button class="plain-button icon-button athlete-toolbar-add-button" type="button" data-action="home-add-athlete" aria-label="Add athlete" title="Add athlete">${ICON_ADD_ATHLETE}</button>` : ""}
    </header>
    ${body}
  </section>`;
}

export function renderCoachHomeAthleteRows(rows, picker = {}) {
  const query = (picker.query || "").trim().toLocaleLowerCase();
  const scopedRows = picker.mode === "today" ? rows.filter((row) => row.hasTrainingToday) : rows;
  const matches = sortAthletes(scopedRows).filter((row) => athleteMatches(row, query));
  return matches.map((row) => `<button class="coach-home-athlete-row" type="button" data-action="coach-home-open-athlete" data-mode="${picker.mode === "load" ? "load" : picker.mode === "today" ? "today" : "plan"}" data-athlete-id="${escapeAttr(row.athleteId)}" data-athlete-uuid="${escapeAttr(row.athleteUuid || "")}">
    ${row.athleteImageUrl ? renderImage(row.athleteImageUrl, "coach-home-avatar") : `<span class="coach-home-avatar coach-home-avatar-fallback">${escapeHtml(programInitials(row.athlete || "Athlete"))}</span>`}
    <span><strong>${escapeHtml(row.athlete)}</strong><small>${row.hasTrainingToday ? `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"} today` : "No session today"}</small></span>
  </button>`).join("") || `<p class="muted">${scopedRows.length ? "No athletes match your search." : picker.mode === "today" ? "No athletes have a session scheduled today." : "No athletes in this workspace."}</p>`;
}
