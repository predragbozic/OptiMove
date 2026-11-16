// Imports P4: the period chooser in a real browser at 1280 and 390 px. "Find new sessions" opens a calendar with one
// chip per session; two taps choose the days and "Search" sends exactly those days; with a mouse a drag does the same.
// 44 px day buttons and no horizontal page scroll. Invented data on a disposable database; nothing is imported.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, showPeriodMonth, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const DAY = (d) => `.imports-period [data-action="training-load-gpexe-period-day"][data-day="${d}"]`;

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`P4 (${label}): the chooser marks the sessions found, two taps choose the days, Search sends exactly them`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      await prepareImports(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        const checks = [];
        page.on("request", (r) => { if (r.method() === "POST" && /\/checks$/.test(r.url())) checks.push(r.postDataJSON()); });
        await openTrainingLoad(page);
        await page.click('[data-action="training-load-section"][data-section="imports"]');
        await page.waitForSelector('[data-action="training-load-gpexe-period-toggle"]:not([disabled])', { state: "attached", timeout: 20_000 });
        // On a computer the chooser is on the page; on a phone "Find new sessions" opens it as a full-screen sheet.
        if (width < 500) {
          assert.equal(await page.locator(".imports-period").isVisible(), false, "a phone: closed until asked for");
          await page.click('[data-action="training-load-gpexe-period-toggle"]');
        } else {
          assert.equal(await page.locator(".imports-find-phone").isVisible(), false, "a computer: no Find new sessions button");
        }
        await page.waitForSelector(".imports-period", { state: "visible", timeout: 10_000 });
        if (width < 500) {
          const sheet = await page.evaluate(() => { const r = document.querySelector(".imports-period").getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight }; });
          assert.deepEqual([sheet.top, sheet.left, sheet.width, sheet.height], [0, 0, sheet.vw, sheet.vh], `a full-screen sheet ${JSON.stringify(sheet)}`);
        }
        // The chooser opens on today's month; the fixture's sessions are on 04.11.2026 and 05.11.2026, so page to them.
        await showPeriodMonth(page, "November 2026");
        await page.waitForSelector(DAY("2026-11-05"), { timeout: 10_000 });
        const look = await page.evaluate(() => {
          const days = [...document.querySelectorAll('.imports-period [data-action="training-load-gpexe-period-day"]')];
          const cell = (d) => document.querySelector(`.imports-period [data-day="${d}"]`);
          const chips = (d) => [...cell(d).querySelectorAll(".period-chip")].map((c) => c.textContent);
          const small = [...document.querySelectorAll(".imports-period button")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44)
            .map((b) => `${(b.textContent || b.dataset.day || "").trim().slice(0, 12)}:${Math.round(b.getBoundingClientRect().height)}`);
          return {
            minDay: Math.min(...days.map((d) => d.getBoundingClientRect().height)),
            minDayWidth: Math.min(...days.map((d) => d.getBoundingClientRect().width)),
            small,
            chips4: chips("2026-11-04"),
            chips5: chips("2026-11-05"),
            label5: cell("2026-11-05").getAttribute("aria-label"),
            missing: document.querySelector(".imports-period .period-missing").textContent.trim(),
            missingFrom: document.querySelector(".imports-period .period-missing").dataset.from,
            missingTo: document.querySelector(".imports-period .period-missing").dataset.to,
            today: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })(),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        assert.ok(look.minDay >= 44, `day buttons ${look.minDay} px tall`);
        assert.deepEqual(look.small, [], "every button of the chooser is at least 44 px tall");
        assert.ok(look.minDayWidth >= 40, `day buttons ${look.minDayWidth} px wide`);
        assert.deepEqual(look.chips4, ["→"], "the ready session: one blue arrow");
        assert.deepEqual(look.chips5, ["!"], "the session that needs a link: one amber !");
        assert.match(look.label5, /5 November, 1 session: needs you/);
        // The first button offers the days since the last search (it ended on 08.11.2026) up to today, at most 31 days.
        const from = new Date(`${look.today}T00:00:00Z`);
        from.setUTCDate(from.getUTCDate() - 30);
        const earliest = from.toISOString().slice(0, 10);
        const expectedFrom = earliest > "2026-11-08" ? earliest : "2026-11-08";
        assert.deepEqual([look.missingFrom, look.missingTo], [expectedFrom, look.today], "the missing days run from the last search to today");
        // One name for the action; the days are said beside it.
        assert.equal(look.missing, "Find new sessions");
        const days = (await page.textContent(".imports-period #period-missing-days")).trim();
        assert.match(days, /^Since the last search: \d{2}\.\d{2}\.(\d{4})? – today\.$/);
        if (expectedFrom === "2026-11-08") assert.equal(days, "Since the last search: 08.11. – today.");
        assert.equal(look.overflow, 0, "no horizontal page scroll");
        // Two taps, the later day first: the period runs from the earlier one.
        await page.click(DAY("2026-11-05"));
        assert.match((await page.textContent(".imports-period .period-wait")).trim(), /^Find new sessions for 05\.11\., or tap another day to make the period longer \(at most 31 days\)\.$/);
        await page.click(DAY("2026-11-03"));
        assert.equal((await page.textContent(".imports-period .period-range-text")).trim(), "03.11. – 05.11. · 3 days");
        assert.equal(checks.length, 0, "picking sends nothing");
        await page.click('.imports-period .period-range [data-action="training-load-gpexe-check"]');
        await page.waitForSelector('[data-action="training-load-gpexe-period-toggle"]:not([disabled])', { state: "attached", timeout: 60_000 });
        assert.deepEqual(checks, [{ from: "2026-11-03", to: "2026-11-05" }], "exactly the chosen days");
        assert.equal(await page.locator(".imports-period").isVisible(), width >= 500, "a phone's sheet closed when the search started; a computer keeps the chooser");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    } finally { await world.stop(); }
  });
}

