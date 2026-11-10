import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// L1 + C1 ("small screens"): the sign-in cards get the app's logo, an accent main action and 44 px fields, buttons and
// links, by CSS alone; the coach directory drops the marketplace promise and says what a profile does. Browser proof:
// e2e/tests/small-screens.test.mjs.
const bodyClasses = new Set();
globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: (c) => bodyClasses.has(c) } } };
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const l1 = css.slice(css.indexOf("Design L1: the sign-in screens"), css.indexOf("/* End of design L1. */"));
const c1 = css.slice(css.indexOf("Design C1:"), css.indexOf("/* End of design C1. */"));

test("L1 is scoped to the sign-in screens and uses only the app's existing logo", () => {
  assert.ok(l1.length > 0);
  const selectors = l1.split("\n").filter((l) => /^[^\s/*].*\{$/.test(l));
  assert.ok(selectors.length >= 5);
  for (const s of selectors) assert.ok(s.startsWith("body.login-mode .login-form"), s);
  assert.match(l1, /background: url\("\.\/brand-logo\.png"\) center \/ contain no-repeat;/);
  const urls = l1.match(/url\(/g) || [];
  assert.equal(urls.length, 1, "no other image");
});

test("L1: 44 px fields, buttons and links; the card's own main action is the accent button", () => {
  assert.match(l1, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\) \{\n  min-height: var\(--om-tap-target\);/);
  assert.match(l1, /\.login-form \.plain-button \{[^}]*min-height: var\(--om-tap-target\);/);
  assert.match(l1, /\.login-form > \.plain-button:not\(\.compact-button\) \{\n  border-color: var\(--accent\);\n  background: var\(--accent\);\n  color: #fff;/);
  assert.match(l1, /\.login-form \.muted > a \{[^}]*min-height: var\(--om-tap-target\);/);
});

test("L1 changes no sign-in markup or wording", () => {
  const auth = readFileSync(new URL("../auth-actions.js", import.meta.url), "utf8");
  assert.ok(auth.includes('<button class="plain-button" type="submit">Sign in</button>'));
  assert.ok(auth.includes('<p class="muted"><a href="/forgot-password">Forgot password?</a></p>'));
});

test("C1: the directory promises no marketplace and says what a profile does; its button is 44 px", async () => {
  assert.match(c1, /body:not\(\.login-mode\) \.coach-directory-head \.plain-button \{\n  min-height: var\(--om-tap-target\);/);
  const { renderCoachesHtml } = await import("../coach-profiles.js");
  const { state } = await import("../state.js");
  const render = (user) => renderCoachesHtml({ coaches: { rows: [] }, currentUser: user, programInfo: null, renderProgramInfoModal: () => "", renderTemplatePreviewModal: () => "" });
  state.currentUser = { id: "c1", role: "coach", activeWorkspace: { type: "team" } };
  const coach = render(state.currentUser);
  assert.ok(!/marketplace/i.test(coach.slice(0, coach.indexOf("coach-card-grid"))), "no marketplace promise in the head");
  assert.ok(!coach.includes("Expert directory"));
  assert.match(coach, /The coaches you can see, with their specialties and programs\./);
  assert.match(coach, /data-action="coach-edit-toggle">Create my profile</);
  assert.match(coach, /No coach profiles yet\. Your profile shows your specialties and programs to the athletes and coaches who can see it\./);
  bodyClasses.add("athlete-mode");
  const athlete = render({ id: "a1", role: "athlete", activeWorkspace: { type: "athlete" } });
  bodyClasses.delete("athlete-mode");
  assert.ok(!athlete.includes("coach-edit-toggle"));
  assert.match(athlete, /No coach profiles to show yet\./);
  assert.ok(!athlete.includes("Your profile shows"), "an athlete is not told about a profile of their own");
});
