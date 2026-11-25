// Roles V-5a (the licence hierarchy, v96; docs/ai/roles-v-steps-plan.md 13.1): in Settings > Clubs > a club's licence,
// a platform administrator takes Training Load out; its three children (Dashboards, Imports, Data configuration) turn
// "Not included" with their switches disabled and the note "Closed because Training Load is closed"; the save sends
// only Training Load; the server stores only that row and reads the children as closed through it; putting it back
// draws the children again. Then the club's admin finds Data configuration closed (the identical 404). At 1280, 390
// and 360 px, with no side scroll and 44 px targets. Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const R = "/api/organization/roles";
const CHILDREN = ["dashboards", "imports", "data_configuration"];

before(async () => {
  world = await startWorld();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

async function openLicence(page) {
  await openSettings(page);
  await page.click('[data-action="organization-section"][data-section="clubs"]');
  await page.click(`[data-action="organization-select-club"][data-club-id="${world.ids.clubA}"]`);
  const licence = page.locator("[data-club-licence]");
  await licence.waitFor();
  await licence.getByRole("button", { name: "Show" }).click();
  await licence.locator('[data-licence-module="training_load"]').waitFor();
  return licence;
}

test("1. (1280 px) taking Training Load out closes its children on screen and on the server; putting it back opens them again", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", WIDTHS.desktop);
  try {
    const licence = await openLicence(page);
    await licence.locator('[data-licence-module="training_load"]').uncheck();
    for (const child of CHILDREN) {
      assert.equal(await licence.locator(`[data-licence-module="${child}"]`).isChecked(), false, child);
      assert.equal(await licence.locator(`[data-licence-module="${child}"]`).isDisabled(), true, child);
      assert.equal((await licence.locator(`[data-licence-closed-by-parent="${child}"]`).textContent()).trim(), "Closed because Training Load is closed.", child);
    }
    assert.equal(await licence.locator('[data-licence-module="calendar"]').isDisabled(), false);
    await licence.getByText("Take out: Training Load.").waitFor();
    await licence.locator("textarea").fill("Licence season end");
    await licence.getByRole("button", { name: "Save licence (1 change)" }).click();
    await licence.getByText("Licence saved – taken out: Training Load.").waitFor();
    const view = JSON.parse((await request(context, world, `${R}/clubs/${world.ids.clubA}/ceiling`)).text);
    for (const child of CHILDREN) {
      const m = view.modules.find((x) => x.module === child);
      assert.deepEqual({ closed: m.closed, closedByParent: m.closedByParent, effectivelyClosed: m.effectivelyClosed }, { closed: false, closedByParent: true, effectivelyClosed: true }, child);
    }
    // The club's admin: Data configuration is closed with its parent (the identical 404 of every other missing read).
    const admin = await browser.newContext();
    try {
      await admin.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === "club_admin").sessionToken, url: world.baseUrl }]);
      const read = await request(admin, world, "/api/training-load/sources/metrics/variables");
      assert.equal(read.status, 404, read.text);
    } finally {
      await admin.close();
    }
    // Put back.
    await licence.locator('[data-licence-module="training_load"]').check();
    await licence.locator("textarea").fill("Licence season start");
    await licence.getByRole("button", { name: "Save licence (1 change)" }).click();
    await licence.getByText("Licence saved – put back: Training Load.").waitFor();
    for (const child of CHILDREN) {
      assert.equal(await licence.locator(`[data-licence-module="${child}"]`).isChecked(), true, child);
      assert.equal(await licence.locator(`[data-licence-module="${child}"]`).isDisabled(), false, child);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

for (const width of [390, 360]) {
  test(`2. (${width} px) the greyed children and their note fit the phone: no side scroll, 44 px targets`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", width);
    try {
      const licence = await openLicence(page);
      await licence.locator('[data-licence-module="training_load"]').uncheck();
      await licence.locator('[data-licence-closed-by-parent="data_configuration"]').waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "no horizontal scroll");
      const small = await page.$$eval("[data-club-licence] button, [data-club-licence] label.club-licence-switch", (els) => els
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ text: el.textContent.trim().slice(0, 40), h: el.getBoundingClientRect().height }))
        .filter((x) => x.h < 43.5));
      assert.deepEqual(small, [], "every control 44 px");
      const overflow = await licence.locator('[data-licence-closed-by-parent="data_configuration"]').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      assert.equal(overflow, false, "the note wraps inside its row");
      await licence.getByRole("button", { name: "Cancel" }).click();
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
