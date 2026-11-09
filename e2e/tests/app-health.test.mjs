// Scenario 6: Settings -> App health. One error is seeded the way the browser reports it (a POST by a signed-in
// coach); only a platform administrator sees the tab and the group (role "Coach"); everybody else has no tab and
// the groups route answers the identical 404 of an unknown route; no answer carries an e-mail or a name.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
  const { context } = await openAs(browser, world, "team_coach");
  try {
    const res = await request(context, world, "/api/app-errors", { method: "POST", body: { screen: "training-load", action: "e2e_seed", code: "e2e_seeded_error", status: 500 } });
    assert.equal(res.status, 204, "the seeded report is accepted");
  } finally {
    await context.close();
  }
});
after(async () => {
  await browser?.close();
  await world?.stop();
});

const PEOPLE = () => [...world.accounts.flatMap((a) => [a.email, a.label]), "Coach Example"];

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`6a. (${label}) the platform admin sees the App health tab and the seeded group with the role Coach`, async () => {
    const { context, page } = await openAs(browser, world, "platform_admin", width);
    try {
      const tabs = await openSettings(page);
      assert.ok(tabs.includes("App health"));
      await page.click('.settings-tabs [data-section="appHealth"]');
      await page.getByText("e2e_seeded_error").first().waitFor({ timeout: 15_000 });
      // The page header names the signed-in viewer; the App health section itself must name nobody.
      const text = (await page.locator("section.app-health").textContent()).replace(/\s+/g, " ");
      assert.match(text, /Coach/, "the group says which role was affected");
      for (const who of PEOPLE()) assert.ok(!text.includes(who), `the screen does not show "${who}"`);
    } finally {
      await context.close();
    }
  });
}

test("6b. the groups read gives the platform admin the group and carries no e-mail or name", async () => {
  const { context } = await openAs(browser, world, "platform_admin");
  try {
    const res = await request(context, world, "/api/app-errors/groups");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("e2e_seeded_error"));
    for (const who of PEOPLE()) assert.ok(!res.text.includes(who), `the answer does not contain "${who}"`);
    for (const a of world.accounts) assert.ok(!res.text.includes(a.id), "the answer does not contain a user id");
  } finally {
    await context.close();
  }
});

for (const role of ["club_admin", "team_coach", "athlete"]) {
  test(`6c. ${role}: no App health tab and the groups route is the identical 404 of an unknown route`, async () => {
    const { context, page } = await openAs(browser, world, role);
    try {
      if (role !== "athlete") assert.ok(!(await openSettings(page)).includes("App health"));
      const groups = await request(context, world, "/api/app-errors/groups");
      const unknown = await request(context, world, "/api/app-errors/no-such-route");
      assert.equal(groups.status, 404);
      assert.equal(unknown.status, 404);
      assert.equal(groups.text.replace("/groups", ""), unknown.text.replace("/no-such-route", ""), "the same body apart from the path");
      for (const who of PEOPLE()) assert.ok(!groups.text.includes(who));
    } finally {
      await context.close();
    }
  });
}
