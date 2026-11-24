// K4b on the athlete's Calendar (docs/ai/central-calendar-k4b-contract.md; the stream manager's Q-A of 2026-11-20) in the
// real athlete app against the real server, at 1280, 390, 375 and 360 px. A team coach makes an RPE request for today
// (no event, so the athlete's calendar shows its own "RPE request" card); the athlete answers it through the real submit
// route; then, on the Calendar: "Your RPE: 7 · Change" with the deadline on that card, Change opens the change form
// filled in from her own weekly read, Save change goes through the real v83 route, and the card shows the new value
// with "Your answer was changed." Checked at every width: no horizontal scroll, Change and the form's buttons 44 px,
// the form's inputs at least 16 px (no iOS zoom).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch, navTo } from "../lib/browser.mjs";

let world;
let browser;
before(async () => {
  world = await startWorld();
  browser = await launch();
  // Her device's zone, reported as her browser does (POST /api/tests/athlete/timezone), before the first request: the
  // seed's Europe/Sarajevo would otherwise make the first request close at Sarajevo's 23:59 (22:59 in a UTC browser).
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const reported = await call("athlete", "POST", "/api/tests/athlete/timezone", { timezone: zone });
  assert.equal(reported.status, 200, reported.text);
});
after(async () => { await browser?.close(); await world?.stop(); });

