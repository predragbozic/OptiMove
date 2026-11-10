// B1: the Builder outline's touch targets (CSS only).
// - a phone (390 px, touch): every action and row of the outline is at least 44 px;
// - a computer (1280 px, mouse): every action of the outline is at least 32 px (the dense look stays);
// - the narrowest phone (360 px): every option of the session's two selects fits its select.
// No horizontal overflow at any width. The drag and autosave guard is builder-drag-autosave.test.mjs.
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

// One block, one session, a domain with a section of two exercises: every kind of outline action is on screen.
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
}

async function openDraft(page) {
  const toggle = page.locator('[data-action="mobile-nav-toggle"]');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('[data-library-tab="builder"]').first().click();
  await page.getByText("Continue where you left off").first().click();
  await page.getByRole("button", { name: "Continue", exact: true }).first().click();
  await page.locator(".builder-session-time-inline").first().waitFor();
  await page.waitForTimeout(500);
}

const OUTLINE_ACTIONS = ["builder-copy-block", "builder-delete-block", "builder-delete-session", "builder-start-inline-add", "builder-move-node", "builder-copy-node", "builder-delete-node", "builder-toggle-section-preview", "builder-toggle-session-quick-add"];

// The visible outline controls of each action, with their sizes.
const measure = (page, actions) => page.evaluate((actions) => {
  const grid = document.querySelector(".builder-block-grid");
  return actions.flatMap((action) => [...grid.querySelectorAll(`[data-action="${action}"]`)]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && getComputedStyle(e).visibility !== "hidden"; })
    .map((e) => { const r = e.getBoundingClientRect(); return { action, w: Math.round(r.width), h: Math.round(r.height) }; }));
}, actions);

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

let made = false;
async function openBuilder(width) {
  const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
  if (!made) { await makeProgram(context, "Outline touch"); made = true; }
  await openDraft(page);
  return { context, page, pageErrors };
}

test("(390 px, a phone) every action and row of the Builder outline is at least 44 px; nothing overflows", async () => {
  const { context, page, pageErrors } = await openBuilder(390);
  try {
    const controls = await measure(page, [...OUTLINE_ACTIONS, "builder-select-node", "builder-select-session"]);
    for (const action of OUTLINE_ACTIONS) assert.ok(controls.some((c) => c.action === action), `${action} is on screen`);
    for (const { action, w, h } of controls) assert.ok(w >= 44 && h >= 44, `${action}: ${w}x${h}`);
    assert.ok(await overflow(page) <= 0, "no horizontal overflow");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(1280 px, a computer) every action of the Builder outline is at least 32 px; nothing overflows", async () => {
  const { context, page, pageErrors } = await openBuilder(1280);
  try {
    const controls = await measure(page, OUTLINE_ACTIONS);
    assert.ok(controls.length >= OUTLINE_ACTIONS.length - 1, JSON.stringify(controls));
    for (const { action, w, h } of controls) assert.ok(w >= 32 && h >= 32, `${action}: ${w}x${h}`);
    assert.ok(await overflow(page) <= 0, "no horizontal overflow");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(360 px, the narrowest phone) every option of the session's two selects fits its select", async () => {
  const { context, page, pageErrors } = await openBuilder(360);
  try {
    // The option's text against the select's inner width less the native arrow (about 22 px).
    const clipped = await page.evaluate(() => {
      const ctx = document.createElement("canvas").getContext("2d");
      return ["amPm", "bta"].flatMap((name) => {
        const select = document.querySelector(`.builder-session-time-inline select[name="${name}"]`);
        const cs = getComputedStyle(select);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = select.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 22;
        return [...select.options].filter((o) => ctx.measureText(o.text).width > room).map((o) => `${name}: "${o.text}" > ${Math.round(room)}`);
      });
    });
    assert.deepEqual(clipped, []);
    assert.ok(await overflow(page) <= 0, "no horizontal overflow");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
