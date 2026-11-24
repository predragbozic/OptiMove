// Import into a program and a block template FROM a weekly plan (the Builder's "Copy from another plan" dialog, owner
// order 2026-11-22), through the real app:
// - the dialog offers the weekly plan only (no Template / Specific program source) and starts at the athlete list;
// - a section's pictures button (44 px) opens that section's exercises and closes again;
// - "Copy this whole session" then Paste session appends the session to the block; "Copy this whole day" then Paste
//   replaces the block's sessions after a confirm that says "block", never "day";
// - the weekly plan the content came from is unchanged, and no horizontal page scroll at any width.
// At 1280 and 390 px, for a specific program and for a block template.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
const cookieOf = (world, role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(world, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(world, "team_coach") }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const ok = (res, ...statuses) => { assert.ok((statuses.length ? statuses : [200]).includes(res.status), `${res.status} ${res.text}`); return res.body; };
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const mondayOf = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));

// A published weekly plan "Source week" with one session "Main" (a domain, a section "Lower body" and one exercise) on
// its first day, and the new draft: a specific program of the same athlete, or (template) a block template.
async function setUp(world, template) {
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  let ext;
  try {
    ext = (await db.query("select athlete_id from public.athletes where id = any($1::uuid[]) order by athlete_id limit 1", [world.ids.athleteIds])).rows[0].athlete_id;
  } finally {
    await db.end();
  }
  const weekly = ok(await call(world, "POST", "/api/builder/plans", { planType: "weekly", weekStart: mondayOf(localDay()), athleteIds: [ext], name: "Source week" }), 201);
  const weeklyId = weekly.plan.id;
  let draft = ok(await call(world, "POST", `/api/builder/blocks/${weekly.blocks[0].id}/sessions`, { amPm: "AM", bta: "T", time: "09:30", name: "Main" }), 201);
  const session = sessionsOf(draft).find((s) => s.name === "Main");
  draft = ok(await call(world, "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Strength" }), 200, 201);
  const domain = (sessionsOf(draft).find((s) => s.id === session.id).nodes || []).find((n) => n.type === "domain");
  draft = ok(await call(world, "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "section", name: "Lower body", parentId: domain.id }), 200, 201);
  const section = (sessionsOf(draft).find((s) => s.id === session.id).nodes || []).find((n) => n.type === "section");
  ok(await call(world, "POST", `/api/builder/nodes/${section.id}/custom-exercise`, { name: "Squat import test" }), 200, 201);
  // A second section with a long unbroken name: it must wrap inside the dialog on a phone, never widen it.
  ok(await call(world, "POST", `/api/builder/sessions/${session.id}/nodes`, { nodeType: "section", name: "Supercalifragilisticexpialidocious_Strength_Block", parentId: domain.id }), 200, 201);
  ok(await call(world, "POST", `/api/builder/plans/${weeklyId}/submit`, { responseMode: "summary" }));
  const program = ok(await call(world, "POST", "/api/builder/plans", { planType: "program", ...(template ? {} : { athleteIds: [ext] }), name: template ? "Import template" : "Import program" }), 201);
  // A program or a template starts with no block: one empty "Block 1" to paste into.
  const withBlock = ok(await call(world, "POST", `/api/builder/plans/${program.plan.id}/blocks`, { name: "Block 1" }), 201);
  return { ext, weeklyId, programId: program.plan.id, targetBlockId: withBlock.blocks[0].id };
}

const weeklySnapshot = async (world, planId) => {
  const plan = ok(await call(world, "GET", `/api/builder/plans/${planId}`));
  return JSON.stringify(sessionsOf(plan).map((s) => ({ id: s.id, name: s.name, logical: s.logicalSessionId ?? s.logical_session_id ?? null, nodes: (s.nodes || []).length })));
};

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }).catch(() => {});
}
const visibleText = (locator) => locator.evaluate((el) => el.innerText.replace(/\s+/g, " ").trim());

// The dialog down to the weekly plan's day: athlete, plan, the day that holds the session.
async function walkToDay(page, ext) {
  await page.locator('[data-action="builder-open-block-picker"]').first().click();
  await page.locator('[data-action="builder-block-picker-choose-athlete"]').first().waitFor();
  assert.equal(await page.locator('[data-action="builder-block-picker-choose-source-type"]').count(), 0, "no other source is offered");
  assert.equal(await page.locator('[data-action="builder-block-picker-back-to-source"]').count(), 0, "no way back to a source choice");
  await page.locator(`[data-action="builder-block-picker-choose-athlete"][data-athlete-id="${ext}"]`).click();
  await page.locator('[data-action="builder-block-picker-choose-plan"]', { hasText: "Source week" }).click();
  await page.locator('[data-action="builder-block-picker-drill-block"]', { hasText: "1 session" }).first().click();
}

