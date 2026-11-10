// The athlete's app on a phone (owner, 2026-11-10):
// - the header controls are 44 px;
// - opening Notifications or Messages never makes the page wider than the screen (sampled every frame);
// - a menu tap made before app.js has bound the button opens the menu once app.js is ready (two taps leave it closed).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch } from "../lib/browser.mjs";

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
      const controls = await page.evaluate(() => [".athlete-topbar-brand", "#mobileNavToggle", "#notificationToggle", "#messageToggle", "#signOutButton"]
        .map((selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return [selector, box && Math.round(box.width), box && Math.round(box.height)]; }));
      for (const [selector, w, h] of controls) assert.ok(w >= 44 && h >= 44, `${selector}: ${w}x${h}`);

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
    await page.getByText("Account", { exact: true }).filter({ visible: true }).first().click();
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

test("(390 px) a menu tap made before app.js is ready opens the menu once it is; two taps leave it closed", async () => {
  for (const [taps, expected] of [[1, "true"], [2, "false"]]) {
    const { context, page, pageErrors, release } = await openAthlete(390, { holdApp: true });
    try {
      // The page's own HTML has drawn the button; app.js has not loaded, so nothing is bound yet.
      await page.locator("#mobileNavToggle").waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await page.evaluate(() => Boolean(window.__omMenuBound)), false, "app.js is not bound yet");
      for (let i = 0; i < taps; i += 1) await page.locator("#mobileNavToggle").click();
      assert.equal(await page.getAttribute("#mobileNavToggle", "aria-expanded"), "false", "nothing happens before app.js");
      release();
      await page.waitForFunction(() => window.__omMenuBound === true, null, { timeout: 20_000 });
      await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
      assert.equal(await page.getAttribute("#mobileNavToggle", "aria-expanded"), expected, `${taps} early tap(s)`);
      assert.equal(await page.evaluate(() => document.body.classList.contains("mobile-nav-open")), expected === "true");
      assert.deepEqual(pageErrors, []);
    } finally {
      release();
      await context.close();
    }
  }
});

test("(390 px) an early menu tap on a page that becomes the sign-in screen is not carried past it", async () => {
  const { context, page, pageErrors, release } = await openAthlete(390, { holdApp: true, signedIn: false });
  try {
    await page.locator("#mobileNavToggle").waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("#mobileNavToggle").click();
    release();
    await page.waitForSelector("#loginForm", { timeout: 20_000 });
    assert.equal(await page.evaluate(() => document.body.classList.contains("mobile-nav-open")), false, "no menu state behind the sign-in screen");
    assert.equal(await page.getAttribute("#mobileNavToggle", "aria-expanded"), "false");
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});
