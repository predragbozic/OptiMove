// The athlete's app on a phone (owner, 2026-11-10):
// - the header controls are 44 px;
// - opening Notifications or Messages never makes the page wider than the screen (sampled every frame);
// - a menu tap made before app.js has bound the button opens the menu once app.js is ready (two taps leave it closed).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openAthlete(width, { holdApp = false, signedIn = true } = {}) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
  if (signedIn) await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  let release = () => {};
  if (holdApp) {
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(/\/app\.js(\?|$)/, async (route) => { await held; await route.continue().catch(() => {}); });
  }
  // A held module script also holds DOMContentLoaded, so an early tap only waits for the page to commit.
  await page.goto(`${world.baseUrl}/athlete`, { waitUntil: holdApp ? "commit" : "load" });
  if (!holdApp && signedIn) await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  return { context, page, pageErrors, release };
}

for (const width of [360, 390, 600, 760]) {
  test(`(${width} px) the athlete's header controls are 44 px and no header panel makes the page wider`, async () => {
    const { context, page, pageErrors } = await openAthlete(width);
    try {
      const controls = await page.evaluate(() => [".athlete-topbar-brand", "#notificationToggle", "#messageToggle", "#signOutButton"]
        .map((selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return [selector, box && Math.round(box.width), box && Math.round(box.height)]; }));
      for (const [selector, w, h] of controls) assert.ok(w >= 44 && h >= 44, `${selector}: ${w}x${h}`);
      // No menu button in the header on a phone: the bottom bar is the main navigation.
      assert.equal(await page.locator("#mobileNavToggle").isVisible(), false, "no header menu button");
      await page.waitForSelector('.om-bottom-nav [data-nav-id="home"]', { timeout: 20_000 });

      for (const [toggle, panelSelector] of [["#notificationToggle", "#notificationPanel"], ["#messageToggle", "#messagePanel"]]) {
        await page.goto(`${world.baseUrl}/athlete`);
        await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
        await page.evaluate(() => {
          window.__widest = 0;
          const start = performance.now();
          const sample = () => {
            window.__widest = Math.max(window.__widest, document.documentElement.scrollWidth, innerWidth);
            if (performance.now() - start < 1500) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        await page.locator(toggle).click();
        await page.waitForTimeout(1600);
        const result = await page.evaluate((selector) => {
          const box = document.querySelector(selector).getBoundingClientRect();
          return { widest: window.__widest, left: Math.round(box.left), right: Math.round(box.right), shown: box.width > 0 };
        }, panelSelector);
        assert.ok(result.shown, `${panelSelector} is open`);
        assert.equal(result.widest, width, `${toggle}: the page reached ${result.widest} px`);
        assert.ok(result.left >= 0 && result.right <= width, `${panelSelector}: ${result.left}-${result.right} inside ${width}`);
      }
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(390 px) the sticky row under the athlete's bar (Account) starts where the 44 px bar ends", async () => {
  const { context, page, pageErrors } = await openAthlete(390);
  try {
    await navTo(page, '.sidebar [data-athlete-tab="athlete-settings"]');
    await page.waitForSelector(".athlete-settings-identity", { timeout: 20_000 });
    const result = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      const bar = document.querySelector(".athlete-topbar").getBoundingClientRect();
      const row = document.querySelector(".athlete-settings-identity").getBoundingClientRect();
      return { barBottom: Math.round(bar.bottom), rowTop: Math.round(row.top) };
    });
    assert.equal(result.rowTop, result.barBottom, JSON.stringify(result));
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

// The header's menu button is gone on a phone (owner, 2026-11-24): hidden from the page's first paint, so there is no
// button to tap before app.js is ready (the early-tap replay of index.html / athlete.html stays for the fallback when
// the bar cannot load). The bar arrives with the signed-in app and never on the sign-in screen.
test("(390 px) no header menu button from the first paint; the bottom bar comes with the signed-in app", async () => {
  const { context, page, pageErrors, release } = await openAthlete(390, { holdApp: true });
  try {
    await page.locator(".athlete-topbar").waitFor({ timeout: 20_000 });
    assert.equal(await page.evaluate(() => Boolean(window.__omMenuBound)), false, "app.js is not bound yet");
    assert.equal(await page.locator("#mobileNavToggle").isVisible(), false, "no menu button before app.js");
    release();
    await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
    await page.waitForSelector('.om-bottom-nav [data-nav-id="home"]', { timeout: 20_000 });
    assert.equal(await page.locator("#mobileNavToggle").isVisible(), false, "nor after it");
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});

test("(390 px) the sign-in screen has neither the header menu button nor the bottom bar", async () => {
  const { context, page, pageErrors, release } = await openAthlete(390, { holdApp: true, signedIn: false });
  try {
    release();
    await page.waitForSelector("#loginForm", { timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator("#mobileNavToggle").isVisible(), false);
    assert.equal(await page.locator(".om-bottom-nav").count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});
