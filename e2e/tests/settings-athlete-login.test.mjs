// Settings rows (design S5) in a real browser. An athlete's login state is a plain badge: a tap on it changes nothing.
// The switch is in a dialog behind the row's button: "Account" for a platform admin (the full account dialog),
// "Login" for a club admin and a team coach (the switch alone). Disabling asks first; declining sends nothing;
// enabling does not ask. Every row control is 44 px and nothing overflows. A join link's label has its own line on a
// phone. The demo athlete with a login is "Ana Example"; each test leaves her login enabled again.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const ATHLETE = "Ana Example";

async function openSection(page, section) {
  await openSettings(page);
  await page.locator(`.settings-tabs [data-section="${section}"]`).first().click();
  await page.waitForTimeout(700);
}

// Ana's row in the Athletes list.
const anaRow = (page) => page.locator("main.workspace .organization-row, main.workspace .organization-table-row").filter({ hasText: ATHLETE }).first();

const loginWrites = (page) => {
  const sent = [];
  page.on("request", (request) => { if (request.method() === "PUT" && /\/login-status$/.test(request.url())) sent.push(JSON.parse(request.postData() || "{}")); });
  return sent;
};

async function rowSizes(page) {
  return page.evaluate((name) => {
    const row = [...document.querySelectorAll("main.workspace .organization-row, main.workspace .organization-table-row")].find((r) => r.textContent.includes(name));
    const controls = [...row.querySelectorAll("button, a[href]")].filter((e) => e.getBoundingClientRect().width > 0);
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, controls: controls.map((e) => ({ what: (e.getAttribute("aria-label") || e.textContent).trim(), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) })) };
  }, ATHLETE);
}

for (const [role, width, button] of [["platform_admin", 1280, "Account"], ["club_admin", 390, "Login"], ["team_coach", 390, "Login"]]) {
  test(`(${role}, ${width} px) the login state is a badge; "${button}" holds the switch, disabling asks first`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, role, width);
    try {
      const sent = loginWrites(page);
      await openSection(page, "athletes");
      const row = anaRow(page);
      await row.waitFor();

      // The state is a badge, not a button; a tap on it sends nothing.
      const badge = row.locator(".athlete-login-status");
      assert.equal(await badge.evaluate((e) => e.tagName), "SPAN");
      assert.equal((await badge.textContent()).trim(), "Login active");
      await badge.click();
      await page.waitForTimeout(400);
      assert.deepEqual(sent, [], "a tap on the badge changes nothing");
      assert.equal(await row.locator('[data-action="organization-toggle-athlete-login"]').count(), 0, "no switch on the row");

      const sizes = await rowSizes(page);
      assert.equal(sizes.overflow, 0, "no horizontal overflow");
      for (const c of sizes.controls) assert.ok(c.h >= 44 && c.w >= 44, `${c.what}: ${c.w} x ${c.h}`);

      // The row's button opens the switch.
      await row.getByRole("button", { name: button, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      const disable = dialog.getByRole("button", { name: "Disable login", exact: true });
      await disable.waitFor();
      assert.ok((await disable.boundingBox()).height >= 44, "the switch is 44 px");

      // Declining the question sends nothing.
      page.once("dialog", (d) => d.dismiss());
      await disable.click();
      await page.waitForTimeout(500);
      assert.deepEqual(sent, [], "declining sends nothing");

      // Accepting disables the login; the dialog and the row say so.
      let asked = "";
      page.once("dialog", (d) => { asked = d.message(); d.accept(); });
      await disable.click();
      await dialog.getByText("Login disabled.").waitFor();
      assert.match(asked, /Disable Ana Example's login\?/);
      assert.deepEqual(sent, [{ active: false }]);
      await anaRow(page).locator(".athlete-login-status", { hasText: "Login disabled" }).waitFor();

      // Enabling does not ask.
      let askedAgain = false;
      page.once("dialog", (d) => { askedAgain = true; d.dismiss(); });
      await dialog.getByRole("button", { name: "Enable login", exact: true }).click();
      await dialog.getByText("Login enabled.").waitFor();
      assert.equal(askedAgain, false, "enabling does not ask");
      assert.deepEqual(sent, [{ active: false }, { active: true }]);
      await anaRow(page).locator(".athlete-login-status", { hasText: "Login active" }).waitFor();
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

for (const width of [1280, 390]) test(`(club_admin, ${width} px) a join link's label is one line and its actions are 44 px`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
  try {
    await openSection(page, "joinLinks");
    await page.locator('main.workspace [data-action="organization-toggle-add-form"]:visible').first().click();
    const form = page.locator("main.workspace form:visible").filter({ hasText: "Create join link" }).first();
    await form.locator("input").first().fill(`Demo tryouts ${width}`);
    await form.getByRole("button", { name: "Create join link" }).click();
    const row = page.locator("main.workspace .organization-join-link-row").filter({ hasText: `Demo tryouts ${width}` }).first();
    await row.waitFor();
    const out = await row.evaluate((r) => {
      const label = r.querySelector(".organization-row-main strong");
      const actions = r.querySelector(".organization-row-actions");
      const lb = label.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(label);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size;
      const ab = actions.getBoundingClientRect();
      return {
        labelLines: lines,
        labelWidth: Math.round(lb.width),
        labelBeside: lb.right <= ab.left + 1,
        labelAboveActions: lb.bottom <= ab.top + 1,
        buttons: [...actions.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().height)),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    assert.equal(out.labelLines, 1, `the label is one line, not wrapped letter by letter (${out.labelWidth} px wide)`);
    if (width <= 760) assert.ok(out.labelAboveActions, "on a phone the label's line is above the actions");
    else assert.ok(out.labelBeside, "on a computer the label is beside the actions");
    for (const h of out.buttons) assert.ok(h >= 44, `an action is ${h} px`);
    assert.equal(out.overflow, 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
