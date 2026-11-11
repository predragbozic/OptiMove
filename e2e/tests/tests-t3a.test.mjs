// T3a in a real browser: a coach's Test Library says read-only once, marks only the test that can be scheduled, has
// 44 px rows that sit in columns on a computer, and a search that narrows the list in place without losing focus; a
// result opened from Results says "Back to results". Demo data; one check-in is seeded and completed through the API.
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
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
  const created = await api("team_coach", "/api/tests/schedules", "POST", { testVersionId: WELLNESS, scheduleKind: "one_time", timezone: zone, startDate: today, opensTime: "00:00", closesTime: "23:59", targets: [{ kind: "team", id: world.ids.teamA }] });
  assert.equal(created.status, 201);
  const assignment = (await api("athlete", "/api/tests/athlete/today")).body?.assignments?.[0];
  assert.equal((await api("athlete", `/api/tests/assignments/${assignment.assignmentId}/submit`, "POST", { values: { fatigue: 3, soreness: 4, sleep: 2, mood: 4, stress: 3, injury: false } })).status, 200);
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openTests(page, section) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="tests"]').first().click();
  await page.locator(`main [data-action="tests-section"][data-section="${section}"]`).first().click();
}

for (const width of [390, 360, 1280]) test(`(team_coach, ${width} px) the Test Library: read-only once, 44 px rows, a search that keeps focus`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openTests(page, "library");
    await page.locator("[data-tests-library-row]").first().waitFor();
    const look = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("[data-tests-library-row]")];
      const top = rows[0].getBoundingClientRect().top;
      const small = [...document.querySelectorAll(".tests-shell button, .tests-shell input")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height < 43.5; }).length;
      return {
        rows: rows.length, minRow: Math.min(...rows.map((r) => r.getBoundingClientRect().height)), firstRowCount: rows.filter((r) => Math.abs(r.getBoundingClientRect().top - top) < 2).length,
        pills: [...document.querySelectorAll(".tests-library .tests-status-pill")].map((p) => p.textContent.trim()),
        note: document.querySelector(".tests-library-note")?.textContent.trim(), small, overflow: document.documentElement.scrollWidth - window.innerWidth,
        font: parseFloat(getComputedStyle(document.querySelector("[data-tests-library-search]")).fontSize),
      };
    });
    assert.ok(look.rows >= 10);
    assert.ok(look.minRow >= 44, `${look.minRow} px`);
    assert.deepEqual(look.pills, ["Can be scheduled"], "only the schedulable test has a pill");
    assert.match(look.note, /^The library is read-only\./);
    assert.equal(look.small, 0);
    assert.ok(look.font >= 16);
    assert.equal(look.overflow, 0);
    assert.equal(look.firstRowCount, width >= 1000 ? 3 : 1, "columns on a computer, a list on a phone");
    await page.locator("[data-tests-library-search]").pressSequentially("shoulder", { delay: 20 });
    const after = await page.evaluate(() => ({
      shown: [...document.querySelectorAll("[data-tests-library-row]")].filter((r) => !r.hidden).map((r) => r.querySelector(".tests-library-row-name").textContent.trim()),
      focus: document.activeElement?.hasAttribute("data-tests-library-search"),
      count: document.querySelector("[data-tests-library-count]").textContent,
    }));
    assert.deepEqual(after.shown, ["Shoulder Clearing Test", "Shoulder Mobility"]);
    assert.equal(after.focus, true, "the search keeps the focus while typing");
    assert.equal(after.count, "2 tests");
    await page.locator("[data-tests-library-search]").fill("no such test");
    await page.locator("[data-tests-library-empty]:not([hidden])").waitFor();
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

for (const width of [390, 1280]) test(`(team_coach, ${width} px) a result opened from Results says "Back to results" and goes back`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openTests(page, "results");
    await page.locator(".tests-weekly-agenda .tests-weekly-session").first().click();
    const one = page.locator('[data-action="tests-open-result"]').first();
    await page.locator(".tests-result-back, [data-action=\"tests-open-result\"]").first().waitFor();
    if (await one.count()) await one.click();
    const back = page.locator(".tests-result-back");
    await back.waitFor();
    const box = await back.boundingBox();
    assert.equal((await back.textContent()).trim(), "← Back to results");
    assert.ok(box.height >= 44 && box.width < 220, JSON.stringify(box));
    await back.click();
    await back.waitFor({ state: "detached" });
    assert.equal(await page.locator('main [data-action="tests-section"][data-section="results"][aria-current="page"]').count(), 1, "still on Results");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
