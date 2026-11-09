// Scenario 1: sign-in and workspaces, every role, at 1280 and 390 px. Each demo account is signed in and sees only
// the navigation of its role; nobody sees another club's club, team or athletes; a resource of another club answers
// the identical 404 as one that does not exist. What a coach's Settings tabs ARE is asserted as observed (see the
// note in docs/ai/test-infrastructure-discovery.md 8.2): the privileged tabs must be absent, the isolation must hold.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";

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

const ZERO = "00000000-0000-0000-0000-000000000000";
const PRIVILEGED = ["Data sources", "Source connections", "Storage", "App health"];
const NAMES = ["Ana Example", "Bojan Example", "Luka Example", "Example Club", "First team", "U19 team"];

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`1a. (${label}) each role signs in and sees the Settings tabs of its role only`, async () => {
    const expectations = {
      platform_admin: { has: PRIVILEGED, hasNot: [] },
      club_admin: { has: ["Source connections"], hasNot: ["Data sources", "Storage", "App health"] },
      team_coach: { has: [], hasNot: PRIVILEGED },
      other_team_coach: { has: [], hasNot: PRIVILEGED },
      other_club_admin: { has: ["Source connections"], hasNot: ["Data sources", "Storage", "App health"] },
    };
    for (const [role, want] of Object.entries(expectations)) {
      const { context, page, pageErrors } = await openAs(browser, world, role, width);
      try {
        const tabs = await openSettings(page);
        for (const t of want.has) assert.ok(tabs.includes(t), `${role} has ${t} (tabs: ${tabs.join(", ")})`);
        for (const t of want.hasNot) assert.ok(!tabs.includes(t), `${role} does not have ${t} (tabs: ${tabs.join(", ")})`);
        assert.deepEqual(pageErrors, [], `${role}: no uncaught page error`);
      } finally {
        await context.close();
      }
    }
  });

  test(`1b. (${label}) an athlete has no Settings and no Training load, only the athlete's own view`, async () => {
    const { context, page } = await openAs(browser, world, "athlete", width);
    try {
      assert.equal(await page.getByText("Settings", { exact: true }).count(), 0, "no Settings entry");
      assert.equal(await page.getByText("Training load", { exact: true }).count(), 0, "no Training load entry");
      assert.ok((await page.locator("body").textContent()).includes("Weekly plan"), "the athlete's own pages are there (in the menu, open or folded)");
    } finally {
      await context.close();
    }
  });
}

test("1c. the workspaces each account can reach are its own and nothing else; a switch to another club's workspace is refused", async () => {
  const reach = async (role) => {
    const { context } = await openAs(browser, world, role);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text);
      const user = me.user || me;
      const put = await request(context, world, "/api/auth/workspace", { method: "PUT", body: { type: "club", scopeId: role.startsWith("other") ? world.ids.clubA : world.ids.clubB } });
      return { available: user.availableWorkspaces.map((w) => `${w.type}:${w.scopeId || ""}`), put: put.status };
    } finally {
      await context.close();
    }
  };
  const ids = world.ids;
  const own = {
    platform_admin: ["platform:"],
    club_admin: [`club:${ids.clubA}`],
    team_coach: [`team:${ids.teamA}`],
    other_team_coach: [`team:${ids.teamB}`],
    other_club_admin: [`club:${ids.clubB}`],
    athlete: ["athlete:"],
  };
  for (const [role, expected] of Object.entries(own)) {
    const r = await reach(role);
    assert.deepEqual(r.available.sort(), expected.sort(), `${role}: available workspaces`);
    if (role !== "platform_admin") assert.notEqual(r.put, 200, `${role} cannot switch to a club that is not theirs`);
  }
  // The club admin may stay in its own club (the same workspace is accepted) and nothing else is on offer.
  const { context } = await openAs(browser, world, "club_admin");
  try {
    const ok = await request(context, world, "/api/auth/workspace", { method: "PUT", body: { type: "club", scopeId: ids.clubA } });
    assert.equal(ok.status, 200);
    const other = await request(context, world, "/api/auth/workspace", { method: "PUT", body: { type: "club", scopeId: ids.clubB } });
    assert.equal(other.status, 403);
  } finally {
    await context.close();
  }
});

test("1d. the other club never sees our club, our team or our athletes: not in the app, not in the data, and a direct request is the identical 404", async () => {
  for (const role of ["other_team_coach", "other_club_admin"]) {
    const { context, page } = await openAs(browser, world, role);
    try {
      const org = (await request(context, world, "/api/organization")).text;
      for (const name of NAMES) assert.ok(!org.includes(name), `${role}: /api/organization does not contain "${name}"`);
      for (const id of [world.ids.clubA, world.ids.teamA, world.ids.teamA2, ...world.ids.athleteIds]) assert.ok(!org.includes(id), `${role}: /api/organization does not contain an id of the other club`);
      const shown = await page.locator("body").innerText();
      for (const name of NAMES) assert.ok(!shown.includes(name), `${role}: the screen does not show "${name}"`);
      const foreign = await request(context, world, `/api/training-load/gpexe/teams/${world.ids.teamA}/status`);
      const missing = await request(context, world, `/api/training-load/gpexe/teams/${ZERO}/status`);
      assert.equal(foreign.status, 404);
      assert.equal(foreign.text, missing.text, `${role}: a team of another club answers exactly like a team that does not exist`);
    } finally {
      await context.close();
    }
  }
});
