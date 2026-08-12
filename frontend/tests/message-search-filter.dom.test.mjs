import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// fix/message-search-filter-not-wired: the previous mobile-messages test
// suite (mobile-messages.render.test.mjs) is entirely source-pattern-guard -
// it confirms handleContentInput's [data-message-search] branch exists as
// text in app.js, but never actually dispatches a DOM event through the
// real page structure. That's exactly how a real bug slipped through: the
// listener was attached to els.content (`#content`), but `#messagePanel`
// lives inside `<header class="topbar">`, a sibling of `#content` under
// `<main class="workspace">` - see frontend/index.html - so an "input"
// event typed into the search box could never bubble to a listener sitting
// on `#content`. Typed text updated the input's own value (the DOM does
// that natively) but state.messages.search and the rendered rows never
// moved.
//
// This suite loads the REAL index.html into jsdom (not a hand-built
// fixture), imports the REAL app.js/messages.js/dom.js/state.js modules
// against that document, and dispatches genuine bubbling DOM events - the
// same mechanism a real keystroke uses - so a regression of "handler
// attached to the wrong ancestor" fails here the way it should have the
// first time.

const frontendDir = fileURLToPath(new URL("..", import.meta.url));
const indexHtml = readFileSync(`${frontendDir}/index.html`, "utf8");

let dom;
let els;
let state;
let renderMessages;

before(async () => {
  dom = new JSDOM(indexHtml, { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom;

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Event = window.Event;
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);

  // jsdom implements neither of these - app.js calls both unconditionally
  // during init()/bindEvents(), so without a stub the import itself throws.
  window.matchMedia = window.matchMedia || (() => ({
    matches: false,
    media: "",
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));

  // api.js calls the bare `fetch(...)` global - stubbed here so init()'s
  // loadSession() (GET /api/auth/me) resolves instead of hitting the
  // network or throwing on an unparsable relative URL. Signed-out is fine:
  // this suite drives state.currentUser/state.messages directly afterwards,
  // it never depends on the real login flow.
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ user: null }),
  });

  // app.js's own top-level `init()` call is fire-and-forget (not awaited),
  // but bindEvents() is its first statement with no prior `await`, so by
  // the time this dynamic import's promise settles, the real event
  // listeners (including the one this test exists to prove) are already
  // wired to the real DOM nodes parsed from index.html above.
  await import("../app.js");
  ({ els } = await import("../dom.js"));
  ({ state } = await import("../state.js"));
  ({ renderMessages } = await import("../messages.js"));

  // Let loadSession()'s stubbed fetch promise (and its .then chain) drain
  // before this suite starts overwriting state itself.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

function seedTwoConversations() {
  state.currentUser = { id: "coach-1" };
  state.messages.open = true;
  state.messages.loading = false;
  state.messages.error = "";
  state.messages.search = "";
  state.messages.selectedId = "";
  state.messages.detail = null;
  state.messages.unreadCount = 0;
  state.messages.rows = [
    {
      id: "c1",
      participants: [{ userId: "a1", name: "Alice Athlete", email: "alice@example.com" }],
      last_message: "Great job on today's session",
    },
    {
      id: "c2",
      participants: [{ userId: "a2", name: "Bob Runner", email: "bob@example.com" }],
      last_message: "See you tomorrow",
    },
  ];
  renderMessages();
}

test("index.html: #messagePanel is not a descendant of #content (the structural root cause) - guards against this ever silently regressing", () => {
  const content = dom.window.document.querySelector("#content");
  const messagePanel = dom.window.document.querySelector("#messagePanel");
  assert.ok(content, "#content must exist");
  assert.ok(messagePanel, "#messagePanel must exist");
  assert.equal(content.contains(messagePanel), false, "#messagePanel must not be inside #content - any listener meant to react to it must be attached elsewhere");
});

