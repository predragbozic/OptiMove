// Builder step 2, the pure part (docs/ai/builder-batch-edit-plan.md 1.1, 1.2
// and condition 10.2.4): the id-free content fingerprint and the
// classification of one sibling. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { choiceTokenOf, planSiblingChange, sessionContentFingerprint, sessionsAtRisk, slotKey } from "../src/builderBatchEdit.js";

let next = 0;
const id = (p) => `${p}-${++next}`;

// One session's content with fresh row ids each call.
function content({ sets = "3", reps = "8", order = [1, 2], note = "Keep the back straight", extra = null } = {}) {
  const domain = id("node"); const section = id("node");
  const nodes = [
    { id: domain, parent_id: null, node_type: "domain", name: "Strength", node_order: 1 },
    { id: section, parent_id: domain, node_type: "section", name: "Lower body", node_order: 1 },
  ];
  const items = [
    { id: id("item"), plan_node_id: section, item_type: "custom", title: "Squat", sets, reps, load: "60%", description: note, item_order: order[0] },
    { id: id("item"), plan_node_id: section, item_type: "custom", title: "Lunge", sets: "2", reps: "10", load: null, description: null, item_order: order[1] },
  ];
  if (extra) items.push({ id: id("item"), plan_node_id: section, item_type: "custom", title: extra, sets: "1", item_order: 3 });
  return { nodes, items };
}
const fp = (c) => sessionContentFingerprint(c.nodes, c.items);

test("1. the same tree with other row ids gives the same fingerprint; a dose, an order or an instruction gives another", () => {
  const base = fp(content());
  assert.equal(fp(content()), base, "ids do not count");
  assert.notEqual(fp(content({ sets: "4" })), base, "a dose");
  assert.notEqual(fp(content({ order: [2, 1] })), base, "an order");
  assert.notEqual(fp(content({ note: "Slow down" })), base, "an instruction");
  assert.notEqual(fp(content({ extra: "Plank" })), base, "an added exercise");
  // The same rows listed in another order (a different read order) are the same tree.
  const c = content();
  assert.equal(sessionContentFingerprint([...c.nodes].reverse(), [...c.items].reverse()), base);
});

test("2. a library image filled in by a copy is derived, not a change; a coach's own image is", () => {
  const item = (image_url) => ({ id: id("i"), plan_node_id: null, item_type: "exercise", exercise_id: "ex-1", image_source: null, video_source: null, image_url, item_order: 1 });
  assert.equal(sessionContentFingerprint([], [item(null)]), sessionContentFingerprint([], [item("https://example.invalid/a.png")]));
  const own = (image_url) => ({ ...item(image_url), image_source: "upload" });
  assert.notEqual(sessionContentFingerprint([], [own(null)]), sessionContentFingerprint([], [own("https://example.invalid/a.png")]));
});

// A plan as loadWeeklyTree returns it.
function plan(sessions, { ambiguous = [], days = null, planFields = {} } = {}) {
  const allDays = days || [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ id: id("day"), weekday, day_order: weekday, date: `2026-11-0${weekday + 1}`, day_note: null, block_name: null }));
  return {
    plan: { id: id("plan"), athlete_id: id("ath"), name: "Week", note: null, icon_url: null, color: null, track_training_load_default: true, request_rpe_default: true, ...planFields },
    days: allDays,
    sessions: sessions.map((s) => ({ id: id("s"), am_pm: null, bta: "T", session_order: 0, session_time: null, rpe_enabled: true, training_load_enabled: true, ...s })),
    ambiguousWeekdays: new Set(ambiguous),
  };
}
const A = fp(content()); const A2 = fp(content({ sets: "5" })); const B = fp(content({ note: "Athlete-only" }));

test("3. unchanged: nothing; changed content: in place, the sibling's own session; three-way fields", () => {
  const before = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }]);
  const sibling = plan([{ weekday: 1, name: "Main", logical_session_id: "S1", fingerprint: A, rpe_enabled: false }]);
  const same = planSiblingChange(before, plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }]), sibling);
  assert.deepEqual(same, { reasons: [], ops: { plan: {}, days: [], update: [], content: [], move: [], remove: [], add: [] } });
  const after = plan([{ weekday: 1, name: "Main 2", logical_session_id: "L1", fingerprint: A2 }]);
  const change = planSiblingChange(before, after, sibling);
  assert.deepEqual(change.reasons, []);
  assert.equal(change.ops.content.length, 1);
  assert.equal(change.ops.content[0].sessionId, sibling.sessions[0].id, "the sibling's own row");
  assert.deepEqual(change.ops.update, [{ sessionId: sibling.sessions[0].id, set: { name: "Main 2" } }], "only the field the coach changed");
});

test("4. diverged: the same session changed for the sibling alone; a field changed both ways; a missing match", () => {
  const before = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }]);
  const after = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A2 }]);
  assert.deepEqual(planSiblingChange(before, after, plan([{ weekday: 1, name: "Main", logical_session_id: "S1", fingerprint: B }])).reasons, ["changed_separately"]);
  const renamed = plan([{ weekday: 1, name: "Mine", logical_session_id: "S1", fingerprint: A }]);
  const afterName = plan([{ weekday: 1, name: "Theirs", logical_session_id: "L1", fingerprint: A }]);
  assert.deepEqual(planSiblingChange(before, afterName, renamed).reasons, ["changed_separately"]);
  assert.deepEqual(planSiblingChange(before, after, plan([])).reasons, ["changed_separately"]);
});

