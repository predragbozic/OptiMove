// Weekly program templates, part WT-A (docs/ai/weekly-program-template-plan.md): the team coach opens a two-week
// weekly template in the Builder, sees the week strip (Week 1, Week 2, + Week), duplicates week 1, and finds the Weekly
// mark in the Program Library. At 1280, 390, 375 and 360 px: every control 44 px, no horizontal page scroll, no page
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
  test(`(${width} px) a weekly template: the week strip, Duplicate week, the library mark`, async () => {
    const world = await startWorld();
    try {
      await setUp(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        await navTo(page, '[data-library-tab="builder"]');
        await page.getByText("Continue where you left off").first().click();
        await page.locator('.builder-draft-row', { hasText: "Base weeks" }).getByRole("button", { name: "Continue", exact: true }).click();
        const strip = page.locator(".builder-week-strip");
        await strip.waitFor();
        assert.deepEqual(await page.locator(".builder-week-tab[role=tab] strong").allTextContents(), ["Week 1", "Week 2"]);
        assert.deepEqual(await page.locator(".builder-block-kicker").allTextContents(), ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Day 7"]);
        assert.deepEqual(await smallTargets(page, ".builder-week-strip button"), [], "week strip controls are 44 px");
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the week strip");
        await shot(page, `wt-01-strip-${width}`);

        await page.locator('[data-action="builder-tw-duplicate-week"]').click();
        await page.locator(".builder-week-tab[role=tab]").nth(2).waitFor();
        assert.equal(await page.locator(".builder-week-tab.is-active strong").textContent(), "Week 3");
        assert.match(await page.locator(".builder-workspace").textContent(), /Easy run/);

        // The Program Library: the template is marked Weekly.
        await navTo(page, '.sidebar .sidebar-nav-button[data-library-tab="templates"]');
        const card = page.locator(".program-library-card", { hasText: "Base weeks" });
        await card.waitFor({ timeout: 20_000 });
        assert.match(await card.locator(".program-kind-chip").textContent(), /Weekly · 3 weeks/);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll in the library");
        await shot(page, `wt-04-library-${width}`);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
