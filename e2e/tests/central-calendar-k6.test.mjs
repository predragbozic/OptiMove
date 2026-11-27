// K6-1 (docs/ai/central-calendar-k6-contract.md 6.2, scenarios 1-3), in the real app at 1280, 390, 375 and 360 px:
// a club admin chooses a Group, an athlete and the next one, reads the green line and goes back to Everyone; with
// All groups the strip is one mixed strip with team labels and dots and a search switches Groups; a team coach has
// no Groups row, and a search for another team's athlete says only the team sentence.
// Every control is at least 44 px, the search field is 16 px, the chosen pill is in view, nothing scrolls sideways,
// and no page error is raised.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    const { clubA, teamA, teamA2, athleteIds } = world.ids;
    const person = async (first, teams) => {
      const name = `${first} Example`;
      const id = (await db.query(
        `insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone) values (nextval('public.athlete_generated_id_seq')::text, $1, 'Example', $2, $2, 'Europe/Sarajevo') returning id`,
        [first, name])).rows[0].id;
      await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [id, clubA]);
      for (const team of teams) await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [id, clubA, team]);
      return id;
    };
    await person("Marko", [teamA]);
    await person("Una", [teamA2]);
    await person("Vid", [teamA2]);
    // Ana (the first seeded athlete) trains with both teams.
    await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteIds[0], clubA, teamA2]);
  } finally {
    await db.end();
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openCalendar(page, width) {
  await navTo(page, "#calendarToggle");
  await page.waitForSelector(".central-calendar .athlete-switcher", { timeout: 20_000 });
  // A phone's box is folded to one line: a tap opens it in place.
  if (width < 761) {
    const fold = page.locator(".athlete-switcher-fold");
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  } else {
    await page.getByRole("button", { name: "Show athletes", exact: true }).click();
  }
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const small = (page) => page.evaluate(() => [...document.querySelectorAll(".athlete-switcher button, .athlete-switcher input")].filter((el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.height < 43.5;
}).map((el) => `${(el.getAttribute("aria-label") || el.textContent || el.className).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}`));
const pillInView = (page) => page.evaluate(() => {
  const box = document.querySelector(".athlete-switcher .builder-batch-pills");
  const pill = box.querySelector(".is-active");
  if (!pill) return true;
  const a = pill.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return a.left >= b.left - 1 && a.right <= b.right + 1;
});
const pillNames = (page) => page.$$eval(".athlete-switcher .builder-batch-pill", (els) => els.map((e) => e.getAttribute("aria-label")));
const waitForAthleteRead = (page, action) => Promise.all([page.waitForRequest((r) => /\/api\/calendar\?/.test(r.url()) && r.url().includes("athleteIds="), { timeout: 20_000 }), action]);

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) club admin: Groups, an athlete, the next, the green line, Show everyone; All groups mixed strip and search`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openCalendar(page, width);
      // --- All groups: one mixed strip with team labels and dots (Marko, Ana ... once each).
      const everyone = await pillNames(page);
      assert.equal(everyone[0], "Everyone");
      assert.ok(await page.locator(".athlete-switcher-group-label").count() >= 2, "a label starts each team");
      assert.ok(await page.locator(".athlete-switcher-dot").count() >= 10);
      assert.equal(everyone.filter((n) => n === "Ana Example").length, 1, "an athlete in two teams appears once");
      // --- Search "mark" -> Marko of the First team -> Groups switches, his week is read.
      const search = page.locator("[data-athlete-switcher-search]");
      assert.equal(await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), 16);
      await search.fill("mark");
      await waitForAthleteRead(page, page.locator(".athlete-switcher-result", { hasText: "Marko Example" }).first().click());
      await page.waitForSelector(".cc-athlete-line");
      assert.match(await page.locator(".cc-athlete-line").innerText(), /Showing Marko Example · First team/);
      assert.equal(await page.locator('.athlete-switcher-groups [aria-pressed="true"] .cc-chip-label').first().textContent(), "First team");
      // --- Groups -> U19 team -> Una; the strip is that team's.
      if (width < 761 && (await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
      await page.locator('.athlete-switcher-groups [data-team-id]', { hasText: "U19 team" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".athlete-switcher .builder-batch-pill").length <= 5);
      assert.deepEqual((await pillNames(page)).slice(0, 1), ["Everyone"]);
      assert.ok((await pillNames(page)).includes("Una Example"));
      assert.equal((await pillNames(page)).includes("Marko Example"), false);
      if (width < 761 && (await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
      await waitForAthleteRead(page, page.locator('.athlete-switcher .builder-batch-pill[aria-label="Una Example"]').click());
      await page.waitForFunction(() => /Showing Una Example/.test(document.querySelector(".cc-athlete-line")?.textContent || ""));
      assert.match(await page.locator(".cc-athlete-line").innerText(), /Showing Una Example · U19 team/);
      assert.ok(await pillInView(page), "the chosen pill is in view");
      // --- › moves to the next athlete; the green line follows.
      if (width < 761 && (await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
      await waitForAthleteRead(page, page.locator('.athlete-switcher .icon-button[aria-label="Next athlete"]').click());
      await page.waitForFunction(() => /Showing Vid Example/.test(document.querySelector(".cc-athlete-line")?.textContent || ""));
      assert.deepEqual(await small(page), [], "every control is at least 44 px");
      assert.equal(await overflow(page, width), 0, "nothing scrolls sideways");
      // --- Show everyone.
      await page.locator(".cc-athlete-line [data-action='central-calendar-show-everyone']").click();
      await page.waitForFunction(() => !document.querySelector(".cc-athlete-line"));
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });

  test(`(${label}) team coach: no Groups row; the team's strip; another team's name gets only the team sentence`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openCalendar(page, width);
      assert.equal(await page.locator(".athlete-switcher-groups").count(), 0);
      const names = await pillNames(page);
      assert.ok(names.includes("Marko Example") && !names.includes("Una Example"), "only the team's athletes");
      const search = page.locator("[data-athlete-switcher-search]");
      await search.fill("Una");
      await page.waitForSelector(".athlete-switcher-empty");
      assert.equal(await page.locator(".athlete-switcher-empty").innerText(), "No athlete in this team matches ‘Una’.");
      assert.equal(/U19/.test(await page.locator(".athlete-switcher").innerText()), false, "no other team's name anywhere");
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
