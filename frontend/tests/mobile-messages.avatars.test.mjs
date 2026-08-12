import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// hotfix/mobile-messages-test-regression: real-DOM tests for participant
// avatars (photo vs initials) in the mobile conversation list and the
// thread header - same jsdom rationale as mobile-messages.search.test.mjs:
// whether the right element type (<img> vs <span>) with the right
// src/alt/data-initials actually renders is real behavior, not something a
// regex over the source text can prove.

const dom = new JSDOM(`<!doctype html><html><body>
  <button id="messageToggle" hidden><span data-message-count hidden>0</span></button>
  <div id="messagePanel" hidden></div>
</body></html>`);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
dom.window.matchMedia = (query) => ({
  matches: query.includes("min-width: 761px"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

const { els } = await import("../dom.js");
const { state } = await import("../state.js");
const { renderMessages } = await import("../messages.js");
const { imageSources } = await import("../media.js");

// hotfix/messages-avatar-display: the exact URL SHAPE a real athlete row's
// athletes.image_url actually has in this app - a Google Drive "share"
// link produced by Drive's own "Copy link" action, not a fabricated
// "example.test" URL. Requesting this URL directly as an <img src> fails
// (it's a Drive viewer page, not raw image bytes) - this is the literal
// bug report: the photo shows correctly in Athlete/Coach profile (which
// already runs every image URL through media.js's imageSources() before
// using it) but showed initials in Messages (which used to put this raw
// URL straight into <img src> with no transform and no fallback).
const REAL_DRIVE_SHARE_URL = "https://drive.google.com/file/d/1tgQ7FfupKdaW_fr1N48A4acLqyb-1Ylh/view?usp=drive_link";

function rowWithParticipant(id, participant, overrides = {}) {
  return {
    id,
    participants: [{ userId: "viewer-1", name: "Viewer", email: "viewer@example.com" }, participant],
    last_message: "hello",
    last_message_created_at: "2026-01-01T10:00:00Z",
    unread_count: 0,
    ...overrides,
  };
}

beforeEach(() => {
  state.currentUser = { id: "viewer-1" };
  state.messages.open = true;
  state.messages.search = "";
  state.messages.selectedId = "";
  state.messages.detail = null;
  state.messages.rows = [];
});

// === List row: photo vs initials ===

test("a conversation row renders the other participant's photo as an <img> when imageUrl is present", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Ana Anić", email: "ana@example.com", imageUrl: "https://example.test/ana.jpg" })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  assert.ok(img, "an <img class=message-avatar-photo> must render");
  assert.equal(img.tagName, "IMG");
  assert.equal(img.getAttribute("src"), "https://example.test/ana.jpg");
  assert.equal(img.classList.contains("message-avatar"), true, "photo must share the same sizing class as the initials fallback");
});

test("a conversation row renders initials in a <span> when the participant has no imageUrl", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Ben Boskov", email: "ben@example.com", imageUrl: "" })];
  renderMessages();
  const avatar = els.messagePanel.querySelector(".message-row .message-avatar");
  assert.ok(avatar);
  assert.equal(avatar.tagName, "SPAN", "no photo means the fallback initials span, not an <img>");
  assert.equal(avatar.textContent, "BB");
});

test("a conversation row falls back to initials when imageUrl is simply absent from the participant object", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Cveta Cvetkovic", email: "cveta@example.com" })];
  renderMessages();
  const avatar = els.messagePanel.querySelector(".message-row .message-avatar");
  assert.equal(avatar.tagName, "SPAN");
});

// === Thread header: photo vs initials ===

function openThreadWith(participant) {
  state.messages.selectedId = "c1";
  state.messages.detail = {
    conversation: {
      id: "c1",
      participants: [{ userId: "viewer-1", name: "Viewer", email: "viewer@example.com" }, participant],
    },
    messages: [],
  };
  renderMessages();
}

test("the thread header renders the same participant photo as an <img>", () => {
  openThreadWith({ userId: "u2", name: "Dado Djordjevic", email: "dado@example.com", imageUrl: "https://example.test/dado.jpg" });
  const img = els.messagePanel.querySelector(".message-thread-identity .message-avatar-photo");
  assert.ok(img);
  assert.equal(img.getAttribute("src"), "https://example.test/dado.jpg");
});

test("the thread header renders initials when the participant has no photo", () => {
  openThreadWith({ userId: "u2", name: "Elena Erakovic", email: "elena@example.com", imageUrl: "" });
  const avatar = els.messagePanel.querySelector(".message-thread-identity .message-avatar");
  assert.equal(avatar.tagName, "SPAN");
  assert.equal(avatar.textContent, "EE");
});

// === Broken image load falls back to initials (structural proxy) ===
// app.js's handleImageError (which does the actual DOM swap on a real
// "error" event) cannot be imported here - it calls init() at module scope
// - see mobile-messages.render.test.mjs's source-pattern-guard tests for
// the fallback branch itself. This test proves messages.js emits the data
// handleImageError needs: alt="" (decorative) plus the real initials text
// carried separately via data-initials, so the fallback it builds shows the
// right letters, not "?" or the (empty) alt text.
test("an <img> avatar carries data-initials (not alt) so a failed image load can restore the correct initials", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Filip Filipovic", email: "filip@example.com", imageUrl: "https://example.test/filip.jpg" })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  assert.equal(img.getAttribute("alt"), "", "alt must be empty/decorative - the name is already shown as visible text right next to it");
  assert.equal(img.dataset.initials, "FF");
});

