import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// feature/athlete-programs-profile: app.js runs init() (full DOM/session/
// network wiring) at import time, so - like every other app.js test in
// this suite - it is never imported directly. These are source-pattern-
// guard tests over the raw text confirming: the athlete-card branch in
// renderProgramToolbar leaves the coach chip toolbar untouched; the search
// input never triggers a fetch (pure in-memory re-render); the
// personal-data submit handler PATCHes the narrow athlete-profile
// endpoint, invalidates the Home cache, and re-renders in place; and the
// Weekly plan quick-action label change didn't leave a second "Calendar"
// route lying around.

const filePath = fileURLToPath(new URL("../app.js", import.meta.url));
const appJsSource = readFileSync(filePath, "utf8");

function sliceFunction(name, windowSize = 1400) {
  const start = appJsSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in app.js`);
  return appJsSource.slice(start, start + windowSize);
}

test("renderProgramToolbar branches on isAthleteMode() before ever touching the coach chip toolbar", () => {
  const body = sliceFunction("renderProgramToolbar");
  const athleteBranchIndex = body.indexOf("if (isAthleteMode())");
  const chipToolbarIndex = body.indexOf("renderProgramToolbarHtml(programs, state.selectedProgramId, renderPlanMoreMenu)");
  assert.ok(athleteBranchIndex >= 0 && chipToolbarIndex > athleteBranchIndex, "the athlete-card branch must return before reaching the coach chip toolbar render");
});

test("the athlete card branch renders through renderAthleteProgramsPanelHtml/wireAthleteProgramsPanel, not the chip toolbar", () => {
  const body = sliceFunction("renderProgramToolbar");
  assert.ok(body.includes("renderAthleteProgramsPanelHtml("));
  assert.ok(body.includes("wireAthleteProgramsPanel("));
});

test("a zero-program athlete keeps the existing fully-empty state (renderProgramToolbar returns early, no panel/search markup)", () => {
  const body = sliceFunction("renderProgramToolbar");
  assert.match(body, /if \(isAthleteMode\(\)\) \{\s*if \(!programs\.length\) return;/);
});

test("wireAthleteProgramsPanel's search input listener never calls api() or fetch() - filtering is purely in-memory", () => {
  const body = sliceFunction("wireAthleteProgramsPanel");
  const listenerStart = body.indexOf("searchInput.addEventListener(\"input\"");
  assert.ok(listenerStart >= 0);
  const listenerBody = body.slice(listenerStart, listenerStart + 200);
  assert.ok(!listenerBody.includes("api("), "the search keystroke handler must never issue an API request");
  assert.ok(!listenerBody.includes("fetch("));
  assert.ok(listenerBody.includes("state.athleteProgramsSearchQuery = searchInput.value"));
});

test("wireAthleteProgramsPanel only replaces the rail container's innerHTML, never the panel/search input itself - so typing never loses focus", () => {
  const body = sliceFunction("wireAthleteProgramsPanel");
  assert.ok(body.includes("railContainer.innerHTML = renderAthleteProgramCardsRailHtml("));
  assert.ok(!body.includes("panel.innerHTML"), "the whole panel (including the search input) must never be replaced by this wiring");
});

test("clicking an athlete program card reuses the EXACT same state.selectedProgramId + renderProgramRoot flow as the coach chip click - no parallel viewer", () => {
  const body = sliceFunction("wireAthleteProgramsPanel");
  assert.ok(body.includes("state.selectedProgramId = button.dataset.programId;"));
  assert.ok(body.includes("renderProgramRoot(programs.find((program) => program.id === state.selectedProgramId));"));
});

test("the personal-data form handler PATCHes /api/athlete-profile with exactly the 7 allowed fields and no other field", () => {
  const start = appJsSource.indexOf("data-account-form='personal-data'");
  assert.ok(start >= 0);
  const body = appJsSource.slice(start, start + 2200);
  assert.match(body, /api\("\/api\/athlete-profile", \{\s*method: "PATCH",\s*body: JSON\.stringify\(\{ firstName, lastName, birthDate, phone, country, city, imageUrl \}\),/);
});

test("every field read from the personal-data form via formData.get(...) is one of the 7 allowed fields - no stray input can smuggle an extra key into the PATCH body", () => {
  const start = appJsSource.indexOf("data-account-form='personal-data'");
  const body = appJsSource.slice(start, start + 2200);
  const readFields = [...body.matchAll(/formData\.get\("(\w+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(readFields), new Set(["firstName", "lastName", "birthDate", "phone", "country", "city", "imageUrl"]));
});

test("a successful personal-data save invalidates the Home cache (so Home reflects the new name/photo on next visit)", () => {
  const start = appJsSource.indexOf("data-account-form='personal-data'");
  const body = appJsSource.slice(start, start + 2200);
  const patchIndex = body.indexOf("method: \"PATCH\"");
  const invalidateIndex = body.indexOf("invalidateAthleteHomeCache()");
  assert.ok(patchIndex >= 0 && invalidateIndex > patchIndex, "cache invalidation must happen only after the PATCH resolves, not before");
});

test("the personal-data handler guards against a stale re-render after the user has already navigated off Settings", () => {
  const start = appJsSource.indexOf("data-account-form='personal-data'");
  const body = appJsSource.slice(start, start + 2200);
  assert.ok(body.includes('state.activeTab === "athlete-settings"'));
  assert.ok(body.includes('if (state.activeTab !== "athlete-settings") return;'));
});

test("no leftover reference to the old renderAthleteSettings(athlete, currentUser, emailChangeStatus) 3-arg call shape remains", () => {
  assert.ok(!/renderAthleteSettingsHtml\(athlete, state\.currentUser, emailChangeStatus\)(?!,)/.test(appJsSource), "every call site must now pass the 4th profile argument");
});

test("renderAthleteSettings() fetches emailChangeStatus and profile in parallel and guards the re-render against a slow response after navigating away", () => {
  const body = sliceFunction("renderAthleteSettings");
  assert.ok(body.includes("Promise.all(["));
  assert.ok(body.includes('api("/api/athlete-profile")'));
  assert.ok(body.includes('if (state.activeTab !== "athlete-settings") return;'));
});
