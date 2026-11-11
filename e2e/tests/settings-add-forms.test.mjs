// Settings add forms (design S3) in a real browser. A section's add action is a labelled button on its heading's row.
// The form opens under the heading in one column, with Cancel and the filled primary in its footer. Users is one panel
// with a tab per kind of form. Every control is 44 px, a field is 16 px on a phone, nothing overflows, and a form
// still saves.
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
  await page.locator("main.workspace h2.organization-section-title").first().waitFor();
}

async function measure(page, width) {
  return page.evaluate((w) => {
    const v = document.querySelector("main.workspace .organization-view");
    const shown = (e) => e.getBoundingClientRect().width > 0;
    const ctrls = [...v.querySelectorAll(".organization-browser-head button, .organization-add-panel button, .organization-add-panel input:not([type=hidden]), .organization-add-panel select")].filter(shown);
    return {
      small: ctrls.filter((c) => c.getBoundingClientRect().height < 43.5).map((c) => c.textContent.trim() || c.name),
      font: w < 600 ? [...v.querySelectorAll(".organization-add-panel input:not([type=hidden]), .organization-add-panel select")].filter(shown).filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map((i) => i.name) : [],
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      toggleInHead: Boolean(v.querySelector(".organization-browser-head .organization-browser-actions .organization-add-toggle")),
    };
  }, width);
}

for (const [role, width] of [["platform_admin", 1280], ["club_admin", 390]]) test(`(${role}, ${width} px) the add button is labelled, the form has Cancel and a filled primary, Users has tabs`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, role, width);
  try {
    const sections = role === "platform_admin" ? [["clubs", "Add club", "Add club"], ["teams", "Add team", "Add team"], ["athletes", "Add athlete", "Add athlete"], ["users", "Add user", "Add user"]] : [["teams", "Add team", "Add team"], ["athletes", "Add athlete", "Add athlete"], ["users", "Add user", "Add user"], ["joinLinks", "Create join link", "Create join link"]];
    for (const [section, label, submit] of sections) {
      await openSection(page, section);
      const add = page.locator("main.workspace .organization-browser-head").getByRole("button", { name: label, exact: true });
      await add.click();
      const form = page.locator("main.workspace .organization-add-panel form:visible").first();
      await form.waitFor();
      assert.equal(await form.locator('button[type="submit"]').evaluate((b) => getComputedStyle(b).backgroundColor !== "rgba(0, 0, 0, 0)" && getComputedStyle(b).color === "rgb(255, 255, 255)"), true, `${section}: the submit is the filled primary`);
      assert.equal((await form.locator('button[type="submit"]').textContent()).trim(), submit);
      const m = await measure(page, width);
      assert.ok(m.toggleInHead, `${section}: the add button is on the heading's row`);
      assert.deepEqual(m.small, [], `${section}: 44 px`);
      assert.deepEqual(m.font, [], `${section}: 16 px fields on a phone`);
      assert.equal(m.overflow, 0, section);
      if (section === "users") {
        // What was typed in one tab is kept after visiting another.
        await page.locator('main.workspace form[data-organization-form="user"] input[name="email"]').fill("new.coach@example.invalid");
        for (const [tab, forms] of [["Give access", ["clubRole", "teamRole"]], ["Athlete login", ["athleteLogin"]], ["New account", ["user"]]]) {
          await page.getByRole("tab", { name: tab, exact: true }).click();
          await page.locator(`main.workspace form[data-organization-form="${forms[0]}"]`).waitFor();
          const shown = await page.$$eval("main.workspace .organization-add-panel form[data-organization-form]", (f) => f.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.dataset.organizationForm));
          assert.deepEqual(shown, forms, tab);
          assert.deepEqual((await measure(page, width)).small, [], `${tab}: 44 px`);
        }
        assert.equal(await page.locator('main.workspace form[data-organization-form="user"] input[name="email"]').inputValue(), "new.coach@example.invalid");
      }
      // Cancel closes the form.
      await page.locator("main.workspace .organization-add-panel").getByRole("button", { name: "Cancel", exact: true }).first().click();
      await page.locator("main.workspace .organization-add-panel").waitFor({ state: "detached" });
    }
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(club_admin, 390 px) a team saves through the new form and appears in the list", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", 390);
  try {
    await openSection(page, "teams");
    await page.locator("main.workspace .organization-browser-head").getByRole("button", { name: "Add team", exact: true }).click();
    const form = page.locator('main.workspace form[data-organization-form="team"]');
    await form.locator('input[placeholder="Type club name"]').fill("Example Club");
    await page.locator(".organization-select-option, [role=option]").filter({ hasText: "Example Club" }).first().click().catch(() => {});
    await form.locator('input[name="name"]').fill("Demo U17");
    await form.getByRole("button", { name: "Add team", exact: true }).click();
    await page.locator('main.workspace [data-action="organization-select-team"]').filter({ hasText: "Demo U17" }).waitFor();
    assert.equal(await page.locator("main.workspace .organization-add-panel").count(), 0, "the form closes after a save");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
