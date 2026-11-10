// B3: the Builder's program bar (the owner's decision of 2026-11-10: icons only, with a styled tooltip).
// - every width: Exit, Save and Discard are 44 x 44 icons named Exit / Save / Discard changes, with no title;
// - a computer (1280, 768 px): hover with the mouse and keyboard focus show the tooltip, which is the button's
//   description (aria-description) and stays on the screen; hovering runs nothing;
// - a phone (390, 360 px): a long press (CDP touch, 700 ms) shows the same tooltip and does not run the action;
//   a short tap still does;
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
  return { action, w: Math.round(box.width), h: Math.round(box.height), text: button.innerText.trim(), name: button.getAttribute("aria-label"), title: button.hasAttribute("title") };
}));

// The tooltip of one bar button: shown or not, its text, and whether it stays inside the window.
const tooltip = (page, action) => page.evaluate((name) => {
  const button = document.querySelector(`.builder-program-actions [data-action="${name}"]`);
  const s = getComputedStyle(button, "::after");
  // The tooltip hangs from its containing block: the button, or the whole bar on a phone (the button is static).
  const holder = getComputedStyle(button).position === "static" ? button.offsetParent : button;
  const b = holder.getBoundingClientRect();
  const width = parseFloat(s.width) + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
  const left = s.left !== "auto" && s.right === "auto" ? b.left + parseFloat(s.left) : b.right - parseFloat(s.right) - width;
  return { shown: s.visibility === "visible" && parseFloat(s.opacity) > 0.9, text: s.content.replace(/^"|"$/g, ""), description: button.getAttribute("aria-description"), inside: left >= 0 && left + width <= document.documentElement.clientWidth };
}, action);

const settle = (page) => page.waitForTimeout(250);

const examples = (page) => page.evaluate(() => [...document.querySelectorAll(".builder-outline-info-buttons .builder-info-button")].map((b) => {
  const box = b.getBoundingClientRect();
  return { text: b.innerText.trim().replace(/\s+/g, " "), w: Math.round(box.width), h: Math.round(box.height) };
}));

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [1280, 768]) {
  test(`(${width} px) the bar's 44 px icons show their description on hover and on keyboard focus; the examples say what they open`, async () => {
    const { context, page, pageErrors } = await openBar(width);
    try {
      for (const { action, w, h, text, title } of await bar(page)) {
        assert.ok(w >= 44 && h >= 44, `${action}: ${w}x${h}`);
        assert.equal(text, "", `${action}: an icon only`);
        assert.equal(title, false, `${action}: no title (no second, native tooltip)`);
      }
      for (const name of ["Exit", "Save", "Discard changes"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
      for (const { action } of await bar(page)) assert.equal((await tooltip(page, action)).shown, false, `${action}: no tooltip at rest`);

      // Hover: the tooltip is the button's name, on the screen; nothing runs.
      for (const { action } of await bar(page)) {
        await page.locator(`.builder-program-actions [data-action="${action}"]`).hover();
        await settle(page);
        const tip = await tooltip(page, action);
        assert.ok(tip.shown, `${action}: shown on hover`);
        assert.ok(tip.description, `${action}: has a description`);
        assert.equal(tip.text, tip.description, `${action}: the tooltip is the button's description`);
        assert.ok(tip.inside, `${action}: the tooltip stays on the screen`);
      }
      await page.mouse.move(5, 5);
      await settle(page);
      assert.equal(await page.locator(".builder-program-bar").count(), 1, "hovering ran nothing: still in the Builder");

      // Keyboard focus shows it as well.
      await page.keyboard.press("Shift");
      await page.locator('.builder-program-actions [data-action="builder-cancel"]').focus();
      await settle(page);
      assert.ok((await tooltip(page, "builder-cancel")).shown, "shown on keyboard focus");
      // Escape closes it while the button keeps its focus (WCAG 1.4.13).
      await page.keyboard.press("Escape");
      await settle(page);
      assert.equal((await tooltip(page, "builder-cancel")).shown, false, "Escape closes the tooltip");
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "builder-cancel", "the focus stays on Exit");
      assert.equal(await page.locator(".builder-program-bar").count(), 1, "Escape ran nothing");

      const info = await examples(page);
      assert.deepEqual(info.map((i) => i.text), ["i Program example", "i Session example"]);
      for (const name of ["Program example", "Session example"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
      for (const { text, h } of info) assert.ok(h >= 44, `${text}: ${h}`);
      assert.equal(await page.locator(".builder-program-actions .builder-status-chip").count(), 1);
      assert.ok(await overflow(page) <= 0, "no horizontal overflow");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

async function touchPress(page, context, action, ms) {
  const box = await page.locator(`.builder-program-actions [data-action="${action}"]`).boundingBox();
  const cdp = await context.newCDPSession(page);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await page.waitForTimeout(ms);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

for (const width of [390, 360]) {
  test(`(${width} px, a phone) the bar's 44 x 44 icons: a long press shows the description and runs nothing, a tap still runs`, async () => {
    const { context, page, pageErrors } = await openBar(width);
    try {
      for (const { action, w, h, text, title } of await bar(page)) {
        assert.ok(w >= 44 && h >= 44, `${action}: ${w}x${h}`);
        assert.equal(text, "", `${action}: an icon only`);
        assert.equal(title, false, `${action}: no title (no second, native tooltip)`);
      }
      for (const name of ["Exit", "Save", "Discard changes"]) assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1, name);
      const info = await examples(page);
      assert.equal(info.length, 2);
      for (const { text, w, h } of info) assert.ok(w >= 44 && h >= 44, `${text}: ${w}x${h}`);

      // A long press on each: its tooltip shows, nothing runs (no save request, no discard question, still in the
      // Builder).
      const sent = [];
      page.on("request", (request) => { if (request.method() !== "GET" && /\/api\/builder\//.test(request.url())) sent.push(request.url()); });
      let asked = 0;
      page.on("dialog", (dialog) => { asked += 1; dialog.dismiss().catch(() => {}); });
      for (const [action, text] of [["builder-cancel", "Exit and keep this draft for later."], ["builder-submit-plan", "Save and finish — marks this plan as active."], ["builder-discard-current-draft", "Discard all changes in this draft."]]) {
        await touchPress(page, context, action, 700);
        await settle(page);
        const tip = await tooltip(page, action);
        assert.ok(tip.shown, `${action}: shown after a long press`);
        assert.equal(tip.text, text);
        assert.ok(tip.inside, `${action}: the tooltip stays on the screen`);
        assert.ok(await overflow(page) <= 0, `${action}: no horizontal overflow`);
        await page.waitForTimeout(1800);
      }
      assert.equal(await page.locator(".builder-program-bar").count(), 1, "no long press left the Builder");
      assert.deepEqual(sent, [], "no long press sent a write");
      assert.equal(asked, 0, "no long press asked a question");

      // A short tap still exits.
      await touchPress(page, context, "builder-cancel", 60);
      await page.locator(".builder-program-bar").waitFor({ state: "detached", timeout: 10_000 });
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
    assert.equal(await page.locator('.builder-program-actions [data-action="builder-submit-plan"] svg').count(), 1, "the icon comes back");
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});
