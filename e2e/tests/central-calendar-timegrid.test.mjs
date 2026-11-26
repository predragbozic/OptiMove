// K7 (docs/ai/central-calendar-k7-timegrid-contract.md, section 6): the time grid like a professional calendar, in a
// real browser on the real server, as the team coach. Today holds the owner's two trainings (00:00-01:00 and
// 00:30-01:29) and a cluster of five at 10:00-11:00. At 1280 and 1024 px: the pair side by side at its minutes, the
// cluster as two columns and "+3 more", whose click shows the Day list with all of them; the team colour; no horizontal
// page scroll; at 1024 px with the panel open the grid scrolls in its own box; reading order day by day. At 390 px
// the phone switches between its selected-day list and the weekly time grid. Invented data on a disposable database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
const cookieOf = (role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
// The browser's day: the calendar opens on today's week.
const DAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
const PAIR = [["Morning group", "00:00", "01:00"], ["Second group", "00:30", "01:29"]];
const CLUSTER = [1, 2, 3, 4, 5].map((n) => [`Cluster ${n}`, "10:00", "11:00"]);
// No end time: drawn 30 minutes with an open edge, one line "15:00 Quick talk".
const SHORT = ["Quick talk", "15:00", null];

// Whether an element's own content fits it (not cut by overflow) and it is drawn at all.
const fits = (page, selector) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  return { found: true, fits: el.scrollWidth <= el.clientWidth + 1, width: r.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, text: el.textContent.trim() };
}, selector);

