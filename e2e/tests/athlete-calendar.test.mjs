// K4a-F: the athlete's Calendar (docs/ai/central-calendar-k4a-contract.md section 2, mockup 04) in the real athlete app,
// at 1280, 390, 375 and 360 px. Her week's read is answered by the test in the athlete's shape of K4a-B (PR #660: the
// event card with her own folded `sessions`; her planned card with her row under include=athletes) - the demo athlete has
// no plan, and the fold is not merged yet; everything else is the real server. Checked: the rail's Calendar (first), the
// cards (one card for event + training with the sessions inside, My training, Cancelled, "RPE given" without a value),
// one primary button per card, the phone's day strip, 44 px targets, no horizontal scroll, and Home's See all.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startWorld } from "../lib/world.mjs";
import { launch } from "../lib/browser.mjs";

let world;
let browser;
before(async () => { world = await startWorld(); browser = await launch(); });
after(async () => { await browser?.close(); await world?.stop(); });

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const TODAY = iso(new Date());
const MONDAY = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
const OTHER = TODAY === addDays(MONDAY, 6) ? addDays(MONDAY, 5) : addDays(TODAY, 1);
const PAST = TODAY === MONDAY ? null : addDays(TODAY, -1);

const event = ({ id, date, title, eventKind = "training", eventTypeLabel = "Training", startTime = "10:00", endTime = "11:30", cancelled = false, sessions = null, place = { source: "library", name: "North field", address: "1 Field Road", note: null } }) => ({
  key: `event:${id}:${date}`, kind: "event", date, title, eventKind, eventTypeLabel, eventTypeIconKey: null, eventTypeColorKey: null,
  span: { from: date, to: date }, startTime, endTime, timezone: "Europe/Sarajevo", location: null, place,
  status: cancelled ? "cancelled" : "planned", cancelled, teamIds: ["t"], links: { eventId: id }, ...(sessions ? { sessions } : {}),
});
const planned = ({ date, title, sessionId, rpe }) => ({
  key: `planned:${sessionId}:${date}`, kind: "planned", date, title, slot: { amPm: "AM", bta: "T", order: 1 }, startTime: null, startsAt: null,
  teamIds: [], athleteIds: ["a"], athleteCount: 1, expects: rpe === "not_asked" ? [] : ["rpe"], status: "none",
  athletes: [{ athleteId: "a", name: "Ana Example", teamIds: [], planId: "p", sessionId, logicalSessionId: `l-${sessionId}`, rpe }],
  links: { activityIds: [], planIds: ["p"], logicalSessionIds: [`l-${sessionId}`] },
});
function weekAnswer(from) {
  const items = from !== MONDAY ? [] : [
    event({
      id: "ev-1", date: TODAY, title: "Team training",
      sessions: [
        { title: "Mobility & activation with a very long name that has to wrap on a small phone", slot: { amPm: "AM", bta: "B", order: 1 }, time: "10:00", timeFromEvent: true, sessionId: "ps-0", logicalSessionId: "l-0", rpe: "not_asked" },
        { title: "Main session", slot: { amPm: "AM", bta: "T", order: 2 }, time: "10:30", timeFromEvent: false, sessionId: "ps-1", logicalSessionId: "l-1", rpe: "missing" },
      ],
    }),
    planned({ date: TODAY, title: "Gym · upper body", sessionId: "ps-9", rpe: "submitted" }),
    event({ id: "ev-2", date: OTHER, title: "Tactical session", cancelled: true }),
    event({ id: "ev-3", date: OTHER, title: "U19 vs Lakeside", eventKind: "match", eventTypeLabel: "Match", startTime: "15:00", endTime: null }),
    ...(PAST ? [planned({ date: PAST, title: "Recovery run", sessionId: "ps-8", rpe: "not_asked" })] : []),
  ];
  const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(from, i), items: items.filter((c) => c.date === addDays(from, i)) }));
  return { from, to: addDays(from, 6), today: TODAY, workspace: { type: "athlete", scopeId: null }, teams: [], days };
}

async function openAthlete(width) {
  const account = world.accounts.find((a) => a.role === "athlete");
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone });
  await context.addCookies([{ name: "optimove_session", value: account.sessionToken, url: world.baseUrl }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const reads = [];
  await page.route((url) => url.pathname === "/api/calendar" && url.searchParams.get("include") === "athletes", (route) => {
    const from = new URL(route.request().url()).searchParams.get("from");
    reads.push(from);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(weekAnswer(from)) });
  });
  await page.goto(`${world.baseUrl}/athlete`, { waitUntil: "load" });
  await page.getByText("Today's training", { exact: false }).first().waitFor({ timeout: 20_000 });
  return { context, page, pageErrors, reads, phone };
}

