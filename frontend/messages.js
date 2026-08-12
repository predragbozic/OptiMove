import { api } from "./api.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";
import { imageSources } from "./media.js";

// feature/mobile-messages-fullscreen: below this width Messages becomes a
// true fullscreen app-level screen (list, then thread) instead of the
// desktop split-view panel - see the matching @media (max-width: 760px)
// block in styles.css. 760px is this codebase's own dominant existing
// breakpoint (already used more than any other cutoff), reused here
// rather than introducing a one-off value. Exported so app.js's
// handleAppBack()/Escape wiring can gate the new Back-priority branches
// to mobile only, matching the desktop-untouched requirement.
export function isMobileMessagesViewport() {
  return !window.matchMedia("(min-width: 761px)").matches;
}

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

// Tracks, across a re-render, whether the thread was scrolled near the
// bottom before the DOM was replaced, and which conversation was showing -
// a realtime update only auto-scrolls if the reader was already near the
// bottom (or this is the very first render of a newly-opened
// conversation); reading older messages further up is never disturbed.
const NEAR_BOTTOM_THRESHOLD_PX = 80;

export function renderMessages() {
  if (!els.messageToggle || !els.messagePanel) return;
  const isSignedIn = Boolean(state.currentUser);
  els.messageToggle.hidden = !isSignedIn;
  const panelOpen = isSignedIn && state.messages.open;
  els.messagePanel.hidden = !panelOpen;
  // Drives the mobile fullscreen shell (hides the sidebar/topbar behind
  // Messages, locks page scroll) - see styles.css's own comment on this
  // class. Harmless outside the mobile breakpoint, where the CSS for it
  // doesn't apply at all.
  document.body.classList.toggle("messages-open", panelOpen);
  const count = els.messageToggle.querySelector("[data-message-count]");
  if (count) {
    count.textContent = String(state.messages.unreadCount || 0);
    count.hidden = !state.messages.unreadCount;
  }

  const previousThread = els.messagePanel.querySelector(".message-thread");
  const previousConversationId = els.messagePanel.dataset.renderedConversationId || "";
  const wasNearBottom = !previousThread
    || previousThread.scrollHeight - previousThread.scrollTop - previousThread.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;

  els.messagePanel.innerHTML = renderMessagePanelHtml();

  const currentConversationId = String(state.messages.selectedId || "");
  els.messagePanel.dataset.renderedConversationId = currentConversationId;
  const newThread = els.messagePanel.querySelector(".message-thread");
  if (newThread) {
    const isNewConversation = currentConversationId !== previousConversationId;
    if (isNewConversation || wasNearBottom) {
      newThread.scrollTop = newThread.scrollHeight;
    }
  }
  wireComposer();
}

// The Send button's disabled state must react on every keystroke, but a
// full renderMessages() per keystroke would replace the input's own DOM
// node mid-typing (the same focus-loss problem solved for Specific
// programs search) - so this only ever toggles one attribute directly,
// never touches state, and is never itself the trigger for a re-render.
function wireComposer() {
  const form = els.messagePanel?.querySelector("[data-message-form]");
  if (!form) return;
  const input = form.querySelector("[name='body']");
  const button = form.querySelector("button[type='submit']");
  if (!input || !button) return;
  const updateDisabled = () => {
    button.disabled = !input.value.trim() || state.messages.sending;
  };
  updateDisabled();
  input.addEventListener("input", updateDisabled);
}

