import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBuilderRpeFixtureDraft, withBuilderRpeGuardFixture,
} from "./support/builder-rpe-guard-fixture.mjs";
import { execFileSync } from "node:child_process";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { builderRpeFixtureApi } from "./support/builder-rpe-guard-fixture.mjs";

test("guard preserves ambiguous predecessor drafts and publishes all-off and proven drafts", async () => {
  await withBuilderRpeGuardFixture(async ({ db, oldApi, cookies, cases, athleteCode, snapshot, stopPrevious }) => {
    const legacyActive = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-05-10", { enable: true });
    const legacySubmission = await oldApi(`/api/builder/plans/${legacyActive.id}/submit`, { method: "POST" });
    assert.equal(legacySubmission.status, 200, JSON.stringify(legacySubmission.body));
    const legacyEdit = await oldApi(`/api/builder/plans/${legacyActive.id}/edit`, { method: "POST" });
    assert.equal(legacyEdit.status, 200, JSON.stringify(legacyEdit.body));
    await stopPrevious();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const server = await previousDashboardServer(db.url, {}, head);
    try {
      const api = (path, options) => builderRpeFixtureApi(server, cookies.owner, path, options);
      const submit = id => api(`/api/builder/plans/${id}/submit`, { method: "POST" });
      const ids = Object.values(cases).map(item => item.id);
      const before = await snapshot(ids);
      for (const item of [cases.before, cases.during, cases.editDraft]) {
        const result = await submit(item.id);
        assert.equal(result.status, 409, JSON.stringify(result.body));
        assert.equal(result.body.code, "rpe_recovery_required");
        assert.deepEqual(await snapshot(ids), before);
      }
      const unchanged = await submit(legacyEdit.body.plan.id);
      assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
      const legacyPublished = await snapshot([legacyActive.id]);
      assert.equal(legacyPublished.plans[0].request_rpe_default, true);
      assert.equal(legacyPublished.sessions[0].rpe_enabled, true);
      const off = await submit(cases.off.id);
      assert.equal(off.status, 200, JSON.stringify(off.body));
      const established = await createBuilderRpeFixtureDraft(api, athleteCode, "2027-05-03", { enable: true });
      const positive = await submit(established.id);
      assert.equal(positive.status, 200, JSON.stringify(positive.body));
      const published = await snapshot([cases.off.id, established.id]);
      for (const plan of published.plans) assert.equal(plan.status, "active");
      assert.equal(published.sessions.find(row => row.id === established.sessionId).rpe_enabled, true);
    } finally {
      await server.stop();
    }
  });
});