async function openCalendar(page, phone) {
  if (phone) await page.locator("#mobileNavToggle").click();
  const tabs = await page.$$eval(".sidebar [data-athlete-tab]", (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.athleteTab));
  assert.equal(tabs[0], "athlete-calendar", `the Calendar is first in the rail (${tabs.join(", ")})`);
  await page.locator('.sidebar [data-athlete-tab="athlete-calendar"]').first().click();
  await page.locator(".athlete-calendar .ac-card").first().waitFor({ timeout: 20_000 });
}

for (const width of [1280, 390, 375, 360]) {
  test(`(${width} px) the athlete's Calendar: one card for event + training, My training, Cancelled, RPE given, one primary per card`, async () => {
    const a = await openAthlete(width);
    try {
      await openCalendar(a.page, a.phone);
      assert.equal((await a.page.textContent("#screenTitle")).trim(), "Calendar");
      assert.deepEqual(a.reads, [MONDAY], "one read of this week");
      const look = await a.page.evaluate(() => {
        const cards = [...document.querySelectorAll(".ac-card")].map((card) => ({
          title: card.querySelector(".ac-card-title")?.textContent.trim(),
          cancelled: card.classList.contains("is-cancelled"),
          sessions: [...card.querySelectorAll(".ac-sessions li")].map((li) => li.textContent.replace(/\s+/g, " ").trim()),
          buttons: [...card.querySelectorAll(".ac-card-actions button")].map((b) => `${b.textContent.trim()}${b.classList.contains("cc-primary") ? "*" : ""}`),
          answer: card.querySelector("[data-ac-answer]:not([hidden])")?.textContent.replace(/\s+/g, " ").trim() || "",
          maps: Boolean(card.querySelector("a.cc-maps")),
        }));
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const small = [...document.querySelectorAll(".athlete-calendar button, .athlete-calendar a")].filter(visible)
          .filter((el) => el.getBoundingClientRect().height < 43.5 && !el.matches("a.cc-maps"))
          .map((el) => `${el.textContent.trim()} ${Math.round(el.getBoundingClientRect().height)}`);
        const strip = document.querySelector(".ac-strip");
        return {
          cards, small, overflow: document.documentElement.scrollWidth - innerWidth,
          strip: strip && visible(strip) ? [...strip.querySelectorAll(".ac-strip-day")].map((b) => `${b.dataset.date}${b.querySelector(".is-busy") ? "•" : ""}${b.getAttribute("aria-current") ? "!" : ""}`) : null,
          labels: Object.fromEntries([...document.querySelectorAll(".ac-day")].map((d) => [d.dataset.acDay, d.querySelector(".ac-day-label").textContent.trim()])),
          clipped: [...document.querySelectorAll(".ac-card-title, .ac-session-text")].filter((el) => el.scrollWidth > el.clientWidth + 1).length,
        };
      });
      const byTitle = Object.fromEntries(look.cards.map((c) => [c.title, c]));
      assert.deepEqual(byTitle["Team training"].buttons, ["Rate RPE*", "Open training"], "Rate RPE primary, then Open training");
      assert.deepEqual(byTitle["Team training"].sessions, ["Before Mobility & activation with a very long name that has to wrap on a small phone · 10:00", "Training Main session · 10:30"]);
      assert.ok(byTitle["Team training"].maps, "Open in maps");
      assert.deepEqual([byTitle["Gym · upper body"].buttons, byTitle["Gym · upper body"].answer], [["Open training*"], "✓ RPE given"], "RPE given without a value");
      assert.deepEqual([byTitle["Tactical session"].cancelled, byTitle["Tactical session"].buttons, byTitle["Tactical session"].sessions], [true, [], []]);
      for (const card of look.cards) assert.ok(card.buttons.filter((b) => b.endsWith("*")).length <= 1, `one primary: ${card.title}`);
      assert.match(look.labels[TODAY], / · today$/, "today's day is marked");
      // Distinct dates: on a Sunday OTHER and PAST are both Saturday.
      assert.equal(Object.keys(look.labels).length, new Set([TODAY, OTHER, PAST].filter(Boolean)).size, "only days that have something");
      assert.equal(look.overflow, 0, "no horizontal scroll");
      assert.deepEqual(look.small, [], "44 px targets");
      assert.ok(await a.page.$$eval(".athlete-calendar a.cc-maps", (links) => links.every((l) => l.getBoundingClientRect().height >= 43.5)), "Open in maps is a 44 px target");
      assert.equal(look.clipped, 0, "long names wrap, never clip");
      if (a.phone) {
        assert.equal(look.strip.length, 7);
        assert.ok(look.strip.some((d) => d.startsWith(TODAY) && d.endsWith("!")), "today marked");
        // A tap on a day with something scrolls the list to it.
        await a.page.click(`.ac-strip-day[data-date="${OTHER}"]`);
        await a.page.waitForFunction((d) => document.querySelector(`.ac-strip-day[data-date="${d}"]`)?.getAttribute("aria-pressed") === "true", OTHER);
        // After a scroll the head and the strip stay reachable under the athlete's sticky topbar: what is at their
        // centre is themselves, never the topbar. Each strip day is at least 44 px wide and tall.
        await a.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await a.page.waitForTimeout(400);
        const sticky = await a.page.evaluate(() => {
          const hit = (el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(top && (top === el || el.contains(top))); };
          const topbar = document.querySelector(".athlete-topbar")?.getBoundingClientRect();
          const head = document.querySelector('.ac-head [data-action="athlete-calendar-week"][data-delta="1"]');
          const days = [...document.querySelectorAll(".ac-strip-day")];
          return {
            headReachable: hit(head), stripReachable: days.every(hit),
            belowTopbar: topbar ? document.querySelector(".ac-head").getBoundingClientRect().top >= topbar.bottom - 1 : true,
            dayBoxes: days.map((d) => { const r = d.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }),
          };
        });
        assert.ok(sticky.headReachable, "the week's arrows stay reachable after a scroll");
        assert.ok(sticky.stripReachable, "the strip stays reachable after a scroll");
        assert.ok(sticky.belowTopbar, "the head sits under the topbar, not behind it");
        assert.ok(sticky.dayBoxes.every(([w, h]) => w >= 44 && h >= 44), `strip days ${JSON.stringify(sticky.dayBoxes)}`);
        // A tapped day lands below the strip, not under it.
        await a.page.click(`.ac-strip-day[data-date="${TODAY}"]`);
        await a.page.waitForTimeout(800);
        const landed = await a.page.evaluate((d) => document.querySelector(`.ac-day[data-ac-day="${d}"]`).getBoundingClientRect().top - document.querySelector(".ac-strip").getBoundingClientRect().bottom, TODAY);
        assert.ok(landed >= -1, `the day's section starts below the strip (${landed})`);
        // Each card's buttons are full width, the primary first.
        const widths = await a.page.$$eval(".ac-card-actions", (rows) => rows.map((r) => [...r.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().width - r.getBoundingClientRect().width))));
        assert.ok(widths.flat().every((w) => Math.abs(w) <= 1), `full-width buttons ${JSON.stringify(widths)}`);
      } else {
        assert.equal(look.strip, null, "no day strip on a computer (Q5)");
      }
      await a.page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/k4a-calendar-${width}.png`, fullPage: true }).catch(() => {});
      if (a.phone) {
        // The longest label (a week across two years, "28 Dec 2026 – 3 Jan 2027") keeps the head one 56 px row, so the
        // sticky strip under it never covers it.
        const yearEnd = `${TODAY.slice(0, 4)}-12-31`;
        const crossMonday = (() => { const d = new Date(`${yearEnd}T12:00:00`); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); })();
        if (crossMonday > MONDAY && addDays(crossMonday, 6) > yearEnd) {
          const weeks = Math.round((new Date(`${crossMonday}T12:00:00`) - new Date(`${MONDAY}T12:00:00`)) / (7 * 864e5));
          for (let i = 0; i < weeks; i += 1) {
            const before = await a.page.textContent(".ac-period");
            await a.page.click('[data-action="athlete-calendar-week"][data-delta="1"]');
            await a.page.waitForFunction((p) => document.querySelector(".ac-period")?.textContent !== p, before);
          }
          const head = await a.page.evaluate(() => {
            const h = document.querySelector(".ac-head").getBoundingClientRect();
            const strip = document.querySelector(".ac-strip").getBoundingClientRect();
            return { label: document.querySelector(".ac-period").textContent, height: Math.round(h.height), gap: Math.round(strip.top - h.bottom), clipped: document.querySelector(".ac-period").scrollWidth > document.querySelector(".ac-period").clientWidth + 1 };
          });
          assert.match(head.label, /\d{4} – .*\d{4}$/, "a week across two years");
          assert.ok(head.height <= 57, `the head stays one row (${head.height} px)`);
          assert.ok(head.gap >= -1, `the strip starts under the head (${head.gap})`);
          assert.equal(head.clipped, false, "the label is not clipped");
          await a.page.click('[data-action="athlete-calendar-today"]');
          await a.page.locator(".ac-card").first().waitFor({ timeout: 10_000 });
        }
      }
      // The next week: one read, an empty week says so with Today.
      await a.page.click('[data-action="athlete-calendar-week"][data-delta="1"]');
      await a.page.locator(".ac-empty").waitFor({ timeout: 10_000 });
      assert.equal((await a.page.textContent(".ac-empty p")).trim(), "Nothing planned this week.");
      await a.page.click('.ac-empty [data-action="athlete-calendar-today"]');
      await a.page.locator(".ac-card").first().waitFor({ timeout: 10_000 });

      // Open training -> her Weekly plan on that day with Back to calendar; the button and the phone's Back both return
      // to the same week, day and scroll (contract 2.3, 2.4).
      const openTraining = '.ac-card[data-key^="event:ev-1"] [data-ac-action="open-training"]';
      const place = async () => a.page.evaluate(() => ({
        title: document.querySelector("#screenTitle")?.textContent.trim(),
        period: document.querySelector(".ac-period")?.textContent.trim() || "",
        selected: document.querySelector('.ac-strip-day[aria-pressed="true"]')?.dataset.date || "",
        y: Math.round(window.scrollY),
      }));
      const toTraining = async () => {
        await a.page.locator(openTraining).scrollIntoViewIfNeeded();
        await a.page.evaluate(() => window.scrollBy(0, 40));
        const before = await place();
        await a.page.click(openTraining);
        await a.page.locator(".ac-backbar").waitFor({ timeout: 20_000 });
        await a.page.locator(".calendar-day, .calendar-week-empty").first().waitFor({ timeout: 20_000 });
        return before;
      };
      const backAt = async (before, how) => {
        if (how === "button") await a.page.click('[data-action="athlete-calendar-back"]');
        else await a.page.goBack().catch(() => {});
        await a.page.locator(".athlete-calendar .ac-card").first().waitFor({ timeout: 20_000 });
        await a.page.waitForTimeout(600);
        const after = await place();
        assert.equal(after.title, "Calendar", `${how}: the Calendar again`);
        assert.equal(after.period, before.period, `${how}: the same week`);
        if (a.phone) assert.equal(after.selected, before.selected, `${how}: the same day`);
        assert.ok(Math.abs(after.y - before.y) <= 2, `${how}: the same scroll (${before.y} -> ${after.y})`);
      };
      const before1 = await toTraining();
      const bar = (await a.page.textContent(".ac-backbar")).replace(/\s+/g, " ").trim();
      assert.match(bar, /Back to calendar .* · Team training$/, bar);
      const barLook = await a.page.evaluate(() => {
        const button = document.querySelector('[data-action="athlete-calendar-back"]').getBoundingClientRect();
        return { height: Math.round(button.height), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      assert.ok(barLook.height >= 44, `Back to calendar is a 44 px target (${barLook.height})`);
      assert.equal(barLook.overflow, 0, "no horizontal scroll on the Weekly plan");
      await a.page.screenshot({ path: `${process.env.E2E_SHOTS || "/tmp"}/k4a-weekly-back-${width}.png` }).catch(() => {});
      assert.equal((await a.page.textContent("#screenTitle")).trim() !== "Calendar", true, "the Weekly plan");
      await backAt(before1, "button");
      const before2 = await toTraining();
      await backAt(before2, "browser Back");
      // The Weekly plan opened from the rail has no Back to calendar.
      if (a.phone) await a.page.locator("#mobileNavToggle").click();
      await a.page.locator('.sidebar [data-athlete-tab="calendar"]').first().click();
      await a.page.locator(".calendar-day, .calendar-week-empty").first().waitFor({ timeout: 20_000 });
      assert.equal(await a.page.locator(".ac-backbar").count(), 0, "no Back to calendar from the rail");
      assert.deepEqual(a.pageErrors, []);
    } finally {
      await a.context.close();
    }
  });
}

test("(390 px) Home's Upcoming events has See all, which opens the Calendar on this week", async () => {
  const a = await openAthlete(390);
  try {
    const seeAll = a.page.locator('[data-action="athlete-home-events-see-all"]');
    await seeAll.waitFor({ timeout: 20_000 });
    await seeAll.click();
    await a.page.locator(".athlete-calendar .ac-card").first().waitFor({ timeout: 20_000 });
    assert.equal((await a.page.textContent("#screenTitle")).trim(), "Calendar");
    assert.deepEqual(a.reads, [MONDAY]);
    assert.deepEqual(a.pageErrors, []);
  } finally {
    await a.context.close();
  }
});
