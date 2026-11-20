// v80 step C end to end (docs/ai/v80-condition-match-plan.md, section 10), against the real server on a disposable
// database with the fake GPEXE source's "events" sessions (a details acceleration events count; the team's events
// setting 2.5 m/s² lasting 0.3 s). Route C creates the events field and route O compares it (through the API: the
// comparison screen has its own scenario). Then, in the browser:
//   * the club's admin sees the club's Accelerations (>= 2.5 m/s² lasting 0.3 s) on the board waiting for GPEXE's setting
//     to be confirmed, and the Source fields block read-only;
//   * the platform admin opens the field at 390 and 360 px (no horizontal scroll, 16 px fields, 44 px buttons, no value
//     of OptiMove's own in the form), and at 1280 px types 2,5 and 0,3 and confirms: one request, the confirmed sentence;
//   * the club's admin's board then offers the column for Accelerations.
// Invented data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

const M = "/api/training-load/sources/metrics";
const G = "/api/training-load/gpexe";
const ACC = "Accelerations (E2E)";
let browser;
let world;
let prep;
let fieldId;
let variableId;

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
  world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "events" } });
  prep = await prepareImports(world);
  const made = await prep.call("platform_admin", "POST", `${M}/fields`, { requestKey: randomUUID(), endpoint: "details.session", name: "acceleration_events", label: "Acceleration events", supportsSession: true, supportsDrill: false });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  fieldId = made.body.field.id;
  const revisionId = made.body.revision.id;
  // The next check keeps the field in the stored sessions; then route O compares it (the owner's comparison).
  await check();
  const read = await prep.call("platform_admin", "GET", `${M}/fields/${fieldId}/observation?teamId=${prep.teamId}`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const o = read.body.observation;
  assert.equal(o.confirmable, true, JSON.stringify(o));
  const tick = await prep.call("platform_admin", "POST", `${M}/fields/${fieldId}/revisions/${revisionId}/observed-confirmation`, {
    requestKey: randomUUID(), session: { candidateId: o.session.candidateId, pairs: [...o.pair.positions], placementHash: o.placementHash }, attested: true,
  });
  assert.ok([200, 201].includes(tick.status), JSON.stringify(tick.body));
  const v = await prep.call("club_admin", "POST", `${M}/variables`, { requestKey: randomUUID(), label: ACC, levels: ["session"], unit: "count", dailyAggregationMethod: "sum",
    condition: { kind: "event_threshold", operator: ">=", value: "2.5", durationSeconds: "0.3", unit: "m/s2" } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  variableId = v.body.variable.id;
});
after(async () => {
  await world?.stop?.();
  await browser?.close();
});

async function openField(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.click('[data-action="training-load-section"][data-section="source-fields"]');
  await page.waitForSelector(`[data-action="source-fields-open"][data-field-id="${fieldId}"]`, { timeout: 20_000 });
  await page.click(`[data-action="source-fields-open"][data-field-id="${fieldId}"]`);
  await page.waitForSelector(".source-fields-event-setting", { timeout: 20_000 });
}
async function openBoard(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.click('[data-action="training-load-section"][data-section="board"]');
  await page.waitForSelector("[data-mb-board]", { timeout: 20_000 });
}
const plain = async (locator) => (await locator.innerText()).replace(/\s+/g, " ");

test("C2 (1280 px) before the confirmation: the club's Accelerations waits for GPEXE's setting, named with its column; the club's admin reads the Source fields block without a form", async () => {
  const { context, page } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openBoard(page);
    const slot = page.locator(".mb-slot", { hasText: ACC });
    await slot.waitFor({ timeout: 20_000 });
    assert.match(await plain(slot), /Counts only .*2\.5.*0\.3 s.* Acceleration events has this setting and waits for GPEXE's setting to be confirmed in Source fields\./);
    assert.equal(await page.locator(`[data-mb-drop-variable][data-variable-id="${variableId}"]`).count(), 0, "no drop target while it waits");
    await openField(page);
    assert.match(await plain(page.locator(".source-fields-event-setting")), /Compared with GPEXE\. A platform administrator still confirms GPEXE's acceleration events setting\. Until then this column fills no variable with a condition\./);
    assert.equal(await page.locator('[data-action="source-fields-event-open"]').count(), 0);
  } finally {
    await context.close();
  }
});

for (const [label, width] of [["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`C1 (${label}) the platform admin's form: within the screen, 16 px fields, 44 px buttons, nothing filled in and no value of OptiMove's own; Cancel sends nothing`, async () => {
    const { context, page } = await openAs(browser, world, "platform_admin", width);
    const posts = [];
    page.on("request", (r) => { if (r.method() === "POST" && /event-setting-confirmation$/.test(r.url())) posts.push(r.url()); });
    try {
      await openField(page);
      assert.match(await plain(page.locator(".source-fields-event-setting")), /In GPEXE, open the team's settings and enter the acceleration events threshold and duration it shows\./);
      await page.click('[data-action="source-fields-event-open"]');
      await page.waitForSelector('[data-source-fields-form="event"]', { timeout: 20_000 });
      const shown = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('[data-source-fields-form="event"] input')];
        const buttons = [...document.querySelectorAll('[data-source-fields-form="event"] button')].filter((b) => b.offsetParent);
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          fonts: inputs.map((i) => getComputedStyle(i).fontSize),
          values: inputs.map((i) => i.value),
          heights: buttons.map((b) => Math.round(b.getBoundingClientRect().height)),
          text: document.querySelector('[data-source-fields-form="event"]').innerText.replace(/\s+/g, " "),
        };
      });
      assert.ok(shown.overflow <= 0, `no horizontal scroll (${shown.overflow})`);
      assert.deepEqual(shown.fonts, ["16px", "16px"]);
      assert.deepEqual(shown.values, ["", ""]);
      assert.ok(shown.heights.every((h) => h >= 44), `buttons ${shown.heights}`);
      assert.equal(/\b2\.5\b|\b0\.3\b/.test(shown.text.replace(/for example 2\.5|for example 0\.3/g, "")), false, shown.text);
      if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/v80-c1-form-${width}.png`, fullPage: false });
      await page.click('[data-source-fields-form="event"] [data-action="source-fields-cancel"]');
      assert.equal(posts.length, 0);
      if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/v80-c1-block-${width}.png`, fullPage: false });
    } finally {
      await context.close();
    }
  });
}

