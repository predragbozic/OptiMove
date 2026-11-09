// A late Home answer never draws Home over another screen (the browser proof is e2e/tests/home-render-race.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("renderCoachHome paints only while Home is the active screen", () => {
  const fn = app.slice(app.indexOf("function renderCoachHome({"), app.indexOf("\n}\n", app.indexOf("function renderCoachHome({")));
  const guard = fn.indexOf('if (state.activeTab !== "coach-home") return;');
  assert.ok(guard > 0, "the guard is there");
  assert.ok(guard < fn.indexOf("els.content.innerHTML"), "before anything is painted");
});
