// U4: the top bar's connection status. On a phone "Online" is a 12 px dot (not a row of its own) with the state in its accessible name;
// a state that is not ok brings the text pill back; on desktop the pill is unchanged.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const box = (page, sel) => page.locator(sel).boundingBox();

test("U4 (390 px) Online is a dot of at least 10 px level with the title, the state is in the aria-label, a problem state is a text pill again", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.phone);
  try {
    await page.waitForFunction(() => document.querySelector("#apiStatus")?.textContent === "Online", null, { timeout: 20_000 });
    const pill = page.locator("#apiStatus");
    assert.equal(await pill.getAttribute("data-state"), "ok");
    assert.match(await pill.getAttribute("aria-label"), /Online/);
    const dot = await box(page, "#apiStatus");
    assert.ok(dot.width >= 10 && dot.height >= 10 && dot.width <= 16, `the dot is ${dot.width}x${dot.height}`);
    const actions = await box(page, ".topbar-actions");
    assert.ok(dot.y < actions.y, "the dot is above the action row, not a row of its own below it");
    const rightEdge = dot.x + dot.width;
    assert.ok(rightEdge <= WIDTHS.phone, "inside the screen");
    // The header is shorter than with the pill row: the dot adds nothing under the actions.
    const topbar = await box(page, ".topbar");
    assert.ok(actions.y + actions.height <= topbar.y + topbar.height + 1, "no extra row under the actions");
    // A problem state: the text pill comes back.
    await page.evaluate(() => { const p = document.querySelector("#apiStatus"); p.textContent = "Error"; p.dataset.state = "error"; p.setAttribute("aria-label", "Status: Error"); });
    const pillBox = await box(page, "#apiStatus");
    assert.ok(pillBox.width >= 50, `the problem pill shows its text (${pillBox.width}px wide)`);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("U4 (1280 px) desktop keeps the Online pill", async () => {
  const { context, page } = await openAs(browser, world, "team_coach", WIDTHS.desktop);
  try {
    await page.waitForFunction(() => document.querySelector("#apiStatus")?.textContent === "Online", null, { timeout: 20_000 });
    const b = await box(page, "#apiStatus");
    assert.ok(b.width >= 90, `the pill is ${b.width}px wide on desktop`);
    assert.equal((await page.locator("#apiStatus").innerText()).trim(), "Online");
  } finally { await context.close(); }
});
