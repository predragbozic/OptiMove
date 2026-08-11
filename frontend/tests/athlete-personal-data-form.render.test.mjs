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

test("the Personal data form exposes exactly firstName, lastName, and imageUrl - no other field name appears as an input", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  const inputNames = [...body.matchAll(/name="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(inputNames, ["firstName", "lastName", "imageUrl"]);
});

test("none of the excluded audit fields (birth date, phone, gender, address, internal IDs, role/status/membership) ever appear in this form", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  for (const forbidden of ["birthDate", "birth_date", "phone", "gender", "country", "city", "addressLine", "address_line", "athleteId", "athlete_id", "userId", "user_id", "clubId", "teamId", "isActive", "is_active", "role", "email"]) {
    assert.ok(!body.includes(`name="${forbidden}"`), `${forbidden} must never be an editable field name in the Personal data form`);
  }
});

test("the imageUrl field is presented as a URL input, not disguised as a real upload widget", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.match(body, /name="imageUrl"[^>]*type="url"/);
});

test("the form submits via data-account-form='personal-data', the exact hook app.js's handleContentSubmit listens for", () => {
  const body = sliceFunction("renderPersonalDataFormHtml");
  assert.ok(body.includes(`data-account-form="personal-data"`));
});

test("the Personal data article sits structurally before the separate Login email and Change password account cards, and is clearly its own section", () => {
  const settingsBody = sliceFunction("renderAthleteSettingsHtml");
  const personalIndex = settingsBody.indexOf("athlete-personal-data");
  const loginIndex = settingsBody.indexOf("Login email");
  const passwordIndex = settingsBody.indexOf("Change password");
  assert.ok(personalIndex >= 0 && loginIndex > personalIndex && passwordIndex > loginIndex);
});

test("renderAthleteSettingsHtml passes the new profile parameter straight into renderPersonalDataFormHtml - no separate fetch or fabricated data inline", () => {
  const settingsBody = sliceFunction("renderAthleteSettingsHtml");
  assert.match(settingsBody, /renderPersonalDataFormHtml\(profile\)/);
});

test("the Login email card still reads strictly from currentUser.email, untouched by the new profile parameter", () => {
  const settingsBody = sliceFunction("renderAthleteSettingsHtml");
  assert.ok(settingsBody.includes("currentUser?.email"));
});
