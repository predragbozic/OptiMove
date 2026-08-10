import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Public /confirm-email-change?token=... page (security/verified-email-
// change) - mirrors password-reset-actions.js's shape exactly: a render*
// function owns els.content.innerHTML, a submit* function is wired by
// app.js's handleContentSubmit into the form's id. The account's
// users.email is never changed until this page's own confirm button is
// pressed and the backend re-verifies the token/address - loading this
// page, or even just GETting the token's validity, never mutates anything.

export async function renderConfirmEmailChange({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Confirm email change");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Confirm email change";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    renderConfirmInvalid();
    return;
  }
  try {
    // Read-only check (GET /api/auth/email-changes/:token never consumes
    // the token) purely so an already-invalid/expired link shows the right
    // message immediately instead of only failing once the button is
    // pressed.
    const data = await api(`/api/auth/email-changes/${encodeURIComponent(token)}`);
    if (!data.valid) {
      renderConfirmInvalid();
      return;
    }
    renderConfirmForm(token, data.newEmail);
  } catch {
    renderConfirmInvalid();
  }
}

function renderConfirmInvalid() {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form">
        <div><p class="eyebrow">Email change</p><h3>This link is invalid or has expired</h3></div>
        <p class="muted">Your login email has not changed. Sign in and request a new confirmation link from Settings.</p>
        <p class="muted"><a href="/">Back to sign in</a></p>
      </div>
    </section>
  `;
}

function renderConfirmForm(token, newEmail) {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form" id="confirmEmailChangeForm" data-token="${escapeAttr(token)}">
        <div>
          <p class="eyebrow">Email change</p>
          <h3>Confirm your new login email</h3>
        </div>
        <p class="muted">Confirming will change your login email to <strong>${escapeHtml(newEmail || "")}</strong>. Your password stays the same - sign in with it and this new address afterward.</p>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="button" data-action="confirm-email-change">Confirm email change</button>
      </div>
    </section>
  `;
}

function renderConfirmSuccess(newEmail) {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form">
        <div><p class="eyebrow">Email change</p><h3>Login email changed</h3></div>
        <p class="muted">Your login email is now <strong>${escapeHtml(newEmail || "")}</strong>. You've been signed out everywhere else - sign in again with your password.</p>
        <a class="plain-button" href="/">Back to sign in</a>
      </div>
    </section>
  `;
}

export async function submitConfirmEmailChange(action) {
  const container = action.closest("#confirmEmailChangeForm");
  const error = container?.querySelector(".login-error");
  if (action.disabled) return;
  const token = container?.dataset.token || "";
  const newEmail = container?.querySelector("strong")?.textContent || "";
  if (error) error.textContent = "";
  action.disabled = true;
  try {
    await api(`/api/auth/email-changes/${encodeURIComponent(token)}/confirm`, { method: "POST" });
    // The raw token has now been consumed server-side (single use) - strip
    // it out of the URL immediately so it never lingers in browser
    // history/bookmarks pointing at an already-dead link.
    window.history.replaceState({}, "", "/confirm-email-change");
    renderConfirmSuccess(newEmail);
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not confirm this email change. The link may be invalid or expired.";
    action.disabled = false;
  }
}
