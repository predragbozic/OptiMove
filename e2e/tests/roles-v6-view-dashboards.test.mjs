// Roles V-6 (docs/ai/roles-v-steps-plan.md sections 2.7 and 13): an account that holds only a new-style role of Example
// Club with dashboards.view, in the club's view workspace:
//  - Training Load opens on Data & Analysis with the Dashboards view only (no Schedule, no Filter);
//  - the club's shared dashboard is listed and opens read only: no New dashboard, no Add widget, no Rename, Set as
//    active, Edit layout, Archive or Delete;
//  - a per-athlete widget reads "This widget shows each athlete's values, which you can't see here." (load.view.athlete is
//    not open in a view workspace yet), and no athlete's name appears anywhere;
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openTrainingLoad, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
let dashboardId;
let athleteNames = [];
const R = "/api/organization/roles";
const D = "/api/training-load/dashboards";
const NAME = "Example Club weekly board";

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    athleteNames = (await client.query(`select display_name from public.athletes where id = any($1::uuid[])`, [world.ids.athleteIds.slice(0, 3)])).rows.map((r) => r.display_name);
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Viewer','Example','Viewer Example','Viewer Example',$2) returning id`,
      ["viewer.v6@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    world.accounts.push({ role: "role_holder", id, email: "viewer.v6@example.invalid", label: "Viewer Example", sessionToken: await createSession(id, client) });
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
    const made = await request(clubAdmin, world, D, { method: "POST", body: { name: NAME, ownerScope: "club", ownerClubId: world.ids.clubA } });
    assert.equal(made.status, 201, made.text);
    let dashboard = JSON.parse(made.text).dashboard;
    dashboardId = dashboard.id;
    let order = 0;
    for (const [title, groupBy, series] of [
      ["Sessions this period", "cohort", { builtInSeriesKey: "session_count", dataScopeLevel: "day", analyticalAggregation: "sum" }],
      ["RPE per athlete", "athlete", { builtInSeriesKey: "rpe", dataScopeLevel: "session", analyticalAggregation: "avg" }],
    ]) {
      order += 1;
      dashboard = JSON.parse((await request(clubAdmin, world, `${D}/${dashboardId}`)).text).dashboard;
      const widget = await request(clubAdmin, world, `${D}/${dashboardId}/widgets`, { method: "POST", body: {
        expectedDashboardRevision: dashboard.revision, widgetType: "table", title, widgetOrder: order, x: 0, y: (order - 1) * 4, width: 6, height: 4, mobileOrder: order, groupBy } });
      assert.equal(widget.status, 201, widget.text);
      const added = await request(clubAdmin, world, `${D}/${dashboardId}/widgets/${JSON.parse(widget.text).widgetId}/series`, { method: "POST", body: { expectedWidgetRevision: 1, seriesOrder: 1, ...series } });
      assert.equal(added.status, 201, added.text);
    }
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view", "dashboards.view"], name: "Club dashboards" } });
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
const WRITES = /new-dashboard|clone-template|add-widget|rename-dashboard|set-active|toggle-edit|archive|delete-dashboard|widget-menu|save-layout/;

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`(${label}) Dashboards in the view workspace: the club's board, read only, team totals only`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      assert.deepEqual([...me.permissions].sort(), ["dashboards.view", "org.view"]);
      await openTrainingLoad(page);
      assert.deepEqual(await page.$$eval(".training-load-tab", (e) => e.map((x) => x.textContent.trim())), ["Data & Analysis"]);
      assert.deepEqual(await page.$$eval(".training-load-subnav-tab", (e) => e.map((x) => x.textContent.trim())), ["Dashboards"]);
      assert.equal(await page.locator('[data-action="training-load-filter-open"]').count(), 0, "no Filter");
      await page.locator('[data-action="training-load-analysis-open-picker"]').first().click();
      await page.locator(`[data-dashboard-id="${dashboardId}"]`).first().click();
      await page.getByText("This widget shows each athlete's values, which you can't see here.").first().waitFor({ timeout: 20_000 });
      await page.locator('[data-action="training-load-analysis-open-menu"][data-menu="dashboard"]').click();
      await page.waitForTimeout(300);
      if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/v6-dashboard-${width}.png`, fullPage: true }).catch(() => {});
      const writes = await page.$$eval(".tl-analysis [data-action]", (els) => els.map((e) => e.dataset.action));
      assert.deepEqual(writes.filter((a) => WRITES.test(a)), [], `no write control (${writes.filter((a) => WRITES.test(a)).join(", ")})`);
      const text = await page.locator(".tl-analysis").first().textContent();
      assert.ok(text.includes(NAME), "the club's board");
      for (const name of athleteNames) assert.ok(!text.includes(name), `no athlete name (${name})`);
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
