// The Imports state: the server's candidateState (backend/src/gpexeImportState.js, used by the candidate list and the
// Imports calendar) and the frontend's inboxBucket agree on every summary when the browser holds none of its own facts (no
// approval with a lost answer, no link made since the last search). If either rule changes alone, this fails.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { inboxBucket } = await import("../gpexe-import-data.js");
const { candidateState } = await import("../../backend/src/gpexeImportState.js");

// The frontend's bucket words, in the server's words.
const WORD = { hidden: "hidden", imported: "imported", out: "out", attention: "needs", ready: "ready" };
// A browser that has seen nothing of its own: no uncertain approval, no link change.
const quiet = { uncertain: {}, linkSeq: 0, linkCheckStartedAt: null, recomputedAtLinkSeq: {} };

const base = {
  status: "pending", snapshot: { available: true }, previewStatus: "ready", blockedCode: null, approvalBlockers: [],
  reasons: [], importUndoneAt: null, supersededByCandidateId: null, supersededByCheckId: null, counts: {}, changesToImported: 0,
};
const cases = {
  ready: {},
  "a reason": { reasons: [{ code: "athletes_not_linked", count: 1 }] },
  "changes to imported results": { reasons: [{ code: "changes_to_imported_results", count: 2 }], changesToImported: 2 },
  "nothing new, somebody imported": { previewStatus: "no_changes" },
  "nothing new, nobody linked": { previewStatus: "no_changes", reasons: [{ code: "no_linked_athlete", count: 3 }] },
  "not confirmed by a successful search": { approvalBlockers: ["not_confirmed_for_import"] },
  "no blockers at all (fail-closed)": { approvalBlockers: undefined },
  "snapshot expired": { snapshot: { available: false } },
  "blocked, other": { status: "blocked", blockedCode: "mapping_not_usable", previewStatus: "blocked" },
  "blocked, a session type that stays out": { status: "blocked", blockedCode: "unsupported_session_type", previewStatus: "blocked" },
  imported: { status: "imported", approvalBlockers: ["already_imported"] },
  "import undone": { status: "imported", importUndoneAt: "2026-11-01T10:00:00Z", approvalBlockers: ["import_undone"] },
  "replaced by newer content": { status: "superseded", supersededByCandidateId: "c-2", approvalBlockers: ["superseded_by_newer_data"] },
  "withdrawn by a search": { status: "superseded", supersededByCheckId: "k-1", approvalBlockers: ["not_confirmed_for_import"] },
  "import switch off only": { approvalBlockers: ["import_switch_off", "team_import_switch_off"] },
};

test("parity: the server's candidateState equals the frontend's inboxBucket for every summary shape, with no browser-only fact", () => {
  for (const [name, overrides] of Object.entries(cases)) {
    const c = { id: `c-${name}`, ...base, ...overrides };
    assert.equal(candidateState(c), WORD[inboxBucket(c, quiet)], name);
  }
});

test("parity: the browser's own facts are the only difference (they can only move a row to needs)", () => {
  const c = { id: "c-ready", ...base };
  assert.equal(candidateState(c), "ready");
  assert.equal(inboxBucket(c, { ...quiet, uncertain: { "c-ready": true } }), "attention", "an approval whose answer was lost in this tab");
  assert.equal(inboxBucket(c, { ...quiet, linkSeq: 1, linkCheckStartedAt: null }), "attention", "a link made since the last search");
});
