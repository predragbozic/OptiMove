import { renderImage } from "./media.js";
import { renderSettingsNavHtml } from "./navigation.js";
import { renderFilterableSelect } from "./organization-select.js";
import { renderTaxonomyPanelHtml } from "./taxonomy-view.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Same figure as the sidebar's "Athletes" nav icon, with a plus badge added
// (matching the document+plus "New" icon used for weekly plans) instead of
// a generic stock "add person" icon.
export const ICON_ADD_ATHLETE = `
  <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true">
    <path d="M14 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-3A3.5 3.5 0 0 0 4 17.5V19"></path>
    <circle cx="9" cy="7" r="3"></circle>
    <circle cx="18" cy="18" r="4.5" fill="currentColor"></circle>
    <path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path>
  </svg>
`;
const ICON_PENCIL = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 20l1-4.5L15.5 5 19 8.5 8.5 19 4 20z"></path><path d="M13 7l4 4"></path></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"></path></svg>`;
const ICON_ARCHIVE = `<svg viewBox="0 0 24 24" class="builder-icon-svg" aria-hidden="true"><rect x="3.5" y="4" width="17" height="4.5" rx="1"></rect><path d="M4.5 8.5v9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-9"></path><path d="M10 13h4"></path></svg>`;

// Club badge/shield with a small ball at its center, matching the reference
// "SPORT CLUB" ribbon-badge image, plus the same white-on-fill plus badge
// used elsewhere for "add" triggers.
const ICON_ADD_CLUB = `
  <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true">
    <path d="M9 3h6v3.2l3 1.4v4.4c0 4-2.8 7-6 8.3-3.2-1.3-6-4.3-6-8.3V7.6l3-1.4V3z"></path>
    <circle cx="12" cy="10.5" r="2"></circle>
    <circle cx="18" cy="18" r="4.5" fill="currentColor"></circle>
    <path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path>
  </svg>
`;

// Three overlapping figures (team roster), plus the same plus badge.
const ICON_ADD_TEAM = `
  <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true">
    <circle cx="4.5" cy="7.5" r="1.8"></circle>
    <path d="M4.5 10.3c-1.6 0-2.9 1.2-2.9 2.7v1.3h5.8v-1.3c0-1.5-1.3-2.7-2.9-2.7z"></path>
    <circle cx="12.5" cy="6" r="2.1"></circle>
    <path d="M12.5 9c-2 0-3.7 1.5-3.7 3.4v2.1h7.4v-2.1c0-1.9-1.7-3.4-3.7-3.4z"></path>
    <circle cx="4.5" cy="7.5" r="1.8" fill="none"></circle>
    <circle cx="18" cy="18" r="4.5" fill="currentColor"></circle>
    <path d="M18 15.8v4.4M15.8 18h4.4" stroke="var(--surface, #fff)" stroke-width="1.4" stroke-linecap="round"></path>
  </svg>
`;

// Person figure combined with two small badges: a plus (add) and a pencil
// (edit) - this section hides both "add user" and "assign role" forms
// behind one trigger, so the icon needs to read as "add and edit".
const ICON_MANAGE_USERS = `
  <svg viewBox="0 0 24 24" class="rail-icon" aria-hidden="true">
    <path d="M11.5 18v-1.2a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3V18"></path>
    <circle cx="7.2" cy="6.8" r="2.6"></circle>
    <circle cx="17.5" cy="7.5" r="3.8" fill="currentColor"></circle>
    <path d="M17.5 5.6v3.8M15.6 7.5h3.8" stroke="var(--surface, #fff)" stroke-width="1.3" stroke-linecap="round"></path>
    <circle cx="17.5" cy="18" r="3.8" fill="currentColor"></circle>
    <path d="M15.7 19.3l3.1-3.1M15.4 19.6l.3-1.6 1-1 1.6-.3-1 1.6z" fill="var(--surface, #fff)" stroke="var(--surface, #fff)" stroke-width="0.4" stroke-linejoin="round"></path>
  </svg>
`;

export function renderOrganizationPanelHtml({ currentUser, data, error, role, scope }) {
  const pendingRequests = (data.accessRequests || []).filter((request) => request.status === "requested").length;
  if (state.organization.section === "requests") state.organization.section = "overview";
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
        ${pendingRequests ? `
          <button class="organization-request-summary" type="button" data-action="program-library-requests">
            <span>${pendingRequests}</span>
            <strong>${pendingRequests === 1 ? "program request" : "program requests"}</strong>
            <small>Review now</small>
          </button>
        ` : ""}
      </section>
      ${error ? `<p class="builder-error">${escapeHtml(error)}</p>` : ""}
      ${renderSettingsNavHtml(data)}
      ${state.organization.section === "presets" ? renderTaxonomyPanelHtml(data) : state.organization.section === "joinLinks" ? `
        ${renderOrganizationActions(data)}
        ${renderJoinLinksSection(data)}
      ` : `
        ${renderOrganizationActions(data)}
        ${renderOrganizationBrowser(data)}
        ${state.organizationEditor.open ? renderOrganizationEditModal(data) : ""}
      `}
    </section>
  `;
}

const organizationAddFormConfig = {
  clubs: (data) => (data.canCreateClub ? { icon: ICON_ADD_CLUB, label: "Add club", render: () => renderOrganizationClubForm() } : null),
  teams: (data) => (data.canCreateTeam ? { icon: ICON_ADD_TEAM, label: "Add team", render: () => renderOrganizationTeamForm(data.clubs) } : null),
  athletes: (data) => (data.canCreateAthlete ? { icon: ICON_ADD_ATHLETE, label: "Add athlete", render: () => renderOrganizationAthleteForm(data.clubs, data.teams) } : null),
  users: (data) => (data.canCreateUser || (data.users || []).length
    ? { icon: ICON_MANAGE_USERS, label: "Add or manage users", render: () => `${data.canCreateUser ? renderOrganizationUserForm() : ""}${renderOrganizationRoleForms(data)}` }
    : null),
  // A join link's context comes from the account's own CURRENT active
  // workspace (private_coach/club/team) - there is no platform-wide join
  // link (see backend/src/joinLinkContext.js), so a platform (or athlete)
  // workspace never offers this trigger at all, matching the backend, which
  // would reject the create call regardless.
  joinLinks: () => (["private_coach", "club", "team"].includes(state.currentUser?.activeWorkspace?.type)
    ? { icon: ICON_ADD_ATHLETE, label: "Create join link", render: () => renderJoinLinkCreateFormHtml() }
    : null),
};

export function renderOrganizationActions(data) {
  const section = state.organization.section || "overview";
  const config = organizationAddFormConfig[section]?.(data);
  if (!config) return "";
  const isOpen = state.organization.addFormOpen;
  return `
    <section class="organization-actions">
      <button class="plain-button icon-button organization-add-toggle ${isOpen ? "is-open" : ""}" type="button" data-action="organization-toggle-add-form" aria-expanded="${isOpen}" aria-label="${escapeAttr(config.label)}" title="${escapeAttr(config.label)}">${config.icon}</button>
      ${isOpen ? config.render() : ""}
    </section>
  `;
}

function renderOrganizationUserForm() {
  const roles = [
    ["coach", "Independent coach"],
    ["team_coach", "Team coach"],
    ["club_admin", "Club admin"],
    ["platform_admin", "Platform admin"],
  ];
  return `
    <form class="panel organization-form" data-organization-form="user">
      <div><p class="eyebrow">Access</p><h3>Add user account</h3></div>
      <label class="search-field"><span>Full name</span><input name="fullName" placeholder="Name"></label>
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="example@example.com" autocomplete="off"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters" autocomplete="new-password"></label>
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
      <span class="organization-row-actions"><button class="plain-button icon-button" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}" aria-label="Edit" title="Edit">${ICON_PENCIL}</button><button class="plain-button icon-button danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}" aria-label="Delete" title="Delete">${ICON_TRASH}</button></span>
    </article>
  `;
}

// True when the athlete has a currently ACTIVE membership matching the given
// filters. An athlete can hold several active club/team memberships at
// once, so this is always an existence check over the memberships array
// returned by the backend (never the legacy single club_id/team_id).
function hasActiveMembership(athlete, { clubId, teamId } = {}) {
  return (athlete.memberships || []).some((m) => (
    m.status === "active"
    && (clubId === undefined || String(m.clubId) === String(clubId))
    && (teamId === undefined || String(m.teamId) === String(teamId))
  ));
}

function archivedMembershipsFor(athletes, { clubId, teamId } = {}) {
  return athletes.filter((athlete) => (athlete.memberships || []).some((m) => (
    m.status === "archived"
    && (clubId === undefined || String(m.clubId) === String(clubId))
    && (teamId === undefined || String(m.teamId) === String(teamId))
  )));
}

