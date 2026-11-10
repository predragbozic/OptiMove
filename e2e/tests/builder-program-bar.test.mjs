// B3: the Builder's program bar.
// - a computer (1280, 768 px): Exit, Save and Discard are 44 px tall and show their words;
// - a phone (390, 360 px): they are 44 x 44 icons whose words stay their accessible names;
// - the outline's two "i" buttons are 44 px and say "Program example" and "Session example";
// - the plan's state is a chip; no horizontal overflow at any width.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

let made = false;
async function openBar(width) {
  const opened = await openAs(browser, world, "team_coach", width);
  const { context, page } = opened;
  if (!made) {
    const res = await context.request.fetch(`${world.baseUrl}/api/builder/plans`, { method: "POST", headers: { origin: world.baseUrl }, data: { planType: "program", athleteIds: ["1"], athleteExternalIds: ["1"], name: "Bar check" } });
    assert.ok(res.status() < 300, `create the program: ${res.status()}`);
    made = true;
  }
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="builder"]').first().click();
  await page.getByText("Continue where you left off").first().click();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.locator(".builder-program-bar").first().waitFor();
  await page.waitForTimeout(400);
  return opened;
}

const bar = (page) => page.evaluate(() => ["builder-cancel", "builder-submit-plan", "builder-discard-current-draft"].map((action) => {
  const button = document.querySelector(`.builder-program-actions [data-action="${action}"]`);
  const box = button.getBoundingClientRect();
  const label = button.querySelector(".builder-bar-label").getBoundingClientRect();
  return { action, w: Math.round(box.width), h: Math.round(box.height), word: label.width > 4 && label.height > 4 };
}));

const examples = (page) => page.evaluate(() => [...document.querySelectorAll(".builder-outline-info-buttons .builder-info-button")].map((b) => {
  const box = b.getBoundingClientRect();
  return { text: b.innerText.trim().replace(/\s+/g, " "), w: Math.round(box.width), h: Math.round(box.height) };
}));

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [1280, 768]) {
  test(`(${width} px) Exit, Save and Discard are 44 px buttons with their words; the examples say what they open`, async () => {
    const { context, page, pageErrors } = await openBar(width);
    try {
      for (const { action, h, word } of await bar(page)) {
        assert.ok(h >= 44, `${action}: ${h} px tall`);
        assert.ok(word, `${action}: its word shows`);
      }
      const info = await examples(page);
      assert.deepEqual(info.map((i) => i.text), ["i Program example", "i Session example"]);
      // Their visible words are their names (voice control: "click Program example").
      for (const name of ["Program example", "Session example"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
      for (const { text, h } of info) assert.ok(h >= 44, `${text}: ${h}`);
      assert.equal(await page.locator(".builder-program-actions .builder-status-chip").count(), 1);
      assert.ok(await overflow(page) <= 0, "no horizontal overflow");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

for (const width of [390, 360]) {
  test(`(${width} px, a phone) the bar's buttons are 44 x 44 icons named by their words; the examples are 44 px`, async () => {
    const { context, page, pageErrors } = await openBar(width);
    try {
      for (const { action, w, h, word } of await bar(page)) {
        assert.ok(w >= 44 && h >= 44, `${action}: ${w}x${h}`);
        assert.equal(word, false, `${action}: the word is hidden on a phone`);
      }
      for (const name of ["Exit", "Save", "Discard changes"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
      const info = await examples(page);
      assert.equal(info.length, 2);
      for (const { text, w, h } of info) assert.ok(w >= 44 && h >= 44, `${text}: ${w}x${h}`);
      assert.ok(await overflow(page) <= 0, "no horizontal overflow");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(360 px, a phone) while a save runs, \"Saving…\" fits its button and the page stays as wide as the screen", async () => {
  const { context, page, pageErrors } = await openBar(360);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  try {
    // The save waits here; the test then answers it with an error, so the plan stays a draft.
    await page.route(/\/api\/builder\/plans\/[^/]+\/submit/, async (route) => { await held; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "test stop" }) }); });
    page.on("dialog", (dialog) => dialog.accept().catch(() => {}));
    await page.locator('.builder-program-actions [data-action="builder-submit-plan"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="builder-submit-plan"]')?.textContent.includes("Saving"), null, { timeout: 10_000 });
    const box = await page.evaluate(() => {
      const button = document.querySelector('[data-action="builder-submit-plan"]');
      return { scroll: button.scrollWidth, client: button.clientWidth, height: Math.round(button.getBoundingClientRect().height) };
    });
    assert.ok(box.scroll <= box.client + 1, JSON.stringify(box));
    assert.ok(box.height >= 44, JSON.stringify(box));
    assert.ok(await overflow(page) <= 0, "no horizontal overflow");
    release();
    await page.waitForFunction(() => !document.querySelector('[data-action="builder-submit-plan"]')?.textContent.includes("Saving"), null, { timeout: 10_000 });
    assert.equal(await page.locator('.builder-program-actions [data-action="builder-submit-plan"] .builder-bar-label').count(), 1, "the icon and its word come back");
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});
