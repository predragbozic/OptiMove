// Roles V-1 (docs/ai/roles-v-steps-plan.md sections 2.1 and 2.2): an account that holds only a new-style role of Example
// Club with variables.view and presets.use, in the club's view workspace:
//  - Training Load opens on Data configuration only (no Schedule, Data & Analysis or Filter); the start screen shows
//    Variables, Domains and Categories (no Source fields, Mappings or the board); the Variables list and a variable read
//    only (no New variable, no action);
//  - Settings adds Tags & Presets, read only (no Add, no remove, no positions, no new session type);
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, openTrainingLoad, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const R = "/api/organization/roles";
const M = "/api/training-load/sources/metrics";

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Viewer','Example','Viewer Example','Viewer Example',$2) returning id`,
      ["viewer.v1@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    world.accounts.push({ role: "role_holder", id, email: "viewer.v1@example.invalid", label: "Viewer Example", sessionToken: await createSession(id, client) });
  } finally {
    await client.end();
  }
  const as = async (role) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === role).sessionToken, url: world.baseUrl }]);
    return ctx;
  };
  const admin = await as("platform_admin");
  const clubAdmin = await as("club_admin");
  try {
    // The club's own variable and preset, made by its admin in the club's workspace.
    const v = await request(clubAdmin, world, `${M}/variables`, { method: "POST", body: { requestKey: crypto.randomUUID(), label: "Sprint distance", unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum" } });
    assert.equal(v.status, 201, v.text);
    world.ids.clubVariable = JSON.parse(v.text).variable.id;
    const p = await request(clubAdmin, world, "/api/taxonomy/node-presets", { method: "POST", body: { nodeType: "domain", name: "Speed block", scope: "club", clubId: world.ids.clubA } });
    assert.equal(p.status, 201, p.text);
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view", "variables.view", "presets.use"], name: "Club analyst" } });
    assert.equal(role.status, 200, role.text);
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(admin, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId: JSON.parse(role.text).role.id, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await admin.close();
    await clubAdmin.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`1. (${label}) Training Load in the view workspace: Data configuration only, read only`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      assert.deepEqual([...me.permissions].sort(), ["org.view", "presets.use", "variables.view"]);
      await openTrainingLoad(page);
      await page.waitForSelector(".dc-home-grid");
      assert.deepEqual(await page.$$eval(".training-load-tab", (e) => e.map((x) => x.textContent.trim())), ["Data configuration"]);
      assert.equal(await page.locator('[data-action="training-load-filter-open"]').count(), 0, "no Filter");
      const cards = await page.$$eval(".dc-card-title strong", (e) => e.map((x) => x.textContent.trim()));
      assert.deepEqual(cards, ["Variables", "Domains", "Categories"], "no Source fields, Mappings or the board");
      await page.click('.dc-card-open[data-view="variables"]');
      await page.waitForSelector(".metric-variables-list");
      assert.equal(await page.locator('[data-action="metric-variables-create-open"]').count(), 0, "no New variable");
      assert.match(await page.textContent(".metric-variables"), /You can look at them here/);
      await page.click(`[data-action="metric-variables-open"][data-variable-id="${world.ids.clubVariable}"]`);
      await page.waitForSelector('[data-action="metric-variables-back"]');
      await page.locator(".metric-variables").getByText("Sprint distance").first().waitFor();
      const writes = await page.$$eval(".metric-variables [data-action]", (els) => els.map((e) => e.dataset.action)
        .filter((a) => /rename|archive|restore|icon|version|create|copy|hide|show|use|move/.test(a) && a !== "metric-variables-back"));
      assert.deepEqual(writes, [], `no write control on the variable (${writes.join(", ")})`);
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });

  test(`2. (${label}) Home and Settings add Tags & Presets, read only`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      await page.waitForSelector(".coach-home-view");
      assert.deepEqual(await page.$$eval('[data-action="view-home-open-settings"]', (e) => e.map((x) => x.textContent.trim())), ["Overview", "Clubs", "Teams", "Tags & Presets"]);
      const tabs = await openSettings(page);
      assert.deepEqual(tabs, ["Overview", "Clubs", "Teams", "Tags & Presets"]);
      await page.click('[data-action="organization-section"][data-section="presets"]');
      await page.waitForSelector(".taxonomy-panel.is-read-only");
      await page.waitForSelector(".session-types-settings .session-types-list");
      assert.match(await page.textContent(".taxonomy-panel"), /Speed block/, "the club's preset");
      assert.equal(await page.locator('[data-action="taxonomy-toggle-add"], [data-action="taxonomy-remove"]').count(), 0, "no Add, no remove");
      assert.equal(await page.locator(".positions-section").count(), 0, "no positions");
      assert.equal(await page.locator('[data-session-types-form="add"], [data-action="session-types-rename"], [data-action="session-types-archive"]').count(), 0, "no session type write");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
