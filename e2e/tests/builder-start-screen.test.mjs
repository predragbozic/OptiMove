// B4: the Builder's start screen ("Continue where you left off").
// - every control is at least 44 px at 1280, 768, 390 and 360 px, with no horizontal overflow;
// - on a phone a draft's name has the row's width (its actions sit below it);
// - Discard, now a button, still discards the draft (after its confirmation).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function makeDraft(context, name) {
  const res = await context.request.fetch(`${world.baseUrl}/api/builder/plans`, { method: "POST", headers: { origin: world.baseUrl }, data: { planType: "program", athleteIds: ["1"], athleteExternalIds: ["1"], name } });
  assert.ok(res.status() < 300, `create ${name}: ${res.status()}`);
}

let made = false;
async function openStart(width) {
  const opened = await openAs(browser, world, "team_coach", width);
  const { context, page } = opened;
  if (!made) {
    await makeDraft(context, "Return to play");
    await makeDraft(context, "Strength block for the second half of the season");
    made = true;
  }
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="builder"]').first().click();
  await page.getByText("Continue where you left off").first().click();
  await page.locator('[data-action="builder-toggle-select-draft"]').first().waitFor();
  await page.locator('[data-action="builder-toggle-select-draft"]').first().click();
  await page.locator('[data-action="builder-discard-selected-drafts"]').waitFor();
  return opened;
}

for (const width of [1280, 768, 390, 360]) {
  test(`(${width} px) every control of "Continue where you left off" is at least 44 px`, async () => {
    const { context, page, pageErrors } = await openStart(width);
    try {
      const controls = await page.evaluate(() => [...document.querySelectorAll(".builder-drafts-panel button")]
        .filter((e) => e.getBoundingClientRect().width)
        .map((e) => { const r = e.getBoundingClientRect(); return { action: e.dataset.action, w: Math.round(r.width), h: Math.round(r.height) }; }));
      for (const action of ["builder-toggle-drafts-panel", "builder-toggle-select-all-drafts", "builder-discard-selected-drafts", "builder-toggle-select-draft", "builder-open-draft", "builder-discard-draft"]) {
        assert.ok(controls.some((c) => c.action === action), `${action} is on screen`);
      }
      for (const { action, w, h } of controls) assert.ok(w >= 44 && h >= 44, `${action}: ${w}x${h}`);
      if (width < 600) {
        const share = await page.evaluate(() => [...document.querySelectorAll(".builder-draft-row")].map((row) => row.querySelector(".builder-draft-info").getBoundingClientRect().width / row.getBoundingClientRect().width));
        for (const s of share) assert.ok(s > 0.6, `the name has ${Math.round(s * 100)} % of its row`);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, "no horizontal overflow");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(390 px) Discard, now a button, discards the draft after its confirmation", async () => {
  const { context, page, pageErrors } = await openStart(390);
  try {
    const before = await page.locator(".builder-draft-row").count();
    page.once("dialog", (dialog) => dialog.accept());
    const deleted = page.waitForResponse((r) => /\/api\/builder\/plans\/[^/]+$/.test(r.url()) && r.request().method() === "DELETE");
    await page.locator('[data-action="builder-discard-draft"]').first().click();
    assert.ok((await deleted).status() < 300);
    await page.waitForFunction((n) => document.querySelectorAll(".builder-draft-row").length < n, before, { timeout: 10_000 });
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
