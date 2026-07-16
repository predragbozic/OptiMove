import { els } from "./dom.js";
import { state } from "./state.js";

export function renderMessages() {
  if (!els.messageToggle || !els.messagePanel) return;
  const isSignedIn = Boolean(state.currentUser);
  els.messageToggle.hidden = !isSignedIn;
  els.messagePanel.hidden = !isSignedIn || !state.messages.open;
  const count = els.messageToggle.querySelector("[data-message-count]");
  if (count) {
    count.textContent = String(state.messages.unreadCount || 0);
    count.hidden = !state.messages.unreadCount;
  }
  els.messagePanel.innerHTML = renderMessagePanelHtml();
}

export function handleMessageAction(action) {
  const type = action?.dataset?.action || "";
  if (type !== "messages-toggle") return false;
  state.messages.open = !state.messages.open;
  if (state.messages.open && state.notifications) state.notifications.open = false;
  renderMessages();
  return true;
}

export function closeMessagesIfOutside(target) {
  if (!state.messages.open) return;
  if (target.closest(".message-menu")) return;
  state.messages.open = false;
  renderMessages();
}

function renderMessagePanelHtml() {
  if (!state.currentUser) return "";
  return `
    <div class="notification-panel-head">
      <strong>Messages</strong>
      <span class="panel-status">Soon</span>
    </div>
    <div class="message-panel-body">
      <p class="empty-note">Messages will collect coach-athlete conversations here.</p>
      <p class="empty-note">For now, access requests and contact requests arrive in Notifications.</p>
    </div>
  `;
}
