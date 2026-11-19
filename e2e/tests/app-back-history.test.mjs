// Back returns to where the user was (app-history.js), not to Home. At 1280 and 390 px:
// - the team coach: calendar -> an event's panel -> an athlete's weekly plan -> Back lands on the calendar, the same
//   week, the panel open; calendar -> an activity -> Open in Training Load -> Back; calendar -> Builder -> Back;
//   calendar -> Settings -> Back; and a Training Load guard that declines Back (Imports: sessions selected, not
//   imported) keeps the coach there until the question is accepted;
// - the athlete: Weekly plan -> Coaches -> Back lands on the weekly plan, then Back lands on Home.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, WIDTHS } from "../lib/browser.mjs";

const G = "/api/training-load/gpexe";
// The fake source's series sessions are on 2-4 November 2026; the event shares the imported session's day (9113).
const DAY = "2026-11-04";
const EVENT_TITLE = "Back test training";

let world;
let browser;
before(async () => {
  world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "series" } });
  browser = await launch();
  const setup = await prepareImports(world);
  // One imported session (an activity on DAY with Open in Training Load); the other two stay Ready for the guard.
  const candidate = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9113");
  const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${candidate.id}`)).body.candidate;
  const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${candidate.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
  assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 300));
  const coach = world.accounts.find((a) => a.role === "team_coach");
  const grant = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/approvers`, { userId: coach.id, reason: "e2e: the team's coach approves its own imports" });
  assert.ok([200, 201].includes(grant.status), `grant: ${grant.status}`);
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
  } finally {
    await db.end();
  }
  const types = (await setup.call("team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training") || types[0];
  const made = await setup.call("team_coach", "POST", "/api/calendar/events", {
    requestKey: crypto.randomUUID(), eventTypeId: training?.id, title: EVENT_TITLE, day: DAY, startTime: "10:00",
    timezone: "Europe/Belgrade", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
  });
  assert.equal(made.status, 201, JSON.stringify(made.body).slice(0, 300));
});
after(async () => { await browser?.close(); await world?.stop(); });

const where = (page) => page.evaluate(() => ({
  title: document.querySelector("#screenTitle")?.textContent.trim() || "",
  calendar: Boolean(document.querySelector(".cc-toolbar")),
  period: document.querySelector(".cc-period")?.textContent.trim() || "",
  openKey: document.querySelector('[data-action="central-calendar-open-item"][aria-pressed="true"]')?.dataset.key || "",
  panel: Boolean(document.querySelector('[data-action="central-calendar-close-panel"]')),
}));

