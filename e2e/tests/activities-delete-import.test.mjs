// v76 (the owner, 2026-11-17): "Delete imported data" on an imported session, from Training Load > Activities, by whoever
// may import - here the team's coach while the team's switch is in mode `team`. The coach opens the session, deletes its
// imported data with a reason, reads the contract's sentence, and the session is gone; a code never shows. Invented data;
// the fake GPEXE source. 1280, 390 and 360 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad } from "../lib/browser.mjs";
import { enableTeamImportSwitch } from "../../backend/tests/support/team-import-switch.mjs";

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
const DAY = "2026-11-04";

async function openSessionInActivities(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="today"]').catch(async () => {
    await page.click('.training-load-tab:has-text("Data & Analysis")');
    await page.click('[data-action="training-load-section"][data-section="today"]');
  });
  await page.waitForSelector('[data-action="training-load-calendar-prev"]', { timeout: 20_000 });
  for (let i = 0; i < 8 && !(await page.locator(`[data-action="training-load-calendar-select-day"][data-date="${DAY}"]`).count()); i += 1) {
    await page.click('[data-action="training-load-calendar-prev"]');
    await page.waitForTimeout(300);
  }
  await page.click(`[data-action="training-load-calendar-select-day"][data-date="${DAY}"]`);
  await page.locator('[data-action="training-load-calendar-select-activity"]').first().click();
}

async function layout(page, width) {
  const m = await page.evaluate(() => {
    const box = document.querySelector(".tl-import-undo");
    const small = [...box.querySelectorAll("button:not(:disabled)")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim());
    const fonts = [...box.querySelectorAll("textarea")].map((f) => parseFloat(getComputedStyle(f).fontSize));
    return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, right: box.getBoundingClientRect().right, small, fonts };
  });
  assert.ok(m.scroll <= m.inner, `no horizontal page scroll at ${width} (${m.scroll} > ${m.inner})`);
  assert.ok(m.right <= m.inner + 0.5, `the section fits at ${width}`);
  assert.deepEqual(m.small, [], "every button is at least 44 px tall");
  assert.ok(m.fonts.every((f) => f >= 16), `16 px fields: ${m.fonts}`);
}

for (const width of [1280, 390, 360]) {
  test(`Delete imported data (${width} px): the team's coach deletes an imported session from Activities; the session is gone`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      const setup = await prepareImports(world);
      const platformAdminId = world.accounts.find((a) => a.role === "platform_admin").id;
      await enableTeamImportSwitch(db, setup.teamId, platformAdminId, { mode: "team" });
      const c = setup.candidates.find((x) => String(x.gpexeTeamSessionId) === "9101");
      const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${c.id}`)).body.candidate;
      const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${c.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
      assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 200));
      const activityId = (await db.query(`select activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id])).rows[0].activity_id;
      assert.equal((await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/status`)).body.viewer?.undoImport, true, "the coach may import, so may delete");

      const coach = await openAs(browser, world, "team_coach", width);
      try {
        const asked = [];
        coach.page.on("dialog", (d) => { asked.push(d.message()); d.accept(); });
        const posts = [];
        coach.page.on("request", (r) => { if (r.method() === "POST") posts.push(new URL(r.url()).pathname); });
        await openSessionInActivities(coach.page);
        const offer = coach.page.locator('[data-action="training-load-session-undo-open"]');
        await offer.waitFor({ timeout: 20_000 });
        await offer.click();
        const box = coach.page.locator(".tl-import-undo");
        await box.locator("textarea[data-gpexe-undo-reason]").waitFor({ timeout: 20_000 });
        const scope = (await box.innerText()).replace(/\s+/g, " ");
        assert.match(scope, /This removes the session from the calendar and deletes its imported data/);
        assert.match(scope, /Why are you deleting it\? \(required\)/);
        assert.ok(!CODE.test(scope) && !/Technical details/.test(scope), `no code for the coach: ${scope.match(CODE)}`);
        await box.locator("textarea[data-gpexe-undo-reason]").fill("Imported with the wrong athletes");
        await layout(coach.page, width);
        // The delete button is red here, as in the Imports review (mobile review).
        const colors = await coach.page.evaluate(() => {
          const b = document.querySelector('.tl-import-undo [data-action="training-load-gpexe-undo-confirm"]');
          const probe = document.createElement("span");
          probe.style.color = "var(--danger)";
          document.body.append(probe);
          const danger = getComputedStyle(probe).color;
          probe.remove();
          return { bg: getComputedStyle(b).backgroundColor, danger, radius: getComputedStyle(b).borderTopLeftRadius };
        });
        assert.equal(colors.bg, colors.danger, "the delete button is red");
        assert.notEqual(colors.radius, "0px", "the delete button is styled, not the browser's default");
        if (SHOTS) await box.screenshot({ path: `${SHOTS}/del-form-${width}.png` }).catch(() => {});
        await box.locator('[data-action="training-load-gpexe-undo-confirm"]').click();
        await box.filter({ hasText: "The imported data is deleted." }).waitFor({ timeout: 30_000 });
        // The manager's two sentences: back in Imports (offered again, review ready) or the dated search.
        assert.match((await box.innerText()).replace(/\s+/g, " "), /The imported data is deleted\. (The session is back in Imports: correct the athlete links if they were wrong, then import it again there\.|To import it again, find new sessions in Imports with dates that include 04\.11\.2026\.)/);
        assert.equal(asked.length, 1, "one question before the delete");
        assert.match(asked[0], /^Delete the imported data of /);
        assert.deepEqual(posts.filter((p) => p.endsWith("/undo-import")), [`${G}/teams/${setup.teamId}/candidates/${c.id}/undo-import`]);
        if (SHOTS) await box.screenshot({ path: `${SHOTS}/del-done-${width}.png` }).catch(() => {});
        const after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${c.id}`)).body.candidate;
        assert.ok(after.importUndoneAt, "the import is undone on the server");
        const lookup = await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/activities/${activityId}/import-undo`);
        assert.equal(lookup.status, 404, "nothing left to delete");
        await coach.page.click('.tl-import-undo [data-action="training-load-calendar-clear-activity"]');
        await coach.page.waitForFunction((id) => !document.querySelector(`[data-action="training-load-calendar-select-activity"][data-activity-id="${id}"]`), activityId, { timeout: 20_000 });
        assert.equal(coach.pageErrors.length, 0, coach.pageErrors.join("\n"));
      } finally {
        await coach.context.close();
      }
    } finally {
      await db.end();
      await world.stop();
    }
  });
}
