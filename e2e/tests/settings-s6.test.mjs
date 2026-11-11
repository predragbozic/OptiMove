// S6 (Settings) in a real browser: App health's chips are 44 px on a computer too; Calendar settings hides the "Add …"
// button while its own form is open and shows it again after Cancel.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openSection(page, section) {
  await openSettings(page);
  await page.locator(`.settings-tabs [data-section="${section}"]`).first().click();
}

for (const width of [1280, 390]) test(`(platform_admin, ${width} px) App health's chips are 44 px`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", width);
  try {
    // App health draws its chips, then draws them again when its data (GET /api/app-errors/groups) arrives. Wait for
    // that answer, then measure in the same step that finds the chips laid out, so a repaint between finding and
    // measuring can never yield "0 chips".
    const loaded = page.waitForResponse((r) => r.url().includes("/api/app-errors/groups"));
    await openSection(page, "appHealth");
    await loaded;
    const sizes = await (await page.waitForFunction(() => {
      const laid = [...document.querySelectorAll(".app-health-chip")].filter((c) => c.getBoundingClientRect().width > 0);
      return laid.length >= 4 ? laid.map((c) => Math.round(c.getBoundingClientRect().height)) : null;
    })).jsonValue();
    assert.ok(sizes.length >= 4, `${sizes.length} chips`);
    for (const h of sizes) assert.ok(h >= 44, `a chip is ${h} px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

for (const width of [1280, 390]) test(`(club_admin, ${width} px) Calendar settings hides "Add a type" while its form is open`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
  try {
    await openSection(page, "calendar");
    const add = page.locator('main.workspace [data-action="calendar-settings-new"][data-kind="type"]');
    await add.waitFor();
    await add.click();
    await page.locator("main.workspace form").filter({ has: page.locator('button[type="submit"]') }).first().waitFor();
    assert.equal(await add.isVisible(), false, "hidden while its form is open");
    assert.equal(await add.isDisabled(), true, "and still off");
    await page.locator('main.workspace [data-action="calendar-settings-cancel"]').first().click();
    await add.waitFor({ state: "visible" });
    assert.equal(await add.isDisabled(), false, "back, and usable, after Cancel");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
