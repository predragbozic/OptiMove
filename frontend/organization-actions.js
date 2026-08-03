import { api } from "./api.js";
import { filterOrganizationSelect, syncOrganizationTeamSelect, validateFilterableSelects } from "./organization-select.js";
import { state } from "./state.js";

export async function submitOrganizationForm(form, { loadAthletes, renderOrganizationPanel }) {
  if (!validateFilterableSelects(form)) return;
  const type = form.dataset.organizationForm;
  const button = form.querySelector("button[type='submit']");
  const error = form.querySelector(".builder-error");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  const editId = form.dataset.organizationEditId;
  const athleteId = form.dataset.athleteId;
  const teamId = form.dataset.teamId;
  const endpoint = {
    club: "/api/organization/clubs",
    team: "/api/organization/teams",
    athlete: "/api/organization/athletes",
    user: "/api/organization/users",
    clubRole: "/api/organization/club-roles",
    teamRole: "/api/organization/team-roles",
    athleteLogin: "/api/organization/athlete-logins",
    athleteInvite: "/api/organization/athlete-invites",
    assignTeamAthlete: `/api/organization/teams/${encodeURIComponent(teamId || "")}/athletes`,
    athleteLibraryAccess: `/api/organization/athletes/${encodeURIComponent(athleteId || "")}/library-access`,
    "edit-club": `/api/organization/clubs/${encodeURIComponent(editId)}`,
    "edit-team": `/api/organization/teams/${encodeURIComponent(editId)}`,
    "edit-athlete": `/api/organization/athletes/${encodeURIComponent(editId)}`,
  }[type];
  const method = type.startsWith("edit-") || type === "athleteLibraryAccess" ? "PUT" : "POST";
  if (type === "athleteLibraryAccess") {
    payload.canViewCoachLibrary = formData.has("canViewCoachLibrary");
    payload.canViewClubLibrary = formData.has("canViewClubLibrary");
    payload.canViewOptimoveLibrary = formData.has("canViewOptimoveLibrary");
    payload.canViewMarketplace = formData.has("canViewMarketplace");
    payload.canViewCoachProfiles = formData.has("canViewCoachProfiles");
    payload.canViewClubCoachProfiles = formData.has("canViewClubCoachProfiles");
    payload.canViewPublicCoachProfiles = formData.has("canViewPublicCoachProfiles");
    payload.canContactVisibleCoaches = formData.has("canContactVisibleCoaches");
    payload.canViewAssignedExercises = formData.has("canViewAssignedExercises");
    payload.canViewCoachExerciseLibrary = formData.has("canViewCoachExerciseLibrary");
    payload.canViewClubExerciseLibrary = formData.has("canViewClubExerciseLibrary");
    payload.canViewOptimoveExerciseLibrary = formData.has("canViewOptimoveExerciseLibrary");
    payload.canViewExerciseGroups = formData.has("canViewExerciseGroups");
    payload.freeOnly = formData.has("freeOnly");
    payload.requireApproval = formData.has("requireApproval");
  }
  if (type === "athleteInvite") {
    // The invite always carries the account's CURRENT active workspace as
    // its presentation context - the backend independently re-derives and
    // re-checks permission from req.authz regardless of what's sent here.
    const workspace = state.currentUser?.activeWorkspace;
    payload.contextType = workspace?.type || "";
    payload.contextId = workspace?.scopeId || null;
  }
  try {
    const result = await api(endpoint, { method, body: JSON.stringify(payload) });
    if (type === "athleteInvite") {
      state.organizationInvite = {
        open: true,
        athleteId: payload.athleteId || state.organizationInvite.athleteId,
        pending: false,
        error: "",
        inviteUrl: result.inviteUrl || "",
        mailtoUrl: result.mailtoUrl || "",
        copied: false,
      };
      await renderOrganizationPanel({ refresh: true });
      return;
    }
    form.reset();
    state.organizationEditor = { open: false, type: "", row: null };
    if (["club", "team", "athlete", "user"].includes(type)) state.organization.addFormOpen = false;
    await loadAthletes();
    if (state.activeTab === "organization") await renderOrganizationPanel();
  } catch (submitError) {
    if (type === "athleteInvite") {
      state.organizationInvite.error = describeInviteError(submitError);
      void renderOrganizationPanel({ refresh: false });
    } else if (error) {
      error.textContent = submitError.message || "Could not save.";
    }
  } finally {
    if (button) button.disabled = false;
  }
}