test("typing into the real search input filters the real rendered conversation rows, via a genuine bubbling DOM event", () => {
  seedTwoConversations();

  const searchInput = els.messagePanel.querySelector("[data-message-search]");
  assert.ok(searchInput, "the rendered panel must contain the search input");
  assert.equal(els.messagePanel.querySelectorAll(".message-row").length, 2, "both conversations render before any search is typed");

  searchInput.value = "alice";
  searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true, cancelable: true }));

  assert.equal(state.messages.search, "alice", "the keystroke must update state.messages.search");
  const rows = els.messagePanel.querySelectorAll(".message-row");
  assert.equal(rows.length, 1, "the row list must actually be filtered down, not just have state updated");
  assert.match(rows[0].textContent, /Alice/);
});

test("clearing the real search input restores every row", () => {
  seedTwoConversations();
  const searchInput = els.messagePanel.querySelector("[data-message-search]");

  searchInput.value = "bob";
  searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true, cancelable: true }));
  assert.equal(els.messagePanel.querySelectorAll(".message-row").length, 1);

  const liveInput = els.messagePanel.querySelector("[data-message-search]");
  liveInput.value = "";
  liveInput.dispatchEvent(new dom.window.Event("input", { bubbles: true, cancelable: true }));
  assert.equal(els.messagePanel.querySelectorAll(".message-row").length, 2, "clearing the box must show every conversation again");
});

test("a search matching nothing shows the real empty-results message, not a blank or unfiltered list", () => {
  seedTwoConversations();
  const searchInput = els.messagePanel.querySelector("[data-message-search]");
  searchInput.value = "nobody-matches-this";
  searchInput.dispatchEvent(new dom.window.Event("input", { bubbles: true, cancelable: true }));

  assert.equal(els.messagePanel.querySelectorAll(".message-row").length, 0);
  assert.match(els.messagePanel.textContent, /No conversations match this search\./);
});

// === Other data-message-* interactions: confirmed NOT to share this bug ===
// app.js wires clicks (handleGlobalClick -> handleMessageAction) and form
// submits (handleGlobalSubmit -> submitMessageForm) on `document` itself,
// not on els.content - and `document` is a real ancestor of #messagePanel,
// unlike #content. These two tests dispatch genuine bubbling events the
// same way the search test above does, to prove that in practice rather
// than by re-reading the wiring.

test("clicking the real 3-dot menu button (data-action=message-menu-toggle) opens the dropdown, via a genuine bubbling click", async () => {
  seedTwoConversations();
  state.messages.selectedId = "c1";
  state.messages.detail = { conversation: state.messages.rows[0], messages: [] };
  renderMessages();

  const menuButton = els.messagePanel.querySelector('[data-action="message-menu-toggle"]');
  assert.ok(menuButton, "the thread header's overflow-menu button must be rendered");
  assert.equal(state.messages.menuOpen, false);

  menuButton.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  // handleGlobalClick awaits handleWorkspaceAction()/handleNotificationAction()
  // before it ever reaches handleMessageAction() - each await is a real
  // microtask suspension, so (unlike the synchronous input-event tests
  // above) the state change lands a few ticks after dispatchEvent returns,
  // not in the same tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.messages.menuOpen, true, "the click must actually reach handleMessageAction and flip menuOpen");
  const dropdown = els.messagePanel.querySelector(".message-thread-menu-dropdown");
  assert.equal(dropdown.hasAttribute("hidden"), false, "the dropdown must be visible in the re-rendered DOM");
});

test("submitting the real compose form (data-message-form) reaches submitMessageForm, via a genuine bubbling submit event", async () => {
  seedTwoConversations();
  state.messages.selectedId = "c1";
  state.messages.detail = { conversation: state.messages.rows[0], messages: [] };
  renderMessages();

  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/messages") && options?.method === "POST") {
      sentBody = JSON.parse(options.body).body;
      return { ok: true, status: 200, json: async () => ({ id: "m1" }) };
    }
    return { ok: true, status: 200, json: async () => ({ conversation: state.messages.rows[0], messages: [] }) };
  };

  const form = els.messagePanel.querySelector("[data-message-form]");
  assert.ok(form, "the compose form must be rendered for an open, unblocked conversation");
  const input = form.querySelector("[name='body']");
  input.value = "hello from a real submit event";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentBody, "hello from a real submit event", "the submit event must actually reach submitMessageForm and post the typed body");
});
