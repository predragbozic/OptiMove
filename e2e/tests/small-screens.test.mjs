// L1 + C1 in a real browser: the sign-in cards (sign in, forgot password, an invalid reset link) show the app's logo,
// an accent main action and only 44 px controls at 390 and 1280 px; forgot password still answers an existing and an
// unknown email with the same sentence; the coach directory names the marketplace only when its list holds it (this world holds none) and its button is 44 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function signedOut(width, path, onResponse) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (onResponse) page.on("response", onResponse);
  await page.goto(world.baseUrl + path);
  await page.locator(".login-form").first().waitFor();
  return { context, page, pageErrors };
}

const card = () => {
  const form = document.querySelector(".login-form");
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const small = [...form.querySelectorAll("button, a[href], input")].filter(vis).filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => e.textContent.trim() || e.name);
  const logo = getComputedStyle(form, "::before");
  const main = form.querySelector(":scope > .plain-button, :scope > form > .plain-button:not(.compact-button)");
  return {
    small,
    logo: logo.backgroundImage.includes("brand-logo") && parseFloat(logo.height) === 48,
    main: main ? { text: main.textContent.trim(), bg: getComputedStyle(main).backgroundColor, color: getComputedStyle(main).color } : null,
    fonts: [...form.querySelectorAll("input")].filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).length,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

for (const width of [390, 1280]) {
  for (const [path, mainText] of [
    ["/", "Sign in"],
    ["/forgot-password", "Send reset link"],
    ["/reset-password?token=not-a-token", null],
    ["/verify-email?token=not-a-token", "Send new confirmation email"],
    ["/join?token=not-a-token", null],
    ["/invite?token=not-a-token", null],
  ]) {
    test(`(${width} px) ${path}: logo, accent main action and 44 px controls`, async () => {
      const logo = [];
      const { context, page, pageErrors } = await signedOut(width, path, (r) => { if (r.url().includes("brand-logo")) logo.push(r.status()); });
      try {
        await page.waitForTimeout(500);
        assert.ok(logo.length > 0 && logo.every((s) => s === 200 || s === 304), `the logo loads (${logo})`);
        const c = await page.evaluate(card);
        assert.deepEqual(c.small, [], "nothing under 44 px");
        assert.ok(c.logo, "the app's logo");
        assert.equal(c.fonts, 0);
        assert.equal(c.overflow, 0);
        if (mainText) {
          assert.equal(c.main?.text, mainText);
          assert.equal(c.main.bg, "rgb(31, 111, 104)");
          assert.equal(c.main.color, "rgb(255, 255, 255)");
        }
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    });
  }
}

test("forgot password answers an existing and an unknown email with the same sentence", async () => {
  const known = world.accounts.find((a) => a.role === "team_coach").email;
  const answers = [];
  for (const email of [known, "nobody@example.invalid"]) {
    const { context, page } = await signedOut(390, "/forgot-password");
    try {
      await page.fill('#forgotPasswordForm input[name="email"]', email);
      await page.click('#forgotPasswordForm button[type="submit"]');
      await page.locator(".login-success").filter({ hasText: /\S/ }).waitFor();
      answers.push(await page.evaluate(() => [document.querySelector(".login-success").textContent.trim(), document.querySelector(".login-error").textContent.trim()]));
    } finally { await context.close(); }
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(answers[0][0], "If an active account exists for that email, we've sent password reset instructions.");
});

for (const width of [390, 1280]) test(`(team_coach, ${width} px) the coach directory: no marketplace line without a marketplace entry, a 44 px button`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    const toggle = page.locator('[data-action="mobile-nav-toggle"]');
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await page.locator('[data-library-tab="coaches"]').first().click();
    await page.locator(".coach-directory").waitFor();
    const d = await page.evaluate(() => {
      const s = document.querySelector(".coach-directory");
      return { text: s.innerText, button: Math.round(s.querySelector(".coach-directory-head .plain-button").getBoundingClientRect().height) };
    });
    assert.ok(!/marketplace/i.test(d.text));
    assert.match(d.text, /The coaches you can see, with their specialties and programs\./);
    assert.match(d.text, /Your profile shows your specialties and programs to the athletes and coaches who can see it\./);
    assert.ok(d.button >= 44, `${d.button} px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
