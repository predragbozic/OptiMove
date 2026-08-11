import { test } from "node:test";
import assert from "node:assert/strict";

// feature/athlete-programs-profile: renderAthleteProgramCardsRailHtml/
// renderAthleteProgramsPanelHtml are pure functions over the real fields
// GET /api/athletes/:athleteId/program-data?program=__all_programs__ now
// returns (see backend/src/utils/grouping.js's buildPrograms) - these
// tests pin the template-card visual pattern, the search threshold/
// filtering behavior, and that no marketplace/price/edit affordance ever
// leaks into the athlete's own already-assigned-programs view.

const {
  ATHLETE_PROGRAMS_SEARCH_THRESHOLD,
  renderAthleteProgramCardsRailHtml,
  renderAthleteProgramsPanelHtml,
} = await import("../athlete-programs-view.js");

function program(overrides = {}) {
  return {
    id: "p1",
    name: "Program A",
    imageUrl: "",
    category: "",
    sessionCount: 0,
    itemCount: 0,
    ...overrides,
  };
}

test("a program with a real cover image renders it; one without falls back to initials, never a broken image", () => {
  const withCover = renderAthleteProgramCardsRailHtml([program({ imageUrl: "https://example.test/cover.jpg" })], null, "");
  assert.ok(withCover.includes("https://example.test/cover.jpg"));
  assert.ok(withCover.includes("program-library-cover"));

  const withoutCover = renderAthleteProgramCardsRailHtml([program({ name: "Speed Block" })], null, "");
  assert.ok(withoutCover.includes("program-library-card-icon"));
  assert.ok(withoutCover.includes("SB"), "initials fallback must be derived from the real program name");
});

test("category renders only when the real field is non-empty - never a fabricated label", () => {
  const withCategory = renderAthleteProgramCardsRailHtml([program({ category: "Strength" })], null, "");
  assert.ok(withCategory.includes(">Strength<"));

  const withoutCategory = renderAthleteProgramCardsRailHtml([program({ category: "" })], null, "");
  assert.ok(!withoutCategory.includes("program-library-card-sub"), "no category chip markup at all when the field is empty");
});

test("item count renders only when > 0, and is never fabricated as a session count", () => {
  const withCount = renderAthleteProgramCardsRailHtml([program({ itemCount: 5 })], null, "");
  assert.ok(withCount.includes("5 items"));

  const zeroCount = renderAthleteProgramCardsRailHtml([program({ itemCount: 0 })], null, "");
  assert.ok(!zeroCount.includes("0 items"), "never show a fabricated 0-items line");
});

test("no price, rating, marketplace action, edit control, or ownership/creator UI ever appears on an athlete's own program card", () => {
  const html = renderAthleteProgramCardsRailHtml([program()], null, "");
  assert.ok(!html.includes("program-library-card-rating"));
  assert.ok(!html.includes("is-price"));
  assert.ok(!html.includes("program-lifecycle-badge"));
  assert.ok(!html.includes("program-access-badge"));
  assert.ok(!html.includes("program-library-creator"));
  assert.ok(!html.includes("program-library-info-button"), "no coach-only info/edit affordance");
});

test("Open program action + selected state are wired for the existing athlete program-view flow, not a new viewer", () => {
  const html = renderAthleteProgramCardsRailHtml([program({ id: "p1" }), program({ id: "p2", name: "Program B" })], "p2", "");
  assert.ok(html.includes(">Open program<"));
  const targetIds = [...html.matchAll(/data-action="athlete-program-open" data-program-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targetIds, ["p1", "p2"]);
  assert.match(html, /program-library-card athlete-program-card is-selected"[^>]*>\s*<button[^>]*data-program-id="p2"/, "the currently-open program's card carries is-selected");
});

test("search is hidden at or below the documented threshold, shown above it", () => {
  const programs = Array.from({ length: ATHLETE_PROGRAMS_SEARCH_THRESHOLD }, (_, i) => program({ id: `p${i}`, name: `Program ${i}` }));
  const atThreshold = renderAthleteProgramsPanelHtml(programs, null, "");
  assert.ok(!atThreshold.includes("athlete-programs-search"), `search must stay hidden at exactly ${ATHLETE_PROGRAMS_SEARCH_THRESHOLD} programs`);

  const overThreshold = renderAthleteProgramsPanelHtml([...programs, program({ id: "extra", name: "Extra" })], null, "");
  assert.ok(overThreshold.includes("athlete-programs-search"), "search must appear once the count exceeds the threshold");
});

test("search matches case-insensitively and ignores leading/trailing whitespace, entirely client-side", () => {
  const programs = [program({ id: "p1", name: "Speed & Power" }), program({ id: "p2", name: "Rehab Basics" })];
  const html = renderAthleteProgramCardsRailHtml(programs, null, "  speed  ");
  assert.ok(html.includes("Speed &amp; Power"));
  assert.ok(!html.includes("Rehab Basics"));
});

test("a search with no matches shows the required exact empty-state text", () => {
  const html = renderAthleteProgramCardsRailHtml([program({ name: "Speed & Power" })], null, "zzz-no-such-program");
  assert.ok(html.includes("No programs match your search."));
  assert.ok(!html.includes("program-library-card"));
});

test("clearing the search (empty query) restores the full unfiltered list", () => {
  const programs = [program({ id: "p1", name: "Speed" }), program({ id: "p2", name: "Rehab" })];
  const filtered = renderAthleteProgramCardsRailHtml(programs, null, "speed");
  const cleared = renderAthleteProgramCardsRailHtml(programs, null, "");
  assert.ok(!filtered.includes("Rehab"));
  assert.ok(cleared.includes("Speed") && cleared.includes("Rehab"));
});

test("an empty programs list renders nothing from the panel - the existing fully-empty state upstream is left untouched", () => {
  assert.equal(renderAthleteProgramsPanelHtml([], null, ""), "");
});

test("the rail reuses Program Library's own existing CSS classes (program-library-row/-card/...) rather than a new component", () => {
  const html = renderAthleteProgramCardsRailHtml([program()], null, "");
  assert.ok(html.includes("program-library-row"));
  assert.ok(html.includes("program-library-card"));
  assert.ok(html.includes("program-library-card-hit"));
  assert.ok(html.includes("program-library-card-media"));
  assert.ok(html.includes("program-library-card-body"));
  assert.ok(html.includes("program-library-card-title"));
});
