// Roles R4-4, PR A (docs/ai/roles-r4-4-screens-contract.md 4.3, 5.1; roles-r4-contract.md 14, test 11):
//  - a platform administrator takes Imports out of a club's licence in Settings > Clubs and sees it saved;
//  - an account that holds only a new-style role of that club lands in the view workspace and sees Settings with
//    Overview, Clubs and Teams and nothing else, a short Home, and no module in the menu or on the phone's bar;
//  - no horizontal scroll and 44 px controls at 360, 375 and 390 px.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const R = "/api/organization/roles";

before(async () => {
  world = await startWorld();
  browser = await launch();
  // The role holder: an account with no old role row, given a club role of Example Club that holds org.view.
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Viewer','Example','Viewer Example','Viewer Example',$2) returning id`,
      ["viewer@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    const sessionToken = await createSession(id, client);
    world.accounts.push({ role: "role_holder", id, email: "viewer@example.invalid", label: "Viewer Example", sessionToken });
    // A notification is the person's, not the workspace's: one that opens a module (Program Library's requests).
    await client.query(`insert into public.app_notifications (recipient_user_id, type, title, body, entity_type, entity_id, href, metadata)
      values ($1, 'program_access_requested', 'Program access request', 'Someone requested a program.', 'program_access', gen_random_uuid(), '/app?tab=templates&section=requests', '{}'::jsonb)`, [id]);
  } finally {
    await client.end();
  }
  const admin = await browser.newContext();
  await admin.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === "platform_admin").sessionToken, url: world.baseUrl }]);
  try {
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view"], name: "Club viewer" } });
    assert.equal(role.status, 200, role.text);
    const roleId = JSON.parse(role.text).role.id;
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(admin, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await admin.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

async function noSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
// Every visible button, checkbox label and summary inside `selector` at least 44 px tall (a checkbox counts by its label).
async function smallTargets(page, selector) {
  return page.$$eval(`${selector} button, ${selector} label.club-licence-switch, ${selector} summary`, (els) => els
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ text: el.textContent.trim().slice(0, 40), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h < 43.5));
}

test("1. a platform administrator takes Imports out of Example Club's licence (1280 px)", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", WIDTHS.desktop);
  try {
    await openSettings(page);
    await page.click('[data-action="organization-section"][data-section="clubs"]');
    await page.click(`[data-action="organization-select-club"][data-club-id="${world.ids.clubA}"]`);
    const licence = page.locator("[data-club-licence]");
    await licence.waitFor();
    await licence.getByRole("button", { name: "Show" }).click();
    await licence.locator('[data-licence-module="imports"]').waitFor();
    assert.equal(await licence.locator('[data-licence-module="organization"]').isDisabled(), true, "Organization is always included");
    await licence.locator('[data-licence-module="imports"]').uncheck();
    await licence.getByText("Take out: Imports.").waitFor();
    await licence.locator("textarea").fill("No import licence this season");
    await licence.getByRole("button", { name: /Save licence/ }).click();
    await licence.getByText("Licence saved – taken out: Imports.").waitFor();
    assert.equal(await licence.locator('[data-licence-module="imports"]').isChecked(), false);
    const read = await request(context, world, `${R}/clubs/${world.ids.clubA}/ceiling`);
    const imports = JSON.parse(read.text).modules.find((m) => m.module === "imports");
    assert.equal(imports.closed, true, "the server holds it");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

for (const width of [360, 375, 390]) {
  test(`2. (${width} px) the licence fits the phone: no side scroll, 44 px targets`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", width);
    try {
      await openSettings(page);
      await page.click('[data-action="organization-section"][data-section="clubs"]');
      await page.click(`[data-action="organization-select-club"][data-club-id="${world.ids.clubA}"]`);
      const licence = page.locator("[data-club-licence]");
      await licence.waitFor();
      await licence.getByRole("button", { name: "Show" }).click();
      await licence.locator('[data-licence-module="calendar"]').uncheck();
      await licence.locator("textarea").waitFor();
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(await smallTargets(page, "[data-club-licence]"), [], "every control 44 px");
      const font = await licence.locator("textarea").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      assert.ok(font >= 16, `textarea ${font}px`);
      const widths = await licence.locator("textarea").evaluate((el) => ({ field: el.getBoundingClientRect().width, card: el.closest("[data-club-licence]").getBoundingClientRect().width }));
      assert.ok(widths.field >= widths.card * 0.8, `the reason field spans the card (${widths.field} of ${widths.card})`);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`3. (${label}) a role holder lands in the club's view workspace: Settings is Overview, Clubs and Teams only`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text);
      assert.equal(me.user.activeWorkspace.type, "club_view");
      // Home: the club's name and the sections it may open; no coach card.
      await page.waitForSelector(".coach-home-view");
      assert.equal((await page.textContent(".coach-home-view h2")).trim(), "Example Club");
      assert.deepEqual(await page.$$eval('[data-action="view-home-open-settings"]', (e) => e.map((x) => x.dataset.section)), ["overview", "clubs", "teams"]);
      assert.equal(await page.locator(".coach-home-grid").count(), 0);
      assert.deepEqual(await page.$$eval(".coach-home-view-section", (e) => e.filter((x) => x.getBoundingClientRect().height < 43.5).map((x) => x.textContent.trim())), [], "Home's buttons are 44 px");
      // The menu (computer) or the bar and its More sheet (phone) offer no module.
      const offered = width > 760
        ? await page.$$eval(".sidebar .rail-button", (e) => e.filter((x) => !(x.hidden || x.closest("[hidden]"))).map((x) => x.getAttribute("title") || x.textContent.trim()))
        : await (async () => {
          await page.waitForSelector(".om-bottom-nav [data-nav-id]");
          return page.$$eval(".om-bottom-nav [data-nav-id]", (e) => e.map((x) => x.dataset.navId));
        })();
      for (const word of ["Builder", "Training load", "Tests", "Exercise Library", "Program Library", "Coaches", "Calendar", "Athletes", "builder", "training-load", "tests", "central-calendar", "athletes"]) {
        assert.ok(!offered.includes(word), `${word} is not offered (${offered.join(", ")})`);
      }
      await page.click('[data-action="view-home-open-settings"][data-section="overview"]');
      await page.waitForSelector(".settings-tabs");
      assert.deepEqual(await page.$$eval(".settings-tabs button", (e) => e.map((x) => x.textContent.trim())), ["Overview", "Clubs", "Teams"]);
      await page.click('[data-action="organization-section"][data-section="clubs"]');
      await page.waitForSelector('[data-action="organization-select-club"]');
      assert.equal(await page.locator('[data-action="organization-edit"], [data-action="organization-delete"]').count(), 0, "no Edit or Delete");
      // A chosen club: its teams, and nothing that writes (the server sends no athlete, no archived team, no add right).
      await page.click('[data-action="organization-select-club"]');
      await page.waitForSelector(".organization-lists-browser");
      const writes = await page.$$eval("#content [data-action]", (els) => els.map((e) => e.dataset.action)
        .filter((a) => !/^organization-(section|select-club|select-team|clear-selection)$/.test(a)));
      assert.deepEqual(writes, [], `only reading controls under a chosen club (${writes.join(", ")})`);
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("5. a notification that opens a module takes a role holder to Home, never into the module", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "role_holder", WIDTHS.desktop);
  try {
    await page.locator("#notificationToggle").click();
    // Home is drawn again after the click: the old Home is marked so the new one is told apart.
    await page.evaluate(() => document.querySelector(".coach-home-view")?.setAttribute("data-before-click", "1"));
    await page.locator('[data-action="notification-open-program-requests"]').first().click();
    await page.waitForFunction(() => {
      const home = document.querySelector("#content .coach-home-view");
      const title = document.querySelector("#screenTitle")?.textContent || "";
      return (home && !home.hasAttribute("data-before-click")) || /Program/i.test(title);
    }, null, { timeout: 15_000 });
    assert.equal((await page.textContent("#screenTitle")).trim(), "Home", "the screen is Home, not a module");
    assert.equal(await page.locator("#content .coach-home-view").count(), 1, "the short Home is drawn");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("4. the role holder's workspace switcher names the club as a view workspace; Settings opens from the menu", async () => {
  const { context, page } = await openAs(browser, world, "role_holder", WIDTHS.desktop);
  try {
    assert.equal(await page.locator("#workspaceToggle").getAttribute("title"), "Club · Example Club (view)");
    await navTo(page, '.sidebar .sidebar-nav-button[data-library-tab="organization"]');
    await page.waitForSelector(".settings-tabs");
    assert.deepEqual(await page.$$eval(".settings-tabs button", (e) => e.map((x) => x.textContent.trim())), ["Overview", "Clubs", "Teams"]);
  } finally {
    await context.close();
  }
});
