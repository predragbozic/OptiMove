// Scenario 12 (J20-C): a platform administrator chooses an attendance state on a row without a GPEXE record in the Session
// review and imports; the state is saved right after the import, bound to its approval (origin 'import'). Invented data only;
// the import writes into the disposable database. 1280 and 390 px; screenshots go to E2E_SHOT_DIR when it is set.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const shot = (page, name) => page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/${name}.png` : "/dev/null", fullPage: false }).catch(() => {});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`12. (${label}) an attendance state chosen in the review is saved right after the import, as the import's own`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      await prepareImports(world);
      const admin = await openAs(browser, world, "platform_admin", width);
      try {
        const dialogs = [];
        admin.page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
        const posts = [];
        admin.page.on("request", (r) => { if (r.method() === "POST" && /\/(approve|states)$/.test(r.url())) posts.push(r.url().split("/").pop()); });
        await openTrainingLoad(admin.page);
        await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
        await admin.page.waitForSelector('[data-action="training-load-gpexe-open"]', { timeout: 20_000 });
        await admin.page.locator('[data-action="training-load-gpexe-open"]', { hasText: "04.11.2026" }).first().click().catch(async () => {
          await admin.page.locator('[data-action="training-load-gpexe-open"]').first().click();
        });
        await admin.page.waitForSelector(".gpexe-detail .gpexe-review-table", { timeout: 20_000 });
        const chooser = admin.page.locator('select[data-action="training-load-gpexe-state"]:visible').first();
        await chooser.waitFor({ timeout: 10_000 });
        const athleteId = await chooser.getAttribute("data-athlete-id");
        const box = await chooser.boundingBox();
        assert.ok(box && box.height >= 44, `the chooser is at least 44 px high (${box?.height})`);
        const fontSize = await chooser.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        assert.ok(fontSize >= 16, `16 px text, no zoom on focus (${fontSize})`);
        await chooser.selectOption("participated_no_values");
        assert.deepEqual(posts, [], "a choice sends nothing");
        await admin.page.waitForFunction(() => /After the import, OptiMove also saves 1 attendance state\./.test(document.body.innerText), null, { timeout: 10_000 });
        await shot(admin.page, `states-1-chosen-${width}`);
        await admin.page.click('[data-action="training-load-gpexe-approve"]');
        await admin.page.waitForFunction(() => /1 attendance state saved\./.test(document.body.innerText), null, { timeout: 30_000 });
        assert.equal(dialogs.length, 1);
        assert.match(dialogs[0], /Then it saves 1 attendance state\./);
        assert.deepEqual(posts, ["approve", "states"], "the states follow the confirmed import");
        await shot(admin.page, `states-2-saved-${width}`);
        const rows = (await db.query(
          `select r.origin, r.origin_approval_id = a.id as bound, d.athlete_id, d.decision_kind
             from training.activity_roster_requests r join training.activity_athlete_decisions d on d.request_id = r.id
             join training_load.gpexe_import_approvals a on a.activity_id = r.activity_id`)).rows;
        assert.deepEqual(rows, [{ origin: "import", bound: true, athlete_id: athleteId, decision_kind: "participated_no_values" }]);
        const horizontal = await admin.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        assert.equal(horizontal, false, "no horizontal scroll");
      } finally {
        await admin.context.close();
      }
    } finally {
      await db.end();
      await world.stop();
    }
  });
}
