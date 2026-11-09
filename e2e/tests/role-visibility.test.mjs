// Scenario 4: Data configuration by role. A team coach sees the tab and only the reduced reads
// (Variables, Domains, Categories); everything else of the metrics API answers 404, the same as a
// resource that does not exist. A platform administrator sees every card and every read.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { api, launch, openAs, openSettings, openTrainingLoad, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await world?.stop();
});

const M = "/api/training-load/sources/metrics";
const COACH_READS = { variables: 200, classification: 200 };
const ADMIN_ONLY = ["fields", "mappings", "conversions", "activations", "source-instances", "targets"];

async function cards(page) {
  await page.click('[data-action="training-load-section"][data-section="variables"]');
  await page.waitForSelector("text=Variables");
  return (await page.$$eval(".training-load-root button", (e) => e.map((x) => x.textContent.trim().replace(/\s+/g, " ")))).filter(Boolean);
}
const has = (list, word) => list.some((t) => t.startsWith(word));

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`4a. (${label}) a team coach sees Data configuration with only Variables, Domains and Categories`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "team_coach", width);
    try {
      await openTrainingLoad(page);
      const tabs = await page.$$eval('[data-action="training-load-section"]', (e) => e.map((x) => x.textContent.trim()));
      assert.ok(tabs.includes("Data configuration"), "the coach has the Data configuration tab");
      const list = await cards(page);
      for (const word of ["Variables", "Domains", "Categories"]) assert.ok(has(list, word), `${word} is offered`);
      for (const word of ["Source fields", "Mappings"]) assert.ok(!has(list, word), `${word} is not offered to a coach`);
      assert.deepEqual(pageErrors, [], "no uncaught page error");
    } finally {
      await context.close();
    }
  });
}

test("4b. a team coach reads Variables and Domains & categories; every other metrics read is the identical 404", async () => {
  const { context } = await openAs(browser, world, "team_coach");
  try {
    for (const [route, status] of Object.entries(COACH_READS)) assert.equal(await api(context, world, `${M}/${route}`), status, `coach ${route}`);
    for (const route of ADMIN_ONLY) assert.equal(await api(context, world, `${M}/${route}`), 404, `coach ${route} is 404`);
    assert.equal(await api(context, world, `/api/training-load/sources/gpexe/connections?clubId=${world.ids.clubA}`), 404, "source connections are 404 for a coach");
    // A route that does not exist answers the same status, so nothing says "exists but forbidden".
    assert.equal(await api(context, world, `${M}/no-such-read`), 404);
  } finally {
    await context.close();
  }
});

test("4c. another team's coach gets the same reduced view and the same 404s (no other club's data)", async () => {
  const { context, page } = await openAs(browser, world, "other_team_coach");
  try {
    for (const route of ADMIN_ONLY) assert.equal(await api(context, world, `${M}/${route}`), 404, `other coach ${route} is 404`);
    await openTrainingLoad(page);
    const list = await cards(page);
    assert.ok(!has(list, "Source fields") && !has(list, "Mappings"));
  } finally {
    await context.close();
  }
});

test("4d. a platform administrator sees every card and every read", async () => {
  const { context, page } = await openAs(browser, world, "platform_admin");
  try {
    await openTrainingLoad(page);
    const list = await cards(page);
    for (const word of ["Variables", "Domains", "Categories", "Source fields", "Mappings"]) assert.ok(has(list, word), `${word} is offered to a platform admin`);
    for (const route of ["variables", "classification", "fields", "mappings", "conversions", "source-instances", "targets"]) assert.equal(await api(context, world, `${M}/${route}`), 200, `admin ${route}`);
  } finally {
    await context.close();
  }
});

test("4e. an athlete has no Training Load and the metrics reads answer as if they did not exist", async () => {
  const { context, page } = await openAs(browser, world, "athlete");
  try {
    assert.equal(await page.getByText("Training load", { exact: true }).count(), 0, "no Training load entry");
    for (const route of [...Object.keys(COACH_READS), ...ADMIN_ONLY]) {
      const status = await api(context, world, `${M}/${route}`);
      assert.ok([403, 404].includes(status), `athlete ${route} is refused (${status})`);
    }
  } finally {
    await context.close();
  }
});

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`4f. (${label}) Settings by role: a team coach gets My team (four tabs), a club admin keeps the organization tabs`, async () => {
    const coach = await openAs(browser, world, "team_coach", width);
    try {
      const tabs = await openSettings(coach.page);
      assert.deepEqual(tabs, ["Athletes", "Join links", "Tags & Presets", "Icons"]);
      const text = (await coach.page.locator(".organization-view").innerText()).replace(/\s+/g, " ");
      assert.match(text, /my team/i);
      assert.match(text, /first team/i);
      assert.match(text, /12 athletes/i);
      assert.doesNotMatch(text, /organization browser|all accessible organization|0 clubs|signed in as/i);
      assert.deepEqual(coach.pageErrors, [], "no uncaught page error");
    } finally {
      await coach.context.close();
    }
    const admin = await openAs(browser, world, "club_admin", width);
    try {
      const tabs = await openSettings(admin.page);
      for (const t of ["Overview", "Clubs", "Teams", "Users"]) assert.ok(tabs.includes(t), `the club admin keeps ${t}`);
      // The club admin reaches the team's athletes through the club membership the application always creates with the team's.
      assert.match((await admin.page.locator(".organization-view").innerText()).replace(/\s+/g, " "), /12 athletes/i, "the club admin sees the team's 12 athletes");
      assert.deepEqual(admin.pageErrors, []);
    } finally {
      await admin.context.close();
    }
  });
}