test("5. an ambiguous weekday is diverged, never a guess", () => {
  const before = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }]);
  const after = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A2 }]);
  const sibling = plan([{ weekday: 1, name: "Main", logical_session_id: "S1", fingerprint: A }], { ambiguous: [1] });
  assert.deepEqual(planSiblingChange(before, after, sibling).reasons, ["changed_separately"]);
});

test("6. removed and moved: blocked by results or a live link; a free move; a taken target slot is diverged", () => {
  const before = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }, { weekday: 3, name: "Wed", logical_session_id: "L2", fingerprint: A }]);
  const sibling = plan([{ weekday: 1, name: "Main", logical_session_id: "S1", fingerprint: A }, { weekday: 3, name: "Wed", logical_session_id: "S2", fingerprint: A }]);
  const removed = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }]);
  const wed = sibling.sessions[1];
  assert.deepEqual(planSiblingChange(before, removed, sibling).ops.remove, [{ sessionId: wed.id }]);
  assert.deepEqual(planSiblingChange(before, removed, sibling, { results: new Set([String(wed.id)]), linkedSlots: new Set() }).reasons, ["has_results"]);
  assert.deepEqual(planSiblingChange(before, removed, sibling, { results: new Set(), linkedSlots: new Set([slotKey(wed)]) }).reasons, ["linked_to_event"]);
  // Wednesday moves to the afternoon.
  const moved = plan([{ weekday: 1, name: "Main", logical_session_id: "L1", fingerprint: A }, { weekday: 3, name: "Wed", logical_session_id: "L2", fingerprint: A, am_pm: "PM" }]);
  const move = planSiblingChange(before, moved, sibling);
  assert.equal(move.ops.move.length, 1);
  assert.equal(move.ops.move[0].sessionId, wed.id);
  assert.equal(move.ops.move[0].slot.am_pm, "PM");
  assert.deepEqual(planSiblingChange(before, moved, sibling, { results: new Set([String(wed.id)]), linkedSlots: new Set() }).reasons, ["has_results"], "a session with results is never moved (Q5)");
  // The sibling already has its own session on that slot.
  const taken = plan([...sibling.sessions.map(({ id: _, ...s }) => s), { weekday: 3, name: "Own PM", logical_session_id: "S9", fingerprint: B, am_pm: "PM" }]);
  assert.deepEqual(planSiblingChange(before, moved, taken).reasons, ["changed_separately"]);
  assert.deepEqual(sessionsAtRisk(before, moved, sibling), [String(wed.id)]);
});

test("7. an added session needs a free slot in the sibling; the plan's fields three-way", () => {
  const before = plan([], { planFields: { name: "Week", request_rpe_default: true } });
  const after = plan([{ weekday: 2, name: "New", logical_session_id: "L9", fingerprint: A }], { planFields: { name: "Week 2", request_rpe_default: true } });
  const free = planSiblingChange(before, after, plan([], { planFields: { request_rpe_default: false } }));
  assert.equal(free.ops.add.length, 1);
  assert.deepEqual(free.ops.plan, { name: "Week 2" }, "the sibling keeps its own Request RPE default");
  const busy = planSiblingChange(before, after, plan([{ weekday: 2, name: "Own", logical_session_id: "S5", fingerprint: B }]));
  assert.deepEqual(busy.reasons, ["changed_separately"]);
});

test("8. the choice token follows the classification, not the order of the members", () => {
  const m = [{ planId: "b", outcome: "ask", reasons: ["has_results"] }, { planId: "a", outcome: "apply", reasons: [] }];
  assert.equal(choiceTokenOf(m), choiceTokenOf([...m].reverse()));
  assert.notEqual(choiceTokenOf(m), choiceTokenOf([{ ...m[0], reasons: ["has_results", "linked_to_event"] }, m[1]]));
  assert.notEqual(choiceTokenOf(m), choiceTokenOf([m[0], { planId: "a", outcome: "skip", reasons: ["archived"] }]));
});

test("9. a move carries a sibling's session only while it is still as before; a tailored one is asked about (code review HIGH)", () => {
  const before = plan([{ weekday: 3, name: "Wed", logical_session_id: "L2", fingerprint: A }]);
  const after = plan([{ weekday: 3, name: "Wed", logical_session_id: "L2", fingerprint: A, am_pm: "PM" }]);
  const tailored = planSiblingChange(before, after, plan([{ weekday: 3, name: "Wed", logical_session_id: "S2", fingerprint: B }]));
  assert.deepEqual(tailored.reasons, ["changed_separately"]);
  assert.equal(tailored.ops.move.length, 0);
  const renamed = planSiblingChange(before, after, plan([{ weekday: 3, name: "Wed (own)", logical_session_id: "S2", fingerprint: A }]));
  assert.deepEqual(renamed.reasons, ["changed_separately"]);
  assert.equal(planSiblingChange(before, after, plan([{ weekday: 3, name: "Wed", logical_session_id: "S2", fingerprint: A }])).ops.move.length, 1);
});
