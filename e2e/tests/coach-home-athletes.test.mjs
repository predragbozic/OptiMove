// A coach's Home (PR5): Today first, then one Athletes card with a Training plan / Training load switch. The test
// clicks both tabs and opens an athlete from each: the plan opens the athlete's weekly plan, the load opens Training
// Load for that athlete. Back on Home the switch keeps the last choice (in memory only), and an empty day offers
// Plan a session, which opens the Calendar. At 1280 and 390 px, with no horizontal overflow and no page error.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const card = ".coach-home-athletes";
const pressed = (page) => page.evaluate(() => [...document.querySelectorAll(".coach-home-athletes-tab")].map((tab) => `${tab.dataset.mode}:${tab.getAttribute("aria-pressed")}`));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

// Back to Home with the browser's Back. Home is drawn again from its cache, so wait until both tabs are there.
async function backHome(page) {
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll(".coach-home-athletes .coach-home-athletes-tab").length === 2, null, { timeout: 20_000 })
    .catch(async (error) => {
      const seen = await page.evaluate(() => ({ title: document.querySelector("#screenTitle")?.textContent, sections: [...document.querySelectorAll("[data-coach-home-section]")].map((s) => s.dataset.coachHomeSection), tl: Boolean(document.querySelector('[data-action="training-load-section"]')), url: location.href }));
      throw new Error(`Home did not come back: ${JSON.stringify(seen)} (${error.message})`);
    });
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`(${label}) both tabs of the Athletes card open an athlete in the right place, and Home remembers the tab`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await page.waitForSelector(`${card} .coach-home-athletes-tab`, { timeout: 20_000 });
      const order = await page.evaluate(() => [...document.querySelectorAll(".coach-home-grid > [data-coach-home-section]")].map((s) => s.dataset.coachHomeSection));
      assert.deepEqual(order.slice(0, 2), ["day", "athletes"], "Today first, then Athletes");
      assert.equal(await page.locator(card).count(), 1, "one Athletes card");
      assert.deepEqual(await pressed(page), ["plan:true", "load:false"], "Training plan by default");
      for (const height of await page.evaluate(() => [...document.querySelectorAll(".coach-home-athletes-tab")].map((tab) => tab.getBoundingClientRect().height))) {
        assert.ok(height >= 44, `a tab is at least 44 px tall (${height})`);
      }
      assert.ok(await overflow(page) <= 0, "no horizontal overflow on Home");

      // Training plan: the first athlete opens their weekly plan.
      const planAthlete = page.locator(`${card} [data-action="coach-home-open-athlete"]`).first();
      assert.equal(await planAthlete.getAttribute("data-mode"), "plan");
      const planName = (await planAthlete.getAttribute("aria-label")).replace(/, Training plan$/, "");
      await planAthlete.scrollIntoViewIfNeeded();
      await planAthlete.click();
      await page.waitForSelector('.tab[data-tab="weekly"].is-active', { timeout: 20_000 });
      assert.equal((await page.textContent("#screenTitle")).trim(), planName);
      assert.equal(await page.locator('[data-action="training-load-section"]').count(), 0, "not Training Load");
      await backHome(page);
      assert.deepEqual(await pressed(page), ["plan:true", "load:false"]);

      // Training load: the switch moves the strip, the search and the items to the load mode.
      await page.click(`${card} .coach-home-athletes-tab[data-mode="load"]`);
      assert.deepEqual(await pressed(page), ["plan:false", "load:true"]);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.mode), "load", "focus stays on the pressed tab");
      assert.equal(await page.getAttribute(`${card} [data-action="coach-home-picker-open"]`, "data-mode"), "load");
      // The search list opens for the load mode and closes again.
      await page.click(`${card} [data-action="coach-home-picker-open"]`);
      await page.waitForSelector("dialog[open]", { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await page.waitForSelector("dialog[open]", { state: "detached", timeout: 10_000 }).catch(() => {});
      const loadAthlete = page.locator(`${card} [data-action="coach-home-open-athlete"]`).first();
      assert.equal(await loadAthlete.getAttribute("data-mode"), "load");
      const loadName = (await loadAthlete.getAttribute("aria-label")).replace(/, Training load$/, "");
      await loadAthlete.scrollIntoViewIfNeeded();
      // Wait for the athlete's own week to load before Back: a Back pressed while Training Load is still loading
      // can leave Training Load drawn under the Home title. That race predates this change (reproduced on main
      // with the old Training load card) and is reported as its own fix.
      const athleteWeek = page.waitForResponse((r) => r.url().includes("/api/training-load/calendar") && r.url().includes("athleteIds="), { timeout: 20_000 });
      await loadAthlete.click();
      await page.waitForSelector('[data-action="training-load-section"]', { timeout: 20_000 });
      await athleteWeek;
      await page.waitForTimeout(300);
      assert.equal((await page.textContent("#screenTitle")).trim(), loadName);

      // Back on Home the switch still says Training load (kept in memory, no new request).
      await backHome(page);
      assert.deepEqual(await pressed(page), ["plan:false", "load:true"], "Home remembers the tab");
      assert.ok(await overflow(page) <= 0, "no horizontal overflow after the round trips");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("(390 px) an empty day offers Plan a session, which opens the Calendar", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.phone);
  try {
    await page.waitForSelector(".coach-home-day", { timeout: 20_000 });
    // Choose a day with no session: the first calendar day without a training marker.
    const found = await page.evaluate(() => {
      const empty = [...document.querySelectorAll('.coach-home-cal-day:not(.has-training):not(.is-outside)')];
      const day = empty.find((button) => button.getBoundingClientRect().width > 0) || empty[0];
      day?.click();
      return Boolean(day);
    });
    assert.ok(found, "the calendar shows a day with no session");
    const plan = page.locator('[data-action="coach-home-plan-session"]');
    await plan.waitFor({ timeout: 10_000 });
    const box = await plan.boundingBox();
    assert.ok(box.height >= 44, `Plan a session is at least 44 px tall (${box.height})`);
    await plan.click();
    await page.waitForSelector(".central-calendar", { timeout: 20_000 });
    assert.equal(await page.locator(".coach-home-day").count(), 0, "Home left for the Calendar");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