export function renderOrganizationBrowser(data) {
  const clubs = data.clubs || [];
  const teams = data.teams || [];
  const isPlatformAdmin = Boolean(data.isPlatformAdmin);
  // Every athlete row the backend allowed this viewer to see at all - this
  // INCLUDES archived-only rows (returned purely so Show archived/Restore
  // have something to work with). Team/club archived lists and the two
  // "archived because of me" lists below must all be computed from this,
  // never from the active-only list - otherwise an athlete whose only tie
  // to a specific team/club is archived would vanish from that team/club's
  // "Show archived" the moment it stopped being active.
  const allReturnedAthletes = data.athletes || [];
  // is_active alone is the PROFILE flag - it says nothing about whether this
  // viewer's own tie to the athlete is still active. has_active_access is
  // the flag computed server-side for that decision. Only THIS list may
  // feed the active roster, the team/club "currently on this roster" rows,
  // Access control, and Invite - never allReturnedAthletes directly.
  const activeAthletes = allReturnedAthletes.filter((athlete) => athlete.is_active !== false && athlete.has_active_access);
  const myArchivedCoachRelationships = allReturnedAthletes.filter((athlete) => athlete.has_my_archived_coach_relationship);
  const archivedProfiles = isPlatformAdmin ? allReturnedAthletes.filter((athlete) => athlete.is_active === false) : [];
  const section = state.organization.section || "overview";
  const selectedClub = clubs.find((club) => String(club.id) === String(state.organization.selectedClubId));
  const selectedTeam = teams.find((team) => String(team.id) === String(state.organization.selectedTeamId));
  const visibleTeams = state.organization.selectedClubId
    ? teams.filter((team) => String(team.club_id) === String(state.organization.selectedClubId))
    : teams;
  const visibleAthletes = state.organization.selectedTeamId
    ? activeAthletes.filter((athlete) => hasActiveMembership(athlete, { teamId: state.organization.selectedTeamId }))
    : state.organization.selectedClubId
      ? activeAthletes.filter((athlete) => hasActiveMembership(athlete, { clubId: state.organization.selectedClubId }))
      : activeAthletes;
  return `
    <section class="organization-browser">
      <div class="organization-browser-head">
        <div>
          <p class="eyebrow">Organization browser</p>
          <h3>${escapeHtml(selectedTeam?.name || selectedClub?.name || "All accessible organization")}</h3>
          <p class="muted">${escapeHtml(selectedTeam ? `${visibleAthletes.length} athletes in team` : selectedClub ? `${visibleTeams.length} teams - ${visibleAthletes.length} athletes` : `${clubs.length} clubs - ${teams.length} teams - ${activeAthletes.length} athletes`)}</p>
        </div>
        <div class="organization-browser-actions">
          ${section === "athletes" && visibleAthletes.length ? `<button class="plain-button compact-button" type="button" data-action="organization-toggle-athlete-access">Access control</button>` : ""}
          ${section === "athletes" && !selectedClub && !selectedTeam ? `<button class="plain-button compact-button" type="button" data-action="organization-toggle-archived-athletes">${state.organization.showArchivedAthletes ? "Hide archived" : `Show archived (${myArchivedCoachRelationships.length + archivedProfiles.length})`}</button>` : ""}
          ${state.organization.selectedClubId || state.organization.selectedTeamId ? `<button class="text-action" type="button" data-action="organization-clear-selection">Show all</button>` : ""}
        </div>
      </div>
      <section class="organization-lists organization-lists-browser">
        ${section === "overview" || section === "users" ? renderOrganizationUsersSection(data) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList("Clubs", clubs, "club", state.organization.selectedClubId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" ? renderOrganizationSelectableList(selectedClub ? `Teams - ${selectedClub.name}` : "Teams", visibleTeams, "team", state.organization.selectedTeamId) : ""}
        ${section === "overview" || section === "clubs" || section === "teams" || section === "athletes"
          ? selectedTeam
            ? renderTeamAthleteTable(selectedTeam, visibleAthletes, allReturnedAthletes)
            : selectedClub
              ? renderClubAthleteList(selectedClub, visibleAthletes, allReturnedAthletes)
              : renderOrganizationList("Athletes", visibleAthletes, "athlete", { isPlatformAdmin })
          : ""}
      </section>
      ${section === "athletes" && !selectedClub && !selectedTeam && state.organization.showArchivedAthletes ? renderArchivedAthletesList(myArchivedCoachRelationships, archivedProfiles, isPlatformAdmin) : ""}
      ${section === "athletes" && state.organization.accessOpen ? renderAthleteAccessModal(visibleAthletes) : ""}
      ${state.organizationInvite.open ? renderAthleteInviteModal(activeAthletes) : ""}
      ${state.organizationUserManage.open ? renderManageAccountModal(data) : ""}
    </section>
  `;
}

// Two clearly separate reasons an athlete can show up here - ending YOUR
// private-coach relationship (restorable by you) is a completely different
// action from archiving the whole sporting profile (platform admin only;
// login, sessions, and every individual relationship are left untouched).
// Never merged into one ambiguous "archived" row.
function renderArchivedAthletesList(myArchivedCoachRelationships, archivedProfiles, isPlatformAdmin) {
  return `
    <section class="panel organization-list-card organization-archived-athletes">
      <div class="organization-list-head"><p class="eyebrow">Archived from my athletes</p><strong>${myArchivedCoachRelationships.length}</strong></div>
      <div class="organization-list">
        ${myArchivedCoachRelationships.length ? myArchivedCoachRelationships.map(renderArchivedCoachRelationshipRow).join("") : `<p class="muted">No archived private-coach relationships.</p>`}
      </div>
    </section>
    ${isPlatformAdmin ? `
    <section class="panel organization-list-card organization-archived-athletes">
      <div class="organization-list-head"><p class="eyebrow">Archived sporting profiles (platform admin)</p><strong>${archivedProfiles.length}</strong></div>
      <div class="organization-list">
        ${archivedProfiles.length ? archivedProfiles.map(renderArchivedProfileRow).join("") : `<p class="muted">No archived profiles.</p>`}
      </div>
    </section>` : ""}
  `;
}

function renderArchivedCoachRelationshipRow(row) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  return `
    <article class="organization-row is-archived">
      <span class="organization-avatar">${escapeHtml((row.athlete_id || "AT").slice(0, 2).toUpperCase())}</span>
      <span><strong>${escapeHtml(title)}</strong><small>Archived from your athletes - login and history are kept</small></span>
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-restore-coach-relationship" data-athlete-id="${escapeAttr(row.id)}">Restore</button>
      </span>
    </article>
  `;
}

function renderArchivedProfileRow(row) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  return `
    <article class="organization-row is-archived">
      <span class="organization-avatar">${escapeHtml((row.athlete_id || "AT").slice(0, 2).toUpperCase())}</span>
      <span><strong>${escapeHtml(title)}</strong><small>Whole sporting profile archived - login and relationships are untouched</small></span>
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-restore-profile" data-athlete-id="${escapeAttr(row.id)}">Restore profile</button>
      </span>
    </article>
  `;
}

const accessControlGroups = [
  {
    id: "program",
    title: "Program access",
    icon: "PL",
    note: "Choose which program libraries these athletes can browse.",
    actions: [
      ["Coach library", "canViewCoachLibrary", "can_view_coach_library", true],
      ["Team library", "canViewTeamLibrary", "can_view_team_library", false],
      ["Club library", "canViewClubLibrary", "can_view_club_library", false],
      ["OptiMove", "canViewOptimoveLibrary", "can_view_optimove_library", false],
      ["Marketplace", "canViewMarketplace", "can_view_marketplace", false],
      ["Free programs only", "freeOnly", "free_only", true],
      ["Require approval", "requireApproval", "require_approval", true],
    ],
  },
  {
    id: "coach",
    title: "Coach visibility",
    icon: "CO",
    note: "Control which coach profiles can be discovered or contacted.",
    actions: [
      ["Own coach profile", "canViewCoachProfiles", "can_view_coach_profiles", true],
      ["Club coaches", "canViewClubCoachProfiles", "can_view_club_coach_profiles", false],
      ["Public coaches", "canViewPublicCoachProfiles", "can_view_public_coach_profiles", false],
      ["Contact visible coaches", "canContactVisibleCoaches", "can_contact_visible_coaches", false],
    ],
  },
  {
    id: "exercise",
    title: "Exercise access",
    icon: "EX",
    note: "Set exercise browsing outside assigned plans.",
    actions: [
      ["Assigned exercises", "canViewAssignedExercises", "can_view_assigned_exercises", true],
      ["Coach exercise library", "canViewCoachExerciseLibrary", "can_view_coach_exercise_library", false],
      ["Team exercise library", "canViewTeamExerciseLibrary", "can_view_team_exercise_library", false],
      ["Club exercise library", "canViewClubExerciseLibrary", "can_view_club_exercise_library", false],
      ["OptiMove exercise library", "canViewOptimoveExerciseLibrary", "can_view_optimove_exercise_library", false],
      ["Selected exercise groups", "canViewExerciseGroups", "can_view_exercise_groups", false],
    ],
  },
];

