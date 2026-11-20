// K5-1 and K5-2 (docs/ai/central-calendar-k5-12-contract.md section 4, e2e): on a world with an imported activity
// linked to an event, a lone import, a lone RPE request and a lone test, as the team coach at 1280, 390, 375 and 360 px:
// - the GPS and RPE marks on the event, and the day's chips under its cards;
// - Show only GPS imports, then Scheduled tests, then Show all: the chosen pill in view inside its row, no page scrolled
//   sideways, every pill a 44 px target on a phone, the green line;
// - Open in Tests and Open in Training Load from a panel, then Back (the app's own back step, and the browser's): the
//   same day with the same panel;
// - and the athlete's K4a Calendar shows no mark.
// The event's GPS mark needs `holdsImport` in the calendar's answer (backend PR #684).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
const WELLNESS = "7a386bd1-d25e-4651-9012-e76d9dc32559";
const cookieOf = (role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
// The browser's day; every fixture is on it (an RPE request's assignments are made only on their own day).
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let world;
let browser;
const DAY = localDay();
const ids = {};
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    const activity = async (name, time, athleteId) => {
      const id = (await db.query(
        `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
         values ($1,$2,$3,'UTC','team',$4,'source_import','confirmed') returning id`,
        [name, DAY, `${DAY}T${time}:00Z`, world.ids.teamA],
      )).rows[0].id;
      await db.query(
        `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,'UTC','participated')`,
        [id, athleteId, DAY],
      );
      return id;
    };
    ids.eventImport = await activity("Training GPS", "10:05", world.ids.athleteIds[0]);
    ids.loneImport = await activity("Afternoon GPS", "15:00", world.ids.athleteIds[1]);
  } finally {
    await db.end();
  }
  const types = (await call("team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training");
  const made = await call("team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: training.id, title: "Team training", day: DAY, startTime: "10:00", endTime: "11:30",
    timezone: "UTC", expects: ["rpe"], targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, made.text);
  ids.event = made.body.event.id;
  const linked = await call("team_coach", "POST", `/api/calendar/events/${ids.event}/activities`, { requestKey: crypto.randomUUID(), expectedRevision: made.body.event.revision, activityId: ids.eventImport });
  assert.equal(linked.status, 200, linked.text);
  const rpe = await call("team_coach", "POST", "/api/training-load/external-schedules", {
    eventName: "Gym", scheduleKind: "one_time", startDate: DAY, timezone: "UTC", opensTime: "00:00", closesTime: "23:59",
    targets: [{ kind: "team", id: world.ids.teamA }],
    notificationRules: [{ kind: "athlete_invitation", enabled: false }, { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 }, { kind: "final_digest", enabled: false }],
  });
  assert.equal(rpe.status, 201, rpe.text);
  ids.rpe = rpe.body.schedules[0].id;
  const tst = await call("team_coach", "POST", "/api/tests/schedules", {
    testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: DAY, opensTime: "00:00", closesTime: "23:59",
    targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(tst.status, 201, tst.text);
  ids.test = tst.body.schedule.id;
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function openCalendar(page) {
  await openNav(page);
  await page.locator("#calendarToggle").click();
  await page.waitForSelector(`.central-calendar [data-key^="event:${ids.event}"]`, { timeout: 20_000 });
  // A phone: the day strip points at the fixtures' day.
  const select = page.locator(`[data-action="central-calendar-select-day"][data-date="${DAY}"]`);
  if (await select.count() && (await select.first().getAttribute("aria-pressed")) !== "true") await select.first().click();
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const shownKeys = (page) => page.$$eval(".central-calendar .cc-card, .central-calendar .cc-daychip", (nodes) => nodes.map((node) => node.dataset.key));
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}
async function choose(page, kind) {
  const pill = page.locator(`.cc-showonly [data-action="central-calendar-show-only"][data-kind="${kind}"]`);
  await pill.click();
  await page.waitForFunction((k) => document.querySelector(`.cc-showonly [data-kind="${k}"]`)?.getAttribute("aria-checked") === "true", kind, { timeout: 20_000 });
  // The kinds read, when the kind needs one, lands after the click.
  await page.waitForTimeout(400);
}
// The chosen pill lies wholly inside its row's visible box.
const pillInView = (page) => page.evaluate(() => {
  const row = document.querySelector(".cc-showonly");
  const pill = row.querySelector('[aria-checked="true"]').getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return pill.left >= box.left - 1 && pill.right <= box.right + 1;
});
// The calendar on DAY with the panel of `key` open.
const calendarWithPanel = (key) => Boolean(document.querySelector(".central-calendar"))
  && document.querySelector('[data-action="central-calendar-open-item"][aria-pressed="true"]')?.dataset.key === key
  && Boolean(document.querySelector(".cc-panel"));

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) the marks, the chips, Show only, and Go there with Back`, async () => {
    const phone = width < 761;
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openCalendar(page);
      // --- H4: the event's marks, and H5: the day's chips under its cards.
      const eventKey = await page.locator(`.cc-card[data-key^="event:${ids.event}"]`).first().getAttribute("data-key");
      const marks = page.locator(`.cc-card[data-key="${eventKey}"] .cc-card-marks`);
      assert.equal(await marks.getAttribute("aria-label"), "Holds RPE and GPS data", "the event holds an RPE question and an import");
      const chipText = async (prefix) => (await page.locator(`.cc-daychip[data-key^="${prefix}"] .cc-daychip-text`).first().textContent()).trim();
      assert.equal(await chipText(`activity:${ids.loneImport}`), "GPS 15:00");
      assert.equal(await chipText(`external:${ids.rpe}`), "RPE · Gym");
      assert.ok(await page.locator(`.cc-daychip[data-key^="test:${ids.test}"]`).count(), "the test is a chip");
      assert.equal(await page.locator(`[data-key^="activity:${ids.eventImport}"]`).count(), 0, "the event's import is folded into it, never a chip");
      const order = await page.evaluate((day) => {
        // A week column (wide, medium) or the selected day's list (a phone).
        const column = [...document.querySelectorAll(".cc-day-column")].find((col) => col.querySelector(`.cc-day-head[data-date="${day}"]`));
        const root = column || document.querySelector(".cc-day-list");
        return [...root.querySelectorAll(".cc-card, .cc-daychip")].map((node) => (node.classList.contains("cc-daychip") ? "chip" : "card"));
      }, DAY);
      assert.ok(order.lastIndexOf("card") < order.indexOf("chip"), `the day's cards come before its chips (${order})`);
      for (const box of await page.$$eval(".cc-daychip", (nodes) => nodes.map((node) => node.getBoundingClientRect().height))) {
        if (phone) assert.ok(box >= 43.5, `a chip is a 44 px target on a phone (${box})`);
      }
      assert.equal(await overflow(page, width), 0, "no horizontal page scroll");
      await shot(page, `k5-week-${width}`);

      // --- Show only: GPS imports, then Scheduled tests, then Show all.
      await choose(page, "gps");
      assert.deepEqual((await shownKeys(page)).sort(), [eventKey, (await page.locator(`.cc-daychip[data-key^="activity:${ids.loneImport}"]`).getAttribute("data-key"))].sort());
      assert.match(await page.locator(".cc-showonly-line").textContent(), /Showing only GPS imports · 2 this week/);
      assert.ok(await pillInView(page), "the chosen pill is in view");
      assert.equal(await overflow(page, width), 0);
      await shot(page, `k5-gps-${width}`);
      await choose(page, "test");
      assert.ok((await shownKeys(page)).every((key) => key.startsWith(`test:${ids.test}`)), "only the scheduled test");
      assert.ok(await pillInView(page), "the last pill too, scrolled into view inside its row");
      assert.match(await page.locator(".cc-showonly-line").textContent(), /Showing only Scheduled tests · 1 this week/);
      if (phone) {
        const heights = await page.$$eval(".cc-showonly-pill", (nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        assert.ok(heights.every((h) => h >= 43.5), `every pill is a 44 px target (${heights})`);
        assert.ok(await page.evaluate(() => document.querySelector(".cc-showonly-line").getBoundingClientRect().bottom <= document.querySelector(".cc-showonly").getBoundingClientRect().top + 1), "the green line sits above the row");
      }
      assert.equal(await overflow(page, width), 0);
      await shot(page, `k5-tests-${width}`);
      await page.click(".cc-showonly-all");
      await page.waitForFunction(() => !document.querySelector(".cc-showonly-line"), null, { timeout: 10_000 });
      assert.ok((await shownKeys(page)).includes(eventKey), "Show all brings everything back");

      // --- K5-1: Open in Tests, then the app's own Back step: the same day, the same panel.
      const testChip = page.locator(`.cc-daychip[data-key^="test:${ids.test}"]`).first();
      const testKey = await testChip.getAttribute("data-key");
      await testChip.click();
      await page.waitForSelector('[data-action="central-calendar-open-tests"]', { timeout: 20_000 });
      assert.match(await page.locator(".cc-go-hint").first().textContent(), /^Opens Tests on \w+day, to see who has answered\.$/);
      await shot(page, `k5-test-panel-${width}`);
      await page.click('[data-action="central-calendar-open-tests"]');
      await page.waitForSelector(".tests-weekly-detail", { timeout: 20_000 });
      // The app's own Back (the in-app back step every Back button takes).
      await page.evaluate(() => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.action = "back";
        document.querySelector("#content").append(button);
        button.click();
      });
      await page.waitForFunction(calendarWithPanel, testKey, { timeout: 20_000 });

      // --- Open in Training Load from the lone import, then the browser's Back.
      await page.click(".cc-panel-close");
      await page.waitForFunction(() => !document.querySelector(".cc-panel"), null, { timeout: 10_000 });
      const gpsChip = page.locator(`.cc-daychip[data-key^="activity:${ids.loneImport}"]`).first();
      const gpsKey = await gpsChip.getAttribute("data-key");
      // click() scrolls and finds the chip again after a repaint (a separate scroll could hold a detached one).
      await gpsChip.click();
      await page.waitForSelector('.cc-panel [data-action="central-calendar-open-training-load"]', { timeout: 20_000 });
      await page.click('.cc-panel .cc-go [data-action="central-calendar-open-training-load"]');
      await page.waitForSelector('[data-action="training-load-section"]', { timeout: 20_000 });
      await page.goBack().catch(() => {});
      await page.waitForFunction(calendarWithPanel, gpsKey, { timeout: 20_000 });

      // --- The RPE request opens its schedule in Training Load › Schedule.
      await page.click(".cc-panel-close");
      await page.waitForFunction(() => !document.querySelector(".cc-panel"), null, { timeout: 10_000 });
      const rpeChip = page.locator(`.cc-daychip[data-key^="external:${ids.rpe}"]`).first();
      await rpeChip.click();
      await page.click('[data-action="central-calendar-open-rpe-schedule"]');
      await page.waitForSelector(".training-load-schedule-detail", { timeout: 20_000 });
      assert.match(await page.locator(".training-load-schedule-detail").textContent(), /Gym/);
      assert.equal(await overflow(page, width), 0);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("the athlete's K4a Calendar shows no mark, chip or Show only", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "athlete", WIDTHS.phone);
  try {
    await openNav(page);
    await page.locator('.sidebar [data-athlete-tab="athlete-calendar"]').first().click();
    await page.locator(".athlete-calendar .ac-card").first().waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".cc-card-marks, .cc-daychip, .cc-showonly").count(), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
