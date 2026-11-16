// I1-I3 end to end (docs/ai/gpexe-field-inventory-plan.md, sections 1 and 7): a real check through the fake GPEXE source
// records the names its answers carried (I1, v72); Source fields lists the ones no field covers yet (I2's read, I3's
// screen). Club A's admin sees them in plain words at 1280, 390 and 360 px with nothing wider than the screen and
// 44 px targets; the platform admin also opens the team thresholds' fold; another club's admin sees none of club A's
// names. Read-only: no write is sent from the list. Invented data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
let world;
before(async () => {
  browser = await launch();
  world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  await prepareImports(world);
});
after(async () => {
  await world?.stop?.();
  await browser?.close();
});

async function openSourceFields(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.click('[data-action="training-load-section"][data-section="source-fields"]');
  await page.waitForSelector("#sf-inventory-title", { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".source-fields-inventory [role=status]"), null, { timeout: 20_000 });
}

async function layout(page) {
  return page.evaluate(() => {
    const sizes = (selector) => [...document.querySelectorAll(selector)].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
    const search = document.querySelector("[data-sf-inv-search]");
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      chips: sizes(".source-fields-inventory-chips .chip"),
      toggle: sizes(".source-fields-inventory-tools .source-fields-choice"),
      searchHeight: search ? Math.round(search.getBoundingClientRect().height) : 0,
      searchFont: search ? getComputedStyle(search).fontSize : "",
      rows: document.querySelectorAll("[data-sf-inv-row]").length,
      text: document.querySelector(".source-fields-inventory")?.innerText.replace(/\s+/g, " ") || "",
    };
  });
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`I3 (${label}) club A's admin sees the names GPEXE sent that no field covers, in plain words, within the screen`, async () => {
    const { context, page } = await openAs(browser, world, "club_admin", width);
    const writes = [];
    page.on("request", (r) => { if (r.method() !== "GET" && /sources\/metrics/.test(r.url())) writes.push(r.url()); });
    try {
      await openSourceFields(page);
      const l = await layout(page);
      assert.ok(l.rows > 0, "the check recorded names that no field covers");
      assert.match(l.text, /Names GPEXE sent in this club's sessions that OptiMove cannot map yet\./);
      assert.match(l.text, /seen in \d+ answers?, last \d{2}\.\d{2}\.\d{4}/);
      assert.doesNotMatch(l.text, /athlete_session|details\.session|more\.events|unit_value_object|connection/, "plain words; no connection count for a club");
      assert.ok(l.overflow <= 0, `nothing wider than the screen (overflow ${l.overflow})`);
      assert.ok(l.chips.length >= 6 && l.chips.every((h) => h >= 44), `chips are 44 px (${l.chips})`);
      assert.ok(l.toggle.every((h) => h >= 44), `the toggle is 44 px (${l.toggle})`);
      assert.ok(l.searchHeight >= 44 && l.searchFont === "16px", `the search is 44 px and 16 px text (${l.searchHeight}, ${l.searchFont})`);
      // A chip narrows to one source of names; the search narrows in place.
      await page.click('[data-action="source-fields-inv-endpoint"][data-endpoint="athlete_session"]');
      await page.waitForFunction(() => document.querySelector('[data-endpoint="athlete_session"]')?.getAttribute("aria-pressed") === "true");
      await page.waitForFunction(() => !document.querySelector(".source-fields-inventory [role=status]"));
      const facts = await page.locator("[data-sf-inv-row] .metric-variables-item-facts").allInnerTexts();
      assert.ok(facts.length > 0 && facts.every((f) => f.startsWith("Athlete row")), "only athlete-row names");
      await page.fill("[data-sf-inv-search]", "zzz-no-such-name");
      await page.waitForSelector("#sf-inv-no-match:not([hidden])");
      assert.equal(writes.length, 0, "the list only reads");
    } finally {
      await context.close();
    }
  });
}

test("I3 the platform admin opens the team thresholds' fold; another club's admin sees none of club A's names", async () => {
  const pa = await openAs(browser, world, "platform_admin", WIDTHS.desktop);
  try {
    await openSourceFields(pa.page);
    assert.match(await pa.page.locator(".source-fields-inventory").innerText(), /every club's sessions/);
    await pa.page.click(".source-fields-inventory-thresholds summary");
    await pa.page.click('[data-action="source-fields-inv-thresholds"]');
    await pa.page.waitForFunction(() => document.querySelector("[data-sf-threshold-row]") || /No team thresholds yet/.test(document.querySelector(".source-fields-inventory-thresholds")?.innerText || ""), null, { timeout: 20_000 });
  } finally {
    await pa.context.close();
  }
  const other = await openAs(browser, world, "other_club_admin", WIDTHS.desktop);
  try {
    await openSourceFields(other.page);
    assert.equal(await other.page.locator("[data-sf-inv-row]").count(), 0);
    assert.match(await other.page.locator(".source-fields-inventory").innerText(), /No names yet/);
  } finally {
    await other.context.close();
  }
});
