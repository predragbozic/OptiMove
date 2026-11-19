// K3 (docs/ai/central-calendar-k3-plan.md 2.1 - 2.6; mockup docs/design/calendar-k4/01): the team coach opens a
// training event, presses Plan the training, the Builder opens for the event's athletes with the band, a session
// added on the event's day is in the event, Save and link saves the plan and links it, and Back to calendar returns to
// the event with its panel open. At 1280, 390, 375 and 360 px; every width a world of its own (a plan per week).
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

async function makeEvent(world) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
  } finally {
    await db.end();
  }
  const types = (await call(world, "team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training");
  assert.ok(training, "a training type");
  const made = await call(world, "team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: training.id, title: "Team training", day: localDay(), startTime: "10:00", endTime: "11:30",
    timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, made.text);
  return made.body.event;
}

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

// A phone lays a page out wider than the screen when something overflows (innerWidth grows with it): the page's
// layout width must be the device's, and nothing scrolls sideways.
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) Plan the training: the Builder with the band, a session in the event, Save and link, Back to calendar`, async () => {
    const world = await startWorld();
    try {
      const event = await makeEvent(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        const toggle = page.locator('[data-action="mobile-nav-toggle"]');
        if (await toggle.isVisible().catch(() => false)) await toggle.click();
        await page.locator("#calendarToggle").click();
        const card = `[data-action="central-calendar-open-item"][data-key^="event:${event.id}"]`;
        await page.waitForSelector(card, { timeout: 20_000 });
        await page.locator(card).first().click();
        const plan = page.locator('[data-action="central-calendar-plan-training"]');
        await plan.waitFor({ timeout: 20_000 });
        assert.match(await plan.textContent(), /Plan the training/);
        assert.match(await page.locator(".cc-panel-k3").textContent(), /No training is planned for this event yet\./);
        await shot(page, `k3-01-panel-${width}`);
        await plan.click();

        // The Builder with the band (case b: nobody has a plan, a new batch for the 12).
        const band = page.locator(".k3-band");
        await band.waitFor({ timeout: 20_000 });
        assert.match(await band.textContent(), /Team training/);
        assert.match(await band.textContent(), /Sessions on this day go into this event\./);
        assert.match(await band.textContent(), /12 athletes/);
        assert.equal(await page.locator('[data-action="builder-submit-plan"]').count(), 0, "Save and link replaces the check button");
        assert.match(await page.locator(".k3-save-bar").textContent(), /Saving publishes the plan to 12 athletes\. No session is put in the event\./);
        // The event's day is in view on entry, its column whole (2.3).
        const seen = await page.evaluate(() => {
          const d = document.querySelector(".builder-block.is-k3-day").getBoundingClientRect();
          const g = document.querySelector(".builder-block-grid").getBoundingClientRect();
          return d.left >= g.left - 1 && d.right <= g.right + 1;
        });
        assert.ok(seen, "the event's day column is whole in the strip");
        const day = page.locator(".builder-block.is-k3-day");
        assert.equal(await day.count(), 1, "the event's day is marked");
        assert.match(await day.textContent(), /In this event/);

        // A session on the event's day starts in the morning (the event is 10:00-11:30).
        await day.locator('[data-action="builder-toggle-session-quick-add"]').first().click();
        assert.equal(await day.locator('[data-action="builder-pick-session-am-pm"][data-value="AM"].is-active').count(), 1, "AM is chosen for the coach");
        await day.locator('[data-action="builder-pick-session-bta"][data-value="T"]').click();
        await day.locator('[data-action="builder-quick-add-session"]').click();
        const chip = day.locator('[data-action="builder-k3-toggle-session"].is-in');
        await chip.waitFor({ timeout: 20_000 });
        assert.match(await day.locator(".k3-session-time").first().textContent(), /10:00 · from the event/);
        assert.match(await page.locator(".k3-save-bar").textContent(), /links 1 session to the event/);

        // Taken out and put back: nothing is sent.
        await chip.click();
        await day.locator(".k3-chip.is-out").waitFor();
        assert.match(await page.locator(".k3-save-bar").textContent(), /No session is put in the event/);
        await day.locator('[data-action="builder-k3-toggle-session"].k3-put-back').click();
        await day.locator('[data-action="builder-k3-toggle-session"].is-in').waitFor();
        // An empty plan is not sent (the server would delete it instead of saving it).
        await page.locator('[data-action="builder-k3-save-link"]').click();
        assert.match(await page.locator(".k3-outcome").textContent(), /Add an exercise or a named section first/);
        // A named part of the session makes the plan worth saving.
        await day.locator('[data-action="builder-start-inline-add"]').first().click();
        await day.locator('.builder-inline-add-form input[name="name"]').fill("Warm-up");
        await day.locator('.builder-inline-add-form button[type="submit"]').click();
        await day.locator(".builder-inline-add-form").waitFor({ state: "detached", timeout: 20_000 });
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll in the Builder");
        await shot(page, `k3-02-builder-${width}`);

        await page.locator('[data-action="builder-k3-save-link"]').click();
        await page.waitForSelector(".k3-outcome:not(.is-busy)", { timeout: 30_000 });
        const outcome = page.locator(".k3-outcome");
        assert.match(await outcome.getAttribute("class"), /is-ok/, await outcome.textContent());
        assert.match(await outcome.textContent(), /Saved\. 1 session for 12 athletes is in Team training · /);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll after the save");
        await shot(page, `k3-03-outcome-${width}`);

        // The link is real: the event's manager view lists the session for the 12.
        const view = await call(world, "team_coach", "GET", `/api/calendar/events/${event.id}`);
        assert.equal(view.status, 200, view.text);
        const linked = (view.body.sessionLinks || view.body.event?.sessionLinks || []).filter((l) => l.state !== "orphaned");
        assert.equal(linked.length, 12, "one link per athlete");

        // Back to calendar: the event's day, its panel open, Open the training.
        await outcome.locator('[data-action="builder-k3-back"]').click();
        const open = page.locator('[data-action="central-calendar-plan-training"]');
        await open.waitFor({ timeout: 20_000 });
        await page.waitForFunction(() => /Open the training/.test(document.querySelector('[data-action="central-calendar-plan-training"]')?.textContent || ""), null, { timeout: 20_000 });
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll on the calendar");
        await shot(page, `k3-04-back-${width}`);

        // Open the training: the published plan (case a, one athlete at a time), already linked; Save and link again
        // says linked (the slot is already in the event), never "not on the calendar".
        await open.click();
        const sheet = page.locator(".k3-sheet");
        await sheet.waitFor({ timeout: 20_000 });
        assert.match(await sheet.textContent(), /12 athletes already have this week's plan\. Changes go to the athlete on screen only\./);
        await sheet.locator('[data-k3="open-plan"]').click();
        await page.locator(".k3-band").waitFor({ timeout: 20_000 });
        assert.equal(await page.locator('.builder-block.is-k3-day [data-action="builder-k3-toggle-session"].is-in').count(), 1, "the linked session is in the event");
        await page.locator('[data-action="builder-k3-save-link"]').click();
        await page.waitForSelector(".k3-outcome:not(.is-busy)", { timeout: 30_000 });
        const again = page.locator(".k3-outcome");
        assert.match(await again.getAttribute("class"), /is-ok/, await again.textContent());
        assert.match(await again.textContent(), /Saved\. 1 session for \d+ athletes? is in Team training/);
        const after = await call(world, "team_coach", "GET", `/api/calendar/events/${event.id}`);
        assert.equal((after.body.event.sessionLinks || []).filter((l) => l.state !== "orphaned").length, 12, "no second link");
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
