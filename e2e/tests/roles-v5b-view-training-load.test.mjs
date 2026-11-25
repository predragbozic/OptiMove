import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openTrainingLoad, request } from "../lib/browser.mjs";

let world, browser;
const scheduleName = "Recovery practice";
const schedulePath = "/api/training-load/external-schedules";
const rolePath = "/api/organization/roles";

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  let viewerId;
  try {
    viewerId = (await client.query(`insert into public.users (email,first_name,last_name,full_name,display_name,password_hash)
      values ('v5b-viewer@example.invalid','Load','Viewer','Load Viewer','Load Viewer',$1) returning id`,
    [hashPassword(`Demo-${crypto.randomUUID()}`)] )).rows[0].id;
    world.accounts.push({ role: "load_viewer", id: viewerId, sessionToken: await createSession(viewerId, client) });
  } finally {
    await client.end();
  }

  const admin = await browser.newContext();
  try {
    const account = world.accounts.find(person => person.role === "club_admin");
    await admin.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
    const created = await request(admin, world, rolePath, { method: "POST", body: {
      requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"],
      items: ["org.view", "load.view.team"], name: "Training Load totals",
    } });
    assert.equal(created.status, 200, created.text);
    const assigned = await request(admin, world, rolePath + "/assignments", { method: "POST", body: {
      requestKey: crypto.randomUUID(), reason: "View schedules", userId: viewerId, roleId: JSON.parse(created.text).role.id,
      scopeType: "club", scopeId: world.ids.clubA,
    } });
    assert.equal(assigned.status, 200, assigned.text);
    const scheduled = await request(admin, world, schedulePath, { method: "POST", body: {
      eventName: scheduleName, timezone: "UTC", scheduleKind: "one_time", startDate: "2026-12-01",
      opensTime: "09:00", closesTime: "17:00", targets: [{ kind: "club", id: world.ids.clubA }],
    } });
    assert.equal(scheduled.status, 201, scheduled.text);
  } finally {
    await admin.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

for (const width of [1280, 390, 360]) {
  test(`(${width}px) the Training Load totals role sees Calendar and read-only external schedules`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "load_viewer", width);
    try {
      await openTrainingLoad(page);
      const tabs = page.locator(".training-load-tab");
      assert.deepEqual(await tabs.allTextContents(), ["External schedules", "Data & Analysis"]);
      assert.deepEqual(await page.locator(".training-load-subnav-tab").allTextContents(), ["Calendar"]);
      await tabs.filter({ hasText: "External schedules" }).click();
      const section = page.locator("[data-training-load-view-schedules]");
      await section.getByText(scheduleName).waitFor();
      assert.equal(await section.getByText("01.12.2026").count(), 1);
      assert.equal(await section.getByRole("button").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
      assert.deepEqual(pageErrors, []);
      await tabs.filter({ hasText: "Data & Analysis" }).click();
      await page.locator(".tl-calendar").waitFor();
      assert.equal(await section.count(), 0);
    } finally {
      await context.close();
    }
  });
}
