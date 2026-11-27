import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { builderRpeFixtureApi, createBuilderRpeFixtureDraft, withBuilderRpeGuardFixture } from "./support/builder-rpe-guard-fixture.mjs";
import { execFileSync } from "node:child_process";
import { createSession } from "../src/auth.js";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";

test("an explicit recovery review preserves and then publishes a legacy draft in its own scope", async () => {
  await withBuilderRpeGuardFixture(async ({ db, cases, cookies, owner, team, snapshot, oldApi, athleteCode, stopPrevious }) => {
    const defaultsOnly = await createBuilderRpeFixtureDraft(oldApi, athleteCode, "2027-06-28");
    const defaults = await oldApi("/api/builder/plans/" + defaultsOnly.id + "/training-load-settings", {
      method: "PATCH", body: { trackTrainingLoadDefault: true, requestRpeDefault: true },
    });
    assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
    await stopPrevious();
    // The current server also uses the Programs Edit bridge.
    await db.applyThrough("202612111000");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    let server;
    const submit = (id, body, cookie = cookies.owner) =>
      builderRpeFixtureApi(server, cookie, "/api/builder/plans/" + id + "/submit", { method: "POST", body });
    const ids = [cases.before.id, cases.saved.id, cases.editDraft.id];
    try {
      server = await previousDashboardServer(db.url, { BUILDER_RPE_REVIEW_SIGNING_KEY: "" }, head);
      const noKey = await submit(cases.before.id);
      assert.equal(noKey.status, 409, noKey.text);
      assert.equal(noKey.body.code, "rpe_recovery_required");
      assert.equal(noKey.body.review, undefined);
      await server.stop();
      server = await previousDashboardServer(db.url, { BUILDER_RPE_REVIEW_SIGNING_KEY: randomBytes(32).toString("hex") }, head);
      const before = await snapshot(ids);
      const proposal = await submit(cases.before.id, { batchScope: "this" });
      assert.equal(proposal.status, 409, proposal.text);
      assert.equal(proposal.body.code, "rpe_recovery_required");
      const { token, expiresAt, scope, summary } = proposal.body.review;
      assert.equal(scope, "this");
      assert.ok(Date.parse(expiresAt) > Date.now());
      assert.deepEqual(summary, { plans: 1, sessions: 1, trackTrainingLoadDefault: true, requestRpeDefault: true, trackingEnabledSessions: 1, rpeEnabledSessions: 1 });
      assert.deepEqual(await snapshot(ids), before);
      const defaultsReview = await submit(defaultsOnly.id, { batchScope: "this" });
      assert.equal(defaultsReview.status, 409, defaultsReview.text);
      assert.deepEqual(defaultsReview.body.review.summary, {
        plans: 1, sessions: 1, trackTrainingLoadDefault: true, requestRpeDefault: true,
        trackingEnabledSessions: 0, rpeEnabledSessions: 0,
      });

      const request = { batchScope: "this", rpeReviewToken: token };
      const otherSession = "optimove_session=" + await createSession(owner, db.client);
      for (const result of [
        await submit(cases.before.id, request, otherSession),
        await submit(cases.before.id, { ...request, unused: true }),
        await submit(cases.before.id, { ...request, batchScope: "all" }),
        await submit(cases.editDraft.id, request),
        await submit(cases.before.id, { ...request, rpeReviewToken: token.replace(/^[0-9]{13}/, "1000000000000") }),
      ]) {
        assert.equal(result.status, 409, result.text);
        assert.equal(result.body.review, undefined);
      }
      const foreign = await submit(cases.before.id, request, cookies.otherCoach);
      assert.equal(foreign.status, 404, foreign.text);
      assert.equal(foreign.body.review, undefined);
      assert.deepEqual(await snapshot(ids), before);

      await db.client.query("update plans.plan_sessions set name=$2 where id=$1", [cases.before.sessionId, "Changed after review"]);
      const changed = await snapshot(ids);
      const stale = await submit(cases.before.id, request);
      assert.equal(stale.status, 409, stale.text);
      assert.equal(stale.body.review, undefined);
      assert.deepEqual(await snapshot(ids), changed);

      const renewed = await submit(cases.before.id, { batchScope: "this" });
      assert.equal(renewed.status, 409, renewed.text);
      request.rpeReviewToken = renewed.body.review.token;
      await db.client.query("update public.user_team_roles set is_active=false where user_id=$1 and team_id=$2", [owner, team]);
      const revoked = await submit(cases.before.id, request);
      assert.equal(revoked.status, 403, revoked.text);
      assert.equal(revoked.body.review, undefined);
      assert.deepEqual(await snapshot(ids), changed);
      await db.client.query("update public.user_team_roles set is_active=true where user_id=$1 and team_id=$2", [owner, team]);
      const again = await submit(cases.before.id, { batchScope: "this" });
      request.rpeReviewToken = again.body.review.token;
      const finished = await submit(cases.before.id, request);
      assert.equal(finished.status, 200, finished.text);
      const after = await snapshot([cases.before.id]);
      assert.equal(after.plans[0].status, "active");
      assert.equal(after.sessions[0].rpe_enabled, true);
      assert.equal(after.plan_baselines.length, 0);
      assert.equal(after.session_baselines.length, 0);
      assert.equal(after.first_use.length, 1);
      const replay = await submit(cases.before.id, request);
      assert.equal(replay.status, 409, replay.text);
      assert.deepEqual(await snapshot([cases.before.id]), after);

      const editProposal = await submit(cases.editDraft.id, { batchScope: "this" }, cookies.platform);
      assert.equal(editProposal.status, 409, editProposal.text);
      const edit = await submit(cases.editDraft.id, { batchScope: "this", rpeReviewToken: editProposal.body.review.token }, cookies.platform);
      assert.equal(edit.status, 200, edit.text);
      const applied = await snapshot([cases.editDraft.id, cases.saved.id]);
      assert.equal(applied.plans.length, 1);
      assert.equal(applied.plans[0].id, cases.saved.id);
      assert.equal(applied.sessions[0].rpe_enabled, true);
    } finally {
      await server?.stop();
    }
  });
});
