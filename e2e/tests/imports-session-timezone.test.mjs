// PR #587 in the Imports review: a session whose GPS units report two time zones stays out of the import until the team has
// a session time zone. The club admin (in the club's workspace) sets it in the review, searches the session's day again,
// and the session becomes importable; a coach reads one sentence telling them to ask the club's admin. Invented data; the
// fake GPEXE source. 1280, 390 and 360 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad } from "../lib/browser.mjs";
import { SESSION_MIXED_TZ } from "../lib/imports-fixture.mjs";

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

async function openMixedReview(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="imports"]');
  await page.waitForSelector('[data-attention-group="data"]', { timeout: 20_000 });
  await page.click('[data-attention-group="data"] [data-action="training-load-gpexe-open"]');
  await page.waitForSelector(".gpexe-blocked", { timeout: 20_000 });
}

async function layout(page, width) {
  const m = await page.evaluate(() => {
    const box = document.querySelector(".gpexe-tz");
    const small = box ? [...box.querySelectorAll("button:not(:disabled), select")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim() || b.tagName) : ["no box"];
    const r = box?.getBoundingClientRect();
    const fonts = box ? [...box.querySelectorAll("select, textarea")].map((f) => parseFloat(getComputedStyle(f).fontSize)) : [];
    return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, small, right: r?.right ?? 0, boxScroll: box ? box.scrollWidth - box.clientWidth : 0, fonts };
  });
  assert.ok(m.scroll <= m.inner, `no horizontal page scroll at ${width} (${m.scroll} > ${m.inner})`);
  assert.ok(m.boxScroll <= 1 && m.right <= m.inner + 0.5, `the form fits at ${width}`);
  assert.deepEqual(m.small, [], "every control is at least 44 px tall");
  assert.ok(m.fonts.every((f) => f >= 16), `16 px fields (no iOS zoom): ${m.fonts}`);
}

for (const width of [1280, 390, 360]) {
  test(`Session time zone (${width} px): the club admin sets it in the review, searches the day again, and the session becomes importable`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "mixedtz" } });
    try {
      const setup = await prepareImports(world);
      const mixed = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === String(SESSION_MIXED_TZ));
      assert.equal(mixed?.status, "blocked", "the session is held back before the zone is set");
      assert.equal((await setup.call("club_admin", "GET", `${G}/teams/${setup.teamId}/status`)).body.viewer?.sessionTimezoneAdmin, true);
      const admin = await openAs(browser, world, "club_admin", width);
      try {
        const puts = [];
        admin.page.on("request", (r) => { if (r.method() === "PUT") puts.push(new URL(r.url()).pathname); });
        await openMixedReview(admin.page);
        const before = (await admin.page.locator(".gpexe-blocked").innerText()).replace(/\s+/g, " ");
        assert.match(before, /Set the team's time zone, then find new sessions again with dates that include 04\.11\.2026\./);
        assert.ok(!CODE.test(before) && !/Technical details/.test(before), `no code for the club admin: ${before.match(CODE)}`);
        await admin.page.click('[data-action="training-load-gpexe-tz-open"]');
        await admin.page.waitForSelector("select[data-gpexe-tz-zone]");
        assert.match(await admin.page.locator(".gpexe-tz").innerText(), /The team's time zone: not set/);
        await layout(admin.page, width);
        if (SHOTS) await admin.page.locator(".gpexe-blocked").screenshot({ path: `${SHOTS}/tz-form-${width}.png` });
        await admin.page.selectOption("select[data-gpexe-tz-zone]", "Europe/Sarajevo");
        await admin.page.fill("textarea[data-gpexe-tz-reason]", "Home sessions are in Sarajevo");
        await admin.page.click('[data-action="training-load-gpexe-tz-save"]');
        await admin.page.locator(".gpexe-tz", { hasText: "The team's time zone is Europe/Sarajevo." }).waitFor({ timeout: 20_000 });
        assert.deepEqual(puts, [`${G}/teams/${setup.teamId}/session-timezone`], "one save");
        const stored = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/session-timezone`)).body.sessionTimezone;
        assert.equal(stored.current.timezone, "Europe/Sarajevo");
        assert.equal(stored.current.reason, "Home sessions are in Sarajevo");
        await layout(admin.page, width);
        if (SHOTS) await admin.page.locator(".gpexe-blocked").screenshot({ path: `${SHOTS}/tz-saved-${width}.png` });
        // The search the saved step offers: the session's own day.
        const search = admin.page.locator('.gpexe-tz [data-action="training-load-gpexe-check"]');
        assert.equal(await search.getAttribute("data-from"), "2026-11-04");
        assert.equal(await search.innerText(), "Find new sessions for 04.11.2026");
        await search.click();
        let after = null;
        for (let i = 0; i < 150 && !after; i += 1) {
          const list = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates`)).body.candidates || [];
          after = list.find((c) => String(c.gpexeTeamSessionId) === String(SESSION_MIXED_TZ) && c.status === "pending" && c.previewStatus === "ready") || null;
          if (!after) await new Promise((r) => setTimeout(r, 200));
        }
        assert.ok(after, "after the new search the session is importable");
        assert.equal(admin.pageErrors.length, 0, admin.pageErrors.join("\n"));
      } finally {
        await admin.context.close();
      }
    } finally {
      await world.stop();
    }
  });
}

test("Session time zone (coach, 390 px): one sentence to ask the club's admin, no form; the server refuses the coach too", async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "mixedtz" } });
  try {
    const setup = await prepareImports(world);
    assert.equal((await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/status`)).body.viewer?.sessionTimezoneAdmin, undefined);
    const coach = await openAs(browser, world, "team_coach", 390);
    try {
      await openMixedReview(coach.page);
      const text = (await coach.page.locator(".gpexe-blocked").innerText()).replace(/\s+/g, " ");
      assert.match(text, /It is not imported until the team has a time zone\. Ask your club's admin to set the team's time zone \(they can do it in this session's review\), then find new sessions again with dates that include 04\.11\.2026\./);
      assert.equal(await coach.page.locator(".gpexe-tz, [data-action='training-load-gpexe-tz-open']").count(), 0, "no form, no button");
      assert.ok(!CODE.test(text), "no code for the coach");
      assert.equal((await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/session-timezone`)).status, 403);
      assert.equal(coach.pageErrors.length, 0, coach.pageErrors.join("\n"));
    } finally {
      await coach.context.close();
    }
  } finally {
    await world.stop();
  }
});