test("P4 (1280 px): a mouse drag across days chooses the period; the click that ends it is not a tap", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    await prepareImports(world);
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.desktop);
    try {
      await openTrainingLoad(page);
      await page.click('[data-action="training-load-section"][data-section="imports"]');
      await page.waitForSelector(".imports-period .period-month", { state: "visible", timeout: 20_000 });
      await showPeriodMonth(page, "November 2026");
      await page.waitForSelector(DAY("2026-11-06"), { state: "visible", timeout: 20_000 });
      // The screen repaints while the status is read: wait for the day, and read its box again if it was just replaced.
      const box = async (d) => {
        for (let i = 0; i < 20; i += 1) {
          await page.locator(DAY(d)).waitFor({ state: "visible" });
          const b = await page.locator(DAY(d)).boundingBox();
          if (b) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
          await page.waitForTimeout(100);
        }
        throw new Error(`no box for ${d}`);
      };
      const a = await box("2026-11-02");
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      const mid = await box("2026-11-04");
      await page.mouse.move(mid.x, mid.y, { steps: 4 });
      const b = await box("2026-11-06");
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.mouse.up();
      assert.equal((await page.textContent(".imports-period .period-range-text")).trim(), "02.11. – 06.11. · 5 days");
      assert.equal(await page.locator(".imports-period .period-wait").count(), 0, "the period is closed, not waiting for a second tap");
      assert.equal(await page.locator(".imports-period .period-fine").isVisible(), true, "a mouse is told it can drag");
      // The next tap starts a new period.
      await page.click(DAY("2026-11-04"));
      assert.equal((await page.textContent(".imports-period .period-range-text")).trim(), "04.11. · 1 day");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  } finally { await world.stop(); }
});

test("P4 (390 px): the sheet is a dialog; Escape closes it; a session tapped in its list opens its review on top", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    await prepareImports(world);
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.phone);
    try {
      await openTrainingLoad(page);
      await page.click('[data-action="training-load-section"][data-section="imports"]');
      await page.waitForSelector('[data-action="training-load-gpexe-period-toggle"]:not([disabled])', { timeout: 20_000 });
      await page.click('[data-action="training-load-gpexe-period-toggle"]');
      await page.waitForSelector('.imports-period[role="dialog"]', { state: "visible" });
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("period-close")), true, "the focus moved into the sheet");
      await page.keyboard.press("Escape");
      await page.waitForSelector(".imports-period", { state: "hidden" });
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("imports-find-phone")), true, "the focus went back to Find new sessions");
      await page.click('[data-action="training-load-gpexe-period-toggle"]');
      // A short phone: the sheet scrolls, and a tap on a day keeps it where it was (the Search button stays in view).
      await page.setViewportSize({ width: 390, height: 560 });
      await showPeriodMonth(page, "November 2026");
      await page.click(DAY("2026-11-02"));
      await page.click(DAY("2026-11-05"));
      const kept = await page.evaluate(() => {
        const sheet = document.querySelector(".imports-period");
        sheet.scrollTop = 90;
        const before = sheet.scrollTop;
        document.querySelector('.imports-period [data-day="2026-11-04"]').click();
        return { before, after: document.querySelector(".imports-period").scrollTop };
      });
      assert.ok(kept.before > 0, `the sheet scrolls (${kept.before})`);
      assert.equal(kept.after, kept.before, "a tap keeps the sheet's scroll");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click(DAY("2026-11-05"));
      await page.locator('.imports-period [data-action="training-load-gpexe-open"]').first().click();
      await page.waitForSelector(".gpexe-detail", { state: "visible", timeout: 20_000 });
      const onTop = await page.evaluate(() => {
        const r = document.querySelector(".gpexe-detail").getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(40, r.height / 2));
        return Boolean(el && el.closest(".gpexe-detail"));
      });
      assert.equal(onTop, true, "the review is on top, not under the sheet");
      assert.equal(await page.locator(".imports-period").isVisible(), false, "the sheet closed");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  } finally { await world.stop(); }
});
