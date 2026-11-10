// Settings sections (design S2) in a real browser. Overview is a summary: one tile per section opens it. Each section
// shows its own list under one heading with its count. A selected club opens its teams and roster in Clubs, and a
// selected team its roster in Teams. No action the role had is lost: each one is still reachable in its own section.
// Nothing overflows, and the heading's and tiles' controls are 44 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const tab = (page, section) => page.locator(`.settings-tabs [data-section="${section}"]`).first();

async function view(page) {
  return page.evaluate(() => {
    const scope = document.querySelector("main.workspace .organization-browser");
    const shown = (e) => e.getBoundingClientRect().width > 0;
    const actions = new Set([...scope.querySelectorAll("[data-action]")].filter(shown).map((e) => e.dataset.action));
    const controls = [...scope.querySelectorAll(".organization-browser-head button, .organization-section-summary-tile")].filter(shown);
    return {
      h2: [...scope.querySelectorAll("h2")].map((h) => h.textContent.trim()),
      count: scope.querySelector(".organization-browser-head .muted")?.textContent.trim(),
      actions: [...actions],
      small: controls.filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim()),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

for (const [role, width] of [["platform_admin", 1280], ["club_admin", 390]]) test(`(${role}, ${width} px) Overview is a summary and each section shows its own list`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, role, width);
  try {
    await openSettings(page);
    await tab(page, "overview").click();
    await page.locator(".organization-section-summary-tile").first().waitFor();
    let v = await view(page);
    assert.deepEqual(v.h2, ["All accessible organization"]);
    assert.ok(!v.actions.includes("organization-select-club") && !v.actions.includes("organization-edit"), "Overview draws no list");
    assert.deepEqual(v.small, []);
    assert.equal(v.overflow, 0);

    const expect = {
      users: { title: "Users", own: "organization-manage-account-open" },
      clubs: { title: "Clubs", own: "organization-select-club" },
      teams: { title: "Teams", own: "organization-select-team" },
      athletes: { title: "Athletes", own: "organization-invite-athlete" },
    };
    for (const [section, e] of Object.entries(expect)) {
      // A tile opens its section.
      await tab(page, "overview").click();
      await page.locator(`.organization-section-summary-tile[data-section="${section}"]`).click();
      await page.locator(`.settings-tabs [data-section="${section}"][aria-current="page"]`).waitFor();
      await page.locator("main.workspace h2.organization-section-title", { hasText: e.title }).waitFor();
      v = await view(page);
      assert.deepEqual(v.h2, [e.title], section);
      assert.ok(v.actions.includes(e.own), `${section} keeps ${e.own}`);
      assert.deepEqual(v.small, [], section);
      assert.equal(v.overflow, 0, section);
    }

    // A club opens its teams and roster in Clubs; a team its roster in Teams; Show all clears.
    await tab(page, "clubs").click();
    await page.locator('main.workspace [data-action="organization-select-club"]').filter({ hasText: "Example Club" }).first().click();
    await page.locator("main.workspace .organization-list-head .eyebrow", { hasText: "Teams - Example Club" }).waitFor();
    v = await view(page);
    assert.deepEqual(v.h2, ["Example Club"]);
    for (const a of ["organization-select-team", "organization-invite-athlete", "organization-toggle-archived-club-members", "organization-clear-selection"]) assert.ok(v.actions.includes(a), a);
    await tab(page, "teams").click();
    await page.locator('main.workspace [data-action="organization-select-team"]').filter({ hasText: "First team" }).first().click();
    await page.locator("main.workspace .organization-list-head .eyebrow", { hasText: "Team roster" }).waitFor();
    v = await view(page);
    assert.deepEqual(v.h2, ["First team"]);
    for (const a of ["organization-toggle-assign-athlete", "organization-toggle-archived-team-members", "organization-archive-team-membership", "organization-clear-selection"]) assert.ok(v.actions.includes(a), a);
    assert.ok(!v.actions.includes("organization-select-club"), "Teams draws no club list");
    assert.equal(v.overflow, 0);
    await page.locator('main.workspace [data-action="organization-clear-selection"]').click();
    await page.locator("main.workspace h2.organization-section-title", { hasText: /^Teams$/ }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