for (const width of [1280, 390, 375, 360]) {
  for (const template of [false, true]) {
    test(`(${width} px) ${template ? "a block template" : "a specific program"} imports a weekly plan's session and day, with the pictures button and the block wording`, async () => {
      const world = await startWorld();
      try {
        const { ext, weeklyId, programId, targetBlockId } = await setUp(world, template);
        const before = await weeklySnapshot(world, weeklyId);
        const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
        try {
          await navTo(page, '[data-library-tab="builder"]');
          await page.getByText("Continue where you left off").first().click();
          await page.getByRole("button", { name: "Continue", exact: true }).first().click();
          await page.locator(".builder-program-bar").first().waitFor();

          // The Import button is on the outline of a program and a template too.
          const importButton = page.locator('[data-action="builder-open-block-picker"]').first();
          assert.equal(await importButton.isVisible(), true, "Import is offered");
          const importBox = await importButton.boundingBox();
          assert.ok(importBox && importBox.height >= 40, `Import is a real target (${importBox?.height})`);

          // 1. One session: drill into the day, then the session, open a section's pictures.
          await walkToDay(page, ext);
          await page.locator('[data-action="builder-block-picker-drill-session"]').first().click();
          const thumbsButton = page.locator('[data-action="builder-block-picker-toggle-thumbs"]').first();
          await thumbsButton.waitFor({ timeout: 20_000 });
          const box = await thumbsButton.boundingBox();
          assert.ok(box && box.width >= 44 && box.height >= 44, `the pictures button is a 44 px target (${box?.width}x${box?.height})`);
          // Every row of the tree, the long unbroken name's included, stays inside the screen.
          const rowsInside = await page.evaluate((w) => [...document.querySelectorAll(".builder-block-picker-node-line")].map((line) => line.getBoundingClientRect().right <= w + 0.5), width);
          assert.ok(rowsInside.length >= 2 && rowsInside.every(Boolean), `every section row fits the screen: ${JSON.stringify(rowsInside)}`);
          assert.equal(await thumbsButton.getAttribute("aria-expanded"), "false");
          assert.match(await thumbsButton.getAttribute("aria-label"), /Show pictures of the exercises in Lower body/);
          await thumbsButton.click();
          const thumbs = page.locator(".builder-block-picker-thumbs");
          await thumbs.waitFor();
          assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-action")), "builder-block-picker-toggle-thumbs", "the keyboard stays on the pictures button after the dialog is drawn again");
          assert.match(await visibleText(thumbs), /Squat import test/);
          assert.equal(await thumbsButton.getAttribute("aria-expanded"), "true");
          assert.equal(await overflow(page, width), 0, "no horizontal page scroll with the pictures open");
          await shot(page, `import-pictures-${template ? "template" : "program"}-${width}`);
          await thumbsButton.click();
          assert.equal(await page.locator(".builder-block-picker-thumbs").count(), 0, "the pictures close again");
          // The copy button of the section is its own control: copying a whole session works from here.
          await page.locator('[data-action="builder-block-picker-copy-whole-session"]').click();

          // 2. Paste session: appended to the (empty) target block.
          const pasteSession = page.locator(`[data-action="builder-paste-session"][data-day-id="${targetBlockId}"]`);
          await pasteSession.waitFor({ timeout: 20_000 });
          // The block's head with its action buttons (copy, paste, delete): 44 px targets on a phone, the name keeps room.
          const head = await page.evaluate((id) => {
            const paste = document.querySelector(`[data-action="builder-paste-session"][data-day-id="${id}"]`);
            const actions = paste.closest(".builder-block-head-actions");
            const text = actions.parentElement.querySelector(".builder-block-head-text") || actions.previousElementSibling;
            return {
              buttons: [...actions.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; }),
              nameWidth: Math.round(text.getBoundingClientRect().width),
            };
          }, targetBlockId);
          assert.ok(head.buttons.length >= 3, `copy, paste and delete: ${JSON.stringify(head)}`);
          assert.ok(head.buttons.every((b) => b.right <= width), `the buttons stay on the screen: ${JSON.stringify(head)}`);
          if (width < 600) {
            assert.ok(head.buttons.every((b) => b.w >= 44 && b.h >= 44), `44 px targets on a phone: ${JSON.stringify(head)}`);
            assert.ok(head.nameWidth >= 90, `the block's name keeps room: ${JSON.stringify(head)}`);
          }
          await shot(page, `import-head-${template ? "template" : "program"}-${width}`);
          await pasteSession.click();
          await page.locator(".builder-sessions", { hasText: "Main" }).first().waitFor({ timeout: 20_000 });
          let target = ok(await call(world, "GET", `/api/builder/plans/${programId}`));
          assert.deepEqual(sessionsOf(target).map((s) => s.name), ["Main"], "the session came into the block");
          assert.equal(await weeklySnapshot(world, weeklyId), before, "the weekly plan is unchanged");
          assert.equal(await overflow(page, width), 0, "no horizontal page scroll after the paste");

          // 3. Paste day: the block has a session now, so it asks first, in block words.
          await walkToDay(page, ext);
          await page.locator('[data-action="builder-block-picker-copy-whole-block"]').click();
          const pasteDay = page.locator(`[data-action="builder-paste-day"][data-day-id="${targetBlockId}"]`);
          await pasteDay.waitFor({ timeout: 20_000 });
          await pasteDay.click();
          const confirm = page.locator(".builder-overwrite-day-confirm-modal");
          await confirm.waitFor();
          const words = await visibleText(confirm);
          assert.match(words, /Replace this block's content\?/);
          assert.match(words, /This block already has sessions\./);
          assert.doesNotMatch(words, /\bday\b/i, "no day wording on a block");
          await shot(page, `import-confirm-${template ? "template" : "program"}-${width}`);
          await confirm.locator('[data-action="builder-overwrite-day-confirm"]').click();
          await confirm.waitFor({ state: "detached" });
          target = ok(await call(world, "GET", `/api/builder/plans/${programId}`));
          assert.deepEqual(sessionsOf(target).map((s) => s.name), ["Main"], "the block's content was replaced, not doubled");
          assert.equal(await weeklySnapshot(world, weeklyId), before, "the weekly plan is still unchanged");
          assert.equal(await overflow(page, width), 0, "no horizontal page scroll after the replace");
          assert.deepEqual(pageErrors, []);
        } finally {
          await context.close();
        }
      } finally {
        await world.stop();
      }
    });
  }
}
