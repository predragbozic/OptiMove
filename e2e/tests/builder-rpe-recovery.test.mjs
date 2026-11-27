import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { withBuilderRpeGuardFixture } from "../../backend/tests/support/builder-rpe-guard-fixture.mjs";
import { previousDashboardServer } from "../../backend/tests/support/dashboard-pages-old-server.mjs";
import { launch, navTo, openAs } from "../lib/browser.mjs";

test("legacy Builder RPE review applies only after confirmation on desktop and phone", async () => {
  await withBuilderRpeGuardFixture(async ({ db, cases, cookies, snapshot, stopPrevious }) => {
    await stopPrevious();
    await db.applyThrough("202612121000");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const server = await previousDashboardServer(db.url, { BUILDER_RPE_REVIEW_SIGNING_KEY: randomBytes(32).toString("hex") }, head);
    let browser;
    try {
      browser = await launch();
      const world = { baseUrl: server.baseUrl, accounts: [{ role: "team_coach", sessionToken: cookies.owner.split("=")[1] }] };
      for (const [width, draft] of [[1280, cases.before], [390, cases.during]]) {
        const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
        try {
          const target = "/api/builder/plans/" + draft.id + "/submit";
          const submitResponse = () => page.waitForResponse(res => new URL(res.url()).pathname === target && res.request().method() === "POST");
          const prior = await snapshot([draft.id]);
          await navTo(page, '[data-library-tab="builder"]');
          await page.getByText("Continue where you left off").first().click();
          await page.locator('[data-action="builder-open-draft"][data-plan-id="' + draft.id + '"]').click();
          const submit = page.locator('[data-action="builder-submit-plan"]').first();
          const review = page.getByRole("dialog", { name: "Confirm Training Load settings" });
          const initialFetch = submitResponse();
          await submit.click();
          const initialResponse = await initialFetch;
          assert.equal(initialResponse.status(), 409);
          const initialPayload = initialResponse.request().postDataJSON();
          await review.waitFor();
          assert.equal(await review.locator('dt:text-is("Tracking for new sessions") + dd').textContent(), "On");
          assert.equal(await review.locator('dt:text-is("Request RPE for new sessions") + dd').textContent(), "On");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
          await review.getByRole("button", { name: "Cancel", exact: true }).click();
          await review.waitFor({ state: "hidden" });
          assert.deepEqual(await snapshot([draft.id]), prior);

          const secondFetch = submitResponse();
          await submit.click();
          const secondResponse = await secondFetch;
          assert.equal(secondResponse.status(), 409);
          const second = await secondResponse.json();
          await review.waitFor();
          assert.equal((await page.content()).includes(second.review.token), false);
          const saving = submitResponse();
          await review.getByRole("button", { name: "Confirm and save", exact: true }).click();
          const saved = await saving;
          assert.equal(saved.status(), 200);
          const { rpeReviewToken, ...retryPayload } = saved.request().postDataJSON();
          assert.deepEqual(retryPayload, initialPayload);
          assert.equal(rpeReviewToken === second.review.token, true);
          await review.waitFor({ state: "hidden" });
          const actual = await snapshot([draft.id]);
          assert.equal(actual.plans[0].status, "active");
          assert.equal(actual.sessions[0].rpe_enabled, true);
          assert.equal(actual.plan_baselines.length, 0);
          assert.deepEqual(pageErrors, []);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      await server.stop();
    }
  });
});
