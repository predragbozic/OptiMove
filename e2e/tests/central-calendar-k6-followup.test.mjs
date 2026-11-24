// K6 follow-up (2026-11-22, after the owner used K6 live), in the real app:
// 1. the Weekly plan's ‹ › page through the athletes and the chosen pill stays in view (it used to be redrawn at
//    scroll 0, so the strip showed the first athletes);
// 2. a computer's calendar box and the Weekly plan's strip can be hidden, remembered per user; a phone's calendar box
//    stays open while the arrows page through the athletes.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    const { clubA, teamA } = world.ids;
    // Enough athletes that the strip scrolls sideways on every width.
    for (let i = 0; i < 30; i += 1) {
      const name = `Zed${String.fromCharCode(97 + (i % 26))}${i} Example`;
      const id = (await db.query(
        `insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone) values (nextval('public.athlete_generated_id_seq')::text, $1, 'Example', $2, $2, 'Europe/Sarajevo') returning id`,
        [name.split(" ")[0], name])).rows[0].id;
      await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [id, clubA]);
      await db.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [id, clubA, teamA]);
    }
  } finally {
    await db.end();
  }
});
after(async () => { await browser?.close(); await world?.stop(); });

async function openCalendar(page, width) {
  await navTo(page, "#calendarToggle");
  await page.waitForSelector(".central-calendar .athlete-switcher", { timeout: 20_000 });
  await openFold(page, width);
}
async function openFold(page, width) {
  if (width < 761) {
    const fold = page.locator(".athlete-switcher-fold");
    if ((await fold.getAttribute("aria-expanded")) !== "true") await fold.click();
  }
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
const activeInView = (page, scope) => page.evaluate((s) => {
  const box = document.querySelector(`${s} .builder-batch-pills`);
  const pill = box?.querySelector(".is-active");
  if (!pill) return false;
  const a = pill.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return a.left >= b.left - 1 && a.right <= b.right + 1;
}, scope);
const small = (page, scope) => page.evaluate((s) => [...document.querySelectorAll(`${s} button, ${s} input`)].filter((el) => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.height < 43.5;
}).map((el) => `${(el.getAttribute("aria-label") || el.textContent || el.className).trim().slice(0, 30)} ${Math.round(el.getBoundingClientRect().height)}`), scope);
const weeklyName = (page) => page.locator(".weekly-k6-summary strong").innerText();
const lineName = (page) => page.evaluate(() => (document.querySelector(".cc-athlete-line strong")?.textContent || ""));

