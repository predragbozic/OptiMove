// Scenario 11 (O1, migration v60): an administrator undoes an imported session that carries roster work - the states the import flow
// wrote and a coach's later decision. The review lists both, the undo needs the explicit tick for the coach's work, and everything
// goes with the session. Invented data only; 1280 and 390 px; screenshots go to E2E_SHOT_DIR when it is set.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => {
  browser = await launch();
});
after(async () => {
  await browser?.close();
});

const G = "/api/training-load/gpexe";
const shot = (page, name) => page.screenshot({ path: process.env.E2E_SHOT_DIR ? `${process.env.E2E_SHOT_DIR}/${name}.png` : "/dev/null", fullPage: false }).catch(() => {});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
test(`11. (${label}) undoing an imported session with roster work: both kinds are listed, the coach's work needs its own tick, everything goes`, async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
    const setup = await prepareImports(world);
    const ready = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9101");
    const imported = await setup.call("platform_admin", "POST", `${G}/teams/${setup.teamId}/imports`, { candidateIds: [ready.id], previewHashes: { [ready.id]: ready.previewHash } });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    const adminId = world.accounts.find((a) => a.role === "platform_admin").id;
    const coachCookie = `optimove_session=${world.accounts.find((a) => a.role === "team_coach").sessionToken}`;
    try {
      const approval = (await db.query(`select metric_event_id, activity_id from training_load.gpexe_import_approvals where candidate_id = $1`, [ready.id])).rows[0];
      const roster = await (await fetch(`${world.baseUrl}/api/training-activity/${approval.activity_id}/roster`, { headers: { Cookie: coachCookie } })).json();
      const needing = roster.athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId).sort();
      assert.ok(needing.length >= 2, "athletes who need a state exist");
      // What the J20 flow will write (J20-C is not built): one import-origin request by the approver with one state.
      const requestId = crypto.randomUUID();
      await db.query("begin");
      await db.query(`insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result, origin) values ($1, $2, $3, $4, 'decide_bulk', $5, '{}'::jsonb, 'import')`, [requestId, approval.activity_id, crypto.randomUUID(), "a".repeat(64), adminId]);
      await db.query(`insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis) values ($1, $2, $3, $4, 'participated_no_values', $5, 'platform_admin')`, [approval.activity_id, needing[0], setup.teamId, requestId, adminId]);
      await db.query("commit");
      // A coach's later decision through the real route.
      const put = await fetch(`${world.baseUrl}/api/training-activity/${approval.activity_id}/roster/${needing[1]}/decision`, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: coachCookie }, body: JSON.stringify({ kind: "participated_no_values", expectedDecisionId: null, requestKey: crypto.randomUUID() }) });
      assert.equal(put.status, 200, await put.clone().text());
      const rows = async () => Number((await db.query(`select (select count(*) from training.activity_athlete_decisions where activity_id = $1) + (select count(*) from training.activity_roster_requests where activity_id = $1) n`, [approval.activity_id])).rows[0].n);
      assert.equal(await rows(), 4);

      const admin = await openAs(browser, world, "platform_admin", width);
      try {
        admin.page.on("dialog", (d) => d.accept());
        const posts = [];
        admin.page.on("request", (r) => { if (r.method() === "POST" && /undo-import$/.test(r.url())) posts.push(r.postDataJSON()); });
        await openTrainingLoad(admin.page);
        await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
        await admin.page.waitForSelector('[data-action="training-load-gpexe-open"]', { timeout: 20_000 });
        const opener = admin.page.locator(`[data-action="training-load-gpexe-open"][data-candidate-id="${ready.id}"]`);
        await opener.first().waitFor({ state: "attached", timeout: 20_000 }).catch(async () => {
          await shot(admin.page, `undo-roster-0-debug-${width}`);
          throw new Error(`the imported session is not listed: ${(await admin.page.locator("main, .content").first().innerText()).slice(0, 600)}`);
        });
        // The imported bucket may be folded: open every folded group that holds it.
        const folded = admin.page.locator("details:not([open]):has([data-candidate-id='" + ready.id + "'])");
        for (let i = 0; i < (await folded.count()); i += 1) await folded.nth(i).locator("summary").first().click();
        await opener.first().click();
        await admin.page.waitForSelector('[data-action="training-load-gpexe-undo-open"]', { timeout: 20_000 });
        await admin.page.click('[data-action="training-load-gpexe-undo-open"]');
        await admin.page.waitForSelector(".gpexe-undo-later", { timeout: 20_000 });
        const text = await admin.page.locator(".gpexe-undo").innerText();
        assert.match(text, /1 attendance state set at import will be removed\./);
        assert.match(text, /A coach has also worked on this session since the import\./);
        assert.match(text, /1 decision from the Roster tab/);
        assert.equal(await admin.page.locator(".gpexe-undo-later li").count(), 1);
        await shot(admin.page, `undo-roster-1-question-${width}`);
        // The box is a 44 px target on a phone.
        const box = await admin.page.locator("[data-gpexe-undo-confirm-later]").boundingBox();
        assert.ok(box.width >= 20 && box.height >= 20);
        const label44 = await admin.page.locator(".gpexe-undo-confirm").boundingBox();
        assert.ok(label44.height >= 44, `the tick's row is at least 44 px (${label44.height})`);
        await admin.page.fill("[data-gpexe-undo-reason]", "Linked to the wrong athletes");
        // Without the tick nothing is asked or sent.
        await admin.page.click('[data-action="training-load-gpexe-undo-confirm"]');
        assert.deepEqual(posts, []);
        assert.match(await admin.page.locator(".gpexe-undo").innerText(), /Tick the box to confirm/);
        await shot(admin.page, `undo-roster-2-needs-tick-${width}`);
        await admin.page.check("[data-gpexe-undo-confirm-later]");
        await admin.page.click('[data-action="training-load-gpexe-undo-confirm"]');
        await admin.page.waitForSelector(".gpexe-undo .gpexe-success", { timeout: 20_000 });
        assert.equal(posts.length, 1);
        assert.match(posts[0].confirmRosterFingerprint, /^[0-9a-f]{32}$/);
        const done = await admin.page.locator(".gpexe-undo").innerText();
        assert.match(done, /Import undone\./);
        assert.match(done, /The coach's 1 later decision on the roster was removed too\./);
        await shot(admin.page, `undo-roster-3-done-${width}`);
        assert.equal(await rows(), 0, "every roster row of the session is gone");
        const log = (await db.query(`select roster_work_removed w from training_load.import_deletion_log where event_id = $1`, [approval.metric_event_id])).rows[0].w;
        assert.equal(log.laterConfirmed, true);
        assert.equal(log.confirmedByUserId, adminId);
        assert.equal(log.later.decisions, 1);
        assert.equal(log.importWritten.decisions, 1);
      } finally {
        await admin.context.close();
      }
    } finally {
      await db.end();
    }
  } finally {
    await world.stop();
  }
});
}
