import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// feature/mobile-messages-fullscreen: messages.js imports els from dom.js,
// which touches `document` at module scope, so (like app.js and
// athlete-view.js elsewhere in this suite) it cannot be imported directly
// under node:test. These are source-pattern-guard tests over the raw
// text of messages.js instead - the same technique already established
// throughout this codebase's test suite.

const filePath = fileURLToPath(new URL("../messages.js", import.meta.url));
const source = readFileSync(filePath, "utf8");

function sliceFunction(name, windowSize = 2600) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in messages.js`);
  return source.slice(start, start + windowSize);
}

// === Mobile screen split (list-only vs thread-only) ===

test("the panel wrapper only carries has-thread when a conversation is actually selected - this single class is what drives which mobile screen shows", () => {
  const body = sliceFunction("renderMessagePanelHtml");
  assert.match(body, /const hasThread = Boolean\(state\.messages\.selectedId\);/);
  assert.match(body, /class="message-inbox-layout\$\{hasThread \? " has-thread" : ""\}"/);
});

test("styles.css: .message-inbox-layout.has-thread hides the list and shows the thread, and only inside the mobile breakpoint", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  assert.ok(mediaStart >= 0, "a single @media (max-width: 760px) block must exist for Messages");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  assert.match(block, /\.message-inbox-layout\.has-thread \.message-inbox-list \{\s*\n\s*display: none;/);
  assert.match(block, /\.message-inbox-layout\.has-thread \.message-inbox-thread \{\s*\n\s*display: grid;/);
});

// === Desktop unaffected ===

test("styles.css: the desktop .message-inbox-layout split-view grid (list + thread side by side) still exists outside any media query", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const desktopBlockStart = css.indexOf(".message-inbox-layout {");
  assert.ok(desktopBlockStart >= 0);
  const desktopBlock = css.slice(desktopBlockStart, desktopBlockStart + 200);
  assert.match(desktopBlock, /grid-template-columns: minmax\(240px, 0\.42fr\) minmax\(0, 1fr\);/, "the original desktop split-view column definition must be untouched");
});

test("styles.css: the old broken 640px override (116px-wide list column) is gone", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  assert.ok(!css.includes("minmax(116px, 0.42fr)"), "the broken narrow-list mobile override must be removed, not just superseded");
});

// === Generic Messages icon opens to the list on mobile ===

test("messages-toggle resets selectedId/detail on open, but only on mobile - Coaches -> Message's separate path is untouched", () => {
  const body = sliceFunction("handleMessageAction", 900);
  assert.match(body, /if \(type === "messages-toggle"\) \{/);
  assert.match(body, /if \(isMobileMessagesViewport\(\)\) \{\s*\n\s*state\.messages\.selectedId = "";\s*\n\s*state\.messages\.detail = null;/);
});

test("openMessageConversation (Coaches -> Message's entry point) never resets selectedId - it sets it via openConversation(id) right after", () => {
  const body = sliceFunction("openMessageConversation");
  assert.ok(!body.includes('state.messages.selectedId = ""'), "openMessageConversation itself must never clear selectedId - it's what OPENS a specific thread");
  assert.match(body, /await openConversation\(id\);/);
});

// === Back/Escape priority ===

test("handleMessagesBack(): menu -> Hide-confirm -> thread-to-list -> close-Messages, in that exact order", () => {
  const body = sliceFunction("handleMessagesBack", 900);
  const menuIdx = body.indexOf("state.messages.menuOpen");
  const hideIdx = body.indexOf("state.messages.hideConfirmOpen");
  const mobileGateIdx = body.indexOf("isMobileMessagesViewport()");
  const selectedIdIdx = body.indexOf("state.messages.selectedId) {");
  const closeIdx = body.indexOf("state.messages.open = false;");
  assert.ok(menuIdx >= 0 && hideIdx > menuIdx && mobileGateIdx > hideIdx && selectedIdIdx > mobileGateIdx && closeIdx > selectedIdIdx, "priority order must be menu, then hide-confirm, then the mobile gate, then thread-to-list, then close");
});

test("thread-to-list and close-Messages are gated to mobile; closing the menu/Hide-confirm is not", () => {
  const body = sliceFunction("handleMessagesBack", 900);
  const mobileGateLine = body.match(/if \(!isMobileMessagesViewport\(\) \|\| !state\.messages\.open\) return false;/);
  assert.ok(mobileGateLine, "the mobile+open gate must exist as an early return, placed AFTER the menu/hide-confirm checks");
  const gateIndex = body.indexOf(mobileGateLine[0]);
  const menuCheckIndex = body.indexOf("state.messages.menuOpen) {");
  assert.ok(menuCheckIndex < gateIndex, "menu-close must not be behind the mobile gate");
});

test("app.js: handleAppBack() calls handleMessagesBack() first, right after the media-modal check, before any other overlay", () => {
  const appJsPath = fileURLToPath(new URL("../app.js", import.meta.url));
  const appJs = readFileSync(appJsPath, "utf8");
  const fnStart = appJs.indexOf("function handleAppBack() {");
  const body = appJs.slice(fnStart, fnStart + 700);
  const mediaModalIdx = body.indexOf("els.mediaModal");
  const messagesBackIdx = body.indexOf("handleMessagesBack()");
  const exitConfirmIdx = body.indexOf("athleteExitConfirmOpen");
  assert.ok(mediaModalIdx >= 0 && messagesBackIdx > mediaModalIdx && exitConfirmIdx > messagesBackIdx, "handleMessagesBack() must run after the media-modal check and before athleteExitConfirmOpen");
});

test("app.js: the Escape keydown handler calls handleMessagesBack() first and returns early if it handled something", () => {
  const appJsPath = fileURLToPath(new URL("../app.js", import.meta.url));
  const appJs = readFileSync(appJsPath, "utf8");
  const marker = 'document.addEventListener("keydown", (event) => {';
  const start = appJs.indexOf(marker);
  const block = appJs.slice(start, start + 400);
  assert.match(block, /if \(handleMessagesBack\(\)\) return;/);
  const escapeCheckIdx = block.indexOf('event.key !== "Escape"');
  const messagesBackIdx = block.indexOf("handleMessagesBack()");
  assert.ok(escapeCheckIdx >= 0 && messagesBackIdx > escapeCheckIdx && messagesBackIdx < block.indexOf("athleteExitConfirmOpen"), "handleMessagesBack() must be checked before the other Escape-closable overlays");
});

test("app.js imports handleMessagesBack from messages.js - Back/Escape share one implementation, not two parallel copies", () => {
  const appJsPath = fileURLToPath(new URL("../app.js", import.meta.url));
  const appJs = readFileSync(appJsPath, "utf8");
  const importStart = appJs.indexOf('from "./messages.js"');
  const importBlock = appJs.slice(Math.max(0, importStart - 300), importStart);
  assert.ok(importBlock.includes("handleMessagesBack"));
});

// === 3-dot overflow menu: Hide/Block/Unblock ===

test("the mobile 3-dot menu dropdown contains exactly Hide conversation + Block/Unblock, as real menu items", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  assert.match(body, /role="menu"/);
  assert.match(body, /role="menuitem">Hide conversation</);
  assert.match(body, /role="menuitem">\$\{blockLabel\}/);
  assert.match(body, /aria-haspopup="true"/);
  assert.match(body, /aria-expanded="\$\{state\.messages\.menuOpen \? "true" : "false"\}"/);
});

test("desktop keeps its own always-visible inline Hide/Block buttons, marked distinctly from the mobile menu so CSS can show one and hide the other per breakpoint", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  assert.match(body, /message-thread-action-inline" data-action="message-hide"/);
  assert.match(body, /message-thread-action-inline" data-action="\$\{blockAction\}"/);
});

test("closeMessagesIfOutside closes the 3-dot menu on a click outside it specifically, independent of whether the whole panel also closes", () => {
  const body = sliceFunction("closeMessagesIfOutside");
  assert.match(body, /if \(state\.messages\.menuOpen && !target\.closest\("\.message-thread-menu"\)\) \{/);
});

// === Hide confirmation: styled modal, not window.confirm ===

test("Hide no longer calls window.confirm anywhere in messages.js - it opens a styled confirm step instead", () => {
  assert.ok(!source.includes("window.confirm("), "window.confirm(...) must be fully replaced by the styled Hide-confirm modal (a comment MAY still name it for context, but no invocation may remain)");
});

test("the Hide-confirm modal reuses the existing .exit-confirm-modal/-backdrop/-dialog/-actions classes verbatim, not a new visual component", () => {
  const body = sliceFunction("renderHideConfirmHtml");
  assert.match(body, /class="exit-confirm-modal message-hide-confirm-modal"/);
  assert.match(body, /class="exit-confirm-backdrop" data-action="message-hide-cancel"/);
  assert.match(body, /class="exit-confirm-dialog"/);
  assert.match(body, /class="exit-confirm-actions"/);
});

test("the backend Hide call (POST /:id/hide) only fires from message-hide-confirm, never from the initial message-hide click - the click only opens the confirm step", () => {
  const hideClickBody = source.slice(source.indexOf('if (type === "message-hide") {'), source.indexOf('if (type === "message-hide-cancel")'));
  assert.ok(!hideClickBody.includes("/hide"), "clicking Hide must only set hideConfirmOpen, not call the API directly");
  const confirmBody = source.slice(source.indexOf('if (type === "message-hide-confirm") {'), source.indexOf('if (type === "message-hide-confirm") {') + 500);
  assert.match(confirmBody, /\/hide/);
});

// === Send button: icon, aria-label, disabled logic, no double-submit ===

test("the Send button has no visible text, uses an inline SVG icon, and carries aria-label='Send message'", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  assert.match(body, /class="plain-button compact-button message-send-button" type="submit" aria-label="Send message" disabled>/);
  assert.match(body, /\$\{ICON_SEND\}/);
});

test("ICON_SEND is a real inline SVG, not literal 'Send' text", () => {
  assert.match(source, /const ICON_SEND = `<svg /);
});

