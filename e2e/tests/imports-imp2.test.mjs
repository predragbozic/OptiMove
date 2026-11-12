// IMP2 / IMP3: the batch import dialog as the "GPS Import Flow" sketch, and the banner after the import, in a real browser at 1280 and 390 px: one question over
// one light list (no framed cards), what happens folded, Cancel and a filled Import, then "Imported N sessions. You can
// see them in Training Load → Activities." over a light list with each outcome on the right. Invented data on a
// disposable database (the series fixture: three Ready sessions); the import writes into it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`IMP2 (${label}): the confirmation and the result are light, with 44 px buttons and no overflow`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "series", batchBudgetMs: 0 } });
    try {
      const setup = await prepareImports(world, { from: "2026-11-01", to: "2026-11-08" });
      const coachAccount = world.accounts.find((a) => a.role === "team_coach");
      const grant = await setup.call("platform_admin", "POST", `/api/training-load/gpexe/teams/${setup.teamId}/approvers`, { userId: coachAccount.id, reason: "e2e: the team's coach approves its own imports" });
      assert.equal(grant.status, 201);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        await openTrainingLoad(page);
        await page.click('[data-action="training-load-section"][data-section="imports"]');
        await page.waitForSelector(".imports-tab-panel", { timeout: 20_000 });
        await page.click('[data-action="training-load-gpexe-import-ready"]');
        await page.waitForSelector(".imports-batch .imports-batch-question");
        const confirm = await page.evaluate(() => {
          const d = document.querySelector(".imports-batch");
          const rows = [...d.querySelectorAll(".imports-batch-list li")];
          const buttons = [...d.querySelectorAll(".imports-batch-actions button")];
          return {
            rows: rows.length,
            framed: rows.filter((r) => getComputedStyle(r).borderTopWidth !== "0px" || getComputedStyle(r).borderLeftWidth !== "0px").length,
            notesFolded: !d.querySelector(".imports-batch-more").open,
            buttons: buttons.map((b) => `${b.textContent.trim()}:${Math.round(b.getBoundingClientRect().height)}`),
            overflow: d.scrollWidth - d.clientWidth,
            page: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        assert.equal(confirm.rows, 3);
        assert.equal(confirm.framed, 0, "light rows, no frames");
        assert.ok(confirm.notesFolded, "what happens is folded");
        assert.deepEqual(confirm.buttons.map((b) => b.split(":")[0]), ["Cancel", "Import 3 sessions"]);
        assert.ok(confirm.buttons.every((b) => Number(b.split(":")[1]) >= 44), confirm.buttons.join(", "));
        assert.ok(confirm.overflow <= 0 && confirm.page === 0, "no horizontal overflow");
        await page.click('[data-action="training-load-gpexe-batch-send"]');
        await page.waitForSelector('.imports-batch[aria-label="Import result"]', { timeout: 60_000 });
        const result = await page.evaluate(() => {
          const d = document.querySelector(".imports-batch");
          const outcome = d.querySelector(".imports-batch-results li .imports-batch-outcome");
          const li = outcome.closest("li").getBoundingClientRect();
          return {
            summary: d.querySelector(".imports-batch-summary").textContent.trim(),
            techBlocks: d.querySelectorAll("details.gpexe-tech").length,
            outcomeRight: Math.round(li.right - outcome.getBoundingClientRect().right),
            dot: getComputedStyle(outcome, "::before").backgroundColor,
            overflow: d.scrollWidth - d.clientWidth,
          };
        });
        assert.equal(result.summary, "Imported 3 sessions. You can see them in Training Load → Activities and in the Imported tab.");
        assert.equal(result.techBlocks, 1, "one Technical details for the whole result");
        assert.ok(result.outcomeRight <= 2, `the outcome sits on the right (${result.outcomeRight} px)`);
        assert.notEqual(result.dot, "rgba(0, 0, 0, 0)", "the outcome carries its dot");
        assert.ok(result.overflow <= 0);
        // IMP3: after Done the banner says it, as the sketch does (the search succeeded, nothing is left).
        await page.click('.imports-batch [data-action="training-load-gpexe-batch-done"]');
        await page.waitForSelector(".imports-batch", { state: "detached" });
        await page.waitForFunction(() => /^Everything from GPEXE is imported · Last search /.test(document.querySelector(".imports-lastsearch")?.textContent.trim() || ""), null, { timeout: 20_000 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    } finally { await world.stop(); }
  });
}
