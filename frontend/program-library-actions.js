import { api } from "./api.js";
import { emptyTemplatePreview, state } from "./state.js";
import { clean } from "./utils.js";

export async function openTemplatePreview(planId, renderAfter) {
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(planId));
  if (!selected) return;
  await openTemplatePreviewWithRenderer(selected, renderAfter);
}

export async function openTemplatePreviewFromCoachProgram(program, renderAfter) {
  if (!program?.plan_id) return;
  if (!state.lastTemplates.some((template) => String(template.plan_id) === String(program.plan_id))) {
    state.lastTemplates = [...state.lastTemplates, normalizeCoachProgramAsTemplate(program)];
  }
  const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(program.plan_id));
  await openTemplatePreviewWithRenderer(selected, renderAfter);
}

async function openTemplatePreviewWithRenderer(selected, renderAfter) {
  state.selectedTemplateId = selected.plan_id;
  state.templatePreview = emptyTemplatePreview({ open: true, loading: true });
  renderAfter();
  try {
    const detail = await api(`/api/plans/${encodeURIComponent(selected.plan_id)}/program`);
    let reviewsData = { reviews: [] };
    let reviewError = "";
    let accessRequestsData = { requests: [] };
    let accessRequestError = "";
    try {
      reviewsData = await api(`/api/templates/${encodeURIComponent(selected.plan_id)}/reviews`);
    } catch (reviewsLoadError) {
      reviewError = reviewsLoadError.message || "Could not load reviews.";
    }
    if (String(state.currentUser?.accessScope || "").toLowerCase() !== "athlete") {
      try {
        accessRequestsData = await api(`/api/templates/${encodeURIComponent(selected.plan_id)}/access-requests`);
      } catch (requestsLoadError) {
        accessRequestError = requestsLoadError.message || "Could not load access requests.";
      }
    }
    state.templatePreview = emptyTemplatePreview({
      ...state.templatePreview,
      open: true,
      loading: false,
      detail,
      reviews: reviewsData.reviews || [],
      accessRequests: accessRequestsData.requests || [],
      accessRequestError,
      error: "",
      reviewError,
    });
  } catch (error) {
    state.templatePreview = emptyTemplatePreview({ ...state.templatePreview, open: true, loading: false, detail: null, error: error.message || "Could not load program." });
  }
  renderAfter();
}

async function refreshTemplateAccessRequests(planId) {
  if (!planId || String(state.currentUser?.accessScope || "").toLowerCase() === "athlete") {
    return { requests: [] };
  }
  return api(`/api/templates/${encodeURIComponent(planId)}/access-requests`);
}

function normalizeCoachProgramAsTemplate(program) {
  return {
    ...program,
    plan_id: program.plan_id,
    plan_name: program.plan_name,
    library_category: program.library_category,
    cover_image_url: program.cover_image_url,
    is_free: program.is_free,
    price_cents: program.price_cents,
    average_rating: program.average_rating,
    review_count: program.review_count,
    library_scope: program.library_scope === "coach" ? "my" : (program.library_scope || "my"),
    tags: program.tags || [],
  };
}

