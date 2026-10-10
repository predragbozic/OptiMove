import { renderImage } from "./media.js";
import { ICON_CALENDAR } from "./athlete-home.js";
import { ICON_ADD_ATHLETE } from "./organization-view.js";
import { escapeAttr, escapeHtml, programInitials } from "./utils.js";

const ICON_LOAD = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"></path><path d="M6 20v-6"></path><path d="M6 14l3-3 3 2 6-6"></path><path d="M18 7h-3v3"></path></svg>`;

export function coachHomeWorkspaceLabel(workspace) {
  if (workspace?.type === "private_coach") return "Private coaching";
  if (workspace?.type === "platform") return "Platform administration";
  return workspace?.label || "Home";
}

export function renderCoachHomeHtml({ rows = [], error = "", user, picker = {} }) {
  const workspace = user?.activeWorkspace;
  const platform = workspace?.type === "platform";
  const withTraining = rows.filter((row) => row.hasTrainingToday);
  const workspaces = (user?.availableWorkspaces || []).filter((entry) => entry.type !== "platform");
  return `<section class="content-section coach-home">
    <header class="coach-home-header"><h2>${escapeHtml(coachHomeWorkspaceLabel(workspace))}</h2>
      ${!platform ? `<button class="plain-button icon-button athlete-toolbar-add-button" type="button" data-action="home-add-athlete" aria-label="Add athlete" title="Add athlete">${ICON_ADD_ATHLETE}</button>` : ""}
    </header>
    ${error ? `<p class="builder-error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${platform ? `<div class="coach-home-workspaces">${workspaces.map((entry) => `<button class="coach-home-workspace" type="button" data-action="workspace-select" data-workspace-type="${escapeAttr(entry.type)}" data-workspace-scope-id="${escapeAttr(entry.scopeId || "")}"><strong>${escapeHtml(coachHomeWorkspaceLabel(entry))}</strong><span>${escapeHtml(entry.type === "club" ? "Club" : entry.type === "team" ? "Team" : entry.type === "athlete" ? "Athlete" : "Private")}</span></button>`).join("") || `<p class="muted">No coaching workspaces available.</p>`}</div>` : `
      <div class="coach-home-actions">
        <button type="button" data-action="coach-home-picker-open" data-mode="plan">${ICON_CALENDAR}<span>Training Plan</span></button>
        <button type="button" data-action="coach-home-picker-open" data-mode="load">${ICON_LOAD}<span>Training Load</span></button>
      </div>
      <div class="coach-home-today"><h3>Today</h3><span>${withTraining.length} / ${rows.length} athletes training</span></div>
      ${picker.mode ? `<dialog class="coach-home-picker" aria-labelledby="coachHomePickerTitle">
        <header><h3 id="coachHomePickerTitle">${picker.mode === "load" ? "Training Load" : "Training Plan"}</h3><button class="plain-button icon-button" type="button" data-action="coach-home-picker-close" aria-label="Close athlete list" title="Close">&times;</button></header>
        <input type="search" data-coach-home-search placeholder="Search athletes" aria-label="Search athletes" value="${escapeAttr(picker.query || "")}">
        <div class="coach-home-picker-list">${renderCoachHomeAthleteRows(rows, picker)}</div>
      </dialog>` : ""}
    `}
  </section>`;
}

export function renderCoachHomeAthleteRows(rows, picker = {}) {
  const query = (picker.query || "").trim().toLocaleLowerCase();
  const matches = rows.filter((row) => `${row.athlete} ${row.athleteId}`.toLocaleLowerCase().includes(query));
  return matches.map((row) => `<button class="coach-home-athlete-row" type="button" data-action="coach-home-open-athlete" data-mode="${picker.mode === "load" ? "load" : "plan"}" data-athlete-id="${escapeAttr(row.athleteId)}" data-athlete-uuid="${escapeAttr(row.athleteUuid || "")}">
    ${row.athleteImageUrl ? renderImage(row.athleteImageUrl, "coach-home-avatar") : `<span class="coach-home-avatar coach-home-avatar-fallback">${escapeHtml(programInitials(row.athlete || "Athlete"))}</span>`}
    <span><strong>${escapeHtml(row.athlete)}</strong><small>${row.hasTrainingToday ? `${row.sessionCount} ${row.sessionCount === 1 ? "session" : "sessions"} today` : "No session today"}</small></span>
  </button>`).join("") || `<p class="muted">${rows.length ? "No athletes match your search." : "No athletes in this workspace."}</p>`;
}