function renderAthleteAccessModal(athletes) {
  const ids = athletes.map((athlete) => athlete.id).filter(Boolean).join(",");
  if (!athletes.length) return "";
  return `
    <div class="athlete-access-modal-overlay" role="presentation">
      <button class="athlete-access-modal-backdrop" type="button" data-action="organization-toggle-athlete-access" aria-label="Close access control"></button>
      <section class="panel athlete-access-modal" role="dialog" aria-modal="true" aria-label="Athlete access control">
        <div class="athlete-access-modal-head">
          <div>
            <p class="eyebrow">Athlete access</p>
            <h3>Access control</h3>
            <p class="muted">Choose what the shown athletes can browse, then save the access profile.</p>
          </div>
          <button class="icon-button" type="button" data-action="organization-toggle-athlete-access" aria-label="Close">X</button>
        </div>
        <div class="athlete-access-count-strip">
          ${renderAthleteAccessClosedSummary(athletes)}
        </div>
        ${state.organization.accessMessage ? `<p class="builder-success">${escapeHtml(state.organization.accessMessage)}</p>` : ""}
        ${state.organization.accessError ? `<p class="builder-error">${escapeHtml(state.organization.accessError)}</p>` : ""}
        <form class="athlete-access-modal-form" data-organization-access-form data-athlete-ids="${escapeAttr(ids)}">
          <div class="athlete-access-control-grid">
            ${accessControlGroups.map((group) => renderAccessControlGroup(athletes, group)).join("")}
          </div>
          <div class="athlete-access-modal-actions">
            <button class="plain-button" type="button" data-action="organization-toggle-athlete-access">Cancel</button>
            <button class="primary-button" type="submit">Save access changes</button>
          </div>
        </form>
        <div class="athlete-access-summary-list">
          ${athletes.map(renderAthleteAccessSummaryRow).join("")}
        </div>
      </section>
    </div>
  `;
}

function renderAccessControlGroup(athletes, { id, title, icon, note, actions }) {
  const checkedCount = accessGroupCheckedCount(athletes, actions);
  const allChecked = actions.length > 0 && checkedCount === actions.length;
  const mixedChecked = checkedCount > 0 && !allChecked;
  return `
    <article class="athlete-access-control-card">
      <div class="athlete-access-control-card-head">
        <span>${escapeHtml(icon)}</span>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <p>${escapeHtml(note)}</p>
        </div>
      </div>
      <div class="athlete-access-control-bulk">
        <button class="checkbox-toggle-all ${allChecked ? "is-checked" : ""} ${mixedChecked ? "is-mixed" : ""}" type="button" data-action="organization-access-group-set" data-access-group="${escapeAttr(id)}" data-access-checked="${allChecked ? "false" : "true"}" aria-pressed="${allChecked ? "true" : "false"}" aria-label="${escapeAttr(allChecked ? `Uncheck all ${title}` : `Check all ${title}`)}">
          <span aria-hidden="true">${allChecked ? "&#10003;" : mixedChecked ? "&minus;" : ""}</span>
        </button>
      </div>
      <div class="athlete-access-control-actions">
        ${actions.map(([label, patchKey, rowKey, defaultValue]) => renderAccessToggleRow(athletes, id, label, patchKey, rowKey, defaultValue)).join("")}
      </div>
    </article>
  `;
}

function accessGroupCheckedCount(athletes, actions) {
  if (!athletes.length || !actions.length) return 0;
  return actions.filter(([, , rowKey, defaultValue]) => athletes.every((athlete) => readAthleteAccess(athlete, rowKey, defaultValue))).length;
}

function renderAccessToggleRow(athletes, groupId, label, patchKey, rowKey, defaultValue = false) {
  const enabled = athletes.filter((athlete) => readAthleteAccess(athlete, rowKey, defaultValue)).length;
  const checked = enabled === athletes.length;
  const stateText = enabled === athletes.length ? "All on" : enabled === 0 ? "Off" : `${enabled}/${athletes.length}`;
  return `
    <label class="athlete-access-toggle-row">
      <input type="checkbox" data-athlete-access-key="${escapeAttr(patchKey)}" data-athlete-access-group="${escapeAttr(groupId)}" ${checked ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(stateText)}</small>
      </span>
    </label>
  `;
}

function readAthleteAccess(athlete, rowKey, defaultValue = false) {
  if (Object.prototype.hasOwnProperty.call(athlete, rowKey)) {
    return defaultValue === true ? athlete[rowKey] !== false : athlete[rowKey] === true;
  }
  return defaultValue === true;
}

function renderAthleteAccessClosedSummary(athletes) {
  const withMarketplace = athletes.filter((athlete) => athlete.can_view_marketplace === true).length;
  const withTeamLibrary = athletes.filter((athlete) => athlete.can_view_team_library === true).length;
  const withPublicCoaches = athletes.filter((athlete) => athlete.can_view_public_coach_profiles === true).length;
  const withCoachExercises = athletes.filter((athlete) => athlete.can_view_coach_exercise_library === true).length;
  return `
    <div class="athlete-access-closed-summary">
      <span><strong>${athletes.length}</strong> athletes in view</span>
      <span><strong>${withTeamLibrary}</strong> team programs</span>
      <span><strong>${withMarketplace}</strong> marketplace</span>
      <span><strong>${withPublicCoaches}</strong> public coaches</span>
      <span><strong>${withCoachExercises}</strong> coach exercises</span>
    </div>
  `;
}

function renderAthleteAccessSummaryRow(athlete) {
  const enabled = [
    athlete.can_view_coach_library !== false ? "Coach programs" : "",
    athlete.can_view_team_library === true ? "Team programs" : "",
    athlete.can_view_club_library === true ? "Club programs" : "",
    athlete.can_view_optimove_library === true ? "OptiMove" : "",
    athlete.can_view_marketplace === true ? "Marketplace" : "",
    athlete.can_view_coach_profiles !== false ? "Coach profiles" : "",
    athlete.can_view_public_coach_profiles === true ? "Public coaches" : "",
    athlete.can_view_coach_exercise_library === true ? "Coach exercises" : "",
    athlete.can_view_team_exercise_library === true ? "Team exercises" : "",
  ].filter(Boolean);
  return `
    <article class="athlete-access-summary-row">
      <div>
        <strong>${escapeHtml(athlete.name || "Athlete")}</strong>
        <span>${escapeHtml(athlete.athlete_id || athlete.source_external_id || "")}</span>
      </div>
      <p>${enabled.length ? enabled.map((label) => `<span>${escapeHtml(label)}</span>`).join("") : `<span>No browsing access</span>`}</p>
      <button class="plain-button icon-button" type="button" data-action="organization-edit" data-org-type="athlete" data-org-id="${escapeAttr(athlete.id)}" aria-label="Edit" title="Edit">${ICON_PENCIL}</button>
    </article>
  `;
}

function renderProgramAccessHelp() {
  return `
    <section class="panel organization-list-card organization-access-help">
      <div class="organization-list-head">
        <div><p class="eyebrow">How approval works</p><h3>Who should approve?</h3></div>
      </div>
      <p class="muted">A program request is approved by the coach, team coach, club admin, or platform admin who can manage that athlete. After approval, the athlete can open and use the program from their Program Library.</p>
    </section>
  `;
}

export function renderProgramAccessRequests(rows, { compact = false } = {}) {
  const statusFilter = state.organization.requestStatus || "all";
  const athleteFilter = state.organization.requestAthleteId || "all";
  const athleteRows = rows.filter((row) => programAccessAthleteMatches(row, athleteFilter));
  const visibleRows = athleteRows.filter((row) => programAccessFilterMatches(row, statusFilter));
  const pendingVisibleRows = visibleRows.filter((row) => row.status === "requested");
  const pendingRows = rows.filter((row) => row.status === "requested");
  return `
    <section class="panel organization-list-card organization-access-requests ${compact ? "is-compact" : ""}">
      <div class="organization-list-head">
        <div><p class="eyebrow">Program access inbox</p><h3>Requests and access</h3><p class="muted">Approve requested programs and review recent access decisions.</p></div>
        <strong>${pendingRows.length} pending</strong>
      </div>
      ${renderProgramAccessFilters(statusFilter, {
        all: athleteRows.length,
        requested: athleteRows.filter((row) => row.status === "requested").length,
        approved: athleteRows.filter((row) => row.status === "accessed").length,
        used: athleteRows.filter((row) => row.status === "used" || row.status === "completed").length,
        rejected: athleteRows.filter((row) => row.status === "rejected").length,
      })}
      ${state.organization.requestMessage ? `<p class="builder-success">${escapeHtml(state.organization.requestMessage)}</p>` : ""}
      ${state.organization.requestError ? `<p class="builder-error">${escapeHtml(state.organization.requestError)}</p>` : ""}
      ${renderProgramAccessActiveAthleteFilter(rows, athleteFilter)}
      ${pendingVisibleRows.length ? renderProgramAccessBulkActions(pendingVisibleRows) : ""}
      <div class="organization-list">
        ${visibleRows.length ? visibleRows.map(renderProgramAccessRequestRow).join("") : `<p class="muted">${rows.length ? "No requests match this filter." : "No program access activity yet."}</p>`}
      </div>
    </section>
  `;
}

