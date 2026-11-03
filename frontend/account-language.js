import { escapeAttr } from "./utils.js";

// Account -> Exercise language (owner, 2026-11-03), on the coach's and the
// athlete's Account page alike. It sets only the caller's own account
// (PUT /api/auth/me/content-language) and decides the language of exercise
// names and instructions (exercise-text.js), never of the interface.
const LANGUAGES = [["sr", "Srpski"], ["en", "English"]];

// Where the choice shows today: the screens that read the exercise itself.
// An exercise already added to a program keeps the name it was added with.
export const CONTENT_LANGUAGE_SCOPE = "The Exercise Library, an exercise's details, the Builder's exercise list and Home show the English name and instruction where an exercise has one. Exercises already added to programs keep their names.";

export function renderContentLanguageOptions(language) {
  const current = language === "en" ? "en" : "sr";
  return LANGUAGES.map(([value, label]) => `<option value="${escapeAttr(value)}"${value === current ? " selected" : ""}>${label}</option>`).join("");
}

export function renderContentLanguageSectionHtml(currentUser) {
  return `
    <section class="panel athlete-settings-card">
      <div>
        <p class="eyebrow">Account</p>
        <h3>Exercise language</h3>
        <p class="muted">${CONTENT_LANGUAGE_SCOPE}</p>
      </div>
      <form class="organization-form" data-account-form="content-language">
        <label class="search-field"><span>Exercise language</span>
          <select class="builder-text-input" name="contentLanguage">
            ${renderContentLanguageOptions(currentUser?.contentLanguage)}
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
      ? "Saved: English. The Exercise Library, the Builder's exercise list and Home show it where an exercise has an English text."
      : "Saved: Srpski.";
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not save the exercise language.";
  } finally {
    if (button) button.disabled = false;
  }
}
