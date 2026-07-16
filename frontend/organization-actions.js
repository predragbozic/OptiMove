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
    payload.freeOnly = formData.has("freeOnly");
    payload.requireApproval = formData.has("requireApproval");
  }
  try {
    const result = await api(endpoint, { method, body: JSON.stringify(payload) });
    if (type === "athleteInvite") {
      state.organizationInvite = {
        open: true,
        athleteId: payload.athleteId || state.organizationInvite.athleteId,
        inviteUrl: result.inviteUrl || "",
        mailtoUrl: result.mailtoUrl || "",
        error: "",
      };
      await renderOrganizationPanel({ refresh: false });
      return;
    }
    form.reset();
    state.organizationEditor = { open: false, type: "", row: null };
    await loadAthletes();
    if (state.activeTab === "organization") await renderOrganizationPanel();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save.";
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

export function findOrganizationRow(type, id) {
  const data = state.organization.data || {};
  const rows = type === "club" ? data.clubs : type === "team" ? data.teams : type === "athlete" ? data.athletes : [];
  return (rows || []).find((row) => String(row.id) === String(id)) || null;
}

export async function deleteOrganizationRow(type, id, { loadAthletes, renderOrganizationPanel }) {
  const labels = { club: "club", team: "team", athlete: "athlete" };
  if (!id || !labels[type]) return;
  if (!window.confirm(`Delete this ${labels[type]}? Existing plans are preserved, but it will be hidden from active lists.`)) return;
  await api(`/api/organization/${type}s/${encodeURIComponent(id)}`, { method: "DELETE" });
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
  if (type === "organization-invite-athlete") {
    const row = findOrganizationRow("athlete", action.dataset.athleteId);
    if (!row) return true;
    state.organizationInvite = { open: true, athleteId: row.id, inviteUrl: "", mailtoUrl: "", error: "" };
    state.organizationEditor = { open: false, type: "", row: null };
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-invite-close") {
    state.organizationInvite = { open: false, athleteId: "", inviteUrl: "", mailtoUrl: "", error: "" };
    void renderOrganizationPanel({ refresh: false });
    return true;
  }
  if (type === "organization-copy-invite") {
    const inviteUrl = state.organizationInvite.inviteUrl || "";
    if (inviteUrl) void navigator.clipboard?.writeText(inviteUrl);
    return true;
  }
  if (type === "organization-delete") {
    await deleteOrganizationRow(action.dataset.orgType, action.dataset.orgId, { loadAthletes, renderOrganizationPanel });
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
  return false;
}
