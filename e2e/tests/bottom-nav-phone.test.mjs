// The phone's bottom navigation (owner, 2026-11-24; the first React island): on a phone every role gets a bar at the
// bottom with exactly the sections its menu shows (the bar's sections plus its More sheet equal the menu's visible
// items), 44 px targets, the current section marked, nothing of the page under the bar; a tap goes through the menu's own
// control, so an unsaved form is asked about first. A computer keeps the rail and never downloads React.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const bar = '.om-bottom-nav';
const barIds = (page) => page.$$eval(`${bar} .om-bottom-nav-item`, (e) => e.map((x) => x.dataset.navId));

// A section wherever it is: on the bar, or in More by its label.
async function go(page, id, label) {
  if (await page.locator(`${bar} [data-nav-id="${id}"]`).count()) return page.click(`${bar} [data-nav-id="${id}"]`);
  await page.click(`${bar} [data-nav-id="more"]`);
  await page.locator(".om-bottom-sheet-item", { hasText: label }).first().click();
}

async function editMenu(page) {
  await page.click(`${bar} [data-nav-id="more"]`);
  await page.getByRole("button", { name: "Edit menu", exact: true }).click();
  await page.waitForSelector(".om-bottom-sheet-field select");
}

// The menu's visible sections (as the menu decides them) and the bar's own (bar + More), by label.
async function sections(page) {
  await page.waitForSelector(`${bar} [data-nav-id]`, { timeout: 20_000 });
  const menu = await page.evaluate(() => {
    const hidden = (el) => el.hidden || el.closest("[hidden]");
    const out = ["Home"];
    for (const el of document.querySelectorAll(".app-shell > .sidebar .rail-button")) {
      if (el.closest(".sidebar-subnav") || el.closest(".brand") || hidden(el)) continue;
      out.push((el.getAttribute("title") || "").trim());
    }
    // Messages may hold a place too, where the shell shows its header button.
    const messages = document.getElementById("messageToggle");
    if (messages && !hidden(messages)) out.push("Messages");
    return out;
  });
  const onBar = await page.$$eval(`${bar} .om-bottom-nav-item:not([data-nav-id="more"])`, (e) => e.map((x) => x.textContent.trim()));
  let inMore = [];
  if (await page.locator(`${bar} [data-nav-id="more"]`).count()) {
    await page.click(`${bar} [data-nav-id="more"]`);
    await page.waitForSelector('.om-bottom-sheet[role="dialog"]');
    inMore = await page.$$eval(".om-bottom-sheet-item", (e) => e.map((x) => x.textContent.trim()));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".om-bottom-sheet"));
  }
  return { menu, onBar, inMore };
}

