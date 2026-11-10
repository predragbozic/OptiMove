// The section editor's exercise library on a computer (design B5), in a real browser. On a computer with a
// mouse, a library card's Favourite, Mark, Tags and Add are 44 px targets; Favourite and Mark keep a small
// 28 px frame inside their 44 px button. A click at the corner of the button, outside the frame, still
// works. The card keeps `draggable` and its data-*, and a mouse drag of a card onto the Added list still
// adds the exercise. Results are read back from the API, not from the screen.
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

async function sectionCount(context, ids) {
  const state = await call(context, `/api/builder/plans/${ids.planId}`);
  return state.blocks[0].sessions[0].nodes.find((n) => n.id === ids.sectionId).items.length;
}

async function openSection(page) {
  await page.locator('[data-library-tab="builder"]').first().click();
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

function card(page, name) {
  return page.locator(".builder-section-library .builder-exercise-result", { hasText: name }).first();
}

// Sizes, draggable and data-* of every library card in the current view.
async function measure(page) {
  return page.evaluate(() => {
    const size = (el) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      cards: [...document.querySelectorAll(".builder-section-library .builder-exercise-result")].map((c) => ({
        draggable: c.getAttribute("draggable"),
        dragData: c.hasAttribute("data-builder-library-drag") && Boolean(c.dataset.exerciseId),
        favorite: size(c.querySelector('[data-action="exercise-toggle-favorite"]')),
        frame: (() => { const b = c.querySelector('[data-action="exercise-toggle-favorite"]'); const s = getComputedStyle(b, "::before"); return { w: parseFloat(s.width) + 2 * parseFloat(s.borderLeftWidth), border: s.borderTopWidth }; })(),
        mark: size(c.querySelector('[data-action="exercise-toggle-mark"]')),
        tags: { ...size(c.querySelector('[data-action="exercise-tags"]')), font: getComputedStyle(c.querySelector('[data-action="exercise-tags"]')).fontSize },
        add: size(c.querySelector('[data-action="builder-pick-exercise"]')),
        ids: ["exercise-toggle-favorite", "exercise-toggle-mark", "exercise-tags", "builder-pick-exercise"].every((a) => c.querySelector(`[data-action="${a}"]`).dataset.exerciseId === c.dataset.exerciseId),
      })),
    };
  });
}

for (const width of [1280, 1024, 800]) {
  test(`(${width} px, mouse) every library card's Favourite, Mark, Tags and Add are 44 px; the card stays draggable`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await makeProgram(context, `Library ${width}`);
      await openSection(page);
      for (const view of ["list", "tile", "big"]) {
        await setView(page, view);
        const out = await measure(page);
        assert.equal(out.overflow, 0, `${view}: no horizontal overflow`);
        assert.ok(out.cards.length >= 2, `${view}: the library shows the exercises`);
        for (const c of out.cards) {
          assert.equal(c.draggable, "true", `${view}: the card is draggable`);
          assert.ok(c.dragData && c.ids, `${view}: the card and its buttons keep their data-*`);
          for (const key of ["favorite", "mark"]) assert.deepEqual(c[key], { w: 44, h: 44 }, `${view}: ${key} is 44 x 44`);
          assert.ok(c.frame.w === 28 && c.frame.border === "1px", `${view}: Favourite keeps a small frame (${c.frame.w} px)`);
          assert.ok(c.tags.h >= 44 && c.tags.w >= 44 && c.tags.font === "14px", `${view}: Tags is ${c.tags.w} x ${c.tags.h} at ${c.tags.font}`);
          assert.ok(c.add.h >= 44 && c.add.w >= 44, `${view}: Add is ${c.add.w} x ${c.add.h}`);
        }
      }
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(1024 x 500, mouse) a short window keeps the compact tile: a 22 px \"+\" Add, 44 px targets, nothing overflows", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 1024);
  try {
    await page.setViewportSize({ width: 1024, height: 500 });
    await makeProgram(context, "Library short window");
    await openSection(page);
    await setView(page, "tile");
    const out = await measure(page);
    assert.equal(out.overflow, 0, "no horizontal overflow");
    for (const c of out.cards) {
      for (const key of ["favorite", "mark"]) assert.deepEqual(c[key], { w: 44, h: 44 }, `${key} is 44 x 44`);
      assert.ok(c.add.h >= 44 && c.add.w >= 44, `Add is ${c.add.w} x ${c.add.h}`);
    }
    const compact = await page.evaluate(() => [...document.querySelectorAll(".builder-section-library .builder-exercise-result")].map((c) => ({
      over: c.scrollWidth - c.clientWidth,
      addFont: getComputedStyle(c.querySelector('[data-action="builder-pick-exercise"]')).fontSize,
      rowInside: c.querySelector(".builder-exercise-mini-actions").getBoundingClientRect().left >= c.getBoundingClientRect().left,
    })));
    for (const c of compact) {
      assert.equal(c.over, 0, "the card does not overflow");
      assert.equal(c.addFont, "22px", "the compact Add is a 22 px +");
      assert.ok(c.rowInside, "the actions row starts inside the card");
    }
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(1280 px, mouse) a click at the corner of Favourite, Mark, Tags and Add works; a mouse drag of a card adds it", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", 1280);
  try {
    const ids = await makeProgram(context, "Library clicks");
    await openSection(page);
    await setView(page, "list");
    const corner = async (locator) => { const b = await locator.boundingBox(); await page.mouse.click(b.x + 3, b.y + 3); };

    // Favourite and Mark: outside the 28 px frame, inside the 44 px button.
    await corner(card(page, "Back squat").locator('[data-action="exercise-toggle-favorite"]'));
    await page.locator('.builder-section-library [data-action="exercise-toggle-favorite"][aria-label="Remove favorite"]').first().waitFor();
    await corner(card(page, "Back squat").locator('[data-action="exercise-toggle-mark"]'));
    await page.locator('.builder-section-library [data-action="exercise-toggle-mark"][aria-label="Unmark"]').first().waitFor();

    // Tags opens its dialog.
    await corner(card(page, "Back squat").locator('[data-action="exercise-tags"]'));
    const dialog = page.locator('[role="dialog"]').filter({ hasText: "Back squat" }).first();
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" }).catch(async () => {
      await page.locator('[role="dialog"] [aria-label="Close"]').first().click();
    });

    // Add, clicked at its corner, adds the exercise.
    const count0 = await sectionCount(context, ids);
    const added = page.waitForResponse((res) => /\/api\/builder\//.test(res.url()) && res.request().method() === "POST");
    await corner(card(page, "Romanian deadlift").locator('[data-action="builder-pick-exercise"]'));
    await added;
    await page.waitForTimeout(600);
    assert.equal(await sectionCount(context, ids), count0 + 1, "Add added the exercise");

    // A mouse drag of a library card onto the Added list adds it too.
    const count1 = await sectionCount(context, ids);
    const dropped = page.waitForResponse((res) => /\/api\/builder\//.test(res.url()) && res.request().method() === "POST");
    await card(page, "Back squat").dragTo(page.locator(".builder-section-added").first());
    await dropped;
    await page.waitForTimeout(600);
    assert.equal(await sectionCount(context, ids), count1 + 1, "the dragged card was added");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