test("submitMessageForm rejects an empty (whitespace-only) message before ever calling the API", () => {
  const body = sliceFunction("submitMessageForm", 900);
  const trimIdx = body.indexOf("const body = String(input?.value");
  const emptyCheckIdx = body.indexOf("if (!body) return;");
  const apiIdx = body.indexOf("api(`/api/messages/");
  assert.ok(trimIdx >= 0 && emptyCheckIdx > trimIdx && apiIdx > emptyCheckIdx, "the empty-body check must happen before the API call");
});

test("submitMessageForm guards against a rapid double-submit via state.messages.sending, checked at function entry", () => {
  const body = sliceFunction("submitMessageForm", 200);
  assert.match(body, /if \(!id \|\| state\.messages\.sending\) return;/);
});

test("submitMessageForm sets sending=true synchronously before the API call, so a second rapid click sees it already true", () => {
  const body = sliceFunction("submitMessageForm", 900);
  const sendingTrueIdx = body.indexOf("state.messages.sending = true;");
  const apiIdx = body.indexOf("api(`/api/messages/");
  assert.ok(sendingTrueIdx >= 0 && sendingTrueIdx < apiIdx);
});

test("a failed send preserves the typed text in state.messages.draft, and restores it into the re-rendered input's value attribute", () => {
  const submitBody = sliceFunction("submitMessageForm", 1300);
  assert.match(submitBody, /catch \(error\) \{\s*\n(\s*\/\/.*\n)*\s*state\.messages\.draft = body;/);
  const conversationBody = sliceFunction("renderConversationHtml", 3800);
  assert.match(conversationBody, /const draft = escapeAttr\(state\.messages\.draft \|\| ""\);/);
  assert.match(conversationBody, /<input name="body" type="text" placeholder="Write a message\.\.\." autocomplete="off" value="\$\{draft\}">/);
});

test("a successful send clears both state.messages.draft and the live input's value", () => {
  const body = sliceFunction("submitMessageForm", 900);
  const successBlock = body.slice(0, body.indexOf("} catch"));
  assert.match(successBlock, /state\.messages\.draft = "";/);
  assert.match(successBlock, /if \(input\) input\.value = "";/);
});

test("openConversation() clears any leftover draft when switching to a (possibly different) conversation", () => {
  const body = sliceFunction("openConversation");
  assert.match(body, /state\.messages\.draft = "";/);
});

// === Loading/error/empty states ===

test("the list shows its own loading/error/empty/no-results states, and a thread-level error never overwrites the list once a thread is selected", () => {
  const body = sliceFunction("renderMessagePanelHtml", 1800);
  assert.match(body, /state\.messages\.loading && !state\.messages\.selectedId/);
  assert.match(body, /state\.messages\.error && !state\.messages\.selectedId/);
  assert.match(body, /No conversations match this search\./);
  assert.match(body, /No messages yet\./);
});

test("a send error does not blank an already-loaded thread's message history - it only replaces the thread body when there are truly zero messages", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  const loadingIdx = body.indexOf("state.messages.loading");
  const messagesLengthIdx = body.indexOf("messages.length");
  const errorIdx = body.indexOf("state.messages.error");
  assert.ok(loadingIdx >= 0 && messagesLengthIdx > loadingIdx && errorIdx > messagesLengthIdx, "messages.length must be checked before state.messages.error in the body ternary, so real messages always win over a stray error");
});

