// Scenario 7: the coach's Imports flow through the UI against the fake GPEXE source - the session review, linking an
// unlinked athlete from its own row, the review recomputing with the new link, and the import by an administrator.
// Invented data only; the import writes into the disposable database. 1280 and 390 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
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
const importsTab = async (page) => {
  await openTrainingLoad(page);
  await page.click('[data-action="training-load-section"][data-section="imports"]');
  await page.waitForSelector('[data-action="training-load-gpexe-open"]', { timeout: 20_000 });
};
const openSession = async (page, day) => {
  await page.locator('[data-action="training-load-gpexe-open"]', { hasText: day }).first().click();
  await page.waitForSelector(".gpexe-detail .gpexe-review-table", { timeout: 20_000 });
};
const importButtonText = (page) => page.locator('[data-action="training-load-gpexe-approve"]').first().textContent().then((t) => t.trim());

// Each width gets its own world: the flow writes links and an import, so it cannot be repeated on the same data.
for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
test(`7. (${label}) the coach links the unlinked athlete from the row, the review recomputes, an administrator imports the session`, async () => {
  const world = await startWorld({ fakeSource: { visibleTeams: ["7001"], sessions: "imports" } });
  try {
  const setup = await prepareImports(world);
  const needs = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9102");
  const ready = setup.candidates.find((c) => String(c.gpexeTeamSessionId) === "9101");
  assert.deepEqual(needs.reasons.map((r) => r.code), ["athletes_not_linked"], "the session with an unlinked athlete says so");
  assert.equal(ready.reasons.length, 0);
  const hashBefore = needs.previewHash;
  const target = world.ids.athleteIds[3]; // an invented athlete of the team, not yet linked

  // The coach: review, link from the row, the review recomputes.
  const coach = await openAs(browser, world, "team_coach", width);
  try {
    await importsTab(coach.page);
    await openSession(coach.page, "05.11.2026");
    const rows = await coach.page.$$eval(".gpexe-review-row", (e) => e.map((x) => x.className));
    assert.ok(rows.some((c) => c.includes("is-needs_link")), "a row needs a link");
    assert.equal(rows.filter((c) => c.includes("is-needs_link")).length, 1);
    // Nothing is preselected: pressing Link without a choice sends nothing.
    const linkPosts = [];
    coach.page.on("request", (r) => { if (r.method() === "POST" && /athlete-links$/.test(r.url())) linkPosts.push(r.url()); });
    const select = coach.page.locator(".gpexe-review-link select");
    assert.equal(await select.inputValue(), "", "nothing is preselected");
    await coach.page.click('.gpexe-review-link [data-action="training-load-gpexe-link"]');
    assert.equal(linkPosts.length, 0, "no choice, no request");
    await select.selectOption(target);
    await coach.page.click('.gpexe-review-link [data-action="training-load-gpexe-link"]');
    assert.equal(linkPosts.length, 0, "choosing alone sends nothing: the confirmation comes first");
    await coach.page.click('[data-action="training-load-gpexe-link-confirm"]');
    await coach.page.waitForSelector(".gpexe-review-row.is-needs_link", { state: "detached", timeout: 20_000 });
    assert.equal(linkPosts.length, 1, "one link request");
    // The server's recomputed review: the athlete is mapped now and the hash moved.
    const detail = (await setup.call("team_coach", "GET", `${G}/teams/${setup.teamId}/candidates/${needs.id}`)).body.candidate;
    assert.notEqual(detail.previewHash, hashBefore, "the preview hash moved with the new link");
    assert.equal(detail.preview.athletes.find((a) => a.gpexeAthleteId === "121").athleteId, target);
    // A coach has no approval right: the review is read-only for them.
    assert.equal(await coach.page.locator('[data-action="training-load-gpexe-approve"]').count(), 0, "no Import button for a coach without the approval right");
  } finally {
    await coach.context.close();
  }

  // The platform administrator imports the recomputed review: all three athletes now.
  const admin = await openAs(browser, world, "platform_admin", width);
  try {
    admin.page.on("dialog", (d) => d.accept());
    await importsTab(admin.page);
    await openSession(admin.page, "05.11.2026");
    assert.equal(await importButtonText(admin.page), "Import 3 athletes");
    await admin.page.click('[data-action="training-load-gpexe-approve"]');
    let after = null;
    for (let i = 0; i < 60; i += 1) {
      after = (await setup.call("platform_admin", "GET", `${G}/teams/${setup.teamId}/candidates/${needs.id}`)).body.candidate;
      if (after.status === "imported") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const shown = (await admin.page.locator(".gpexe-detail").innerText()).replace(/\s+/g, " ").slice(0, 400);
    assert.equal(after.status, "imported", `the candidate is imported (status ${after.status}; screen: ${shown})`);
    // What was written: three athletes, nine results, every value with its source provenance.
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    try {
      const n = async (sql) => Number((await db.query(sql)).rows[0].n);
      assert.equal(await n(`select count(*) n from training_load.metric_event_participants`), 3);
      const values = await n(`select count(*) n from training_load.metric_values`);
      assert.ok(values > 0, "values were written");
      assert.equal(await n(`select count(*) n from training_load.metric_value_source_provenance`), values, "every written value has its source provenance");
      assert.equal(await n(`select count(*) n from training_load.metric_measurement_occasions`), 9, "nine results: three athletes, the whole session and two drills each");
    } finally {
      await db.end();
    }
  } finally {
    await admin.context.close();
  }
  } finally {
    await world.stop();
  }
});
}
