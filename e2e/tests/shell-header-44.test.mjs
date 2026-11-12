// S6 (shell) in a real browser: the coach and admin header's controls (workspace switcher, Notifications, Messages,
// Sign out) are 44 px at every width, not only on a phone. The "Online" pill keeps its size, the page does not overflow,
// and the athlete app's header is not touched by this change.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const header = (page) => page.evaluate(() => {
  const size = (sel) => { const e = document.querySelector(`.topbar ${sel}`); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; };
  return {
    switcher: size(".workspace-toggle"),
    notifications: size(".notification-toggle"),
    messages: size(".message-toggle"),
    signOut: size(".sign-out-button"),
    pill: size(".status-pill"),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});

for (const role of ["platform_admin", "club_admin", "team_coach"]) for (const width of [1280, 1024, 800, 761, 390]) test(`(${role}, ${width} px) every header control is 44 px; the Online pill is unchanged`, async () => {
  const { context, page, pageErrors } = await openAs(browser, world, role, width);
  try {
    await page.waitForFunction(() => document.querySelector("#apiStatus")?.textContent === "Online", null, { timeout: 20_000 });
    const h = await header(page);
    assert.ok(h.switcher[1] >= 44, `the switcher is ${h.switcher[1]} px tall`);
    for (const key of ["notifications", "messages", "signOut"]) assert.deepEqual(h[key], [44, 44], key);
    if (width > 760) {
      assert.equal(h.pill[0], 104, "the Online pill keeps its width");
      assert.ok(Math.abs(h.pill[1] - 31) <= 1, "the Online pill keeps its height within one pixel");
    }
    else assert.deepEqual(h.pill, [12, 12], "the Online dot keeps its size on a phone");
    assert.equal(h.overflow, 0);
    assert.deepEqual(pageErrors, []);
  } finally { await context.close(); }
});

test("(athlete, 1280 px) the athlete app's header is outside this change", async () => {
  const { context, page } = await openAs(browser, world, "athlete", 1280);
  try {
    await page.locator(".topbar .sign-out-button").waitFor();
    const h = await header(page);
    assert.deepEqual(h.signOut, [40, 40], "the athlete header keeps its 40 px controls (a separate decision)");
  } finally { await context.close(); }
});