export function handleTemplateLibraryAction(action, { loadTemplates, renderCoachContext, renderTemplateLibrary }) {
  const type = action.dataset.action;
  if (type === "template-open") {
    void openTemplatePreview(action.dataset.templateId, () => renderTemplateLibrary(state.lastTemplates));
    return true;
  }
  if (type === "template-info") {
    const template = state.lastTemplates.find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (template) {
      state.programInfo = { open: true, program: template };
      renderTemplateLibrary(state.lastTemplates);
    }
    return true;
  }
  if (type === "program-info-close") {
    state.programInfo = { open: false, program: null };
    if (state.activeTab === "coaches") renderCoachContext();
    else renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-scope") {
    state.programLibrarySection = "programs";
    state.templateScope = action.dataset.scope || "my_programs";
    if (state.templateScope !== "my_programs") state.templateFilters.lifecycle = "all";
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    void loadTemplates();
    return true;
  }
  if (type === "program-library-section") {
    state.programLibrarySection = action.dataset.programLibrarySection || "programs";
    state.selectedTemplateId = null;
    state.templatePreview = emptyTemplatePreview();
    void loadTemplates();
    return true;
  }
  if (type === "template-settings-toggle") {
    state.templatePreview = { ...state.templatePreview, settingsOpen: !state.templatePreview.settingsOpen };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-use") {
    void markTemplateUsed(action.dataset.templateId, { renderTemplateLibrary });
    return true;
  }
  if (type === "template-access-approve" || type === "template-access-reject" || type === "template-access-revoke") {
    const accessAction = type === "template-access-approve" ? "approve" : type === "template-access-reject" ? "reject" : "revoke";
    void updateTemplateAccessRequest(action.dataset.accessId, accessAction, {
      renderAfter: () => {
        if (state.activeTab === "coaches") renderCoachContext();
        else renderTemplateLibrary(state.lastTemplates);
      },
    });
    return true;
  }
  if (type === "template-access-bulk") {
    void bulkUpdateTemplateAccessRequests(action.dataset.accessAction, action.dataset.accessIds, {
      renderAfter: () => {
        if (state.activeTab === "coaches") renderCoachContext();
        else renderTemplateLibrary(state.lastTemplates);
      },
    });
    return true;
  }
  if (type === "template-assign") {
    const selected = state.lastTemplates.find((template) => String(template.plan_id) === String(action.dataset.templateId));
    if (!selected) return true;
    state.templatePreview = {
      ...state.templatePreview,
      assignOpen: !state.templatePreview.assignOpen,
      assignError: "",
      assignMessage: "",
      assignedAthleteIds: state.templatePreview.assignOpen ? [] : state.templatePreview.assignedAthleteIds,
    };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-assign-toggle-athlete") {
    const athleteId = action.dataset.athleteId || "";
    const selectedIds = new Set((state.templatePreview.assignedAthleteIds || []).map(String));
    if (selectedIds.has(String(athleteId))) selectedIds.delete(String(athleteId));
    else selectedIds.add(String(athleteId));
    state.templatePreview = {
      ...state.templatePreview,
      assignError: "",
      assignMessage: "",
      assignedAthleteIds: [...selectedIds],
    };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-assign-toggle-all") {
    const athleteIds = (state.athletes || []).map(assignmentAthleteId).filter(Boolean);
    const selectedIds = new Set((state.templatePreview.assignedAthleteIds || []).map(String));
    const allSelected = athleteIds.length > 0 && athleteIds.every((athleteId) => selectedIds.has(String(athleteId)));
    state.templatePreview = {
      ...state.templatePreview,
      assignError: "",
      assignMessage: "",
      assignedAthleteIds: allSelected ? [] : athleteIds,
    };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-assign-submit") {
    void assignTemplateToAthletes(action.dataset.templateId, { renderTemplateLibrary });
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-review-toggle") {
    state.templatePreview = {
      ...state.templatePreview,
      reviewOpen: !state.templatePreview.reviewOpen,
      reviewError: "",
      reviewMessage: "",
    };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-reviews-toggle") {
    state.templatePreview = { ...state.templatePreview, reviewsOpen: !state.templatePreview.reviewsOpen };
    renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "template-close") {
    state.templatePreview = emptyTemplatePreview();
    if (state.activeTab === "coaches") renderCoachContext();
    else renderTemplateLibrary(state.lastTemplates);
    return true;
  }
  if (type === "program-tags-close") {
    closeProgramTagEditor({ renderTemplateLibrary });
    return true;
  }
  if (type === "program-tag-add") {
    void addInlineProgramTag(action.dataset.planId, { renderTemplateLibrary });
    return true;
  }
  if (type === "program-tag-remove") {
    void removeProgramTag(action.dataset.planId, action.dataset.tagId, { renderTemplateLibrary });
    return true;
  }
  return false;
}

function assignmentAthleteId(athlete) {
  return String(athlete?.athlete_uuid || athlete?.id || athlete?.athlete_id || "");
}

