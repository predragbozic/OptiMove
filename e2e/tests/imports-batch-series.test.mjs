// Scenario 13 (U6a-3): one click on Import N ready imports three Ready sessions in several rounds through the real route.
// The server's batch time budget is 0 in this world (E2E_BATCH_BUDGET_MS, the e2e server process only), so every
// POST /imports approves exactly one session and answers the rest "not_attempted" / "batch_time_budget"; the screen
// sends the next round by itself with exactly those sessions and the hashes they were chosen with. Invented data; the
// imports are written into the disposable database. 1280 and 390 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { prepareImports } from "../lib/imports-setup.mjs";
import { launch, openAs, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`13. (${label}) one click imports three Ready sessions in three rounds; each round sends only what the server did not try`, async () => {
    const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "series", batchBudgetMs: 0 } });
    try {
      const setup = await prepareImports(world, { from: "2026-11-01", to: "2026-11-08" });
      const ready = setup.candidates.filter((c) => c.status === "pending" && c.previewStatus === "ready");
      assert.equal(ready.length, 3, `three Ready sessions: ${JSON.stringify(setup.candidates.map((c) => [c.status, c.previewStatus]))}`);
      const admin = await openAs(browser, world, "platform_admin", width);
      try {
        const posts = [];
        admin.page.on("request", (r) => { if (r.method() === "POST" && /\/imports$/.test(r.url())) posts.push(JSON.parse(r.postData() || "{}")); });
        await openTrainingLoad(admin.page);
        await admin.page.click('[data-action="training-load-section"][data-section="imports"]');
        await admin.page.click('[data-action="training-load-gpexe-import-ready"]', { timeout: 20_000 });
        await admin.page.click('[data-action="training-load-gpexe-batch-send"]', { timeout: 20_000 });
        await admin.page.waitForSelector('.imports-batch[aria-label="Import result"]', { timeout: 60_000 });
        assert.equal(posts.length, 3, "three requests from one click");
        const ids = posts[0].candidateIds;
        assert.equal(ids.length, 3);
        assert.deepEqual(posts[1].candidateIds, ids.slice(1), "round 2: only the two the server did not try");
        assert.deepEqual(posts[2].candidateIds, ids.slice(2), "round 3: only the last");
        for (const body of posts) for (const id of body.candidateIds) assert.equal(body.previewHashes[id], posts[0].previewHashes[id], "the hash the session was chosen with");
        const panel = await admin.page.locator(".imports-batch").innerText();
        assert.match(panel, /Imported 3 sessions/);
        assert.doesNotMatch(panel, /not tried|Not imported/i);
        const overflow = await admin.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `no horizontal overflow (${overflow})`);
      } finally {
        await admin.context.close();
      }
      const db = new pg.Client({ connectionString: world.databaseUrl });
      await db.connect();
      try {
        const n = (await db.query("select count(*)::int as n from training_load.gpexe_import_approvals where owner_team_id = $1", [setup.teamId])).rows[0].n;
        assert.equal(n, 3, "three approvals written, each once");
      } finally {
        await db.end();
      }
    } finally {
      await world.stop();
    }
  });
}
