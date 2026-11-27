// Roles V-4 (docs/ai/roles-v-steps-plan.md section 2.5): an account that holds only a new-style role of Example Club with
// tests.view and tests.results.view, in the club's view workspace:
//  - Tests opens on Schedule; its sections are Schedule, Results and Test Library (no Today);
//  - no New check-in schedule; a schedule's detail has no Edit, Pause, Delete, Schedule again or group link;
//  - a result names no athlete (P-1: names need athletes.view: it says "Athlete") and offers no Schedule again;
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { WELLNESS_TEST_VERSION_ID } from "../../backend/src/testsScheduleWriter.js";
import { startWorld } from "../lib/world.mjs";
import { stageScheduleManageForTest } from "../../backend/tests/support/tests-schedule-manage-fixture.mjs";
import { launch, navTo, openAs, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
let scheduleId;
let athleteName = "";
const R = "/api/organization/roles";

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    await stageScheduleManageForTest(client);
    athleteName = (await client.query(`select display_name from public.athletes where id = $1`, [world.ids.athleteIds[0]])).rows[0].display_name;
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Viewer','Example','Viewer Example','Viewer Example',$2) returning id`,
      ["viewer.v4@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    world.accounts.push({ role: "role_holder", id, email: "viewer.v4@example.invalid", label: "Viewer Example", sessionToken: await createSession(id, client) });
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
  const athlete = await as("athlete");
  try {
    const made = await request(clubAdmin, world, "/api/tests/schedules", { method: "POST", body: {
      testVersionId: WELLNESS_TEST_VERSION_ID, scheduleKind: "one_time", timezone: "UTC", startDate: localDay(), opensTime: "00:00", closesTime: "23:59",
      targets: [{ kind: "athlete", id: world.ids.athleteIds[0] }] } });
    assert.equal(made.status, 201, made.text);
    scheduleId = JSON.parse(made.text).schedule.id;
    assert.equal((await request(clubAdmin, world, `/api/tests/schedules/${scheduleId}/link`, { method: "POST", body: {} })).status, 201);
    const today = JSON.parse((await request(athlete, world, "/api/tests/athlete/today")).text).assignments;
    const own = today.find((a) => a.assignmentId) || today[0];
    const submitted = await request(athlete, world, `/api/tests/assignments/${own.assignmentId}/submit`, { method: "POST",
      body: { values: { fatigue: 2, sleep: 4, soreness: 0, stress: 6, mood: 8, injury: false } } });
    assert.equal(submitted.status, 200, submitted.text);
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view", "tests.view", "tests.results.view"], name: "Club tests" } });
    assert.equal(role.status, 200, role.text);
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(admin, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId: JSON.parse(role.text).role.id, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await admin.close();
    await clubAdmin.close();
    await athlete.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = async (page, name) => { if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/${name}.png` }).catch(() => {}); };

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`(${label}) Tests in the view workspace: Schedule, Results and the Library, read only, no names`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      const detail = await request(context, world, `/api/tests/schedules/${scheduleId}`);
      assert.equal(detail.status, 200, detail.text);
      assert.ok(!Object.hasOwn(JSON.parse(detail.text), "link"));
      const denied = await request(context, world, `/api/tests/schedules/${scheduleId}/link`, { method: "POST", body: {} });
      assert.equal(denied.status, 403, denied.text);
      assert.deepEqual(JSON.parse(denied.text), { error: "Forbidden" });
      assert.deepEqual([...me.permissions].sort(), ["org.view", "tests.results.view", "tests.view"]);
      await navTo(page, '[data-library-tab="tests"]');
      await page.waitForSelector(".tests-section-tabs");
      assert.deepEqual(await page.$$eval(".tests-section-tabs [data-section]", (e) => e.map((x) => x.textContent.trim())), ["Schedule", "Results", "Test Library"]);
      await page.waitForSelector(`[data-action="tests-open-schedule"][data-schedule-id="${scheduleId}"]`, { timeout: 20_000 });
      assert.equal(await page.locator('[data-action="tests-open-schedule-form"]').count(), 0, "no New check-in schedule");
      await page.click(`[data-action="tests-open-schedule"][data-schedule-id="${scheduleId}"]`);
      await page.waitForSelector(".tests-schedule-detail.is-read-only");
      await shot(page, `v4-detail-${width}`);
      const detailText = await page.textContent(".tests-schedule-detail");
      assert.ok(!detailText.includes(athleteName), "no athlete name");
      assert.match(detailText, /1 athlete/);
      assert.equal(await page.locator('.tests-schedule-detail [data-action]:not([data-action="tests-close-schedule"])').count(), 0, "no action, no link");
      assert.equal(await page.locator(".tests-link-box, .tests-link-code").count(), 0);

      await page.click('[data-action="tests-section"][data-section="results"]');
      await page.waitForSelector(`[data-action="tests-weekly-open-results"][data-schedule-id="${scheduleId}"]`, { timeout: 20_000 });
      await page.click(`[data-action="tests-weekly-open-results"][data-schedule-id="${scheduleId}"]`);
      // One result on the day opens at once.
      await page.waitForSelector(".wellness-result");
      await shot(page, `v4-result-${width}`);
      const resultText = await page.textContent(".wellness-result");
      assert.ok(!resultText.includes(athleteName) && /Athlete/.test(resultText), "the result says Athlete, not the name");
      assert.equal(await page.locator('.wellness-result [data-action="tests-schedule-again"]').count(), 0, "no Schedule again");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
