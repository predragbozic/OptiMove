// Settings dialogs (design S4) in a real browser. Manage account, Athlete account, Invite and Edit share one frame: the
// head (title and a 44 px close icon) stays in view while the body scrolls, and a saving dialog's footer (Cancel and
// the filled primary) stays at the bottom. Nothing overflows, every control is 44 px, a field is 16 px on a phone, Cancel
// closes, and Save changes still saves.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openSection(page, section) {
  await page.goto(world.baseUrl);
  await page.getByText("Sign out").first().waitFor();
  await openSettings(page);
  await page.locator(`.settings-tabs [data-section="${section}"]`).first().click();
  await page.locator("main.workspace h2.organization-section-title").first().waitFor();
}

// The open dialog, scrolled to its end: where the head and the footer are, and the sizes.
const frame = (page, width) => page.evaluate((w) => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((e) => e.getBoundingClientRect().width > 0);
  const db = () => d.getBoundingClientRect();
  // At the start, the saving footer (Edit athlete: its profile's) is at the dialog's bottom edge.
  d.scrollTop = 0;
  const footer = [...d.querySelectorAll(".organization-dialog-footer")].map((f) => f.getBoundingClientRect()).find((b) => b.bottom <= db().bottom + 1 && b.top >= db().top);
  const footerAtBottom = footer ? Math.round(db().bottom - footer.bottom) : null;
  // At the end, the head is still in view.
  d.scrollTop = d.scrollHeight;
  const head = d.querySelector(".organization-dialog-head").getBoundingClientRect();
  const close = d.querySelector(".organization-dialog-close").getBoundingClientRect();
  const shown = (e) => e.getBoundingClientRect().width > 0;
  const ctrls = [...d.querySelectorAll("button, input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select")].filter(shown);
  return {
    scrolls: d.scrollHeight > d.clientHeight + 2,
    headInView: head.top >= db().top - 1 && head.top <= db().top + 2,
    close: [Math.round(close.width), Math.round(close.height)],
    footerAtBottom,
    small: ctrls.filter((c) => c.getBoundingClientRect().height < 43.5).map((c) => (c.textContent || c.name).trim().slice(0, 30)),
    font: w < 600 ? [...d.querySelectorAll("input:not([type=hidden]):not([type=checkbox]), select")].filter(shown).filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map((i) => i.name) : [],
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
}, width);

for (const [role, width] of [["platform_admin", 1280], ["club_admin", 390]]) test(`(${role}, ${width} px) every Settings dialog keeps its head in view; a saving dialog's footer stays at the bottom`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, role, width);
  try {
    const dialogs = [
      ["users", "Manage account", 'main.workspace [data-action="organization-manage-account-open"]', false],
      ["athletes", "Edit athlete", 'main.workspace .organization-row [data-action="organization-edit"]', true],
      ["teams", "Edit team", 'main.workspace [data-action="organization-edit"][data-org-type="team"]', true],
      ["athletes", "Invite", 'main.workspace [data-action="organization-invite-athlete"]', false],
      ["athletes", role === "platform_admin" ? "Athlete account" : "Athlete login", 'main.workspace [data-action="organization-athlete-account-open"], main.workspace [data-action="organization-athlete-login-open"]', false],
    ];
    for (const [section, name, opener, saves] of dialogs) {
      await openSection(page, section);
      await page.locator(opener).first().click();
      await page.locator(".organization-dialog-head").first().waitFor();
      await page.waitForTimeout(300);
      const f = await frame(page, width);
      assert.ok(f.headInView, `${name}: the head stays in view${f.scrolls ? " after scrolling" : ""}`);
      assert.deepEqual(f.close, [44, 44], `${name}: the close icon is 44 px`);
      // Edit club and team: the footer is at the dialog's bottom edge. Edit athlete: its profile's footer is in view
      // (at the bottom while the profile is taller than the dialog, under the profile when it is not).
      if (saves) assert.ok(f.footerAtBottom !== null && (name === "Edit athlete" || f.footerAtBottom <= 2), `${name}: the footer is in view at the bottom (${f.footerAtBottom})`);
      assert.deepEqual(f.small, [], `${name}: 44 px`);
      assert.deepEqual(f.font, [], `${name}: 16 px fields on a phone`);
      assert.equal(f.overflow, 0, name);
      // Cancel closes a saving dialog; the close icon closes the others.
      const dialog = page.locator('[role="dialog"]');
      if (saves) await dialog.locator(".organization-dialog-footer").getByRole("button", { name: "Cancel", exact: true }).first().click();
      else await dialog.locator(".organization-dialog-close").click();
      await page.locator(".organization-dialog-head").waitFor({ state: "detached" });
    }
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(club_admin, 390 px) Edit team saves from the footer, and Manage account shows the login switch last", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", 390);
  try {
    await openSection(page, "teams");
    await page.locator('main.workspace [data-action="organization-edit"][data-org-type="team"]').first().click();
    const form = page.locator('[role="dialog"] form[data-organization-form="edit-team"]');
    const name = form.locator('input[name="name"]');
    const before = await name.inputValue();
    await name.fill(`${before} S4`);
    await page.locator('[role="dialog"] .organization-dialog-footer').getByRole("button", { name: "Save changes", exact: true }).click();
    await page.locator('main.workspace [data-action="organization-select-team"]').filter({ hasText: `${before} S4` }).waitFor();
    await page.locator(".organization-dialog-head").waitFor({ state: "detached" });

    await openSection(page, "users");
    await page.locator('main.workspace [data-action="organization-manage-account-open"]').first().click();
    const titles = await page.$$eval('[role="dialog"] .manage-account-section > .eyebrow', (e) => e.map((x) => x.textContent.trim()));
    assert.equal(titles.at(-1), "Account status", titles.join(", "));
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
