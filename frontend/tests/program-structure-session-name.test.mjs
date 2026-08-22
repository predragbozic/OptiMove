import { test } from "node:test";
import assert from "node:assert/strict";
import { createNode, btaNodes, sessionNodes } from "../program-structure.js";

// Weekly/Program views were showing the AM/PM+training-phase badge only
// (e.g. "Training") for a group, never the session's own custom name (set
// in the Builder, plans.plan_sessions.name) - reported live: "Ne vidi se
// naziv sesije u weekly planu iako smo uveli naziv sesije unutar sesije."
// Root cause: neither the read view (plans.v_weekly_plan_items) nor the
// item shape backend/src/utils/grouping.js's toPlanItem() builds ever
// carried the name through, so the value never reached this file's own
// label-building logic (btaNodes/sessionNodes) at all. Fixed by threading
// item.sessionName through withSessionDetails(), the same "name (badge)"
// convention builder-modals.js's pickerSessionLabel() already uses for the
// cross-plan-copy picker.
const makeNode = createNode;

function item(overrides = {}) {
  return {
    plan_item_id: overrides.title ? `item-${overrides.title}` : "item",
    item_type: "exercise",
    bta: "T",
    sessionName: "",
    sessionTime: "",
    title: "",
    ...overrides,
  };
}

test("1. a session with a name shows 'Name (Phase)' instead of just the phase", () => {
  const items = [item({ title: "Squat", sessionName: "Morning strength" })];
  const nodes = btaNodes(items, makeNode);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, "Morning strength (Training)");
});

test("2. a session with no name falls back to the plain phase label, unchanged from before", () => {
  const items = [item({ title: "Squat" })];
  const nodes = btaNodes(items, makeNode);
  assert.equal(nodes[0].label, "Training");
});

test("3. a session with both a name and a specific time shows 'HH:MM · Name (Phase)'", () => {
  const items = [item({ title: "Squat", sessionName: "Morning strength", sessionTime: "07:00" })];
  const nodes = btaNodes(items, makeNode);
  assert.equal(nodes[0].label, "07:00 · Morning strength (Training)");
});

test("4. a session with a time but no name shows 'HH:MM · Phase', same as before this fix", () => {
  const items = [item({ title: "Squat", sessionTime: "07:00" })];
  const nodes = btaNodes(items, makeNode);
  assert.equal(nodes[0].label, "07:00 · Training");
});

test("5. sessionNodes() nested under AM/PM also carries the session name onto the phase-level node", () => {
  const items = [item({ title: "Squat", amPm: "AM", sessionName: "Morning strength" })];
  const nodes = sessionNodes(items, makeNode);
  const am = nodes.find((node) => node.label === "AM");
  assert.ok(am, "the AM wrapper node itself stays plain 'AM' - the name belongs on the phase node one level down");
  const phase = btaNodes(am.items, makeNode);
  assert.equal(phase[0].label, "Morning strength (Training)");
});
