// Task 5 (docs/ai/builder-batch-edit-plan.md section 12): the team coach reopens a published weekly plan whose session
// is linked to today's event, removes that session in the draft and presses Save. Nothing is saved; the panel names the
// session and says "First remove the link to the event", and Open the event opens the calendar on that day with the
// event's panel. At 1280, 390, 375 and 360 px.
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
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// One athlete's published week with "Main session" today, linked to today's team training; its edit draft open with
// that session removed.
async function setUp(world) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  let athleteExternalId;
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    athleteExternalId = (await db.query("select athlete_id from public.athletes where id = any($1::uuid[]) order by athlete_id limit 1", [world.ids.athleteIds])).rows[0].athlete_id;
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
  const plan = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart: mondayOf(day), athleteIds: [athleteExternalId], name: "Week plan" });
  assert.equal(plan.status, 201, plan.text);
  const block = plan.body.blocks.find((b) => b.date === day);
  const withSession = await call(world, "team_coach", "POST", `/api/builder/blocks/${block.id}/sessions`, { amPm: "AM", bta: "T", time: "" });
  assert.equal(withSession.status, 201, withSession.text);
  const session = withSession.body.blocks.find((b) => b.date === day).sessions[0];
  assert.equal((await call(world, "team_coach", "PATCH", `/api/builder/sessions/${session.id}`, { name: "Main session" })).status, 200);
  const node = await call(world, "team_coach", "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Warm-up" });
  assert.ok(node.status === 200 || node.status === 201, node.text);
  const submitted = await call(world, "team_coach", "POST", `/api/builder/plans/${plan.body.plan.id}/submit`, { responseMode: "summary" });
  assert.equal(submitted.status, 200, submitted.text);
  const db2 = new pg.Client({ connectionString: world.databaseUrl });
  await db2.connect();
  let logicalId;
  try {
    logicalId = (await db2.query(
      `select ps.logical_session_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id
       where pd.plan_id = $1 and ps.name = 'Main session'`, [plan.body.plan.id])).rows[0].logical_session_id;
  } finally {
    await db2.end();
  }
  const linked = await call(world, "team_coach", "POST", `/api/calendar/events/${made.body.event.id}/sessions`, { requestKey: crypto.randomUUID(), expectedRevision: 1, logicalSessionIds: [String(logicalId)] });
  assert.equal(linked.status, 200, linked.text);
  const edit = await call(world, "team_coach", "POST", `/api/builder/plans/${plan.body.plan.id}/edit`);
  assert.equal(edit.status, 200, edit.text);
  const draftSession = edit.body.blocks.find((b) => b.date === day).sessions[0];
  assert.equal((await call(world, "team_coach", "DELETE", `/api/builder/sessions/${draftSession.id}`)).status, 200);
  return { event: made.body.event, planId: plan.body.plan.id, draftId: edit.body.plan.id, day };
}

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) Save refuses to remove a session linked to an event: the panel, then Open the event`, async () => {
    const world = await startWorld();
    try {
      const { event, planId, draftId } = await setUp(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        const toggle = page.locator('[data-action="mobile-nav-toggle"]');
        if (await toggle.isVisible().catch(() => false)) await toggle.click();
        await page.locator('[data-library-tab="builder"]').first().click();
        await page.getByText("Continue where you left off").first().click();
        await page.getByRole("button", { name: "Continue", exact: true }).first().click();
        await page.locator(".builder-program-bar").first().waitFor();
        // The events row has read the week (the panel finds the event from it).
        await page.locator('.b-ev-row [data-action="builder-events-open"]').first().waitFor({ timeout: 20_000 });

        await page.locator('[data-action="builder-submit-plan"]').first().click();
        const panel = page.locator("[data-builder-sessions-locked]");
        await panel.waitFor({ timeout: 20_000 });
        const text = (await panel.textContent()).replace(/\s+/g, " ");
        assert.match(text, /Not saved\./);
        assert.match(text, /Main session · \w{3} \d{2}\.\d{2} · AM \(removed in this draft\)/);
        assert.match(text, /Linked to the event “Team training” in the calendar\. To keep this change, first remove the link to the event, then save again\./);
        assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-builder-sessions-locked")), true, "focus is on the panel");
        assert.equal(await page.locator(".builder-workspace").count(), 1, "still in the Builder");
        const drafts = await call(world, "team_coach", "GET", `/api/builder/plans/${draftId}`);
        assert.equal(drafts.status, 200, "the draft is kept");
        const view = await call(world, "team_coach", "GET", `/api/calendar/events/${event.id}`);
        assert.equal((view.body.event.sessionLinks || []).filter((l) => l.state !== "orphaned").length, 1, "the link is untouched");
        const livePlan = await call(world, "team_coach", "GET", `/api/builder/plans/${planId}`);
        assert.ok(livePlan.body.blocks.some((b) => (b.sessions || []).some((s) => s.name === "Main session")), "the published session stays");
        const open = panel.locator('[data-action="builder-events-open"]');
        const box = await open.boundingBox();
        assert.ok(box && box.height >= 44, `Open the event is a 44 px target (${box?.height})`);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the panel");
        await shot(page, `t5-01-panel-${width}`);

        // Open the event: the calendar on that day with the event's panel, where the session's Unlink is.
        await open.click();
        // The redesign (2026-11-23): the linked training's Unlink is in its row's "⋯" menu, in the Trainings section.
        const trainings = page.locator('.cc-psec-toggle[data-key="trainings"]');
        await trainings.waitFor({ timeout: 20_000 });
        if (await trainings.getAttribute("aria-expanded") !== "true") await trainings.click();
        await page.locator(".cc-psec[data-section='trainings'] .cc-row-more").first().click({ timeout: 20_000 });
        const unlink = page.locator('[data-action="central-calendar-link"][data-act="unlink-sessions"]').first();
        await unlink.waitFor({ timeout: 20_000 });
        const unlinkBox = await unlink.boundingBox();
        assert.ok(unlinkBox && unlinkBox.height >= 43.5, `Unlink is a 44 px target (${unlinkBox?.height})`);
        assert.equal(await page.locator(".builder-workspace").count(), 0, "the calendar is open");
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll on the calendar");
        await shot(page, `t5-02-event-${width}`);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
