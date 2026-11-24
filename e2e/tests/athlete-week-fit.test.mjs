// The athlete's Weekly plan on a computer (owner's report, 2026-11-22): the seven days and the week header fit the window,
// nothing is cut off on the right and the page never scrolls sideways. 1745 px and 1536 px are a 1920 px screen at 110% and
// 125% browser zoom. A week with long names and notes is the worst case; the days share the width instead of a strip of
// 165 px days that scrolled inside the panel. The athlete's menu is a fixed rail on a computer (there is no open / closed
// state to toggle), so the menu check is the rail's own width in the measurement.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
const weekDays = () => Array.from({ length: 7 }, (_, i) => { const d = monday(); d.setDate(d.getDate() + i); return iso(d); });

async function measure(width) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const days = weekDays();
  const item = (id, amPm, section) => ({ id, amPm, bta: "T", domain: "", category: "", section, exercise_name: section, name: section });
  const planWeek = {
    weekStart: days[0], weekEnd: days[6],
    days: days.map((date, i) => ({
      date,
      dayNote: `Match preparation with a long note about travel, meals and recovery ${"x".repeat(i === 3 ? 40 : 0)}`,
      slots: { AM: { T: [item(`a${i}`, "AM", "Warm-up mobility and activation circuit with a very long exercise name"), item(`b${i}`, "AM", "Strength lower body")] }, PM: { T: [item(`c${i}`, "PM", "Speed")] } },
    })),
  };
  await page.route("**/program-data?program=__weekly__*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.weeks = [...(body.weeks || []).filter((w) => w.weekStart !== planWeek.weekStart), planWeek];
    await route.fulfill({ response: res, json: body });
  });
  try {
    await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
    await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
    await navTo(page, '.sidebar [data-athlete-tab="calendar"]');
    await page.locator(".calendar-day").first().waitFor({ timeout: 20_000 });
    // The reported path: pressing Today scrolls the week to its day, and on the old strip layout that gave the grid
    // about 1,200 px of trailing space (Saturday cut, Sunday out of reach).
    await page.click('[data-action="week-today"]');
    await page.waitForTimeout(1000);
    const look = await page.evaluate(() => {
      const grid = document.querySelector(".calendar-grid");
      const days = [...grid.querySelectorAll(".calendar-day")];
      const nav = document.querySelector(".week-nav-panel").getBoundingClientRect();
      const lastDay = days[days.length - 1].getBoundingClientRect();
      return {
        days: days.length,
        pageSideways: document.documentElement.scrollWidth - innerWidth,
        gridSideways: grid.scrollWidth - grid.clientWidth,
        actionsRight: Math.round(document.querySelector(".topbar-actions").getBoundingClientRect().right),
        padRight: getComputedStyle(grid).paddingRight,
        lastDayRight: Math.round(lastDay.right),
        navRight: Math.round(nav.right),
        innerWidth,
      };
    });
    return { look, pageErrors };
  } finally { await context.close(); }
}

for (const width of [1920, 1745, 1536, 1440, 1280, 490, 390, 360]) {
  test(`Weekly plan (${width} px): seven days and the header inside the window, no sideways scroll`, async () => {
    const { look, pageErrors } = await measure(width);
    assert.equal(look.days, 7);
    assert.ok(look.pageSideways <= 0, `the page scrolls sideways by ${look.pageSideways}px`);
    assert.ok(look.gridSideways <= 1, `the week scrolls inside its panel by ${look.gridSideways}px`);
    assert.ok(look.lastDayRight <= look.innerWidth, `Sunday ends at ${look.lastDayRight} of ${look.innerWidth}`);
    assert.ok(look.navRight <= look.innerWidth, `the week header ends at ${look.navRight} of ${look.innerWidth}`);
    if (width >= 1180) assert.equal(look.padRight, "0px", "no trailing space left on the week");
    assert.deepEqual(pageErrors, []);
  });
}

// A narrow computer window (a heavily zoomed browser) keeps the strip of days, but the page itself never grows wider than
// the window: the hero and its tabs used to hold two 360 px columns.
test("Weekly plan (800 px): the page does not grow wider than the window", async () => {
  const { look } = await measure(800);
  assert.ok(look.pageSideways <= 0, `the page scrolls sideways by ${look.pageSideways}px`);
  assert.ok(look.navRight <= look.innerWidth, `the week header ends at ${look.navRight} of ${look.innerWidth}`);
});

// An athlete who also holds another workspace gets the workspace chip in the header. On a 360 px phone the chip, its menu
// and the actions row kept their full width, so the bell and sign-out ran past the window (the layout viewport grew to 368 px).
test("Weekly plan (360, 390, 490 px) of an athlete who also coaches: the header and the week stay inside the window", async () => {
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    const athlete = world.accounts.find((a) => a.role === "athlete");
    await client.query("insert into public.user_global_roles (user_id, role, is_active) values ($1, 'independent_coach', true)", [athlete.id]);
  } finally { await client.end(); }
  for (const width of [490, 390, 360]) {
    const { look } = await measure(width);
    assert.equal(look.innerWidth, width, `the window grew to ${look.innerWidth} px at ${width}`);
    assert.ok(look.actionsRight <= width, `the header buttons end at ${look.actionsRight} of ${width}`);
    assert.ok(look.pageSideways <= 0 && look.gridSideways <= 1 && look.navRight <= width, JSON.stringify(look));
  }
});
