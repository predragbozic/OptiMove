import { renderImage } from "./media.js";
import { renderSettingsNavHtml } from "./navigation.js";
import { renderFilterableSelect } from "./organization-select.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export function renderOrganizationPanelHtml({ currentUser, data, error, role, scope }) {
  return `
    <section class="content-section organization-view">
      <section class="panel organization-hero">
        <div>
          <p class="eyebrow">Signed in as</p>
          <h3>${escapeHtml(currentUser?.name || currentUser?.email || "User")}</h3>
          <p class="muted">${escapeHtml(currentUser?.email || "")}</p>
        </div>
        <div class="organization-scope-card">
          <span>${escapeHtml(role)}</span>
          <strong>${escapeHtml(scope)}</strong>
        </div>
      </section>
      ${error ? `<p class="builder-error">${escapeHtml(error)}</p>` : ""}
      ${renderSettingsNavHtml()}
      ${renderOrganizationActions(data)}
      ${renderOrganizationBrowser(data)}
      ${state.organizationEditor.open ? renderOrganizationEditModal(data) : ""}
    </section>
  `;
}

export function renderOrganizationActions(data) {
  const section = state.organization.section || "overview";
  const actions = {
    overview: "",
    clubs: data.canCreateClub ? renderOrganizationClubForm() : "",
    teams: data.canCreateTeam ? renderOrganizationTeamForm(data.clubs) : "",
    athletes: data.canCreateAthlete ? renderOrganizationAthleteForm(data.clubs, data.teams) : "",
    users: `${data.canCreateUser ? renderOrganizationUserForm() : ""}${renderOrganizationRoleForms(data)}`,
  }[section] || "";
  return actions ? `<section class="organization-actions">${actions}</section>` : "";
}

function renderOrganizationUserForm() {
  const roles = [
    ["athlete", "Athlete login"],
    ["coach", "Independent coach"],
    ["team_coach", "Team coach"],
    ["club_admin", "Club admin"],
    ["platform_admin", "Platform admin"],
  ];
  return `
    <form class="panel organization-form" data-organization-form="user">
      <div><p class="eyebrow">Access</p><h3>Add user account</h3></div>
      <label class="search-field"><span>Full name</span><input name="fullName" placeholder="Name"></label>
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="name@example.com"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters"></label>
      <label class="search-field"><span>Role</span><select name="roleHint">${roles.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add user</button>
    </form>
  `;
}

export function normalizeOrganizationSelection(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const selectedClubExists = clubs.some((club) => String(club.id) === String(state.organization.selectedClubId));
  if (state.organization.selectedClubId && !selectedClubExists) state.organization.selectedClubId = "";
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  if (state.organization.selectedTeamId && !selectedTeam) state.organization.selectedTeamId = "";
  if (selectedTeam?.club_id && !state.organization.selectedClubId) state.organization.selectedClubId = selectedTeam.club_id;
}