before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
  } finally {
    await db.end();
  }
  const types = (await call("team_coach", "GET", "/api/calendar/events/types")).body.types || [];
  const training = types.find((t) => t.kind === "training") || types[0];
  for (const [title, startTime, endTime] of [...PAIR, ...CLUSTER, SHORT]) {
    const made = await call("team_coach", "POST", "/api/calendar/events", {
      requestKey: crypto.randomUUID(), eventTypeId: training.id, title, day: DAY, startTime, ...(endTime ? { endTime } : {}),
      timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
    });
    assert.equal(made.status, 201, made.text);
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openCalendar(page) {
  await navTo(page, "#calendarToggle");
  await page.waitForSelector(".central-calendar [data-date]", { timeout: 20_000 });
}

const boxOf = (page, title) => page.evaluate((t) => {
  const card = [...document.querySelectorAll(".cc-tg-col .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === t);
  if (!card) return null;
  const r = card.closest(".cc-tg-box").getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, color: getComputedStyle(card).getPropertyValue("--cc-team-color").trim() };
}, title);

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["1024 px", 1024]]) {
  test(`(${label}) the time grid: the owner's pair side by side at its minutes, the cluster as two columns and '+3 more'`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openCalendar(page);
      await page.click('[data-action="central-calendar-mode"][data-mode="grid"]');
      await page.waitForSelector(".cc-timegrid .cc-tg-col", { timeout: 20_000 });
      assert.equal((await page.textContent(".cc-tg-hour")).trim(), "00:00", "the grid opens at 00:00 for the pair");
      const a = await boxOf(page, "Morning group");
      const b = await boxOf(page, "Second group");
      assert.ok(a && b, "both drawn in the timed part");
      assert.ok(a.right <= b.left + 0.5, `side by side, not over each other (${JSON.stringify({ a, b })})`);
      const hourPx = a.height; // 00:00-01:00 is one hour
      assert.ok(Math.abs(b.top - a.top - hourPx / 2) <= 1.5, `the second starts 30 minutes lower (${b.top - a.top} vs ${hourPx / 2})`);
      assert.ok(Math.abs(b.height - (hourPx * 59) / 60) <= 1.5, "heights proportional to the times");
      assert.ok(a.color && b.color, "the team colour on each card");
      // The cluster: two columns of cards and "+3 more".
      const cluster = await page.evaluate(() => [...document.querySelectorAll(".cc-tg-col .cc-card .cc-card-title")].filter((el) => el.textContent.startsWith("Cluster")).length);
      assert.equal(cluster, 2, "two of the five drawn");
      const more = page.locator(`.cc-tg-col .cc-tg-more[data-date="${DAY}"]`);
      assert.equal((await more.textContent()).trim(), "+3 more");
      // Reading order is day by day: the column's items, then its "+N more".
      const order = await page.evaluate((day) => {
        const col = document.querySelector(`.cc-tg-more[data-date="${day}"]`).closest(".cc-tg-col");
        return [...col.querySelectorAll("button")].map((el) => el.classList.contains("cc-tg-more") ? "more" : el.querySelector(".cc-card-title").textContent);
      }, DAY);
      assert.deepEqual(order, ["Morning group", "Second group", "Cluster 1", "Cluster 2", "more", "Quick talk"]);
      // A box with no end (30 minutes): its time and title on one line, the title drawn inside the box.
      const short = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".cc-tg-col .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === "Quick talk");
        const box = card.closest(".cc-tg-box").getBoundingClientRect();
        const title = card.querySelector(".cc-card-title").getBoundingClientRect();
        const time = card.querySelector(".cc-card-when").getBoundingClientRect();
        return { short: card.closest(".cc-tg-box").classList.contains("is-short"), inside: title.top >= box.top - 0.5 && title.bottom <= box.bottom + 0.5, oneLine: Math.abs(title.top + title.height / 2 - (time.top + time.height / 2)) <= 3, width: title.width };
      });
      assert.deepEqual([short.short, short.inside, short.oneLine], [true, true, true], `the short box shows its title on the time's line (${JSON.stringify(short)})`);
      assert.ok(short.width > 20, "the title has room");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, "no horizontal page scroll");
      // The narrowest box (a third of a week column): its start "10:00" is drawn whole inside the card's body.
      const narrow = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".cc-tg-box.is-narrow .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === "Cluster 1");
        const when = card.querySelector(".cc-card-when");
        const range = document.createRange();
        range.selectNodeContents(when);
        const text = range.getBoundingClientRect();
        const body = card.querySelector(".cc-card-body").getBoundingClientRect();
        return { boxWidth: card.closest(".cc-tg-box").getBoundingClientRect().width, textRight: text.right, bodyRight: body.right, text: when.innerText.trim() };
      });
      assert.match(narrow.text, /^10:00/, JSON.stringify(narrow));
      assert.ok(narrow.textRight <= narrow.bodyRight + 0.5, `"10:00" not cut in a ${narrow.boxWidth}px box (${JSON.stringify(narrow)})`);
      if (width === 1024) {
        // With the panel open the grid scrolls inside its own box, the page does not.
        await page.locator(".cc-tg-col .cc-card").first().click();
        await page.waitForSelector('[data-action="central-calendar-close-panel"]', { timeout: 20_000 });
        const scroll = await page.evaluate(() => {
          const grid = document.querySelector(".cc-timegrid");
          return { inner: grid.scrollWidth - grid.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
        });
        assert.equal(scroll.page, 0, "no page scroll with the panel open");
        assert.ok(scroll.inner > 0, `the grid scrolls in its box (${scroll.inner})`);
        // The narrowest case (mobile review): a third of a column still shows its start uncut, and "+3 more" fits.
        const when = await page.evaluate(() => {
          const card = [...document.querySelectorAll(".cc-tg-box.is-narrow .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === "Cluster 1");
          const el = card?.querySelector(".cc-card-when");
          if (!el) return { found: false, narrow: document.querySelectorAll(".cc-tg-box.is-narrow").length };
          return { found: true, fits: el.scrollWidth <= el.clientWidth + 1, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, visible: el.getBoundingClientRect().width > 0, text: el.innerText.trim() };
        });
        assert.ok(when.found && when.fits && when.visible, `a narrow box's start is not cut (${JSON.stringify(when)})`);
        assert.match(when.text, /^10:00/, JSON.stringify(when));
        const moreFits = await fits(page, ".cc-tg-col .cc-tg-more");
        assert.ok(moreFits.found && moreFits.fits, `"+3 more" fits its column (${JSON.stringify(moreFits)})`);
        if (process.env.K7_SHOTS) await page.screenshot({ path: `${process.env.K7_SHOTS}/week-1024-panel.png` });
        await page.click('[data-action="central-calendar-close-panel"]');
      }
      if (process.env.K7_SHOTS) await page.screenshot({ path: `${process.env.K7_SHOTS}/week-${width}.png`, fullPage: true });
      // "+3 more" shows the Day list with all of them.
      await page.locator(`.cc-tg-col .cc-tg-more[data-date="${DAY}"]`).click();
      await page.waitForSelector(".cc-day-list", { timeout: 20_000 });
      const titles = await page.evaluate(() => [...document.querySelectorAll(".cc-day-list .cc-card-title")].map((el) => el.textContent));
      for (const [title] of [...PAIR, ...CLUSTER]) assert.ok(titles.includes(title), `${title} in the Day list`);
      assert.equal(await page.locator(".cc-timegrid").count(), 0, "the list, not the Day grid");
      // The switch to Time grid on the Day view: the Day time grid, six columns, all five side by side.
      await page.click('[data-action="central-calendar-mode"][data-mode="grid"]');
      await page.waitForSelector(".cc-timegrid-day .cc-tg-col", { timeout: 20_000 });
      const dayGrid = await page.evaluate(() => ({
        cluster: [...document.querySelectorAll(".cc-tg-col .cc-card .cc-card-title")].filter((el) => el.textContent.startsWith("Cluster")).length,
        more: document.querySelectorAll(".cc-tg-col .cc-tg-more").length,
      }));
      assert.deepEqual(dayGrid, { cluster: 5, more: 0 }, "the Day view fits five");
      // A side-by-side card with room keeps its end time (UX review): the end hides only in a narrow box.
      const endShown = await page.evaluate(() => {
        const card = [...document.querySelectorAll(".cc-tg-col .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === "Morning group");
        const end = card.querySelector(".cc-card-when-end");
        return { visible: Boolean(end) && getComputedStyle(end).display !== "none", boxWidth: card.closest(".cc-tg-box").getBoundingClientRect().width };
      });
      assert.ok(endShown.visible, `the Day view's half-width card shows 00:00–01:00 (${JSON.stringify(endShown)})`);
      if (process.env.K7_SHOTS) await page.screenshot({ path: `${process.env.K7_SHOTS}/day-${width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(1280 px, touch) a tablet in landscape keeps 44 px targets: the short box and '+3 more'", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.desktop, { hasTouch: true });
  try {
    await openCalendar(page);
    await page.click('[data-action="central-calendar-mode"][data-mode="grid"]');
    await page.waitForSelector(".cc-timegrid .cc-tg-col", { timeout: 20_000 });
    const sizes = await page.evaluate(() => {
      const card = [...document.querySelectorAll(".cc-tg-col .cc-card")].find((el) => el.querySelector(".cc-card-title")?.textContent === "Quick talk");
      return {
        coarse: matchMedia("(pointer: coarse)").matches,
        short: card.getBoundingClientRect().height,
        more: document.querySelector(".cc-tg-col .cc-tg-more").getBoundingClientRect().height,
      };
    });
    assert.ok(sizes.coarse, "the context is a touch screen");
    assert.ok(sizes.short >= 44 && sizes.more >= 44, `44 px targets on touch (${JSON.stringify(sizes)})`);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(390 px) a team coach can switch List → Time grid → List without horizontal overflow", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", WIDTHS.phone);
  try {
    await openCalendar(page);
    await page.waitForSelector(".cc-strip", { timeout: 20_000 });
    assert.equal(await page.locator(".cc-timegrid").count(), 0);
    const modes = page.locator(".cc-mode-switch");
    const list = modes.getByRole("button", { name: "List", exact: true });
    const timeGrid = modes.getByRole("button", { name: "Time grid", exact: true });
    assert.equal(await list.getAttribute("aria-pressed"), "true");
    await timeGrid.click();
    const grid = page.locator(".cc-timegrid");
    await grid.waitFor({ state: "visible" });
    assert.equal(await timeGrid.getAttribute("aria-pressed"), "true");
    assert.equal(await grid.locator(".cc-timegrid-head").count(), 7);
    assert.equal(await grid.evaluate((element) => element.scrollWidth - element.clientWidth), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    await list.click();
    await page.locator(".cc-day-list").waitFor({ state: "visible" });
    assert.equal(await grid.count(), 0);
    assert.equal(await list.getAttribute("aria-pressed"), "true");
    assert.ok(await page.locator(".cc-day-list").count(), "the selected day's list");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
