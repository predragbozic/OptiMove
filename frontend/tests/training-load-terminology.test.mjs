// Phase G: "Results" must no longer have two user-facing meanings in
// Training Load - the Data & Analysis sub-view is "Athletes" (internal
// section key "results" is fine), and Activities' per-activity table is
// "Recorded metrics". A source scan, same approach as the app.js checks in
// training-load-shell.actions.test.mjs: confirm() prompts and notification
// hints are plain strings no render test would ever reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("no Training Load confirm() prompt, note or notification hint still points the coach to 'Results'", () => {
  const actions = read("training-load-actions.js");
  const view = read("training-load-view.js");
  const notifications = read("notifications.js");
  for (const [file, src, minimum] of [["training-load-actions.js", actions, 3], ["training-load-view.js", view, 1]]) {
    const userFacing = [...src.matchAll(/window\.confirm\("([^"]*)"\)|<p class="muted">([^<]*)<\/p>/g)].map((m) => m[1] || m[2]);
    // code-reviewer note: a source scan that matches nothing must fail loudly,
    // or a harmless refactor (confirm(variable), interpolated note) would
    // silently turn this guard vacuous.
    assert.ok(userFacing.length >= minimum, `${file}: source scan matched ${userFacing.length} string(s) - the regex no longer sees the confirm()/note strings`);
    for (const text of userFacing) assert.ok(!/\bin Results\b/.test(text), `${file}: "${text}"`);
  }
  const trainingLoadHint = notifications.match(/isTrainingLoadFinalDigestNotification \? `<small class="notification-hint">([^<]*)<\/small>`/);
  assert.ok(trainingLoadHint, "the Training Load final-digest hint still exists");
  assert.equal(trainingLoadHint[1], "Open Athletes");
});

test("the Data & Analysis sub-nav labels are Overview / Activities / Athletes / Dashboards / GPEXE imports - never 'Results'", async () => {
  globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
  globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };
  const { renderTrainingLoadCoachHtml } = await import("../training-load-view.js");
  const { emptyTrainingLoadState, state } = await import("../state.js");
  state.currentUser = { id: "coach-1", activeWorkspace: { type: "club", scopeId: "club-1" } };
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = "overview";
  const html = renderTrainingLoadCoachHtml();
  const labels = [...html.matchAll(/class="training-load-subnav-tab[^"]*"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Overview", "Activities", "Athletes", "Dashboards", "GPEXE imports"]);
});
