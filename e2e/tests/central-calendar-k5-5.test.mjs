// K5-5 (docs/ai/central-calendar-k5-plan.md, K5-5; the manager's R1, R2): "Open in calendar" from Coach Home's day,
// Tests' week (the bar and the day's quiet link) and the Training Load calendar, as the team coach at 1280, 390, 375
// and 360 px. Each opens the central calendar on that place's day (the week with the day selected, or the Day view
// for Tests' day link), and Back returns to the module. Every opener is a 44 px target and no page scrolls sideways.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}
async function opener(page, scope) {
  const button = page.locator(`${scope} [data-action="open-in-central-calendar"]`).first();
  await button.waitFor({ timeout: 20_000 });
  const box = await button.boundingBox();
  assert.ok(box.height >= 43.5, `${scope}: a 44 px target (${box.height})`);
  return button;
}
// The central calendar on `date`: the chosen view, the day in it (and, on a phone's week, selected in the strip).
async function calendarOn(page, date, view) {
  await page.waitForFunction(([d, v]) => {
    const root = document.querySelector(".central-calendar");
    if (!root || !root.classList.contains(`cc-view-${v}`)) return false;
    if (v === "day") return Boolean(root.querySelector(".cc-day-list"));
    const day = root.querySelector(`[data-date="${d}"]`);
    const strip = root.querySelector(`.cc-strip-day[data-date="${d}"]`);
    return Boolean(day) && (!strip || strip.getAttribute("aria-pressed") === "true");
  }, [date, view], { timeout: 20_000 });
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) Open in calendar from Coach Home, Tests and Training Load, and Back to each`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    const today = localDay();
    try {
      // --- Coach Home's day: today.
      await page.waitForSelector(".coach-home-day", { timeout: 20_000 });
      const home = await opener(page, ".coach-home-day .coach-home-panel-head");
      assert.equal(await home.getAttribute("data-date"), today);
      assert.equal(await overflow(page, width), 0, "Home: no sideways scroll");
      await shot(page, `k5-5-home-${width}`);
      await home.click();
      await calendarOn(page, today, "week");
      await page.goBack();
      await page.waitForSelector(".coach-home-day", { timeout: 20_000 });

      // --- Tests' week: another day of the week, its bar, then its day link.
      await navTo(page, '[data-library-tab="tests"]');
      await page.locator('[data-action="tests-weekly-prev-week"]').waitFor({ timeout: 20_000 });
      const lastDay = await page.locator('[data-action="tests-weekly-select-day"]').last().getAttribute("data-date");
      await page.locator(`[data-action="tests-weekly-select-day"][data-date="${lastDay}"]`).click();
      await page.waitForSelector(`.tests-weekly-nav [data-action="open-in-central-calendar"][data-date="${lastDay}"]`, { timeout: 10_000 });
      const week = (await page.textContent(".tests-weekly-range strong")).trim();
      const bar = await opener(page, ".tests-weekly-nav");
      assert.equal(await overflow(page, width), 0, "Tests: no sideways scroll");
      await shot(page, `k5-5-tests-${width}`);
      await bar.click();
      await calendarOn(page, lastDay, "week");
      await page.goBack();
      await page.waitForSelector(".tests-weekly-day-link", { timeout: 20_000 });
      assert.equal((await page.textContent(".tests-weekly-range strong")).trim(), week, "Back: Tests on the same week");
      const link = await opener(page, ".tests-weekly-day-link");
      assert.match(await link.textContent(), /^Open \w{3} \d{1,2} \w{3} in calendar$/, "the day link names its day");
      const linkDay = await link.getAttribute("data-date");
      await link.click();
      await calendarOn(page, linkDay, "day");
      await page.goBack();
      await page.waitForSelector(".tests-weekly-day-link", { timeout: 20_000 });

      // --- The Training Load calendar: its selected day.
      await openTrainingLoad(page);
      await page.click('[data-action="training-load-section"][data-section="today"]').catch(() => {});
      const tl = await opener(page, ".tl-calendar-nav");
      const tlDay = await tl.getAttribute("data-date");
      assert.match(tlDay, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(await overflow(page, width), 0, "Training Load: no sideways scroll");
      await shot(page, `k5-5-tl-${width}`);
      await tl.click();
      await calendarOn(page, tlDay, "week");
      await page.goBack();
      await page.waitForSelector(".tl-calendar-nav", { timeout: 20_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