async function assignTemplateToAthletes(planId, { renderTemplateLibrary }) {
  const athleteIds = state.templatePreview.assignedAthleteIds || [];
  if (!planId || !athleteIds.length || state.templatePreview.assigning) return;
  state.templatePreview = {
    ...state.templatePreview,
    assigning: true,
    assignError: "",
    assignMessage: "",
  };
  renderTemplateLibrary(state.lastTemplates);
  try {
    const response = await api(`/api/templates/${encodeURIComponent(planId)}/assignments`, {
      method: "POST",
      body: JSON.stringify({ athleteIds }),
    });
    let accessRequests = state.templatePreview.accessRequests || [];
    let accessRequestError = "";
    try {
      const accessData = await refreshTemplateAccessRequests(planId);
      accessRequests = accessData.requests || [];
    } catch (refreshError) {
      accessRequestError = refreshError.message || "Access was changed, but the access list could not be refreshed.";
    }
    const assignedCount = (response.assigned || []).length;
    const skipped = response.skipped || [];
    state.templatePreview = {
      ...state.templatePreview,
      assigning: false,
      assignOpen: skipped.length > 0,
      assignedAthleteIds: skipped.length ? athleteIds : [],
      assignMessage: assignedCount
        ? `Access granted to ${assignedCount} ${assignedCount === 1 ? "athlete" : "athletes"}.`
        : "",
      assignError: skipped.length
        ? skipped.map((item) => `${item.athleteName || item.athleteId}: ${item.reason}`).join(" ")
        : "",
      accessRequests,
      accessRequestError,
    };
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      assigning: false,
      assignError: error.message || "Could not assign this program.",
      assignMessage: "",
    };
  }
  renderTemplateLibrary(state.lastTemplates);
}

async function updateTemplateAccessRequest(accessId, actionName, { renderAfter }) {
  if (!accessId || state.templatePreview.submittingAccessId) return;
  state.templatePreview = {
    ...state.templatePreview,
    submittingAccessId: accessId,
    accessRequestError: "",
    reviewMessage: "",
  };
  renderAfter();
  try {
    await api(`/api/organization/program-access/${encodeURIComponent(accessId)}/${actionName}`, { method: "POST" });
    let accessRequests = (state.templatePreview.accessRequests || []).filter((request) => String(request.id) !== String(accessId));
    let accessRequestError = "";
    try {
      const accessData = await refreshTemplateAccessRequests(state.selectedTemplateId);
      accessRequests = accessData.requests || [];
    } catch (refreshError) {
      accessRequestError = refreshError.message || "Access was changed, but the access list could not be refreshed.";
    }
    state.templatePreview = {
      ...state.templatePreview,
      submittingAccessId: "",
      accessRequests,
      reviewMessage: actionName === "approve"
        ? "Program access approved."
        : actionName === "revoke"
          ? "Program access removed."
          : "Program request rejected.",
      accessRequestError,
    };
    if (actionName !== "revoke") patchTemplatePendingRequestCount(state.selectedTemplateId, -1);
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingAccessId: "",
      accessRequestError: error.message || "Could not update access request.",
    };
  }
  renderAfter();
}

async function bulkUpdateTemplateAccessRequests(actionName, accessIdsText, { renderAfter }) {
  const accessIds = String(accessIdsText || "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!["approve", "reject"].includes(actionName) || !accessIds.length || state.templatePreview.submittingAccessBulk) return;
  state.templatePreview = {
    ...state.templatePreview,
    submittingAccessBulk: true,
    accessRequestError: "",
    reviewMessage: "",
  };
  renderAfter();
  try {
    const response = await api("/api/organization/program-access/bulk", {
      method: "POST",
      body: JSON.stringify({ action: actionName, accessIds }),
    });
    const updatedIds = new Set((response.updated || []).map((row) => String(row.id)));
    const changed = updatedIds.size;
    let accessRequests = (state.templatePreview.accessRequests || []).filter((request) => !updatedIds.has(String(request.id)));
    let accessRequestError = "";
    try {
      const accessData = await refreshTemplateAccessRequests(state.selectedTemplateId);
      accessRequests = accessData.requests || [];
    } catch (refreshError) {
      accessRequestError = refreshError.message || "Access was changed, but the access list could not be refreshed.";
    }
    state.templatePreview = {
      ...state.templatePreview,
      submittingAccessBulk: false,
      accessRequests,
      reviewMessage: changed
        ? actionName === "approve"
          ? `Approved ${changed} ${changed === 1 ? "request" : "requests"}.`
          : `Rejected ${changed} ${changed === 1 ? "request" : "requests"}.`
        : "No pending requests were changed.",
      accessRequestError,
    };
    patchTemplatePendingRequestCount(state.selectedTemplateId, -changed);
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingAccessBulk: false,
      accessRequestError: error.message || "Could not update access requests.",
    };
  }
  renderAfter();
}

