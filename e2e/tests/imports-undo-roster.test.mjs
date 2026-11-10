// Scenario 11 (O1 of J20, migration v60): a platform administrator undoes an imported session that carries roster work of both
// kinds - two attendance states the import flow set (origin 'import', written here the way J20-C's states route will) and a
// coach's later change in the Roster tab. The undo section shows the two warnings apart; the undo is not sent until the later
// changes' own box is ticked; then every roster row of the session is gone and the deletion log records both kinds.
// Invented data only; 1280 and 390 px; screenshots go to E2E_SHOT_DIR when it is set.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const G = "/api/training-load/gpexe";
const DAY = "2026-11-04";
const shot = (page, name) => page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/${name}.png` : "/dev/null", fullPage: false }).catch(() => {});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`11. (${label}) the administrator undoes an import with roster work: two warnings, the later changes only with their own tick`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      const setup = await prepareImports(world);
      const c = setup.candidates.find((x) => String(x.gpexeTeamSessionId) === "9101");
      const detail = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${c.id}`)).body.candidate;
      const approved = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/candidates/${c.id}/approve`, { previewHash: detail.previewHash, acceptChanges: false });
      assert.equal(approved.status, 200, JSON.stringify(approved.body).slice(0, 200));
      const approval = (await db.query(`select approved_by_user_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [c.id])).rows[0];
      const activityId = approval.activity_id;
      const roster = (await setup.call("team_coach", "GET", `/api/training-activity/${activityId}/roster`)).body;
      const needing = roster.athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId);
      assert.ok(needing.length >= 3, `athletes without device data: ${needing.length}`);
      // The import flow's states (J20-C): one request with origin 'import' by the approving administrator.
      const requestId = crypto.randomUUID();
      await db.query("begin");
      await db.query(
        `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
         select $1, x, $2, $3, 'participated_no_values', $4, 'platform_admin' from unnest($5::uuid[]) x`,
        [activityId, setup.teamId, requestId, approval.approved_by_user_id, needing.slice(0, 2)]);
      await db.query(
        `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin)
         values ($1, $2, gen_random_uuid(), repeat('a', 64), 'decide_bulk', $3, '{}'::jsonb, 'import')`, [requestId, activityId, approval.approved_by_user_id]);
      await db.query("commit");
      // The coach's later change in the Roster tab.
      const later = await setup.call("team_coach", "PUT", `/api/training-activity/${activityId}/roster/${needing[2]}/decision`,
        { kind: "did_not_participate", reasonKey: "illness", expectedDecisionId: null, requestKey: crypto.randomUUID() });
      assert.equal(later.status, 200, JSON.stringify(later.body).slice(0, 200));

      const admin = await openAs(browser, world, "platform_admin", width);
      try {
        const dialogs = [];
        admin.page.on("dialog", (d) => { dialogs.push(d.message()); d.accept(); });
        const undoPosts = [];
        admin.page.on("request", (r) => { if (r.method() === "POST" && /\/undo-import$/.test(r.url())) undoPosts.push(JSON.parse(r.postData() || "{}")); });
        await openTrainingLoad(admin.page);
        await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
        await admin.page.waitForSelector('[data-action="training-load-gpexe-open"]', { timeout: 20_000 });
        // The imported session is in the folded "Imported" group.
        await admin.page.locator("details.imports-bucket > summary", { hasText: /^Imported \(/ }).click();
        await admin.page.locator(`[data-action="training-load-gpexe-open"][data-candidate-id="${c.id}"]:visible`).first().click();
        await admin.page.waitForSelector('[data-action="training-load-gpexe-undo-open"]', { timeout: 20_000 }).catch(async (error) => {
          console.log("PAGE:", (await admin.page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 3000));
          throw error;
        });
        await admin.page.click('[data-action="training-load-gpexe-undo-open"]');
        await admin.page.waitForSelector("[data-gpexe-undo-later-confirm]", { timeout: 20_000 });
        const section = async () => (await admin.page.locator(".gpexe-undo").innerText()).replace(/\s+/g, " ");
        let text = await section();
        assert.match(text, /The undo also removes the 2 attendance states the import set\./);
        assert.match(text, /Attendance was changed in the Roster tab after the import: 1 change\./);
        assert.match(text, /Did not participate · Illness/);
        assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/, "no ids on the screen");
        // Touch target and no horizontal overflow at this width.
        const box = await admin.page.locator(".gpexe-undo-later-confirm").boundingBox();
        assert.ok(box && box.height >= 44, `the confirmation row is at least 44 px high (${box?.height})`);
        assert.ok(await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no horizontal overflow");
        await shot(admin.page, `undo-roster-1-warnings-${width}`);

        await admin.page.fill("[data-gpexe-undo-reason]", "Wrong athlete link");
        await admin.page.click('[data-action="training-load-gpexe-undo-confirm"]');
        await admin.page.waitForFunction(() => /Remove these later changes too" to continue/.test(document.body.innerText), null, { timeout: 10_000 });
        assert.deepEqual([dialogs.length, undoPosts.length], [0, 0], "nothing is asked or sent without the tick");

        await admin.page.check("[data-gpexe-undo-later-confirm]");
        await admin.page.click('[data-action="training-load-gpexe-undo-confirm"]');
        await admin.page.waitForFunction(() => /Import undone\./.test(document.body.innerText), null, { timeout: 30_000 });
        assert.equal(dialogs.length, 1);
        assert.match(dialogs[0], /This also removes 1 later attendance change made in the Roster tab\./);
        assert.equal(undoPosts.length, 1);
        assert.equal(undoPosts[0].confirmLaterRosterWork, undefined, "the fingerprint alone is the confirmation");
        assert.match(undoPosts[0].laterRosterFingerprint, /^[0-9a-f]{64}$/);
        await shot(admin.page, `undo-roster-2-done-${width}`);
      } finally {
        await admin.context.close();
      }
      const n = async (sql) => Number((await db.query(sql, [activityId])).rows[0].n);
      assert.equal(await n(`select count(*) n from training.activity_athlete_decisions where activity_id = $1`), 0);
      assert.equal(await n(`select count(*) n from training.activity_roster_requests where activity_id = $1`), 0);
      assert.equal(await n(`select count(*) n from training.activity_completions where activity_id = $1`), 0);
      assert.equal(await n(`select count(*) n from training.activity_completion_log where activity_id = $1`), 0);
      const log = (await db.query(`select roster_work_removed r, deleted_by_user_id from training_load.import_deletion_log`)).rows;
      assert.equal(log.length, 1);
      assert.equal(log[0].r.import_written.decisions, 2);
      assert.equal(log[0].r.later.decisions, 1);
      assert.equal(log[0].r.confirmed_by, log[0].deleted_by_user_id);
    } finally {
      await db.end();
      await world.stop();
    }
  });
}
