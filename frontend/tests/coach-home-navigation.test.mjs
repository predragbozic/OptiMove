import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderCoachHomeHtml, renderCoachHomeAthleteRows } = await import("../coach-home.js");
const { loadCoachHome } = await import("../coach-home-data.js");
const { state } = await import("../state.js");
const rows = [{ athleteId: "17", athleteUuid: "uuid-17", athlete: "Ana Test", hasTrainingToday: true, sessionCount: 1 }, { athleteId: "18", athleteUuid: "uuid-18", athlete: "Marko Test", hasTrainingToday: false }];
beforeEach(() => { state.currentUser = { id: "coach", activeWorkspace: { type: "private_coach" } }; });

test("Home offers two workflows without listing every athlete", () => {
  const html = renderCoachHomeHtml({ rows, user: state.currentUser });
  assert.match(html, /Training Plan/);
  assert.match(html, /Training Load/);
  assert.match(html, /1 \/ 2 athletes training/);
  assert.doesNotMatch(html, /Ana Test|Marko Test|<dialog/);
});
test("Home Training Load uses the Data & Analysis bars and trend icon", () => {
  const html = renderCoachHomeHtml({ rows, user: state.currentUser });
  const icon = html.match(/data-mode="load">(<svg.*?<\/svg>)/)?.[1];
  assert.ok(icon);
  assert.match(icon, /aria-hidden="true"/);
  for (const path of ["M4 12l5-5 5 3 5-4", "M4 21v-6", "M9 21v-9", "M14 21v-7", "M19 21v-11"]) {
    assert.ok(icon.includes(`d="${path}"`));
  }
  assert.equal((icon.match(/<circle /g) || []).length, 4);
});
test("Today opens a searchable list limited to athletes training today", () => {
  const html = renderCoachHomeHtml({ rows, user: state.currentUser, picker: { mode: "today" } });
  assert.match(html, /<button class="coach-home-today".*data-mode="today"/);
  assert.match(html, /id="coachHomePickerTitle">Today/);
  assert.match(html, /data-mode="today" data-athlete-id="17"/);
  assert.doesNotMatch(html, /Marko Test/);
  assert.match(renderCoachHomeAthleteRows(rows, { mode: "today", query: "ana" }), /Ana Test/);
  assert.match(renderCoachHomeAthleteRows(rows, { mode: "today", query: "Marko" }), /No athletes match/);
  assert.match(renderCoachHomeAthleteRows([rows[1]], { mode: "today" }), /No athletes have a session scheduled today/);
  assert.match(renderCoachHomeAthleteRows([], { mode: "today" }), /No athletes have a session scheduled today/);
});
test("sidebar and Home Training Load icons have identical paths", () => {
  const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const sidebar = shell.match(/data-library-tab="training-load"[^>]*>[\s\S]*?<svg[^>]*>([\s\S]*?)<\/svg>/)?.[1];
  // The workflow buttons exist only once the roster holds an athlete (an
  // empty roster renders the empty state instead), so the icon is read
  // from a Home with rows.
  const home = renderCoachHomeHtml({ rows, user: state.currentUser }).match(/data-mode="load"><svg[^>]*>(.*?)<\/svg>/)?.[1];
  assert.ok(sidebar);
  assert.ok(home);
  assert.equal(sidebar.trim(), home.trim());
});
test("admin Home shows only available workspaces, no combined roster", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [{ type: "private_coach" }, { type: "club", scopeId: "club-a", label: "My Club" }] };
  const html = renderCoachHomeHtml({ rows, user });
  assert.match(html, /data-workspace-type="private_coach"/);
  assert.match(html, /data-workspace-scope-id="club-a"/);
  assert.doesNotMatch(html, /Ana Test|Marko Test|coach-home-picker-open/);
});
test("admin Home nests available teams under their club and keeps other teams independent", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [
    { type: "platform" }, { type: "private_coach" },
    { type: "team", scopeId: "team-a", clubId: "club-a", label: "First Team" },
    { type: "club", scopeId: "club-a", label: "My Club" },
    { type: "team", scopeId: "solo", clubId: "unavailable-club", label: "Independent Team" },
  ] };
  const dom = new JSDOM(renderCoachHomeHtml({ user }));
  const doc = dom.window.document;
  const nested = doc.querySelector(".coach-home-workspace-teams");
  assert.equal(nested.getAttribute("aria-label"), "My Club teams");
  assert.equal(nested.querySelector("button").dataset.workspaceScopeId, "team-a");
  assert.equal(nested.parentElement.querySelector("button").dataset.workspaceScopeId, "club-a");
  assert.equal(doc.querySelectorAll('[data-workspace-scope-id="team-a"]').length, 1);
  assert.equal(doc.querySelector('[data-workspace-scope-id="solo"]').closest("ul").className, "coach-home-workspaces");
  for (const button of doc.querySelectorAll(".coach-home-workspace")) {
    assert.ok(button.querySelector('svg[aria-hidden="true"]'));
    assert.equal(button.dataset.action, "workspace-select");
  }
  assert.equal(doc.querySelectorAll('[data-workspace-type="platform"]').length, 0);
  dom.window.close();
});
test("admin Home avoids fetching all athletes", async () => {
  state.currentUser.activeWorkspace = { type: "platform" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Must not load a combined roster");
  try {
    let rendered;
    await loadCoachHome({ renderCoachHome: (data) => { rendered = data; } });
    assert.deepEqual(rendered, { rows: [], error: "" });
  } finally { globalThis.fetch = originalFetch; }
});
test("picker searches names and IDs case-insensitively and uses the chosen destination", () => {
  const html = renderCoachHomeAthleteRows(rows, { mode: "load", query: " ANA " });
  assert.match(html, /Ana Test/);
  assert.doesNotMatch(html, /Marko Test/);
  assert.match(html, /data-mode="load".*data-athlete-uuid="uuid-17"/);
  assert.match(renderCoachHomeAthleteRows(rows, { query: "18" }), /Marko Test/);
  assert.match(renderCoachHomeAthleteRows(rows, { query: "missing" }), /No athletes match/);
});
test("picker has an accessible dialog and escapes athlete and workspace labels", () => {
  const html = renderCoachHomeHtml({ rows: [{ ...rows[0], athlete: "<script>bad</script>" }], picker: { mode: "plan" }, user: state.currentUser });
  assert.match(html, /<dialog.*aria-labelledby="coachHomePickerTitle"/);
  assert.match(html, /aria-label="Search athletes"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});

// --- Empty, error and trigger states (coach Home) ---

function parse(html) {
  const dom = new JSDOM(html);
  return { doc: dom.window.document, close: () => dom.window.close() };
}

test("a roster that loaded with no athletes shows the empty state with Add athlete - no Today row, no pickers", () => {
  const html = renderCoachHomeHtml({ rows: [], user: state.currentUser });
  const { doc, close } = parse(html);
  assert.match(html, /No athletes in this workspace yet/);
  const cta = doc.querySelector('.coach-home-state [data-action="home-add-athlete"]');
  assert.ok(cta, "the empty state carries the existing home-add-athlete action");
  assert.equal(cta.tagName, "BUTTON");
  assert.match(cta.textContent, /Add athlete/);
  assert.ok(doc.querySelector('.coach-home-header [data-action="home-add-athlete"]'), "the header's round Add athlete stays");
  assert.equal(doc.querySelectorAll('[data-action="coach-home-picker-open"]').length, 0);
  assert.equal(doc.querySelector(".coach-home-today"), null);
  assert.equal(doc.querySelector("dialog"), null);
  assert.doesNotMatch(html, /athletes training|Training Plan|Training Load|coach-home-retry/);
  close();
});

test("a failed load shows only the error and Try again - no pickers, no Today row, no dialog even with a picker mode left over", () => {
  const html = renderCoachHomeHtml({ rows: [], error: "network down", user: state.currentUser, picker: { mode: "today" } });
  const { doc, close } = parse(html);
  const alert = doc.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /Today's overview could not be loaded/);
  assert.match(alert.textContent, /network down/);
  const retry = doc.querySelector('[data-action="coach-home-retry"]');
  assert.ok(retry, "the error state offers Try again");
  assert.equal(retry.tagName, "BUTTON");
  assert.match(retry.textContent, /Try again/);
  assert.equal(doc.querySelectorAll('[data-action="coach-home-picker-open"]').length, 0);
  assert.equal(doc.querySelector(".coach-home-today"), null);
  assert.equal(doc.querySelector("dialog"), null);
  assert.doesNotMatch(html, /athletes training|No athletes in this workspace/);
  close();
});

test("the error message is escaped like every other value", () => {
  const html = renderCoachHomeHtml({ rows: [], error: "<img src=x onerror=alert(1)>", user: state.currentUser });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("Try again re-runs loadCoachHome with forceRefresh in app.js - never a page reload", () => {
  // app.js touches document at module scope through its import chain, so the
  // handler is checked over the source text (the same source-pattern guard
  // every other app.js-adjacent test in this suite uses); the real click is
  // exercised in the browser QA of the change.
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf('type === "coach-home-retry"');
  assert.ok(start >= 0, "app.js must handle coach-home-retry");
  const block = source.slice(start, source.indexOf("return;", start));
  assert.match(block, /await loadCoachHome\(\{\s*forceRefresh:\s*true\s*\}\)/);
  assert.doesNotMatch(block, /location\.(reload|assign|replace)|fetch\(/);
});

test("platform administration Home is untouched by the empty and error states", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [{ type: "private_coach" }, { type: "club", scopeId: "club-a", label: "My Club" }] };
  const html = renderCoachHomeHtml({ rows: [], user });
  assert.match(html, /class="coach-home-workspaces"/);
  assert.doesNotMatch(html, /coach-home-state|No athletes in this workspace yet|coach-home-retry|home-add-athlete/);
  const errored = renderCoachHomeHtml({ rows: [], error: "x", user });
  assert.match(errored, /<p class="builder-error" role="alert">x<\/p>/);
  assert.match(errored, /class="coach-home-workspaces"/);
  assert.doesNotMatch(errored, /coach-home-state|coach-home-retry/);
  const none = renderCoachHomeHtml({ rows: [], user: { activeWorkspace: { type: "platform" }, availableWorkspaces: [] } });
  assert.match(none, /No coaching workspaces available/);
  assert.doesNotMatch(none, /coach-home-state/);
});

test("all three picker triggers declare aria-haspopup=dialog and the Today row carries the chevron", () => {
  const { doc, close } = parse(renderCoachHomeHtml({ rows, user: state.currentUser }));
  const triggers = doc.querySelectorAll('[data-action="coach-home-picker-open"]');
  assert.equal(triggers.length, 3);
  for (const trigger of triggers) {
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  }
  const today = doc.querySelector(".coach-home-today");
  assert.equal(today.dataset.mode, "today");
  assert.ok(today.querySelector('svg.coach-home-workspace-arrow[aria-hidden="true"]'), "the Today row shows the same chevron as the workspace rows");
  assert.match(today.textContent, /Today/);
  assert.match(today.textContent, /1 \/ 2 athletes training/);
  close();
});

test("Today still opens the same dialog, limited to athletes training today, with the trigger kept behind it", () => {
  const { doc, close } = parse(renderCoachHomeHtml({ rows, user: state.currentUser, picker: { mode: "today" } }));
  const dialog = doc.querySelector("dialog.coach-home-picker");
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-labelledby"), "coachHomePickerTitle");
  assert.equal(doc.querySelector("#coachHomePickerTitle").textContent, "Today");
  assert.ok(dialog.querySelector('[data-action="coach-home-picker-close"]'));
  assert.ok(dialog.querySelector("input[data-coach-home-search]"));
  const athleteRows = dialog.querySelectorAll('[data-action="coach-home-open-athlete"]');
  assert.equal(athleteRows.length, 1);
  assert.equal(athleteRows[0].dataset.mode, "today");
  assert.equal(athleteRows[0].dataset.athleteId, "17");
  assert.ok(doc.querySelector('.coach-home-today[data-action="coach-home-picker-open"]'));
  close();
});

test("the dead card, list and summary Home selectors stay out of styles.css while the avatar rules stay in", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.coach-home-(card|cards|list|summary)\b/);
  assert.match(css, /\.coach-home-avatar\b/);
  assert.match(css, /\.coach-home-avatar-fallback\b/);
});
