// Header panels on a phone: opening Notifications must not make the page wider. It did: the panel first
// hung from the bell's left edge and reached past the screen, mobile Chrome widened the layout viewport
// to fit it, and the closed menu drawer (position: fixed; right: 10px, only transparent) then held the
// page that wide even after the panel was moved back.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

// openAs emulates a phone below 600 px; 600 px (the top of the phone layout) is opened as a phone here.
async function openPhone(width) {
  if (width < 600) return openAs(browser, world, "team_coach", width);
  const account = world.accounts.find((a) => a.role === "team_coach");
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(world.baseUrl);
  await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
  return { context, page, pageErrors };
}

const widths = (page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));

for (const width of [360, 390, 600]) {
  test(`(${width} px, a phone) opening Notifications keeps the page as wide as the screen and the panel inside it`, async () => {
    const { context, page, pageErrors } = await openPhone(width);
    try {
      const before = await widths(page);
      assert.equal(before.scroll, before.client, "no sideways overflow before");
      // Every frame from before the click until 1.5 s after the panel first shows: a widening that lasts
      // one frame is already the trigger, however long the click itself takes.
      await page.evaluate(() => {
        window.__widest = 0;
        window.__sampling = true;
        let shownAt = 0;
        const sample = () => {
          window.__widest = Math.max(window.__widest, document.documentElement.scrollWidth, innerWidth);
          const panel = document.querySelector("#notificationPanel");
          if (!shownAt && panel && !panel.hidden) shownAt = performance.now();
          if (shownAt && performance.now() - shownAt > 1500) { window.__sampling = false; return; }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await page.locator("#notificationToggle").click();
      await page.locator("#notificationPanel:not([hidden])").waitFor();
      await page.waitForFunction(() => window.__sampling === false, null, { timeout: 10_000 });
      const widest = await page.evaluate(() => window.__widest);
      assert.equal(widest, width, `the page never got wider than the screen while the panel opened (it reached ${widest} px)`);
      const opened = await widths(page);
      assert.equal(opened.client, width, `the layout viewport stays ${width} px (it was ${opened.client})`);
      assert.equal(opened.scroll, opened.client, `no sideways overflow with the panel open (${opened.scroll} > ${opened.client})`);
      const panel = await page.locator("#notificationPanel").boundingBox();
      assert.ok(panel.x >= 0 && panel.x + panel.width <= width, `the panel ${Math.round(panel.x)}-${Math.round(panel.x + panel.width)} is inside ${width} px`);
      const markAll = await page.getByRole("button", { name: "Mark all read" }).boundingBox();
      assert.ok(markAll.x + markAll.width <= width, "Mark all read is on screen");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}
