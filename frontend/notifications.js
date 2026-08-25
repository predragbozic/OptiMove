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
  if (type === "notification-open-conversation") {
    const id = action.dataset.notificationId;
    const conversationId = action.dataset.conversationId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    if (conversationId) await openMessageConversation(conversationId);
    return true;
  }
  // WELLNESS invitation/reminder (athlete side) - deep-links straight to the
  // athlete's OWN assignment, never anyone else's (assignmentId comes from
  // this exact notification row, which the worker only ever wrote for its
  // real recipient - see testsNotificationWorker.js).
  if (type === "notification-open-test-assignment") {
    const id = action.dataset.notificationId;
    const assignmentId = action.dataset.assignmentId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    if (assignmentId) await handlers.openTestAssignment?.(assignmentId);
    return true;
  }
  // Coach live digest - opens Tests -> Today (coach side).
  if (type === "notification-open-tests-today") {
    const id = action.dataset.notificationId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    await handlers.openTestsToday?.();
    return true;
  }
  // Final coach digest - opens Tests -> Results (coach side).
  if (type === "notification-open-tests-results") {
    const id = action.dataset.notificationId;
    const scheduleId = action.dataset.scheduleId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    await handlers.openTestsResults?.(scheduleId);
    return true;
  }
  // Weekly plan just published (draft -> active, Builder's own "Save and
  // finish") - opens the athlete's own Weekly view, selecting the exact
  // week from metadata.weekStart (see backend/src/routes/builder.js's
  // notifyPlanAssignments).
  if (type === "notification-open-weekly-plan") {
    const id = action.dataset.notificationId;
    const weekStart = action.dataset.weekStart;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    if (weekStart) await handlers.openWeeklyPlanFromNotification?.(weekStart);
    return true;
  }
  // Specific Program just published/assigned - opens the athlete's own
  // Specific Programs view, resolving the exact plan by id (never by name -
  // two programs can share a name).
  if (type === "notification-open-specific-program") {
    const id = action.dataset.notificationId;
    const planId = action.dataset.planId;
    if (id) await markNotificationRead(id);
    state.notifications.open = false;
    renderNotifications();
    if (planId) await handlers.openSpecificProgramFromNotification?.(planId);
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
  const isConversationNotification = row.entity_type === "message_conversation" && row.entity_id;
  // Phase 3A: WELLNESS notifications (testsNotificationWorker.js). Invitation
  // and reminder both deep-link to the athlete's own assignment; the two
  // coach digests both open Tests, but to different sections.
  const isTestAssignmentNotification = (row.type === "test_athlete_invitation" || row.type === "test_athlete_reminder") && row.entity_type === "test_assignment" && row.entity_id;
  const isCoachDigestNotification = row.type === "test_coach_digest" && row.entity_type === "test_occurrence";
  const isFinalDigestNotification = row.type === "test_final_digest" && row.entity_type === "test_occurrence";
  // Builder plan-assignment notifications (backend/src/routes/builder.js's
  // notifyPlanAssignments) - athlete side, one of the two plan_type kinds.
  const isWeeklyPlanAssigned = row.type === "weekly_plan_assigned" && row.entity_type === "plan" && row.entity_id;
  const isSpecificProgramAssigned = row.type === "specific_program_assigned" && row.entity_type === "plan" && row.entity_id;
  const rowAction = isProgramAccessRequest
    ? "notification-open-program-requests"
    : isConversationNotification
      ? "notification-open-conversation"
      : isTestAssignmentNotification
        ? "notification-open-test-assignment"
        : isCoachDigestNotification
          ? "notification-open-tests-today"
          : isFinalDigestNotification
            ? "notification-open-tests-results"
            : isWeeklyPlanAssigned
              ? "notification-open-weekly-plan"
              : isSpecificProgramAssigned
                ? "notification-open-specific-program"
                : "notification-read";
  return `
    <article class="notification-row${unreadClass}">
      <button class="notification-row-hit" data-action="${rowAction}" data-notification-id="${escapeAttr(row.id)}" data-conversation-id="${escapeAttr(isConversationNotification ? row.entity_id : "")}" data-assignment-id="${escapeAttr(isTestAssignmentNotification ? row.entity_id : "")}" data-schedule-id="${escapeAttr(isFinalDigestNotification ? row.metadata?.scheduleId || "" : "")}" data-week-start="${escapeAttr(isWeeklyPlanAssigned ? row.metadata?.weekStart || "" : "")}" data-plan-id="${escapeAttr(isSpecificProgramAssigned ? row.entity_id : "")}" type="button">
        <span>
          <strong>${escapeHtml(row.title || "Notification")}</strong>
          ${row.body ? `<small>${escapeHtml(row.body)}</small>` : ""}
          ${isProgramAccessRequest ? `<small class="notification-hint">Open requests</small>` : ""}
          ${isConversationNotification ? `<small class="notification-hint">Open conversation</small>` : ""}
          ${isTestAssignmentNotification ? `<small class="notification-hint">Open check-in</small>` : ""}
          ${isCoachDigestNotification ? `<small class="notification-hint">Open Today</small>` : ""}
          ${isFinalDigestNotification ? `<small class="notification-hint">Open Results</small>` : ""}
          ${isWeeklyPlanAssigned ? `<small class="notification-hint">Open weekly plan</small>` : ""}
          ${isSpecificProgramAssigned ? `<small class="notification-hint">Open program</small>` : ""}
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
