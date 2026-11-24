// A favorite that could not be saved, in a real browser on a phone (360 and 390 px): the sentence and "Try again"
// appear beside the star that was pressed in the library's card, the library's icon row and the Builder's result;
// "Try again" is a 44 px target; the card is no wider than before and nothing scrolls sideways; the retry saves.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs } from "../lib/browser.mjs";

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

// A fresh program: one session with a section of two exercises (they also land in the library).
async function makeProgram(context, name) {
  const { plan } = await call(context, "/api/builder/plans", "POST", { planType: "program", athleteIds: ["1"], athleteExternalIds: ["1"], name });
  let state = await call(context, `/api/builder/plans/${plan.id}/blocks`, "POST", { name: "Week 1", type: "session" });
  state = await call(context, `/api/builder/blocks/${state.blocks[0].id}/sessions`, "POST", { bta: "T", name: "Main session" });
  const sessionId = state.blocks[0].sessions[0].id;
  state = await call(context, `/api/builder/sessions/${sessionId}/nodes`, "POST", { nodeType: "domain", name: "Strength" });
  const domainId = state.blocks[0].sessions[0].nodes.find((n) => n.type === "domain").id;
  state = await call(context, `/api/builder/sessions/${sessionId}/nodes`, "POST", { nodeType: "section", name: "Lower body", parentId: domainId });
  const sectionId = state.blocks[0].sessions[0].nodes.find((n) => n.type === "section").id;
  for (const exercise of ["Back squat", "Romanian deadlift"]) await call(context, `/api/builder/nodes/${sectionId}/custom-exercise`, "POST", { name: exercise });
  return { planId: plan.id, sectionId };
}

async function openSection(page) {
  // Below 761 px the navigation is behind the menu button.
  await navTo(page, '[data-library-tab="builder"]');
  await page.getByText("Continue where you left off").first().click();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.locator('[data-action="builder-select-node"]', { hasText: "Lower body" }).first().click();
  await page.locator(".builder-section-library .builder-exercise-result").first().waitFor();
  await page.waitForTimeout(300);
}

async function setView(page, view) {
  await page.locator(`.builder-section-library .exercise-view-button[data-view="${view}"]:visible`).first().click();
  await page.locator(`.builder-exercise-view.is-${view}`).first().waitFor();
  await page.waitForTimeout(200);
}


// Presses the star of the first exercise in `scope` with the favorite call cut off, checks the message and its
// layout, then lets the call through and checks that Try again saves.
async function failThenRetry(page, context, scope, actionsSelector, label, width) {
  const item = page.locator(scope).first();
  const actions = item.locator(actionsSelector);
  const star = actions.locator('[data-action="exercise-toggle-favorite"]').first();
  await star.scrollIntoViewIfNeeded();
  const before = await item.boundingBox();
  let offline = true;
  let saves = 0;
  await context.route("**/api/exercises/*/favorite", async (route) => { if (offline) return route.abort("failed"); saves += 1; return route.continue(); });
  await star.click();
  const note = actions.locator(".exercise-favorite-failed");
  await note.waitFor({ timeout: 10_000 });
  const wasOn = (await star.getAttribute("data-favorite")) === "true";
  assert.equal((await note.textContent()).replace(/\s+/g, " ").trim(), `The favorite was not ${wasOn ? "removed" : "saved"}. Try again`, label);
  const retry = note.getByRole("button", { name: "Try again" });
  const [itemBox, noteBox, retryBox] = [await item.boundingBox(), await note.boundingBox(), await retry.boundingBox()];
  assert.ok(retryBox.height >= 44 && retryBox.width >= 44, `${label}: Try again is ${retryBox.width} x ${retryBox.height}`);
  assert.ok(Math.abs(itemBox.width - before.width) <= 1 && Math.abs(itemBox.x - before.x) <= 1, `${label}: the card keeps its width (${before.width} -> ${itemBox.width})`);
  assert.ok(noteBox.x >= itemBox.x - 1 && noteBox.x + noteBox.width <= itemBox.x + itemBox.width + 1, `${label}: the message stays inside its card`);
  assert.ok(noteBox.x >= 0 && noteBox.x + noteBox.width <= width, `${label}: the message stays inside the screen`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 0, `${label}: no horizontal scroll (${overflow}px)`);
  // The other controls of the card are still where a finger finds them: none is covered by the message.
  const covered = await actions.evaluate((el) => [...el.querySelectorAll(":scope > button, :scope > details > summary")].filter((b) => {
    const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top && !b.contains(top) && top.closest(".exercise-favorite-failed");
  }).length);
  assert.equal(covered, 0, `${label}: no control is covered`);
  if (process.env.E2E_SHOTS_DIR) await item.screenshot({ path: `${process.env.E2E_SHOTS_DIR}/favorite-not-saved-${label.replace(/[^a-z0-9]+/gi, "-")}.png` });
  offline = false;
  await retry.click();
  await note.waitFor({ state: "detached", timeout: 10_000 });
  assert.equal(saves, 1, `${label}: Try again saved the favorite`);
  await context.unroute("**/api/exercises/*/favorite");
}

for (const width of [360, 390]) {
  test(`(${width} px) the library: the message beside the star in the details card and in the icon row`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await makeProgram(context, `Favorites ${width}`);
      await navTo(page, '[data-library-tab="exercises"]');
      for (const [view, scope, actions] of [["details", ".exercise-card, .exercise-library-card, article:has(> .exercise-card-actions), article:has(.exercise-card-actions)", ".exercise-card-actions"], ["list", "article:has(.exercise-view-actions)", ".exercise-view-actions"], ["tile", "article:has(.exercise-view-actions)", ".exercise-view-actions"]]) {
        await page.locator(`.exercise-view-button[data-view="${view}"]:visible`).first().click();
        await page.locator(actions).first().waitFor({ timeout: 15_000 });
        await page.waitForTimeout(200);
        await failThenRetry(page, context, `article:has(${actions})`, actions, `library ${view} ${width}`, width);
      }
      // The page reported the failed calls itself (api.js); nothing surfaced as an uncaught error.
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });

  test(`(${width} px) the Builder's section library: the message beside the star of a result`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await makeProgram(context, `Favorites builder ${width}`);
      await openSection(page);
      await failThenRetry(page, context, ".builder-section-library .builder-exercise-result", ".builder-exercise-mini-actions", `builder ${width}`, width);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}
