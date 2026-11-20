// K5-4 (docs/ai/central-calendar-k5-4-contract.md, section 5): the calendar's GPS marks and Imports opened on a day, in a
// real browser at 1280, 390, 375 and 360 px. The fake source serves two sessions on 05.11.2026 (one Ready, one that
// needs athlete 121 linked) and one on 04.11.2026, which the setup imports. The team coach's calendar shows
// "2 GPS sessions to review" on 05.11 only; its click opens Imports with 05.11 chosen and both sessions listed; Back to
// calendar returns to that week. The club admin's club workspace and the athlete's Calendar show no mark and read
// nothing. Invented data on a disposable database; nothing is imported by the browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";
import { K54_SESSIONS } from "../lib/imports-fixture.mjs";

const G = "/api/training-load/gpexe";
const DAY = "2026-11-05";
const IMPORTED_DAY = "2026-11-04";
const MARK = `.cc-daymark[data-date="${DAY}"]`;
const GPS_READ = /\/api\/training-load\/gpexe\/teams\/[^/]+\/calendar\?/;

let world;
let browser;
before(async () => {
  world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "calendarmarks" } });
  browser = await launch();
  const setup = await prepareImports(world);
  // The 04.11 session is imported, so that day has nothing waiting.
  const candidate = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === String(K54_SESSIONS.imported));
  assert.ok(candidate, "the 04.11 session was found");
  const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${candidate.id}`)).body.candidate;
  const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${candidate.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
  assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 300));
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openCalendar(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator("#calendarToggle").click();
  await page.waitForSelector(".central-calendar .cc-nav-arrow", { timeout: 20_000 });
}

// Back to the week of DAY (the calendar opens on today's week); on a phone, DAY chosen in the strip.
async function showDay(page, width) {
  for (let i = 0; i < 12; i += 1) {
    if (await page.locator(`[data-date="${DAY}"]`).count()) break;
    await page.click('[data-action="central-calendar-prev"]');
    await page.waitForTimeout(150);
  }
  if (width < 600) {
    await page.click(`.cc-strip-day[data-date="${DAY}"]`);
    await page.waitForTimeout(100);
  }
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) the mark on 05.11 opens Imports with that day chosen, and Back to calendar returns to it`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      const writes = [];
      page.on("request", (r) => { if (r.method() !== "GET" && /\/api\/training-load\/gpexe\//.test(r.url())) writes.push(r.url()); });
      await openCalendar(page);
      await showDay(page, width);
      await page.waitForSelector(MARK, { timeout: 20_000 });
      const look = await page.evaluate(([day, importedDay]) => {
        const marks = [...document.querySelectorAll(".cc-daymark")];
        const mark = document.querySelector(`.cc-daymark[data-date="${day}"]`);
        const box = mark.getBoundingClientRect();
        return {
          dates: marks.map((m) => m.dataset.date),
          text: mark.textContent.replace(/\s+/g, " ").trim(),
          label: mark.getAttribute("aria-label"),
          height: box.height,
          inside: box.left >= 0 && box.right <= window.innerWidth,
          importedMark: Boolean(document.querySelector(`.cc-daymark[data-date="${importedDay}"]`)),
        };
      }, [DAY, IMPORTED_DAY]);
      assert.deepEqual(look.dates, [DAY], "one mark, on 05.11 only");
      assert.equal(look.text, "2 GPS sessions to review");
      assert.match(look.label, /^2 GPS sessions to review on .*5 November.*, open Imports$/);
      assert.equal(look.importedMark, false, "the imported day has no mark");
      assert.ok(look.inside, "the mark fits the screen");
      if (width < 600) assert.ok(look.height >= 44, `a 44 px target on a phone (${look.height})`);
      assert.equal(await overflow(page), 0, "no horizontal page scroll on the calendar");

      await page.click(MARK);
      await page.waitForSelector(".imports-period .period-range-text", { state: "attached", timeout: 30_000 });
      await page.waitForSelector(".imports-period .period-daylist-open", { state: "attached", timeout: 30_000 });
      const imports = await page.evaluate(() => {
        const period = document.querySelector(".imports-period");
        return {
          range: period.querySelector(".period-range-text")?.textContent.trim(),
          listed: period.querySelectorAll(".period-daylist-open").length,
          modal: period.getAttribute("aria-modal"),
          open: period.classList.contains("is-open"),
          band: Boolean(document.querySelector('[data-action="imports-back-to-calendar"]')),
        };
      });
      assert.match(imports.range, /^05\.11\. · 1 day$/, `05.11 chosen (${imports.range})`);
      assert.equal(imports.listed, 2, "both waiting sessions are listed");
      assert.ok(imports.band, "Back to calendar is there");
      if (width < 600) {
        assert.equal(imports.open, true, "a phone: the sheet is open");
        assert.equal(imports.modal, "true");
        assert.equal(await overflow(page), 0);
        // The sheet covers the screen: close it (Back would do the same), then Back to calendar.
        await page.click(".imports-period .period-close");
      } else {
        assert.equal(imports.open, false, "a computer: the chooser is on the page, not a sheet");
        assert.equal(imports.modal, null, "no dialog on a computer");
        assert.equal(await overflow(page), 0);
      }
      await page.click('[data-action="imports-back-to-calendar"]');
      await page.waitForSelector(MARK, { timeout: 20_000 });
      assert.equal(await page.locator('[data-action="imports-back-to-calendar"]').count(), 0, "the band is gone on the calendar");
      assert.deepEqual(writes, [], "nothing written, no search started");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("the club admin's club workspace shows no mark and never reads Imports' calendar", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    const reads = [];
    page.on("request", (r) => { if (GPS_READ.test(r.url())) reads.push(r.url()); });
    await openCalendar(page);
    await showDay(page, WIDTHS.desktop);
    await page.waitForSelector(`.cc-day-column [data-date="${DAY}"], .cc-timegrid-head [data-date="${DAY}"]`, { state: "attached", timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".cc-daymark").count(), 0);
    assert.deepEqual(reads, []);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("the athlete's Calendar shows no mark and never reads Imports' calendar", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "athlete", WIDTHS.phone);
  try {
    const reads = [];
    page.on("request", (r) => { if (GPS_READ.test(r.url())) reads.push(r.url()); });
    const toggle = page.locator('[data-action="mobile-nav-toggle"]');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await page.locator('.sidebar [data-athlete-tab="athlete-calendar"]').first().click();
    await page.waitForSelector(".athlete-calendar", { timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".cc-daymark").count(), 0);
    assert.deepEqual(reads, []);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
