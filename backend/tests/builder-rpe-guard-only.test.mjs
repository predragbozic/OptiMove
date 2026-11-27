import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  builderRpeFixtureApi, createBuilderRpeFixtureDraft, withBuilderRpeGuardFixture,
} from "./support/builder-rpe-guard-fixture.mjs";
import { execFileSync } from "node:child_process";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";

test("guard preserves ambiguous predecessor drafts and publishes all-off and proven drafts", async () => {
  await withBuilderRpeGuardFixture(async ({ db, oldApi, cookies, cases, athleteCode, snapshot, stopPrevious }) => {
    const legacyActive = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-05-10", { enable: true });
    const legacySubmission = await oldApi(`/api/builder/plans/${legacyActive.id}/submit`, { method: "POST" });
    assert.equal(legacySubmission.status, 200, JSON.stringify(legacySubmission.body));
    const legacyEdit = await oldApi(`/api/builder/plans/${legacyActive.id}/edit`, { method: "POST" });
    assert.equal(legacyEdit.status, 200, JSON.stringify(legacyEdit.body));
    const oldTemplate = async (weekly) => {
      const plan = await oldApi("/api/builder/plans", {
        method: "POST", body: { planType: "program", name: "Old enabled template", ...(weekly ? { templateKind: "weekly", weeks: 1 } : {}) },
      });
      assert.equal(plan.status, 201, JSON.stringify(plan.body));
      const id = plan.body.plan.id;
      const blocks = weekly ? plan : await oldApi(`/api/builder/plans/${id}/blocks`, { method: "POST", body: {} });
      assert.equal(blocks.status, 201, JSON.stringify(blocks.body));
      const added = await oldApi(`/api/builder/blocks/${blocks.body.blocks[0].id}/sessions`, {
        method: "POST", body: { name: "Old enabled session", bta: "T" },
      });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const enabled = await oldApi(`/api/builder/sessions/${added.body.blocks[0].sessions[0].id}`, {
        method: "PATCH", body: { trackingEnabled: true, rpeEnabled: true },
      });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      return id;
    };
    const weeklyTemplateId = await oldTemplate(true);
    const specificTemplateId = await oldTemplate(false);
    await stopPrevious();
    const bridge = await previousDashboardServer(db.url, {}, process.env.OPTIMOVE_BUILDER_RPE_BRIDGE_SHA
      ?? "66220c1224abdbdc0eaa1a23fa8d53591064a98a");
    let descendant;
    let descendantOfLaterPublished;
    let descendantWithInheritedDefault;
    try {
      const copied = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/plans/${cases.before.id}/duplicate`, {
        method: "POST", body: { athleteIds: [athleteCode], weekStart: "2027-05-17" },
      });
      assert.equal(copied.status, 201, JSON.stringify(copied.body));
      descendant = copied.body.plan.id;
      const derived = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/plans/${cases.before.id}/duplicate`, {
        method: "POST", body: { athleteIds: [athleteCode], weekStart: "2027-06-21" },
      });
      assert.equal(derived.status, 201, JSON.stringify(derived.body));
      descendantWithInheritedDefault = derived.body.plan.id;
      const originalSession = derived.body.blocks[0].sessions[0].id;
      const addInherited = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/blocks/${derived.body.blocks[0].id}/sessions`, {
        method: "POST", body: { name: "Born under copied defaults", bta: "T" },
      });
      assert.equal(addInherited.status, 201, JSON.stringify(addInherited.body));
      const inherited = addInherited.body.blocks[0].sessions.find(row => row.id !== originalSession);
      const node = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/sessions/${inherited.id}/nodes`, {
        method: "POST", body: { nodeType: "domain", name: "Training content" },
      });
      assert.equal(node.status, 201, JSON.stringify(node.body));
      const deleted = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/sessions/${originalSession}`, { method: "DELETE" });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      const off = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/plans/${descendantWithInheritedDefault}/training-load-settings`, {
        method: "PATCH", body: { trackTrainingLoadDefault: false, requestRpeDefault: false },
      });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      const later = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/plans/${cases.during.id}/duplicate`, {
        method: "POST", body: { athleteIds: [athleteCode], weekStart: "2027-06-14" },
      });
      assert.equal(later.status, 201, JSON.stringify(later.body));
      descendantOfLaterPublished = later.body.plan.id;
      const publishedAfterCopy = await builderRpeFixtureApi(bridge, cookies.owner, `/api/builder/plans/${cases.during.id}/submit`, { method: "POST" });
      assert.equal(publishedAfterCopy.status, 200, JSON.stringify(publishedAfterCopy.body));
    } finally {
      await bridge.stop();
    }
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const server = await previousDashboardServer(db.url, {}, head);
    try {
      const api = (path, options) => builderRpeFixtureApi(server, cookies.owner, path, options);
      const submit = id => api(`/api/builder/plans/${id}/submit`, { method: "POST" });
      const ids = [...Object.values(cases).map(item => item.id), descendant, descendantOfLaterPublished, descendantWithInheritedDefault, weeklyTemplateId, specificTemplateId];
      const before = await snapshot(ids);
      for (const item of [cases.before, cases.editDraft, { id: descendant }, { id: descendantOfLaterPublished }, { id: descendantWithInheritedDefault }]) {
        const result = await submit(item.id);
        assert.equal(result.status, 409, JSON.stringify(result.body));
        assert.equal(result.body.code, "rpe_recovery_required");
        assert.deepEqual(await snapshot(ids), before);
      }
      const sourceDay = before.sessions.find(row => row.id === cases.before.sessionId).plan_day_id;
      const targetDay = before.sessions.find(row => row.id === cases.off.sessionId).plan_day_id;
      const samePlanDay = before.days.find(row => row.plan_id === cases.before.id && row.id !== sourceDay).id;
      const requestKeys = [randomUUID(), randomUUID()];
      const copies = [
        [`/api/builder/plans/${cases.before.id}/duplicate`, { athleteIds: [athleteCode], weekStart: "2027-05-24" }],
        [`/api/builder/sessions/${cases.before.sessionId}/copy-into/${targetDay}`, {}],
        [`/api/builder/days/${sourceDay}/copy-into/${samePlanDay}`, { confirmOverwrite: true }],
        [`/api/builder/blocks/${sourceDay}/copy-into/${targetDay}`, { confirmOverwrite: true }],
        ["/api/builder/weekly-templates", { name: "Unconfirmed copy", planIds: [cases.before.id] }],
        [`/api/builder/plans/${specificTemplateId}/duplicate`, { intent: "assign", athleteIds: [athleteCode], assignmentRequestId: requestKeys[0] }],
        [`/api/builder/plans/${weeklyTemplateId}/assign-weekly`, { athleteIds: [athleteCode], startDate: "2027-05-31", assignmentRequestId: requestKeys[1] }],
      ];
      const planCount = () => db.client.query("select count(*)::integer as n from plans.plans").then(({ rows }) => rows[0].n);
      const priorCount = await planCount();
      for (const [path, body] of copies) {
        const refused = await api(path, { method: "POST", body });
        assert.equal(refused.status, 409, path + " " + JSON.stringify(refused.body));
        assert.match(refused.body.error, /Training Load settings/, path);
        assert.equal(await planCount(), priorCount);
        assert.deepEqual(await snapshot(ids), before);
      }
      assert.equal((await db.client.query("select id from public.builder_assignment_requests where id=any($1::uuid[])", [requestKeys])).rowCount, 0);
      const safeCopy = await api(`/api/builder/plans/${cases.off.id}/duplicate`, {
        method: "POST", body: { athleteIds: [athleteCode], weekStart: "2027-06-07" },
      });
      assert.equal(safeCopy.status, 201, JSON.stringify(safeCopy.body));
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
