// Design (header panels): the real renderNotifications() / renderMessages() fit an open panel to the
// window, and the window's resize listener exists even when the first fit skipped a full-screen
// panel (messages opened on an upright phone, then the phone is turned sideways). Its own file: the
// listener is installed once per process.
import { test } from "node:test";
import assert from "node:assert/strict";

let width = 390;
let messagesPosition = "fixed";
const listeners = {};
globalThis.addEventListener = (type, handler) => { listeners[type] = handler; };

// A panel anchored on its button: its box moves with style.translate, as a browser lays it out.
function fakePanel(left, boxWidth) {
  let html = "";
  return {
    hidden: true,
    dataset: {},
    style: {},
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; },
    querySelector: () => null,
    getBoundingClientRect() {
      const shift = parseFloat(this.style.translate) || 0;
      return { left: left + shift, right: left + shift + boxWidth, width: boxWidth };
    },
  };
}
const notificationPanel = fakePanel(236, 314); // the bell's panel on a 390 px phone
const messagePanel = fakePanel(-144, 736); // the messages panel at 768 px
const toggle = () => ({ hidden: false, querySelector: () => null });
const ids = { "#notificationPanel": notificationPanel, "#messagePanel": messagePanel, "#notificationToggle": toggle(), "#messageToggle": toggle() };
globalThis.document = {
  querySelector: (sel) => ids[sel] || null,
  querySelectorAll: (sel) => (sel === ".notification-panel, .message-panel" ? [notificationPanel, messagePanel] : []),
  body: { classList: { contains: () => false, toggle() {} } },
  documentElement: { get clientWidth() { return width; } },
};
globalThis.window = { matchMedia: () => ({ matches: true }) };
globalThis.getComputedStyle = (el) => ({ position: el === messagePanel ? messagesPosition : "absolute" });

const { renderMessages } = await import("../messages.js");
const { renderNotifications } = await import("../notifications.js");
const { state } = await import("../state.js");
state.currentUser = { id: "coach-1" };

test("messages opened full-screen on an upright phone are fitted once the phone is turned sideways", () => {
  state.messages = { ...state.messages, open: true, rows: [], selectedId: "", loading: false, error: "" };
  renderMessages();
  assert.equal(messagePanel.hidden, false);
  assert.equal(messagePanel.style.translate, "", "full-screen: left alone");
  assert.equal(typeof listeners.resize, "function", "the resize listener exists after a skipped first fit");
  width = 768;
  messagesPosition = "absolute";
  listeners.resize();
  assert.equal(messagePanel.style.translate, "152px 0");
  assert.equal(messagePanel.getBoundingClientRect().left, 8);
});

test("renderNotifications fits the open panel on a phone, and a closed one keeps no shift", () => {
  width = 390;
  state.notifications = { open: true, rows: [], unreadCount: 0, loading: false, error: "" };
  renderNotifications();
  assert.equal(notificationPanel.style.translate, "-168px 0");
  assert.equal(notificationPanel.getBoundingClientRect().right, 382);
  state.notifications = { ...state.notifications, open: false };
  renderNotifications();
  assert.equal(notificationPanel.hidden, true);
  assert.equal(notificationPanel.style.translate, "");
});

test("renderMessages fits the open panel between 761 and 940 px", () => {
  width = 768;
  messagesPosition = "absolute";
  messagePanel.style.translate = "";
  renderMessages();
  assert.equal(messagePanel.style.translate, "152px 0");
});
