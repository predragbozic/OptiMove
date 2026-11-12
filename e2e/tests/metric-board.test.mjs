// J18 (18-4): Map by drag and drop, against the real server on a disposable database, with the fake GPEXE source's
// "board" session (three linked athletes with different values). A club's admin switches OptiMove's own mapping of
// TotDist off, drags the column onto the club's variable (1280 px) or taps it and then the variable (390 px), compares
// two athletes, ticks, saves and sees "On for First team"; History shows the confirmation. A coach is offered nothing
// and the routes answer 404. Invented data.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const M = "/api/training-load/sources/metrics";
const VARIABLE = "Total distance (km)";

async function prepareBoard(world) {
  const setup = await prepareImports(world);
  const made = await setup.call("club_admin", "POST", `${M}/variables`, { requestKey: randomUUID(), label: VARIABLE, levels: ["session"], unit: "km", dailyAggregationMethod: "sum" });
  assert.equal(made.status, 201, `variable: ${JSON.stringify(made.body)}`);
  const board = (await setup.call("club_admin", "GET", `${M}/board?teamId=${setup.teamId}`)).body.board;
  const column = board.columns.find((c) => c.key === "athlete_session.total_distance");
  const on = board.on.find((o) => o.fieldId === column.fieldId);
  assert.ok(on, "OptiMove's mapping of TotDist is on at the start");
  return { setup, fieldId: column.fieldId, variableId: made.body.variable.id, activationId: on.activationId };
}

async function openBoard(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.click('[data-action="training-load-section"][data-section="board"]');
  await page.waitForSelector("[data-mb-board]", { timeout: 20_000 });
}

async function switchOff(page, activationId) {
  await page.click(`[data-action="metric-board-switch-off-open"][data-activation-id="${activationId}"]`);
  await page.click('[data-action="metric-board-switch-off"]');
  await page.waitForSelector(`[data-action="metric-board-switch-off-open"][data-activation-id="${activationId}"]`, { state: "detached", timeout: 20_000 });
}

async function checkAndSave(page, scope) {
  const tick = page.locator(`${scope} [data-mb-tick]`);
  await tick.waitFor({ timeout: 20_000 });
  const panel = (await page.locator(scope).first().innerText()).replace(/\s+/g, " ");
  assert.match(panel, /m → km \(× 0\.001\)/);
  assert.match(panel, /Ana Example/);
  assert.match(panel, /3000 m/);
  assert.match(panel, /3 km/);
  assert.doesNotMatch(panel, /3000\.0/, "a distance in metres shows no decimal");
  await tick.check();
  await page.click(`${scope} [data-action="metric-board-keep"]`);
  await page.click('[data-action="metric-board-review"]');
  const saves = [];
  page.on("request", (r) => { if (r.method() === "POST" && /sources\/metrics\/confirmations$/.test(r.url())) saves.push(r.postDataJSON()); });
  await page.click('[data-action="metric-board-save"]:visible');
  const slot = page.locator(".mb-slot.is-on", { hasText: VARIABLE });
  await slot.waitFor({ timeout: 20_000 });
  assert.match(await slot.innerText(), /On for First team/);
  assert.match((await page.locator(".mb-notice.is-success").innerText()).replace(/\s+/g, " "), /Saved\. Switched on for First team: TotDist → Total distance \(km\)/);
  assert.equal(saves.length, 1, "one save request");
  assert.equal(saves[0].rows.length, 1);
  assert.equal(saves[0].rows[0].checked, true);
  return saves[0];
}

