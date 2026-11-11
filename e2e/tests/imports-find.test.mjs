// Scenario 8: the whole Imports flow started in the UI. Find new sessions (the fake GPEXE source) -> the session review ->
// link the unlinked athlete from its row -> the review recomputes -> Import. Two coaches of the same team, at 1280 and 390 px:
// one with an explicit approver grant, who imports; one without the right, who reviews and links but is never offered Import.
// Invented data; the import writes into the disposable database.
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
const OPEN = '[data-action="training-load-gpexe-open"]';

async function findThroughUi(page) {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="imports"]');
  await page.waitForSelector('[data-action="training-load-gpexe-check"]', { timeout: 20_000 });
  assert.equal(await page.locator(OPEN).count(), 0, "nothing has been found yet");
  await page.click('[data-action="training-load-gpexe-check"]');
  // The sessions appear when the check ends (the screen polls the check).
  await page.waitForSelector(OPEN, { timeout: 60_000 });
}

async function openSession(page, day) {
  await page.locator(OPEN, { hasText: day }).first().click();
  await page.waitForSelector(".gpexe-detail .gpexe-review-table", { timeout: 20_000 });
}

async function linkFromRow(page, athleteId) {
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && /athlete-links$/.test(r.url())) posts.push(r.url()); });
  await page.locator(".gpexe-review-link select").selectOption(athleteId);
  await page.click('.gpexe-review-link [data-action="training-load-gpexe-link"]');
  await page.click('[data-action="training-load-gpexe-link-confirm"]');
  await page.waitForSelector(".gpexe-review-row.is-needs_link", { state: "detached", timeout: 20_000 });
  assert.equal(posts.length, 1, "one link request");
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`8a. (${label}) a coach with an approver grant: Find new sessions, link from the row, Import`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      const setup = await prepareImports(world, { check: false });
      const coachAccount = world.accounts.find((a) => a.role === "team_coach");
      const grant = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/approvers`, { userId: coachAccount.id, reason: "e2e: the team's coach approves its own imports" });
      assert.equal(grant.status, 201, `grant: ${JSON.stringify(grant.body)}`);
      const coach = await openAs(browser, world, "team_coach", width);
      try {
        coach.page.on("dialog", (d) => d.accept());
        await findThroughUi(coach.page);
        await openSession(coach.page, "05.11.");
        await linkFromRow(coach.page, world.ids.athleteIds[3]);
        const importBtn = coach.page.locator('[data-action="training-load-gpexe-approve"]').first();
        await importBtn.waitFor({ timeout: 20_000 });
        assert.equal((await importBtn.textContent()).trim(), "Import 3 athletes");
        await importBtn.click();
        const candidates = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates`)).body.candidates;
        const target = candidates.find((c) => String(c.gpexeTeamSessionId) === "9102");
        let status = null;
        for (let i = 0; i < 60; i += 1) {
          status = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates/${target.id}`)).body.candidate.status;
          if (status === "imported") break;
          await new Promise((r) => setTimeout(r, 500));
        }
        assert.equal(status, "imported", "the approver coach imported the session");
        const db = new pg.Client({ connectionString: world.databaseUrl });
        await db.connect();
        try {
          assert.equal(Number((await db.query(`select count(*) n from training_load.metric_event_participants`)).rows[0].n), 3);
        } finally { await db.end(); }
      } finally { await coach.context.close(); }
    } finally { await world.stop(); }
  });

  test(`8b. (${label}) a coach without the approval right: Find new sessions, link from the row, never offered Import`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    try {
      const setup = await prepareImports(world, { check: false });
      const coach = await openAs(browser, world, "team_coach", width);
      try {
        await findThroughUi(coach.page);
        await openSession(coach.page, "05.11.");
        await linkFromRow(coach.page, world.ids.athleteIds[3]);
        assert.equal(await coach.page.locator('[data-action="training-load-gpexe-approve"]').count(), 0, "no Import button without the right");
        assert.match((await coach.page.locator(".gpexe-detail").innerText()).replace(/\s+/g, " "), /Approving needs a platform admin or an explicit approver grant/);
        const candidates = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates`)).body.candidates;
        const target = candidates.find((c) => String(c.gpexeTeamSessionId) === "9102");
        const detail = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates/${target.id}`)).body.candidate;
        const refused = await setup.call("team_coach", "POST", `${G}/teams/${setup.teamId}/candidates/${target.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
        assert.ok([403, 404].includes(refused.status), `the server refuses the coach's approval (${refused.status})`);
        assert.equal((await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates/${target.id}`)).body.candidate.status, "pending");
      } finally { await coach.context.close(); }
    } finally { await world.stop(); }
  });
}