async function openWeekOfAna(page, width) {
  await openCalendar(page, width);
  await page.locator('.athlete-switcher .builder-batch-pill[aria-label="Ana Example"]').click();
  await page.waitForSelector(".cc-athlete-line");
  await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
  await page.waitForSelector(".weekly-k6");
  assert.equal(await weeklyName(page), "Ana Example");
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`(${label}) Weekly plan: › and ‹ page through the athletes and the chosen pill stays in view`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openWeekOfAna(page, width);
      const seen = [await weeklyName(page)];
      for (let i = 0; i < 14; i += 1) {
        const before = await weeklyName(page);
        await page.locator('.weekly-k6 .icon-button[aria-label="Next athlete"]').click();
        await page.waitForFunction((name) => document.querySelector(".weekly-k6-summary strong")?.textContent !== name, before, { timeout: 15_000 });
        seen.push(await weeklyName(page));
        assert.ok(await activeInView(page, ".weekly-k6"), `the chosen pill (${seen.at(-1)}) is in view after › ${i + 1}`);
      }
      assert.equal(new Set(seen).size, seen.length, "every › moved to a new athlete, none went back to the first");
      const last = seen.at(-1);
      await page.locator('.weekly-k6 .icon-button[aria-label="Previous athlete"]').click();
      await page.waitForFunction((name) => document.querySelector(".weekly-k6-summary strong")?.textContent !== name, last, { timeout: 15_000 });
      assert.equal(await weeklyName(page), seen.at(-2), "‹ goes back by one");
      assert.ok(await activeInView(page, ".weekly-k6"));
      assert.deepEqual(await small(page, ".weekly-k6"), []);
      assert.equal(await overflow(page, width), 0);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("(1280 px) a computer's calendar box and the Weekly strip can be hidden, remembered per user", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openCalendar(page, WIDTHS.desktop);
    await page.locator('.athlete-switcher .builder-batch-pill[aria-label="Bojan Example"]').click();
    await page.waitForSelector(".cc-athlete-line");
    const hide = page.locator(".athlete-switcher-hide");
    assert.equal(await hide.innerText(), "Hide athletes");
    await hide.click();
    await page.waitForFunction(() => document.querySelector(".athlete-switcher.is-collapsed"));
    assert.equal(await page.locator(".athlete-switcher .builder-batch-pills").isVisible(), false, "the strip is gone");
    assert.match(await page.locator(".athlete-switcher-head-text").innerText(), /Bojan Example/, "who is chosen stays");
    assert.equal(await page.locator(".athlete-switcher-hide").innerText(), "Show athletes");
    assert.equal(await page.locator(".athlete-switcher-hide").getAttribute("aria-expanded"), "false");
    assert.deepEqual(await small(page, ".athlete-switcher"), []);
    // Remembered across a reload.
    await page.reload();
    await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
    await page.locator("#calendarToggle").click();
    await page.waitForSelector(".central-calendar .athlete-switcher");
    assert.equal(await page.locator(".athlete-switcher.is-collapsed").count(), 1, "still hidden after a reload");
    await page.locator(".athlete-switcher-hide").click();
    await page.locator(".athlete-switcher .builder-batch-pills").waitFor({ state: "visible" });
    assert.equal(await page.locator(".athlete-switcher-hide").innerText(), "Hide athletes");
    // The Weekly strip: its own choice.
    await page.locator('.athlete-switcher .builder-batch-pill[aria-label="Ana Example"]').click();
    await page.waitForSelector(".cc-athlete-line");
    await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
    await page.waitForSelector(".weekly-k6");
    assert.equal(await page.locator(".weekly-k6 .builder-batch-pills").count(), 1);
    await page.locator(".weekly-k6-strip-toggle").click();
    await page.waitForFunction(() => !document.querySelector(".weekly-k6 .builder-batch-pills"));
    assert.equal(await weeklyName(page), "Ana Example", "who is chosen stays");
    assert.equal(await page.locator(".weekly-k6-strip-toggle").innerText(), "Show athletes");
    assert.deepEqual(await small(page, ".weekly-k6"), []);
    // Back to the calendar and into a week again: still hidden (the preference, not the flow).
    await page.locator("[data-action='weekly-back-to-calendar']").click();
    await page.waitForSelector(".central-calendar .athlete-switcher");
    await page.locator(".cc-athlete-line [data-action='central-calendar-open-athlete']").click();
    await page.waitForSelector(".weekly-k6");
    assert.equal(await page.locator(".weekly-k6 .builder-batch-pills").count(), 0);
    await page.locator(".weekly-k6-strip-toggle").click();
    await page.waitForSelector(".weekly-k6 .builder-batch-pills");
    assert.ok(await activeInView(page, ".weekly-k6"));
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("(1280 px) the screen works when storage is blocked", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } });
    });
    await page.reload();
    await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
    await page.locator("#calendarToggle").click();
    await page.waitForSelector(".central-calendar .athlete-switcher");
    await page.locator(".athlete-switcher-hide").click();
    await page.waitForSelector(".athlete-switcher.is-collapsed");
    await page.locator(".athlete-switcher-hide").click();
    await page.locator(".athlete-switcher .builder-batch-pills").waitFor({ state: "visible" });
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test("(390 px) the phone's calendar box stays open while › pages through the athletes", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", WIDTHS.phone);
  try {
    await openCalendar(page, WIDTHS.phone);
    assert.equal(await page.locator(".athlete-switcher-hide").count(), 0, "a phone keeps its own fold");
    const names = [];
    for (let i = 0; i < 3; i += 1) {
      await page.locator('.athlete-switcher .icon-button[aria-label="Next athlete"]').click();
      await page.waitForFunction((n) => (document.querySelector(".cc-athlete-line strong")?.textContent || "") !== "" && n.indexOf(document.querySelector(".cc-athlete-line strong").textContent) < 0, names, { timeout: 15_000 });
      names.push(await lineName(page));
      assert.equal(await page.locator(".athlete-switcher-fold").getAttribute("aria-expanded"), "true", "the box stays open after ›");
    }
    assert.equal(new Set(names).size, 3, "three different athletes with no re-opening");
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`(${label}) the calendar strip (guard): after every › the chosen pill is inside the strip's visible box`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openCalendar(page, width);
      const seen = [];
      for (let i = 0; i < 14; i += 1) {
        await openFold(page, width);
        await page.locator('.athlete-switcher .icon-button[aria-label="Next athlete"]').click();
        await page.waitForFunction((n) => (document.querySelector(".cc-athlete-line strong")?.textContent || "") !== "" && !n.includes(document.querySelector(".cc-athlete-line strong").textContent), seen, { timeout: 15_000 });
        seen.push(await lineName(page));
        await page.waitForTimeout(150);
        assert.ok(await activeInView(page, ".athlete-switcher"), `the chosen pill (${seen.at(-1)}) is in view after › ${i + 1}`);
      }
      assert.equal(new Set(seen).size, 14);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
