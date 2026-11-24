// Weekly program templates, part WT-B (docs/ai/weekly-program-template-plan.md): the team coach assigns a two-week
// weekly template from a Wednesday to an athlete who already has a published week there. The question (Replace / Skip
// weeks that already have a plan / Back) is asked, Skip leaves the own week untouched. At 1280, 390, 375 and 360 px,
// and at 360x640 with three conflicting athletes: every answer 44 px and reachable, no horizontal page scroll, no page
// error.
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
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The Wednesday of next week, and its Monday.
function nextWednesday() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 + 2);
  const monday = new Date(d);
  monday.setDate(d.getDate() - 2);
  return { wednesday: iso(d), monday: iso(monday) };
}

async function setUp(world) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  let athlete;
  try {
    athlete = (await db.query("select athlete_id, coalesce(display_name, full_name) as name from public.athletes where id = any($1::uuid[]) order by athlete_id limit 1", [world.ids.athleteIds])).rows[0];
  } finally {
    await db.end();
  }
  const { wednesday, monday } = nextWednesday();
  const template = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "program", templateKind: "weekly", weeks: 2, name: "Base weeks" });
  assert.equal(template.status, 201, template.text);
  const day2 = template.body.blocks.find((b) => b.index === 2);
  assert.equal((await call(world, "team_coach", "POST", `/api/builder/blocks/${day2.id}/sessions`, { bta: "T", name: "Easy run" })).status, 201);
  // The athlete already has a published week where Day 1 lands.
  const week = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart: monday, athleteIds: [athlete.athlete_id], name: "Own week" });
  assert.equal(week.status, 201, week.text);
  const wed = week.body.blocks.find((b) => b.date === wednesday);
  const own = await call(world, "team_coach", "POST", `/api/builder/blocks/${wed.id}/sessions`, { bta: "T", name: "Own session" });
  assert.equal(own.status, 201, own.text);
  const ownSession = own.body.blocks.find((b) => b.date === wednesday).sessions[0];
  // A named structure, so the Save keeps the week (an empty one is removed).
  const node = await call(world, "team_coach", "POST", `/api/builder/sessions/${ownSession.id}/nodes`, { nodeType: "domain", name: "Warm-up" });
  assert.ok(node.status < 300, node.text);
  assert.equal((await call(world, "team_coach", "POST", `/api/builder/plans/${week.body.plan.id}/submit`, { responseMode: "summary" })).status, 200);
  return { templateId: template.body.plan.id, athlete, wednesday, monday, weekPlanId: week.body.plan.id };
}

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const smallTargets = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
  .filter((e) => e.getBoundingClientRect().width)
  .map((e) => { const r = e.getBoundingClientRect(); return { label: (e.getAttribute("aria-label") || e.textContent || "").trim().slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; })
  .filter((c) => c.w < 44 || c.h < 44), selector);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) the dated assign of a weekly template: the question, Skip, the own week untouched`, async () => {
    const world = await startWorld();
    try {
      const { athlete, wednesday, weekPlanId } = await setUp(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        await navTo(page, '[data-library-tab="builder"]');
        await page.getByText("Continue where you left off").first().click();
        await page.locator('.builder-draft-row', { hasText: "Base weeks" }).getByRole("button", { name: "Continue", exact: true }).click();
        await page.locator(".builder-week-strip").waitFor();

        // The dated assign: a question, because the athlete has a published week there.
        await page.locator('[data-action="builder-tw-assign-open"]').click();
        const modal = page.locator(".builder-tw-assign-modal");
        await modal.waitFor();
        await modal.locator("[data-tw-start-date]").fill(wednesday);
        await modal.locator(`[data-action="builder-tw-assign-toggle"][data-athlete-id="${athlete.athlete_id}"]`).click();
        assert.deepEqual(await smallTargets(page, ".builder-tw-assign-modal .builder-copy-plan-footer button"), []);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the assign dialog");
        await shot(page, `wt-02-assign-${width}`);
        await modal.locator('[data-action="builder-tw-assign-submit"]').click();
        const question = modal.locator("[data-tw-conflict]");
        await modal.locator("[data-tw-conflict], [role=alert], [role=status]").first().waitFor({ timeout: 20_000 });
        assert.equal(await question.count(), 1, (await modal.textContent()).replace(/\s+/g, " "));
        assert.match((await question.textContent()).replace(/\s+/g, " "), /1 athlete already has plans in these weeks\./);
        assert.deepEqual(await smallTargets(page, ".builder-tw-conflict-actions button"), [], "the three answers are 44 px");
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the question");
        await shot(page, `wt-03-question-${width}`);
        await question.locator('[data-action="builder-tw-assign-choice"][data-choice="skip"]').click();
        await modal.getByText("Assigned.").waitFor({ timeout: 20_000 });
        // The own week is untouched; the following weeks are new.
        const own = await call(world, "team_coach", "GET", `/api/builder/plans/${weekPlanId}`);
        assert.deepEqual(own.body.blocks.flatMap((b) => b.sessions.map((s) => s.name)), ["Own session"]);
        await modal.locator('[data-action="builder-tw-assign-close"]').last().click();
        await modal.waitFor({ state: "detached" });

        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}

test("(360x640) the question with three athletes: Replace and Skip can be reached and pressed", async () => {
  const world = await startWorld();
  try {
    const { templateId, wednesday, monday } = await setUp(world);
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    let athletes;
    try {
      athletes = (await db.query("select athlete_id from public.athletes where id = any($1::uuid[]) order by athlete_id limit 3", [world.ids.athleteIds])).rows.map((r) => r.athlete_id);
    } finally {
      await db.end();
    }
    // Two more athletes with a published week where Day 1 lands.
    for (const athleteId of athletes.slice(1)) {
      const week = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart: monday, athleteIds: [athleteId], name: "Own week" });
      assert.equal(week.status, 201, week.text);
      const wed = week.body.blocks.find((b) => b.date === wednesday);
      const own = await call(world, "team_coach", "POST", `/api/builder/blocks/${wed.id}/sessions`, { bta: "T", name: "Own session" });
      const ownSession = own.body.blocks.find((b) => b.date === wednesday).sessions[0];
      await call(world, "team_coach", "POST", `/api/builder/sessions/${ownSession.id}/nodes`, { nodeType: "domain", name: "Warm-up" });
      assert.equal((await call(world, "team_coach", "POST", `/api/builder/plans/${week.body.plan.id}/submit`, { responseMode: "summary" })).status, 200);
    }
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 360);
    try {
      await page.setViewportSize({ width: 360, height: 640 });
      await navTo(page, '[data-library-tab="builder"]');
      await page.getByText("Continue where you left off").first().click();
      await page.locator(".builder-draft-row", { hasText: "Base weeks" }).getByRole("button", { name: "Continue", exact: true }).click();
      await page.locator(".builder-week-strip").waitFor();
      assert.ok(templateId);
      await page.locator('[data-action="builder-tw-assign-open"]').click();
      const modal = page.locator(".builder-tw-assign-modal");
      await modal.locator("[data-tw-start-date]").fill(wednesday);
      for (const athleteId of athletes) await modal.locator(`[data-action="builder-tw-assign-toggle"][data-athlete-id="${athleteId}"]`).click();
      await modal.locator('[data-action="builder-tw-assign-submit"]').click();
      await modal.locator("[data-tw-conflict]").waitFor({ timeout: 20_000 });
      for (const choice of ["replace", "skip"]) {
        const answer = modal.locator(`[data-action="builder-tw-assign-choice"][data-choice="${choice}"]`);
        await answer.scrollIntoViewIfNeeded();
        const box = await answer.boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= 640 && box.height >= 44, `${choice} reachable: ${JSON.stringify(box)}`);
      }
      assert.equal(await overflow(page, 360), 0, "no horizontal page scroll");
      await shot(page, "wt-05-question-3-athletes-360x640");
      await modal.locator('[data-action="builder-tw-assign-choice"][data-choice="skip"]').click();
      await modal.getByText(/Assigned\.|Nothing was assigned/).first().waitFor({ timeout: 20_000 });
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  } finally {
    await world.stop();
  }
});