export async function handleMessageAction(action) {
  const type = action?.dataset?.action || "";
  if (type === "messages-toggle") {
    const opening = !state.messages.open;
    state.messages.open = opening;
    if (opening) {
      if (state.notifications) state.notifications.open = false;
      // A generic open (topbar icon) always lands on the list on mobile -
      // never silently restores whatever conversation was open before.
      // Coaches -> Message keeps opening straight to a thread via the
      // separate openMessageConversation() path below, unchanged.
      if (isMobileMessagesViewport()) {
        state.messages.selectedId = "";
        state.messages.detail = null;
      }
      state.messages.menuOpen = false;
      state.messages.hideConfirmOpen = false;
      await loadMessages({ silent: true });
    } else {
      state.messages.menuOpen = false;
      state.messages.hideConfirmOpen = false;
      renderMessages();
    }
    return true;
  }
  if (type === "messages-close") {
    state.messages.open = false;
    state.messages.menuOpen = false;
    state.messages.hideConfirmOpen = false;
    renderMessages();
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
    state.messages.menuOpen = false;
    // A stale thread-load/send error must never bleed into the list view
    // once the athlete has already backed out of the thread it belonged
    // to (the list has its own separate loading/error path in loadMessages).
    state.messages.error = "";
    renderMessages();
    return true;
  }
  if (type === "message-menu-toggle") {
    state.messages.menuOpen = !state.messages.menuOpen;
    renderMessages();
    return true;
  }
  if (type === "message-block" || type === "message-unblock") {
    const id = state.messages.selectedId;
    if (!id) return true;
    state.messages.menuOpen = false;
    await api(`/api/messages/${encodeURIComponent(id)}/block`, {
      method: "POST",
      body: JSON.stringify({ blocked: type === "message-block" }),
    });
    await openConversation(id);
    await loadMessages({ silent: true });
    return true;
  }
  // security/mobile-messages-fullscreen note: Hide now goes through a
  // styled confirm step (hideConfirmOpen) instead of window.confirm - the
  // actual backend call (POST /:id/hide) and its effect are byte-for-byte
  // unchanged from before, only the confirmation UI changed.
  if (type === "message-hide") {
    if (!state.messages.selectedId) return true;
    state.messages.menuOpen = false;
    state.messages.hideConfirmOpen = true;
    renderMessages();
    return true;
  }
  if (type === "message-hide-cancel") {
    state.messages.hideConfirmOpen = false;
    renderMessages();
    return true;
  }
  if (type === "message-hide-confirm") {
    const id = state.messages.selectedId;
    state.messages.hideConfirmOpen = false;
    if (!id) {
      renderMessages();
      return true;
    }
    await api(`/api/messages/${encodeURIComponent(id)}/hide`, { method: "POST" });
    state.messages.rows = (state.messages.rows || []).filter((row) => String(row.id) !== String(id));
    state.messages.selectedId = "";
    state.messages.detail = null;
    await loadMessages({ silent: true });
    return true;
  }
  return false;
}

