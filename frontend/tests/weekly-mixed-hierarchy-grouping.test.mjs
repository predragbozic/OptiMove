import { test } from "node:test";
import assert from "node:assert/strict";
import { createNode, structureNodes, categoryOrSectionNodes, sectionOrExerciseNodes } from "../program-structure.js";

// Weekly must render a genuine MIX of hierarchy levels within one session/BTA
// group - a category (with its own sections nested under it) sitting
// directly alongside a standalone section that has no category, without
// flattening everything to the lowest shared level.
//
// Root cause (reported live: "Morning activation" category's sections
// vanished from Weekly on 2026-08-21/22, though correctly shown in
// Builder): structureNodes() used to be an all-or-nothing cascade - group by
// domain if EVERY item has one, else by category if EVERY item has one,
// else by section. A single standalone section with no category anywhere in
// the group flipped the whole group to section-only, discarding every
// category that DID exist alongside it. The fix (mixedStructureNodes in
// program-structure.js) groups each item by its OWN real ancestor level
// (via domain_node_id/category_node_id/section_node_id, never by name
// alone), so different siblings can resolve to different levels.
//
// makeNode here is the real createNode() (program-structure.js) - not a
// stub - so these tests exercise the exact node shape (type, label, items,
// subtitle, color, etc.) the real renderer consumes.
const makeNode = createNode;

function item(overrides = {}) {
  return {
    plan_item_id: overrides.title ? `item-${overrides.title}` : "item",
    item_type: "exercise",
    domain: "",
    domain_node_id: "",
    category: "",
    category_node_id: "",
    section: "",
    section_node_id: "",
    title: "",
    ...overrides,
  };
}

test("1. one category with multiple sections: the category is ONE top-level node, its sections are visible one level down", () => {
  const items = [
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Stability", section_node_id: "sec-2", title: "Plank" }),
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 1);
  assert.equal(top[0].type, "category");
  assert.equal(top[0].label, "Morning activation");
  assert.equal(top[0].items.length, 2);

  // Descending into a CATEGORY node's own children uses sectionOrExerciseNodes
  // (see nextNodes() in program-structure.js: node.type === "category" ->
  // sectionOrExerciseNodes), not categoryOrSectionNodes (that one is for a
  // DOMAIN's children, deciding whether THEY are further grouped by
  // category or go straight to section).
  const sections = sectionOrExerciseNodes(top[0].items, makeNode);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((n) => n.label), ["Mobility", "Stability"]);
  assert.ok(sections.every((n) => n.type === "section"));
});

test("2. a category and a standalone section (no category) in the SAME BTA group: both appear as separate top-level nodes - the category is never dropped", () => {
  const items = [
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ section: "Bike", section_node_id: "sec-standalone", title: "Stationary bike" }), // no category at all
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 2, "the category node must not be flattened away just because a sibling has no category");
  assert.deepEqual(
    top.map((n) => [n.type, n.label]),
    [["category", "Morning activation"], ["section", "Bike"]],
  );
});

test("3. two different categories in the same group produce two separate top-level category nodes, each with its own sections", () => {
  const items = [
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ category: "Strength", category_node_id: "cat-2", section: "Upper body", section_node_id: "sec-2", title: "Push-up" }),
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 2);
  assert.deepEqual(top.map((n) => n.label), ["Morning activation", "Strength"]);
  assert.ok(top.every((n) => n.type === "category"));
});

test("4. Domain -> Category -> Section together with a direct Section branch at the SAME session level", () => {
  const items = [
    item({ domain: "Recovery", domain_node_id: "dom-1", category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ section: "Bike", section_node_id: "sec-standalone", title: "Stationary bike" }), // domain-less, category-less
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 2);
  assert.deepEqual(
    top.map((n) => [n.type, n.label]),
    [["domain", "Recovery"], ["section", "Bike"]],
  );

  const domainChildren = categoryOrSectionNodes(top[0].items, makeNode);
  assert.equal(domainChildren.length, 1);
  assert.equal(domainChildren[0].type, "category");
  assert.equal(domainChildren[0].label, "Morning activation");
});

test("5. copy/paste a section INTO a category: once the item carries the category's real node id, it groups under that category, not as a standalone section", () => {
  // "Before paste": a standalone section, no category.
  const beforePaste = [item({ section: "Bike", section_node_id: "sec-1", title: "Stationary bike" })];
  const beforeTop = structureNodes(beforePaste, makeNode);
  assert.deepEqual(beforeTop.map((n) => n.type), ["section"]);

  // "After paste": the exact same section, now carrying the target
  // category's real ids (what copySessionContent-style copy logic would
  // stamp onto it) - simulates dropping it into "Morning activation".
  const afterPaste = [item({ category: "Morning activation", category_node_id: "cat-1", section: "Bike", section_node_id: "sec-1", title: "Stationary bike" })];
  const afterTop = structureNodes(afterPaste, makeNode);
  assert.equal(afterTop.length, 1);
  assert.equal(afterTop[0].type, "category");
  assert.equal(afterTop[0].label, "Morning activation");
});

test("6. an empty node and a populated node in the same structure both appear, at their real positions", () => {
  const items = [
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    // Empty section placeholder row shape (item_type='section', no title) -
    // matches plans.v_weekly_plan_items' empty-node branch. Same category as
    // the populated section above (cat-1), so both belong under it.
    item({ item_type: "section", category: "Morning activation", category_node_id: "cat-1", section: "Empty section", section_node_id: "sec-empty" }),
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 1, "both rows share category cat-1, so they must land in the SAME category node");
  const sections = sectionOrExerciseNodes(top[0].items, makeNode);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((n) => n.label), ["Mobility", "Empty section"]);
});

test("7. group order follows the items' own array order (already hierarchy-sorted by SQL) - mixed levels interleave correctly, not category-first or section-first", () => {
  const items = [
    item({ section: "Bike", section_node_id: "sec-standalone-1", title: "Warm-up bike" }), // standalone section FIRST
    item({ category: "Morning activation", category_node_id: "cat-1", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ section: "Cooldown", section_node_id: "sec-standalone-2", title: "Cooldown walk" }), // standalone section LAST
  ];
  const top = structureNodes(items, makeNode);
  assert.deepEqual(
    top.map((n) => [n.type, n.label]),
    [["section", "Bike"], ["category", "Morning activation"], ["section", "Cooldown"]],
    "the standalone section before the category, and the one after it, must both stay in their real relative positions - not sorted to the start/end by type",
  );
});

test("group by real node id, never by name alone - two categories that happen to share a name stay separate", () => {
  const items = [
    item({ category: "Warm-up", category_node_id: "cat-A", section: "Mobility", section_node_id: "sec-1", title: "Hip circles" }),
    item({ category: "Warm-up", category_node_id: "cat-B", section: "Mobility", section_node_id: "sec-2", title: "Ankle circles" }),
  ];
  const top = structureNodes(items, makeNode);
  assert.equal(top.length, 2, "two different category node ids sharing the same name must never visually merge");
});
