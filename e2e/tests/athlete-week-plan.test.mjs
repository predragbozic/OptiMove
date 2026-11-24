// Athlete Home and Weekly plan (owner, 2026-11-16, items 2 and 4), in the real athlete app. Home has one week strip and one
// button in its "This week" row, named for what waits; the Weekly plan on a phone is one day under another, nothing cut
// off or scrolled sideways, and a week with nothing planned is one sentence. Planned weeks come from a read the test
// answers (the demo athlete has none); everything else is the real server.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
const weekDays = () => Array.from({ length: 7 }, (_, i) => { const d = monday(); d.setDate(d.getDate() + i); return iso(d); });

async function openAthlete(width, { trainingWeek, planWeek } = {}) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  if (trainingWeek) {
    await page.route("**/api/training-load/weekly*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(trainingWeek) }));
  }
  if (planWeek) {
    await page.route("**/program-data?program=__weekly__*", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.weeks = [...(body.weeks || []).filter((w) => w.weekStart !== planWeek.weekStart), planWeek];
      await route.fulfill({ response: res, json: body });
    });
  }
  await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
  await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  const under44 = (selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height < 43.5; }).map((e) => `${(e.innerText || "").trim()} ${Math.round(e.getBoundingClientRect().height)}`), selector);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const weeklyPlan = async () => {
    await navTo(page, '.sidebar [data-athlete-tab="calendar"]');
    await page.locator(".calendar-day, .calendar-week-empty").first().waitFor({ timeout: 20_000 });
  };
  return { context, page, pageErrors, under44, overflow, weeklyPlan };
}

test("Home (390 px): one week strip; 'Rate your sessions (2)' while two sessions of the week wait, and it opens the sheet", async () => {
  const days = weekDays();
  const today = iso(new Date());
  const later = days.find((d) => d > today);
  const session = (id, rated) => ({ sessionId: id, sessionName: "Training", sessionTime: "10:00:00", rated, ...(rated ? { feedback: { rpe: 6, durationMinutes: 60, srpe: 360 } } : {}) });
  const trainingWeek = {
    weekStart: days[0], weekEnd: days[6],
    // Today holds two unrated sessions and a rated one (whatever weekday today is); a later day's session never counts.
    days: days.map((date) => ({ date, sessions: date === today ? [session("s1", false), session("s2", true), session("s3", false)] : date === later ? [session("s4", false)] : [] })),
  };
  const a = await openAthlete(390, { trainingWeek });
  try {
    const button = a.page.locator(".athlete-home-week-head .training-load-week-button");
    await a.page.waitForFunction(() => /Rate your sessions \(2\)/.test(document.querySelector(".athlete-home-week-head .training-load-week-button")?.textContent || ""), null, { timeout: 15_000 });
    assert.equal(await a.page.locator(".athlete-home-week-strip").count(), 1, "one week strip");
    assert.equal(await a.page.locator(".training-load-week-link").count(), 0, "the old link is gone");
    assert.deepEqual(await a.under44(".athlete-home-week-head .training-load-week-button"), []);
    const row = await a.page.evaluate(() => { const h = document.querySelector(".athlete-home-week-head"); const e = h.querySelector(".eyebrow").getBoundingClientRect(); const b = h.querySelector("button").getBoundingClientRect(); return { sameRow: Math.abs((e.top + e.bottom) / 2 - (b.top + b.bottom) / 2) < 8, right: b.right <= innerWidth }; });
    assert.ok(row.sameRow && row.right, `the button sits in the This week row: ${JSON.stringify(row)}`);
    assert.equal(await a.overflow(), 0);
    await button.click();
    await a.page.locator(".training-load-athlete-weekly-panel").waitFor({ timeout: 10_000 });
    // It lands where its promise is: the week's first day that waits (today here), with its sessions to rate.
    await a.page.waitForSelector(`.training-load-weekly-day.is-selected[data-date="${today}"]`, { timeout: 10_000 });
    assert.equal(await a.page.locator('.training-load-weekly-agenda [data-action="training-load-open-rpe-form"]').count(), 2);
    assert.deepEqual(a.pageErrors, []);
  } finally { await a.context.close(); }
});

for (const width of [360, 390]) {
  test(`Weekly plan (${width} px): one day under another, nothing cut or sideways; an empty week is one sentence`, async () => {
    const days = weekDays();
    const item = (id, amPm, section) => ({ id, amPm, bta: "T", domain: "", category: "", section, exercise_name: section, name: section });
    const planWeek = { weekStart: days[0], weekEnd: days[6], days: days.map((date, i) => ({ date, dayNote: i === 2 ? "Match preparation" : i === 4 ? "Match day" : "", slots: i === 0 ? { AM: { T: [item("e1", "AM", "Warm-up"), item("e2", "AM", "Strength")] } } : i === 2 ? { PM: { T: [item("e3", "PM", "Speed")] } } : {} })) };
    const planned = await openAthlete(width, { planWeek });
    try {
      await planned.weeklyPlan();
      const look = await planned.page.evaluate(() => {
        const grid = document.querySelector(".calendar-grid");
        const tops = [...grid.querySelectorAll(".calendar-day")].map((d) => Math.round(d.getBoundingClientRect().top));
        const range = [...document.querySelectorAll(".week-title-button strong")].find((s) => s.offsetParent);
        return { days: tops.length, oneUnderAnother: tops.every((t, i) => i === 0 || t > tops[i - 1]), sideways: grid.scrollWidth > grid.clientWidth + 1, range: range.innerText.trim(), rangeCut: range.scrollWidth > range.clientWidth + 1, empties: [...grid.querySelectorAll(".calendar-empty")].map((e) => e.innerText.trim()) };
      });
      assert.equal(look.days, 7);
      assert.ok(look.oneUnderAnother, "one day under another");
      assert.equal(look.sideways, false, "no sideways scroll");
      assert.equal(look.rangeCut, false, `the range is not cut: ${look.range}`);
      assert.ok(look.empties.length === 4 && look.empties.every((t) => t === "Nothing planned"), JSON.stringify(look.empties));
      // A day with only a note shows the note, never "Nothing planned" beside it (UX review).
      const noteDay = planned.page.locator(`.calendar-day[data-date="${days[4]}"]`);
      assert.match(await noteDay.innerText(), /Match day/);
      assert.doesNotMatch(await noteDay.innerText(), /Nothing planned/);
      assert.deepEqual(await planned.under44(".week-nav-panel button"), [], "the week controls");
      // A day brought into view lands below the sticky header and week controls: the shared height variable resolves
      // (an undefined variable would make the whole margin 0).
      const margin = await planned.page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".calendar-day")).scrollMarginTop));
      assert.ok(margin >= 61 + 12, `scroll margin ${margin}px`);
      assert.equal(await planned.overflow(), 0);
      assert.deepEqual(planned.pageErrors, []);
    } finally { await planned.context.close(); }

    const empty = await openAthlete(width);
    try {
      await empty.weeklyPlan();
      assert.equal((await empty.page.locator(".calendar-week-empty").innerText()).trim(), "Nothing is planned this week.");
      assert.equal(await empty.page.locator(".calendar-day").count(), 0, "no seven empty days");
      assert.equal(await empty.overflow(), 0);
      assert.deepEqual(empty.pageErrors, []);
    } finally { await empty.context.close(); }
  });
}
