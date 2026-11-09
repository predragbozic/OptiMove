// A late Home answer must not draw Home over another screen. Found during the design work (2026-11-09):
// on a phone, Settings opened right after load sometimes showed Home's cards under the "Settings" title,
// because renderCoachHome painted whenever /api/athletes/today answered, whatever screen was open by then.
// The test holds that answer, opens Settings, then lets the answer through.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

for (const [label, width] of [["390 px", WIDTHS.phone], ["1280 px", WIDTHS.desktop]]) {
  test(`(${label}) Home's late answer does not replace Settings`, async () => {
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    const account = world.accounts.find((a) => a.role === "club_admin");
    await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let heldCount = 0;
    await context.route("**/api/athletes/today*", async (route) => {
      heldCount += 1;
      await held;
      await route.continue();
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      await page.goto(world.baseUrl);
      await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
      for (let i = 0; i < 100 && heldCount < 1; i += 1) await page.waitForTimeout(100);
      assert.ok(heldCount >= 1, "Home asked for its roster");
      await page.evaluate(() => document.querySelector('.rail-button[data-library-tab="organization"]').click());
      await page.waitForSelector(".organization-view", { timeout: 20_000 });
      // Home's answer arrives now and must really reach the page, or the checks below would prove nothing.
      const lateAnswer = page.waitForResponse((r) => r.url().includes("/api/athletes/today"), { timeout: 20_000 });
      release();
      const late = await lateAnswer;
      assert.ok(late.status() >= 200, `the held roster answer reached the page (${late.status()})`);
      await page.waitForTimeout(1000);
      assert.equal(await page.locator("#screenTitle").textContent(), "Settings");
      assert.equal(await page.locator(".organization-view").count(), 1, "Settings is still on screen");
      assert.equal(await page.locator(".coach-home").count(), 0, "Home did not draw over it");
      // Home still works when opened again.
      await page.evaluate(() => document.querySelector('[data-action="brand-home"]').click());
      await page.waitForSelector(".coach-home", { timeout: 20_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      release();
      await context.close();
    }
  });
}
