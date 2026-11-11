// T1 in a real browser: on a coach's Tests, the week pager's arrows sit next to the week and Today, every pager and
// Schedule toolbar control is 44 px, "Show cancelled" is a 44 px switch that still works, and the eyebrow names the
// area instead of repeating "Tests".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openTests(page, section) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="tests"]').first().click();
  await page.locator('main [data-action="tests-section"][data-section="today"]').first().waitFor();
  if (section !== "today") await page.locator(`main [data-action="tests-section"][data-section="${section}"]`).first().click();
  await page.locator('[data-action="tests-weekly-prev-week"]').waitFor();
}

const pager = () => {
  const box = (s) => document.querySelector(s).getBoundingClientRect();
  // Measured to what the range shows (the week and Today), not to its box, which may stretch.
  const prev = box('[data-action="tests-weekly-prev-week"]'), next = box('[data-action="tests-weekly-next-week"]');
  const range = { left: box(".tests-weekly-range strong").left, right: box(".tests-weekly-today-button").right };
  const small = [...document.querySelectorAll(".tests-weekly-nav button, .tests-schedule-toolbar button, .tests-shell .om-btn, .tests-show-cancelled-toggle")]
    .filter((e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height < 43.5).map((e) => e.textContent.trim() || e.getAttribute("aria-label"));
  return { gapPrev: range.left - prev.right, gapNext: next.left - range.right, small, context: document.querySelector("#contextLabel")?.textContent.trim(), overflow: document.documentElement.scrollWidth - window.innerWidth };
};

for (const width of [390, 360, 1280]) for (const section of ["today", "schedule", "results"]) {
  test(`(team_coach, ${width} px, ${section}) the pager sits together and is 44 px`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openTests(page, section);
      const p = await page.evaluate(pager);
      assert.ok(p.gapPrev >= 0 && p.gapPrev <= 16 && p.gapNext >= 0 && p.gapNext <= 16, `arrows next to the week (${p.gapPrev}, ${p.gapNext})`);
      assert.deepEqual(p.small, []);
      assert.equal(p.context, "Testing and wellness");
      assert.equal(p.overflow, 0);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

for (const width of [390, 1280]) test(`(team_coach, ${width} px) Show cancelled is a 44 px switch that still works`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openTests(page, "schedule");
    const sw = page.locator('[data-action="tests-toggle-show-cancelled"]');
    const look = await sw.evaluate((i) => ({ role: i.getAttribute("role"), appearance: getComputedStyle(i).appearance, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height, row: i.closest("label").getBoundingClientRect().height }));
    assert.equal(look.role, "switch");
    assert.equal(look.appearance, "none", "drawn as a switch, not the native box");
    assert.ok(look.w === 40 && look.h === 24 && look.row >= 44, JSON.stringify(look));
    assert.equal(await sw.isChecked(), false);
    const reload = page.waitForResponse((r) => r.url().includes("/api/tests/") && r.url().includes("includeCancelled=true"));
    await page.locator(".tests-show-cancelled-toggle").click();
    await reload;
    // After the reload the toolbar is drawn again from state: the new switch must still be on.
    await page.waitForFunction(() => document.querySelector('[data-action="tests-toggle-show-cancelled"]')?.checked === true);
    assert.equal(await page.locator('[data-action="tests-open-schedule-form"]').textContent(), "New wellness schedule");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
