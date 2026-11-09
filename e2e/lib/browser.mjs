// Shared browser helpers for the e2e files. Text and state are asserted, never pixels.
import { chromium } from "playwright";

export const WIDTHS = { desktop: 1280, phone: 390 };

export async function launch() {
  return chromium.launch();
}

// A page already signed in as one of the world's demo accounts (its session cookie), at a given width.
export async function openAs(browser, world, role, width = WIDTHS.desktop) {
  const account = world.accounts.find((a) => a.role === role);
  if (!account) throw new Error(`no demo account for role ${role}`);
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(world.baseUrl);
  // The app polls, so the network never goes idle: the signed-in shell is the ready signal.
  await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
  return { context, page, account, pageErrors };
}

// Training Load from the main navigation (a phone opens the menu first).
export async function openTrainingLoad(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.getByText("Training load", { exact: true }).first().click();
  await page.waitForSelector('[data-action="training-load-section"]');
}

export async function api(context, world, path) {
  const res = await context.request.get(`${world.baseUrl}${path}`);
  return res.status();
}
