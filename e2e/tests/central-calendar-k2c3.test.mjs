// K2c-3 (docs/ai/central-calendar-k3-plan.md 6.2 - 6.6; mockups docs/design/calendar-k4/02 and 03): the team coach
// opens a weekly draft in the Builder; the event's day shows its events row; choosing the event for a session of a plan
// never saved asks "This plan isn't saved yet", Save and continue saves it, stays in the Builder and links the session;
// Create event → opens the calendar's own form with its band, and after Create event the coach is back in the Builder
// with the new event in the day's row. At 1280, 390, 375 and 360 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs } from "../lib/browser.mjs";

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
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// The world: a training event today for the team, and a never-saved weekly draft of the team's athletes with one
// named AM Training session today.
async function setUp(world) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  let builderIds;
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    builderIds = (await db.query("select athlete_id from public.athletes where id = any($1::uuid[]) order by athlete_id", [world.ids.athleteIds])).rows.map((r) => r.athlete_id);
  } finally {
    await db.end();
  }
  const types = (await call(world, "team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training");
  const day = localDay();
  const made = await call(world, "team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: training.id, title: "Team training", day, startTime: "10:00", endTime: "11:30",
    timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, made.text);
  const plan = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart: mondayOf(day), athleteIds: builderIds, name: "Week plan" });
  assert.equal(plan.status, 201, plan.text);
  const block = plan.body.blocks.find((b) => b.date === day);
  const withSession = await call(world, "team_coach", "POST", `/api/builder/blocks/${block.id}/sessions`, { amPm: "AM", bta: "T", time: "", syncBatch: true });
  assert.equal(withSession.status, 201, withSession.text);
  const session = withSession.body.blocks.find((b) => b.date === day).sessions[0];
  const named = await call(world, "team_coach", "PATCH", `/api/builder/sessions/${session.id}`, { name: "Main session", syncBatch: true });
  assert.equal(named.status, 200, named.text);
  const node = await call(world, "team_coach", "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Warm-up", syncBatch: true });
  assert.ok(node.status === 200 || node.status === 201, node.text);
  return { event: made.body.event, planId: plan.body.plan.id, day };
}

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) the events row, Event: [▾] on a draft (Save and continue), Create event → and back`, async () => {
    const world = await startWorld();
    try {
      const { event, planId, day } = await setUp(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        await navTo(page, '[data-library-tab="builder"]');
        await page.getByText("Continue where you left off").first().click();
        await page.getByRole("button", { name: "Continue", exact: true }).first().click();
        await page.locator(".builder-program-bar").first().waitFor();

        // The events row of today: the event's chip and Create event →.
        const row = page.locator(".b-ev-row").filter({ has: page.locator(`[data-action="builder-events-open"]`) });
        await row.first().waitFor({ timeout: 20_000 });
        assert.match(await row.first().textContent(), /Team training/);
        assert.match(await row.first().textContent(), /10:00–11:30/);
        const select = page.locator("[data-builder-event-select]").first();
        await select.waitFor();
        assert.equal(await select.inputValue(), "", "No event yet");
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the events row");
        await shot(page, `k2c3-01-row-${width}`);

        // A plan never saved: the question, then Save and continue (it stays in the Builder) and the link.
        await select.selectOption(String(event.id));
        const ask = page.locator(".k3-sheet");
        await ask.waitFor({ timeout: 10_000 });
        assert.match(await ask.textContent(), /This plan isn't saved yet/);
        assert.match(await ask.textContent(), /Save it \(the athletes will see it\) and continue\?/);
        await shot(page, `k2c3-02-ask-${width}`);
        await ask.locator('[data-answer="yes"]').click();
        await page.waitForFunction(() => /is in Team training 10:00\./.test(document.querySelector(".builder-workspace")?.textContent || ""), null, { timeout: 30_000 });
        assert.equal(await page.locator(".builder-workspace").count(), 1, "still in the Builder");
        assert.equal(await page.locator("[data-builder-event-select]").first().inputValue(), String(event.id));
        const view = await call(world, "team_coach", "GET", `/api/calendar/events/${event.id}`);
        assert.equal((view.body.event.sessionLinks || []).filter((l) => l.state !== "orphaned").length, 12, "the session of the 12 athletes is linked");
        assert.equal(await overflow(page, width), 0);
        await shot(page, `k2c3-03-linked-${width}`);

        // Create event →: the calendar's own form with its band; Create event brings the coach back.
        await page.locator(`[data-action="builder-events-create"][data-date="${day}"]`).click();
        const band = page.locator(".k3-band-form");
        await band.waitFor({ timeout: 20_000 });
        assert.match(await band.textContent(), /Creating an event for the Builder/);
        await page.locator(".cc-event-form").waitFor({ timeout: 20_000 });
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the form's band");
        await shot(page, `k2c3-04-form-${width}`);
        await page.locator('.cc-event-form [data-cc-focus="field:title"], .cc-event-form input[name="title"]').first().fill("Evening session");
        const start = page.locator('.cc-event-form input[type="time"]').first();
        await start.fill("18:00");
        await page.locator('.cc-event-form [data-action="central-calendar-event-save"], .cc-event-form button[type="submit"]').first().click();
        await page.waitForFunction(() => /The event Evening session · 18:00 is in the calendar\./.test(document.querySelector(".builder-workspace")?.textContent || ""), null, { timeout: 30_000 });
        await page.waitForFunction(() => [...document.querySelectorAll('[data-action="builder-events-open"]')].some((b) => /Evening session/.test(b.textContent)), null, { timeout: 20_000 });
        assert.equal(await overflow(page, width), 0);
        await shot(page, `k2c3-05-back-${width}`);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