test("a send error is still surfaced as a small banner near the composer when messages already exist, so the failure isn't silently swallowed", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  assert.match(body, /state\.messages\.error && messages\.length \? `<p class="form-error message-thread-error">/);
});

test("going back to the list (message-back and the mobile Back/Escape path) clears any stale thread error so it can never bleed into the list view", () => {
  const backActionBody = source.slice(source.indexOf('if (type === "message-back") {'), source.indexOf('if (type === "message-menu-toggle")'));
  assert.match(backActionBody, /state\.messages\.error = "";/);
  const handleBackBody = sliceFunction("handleMessagesBack", 900);
  assert.match(handleBackBody, /state\.messages\.error = "";/);
});

// === Scroll-to-bottom / near-bottom realtime behavior ===

test("renderMessages() scrolls to the bottom on a newly-opened conversation OR when the reader was already near the bottom - never forces scroll otherwise", () => {
  const body = sliceFunction("renderMessages", 1600);
  assert.match(body, /const wasNearBottom = !previousThread\s*\n\s*\|\| previousThread\.scrollHeight - previousThread\.scrollTop - previousThread\.clientHeight <= NEAR_BOTTOM_THRESHOLD_PX;/);
  assert.match(body, /const isNewConversation = currentConversationId !== previousConversationId;/);
  assert.match(body, /if \(isNewConversation \|\| wasNearBottom\) \{\s*\n\s*newThread\.scrollTop = newThread\.scrollHeight;/);
});

test("the near-bottom check is measured BEFORE the panel's innerHTML is replaced, against the OLD thread element - not the new one", () => {
  const body = sliceFunction("renderMessages", 1600);
  const wasNearBottomIdx = body.indexOf("const wasNearBottom");
  const innerHtmlIdx = body.indexOf("els.messagePanel.innerHTML = renderMessagePanelHtml();");
  assert.ok(wasNearBottomIdx >= 0 && wasNearBottomIdx < innerHtmlIdx);
});

// === Unread badge ===

test("the unread badge logic is unchanged: text content and hidden state both driven by state.messages.unreadCount", () => {
  const body = sliceFunction("renderMessages", 1600);
  assert.match(body, /count\.textContent = String\(state\.messages\.unreadCount \|\| 0\);/);
  assert.match(body, /count\.hidden = !state\.messages\.unreadCount;/);
});

test("the mobile list header also shows the unread count next to the Messages title", () => {
  const body = sliceFunction("renderMessagePanelHtml", 1800);
  assert.match(body, /\$\{state\.messages\.unreadCount \? `<span class="notification-count">\$\{escapeHtml\(String\(state\.messages\.unreadCount\)\)\}<\/span>` : ""\}/);
});

// === Close button ===

test("the list header has a Close button with a clear aria-label, wired to messages-close (close only, no navigation)", () => {
  const body = sliceFunction("renderMessagePanelHtml", 1800);
  assert.match(body, /data-action="messages-close" type="button" aria-label="Close messages"/);
  const closeActionBody = source.slice(source.indexOf('if (type === "messages-close") {'), source.indexOf('if (type === "messages-close") {') + 300);
  assert.match(closeActionBody, /state\.messages\.open = false;/);
  assert.ok(!closeActionBody.includes("activeTab"), "closing Messages must never touch app navigation/activeTab");
});

// === Back button on the thread header ===

test("the thread header has a Back button wired to the existing message-back action, with a clear aria-label", () => {
  const body = sliceFunction("renderConversationHtml", 3800);
  assert.match(body, /data-action="message-back" type="button" aria-label="Back to conversations"/);
});

// === Search: focus preservation and no extra API calls ===
// This behavior lives in app.js's handleContentInput, not in messages.js,
// and predates this phase - included here because the user's test list
// explicitly requires it, and this phase's changes must not have disturbed
// it (renderMessages() is still called synchronously, not through a
// network round-trip, on every keystroke).

test("app.js: message search is handled entirely client-side on input - re-renders from local state only, no api() call in the branch", () => {
  const appPath = fileURLToPath(new URL("../app.js", import.meta.url));
  const appSource = readFileSync(appPath, "utf8");
  const start = appSource.indexOf('const messageSearch = event.target.closest("[data-message-search]");');
  assert.ok(start >= 0, "handleContentInput must still special-case [data-message-search]");
  const branch = appSource.slice(start, start + 500);
  assert.match(branch, /state\.messages\.search = messageSearch\.value;/);
  assert.match(branch, /renderMessages\(\);/);
  assert.ok(!/\bapi\(/.test(branch), "typing in the message search box must never issue a network request");
});

test("app.js: message search restores focus and cursor position after the re-render, so typing never gets interrupted", () => {
  const appPath = fileURLToPath(new URL("../app.js", import.meta.url));
  const appSource = readFileSync(appPath, "utf8");
  const start = appSource.indexOf('const messageSearch = event.target.closest("[data-message-search]");');
  const branch = appSource.slice(start, start + 500);
  assert.match(branch, /requestAnimationFrame\(\(\) => \{/);
  assert.match(branch, /nextInput\.focus\(\);/);
  assert.match(branch, /nextInput\.setSelectionRange\(cursor, cursor\);/);
});

// === Fullscreen shell / safe-area CSS ===

test("styles.css: the mobile Messages shell is a fixed fullscreen overlay covering the viewport, respecting all four safe-area insets", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const panelStart = block.indexOf(".message-panel {");
  const panelBlock = block.slice(panelStart, block.indexOf("}", panelStart));
  assert.match(panelBlock, /position: fixed;/);
  assert.match(panelBlock, /inset: 0;/);
  assert.match(panelBlock, /width: 100vw;/);
  assert.match(panelBlock, /height: 100dvh;/);
  assert.match(panelBlock, /env\(safe-area-inset-top, 0px\)/);
  assert.match(panelBlock, /env\(safe-area-inset-right, 0px\)/);
  assert.match(panelBlock, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(panelBlock, /env\(safe-area-inset-left, 0px\)/);
});

test("styles.css: the mobile composer also respects the left/right/bottom safe-area insets, so the send button and input are never clipped", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const composeStart = block.indexOf(".message-compose {");
  const composeBlock = block.slice(composeStart, block.indexOf("}", composeStart));
  assert.match(composeBlock, /env\(safe-area-inset-right, 0px\)/);
  assert.match(composeBlock, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(composeBlock, /env\(safe-area-inset-left, 0px\)/);
});

test("styles.css: no rule inside the mobile Messages block sets a width/inset wider than the viewport (guards against page-level horizontal overflow)", () => {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  const css = readFileSync(cssPath, "utf8");
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const widthDeclarations = block.match(/width:\s*[^;]+;/g) || [];
  for (const decl of widthDeclarations) {
    if (decl.includes("min(") || decl.includes("calc(")) continue; // clamped against another bound - safe by construction
    for (const [, num] of decl.matchAll(/(\d+(?:\.\d+)?)vw/g)) {
      assert.ok(Number(num) <= 100, `unexpected viewport-width declaration that could overflow: ${decl}`);
    }
  }
});
