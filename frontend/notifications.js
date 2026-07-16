import { api } from "./api.js";
import { els } from "./dom.js";
import { openMessageConversation } from "./messages.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export async function loadNotifications({ silent = false } = {}) {
  if (!state.currentUser) return;
  state.notifications.loading = !silent;
  try {
    const data = await api("/api/notifications");
    state.notifications.rows = data.notifications || [];
    state.notifications.unreadCount = data.unreadCount || 0;
    state.notifications.error = "";
  } catch (error) {
    state.notifications.error = error.message || "Could not load notifications.";
  } finally {
    state.notifications.loading = false;
    renderNotifications();
  }
}

export function renderNotifications() {
  if (!els.notificationToggle || !els.notificationPanel) return;
  const isSignedIn = Boolean(state.currentUser);
  els.notificationToggle.hidden = !isSignedIn;
  els.notificationPanel.hidden = !isSignedIn || !state.notifications.open;
  const count = els.notificationToggle.querySelector("[data-notification-count]");
  if (count) {
    count.textContent = String(state.notifications.unreadCount || 0);
    count.hidden = !state.notifications.unreadCount;
  }
  els.notificationPanel.innerHTML = renderNotificationPanelHtml();
}

export async function handleNotificationAction(action, handlers = {}) {
  const type = action?.dataset?.action || "";
  if (type === "notifications-toggle") {
    state.notifications.open = !state.notifications.open;
    if (state.notifications.open && state.messages) state.messages.open = false;
    if (state.notifications.open) await loadNotifications({ silent: true });
    else renderNotifications();
    return true;
  }
  if (type === "notifications-read-all") {
    await api("/api/notifications/read-all", { method: "POST", body: JSON.stringify({}) });
    state.notifications.rows = state.notifications.rows.map((row) => ({ ...row, read_at: row.read_at || new Date().toISOString() }));
    state.notifications.unreadCount = 0;
    renderNotifications();
    return true;
  }
  if (type === "notification-read") {
    const id = action.dataset.notificationId;
    if (!id) return true;
    await markNotificationRead(id);
    renderNotifications();
    return true;
  }
  if (type === "notification-open-program-requests") {
    const id = action.dataset.notificationId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    await handlers.openProgramRequests?.();
    return true;
  }
  if (type === "notification-accept-contact") {
    const requestId = action.dataset.requestId;
    const notificationId = action.dataset.notificationId;
    if (!requestId) return true;
    state.notifications.loading = true;
    renderNotifications();
    try {
      const data = await api(`/api/coaches/contact-requests/${encodeURIComponent(requestId)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "accepted" }),
      });
      if (notificationId) {
        await api(`/api/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", body: JSON.stringify({}) });
      }
      await loadNotifications({ silent: true });
      if (data.conversationId) await openMessageConversation(data.conversationId);
    } catch (error) {
      state.notifications.error = error.message || "Could not accept contact request.";
      renderNotifications();
    } finally {
      state.notifications.loading = false;
    }
    return true;
  }
  return false;
}

export function closeNotificationsIfOutside(target) {
  if (!state.notifications.open) return;
  if (target.closest(".notification-menu")) return;
  state.notifications.open = false;
  renderNotifications();
}

function renderNotificationPanelHtml() {
  if (!state.currentUser) return "";
  const rows = state.notifications.rows || [];
  const content = state.notifications.loading
    ? `<p class="empty-note">Loading notifications...</p>`
    : state.notifications.error
      ? `<p class="form-error">${escapeHtml(state.notifications.error)}</p>`
      : rows.length
        ? rows.map(renderNotificationRow).join("")
        : `<p class="empty-note">No notifications yet.</p>`;
  return `
    <div class="notification-panel-head">
      <strong>Notifications</strong>
      <button class="plain-button compact-button" data-action="notifications-read-all" type="button" ${state.notifications.unreadCount ? "" : "disabled"}>Mark all read</button>
    </div>
    <div class="notification-list">${content}</div>
  `;
}

function renderNotificationRow(row) {
  const unreadClass = row.read_at ? "" : " is-unread";
  const date = row.created_at ? new Date(row.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  const isCoachContact = row.type === "coach_contact_requested" && row.entity_type === "coach_contact_request" && row.entity_id;
  const isProgramAccessRequest = row.type === "program_access_requested" && row.entity_type === "program_access";
  const rowAction = isProgramAccessRequest ? "notification-open-program-requests" : "notification-read";
  return `
    <article class="notification-row${unreadClass}">
      <button class="notification-row-hit" data-action="${rowAction}" data-notification-id="${escapeAttr(row.id)}" type="button">
        <span>
          <strong>${escapeHtml(row.title || "Notification")}</strong>
          ${row.body ? `<small>${escapeHtml(row.body)}</small>` : ""}
          ${isProgramAccessRequest ? `<small class="notification-hint">Open requests</small>` : ""}
        </span>
        <time>${escapeHtml(date)}</time>
      </button>
      ${isCoachContact
        ? `<div class="notification-actions">
            <button class="plain-button compact-button" data-action="notification-accept-contact" data-request-id="${escapeAttr(row.entity_id)}" data-notification-id="${escapeAttr(row.id)}" type="button">Accept and open chat</button>
          </div>`
        : ""}
    </article>
  `;
}

async function markNotificationRead(id) {
  await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST", body: JSON.stringify({}) });
  const row = state.notifications.rows.find((item) => item.id === id);
  if (row && !row.read_at) {
    row.read_at = new Date().toISOString();
    state.notifications.unreadCount = Math.max(0, (state.notifications.unreadCount || 0) - 1);
  }
}
