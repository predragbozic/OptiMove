import { api } from "./api.js";
import { state } from "./state.js";

export async function loadCoaches({ setLoading, renderCoaches }) {
  state.navStack = [];
  setLoading("Loading coach profiles...");
  try {
    const data = await api("/api/coaches");
    state.coaches = { ...state.coaches, rows: data.coaches || [], error: "" };
  } catch (error) {
    state.coaches = { ...state.coaches, error: error.message || "Could not load coach profiles." };
  }
  renderCoaches();
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
        contactEmail: formData.get("contactEmail"),
        visibility: formData.get("visibility"),
        tags: formData.get("tags"),
        bio: formData.get("bio"),
        contactEnabled: formData.get("contactEnabled") === "on",
      }),
    });
    state.coaches.editOpen = false;
    await loadCoaches();
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
