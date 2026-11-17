// Settings > Source connections: a bound team's session time zone (after PR #587). The club admin, in the club's
// workspace, sets it and clears it with a reason; the server stores what the screen says. Invented data; the fake GPEXE
// source. 1280, 390 and 360 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openSettings } from "../lib/browser.mjs";

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const G = "/api/training-load/gpexe";
const SHOTS = process.env.E2E_SHOTS || "";
const CODE = /\b[a-z]+_[a-z_]+\b/;

async function openSourceConnections(page) {
  await openSettings(page);
  await page.click('.settings-tabs [data-section="sourceConnections"]');
  await page.waitForSelector(".source-connections-zone", { timeout: 20_000 });
}

async function layout(page, width) {
  const m = await page.evaluate(() => {
    const box = document.querySelector(".source-connections-zone");
    const r = box.getBoundingClientRect();
    const small = [...box.querySelectorAll("button:not(:disabled), select")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim() || b.tagName);
    const fonts = [...box.querySelectorAll("select, textarea")].map((f) => parseFloat(getComputedStyle(f).fontSize));
    return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, right: r.right, small, fonts };
  });
  assert.ok(m.scroll <= m.inner, `no horizontal page scroll at ${width} (${m.scroll} > ${m.inner})`);
  assert.ok(m.right <= m.inner + 0.5, `the line fits at ${width}`);
  assert.deepEqual(m.small, [], "every control is at least 44 px tall");
  assert.ok(m.fonts.every((f) => f >= 16), `16 px fields: ${m.fonts}`);
}

for (const width of [1280, 390, 360]) {
  test(`Source connections (${width} px): the club admin sets the team's session time zone, then clears it, each with a reason`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"] } });
    try {
      const setup = await prepareImports(world, { link: [], check: false });
      const admin = await openAs(browser, world, "club_admin", width);
      try {
        await openSourceConnections(admin.page);
        const zone = admin.page.locator(".source-connections-zone");
        assert.match(await zone.innerText(), /Session time zone:\s*Not set/);
        await admin.page.click('[data-action="source-connections-zone-change"]');
        await admin.page.selectOption('form[data-source-connections-form="zone"] select[name="timezone"]', "Europe/Sarajevo");
        await admin.page.fill('form[data-source-connections-form="zone"] textarea[name="reason"]', "Home sessions are in Sarajevo");
        await layout(admin.page, width);
        if (SHOTS) await admin.page.locator(".source-connections-bound").screenshot({ path: `${SHOTS}/sc-form-${width}.png` });
        await admin.page.click('form[data-source-connections-form="zone"] button[type="submit"]');
        await zone.filter({ hasText: "Saved. The team's time zone is Europe/Sarajevo." }).waitFor({ timeout: 20_000 });
        let stored = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/session-timezone`)).body.sessionTimezone;
        assert.equal(stored.current.timezone, "Europe/Sarajevo");
        assert.equal(stored.current.reason, "Home sessions are in Sarajevo");
        await layout(admin.page, width);
        if (SHOTS) await admin.page.locator(".source-connections-bound").screenshot({ path: `${SHOTS}/sc-saved-${width}.png` });
        // Clear: the consequence, a reason, then Not set.
        await admin.page.click('[data-action="source-connections-zone-clear"]');
        const clearForm = await zone.innerText();
        assert.match(clearForm, /sessions whose GPS units report different time zones are not imported until a time zone is set again/);
        await admin.page.fill('form[data-source-connections-form="zone"] textarea[name="reason"]', "Set by mistake");
        await admin.page.click('form[data-source-connections-form="zone"] button[type="submit"]');
        await zone.filter({ hasText: "Cleared. The team has no session time zone." }).waitFor({ timeout: 20_000 });
        stored = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/session-timezone`)).body.sessionTimezone;
        assert.equal(stored.current?.timezone ?? null, null, "cleared (the server keeps the clearing as a row with no zone)");
        assert.ok(!CODE.test(await zone.innerText()), "no code in the open");
        assert.equal(admin.pageErrors.length, 0, admin.pageErrors.join("\n"));
      } finally {
        await admin.context.close();
      }
    } finally {
      await world.stop();
    }
  });
}