test("C1 (1280 px) the platform admin types 2,5 and 0,3 and confirms: one request with the numbers as typed (a comma read as a point), the confirmed sentence", async () => {
  const { context, page } = await openAs(browser, world, "platform_admin", WIDTHS.desktop);
  page.on("dialog", (d) => d.accept());
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && /event-setting-confirmation$/.test(r.url())) posts.push(r.postDataJSON()); });
  try {
    await openField(page);
    await page.click('[data-action="source-fields-event-open"]');
    await page.fill('[data-sf-field="thresholdValue"]', "2,5");
    await page.fill('[data-sf-field="durationSeconds"]', "0,3");
    await page.click('[data-source-fields-form="event"] button[type="submit"]');
    await page.waitForSelector('[data-source-fields-form="event"]', { state: "detached", timeout: 20_000 });
    assert.equal(posts.length, 1);
    assert.deepEqual([posts[0].thresholdValue, posts[0].durationSeconds], ["2.5", "0.3"]);
    assert.match(await plain(page.locator(".source-fields")), /Confirmed: acceleration events at or above 2\.5 m\/s² lasting 0\.3 s\./);
  } finally {
    await context.close();
  }
});

test("C2 (1280 px) after the confirmation: the club's board offers the column for Accelerations, and only that column takes the drop", async () => {
  const { context, page } = await openAs(browser, world, "club_admin", WIDTHS.desktop);
  try {
    await openBoard(page);
    const target = page.locator(`[data-mb-drop-variable][data-variable-id="${variableId}"]`);
    await target.waitFor({ timeout: 20_000 });
    assert.equal(await target.getAttribute("data-mb-only-fields"), fieldId);
    assert.match(await plain(page.locator(".mb-slot", { hasText: ACC })), /Empty · drag a column here/);
  } finally {
    await context.close();
  }
});
