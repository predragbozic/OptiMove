// Roles V-2 (docs/ai/roles-v-steps-plan.md sections 2.3 and 9): an account that holds only a new-style role of Example
// Club with org.view and athletes.view, in the club's view workspace:
//  - /me offers athletes.view; Home and Settings add Athletes;
//  - the sidebar's athlete list shows the club's 12 athletes as plain rows (no button, no plan counts);
//  - Settings -> Athletes lists them read only (no Add, Edit, Archive, Invite, login or access control);
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const R = "/api/organization/roles";

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Scout','Example','Scout Example','Scout Example',$2) returning id`,
      ["scout.v2@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    world.accounts.push({ role: "role_holder", id, email: "scout.v2@example.invalid", label: "Scout Example", sessionToken: await createSession(id, client) });
  } finally {
    await client.end();
  }
  const admin = await browser.newContext();
  await admin.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === "platform_admin").sessionToken, url: world.baseUrl }]);
  try {
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view", "athletes.view"], name: "Club scout" } });
    assert.equal(role.status, 200, role.text);
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(admin, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId: JSON.parse(role.text).role.id, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await admin.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const WRITE_CONTROLS = '[data-action="organization-edit"], [data-action="organization-invite-athlete"], [data-action^="organization-archive"], [data-action="organization-toggle-athlete-access"], [data-action="organization-toggle-archived-athletes"], [data-action="organization-toggle-add-form"], [data-action="organization-athlete-login-open"], [data-action="organization-athlete-account-open"]';

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`1. (${label}) the club's athletes, read only: the sidebar list, Home and Settings -> Athletes`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      assert.deepEqual([...me.permissions].sort(), ["athletes.view", "org.view"]);
      const list = JSON.parse((await request(context, world, "/api/athletes")).text).adminRows;
      assert.equal(list.length, 12, "the club's 12 athletes");
      assert.ok(list.every((r) => r.weekly_plan_count === null && r.program_count === null), "no plan counts");

      await page.waitForSelector(".coach-home-view");
      assert.deepEqual(await page.$$eval('[data-action="view-home-open-settings"]', (e) => e.map((x) => x.textContent.trim())), ["Overview", "Clubs", "Teams", "Athletes"]);
      await page.waitForFunction(() => document.querySelectorAll("#athleteList .athlete-button-readonly").length === 12);
      assert.equal(await page.locator("#athleteList button.athlete-button").count(), 0, "the sidebar list has no button");
      assert.doesNotMatch(await page.textContent("#athleteList"), /weekly|specific/, "no plan counts in the sidebar");

      const tabs = await openSettings(page);
      assert.deepEqual(tabs, ["Overview", "Clubs", "Teams", "Athletes"]);
      await page.click('[data-action="organization-section"][data-section="athletes"]');
      await page.waitForSelector(".organization-view-athletes");
      await page.locator(".organization-view-athletes").getByText("Kira Example").first().waitFor();
      assert.equal(await page.locator(".organization-view-athletes .organization-row").count(), 12);
      assert.equal(await page.locator(WRITE_CONTROLS).count(), 0, "no write control");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