const cookieOf = (role) => `optimove_session=${world.accounts.find((a) => a.role === role).sessionToken}`;
async function call(role, method, path, body) {
  const res = await fetch(`${world.baseUrl}${path}`, { method, headers: { "Content-Type": "application/json", Cookie: cookieOf(role) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const TODAY = iso(new Date());
const MONDAY = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();

// One answered RPE request of hers for today, named per width so each run has its own card.
async function answeredRequest(name) {
  const made = await call("team_coach", "POST", "/api/training-load/external-schedules", {
    eventName: name, scheduleKind: "one_time", startDate: TODAY, timezone: "UTC", opensTime: "00:00", closesTime: "23:59",
    targets: [{ kind: "team", id: world.ids.teamA }],
    notificationRules: [{ kind: "athlete_invitation", enabled: false }, { kind: "athlete_reminder", enabled: false, reminderOffsetMinutes: 60 }, { kind: "final_digest", enabled: false }],
  });
  assert.equal(made.status, 201, made.text);
  const weekly = await call("athlete", "GET", `/api/training-load/weekly?weekStart=${MONDAY}`);
  assert.equal(weekly.status, 200, weekly.text);
  const row = weekly.body.days.flatMap((d) => d.sessions).find((s) => s.source === "scheduled_external" && s.sessionName === name);
  assert.ok(row?.externalAssignmentId, `her request "${name}" is in her week`);
  const sent = await call("athlete", "POST", `/api/training-load/external-assignments/${row.externalAssignmentId}/rpe`, { rpe: 7, durationMinutes: 60, note: "first" });
  assert.ok([200, 201].includes(sent.status), sent.text);
  return row.externalAssignmentId;
}

async function openCalendar(width, { prepare = null, ready = ".athlete-calendar .ac-card" } = {}) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await prepare?.(page);
  await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
  await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  await navTo(page, '.sidebar [data-athlete-tab="athlete-calendar"]');
  await page.locator(ready).first().waitFor({ timeout: 20_000 });
  return { context, page, pageErrors, phone };
}

const small = (page, scope) => page.evaluate((s) => [...document.querySelectorAll(`${s} button`)]
  .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 43.5; })
  .map((el) => `${el.textContent.trim()} ${Math.round(el.getBoundingClientRect().height)}`), scope);

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) her RPE request card: Your RPE: 7 · Change, the change form from the Calendar, the new value after Save change`, async () => {
    const name = `Match RPE ${width}`;
    const assignmentId = await answeredRequest(name);
    const a = await openCalendar(width);
    try {
      const card = a.page.locator(".ac-card-external", { has: a.page.locator(".ac-card-title", { hasText: name }) });
      const change = card.locator(`[data-action="athlete-calendar-rpe-change"][data-assignment-id="${assignmentId}"]`);
      await change.waitFor({ timeout: 20_000 });
      const line = (await card.locator("[data-ac-answer]").textContent()).replace(/\s+/g, " ").trim();
      // 23:59 exactly: the request closes at 23:59 in her own (the browser's) zone.
      assert.equal(line, "Your RPE: 7 Change You can change it until 23:59.");
      assert.deepEqual(await small(a.page, ".athlete-calendar"), [], "44 px targets on the Calendar");
      assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no horizontal scroll");
      await a.page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/k4b-calendar-line-${width}.png`, fullPage: true }).catch(() => {});

      await change.click();
      const heading = a.page.locator(".training-load-rpe-form h3, [role=dialog] h3").filter({ hasText: "Change your RPE" }).first();
      await heading.waitFor({ timeout: 10_000 });
      // The heading names the request; her tag "RPE request" follows it (K4 follow-ups, 2c).
      assert.equal((await heading.textContent()).replace(/\s+/g, " ").trim(), `Change your RPE · ${name}RPE request`);
      const sheet = await a.page.evaluate(() => {
        const root = [...document.querySelectorAll("h3")].find((h) => /Change your RPE/.test(h.textContent))?.closest("form, [role=dialog], section, .panel");
        const inputs = [...(root?.querySelectorAll("input:not([type=range]):not([type=hidden]), textarea, select") || [])].filter((el) => el.getBoundingClientRect().width > 0);
        return {
          text: root?.textContent.replace(/\s+/g, " ") || "",
          fonts: inputs.map((el) => parseFloat(getComputedStyle(el).fontSize)),
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.match(sheet.text, /Your answer: 7, sent at \d\d:\d\d\./);
      // iOS zooms into a field under 16 px: the rule is the phone's.
      if (a.phone) assert.ok(sheet.fonts.length > 0 && sheet.fonts.every((f) => f >= 16), `inputs at least 16 px ${JSON.stringify(sheet.fonts)}`);
      if (a.phone) assert.deepEqual(await small(a.page, ".training-load-rpe-panel"), [], "the form's buttons are 44 px targets");
      assert.equal(sheet.overflow, 0, "no horizontal scroll with the form open");
      await a.page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/k4b-calendar-form-${width}.png` }).catch(() => {});

      // RPE 5 on the scale, then Save change through the real v83 route.
      await a.page.locator('[data-action="training-load-rpe-slider-input"]').first().fill("5");
      const save = a.page.getByRole("button", { name: "Save change" });
      if (a.phone) assert.ok((await save.boundingBox()).height >= 43.5, "Save change is a 44 px target");
      const answered = a.page.waitForResponse((r) => r.url().includes(`/external-assignments/${assignmentId}/rpe/change`));
      await save.click();
      assert.equal((await answered).status(), 200);
      await a.page.getByRole("button", { name: "Done" }).click();
      await a.page.locator(".ac-notice.is-saved", { hasText: "Your answer was changed." }).waitFor({ timeout: 10_000 });
      await card.locator("[data-ac-answer]", { hasText: "Your RPE: 5" }).waitFor({ timeout: 10_000 });
      assert.equal(await a.page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, "no horizontal scroll after the change");
      assert.deepEqual(a.pageErrors, []);
    } finally {
      await a.context.close();
    }
  });
}

async function openChangeOn(a, name, assignmentId) {
  const card = a.page.locator(".ac-card-external", { has: a.page.locator(".ac-card-title", { hasText: name }) });
  await card.locator(`[data-action="athlete-calendar-rpe-change"][data-assignment-id="${assignmentId}"]`).click();
  await a.page.locator("h3", { hasText: "Change your RPE" }).first().waitFor({ timeout: 10_000 });
  await a.page.locator('[data-action="training-load-rpe-slider-input"]').first().fill("5");
  return card;
}

test("(390 px) a change whose answer is lost after the server wrote it: Cancel, and the card reads the week again (never the value from before)", async () => {
  const name = "Match RPE lost";
  const assignmentId = await answeredRequest(name);
  const a = await openCalendar(390);
  try {
    // The request reaches the real server (v83 writes it); its answer never reaches the page.
    await a.page.route(`**/external-assignments/${assignmentId}/rpe/change`, async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    const card = await openChangeOn(a, name, assignmentId);
    await a.page.getByRole("button", { name: "Save change" }).click();
    await a.page.getByText("We can't tell yet whether your change was saved.").waitFor({ timeout: 10_000 });
    await a.page.locator('.training-load-rpe-panel .compact-button[data-action="training-load-close-rpe-form"]').click();
    await card.locator("[data-ac-answer]", { hasText: "Your RPE: 5" }).waitFor({ timeout: 10_000 });
    assert.equal(await a.page.locator(".ac-notice").count(), 0, "no sentence: the result was never confirmed on screen");
    assert.deepEqual(a.pageErrors, []);
  } finally {
    await a.context.close();
  }
});

test("(390 px) a change refused as closed: the form says so, the week is read again once, the card shows Answers closed at", async () => {
  const name = "Match RPE closed";
  const assignmentId = await answeredRequest(name);
  const a = await openCalendar(390);
  try {
    let refused = false;
    let readsAfter = 0;
    await a.page.route(`**/external-assignments/${assignmentId}/rpe/change`, (route) => {
      refused = true;
      return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "answer_locked", message: "This answer can no longer be changed. The question is closed." }) });
    });
    // After the refusal, her week says what the server would: the question closed a moment ago.
    await a.page.route("**/api/training-load/weekly?*", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (refused) {
        readsAfter += 1;
        for (const day of body.days || []) for (const s of day.sessions || []) {
          if (s.externalAssignmentId === assignmentId) Object.assign(s, { changeable: false, closesAt: new Date(Date.now() - 60_000).toISOString() });
        }
      }
      return route.fulfill({ response, body: JSON.stringify(body) });
    });
    const card = await openChangeOn(a, name, assignmentId);
    await a.page.getByRole("button", { name: "Save change" }).click();
    await a.page.getByText("This answer can no longer be changed. The question is closed.").waitFor({ timeout: 10_000 });
    await card.locator("[data-ac-answer]", { hasText: "Answers closed at" }).waitFor({ timeout: 10_000 });
    await a.page.waitForTimeout(500);
    // Counted before Done: Done itself refreshes the Training Load form's own reads (#663), not the Calendar's.
    assert.equal(readsAfter, 1, "the Calendar reads the week again once after the refusal");
    await a.page.getByRole("button", { name: "Done" }).click();
    assert.equal(await card.locator('[data-action="athlete-calendar-rpe-change"]').count(), 0);
    assert.equal(await a.page.locator(".ac-notice").count(), 0, "no sentence on the Calendar: the form said it");
    assert.deepEqual(a.pageErrors, []);
  } finally {
    await a.context.close();
  }
});

// K4 follow-ups, item 1: signed out (her calendar read answers 401), the Calendar offers Sign in, a 44 px target that
// goes to the login (the app's entry at "/").
for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) signed out: 'Please sign in again.' with a 44 px Sign in that goes to the login`, async () => {
    const a = await openCalendar(width, {
      prepare: (page) => page.route((url) => url.pathname === "/api/calendar", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) })),
      ready: '.athlete-calendar [data-action="athlete-calendar-sign-in"]',
    });
    try {
      const look = await a.page.evaluate(() => {
        const box = document.querySelector('[data-action="athlete-calendar-sign-in"]').getBoundingClientRect();
        return {
          text: document.querySelector(".athlete-calendar .ac-state p").textContent.trim(),
          label: document.querySelector('[data-action="athlete-calendar-sign-in"]').textContent.trim(),
          width: box.width, height: box.height,
          retry: document.querySelectorAll('[data-action="athlete-calendar-retry"]').length,
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      assert.deepEqual([look.text, look.label], ["Please sign in again.", "Sign in"]);
      assert.ok(look.height >= 43.5 && look.width >= 43.5, `Sign in is a 44 px target (${look.width}x${look.height})`);
      assert.equal(look.retry, 0, "no Try again when signed out");
      assert.equal(look.overflow, 0, "no horizontal scroll");
      await a.page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/k4fu-signed-out-${width}.png` }).catch(() => {});
      await Promise.all([
        a.page.waitForURL((url) => url.pathname === "/", { timeout: 20_000 }),
        a.page.click('[data-action="athlete-calendar-sign-in"]'),
      ]);
      assert.deepEqual(a.pageErrors, []);
    } finally {
      await a.context.close();
    }
  });
}
