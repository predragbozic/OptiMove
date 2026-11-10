// Back while Training Load is still loading: Home opens an athlete in Training Load, the athlete's week is held,
// the coach presses Back, then the held answer arrives. Its late paint must not draw Training Load under the Home
// title (before the fix it did: Home's title with Training Load's content). At 1280 and 390 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const isAthleteWeek = (url) => url.includes("/api/training-load/calendar") && url.includes("athleteIds=");

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`(${label}) a Training Load answer that lands after Back does not draw over Home`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let heldCount = 0;
    await page.route((url) => isAthleteWeek(url.href), async (route) => {
      heldCount += 1;
      await held;
      await route.continue().catch(() => {});
    });
    try {
      const openLoad = '[data-action="coach-home-open-athlete"][data-mode="load"]';
      await page.waitForSelector('[data-action="coach-home-open-athlete"]', { timeout: 20_000 });
      // Home's Athletes card may show the plan first; its switch then offers Training load.
      const loadTab = page.locator('[data-action="coach-home-athletes-mode"][data-mode="load"]');
      if (await loadTab.count()) await loadTab.click();
      const athlete = page.locator(openLoad).first();
      await athlete.scrollIntoViewIfNeeded();
      await athlete.click();
      await page.waitForSelector('[data-action="training-load-section"]', { timeout: 20_000 });
      for (let i = 0; i < 100 && heldCount < 1; i += 1) await page.waitForTimeout(50);
      assert.ok(heldCount >= 1, "the athlete's week was asked for and is held");

      await page.goBack();
      await page.waitForFunction(() => document.querySelector("#screenTitle")?.textContent.trim() === "Home", null, { timeout: 20_000 });
      await page.waitForSelector("[data-coach-home-section]", { timeout: 20_000 });

      const late = page.waitForResponse((r) => isAthleteWeek(r.url()), { timeout: 20_000 });
      release();
      await (await late).finished();
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForTimeout(500);

      assert.equal((await page.textContent("#screenTitle")).trim(), "Home");
      assert.equal(await page.locator('[data-action="training-load-section"]').count(), 0, "no Training Load drawn under Home");
      assert.ok(await page.locator("[data-coach-home-section]").count() > 0, "Home's cards are still on screen");
      assert.deepEqual(pageErrors, []);
    } finally {
      release();
      await context.close();
    }
  });
}
