import { api } from "./api.js";
import { canManageCoachProfile, currentUserWorkspaceContextParts } from "./access.js";
import { openTemplatePreviewFromCoachProgram } from "./program-library-actions.js";
import { state } from "./state.js";
import { buildContextKey, invalidateCacheNamespace, loadCachedView } from "./view-cache.js";

const COACHES_CACHE_NAMESPACE = "coaches";

// The coach directory (/api/coaches) is filtered per-viewer and per-workspace
// (see canUseClubProfiles/canBypassCoachVisibility in
// backend/src/routes/coaches.js) - no other filters/search apply to this
// list, so the account+workspace part alone is the full context key.
function coachesContextKey() {
  return buildContextKey(currentUserWorkspaceContextParts());
}

export function invalidateCoachesCache() {
  invalidateCacheNamespace(COACHES_CACHE_NAMESPACE);
}

export async function loadCoaches({ setLoading, renderCoaches, forceRefresh = false } = {}) {
  state.navStack = [];
  const contextKey = coachesContextKey();
  await loadCachedView({
    namespace: COACHES_CACHE_NAMESPACE,
    contextKey,
    forceRefresh,
    fetcher: () => api("/api/coaches"),
    showLoading: () => setLoading("Loading coach profiles..."),
    applyData: (data) => {
      state.coaches = { ...state.coaches, rows: data.coaches || [], error: "" };
      renderCoaches();
    },
    applyError: (error) => {
      state.coaches = { ...state.coaches, error: error.message || "Could not load coach profiles." };
      renderCoaches();
    },
    getCurrentContextKey: coachesContextKey,
  });
}

export async function openCoachProfile(profileId, { renderCoachContext }) {
  if (!profileId) return;
  state.coaches = { ...state.coaches, selected: profileId, detail: null, editOpen: false, contactOpen: false, error: "" };
  renderCoachContext();
  try {
    const detail = await api(`/api/coaches/${encodeURIComponent(profileId)}`);
    state.coaches = { ...state.coaches, detail, error: "" };
  } catch (error) {
    state.coaches = { ...state.coaches, error: error.message || "Could not load coach profile." };
  }
  renderCoachContext();
}

export function handleCoachProfileAction(action, { renderCoachContext, renderCurrentNode }) {
  const type = action.dataset.action;
  if (type === "coach-program-open") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program?.plan_id) {
      state.coaches = { ...state.coaches, selected: null, detail: null, contactOpen: false, error: "" };
      void openTemplatePreviewFromCoachProgram(program, renderCurrentNode);
    }
    return true;
  }
  if (type === "coach-program-info") {
    const program = (state.coaches.detail?.programs || []).find((row) => String(row.plan_id) === String(action.dataset.templateId));
    if (program) {
      state.programInfo = { open: true, program };
      renderCoachContext();
    }
    return true;
  }
  if (type === "coach-programs-focus") {
    const section = document.querySelector("[data-coach-programs]");
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
    return true;
  }
  if (type === "coach-open") {
    void openCoachProfile(action.dataset.profileId, { renderCoachContext });
    return true;
  }
  if (type === "coach-close") {
    state.coaches = { ...state.coaches, selected: null, detail: null, editOpen: false, contactOpen: false, error: "" };
    renderCoachContext();
    return true;
  }
  if (type === "coach-edit-toggle") {
    if (!canManageCoachProfile()) return true;
    state.coaches.editOpen = !state.coaches.editOpen;
    renderCoachContext();
    return true;
  }
  if (type === "coach-contact-toggle") {
    state.coaches.contactOpen = !state.coaches.contactOpen;
    renderCoachContext();
    return true;
  }
  return false;
}

export async function submitCoachProfileForm(form, { loadCoaches }) {
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api("/api/coaches/me", {
      method: "PATCH",
      body: JSON.stringify({
        headline: formData.get("headline"),
        specialties: formData.get("specialties"),
        photoUrl: formData.get("photoUrl"),
        coverImageUrl: formData.get("coverImageUrl"),
        videoUrl: formData.get("videoUrl"),
        contactEmail: formData.get("contactEmail"),
        visibility: formData.get("visibility"),
        tags: formData.get("tags"),
        bio: formData.get("bio"),
        contactEnabled: formData.get("contactEnabled") === "on",
      }),
    });
    state.coaches.editOpen = false;
    // The account just changed its own coach profile - the cached directory
    // list must never keep showing the pre-edit version, so force a real
    // refetch rather than trusting whatever was cached moments ago.
    await loadCoaches({ forceRefresh: true });
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save profile.";
  } finally {
    if (button) button.disabled = false;
  }
}

export async function submitCoachContactForm(form, { renderCoachContext }) {
  const profileId = form.dataset.profileId || "";
  const error = form.querySelector(".builder-error");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  const formData = new FormData(form);
  try {
    await api(`/api/coaches/${encodeURIComponent(profileId)}/contact`, {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        email: formData.get("email"),
        message: formData.get("message"),
      }),
    });
    state.coaches.contactOpen = false;
    state.coaches.error = "Contact request sent.";
    renderCoachContext();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not send request.";
  } finally {
    if (button) button.disabled = false;
  }
}
