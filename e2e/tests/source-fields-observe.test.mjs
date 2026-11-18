// G1b-2 end to end (docs/ai/gpexe-field-inventory-plan.md, sections 8.2 and 8.10): the platform admin compares a created
// field with the GPEXE screen and ticks it, in the browser, at 1280 and 390 px. A real check through the fake GPEXE source
// records the names (I1); route C creates two whole-session fields (GPEXE's words energy and energy_std, both J/kg); the
// next check keeps them; Compare with GPEXE shows two named athletes and the number to compare; the tick saves the unit
// stated by GPEXE. A club's admin is never offered it. Invented data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

const M = "/api/training-load/sources/metrics";
const G = "/api/training-load/gpexe";
let browser;
let world;
let prep;
const fields = {};

async function check() {
  const started = await prep.call("team_coach", "POST", `${G}/teams/${prep.teamId}/checks`, { from: "2026-11-01", to: "2026-11-08" });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 300; i += 1) {
    const r = await prep.call("team_coach", "GET", `${G}/teams/${prep.teamId}/checks/${started.body.check.id}`);
    if (r.body.check?.status && r.body.check.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check).slice(0, 300));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("the check did not finish");
}

before(async () => {
  browser = await launch();
  world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "inventory" } });
  prep = await prepareImports(world);
  for (const [name, label] of [["e2e_metabolic_energy", "E2E metabolic energy"], ["e2e_work_energy", "E2E work energy"]]) {
    const r = await prep.call("platform_admin", "POST", `${M}/fields`, { requestKey: crypto.randomUUID(), endpoint: "details.session", name, label, supportsSession: true, supportsDrill: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.revision.expectedSourceUnit, "J/kg");
    fields[name] = { id: r.body.field.id, label };
  }
  // The next check keeps the two fields in the stored sessions (the pinned set).
  await check();
});
after(async () => {
  await world?.stop?.();
  await browser?.close();
});

async function openField(page, fieldId) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.click('[data-action="training-load-section"][data-section="source-fields"]');
  await page.waitForSelector(`[data-action="source-fields-open"][data-field-id="${fieldId}"]`, { timeout: 20_000 });
  await page.click(`[data-action="source-fields-open"][data-field-id="${fieldId}"]`);
  await page.waitForSelector(".source-fields-revision", { timeout: 20_000 });
}

