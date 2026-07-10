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
    const [detail, reviewsData] = await Promise.all([
      api(`/api/plans/${encodeURIComponent(selected.plan_id)}/program`),
      api(`/api/templates/${encodeURIComponent(selected.plan_id)}/reviews`),
    ]);
    state.templatePreview = emptyTemplatePreview({
      ...state.templatePreview,
      open: true,
      loading: false,
      detail,
      reviews: reviewsData.reviews || [],
      error: "",
    });
  } catch (error) {
    state.templatePreview = emptyTemplatePreview({ ...state.templatePreview, open: true, loading: false, detail: null, error: error.message || "Could not load program." });
  }
  renderAfter();
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
    library_scope: program.library_scope || "coach",
    tags: program.tags || [],
  };
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
    await api(`/api/templates/${encodeURIComponent(planId)}/use`, {
      method: "POST",
      body: JSON.stringify({ note: "Marked as used from Program Library." }),
    });
    state.templatePreview = {
      ...state.templatePreview,
      submittingUse: false,
      usedMarked: true,
      reviewOpen: true,
      reviewMessage: "Access active. You can now leave a review after using this program.",
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