function renderProgramAccessActiveAthleteFilter(rows, activeAthleteId) {
  if (!activeAthleteId || activeAthleteId === "all") return "";
  const activeRow = rows.find((row) => String(row.athlete_id || row.user_id || "") === String(activeAthleteId));
  const label = activeRow?.athlete_name || "Selected athlete";
  return `
    <div class="organization-request-active-filter">
      <span>Showing ${escapeHtml(label)}</span>
      <button class="text-action" type="button" data-action="organization-request-athlete-filter" data-request-athlete-id="all">Clear</button>
    </div>
  `;
}

function renderProgramAccessBulkActions(pendingRows) {
  const ids = pendingRows.map((row) => row.id).filter(Boolean).join(",");
  const count = pendingRows.length;
  return `
    <div class="organization-request-bulk-actions">
      <span>${count} ${count === 1 ? "visible request" : "visible requests"}</span>
      <button class="plain-button compact-button" type="button" data-action="organization-access-bulk" data-access-action="approve" data-access-ids="${escapeAttr(ids)}">Approve all shown</button>
      <button class="plain-button compact-button danger-button" type="button" data-action="organization-access-bulk" data-access-action="reject" data-access-ids="${escapeAttr(ids)}">Reject all shown</button>
    </div>
  `;
}

function renderProgramAccessFilters(activeFilter, counts) {
  const filters = [
    ["all", "All", counts.all],
    ["requested", "Pending", counts.requested],
    ["approved", "Approved", counts.approved],
    ["used", "Used", counts.used],
    ["rejected", "Rejected", counts.rejected],
  ];
  return `
    <div class="organization-request-filters" role="group" aria-label="Program access filters">
      ${filters.map(([value, label, count]) => `
        <button class="${value === activeFilter ? "is-active" : ""}" type="button" data-action="organization-request-filter" data-request-status="${escapeAttr(value)}">
          <span>${escapeHtml(label)}</span>
          <strong>${count}</strong>
        </button>
      `).join("")}
    </div>
  `;
}

function programAccessAthleteMatches(row, athleteId) {
  if (!athleteId || athleteId === "all") return true;
  return String(row.athlete_id || row.user_id || "") === String(athleteId);
}

function programAccessFilterMatches(row, filter) {
  const status = row.status || "";
  if (filter === "requested") return status === "requested";
  if (filter === "approved") return status === "accessed";
  if (filter === "used") return status === "used" || status === "completed";
  if (filter === "rejected") return status === "rejected";
  return true;
}

function programAccessStatusLabel(status) {
  return {
    requested: "Requested",
    accessed: "Approved",
    used: "Used",
    completed: "Completed",
    rejected: "Rejected",
  }[status] || "Access";
}

