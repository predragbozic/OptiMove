// T2 in a real browser, on a seeded check-in (a team coach schedules one for today through the API and the athlete with
// a login completes it): a session's detail and a schedule's detail have only 44 px controls, 44 px reminder rows,
// clock times without seconds and a back button as wide as its words; the four tabs fit at 360 px; an empty Results
// day offers Today.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

const WELLNESS = "7a386bd1-d25e-4651-9012-e76d9dc32559";
let world;
let browser;

async function api(role, path, method = "GET", body) {
  const token = world.accounts.find((a) => a.role === role).sessionToken;
  const res = await fetch(world.baseUrl + path, { method, headers: { cookie: `optimove_session=${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  world = await startWorld();
  browser = await launch();
  const today = new Date().toISOString().slice(0, 10);
  const created = await api("team_coach", "/api/tests/schedules", "POST", { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: "UTC", startDate: today, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: world.ids.teamA }] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mine = await api("athlete", "/api/tests/athlete/today");
  const assignment = mine.body?.assignments?.[0];
  assert.ok(assignment, "the athlete has today's check-in");
  const sent = await api("athlete", `/api/tests/assignments/${assignment.assignmentId}/submit`, "POST", { values: { fatigue: 3, soreness: 4, sleep: 2, mood: 4, stress: 3, injury: false } });
  assert.equal(sent.status, 200);
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openTests(page, section) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="tests"]').first().click();
  await page.locator('main [data-action="tests-section"][data-section="today"]').first().waitFor();
  if (section !== "today") await page.locator(`main [data-action="tests-section"][data-section="${section}"]`).first().click();
  await page.locator('[data-action="tests-weekly-prev-week"]').waitFor();
}

const detail = () => {
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const shell = document.querySelector(".tests-shell");
  return {
    small: [...shell.querySelectorAll("button, a[href]")].filter(vis).filter((e) => e.getBoundingClientRect().height < 43.5).map((e) => e.textContent.trim()),
    rows: [...shell.querySelectorAll(".tests-reminder-row")].map((r) => Math.round(r.getBoundingClientRect().height)),
    boxes: [...shell.querySelectorAll(".tests-reminder-checkbox")].map((c) => Math.round(c.getBoundingClientRect().width)),
    text: shell.innerText,
    back: (() => { const b = shell.querySelector('[data-action="tests-weekly-close-detail"], [data-action="tests-close-schedule"]'); return b ? Math.round(b.getBoundingClientRect().width) : null; })(),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
};

for (const width of [390, 360, 1280]) test(`(team_coach, ${width} px) a session's detail: 44 px controls and reminder rows, times without seconds`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openTests(page, "today");
    await page.locator(".tests-weekly-agenda .tests-weekly-session").first().click();
    await page.locator(".tests-reminder-row").first().waitFor();
    const d = await page.evaluate(detail);
    assert.deepEqual(d.small, []);
    assert.ok(d.rows.length >= 10 && d.rows.every((h) => h >= 44), `reminder rows ${d.rows}`);
    assert.ok(d.boxes.every((w) => w === 20));
    assert.match(d.text, /00:00–23:59 in each athlete's local timezone/);
    assert.ok(!/\d\d:\d\d:\d\d/.test(d.text), "no seconds");
    assert.ok(d.back < 220, `the back button is as wide as its words (${d.back} px)`);
    assert.equal(d.overflow, 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

for (const width of [390, 1280]) test(`(team_coach, ${width} px) a schedule's detail: 44 px actions, no seconds`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openTests(page, "schedule");
    await page.locator(".tests-weekly-agenda .tests-weekly-session").first().click();
    await page.locator('[data-action="tests-close-schedule"]').waitFor();
    const d = await page.evaluate(detail);
    assert.deepEqual(d.small, []);
    assert.match(d.text, /00:00–23:59 UTC/);
    assert.ok(d.back < 220, `${d.back} px`);
    assert.equal(d.overflow, 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(team_coach, 360 px) the four section tabs fit on one row; Today follows the arrows", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 360);
  try {
    await openTests(page, "today");
    const t = await page.evaluate(() => {
      const strip = document.querySelector(".tests-section-tabs").getBoundingClientRect();
      const tabs = [...document.querySelectorAll('.tests-section-tabs [data-action="tests-section"]')].map((b) => b.getBoundingClientRect());
      const next = document.querySelector('[data-action="tests-weekly-next-week"]').getBoundingClientRect();
      const today = document.querySelector(".tests-weekly-today-button").getBoundingClientRect();
      return { inside: tabs.every((r) => r.left >= strip.left && r.right <= strip.right), oneRow: new Set(tabs.map((r) => Math.round(r.top))).size === 1, todayAfter: today.left >= next.right };
    });
    assert.ok(t.inside && t.oneRow, JSON.stringify(t));
    assert.ok(t.todayAfter);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(team_coach, 390 px) an empty Results day says when results come and offers Today", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 390);
  try {
    await openTests(page, "results");
    await page.locator('[data-action="tests-weekly-next-week"]').click();
    await page.locator('.tests-weekly-agenda [data-action="tests-section"][data-section="today"]').waitFor();
    assert.match(await page.locator(".tests-weekly-agenda").innerText(), /Results appear here once athletes complete a check-in\./);
    await page.locator('.tests-weekly-agenda [data-action="tests-section"][data-section="today"]').click();
    await page.locator('main [data-action="tests-section"][data-section="today"].is-active').waitFor();
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