function patchTemplatePendingRequestCount(planId, delta) {
  if (!planId) return;
  state.lastTemplates = (state.lastTemplates || []).map((template) => {
    if (String(template.plan_id) !== String(planId)) return template;
    const pending = Math.max(0, Number(template.pending_access_count || 0) + delta);
    return { ...template, pending_access_count: pending };
  });
}

export async function submitTemplateMetadataForm(form, { loadTemplates }) {
  const planId = form.dataset.planId || "";
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({
        libraryScope: formData.get("libraryScope"),
        programStatus: formData.get("programStatus"),
        libraryCategory: formData.get("libraryCategory"),
        coverImageUrl: formData.get("coverImageUrl"),
        isFree: formData.get("isFree") === "true",
        priceCents: Math.round(Number(formData.get("price") || 0) * 100),
        availableUntil: formData.get("availableUntil"),
        ownerType: formData.get("ownerType"),
        visibility: formData.get("visibility"),
        accessModel: formData.get("accessModel"),
        accessDurationDays: formData.get("accessDurationDays"),
        subscriptionPeriod: formData.get("subscriptionPeriod"),
        canCopy: formData.get("canCopy") === "true",
        canEditCopy: formData.get("canEditCopy") === "true",
        canAssignToAthlete: formData.get("canAssignToAthlete") === "true",
        athleteCanViewDirectly: formData.get("athleteCanViewDirectly") === "true",
        requiresApproval: formData.get("requiresApproval") === "true",
      }),
    });
    state.templateFilters.lifecycle = "all";
    state.templatePreview = emptyTemplatePreview();
    state.selectedTemplateId = null;
    await loadTemplates();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save library settings.";
  } finally {
    if (button) button.disabled = false;
  }
}

export async function markTemplateUsed(planId, { renderTemplateLibrary }) {
  if (!planId || state.templatePreview.submittingUse) return;
  state.templatePreview = {
    ...state.templatePreview,
    submittingUse: true,
    reviewError: "",
    reviewMessage: "",
  };
  renderTemplateLibrary(state.lastTemplates);
  try {
    const response = await api(`/api/templates/${encodeURIComponent(planId)}/use`, {
      method: "POST",
      body: JSON.stringify({ note: "Marked as used from Program Library." }),
    });
    const access = response?.access || {};
    const accessStatus = clean(access.status).toLowerCase();
    const requested = accessStatus === "requested";
    const used = accessStatus === "used" || accessStatus === "completed";
    const approved = accessStatus === "accessed";
    updateTemplateAccess(planId, access);
    state.templatePreview = {
      ...state.templatePreview,
      submittingUse: false,
      requestSent: requested,
      usedMarked: used,
      reviewOpen: used,
      reviewMessage: requested
        ? "Request sent. Your coach can approve this program before it becomes active."
        : approved
          ? "Access approved. Mark it as used when you start working with this program."
          : "Access active. You can now leave a review after using this program.",
      reviewError: "",
    };
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingUse: false,
      reviewError: error.message || "Could not mark this program as used.",
      reviewMessage: "",
    };
  }
  renderTemplateLibrary(state.lastTemplates);
}

function updateTemplateAccess(planId, access) {
  const accessPatch = {
    user_access_status: access.status || "",
    user_access_type: access.access_type || "",
    user_access_used_at: access.used_at || null,
    user_access_expires_at: access.expires_at || null,
  };
  state.lastTemplates = (state.lastTemplates || []).map((template) => (
    String(template.plan_id) === String(planId) ? { ...template, ...accessPatch } : template
  ));
  if (String(state.templatePreview?.detail?.plan_id) === String(planId)) {
    state.templatePreview = {
      ...state.templatePreview,
      detail: { ...state.templatePreview.detail, ...accessPatch },
    };
  }
}

