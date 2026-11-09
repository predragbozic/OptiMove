// Scenario 9: roster decisions on a team session through the UI. A session imported with 3 of the team's 12 athletes leaves
// 9 who need a state; the team's coach sets "Participated" for one, "Did not participate" (with a reason) for another and
// the remaining ones in one group action, and the server's roster agrees. Another team's coach gets the same 404 as for
// a session that does not exist. 1280 and 390 px. Invented data only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const G = "/api/training-load/gpexe";
const DAY = "2026-11-04";

async function importedActivity(world) {
  const setup = await prepareImports(world);
  const c = setup.candidates.find((x) => String(x.gpexeTeamSessionId) === "9101");
  const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${c.id}`)).body.candidate;
  const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${c.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
  assert.equal(approved.status, 200, `import: ${JSON.stringify(approved.body).slice(0, 200)}`);
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    const rows = (await db.query(`select id from training.activities where origin = 'source_import' and occurred_local_date = $1`, [DAY])).rows;
    assert.equal(rows.length, 1);
    return { setup, activityId: rows[0].id };
  } finally { await db.end(); }
}

async function openRoster(page) {
  await openTrainingLoad(page);
  // The session is of the week before today: go one week back, pick the day, the session, then the Roster tab.
  await page.click('[data-action="training-load-calendar-prev"]');
  await page.click(`[data-action="training-load-calendar-select-day"][data-date="${DAY}"]`);
  await page.locator('[data-action="training-load-calendar-select-activity"]').first().click();
  await page.locator(".tl-activity-detail-tab", { hasText: "Roster" }).click();
  await page.waitForSelector('[data-action="training-load-roster-filter"]', { timeout: 20_000 });
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`9. (${label}) the coach sets roster states on an imported team session; another team's coach cannot see it`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      const { setup, activityId } = await importedActivity(world);
      const coach = await openAs(browser, world, "team_coach", width);
      try {
        await openRoster(coach.page);
        const text = async () => (await coach.page.locator(".tl-activity-detail").first().innerText().catch(() => "")).replace(/\s+/g, " ");
        const page = coach.page;
        assert.match(await page.locator("body").innerText().then((t) => t.replace(/\s+/g, " ")), /12 on the roster · 9 need a state/);

        // One athlete: Participated, saved at once.
        await page.locator('[data-action="training-load-roster-set"]').first().click();
        await page.waitForFunction(() => /8 need a state/.test(document.body.innerText), null, { timeout: 20_000 });

        // One athlete: Did not participate - the reason is chosen and the state is saved.
        await page.locator('[data-action="training-load-roster-absent"]').first().click();
        await page.locator('[data-action="training-load-roster-reason"]').first().click();
        await page.waitForFunction(() => /7 need a state/.test(document.body.innerText), null, { timeout: 20_000 });

        // The other seven in one group action: select them, choose the state, confirm.
        await page.locator('[data-action="training-load-roster-select-needing"]').click();
        if (width < 600) await page.getByRole("button", { name: /Set state/ }).click();
        const bulk = page.locator('[data-action="training-load-roster-bulk"], [data-action="training-load-roster-bulk-kind"][data-kind="participated_no_values"]').first();
        await bulk.click();
        await page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/roster-${width}.png` : "/dev/null" }).catch(() => {});
        await page.locator('[data-action="training-load-roster-bulk-apply"], [data-action="training-load-roster-confirm-proceed"]').first().click();
        await page.waitForFunction(() => /Everybody has a state/.test(document.body.innerText) && /Saved for 7 athletes/.test(document.body.innerText), null, { timeout: 20_000 });
      } finally { await coach.context.close(); }
      // The server agrees: nobody is left without a state, and the roster is complete or ready to complete.
      const roster = (await setup.call("team_coach", "GET", `/api/training-activity/${activityId}/roster`)).body;
      const flat = JSON.stringify(roster);
      void flat;
      const states = roster.athletes.map((a) => a.state);
      assert.equal(roster.athletes.length, 12);
      assert.equal(states.filter((x) => x === "measured").length, 3, "the three imported athletes stay measured");
      assert.equal(roster.athletes.filter((a) => a.group === "needs_state" || a.state === "unknown").length, 0, "nobody is left without a state");
      assert.equal(states.filter((x) => x === "did_not_participate").length, 1, "exactly one athlete was set as not participating");
      assert.equal(states.filter((x) => x === "participated_no_values").length, 8, "one single plus seven in the group action");
      // Another team's coach: byte-identical to a session that does not exist.
      const other = await fetch(`${world.baseUrl}/api/training-activity/${activityId}/roster`, { headers: { Cookie: `optimove_session=${world.accounts.find((a) => a.role === "other_team_coach").sessionToken}` } });
      const missing = await fetch(`${world.baseUrl}/api/training-activity/00000000-0000-4000-8000-000000000000/roster`, { headers: { Cookie: `optimove_session=${world.accounts.find((a) => a.role === "other_team_coach").sessionToken}` } });
      assert.equal(other.status, 404);
      assert.equal(other.status, missing.status);
      assert.equal(await other.text(), await missing.text(), "a foreign session answers exactly like a missing one");

    } finally { await world.stop(); }
  });
}