for (const [label, width, name] of [["1280 px", WIDTHS.desktop, "e2e_metabolic_energy"], ["390 px", WIDTHS.phone, "e2e_work_energy"]]) {
  test(`G1b-2 (${label}) the platform admin compares a created field with the GPEXE screen and ticks it: two named athletes, the number to compare, within the screen, 44 px targets; the unit is saved as stated by GPEXE`, async () => {
    const { context, page } = await openAs(browser, world, "platform_admin", width);
    page.on("dialog", (d) => d.accept());
    const ticks = [];
    page.on("request", (r) => { if (r.method() === "POST" && /observed-confirmation$/.test(r.url())) ticks.push(r.postDataJSON()); });
    try {
      await openField(page, fields[name].id);
      await page.click('[data-action="source-fields-observe-open"]');
      await page.waitForSelector('[data-source-fields-form="observe"] select[data-sf-field="teamId"]', { timeout: 20_000 });
      await page.selectOption('select[data-sf-field="teamId"]', prep.teamId);
      await page.click('[data-action="source-fields-observe-load"]');
      await page.waitForSelector(".source-fields-observe-athletes li", { timeout: 20_000 });
      const shown = await page.evaluate(() => {
        const select = document.querySelector('select[data-sf-field="teamId"]');
        const box = document.querySelector('[data-sf-field="attested"]');
        const sizes = [...document.querySelectorAll(".source-fields-form .source-fields-choice, .source-fields-form .data-sources-form-actions button, .source-fields-observe .plain-button")]
          .filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          selectHeight: Math.round(select.getBoundingClientRect().height),
          selectFont: getComputedStyle(select).fontSize,
          boxWidth: Math.round(box.getBoundingClientRect().width),
          sizes,
          lines: [...document.querySelectorAll(".source-fields-observe-athletes li")].map((li) => li.innerText.replace(/\s+/g, " ").trim()),
          text: document.querySelector(".source-fields-form").innerText.replace(/\s+/g, " "),
        };
      });
      assert.ok(shown.overflow <= 0, `nothing wider than the screen (${shown.overflow})`);
      assert.ok(shown.selectHeight >= 44 && shown.selectFont === "16px", `the team select is 44 px and 16 px text (${shown.selectHeight}, ${shown.selectFont})`);
      assert.ok(shown.boxWidth > 0 && shown.boxWidth <= 24, `the tick keeps its own size (${shown.boxWidth})`);
      assert.ok(shown.sizes.every((h) => h >= 44), `choices and buttons are 44 px (${shown.sizes})`);
      assert.equal(shown.lines.length, 2);
      for (const line of shown.lines) assert.match(line, /^.+: GPEXE may show this rounded or in another unit\. Compare the number: [0-9.]+ J\/kg\.$/);
      assert.match(shown.text, new RegExp(`find the value ${name} for these two athletes`));
      assert.match(shown.text, new RegExp(`GPEXE sends the unit word "${name === "e2e_metabolic_energy" ? "energy" : "energy_std"}" with this value; OptiMove reads it as J/kg\\.`));
      assert.doesNotMatch(shown.text, /\b10[1-3]\b|candidate|athlete id/i, "no GPEXE athlete id or internal word on the screen");
      // No save before the tick.
      await page.click('[data-source-fields-form="observe"] button[type="submit"]');
      await page.waitForSelector("#sf-err-attested");
      assert.equal(ticks.length, 0);
      await page.check('[data-sf-field="attested"]');
      await page.click('[data-source-fields-form="observe"] button[type="submit"]');
      await page.waitForFunction(() => /were saved from the comparison\./.test(document.querySelector(".source-fields")?.innerText || ""), null, { timeout: 20_000 });
      assert.equal(ticks.length, 1, "one request");
      assert.equal(ticks[0].attested, true);
      assert.equal(ticks[0].session.pairs.length, 2);
      await page.waitForSelector(".source-fields-revision", { timeout: 20_000 });
      await page.waitForFunction(() => /Comparisons with GPEXE/.test(document.querySelector(".source-fields")?.textContent || ""), null, { timeout: 20_000 });
      const detail = (await page.locator(".source-fields").textContent()).replace(/\s+/g, " ");
      assert.match(detail, /Unit stated by GPEXE, checked on the board/, detail.slice(0, 800));
      assert.match(detail, /Comparisons with GPEXE/);
      assert.match(detail, /Values GPEXE sent: [0-9.]+ and [0-9.]+ J\/kg/);
      assert.equal(await page.locator('[data-action="source-fields-observe-open"]').count(), 0, "no second comparison");
      const after = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(after <= 0, `the detail stays within the screen (${after})`);
    } finally {
      await context.close();
    }
  });
}

test("G1b-2 a club's admin is never offered the comparison, and its routes answer the identical 404", async () => {
  const { context, page } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openField(page, fields.e2e_metabolic_energy.id);
    assert.equal(await page.locator('[data-action="source-fields-observe-open"]').count(), 0);
    assert.doesNotMatch(await page.locator(".source-fields").innerText(), /Comparisons with GPEXE|Values GPEXE sent/);
  } finally {
    await context.close();
  }
  for (const path of [`${M}/fields/${fields.e2e_metabolic_energy.id}/observations`, `${M}/fields/${fields.e2e_metabolic_energy.id}/observation?teamId=${prep.teamId}`]) {
    const r = await prep.call("club_admin", "GET", path);
    assert.deepEqual([r.status, r.body], [404, { error: "notFound" }], path);
  }
});
