import { test } from "node:test";
import assert from "node:assert/strict";

// fix/add-athlete-button-on-home: "Add athlete" used to live in the athlete
// header toolbar (shared by the Weekly plans and Specific programs tabs) -
// reported live as being in the wrong place ("mislim tu mu je mesto" - it
// belongs on Home instead, where a coach actually starts their day). Moved
// from renderAthleteHeaderToolbarHtml (athlete-view.js) into
// renderCoachHomeHtml (coach-home.js), reusing the exact same
// data-action="home-add-athlete" wiring (app.js's handler, untouched) and
// the same .athlete-toolbar-add-button styling, so no navigation logic
// needed to change - only where the button itself renders.
//
// coach-home.js now imports ICON_ADD_ATHLETE from organization-view.js,
// whose own import chain (navigation.js -> dom.js) touches `document` at
// module scope - same reasoning as builder-actions.js's tests elsewhere in
// this suite - so a minimal document stub is installed before the dynamic
// import. athlete-view.js no longer imports organization-view.js at all
// (that was the only reason it used to need a source-pattern-guard test
// instead of a real import - see the removed import in the old version of
// athlete-program-navigation-icons.test.mjs's own header comment), so it is
// imported directly here too.

const fakeElements = new Map();
function fakeElement() {
  return { innerHTML: "", textContent: "", querySelector: () => null, querySelectorAll: () => [] };
}
globalThis.document = {
  querySelector(selector) {
    if (!fakeElements.has(selector)) fakeElements.set(selector, fakeElement());
    return fakeElements.get(selector);
  },
  querySelectorAll: () => [],
};

const { renderCoachHomeHtml } = await import("../coach-home.js");
const { renderAthleteHeaderToolbarHtml } = await import("../athlete-view.js");

test("renderCoachHomeHtml (the coach's Home page) renders the Add athlete button, wired to the same home-add-athlete action as before", () => {
  const html = renderCoachHomeHtml({ rows: [], error: null });
  assert.match(html, /data-action="home-add-athlete"/, "Home must render the Add athlete button");
  assert.match(html, /aria-label="Add athlete"/);
  assert.match(html, /class="plain-button icon-button athlete-toolbar-add-button"/, "reuses the exact same button styling it had in the toolbar, not a new one-off style");
});

test("renderAthleteHeaderToolbarHtml (the Weekly plans / Specific programs toolbar) no longer renders an Add athlete button - it only moved, it wasn't duplicated", () => {
  const coachHtml = renderAthleteHeaderToolbarHtml({ athlete: "Test Athlete", athlete_image_url: "" }, { isAthleteMode: false });
  assert.ok(!coachHtml.includes("home-add-athlete"), "the toolbar must not still render the button now that it lives on Home");
  assert.ok(!coachHtml.includes("athlete-toolbar-add-button"));

  const athleteModeHtml = renderAthleteHeaderToolbarHtml({ athlete: "Test Athlete", athlete_image_url: "" }, { isAthleteMode: true });
  assert.ok(!athleteModeHtml.includes("home-add-athlete"), "athlete-mode's own toolbar never had this button either (it was coach-only) and still doesn't");
});

test("renderCoachHomeHtml's Add athlete button sits in the Today summary panel's own header row, not buried inside the athlete card list below", () => {
  const html = renderCoachHomeHtml({ rows: [], error: null });
  const summaryStart = html.indexOf('class="panel coach-home-summary"');
  const summaryEnd = html.indexOf("</section>", summaryStart);
  const headStart = html.indexOf('class="coach-home-summary-head"');
  const buttonIndex = html.indexOf('data-action="home-add-athlete"');
  assert.ok(summaryStart >= 0 && headStart > summaryStart, "coach-home-summary-head must be inside the Today summary panel");
  assert.ok(buttonIndex > headStart && buttonIndex < summaryEnd, "the Add athlete button must be inside that same summary panel, next to the Today text - not in the athlete cards list below");
});