// feature/mobile-messages-fullscreen: shared Back/Escape priority chain
// for Messages - menu, then Hide-confirm, then thread-to-list, then
// close-Messages - called identically from app.js's handleAppBack() and
// its Escape keydown handler so the two never drift out of sync. The
// thread-to-list/close-Messages steps only apply on mobile (desktop shows
// both panels at once, so there is nothing for Back/Escape to do there);
// closing an open menu or the Hide-confirm modal applies on any viewport,
// matching how every other modal/menu in this app already responds to
// Escape regardless of screen size.
export function handleMessagesBack() {
  if (state.messages.menuOpen) {
    state.messages.menuOpen = false;
    renderMessages();
    return true;
  }
  if (state.messages.hideConfirmOpen) {
    state.messages.hideConfirmOpen = false;
    renderMessages();
    return true;
  }
  if (!isMobileMessagesViewport() || !state.messages.open) return false;
  if (state.messages.selectedId) {
    state.messages.selectedId = "";
    state.messages.detail = null;
    state.messages.error = "";
    renderMessages();
    return true;
  }
  state.messages.open = false;
  renderMessages();
  return true;
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
  if (!id || state.messages.sending) return;
  const input = form.querySelector("[name='body']");
  const body = String(input?.value || "").trim();
  if (!body) return;
  state.messages.sending = true;
  const button = form.querySelector("button[type='submit']");
  if (button) button.disabled = true;
  try {
    await api(`/api/messages/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    state.messages.draft = "";
    if (input) input.value = "";
    await openConversation(id);
    await loadMessages({ silent: true });
    els.messagePanel?.querySelector("[name='body']")?.focus();
  } catch (error) {
    // The typed text must survive a failed send - openConversation()/
    // loadMessages() above are skipped on this path, but renderMessages()
    // still fully replaces the panel's innerHTML to show the error, which
    // would otherwise silently drop whatever was typed (see this branch's
    // ONLY other write to `draft` above, which clears it - so a lost
    // draft was previously indistinguishable from a successful send).
    state.messages.draft = body;
    state.messages.error = error.message || "Could not send message.";
    renderMessages();
  } finally {
    state.messages.sending = false;
  }
}

export function closeMessagesIfOutside(target) {
  if (state.messages.menuOpen && !target.closest(".message-thread-menu")) {
    state.messages.menuOpen = false;
    renderMessages();
  }
  if (!state.messages.open) return;
  if (target.closest(".message-menu")) return;
  state.messages.open = false;
  state.messages.menuOpen = false;
  state.messages.hideConfirmOpen = false;
  renderMessages();
}

async function openConversation(id, { silent = false } = {}) {
  state.messages.selectedId = id;
  state.messages.loading = !silent;
  state.messages.draft = "";
  if (!silent) renderMessages();
  try {
    const data = await api(`/api/messages/${encodeURIComponent(id)}`);
    state.messages.detail = data;
    state.messages.error = "";
    const row = state.messages.rows.find((item) => item.id === id);
    if (row) {
      const previousUnread = Number(row.unread_count || 0);
      row.unread_count = 0;
      state.messages.unreadCount = Math.max(0, Number(state.messages.unreadCount || 0) - previousUnread);
    }
  } catch (error) {
    state.messages.error = error.message || "Could not load conversation.";
  } finally {
    state.messages.loading = false;
    renderMessages();
  }
}

// hotfix/mobile-messages-test-regression: pure and exported so the search
// behavior (name/email/last-message matching, case-insensitivity, trimming,
// empty-search-returns-everything) can be unit tested with plain fixture
// data, with no DOM involved at all - the DOM-dependent part of search is
// only the event wiring in handleMessagesPanelInput below.
export function filterConversationRows(rows, search) {
  const term = String(search || "").trim().toLowerCase();
  if (!term) return rows;
  return rows.filter((row) => {
    const participants = (row.participants || []).map((participant) => `${participant.name || ""} ${participant.email || ""}`).join(" ");
    const haystack = `${conversationNames(row)} ${participants} ${row.last_message || ""}`.toLowerCase();
    return haystack.includes(term);
  });
}

// hotfix/mobile-messages-test-regression: [data-message-search] lives inside
// #messagePanel, which itself lives in the topbar's <header>, not inside
// #content - so app.js's single delegated `input` listener on els.content
// (handleContentInput) could never see this input's events, and typing into
// the search box silently did nothing. Wired as ONE delegated listener
// directly on els.messagePanel in app.js's bindEvents() (called once at
// startup), the same "render everything, then restore focus/caret manually"
// pattern already used for every other search box in this app (see e.g.
// Program Library's own search handling in handleContentInput) - a full
// renderMessages() replaces #messagePanel's innerHTML (including the input
// node itself), so focus and caret position have to be reapplied by hand on
// the NEW node after the DOM settles, on the next animation frame.
export function handleMessagesPanelInput(event) {
  const input = event.target.closest("[data-message-search]");
  if (!input) return;
  const cursor = input.selectionStart;
  state.messages.search = input.value;
  renderMessages();
  requestAnimationFrame(() => {
    const nextInput = els.messagePanel?.querySelector("[data-message-search]");
    if (!nextInput) return;
    nextInput.focus();
    if (Number.isInteger(cursor)) nextInput.setSelectionRange(cursor, cursor);
  });
}

// hotfix/mobile-messages-test-regression: called on logout (before the hard
// reload, which already wipes everything - defensive, not load-bearing, see
// signOut()'s own comment for why this codebase adds these anyway) and on
// login (before the next session's data loads), so a search typed by one
// user can never survive into the next session's Messages panel.
export function resetMessagesState() {
  state.messages.search = "";
  state.messages.open = false;
  state.messages.rows = [];
  state.messages.unreadCount = 0;
  state.messages.selectedId = "";
  state.messages.detail = null;
  state.messages.error = "";
  state.messages.menuOpen = false;
  state.messages.hideConfirmOpen = false;
  state.messages.draft = "";
}

function renderMessagePanelHtml() {
  if (!state.currentUser) return "";
  const rows = state.messages.rows || [];
  const search = String(state.messages.search || "").trim();
  const filteredRows = filterConversationRows(rows, search);
  const listContent = state.messages.loading && !state.messages.selectedId
    ? `<p class="empty-note">Loading messages...</p>`
    : state.messages.error && !state.messages.selectedId
      ? `<p class="form-error">${escapeHtml(state.messages.error)}</p>`
      : filteredRows.length
        ? filteredRows.map(renderConversationRow).join("")
        : `<p class="empty-note">${search ? "No conversations match this search." : "No messages yet."}</p>`;
  const hasThread = Boolean(state.messages.selectedId);
  return `
    <div class="message-inbox-layout${hasThread ? " has-thread" : ""}">
      <section class="message-inbox-list" aria-label="Conversations">
        <div class="notification-panel-head message-inbox-head">
          <span class="message-inbox-head-title">
            <strong>Messages</strong>
            ${state.messages.unreadCount ? `<span class="notification-count">${escapeHtml(String(state.messages.unreadCount))}</span>` : ""}
          </span>
          <button class="plain-button icon-button message-close-button" data-action="messages-close" type="button" aria-label="Close messages">
            ${ICON_CLOSE}
          </button>
        </div>
        <label class="message-search">
          <span>Search conversations</span>
          <input data-message-search type="search" value="${escapeAttr(state.messages.search || "")}" placeholder="Name, email, or message">
        </label>
        <div class="message-list">${listContent}</div>
      </section>
      <section class="message-inbox-thread" aria-label="Conversation">
        ${hasThread ? renderConversationHtml() : renderConversationPlaceholder()}
      </section>
    </div>
    ${renderHideConfirmHtml()}
  `;
}

function renderConversationRow(row) {
  const names = conversationNames(row);
  const imageUrl = conversationImageUrl(row);
  const unread = Number(row.unread_count || 0);
  const blocked = row.blocked_by_me || row.blocked_by_other;
  const date = row.last_message_created_at ? formatMessageDate(row.last_message_created_at) : "";
  const selected = String(row.id || "") === String(state.messages.selectedId || "");
  return `
    <button class="message-row${unread ? " is-unread" : ""}${selected ? " is-selected" : ""}${blocked ? " is-blocked" : ""}" data-action="message-open" data-conversation-id="${escapeAttr(row.id)}" type="button">
      ${renderAvatarMarkup(imageUrl, names)}
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
  const threadImageUrl = conversation ? conversationImageUrl(conversation) : "";
  const blockedByMe = Boolean(conversation?.blocked_by_me);
  const blockedByOther = Boolean(conversation?.blocked_by_other);
  const blocked = blockedByMe || blockedByOther;
  const blockAction = blockedByMe ? "message-unblock" : "message-block";
  const blockLabel = blockedByMe ? "Unblock" : "Block";
  // A failed SEND must never erase already-loaded message history - only
  // a genuine failure to load the thread in the first place (no messages
  // at all yet) replaces this area with the error; once real messages
  // exist, a send error surfaces as a small banner near the composer
  // instead (see below), right where the retry action actually is.
  const body = state.messages.loading
    ? `<p class="empty-note">Loading conversation...</p>`
    : messages.length
      ? messages.map(renderMessageBubble).join("")
      : state.messages.error
        ? `<p class="form-error">${escapeHtml(state.messages.error)}</p>`
        : `<p class="empty-note">No messages yet.</p>`;
  const draft = escapeAttr(state.messages.draft || "");
  return `
    <div class="notification-panel-head message-thread-head">
      <button class="plain-button icon-button message-back-button" data-action="message-back" type="button" aria-label="Back to conversations">
        ${ICON_BACK}
      </button>
      <span class="message-thread-identity">
        ${renderAvatarMarkup(threadImageUrl, title)}
        <strong>${escapeHtml(title)}</strong>
      </span>
      <span class="message-thread-actions">
        <button class="plain-button compact-button message-thread-action-inline" data-action="message-hide" type="button">Hide</button>
        <button class="plain-button compact-button message-thread-action-inline" data-action="${blockAction}" type="button">${blockLabel}</button>
        <span class="message-thread-menu">
          <button class="plain-button icon-button" data-action="message-menu-toggle" type="button" aria-haspopup="true" aria-expanded="${state.messages.menuOpen ? "true" : "false"}" aria-label="Conversation options">
            ${ICON_DOTS}
          </button>
          <div class="message-thread-menu-dropdown" role="menu" ${state.messages.menuOpen ? "" : "hidden"}>
            <button class="message-thread-menu-item" data-action="message-hide" type="button" role="menuitem">Hide conversation</button>
            <button class="message-thread-menu-item" data-action="${blockAction}" type="button" role="menuitem">${blockLabel}</button>
          </div>
        </span>
      </span>
    </div>
    <div class="message-thread">${body}</div>
    ${state.messages.error && messages.length ? `<p class="form-error message-thread-error">${escapeHtml(state.messages.error)}</p>` : ""}
    ${blocked
      ? `<p class="message-blocked-note">${blockedByMe ? "You blocked this conversation." : "This conversation is blocked by the other participant."}</p>`
      : `<form class="message-compose" data-message-form>
          <input name="body" type="text" placeholder="Write a message..." autocomplete="off" value="${draft}">
          <button class="plain-button compact-button message-send-button" type="submit" aria-label="Send message" disabled>
            ${ICON_SEND}
          </button>
        </form>`}
  `;
}

function renderHideConfirmHtml() {
  if (!state.messages.hideConfirmOpen) return "";
  return `
    <div class="exit-confirm-modal message-hide-confirm-modal">
      <div class="exit-confirm-backdrop" data-action="message-hide-cancel"></div>
      <div class="exit-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="messageHideConfirmTitle" aria-describedby="messageHideConfirmText">
        <h3 id="messageHideConfirmTitle">Hide this conversation?</h3>
        <p id="messageHideConfirmText">It will leave your inbox. New messages will bring it back.</p>
        <div class="exit-confirm-actions">
          <button class="plain-button" type="button" data-action="message-hide-cancel">Cancel</button>
          <button class="plain-button exit-confirm-exit-button" type="button" data-action="message-hide-confirm">Hide</button>
        </div>
      </div>
    </div>
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

// hotfix/mobile-messages-test-regression: extracted from conversationNames
// so the image lookup below can reuse the exact same "who is the other
// person" logic - this app's conversations are always exactly 2 people
// (direct/coach_contact - see ensureDirectCoachConversation's own "exactly
// 2 participants" invariant in backend/src/messages.js), so `others` is
// always a single-element array in practice, but this stays general in
// case a group conversation type is ever added.
function otherParticipants(row) {
  const participants = row.participants || [];
  const others = participants.filter((participant) => String(participant.userId) !== String(state.currentUser?.id));
  return others.length ? others : participants;
}

function conversationNames(row) {
  const names = otherParticipants(row).map((participant) => participant.name || participant.email).filter(Boolean);
  return names.join(", ") || row.title || "Conversation";
}

// Same participant object conversationNames() already resolved - just its
// imageUrl instead of its name, so a row/thread-header never looks up or
// displays a photo for anyone other than the person it's already showing
// the name of.
function conversationImageUrl(row) {
  const [first] = otherParticipants(row);
  return first?.imageUrl || "";
}

// hotfix/messages-avatar-display: participants[].imageUrl often holds a
// Google Drive "share" link (https://drive.google.com/file/d/ID/view?...) -
// the same raw value stored in athletes.image_url/coach_profiles.photo_url.
// That URL is a Drive VIEWER page, not a fetchable image: requesting it as
// a plain <img src> (no session/auth, no Drive UI) fails to load, and with
// no fallback queued this used to drop straight to initials even though
// the exact same stored URL renders correctly everywhere else in the app
// (Athlete Home, Athlete/Coach profile) - because those call sites already
// run the URL through media.js's imageSources()/renderImage() first. This
// now does the same: imageSources() turns one Drive share link into 3 real
// image endpoints (thumbnail, googleusercontent, uc?export=view); the
// first becomes src, the rest become data-fallbacks, and app.js's generic
// handleImageError (which already drives every other avatar/thumbnail in
// this app) walks that chain on load failure before ever giving up to
// initials. A non-Drive URL is unaffected - imageSources() returns it
// unchanged as the sole source, so behavior for a plain direct image URL
// is identical to before this change.
//
// alt="" (decorative) rather than the person's name - in both call sites
// below the name is rendered as visible text immediately next to this
// avatar, so a non-empty alt would make a screen reader announce the name
// twice. The real fallback text (initials) travels via data-initials
// instead of alt, consumed by app.js's handleImageError
// .message-avatar-photo branch once every real photo source has failed.
function renderAvatarMarkup(imageUrl, name) {
  const initialsText = initials(name);
  const sources = imageSources(imageUrl);
  if (!sources.length) return `<span class="message-avatar">${escapeHtml(initialsText)}</span>`;
  const fallbacks = sources.slice(1);
  return `<img class="message-avatar message-avatar-photo" src="${escapeAttr(sources[0])}" alt="" data-initials="${escapeAttr(initialsText)}"${fallbacks.length ? ` data-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"` : ""}>`;
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

const ICON_CLOSE = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`;
const ICON_BACK = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>`;
const ICON_DOTS = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="5" cy="12" r="1.8" fill="currentColor"></circle><circle cx="12" cy="12" r="1.8" fill="currentColor"></circle><circle cx="19" cy="12" r="1.8" fill="currentColor"></circle></svg>`;
// hotfix/mobile-messages-test-regression: the previous path (M4 12l16-8-6.5
// 8L20 20 4 12z) rendered with its tip pointing toward the lower-left, the
// opposite of a standard send arrow. This is the well-known Material Design
// "send" glyph - a paper plane with its tip pointing due right at (23,12),
// vertically centered in the 24x24 viewBox.
const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"></path></svg>`;
