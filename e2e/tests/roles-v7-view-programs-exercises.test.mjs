// Roles V-7 (docs/ai/roles-v-steps-plan.md, "V-7 design"): an account that holds only a new-style role of Example Club
// with org.view, athletes.view, programs.view and exercises.use, in the club's view workspace:
//  - /me offers the four words; the menu offers the Program Library and the Exercise Library, never the Builder;
//  - the Program Library lists the public template only (no "My Programs", no Requests), and its preview is read only;
//  - an athlete of the club opens its Specific programs: the published program, never the draft, with no Edit or Copy;
//  - the Exercise Library lists the system exercise only, with no Add, Edit, Copy, favourite or hide control;
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const R = "/api/organization/roles";
const ids = {};

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
    const viewer = await one(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Scout','Example','Scout Example','Scout Example',$2) returning id`,
      ["scout.v7@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)]);
    world.accounts.push({ role: "role_holder", id: viewer.id, email: "scout.v7@example.invalid", label: "Scout Example", sessionToken: await createSession(viewer.id, client) });
    const admin = world.accounts.find((a) => a.role === "club_admin") || world.accounts.find((a) => a.role === "platform_admin");
    const athlete = await one(`select a.id from public.athletes a join public.athlete_memberships m on m.athlete_id = a.id
      where m.club_id = $1 and m.membership_type = 'club' and m.status = 'active' and a.athlete_id = '1' limit 1`, [world.ids.clubA]);
    assert.ok(athlete, "the seed's athlete 1 of the club");
    ids.athlete = athlete.id;
    const program = async (name, status) => (await one(`insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, is_template, is_active, status)
      values ('program', $1, $2, $3, false, true, $4) returning id`, [admin.id, athlete.id, name, status])).id;
    ids.published = await program("Vseven Strength Block", "active");
    ids.draft = await program("Vseven Hidden Draft", "draft");
    ids.template = (await one(`insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, status, is_active, is_free)
      values ('program', $1, 'Vseven Public Template', true, 'optimove', 'public', 'active', true, true) returning id`, [admin.id])).id;
    ids.privateTemplate = (await one(`insert into plans.plans (plan_type, created_by_user_id, name, is_template, library_scope, visibility, status, is_active)
      values ('program', $1, 'Vseven Private Template', true, 'my', 'private', 'active', true) returning id`, [admin.id])).id;
    ids.exercise = (await one(`insert into library.exercises (name, owner_scope, is_active, exercise_code) values ('Vseven System Squat', 'system', true, 'V7-001') returning id`)).id;
    ids.ownExercise = (await one(`insert into library.exercises (name, owner_scope, owner_user_id, is_active) values ('Vseven Own Drill', 'user', $1, true) returning id`, [admin.id])).id;
  } finally {
    await client.end();
  }
  const pa = await browser.newContext();
  await pa.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === "platform_admin").sessionToken, url: world.baseUrl }]);
  try {
    const role = await request(pa, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"],
      items: ["org.view", "athletes.view", "programs.view", "exercises.use"], name: "Club program scout" } });
    assert.equal(role.status, 200, role.text);
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(pa, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId: JSON.parse(role.text).role.id, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await pa.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const WRITES = [
  '[data-action="template-assign"]', '[data-action="template-settings-toggle"]', '[data-action="template-use"]',
  '[data-action="builder-edit-plan"]', '[data-action="builder-duplicate-plan"]', '[data-action="builder-delete-source-plan"]',
  '[data-action="weekly-create-plan"]', '[data-action="exercise-add-open"]', '[data-action="exercise-edit-open"]',
  '[data-action="exercise-copy-open"]', '[data-action="exercise-toggle-favorite"]', '[data-action="exercise-hide"]',
  '[data-action="exercise-blocks-open"]', '[data-action="exercise-tags"]',
].join(", ");
const visibleWrites = (page) => page.locator(WRITES).evaluateAll((els) => els.filter((e) => e.offsetParent !== null).map((e) => e.dataset.action));

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`1. (${label}) the Program Library, an athlete's programs and the Exercise Library, read only; never the Builder`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      assert.deepEqual([...me.permissions].sort(), ["athletes.view", "exercises.use", "org.view", "programs.view"]);
      await page.waitForSelector(".coach-home-view");
      assert.equal(await page.locator('[data-library-tab="builder"]').first().isVisible(), false, "no Builder in the menu");

      // The Program Library: the public template only, its preview read only.
      await navTo(page, '.sidebar-nav-button[data-library-tab="templates"]');
      await page.getByText("Vseven Public Template").first().waitFor();
      assert.equal(await page.getByText("Vseven Private Template").count(), 0, "never a private template");
      assert.equal(await page.locator('[data-program-library-section="requests"]:visible').count(), 0, "no Requests");
      await page.locator('[data-action="template-open"]', { hasText: "Vseven Public Template" }).first().click();
      await page.waitForSelector(".program-template-preview-modal");
      await page.locator(".program-template-preview-modal").getByText("It cannot be changed or assigned from this workspace.").waitFor();
      assert.deepEqual(await visibleWrites(page), [], "a read-only preview");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll (Program Library)");
      await page.locator('[data-action="template-close"]').last().click();

      // An athlete of the club: its Specific programs, the published one only.
      await navTo(page, "#athletesToggle");
      await page.locator("#athleteList button.athlete-button").first().waitFor();
      await page.locator("#athleteList button.athlete-button", { hasText: "ID 1" }).first().click();
      await page.locator('[data-tab="programs"]').first().click();
      await page.getByText("Vseven Strength Block").first().waitFor();
      assert.equal(await page.getByText("Vseven Hidden Draft").count(), 0, "never a draft");
      assert.deepEqual(await visibleWrites(page), [], "no Edit, Copy or Delete of a plan");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll (athlete programs)");

      // The Exercise Library: the system exercise only, read only.
      await navTo(page, '[data-library-tab="exercises"]');
      await page.getByText("Vseven System Squat").first().waitFor();
      assert.equal(await page.getByText("Vseven Own Drill").count(), 0, "never someone's own exercise");
      assert.deepEqual(await visibleWrites(page), [], "no exercise control");
      assert.equal(await noSideScroll(page), true, "no horizontal scroll (Exercise Library)");

      // The server still decides: the Builder and a write are refused.
      assert.equal((await request(context, world, "/api/builder/drafts")).status, 403);
      assert.equal((await request(context, world, "/api/exercises", { method: "POST", body: { name: "Nope" } })).status, 403);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
