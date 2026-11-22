// The weekly "Plan it in the Builder" refused because the coach's own draft of that athlete and week holds a session (an
// empty one: PR #726 no longer replaces it): the message offers "Open that draft", and it opens that very draft in the
// Builder. At 1280, 390 and 360 px: the button is a 44 px target, nothing overflows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const MONDAY = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();

let world;
let browser;
const rosterId = {};
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    for (const row of (await db.query(`select athlete_id, full_name from public.athletes`)).rows) rosterId[row.full_name] = row.athlete_id;
  } finally {
    await db.end();
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

async function call(role, method, path, body) {
  const account = world.accounts.find((a) => a.role === role);
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: `optimove_session=${account.sessionToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);

// One draft with one empty session in this week, for an athlete no other test of this file uses.
async function draftWithEmptySession(name) {
  const plan = await call("club_admin", "POST", "/api/builder/plans", { planType: "weekly", weekStart: MONDAY, athleteIds: [rosterId[name]], name: "Abandoned week" });
  assert.equal(plan.status, 201, plan.text);
  const block = plan.body.blocks[0];
  const withSession = await call("club_admin", "POST", `/api/builder/blocks/${block.id}/sessions`, { amPm: "AM", bta: "T", time: "" });
  assert.equal(withSession.status, 201, withSession.text);
  // The week is what the server refuses to replace now.
  const again = await call("club_admin", "POST", "/api/builder/plans", { planType: "weekly", weekStart: MONDAY, athleteIds: [rosterId[name]] });
  assert.equal(again.status, 409, again.text);
  return plan.body.plan.id;
}

test("(390 px) when opening the draft fails, the screen is drawn again with the message, its button and the reason", async () => {
  const name = "Dario Example";
  const planId = await draftWithEmptySession(name);
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.phone);
  try {
    await openNav(page);
    await page.locator("#calendarToggle").click();
    await page.waitForSelector(".central-calendar .athlete-switcher", { timeout: 20_000 });
    if ((await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
    await page.locator(`.athlete-switcher .builder-batch-pill[aria-label="${name}"]`).click();
    await page.waitForSelector(".cc-athlete-line");
    await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
    await page.waitForSelector(".weekly-k6");
    await page.getByRole("button", { name: "Plan it in the Builder" }).click();
    const open = page.locator('[data-action="weekly-open-existing"]');
    await open.waitFor({ timeout: 20_000 });
    await page.route(`**/api/builder/plans/${planId}`, (route) => (route.request().method() === "GET" ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.continue()));
    await open.click();
    await page.locator(".builder-error", { hasText: "boom" }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText("Opening weekly plan...").count(), 0, "no loading placeholder is left");
    assert.equal(await page.locator('[data-action="weekly-open-existing"]').count(), 1, "the button is back for a retry");
    assert.deepEqual(pageErrors.filter((e) => !/500/.test(String(e))), []);
  } finally {
    await context.close();
  }
});

const CASES =[["1280 px", WIDTHS.desktop, "Ana Example"], ["390 px", WIDTHS.phone, "Bojan Example"], ["360 px", 360, "Cara Example"]];
for (const [label, width, name] of CASES) {
  test(`(${label}) a refused weekly create offers Open that draft, and it opens that draft`, async () => {
    const planId = await draftWithEmptySession(name);
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openNav(page);
      await page.locator("#calendarToggle").click();
      await page.waitForSelector(".central-calendar .athlete-switcher", { timeout: 20_000 });
      if (width < 761 && (await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
      await page.locator(`.athlete-switcher .builder-batch-pill[aria-label="${name}"]`).click();
      await page.waitForSelector(".cc-athlete-line");
      await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
      await page.waitForSelector(".weekly-k6");
      await page.getByText("No plan this week").waitFor();
      await page.getByRole("button", { name: "Plan it in the Builder" }).click();
      const open = page.locator('[data-action="weekly-open-existing"]');
      await open.waitFor({ timeout: 20_000 });
      assert.equal((await open.innerText()).trim(), "Open that draft");
      assert.match(await page.locator(".builder-page-error p").innerText(), /already has a weekly plan/i);
      const box = await open.boundingBox();
      assert.ok(box.height >= 43.5 && box.width >= 43.5, `44 px target, got ${box.width}x${box.height}`);
      assert.equal(await overflow(page, width), 0);
      await open.click();
      await page.locator(".builder-program-bar").first().waitFor({ timeout: 20_000 });
      assert.equal(await page.locator('[data-action="weekly-open-existing"]').count(), 0);
      const draft = await call("club_admin", "GET", `/api/builder/plans/${planId}`);
      assert.equal(draft.status, 200, "the draft is kept");
      assert.equal(await overflow(page, width), 0);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
