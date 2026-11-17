// "My training" (owner, 2026-11-16): the athlete sees her own recorded sessions and values, read-only, through the real
// athlete-results routes (PR #578). The entry (Home and the menu) is there only once the server says she has a
// recorded session. The session comes from a real import of the fake source (invented data); the athlete account is
// linked to its GPEXE athlete 101. 1280, 390 and 360 px; screenshots go to E2E_SHOT_DIR when it is set.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const G = "/api/training-load/gpexe";
const shot = (page, name) => page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/${name}.png` : "/dev/null", fullPage: true }).catch(() => {});

async function openAthlete(world, width) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const context = await browser.newContext({ viewport: { width, height: 800 }, ...(width < 800 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // The app's own read of whether she has a recorded session.
  const selfAnswer = page.waitForResponse((r) => r.url().endsWith("/api/training-activity/self"), { timeout: 20_000 });
  await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
  await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  const under44 = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 43.5; }).map((e) => `${(e.innerText || "").trim().slice(0, 30)} ${Math.round(e.getBoundingClientRect().height)}`), selector);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  return { context, page, pageErrors, under44, overflow, selfAnswer };
}

test("no recorded session: no entry on Home or in the menu, and the server says so", async () => {
  const world = await startWorld();
  try {
    const a = await openAthlete(world, 390);
    try {
      // The app read the server's answer (no) and drew the screen after it.
      assert.deepEqual(await (await a.selfAnswer).json(), { hasRecordedSessions: false });
      await a.page.waitForTimeout(200);
      assert.equal(await a.page.locator(".my-training-home").count(), 0, "no Home entry");
      assert.equal(await a.page.locator('.sidebar [data-athlete-tab="my-training"]').first().isHidden(), true, "no menu item");
      assert.deepEqual(a.pageErrors, []);
    } finally { await a.context.close(); }
  } finally { await world.stop(); }
});

test("an imported session: Home and the menu lead to her sessions; a session shows her values, the whole session then each drill", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    const setup = await prepareImports(world);
    const c = setup.candidates.find((x) => String(x.gpexeTeamSessionId) === "9101");
    const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${c.id}`)).body.candidate;
    const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${c.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
    assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 200));

    for (const width of [1280, 390, 360]) {
      const a = await openAthlete(world, width);
      try {
        const home = a.page.locator(".my-training-home");
        await home.waitFor({ timeout: 15_000 });
        await a.page.waitForFunction(() => /Last:/.test(document.querySelector(".my-training-home")?.textContent || ""), null, { timeout: 15_000 });
        assert.deepEqual(await a.under44(".my-training-home"), []);
        assert.equal(await a.overflow(), 0, "Home");
        await shot(a.page, `my-training-home-${width}`);
        // A computer goes in from Home; a phone from the menu (both ways are there).
        if (width < 800) {
          await a.page.locator("#mobileNavToggle").click();
          const item = a.page.locator('.sidebar [data-athlete-tab="my-training"]').first();
          assert.equal(await item.isVisible(), true, "the menu item");
          assert.deepEqual(await a.under44('.sidebar [data-athlete-tab="my-training"]'), []);
          await item.click();
        } else {
          assert.equal(await a.page.locator('.sidebar [data-athlete-tab="my-training"]').first().isVisible(), true, "the menu item");
          await home.click();
        }
        const row = a.page.locator('[data-action="my-training-open"]').first();
        await row.waitFor({ timeout: 15_000 });
        await a.page.waitForFunction(() => !document.body.classList.contains("mobile-nav-open"), null, { timeout: 10_000 });
        await a.page.waitForTimeout(400);
        assert.match(await row.innerText(), /Recorded by a device/);
        assert.deepEqual(await a.under44('[data-action="my-training-open"]'), []);
        assert.equal(await a.overflow(), 0, "the list");
        await shot(a.page, `my-training-list-${width}`);
        await row.click();
        await a.page.locator(".my-training-values").first().waitFor({ timeout: 15_000 });
        const look = await a.page.evaluate(() => ({
          sections: [...document.querySelectorAll(".my-training-values h4")].map((h) => h.textContent.trim()),
          values: document.querySelectorAll(".my-training-value").length,
          keys: [...document.querySelectorAll(".my-training-value")].map((v) => v.dataset.valueKey),
          text: document.querySelector(".my-training").innerText,
        }));
        assert.equal(look.sections[0], "Whole session", JSON.stringify(look.sections));
        assert.ok(look.sections.length >= 2, `the drills follow: ${JSON.stringify(look.sections)}`);
        assert.ok(look.values > 0);
        // Drills start folded; one opens on a tap and shows its values.
        const firstDrill = a.page.locator(".my-training-drill").first();
        assert.equal(await firstDrill.evaluate((d) => d.open), false);
        assert.deepEqual(await a.under44(".my-training-drill summary"), []);
        await firstDrill.locator("summary").click();
        assert.ok(await firstDrill.locator(".my-training-value").first().isVisible(), "an opened drill shows its values");
        assert.equal(new Set(look.keys).size, look.keys.length, "one row per value");
        // No source id (the GPEXE athlete, team or session numbers) reaches her screen; names are the stored names.
        assert.doesNotMatch(look.text, /\b(?:101|7001|9101)\b/, `no source ids: ${look.text.slice(0, 600)}`);
        assert.deepEqual(await a.under44(".my-training-back"), []);
        assert.equal(await a.overflow(), 0, "the session");
        await shot(a.page, `my-training-session-${width}`);
        // Back to her list, by the button (and on a phone by Back).
        if (width < 800) await a.page.goBack(); else await a.page.locator(".my-training-back").click();
        await a.page.locator('[data-action="my-training-open"]').first().waitFor({ timeout: 10_000 });
        // A quick double tap on "‹ My training" ends on her list, not on Home (code review).
        await a.page.locator('[data-action="my-training-open"]').first().click();
        await a.page.locator(".my-training-values").first().waitFor({ timeout: 15_000 });
        await a.page.locator(".my-training-back").evaluate((b) => { b.click(); b.click(); });
        await a.page.waitForTimeout(600);
        await a.page.locator('[data-action="my-training-open"]').first().waitFor({ timeout: 10_000 });
        assert.equal(await a.page.locator(".athlete-home-week").count(), 0, "still My training, not Home");
        // The folded drill shows a chevron.
        await a.page.locator('[data-action="my-training-open"]').first().click();
        await a.page.locator(".my-training-drill summary").first().waitFor({ timeout: 15_000 });
        assert.equal(await a.page.locator(".my-training-drill summary").first().evaluate((s) => getComputedStyle(s, "::after").content), '"›"');
        assert.deepEqual(a.pageErrors, []);
      } finally { await a.context.close(); }
    }
  } finally { await world.stop(); }
});
