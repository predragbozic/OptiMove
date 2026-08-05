import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

// Public /verify-email?token=... page (feature/email-verification-
// foundation) - confirms a brand-new-email athlete_join_applications row's
// email ownership. Reuses the confirm attempt as the whole render: there is
// no separate "click to confirm" step, matching how a typical email
// verification link works (the click IS the confirmation).

export async function renderVerifyEmailPage({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Verify email");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Verify email";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    renderVerifyResult({ title: "Verification link is missing", message: "Ask for a new confirmation email below.", showResendForm: true });
    return;
  }
  try {
    await api(`/api/auth/email-verifications/${encodeURIComponent(token)}/confirm`, { method: "POST" });
    renderVerifyResult({
      title: "Email verified",
      message: "Thanks - your email is confirmed. A coach or admin will review your request next.",
      showResendForm: false,
    });
  } catch (error) {
    if (error.message === "EMAIL_NOW_EXISTS_REQUIRES_LOGIN") {
      renderVerifyResult({
        title: "Log in with your existing account",
        message: "An account with this email already exists. Log in with its existing password, then submit your join request from that account.",
        showResendForm: false,
      });
      return;
    }
    // Invalid/expired/consumed/revoked all collapse to the exact same
    // generic message here too, mirroring the backend's own generic
    // response - a link can never be used to probe why it stopped working.
    renderVerifyResult({
      title: "This link is invalid or has expired",
      message: "Request a new confirmation email below.",
      showResendForm: true,
    });
  }
}

function renderVerifyResult({ title, message, showResendForm }) {
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form invite-form">
        <div><p class="eyebrow">Email verification</p><h3>${escapeHtml(title)}</h3></div>
        <p class="muted">${escapeHtml(message)}</p>
        ${showResendForm ? `
          <form id="resendVerificationForm">
            <label class="search-field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
            <p class="login-success" aria-live="polite"></p>
            <p class="login-error" aria-live="polite"></p>
            <button class="plain-button" type="submit">Send new confirmation email</button>
          </form>
        ` : ""}
      </div>
    </section>
  `;
}

// Shared by both resend forms - the one shown right after a brand-new apply
// (frontend/join-actions.js's "Check your email" screen, where the email is
// already known and carried via form.dataset.email) and the one shown here
// on an invalid/expired verification link (where the visitor has to type
// it, since an invalid token reveals nothing). Always surfaces the exact
// same generic response the backend returns, regardless of what actually
// happened - this endpoint must never be usable to probe whether a given
// email has a pending request.
export async function submitResendVerification(form) {
  const success = form.querySelector(".login-success");
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  const email = form.dataset.email || form.querySelector("input[name='email']")?.value || "";
  if (success) success.textContent = "";
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  try {
    const data = await api("/api/auth/email-verifications/resend", { method: "POST", body: JSON.stringify({ email }) });
    if (success) success.textContent = data.message || "If a pending request needs email verification, a new link has been sent.";
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not resend. Please try again.";
  } finally {
    if (button) button.disabled = false;
  }
}
