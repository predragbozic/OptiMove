// K6-2 and K6-3 (docs/ai/central-calendar-k6-contract.md 6.2, scenarios 4 and 5), in the real app at 1280, 390, 375 and
// 360 px. Planned weeks come from a read the test answers per athlete (the e2e world has none); the calendar, the
// roster, the panel and the Weekly plan's own screens are the real app:
// - from the calendar, Open the week on an athlete, drill into Strength > Power, move to the next athlete on the same
//   section (the name differs in case and spaces); an athlete without a "Power" section gets the calm line with
//   Strength open; an athlete without a plan gets "No plan this week"; Back to calendar returns in one tap;
// - an event's panel, See each athlete: "in this event" count, the target without a session says so.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = iso(new Date());
const MONDAY = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
const SUNDAY = (() => { const d = new Date(`${MONDAY}T12:00:00`); d.setDate(d.getDate() + 6); return iso(d); })();

let world;
let browser;
const rosterId = {};
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    for (const row of (await db.query(`select athlete_id, full_name from public.athletes`)).rows) rosterId[row.full_name] = row.athlete_id;
  } finally {
    await db.end();
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

const item = (o) => ({ amPm: "PM", bta: "T", domain: "Strength", domain_node_id: "d-strength", category: "", section: "", section_node_id: "", ...o });
const PLANS = {
  "Ana Example": [item({ section: "Power", section_node_id: "s1" })],
  "Bojan Example": [item({ section: " power ", section_node_id: "s2" })],
  "Cara Example": [item({ section: "Speed", section_node_id: "s3" })],
  "Dario Example": null,
};
const weekOf = (items) => ({
  weekStart: MONDAY, weekEnd: SUNDAY, planId: "plan-x",
  days: Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${MONDAY}T12:00:00`); d.setDate(d.getDate() + i);
    const date = iso(d);
    return { date, dayNote: "", slots: { AM: { B: [], T: [], A: [] }, PM: { B: [], T: date === DAY ? items : [], A: [] } } };
  }),
});

async function withPlans(page) {
  await page.route("**/program-data?program=__weekly__*", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]);
    const name = Object.keys(rosterId).find((n) => rosterId[n] === id);
    const res = await route.fetch();
    const body = await res.json();
    body.weeks = name && PLANS[name] ? [weekOf(PLANS[name])] : [];
    await route.fulfill({ response: res, json: body });
  });
}
async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function openCalendar(page, width) {
  await openNav(page);
  await page.locator("#calendarToggle").click();
  await page.waitForSelector(".central-calendar .athlete-switcher", { timeout: 20_000 });
  if (width < 761 && (await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded")) !== "true") await page.locator(".athlete-switcher-fold").click();
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const small = (page) => page.evaluate(() => [...document.querySelectorAll(".weekly-k6 button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 43.5; }).map((el) => `${(el.getAttribute("aria-label") || el.textContent).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}`));
const summary = (page) => page.locator(".weekly-k6-summary strong").innerText();
const crumbOpen = async (page, label) => { await page.locator(`[data-action="node"]`, { hasText: label }).first().click(); await page.waitForTimeout(250); };

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) the Weekly plan keeps the place across athletes; Back to calendar is one tap`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await withPlans(page);
      await openCalendar(page, width);
      // Ana chosen in the calendar, then Open the week on today.
      await page.locator('.athlete-switcher .builder-batch-pill[aria-label="Ana Example"]').click();
      await page.waitForSelector(".cc-athlete-line");
      await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
      await page.waitForSelector(".weekly-k6");
      assert.equal(await summary(page), "Ana Example");
      // Drill into Strength > Power.
      await crumbOpen(page, "Strength");
      await page.waitForSelector(".weekly-k6", { timeout: 5000 });
      assert.equal(await summary(page), "Ana Example", "the switcher stays at the next level (S6)");
      await crumbOpen(page, "Power");
      // › -> Bojan, whose section is " power ": the same place.
      await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
      await page.waitForFunction(() => document.querySelector(".weekly-k6-summary strong")?.textContent === "Bojan Example");
      assert.match(await page.locator(".weekly-k6-kept").innerText(), /Strength/);
      assert.ok(await page.getByText(/power/i).first().isVisible(), "his Power section is open");
      // › -> Cara, who has Speed only: the calm line, Strength open, never "Speed".
      await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
      await page.waitForFunction(() => document.querySelector(".weekly-k6-summary strong")?.textContent === "Cara Example");
      // The place was last in Bojan's plan, so the name is his own spelling (" power ").
      assert.match(await page.locator(".weekly-k6-line").innerText(), /^Cara Example has no ‘\s*power\s*’ section in Strength\.$/i);
      // › -> Dario, no plan this week.
      await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
      await page.waitForFunction(() => document.querySelector(".weekly-k6-summary strong")?.textContent === "Dario Example");
      await page.getByText("No plan this week").waitFor();
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      // Back to calendar: one tap, the calendar.
      await page.locator("[data-action='weekly-back-to-calendar']").click();
      await page.waitForSelector(".central-calendar", { timeout: 10_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

// --- K6-3: See each athlete from an event's panel -----------------------------------------------------------

async function call(role, method, path, body) {
  const account = world.accounts.find((a) => a.role === role);
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: `optimove_session=${account.sessionToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) See each athlete: the event's athletes, a target without a session says so, Back returns to the panel`, async () => {
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    let uuidOf;
    try {
      await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]).catch(() => {});
      uuidOf = Object.fromEntries((await db.query(`select id, full_name from public.athletes`)).rows.map((r) => [r.full_name, r.id]));
    } finally {
      await db.end();
    }
    const types = (await call("club_admin", "GET", "/api/calendar/events/types")).body.types || [];
    const made = await call("club_admin", "POST", "/api/calendar/events", {
      requestKey: crypto.randomUUID(), eventTypeId: types.find((t) => t.kind === "training").id, title: `Main session ${label}`, day: DAY, startTime: "18:00", endTime: "19:30",
      timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
    });
    assert.equal(made.status, 201, made.text);
    const eventId = made.body.event.id;
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await withPlans(page);
      // The manager's read carries the session links (a real link needs a saved plan; the screens are the real ones).
      await page.route(`**/api/calendar/events/${eventId}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const body = await res.json();
        const link = (name) => ({ id: `l-${name}`, planId: "plan-x", day: DAY, amPm: "PM", bta: "T", order: 1, state: "linked", sessionName: "Main session", athleteId: uuidOf[name], athleteName: name });
        body.event = { ...body.event, sessionLinks: ["Ana Example", "Cara Example", "Dario Example"].map(link) };
        return route.fulfill({ response: res, json: body });
      });
      await openNav(page);
      await page.locator("#calendarToggle").click();
      await page.waitForSelector(".central-calendar", { timeout: 20_000 });
      const card = page.locator(`.cc-card[data-key^="event:${eventId}"]`).first();
      await card.waitFor({ timeout: 20_000 });
      await card.click();
      const see = page.locator('[data-action="central-calendar-see-each-athlete"]');
      await see.waitFor({ timeout: 20_000 });
      assert.match(await page.locator(".cc-see-each").innerText(), /only the \d+ of this event/);
      await see.click();
      await page.waitForSelector(".weekly-k6");
      assert.equal(await summary(page), "Ana Example");
      assert.match(await page.locator(".weekly-k6-summary").innerText(), /1 \/ \d+ in this event/);
      assert.ok(await page.locator("[data-action='node']").count() > 0 || await page.locator(".node-detail-panel, .calendar-event").count() > 0, "the slot's session is open");
      // A target with no linked session: Bojan.
      await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
      await page.waitForFunction(() => document.querySelector(".weekly-k6-summary strong")?.textContent === "Bojan Example");
      assert.match(await page.locator(".weekly-k6").innerText(), /Not in this session/);
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      // Back to calendar: the event's panel is open again.
      await page.locator("[data-action='weekly-back-to-calendar']").click();
      await page.waitForSelector(".central-calendar .cc-panel", { timeout: 10_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("(390 px) the phone's Back steps up the drilled levels once each, never shows a view twice, then lands on the calendar", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", 390);
  try {
    await withPlans(page);
    await openCalendar(page, 390);
    await page.locator('.athlete-switcher .builder-batch-pill[aria-label="Ana Example"]').click();
    await page.waitForSelector(".cc-athlete-line");
    await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
    await page.waitForSelector(".weekly-k6");
    await crumbOpen(page, "Strength");
    await crumbOpen(page, "Power");
    await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
    await page.waitForFunction(() => document.querySelector(".weekly-k6-summary strong")?.textContent === "Bojan Example");
    // Two levels deep (Strength > Power), and the athlete changed: no extra Back entry for it.
    const seen = [];
    for (let i = 0; i < 6; i += 1) {
      if (await page.locator(".central-calendar").count()) break;
      await page.goBack();
      await page.waitForTimeout(350);
      seen.push(await page.evaluate(() => (document.querySelector(".central-calendar") ? "calendar" : document.querySelector(".node-detail-panel, .node-detail") ? "node" : "weekly")));
    }
    assert.equal(seen.at(-1), "calendar", `Back lands on the calendar: ${seen.join(" > ")}`);
    assert.ok(seen.length <= 4, `a bounded number of presses: ${seen.join(" > ")}`);
    assert.equal(seen.filter((s, i) => i > 0 && s === seen[i - 1] && s !== "calendar").length <= 1, true, `no view shown twice in a row more than once: ${seen.join(" > ")}`);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
