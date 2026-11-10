// The Builder's drag and autosave, in a real browser: the guard every visual Builder PR runs (design B1-B5).
// A program with one section of three exercises is made through the API; then
// - a computer (1280 px): an item field saves itself 500 ms after typing, a session field saves on change, and
//   dragging an item's grip with the mouse below the next item reorders the section;
// - a phone (390 px): dragging the grip with a finger (CDP touch) reorders the section.
// Every result is read back from the API, not from the screen.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function call(context, path, method = "GET", body) {
  const res = await context.request.fetch(`${world.baseUrl}${path}`, { method, headers: { origin: world.baseUrl }, ...(body === undefined ? {} : { data: body }) });
  const text = await res.text();
  assert.ok(res.status() < 300, `${method} ${path}: ${res.status()} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// A fresh program: one block, one session, a section with three exercises. Returns the ids.
async function makeProgram(context, name) {
  const { plan } = await call(context, "/api/builder/plans", "POST", { planType: "program", athleteIds: ["1"], athleteExternalIds: ["1"], name });
  let state = await call(context, `/api/builder/plans/${plan.id}/blocks`, "POST", { name: "Week 1", type: "session" });
  state = await call(context, `/api/builder/blocks/${state.blocks[0].id}/sessions`, "POST", { bta: "T", name: "Main session" });
  const sessionId = state.blocks[0].sessions[0].id;
  state = await call(context, `/api/builder/sessions/${sessionId}/nodes`, "POST", { nodeType: "domain", name: "Strength" });
  const domainId = state.blocks[0].sessions[0].nodes.find((n) => n.type === "domain").id;
  state = await call(context, `/api/builder/sessions/${sessionId}/nodes`, "POST", { nodeType: "section", name: "Lower body", parentId: domainId });
  const sectionId = state.blocks[0].sessions[0].nodes.find((n) => n.type === "section").id;
  for (const exercise of ["Back squat", "Romanian deadlift", "Split squat"]) await call(context, `/api/builder/nodes/${sectionId}/custom-exercise`, "POST", { name: exercise });
  return { planId: plan.id, sessionId, sectionId };
}

async function sectionItems(context, ids) {
  const state = await call(context, `/api/builder/plans/${ids.planId}`);
  const section = state.blocks[0].sessions[0].nodes.find((n) => n.id === ids.sectionId);
  return [...section.items].sort((a, b) => a.itemOrder - b.itemOrder);
}

// Builder from the navigation, then the one unfinished draft.
async function openDraft(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="builder"]').first().click();
  await page.getByText("Continue where you left off").first().click();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.locator(".builder-session-time-inline").first().waitFor();
}

async function openSection(page) {
  await page.locator('[data-action="builder-select-node"]', { hasText: "Lower body" }).first().click();
  await page.locator(".builder-section-added").first().waitFor({ state: "attached" });
  await page.locator(".builder-section-library").first().waitFor();
}

test("(1280 px) an item field saves 500 ms after typing, a session field on change, and a mouse drag of the grip reorders the section", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 1280);
  try {
    const ids = await makeProgram(context, "Drag and autosave (computer)");
    await openDraft(page);

    // A session field saves on change.
    const sessionName = page.locator(".builder-session-time-inline [name=name]").first();
    await sessionName.fill("Main session A");
    await sessionName.press("Tab");
    await page.waitForTimeout(1200);
    let state = await call(context, `/api/builder/plans/${ids.planId}`);
    assert.equal(state.blocks[0].sessions[0].name, "Main session A", "the session name was saved on change");

    await openSection(page);
    const before = await sectionItems(context, ids);
    assert.deepEqual(before.map((i) => i.title), ["Back squat", "Romanian deadlift", "Split squat"]);

    // An item field saves itself 500 ms after the last key, with no blur.
    const sets = page.locator(`.builder-section-added .builder-item[data-item-id="${before[0].id}"] [name=sets]`).filter({ visible: true }).first();
    await sets.click();
    await sets.pressSequentially("4");
    await page.waitForTimeout(1500);
    const typed = await sectionItems(context, ids);
    assert.equal(typed.find((i) => i.id === before[0].id).sets, "4", "the item's sets were saved by the 500 ms autosave");

    // Mouse drag: the first item's grip, dropped below the second item.
    const grip = page.locator(`.builder-section-added [data-builder-item-drag][data-item-id="${before[0].id}"]`).filter({ visible: true }).first();
    const second = page.locator(`.builder-section-added .builder-item[data-item-id="${before[1].id}"]`).filter({ visible: true }).first();
    const first = page.locator(`.builder-section-added .builder-item[data-item-id="${before[0].id}"]`).filter({ visible: true }).first();
    const g = await grip.boundingBox();
    const f = await first.boundingBox();
    const s = await second.boundingBox();
    // The drop place follows the dragged item's own middle: move it just past the second item's middle.
    const distance = (s.y + s.height / 2) - (f.y + f.height / 2) + 8;
    const moved = page.waitForResponse((res) => /\/api\/builder\/items\/[^/]+\/move/.test(res.url()) && res.request().method() === "POST");
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2 + (distance * step) / 12);
    await page.mouse.up();
    assert.ok((await moved).status() < 300, "the move was saved");
    await page.waitForTimeout(600);
    const after = await sectionItems(context, ids);
    assert.deepEqual(after.map((i) => i.title), ["Romanian deadlift", "Back squat", "Split squat"], "the dragged item is now second");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(390 px) a touch drag of the grip reorders the section", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 390);
  try {
    const ids = await makeProgram(context, "Drag and autosave (phone)");
    await openDraft(page);
    await openSection(page);
    // On a phone the added exercises are behind Edit.
    const edit = page.getByRole("button", { name: "Edit", exact: true });
    if (await edit.isVisible().catch(() => false)) await edit.click();
    const before = await sectionItems(context, ids);
    const grip = page.locator(`[data-builder-item-drag][data-item-id="${before[0].id}"]`).filter({ visible: true }).first();
    await grip.waitFor();
    const second = page.locator(`[data-drag-item][data-item-id="${before[1].id}"]`).filter({ visible: true }).first();
    const first = page.locator(`[data-drag-item][data-item-id="${before[0].id}"]`).filter({ visible: true }).first();
    const g = await grip.boundingBox();
    const f = await first.boundingBox();
    const s = await second.boundingBox();
    const cdp = await context.newCDPSession(page);
    const x = g.x + g.width / 2;
    const y0 = g.y + g.height / 2;
    const y1 = y0 + (s.y + s.height / 2) - (f.y + f.height / 2) + 8;
    const moved = page.waitForResponse((res) => /\/api\/builder\/items\/[^/]+\/move/.test(res.url()) && res.request().method() === "POST");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
    for (let step = 1; step <= 12; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + ((y1 - y0) * step) / 12 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.ok((await moved).status() < 300, "the move was saved");
    await page.waitForTimeout(600);
    const after = await sectionItems(context, ids);
    assert.deepEqual(after.map((i) => i.title), ["Romanian deadlift", "Back squat", "Split squat"], "the dragged item is now second");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
