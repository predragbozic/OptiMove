// K6 (docs/ai/central-calendar-k6-contract.md 6.2): the team and athlete switcher in a real browser, at 1280, 390, 375
// and 360 px, over the real server and real data. The world's club has First team (12 athletes) and U19; three of
// them (Ana, Bojan, Cara) also train with U19, and Zed is in U19 only. Ana's and Bojan's published weekly plans hold
// "Main" (Training) with Strength › Power and Strength › Speed; Cara has no plan this week. A U19 event on Monday links
// Ana's Main and targets the team. Synthetic names only.
//  1. Club admin: Groups → U19 → Ana → her cards only; › → Bojan; the green line; Show everyone.
//  2. Club admin, All groups: the search finds Zed of U19 and Groups switches to U19.
//  3. Team coach: no Groups row; the search for a U19-only athlete gives the team sentence.
//  4. Weekly plan from the calendar: Ana's Strength › Power, › → Bojan (no Power: the calm line, Strength open), › → Cara
//     (No plan this week), Back to calendar in one tap.
//  5. See each athlete from the event: Ana in the session, Bojan "Not in this session"; Back to calendar.
// At every width: no page-level horizontal overflow, the controls ≥ 44 px, the search field 16 px, no page error.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
let world;
let browser;
let ids;

const cookieOf = (role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const MONDAY = mondayOf(localDay());
const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));

// A published weekly plan of `ext` this week with Monday "Main" (Training) › Strength › `section`.
async function planWith(ext, section) {
  const created = ok(await call("team_coach", "POST", "/api/builder/plans", { planType: "weekly", weekStart: MONDAY, athleteIds: [ext], athleteExternalIds: [ext], name: "K6 week" }), 201);
  let draft = ok(await call("team_coach", "GET", `/api/builder/plans/${created.plan.id}`));
  draft = ok(await call("team_coach", "POST", `/api/builder/blocks/${draft.blocks[0].id}/sessions`, { bta: "T", name: "Main" }), 201);
  const session = sessionsOf(draft).find((x) => x.name === "Main");
  draft = ok(await call("team_coach", "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Strength" }), 201);
  const domain = (sessionsOf(draft).find((x) => x.id === session.id).nodes || []).find((n) => n.type === "domain");
  draft = ok(await call("team_coach", "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "section", name: section, parentId: domain.id }), 201);
  const node = (sessionsOf(draft).find((x) => x.id === session.id).nodes || []).find((n) => n.type === "section");
  const made = await call("team_coach", "POST", `/api/builder/nodes/${node.id}/custom-exercise`, { name: `${section} squat` });
  assert.ok(made.status < 300, made.text);
  ok(await call("team_coach", "POST", `/api/builder/plans/${created.plan.id}/submit`, { responseMode: "summary" }));
}

async function setup() {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    const [ana, bojan, cara] = world.ids.athleteIds;
    for (const id of [ana, bojan, cara]) {
      await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [id, world.ids.clubA, world.ids.teamA2]);
    }
    const zed = (await db.query(`insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone) values (nextval('public.athlete_generated_id_seq')::text, 'Zed', 'Example', 'Zed Example', 'Zed Example', 'Europe/Sarajevo') returning id`)).rows[0].id;
    await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [zed, world.ids.clubA]);
    await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [zed, world.ids.clubA, world.ids.teamA2]);
    const ext = async (id) => (await db.query(`select coalesce(source_external_id, athlete_id) as x from public.athletes where id = $1`, [id])).rows[0].x;
    await planWith(await ext(ana), "Power");
    await planWith(await ext(bojan), "Speed");
    const main = (await db.query(
      `select ps.logical_session_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id
        where p.athlete_id = $1 and p.status = 'active' and not coalesce(p.is_edit_draft,false) and ps.name = 'Main'`, [ana])).rows[0].logical_session_id;
    ids = { ana, bojan, cara, zed, main };
  } finally {
    await db.end();
  }
  const types = ok(await call("club_admin", "GET", "/api/calendar/events/types"));
  const type = types.types.find((t) => t.kind === "training");
  const event = ok(await call("club_admin", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title: "U19 practice", day: MONDAY, startTime: "10:00", endTime: "11:30",
    targets: [{ kind: "team", id: world.ids.teamA2 }],
  }), 201).event;
  ok(await call("club_admin", "POST", `/api/calendar/events/${event.id}/sessions`, { requestKey: crypto.randomUUID(), expectedRevision: Number(event.revision) || 1, logicalSessionIds: [String(ids.main)] }));
  ids.event = event.id;
}

