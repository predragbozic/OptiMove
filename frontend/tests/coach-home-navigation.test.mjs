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
  const home = renderCoachHomeHtml({ user: state.currentUser }).match(/data-mode="load"><svg[^>]*>(.*?)<\/svg>/)?.[1];
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
