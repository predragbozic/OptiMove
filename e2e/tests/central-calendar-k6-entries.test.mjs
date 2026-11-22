// K6 follow-up PR2 (2026-11-22), in the real app at 1280 and 390 px:
// - item 3: an athlete's row in an event's panel opens the Weekly plan with the switcher holding ONLY that event's
//   athletes ("in this event"), not the whole team; the Weekly plan itself is the athlete's own week;
// - item 4: a row of Coach Home's day list opens the Weekly plan with the switcher holding only the athletes with a
//   session that day ("with a session on this day"), Back goes to Home; a team coach's list never holds an athlete
//   the roster read does not return.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = iso(new Date());

let world;
let browser;
let uuidOf;
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]).catch(() => {});
    uuidOf = Object.fromEntries((await db.query(`select id, full_name from public.athletes`)).rows.map((r) => [r.full_name, r.id]));
  } finally {
    await db.end();
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

async function call(role, method, path, body) {
  const account = world.accounts.find((a) => a.role === role);
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: `optimove_session=${account.sessionToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const small = (page) => page.evaluate(() => [...document.querySelectorAll(".weekly-k6 button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 43.5; }).map((el) => `${(el.getAttribute("aria-label") || el.textContent).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}`));
const summary = (page) => page.locator(".weekly-k6-summary strong").innerText();
const pillNames = (page) => page.$$eval(".weekly-k6 .builder-batch-pill", (els) => els.map((e) => e.getAttribute("aria-label")));
const waitSummary = (page, name) => page.waitForFunction((n) => document.querySelector(".weekly-k6-summary strong")?.textContent === n, name, { timeout: 15_000 });
async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`(${label}) an athlete row in an event's panel opens the plan with only that event's athletes`, async () => {
    const types = (await call("club_admin", "GET", "/api/calendar/events/types")).body.types || [];
    const made = await call("club_admin", "POST", "/api/calendar/events", {
      requestKey: crypto.randomUUID(), eventTypeId: types.find((t) => t.kind === "training").id, title: `Three athletes ${label}`, day: DAY, startTime: "18:00", endTime: "19:30",
      timezone: "UTC", expects: [], targets: ["Ana Example", "Bojan Example", "Cara Example"].map((name) => ({ kind: "athlete", id: uuidOf[name] })),
    });
    assert.equal(made.status, 201, made.text);
    const eventId = made.body.event.id;
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openNav(page);
      await page.locator("#calendarToggle").click();
      await page.waitForSelector(".central-calendar", { timeout: 20_000 });
      const card = page.locator(`.cc-card[data-key^="event:${eventId}"]`).first();
      await card.waitFor({ timeout: 20_000 });
      await card.click();
      const row = page.locator(".cc-athletes .cc-athlete", { hasText: "Bojan Example" });
      await row.waitFor({ timeout: 20_000 });
      assert.equal(await page.locator(".cc-athletes .cc-athlete").count(), 3, "the event names three athletes");
      await row.click();
      await page.waitForSelector(".weekly-k6", { timeout: 20_000 });
      assert.equal(await summary(page), "Bojan Example");
      assert.match(await page.locator(".weekly-k6-summary").innerText(), /2 \/ 3 in this event/);
      assert.deepEqual((await pillNames(page)).sort(), ["Ana Example", "Bojan Example", "Cara Example"], "only the event's athletes, not the team");
      assert.equal(await page.locator(".weekly-k6 .athlete-switcher-groups, .weekly-k6 [data-action='weekly-k6-group']").count(), 0, "no Groups to widen the list");
      // The arrows page inside the three.
      await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
      await waitSummary(page, "Cara Example");
      assert.equal(await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').isDisabled(), true, "the list ends at its last athlete");
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      assert.match(await page.locator("[data-action='weekly-back-to-calendar']").innerText(), /Back to calendar/);
      await page.locator("[data-action='weekly-back-to-calendar']").click();
      await page.waitForSelector(".central-calendar .cc-panel", { timeout: 10_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

for (const role of ["team_coach", "club_admin"]) {
  for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
    test(`(${label}, ${role}) Home's day list opens the plan with only the athletes with a session that day; Back goes to Home`, async () => {
      const { context, page, pageErrors } = await openAs(browser, world, role, width);
      try {
        let roster = [];
        await page.route("**/api/athletes/today", async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          roster = body.rows.map((row) => row.athlete);
          const first = [...body.rows].sort((a, b) => a.athlete.localeCompare(b.athlete)).slice(0, 3).map((row) => row.athleteUuid);
          body.rows = body.rows.map((row) => ({ ...row, hasTrainingToday: first.includes(row.athleteUuid), sessionCount: first.includes(row.athleteUuid) ? 1 : 0 }));
          return route.fulfill({ response: res, json: body });
        });
        await page.reload();
        await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
        const rows = page.locator(".coach-home-day-athlete");
        await rows.first().waitFor({ timeout: 20_000 });
        assert.equal(await rows.count(), 3, "three athletes have a session today");
        const names = await rows.locator("strong").allInnerTexts();
        await rows.nth(1).scrollIntoViewIfNeeded();
        await rows.nth(1).click();
        await page.waitForSelector(".weekly-k6", { timeout: 20_000 });
        assert.equal(await summary(page), names[1]);
        assert.match(await page.locator(".weekly-k6-summary").innerText(), /2 \/ 3 with a session on this day/);
        const pills = await pillNames(page);
        assert.deepEqual([...pills].sort(), [...names].sort(), "only the day's athletes");
        assert.ok(pills.every((name) => roster.includes(name)), "never an athlete the roster read does not return");
        assert.match(await page.locator("[data-action='weekly-back-to-calendar']").innerText(), /Back to Home/);
        await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
        await waitSummary(page, names[2]);
        await page.locator('.weekly-k6 .icon-button[aria-label="Previous athlete"]').click();
        await waitSummary(page, names[1]);
        assert.deepEqual(await small(page), []);
        assert.equal(await overflow(page, width), 0);
        await page.locator("[data-action='weekly-back-to-calendar']").click();
        await page.waitForSelector(".coach-home-day", { timeout: 20_000 });
        assert.equal(await page.locator(".weekly-k6").count(), 0);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    });
  }
}

test("(1280 px) a plan opened another way from Home, or from the Athletes card, carries no switcher", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.desktop);
  try {
    const open = page.locator(".coach-home-athletes [data-action='coach-home-open-athlete']").first();
    await open.waitFor({ timeout: 20_000 });
    await open.click();
    await page.waitForSelector('.tab[data-tab="weekly"].is-active', { timeout: 20_000 });
    assert.equal(await page.locator(".weekly-k6").count(), 0, "the Athletes card opens the plan as before");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
