import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
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
test("admin Home shows only available workspaces, no combined roster", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [{ type: "private_coach" }, { type: "club", scopeId: "club-a", label: "My Club" }] };
  const html = renderCoachHomeHtml({ rows, user });
  assert.match(html, /data-workspace-type="private_coach"/);
  assert.match(html, /data-workspace-scope-id="club-a"/);
  assert.doesNotMatch(html, /Ana Test|Marko Test|coach-home-picker-open/);
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
