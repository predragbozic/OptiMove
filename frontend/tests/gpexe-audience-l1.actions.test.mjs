// P2's follow-up (the Independent reviewer's L1, 2026-11-13): a sentence may point at Technical details only for the
// platform admin, who is the only reader that has them. One assertion per role for each sentence that names them.
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { emptyTrainingLoadState, state } = await import("../state.js");
const view = await import("../gpexe-import-view.js");

const ROLES = [
  ["coach", {}],
  ["club admin", { identityAdmin: true }],
  ["platform admin", { identityAdmin: true, isPlatformAdmin: true }],
];

function as(viewer) {
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.gpexe.status = { settings: { gpexeTeamId: "980" }, importSwitch: { enabled: true }, viewer: { canApprove: true, isPlatformAdmin: false, ...viewer } };
}

const candidate = { id: "c-1", sessionStartedAt: "2026-10-06T16:08:12Z", approvalBlockers: ["not_confirmed_for_import"] };

for (const [who, viewer] of ROLES) {
  const platform = who === "platform admin";
  test(`L1 (${who}): no sentence points at Technical details the reader does not have`, () => {
    as(viewer);
    const texts = {
      notConfirmed: view.notConfirmedText(candidate, state.trainingLoad.gpexe),
      leftOut: view.leftOutText({ reason: "no_such_reason" }),
      identityCheck: view.identityCheckRefusalText({ code: "internal_error" }),
      mapNote: view.mapNumberNote(),
      batchGiveUp: view.batchGiveUpText(),
    };
    for (const [name, text] of Object.entries(texts)) {
      if (name === "notConfirmed") continue;
      assert.equal(/Technical details/.test(text), platform, `${who}, ${name}: ${text}`);
    }
    // The two causes and the GPEXE step are the platform admin's (manager, 2026-11-13: keep it as built).
    assert.equal(/drill data for fewer than two of its drills/.test(texts.notConfirmed), platform, `${who}, notConfirmed: ${texts.notConfirmed}`);
    assert.match(texts.notConfirmed, /Find new sessions again/, `${who}: one step for everyone`);
    if (!platform) {
      assert.match(texts.batchGiveUp, who === "coach" ? /^Ask your club administrator to check these imports\.$/ : /^Contact OptiMove support to check these imports\.$/);
      assert.equal(texts.leftOut, "other reason");
    }
  });
}
