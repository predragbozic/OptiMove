import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export function renderLogin({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Sign in");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Sign in";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  renderUserControls();
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form" id="loginForm">
        <div>
          <p class="eyebrow">Account</p>
          <h3>Sign in to OptiMove</h3>
        </div>
        <label class="search-field">
          <span>Email</span>
          <input name="email" type="email" autocomplete="username" required>
        </label>
        <label class="search-field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="submit">Sign in</button>
      </form>
    </section>
  `;
}

export async function renderInviteAccept({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Invite");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Activate account";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Invite link is missing</h3><p class="muted">Ask your coach to send a new invite link.</p></div></section>`;
    return;
  }
  try {
    const data = await api(`/api/auth/invites/${encodeURIComponent(token)}`);
    const invite = data.invite || {};
    els.content.innerHTML = `
      <section class="login-panel">
        <form class="login-form invite-form" id="inviteAcceptForm" data-token="${escapeAttr(token)}">
          <div>
            <p class="eyebrow">Athlete access</p>
            <h3>Activate OptiMove account</h3>
            <p class="muted">${escapeHtml(invite.athlete_name || "Athlete")} ${invite.athlete_code ? `- ID ${escapeHtml(invite.athlete_code)}` : ""}</p>
          </div>
          <label class="search-field">
            <span>Email</span>
            <input value="${escapeAttr(invite.email || "")}" readonly>
          </label>
          <label class="search-field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters">
          </label>
          <label class="search-field">
            <span>Confirm password</span>
            <input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8">
          </label>
          <p class="login-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Activate account</button>
        </form>
      </section>
    `;
  } catch (error) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Invite is not valid</h3><p class="login-error">${escapeHtml(error.message || "This invite has expired.")}</p></div></section>`;
  }
}

export async function submitInviteAccept(form) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const password = String(formData.get("password") || "");
  const confirmPassword = String(formData.get("confirmPassword") || "");
  if (error) error.textContent = "";
  if (password !== confirmPassword) {
    if (error) error.textContent = "Passwords do not match.";
    return;
  }
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/auth/invites/${encodeURIComponent(form.dataset.token || "")}/accept`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.currentUser = data.user;
    window.location.replace(state.currentUser?.role === "athlete" ? "/athlete" : "/");
  } catch (submitError) {
    if (error) error.textContent = submitError.message || "Could not activate account.";
  } finally {
    if (button) button.disabled = false;
  }
}
