import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr } from "./utils.js";

// Public /forgot-password and /reset-password?token=... pages
// (security/password-recovery) - same markup classes (login-panel/
// login-form/login-error/login-success) the existing login/invite/verify-
// email pages already use, deliberately not a new visual design (see
// styles.html/styles.css - nothing added here). Mirrors
// auth-actions.js/email-verification-actions.js's shape: a render*
// function owns els.content.innerHTML, a submit* function is wired by
// app.js's handleContentSubmit into the form's id.

export function renderForgotPassword({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Forgot password");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Forgot password";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form" id="forgotPasswordForm">
        <div>
          <p class="eyebrow">Account</p>
          <h3>Reset your password</h3>
          <p class="muted">Enter your account email and, if it has an active account, we'll send a link to set a new password.</p>
        </div>
        <label class="search-field">
          <span>Email</span>
          <input name="email" type="email" autocomplete="username" required>
        </label>
        <p class="login-success" aria-live="polite"></p>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="submit">Send reset link</button>
        <p class="muted"><a href="/">Back to sign in</a></p>
      </form>
    </section>
  `;
}

// Always shows the exact same generic message the backend itself always
// returns (see POST /api/auth/password/forgot) - never anything that could
// imply whether the typed email has an account, active or not.
export async function submitForgotPassword(form) {
  const success = form.querySelector(".login-success");
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  if (button?.disabled) return;
  const formData = new FormData(form);
  const email = String(formData.get("email") || "");
  if (success) success.textContent = "";
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  try {
    const data = await api("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ email }) });
    if (success) success.textContent = data.message || "If an active account exists for that email, we've sent password reset instructions.";
  } catch {
    // The backend only ever returns 200 for this endpoint - only a genuine
    // network failure reaches here. Still generic wording, never anything
    // account-specific.
    if (error) error.textContent = "Could not send the reset email right now. Please try again.";
  } finally {
    if (button) button.disabled = false;
  }
}

export async function renderResetPassword({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Reset password");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Reset password";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    renderResetInvalid();
    return;
  }
  try {
    // Read-only check (GET /api/auth/password/reset/:token never consumes
    // the token) purely so an already-invalid/expired link shows the right
    // message immediately instead of only failing once the form is
    // submitted.
    const data = await api(`/api/auth/password/reset/${encodeURIComponent(token)}`);
    if (!data.valid) {
      renderResetInvalid();
      return;
    }
    renderResetForm(token);
  } catch {
    renderResetInvalid();
  }
}

function renderResetInvalid() {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form">
        <div><p class="eyebrow">Password reset</p><h3>This link is invalid or has expired</h3></div>
        <p class="muted">Request a new password reset link below.</p>
        <p class="muted"><a href="/forgot-password">Forgot password?</a></p>
        <p class="muted"><a href="/">Back to sign in</a></p>
      </div>
    </section>
  `;
}

function renderResetForm(token) {
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form" id="resetPasswordForm" data-token="${escapeAttr(token)}">
        <div>
          <p class="eyebrow">Password reset</p>
          <h3>Set a new password</h3>
        </div>
        <label class="search-field">
          <span>New password</span>
          <input name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
        </label>
        <label class="search-field">
          <span>Confirm new password</span>
          <input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
        </label>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="submit">Set new password</button>
      </form>
    </section>
  `;
}

function renderResetSuccess() {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form">
        <div><p class="eyebrow">Password reset</p><h3>Password updated</h3></div>
        <p class="muted">Your password has been changed. Sign in with your new password.</p>
        <a class="plain-button" href="/">Back to sign in</a>
      </div>
    </section>
  `;
}

export async function submitResetPassword(form) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  if (button?.disabled) return;
  const formData = new FormData(form);
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");
  const token = form.dataset.token || "";
  if (error) error.textContent = "";
  if (password !== confirmPassword) {
    if (error) error.textContent = "Passwords do not match.";
    return;
  }
  if (button) button.disabled = true;
  try {
    await api(`/api/auth/password/reset/${encodeURIComponent(token)}`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    // The raw token has now been consumed server-side (single use) - strip
    // it out of the URL immediately so it never lingers in browser
    // history/bookmarks pointing at an already-dead link. Never stored in
    // localStorage/sessionStorage at any point in this flow, and never sent
    // anywhere except this one API call.
    window.history.replaceState({}, "", "/reset-password");
    renderResetSuccess();
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not reset your password. This link may be invalid or expired.";
  } finally {
    if (button) button.disabled = false;
  }
}
