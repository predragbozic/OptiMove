// Scenario 3: Source connections against the fake GPEXE source (the in-process fake of the backend tests, answering
// only the one approved host; marker credentials, no network). Club admin, in its own club: Create -> Connect (the fake
// pair, typed into the form) -> Test -> Bind the approved pair -> Unbind with a reason, each step with its expected
// state on the screen and in the answer. The platform admin sees the same; a coach has no tab and the identical 404;
// another club's admin does not learn the connection exists; the password appears in no HTML, URL or response.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { startWorld } from "../lib/world.mjs";
import { launch, openAs, openSettings, request, WIDTHS } from "../lib/browser.mjs";
import { FAKE_PASSWORD, FAKE_TOKEN, FAKE_USERNAME } from "../../backend/tests/support/gpexe-fake-source.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld({ fakeSource: { visibleTeams: ["7001", "7002"] } });
  browser = await launch();
  // The platform admin approves the pair OptiMove team <-> GPEXE team 7001 (the club admin can only bind an approved pair).
  const { context } = await openAs(browser, world, "platform_admin");
  try {
    const res = await request(context, world, `/api/training-load/gpexe/teams/${world.ids.teamA}/settings`, { method: "PUT", body: { gpexeTeamId: "7001" } });
    assert.equal(res.status, 200);
  } finally {
    await context.close();
  }
});
after(async () => {
  await browser?.close();
  await world?.stop();
});

const S = "/api/training-load/sources/gpexe";
const ZERO = "00000000-0000-0000-0000-000000000000";
const json = (r) => JSON.parse(r.text);

async function sourceScreen(page) {
  await openSettings(page);
  await page.click('.settings-tabs [data-section="sourceConnections"]');
  await page.waitForSelector("text=Club account (label only)", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
  return (await page.locator(".training-load-root, main, #app").first().innerText()).replace(/\s+/g, " ");
}

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone]]) {
  test(`3a. (${label}) club admin: Create -> Connect -> Test -> Bind -> Unbind, each step with its state; the password is nowhere`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    const seen = [];
    page.on("response", async (r) => { if (r.url().includes("/api/")) seen.push(await r.text().catch(() => "")); });
    const requestUrls = [];
    page.on("request", (r) => requestUrls.push(r.url()));
    try {
      // Create (API: the form's own request) -> not connected.
      const created = await request(context, world, `${S}/connections`, { method: "POST", body: { ownerScope: "club", ownerClubId: world.ids.clubA, hostKey: "server3", accountLabel: `Club account (label only)`, credentialKind: "exchanged_token" } });
      assert.equal(created.status, 201);
      const id = json(created).connection.id;
      assert.equal(json(created).connection.state, "not_connected");
      let text = await sourceScreen(page);
      assert.match(text, /Not connected/);
      assert.match(text, /None stored yet/);

      // Connect with the fake pair, typed into the real form.
      await page.click('[data-action="source-connections-connect-open"]');
      await page.fill('input[name="username"]', FAKE_USERNAME);
      await page.fill('input[name="password"]', FAKE_PASSWORD);
      assert.equal(await page.getAttribute('input[name="password"]', "type"), "password");
      await page.locator('form:has(input[name="password"]) button[type="submit"]').click();
      await page.getByText("Access token stored, encrypted").first().waitFor({ timeout: 20_000 });
      text = await sourceScreen(page);
      assert.match(text, /Verified/);
      assert.match(text, /Access token stored, encrypted\. It is never shown\./);
      assert.match(text, /Bound teams None yet/);
      let read = json(await request(context, world, `${S}/connections/${id}`)).connection;
      assert.equal(read.state, "verified");

      // Test: still verified, and the approved pair is offered.
      const tested = await request(context, world, `${S}/connections/${id}/test`, { method: "POST", body: {} });
      assert.equal(tested.status, 200);
      assert.equal(json(tested).result.state, "verified");
      const offered = json(tested).result.sourceTeams;
      assert.deepEqual(offered.map((t) => [t.sourceTeamId, t.approvedTeamName]), [["7001", "First team"], ["7002", null]]);

      // Bind the approved pair.
      const bound = await request(context, world, `${S}/connections/${id}/bindings`, { method: "POST", body: { teamId: world.ids.teamA, sourceTeamId: "7001" } });
      assert.equal(bound.status, 201);
      const bindingId = json(bound).result.binding.bindingId;
      assert.equal(json(bound).result.binding.state, "active");
      text = await sourceScreen(page);
      assert.match(text, /Bound teams 1 team/);
      assert.match(text, /First team GPEXE team 7001/);
      // A pair that was not approved is refused.
      const refused = await request(context, world, `${S}/connections/${id}/bindings`, { method: "POST", body: { teamId: world.ids.teamA2, sourceTeamId: "7002" } });
      assert.ok([404, 409].includes(refused.status), `an unapproved pair is refused (${refused.status})`);

      // Unbind with a reason.
      const unbound = await request(context, world, `${S}/connections/${id}/bindings/${bindingId}/unbind`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "e2e: ending the binding", expected: { teamId: world.ids.teamA, sourceTeamId: "7001" } } });
      assert.equal(unbound.status, 200);
      assert.equal(json(unbound).result.binding.state, "ended");
      text = await sourceScreen(page);
      assert.match(text, /Bound teams None yet/);

      // The password and the token are in no answer, no page and no address.
      const html = await page.content();
      for (const secret of [FAKE_PASSWORD, FAKE_TOKEN]) {
        assert.ok(!html.includes(secret), "not in the page");
        assert.ok(!requestUrls.some((u) => u.includes(secret)), "not in a URL");
        assert.ok(!seen.some((t) => t.includes(secret)), "not in an answer the browser received");
        for (const body of [created, tested, bound, unbound]) assert.ok(!body.text.includes(secret), "not in an API answer");
      }
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}

test("3b. the platform admin sees the club's connection with the same state; a coach, the other club's admin and the other club's coach get the identical 404", async () => {
  const admin = await openAs(browser, world, "club_admin");
  let id;
  try {
    const list = json(await request(admin.context, world, `${S}/connections?clubId=${world.ids.clubA}`));
    id = list.connections[0].id;
  } finally {
    await admin.context.close();
  }
  const pa = await openAs(browser, world, "platform_admin");
  try {
    const got = await request(pa.context, world, `${S}/connections/${id}`);
    assert.equal(got.status, 200);
    assert.equal(json(got).connection.state, "verified");
    assert.equal((await request(pa.context, world, `${S}/connections?clubId=${world.ids.clubA}`)).status, 200);
  } finally {
    await pa.context.close();
  }
  for (const role of ["team_coach", "other_club_admin", "other_team_coach", "athlete"]) {
    const { context, page } = await openAs(browser, world, role);
    try {
      const real = await request(context, world, `${S}/connections/${id}`);
      const none = await request(context, world, `${S}/connections/${ZERO}`);
      assert.equal(real.status, 404, `${role}: the connection is 404`);
      assert.equal(real.text, none.text, `${role}: it answers exactly like a connection that does not exist`);
      const lst = await request(context, world, `${S}/connections?clubId=${world.ids.clubA}`);
      assert.equal(lst.status, 404, `${role}: the list is 404`);
      if (role !== "athlete" && role !== "other_club_admin") assert.ok(!(await openSettings(page)).includes("Source connections"), `${role}: no Source connections tab`);
    } finally {
      await context.close();
    }
  }
});
