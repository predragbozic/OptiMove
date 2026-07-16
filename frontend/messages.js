import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export async function loadMessages({ silent = false } = {}) {
  if (!state.currentUser) return;
  state.messages.loading = !silent;
  try {
    const data = await api("/api/messages");
    state.messages.rows = data.conversations || [];
    state.messages.unreadCount = data.unreadCount || 0;
    state.messages.error = "";
  } catch (error) {
    state.messages.error = error.message || "Could not load messages.";
  } finally {
    state.messages.loading = false;
    renderMessages();
  }
}

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

export async function handleMessageAction(action) {
  const type = action?.dataset?.action || "";
  if (type === "messages-toggle") {
    state.messages.open = !state.messages.open;
    if (state.messages.open && state.notifications) state.notifications.open = false;
    if (state.messages.open) await loadMessages({ silent: true });
    else renderMessages();
    return true;
  }
  if (type === "message-open") {
    const id = action.dataset.conversationId || "";
    if (!id) return true;
    await openConversation(id);
    return true;
  }
  if (type === "message-back") {
    state.messages.selectedId = "";
    state.messages.detail = null;
    renderMessages();
    return true;
  }
  if (type === "message-block" || type === "message-unblock") {
    const id = state.messages.selectedId;
    if (!id) return true;
    await api(`/api/messages/${encodeURIComponent(id)}/block`, {
      method: "POST",
      body: JSON.stringify({ blocked: type === "message-block" }),
    });
    await openConversation(id);
    await loadMessages({ silent: true });
    return true;
  }
  return false;
}

export async function openMessageConversation(id) {
  if (!id) return;
  state.messages.open = true;
  if (state.notifications) state.notifications.open = false;
  await loadMessages({ silent: true });
  await openConversation(id);
}

export async function refreshSelectedConversation({ silent = false } = {}) {
  const id = state.messages.selectedId;
  if (!id) return;
  await openConversation(id, { silent });
}

export async function submitMessageForm(form) {
  const id = state.messages.selectedId;
  if (!id) return;
  const input = form.querySelector("[name='body']");
  const body = String(input?.value || "").trim();
  if (!body) return;
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    await api(`/api/messages/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if (input) input.value = "";
    await openConversation(id);
    await loadMessages({ silent: true });
  } catch (error) {
    state.messages.error = error.message || "Could not send message.";
    renderMessages();
  } finally {
    if (button) button.disabled = false;
  }
}

export function closeMessagesIfOutside(target) {
  if (!state.messages.open) return;
  if (target.closest(".message-menu")) return;
  state.messages.open = false;
  renderMessages();
}

async function openConversation(id, { silent = false } = {}) {
  state.messages.selectedId = id;
  state.messages.loading = !silent;
  if (!silent) renderMessages();
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    state.messages.detail = data;
    state.messages.error = "";
    const row = state.messages.rows.find((item) => item.id === id);
    if (row) row.unread_count = 0;
  } catch (error) {
    state.messages.error = error.message || "Could not load conversation.";
  } finally {
    state.messages.loading = false;
    renderMessages();
  }
}

function renderMessagePanelHtml() {
  if (!state.currentUser) return "";
  const rows = state.messages.rows || [];
  const listContent = state.messages.loading && !state.messages.selectedId
    ? `<p class="empty-note">Loading messages...</p>`
    : state.messages.error
      ? `<p class="form-error">${escapeHtml(state.messages.error)}</p>`
      : rows.length
        ? rows.map(renderConversationRow).join("")
        : `<p class="empty-note">No messages yet.</p>`;
  return `
    <div class="message-inbox-layout">
      <section class="message-inbox-list" aria-label="Conversations">
        <div class="notification-panel-head message-inbox-head">
          <strong>Messages</strong>
          <span class="panel-status">${rows.length} thread${rows.length === 1 ? "" : "s"}</span>
        </div>
        <div class="message-list">${listContent}</div>
      </section>
      <section class="message-inbox-thread" aria-label="Conversation">
        ${state.messages.selectedId ? renderConversationHtml() : renderConversationPlaceholder()}
      </section>
    </div>
  `;
}

function renderConversationRow(row) {
  const names = conversationNames(row);
  const unread = Number(row.unread_count || 0);
  const blocked = row.blocked_by_me || row.blocked_by_other;
  const date = row.last_message_created_at ? formatMessageDate(row.last_message_created_at) : "";
  const selected = String(row.id || "") === String(state.messages.selectedId || "");
  return `
    <button class="message-row${unread ? " is-unread" : ""}${selected ? " is-selected" : ""}" data-action="message-open" data-conversation-id="${escapeAttr(row.id)}" type="button">
      <span class="message-avatar">${escapeHtml(initials(names))}</span>
      <span class="message-row-main">
        <strong>${escapeHtml(names)}</strong>
        <small>${blocked ? "Blocked conversation" : escapeHtml(row.last_message || "No messages yet.")}</small>
      </span>
      <span class="message-row-meta">
        ${unread ? `<span class="notification-count">${unread}</span>` : ""}
        <time>${escapeHtml(date)}</time>
      </span>
    </button>
  `;
}

function renderConversationHtml() {
  const detail = state.messages.detail;
  const conversation = detail?.conversation;
  const messages = detail?.messages || [];
  const title = conversation ? conversationNames(conversation) : "Conversation";
  const blockedByMe = Boolean(conversation?.blocked_by_me);
  const blockedByOther = Boolean(conversation?.blocked_by_other);
  const blocked = blockedByMe || blockedByOther;
  const body = state.messages.loading
    ? `<p class="empty-note">Loading conversation...</p>`
    : state.messages.error
      ? `<p class="form-error">${escapeHtml(state.messages.error)}</p>`
      : messages.length
        ? messages.map(renderMessageBubble).join("")
        : `<p class="empty-note">No messages yet.</p>`;
  return `
    <div class="notification-panel-head message-thread-head">
      <strong>${escapeHtml(title)}</strong>
      <button class="plain-button compact-button" data-action="${blockedByMe ? "message-unblock" : "message-block"}" type="button">
        ${blockedByMe ? "Unblock" : "Block"}
      </button>
    </div>
    <div class="message-thread">${body}</div>
    ${blocked
      ? `<p class="message-blocked-note">${blockedByMe ? "You blocked this conversation." : "This conversation is blocked by the other participant."}</p>`
      : `<form class="message-compose" data-message-form>
          <input name="body" type="text" placeholder="Write a message..." autocomplete="off">
          <button class="plain-button compact-button" type="submit">Send</button>
        </form>`}
  `;
}

function renderConversationPlaceholder() {
  return `
    <div class="message-thread-placeholder">
      <strong>Select a conversation</strong>
      <p>Choose a person from the left to continue messaging.</p>
    </div>
  `;
}

function renderMessageBubble(message) {
  const own = String(message.sender_user_id || "") === String(state.currentUser?.id || "");
  return `
    <div class="message-bubble${own ? " is-own" : ""}">
      <small>${escapeHtml(own ? "You" : message.sender_name || "User")} · ${escapeHtml(formatMessageDate(message.created_at))}</small>
      <p>${escapeHtml(message.body)}</p>
    </div>
  `;
}

function conversationNames(row) {
  const participants = row.participants || [];
  const others = participants.filter((participant) => String(participant.userId) !== String(state.currentUser?.id));
  const names = (others.length ? others : participants).map((participant) => participant.name || participant.email).filter(Boolean);
  return names.join(", ") || row.title || "Conversation";
}

function initials(name) {
  return String(name || "M")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatMessageDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