function renderProgramAccessRequestRow(row) {
  const image = row.athlete_image_url || "";
  const date = row.created_at ? new Date(row.created_at).toLocaleDateString("en-GB") : "";
  const updated = row.updated_at ? new Date(row.updated_at).toLocaleDateString("en-GB") : "";
  const status = row.status || "";
  const isPending = status === "requested";
  return `
    <article class="organization-row organization-request-row is-${escapeAttr(status)}">
      <button class="organization-table-athlete organization-request-athlete organization-request-athlete-button" type="button" data-action="organization-request-athlete-filter" data-request-athlete-id="${escapeAttr(row.athlete_id || row.user_id || "")}">
        ${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">AT</span>`}
        <span>
          <strong>${escapeHtml(row.athlete_name || "Athlete")}</strong>
          <small>${escapeHtml([row.athlete_code ? `ID ${row.athlete_code}` : "", date].filter(Boolean).join(" - "))}</small>
        </span>
      </button>
      <span class="organization-request-program">
        <small>${escapeHtml(programAccessStatusLabel(status))}${updated && updated !== date ? ` - ${escapeHtml(updated)}` : ""}</small>
        <strong>${escapeHtml(row.program_name || "Program")}</strong>
        <em>${escapeHtml(row.library_category || "General")}</em>
      </span>
      <span class="organization-row-actions">
        <span class="program-access-badge is-${escapeAttr(status)}">${escapeHtml(programAccessStatusLabel(status))}</span>
        ${isPending ? `
          <button class="text-action" type="button" data-action="organization-access-approve" data-access-id="${escapeAttr(row.id)}">Approve</button>
          <button class="text-action danger-action" type="button" data-action="organization-access-reject" data-access-id="${escapeAttr(row.id)}">Reject</button>
        ` : ""}
      </span>
    </article>
  `;
}

function renderAssignAthleteToTeamForm(team, visibleAthletes, allAthletes) {
  // An athlete may already belong to other teams (or this club) at once -
  // this form only excludes athletes already ACTIVE on THIS specific team.
  const assignedIds = new Set(visibleAthletes.map((athlete) => String(athlete.id)));
  const options = allAthletes
    .filter((athlete) => !assignedIds.has(String(athlete.id)))
    .map((athlete) => ({ value: athlete.id, label: [athlete.name, athlete.athlete_id ? `ID ${athlete.athlete_id}` : "", athlete.club_name || "No club"].filter(Boolean).join(" - ") }));
  return `
    <form class="organization-form organization-assign-panel" data-organization-form="assignTeamAthlete" data-team-id="${escapeAttr(team.id)}">
      <div><p class="eyebrow">Existing athletes</p><h3>Add athlete to ${escapeHtml(team.name)}</h3><p class="muted">Adds an active membership in this team (and this team's club, if they don't already have one) - it does not remove them from any other team or club.</p></div>
      ${renderFilterableSelect({ name: "athleteId", label: "Athlete", options, required: true, placeholder: "Type athlete name or ID" })}
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${options.length ? "" : "disabled"}>Assign athlete</button>
    </form>
  `;
}

function renderTeamAthleteTable(team, teamAthletes, allAthletes) {
  const archivedInTeam = archivedMembershipsFor(allAthletes, { teamId: team.id });
  return `
    <section class="panel organization-list-card organization-team-detail">
      <div class="organization-list-head organization-team-head">
        <div>
          <p class="eyebrow">Team roster</p>
          <h3>${escapeHtml(team.name)}</h3>
          <p class="muted">${escapeHtml(team.club_name || "No club")} - ${teamAthletes.length} athletes</p>
        </div>
        <div class="organization-browser-actions">
          <button class="plain-button compact-button" type="button" data-action="organization-toggle-archived-team-members">${state.organization.showArchivedTeamMembers ? "Hide archived" : `Show archived (${archivedInTeam.length})`}</button>
          <button class="plain-button compact-button" type="button" data-action="organization-toggle-assign-athlete">${state.organization.assignOpen ? "Close add" : "Add athlete"}</button>
        </div>
      </div>
      ${state.organization.assignOpen ? renderAssignAthleteToTeamForm(team, teamAthletes, allAthletes) : ""}
      <div class="organization-table" role="table" aria-label="${escapeAttr(team.name)} athletes">
        <div class="organization-table-row organization-table-head" role="row">
          <span>Athlete</span><span>ID</span><span>Login</span><span></span>
        </div>
        ${teamAthletes.length ? teamAthletes.map((athlete) => renderTeamAthleteRow(athlete, team)).join("") : `<p class="muted organization-empty-row">No athletes assigned to this team yet.</p>`}
      </div>
      ${state.organization.showArchivedTeamMembers ? `
        <div class="organization-table organization-archived-athletes" role="table" aria-label="${escapeAttr(team.name)} archived athletes">
          ${archivedInTeam.length ? archivedInTeam.map((athlete) => renderArchivedTeamAthleteRow(athlete, team)).join("") : `<p class="muted organization-empty-row">No archived team memberships.</p>`}
        </div>
      ` : ""}
    </section>
  `;
}

function renderAthleteLoginToggle(athlete) {
  if (!athlete.user_id) return `<span class="athlete-login-status is-none" title="No login yet">No login</span>`;
  // This account also holds real coach/admin capability - disabling it here
  // would kill their staff access too, which this control must never do (the
  // backend independently refuses this regardless of what's rendered here).
  if (athlete.login_is_multi_role) {
    return `<span class="athlete-login-status is-multi-role" title="This login also has coach or administrator access - it can't be disabled from here.">Multi-role account</span>`;
  }
  const active = athlete.login_active === true;
  return `
    <button class="athlete-login-toggle ${active ? "is-active" : "is-disabled"}" type="button" data-action="organization-toggle-athlete-login" data-athlete-id="${escapeAttr(athlete.id)}" data-current-active="${active ? "true" : "false"}" title="${active ? "Click to disable this login" : "Click to enable this login"}">
      ${active ? "Active" : "Disabled"}
    </button>
  `;
}

// The Invite trigger is only ever offered when the CURRENT active workspace
// is one that can actually send an invite (platform/private_coach/club/
// team - never athlete, and never when there's no resolved workspace at
// all), and only for an athlete who doesn't already have a login. This is
// presentation only - the backend independently re-derives and re-checks
// the exact same context from req.authz regardless of what this renders.
function inviteTriggerHtml(athlete) {
  const workspace = state.currentUser?.activeWorkspace;
  if (!workspace || workspace.type === "athlete") return "";
  if (athlete.user_id) return "";
  return `<button class="text-action" type="button" data-action="organization-invite-athlete" data-athlete-id="${escapeAttr(athlete.id)}">${athlete.inviteStatus === "pending" ? "Invite pending" : "Invite"}</button>`;
}

function renderTeamAthleteRow(athlete, team) {
  const image = athlete.image_url || "";
  return `
    <div class="organization-table-row" role="row">
      <span class="organization-table-athlete">${image ? renderImage(image, "organization-avatar") : `<span class="organization-avatar">AT</span>`}<strong>${escapeHtml(athlete.name || "Athlete")}</strong></span>
      <span>${escapeHtml(athlete.athlete_id || athlete.source_external_id || "-")}</span>
      <span>${renderAthleteLoginToggle(athlete)}</span>
      <span class="organization-row-actions">
        ${inviteTriggerHtml(athlete)}
        <button class="plain-button icon-button" type="button" data-action="organization-edit" data-org-type="athlete" data-org-id="${escapeAttr(athlete.id)}" aria-label="Edit" title="Edit">${ICON_PENCIL}</button>
        <button class="plain-button icon-button" type="button" data-action="organization-archive-team-membership" data-team-id="${escapeAttr(team.id)}" data-athlete-id="${escapeAttr(athlete.id)}" aria-label="Remove from team" title="Remove from team - ends only this team membership. Login, history, and any other teams/clubs/coaches are kept, and it can be restored later.">${ICON_ARCHIVE}</button>
      </span>
    </div>
  `;
}

function renderArchivedTeamAthleteRow(athlete, team) {
  return `
    <div class="organization-table-row is-archived" role="row">
      <span class="organization-table-athlete"><span class="organization-avatar">${escapeHtml((athlete.athlete_id || "AT").slice(0, 2).toUpperCase())}</span><strong>${escapeHtml(athlete.name || "Athlete")}</strong></span>
      <span>${escapeHtml(athlete.athlete_id || athlete.source_external_id || "-")}</span>
      <span class="muted">Removed from team</span>
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-restore-team-membership" data-team-id="${escapeAttr(team.id)}" data-athlete-id="${escapeAttr(athlete.id)}">Restore</button>
      </span>
    </div>
  `;
}

// A specific club is selected (no team) - "Archive from club" is
// unambiguous here since the context is exactly which club's membership is
// being ended, unlike the flat, unfiltered athlete list.
function renderClubAthleteList(club, clubAthletes, allAthletes) {
  const archivedInClub = archivedMembershipsFor(allAthletes, { clubId: club.id }).filter((athlete) => (
    (athlete.memberships || []).some((m) => m.membershipType === "club" && String(m.clubId) === String(club.id) && m.status === "archived")
  ));
  return `
    <section class="panel organization-list-card organization-team-detail">
      <div class="organization-list-head organization-team-head">
        <div>
          <p class="eyebrow">Club roster</p>
          <h3>${escapeHtml(club.name)}</h3>
          <p class="muted">${clubAthletes.length} athletes</p>
        </div>
        <button class="plain-button compact-button" type="button" data-action="organization-toggle-archived-club-members">${state.organization.showArchivedClubMembers ? "Hide archived" : `Show archived (${archivedInClub.length})`}</button>
      </div>
      <div class="organization-list">
        ${clubAthletes.length ? clubAthletes.map((athlete) => renderClubAthleteRow(athlete, club)).join("") : `<p class="muted organization-empty-row">No athletes in this club yet.</p>`}
      </div>
      ${state.organization.showArchivedClubMembers ? `
        <div class="organization-list organization-archived-athletes">
          ${archivedInClub.length ? archivedInClub.map((athlete) => renderArchivedClubMemberRow(athlete, club)).join("") : `<p class="muted">No archived club memberships.</p>`}
        </div>
      ` : ""}
    </section>
  `;
}

function renderClubAthleteRow(athlete, club) {
  return `
    <article class="organization-row">
      ${renderOrganizationRowContent(athlete, "athlete")}
      <span class="organization-row-actions">
        ${renderAthleteLoginToggle(athlete)}
        ${inviteTriggerHtml(athlete)}
        <button class="plain-button icon-button" type="button" data-action="organization-edit" data-org-type="athlete" data-org-id="${escapeAttr(athlete.id)}" aria-label="Edit" title="Edit">${ICON_PENCIL}</button>
        <button class="plain-button icon-button" type="button" data-action="organization-archive-club-membership" data-club-id="${escapeAttr(club.id)}" data-athlete-id="${escapeAttr(athlete.id)}" aria-label="Archive from club" title="Archive from club - ends this club membership, and any active team memberships within it. Login, history, and other clubs/teams/coaches are kept, and it can be restored later.">${ICON_ARCHIVE}</button>
      </span>
    </article>
  `;
}

function renderArchivedClubMemberRow(athlete, club) {
  return `
    <article class="organization-row is-archived">
      ${renderOrganizationRowContent(athlete, "athlete")}
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-restore-club-membership" data-club-id="${escapeAttr(club.id)}" data-athlete-id="${escapeAttr(athlete.id)}">Restore</button>
      </span>
    </article>
  `;
}

// Matches the exact 4 sendable contexts (never "athlete" - that workspace
// never reaches this modal at all, per inviteTriggerHtml above).
function inviteContextLabel(workspace) {
  if (!workspace) return "";
  if (workspace.type === "platform") return "Platform";
  if (workspace.type === "private_coach") return "Private coaching";
  if (workspace.type === "club") return `Club · ${workspace.label || ""}`;
  if (workspace.type === "team") return `Team · ${workspace.label || ""}`;
  return "";
}

function formatInviteDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderInviteLinkResultHtml() {
  return `
    <div class="invite-result">
      <p class="muted">Send this activation link to the athlete. They will open it and set their own password. It expires in 7 days.</p>
      <input readonly value="${escapeAttr(state.organizationInvite.inviteUrl)}">
      <div class="invite-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-copy-invite">Copy link</button>
        <a class="plain-button compact-button" href="${escapeAttr(state.organizationInvite.mailtoUrl || "#")}">Open email draft</a>
      </div>
      ${state.organizationInvite.copied ? `<p class="muted invite-copied">Link copied.</p>` : ""}
    </div>
  `;
}

function renderInviteCreateFormHtml(athlete) {
  return `
    <form class="organization-form" data-organization-form="athleteInvite">
      <input type="hidden" name="athleteId" value="${escapeAttr(athlete.id)}">
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="example@example.com" autocomplete="off"></label>
      <button class="plain-button" type="submit" ${state.organizationInvite.pending ? "disabled" : ""}>Create invite link</button>
    </form>
  `;
}

function renderInvitePendingHtml(invite) {
  return `
    <div class="invite-result invite-pending">
      <p><strong>Pending invite</strong></p>
      <p class="muted">${escapeHtml(invite.email)} - expires ${formatInviteDate(invite.expiresAt)}</p>
      <div class="invite-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-invite-regenerate" ${state.organizationInvite.pending ? "disabled" : ""}>Generate new link</button>
        <button class="plain-button compact-button danger-button" type="button" data-action="organization-invite-revoke" data-invite-id="${escapeAttr(invite.id)}" ${state.organizationInvite.pending ? "disabled" : ""}>Revoke invite</button>
      </div>
    </div>
  `;
}

function renderInviteHistoricalHtml(invite, status, canCreateNew, athlete) {
  const labels = { accepted: "Accepted", expired: "Expired", revoked: "Revoked" };
  return `
    <p class="muted invite-historical">${escapeHtml(labels[status] || status)} invite sent to ${escapeHtml(invite.email)}.</p>
    ${canCreateNew ? renderInviteCreateFormHtml(athlete) : ""}
  `;
}

function renderAthleteInviteModal(athletes) {
  const athlete = athletes.find((entry) => String(entry.id) === String(state.organizationInvite.athleteId));
  if (!athlete) return "";
  const workspace = state.currentUser?.activeWorkspace;
  const contextLabel = inviteContextLabel(workspace);
  const justCreatedUrl = state.organizationInvite.inviteUrl;
  const status = athlete.inviteStatus || "none";
  const invite = athlete.invite || null;

  let body;
  if (justCreatedUrl) {
    body = renderInviteLinkResultHtml();
  } else if (status === "pending" && invite) {
    body = renderInvitePendingHtml(invite);
  } else if ((status === "accepted" || status === "expired" || status === "revoked") && invite) {
    // Accepted normally means the athlete now has a login (no trigger would
    // even be shown), but expired/revoked leaves the athlete still
    // login-less, so a fresh invite may still be created from here.
    body = renderInviteHistoricalHtml(invite, status, !athlete.user_id, athlete);
  } else {
    body = renderInviteCreateFormHtml(athlete);
  }

  return `
    <div class="exercise-tag-overlay">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-invite-close" aria-label="Close invite"></button>
      <section class="panel exercise-tag-modal organization-invite-modal" role="dialog" aria-modal="true" aria-label="Athlete invite">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Athlete invite${contextLabel ? ` · ${escapeHtml(contextLabel)}` : ""}</p><h3>${escapeHtml(athlete.name || "Athlete")}</h3></div>
          <button class="plain-button icon-button" type="button" data-action="organization-invite-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        <p class="builder-error" aria-live="polite">${escapeHtml(state.organizationInvite.error || "")}</p>
        ${body}
      </section>
    </div>
  `;
}

// --- Group athlete join links (feature/group-athlete-join-links) ---
// A separate, context-level system from the per-athlete Invite modal above -
// see backend/src/joinLinkContext.js. A link's context (private_coach/club/
// team) always comes from the account's own current active workspace, never
// a client-chosen value.

function renderJoinLinkCreateFormHtml() {
  return `
    <form class="panel organization-form" data-organization-form="joinLink">
      <div><p class="eyebrow">Join link</p><h3>Create join link</h3></div>
      <label class="search-field"><span>Label</span><input name="label" placeholder="e.g. Fall tryouts"></label>
      <label class="search-field"><span>Expires in (days)</span><input name="expiresInDays" type="number" min="1" max="30" value="7" required></label>
      <label class="search-field"><span>Max members (optional)</span><input name="maxUses" type="number" min="1" max="500" placeholder="Unlimited"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${state.organizationJoinLinks.pending ? "disabled" : ""}>Create join link</button>
    </form>
  `;
}

function joinLinkStatusLabel(status) {
  return { active: "Active", expired: "Expired", revoked: "Revoked", full: "Full" }[status] || status;
}

function renderJoinLinkRow(link) {
  const justCreated = state.organizationJoinLinks.justCreatedId === link.id && state.organizationJoinLinks.justCreatedUrl;
  const isDead = link.status === "revoked";
  return `
    <article class="organization-row">
      <div class="organization-row-main" style="flex:1">
        <strong>${escapeHtml(link.label || "Join link")}</strong>
        <p class="muted">${escapeHtml(joinLinkStatusLabel(link.status))} · ${link.approvedUses}${link.maxUses != null ? `/${escapeHtml(String(link.maxUses))}` : ""} used · ${link.pendingCount} pending · expires ${formatInviteDate(link.expiresAt)}</p>
        ${justCreated ? `
          <div class="invite-result">
            <input readonly value="${escapeAttr(state.organizationJoinLinks.justCreatedUrl)}">
            <div class="invite-actions">
              <button class="plain-button compact-button" type="button" data-action="organization-join-link-copy" data-link-id="${escapeAttr(link.id)}">Copy link</button>
            </div>
            ${state.organizationJoinLinks.copiedId === link.id ? `<p class="muted invite-copied">Link copied.</p>` : ""}
          </div>
        ` : ""}
      </div>
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-join-link-regenerate" data-link-id="${escapeAttr(link.id)}" ${isDead || state.organizationJoinLinks.pending ? "disabled" : ""}>Generate new link</button>
        <button class="plain-button compact-button danger-button" type="button" data-action="organization-join-link-revoke" data-link-id="${escapeAttr(link.id)}" ${isDead || state.organizationJoinLinks.pending ? "disabled" : ""}>Revoke</button>
      </span>
    </article>
  `;
}

function renderJoinApplicationRow(app) {
  const isPending = app.status === "pending";
  const isBusy = state.organizationJoinLinks.reviewPendingId === app.id;
  // A new-email application's Approve stays disabled until email_verified_at
  // is set (backend/src/routes/organization.js's EMAIL_NOT_VERIFIED gate is
  // the real enforcement - this is purely a UX affordance, never the actual
  // security boundary). An existing-account application is always reported
  // emailVerified=true (see loadJoinApplicationsForWorkspace) since
  // session-proven ownership already covers it.
  const approveDisabled = isBusy || !app.emailVerified;
  return `
    <article class="organization-row">
      <div class="organization-row-main" style="flex:1">
        <strong>${escapeHtml(app.name)}</strong>
        <p class="muted">${escapeHtml(app.email)} · ${app.accountType === "existing" ? "Existing account" : "New account"} · ${formatInviteDate(app.submittedAt)} · ${escapeHtml(joinApplicationStatusLabel(app.status))}${isPending && !app.emailVerified ? " · Email not verified" : ""}</p>
      </div>
      ${isPending ? `
        <span class="organization-row-actions">
          <button class="plain-button compact-button" type="button" data-action="organization-join-application-approve" data-application-id="${escapeAttr(app.id)}" ${approveDisabled ? "disabled" : ""} title="${app.emailVerified ? "" : "The applicant must verify their email before this request can be approved."}">Approve</button>
          <button class="plain-button compact-button danger-button" type="button" data-action="organization-join-application-reject" data-application-id="${escapeAttr(app.id)}" ${isBusy ? "disabled" : ""}>Reject</button>
        </span>
      ` : ""}
    </article>
  `;
}

function joinApplicationStatusLabel(status) {
  return { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", requires_login: "Needs applicant login" }[status] || status;
}

function renderJoinLinksSection(data) {
  const links = data.joinLinks || [];
  const applications = data.joinApplications || [];
  const pendingCount = applications.filter((app) => app.status === "pending").length;
  return `
    <section class="organization-lists organization-lists-browser">
      <section class="panel organization-list-card">
        <div class="organization-list-head"><p class="eyebrow">Join links</p><strong>${links.length}</strong></div>
        <p class="builder-error" aria-live="polite">${escapeHtml(state.organizationJoinLinks.error || "")}</p>
        <div class="organization-list">
          ${links.length ? links.map(renderJoinLinkRow).join("") : `<p class="muted">No join links yet.</p>`}
        </div>
      </section>
      <section class="panel organization-list-card">
        <div class="organization-list-head"><p class="eyebrow">Join requests</p><strong>${pendingCount} pending</strong></div>
        <div class="organization-list">
          ${applications.length ? applications.map(renderJoinApplicationRow).join("") : `<p class="muted">No requests yet.</p>`}
        </div>
      </section>
    </section>
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
  const athleteOptions = (data.athletes || []).filter((athlete) => athlete.is_active !== false).map((athlete) => ({ value: athlete.id, label: `${athlete.name}${athlete.athlete_id ? ` - ID ${athlete.athlete_id}` : ""}` }));
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
      <label class="search-field"><span>Email</span><input name="email" type="email" required placeholder="example@example.com" autocomplete="off"></label>
      <label class="search-field"><span>Password</span><input name="password" type="password" required placeholder="At least 8 characters" autocomplete="new-password"></label>
      <p class="builder-error" aria-live="polite"></p>
      <button class="plain-button" type="submit" ${athleteOptions.length ? "" : "disabled"}>Create login</button>
    </form>
  `;
}

// Independent/private coach is intentionally never called "global" in the
// UI - it lives in public.user_global_roles because it isn't tied to one
// specific club or team, but it grants NO platform-wide access (only real
// club/team roles and platform_admin do). Keeping the two visually and
// textually separate here (Platform access vs Private coaching) matches
// that distinction; the backend table name is unrelated to this wording.
function roleLabelText(role) {
  return {
    club_admin: "Club admin",
    club_manager: "Club manager",
    team_admin: "Team admin",
    team_coach: "Team coach",
    team_trainer: "Team trainer",
  }[role] || role || "Role";
}

// Every badge below is derived from the account's REAL rows (globalRoles,
// clubRoles, teamRoles, isAthlete, loginActive) as returned by
// GET /api/organization - never from role_hint/legacyDisplayRole, which is
// display-only legacy text and may not match reality for a multi-role
// account. A multi-role account shows every applicable badge at once.
function renderOrganizationUserBadges(row) {
  const globalRoles = row.globalRoles || [];
  const isPlatformAdminBadge = globalRoles.some((r) => r.role === "platform_admin" && r.isActive);
  const isCoachBadge = globalRoles.some((r) => r.role === "independent_coach" && r.isActive);
  const clubRoles = (row.clubRoles || []).filter((r) => r.isActive);
  const teamRoles = (row.teamRoles || []).filter((r) => r.isActive);
  const loginActive = row.loginActive !== false;
  return `
    <span class="organization-user-badges">
      <span class="user-status-badge ${loginActive ? "is-active" : "is-disabled"}">${loginActive ? "Active login" : "Login disabled"}</span>
      ${row.isAthlete === true ? `<span class="role-badge is-athlete">Athlete</span>` : ""}
      ${isPlatformAdminBadge ? `<span class="role-badge is-platform-admin">Platform administrator</span>` : ""}
      ${isCoachBadge ? `<span class="role-badge is-coach">Independent/private coach</span>` : ""}
      ${clubRoles.map((r) => {
        const label = `${roleLabelText(r.role)} · ${r.clubName || "Club"}`;
        return `<span class="role-badge is-club" title="${escapeAttr(label)}">${escapeHtml(label)}</span>`;
      }).join("")}
      ${teamRoles.map((r) => {
        const label = `${roleLabelText(r.role)} · ${r.teamName || "Team"}`;
        return `<span class="role-badge is-team" title="${escapeAttr(label)}">${escapeHtml(label)}</span>`;
      }).join("")}
    </span>
  `;
}

function renderOrganizationUserRow(row) {
  const loginActive = row.loginActive !== false;
  return `
    <article class="organization-row organization-user-row ${loginActive ? "" : "is-disabled-account"}">
      <span class="organization-avatar">${escapeHtml((row.name || row.email || "US").slice(0, 2).toUpperCase())}</span>
      <span class="organization-user-summary">
        <strong>${escapeHtml(row.name || row.email || "User")}</strong>
        <small>${escapeHtml(row.email || "")}</small>
        ${renderOrganizationUserBadges(row)}
      </span>
      <span class="organization-row-actions">
        <button class="plain-button compact-button" type="button" data-action="organization-manage-account-open" data-user-id="${escapeAttr(row.id)}">Manage account</button>
      </span>
    </article>
  `;
}

function renderOrganizationUsersSection(data) {
  const allUsers = data.users || [];
  const disabledUsers = allUsers.filter((row) => row.loginActive === false);
  const activeUsers = allUsers.filter((row) => row.loginActive !== false);
  const showDisabled = state.organization.showDisabledUsers;
  const visibleUsers = showDisabled ? allUsers : activeUsers;
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head">
        <p class="eyebrow">Users</p>
        <strong>${activeUsers.length}</strong>
        ${disabledUsers.length ? `<button class="text-action" type="button" data-action="organization-toggle-disabled-users">${showDisabled ? "Hide disabled" : `Show disabled (${disabledUsers.length})`}</button>` : ""}
      </div>
      <div class="organization-list">
        ${visibleUsers.length ? visibleUsers.map((row) => renderOrganizationUserRow(row)).join("") : `<p class="muted">No users yet.</p>`}
      </div>
    </section>
  `;
}

