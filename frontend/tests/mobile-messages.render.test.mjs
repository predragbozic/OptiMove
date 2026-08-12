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
  // `.` never matches CR in JS regex (ECMAScript's LineTerminator set - LF,
  // CR, LS, PS - is excluded from the dot), so `.*\n` cannot cross this
  // file's CRLF line endings inside the multi-line comment block between
  // `catch (error) {` and the draft-preserving assignment. [^\r\n]* with an
  // explicit \r? before each \n handles CRLF (and would still handle LF-only
  // files, since \r? is optional).
  assert.match(submitBody, /catch \(error\) \{\r?\n(\s*\/\/[^\r\n]*\r?\n)*\s*state\.messages\.draft = body;/);
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
  const body = sliceFunction("renderMessages", 1700);
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
// hotfix/mobile-messages-test-regression: this behavior USED to be asserted
// against app.js's handleContentInput - but that branch could never
// actually fire (#messagePanel lives outside #content, see the "Search
// input wiring" section further down), so those old assertions were
// checking dead code, not real behavior. The handling now lives in
// messages.js's exported handleMessagesPanelInput; see
// mobile-messages.search.test.mjs for the real jsdom-based behavior proof
// (actual dispatched input events, actual focus/caret survival) and the
// "Search input wiring" tests below for the app.js integration.

test("messages.js: message search is handled entirely client-side on input - re-renders from local state only, no api() call in the branch", () => {
  const start = source.indexOf("export function handleMessagesPanelInput(");
  assert.ok(start >= 0, "handleMessagesPanelInput must exist in messages.js");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /state\.messages\.search = input\.value;/);
  assert.match(body, /renderMessages\(\);/);
  assert.ok(!/\bapi\(/.test(body), "typing in the message search box must never issue a network request");
});

test("messages.js: message search restores focus and cursor position after the re-render, so typing never gets interrupted", () => {
  const start = source.indexOf("export function handleMessagesPanelInput(");
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /requestAnimationFrame\(\(\) => \{/);
  assert.match(body, /nextInput\.focus\(\);/);
  assert.match(body, /nextInput\.setSelectionRange\(cursor, cursor\);/);
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

// === hotfix/mobile-messages-test-regression: compact conversation list ===
// Root cause of the "1-2 rows stretch to fill the screen" bug: .message-list
// is display:grid with implicit auto row tracks; sitting inside the mobile
// .message-inbox-list's minmax(0, 1fr) row gives it a DEFINITE height, and
// grid's default align-content (normal -> stretch here) stretches those few
// row tracks to fill that height. align-content: start is the fix - see the
// comment on the base .message-list rule in styles.css.

function cssSource() {
  const cssPath = fileURLToPath(new URL("../styles.css", import.meta.url));
  return readFileSync(cssPath, "utf8");
}

function ruleBody(css, selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `${selector} rule must exist in styles.css`);
  return css.slice(start, css.indexOf("}", start));
}

test("styles.css: .message-list uses align-content: start so 1-2 rows pack at the top instead of stretching to fill the available height", () => {
  const body = ruleBody(cssSource(), ".message-list {");
  assert.match(body, /align-content:\s*start;/);
});

test("styles.css: on mobile, .message-inbox-list is a 3-row grid (header, search, minmax(0, 1fr) list) with overflow hidden - only the inner .message-list can ever scroll", () => {
  const css = cssSource();
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const listBody = ruleBody(block, ".message-inbox-list {");
  assert.match(listBody, /grid-template-rows:\s*auto auto minmax\(0, 1fr\);/);
  assert.match(listBody, /overflow:\s*hidden;/);
});

test("styles.css: on mobile, .message-list itself is the only scrollable region (overflow-y: auto, overflow-x: hidden)", () => {
  const css = cssSource();
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const listBody = ruleBody(block, ".message-list {");
  assert.match(listBody, /overflow-y:\s*auto;/);
  assert.match(listBody, /overflow-x:\s*hidden;/);
});

test("styles.css: on mobile, .message-row's compact height falls within the required ~68-76px range", () => {
  const css = cssSource();
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const rowBody = ruleBody(block, ".message-row {");
  const match = rowBody.match(/min-height:\s*(\d+)px/);
  assert.ok(match, "min-height must be set on the mobile .message-row rule");
  const value = Number(match[1]);
  assert.ok(value >= 68 && value <= 76, `expected .message-row min-height within 68-76px, got ${value}px`);
});

test("styles.css: long name/last-message text is clipped with ellipsis, not wrapped, so a long conversation entry can never grow a row's height", () => {
  const body = ruleBody(cssSource(), ".message-row-main strong,");
  assert.match(body, /white-space:\s*nowrap;/);
  assert.match(body, /overflow:\s*hidden;/);
  assert.match(body, /text-overflow:\s*ellipsis;/);
});

// === Send icon orientation ===

test("ICON_SEND's path data is the Material Design 'send' glyph, tip pointing due right at x=23 (the rightmost point), vertically centered - not the previous inverted path", () => {
  assert.match(source, /const ICON_SEND = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M2\.01 21L23 12 2\.01 3 2 10l15 2-15 2z" fill="currentColor">/);
  assert.ok(!source.includes("M4 12l16-8-6.5 8L20 20 4 12z"), "the old inverted send-icon path must be fully removed");
});

test("ICON_SEND's path's rightmost point (the arrow tip) sits at the vertical center of the 24x24 viewBox, confirming it points right rather than left/down", () => {
  const match = source.match(/const ICON_SEND = `<svg viewBox="0 0 24 24"[^`]*?<path d="([^"]+)"/);
  assert.ok(match, "ICON_SEND path data must be extractable");
  const d = match[1];
  const numbers = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const points = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  const rightmost = points.reduce((a, b) => (b[0] > a[0] ? b : a));
  assert.equal(rightmost[0], 23, "the tip (rightmost x) should be at x=23");
  assert.equal(rightmost[1], 12, "the tip should be vertically centered (y=12) in the 24-tall viewBox");
});

test("the Send button is not rotated as a whole - only ICON_SEND's own path data changed, .message-send-button carries no transform/rotate rule", () => {
  const css = cssSource();
  assert.ok(!/\.message-send-button\s*\{[^}]*transform/.test(css), "the button itself must not be rotated - only the icon's path was corrected");
});

test("mobile Send button stays a circular >=44x44px icon-only button with aria-label, no text label added", () => {
  const css = cssSource();
  const mediaStart = css.indexOf("@media (max-width: 760px) {");
  const mediaEnd = css.indexOf("\n}\n\n.panel-status", mediaStart);
  const block = css.slice(mediaStart, mediaEnd);
  const body = ruleBody(block, ".message-send-button {");
  assert.match(body, /width:\s*44px;/);
  assert.match(body, /height:\s*44px;/);
  assert.match(body, /border-radius:\s*50%;/, "button must actually render circular, not just be 44x44 square - the mobile rule must be scoped specifically enough (e.g. .message-compose .message-send-button) to beat .plain-button's later, equal-specificity border-radius: var(--radius) in the cascade");
  const composeBody = sliceFunction("renderConversationHtml", 3800);
  assert.ok(!/message-send-button"[^>]*>\s*Send\s*</.test(composeBody), "the button must stay icon-only, never gaining literal 'Send' text");
});

test("desktop and mobile share the exact same Send button markup (single source, no separate desktop text button that needs preserving)", () => {
  const composeBody = sliceFunction("renderConversationHtml", 3800);
  const sendButtonMatches = composeBody.match(/class="plain-button compact-button message-send-button"/g) || [];
  assert.equal(sendButtonMatches.length, 1, "there must be exactly one Send button rendered - the same markup serves both desktop and mobile via CSS, not a duplicated desktop-only button");
});

// === Compact list scenarios (1, 2, 20 conversations) ===
// renderConversationRow/renderMessagePanelHtml are pure string-template
// functions with no per-row inline height - the actual "does it stay
// compact" behavior is entirely CSS-driven (asserted above via
// align-content/overflow/min-height), so these confirm the row markup
// itself carries no inline sizing that could fight the CSS fix.

test("renderConversationRow never sets an inline height/flex-grow style that could override the CSS-driven compact row height", () => {
  const start = source.indexOf("function renderConversationRow(");
  assert.ok(start >= 0);
  const body = source.slice(start, start + 900);
  assert.ok(!/style="[^"]*height/.test(body), "no inline height style should exist on a conversation row");
});

test("the same .message-row markup is reused regardless of conversation count - list length only changes how many rows are joined, never their template", () => {
  const start = source.indexOf("function renderMessagePanelHtml(");
  assert.ok(start >= 0);
  const body = source.slice(start, start + 1800);
  assert.match(body, /\.map\(renderConversationRow\)\.join\(""\)|rows\.map\(/);
});

// === Search input wiring (structural checks - real event-dispatch behavior
// is covered by mobile-messages.search.test.mjs's jsdom-based tests) ===
// #messagePanel lives in the topbar's <header>, not inside #content, so
// app.js's single delegated `input` listener on els.content (handleContentInput)
// could never see the search input's events. The fix moves that handling
// into messages.js's own exported handleMessagesPanelInput, wired as a
// SEPARATE, equally one-time delegated listener directly on els.messagePanel
// inside bindEvents() (called once at startup) - never re-added per render.

function appSource() {
  const appPath = fileURLToPath(new URL("../app.js", import.meta.url));
  return readFileSync(appPath, "utf8");
}

test("app.js: handleContentInput no longer contains the dead message-search branch (it could never fire - #messagePanel is outside #content)", () => {
  const app = appSource();
  const start = app.indexOf("function handleContentInput(");
  assert.ok(start >= 0, "handleContentInput must exist");
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.ok(!body.includes("data-message-search"), "the dead branch must be removed from handleContentInput, not left as unreachable code");
});

test("app.js: bindEvents() wires handleMessagesPanelInput as exactly one delegated listener directly on els.messagePanel", () => {
  const app = appSource();
  const bindStart = app.indexOf("function bindEvents(");
  assert.ok(bindStart >= 0);
  const bindEnd = app.indexOf("\n}\n", bindStart);
  const body = app.slice(bindStart, bindEnd);
  const matches = body.match(/els\.messagePanel\?\.addEventListener\("input", handleMessagesPanelInput\)/g) || [];
  assert.equal(matches.length, 1, "must be wired exactly once, inside bindEvents() which itself runs exactly once at startup - never inside a render function");
});

test("app.js: handleMessagesPanelInput is never passed to addEventListener anywhere outside bindEvents() - proves no render path re-adds it", () => {
  const app = appSource();
  const wiringCalls = app.match(/addEventListener\([^)]*handleMessagesPanelInput\)/g) || [];
  assert.equal(wiringCalls.length, 1, `expected exactly one addEventListener(...) call wiring handleMessagesPanelInput, found ${wiringCalls.length}`);
});

test("app.js: signOut() calls resetMessagesState() before its hard reload, so a typed search can never survive into the next login", () => {
  const app = appSource();
  const start = app.indexOf("async function signOut(");
  assert.ok(start >= 0);
  const body = app.slice(start, app.indexOf("\n}\n", start));
  assert.match(body, /resetMessagesState\(\);\s*\n\s*window\.location\.replace\("\/"\);/, "resetMessagesState() must run before the reload");
});

test("app.js: the login submit handler calls resetMessagesState() defensively, mirroring the existing organization.data/clearAllViewCache reset there", () => {
  const app = appSource();
  const loginIdx = app.indexOf('const form = event.target.closest("#loginForm");');
  assert.ok(loginIdx >= 0);
  const body = app.slice(loginIdx, loginIdx + 1500);
  const orgResetIdx = body.indexOf("state.organization.data = null;");
  const messagesResetIdx = body.indexOf("resetMessagesState();");
  assert.ok(orgResetIdx >= 0 && messagesResetIdx > orgResetIdx, "resetMessagesState() must be called alongside the existing defensive per-login resets");
});

// === Participant avatars ===
// Live-DOM rendering behavior (which element renders, src/alt/data-initials
// values) is covered by mobile-messages.avatars.test.mjs's jsdom tests.
// These are the parts only reachable via source inspection: app.js's
// runtime image-error fallback (never fires in the jsdom tests since jsdom
// doesn't actually fetch/fail image loads) and the CSS sizing contract.

test("app.js: handleImageError has a .message-avatar-photo branch that rebuilds the initials fallback from data-initials, not alt", () => {
  const app = appSource();
  const start = app.indexOf('if (image.classList.contains("message-avatar-photo")) {');
  assert.ok(start >= 0, "handleImageError must special-case a failed message-avatar-photo load");
  const body = app.slice(start, start + 300);
  assert.match(body, /fallback\.className = "message-avatar";/);
  assert.match(body, /fallback\.textContent = image\.dataset\.initials \|\| "\?";/);
  assert.match(body, /image\.replaceWith\(fallback\);/);
});

test("messages.js: renderAvatarMarkup renders alt=\"\" (decorative) with the real initials carried via data-initials", () => {
  const start = source.indexOf("function renderAvatarMarkup(");
  assert.ok(start >= 0);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /alt=""/);
  assert.match(body, /data-initials="\$\{escapeAttr\(initialsText\)\}"/);
});

test("styles.css: the photo avatar uses object-fit: cover and shares the base .message-avatar circular sizing", () => {
  const css = cssSource();
  const baseBody = ruleBody(css, ".message-avatar {");
  assert.match(baseBody, /border-radius:\s*50%;/, "the avatar (photo or initials) must be circular");
  const photoBody = ruleBody(css, ".message-avatar-photo {");
  assert.match(photoBody, /object-fit:\s*cover;/);
});

test("styles.css: .message-row's avatar column is sized to 44px, matching the .message-row .message-avatar override", () => {
  const css = cssSource();
  const rowBody = ruleBody(css, ".message-row {");
  assert.match(rowBody, /grid-template-columns:\s*44px/, "the fixed first grid column must match the enlarged list avatar, or it would be clipped/misaligned");
  const rowAvatarBody = ruleBody(css, ".message-row .message-avatar {");
  assert.match(rowAvatarBody, /width:\s*44px;/);
  assert.match(rowAvatarBody, /height:\s*44px;/);
});
