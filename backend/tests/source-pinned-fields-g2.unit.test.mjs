// G2 (docs/ai/gpexe-field-inventory-plan.md, section 9): the pinned set and the projections that keep it. Pure: no
// database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedPinnedFields, EMPTY_PINNED_FIELDS, PINNED_FIELDS_MAX, PinnedFieldsError, pinnedFieldsFromKeys } from "../src/sourcePinnedFields.js";
import { athleteSessionFieldsOf, BUNDLE_FIELDS, DETAILS_CONSUMED_FIELDS, detailsFieldsOf, projectSessionDetails, projectStoredDetails } from "../src/gpexeRestV1Adapter.js";

const refusal = (code) => (error) => error instanceof PinnedFieldsError && error.code === code;
const names = (n, prefix = "g2_f") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

test("1. the pinned set from T2a keys: only the two generic prefixes, names sorted and unique, frozen; any other key is ignored", () => {
  const pinned = pinnedFieldsFromKeys([
    "athlete_session.g2_hsr", "athlete_session.total_time", "details.players.g2_jumps", "athlete_session.g2_hsr",
    "more.events.acceleration_events_count", "more.complementary_data.power.distance", "board.test.time.fxyz",
  ]);
  assert.deepEqual(pinned, { athleteSession: ["g2_hsr", "total_time"], details: ["g2_jumps"] });
  assert.ok(Object.isFrozen(pinned) && Object.isFrozen(pinned.athleteSession) && Object.isFrozen(pinned.details));
  assert.deepEqual(pinnedFieldsFromKeys([]), EMPTY_PINNED_FIELDS);
  assert.deepEqual(checkedPinnedFields(null), EMPTY_PINNED_FIELDS);
});

test("2. a stored name a check cannot keep (not an identifier, a dangerous key, not text) is left out of the set and counted in one log line that names none; a malformed set given to the adapter, or more than the bound for one endpoint, is refused with a stable code; exactly the bound is accepted", () => {
  const warnings = [];
  const log = { warn: (line) => warnings.push(line) };
  const bad = ["athlete_session.g2.x", "athlete_session.9x", "athlete_session.", "details.players.__proto__", "athlete_session.constructor", "details.players.has-dash", `athlete_session.${"a".repeat(65)}`, 42];
  assert.deepEqual(pinnedFieldsFromKeys([...bad, "athlete_session.g2_ok"], { log }), { athleteSession: ["g2_ok"], details: [] });
  assert.deepEqual(warnings, [`[gpexe] pinned set: ${bad.length} source field key(s) left out (pinned_field_invalid)`]);
  assert.ok(!warnings[0].includes("__proto__") && !warnings[0].includes("constructor"), "the log names no key");
  assert.deepEqual(pinnedFieldsFromKeys(["athlete_session.g2_ok"], { log }), { athleteSession: ["g2_ok"], details: [] });
  assert.equal(warnings.length, 1, "nothing left out, nothing logged");
  for (const bad of [[], { athleteSession: "x" }, { other: [] }, { details: ["ok", "toString"] }]) {
    assert.throws(() => checkedPinnedFields(bad), refusal("pinned_field_invalid"), JSON.stringify(bad));
  }
  assert.equal(PINNED_FIELDS_MAX, 64);
  assert.equal(pinnedFieldsFromKeys(names(64).map((n) => `athlete_session.${n}`)).athleteSession.length, 64);
  assert.throws(() => pinnedFieldsFromKeys(names(65).map((n) => `athlete_session.${n}`)), refusal("pinned_fields_too_many"));
  assert.throws(() => pinnedFieldsFromKeys(names(65).map((n) => `details.players.${n}`)), refusal("pinned_fields_too_many"));
  assert.equal(pinnedFieldsFromKeys([...names(64).map((n) => `athlete_session.${n}`), ...names(64).map((n) => `details.players.${n}`)]).details.length, 64, "the bound is per endpoint");
});