// A phone opens its menu first (only when it is closed).
async function openNav(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false) && (await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

async function openCalendar(page) {
  await openNav(page);
  await page.locator("#calendarToggle").click();
  // Drawn once the week's days carry their dates (the read is asynchronous).
  await page.waitForSelector(".central-calendar [data-date]", { timeout: 20_000 });
}

// Pages the calendar to DAY's week; on a phone the day strip then points at DAY.
async function showDay(page) {
  // The week is drawn once its days carry their dates (the read is asynchronous after every step).
  const drawn = () => page.waitForSelector(".central-calendar [data-date]", { timeout: 20_000 });
  await drawn();
  for (let i = 0; i < 60 && !(await page.locator(`.central-calendar [data-date="${DAY}"]`).count()); i += 1) {
    const first = await page.locator(".central-calendar [data-date]").first().getAttribute("data-date");
    const period = await page.textContent(".cc-period");
    await page.click(`[data-action="central-calendar-${DAY < first ? "prev" : "next"}"]`);
    await page.waitForFunction((p) => document.querySelector(".cc-period")?.textContent !== p, period, { timeout: 10_000 });
    await page.waitForFunction((d) => [...document.querySelectorAll(".central-calendar [data-date]")].some((e) => e.dataset.date !== d), first, { timeout: 20_000 });
  }
  const select = page.locator(`[data-action="central-calendar-select-day"][data-date="${DAY}"]`);
  if (await select.count() && (await select.first().getAttribute("aria-pressed")) !== "true") await select.first().click();
}

// A card of DAY, opened (its panel drawn).
async function openCard(page, filter) {
  const card = page.locator(`[data-action="central-calendar-open-item"][data-date="${DAY}"]`, filter).first();
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForSelector('[data-action="central-calendar-close-panel"]', { timeout: 20_000 });
}

async function backTo(page, predicate, arg) {
  await page.goBack().catch(() => {});
  await page.waitForFunction(predicate, arg, { timeout: 20_000 }).catch(async (error) => {
    throw new Error(`Back did not land where expected (${JSON.stringify(arg)}): ${JSON.stringify(await where(page))}; ${error.message.split("\n")[0]}`);
  });
  // And it stays so once the tab's own read has landed.
  await page.waitForTimeout(1000);
  if (!(await page.evaluate(predicate, arg))) {
    await page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/back-history-fail.png` }).catch(() => {});
    throw new Error(`Back landed, then moved: ${JSON.stringify(await where(page))}`);
  }
}

const calendarAt = ([period, key]) => document.querySelector(".cc-period")?.textContent.trim() === period
  && (!key || document.querySelector('[data-action="central-calendar-open-item"][aria-pressed="true"]')?.dataset.key === key)
  && (!key || Boolean(document.querySelector('[data-action="central-calendar-close-panel"]')));

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`(${label}) the team coach: Back returns to the calendar's week and open panel, to Training Load's caller, and a declining guard keeps Training Load`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      // calendar -> the event's panel -> an athlete's weekly plan -> Back.
      await openCalendar(page);
      await showDay(page);
      await openCard(page, { hasText: EVENT_TITLE });
      const atEvent = await where(page);
      assert.ok(atEvent.openKey, "the event's panel is open");
      await page.locator('[data-action="central-calendar-open-athlete"]').first().click();
      await page.waitForFunction(() => !document.querySelector(".cc-toolbar"), null, { timeout: 20_000 });
      await backTo(page, calendarAt, [atEvent.period, atEvent.openKey]);
      const back1 = await where(page);
      assert.equal(back1.period, atEvent.period, "the same week");
      assert.equal(back1.openKey, atEvent.openKey, "the same panel open");

      // An activity -> Open in Training Load -> Back: the calendar with that activity's panel. (A phone's panel is a
      // sheet over the cards: it is closed first.)
      await page.click('.cc-panel-close');
      await page.waitForFunction(() => !document.querySelector('[data-action="central-calendar-close-panel"]'), null, { timeout: 10_000 });
      await openCard(page, { hasNotText: EVENT_TITLE });
      const atActivity = await where(page);
      await page.locator('[data-action="central-calendar-open-training-load"]').first().click();
      await page.waitForSelector('[data-action="training-load-section"]', { timeout: 20_000 });
      await backTo(page, calendarAt, [atActivity.period, atActivity.openKey]);

      // A declining guard: Imports with Ready sessions chosen, not imported. Back asks; Stay keeps Training Load.
      await page.locator('[data-action="central-calendar-open-training-load"]').first().click();
      await page.waitForSelector('[data-action="training-load-section"]', { timeout: 20_000 });
      await page.click('[data-action="training-load-section"][data-section="imports"]');
      await page.waitForSelector(".imports-tab-panel", { timeout: 20_000 });
      const readyTab = page.locator('[data-action="training-load-gpexe-tab"][data-import-tab="ready"]');
      if (await readyTab.count()) await readyTab.click();
      await page.click('[data-action="training-load-gpexe-import-ready"]', { timeout: 20_000 });
      const asked = [];
      page.once("dialog", (d) => { asked.push(d.message()); d.dismiss().catch(() => {}); });
      await page.goBack().catch(() => {});
      for (let i = 0; i < 100 && !asked.length; i += 1) await page.waitForTimeout(50);
      assert.equal(asked.length, 1, "Back asked before leaving");
      assert.match(asked[0], /did not import/);
      await page.waitForTimeout(500);
      assert.equal(await page.locator('[data-action="training-load-section"]').count() > 0, true, "still on Training Load");
      assert.equal((await where(page)).calendar, false);
      // Back again, accepted: the calendar as it was left.
      page.once("dialog", (d) => d.accept().catch(() => {}));
      await backTo(page, calendarAt, [atActivity.period, atActivity.openKey]);

      // calendar -> Builder -> Back; calendar -> Settings -> Back: the same week.
      for (const go of [
        async () => { await openNav(page); await page.locator('[data-library-tab="builder"]').first().click(); },
        async () => { await openNav(page); await page.getByText("Settings", { exact: true }).first().click(); await page.waitForSelector(".settings-tabs"); },
      ]) {
        // A phone's open panel sheet covers the menu button: it is closed first.
        if (width < 600 && await page.locator(".cc-panel-close").count()) {
          await page.click(".cc-panel-close");
          await page.waitForFunction(() => !document.querySelector(".cc-panel-close"), null, { timeout: 10_000 });
        }
        const at = await where(page);
        await go();
        await page.waitForFunction(() => !document.querySelector(".cc-toolbar"), null, { timeout: 20_000 });
        await backTo(page, calendarAt, [at.period, at.openKey]);
      }

      // A place left behind on the same tab (the Athletes list opened and closed by its own toggle) is skipped:
      // Builder -> calendar -> Athletes open and closed -> Settings -> Back -> calendar -> Back -> Builder, never Home.
      await openNav(page);
      await page.locator('[data-library-tab="builder"]').first().click();
      await page.waitForFunction(() => !document.querySelector(".cc-toolbar"), null, { timeout: 20_000 });
      const builderTitle = (await where(page)).title;
      await openCalendar(page);
      // The panel left open earlier closes first on Back (the calendar's own Back): closed here, so the path is the
      // stale place alone.
      if (await page.locator(".cc-panel-close").count()) {
        await page.click(".cc-panel-close");
        await page.waitForFunction(() => !document.querySelector(".cc-panel-close"), null, { timeout: 10_000 });
      }
      const atCalendar = await where(page);
      await openNav(page);
      await page.click("#athletesToggle");
      await page.waitForFunction(() => document.querySelector("#athletesToggle")?.getAttribute("aria-expanded") === "true", null, { timeout: 10_000 });
      await page.click("#athletesToggle");
      await page.waitForFunction(() => document.querySelector("#athletesToggle")?.getAttribute("aria-expanded") === "false", null, { timeout: 10_000 });
      await openNav(page);
      await page.getByText("Settings", { exact: true }).first().click();
      await page.waitForSelector(".settings-tabs");
      await backTo(page, calendarAt, [atCalendar.period, atCalendar.openKey]);
      // Every title shown on the way to the Builder.
      await page.evaluate(() => {
        window.__backTitles = [];
        new MutationObserver(() => window.__backTitles.push(document.querySelector("#screenTitle")?.textContent.trim()))
          .observe(document.querySelector("#screenTitle"), { childList: true, characterData: true, subtree: true });
      });
      await backTo(page, (t) => document.querySelector("#screenTitle")?.textContent.trim() === t, builderTitle);
      const titles = await page.evaluate(() => window.__backTitles);
      assert.ok(!titles.includes("Home"), `never Home on the way: ${titles.join(" > ")}`);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });

  test(`(${label}) the athlete: Weekly plan -> Coaches -> Back lands on the weekly plan, then Back on Home`, async () => {
    const account = world.accounts.find((a) => a.role === "athlete");
    const phone = width < 600;
    const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone });
    await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    try {
      await page.goto(`${world.baseUrl}/athlete`);
      await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
      const home = (await where(page)).title;
      const tab = async (name) => {
        await openNav(page);
        const before = (await where(page)).title;
        await page.locator(`[data-athlete-tab="${name}"]`).first().click();
        await page.waitForFunction((t) => document.querySelector("#screenTitle")?.textContent.trim() !== t, before, { timeout: 20_000 });
        return (await where(page)).title;
      };
      const weekly = await tab("calendar");
      await tab("coaches");
      await backTo(page, (t) => document.querySelector("#screenTitle")?.textContent.trim() === t, weekly);
      await backTo(page, (t) => document.querySelector("#screenTitle")?.textContent.trim() === t, home);
      assert.equal(await page.locator("#exitConfirmModal:not([hidden])").count(), 0, "no Exit question on the way");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
