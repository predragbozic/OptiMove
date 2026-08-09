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
        <p class="muted"><a href="/forgot-password">Forgot password?</a></p>
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

export async function submitInviteAccept(form, { loadSession } = {}) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
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
    const data = await api(`/api/auth/invites/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    state.currentUser = data.user;
    // /invites/:token/accept only returns the compatible base user shape -
    // reload the full /me shape (activeWorkspace) before deciding which
    // shell to land in.
    await loadSession?.();
    window.location.replace(state.currentUser?.activeWorkspace?.type === "athlete" ? "/athlete" : "/");
  } catch (submitError) {
    if (submitError.requiresLogin) {
      const email = form.querySelector("input[readonly]")?.value || "";
      renderInviteRequiresLogin(token, email);
      return;
    }
    if (error) error.textContent = submitError.message || "Could not activate account.";
  } finally {
    if (button) button.disabled = false;
  }
}

// Shown when the invite's email already belongs to an existing account: the
// public accept form can no longer set a password on it (see backend), so
// the only safe way forward is logging in with the existing password and
// letting the authenticated /link endpoint attach this athlete profile.
function renderInviteRequiresLogin(token, email) {
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form invite-form" id="inviteLoginForm" data-token="${escapeAttr(token)}">
        <div>
          <p class="eyebrow">Athlete access</p>
          <h3>Log in to accept this invite</h3>
          <p class="muted">An account with this email already exists. Log in with its existing password - this invite will then be linked to that account, without changing its password.</p>
        </div>
        <label class="search-field">
          <span>Email</span>
          <input value="${escapeAttr(email)}" readonly>
        </label>
        <label class="search-field">
          <span>Password</span>
          <input name="password" type="password" autocomplete="current-password" required placeholder="Your existing password">
        </label>
        <p class="login-error" aria-live="polite"></p>
        <p class="login-success" aria-live="polite"></p>
        <button class="plain-button" type="submit">Log in and accept invite</button>
      </form>
    </section>
  `;
}

export async function submitInviteLogin(form, { loadSession } = {}) {
  const error = form.querySelector(".login-error");
  const success = form.querySelector(".login-success");
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const email = form.querySelector("input[readonly]")?.value || "";
  const password = String(formData.get("password") || "");
  const token = form.dataset.token || "";
  if (error) error.textContent = "";
  if (success) success.textContent = "";
  if (button) button.disabled = true;
  try {
    const loginData = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    state.currentUser = loginData.user;
    try {
      await api(`/api/auth/invites/${encodeURIComponent(token)}/link`, { method: "POST" });
      // /login only returns the compatible base user shape - reload the
      // full /me shape (activeWorkspace) before deciding which shell to
      // land in.
      await loadSession?.();
      window.location.replace(state.currentUser?.activeWorkspace?.type === "athlete" ? "/athlete" : "/");
    } catch (linkError) {
      if (success) success.textContent = "Logged in, but the invite could not be linked.";
      if (error) error.textContent = linkError.message || "Could not link this invite to your account.";
    }
  } catch (loginError) {
    if (error) error.textContent = loginError.message || "Could not log in.";
  } finally {
    if (button) button.disabled = false;
  }
}