function renderManageAccountRoleSection({ eyebrow, label, active, canManage, userId, role, note, grantLabel = "Grant access", removeLabel = "Remove access" }) {
  return `
    <section class="manage-account-section">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <div class="manage-account-row">
        <strong>${escapeHtml(label)}</strong>
        <span class="user-status-badge ${active ? "is-active" : "is-inactive"}">${active ? "Active" : "Not assigned"}</span>
        ${canManage ? `
          <button class="plain-button compact-button ${active ? "danger-button" : ""}" type="button" data-action="organization-global-role-toggle" data-user-id="${escapeAttr(userId)}" data-role="${escapeAttr(role)}" data-next-active="${active ? "false" : "true"}" ${state.organizationUserManage.pending ? "disabled" : ""}>${active ? removeLabel : grantLabel}</button>
        ` : ""}
      </div>
      ${note ? `<p class="muted">${escapeHtml(note)}</p>` : ""}
    </section>
  `;
}

// Shared by both club and team role rows below - a Remove button only ever
// appears for the ONE role this phase actually manages (club_admin /
// team_coach), and only when the viewer has real assignment rights for
// THIS specific club/team (manageableClubIds/manageableTeamIds, computed
// server-side - never guessed here). Any other role value - including the
// legacy club_manager/team_admin/team_trainer names, which have no defined
// authorization semantics yet - always renders read-only, matching
// existing behavior exactly.
function renderManageAccountScopedRoleRow({ label, sublabel, roleValue, isActive, canManage, removeAction, removeDataAttrs }) {
  const manageableRole = roleValue === "club_admin" || roleValue === "team_coach";
  return `
    <div class="manage-account-row">
      <span>${escapeHtml(label)}${sublabel ? ` <small>${escapeHtml(sublabel)}</small>` : ""}</span>
      <span class="muted">${escapeHtml(roleLabelText(roleValue))}</span>
      <span class="user-status-badge ${isActive ? "is-active" : "is-inactive"}">${isActive ? "Active" : "Inactive"}</span>
      ${manageableRole && isActive && canManage ? `
        <button class="plain-button compact-button danger-button" type="button" data-action="${removeAction}" ${removeDataAttrs} ${state.organizationUserManage.pending ? "disabled" : ""}>Remove role</button>
      ` : ""}
    </div>
  `;
}