function renderOrganizationSelectableList(title, rows, type, selectedId) {
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      <div class="organization-list">
        ${rows.length ? rows.map((row) => renderOrganizationSelectableRow(row, type, selectedId)).join("") : `<p class="muted">No ${escapeHtml(title.toLowerCase())} yet.</p>`}
      </div>
    </section>
  `;
}

function renderOrganizationSelectableRow(row, type, selectedId) {
  const isSelected = String(row.id) === String(selectedId);
  return `
    <article class="organization-row ${isSelected ? "is-selected" : ""}">
      <button class="organization-row-main" type="button" data-action="organization-select-${escapeAttr(type)}" data-${escapeAttr(type)}-id="${escapeAttr(row.id)}">
        ${renderOrganizationRowContent(row, type)}
      </button>
      <span class="organization-row-actions"><button class="text-action" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Edit</button><button class="text-action danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Delete</button></span>
    </article>
  `;
}

export function renderOrganizationBrowser(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const athletes = data.athletes || [];
  const users = data.users || [];
  const accessRequests = data.accessRequests || [];
  const section = state.organization.section || "overview";
  const selectedClub = clubs.find((club) => String(club.id) === String(state.organization.selectedClubId));
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  const visibleTeams = state.organization.selectedClubId
    ? teams.filter((team) => String(team.club_id) === String(state.organization.selectedClubId))
    : teams;
  const visibleAthletes = state.organization.selectedTeamId
    ? athletes.filter((athlete) => String(athlete.team_id) === String(state.organization.selectedTeamId))
    : state.organization.selectedClubId
      ? athletes.filter((athlete) => String(athlete.club_id) === String(state.organization.selectedClubId) || visibleTeams.some((team) => String(team.id) === String(athlete.team_id)))
      : athletes;
  return `
    <section class="organization-browser">
      <div class="organization-browser-head">
        <div>
          <p class="eyebrow">Organization browser</p>
          <h3>${escapeHtml(selectedTeam?.name || selectedClub?.name || "All accessible organization")}</h3>
          <p class="muted">${escapeHtml(selectedTeam ? `${visibleAthletes.length} athletes in team` : selectedClub ? `${visibleTeams.length} teams - ${visibleAthletes.length} athletes` : `${clubs.length} clubs - ${teams.length} teams - ${athletes.length} athletes`)}</p>
        </div>
        ${state.organization.selectedClubId || state.organization.selectedTeamId ? `<button class="text-action" type="button" data-action="organization-clear-selection">Show all</button>` : ""}
      </div>
      <section class="organization-lists organization-lists-browser">
        ${section === "overview" || section === "athletes" ? renderProgramAccessRequests(accessRequests) : ""}
        ${section === "overview" || section === "users" ? renderOrganizationList("Users", users, "user") : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList("Clubs", clubs, "club", state.organization.selectedClubId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList(selectedClub ? `Teams - ${selectedClub.name}` : "Teams", visibleTeams, "team", state.organization.selectedTeamId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" || section === "athletes" ? selectedTeam ? renderTeamAthleteTable(selectedTeam, visibleAthletes, athletes) : renderOrganizationList(selectedClub ? `Athletes - ${selectedClub.name}` : "Athletes", visibleAthletes, "athlete") : ""}
      </section>
      ${state.organizationInvite.open ? renderAthleteInviteModal(athletes) : ""}
    </section>
  `;
}

function renderProgramAccessRequests(rows) {
  return `
    <section class="panel organization-list-card organization-access-requests">
      <div class="organization-list-head">
        <div><p class="eyebrow">Program access</p><h3>Pending requests</h3></div>
        <strong>${rows.length}</strong>
      </div>
      <div class="organization-list">
        ${rows.length ? rows.map(renderProgramAccessRequestRow).join("") : `<p class="muted">No pending program requests.</p>`}
      </div>
    </section>
  `;
}

function renderProgramAccessRequestRow(row) {
  const image = row.athlete_image_url || "";
  const date = row.created_at ? new Date(row.created_at).toLocaleDateString("en-GB") : "";
  return `
    <article class="organization-row organization-request-row">
      <span class="organization-table-athlete">
        ${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">AT</span>`}
        <span>
          <strong>${escapeHtml(row.athlete_name || "Athlete")}</strong>
          <small>${escapeHtml([row.athlete_code ? `ID ${row.athlete_code}` : "", date].filter(Boolean).join(" - "))}</small>
        </span>
      </span>
      <span>
        <strong>${escapeHtml(row.program_name || "Program")}</strong>
        <small>${escapeHtml(row.library_category || "General")}</small>
      </span>
      <span class="organization-row-actions">
        <button class="text-action" type="button" data-action="organization-access-approve" data-access-id="${escapeAttr(row.id)}">Approve</button>
        <button class="text-action danger-action" type="button" data-action="organization-access-reject" data-access-id="${escapeAttr(row.id)}">Reject</button>
      </span>
    </article>
  `;
}

function renderAssignAthleteToTeamForm(team, visibleAthletes, allAthletes) {
  const assignedIds = new Set(visibleAthletes.map((athlete) => String(athlete.id)));
  const options = allAthletes
    .filter((athlete) => !assignedIds.has(String(athlete.id)) && !athlete.team_id)
    .map((athlete) => ({ value: athlete.id, label: [athlete.name, athlete.athlete_id ? `ID ${athlete.athlete_id}` : "", athlete.club_name || "No club"].filter(Boolean).join(" - ") }));
  return `
    <form class="organization-form organization-assign-panel" data-organization-form="assignTeamAthlete" data-team-id="${escapeAttr(team.id)}">
      <div><p class="eyebrow">Existing athletes</p><h3>Add athlete to ${escapeHtml(team.name)}</h3><p class="muted">Shows athletes without a team. Assigning also sets the club to ${escapeHtml(team.club_name || "this team's club")}.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options, required: true, placeholder: "Type athlete name or ID" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Assign athlete</button>
    </form>
  `;
}

function renderTeamAthleteTable(team, teamAthletes, allAthletes) {
  return `
    <section class="panel organization-list-card organization-team-detail">
      <div class="organization-list-head organization-team-head">
        <div>
          <p class="eyebrow">Team roster</p>
          <h3>${escapeHtml(team.name)}</h3>
          <p class="muted">${escapeHtml(team.club_name || "No club")} - ${teamAthletes.length} athletes</p>
        </div>
        <button class="plain-button compact-button" type="button" data-action="organization-toggle-assign-athlete">${state.organization.assignOpen ? "Close add" : "Add athlete"}</button>
      </div>
      ${state.organization.assignOpen ? renderAssignAthleteToTeamForm(team, teamAthletes, allAthletes) : ""}
      <div class="organization-table" role="table" aria-label="${escapeAttr(team.name)} athletes">
        <div class="organization-table-row organization-table-head" role="row">
          <span>Athlete</span><span>ID</span><span>Login</span><span></span>
        </div>
        ${teamAthletes.length ? teamAthletes.map((athlete) => renderTeamAthleteRow(athlete)).join("") : `<p class="muted organization-empty-row">No athletes assigned to this team yet.</p>`}
      </div>
    </section>
  `;
}

function renderTeamAthleteRow(athlete) {
  const image = athlete.image_url || "";
  return `
    <div class="organization-table-row" role="row">
      <span class="organization-table-athlete">${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">AT</span>`}<strong>${escapeHtml(athlete.name || "Athlete")}</strong></span>
      <span>${escapeHtml(athlete.athlete_id || athlete.source_external_id || "-")}</span>
      <span>${athlete.user_id ? "Enabled" : "No login"}</span>
      <span class="organization-row-actions">
        <button class="text-action" type="button" data-action="organization-invite-athlete" data-athlete-id="${escapeAttr(athlete.id)}">Invite</button>
        <button class="text-action" type="button" data-action="organization-edit" data-org-type="athlete" data-org-id="${escapeAttr(athlete.id)}">Edit</button>
      </span>
    </div>
  `;
}

function renderAthleteInviteModal(athletes) {
  const athlete = athletes.find((entry) => String(entry.id) === String(state.organizationInvite.athleteId));
  if (!athlete) return "";
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-invite-close" aria-label="Close invite"></button>
      <section class="panel exercise-tag-modal organization-invite-modal" role="dialog" aria-modal="true" aria-label="Athlete invite">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Athlete invite</p><h3>${escapeHtml(athlete.name || "Athlete")}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="organization-invite-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <form class="organization-form" data-organization-form="athleteInvite">
          <input type="hidden" name="athleteId" value="${escapeAttr(athlete.id)}">
          <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="athlete@example.com"></label>
          <p class="builder-error" aria-live="polite">${escapeHtml(state.organizationInvite.error || "")}</p>
          <button class="plain-button" type="submit">Create invite email</button>
        </form>
        ${state.organizationInvite.inviteUrl ? `
          <div class="invite-result">
            <p class="muted">Send this activation link to the athlete. They will open it and set their own password. It expires in 14 days.</p>
            <input readonly value="${escapeAttr(state.organizationInvite.inviteUrl)}">
            <div class="invite-actions">
              <button class="plain-button compact-button" type="button" data-action="organization-copy-invite">Copy link</button>
              <a class="plain-button compact-button" href="${escapeAttr(state.organizationInvite.mailtoUrl || "#")}">Open email draft</a>
            </div>
          </div>
        ` : ""}
      </section>
    </div>
  `;
}

function renderOrganizationClubForm() {
  return `
    <form class="panel organization-form" data-organization-form="club">
      <div><p class="eyebrow">Platform</p><h3>Add club</h3></div>
      <label class="search-field"><span>Club name</span><input name="name" required placeholder="e.g. FK Borac"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" placeholder="e.g. Borac"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" placeholder="https://..."></label>
      <div class="organization-form-row">
        <label class="search-field"><span>City</span><input name="city"></label>
        <label class="search-field"><span>Country</span><input name="country"></label>
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add club</button>
    </form>
  `;
}

function renderOrganizationTeamForm(clubs) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  return `
    <form class="panel organization-form" data-organization-form="team">
      <div><p class="eyebrow">Club</p><h3>Add team</h3></div>
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, required: true, placeholder: "Type club name" })}
      <label class="search-field"><span>Team name</span><input name="name" required placeholder="e.g. First team"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" placeholder="e.g. U19"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" placeholder="https://..."></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${clubs.length ? "" : "disabled"}>Add team</button>
    </form>
  `;
}

function renderOrganizationAthleteForm(clubs, teams) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = teams.map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  return `
    <form class="panel organization-form" data-organization-form="athlete">
      <div><p class="eyebrow">Athletes</p><h3>Add athlete</h3></div>
      <label class="search-field"><span>Athlete name</span><input name="fullName" required placeholder="First and last name"></label>
      <label class="search-field"><span>External ID</span><input name="athleteId" placeholder="Optional old ID"></label>
      <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" placeholder="https://..."></label>
      <div class="organization-form-row">
        ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, placeholder: "Type club name", includeEmpty: "No club", extraSelectAttrs: "data-organization-club-select" })}
        ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, placeholder: "Type team name", includeEmpty: "No team", extraSelectAttrs: "data-organization-team-select" })}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Add athlete</button>
    </form>
  `;
}

function renderOrganizationRoleForms(data) {
  const users = data.users || [];
  if (!users.length) return "";
  const userOptions = users.map((user) => ({ value: user.id, label: `${user.name || user.email}${user.email ? ` - ${user.email}` : ""}` }));
  const clubOptions = (data.clubs || []).map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = (data.teams || []).map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  const athleteOptions = (data.athletes || []).map((athlete) => ({ value: athlete.id, label: `${athlete.name}${athlete.athlete_id ? ` - ID ${athlete.athlete_id}` : ""}` }));
  return `
    <form class="panel organization-form" data-organization-form="clubRole">
      <div><p class="eyebrow">Club access</p><h3>Assign club admin</h3></div>
      ${renderFilterableSelect({ name: "userId", label: "User", options: userOptions, required: true, placeholder: "Type user name or email" })}
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, required: true, placeholder: "Type club name" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.clubs || []).length ? "" : "disabled"}>Assign club</button>
    </form>
    <form class="panel organization-form" data-organization-form="teamRole">
      <div><p class="eyebrow">Team access</p><h3>Assign team coach</h3></div>
      ${renderFilterableSelect({ name: "userId", label: "User", options: userOptions, required: true, placeholder: "Type user name or email" })}
      ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, required: true, placeholder: "Type team name" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.teams || []).length ? "" : "disabled"}>Assign team</button>
    </form>
    <form class="panel organization-form" data-organization-form="athleteLogin">
      <div><p class="eyebrow">Athlete app</p><h3>Manual athlete login</h3><p class="muted">For normal onboarding, use Invite on the athlete row so the athlete sets their own password.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options: athleteOptions, required: true, placeholder: "Type athlete name or ID" })}
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="athlete@example.com"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${(data.athletes || []).length ? "" : "disabled"}>Create login</button>
    </form>
  `;
}

function renderOrganizationList(title, rows, type) {
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      <div class="organization-list">
        ${rows.length ? rows.map((row) => renderOrganizationRowV2(row, type)).join("") : `<p class="muted">No ${escapeHtml(title.toLowerCase())} yet.</p>`}
      </div>
    </section>
  `;
}

function renderOrganizationRowV2(row, type) {
  return `
    <article class="organization-row">
      ${renderOrganizationRowContent(row, type)}
      ${type === "user" ? "" : `<span class="organization-row-actions"><button class="text-action" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Edit</button><button class="text-action danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}">Delete</button></span>`}
    </article>
  `;
}

function renderOrganizationRowContent(row, type) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  const subtitle = type === "athlete"
    ? [row.athlete_id || row.source_external_id, row.team_name, row.club_name, row.user_id ? "login enabled" : ""].filter(Boolean).join(" - ")
    : type === "user"
      ? [row.email, row.role_hint].filter(Boolean).join(" - ")
      : [row.short_name, row.club_name, row.city, row.country].filter(Boolean).join(" - ");
  const image = row.image_url || row.logo_url || "";
  return `
    ${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">${escapeHtml(type.slice(0, 2).toUpperCase())}</span>`}
    <span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(subtitle || type)}</small></span>
  `;
}

export function renderOrganizationEditModal(data) {
  const { type, row } = state.organizationEditor;
  if (!row) return "";
  const title = `Edit ${type}`;
  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-edit-close" aria-label="Close editor"></button>
      <section class="panel exercise-tag-modal organization-edit-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Organization</p><h3>${escapeHtml(title)}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="organization-edit-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${type === "club" ? renderOrganizationClubEditForm(row) : type === "team" ? renderOrganizationTeamEditForm(row, data.clubs || []) : `${renderOrganizationAthleteEditForm(row, data.clubs || [], data.teams || [])}${renderAthleteLibraryAccessForm(row)}`}
      </section>
    </div>
  `;
}

function renderOrganizationClubEditForm(row) {
  return `
    <form class="organization-form" data-organization-form="edit-club" data-organization-edit-id="${escapeAttr(row.id)}">
      <label class="search-field"><span>Club name</span><input name="name" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" value="${escapeAttr(row.short_name || "")}"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" value="${escapeAttr(row.logo_url || "")}"></label>
      <div class="organization-form-row"><label class="search-field"><span>City</span><input name="city" value="${escapeAttr(row.city || "")}"></label><label class="search-field"><span>Country</span><input name="country" value="${escapeAttr(row.country || "")}"></label></div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderOrganizationTeamEditForm(row, clubs) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  return `
    <form class="organization-form" data-organization-form="edit-team" data-organization-edit-id="${escapeAttr(row.id)}">
      ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: row.club_id, required: true, placeholder: "Type club name" })}
      <label class="search-field"><span>Team name</span><input name="name" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>Short name</span><input name="shortName" value="${escapeAttr(row.short_name || "")}"></label>
      <label class="search-field"><span>Logo URL</span><input name="logoUrl" type="url" value="${escapeAttr(row.logo_url || "")}"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderOrganizationAthleteEditForm(row, clubs, teams) {
  const clubOptions = clubs.map((club) => ({ value: club.id, label: club.name }));
  const teamOptions = teams.map((team) => ({ value: team.id, label: `${team.name}${team.club_name ? ` - ${team.club_name}` : ""}`, clubId: team.club_id }));
  return `
    <form class="organization-form" data-organization-form="edit-athlete" data-organization-edit-id="${escapeAttr(row.id)}">
      <label class="search-field"><span>Athlete name</span><input name="fullName" required value="${escapeAttr(row.name || "")}"></label>
      <label class="search-field"><span>External ID</span><input name="athleteId" value="${escapeAttr(row.athlete_id || row.source_external_id || "")}"></label>
      <label class="search-field"><span>Image URL</span><input name="imageUrl" type="url" value="${escapeAttr(row.image_url || "")}"></label>
      <div class="organization-form-row">
        ${renderFilterableSelect({ name: "clubId", label: "Club", options: clubOptions, value: row.club_id, placeholder: "Type club name", includeEmpty: "No club", extraSelectAttrs: "data-organization-club-select" })}
        ${renderFilterableSelect({ name: "teamId", label: "Team", options: teamOptions, value: row.team_id, placeholder: "Type team name", includeEmpty: "No team", extraSelectAttrs: "data-organization-team-select" })}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit">Save changes</button>
    </form>
  `;
}

function renderAthleteLibraryAccessForm(row) {
  return `
    <form class="organization-form athlete-access-form" data-organization-form="athleteLibraryAccess" data-athlete-id="${escapeAttr(row.id)}">
      <div>
        <p class="eyebrow">Athlete library access</p>
        <h3>Visible program libraries</h3>
        <p class="muted">Control what this athlete can browse from Program Library. Assigned weekly and specific programs stay visible as before.</p>
      </div>
      <div class="athlete-access-grid">
        ${renderAccessCheckbox("canViewCoachLibrary", "Coach library", row.can_view_coach_library !== false)}
        ${renderAccessCheckbox("canViewClubLibrary", "Club library", row.can_view_club_library === true)}
        ${renderAccessCheckbox("canViewOptimoveLibrary", "OptiMove", row.can_view_optimove_library === true)}
        ${renderAccessCheckbox("canViewMarketplace", "Marketplace", row.can_view_marketplace === true)}
        ${renderAccessCheckbox("freeOnly", "Free programs only", row.free_only !== false)}
        ${renderAccessCheckbox("requireApproval", "Require approval", row.require_approval !== false)}
      </div>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button compact-button" type="submit">Save library access</button>
    </form>
  `;
}

function renderAccessCheckbox(name, label, checked) {
  return `
    <label class="program-checkbox">
      <input type="checkbox" name="${escapeAttr(name)}" value="true" ${checked ? "checked" : ""}>
      <span>${escapeHtml(label)}</span>
    </label>
  `;
}
