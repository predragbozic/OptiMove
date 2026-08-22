import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// feature/athlete-programs-profile: athlete-view.js transitively imports
// organization-view.js -> navigation.js -> dom.js, which touches
// `document` at module scope, so (like app.js elsewhere in this suite) it
// cannot be imported directly under node:test. These are source-pattern-
// guard tests over the raw text of renderAthleteSettingsHtml/
// renderPersonalDataFormHtml instead, the same technique already used for
// app.js throughout this codebase's test suite.

const filePath = fileURLToPath(new URL("../athlete-view.js", import.meta.url));
const source = readFileSync(filePath, "utf8");

function sliceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in athlete-view.js`);
  const nextFunctionStart = source.indexOf("\nfunction ", start + 1);
  const nextExportStart = source.indexOf("\nexport function ", start + 1);
  const candidates = [nextFunctionStart, nextExportStart].filter((i) => i >= 0);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

test("renderPersonalDataFormHtml shows a stable loading message when profile is null/falsy, before any form markup", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  const loadingCheckIndex = body.indexOf("if (!profile)");
  const loadingMessageIndex = body.indexOf("Loading your profile");
  const formMarkupIndex = body.indexOf("data-account-form=\"personal-data\"");
  assert.ok(loadingCheckIndex >= 0 && loadingMessageIndex > loadingCheckIndex, "the null-profile branch must come first and show a loading message");
  assert.ok(formMarkupIndex > loadingMessageIndex, "the real form must only be reachable after the loading branch");
});

test("renderPersonalDataFormHtml shows an explicit error message when profile.error is set, never a blank form", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.ok(body.includes("profile.error"));
  assert.ok(body.includes("Could not load your profile"));
});

test("the Personal data form exposes exactly the 7 audit-approved fields, in order, no other field name appears as an input", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  const inputNames = [...body.matchAll(/name="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(inputNames, ["firstName", "lastName", "birthDate", "phone", "country", "city", "imageUrl"]);
});

test("none of the still-excluded audit fields (gender, address line, cover photo, contact email, internal IDs, role/status/membership) ever appear in this form", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  for (const forbidden of ["gender", "addressLine", "address_line", "coverImageUrl", "cover_image_url", "athleteId", "athlete_id", "userId", "user_id", "clubId", "teamId", "isActive", "is_active", "role", "email"]) {
    assert.ok(!body.includes(`name="${forbidden}"`), `${forbidden} must never be an editable field name in the Personal data form`);
  }
});

test("birthDate is a real date input capped at today - no future date can even be picked in the browser", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.match(body, /name="birthDate"[^>]*type="date"/);
  assert.match(body, /name="birthDate"[^>]*max="\$\{escapeAttr\(todayIsoUtc\(\)\)\}"/);
});

test("phone has no format/pattern restriction imposed - just a length cap matching the real DB column", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  const phoneInputMatch = body.match(/<input name="phone"[^>]*>/);
  assert.ok(phoneInputMatch);
  assert.ok(!phoneInputMatch[0].includes("pattern="), "no regex pattern attribute may constrain phone to one country's format");
  assert.match(phoneInputMatch[0], /maxlength="50"/);
});

test("country and city are plain trimmed text fields capped at the real 100-character DB column limit", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.match(body, /name="country"[^>]*maxlength="100"/);
  assert.match(body, /name="city"[^>]*maxlength="100"/);
});

test("the imageUrl field is labeled 'Profile photo URL' and presented as a URL input, never as 'Upload photo' or disguised as a real upload widget", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.match(body, /name="imageUrl"[^>]*type="url"/);
  assert.ok(body.includes("Profile photo URL"));
  assert.ok(!/>\s*Upload photo\s*</.test(body), "must never claim to be a real upload");
  assert.ok(body.toLowerCase().includes("no photo upload"), "must disclose that this is a temporary URL-only workaround");
});

test("the form submits via data-account-form='personal-data', the exact hook app.js's handleContentSubmit listens for", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.ok(body.includes(`data-account-form="personal-data"`));
});

test("the Personal data article sits structurally before the shared Login email/Change password account sections", () => {
  // renderAccountEmailPasswordSectionsHtml (Login email + Change password) is
  // shared with the coach Account page (coach-account.js), so it's its own
  // exported function now, called from here rather than inlined - the
  // Personal data article must still come first, then the call into it.
  const settingsBody = sliceFunction("renderAthleteSettingsHtml");
  const personalIndex = settingsBody.indexOf("athlete-personal-data");
  const sharedSectionsCallIndex = settingsBody.indexOf("renderAccountEmailPasswordSectionsHtml(currentUser, emailChangeStatus)");
  assert.ok(personalIndex >= 0 && sharedSectionsCallIndex > personalIndex);
});

test("renderAthleteSettingsHtml passes the new profile parameter straight into renderPersonalDataFormHtml - no separate fetch or fabricated data inline", () => {
  const settingsBody = sliceFunction("renderAthleteSettingsHtml");
  assert.match(settingsBody, /renderPersonalDataFormHtml\(profile\)/);
});

test("within the shared account sections, Login email still comes before Change password, and reads strictly from currentUser.email", () => {
  const sharedBody = sliceFunction("renderAccountEmailPasswordSectionsHtml");
  const loginIndex = sharedBody.indexOf("Login email");
  const passwordIndex = sharedBody.indexOf("Change password");
  assert.ok(loginIndex >= 0 && passwordIndex > loginIndex);
  assert.ok(sharedBody.includes("currentUser?.email"));
});