function renderManageAccountClubRolesSection(row, data) {
  const clubRoles = row.clubRoles || [];
  const manageableClubIds = data.manageableClubIds || [];
  const isManageableClub = (clubId) => manageableClubIds.some((id) => String(id) === String(clubId));
  const activeClubIds = new Set(clubRoles.filter((r) => r.role === "club_admin" && r.isActive).map((r) => String(r.clubId)));
  const addableClubs = (data.clubs || []).filter((club) => isManageableClub(club.id) && !activeClubIds.has(String(club.id)));
  const pending = state.organizationUserManage.pending;
  return `
    <section class="manage-account-section">
      <p class="eyebrow">Club roles</p>
      ${clubRoles.length ? `<div class="manage-account-list">${clubRoles.map((r) => renderManageAccountScopedRoleRow({
        label: r.clubName || "Club",
        roleValue: r.role,
        isActive: r.isActive,
        canManage: isManageableClub(r.clubId),
        removeAction: "organization-club-role-remove",
        removeDataAttrs: `data-user-id="${escapeAttr(row.id)}" data-club-id="${escapeAttr(r.clubId)}" data-user-name="${escapeAttr(row.name || row.email || "this user")}" data-club-name="${escapeAttr(r.clubName || "this club")}"`,
      })).join("")}</div>` : `<p class="muted">No club roles.</p>`}
      ${manageableClubIds.length ? `
        <div class="manage-account-add-row" data-manage-account-add="club">
          <select name="clubId" ${addableClubs.length ? "" : "disabled"}>
            ${addableClubs.length ? addableClubs.map((club) => `<option value="${escapeAttr(club.id)}">${escapeHtml(club.name)}</option>`).join("") : `<option value="">No clubs available to add</option>`}
          </select>
          <button class="plain-button compact-button" type="button" data-action="organization-club-role-add" data-user-id="${escapeAttr(row.id)}" ${addableClubs.length && !pending ? "" : "disabled"}>Add club administrator</button>
        </div>
      ` : ""}
    </section>
  `;
}

function renderManageAccountTeamRolesSection(row, data) {
  const teamRoles = row.teamRoles || [];
  const manageableTeamIds = data.manageableTeamIds || [];
  const isManageableTeam = (teamId) => manageableTeamIds.some((id) => String(id) === String(teamId));
  const activeTeamIds = new Set(teamRoles.filter((r) => r.role === "team_coach" && r.isActive).map((r) => String(r.teamId)));
  const addableTeams = (data.teams || []).filter((team) => isManageableTeam(team.id) && !activeTeamIds.has(String(team.id)));
  const pending = state.organizationUserManage.pending;
  return `
    <section class="manage-account-section">
      <p class="eyebrow">Team roles</p>
      ${teamRoles.length ? `<div class="manage-account-list">${teamRoles.map((r) => renderManageAccountScopedRoleRow({
        label: r.teamName || "Team",
        sublabel: r.clubName || "",
        roleValue: r.role,
        isActive: r.isActive,
        canManage: isManageableTeam(r.teamId),
        removeAction: "organization-team-role-remove",
        removeDataAttrs: `data-user-id="${escapeAttr(row.id)}" data-team-id="${escapeAttr(r.teamId)}" data-user-name="${escapeAttr(row.name || row.email || "this user")}" data-team-name="${escapeAttr(r.teamName || "this team")}"`,
      })).join("")}</div>` : `<p class="muted">No team roles.</p>`}
      ${manageableTeamIds.length ? `
        <div class="manage-account-add-row" data-manage-account-add="team">
          <select name="teamId" ${addableTeams.length ? "" : "disabled"}>
            ${addableTeams.length ? addableTeams.map((team) => `<option value="${escapeAttr(team.id)}">${escapeHtml(team.name)}${team.club_name ? ` - ${escapeHtml(team.club_name)}` : ""}</option>`).join("") : `<option value="">No teams available to add</option>`}
          </select>
          <button class="plain-button compact-button" type="button" data-action="organization-team-role-add" data-user-id="${escapeAttr(row.id)}" ${addableTeams.length && !pending ? "" : "disabled"}>Add team coach</button>
        </div>
      ` : ""}
    </section>
  `;
}