async function geometry(page) {
  return page.evaluate(() => {
    const nav = document.querySelector(".om-bottom-nav");
    const r = nav.getBoundingClientRect();
    const items = [...nav.querySelectorAll("button")].map((b) => b.getBoundingClientRect()).map((b) => ({ w: b.width, h: b.height }));
    const shell = getComputedStyle(document.querySelector(".app-shell"));
    return {
      atBottom: Math.round(r.bottom) === window.innerHeight,
      height: r.height,
      small: items.filter((b) => b.w < 44 || b.h < 44).length,
      shellPadding: parseFloat(shell.paddingBottom),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const role of ["platform_admin", "club_admin", "team_coach", "athlete"]) {
  for (const width of [360, 390]) {
    test(`(${role}, ${width} px) the bar and More hold exactly the menu's sections, 44 px, nothing under the bar`, async () => {
      const { context, page, pageErrors } = await openAs(browser, world, role, width);
      try {
        const { menu, onBar, inMore } = await sections(page);
        assert.deepEqual([...onBar, ...inMore].sort(), [...menu].sort(), `the bar and More are the menu's sections, no more, no fewer: ${JSON.stringify({ menu, onBar, inMore })}`);
        assert.equal(onBar.length <= 4, true);
        assert.equal(onBar[0], "Home");
        const g = await geometry(page);
        assert.equal(g.atBottom, true, "the bar sits at the bottom of the screen");
        assert.equal(g.small, 0, "every control of the bar is at least 44 px");
        assert.ok(g.shellPadding >= g.height - 1, `the page ends above the bar (${g.shellPadding} >= ${g.height})`);
        assert.equal(g.overflow, 0);
        // Home is the current section after sign-in.
        assert.equal(await page.getAttribute(`${bar} [data-nav-id="home"]`, "aria-current"), "page");
        assert.deepEqual(pageErrors, []);
      } finally { await context.close(); }
    });
  }
}

test("(team_coach, 390 px) Training load and Calendar from the bar, the current one marked; More opens a section of the rest", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 390);
  try {
    await page.click(`${bar} [data-nav-id="training-load"]`);
    await page.waitForSelector('[data-action="training-load-section"]');
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="training-load"]')?.getAttribute("aria-current") === "page");
    assert.equal(await page.getAttribute(`${bar} [data-nav-id="home"]`, "aria-current"), null);
    await page.click(`${bar} [data-nav-id="central-calendar"]`);
    await page.waitForSelector(".cc-toolbar", { timeout: 20_000 });
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="central-calendar"]')?.getAttribute("aria-current") === "page");
    // More: Settings; the More button is then marked as holding the current section.
    await page.click(`${bar} [data-nav-id="more"]`);
    // The open sheet's backdrop covers the header and the page (it is not held under the bar's own layer).
    const onTop = await page.evaluate(() => [[20, 20], [innerWidth - 20, 60]].map(([x, y]) => document.elementFromPoint(x, y)?.className || ""));
    assert.deepEqual(onTop, ["om-bottom-sheet-backdrop", "om-bottom-sheet-backdrop"], "the backdrop is on top of the header");
    await page.locator(".om-bottom-sheet-item", { hasText: "Settings" }).click();
    await page.waitForSelector(".settings-tabs");
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="more"]')?.classList.contains("is-active"));
    assert.equal(await page.locator(".om-bottom-sheet").count(), 0, "the sheet closed");
    // Athletes opens the athlete list.
    await page.click(`${bar} [data-nav-id="athletes"]`);
    await page.waitForFunction(() => document.body.classList.contains("mobile-nav-open") && document.body.classList.contains("athletes-drawer-open"));
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(platform_admin, 390 px) an unsaved variable form is asked about before the bar leaves Training Load", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", 390);
  try {
    // An administrator's Training load is under More by default.
    await go(page, "training-load", "Training load");
    await page.click('[data-action="training-load-section"][data-section="variables"]');
    await page.click('[data-action="metric-classification-view"][data-view="variables"]');
    await page.click('[data-action="metric-variables-create-open"]', { timeout: 20_000 });
    await page.fill('input[data-mv-field="label"]', "Bar guard test");
    const asked = [];
    page.once("dialog", (d) => { asked.push(d.message()); d.dismiss().catch(() => {}); });
    await page.click(`${bar} [data-nav-id="home"]`);
    for (let i = 0; i < 60 && !asked.length; i += 1) await page.waitForTimeout(50);
    assert.equal(asked.length, 1, "the bar's Home asked first");
    assert.match(asked[0], /Discard/);
    await page.waitForTimeout(300);
    assert.equal(await page.inputValue('input[data-mv-field="label"]'), "Bar guard test", "Stay keeps the form and what was typed");
    assert.equal(await page.locator('[data-action="training-load-section"]').count() > 0, true, "still on Training load");
    page.once("dialog", (d) => d.accept().catch(() => {}));
    await page.click(`${bar} [data-nav-id="home"]`);
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="home"]')?.getAttribute("aria-current") === "page", null, { timeout: 20_000 });
    assert.equal(await page.locator('input[data-mv-field="label"]').count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(athlete, 390 px) Calendar from the bar; Weekly plan from wherever it is (the bar or More)", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "athlete", 390);
  try {
    const ids = await barIds(page);
    assert.deepEqual(ids.slice(0, 3), ["home", "athlete-calendar", "tests"], "the athlete's defaults: Calendar and Tests after Home");
    await page.click(`${bar} [data-nav-id="athlete-calendar"]`);
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="athlete-calendar"]')?.getAttribute("aria-current") === "page", null, { timeout: 20_000 });
    await go(page, "calendar", "Weekly plan");
    await page.waitForFunction(() => document.querySelector('.sidebar [data-athlete-tab="calendar"]')?.classList.contains("is-active"), null, { timeout: 20_000 });
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(defaults) a coach: Calendar, Athletes, Training load; an administrator: Calendar, Athletes, Settings", async () => {
  for (const [role, expected] of [["team_coach", ["home", "central-calendar", "athletes", "training-load", "more"]], ["club_admin", ["home", "central-calendar", "athletes", "organization", "more"]], ["platform_admin", ["home", "central-calendar", "athletes", "organization", "more"]]]) {
    const { context, page } = await openAs(browser, world, role, 390);
    try {
      await page.waitForSelector(`${bar} [data-nav-id]`, { timeout: 20_000 });
      assert.deepEqual(await barIds(page), expected, role);
    } finally { await context.close(); }
  }
});

