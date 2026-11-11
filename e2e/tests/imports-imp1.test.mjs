// IMP1: the Imports screen as the "GPS Import Flow" sketch, in a real browser at 1280 and 390 px. A banner with one main
// button, one row of tabs (44 px; on a phone it scrolls sideways inside itself and keeps the active tab in view), one
// tab's light list at a time, and a tab that stays where it is while a search repaints the screen. Invented data on a
// disposable database; nothing is imported.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openImportsTab, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`IMP1 (${label}): banner, tabs and one light list; the tab stays during a search`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      const setup = await prepareImports(world);
      const coachAccount = world.accounts.find((a) => a.role === "team_coach");
      const grant = await setup.call("platform_admin", "POST", `/api/training-load/gpexe/teams/${setup.teamId}/approvers`, { userId: coachAccount.id, reason: "e2e: the team's coach approves its own imports" });
      assert.equal(grant.status, 201);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        await openTrainingLoad(page);
        await page.click('[data-action="training-load-section"][data-section="imports"]');
        await page.waitForSelector('.imports-tab-panel[data-imports-tab="attention"]', { timeout: 20_000 });
        const look = await page.evaluate(() => {
          const banner = document.querySelector(".imports-banner");
          const row = document.querySelector(".imports-tabs");
          const tabs = [...row.querySelectorAll(".om-tab")];
          return {
            bannerButtons: [...banner.querySelectorAll(".imports-statusbar button")].map((b) => b.textContent.trim()),
            bannerText: banner.querySelector(".imports-lastsearch").textContent.trim(),
            tabHeights: tabs.map((t) => Math.round(t.getBoundingClientRect().height)),
            tabs: tabs.map((t) => t.textContent.trim()),
            rowScrolls: row.scrollWidth > row.clientWidth,
            panels: document.querySelectorAll(".imports-tab-panel").length,
            column: Math.round(document.querySelector(".imports-tab-panel").getBoundingClientRect().width),
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        assert.deepEqual(look.bannerButtons, ["Find new sessions"], "one main button in the banner");
        assert.match(look.bannerText, /^Last search \d{2}\.\d{2}\. \d{2}:\d{2} · 1 ready · 1 needs you$/);
        assert.deepEqual(look.tabs, ["Needs you (1)", "Ready (1)", "Imported (0)", "Stays out (0)", "Athletes (1 not linked)", "Search"]);
        assert.ok(look.tabHeights.every((h) => h >= 44), `tabs ${look.tabHeights}`);
        assert.equal(look.panels, 1, "one tab's content at a time");
        assert.ok(look.column <= 860, `${look.column} px column`);
        assert.equal(look.overflow, 0, "no horizontal page scroll");
        if (width < 500) assert.ok(look.rowScrolls, "on a phone the tab row scrolls inside itself");
        // Ready: the light list, a Ready pill, the Import button under it.
        await openImportsTab(page, "ready");
        const ready = await page.evaluate(() => {
          const panel = document.querySelector('.imports-tab-panel[data-imports-tab="ready"]');
          const row = panel.querySelector(".gpexe-candidate");
          const active = document.querySelector(".imports-tabs .om-tab.is-active");
          const tabRow = document.querySelector(".imports-tabs").getBoundingClientRect();
          const a = active.getBoundingClientRect();
          return {
            pill: panel.querySelector(".imports-row-pill")?.textContent.trim(),
            pillRightGap: Math.round(row.getBoundingClientRect().right - panel.querySelector(".imports-row-pill").getBoundingClientRect().right),
            rowHeight: Math.round(row.getBoundingClientRect().height),
            rowBorder: getComputedStyle(row).borderTopWidth,
            importLabel: panel.querySelector('[data-action="training-load-gpexe-import-ready"]')?.textContent.trim(),
            importBg: getComputedStyle(panel.querySelector('[data-action="training-load-gpexe-import-ready"]')).backgroundColor,
            activeInView: a.left >= tabRow.left - 1 && a.right <= tabRow.right + 1,
          };
        });
        assert.equal(ready.pill, "Ready");
        assert.ok(ready.pillRightGap <= 2, `the Ready pill sits on the right (${ready.pillRightGap} px from the edge)`);
        assert.ok(ready.rowHeight >= 44, `${ready.rowHeight} px row`);
        assert.equal(ready.rowBorder, "0px", "no frame around a row");
        assert.equal(ready.importLabel, "Import 1 ready session");
        assert.notEqual(ready.importBg, "rgba(0, 0, 0, 0)", "the Import button is filled");
        assert.ok(ready.activeInView, "the active tab is in view");
        // A search repaints the screen every 2 s: the tab stays, and on a phone the tab row keeps where it was scrolled
        // (Ready is still in view, so nothing needs to move it).
        const scrolled = await page.evaluate(() => { const row = document.querySelector(".imports-tabs"); row.scrollLeft = 24; return row.scrollLeft; });
        await page.click('[data-action="training-load-gpexe-check"]');
        await page.waitForSelector('[data-action="training-load-gpexe-check"][disabled]', { timeout: 20_000 }).catch(() => {});
        await page.waitForSelector('[data-action="training-load-gpexe-check"]:not([disabled])', { timeout: 60_000 });
        assert.equal(await page.locator('.imports-tab-panel[data-imports-tab="ready"]').count(), 1, "still on Ready after the search");
        if (width < 500) assert.equal(await page.evaluate(() => document.querySelector(".imports-tabs").scrollLeft), scrolled, "the tab row kept its place");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    } finally { await world.stop(); }
  });
}
