// The platform administrator's Home reads the clubs summary. An answer that lands after a switch to a club workspace
// belongs to the old workspace and must not repaint the club's Home (it drew it as an empty club). The test holds
// that answer, switches workspace, then lets the answer through.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
  // The platform admin also administers Example Club, so the switcher offers that club's workspace.
  const db = new pg.Client({ connectionString: world.databaseUrl });
  await db.connect();
  try {
    const admin = world.accounts.find((a) => a.role === "platform_admin");
    await db.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1, $2, 'club_admin', true)`, [admin.id, world.ids.clubA]);
  } finally { await db.end(); }
});
after(async () => { await browser?.close(); await world?.stop(); });

test("(1280 px) a late clubs summary does not repaint the club's Home after a workspace switch", async () => {
  const context = await browser.newContext({ viewport: { width: WIDTHS.desktop, height: 900 } });
  const admin = world.accounts.find((a) => a.role === "platform_admin");
  await context.addCookies([{ name: "optimove_session", value: admin.sessionToken, url: world.baseUrl }]);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let heldCount = 0;
  await context.route("**/api/organization/clubs-summary*", async (route) => {
    heldCount += 1;
    if (heldCount === 1) await held;
    await route.continue();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  try {
    await page.goto(world.baseUrl);
    await page.getByText("Sign out").first().waitFor({ timeout: 20_000 });
    for (let i = 0; i < 100 && heldCount < 1; i += 1) await page.waitForTimeout(100);
    assert.ok(heldCount >= 1, "the platform Home asked for the clubs summary");
    await page.click("#workspaceToggle");
    await page.click(`[data-action="workspace-select"][data-workspace-type="club"][data-workspace-scope-id="${world.ids.clubA}"]`);
    await page.waitForSelector(".coach-home-grid .coach-home-panel-plan", { timeout: 20_000 });
    // The late answer must really reach the page, or the checks below would prove nothing.
    const lateAnswer = page.waitForResponse((r) => r.url().includes("/api/organization/clubs-summary"), { timeout: 20_000 });
    release();
    // It reaches the server after the switch, so the server may refuse it for the new workspace: either way it is a
    // late result of the old workspace (an answer or a failure), and neither may repaint the club's Home.
    const late = await lateAnswer;
    assert.ok(late.status() >= 200, `the held clubs summary reached the page after the switch (${late.status()})`);
    await page.waitForTimeout(1000);
    assert.equal(await page.locator(".coach-home-clubs").count(), 0, "no clubs list on the club's Home");
    assert.equal(await page.locator(".coach-home-grid .coach-home-panel-plan").count(), 1, "the club's athletes are still on screen");
    assert.equal(await page.locator(".coach-home-state-empty").count(), 0, "the club is not drawn as empty");
    assert.deepEqual(pageErrors, []);
  } finally {
    release();
    await context.close();
  }
});
