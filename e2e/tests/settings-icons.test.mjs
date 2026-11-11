// S7 in a real browser: Settings > Icons on a phone is a grid of tiles (icon, name, a 44 px Copy key), at least three
// to a row, with the category chips held at the top while the page scrolls; on a computer the layout is unchanged.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openIcons(page) {
  await openSettings(page);
  await page.locator('.settings-tabs [data-section="icons"]').first().click();
  await page.locator(".icon-gallery-item").first().waitFor();
}

const firstRow = () => {
  const items = [...document.querySelector(".icon-gallery-grid").children];
  const top = items[0].getBoundingClientRect().top;
  return items.filter((i) => Math.abs(i.getBoundingClientRect().top - top) < 2).length;
};

for (const width of [390, 360, 320]) test(`(team_coach, ${width} px) Icons is a grid of tiles and the chips stay at the top`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  try {
    await openIcons(page);
    assert.ok(await page.evaluate(firstRow) >= 3, "three tiles to a row");
    const tile = await page.evaluate(() => {
      const item = document.querySelector(".icon-gallery-item");
      const b = item.getBoundingClientRect(); const copy = item.querySelector('[data-action="icon-gallery-copy"]').getBoundingClientRect();
      return { h: b.height, copyW: copy.width, copyH: copy.height, w: b.width, words: getComputedStyle(item.querySelector(".icon-gallery-text > small")).display };
    });
    assert.ok(tile.h < 160, `a tile is ${tile.h} px tall`);
    assert.ok(tile.copyH >= 44 && tile.copyW >= tile.w - 20, "Copy key fills the tile and is 44 px");
    assert.equal(tile.words, "none");
    const small = await page.$$eval(".icon-gallery button, .icon-gallery input", (els) => els.filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height < 43.5; }).length);
    assert.equal(small, 0);
    const clipped = await page.$$eval(".icon-gallery-item button", (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 0.5).length);
    assert.equal(clipped, 0, "every Copy key label fits its button");
    assert.ok(await page.$eval(".icon-gallery-search input", (i) => parseFloat(getComputedStyle(i).fontSize)) >= 16);
    await page.evaluate(() => window.scrollTo(0, 2500));
    await page.waitForTimeout(200);
    const chips = await page.$eval("[data-icon-gallery-chips]", (c) => { const b = c.getBoundingClientRect(); return { top: Math.round(b.top), right: b.right, scroll: c.scrollWidth > c.clientWidth }; });
    assert.equal(chips.top, 0, "the chips stay at the top");
    assert.ok(chips.scroll && chips.right <= width, "one row that scrolls sideways inside the page");
    const tallest = await page.$$eval(".icon-gallery-item", (items) => Math.max(...items.map((i) => i.getBoundingClientRect().height)));
    assert.ok(tallest < 200, `the tallest tile is ${tallest} px`);
    await page.locator('[data-icon-gallery-chips] .icon-picker-chip').nth(2).click();
    await page.waitForTimeout(200);
    const seen = await page.evaluate(() => {
      const chips = document.querySelector("[data-icon-gallery-chips]").getBoundingClientRect();
      const count = document.querySelector("[data-icon-gallery-count]").getBoundingClientRect();
      const first = document.querySelector(".icon-gallery-item").getBoundingClientRect();
      return { chipsTop: chips.top, chipsBottom: chips.bottom, countTop: count.top, firstTop: first.top, firstBottom: first.bottom };
    });
    assert.ok(seen.chipsTop >= 0, "the chips are still on screen");
    assert.ok(seen.countTop >= seen.chipsBottom - 1 && seen.countTop < 844, "a chip tapped from deep in the list shows its count line under the chips");
    assert.ok(seen.firstTop >= seen.chipsBottom - 1 && seen.firstBottom <= await page.evaluate(() => window.innerHeight), "and the first tile of its result");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(team_coach, 360 px) a refused Copy key shows the key inside its tile", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 360);
  try {
    await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("refused")) }, configurable: true }); });
    await page.reload();
    await openIcons(page);
    const item = page.locator(".icon-gallery-item").filter({ hasText: "battery-half" }).first();
    await item.locator('[data-action="icon-gallery-copy"]').click();
    await item.locator("[data-icon-gallery-refused]").waitFor();
    const box = await item.evaluate((i) => {
      const r = i.getBoundingClientRect(); const m = i.querySelector("[data-icon-gallery-refused]").getBoundingClientRect();
      return { visible: m.height > 0, inside: m.left >= r.left - 0.5 && m.right <= r.right + 0.5, text: i.querySelector("[data-icon-gallery-refused]").textContent };
    });
    assert.ok(box.visible && box.inside, JSON.stringify(box));
    assert.match(box.text, /icon:battery-half/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(club_admin, 1280 px) Icons on a computer keeps its list rows", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", 1280);
  try {
    await openIcons(page);
    const item = await page.$eval(".icon-gallery-item", (i) => ({ dir: getComputedStyle(i).flexDirection, h: i.getBoundingClientRect().height, words: getComputedStyle(i.querySelector(".icon-gallery-text > small")).display }));
    assert.equal(item.dir, "row");
    assert.ok(item.h < 80);
    assert.notEqual(item.words, "none");
    assert.equal(await page.$eval("[data-icon-gallery-chips]", (c) => getComputedStyle(c).position), "static");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