export async function submitTemplateReviewForm(form, { loadTemplates, renderTemplateLibrary }) {
  const planId = form.dataset.planId || "";
  if (!planId || state.templatePreview.submittingReview) return;
  const formData = new FormData(form);
  const rating = Number(formData.get("rating") || 0);
  const comment = clean(formData.get("comment"));
  state.templatePreview = {
    ...state.templatePreview,
    submittingReview: true,
    reviewError: "",
    reviewMessage: "",
  };
  renderTemplateLibrary(state.lastTemplates);
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/reviews`, {
      method: "POST",
      body: JSON.stringify({ rating, comment }),
    });
    const reviewsData = await api(`/api/templates/${encodeURIComponent(planId)}/reviews`);
    state.templatePreview = {
      ...state.templatePreview,
      submittingReview: false,
      reviewOpen: false,
      reviewsOpen: true,
      reviews: reviewsData.reviews || [],
      usedMarked: true,
      reviewMessage: "Review saved.",
      reviewError: "",
    };
    await loadTemplates();
  } catch (error) {
    state.templatePreview = {
      ...state.templatePreview,
      submittingReview: false,
      reviewError: error.message || "Could not save review.",
      reviewMessage: "",
    };
    renderTemplateLibrary(state.lastTemplates);
  }
}

export async function openProgramTagEditor(planId, programName, { renderTemplateLibrary, renderError }) {
  if (!planId) return;
  try {
    const data = await api(`/api/templates/${encodeURIComponent(planId)}/tags`);
    state.programTagEditor = {
      open: true,
      planId,
      programName,
      tags: data.tags || [],
      options: data.options || [],
      error: "",
    };
    renderTemplateLibrary(state.lastTemplates);
  } catch (error) {
    renderError(error);
  }
}

export function closeProgramTagEditor({ renderTemplateLibrary }) {
  state.programTagEditor = { open: false, planId: "", programName: "", tags: [], options: [], error: "" };
  renderTemplateLibrary(state.lastTemplates);
}

export async function submitProgramTagForm(form, { renderTemplateLibrary }) {
  const formData = new FormData(form);
  const planId = form.dataset.planId || state.programTagEditor.planId;
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/tags`, {
      method: "POST",
      body: JSON.stringify({
        tagId: formData.get("tagId"),
        name: formData.get("name"),
      }),
    });
    form.reset();
    await refreshProgramTags(planId, { renderTemplateLibrary });
  } catch (error) {
    state.programTagEditor = { ...state.programTagEditor, error: error.message || "Could not add tag.", planId };
    renderTemplateLibrary(state.lastTemplates);
  }
}

export async function removeProgramTag(planId, tagId, { renderTemplateLibrary }) {
  if (!planId || !tagId) return;
  await api(`/api/templates/${encodeURIComponent(planId)}/tags/${encodeURIComponent(tagId)}`, { method: "DELETE" });
  await refreshProgramTags(planId, { renderTemplateLibrary });
}

export async function refreshProgramTagEditor({ renderTemplateLibrary }) {
  await refreshProgramTags(state.programTagEditor.planId, { renderTemplateLibrary });
}

async function refreshProgramTags(planId, { renderTemplateLibrary }) {
  const data = await api(`/api/templates/${encodeURIComponent(planId)}/tags`);
  if (state.programTagEditor.open && String(state.programTagEditor.planId) === String(planId)) {
    state.programTagEditor = { ...state.programTagEditor, tags: data.tags || [], options: data.options || [], error: "" };
  }
  updateProgramTagsInCache(planId, data.tags || []);
  const options = await api("/api/templates/options");
  state.templateOptions = { ...options, loaded: true };
  renderTemplateLibrary(state.lastTemplates);
}

export async function addInlineProgramTag(planId, { renderTemplateLibrary }) {
  const escapedPlanId = window.CSS?.escape ? CSS.escape(String(planId)) : String(planId).replace(/"/g, '\\"');
  const input = document.querySelector(`[data-program-tag-input="${escapedPlanId}"]`);
  const name = clean(input?.value);
  if (!planId || !name) return;
  try {
    await api(`/api/templates/${encodeURIComponent(planId)}/tags`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (input) input.value = "";
    await refreshProgramTags(planId, { renderTemplateLibrary });
  } catch (error) {
    state.programTagEditor = { ...state.programTagEditor, error: error.message || "Could not add tag.", planId };
    renderTemplateLibrary(state.lastTemplates);
  }
}

function updateProgramTagsInCache(planId, tags) {
  state.lastTemplates.forEach((template) => {
    if (String(template.plan_id) === String(planId)) template.tags = tags;
  });
}
