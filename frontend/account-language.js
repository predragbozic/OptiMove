import { escapeAttr } from "./utils.js";

// Account -> Exercise language (owner, 2026-11-03), on the coach's and the
// athlete's Account page alike. It sets only the caller's own account
// (PUT /api/auth/me/content-language) and decides the language of exercise
// names and instructions (exercise-text.js), never of the interface.
const LANGUAGES = [["sr", "Srpski"], ["en", "English"]];

export function renderContentLanguageSectionHtml(currentUser) {
  const current = currentUser?.contentLanguage === "en" ? "en" : "sr";
  return `
    <section class="panel athlete-settings-card">
      <div>
        <p class="eyebrow">Account</p>
        <h3>Exercise language</h3>
        <p class="muted">Exercise names and instructions are shown in this language. An exercise without an English text stays in Serbian.</p>
      </div>
      <form class="organization-form" data-account-form="content-language">
        <label class="search-field"><span>Exercise language</span>
          <select class="builder-text-input" name="contentLanguage">
            ${LANGUAGES.map(([value, label]) => `<option value="${escapeAttr(value)}"${value === current ? " selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <p class="builder-error" aria-live="polite"></p>
        <p class="builder-success" aria-live="polite"></p>
        <button class="plain-button" type="submit">Save language</button>
      </form>
    </section>
  `;
}

// The form's submit: saves the choice, then keeps it on the signed-in user,
// so the next screen that shows an exercise reads it. Nothing is changed in
// state when the server refuses.
export async function saveContentLanguage(form, { api, currentUser }) {
  const error = form.querySelector(".builder-error");
  const success = form.querySelector(".builder-success");
  const button = form.querySelector("button[type='submit']");
  if (error) error.textContent = "";
  if (success) success.textContent = "";
  const contentLanguage = String(form.querySelector("select[name='contentLanguage']")?.value || "");
  if (button) button.disabled = true;
  try {
    const saved = await api("/api/auth/me/content-language", {
      method: "PUT",
      body: JSON.stringify({ contentLanguage }),
    });
    if (currentUser) currentUser.contentLanguage = saved.contentLanguage === "en" ? "en" : "sr";
    if (success) success.textContent = saved.contentLanguage === "en"
      ? "Saved. Exercises are shown in English where they have an English text."
      : "Saved. Exercises are shown in Serbian.";
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save the exercise language.";
  } finally {
    if (button) button.disabled = false;
  }
}
