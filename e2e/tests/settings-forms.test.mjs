// The Settings forms in a real browser (design S1), at 1280 and 390 px: Tags & Presets "+ Add", Users (add user,
// assign access, manual login, Manage account) and Join links. Every field, select and button is 44 px, a select
// is 16 px on a phone, nothing overflows, and a colour swatch takes a click 18 px from its centre.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

async function openSection(page, section) {
  await openSettings(page);
  await page.locator(`.settings-tabs [data-section="${section}"]`).first().click();
  await page.waitForTimeout(600);
}

async function click(page, action) {
  await page.locator(`main.workspace [data-action="${action}"]:visible`).first().click();
  await page.waitForTimeout(500);
}

// Every shown field, select and button of the Settings content (not the header or the section tabs).
async function measure(page, scope = "main.workspace .organization-view") {
  return page.evaluate((scopeSelector) => {
    const root = document.querySelector(scopeSelector);
    const shown = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const items = [...root.querySelectorAll("input, select, button, .text-action")]
      .filter((e) => shown(e) && !e.closest(".settings-tabs") && !["checkbox", "radio", "color", "hidden"].includes(e.type) && !e.classList.contains("pastel-swatch"))
      .map((e) => ({ what: `${e.tagName.toLowerCase()} "${(e.getAttribute("aria-label") || e.textContent || e.placeholder || e.name || "").trim().slice(0, 30)}"`, h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width), font: parseFloat(getComputedStyle(e).fontSize), tag: e.tagName }));
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, items };
  }, scope);
}

function assertTargets(out, width) {
  assert.equal(out.overflow, 0, "no horizontal overflow");
  assert.ok(out.items.length > 0, "the form is shown");
  for (const item of out.items) {
    assert.ok(item.h >= 44, `${item.what} is ${item.h} px tall`);
    assert.ok(item.w >= 44, `${item.what} is ${item.w} px wide`);
    if (width <= 760 && /^(INPUT|SELECT|TEXTAREA)$/.test(item.tag)) assert.ok(item.font >= 16, `${item.what} is ${item.font} px on a phone`);
  }
}

for (const width of [1280, 390]) {
  test(`(${width} px) Tags & Presets: the add form is 44 px and a swatch takes a click 18 px from its centre`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", width);
    try {
      await openSection(page, "presets");
      await click(page, "taxonomy-toggle-add");
      const form = page.locator("main.workspace .tag-chip-add-form").first();
      await form.waitFor();
      assertTargets(await measure(page), width);
      const third = form.locator(".pastel-swatch:not(.pastel-swatch-custom)").nth(2);
      await third.scrollIntoViewIfNeeded();
      const box = await third.boundingBox();
      assert.equal(Math.round(box.width), 28, "the swatch is a 28 px circle");
      const x = box.x + box.width / 2 + 18;
      const y = box.y + box.height / 2;
      const hit = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.dataset.color || "", [x, y]);
      assert.equal(hit, await third.getAttribute("data-color"), "18 px from its centre is still the swatch");
      // The target is square: a point 18 px off the centre on both axes is still the swatch.
      const diagonal = await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.dataset.color || "", [box.x + box.width / 2 + 18, box.y + box.height / 2 + 18]);
      assert.equal(diagonal, await third.getAttribute("data-color"), "the corner of the target is the swatch");
      // The custom colour's own input is the 44 px target, centred on its circle.
      const custom = await page.evaluate(() => {
        const label = document.querySelector("main.workspace .tag-chip-add-form .pastel-swatch-custom");
        const l = label.getBoundingClientRect(); const i = label.querySelector("input").getBoundingClientRect();
        return { w: i.width, dx: (i.left + i.width / 2) - (l.left + l.width / 2), dy: (i.top + i.height / 2) - (l.top + l.height / 2) };
      });
      assert.equal(Math.round(custom.w), 44, "the custom colour's target is 44 px");
      assert.ok(Math.abs(custom.dx) <= 0.5 && Math.abs(custom.dy) <= 0.5, `the custom colour's target is centred (${custom.dx}, ${custom.dy})`);
      await page.mouse.click(x, y);
      await page.waitForTimeout(300);
      assert.match(await form.locator(".pastel-swatch").nth(2).getAttribute("class"), /is-selected/, "the clicked swatch is chosen");
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });

  test(`(${width} px) Users: the forms and Manage account are 44 px, selects 16 px on a phone`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", width);
    try {
      await openSection(page, "users");
      await click(page, "organization-toggle-add-form");
      assertTargets(await measure(page), width);
      await click(page, "organization-manage-account-open");
      assertTargets(await measure(page), width);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });

  test(`(${width} px) Join links: the create form and a new link's actions are 44 px`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      await openSection(page, "joinLinks");
      await click(page, "organization-toggle-add-form");
      const form = page.locator("main.workspace form:visible").filter({ hasText: "Create join link" }).first();
      assertTargets(await measure(page), width);
      await form.locator("input").first().fill(`Demo tryouts ${width}`);
      await form.getByRole("button", { name: "Create join link" }).click();
      await page.locator('main.workspace [data-action="organization-join-link-revoke"]:visible').first().waitFor();
      assertTargets(await measure(page), width);
      assert.deepEqual(pageErrors, []);
    } finally { await context.close(); }
  });
}

test("(390 px) Calendar settings: a select marked invalid keeps its red border", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "club_admin", 390);
  try {
    await openSection(page, "calendar");
    await click(page, "calendar-settings-new");
    const form = page.locator("main.workspace form:visible").filter({ has: page.locator("#cs-type-kind") }).first();
    await form.locator('button[type="submit"]').click();
    const kind = page.locator('#cs-type-kind[aria-invalid="true"]');
    await kind.waitFor();
    const colours = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--danger)";
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { danger, border: getComputedStyle(document.querySelector("#cs-type-kind")).borderTopColor };
    });
    assert.equal(colours.border, colours.danger, "the invalid select is red");
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(1280 px) Data sources keeps its 16 px selects", async () => {
  const { context, page, pageErrors } = await openAs(browser, world, "platform_admin", 1280);
  try {
    await openSection(page, "dataSources");
    // Its selects (a coach to grant, a team) appear deep in a flow; a probe select in the real panel gets the
    // same styles.
    await page.locator("main.workspace .data-sources").first().waitFor();
    const style = await page.evaluate(() => {
      const select = document.createElement("select");
      select.append(new Option("Choose a coach", ""));
      document.querySelector("main.workspace .data-sources").append(select);
      const s = getComputedStyle(select);
      const out = { font: s.fontSize, h: select.getBoundingClientRect().height };
      select.remove();
      return out;
    });
    assert.equal(style.font, "16px", "Data sources selects stay 16 px");
    assert.ok(style.h >= 44, `a Data sources select is ${style.h} px tall`);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});
