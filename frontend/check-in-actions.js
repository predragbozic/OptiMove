// Public schedule check-in page (/tests/check-in/:publicToken) - a coach
// pastes this link into a WhatsApp/Viber group chat. Mirrors join-actions.js's
// "public page, log in inline, then show the real content" shape: rendered
// directly into els.content (bypassing the normal app shell/tab navigation,
// same as renderJoinPage), reachable before loadSession() runs at all (see
// the pathname bypass in app.js's init()). The link itself never grants
// access - only a logged-in athlete session resolved against a real
// tests.test_assignments row does (backend/src/routes/testsCheckIn.js).
import { api } from "./api.js";
import { els } from "./dom.js";
import { emptyCheckInState, state } from "./state.js";
import { formFromAssignmentDetail, loadPendingCount } from "./tests-data.js";
import { renderTestsBadge, renderWellnessFormHtml } from "./tests-view.js";
import { escapeHtml } from "./utils.js";

function tokenFromPath() {
  const match = window.location.pathname.match(/^\/tests\/check-in\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function renderCheckInPage({ renderUserControls, setStatus }) {
  document.body.classList.add("login-mode");
  setStatus("Check-in");
  els.context.textContent = "OptiMove";
  els.title.textContent = "Check-in";
  els.toolbar.innerHTML = "";
  state.currentUser = null;
  renderUserControls();
  const token = tokenFromPath();
  state.checkIn = emptyCheckInState({ token, loading: true });
  renderCheckInContent();
  try {
    const info = await api(`/api/tests/check-in/${encodeURIComponent(token)}`);
    state.checkIn.testName = info.testName;
    state.checkIn.needsLogin = Boolean(info.requiresLogin);
    if (!state.checkIn.needsLogin) await resolveAssignment();
  } catch (error) {
    state.checkIn.error = error.message || "This check-in link is invalid or no longer available.";
  } finally {
    state.checkIn.loading = false;
    renderCheckInContent();
  }
}

async function resolveAssignment() {
  const data = await api(`/api/tests/check-in/${encodeURIComponent(state.checkIn.token)}/my-assignment`);
  if (!data.assignment) {
    state.checkIn.message = data.message || "There is nothing to check in right now.";
    return;
  }
  state.checkIn.form = formFromAssignmentDetail(data);
}

export function renderCheckInContent() {
  const checkIn = state.checkIn;
  if (checkIn.loading) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Loading...</h3></div></section>`;
    return;
  }
  if (checkIn.error) {
    els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>Check-in link is not valid</h3><p class="login-error">${escapeHtml(checkIn.error)}</p></div></section>`;
    return;
  }
  if (checkIn.needsLogin) {
    els.content.innerHTML = `
      <section class="login-panel">
        <form class="login-form" id="checkInLoginForm">
          <div>
            <p class="eyebrow">${escapeHtml(checkIn.testName || "Check-in")}</p>
            <h3>Log in to check in</h3>
          </div>
          <label class="search-field"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
          <label class="search-field"><span>Password</span><input name="password" type="password" required autocomplete="current-password"></label>
          <p class="login-error" aria-live="polite">${escapeHtml(checkIn.loginError)}</p>
          <button class="plain-button" type="submit" ${checkIn.loginPending ? "disabled" : ""}>${checkIn.loginPending ? "Logging in..." : "Log in"}</button>
        </form>
      </section>
    `;
    return;
  }
  if (checkIn.form) {
    els.content.innerHTML = `<div class="wellness-shell">${renderWellnessFormHtml(checkIn.form)}</div>`;
    return;
  }
  els.content.innerHTML = `<section class="login-panel"><div class="login-form"><h3>${escapeHtml(checkIn.testName || "Check-in")}</h3><p class="muted">${escapeHtml(checkIn.message || "Nothing to check in right now.")}</p></div></section>`;
}

export async function submitCheckInLogin(form) {
  const formData = new FormData(form);
  state.checkIn.loginPending = true;
  state.checkIn.loginError = "";
  renderCheckInContent();
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: String(formData.get("email") || ""), password: String(formData.get("password") || "") }),
    });
    state.checkIn.needsLogin = false;
    await resolveAssignment();
    void loadPendingCount().then(renderTestsBadge);
  } catch (error) {
    state.checkIn.loginError = error.message || "Could not log in.";
  } finally {
    state.checkIn.loginPending = false;
    renderCheckInContent();
  }
}