export function renderManageAccountModal(data) {
  const row = (data.users || []).find((user) => String(user.id) === String(state.organizationUserManage.userId));
  if (!row) return "";
  const viewerIsPlatformAdmin = Boolean(data.isPlatformAdmin);
  const viewerId = state.currentUser?.id;
  const isSelf = Boolean(viewerId) && String(viewerId) === String(row.id);
  const loginActive = row.loginActive !== false;
  const globalRoles = row.globalRoles || [];
  const platformAdminActive = globalRoles.some((r) => r.role === "platform_admin" && r.isActive);
  const coachActive = globalRoles.some((r) => r.role === "independent_coach" && r.isActive);
  const pending = state.organizationUserManage.pending;
  const error = state.organizationUserManage.error;
  return `
    <div class="exercise-tag-overlay" role="presentation">
      <button class="exercise-tag-backdrop" type="button" data-action="organization-manage-account-close" aria-label="Close manage account"></button>
      <section class="panel exercise-tag-modal organization-manage-account-modal" role="dialog" aria-modal="true" aria-label="Manage account">
        <div class="builder-modal-head">
          <div><p class="eyebrow">Account</p><h3>${escapeHtml(row.name || row.email || "User")}</h3><p class="muted">${escapeHtml(row.email || "")}</p></div>
          <button class="plain-button icon-button" type="button" data-action="organization-manage-account-close" aria-label="Close"><span class="button-icon">x</span></button>
        </div>
        ${error ? `<p class="builder-error">${escapeHtml(error)}</p>` : ""}
        <section class="manage-account-section">
          <p class="eyebrow">Account status</p>
          <div class="manage-account-row">
            <span class="user-status-badge ${loginActive ? "is-active" : "is-disabled"}">${loginActive ? "Active login" : "Login disabled"}</span>
            ${isSelf
              ? `<span class="muted">You can't disable your own login.</span>`
              : row.canManageLogin === true
                ? `<button class="plain-button compact-button ${loginActive ? "danger-button" : ""}" type="button" data-action="organization-user-login-toggle" data-user-id="${escapeAttr(row.id)}" data-next-active="${loginActive ? "false" : "true"}" ${pending ? "disabled" : ""}>${loginActive ? "Disable login" : "Enable login"}</button>`
                : `<span class="muted">You don't have permission to change this login.</span>`}
          </div>
          <p class="muted">Roles, athlete profile, memberships, and history are not changed by disabling or enabling this login.</p>
        </section>
        ${renderManageAccountRoleSection({
          eyebrow: "Platform access",
          label: "Platform administrator",
          active: platformAdminActive,
          canManage: viewerIsPlatformAdmin,
          userId: row.id,
          role: "platform_admin",
        })}
        ${renderManageAccountRoleSection({
          eyebrow: "Private coaching",
          label: "Independent/private coach",
          active: coachActive,
          canManage: viewerIsPlatformAdmin,
          userId: row.id,
          role: "independent_coach",
          grantLabel: "Grant private coaching",
          removeLabel: "Remove private coaching",
          note: "Can only manage athletes linked through an active private coach relationship. No automatic access to clubs or teams.",
        })}
        ${renderManageAccountClubRolesSection(row, data)}
        ${renderManageAccountTeamRolesSection(row, data)}
        <section class="manage-account-section">
          <p class="eyebrow">Athlete profile</p>
          <p>${row.isAthlete === true ? "Athlete profile linked" : "No athlete profile linked"}</p>
        </section>
      </section>
    </div>
  `;
}

function renderOrganizationList(title, rows, type, { isPlatformAdmin = false } = {}) {
  return `
    <section class="panel organization-list-card">
      <div class="organization-list-head"><p class="eyebrow">${escapeHtml(title)}</p><strong>${rows.length}</strong></div>
      <div class="organization-list">
        ${rows.length ? rows.map((row) => renderOrganizationRowV2(row, type, { isPlatformAdmin })).join("") : `<p class="muted">No ${escapeHtml(title.toLowerCase())} yet.</p>`}
      </div>
    </section>
  `;
}

// This flat list has no single club/team context selected, so it never
// offers a club/team-scoped archive action here (that would be a guess about
// which relationship to end) - only the one unambiguous action available
// without any selection: ending YOUR OWN private-coach relationship. A
// platform admin additionally gets the clearly-separate, clearly-named
// whole-profile archive action.
function renderAthleteArchiveActions(row, isPlatformAdmin) {
  const actions = [];
  if (row.has_my_active_coach_relationship) {
    actions.push(`<button class="plain-button icon-button" type="button" data-action="organization-archive-coach-relationship" data-athlete-id="${escapeAttr(row.id)}" aria-label="Archive from my athletes" title="Archive from my athletes - ends only YOUR private-coach relationship. Login, history, and any other relationships are kept, and you can restore it later.">${ICON_ARCHIVE}</button>`);
  }
  if (isPlatformAdmin) {
    actions.push(`<button class="plain-button icon-button danger-action" type="button" data-action="organization-archive-profile" data-athlete-id="${escapeAttr(row.id)}" aria-label="Archive profile" title="Archive the WHOLE sporting profile (platform admin only) - hides it from active lists platform-wide. This does NOT disable their login, delete sessions, or end any coach/team/club relationship - those are separate actions.">${ICON_TRASH}</button>`);
  }
  return actions.join("");
}

function renderOrganizationRowV2(row, type, { isPlatformAdmin = false } = {}) {
  const canEdit = type !== "user";
  const isAthlete = type === "athlete";
  return `
    <article class="organization-row">
      ${renderOrganizationRowContent(row, type)}
      <span class="organization-row-actions">
        ${isAthlete ? renderAthleteLoginToggle(row) : ""}
        ${isAthlete ? inviteTriggerHtml(row) : ""}
        ${canEdit ? `<button class="plain-button icon-button" type="button" data-action="organization-edit" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}" aria-label="Edit" title="Edit">${ICON_PENCIL}</button>` : ""}
        ${isAthlete
          ? renderAthleteArchiveActions(row, isPlatformAdmin)
          : `<button class="plain-button icon-button danger-action" type="button" data-action="organization-delete" data-org-type="${escapeAttr(type)}" data-org-id="${escapeAttr(row.id)}" aria-label="Delete" title="Delete">${ICON_TRASH}</button>`}
      </span>
    </article>
  `;
}

function renderOrganizationRowContent(row, type) {
  const title = row.name || row.full_name || row.display_name || row.athlete_id || "Untitled";
  const subtitle = type === "athlete"
    ? [row.athlete_id || row.source_external_id, row.team_name, row.club_name].filter(Boolean).join(" - ")
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
        ${renderAccessCheckbox("canViewTeamLibrary", "Team library", row.can_view_team_library === true)}
        ${renderAccessCheckbox("canViewClubLibrary", "Club library", row.can_view_club_library === true)}
        ${renderAccessCheckbox("canViewOptimoveLibrary", "OptiMove", row.can_view_optimove_library === true)}
        ${renderAccessCheckbox("canViewMarketplace", "Marketplace", row.can_view_marketplace === true)}
      </div>
      <div>
        <h3>Visible coaches and staff</h3>
        <p class="muted">Control which coach profiles this athlete can discover or contact. This also leaves room for future staff types such as medical or physio profiles.</p>
      </div>
      <div class="athlete-access-grid">
        ${renderAccessCheckbox("canViewCoachProfiles", "Own coach profile", row.can_view_coach_profiles !== false)}
        ${renderAccessCheckbox("canViewClubCoachProfiles", "Club coaches", row.can_view_club_coach_profiles === true)}
        ${renderAccessCheckbox("canViewPublicCoachProfiles", "Public coaches", row.can_view_public_coach_profiles === true)}
        ${renderAccessCheckbox("canContactVisibleCoaches", "Can contact visible coaches", row.can_contact_visible_coaches !== false)}
      </div>
      <div>
        <h3>Visible exercise library</h3>
        <p class="muted">Choose whether this athlete can browse exercise content beyond exercises already shown inside assigned plans.</p>
      </div>
      <div class="athlete-access-grid">
        ${renderAccessCheckbox("canViewAssignedExercises", "Assigned exercises", row.can_view_assigned_exercises !== false)}
        ${renderAccessCheckbox("canViewCoachExerciseLibrary", "Coach exercise library", row.can_view_coach_exercise_library === true)}
        ${renderAccessCheckbox("canViewTeamExerciseLibrary", "Team exercise library", row.can_view_team_exercise_library === true)}
        ${renderAccessCheckbox("canViewClubExerciseLibrary", "Club exercise library", row.can_view_club_exercise_library === true)}
        ${renderAccessCheckbox("canViewOptimoveExerciseLibrary", "OptiMove exercise library", row.can_view_optimove_exercise_library === true)}
        ${renderAccessCheckbox("canViewExerciseGroups", "Selected exercise groups", row.can_view_exercise_groups === true)}
      </div>
      <div>
        <h3>Access rules</h3>
      </div>
      <div class="athlete-access-grid">
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