before(async () => { world = await startWorld(); browser = await launch(); await setup(); });
after(async () => { await browser?.close(); await world?.stop(); });

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {}); }
async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}
async function openCalendar(page) {
  await openNav(page);
  await page.locator("#calendarToggle").click();
  await page.waitForSelector(".central-calendar .cc-k6", { timeout: 20_000 });
}
// A phone folds the box: open it.
async function openBox(page) {
  const fold = page.locator(".cc-k6-fold");
  if (await fold.isVisible().catch(() => false) && (await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
}
async function under44(page, selector) {
  return page.$$eval(selector, (nodes) => nodes.filter((n) => n.offsetParent !== null).map((n) => n.getBoundingClientRect()).filter((r) => r.height < 43.5 || r.width < 43.5).length);
}
const pill = (page, name) => page.locator(`.cc-k6 .builder-batch-pill[aria-label="${name}"]`);
const line = (page) => page.locator(".cc-k6-line");

for (const [label, width] of [["1280 px", 1280], ["390 px", 390], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) K6: the calendar by team and athlete, the search, the Weekly plan switcher and See each athlete`, async () => {
    const admin = await openAs(browser, world, "club_admin", width);
    const { page, pageErrors } = admin;
    try {
      // 1. Groups → U19 → Ana → her cards; › → Bojan; Show everyone.
      await openCalendar(page);
      await openBox(page);
      assert.equal(await overflow(page, width), 0, "the calendar: no sideways scroll");
      await page.locator(`.cc-k6 [data-action="central-calendar-toggle-team"][data-team-id="${world.ids.teamA2}"]`).click();
      await openBox(page);
      await pill(page, "Ana Example").waitFor({ timeout: 10_000 });
      assert.deepEqual(await page.$$eval(".cc-k6 .builder-batch-pill", (n) => n.map((x) => x.getAttribute("aria-label"))), ["Everyone", "Ana Example", "Bojan Example", "Cara Example", "Zed Example"]);
      assert.equal(await under44(page, ".cc-k6 .builder-batch-buttons > .icon-button"), 0, "the arrows are 44 px");
      await pill(page, "Ana Example").click();
      await line(page).waitFor({ timeout: 10_000 });
      assert.match(await line(page).textContent(), /Showing Ana Example · U19/);
      await shot(page, `k6-ana-${width}`);
      await openBox(page);
      await page.locator('.cc-k6 [aria-label="Next athlete"]').click();
      await page.waitForFunction(() => /Showing Bojan Example/.test(document.querySelector(".cc-k6-line")?.textContent || ""), null, { timeout: 10_000 });
      assert.equal(await overflow(page, width), 0, "with an athlete chosen: no sideways scroll");
      await page.locator('[data-action="central-calendar-k6-everyone"]').click();
      await page.waitForFunction(() => !document.querySelector(".cc-k6-line"), null, { timeout: 10_000 });

      // 2. All groups and the search: Zed of U19.
      await openBox(page);
      await page.locator('.cc-k6 [data-action="central-calendar-all-groups"]').click();
      await openBox(page);
      const search = page.locator(".cc-k6 .athlete-switcher-search-input");
      await search.waitFor({ timeout: 10_000 });
      assert.equal(await search.evaluate((n) => getComputedStyle(n).fontSize), "16px");
      await search.fill("zed");
      await page.locator('.athlete-switcher-result[data-athlete-key]').first().waitFor({ timeout: 10_000 });
      await page.locator('.athlete-switcher-result[data-athlete-key]').first().click();
      await page.waitForFunction(() => /Showing Zed Example · U19/.test(document.querySelector(".cc-k6-line")?.textContent || ""), null, { timeout: 10_000 });
      await page.locator('[data-action="central-calendar-k6-everyone"]').click();
      await page.waitForFunction(() => !document.querySelector(".cc-k6-line"), null, { timeout: 10_000 });

      // 4. The Weekly plan from the calendar: open Ana's Monday from the U19 event's panel... from her planned card.
      await openBox(page);
      await page.locator(`.cc-k6 [data-action="central-calendar-toggle-team"][data-team-id="${world.ids.teamA2}"]`).click();
      const select = page.locator(`[data-action="central-calendar-select-day"][data-date="${MONDAY}"]`);
      if (await select.count()) await select.first().click();
      const event = page.locator(`[data-action="central-calendar-open-item"][data-key^="event:${ids.event}"]:visible`).first();
      await event.waitFor({ timeout: 10_000 });
      await event.click();
      const each = page.locator('[data-action="central-calendar-k6-each"]:visible').first();
      // The panel paints again as its reads settle: measure inside the page, on the button drawn now.
      const eachHeight = await (await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('[data-action="central-calendar-k6-each"]')].find((n) => n.offsetParent !== null);
        return button && !document.querySelector(".cc-panel [role=status]")?.textContent?.includes("Loading") ? button.getBoundingClientRect().height : 0;
      }, null, { timeout: 15_000 })).jsonValue();
      assert.ok(eachHeight >= 43.5, `See each athlete is 44 px (${eachHeight})`);
      await shot(page, `k6-panel-${width}`);

      // 5. See each athlete: Ana in the session (the slot opened), Bojan not in it.
      await each.click();
      await page.locator(".weekly-k6").waitFor({ timeout: 20_000 });
      assert.match(await page.textContent(".weekly-k6-head"), /Ana Example/);
      assert.match(await page.textContent(".weekly-k6-head"), /in this event/);
      await page.locator(".node-detail-panel").waitFor({ timeout: 10_000 });
      assert.equal(await overflow(page, width), 0, "the Weekly plan: no sideways scroll");
      await page.locator('.weekly-k6 [aria-label="Next athlete"]').click();
      await page.waitForFunction(() => /Not in this session · Bojan Example/.test(document.querySelector(".weekly-k6-stop")?.textContent || ""), null, { timeout: 15_000 });
      await shot(page, `k6-each-${width}`);
      await page.locator('[data-action="weekly-back-to-calendar"]').click();
      await page.waitForSelector(".central-calendar", { timeout: 15_000 });

      // 4 (cont.). From the calendar's panel athlete row: Ana's plan, Strength › Power, then Bojan, then Cara.
      const event2 = page.locator(`[data-action="central-calendar-open-item"][data-key^="event:${ids.event}"]:visible`).first();
      if (!(await page.locator(".cc-panel").isVisible().catch(() => false))) await event2.click();
      const anaRow = page.locator(`[data-action="central-calendar-open-athlete"][data-athlete-id="${ids.ana}"]:visible`).first();
      await anaRow.waitFor({ timeout: 15_000 });
      await anaRow.click();
      await page.locator(".weekly-k6").waitFor({ timeout: 20_000 });
      await page.locator(`.calendar-day[data-date="${MONDAY}"] [data-action="node"]`).filter({ hasText: "Strength" }).first().click();
      await page.locator('.node-card[data-action="node"]').filter({ hasText: "Power" }).first().click();
      await page.waitForFunction(() => /Power/.test(document.querySelector(".node-detail-panel h3")?.textContent || ""), null, { timeout: 10_000 });
      const depth = await page.evaluate(() => window.history.length);
      await page.locator('.weekly-k6 [aria-label="Next athlete"]').click();
      await page.waitForFunction(() => /Bojan Example has no ‘Power’ section in Strength\./.test(document.querySelector(".weekly-k6-stop")?.textContent || ""), null, { timeout: 15_000 });
      assert.match(await page.textContent(".node-detail-panel h3"), /Strength/, "Strength stays open");
      assert.equal(await page.evaluate(() => window.history.length), depth, "switching adds no history entry");
      await page.locator('.weekly-k6 [aria-label="Next athlete"]').click();
      await page.waitForFunction(() => /Cara Example/.test(document.querySelector(".weekly-k6-head")?.textContent || ""), null, { timeout: 15_000 });
      await page.locator(".weekly-k6-noplan").waitFor({ timeout: 10_000 });
      assert.equal(await overflow(page, width), 0, "No plan this week: no sideways scroll");
      await shot(page, `k6-weekly-${width}`);
      await page.locator('[data-action="weekly-back-to-calendar"]').click();
      await page.waitForSelector(".central-calendar", { timeout: 15_000 });
      assert.deepEqual(pageErrors, [], "no page error");
    } finally {
      await admin.context.close();
    }

    // 3. The team coach: no Groups row; Zed (U19 only) is not in the team.
    const coach = await openAs(browser, world, "team_coach", width);
    try {
      await openCalendar(coach.page);
      await openBox(coach.page);
      assert.equal(await coach.page.locator(".cc-k6-groups").count(), 0, "no Groups row");
      const search = coach.page.locator(".cc-k6 .athlete-switcher-search-input");
      await search.waitFor({ timeout: 10_000 });
      await search.fill("zed");
      await coach.page.waitForFunction(() => document.querySelector(".athlete-switcher-empty")?.textContent === "No athlete in this team matches ‘zed’.", null, { timeout: 10_000 });
      assert.equal(await coach.page.locator(".cc-k6").evaluate((n) => /U19|Zed/.test(n.textContent)), false, "no other team or its athlete named");
      assert.equal(await overflow(coach.page, width), 0);
      assert.deepEqual(coach.pageErrors, [], "no page error");
    } finally {
      await coach.context.close();
    }
  });
}