export async function submitOrganizationAccessForm(form, { refreshOrganizationData, renderOrganizationPanel }) {
  const button = form.querySelector("button[type='submit']");
  const athleteIds = (form.dataset.athleteIds || "").split(",").map((id) => id.trim()).filter(Boolean);
  const patch = {};
  form.querySelectorAll("[data-athlete-access-key]").forEach((input) => {
    patch[input.dataset.athleteAccessKey] = input.checked;
  });
  if (!athleteIds.length || !Object.keys(patch).length) return;
  if (button) button.disabled = true;
  state.organization.accessError = "";
  state.organization.accessMessage = "";
  try {
    const result = await api("/api/organization/athlete-library-access/bulk", {
      method: "PUT",
      body: JSON.stringify({ athleteIds, patch }),
    });
    state.organization.accessMessage = `Updated ${result?.updated?.length || 0} shown athletes.`;
    await refreshOrganizationData?.();
    await renderOrganizationPanel({ refresh: false });
  } catch (error) {
    state.organization.accessError = error?.message || "Unable to update athlete access.";
    await renderOrganizationPanel({ refresh: false });
  } finally {
    if (button) button.disabled = false;
  }
}

export function handleOrganizationFilterInput(input) {
  return filterOrganizationSelect(input);
}

export function handleOrganizationSelectChange(select) {
  syncOrganizationTeamSelect(select);
}

export function syncOrganizationAccessGroupMaster(input) {
  const form = input?.closest?.("[data-organization-access-form]");
  const group = input?.dataset?.athleteAccessGroup || "";
  if (!form || !group) return;
  syncAccessGroupMaster(form, group);
}

export function findOrganizationRow(type, id) {
  const data = state.organization.data || {};
  const rows = type === "club" ? data.clubs : type === "team" ? data.teams : type === "athlete" ? data.athletes : [];
  return (rows || []).find((row) => String(row.id) === String(id)) || null;
}

