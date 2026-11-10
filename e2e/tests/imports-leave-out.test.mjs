// Scenario 10 (J20-B): an administrator leaves one athlete out of a ready session through the Session review, reviews the
// import without them and imports exactly the others. Invented data only; the import writes into the disposable database.
// 1280 and 390 px; screenshots go to E2E_SHOT_DIR when it is set.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const G = "/api/training-load/gpexe";
const shot = (page, name) => page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/${name}.png` : "/dev/null", fullPage: false }).catch(() => {});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
test(`10. (${label}) the administrator leaves one athlete out, reviews the import without them and imports the others`, async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    const setup = await prepareImports(world);
    const ready = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9101");
    assert.equal(ready.reasons.length, 0, "a clean ready session");
    const admin = await openAs(browser, world, "platform_admin", width);
    try {
      admin.page.on("dialog", (d) => d.accept());
      const posts = [];
      admin.page.on("request", (r) => { if (r.method() === "POST" && /\/(preview|approve)$/.test(r.url())) posts.push(`${r.url().split("/").pop()} ${r.postData() || ""}`); });
      await openTrainingLoad(admin.page);
      await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
      await admin.page.waitForSelector('[data-action="training-load-gpexe-open"]', { timeout: 20_000 });
      await admin.page.locator('[data-action="training-load-gpexe-open"]', { hasText: "04.11.2026" }).first().click().catch(async () => {
        await admin.page.locator('[data-action="training-load-gpexe-open"]').first().click();
      });
      await admin.page.waitForSelector(".gpexe-detail .gpexe-review-table", { timeout: 20_000 });
      // J20-C: the rows without a GPEXE record now need a person (an attendance choice), so the importable rows sit under
      // "N athletes are fine", which the screen tells the coach to open.
      const fine = admin.page.locator(".gpexe-detail details.gpexe-fine", { has: admin.page.locator("summary", { hasText: /athletes? (?:is|are) fine$/ }) }).first();
      if (!(await fine.evaluate((el) => el.open))) await fine.locator("summary").click();
      const boxes = admin.page.locator('[data-action="training-load-gpexe-leave-out"]');
      assert.equal(await boxes.count(), 3, "a Leave out box on each importable row");
      assert.match((await admin.page.locator('[data-action="training-load-gpexe-approve"]').first().textContent()).trim(), /^Import 3 athletes$/);
      await shot(admin.page, `leave-out-1-review-${width}`);
      // Tick the last athlete: nothing is sent, the whole-session button is replaced by the review step.
      await boxes.nth(2).check();
      assert.deepEqual(posts, [], "a tick sends nothing");
      assert.equal(await admin.page.locator('[data-action="training-load-gpexe-approve"]').count(), 0);
      assert.match(await admin.page.locator(".gpexe-approve-subset").innerText(), /Leaving out 1 athlete/);
      await shot(admin.page, `leave-out-2-ticked-${width}`);
      await admin.page.click('[data-action="training-load-gpexe-subset-review"]');
      await admin.page.waitForSelector('[data-action="training-load-gpexe-approve"]', { timeout: 20_000 });
      assert.equal(posts.length, 1);
      assert.match(posts[0], /^preview \{"excludedAthleteIds":\["\d+"\]\}$/);
      assert.match((await admin.page.locator('[data-action="training-load-gpexe-approve"]').first().textContent()).trim(), /^Import 2 athletes$/);
      await shot(admin.page, `leave-out-3-reviewed-${width}`);
      await admin.page.click('[data-action="training-load-gpexe-approve"]');
      let after = null;
      for (let i = 0; i < 60; i += 1) {
        after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${ready.id}`)).body.candidate;
        if (after.status === "imported") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(after.status, "imported");
      assert.equal(after.approval.excludedAthleteIds.length, 1, "the approval records who was left out");
      await admin.page.waitForSelector(".gpexe-success", { timeout: 20_000 });
      const successText = (await admin.page.locator(".gpexe-success").allInnerTexts()).join(" | ");
      assert.match(successText, /1 athlete was left out/, `the outcome names the left-out athlete (shown: ${successText})`);
      await shot(admin.page, `leave-out-4-imported-${width}`);
      const db = new pg.Client({ connectionString: world.databaseUrl });
      await db.connect();
      try {
        const n = async (sql) => Number((await db.query(sql)).rows[0].n);
        assert.equal(await n(`select count(*) n from training_load.metric_event_participants`), 2, "only the two athletes that were not left out");
        const a = (await db.query(`select excluded_athlete_ids, subset_hash from training_load.gpexe_import_approvals`)).rows;
        assert.equal(a.length, 1);
        assert.deepEqual(a[0].excluded_athlete_ids, after.approval.excludedAthleteIds);
        assert.match(a[0].subset_hash, /^[0-9a-f]{64}$/);
      } finally {
        await db.end();
      }
      // Reopened, the imported session marks the athlete as left out by the coach.
      await admin.page.reload();
      await admin.page.click('[data-action="training-load-section"][data-section="imports"]').catch(() => {});
    } finally {
      await admin.context.close();
    }
  } finally {
    await world.stop();
  }
});
}
