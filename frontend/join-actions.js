import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

// Public /join?token=... page (feature/group-athlete-join-links) - a
// separate flow from /invite (auth-actions.js). A join link is not
// addressed to any one person: the default form is for someone with no
// existing OptiMove account; submitting with an email that already has one
// switches to a login form instead, exactly mirroring how the invite-accept
// flow handles that same collision.

export async function renderJoinPage({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Join request");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Join";
  els.athleteList.innerHTML = "";
  els.athleteSearch.value = "";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = new URLSearchParams(window.location.search).get("token") || "";
  if (!token) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Join link is missing</h3><p class="muted">Ask your coach or club for a new join link.</p></div></section>`;
    return;
  }
  try {
    const data = await api(`/api/auth/join-links/${encodeURIComponent(token)}`);
    const link = data.link || {};
    els.content.innerHTML = `
      <section class="login-panel">
        <form class="login-form invite-form" id="joinApplyForm" data-token="${escapeAttr(token)}">
          <div>
            <p class="eyebrow">${escapeHtml(joinContextEyebrow(link.contextType))}</p>
            <h3>${escapeHtml(link.label || "Join OptiMove")}</h3>
            <p class="muted">${escapeHtml(link.contextName || "")}</p>
          </div>
          <label class="search-field"><span>First name</span><input name="firstName" required autocomplete="given-name"></label>
          <label class="search-field"><span>Last name</span><input name="lastName" autocomplete="family-name"></label>
          <label class="search-field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
          <label class="search-field"><span>Password</span><input name="password" type="password" autocomplete="new-password" required minlength="8" placeholder="At least 8 characters"></label>
          <p class="muted">Your request will be reviewed before access is activated.</p>
          <p class="login-error" aria-live="polite"></p>
          <button class="plain-button" type="submit">Submit join request</button>
        </form>
      </section>
    `;
  } catch (error) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Join link is not valid</h3><p class="login-error">${escapeHtml(error.message || "This join link is invalid or no longer available.")}</p></div></section>`;
  }
}

function joinContextEyebrow(contextType) {
  if (contextType === "private_coach") return "Private coaching";
  if (contextType === "club") return "Club";
  if (contextType === "team") return "Team";
  return "Join request";
}

export async function submitJoinApply(form) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const token = form.dataset.token || "";
  const email = String(formData.get("email") || "");
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/auth/join-links/${encodeURIComponent(token)}/apply`, {
      method: "POST",
      body: JSON.stringify({
        firstName: String(formData.get("firstName") || ""),
        lastName: String(formData.get("lastName") || ""),
        email,
        password: String(formData.get("password") || ""),
      }),
    });
    renderJoinPending(data.statusToken);
  } catch (submitError) {
    if (submitError.requiresLogin) {
      renderJoinLoginRequired(token, email);
      return;
    }
    if (error) error.textContent = submitError.message || "Could not submit this request.";
  } finally {
    if (button) button.disabled = false;
  }
}

// Shown when the applicant's email already belongs to an existing account:
// the public form can no longer set a password on it (see backend), so the
// only safe way forward is logging in with the existing password and
// letting the authenticated /apply-existing submit the request instead.
function renderJoinLoginRequired(token, email) {
  els.content.innerHTML = `
    <section class="login-panel">
      <form class="login-form invite-form" id="joinLoginForm" data-token="${escapeAttr(token)}">
        <div>
          <p class="eyebrow">Join request</p>
          <h3>Log in to submit this request</h3>
          <p class="muted">An account with this email already exists. Log in with its existing password - this request will then be submitted from that account, without changing its password.</p>
        </div>
        <label class="search-field"><span>Email</span><input value="${escapeAttr(email)}" readonly></label>
        <label class="search-field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required placeholder="Your existing password"></label>
        <p class="login-error" aria-live="polite"></p>
        <button class="plain-button" type="submit">Log in and submit request</button>
      </form>
    </section>
  `;
}

export async function submitJoinLogin(form) {
  const error = form.querySelector(".login-error");
  const button = form.querySelector("button[type='submit']");
  const formData = new FormData(form);
  const email = form.querySelector("input[readonly]")?.value || "";
  const password = String(formData.get("password") || "");
  const token = form.dataset.token || "";
  if (error) error.textContent = "";
  if (button) button.disabled = true;
  try {
    await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    try {
      const data = await api(`/api/auth/join-links/${encodeURIComponent(token)}/apply-existing`, { method: "POST" });
      renderJoinPending(data.statusToken);
    } catch (applyError) {
      if (error) error.textContent = applyError.message || "Logged in, but could not submit this request.";
    }
  } catch (loginError) {
    if (error) error.textContent = loginError.message || "Could not log in.";
  } finally {
    if (button) button.disabled = false;
  }
}

async function renderJoinPending(statusToken) {
  // The status token is only ever kept in memory long enough to show this
  // one confirmation screen - never written to storage, analytics, or logs.
  let statusHtml = `<p class="muted">Your request will be reviewed before access is activated.</p>`;
  if (statusToken) {
    try {
      const data = await api(`/api/auth/join-applications/${encodeURIComponent(statusToken)}`);
      const application = data.application || {};
      statusHtml = `
        <p class="muted">Status: <strong>${escapeHtml(joinStatusLabel(application.status))}</strong></p>
        <p class="muted">${escapeHtml(application.contextLabel || "")}</p>
        ${application.status === "rejected" && application.rejectionReason ? `<p class="muted">${escapeHtml(application.rejectionReason)}</p>` : ""}
      `;
    } catch {
      // Falls back to the generic pending message above.
    }
  }
  els.content.innerHTML = `
    <section class="login-panel">
      <div class="login-form invite-form">
        <div><p class="eyebrow">Join request submitted</p><h3>Thanks - you're on the list</h3></div>
        ${statusHtml}
      </div>
    </section>
  `;
}

function joinStatusLabel(status) {
  return { pending: "Pending review", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", requires_login: "Needs login" }[status] || status;
}
