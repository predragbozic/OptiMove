// Athlete screens: wording and targets (manager, 2026-11-16), in the real athlete app at 360 and 390 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openAthlete(width) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const home = async () => {
    await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
    await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  };
  const menu = async (tab) => {
    await home();
    await page.locator("#mobileNavToggle").click();
    await page.locator(`.sidebar [data-athlete-tab="${tab}"]`).first().click();
  };
  const under44 = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 44; }).map((e) => `${(e.innerText || e.getAttribute("aria-label") || "").trim()} ${Math.round(e.getBoundingClientRect().height)}`), selector);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  return { context, page, pageErrors, home, menu, under44, overflow };
}

for (const width of [360, 390]) {
  test(`(${width} px) the athlete's screens: no 0 badge, a sheet title that names the week, plain Programs and Account, 44 px targets`, async () => {
    const a = await openAthlete(width);
    try {
      await a.home();
      assert.deepEqual(await a.under44(".training-load-week-button"), [], "the This week button");
      await a.page.locator("#mobileNavToggle").click();
      await a.page.waitForTimeout(400);
      assert.equal(await a.page.locator(".sidebar [data-tests-count]").isVisible(), false, "no count of 0 on Tests");
      assert.deepEqual(await a.under44(".sidebar .brand-mark"), [], "the menu's logo");

      await a.home();
      await a.page.locator(".athlete-home-week-head .training-load-week-button").click();
      const title = a.page.locator(".training-load-athlete-weekly-panel h3");
      assert.equal((await title.innerText()).trim(), "This week's training load");
      assert.deepEqual(await a.under44(".training-load-athlete-weekly-panel .icon-button, .training-load-weekly-today-button"), [], "the sheet's controls");
      await a.page.locator('[data-action="training-load-athlete-weekly-prev-week"]').click();
      await a.page.waitForFunction(() => document.querySelector(".training-load-athlete-weekly-panel h3")?.textContent.trim() === "Training load", null, { timeout: 10_000 });

      await a.menu("athlete-library");
      const empty = a.page.locator(".program-library-page .empty-state");
      await empty.waitFor({ timeout: 20_000 });
      assert.equal((await empty.innerText()).trim(), "No programs have been shared with you yet.");
      assert.equal(await a.page.locator('[data-template-filter="lifecycle"], [data-template-filter="tag"], [data-template-filter="freeOnly"]').count(), 0, "no coach filters");
      assert.equal((await a.page.locator("[data-template-count]").innerText()).trim(), "", "no '0 programs'");

      await a.menu("programs");
      await a.page.getByText("You have no specific programs yet.").waitFor({ timeout: 20_000 });

      await a.menu("tests");
      await a.page.locator(".tests-section-tabs .tab").first().waitFor({ timeout: 20_000 });
      assert.deepEqual(await a.under44(".tests-section-tabs .tab"), [], "the Tests tabs");

      await a.menu("athlete-settings");
      await a.page.getByText("Your coach manages your programs and teams. You can edit your own details below.").waitFor({ timeout: 20_000 });
      assert.equal((await a.page.locator(".athlete-settings-identity-eyebrow").innerText()).trim().toLowerCase(), "account");
      assert.deepEqual(await a.under44(".athlete-simple-view button"), [], "the Account buttons");

      await a.home();
      await a.page.locator("#notificationToggle").click();
      await a.page.locator('[data-action="notifications-read-all"]').waitFor({ timeout: 10_000 });
      assert.deepEqual(await a.under44('[data-action="notifications-read-all"]'), [], "Mark all read");
      assert.equal(await a.overflow(), 0, "no horizontal page scroll");
      assert.deepEqual(a.pageErrors, []);
    } finally {
      await a.context.close();
    }
  });
}
