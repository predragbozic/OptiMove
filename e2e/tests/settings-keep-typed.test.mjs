// F1 in a real browser: a late /api/organization answer repaints Settings while an edit dialog is open; what the
// person typed is still there afterwards (it was wiped before), a field they did not touch takes the saved value, and
// Save sends the typed name. Demo data only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

for (const width of [390, 1280]) test(`(club_admin, ${width} px) a late organization answer keeps what was typed in the open Edit team dialog`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
  try {
    await openSettings(page);
    await page.locator('.settings-tabs [data-section="teams"]').first().click();
    await page.locator('main.workspace [data-action="organization-edit"][data-org-type="team"]').first().waitFor();
    // From here every organization read answers 1.5 s late, so the repaint lands after the typing.
    let delayed = 0;
    await page.route(/\/api\/organization(\?.*)?$/, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      delayed += 1;
      await new Promise((r) => setTimeout(r, 1500));
      return route.continue();
    });
    const late = page.waitForResponse((r) => /\/api\/organization(\?.*)?$/.test(r.url()) && r.request().method() === "GET");
    await page.locator('main.workspace [data-action="organization-edit"][data-org-type="team"]').first().click();
    const name = page.locator('[role="dialog"] form[data-organization-form="edit-team"] input[name="name"]');
    await name.waitFor();
    const before = await name.inputValue();
    await name.fill(`${before} F1`);
    await late;
    await page.waitForTimeout(300);
    assert.ok(delayed >= 1, "an organization answer arrived while the dialog was open");
    assert.equal(await name.inputValue(), `${before} F1`, "the typed name survived the repaint");
    await page.unroute(/\/api\/organization(\?.*)?$/);
    const sent = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes("/api/organization/teams/"));
    await page.locator('[role="dialog"] .organization-dialog-footer').getByRole("button", { name: "Save changes", exact: true }).click();
    assert.equal(JSON.parse((await sent).postData()).name, `${before} F1`, "Save sends what was typed");
    await page.locator('main.workspace [data-action="organization-select-team"]').filter({ hasText: `${before} F1` }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
