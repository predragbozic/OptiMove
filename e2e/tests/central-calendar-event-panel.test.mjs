// The event panel package (docs/ai/central-calendar-event-panel-contract.md, section 5, e2e): a team event with its
// RPE request folded in, two answers and one of them changed. The manager's panel shows each athlete's values and the
// summary at 1280, 390, 375 and 360 px with no horizontal overflow; the row opens the athlete's Weekly plan on the day
// and Back returns to the panel; a reader's panel shows states only and reads no values.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
const cookieOf = (world, role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(world, role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(world, role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

let browser;
let world;
let names;
const managerTitle = "Team training";
const readerTitle = "Club meeting";

// The team's training with its RPE request folded into the card (12 athletes asked). The athlete account answers 7
// and then changes it to 5 through the real routes (v83); a teammate's answer of 8 is stored as the athlete's own
// submit stores it. Planned answers cannot change (an immutable snapshot), so the changed one is a request's.
async function setup() {
  const day = localDay();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    names = [];
    for (const athleteId of world.ids.athleteIds.slice(0, 3)) {
      names.push((await db.query(`select display_name from public.athletes where id = $1`, [athleteId])).rows[0].display_name);
    }
  } finally {
    await db.end();
  }
  const ext = await call(world, "team_coach", "POST", "/api/training-load/external-schedules", {
    eventName: "Training RPE", scheduleKind: "one_time", startDate: day, timezone: "UTC", opensTime: "00:00", closesTime: "23:59",
    targets: [{ kind: "team", id: world.ids.teamA }],
    notificationRules: [{ kind: "athlete_invitation", enabled: false }, { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 }, { kind: "final_digest", enabled: false }],
  });
  assert.equal(ext.status, 201, ext.text);
  const scheduleId = ext.body.schedules[0].id;
  const types = (await call(world, "team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training");
  const made = await call(world, "team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: training.id, title: managerTitle, day, startTime: "10:00", endTime: "11:30",
    timezone: "UTC", expects: ["rpe"], externalScheduleId: scheduleId, targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, made.text);
  // The coach's weekly read makes today's occurrence and its assignments.
  assert.equal((await call(world, "team_coach", "GET", `/api/training-load/weekly?weekStart=${mondayOf(day)}`)).status, 200);
  const db2 = new pg.Client({ connectionString: world.databaseUrl });
  await db2.connect();
  try {
    const assignmentOf = async (athleteId) => (await db2.query(
      `select a.id from training_load.external_assignments a join training_load.external_schedule_occurrences o on o.id = a.occurrence_id
        where o.schedule_id = $1 and a.athlete_id = $2`, [scheduleId, athleteId])).rows[0].id;
    const own = await assignmentOf(world.ids.athleteIds[0]);
    const submitted = await call(world, "athlete", "POST", `/api/training-load/external-assignments/${own}/rpe`, { rpe: 7, durationMinutes: 60 });
    assert.ok(submitted.status < 300, submitted.text);
    const changed = await call(world, "athlete", "POST", `/api/training-load/external-assignments/${own}/rpe/change`, { requestKey: crypto.randomUUID(), rpe: 5, durationMinutes: 60, expectedRevision: 0 });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.body.outcome, "changed", changed.text);
    const mate = await assignmentOf(world.ids.athleteIds[1]);
    await db2.query(
      `insert into training_load.session_feedback (athlete_id, session_date, external_assignment_id, source, event_name, rpe, duration_minutes) values ($1,$2,$3,'scheduled_external','Training RPE',8,45)`,
      [world.ids.athleteIds[1], day, mate]);
  } finally {
    await db2.end();
  }
  // The reader's event: the club's, for the team; the team's coach reads it and may not manage it.
  const clubTypes = (await call(world, "club_admin", "GET", "/api/calendar/events/types")).body.types || [];
  const meeting = clubTypes.find((t) => t.kind === "meeting") || clubTypes[0];
  const clubEvent = await call(world, "club_admin", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: meeting.id, title: readerTitle, day, startTime: "16:00", endTime: "17:00",
    timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(clubEvent.status, 201, clubEvent.text);
  return { managerId: made.body.event.id, readerId: clubEvent.body.event.id };
}

let ids;
before(async () => {
  browser = await launch();
  world = await startWorld();
  ids = await setup();
});
after(async () => {
  await browser?.close();
  await world?.stop();
});

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}
async function openCalendar(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator("#calendarToggle").click();
}
const cardOf = (eventId) => `[data-action="central-calendar-open-item"][data-key^="event:${eventId}"]`;

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) the manager's panel: each athlete's values, the summary, the click to the Weekly plan and Back`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openCalendar(page);
      await page.waitForSelector(cardOf(ids.managerId), { timeout: 20_000 });
      await page.locator(cardOf(ids.managerId)).first().click();
      const summary = page.locator(".cc-answers-summary");
      await page.waitForFunction(() => /Answered/.test(document.querySelector(".cc-answers-summary")?.textContent || ""), null, { timeout: 20_000 });
      // Twelve athletes asked; two answered: (5 + 8) / 2 = 6.5. The changed answer counts with its current value.
      assert.equal((await summary.textContent()).replace(/\s+/g, " ").trim(), "Answered 2/12 · average RPE 6.5");
      const row = (name) => page.locator(".cc-athletes .cc-athlete").filter({ has: page.locator(".cc-athlete-name", { hasText: name }) });
      assert.match(await row(names[0]).textContent(), /RPE 5 · 60 min/);
      assert.match(await row(names[1]).textContent(), /RPE 8 · 45 min/);
      assert.match(await row(names[2]).textContent(), /RPE missing/);
      assert.match(await row(names[1]).getAttribute("aria-label"), /RPE 8, 45 minutes, open the weekly plan on /);
      assert.equal(await row(names[1]).locator(".cc-athlete-go").textContent(), "Weekly plan ›");
      // The row is one button, at least 44 px high.
      const box = await row(names[1]).boundingBox();
      assert.ok(box.height >= 44, `the row is ${box.height} px high`);
      assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the panel open");
      await shot(page, `event-panel-01-${width}`);
      if (SHOTS) {
        await summary.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/event-panel-02-athletes-${width}.png` }).catch(() => {});
      }

      await row(names[1]).click();
      await page.waitForFunction(() => !document.querySelector(".cc-answers-summary"), null, { timeout: 20_000 });
      await page.goBack();
      await page.waitForFunction(() => /Answered/.test(document.querySelector(".cc-answers-summary")?.textContent || ""), null, { timeout: 20_000 });
      assert.match(await page.locator(".cc-panel").first().textContent(), new RegExp(managerTitle));
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("(1280 px) a reader's panel: the states only, no summary, no weekly read", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 1280);
  try {
    await openCalendar(page);
    await page.waitForSelector(cardOf(ids.readerId), { timeout: 20_000 });
    const weekly = [];
    page.on("request", (req) => { if (req.url().includes("/api/training-load/weekly")) weekly.push(req.url()); });
    await page.locator(cardOf(ids.readerId)).first().click();
    await page.waitForSelector(".cc-athletes .cc-athlete", { timeout: 20_000 });
    await page.waitForTimeout(500);
    assert.equal(await page.locator(".cc-answers-summary").count(), 0);
    assert.deepEqual(weekly, [], "a reader's panel reads no values");
    assert.equal(await overflow(page, 1280), 0);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});
