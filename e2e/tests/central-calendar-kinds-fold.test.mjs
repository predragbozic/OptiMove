// FE-D16 (central-calendar-k2b2-plan.md 9.4): an RPE request an event refers to is folded into the event's card on
// the calendar; with "RPE requests" alone chosen the screen reads `kinds=external`, so the request is its own card.
// At 1280, 390, 375 and 360 px, as the team coach.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const cookieOf = (role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}

// The server's calendar day of the browser: the event and the request are on the day the calendar opens on.
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let world;
let browser;
let scheduleId;
let eventId;
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
  } finally {
    await db.end();
  }
  const day = localDay();
  const ext = await call("team_coach", "POST", "/api/training-load/external-schedules", {
    eventName: "Fold check RPE", scheduleKind: "one_time", startDate: day, timezone: "UTC", opensTime: "00:00", closesTime: "23:59",
    targets: [{ kind: "team", id: world.ids.teamA }],
    notificationRules: [{ kind: "athlete_invitation", enabled: false }, { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 }, { kind: "final_digest", enabled: false }],
  });
  assert.equal(ext.status, 201, ext.text);
  scheduleId = ext.body.schedules[0].id;
  const types = (await call("team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const match = types.find((t) => t.kind === "match") || types[0];
  const made = await call("team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: match.id, title: "Fold check match", day, startTime: "18:00",
    timezone: "UTC", expects: ["rpe"], externalScheduleId: scheduleId, targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, made.text);
  eventId = made.body.event.id;
});
after(async () => { await browser?.close(); await world?.stop(); });

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) RPE requests alone shows the request the event folds; Events back folds it again`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    const kindsSent = [];
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.pathname === "/api/calendar") kindsSent.push(url.searchParams.get("kinds"));
    });
    try {
      const toggle = page.locator('[data-action="mobile-nav-toggle"]');
      if (await toggle.isVisible().catch(() => false)) await toggle.click();
      await page.locator("#calendarToggle").click();
      const eventCard = `[data-action="central-calendar-open-item"][data-key^="event:${eventId}"]`;
      const rpeCard = `[data-action="central-calendar-open-item"][data-key^="external:${scheduleId}"]`;
      await page.waitForSelector(eventCard, { timeout: 20_000 });
      assert.equal(await page.locator(rpeCard).count(), 0, "folded into the event's card");

      // K5-2: Show only is always in view (no need to open More filters).
      await page.click('[data-action="central-calendar-show-only"][data-kind="external"]');
      await page.waitForSelector(rpeCard, { timeout: 20_000 });
      assert.equal(await page.locator(eventCard).count(), 0, "events are not chosen");
      assert.ok(kindsSent.includes("external"), `the screen asked for kinds=external (${JSON.stringify(kindsSent)})`);
      await page.locator(rpeCard).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/fe-d16-rpe-alone-${width}.png` }).catch(() => {});

      // Events instead: the unfiltered answer again, the request folded.
      const sent = kindsSent.length;
      await page.click('[data-action="central-calendar-show-only"][data-kind="event"]');
      await page.waitForSelector(eventCard, { timeout: 20_000 });
      assert.equal(await page.locator(rpeCard).count(), 0);
      assert.equal(kindsSent.length, sent, "no request: the unfiltered answer is on hand");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, "no horizontal page scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