test("18-4a. (1280 px) a club admin drags a column onto a variable, ticks, saves and sees On for the team; History keeps it", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "board" } });
  try {
    const { fieldId, variableId, activationId } = await prepareBoard(world);
    const admin = await openAs(browser, world, "club_admin", WIDTHS.desktop);
    try {
      const page = admin.page;
      await openBoard(page);
      await switchOff(page, activationId);
      const column = `[data-mb-drag-field][data-field-id="${fieldId}"]`;
      await page.waitForSelector(column, { timeout: 20_000 });
      await page.dragAndDrop(column, `[data-mb-drop-variable][data-variable-id="${variableId}"]`);
      await checkAndSave(page, ".mb-panel");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no horizontal overflow");
      await page.click('[data-action="metric-board-tab"][data-board-tab="history"]');
      const history = page.locator(".mb-history");
      await history.waitFor({ timeout: 20_000 });
      const text = (await history.innerText()).replace(/\s+/g, " ");
      assert.match(text, /TotDist → Total distance \(km\)/);
      assert.match(text, /Compared with two athletes/);
      assert.doesNotMatch(text, /Ana Example|Bojan Example/);
      assert.deepEqual(admin.pageErrors, []);
    } finally { await admin.context.close(); }
  } finally { await world.stop(); }
});

test("18-4b. (390 px) the same flow by tapping: one bottom sheet at a time, no drag, no overflow", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "board" } });
  try {
    const { fieldId, variableId, activationId } = await prepareBoard(world);
    const admin = await openAs(browser, world, "club_admin", WIDTHS.phone);
    try {
      const page = admin.page;
      await openBoard(page);
      assert.equal(await page.locator("[data-mb-drag-field]").count(), 0, "nothing drags on a phone");
      const summary = await page.locator(".mb-tech summary").first().boundingBox();
      assert.ok(summary.height >= 44, `Technical details is ${summary.height}px tall`);
      // Switch off asks in the bottom sheet, in view, not somewhere up the page.
      await page.tap(`[data-action="metric-board-switch-off-open"][data-activation-id="${activationId}"]`);
      const question = page.locator(".mb-sheet", { hasText: "Switch off TotDist" });
      await question.waitFor({ timeout: 10_000 });
      const qBox = await question.boundingBox();
      assert.ok(qBox.y >= 0 && qBox.y + qBox.height <= 844 + 1, "the question is inside the viewport");
      await page.tap('.mb-sheet [data-action="metric-board-switch-off-cancel"]');
      await page.waitForSelector(".mb-sheet", { state: "detached" });
      await switchOff(page, activationId);
      await page.tap(`[data-action="metric-board-pick"][data-field-id="${fieldId}"]`);
      await page.waitForSelector(".mb-sheet");
      assert.equal(await page.locator(".mb-sheet").count(), 1);
      await page.tap(`.mb-sheet [data-action="metric-board-place"][data-variable-id="${variableId}"]`);
      await page.waitForSelector(".mb-sheet [data-mb-tick]", { timeout: 20_000 });
      assert.equal(await page.locator(".mb-sheet").count(), 1, "one sheet at a time");
      const box = await page.locator(".mb-sheet [data-action=\"metric-board-keep\"]").boundingBox();
      assert.ok(box.height >= 44, `Keep is ${box.height}px tall`);
      await checkAndSave(page, ".mb-sheet");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no horizontal overflow");
      assert.deepEqual(admin.pageErrors, []);
    } finally { await admin.context.close(); }
  } finally { await world.stop(); }
});

test("18-4c. a coach is offered nothing: no card, no board, and the routes answer 404", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "board" } });
  try {
    const { setup } = await prepareBoard(world);
    for (const path of [`${M}/board?teamId=${setup.teamId}`, `${M}/confirmations?teamId=${setup.teamId}`]) {
      assert.equal((await setup.call("team_coach", "GET", path)).status, 404, path);
    }
    const coach = await openAs(browser, world, "team_coach", WIDTHS.desktop);
    try {
      await openTrainingLoad(coach.page);
      assert.equal(await coach.page.locator('[data-section="board"]').count(), 0);
      const variables = coach.page.locator('[data-action="training-load-section"][data-section="variables"]');
      if (await variables.count()) {
        await variables.first().click();
        await coach.page.waitForTimeout(1000);
        assert.equal(await coach.page.locator('[data-section="board"]').count(), 0);
      }
      assert.equal(await coach.page.getByText("Map by drag and drop").count(), 0);
    } finally { await coach.context.close(); }
  } finally { await world.stop(); }
});
