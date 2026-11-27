import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builderRpeFixtureApi, createBuilderRpeFixtureDraft, withBuilderRpeGuardFixture,
} from "./support/builder-rpe-guard-fixture.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";

test("guard fixture preserves real predecessor drafts created before and during v106 overlap", async () => {
  await withBuilderRpeGuardFixture(async ({ db, cookies, cases, snapshot, stopPrevious, owner, team, athleteCode, club }) => {
    const ids = Object.values(cases).map(item => item.id);
    const legacy = await snapshot(ids);
    assert.equal(legacy.plans.length, ids.length);
    assert.equal(legacy.plan_baselines.length, 0);
    assert.equal(legacy.session_baselines.length, 0);
    assert.equal(legacy.plan_effects.length, 0);
    assert.equal(legacy.session_effects.length, 0);
    assert.equal(legacy.first_use.length, 0);
    for (const item of [cases.before, cases.during, cases.editDraft]) {
      const plan = legacy.plans.find(row => row.id === item.id);
      const session = legacy.sessions.find(row => row.id === item.sessionId);
      assert.deepEqual([plan.status, plan.track_training_load_default, plan.request_rpe_default], ["draft", true, true]);
      assert.deepEqual([session.training_load_enabled, session.rpe_enabled], [true, true]);
    }
    const off = legacy.plans.find(row => row.id === cases.off.id);
    assert.equal(off.track_training_load_default || off.request_rpe_default, false);
    const staged = (await db.client.query("select public.user_has_permission($1,'programs.rpe_settings','team',$2) as allowed", [owner, team])).rows[0];
    assert.equal(staged.allowed, true);
    await stopPrevious();

    const bridge = await previousDashboardServer(db.url, {}, process.env.OPTIMOVE_BUILDER_RPE_BRIDGE_SHA ?? "bac5c86a953b0ada8c0992cf97ba73b7234eed58");
    try {
      const api = (path, options) => builderRpeFixtureApi(bridge, cookies.owner, path, options);
      const catalog = await builderRpeFixtureApi(bridge, cookies.platform, `/api/organization/roles/catalog?clubId=${club}`);
      assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
      const word = catalog.body.permissions.find(item => item.word === "programs.rpe_settings");
      assert.deepEqual([word.checked, word.storable], [false, false]);
      const reopened = await api(`/api/builder/plans/${cases.saved.id}/edit`, { method: "POST" });
      assert.equal(reopened.status, 200);
      assert.equal(reopened.body.plan.id, cases.editDraft.id);
      assert.deepEqual(await snapshot(ids), legacy);
      const current = await createBuilderRpeFixtureDraft(api, athleteCode, "2027-05-03", { enable: true });
      const proven = await snapshot([current.id]);
      assert.equal(proven.plan_baselines.length, 1);
      assert.equal(proven.session_baselines.length, 1);
      assert.equal(proven.plan_effects.length, 1);
      assert.equal(proven.session_effects.length, 1);
      assert.equal(proven.first_use.length, 1);
    } finally {
      await bridge.stop();
    }
  });
});