test("3. the fields a run keeps: the importer's own first, in their order, then the pinned names that are not already there", () => {
  assert.deepEqual(athleteSessionFieldsOf(null), [...BUNDLE_FIELDS.athleteSession]);
  assert.deepEqual(detailsFieldsOf(null), [...DETAILS_CONSUMED_FIELDS]);
  const pinned = { athleteSession: ["g2_hsr", "total_time"], details: ["tot_burst_events", "g2_jumps"] };
  assert.deepEqual(athleteSessionFieldsOf(pinned), [...BUNDLE_FIELDS.athleteSession, "g2_hsr"]);
  assert.deepEqual(detailsFieldsOf(pinned), [...DETAILS_CONSUMED_FIELDS, "g2_jumps"]);
});

test("4. a details answer keeps the consumed and the pinned fields, each validated and copied (unit and value only); an unpinned metric of any shape is dropped; a pinned value of an unknown shape fails closed, naming the field after the mark", () => {
  const body = { drills_count: 0, players: {
    101: { tot_burst_events: { unit: "number", value: 3 }, g2_jumps: { unit: "number", value: 11, extra: "x" }, g2_hidden: { unit: "number", value: 77 }, odd: { a: { b: 1 } } },
    102: { g2_jumps: { unit: "number", value: 4 } },
  } };
  const fields = detailsFieldsOf({ details: ["g2_jumps"] });
  const out = projectSessionDetails(body, 0, { fields });
  assert.deepEqual(out.players, { 101: { tot_burst_events: { unit: "number", value: 3 }, g2_jumps: { unit: "number", value: 11 } }, 102: { g2_jumps: { unit: "number", value: 4 } } });
  assert.deepEqual(projectSessionDetails(body, 0).players, { 101: { tot_burst_events: { unit: "number", value: 3 } }, 102: {} }, "without the pinned set, as before G2");
  const bad = { players: { 101: { g2_jumps: { unit: "number", value: { deep: [1, 2, 3] } } } } };
  assert.throws(() => projectSessionDetails(bad, null, { fields, drillAnswer: true }), (e) => e.code === "source_answer_unexpected" && /field=g2_jumps; kind=object/.test(e.message));
  assert.doesNotThrow(() => projectSessionDetails(bad, null, { drillAnswer: true }), "an unpinned field of that shape is simply dropped");
});

test("5. a stored snapshot (retention, supersede) keeps the consumed and the pinned details fields, nothing else; without the run's set it keeps only the consumed ones; the athlete rows are not touched", () => {
  const bundle = {
    athleteSessions: [{ id: 1, total_time: 60, g2_hsr: 10 }],
    details: {
      full: { drills_count: 1, aggregate: 5, players: { 101: { tot_brake_events: { unit: "number", value: 2 }, g2_jumps: { unit: "number", value: 9, more: 1 }, g2_hidden: { unit: "number", value: 1 } } } },
      drills: { 0: { drills_count: 0, players: { 101: { g2_jumps: { unit: "number", value: 5 }, g2_hidden: { unit: "number", value: 1 } } } } },
    },
  };
  const kept = projectStoredDetails(bundle, { details: ["g2_jumps"] });
  assert.deepEqual(kept.details.full, { players: { 101: { tot_brake_events: { unit: "number", value: 2 }, g2_jumps: { unit: "number", value: 9 } } }, drills_count: 1 });
  assert.deepEqual(kept.details.drills, { 0: { players: { 101: { g2_jumps: { unit: "number", value: 5 } } } } });
  assert.deepEqual(kept.athleteSessions, bundle.athleteSessions);
  const consumedOnly = projectStoredDetails(bundle);
  assert.deepEqual(consumedOnly.details.full.players, { 101: { tot_brake_events: { unit: "number", value: 2 } } });
  assert.deepEqual(bundle.details.full.players[101].g2_hidden, { unit: "number", value: 1 }, "the input is untouched");
});
