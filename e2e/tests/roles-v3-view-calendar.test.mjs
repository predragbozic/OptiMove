// Roles V-3 (docs/ai/roles-v-steps-plan.md section 2.4): an account that holds only a new-style role of Example Club with
// calendar.view, in the club's view workspace:
//  - the Calendar opens and shows the club's event, with no New event;
//  - the event's panel is the reader's: no edit, cancel, delete or link control, no notes, and no athlete's name
//    (P-1: names need athletes.view, which no view workspace can use yet);
//  - no horizontal scroll at 1280, 390 and 360 px, and no page error.
// Every name is invented.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { createSession, hashPassword } from "../../backend/src/auth.js";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, request, WIDTHS } from "../lib/browser.mjs";

let world;
let browser;
let eventId;
let athleteNames = [];
const R = "/api/organization/roles";
const TITLE = "Club video meeting";
const NOTE = "Private planning note";

const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

before(async () => {
  world = await startWorld();
  browser = await launch();
  const client = new pg.Client({ connectionString: world.databaseUrl });
  await client.connect();
  try {
    await client.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]);
    athleteNames = (await client.query(`select display_name from public.athletes where id = any($1::uuid[])`, [world.ids.athleteIds.slice(0, 3)])).rows.map((r) => r.display_name);
    const id = (await client.query(
      `insert into public.users (email, first_name, last_name, full_name, display_name, password_hash) values ($1,'Viewer','Example','Viewer Example','Viewer Example',$2) returning id`,
      ["viewer.v3@example.invalid", hashPassword(`Demo-${crypto.randomBytes(9).toString("base64url")}`)])).rows[0].id;
    world.accounts.push({ role: "role_holder", id, email: "viewer.v3@example.invalid", label: "Viewer Example", sessionToken: await createSession(id, client) });
  } finally {
    await client.end();
  }
  const as = async (role) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "optimove_session", value: world.accounts.find((a) => a.role === role).sessionToken, url: world.baseUrl }]);
    return ctx;
  };
  const admin = await as("platform_admin");
  const clubAdmin = await as("club_admin");
  try {
    const types = JSON.parse((await request(clubAdmin, world, "/api/calendar/events/types")).text).types;
    const type = types.find((t) => t.kind === "meeting") || types[0];
    const made = await request(clubAdmin, world, "/api/calendar/events", { method: "POST", body: {
      requestKey: crypto.randomUUID(), eventTypeId: type.id, title: TITLE, day: localDay(), startTime: "16:00", endTime: "17:00",
      timezone: "UTC", notes: NOTE, targets: [{ kind: "team", id: world.ids.teamA }, { kind: "athlete", id: world.ids.athleteIds[0] }] } });
    assert.equal(made.status, 201, made.text);
    eventId = JSON.parse(made.text).event.id;
    const role = await request(admin, world, R, { method: "POST", body: { requestKey: crypto.randomUUID(), clubId: world.ids.clubA, scopeTypes: ["club"], items: ["org.view", "calendar.view"], name: "Club calendar" } });
    assert.equal(role.status, 200, role.text);
    const viewer = world.accounts.find((a) => a.role === "role_holder");
    const grant = await request(admin, world, `${R}/assignments`, { method: "POST", body: { requestKey: crypto.randomUUID(), reason: "Season", userId: viewer.id, roleId: JSON.parse(role.text).role.id, scopeType: "club", scopeId: world.ids.clubA } });
    assert.equal(grant.status, 200, grant.text);
  } finally {
    await admin.close();
    await clubAdmin.close();
  }
});

after(async () => {
  await browser?.close();
  await world?.stop();
});

const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const cardOf = (id) => `[data-action="central-calendar-open-item"][data-key^="event:${id}"]`;

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["360 px", 360]]) {
  test(`(${label}) the calendar in the view workspace: the club's event, read only, no names`, async () => {
    const { context, page, pageErrors } = await openAs(browser, world, "role_holder", width);
    try {
      const me = JSON.parse((await request(context, world, "/api/auth/me")).text).user;
      assert.equal(me.activeWorkspace.type, "club_view");
      assert.deepEqual([...me.permissions].sort(), ["calendar.view", "org.view"]);
      await navTo(page, "#calendarToggle");
      await page.waitForSelector(cardOf(eventId), { timeout: 20_000 });
      assert.equal(await page.locator('[data-action="central-calendar-new-event"]').count(), 0, "no New event");
      await page.locator(cardOf(eventId)).first().click();
      await page.locator(".cc-panel").first().getByText(TITLE).first().waitFor({ timeout: 20_000 });
      const toggle = page.locator('.cc-psec-toggle[data-key="athletes"]');
      if (await toggle.count()) await toggle.click();
      await page.waitForTimeout(800);
      if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/v3-panel-${width}.png` }).catch(() => {});
      const text = await page.locator(".cc-panel").first().textContent();
      assert.ok(!text.includes(NOTE), "no notes");
      for (const name of athleteNames) assert.ok(!text.includes(name), `no athlete name (${name})`);
      const writes = await page.$$eval(".cc-panel [data-action]", (els) => els.map((e) => e.dataset.action)
        .filter((a) => /edit|cancel-event|delete|link|attach|detach|fields|ask|question|align|enter-details/.test(a)));
      assert.deepEqual(writes, [], `no write control in the panel (${writes.join(", ")})`);
      assert.equal(await noSideScroll(page), true, "no horizontal scroll");
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