// === Row height stays consistent regardless of photo vs initials (structural proxy) ===
// jsdom has no real layout engine (getBoundingClientRect always returns 0),
// so actual pixel height can't be measured here - see styles.css's
// .message-row/.message-avatar rules and the CSS source-pattern-guard
// tests in mobile-messages.render.test.mjs for the real sizing contract.
// What IS provable here: both the photo and initials variants render as the
// exact same class ("message-avatar"), which is what makes them share
// identical CSS box dimensions.
test("both the photo and initials avatar variants share the identical message-avatar class (same CSS box, same row height)", () => {
  state.messages.rows = [
    rowWithParticipant("c1", { userId: "u2", name: "With Photo", email: "wp@example.com", imageUrl: "https://example.test/wp.jpg" }),
    rowWithParticipant("c2", { userId: "u3", name: "No Photo", email: "np@example.com" }),
  ];
  renderMessages();
  const avatars = els.messagePanel.querySelectorAll(".message-row .message-avatar");
  assert.equal(avatars.length, 2);
  avatars.forEach((el) => assert.ok(el.classList.contains("message-avatar")));
});

// === Google Drive share-link photos (the actual reported bug) ===

test("a conversation row resolves a real Google Drive share-link imageUrl to a fetchable thumbnail src, not the raw un-embeddable viewer URL", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Radovan Pankov", email: "radovan@example.com", imageUrl: REAL_DRIVE_SHARE_URL })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  assert.ok(img, "a Drive share link must still render as an <img>, never silently drop to initials");
  const [expectedSrc] = imageSources(REAL_DRIVE_SHARE_URL);
  assert.equal(img.getAttribute("src"), expectedSrc);
  assert.notEqual(img.getAttribute("src"), REAL_DRIVE_SHARE_URL, "the raw Drive viewer URL is not a fetchable image and must never be used as src directly");
});

test("a conversation row's Drive-link avatar carries the remaining real image endpoints as data-fallbacks, so a failed primary load has somewhere real to go before ever falling back to initials", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Radovan Pankov", email: "radovan@example.com", imageUrl: REAL_DRIVE_SHARE_URL })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  const allSources = imageSources(REAL_DRIVE_SHARE_URL);
  const fallbacks = JSON.parse(img.dataset.fallbacks || "[]");
  assert.deepEqual(fallbacks, allSources.slice(1), "every remaining real Drive image endpoint must be queued, in order");
  assert.equal(fallbacks.length, 2, "a Drive URL resolves to 3 total candidate endpoints (thumbnail, googleusercontent, uc?export=view) - 1 src + 2 fallbacks");
});

test("the thread header resolves the same Drive share-link the same way as the list row", () => {
  openThreadWith({ userId: "u2", name: "Radovan Pankov", email: "radovan@example.com", imageUrl: REAL_DRIVE_SHARE_URL });
  const img = els.messagePanel.querySelector(".message-thread-identity .message-avatar-photo");
  const [expectedSrc] = imageSources(REAL_DRIVE_SHARE_URL);
  assert.equal(img.getAttribute("src"), expectedSrc);
});

test("a plain, already-direct image URL (not a Drive link) is completely unaffected by the Drive transform - same src, no fallbacks queued", () => {
  const directUrl = "https://example.test/direct-photo.jpg";
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Direct Photo", email: "direct@example.com", imageUrl: directUrl })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  assert.equal(img.getAttribute("src"), directUrl);
  assert.equal(img.dataset.fallbacks, undefined, "a non-Drive URL has only one candidate source, so no data-fallbacks attribute should be emitted at all");
});

test("messages.js resolves a Drive share link through the identical imageSources() helper media.js exposes to Athlete Home/Athlete profile/Coach profile - a photo that works there is guaranteed to resolve to the same src here", () => {
  state.messages.rows = [rowWithParticipant("c1", { userId: "u2", name: "Radovan Pankov", email: "radovan@example.com", imageUrl: REAL_DRIVE_SHARE_URL })];
  renderMessages();
  const img = els.messagePanel.querySelector(".message-row .message-avatar-photo");
  const [athleteHomeWouldUse] = imageSources(REAL_DRIVE_SHARE_URL);
  assert.equal(img.getAttribute("src"), athleteHomeWouldUse, "Messages and Athlete Home/profile must resolve the exact same stored URL to the exact same src - one shared transform, not two divergent ones");
});

// === Search and avatars work together ===

test("filtering the list by search still renders the matching row's photo correctly", () => {
  state.messages.rows = [
    rowWithParticipant("c1", { userId: "u2", name: "Goran Gavric", email: "goran@example.com", imageUrl: "https://example.test/goran.jpg" }),
    rowWithParticipant("c2", { userId: "u3", name: "Someone Else", email: "else@example.com" }),
  ];
  state.messages.search = "Gavric";
  renderMessages();
  const rows = els.messagePanel.querySelectorAll(".message-row");
  assert.equal(rows.length, 1);
  const img = rows[0].querySelector(".message-avatar-photo");
  assert.ok(img);
  assert.equal(img.getAttribute("src"), "https://example.test/goran.jpg");
});
