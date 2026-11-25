// Settings add forms (design S3) in a real browser. A section's add action is a labelled button on its heading's row.
// The form opens under the heading in one column, with Cancel and the filled primary in its footer. Users is one panel
// with a tab per kind of form. Every control is 44 px, a field is 16 px on a phone, nothing overflows, and a form
// still saves.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request } from "../lib/browser.mjs";

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
        // R3 (owner decision Q3): "Give access" is ONE assignment form (data-roles-form="assign"); the two old fixed
        // forms (clubRole, teamRole) must not be shown there. The other tabs keep their data-organization-form.
        const panel = "main.workspace .organization-add-panel";
        for (const [tab, expected] of [["Give access", { roles: ["assign"], organization: [] }], ["Athlete login", { roles: [], organization: ["athleteLogin"] }], ["New account", { roles: [], organization: ["user"] }]]) {
          await page.getByRole("tab", { name: tab, exact: true }).click();
          const first = expected.roles.length ? `form[data-roles-form="${expected.roles[0]}"]` : `form[data-organization-form="${expected.organization[0]}"]`;
          await page.locator(`${panel} ${first}`).waitFor();
          const shown = await page.$$eval(`${panel} form`, (f) => f.filter((x) => x.getBoundingClientRect().width > 0).map((x) => ({ roles: x.dataset.rolesForm || null, organization: x.dataset.organizationForm || null })));
          assert.deepEqual(shown.filter((x) => x.roles).map((x) => x.roles), expected.roles, `${tab}: visible roles forms`);
          assert.deepEqual(shown.filter((x) => x.organization).map((x) => x.organization), expected.organization, `${tab}: visible organization forms`);
          assert.equal(shown.length, expected.roles.length + expected.organization.length, `${tab}: exactly these forms and no other`);
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
test("Manage account opens role assignment for that person at phone and desktop widths", async () => {
  for (const width of [360, 375, 390, 1280]) {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      if (width === 1280) {
        const created = await request(context, world, "/api/organization/roles", {
          method: "POST",
          body: { requestKey: randomUUID(), clubId: world.ids.clubA, name: "Match analyst", scopeTypes: ["club"], items: ["dashboards.view"] },
        });
        assert.ok([200, 201].includes(created.status), created.text);
      }
      await openSection(page, "users");
      await page.locator(".organization-user-row").filter({ hasText: "Coach Example" })
        .getByRole("button", { name: "Manage account", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Manage account" });
      const entry = dialog.getByRole("button", { name: "Give a role", exact: true });
      assert.ok((await entry.boundingBox()).height >= 43.5, `${width}: role action is a full-size touch target`);
      await entry.click();

      const form = dialog.locator('form[data-roles-form="assign"]');
      const where = form.locator('select[name="scope"]');
      await where.waitFor();
      assert.match(await dialog.getByRole("heading", { name: "Coach Example", exact: true }).textContent(), /Coach Example/);
      assert.equal(await page.locator('main.workspace form[data-roles-form="assign"]').count(), 1);
      const recipient = form.locator('input[name="userId"]');
      const userId = world.accounts.find((account) => account.role === "team_coach").id;
      assert.equal(await recipient.inputValue(), userId);
      assert.equal(await where.evaluate((node) => node === document.activeElement), true);
      assert.equal(await where.inputValue(), "", "a previous assignment location cannot carry over");
      await where.selectOption({ label: "Club: Example Club" });
      const roles = form.locator('select[name="roleId"]');
      await roles.locator("option").filter({ hasText: "Club admin" }).waitFor({ state: "attached" });
      assert.equal(await recipient.inputValue(), userId, "the selected person stays fixed after the roles load");
      assert.equal(await dialog.locator('input[type="password"]').count(), 0);
      assert.equal(await where.evaluate((node) => node === document.activeElement), true, "role loading keeps the keyboard focus");
      assert.equal((await measure(page, width)).overflow, 0);
      if (width === 1280) {
        await roles.selectOption({ label: "Match analyst" });
        await form.locator('textarea[name="reason"]').fill("Review team dashboards");
        await form.getByRole("button", { name: "Give role", exact: true }).click();
        await dialog.getByText("Coach Example now has Match analyst in Example Club.").waitFor();
        assert.equal(await recipient.inputValue(), userId);
        const stored = await request(context, world, `/api/organization/roles/assignments?clubId=${world.ids.clubA}&userId=${userId}`);
        assert.equal(stored.status, 200, stored.text);
        assert.ok(JSON.parse(stored.text).assignments.some((assignment) => assignment.roleName === "Match analyst"
          && assignment.userId === userId && assignment.scopeType === "club"
          && assignment.scopeId === world.ids.clubA && assignment.state === "active"));
      }

      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.locator(".organization-browser-head").getByRole("button", { name: "Add user", exact: true }).click();
      await page.getByRole("tab", { name: "Give access", exact: true }).click();
      const generalForm = page.locator('.organization-add-panel form[data-roles-form="assign"]');
      assert.equal(await generalForm.getByLabel("User").inputValue(), "", "the profile recipient does not leak into the general form");
      assert.equal(await generalForm.locator('select[name="scope"]').inputValue(), "", "the profile scope does not leak into the general form");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  }
});
