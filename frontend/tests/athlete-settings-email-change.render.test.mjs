import { test } from "node:test";
import assert from "node:assert/strict";

// security/verified-email-change: renderAthleteSettingsHtml no longer emits
// a single combined "credentials" form - it's split into a read-only
// current-email display + an email-change-request/pending-status panel, and
// a completely separate password-change form. These tests pin that shape
// down so a future edit can't silently reintroduce the old combined form or
// blur the Login email / Change password labeling the spec requires.

// athlete-view.js imports organization-view.js (for ICON_ADD_ATHLETE), which
// in turn pulls in navigation.js -> dom.js, reading `document.querySelector`
// at module load time - see organization-view.render.test.mjs for the fuller
// explanation of this same stub.
globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
};

const { renderAthleteSettingsHtml } = await import("../athlete-view.js");

const athlete = { athlete: "Test Athlete", athlete_id: "AT001" };
const currentUser = { email: "athlete@test.local" };

test("the old combined data-account-form='credentials' form no longer exists anywhere in Settings", () => {
  const html = renderAthleteSettingsHtml(athlete, currentUser, null);
  assert.ok(!html.includes(`data-account-form="credentials"`), "the combined email+password form must be fully removed");
});

test("with no pending request, renders the current login email read-only and a separate email-change-request form", () => {
  const html = renderAthleteSettingsHtml(athlete, currentUser, null);
  assert.ok(html.includes("Login email"), "must clearly label the login email, never just 'Email'");
  assert.ok(html.includes(currentUser.email), "must show the current login email");
  assert.ok(html.includes(`data-account-form="email-change-request"`), "must render the request form when nothing is pending");
  assert.ok(html.includes(`name="newEmail"`));
  assert.ok(html.includes(`name="currentPassword"`), "the request form must require the current password");
  assert.ok(!html.includes(`data-action="email-change-resend"`), "no pending banner/actions when there is nothing pending");
});

test("with a pending request, renders the pending banner (not the request form) with Resend/Cancel and the new address", () => {
  const pending = { pending: true, newEmail: "new@test.local", expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(), requestSource: "self" };
  const html = renderAthleteSettingsHtml(athlete, currentUser, pending);
  assert.ok(html.includes("has not changed yet"), "must clearly state the login email has not changed yet");
  assert.ok(html.includes("new@test.local"), "must show the pending new address");
  assert.ok(html.includes(`data-action="email-change-resend"`));
  assert.ok(html.includes(`data-action="email-change-cancel"`));
  assert.ok(!html.includes(`data-account-form="email-change-request"`), "the request form must not show while a request is already pending");
});

test("Change password is a fully separate form that never includes an email field", () => {
  const html = renderAthleteSettingsHtml(athlete, currentUser, null);
  assert.ok(html.includes("Change password"));
  assert.ok(html.includes(`data-account-form="password-change"`));
  const passwordFormStart = html.indexOf(`data-account-form="password-change"`);
  const passwordFormEnd = html.indexOf("</form>", passwordFormStart);
  const passwordFormHtml = html.slice(passwordFormStart, passwordFormEnd);
  assert.ok(!passwordFormHtml.includes(`name="newEmail"`), "the password form must never contain an email field, even in markup");
  assert.ok(passwordFormHtml.includes(`name="currentPassword"`));
  assert.ok(passwordFormHtml.includes(`name="newPassword"`));
  assert.ok(passwordFormHtml.includes(`name="confirmNewPassword"`), "must require confirming the new password client-side");
});