// Athlete rows no longer go through this generic delete - archiving an
// athlete always means archiving ONE specific relationship (coach/team/club)
// or, for a platform admin only, the whole profile, each with its own
// dedicated action below. This remains for club/team/user, which are
// simple single-resource soft-deletes.
export async function deleteOrganizationRow(type, id, { loadAthletes, renderOrganizationPanel }) {
  // "user" is deliberately absent - a user account is never hard- or soft-
  // deleted from here. Its login is enabled/disabled via the Manage account
  // modal (PUT /organization/users/:userId/login-status), which never
  // touches roles, athlete profile, or membership history.
  const labels = { club: "club", team: "team" };
  if (!id || !labels[type]) return;
  const confirmMessage = `Delete this ${labels[type]}? Existing plans are preserved, but it will be hidden from active lists.`;
  if (!window.confirm(confirmMessage)) return;
  await api(`/api/organization/${type}s/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadAthletes();
  if (state.activeTab === "organization") await renderOrganizationPanel();
}

async function archiveAthleteRelationship(endpoint, confirmMessage, { loadAthletes, renderOrganizationPanel }) {
  if (!window.confirm(confirmMessage)) return;
  await api(endpoint, { method: "DELETE" });
  await loadAthletes();
  if (state.activeTab === "organization") await renderOrganizationPanel();
}

async function restoreAthleteRelationship(endpoint, { loadAthletes, renderOrganizationPanel }) {
  await api(endpoint, { method: "PUT" });
  await loadAthletes();
  if (state.activeTab === "organization") await renderOrganizationPanel();
}

export async function handleOrganizationAction(action, { loadAthletes, renderOrganizationPanel, refreshOrganizationData, renderAfterOrganizationAccessChange }) {
  const type = action.dataset.action;
  if (!type?.startsWith("organization-")) return false;
  const renderAccessState = async (options = {}) => {
    if (renderAfterOrganizationAccessChange) await renderAfterOrganizationAccessChange(options);
    else await renderOrganizationPanel(options);
  };
  if (type === "organization-edit") {
    const row = findOrganizationRow(action.dataset.orgType, action.dataset.orgId);
    if (!row) return true;
    state.organizationEditor = { open: true, type: action.dataset.orgType, row };
    void renderOrganizationPanel();
    return true;
  }
  if (type === "organization-select-club") {
    state.organization.selectedClubId = action.dataset.clubId || "";
    state.organization.selectedTeamId = "";
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-select-team") {
    state.organization.selectedTeamId = action.dataset.teamId || "";
    const team = findOrganizationRow("team", state.organization.selectedTeamId);
    if (team?.club_id) state.organization.selectedClubId = team.club_id;
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-clear-selection") {
    state.organization.selectedClubId = "";
    state.organization.selectedTeamId = "";
    state.organization.assignOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-section") {
    state.organization.section = action.dataset.section || "overview";
    state.organization.addFormOpen = false;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-toggle-add-form") {
    state.organization.addFormOpen = !state.organization.addFormOpen;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-request-filter") {
    state.organization.requestStatus = action.dataset.requestStatus || "all";
    state.organization.requestError = "";
    state.organization.requestMessage = "";
    void renderAccessState({ refresh: false });
    return true;
  }
  if (type === "organization-request-athlete-filter") {
    state.organization.requestAthleteId = action.dataset.requestAthleteId || "all";
    state.organization.requestError = "";
    state.organization.requestMessage = "";
    void renderAccessState({ refresh: false });
    return true;
  }
  if (type === "organization-edit-close") {
    state.organizationEditor = { open: false, type: "", row: null };
    void renderOrganizationPanel();
    return true;
  }
  if (type === "organization-toggle-assign-athlete") {
    state.organization.assignOpen = !state.organization.assignOpen;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-toggle-archived-athletes") {
    state.organization.showArchivedAthletes = !state.organization.showArchivedAthletes;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-toggle-archived-team-members") {
    state.organization.showArchivedTeamMembers = !state.organization.showArchivedTeamMembers;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-toggle-archived-club-members") {
    state.organization.showArchivedClubMembers = !state.organization.showArchivedClubMembers;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-toggle-disabled-users") {
    state.organization.showDisabledUsers = !state.organization.showDisabledUsers;
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-manage-account-open") {
    const userId = action.dataset.userId;
    if (!userId) return true;
    state.organizationUserManage = { open: true, userId, pending: false, error: "" };
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-manage-account-close") {
    closeManageAccountModal(renderOrganizationPanel);
    return true;
  }
  if (type === "organization-global-role-toggle") {
    const userId = action.dataset.userId || "";
    const role = action.dataset.role || "";
    const nextActive = action.dataset.nextActive === "true";
    if (!userId || !role || state.organizationUserManage.pending) return true;
    if (role === "platform_admin" && !nextActive) {
      if (!window.confirm("Remove platform administrator access from this account? Other roles and login access will remain unchanged.")) return true;
    }
    action.disabled = true;
    state.organizationUserManage.pending = true;
    state.organizationUserManage.error = "";
    void renderOrganizationPanel({ refresh: false });
    try {
      await api(`/api/organization/users/${encodeURIComponent(userId)}/global-roles/${encodeURIComponent(role)}`, {
        method: nextActive ? "PUT" : "DELETE",
      });
      state.organizationUserManage.pending = false;
      await refreshOrganizationData?.();
      await renderOrganizationPanel({ refresh: false });
    } catch (error) {
      state.organizationUserManage.pending = false;
      state.organizationUserManage.error = describeOrganizationAccountError(error);
      void renderOrganizationPanel({ refresh: false });
    }
    return true;
  }
  if (type === "organization-user-login-toggle") {
    const userId = action.dataset.userId || "";
    const nextActive = action.dataset.nextActive === "true";
    if (!userId || state.organizationUserManage.pending) return true;
    if (!nextActive) {
      if (!window.confirm("Disable sign-in for this account? All current sessions will end. Roles, athlete profile, memberships, plans and history will remain unchanged.")) return true;
    }
    action.disabled = true;
    state.organizationUserManage.pending = true;
    state.organizationUserManage.error = "";
    void renderOrganizationPanel({ refresh: false });
    try {
      // Strictly a JSON boolean, never a coerced value - matches what
      // PUT /organization/users/:userId/login-status requires.
      await api(`/api/organization/users/${encodeURIComponent(userId)}/login-status`, {
        method: "PUT",
        body: JSON.stringify({ active: nextActive }),
      });
      state.organizationUserManage.pending = false;
      await refreshOrganizationData?.();
      await renderOrganizationPanel({ refresh: false });
    } catch (error) {
      state.organizationUserManage.pending = false;
      state.organizationUserManage.error = describeOrganizationAccountError(error);
      void renderOrganizationPanel({ refresh: false });
    }
    return true;
  }
  if (type === "organization-club-role-add") {
    const userId = action.dataset.userId || "";
    const container = action.closest('[data-manage-account-add="club"]');
    const clubId = container?.querySelector('select[name="clubId"]')?.value || "";
    if (!userId || !clubId || state.organizationUserManage.pending) return true;
    await performScopedRoleChange(action, {
      endpoint: `/api/organization/users/${encodeURIComponent(userId)}/club-roles/${encodeURIComponent(clubId)}/club_admin`,
      method: "PUT",
      renderOrganizationPanel,
      refreshOrganizationData,
    });
    return true;
  }
  if (type === "organization-club-role-remove") {
    const userId = action.dataset.userId || "";
    const clubId = action.dataset.clubId || "";
    if (!userId || !clubId || state.organizationUserManage.pending) return true;
    const userName = action.dataset.userName || "this user";
    const clubName = action.dataset.clubName || "this club";
    await performScopedRoleChange(action, {
      endpoint: `/api/organization/users/${encodeURIComponent(userId)}/club-roles/${encodeURIComponent(clubId)}/club_admin`,
      method: "DELETE",
      confirmMessage: `Remove club administrator access for ${userName} in ${clubName}?`,
      renderOrganizationPanel,
      refreshOrganizationData,
    });
    return true;
  }
  if (type === "organization-team-role-add") {
    const userId = action.dataset.userId || "";
    const container = action.closest('[data-manage-account-add="team"]');
    const teamId = container?.querySelector('select[name="teamId"]')?.value || "";
    if (!userId || !teamId || state.organizationUserManage.pending) return true;
    await performScopedRoleChange(action, {
      endpoint: `/api/organization/users/${encodeURIComponent(userId)}/team-roles/${encodeURIComponent(teamId)}/team_coach`,
      method: "PUT",
      renderOrganizationPanel,
      refreshOrganizationData,
    });
    return true;
  }
  if (type === "organization-team-role-remove") {
    const userId = action.dataset.userId || "";
    const teamId = action.dataset.teamId || "";
    if (!userId || !teamId || state.organizationUserManage.pending) return true;
    const userName = action.dataset.userName || "this user";
    const teamName = action.dataset.teamName || "this team";
    await performScopedRoleChange(action, {
      endpoint: `/api/organization/users/${encodeURIComponent(userId)}/team-roles/${encodeURIComponent(teamId)}/team_coach`,
      method: "DELETE",
      confirmMessage: `Remove team coach access for ${userName} in ${teamName}?`,
      renderOrganizationPanel,
      refreshOrganizationData,
    });
    return true;
  }
  if (type === "organization-archive-coach-relationship") {
    const athleteId = action.dataset.athleteId;
    if (!athleteId) return true;
    action.disabled = true;
    try {
      await archiveAthleteRelationship(
        `/api/organization/athletes/${encodeURIComponent(athleteId)}/coach-relationship`,
        "Archive this athlete from your own athletes list? This only ends YOUR private-coach relationship - their login, history, and any other coach/team/club relationships stay exactly as they are. You can restore it later from Show archived.",
        { loadAthletes, renderOrganizationPanel },
      );
    } catch (error) {
      window.alert(error?.message || "Could not archive this relationship.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-restore-coach-relationship") {
    const athleteId = action.dataset.athleteId;
    if (!athleteId) return true;
    action.disabled = true;
    try {
      await restoreAthleteRelationship(`/api/organization/athletes/${encodeURIComponent(athleteId)}/coach-relationship/restore`, { loadAthletes, renderOrganizationPanel });
    } catch (error) {
      window.alert(error?.message || "Could not restore this relationship.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-archive-team-membership") {
    const athleteId = action.dataset.athleteId;
    const teamId = action.dataset.teamId;
    if (!athleteId || !teamId) return true;
    action.disabled = true;
    try {
      await archiveAthleteRelationship(
        `/api/organization/teams/${encodeURIComponent(teamId)}/athletes/${encodeURIComponent(athleteId)}`,
        "Remove this athlete from the team? This only ends their membership in THIS team - their login, history, and any other teams/clubs/coaches stay exactly as they are. You can restore it later from Show archived.",
        { loadAthletes, renderOrganizationPanel },
      );
    } catch (error) {
      window.alert(error?.message || "Could not remove this athlete from the team.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-restore-team-membership") {
    const athleteId = action.dataset.athleteId;
    const teamId = action.dataset.teamId;
    if (!athleteId || !teamId) return true;
    action.disabled = true;
    try {
      await restoreAthleteRelationship(`/api/organization/teams/${encodeURIComponent(teamId)}/athletes/${encodeURIComponent(athleteId)}/restore`, { loadAthletes, renderOrganizationPanel });
    } catch (error) {
      window.alert(error?.message || "Could not restore this team membership.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-archive-club-membership") {
    const athleteId = action.dataset.athleteId;
    const clubId = action.dataset.clubId;
    if (!athleteId || !clubId) return true;
    action.disabled = true;
    try {
      await archiveAthleteRelationship(
        `/api/organization/clubs/${encodeURIComponent(clubId)}/athletes/${encodeURIComponent(athleteId)}`,
        "Archive this athlete from the club? This ends their membership in THIS club (and any active team memberships within it) - their login, history, other clubs, and any private coaches stay exactly as they are. You can restore the club membership later from Show archived.",
        { loadAthletes, renderOrganizationPanel },
      );
    } catch (error) {
      window.alert(error?.message || "Could not archive this club membership.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-restore-club-membership") {
    const athleteId = action.dataset.athleteId;
    const clubId = action.dataset.clubId;
    if (!athleteId || !clubId) return true;
    action.disabled = true;
    try {
      await restoreAthleteRelationship(`/api/organization/clubs/${encodeURIComponent(clubId)}/athletes/${encodeURIComponent(athleteId)}/restore`, { loadAthletes, renderOrganizationPanel });
    } catch (error) {
      window.alert(error?.message || "Could not restore this club membership.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-archive-profile") {
    const athleteId = action.dataset.athleteId;
    if (!athleteId) return true;
    action.disabled = true;
    try {
      await archiveAthleteRelationship(
        `/api/organization/athletes/${encodeURIComponent(athleteId)}/archive-profile`,
        "Archive this athlete's WHOLE sporting profile? This hides it from active lists platform-wide. It does NOT disable their login, delete sessions, or end any coach/team/club relationship - use the specific relationship actions for that. This can be restored later.",
        { loadAthletes, renderOrganizationPanel },
      );
    } catch (error) {
      window.alert(error?.message || "Could not archive this profile.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-restore-profile") {
    const athleteId = action.dataset.athleteId;
    if (!athleteId) return true;
    action.disabled = true;
    try {
      await restoreAthleteRelationship(`/api/organization/athletes/${encodeURIComponent(athleteId)}/restore-profile`, { loadAthletes, renderOrganizationPanel });
    } catch (error) {
      window.alert(error?.message || "Could not restore this profile.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-toggle-athlete-access") {
    state.organization.accessOpen = !state.organization.accessOpen;
    state.organization.accessError = "";
    state.organization.accessMessage = "";
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-access-group-set") {
    const group = action.dataset.accessGroup || "";
    const form = action.closest("[data-organization-access-form]");
    if (!group || !form) return true;
    const inputs = accessGroupInputs(form, group);
    const allChecked = inputs.length > 0 && inputs.every((input) => input.checked);
    const checked = !allChecked;
    inputs.forEach((input) => {
      input.checked = checked;
    });
    syncAccessGroupMaster(form, group);
    return true;
  }
  if (type === "organization-invite-athlete") {
    const row = findOrganizationRow("athlete", action.dataset.athleteId);
    if (!row) return true;
    state.organizationInvite = { open: true, athleteId: row.id, pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
    state.organizationEditor = { open: false, type: "", row: null };
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-invite-close") {
    closeAthleteInviteModal(renderOrganizationPanel);
    return true;
  }
  if (type === "organization-copy-invite") {
    const inviteUrl = state.organizationInvite.inviteUrl || "";
    if (!inviteUrl) return true;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
        state.organizationInvite.copied = true;
      }
    } catch {
      state.organizationInvite.copied = false;
    }
    // If the clipboard API isn't available or the write failed, the link
    // stays visible in its readonly input either way - the user can select
    // and copy it manually - so no error is surfaced here, just no "Link
    // copied" confirmation.
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-invite-regenerate") {
    const athleteId = state.organizationInvite.athleteId;
    const row = findOrganizationRow("athlete", athleteId);
    const currentInvite = row?.invite;
    if (!athleteId || !currentInvite || state.organizationInvite.pending) return true;
    if (!window.confirm("Generate a new invite link? The current link will stop working immediately.")) return true;
    const workspace = state.currentUser?.activeWorkspace;
    state.organizationInvite.pending = true;
    state.organizationInvite.error = "";
    void renderOrganizationPanel({ refresh: false });
    try {
      const result = await api("/api/organization/athlete-invites", {
        method: "POST",
        body: JSON.stringify({ athleteId, email: currentInvite.email, contextType: workspace?.type || "", contextId: workspace?.scopeId || null }),
      });
      state.organizationInvite.pending = false;
      state.organizationInvite.inviteUrl = result.inviteUrl || "";
      state.organizationInvite.mailtoUrl = result.mailtoUrl || "";
      state.organizationInvite.copied = false;
      await renderOrganizationPanel({ refresh: true });
    } catch (error) {
      state.organizationInvite.pending = false;
      state.organizationInvite.error = describeInviteError(error);
      void renderOrganizationPanel({ refresh: false });
    }
    return true;
  }
  if (type === "organization-invite-revoke") {
    const inviteId = action.dataset.inviteId;
    if (!inviteId || state.organizationInvite.pending) return true;
    if (!window.confirm("Revoke this invite? The link will stop working immediately.")) return true;
    state.organizationInvite.pending = true;
    state.organizationInvite.error = "";
    void renderOrganizationPanel({ refresh: false });
    try {
      await api(`/api/organization/athlete-invites/${encodeURIComponent(inviteId)}`, { method: "DELETE" });
      state.organizationInvite.pending = false;
      await renderOrganizationPanel({ refresh: true });
    } catch (error) {
      state.organizationInvite.pending = false;
      state.organizationInvite.error = describeInviteError(error);
      void renderOrganizationPanel({ refresh: false });
    }
    return true;
  }
  if (type === "organization-delete") {
    await deleteOrganizationRow(action.dataset.orgType, action.dataset.orgId, { loadAthletes, renderOrganizationPanel });
    return true;
  }
  if (type === "organization-toggle-athlete-login") {
    const athleteId = action.dataset.athleteId;
    const nextActive = action.dataset.currentActive !== "true";
    if (!athleteId) return true;
    action.disabled = true;
    try {
      await api(`/api/organization/athletes/${encodeURIComponent(athleteId)}/login-status`, {
        method: "PUT",
        body: JSON.stringify({ active: nextActive }),
      });
      await loadAthletes();
      if (state.activeTab === "organization") await renderOrganizationPanel();
    } catch (error) {
      window.alert(error?.message || "Could not update login status.");
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-access-approve" || type === "organization-access-reject") {
    const accessId = action.dataset.accessId || "";
    if (!accessId) return true;
    const actionName = type === "organization-access-approve" ? "approve" : "reject";
    action.disabled = true;
    state.organization.requestError = "";
    state.organization.requestMessage = "";
    try {
      await api(`/api/organization/program-access/${encodeURIComponent(accessId)}/${actionName}`, { method: "POST" });
      state.organization.requestMessage = actionName === "approve" ? "Program request approved." : "Program request rejected.";
      await refreshOrganizationData?.();
      await renderAccessState({ refresh: false });
    } catch (error) {
      state.organization.requestError = error?.message || "Unable to update this request.";
      await renderAccessState({ refresh: false });
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-access-bulk") {
    const actionName = action.dataset.accessAction || "";
    const accessIds = (action.dataset.accessIds || "").split(",").map((id) => id.trim()).filter(Boolean);
    if (!["approve", "reject"].includes(actionName) || !accessIds.length) return true;
    action.disabled = true;
    state.organization.requestError = "";
    state.organization.requestMessage = "";
    try {
      const result = await api("/api/organization/program-access/bulk", {
        method: "POST",
        body: JSON.stringify({ action: actionName, accessIds }),
      });
      if (!result?.updated?.length) state.organization.requestError = "No shown requests were changed.";
      else {
        const changed = result.updated.length;
        state.organization.requestMessage = actionName === "approve"
          ? `Approved ${changed} shown ${changed === 1 ? "request" : "requests"}.`
          : `Rejected ${changed} shown ${changed === 1 ? "request" : "requests"}.`;
        const updates = new Map(result.updated.map((row) => [String(row.id), row]));
        const accessRequests = state.organization?.data?.accessRequests || [];
        state.organization.data = {
          ...state.organization.data,
          accessRequests: accessRequests.map((row) => (
            updates.has(String(row.id)) ? { ...row, ...updates.get(String(row.id)) } : row
          )),
        };
      }
      await refreshOrganizationData?.();
      await renderAccessState({ refresh: false });
    } catch (error) {
      state.organization.requestError = error?.message || "Unable to update shown requests.";
      await renderAccessState({ refresh: false });
    } finally {
      action.disabled = false;
    }
    return true;
  }
  if (type === "organization-athlete-access-bulk") {
    const athleteIds = (action.dataset.athleteIds || "").split(",").map((id) => id.trim()).filter(Boolean);
    let patch = {};
    try {
      patch = JSON.parse(action.dataset.accessPatch || "{}");
    } catch {
      patch = {};
    }
    if (!athleteIds.length || !Object.keys(patch).length) return true;
    action.disabled = true;
    state.organization.accessError = "";
    state.organization.accessMessage = "";
    try {
      const result = await api("/api/organization/athlete-library-access/bulk", {
        method: "PUT",
        body: JSON.stringify({ athleteIds, patch }),
      });
      state.organization.accessMessage = `Updated ${result?.updated?.length || 0} shown athletes.`;
      await refreshOrganizationData?.();
      await renderOrganizationPanel({ refresh: false });
    } catch (error) {
      state.organization.accessError = error?.message || "Unable to update athlete access.";
      await renderOrganizationPanel({ refresh: false });
    } finally {
      action.disabled = false;
    }
    return true;
  }
  return false;
}

// Shared by the modal's own close button/backdrop click (via
// handleOrganizationAction above) and the global Escape handler in app.js,
// so both paths reset exactly the same state - never an API request, just
// closing the view.
export function closeManageAccountModal(renderOrganizationPanel) {
  state.organizationUserManage = { open: false, userId: "", pending: false, error: "" };
  void renderOrganizationPanel({ refresh: false });
}

// Shared by the invite modal's own close button/backdrop click (via
// handleOrganizationAction above) and the global Escape handler in app.js -
// never an API call, just closing the view.
export function closeAthleteInviteModal(renderOrganizationPanel) {
  state.organizationInvite = { open: false, athleteId: "", pending: false, error: "", inviteUrl: "", mailtoUrl: "", copied: false };
  void renderOrganizationPanel({ refresh: false });
}

// LAST_PLATFORM_ADMIN/LAST_CLUB_ADMIN are machine-readable error codes from
// the backend (api.js surfaces them verbatim as error.message from
// {error: "..."}) - never shown to the user as-is. Any other error (403,
// network failure, 500) just passes the backend's own message through, or
// a generic fallback for a network error with no JSON body.
function describeOrganizationAccountError(error) {
  if (error?.message === "LAST_PLATFORM_ADMIN") return "At least one active platform administrator must remain.";
  if (error?.message === "LAST_CLUB_ADMIN") return "At least one active club administrator must remain.";
  return error?.message || "Something went wrong. Please try again.";
}

// ATHLETE_ALREADY_HAS_LOGIN/UNSUPPORTED_INVITE_CONTEXT are machine-readable
// codes from the backend - never shown to the user as-is.
function describeInviteError(error) {
  if (error?.message === "ATHLETE_ALREADY_HAS_LOGIN") return "This athlete already has a login and cannot receive a new invite.";
  if (error?.message === "UNSUPPORTED_INVITE_CONTEXT") return "This workspace cannot send invites.";
  return error?.message || "Could not save the invite. Please try again.";
}

// Shared executor for every Manage account modal action that hits a
// PUT/DELETE scoped-role or login-status endpoint: blocks a repeat click
// while a request is in flight, shows the confirmation (if any) before
// doing anything, and on failure leaves state exactly as it was (no
// optimistic change) with the error surfaced in the modal - it never closes
// the modal on failure.
async function performScopedRoleChange(action, { endpoint, method, confirmMessage, renderOrganizationPanel, refreshOrganizationData }) {
  if (confirmMessage && !window.confirm(confirmMessage)) return;
  action.disabled = true;
  state.organizationUserManage.pending = true;
  state.organizationUserManage.error = "";
  void renderOrganizationPanel({ refresh: false });
  try {
    await api(endpoint, { method });
    state.organizationUserManage.pending = false;
    await refreshOrganizationData?.();
    await renderOrganizationPanel({ refresh: false });
  } catch (error) {
    state.organizationUserManage.pending = false;
    state.organizationUserManage.error = describeOrganizationAccountError(error);
    void renderOrganizationPanel({ refresh: false });
  }
}

function accessGroupInputs(form, group) {
  return Array.from(form.querySelectorAll(`[data-athlete-access-group="${selectorEscape(group)}"]`));
}

function syncAccessGroupMaster(form, group) {
  const inputs = accessGroupInputs(form, group);
  const master = form.querySelector(`[data-action="organization-access-group-set"][data-access-group="${selectorEscape(group)}"]`);
  if (!master) return;
  const checkedCount = inputs.filter((input) => input.checked).length;
  const allChecked = inputs.length > 0 && checkedCount === inputs.length;
  const mixedChecked = checkedCount > 0 && !allChecked;
  master.dataset.accessChecked = allChecked ? "false" : "true";
  master.classList.toggle("is-checked", allChecked);
  master.classList.toggle("is-mixed", mixedChecked);
  master.setAttribute("aria-pressed", allChecked ? "true" : "false");
  master.setAttribute("aria-label", allChecked ? "Uncheck all" : "Check all");
  const mark = master.querySelector("span");
  if (mark) mark.innerHTML = allChecked ? "&#10003;" : mixedChecked ? "&minus;" : "";
}

function selectorEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}