test("(team_coach, 390 px) Edit menu: choose and order the three buttons; kept after a reload; the default restores it", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 390);
  try {
    await page.waitForSelector(`${bar} [data-nav-id]`, { timeout: 20_000 });
    await editMenu(page);
    const fields = page.locator(".om-bottom-sheet-field select");
    assert.equal(await fields.count(), 3);
    // Every choice is a section this coach's menu offers; Home is not one (it is always first).
    const offered = await fields.first().locator("option").allTextContents();
    assert.ok(!offered.includes("Home") && offered.includes("Tests") && offered.includes("Builder"), offered.join(", "));
    const sizes = await page.$$eval(".om-bottom-sheet select, .om-bottom-sheet button", (e) => e.map((x) => ({ h: x.getBoundingClientRect().height, f: parseFloat(getComputedStyle(x).fontSize), tag: x.tagName })));
    assert.ok(sizes.every((s) => s.h >= 44), "44 px controls");
    assert.ok(sizes.filter((s) => s.tag === "SELECT").every((s) => s.f >= 16), "16 px selects");
    await fields.nth(0).selectOption({ label: "Tests" });
    await fields.nth(1).selectOption({ label: "Builder" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".om-bottom-sheet"));
    assert.deepEqual(await barIds(page), ["home", "tests", "builder", "training-load", "more"]);
    // Calendar and Athletes moved under More.
    await page.click(`${bar} [data-nav-id="more"]`);
    const inMore = await page.$$eval(".om-bottom-sheet-item", (e) => e.map((x) => x.textContent.trim()));
    assert.ok(inMore.includes("Calendar") && inMore.includes("Athletes"), inMore.join(", "));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".om-bottom-sheet"));
    // The bar's Tests opens Tests.
    await page.click(`${bar} [data-nav-id="tests"]`);
    await page.waitForFunction(() => document.querySelector('.om-bottom-nav [data-nav-id="tests"]')?.getAttribute("aria-current") === "page", null, { timeout: 20_000 });
    // Kept on this device after a reload.
    await page.reload();
    await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
    await page.waitForSelector(`${bar} [data-nav-id]`, { timeout: 20_000 });
    assert.deepEqual(await barIds(page), ["home", "tests", "builder", "training-load", "more"]);
    // Back to the default.
    await editMenu(page);
    await page.getByRole("button", { name: "Use the default", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".om-bottom-sheet"));
    assert.deepEqual(await barIds(page), ["home", "central-calendar", "athletes", "training-load", "more"]);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("optimove.bottomNav")).length), 0, "the default stores nothing");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(1280 px) a computer keeps the rail: no bar and React is never downloaded", async () => {
  const requested = [];
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 1280);
  try {
    page.on("request", (r) => { if (r.url().includes("react-build")) requested.push(r.url()); });
    await page.reload();
    await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator(bar).count(), 0);
    assert.deepEqual(requested, []);
    assert.equal(await page.locator(".sidebar").isVisible(), true);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
