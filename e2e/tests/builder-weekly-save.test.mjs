// Weekly program templates, part WT-C (docs/ai/weekly-program-template-plan.md): the team coach opens an athlete's
// published week in the Builder, presses Save weeks as template, chooses two of the athlete's weeks (not consecutive),
// names the template and saves it; the Builder opens the new weekly template with its weeks. At 1280, 390, 375 and
// 360 px: the dialog's rows and buttons 44 px, the week rows' text and checkmark side by side, no horizontal page
// scroll, no page error.
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

// Three published weeks of one athlete, a week apart each, with one named session.
async function setUp(world) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  let athleteId;
  try {
    athleteId = (await db.query("select athlete_id from public.athletes where id = any($1::uuid[]) order by athlete_id limit 1", [world.ids.athleteIds])).rows[0].athlete_id;
  } finally {
    await db.end();
  }
  const ids = [];
  for (const [weekStart, name] of [["2027-01-04", "January one"], ["2027-01-11", "January two"], ["2027-01-18", "January three"]]) {
    const plan = await call(world, "team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart, athleteIds: [athleteId], name });
    assert.equal(plan.status, 201, plan.text);
    const monday = plan.body.blocks[0];
    const withSession = await call(world, "team_coach", "POST", `/api/builder/blocks/${monday.id}/sessions`, { bta: "T", name: `${name} session` });
    const session = withSession.body.blocks[0].sessions[0];
    await call(world, "team_coach", "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Warm-up" });
    assert.equal((await call(world, "team_coach", "POST", `/api/builder/plans/${plan.body.plan.id}/submit`, { responseMode: "summary" })).status, 200);
    ids.push(plan.body.plan.id);
  }
  return { ids };
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
  test(`(${width} px) save an athlete's chosen weeks as a weekly template`, async () => {
    const world = await startWorld();
    try {
      const { ids } = await setUp(world);
      const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
      try {
        // Open the first week in the Builder (its edit draft).
        const opened = await call(world, "team_coach", "POST", `/api/builder/plans/${ids[0]}/edit`);
        assert.equal(opened.status, 200, opened.text);
        const toggle = page.locator('[data-action="mobile-nav-toggle"]');
        if (await toggle.isVisible().catch(() => false)) await toggle.click();
        await page.locator('[data-library-tab="builder"]').first().click();
        await page.getByText("Continue where you left off").first().click();
        await page.getByRole("button", { name: "Continue", exact: true }).first().click();
        await page.locator('[data-action="builder-tw-save-open"]').click();
        const modal = page.locator(".builder-tw-save-modal");
        await modal.locator('[data-action="builder-tw-save-toggle"]').nth(2).waitFor({ timeout: 20_000 });
        // Newest first; the open week is chosen to start with; choose the newest too (not consecutive).
        const rows = modal.locator('[data-action="builder-tw-save-toggle"]');
        assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => e.dataset.planId)), [ids[2], ids[1], ids[0]]);
        await rows.nth(0).click();
        await modal.locator("[data-tw-save-name]").fill("January weeks");
        assert.deepEqual(await smallTargets(page, ".builder-tw-save-modal button"), [], "the dialog's controls are 44 px");
        const layout = await rows.nth(0).evaluate((row) => {
          const text = row.querySelector("span").getBoundingClientRect();
          const mark = row.querySelector(".builder-checkmark").getBoundingClientRect();
          return { textWidth: Math.round(text.width), markLeftOfText: mark.left < text.right - 1 };
        });
        assert.ok(layout.textWidth > 120 && !layout.markLeftOfText, `the row's text has its width and the checkmark is beside it: ${JSON.stringify(layout)}`);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the dialog");
        await shot(page, `wt-c-01-save-${width}`);
        await modal.locator('[data-action="builder-tw-save-submit"]').click();
        await page.locator(".builder-week-strip").waitFor({ timeout: 20_000 });
        assert.deepEqual(await page.locator(".builder-week-tab[role=tab] strong").allTextContents(), ["Week 1", "Week 2"]);
        assert.match(await page.locator(".builder-tw-notice").textContent(), /Saved as the template “January weeks”/);
        assert.match(await page.locator(".builder-workspace").textContent(), /January one session/);
        assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the new template");
        await shot(page, `wt-c-02-template-${width}`);
        assert.deepEqual(pageErrors, []);
      } finally {
        await context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
