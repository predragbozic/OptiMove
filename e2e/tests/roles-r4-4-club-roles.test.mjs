// Roles R4-4, PR B (docs/ai/roles-r4-4-screens-contract.md 5.2-5.5): in the real app against the real R4-3 routes,
//  - a club's admin changes the club's version of Team coach in Settings > Roles and sees it saved;
//  - Imports, taken out of the club's licence, shows closed and locked in the role's words;
//  - OptiMove changes Team coach's default: the club's admin answers the question with Keep ours;
//  - in Settings > Users the club's admin makes a custom Team coach for one coach and then goes back to the role;
//  - at 360, 375 and 390 px no side scroll, 44 px targets and 16 px fields.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
let coachRoleId;
const R = "/api/organization/roles";

async function asPlatform(fn) {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === "platform_admin").sessionToken, url: world.baseUrl }]);
  try { return await fn(ctx); } finally { await ctx.close(); }
}

before(async () => {
  world = await startWorld();
  browser = await launch();
  await asPlatform(async (ctx) => {
    const roles = JSON.parse((await request(ctx, world, `${R}/clubs/${world.ids.clubA}/roles`)).text);
    coachRoleId = roles.systemRoles.find((r) => r.basicKey === "team_coach").roleId;
    const closed = await request(ctx, world, `${R}/clubs/${world.ids.clubA}/ceiling`, { method: "POST", body: { requestKey: crypto.randomUUID(), close: ["imports"], open: [], reason: "No import licence" } });
    assert.equal(closed.status, 200, closed.text);
  });
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

async function openRoles(page) {
  await openSettings(page);
  await page.click('[data-action="organization-section"][data-section="roles"]');
  await page.locator("[data-club-roles]").waitFor();
  await page.locator(`[data-club-role="${coachRoleId}"]`).waitFor();
}
async function noSideScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
async function smallTargets(page, selector) {
  return page.$$eval(`${selector} button, ${selector} label.role-words-label, ${selector} summary, ${selector} select`, (els) => els
    .filter((el) => el.offsetParent !== null)
    .map((el) => ({ text: el.textContent.trim().slice(0, 40), h: el.getBoundingClientRect().height }))
    .filter((x) => x.h < 43.5));
}
async function smallFonts(page, selector) {
  return page.$$eval(`${selector} textarea, ${selector} select, ${selector} input:not([type=checkbox])`, (els) => els
    .filter((el) => el.offsetParent !== null)
    .map((el) => parseFloat(getComputedStyle(el).fontSize)).filter((f) => f < 16));
}
// The first ticked, changeable word of the open list.
const firstChangeable = (scope) => scope.locator("[data-role-word]:checked:not([disabled])").first();

test("1. a club's admin changes Team coach for the club; Imports shows closed and locked (1280 px)", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openRoles(page);
    const row = page.locator(`[data-club-role="${coachRoleId}"]`);
    assert.match(await row.textContent(), /Same as OptiMove's default/);
    assert.match(await page.locator("[data-club-roles-licence]").textContent(), /does not include: Imports/);
    await row.getByRole("button", { name: "Open" }).click();
    const editor = page.locator(`[data-club-roles-editor="${coachRoleId}"]`);
    await editor.waitFor();
    const imports = editor.locator('[data-role-words-group="imports"]');
    if (await imports.count()) {
      assert.match(await imports.textContent(), /Not in your club's licence/);
      assert.equal(await imports.locator("[data-role-word]").count(), 0, "folded");
    }
    const box = editor.getByRole("checkbox", { name: "Manage estimated values", exact: true });
    assert.equal(await box.getAttribute("data-role-word"), "load.estimates.manage");
    assert.equal(await box.isChecked(), true);
    const word = "load.estimates.manage";
    await box.uncheck();
    const save = page.locator("[data-club-roles-save]");
    await save.locator("textarea").fill("Coaches do not need this here");
    await save.getByRole("button", { name: /Save for Example Club/ }).click();
    await page.getByText("Saved for this club: Team coach.").waitFor();
    const read = JSON.parse((await request(context, world, `${R}/clubs/${world.ids.clubA}/roles`)).text);
    const coach = read.systemRoles.find((r) => r.roleId === coachRoleId);
    assert.equal(coach.state, "own_version");
    assert.ok(!coach.effectiveItems.includes(word), "the server holds it");
    await page.getByRole("button", { name: /All roles/ }).click();
    assert.match(await page.locator(`[data-club-role="${coachRoleId}"]`).textContent(), /Changed for this club/);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("1b. a new role of the club's own, made in the R3 form, is listed when the admin is back on the list", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openRoles(page);
    await page.locator("[data-club-roles]").getByRole("button", { name: "New role", exact: true }).click();
    const form = page.locator('[data-roles-form="role"]');
    await form.waitFor();
    await form.locator('[data-roles-field="name"]').fill("Video analyst");
    const word = form.locator("[data-roles-word]:not([disabled])").first();
    await word.evaluate((el) => { el.closest("details")?.setAttribute("open", ""); });
    await word.check();
    await form.getByRole("button", { name: "Create role" }).click();
    await page.locator("[data-club-own-role]").filter({ hasText: "Video analyst" }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("2. OptiMove changes Team coach's default: the club's admin answers Keep ours", async () => {
  await asPlatform(async (ctx) => {
    const role = JSON.parse((await request(ctx, world, `${R}/${coachRoleId}`)).text);
    assert.ok(Number.isInteger(role.revision) && Array.isArray(role.items), "the role read");
    // O6: only a word the app checks can leave a role.
    const catalog = JSON.parse((await request(ctx, world, `${R}/catalog`)).text);
    const checked = new Set(catalog.permissions.filter((p) => p.checked).map((p) => p.word));
    const drop = role.items.filter((w) => checked.has(w)).pop();
    assert.ok(drop, "Team coach holds a checked word");
    const changed = await request(ctx, world, `${R}/${coachRoleId}/change`, { method: "POST", body: { requestKey: crypto.randomUUID(), expectedRevision: role.revision, reason: "New default", items: role.items.filter((w) => w !== drop) } });
    assert.equal(changed.status, 200, changed.text);
  });
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openRoles(page);
    const row = page.locator(`[data-club-role="${coachRoleId}"]`);
    assert.match(await row.textContent(), /your answer is needed/);
    await row.getByRole("button", { name: "Answer" }).click();
    const q = page.locator("[data-club-roles-question]");
    await q.waitFor();
    await q.getByRole("button", { name: "Keep ours" }).click();
    await page.getByText("Team coach keeps this club's own version.").waitFor();
    const read = JSON.parse((await request(context, world, `${R}/clubs/${world.ids.clubA}/roles`)).text);
    assert.equal(read.systemRoles.find((r) => r.roleId === coachRoleId).state, "own_version");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("3. Users: a custom Team coach for one coach, then back to the role", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  const coach = world.accounts.find((a) => a.role === "team_coach");
  try {
    await openSettings(page);
    await page.click('[data-action="organization-section"][data-section="users"]');
    const access = page.locator("[data-person-access]");
    await access.waitFor();
    await access.locator("select").selectOption(coach.id);
    const holding = access.locator("[data-person-holding]").first();
    await holding.waitFor();
    await holding.getByRole("button", { name: "Change for Coach Example" }).click();
    await firstChangeable(holding).uncheck();
    const save = holding.locator("[data-person-save]");
    await save.locator("textarea").fill("Only plans this season");
    await save.getByRole("button", { name: /Save for Coach Example/ }).click();
    await page.getByText("Saved: Team coach (custom) for Coach Example.").waitFor();
    await holding.getByText("Team coach (custom)").waitFor();
    assert.match(await holding.textContent(), /Taken away for Coach Example/);
    await holding.getByRole("button", { name: "Back to Team coach" }).click();
    const end = holding.locator("[data-person-end]");
    await end.locator("textarea").fill("Season over");
    await end.getByRole("button", { name: "Back to Team coach" }).click();
    await page.getByText("Coach Example is back to Team coach.").waitFor();
    assert.equal(await holding.getByText("Team coach (custom)").count(), 0);
    const read = JSON.parse((await request(context, world, `${R}/users/${coach.id}/clubs/${world.ids.clubA}`)).text);
    assert.ok(read.holdings.every((h) => !h.custom?.live), "the server ended it");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

for (const width of [360, 375, 390]) {
  test(`4. (${width} px) Club roles and Access fit the phone: no side scroll, 44 px targets, 16 px fields`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openRoles(page);
      assert.equal(await noSideScroll(page), true, "list: no horizontal scroll");
      assert.deepEqual(await smallTargets(page, "[data-club-roles]"), [], "list: 44 px");
      await page.locator(`[data-club-role="${coachRoleId}"]`).getByRole("button", { name: "Open" }).click();
      const editor = page.locator(`[data-club-roles-editor="${coachRoleId}"]`);
      await editor.waitFor();
      await firstChangeable(editor).uncheck();
      await page.locator("[data-club-roles-save] textarea").waitFor();
      assert.equal(await noSideScroll(page), true, "editor: no horizontal scroll");
      assert.deepEqual(await smallTargets(page, "[data-club-roles]"), [], "editor: 44 px");
      assert.deepEqual(await smallFonts(page, "[data-club-roles]"), [], "editor: 16 px fields");
      await page.click('[data-action="organization-section"][data-section="users"]');
      const access = page.locator("[data-person-access]");
      await access.waitFor();
      assert.equal(await noSideScroll(page), true, "users: no horizontal scroll");
      assert.deepEqual(await smallTargets(page, "[data-person-access]"), [], "access: 44 px");
      assert.deepEqual(await smallFonts(page, "[data-person-access]"), [], "access: 16 px fields");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("Programs Edit can be changed in Settings while Assign and Publish stay locked", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.phone);
  try {
    await openRoles(page);
    await page.locator(`[data-club-role="${coachRoleId}"]`).getByRole("button", { name: "Open" }).click();
    const editor = page.locator(`[data-club-roles-editor="${coachRoleId}"]`);
    const programs = editor.locator('[data-role-words-group="programs"]');
    await programs.waitFor();
    const edit = programs.locator('[data-role-word="programs.edit"]');
    assert.ok(await edit.isEnabled());
    assert.ok(await edit.isChecked());
    assert.ok(await programs.locator('[data-role-word="programs.assign"]').isDisabled());
    assert.ok(await programs.locator('[data-role-word="programs.publish"]').isDisabled());
    const save = page.locator("[data-club-roles-save]");
    const apply = async reason => {
      await save.locator("textarea").fill(reason);
      await save.getByRole("button", { name: /Save for Example Club/ }).click();
      await page.getByText("Saved for this club: Team coach.").waitFor();
    };
    const items = async () => JSON.parse((await request(context, world, `${R}/clubs/${world.ids.clubA}/roles`)).text)
      .systemRoles.find(role => role.roleId === coachRoleId).effectiveItems;
    await edit.uncheck();
    await apply("Review draft permission");
    assert.ok(!(await items()).includes("programs.edit"));
    await edit.check();
    await apply("Restore draft permission");
    const restored = await items();
    assert.ok(restored.includes("programs.edit"));
    assert.ok(!restored.includes("programs.assign") && !restored.includes("programs.publish"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
