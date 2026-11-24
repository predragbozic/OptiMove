// The event panel's redesign (the owner's order of 2026-11-23), in the real app with its real styles at 1280, 390, 375
// and 360 px, on an event that holds a lot - eight linked trainings in eight forms and four linked activities (the
// manager's read is answered by the test; the calendar, the panel and its actions are the real app):
// - the head, then ONE "In this event" row (an icon and a count per kind), then folded sections; Athletes folded with
//   its count; ONE See each athlete with a chooser of the forms; Edit · Cancel event together at the bottom;
// - a section opens from its header and from its chip; a linked row's Unlink is in its "⋯" menu;
// - every visible control is a 44 px target, no horizontal page scroll, no page error.
// E2E_SHOTS=<dir> keeps the screenshots for the manager.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo, openAs, WIDTHS } from "../lib/browser.mjs";

const SHOTS = process.env.E2E_SHOTS || "";
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = iso(new Date());

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
});
after(async () => { await browser?.close(); await world?.stop(); });

async function call(role, method, path, body) {
  const account = world.accounts.find((a) => a.role === role);
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: `optimove_session=${account.sessionToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const overflow = (page, width) => page.evaluate((w) => Math.max(window.innerWidth - w, document.documentElement.scrollWidth - w), width);
// Every visible button of the panel shorter or narrower than a 44 px target.
const small = (page) => page.evaluate(() => [...document.querySelectorAll(".cc-panel button")]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 43.5 || r.width < 43.5) && !el.classList.contains("cc-sheet-backdrop"); })
  .map((el) => `${(el.getAttribute("aria-label") || el.textContent).trim().slice(0, 40)} ${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`));
async function shot(page, name) {
  if (!SHOTS) return;
  await page.locator(".cc-panel").first().screenshot({ path: `${SHOTS}/${name}.png` }).catch(() => {});
}
// The sheet (below 1024 px) or the side column scrolls inside: a shot of each screenful of the panel.
async function shotPanel(page, name) {
  if (!SHOTS) return;
  const panel = page.locator(".cc-panel").first();
  const { height, client } = await panel.evaluate((el) => ({ height: el.scrollHeight, client: el.clientHeight }));
  let i = 0;
  for (let top = 0; top < height && i < 6; top += Math.max(client - 40, 200), i += 1) {
    await panel.evaluate((el, y) => { el.scrollTop = y; }, top);
    await page.screenshot({ path: `${SHOTS}/${name}-${i + 1}.png` }).catch(() => {});
  }
  await panel.evaluate((el) => { el.scrollTop = 0; });
}

const FORMS = [
  ["AM", "B", "Activation"], ["AM", "T", "Main session"], ["AM", "A", "Recovery"], ["PM", "B", "Warm-up"],
  ["PM", "T", "Tactics"], ["PM", "A", "Stretching"], ["PM", "T", "Finishing"], ["PM", "T", "Set pieces"],
];

for (const [label, width] of [["1280 px", WIDTHS.desktop], ["390 px", WIDTHS.phone], ["375 px", 375], ["360 px", 360]]) {
  test(`(${label}) a busy event's panel: one summary row, folded sections, one See each athlete, the acts at the bottom`, async () => {
    const db = new pg.Client({ connectionString: world.databaseUrl });
    await db.connect();
    let uuidOf;
    try {
      await db.query("select calendar.seed_club_event_types($1)", [world.ids.clubA]).catch(() => {});
      uuidOf = Object.fromEntries((await db.query(`select id, full_name from public.athletes`)).rows.map((r) => [r.full_name, r.id]));
    } finally {
      await db.end();
    }
    const names = Object.keys(uuidOf).slice(0, 3);
    const types = (await call("club_admin", "GET", "/api/calendar/events/types")).body.types || [];
    const made = await call("club_admin", "POST", "/api/calendar/events", {
      requestKey: crypto.randomUUID(), eventTypeId: types.find((t) => t.kind === "training").id, title: `Busy training day ${label}`, day: DAY, startTime: "09:00", endTime: "19:30",
      timezone: "UTC", expects: [], targets: [{ kind: "team", id: world.ids.teamA }],
    });
    assert.equal(made.status, 201, made.text);
    const eventId = made.body.event.id;
    const { context, page, pageErrors } = await openAs(browser, world, "club_admin", width);
    try {
      // The manager's read carries eight linked forms and four linked activities (a real link needs a saved plan and an
      // import; the screens are the real ones). Nothing is written: the test presses no Unlink.
      await page.route(`**/api/calendar/events/${eventId}`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        const body = await res.json();
        const sessionLinks = FORMS.flatMap(([amPm, bta, name], i) => names.map((athlete, j) => ({
          id: `l-${i}-${j}`, planId: `plan-${j}`, day: DAY, amPm, bta, order: i + 1, state: "linked", sessionName: name, sessionNameAtLink: name, athleteId: uuidOf[athlete], athleteName: athlete,
        })));
        const activityLinks = ["GPS session AM", "GPS session PM", "Gym circuit", "Recovery run"].map((name, i) => ({
          id: `al-${i}`, activityId: `00000000-0000-4000-8000-00000000000${i}`, day: DAY, visible: true, name, origin: "api_import",
        }));
        body.event = { ...body.event, sessionLinks, activityLinks };
        return route.fulfill({ response: res, json: body });
      });
      await navTo(page, "#calendarToggle");
      await page.waitForSelector(".central-calendar", { timeout: 20_000 });
      const card = page.locator(`.cc-card[data-key^="event:${eventId}"]`).first();
      await card.waitFor({ timeout: 20_000 });
      await card.click();
      await page.waitForFunction(() => document.querySelector('.cc-sum-chip[data-key="trainings"] .cc-sum-count')?.textContent === "8", null, { timeout: 20_000 });

      // The order: head, summary, sections, See each athlete, Athletes, the acts at the bottom.
      const order = await page.evaluate(() => {
        const panel = document.querySelector(".cc-panel");
        const at = (sel) => [...panel.querySelectorAll("*")].indexOf(panel.querySelector(sel));
        return { title: at(".cc-panel-title"), summary: at(".cc-panel-summary"), trainings: at('.cc-psec[data-section="trainings"]'), see: at(".cc-see-each"), athletes: at('.cc-psec[data-section="athletes"]'), bottom: at(".cc-panel-bottom") };
      });
      assert.ok(order.title < order.summary && order.summary < order.trainings && order.trainings < order.see && order.see < order.athletes && order.athletes < order.bottom, JSON.stringify(order));
      const chips = await page.locator(".cc-sum-chip").evaluateAll((els) => els.map((el) => `${el.dataset.key}:${el.querySelector(".cc-sum-count").textContent}`));
      assert.deepEqual(chips, ["trainings:8", "activities:4"]);
      // Everything folded: no Unlink anywhere, no athlete row, one See each athlete.
      for (const id of ["trainings", "activities", "athletes"]) {
        assert.equal(await page.locator(`.cc-psec-toggle[data-key="${id}"]`).getAttribute("aria-expanded"), "false", `${id} folded`);
      }
      assert.equal(await page.locator('[data-act="unlink-sessions"], [data-act="unlink-activity"]').count(), 0);
      assert.equal(await page.locator(".cc-athletes").count(), 0);
      assert.equal(await page.locator(".cc-see-each button").count(), 1, "one See each athlete");
      // Eight trainings, six forms: three of them share the PM Training slot, which is one form of the Weekly plan.
      assert.match(await page.locator(".cc-see-each-choose").innerText(), /See each athlete\s*· 6 forms/);
      const acts = await page.locator(".cc-panel-bottom button").allInnerTexts();
      assert.deepEqual(acts.slice(0, 2), ["Edit", "Cancel event"], `the event's acts together at the bottom: ${acts}`);
      assert.ok(acts.length <= 3 && (acts.length === 2 || acts[2] === "Delete event"), String(acts));
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      await shot(page, `event-panel-layout-01-folded-${width}`);

      // A chip opens its section and brings it into view; a linked row's Unlink is behind "⋯".
      await page.locator('.cc-sum-chip[data-key="trainings"]').click();
      assert.equal(await page.locator('.cc-psec-toggle[data-key="trainings"]').getAttribute("aria-expanded"), "true");
      assert.equal(await page.locator('.cc-psec[data-section="trainings"] .cc-link-row').count(), 8);
      assert.equal(await page.locator('.cc-psec[data-section="trainings"] .cc-row-more').count(), 8);
      assert.equal(await page.locator('[data-act="unlink-sessions"]').count(), 0, "no Unlink button under each row");
      await page.locator('.cc-psec[data-section="trainings"] .cc-row-more').nth(1).click();
      const unlink = page.locator('.cc-row-menu [data-act="unlink-sessions"]');
      await unlink.waitFor();
      assert.equal(await page.locator(".cc-row-menu").count(), 1);
      // Escape closes the menu, the panel stays.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".cc-row-menu"));
      assert.equal(await page.locator(".cc-panel").count(), 1);
      await page.locator('.cc-psec[data-section="trainings"] .cc-row-more').nth(1).click();
      await unlink.waitFor();
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      await shot(page, `event-panel-layout-02-trainings-${width}`);

      // The header folds it again; the activities and the athletes open from their headers.
      await page.locator('.cc-psec-toggle[data-key="trainings"]').click();
      assert.equal(await page.locator('.cc-psec[data-section="trainings"] .cc-link-row').count(), 0);
      await page.locator('.cc-psec-toggle[data-key="activities"]').click();
      assert.equal(await page.locator('.cc-psec[data-section="activities"] .cc-link-row').count(), 4);
      await page.locator('.cc-psec-toggle[data-key="athletes"]').click();
      await page.locator(".cc-athletes .cc-athlete").first().waitFor({ timeout: 20_000 });
      // See each athlete: the chooser of the six forms, the same target per form.
      await page.locator(".cc-see-each-choose").click();
      assert.equal(await page.locator('.cc-see-each-forms [data-action="central-calendar-see-each-athlete"]').count(), 6);
      assert.deepEqual(await small(page), []);
      assert.equal(await overflow(page, width), 0);
      await shot(page, `event-panel-layout-03-opened-${width}`);
      await shotPanel(page, `event-panel-layout-04-scroll-${width}`);
      assert.deepEqual(pageErrors, []);
    } finally {
      await context.close();
    }
  });
}
