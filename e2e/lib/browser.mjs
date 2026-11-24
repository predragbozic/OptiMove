// Shared browser helpers for the e2e files. Text and state are asserted, never pixels.
import { chromium } from "playwright";

export const WIDTHS = { desktop: 1280, phone: 390 };

// E2E_CHROMIUM_EXECUTABLE points at a Chromium build other than the one this Playwright version expects.
export async function launch() {
  const executablePath = process.env.E2E_CHROMIUM_EXECUTABLE || undefined;
  return chromium.launch(executablePath ? { executablePath } : {});
}

// A page already signed in as one of the world's demo accounts (its session cookie), at a given width.
// `hasTouch` makes a wide screen a touch screen ((pointer: coarse)), e.g. a tablet in landscape.
export async function openAs(browser, world, role, width = WIDTHS.desktop, { hasTouch } = {}) {
  const account = world.accounts.find((a) => a.role === role);
  if (!account) throw new Error(`no demo account for role ${role}`);
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: hasTouch ?? phone });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(world.baseUrl);
  // The app polls, so the network never goes idle: the signed-in shell is the ready signal.
  await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
  return { context, page, account, pageErrors };
}

// IMP1: the Imports screen shows one tab at a time (attention, ready, imported, out, athletes, search). Opens one by its
// key and waits until its panel is drawn.
export async function openImportsTab(page, tab) {
  await page.click(`[data-action="training-load-gpexe-tab"][data-import-tab="${tab}"]`);
  await page.waitForSelector(`.imports-tab-panel[data-imports-tab="${tab}"]`);
}

// The main navigation at any width. `selector` names the menu's own control (e.g. '[data-library-tab="builder"]',
// '#calendarToggle', '.sidebar [data-athlete-tab="tests"]', a Program Library or Settings sub-section). A computer
// clicks it in the menu; a phone (<= 760 px, no header menu button there since the bottom bar) taps the same section on
// the bottom bar, or in its More sheet - a sub-section under its section's group there.
export async function navTo(page, selector) {
  const target = page.locator(selector).first();
  const phone = await page.evaluate(() => window.matchMedia("(max-width: 760px)").matches);
  if (!phone) {
    const toggle = page.locator('[data-action="mobile-nav-toggle"]');
    if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await target.click();
    return;
  }
  await page.waitForSelector('.om-bottom-nav [data-nav-id]', { timeout: 20_000 });
  // The athlete list (the drawer the bar's Athletes opens) covers the bar while it is open: it is closed first.
  if (await page.evaluate(() => document.body.classList.contains("mobile-nav-open"))) {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.body.classList.contains("mobile-nav-open"), null, { timeout: 10_000 });
  }
  const info = await target.evaluate((el) => {
    const action = el.dataset.action || "";
    const id = el.id === "athletesToggle" ? "athletes" : el.id === "calendarToggle" ? "central-calendar"
      : action === "brand-home" || action === "home" ? "home" : (el.dataset.libraryTab || el.dataset.athleteTab || "");
    const sub = el.classList.contains("sidebar-subnav-button");
    const parent = sub ? el.closest(".sidebar-submenu")?.querySelector(".sidebar-nav-button")?.getAttribute("title") : null;
    return { id, sub, parent, label: sub ? el.textContent.trim() : (el.getAttribute("title") || el.textContent.trim()) };
  });
  if (!info.sub && await page.locator(`.om-bottom-nav [data-nav-id="${info.id}"]`).count()) {
    await page.click(`.om-bottom-nav [data-nav-id="${info.id}"]`);
    return;
  }
  await page.click('.om-bottom-nav [data-nav-id="more"]');
  const sheet = page.locator(".om-bottom-sheet");
  await sheet.waitFor();
  if (info.sub) await sheet.locator(`ul[aria-label="${info.parent} sections"]`).getByRole("button", { name: info.label, exact: true }).click();
  else await sheet.locator(".om-bottom-sheet-item", { has: page.getByText(info.label, { exact: true }) }).first().click();
}

// Training Load from the main navigation.
export async function openTrainingLoad(page) {
  await navTo(page, '.sidebar [data-library-tab="training-load"]');
  await page.waitForSelector('[data-action="training-load-section"]');
}

export async function api(context, world, path) {
  const res = await context.request.get(`${world.baseUrl}${path}`);
  return res.status();
}

// Settings from the main navigation; returns the tab labels.
export async function openSettings(page) {
  await navTo(page, '.sidebar .sidebar-nav-button[data-library-tab="organization"]');
  await page.waitForSelector(".settings-tabs");
  return page.$$eval(".settings-tabs button", (e) => e.map((x) => x.textContent.trim()));
}

export async function request(context, world, path, { method = "GET", body } = {}) {
  const res = await context.request.fetch(`${world.baseUrl}${path}`, { method, ...(body === undefined ? {} : { data: body }) });
  const text = await res.text();
  return { status: res.status(), text };
}

// Imports P4: the period chooser opens on today's month; the e2e fixture's sessions are in November 2026. Page the chooser
// (on the page or in the phone's sheet) to a month by its heading ("November 2026"), whatever the date of the run.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthIndex = (heading) => {
  const [name, year] = heading.trim().split(/\s+/);
  return Number(year) * 12 + MONTHS.indexOf(name);
};
export async function showPeriodMonth(page, heading = "November 2026") {
  const target = monthIndex(heading);
  for (let i = 0; i < 36; i += 1) {
    const shown = (await page.textContent(".imports-period .period-month")).trim();
    if (shown === heading) return;
    await page.click(`.imports-period [data-action="training-load-gpexe-period-month"][data-delta="${monthIndex(shown) > target ? -1 : 1}"]`);
    await page.waitForFunction((s) => document.querySelector(".imports-period .period-month")?.textContent.trim() !== s, shown, { timeout: 10_000 });
  }
  throw new Error(`the period chooser never showed ${heading}`);
}
