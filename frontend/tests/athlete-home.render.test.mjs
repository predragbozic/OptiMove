import { test } from "node:test";
import assert from "node:assert/strict";

// feature/athlete-home-mvp: renderAthleteHomeHtml is a pure function over
// GET /api/athlete-home's own response shape (see backend/src/routes/
// athleteHome.js) - these tests pin every required empty state and the
// data-action hooks app.js's handleContentClick dispatches on, without ever
// fabricating data the endpoint doesn't actually provide (no duration/
// progress/calories/completion fields exist anywhere in this render).

const { renderAthleteHomeHtml } = await import("../athlete-home.js");

function emptyWeek() {
  return {
    days: [
      { date: "2026-08-10", isToday: true, hasTraining: false },
      { date: "2026-08-11", isToday: false, hasTraining: false },
      { date: "2026-08-12", isToday: false, hasTraining: false },
      { date: "2026-08-13", isToday: false, hasTraining: false },
      { date: "2026-08-14", isToday: false, hasTraining: false },
      { date: "2026-08-15", isToday: false, hasTraining: false },
      { date: "2026-08-16", isToday: false, hasTraining: false },
    ],
  };
}

test("a loading state (data: null, no error) shows a stable loading message, never a blank screen", () => {
  const html = renderAthleteHomeHtml({ data: null, error: "" });
  assert.ok(html.includes("Loading your home"));
});

test("an error state shows the error message instead of a blank screen", () => {
  const html = renderAthleteHomeHtml({ data: null, error: "Could not load your home." });
  assert.ok(html.includes("Could not load your home."));
});

test("no training today: shows the explicit empty state, never an empty card or a stuck Loading", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes("No training is assigned for today."));
  assert.ok(!html.includes("Open today's training"), "no open-training button when there is nothing to open");
});

test("training exists today: shows plan name, real session/exercise counts, and the open-today button with the correct date", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: true, planId: "plan-1", planName: "Week 1", sessionCount: 2, itemCount: 5 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes("Week 1"));
  assert.ok(html.includes("2 sessions"));
  assert.ok(html.includes("5 exercises"));
  assert.ok(html.includes(`data-action="athlete-home-open-today"`));
  assert.ok(html.includes(`data-date="2026-08-10"`));
});

test("session/exercise counts are only shown when actually available (never a fabricated 0/0 line)", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: true, planId: "plan-1", planName: "Week 1", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(!html.includes("0 sessions"));
  assert.ok(!html.includes("0 exercises"));
});

test("the week strip always renders exactly 7 days, marks today, and marks days with training - each day is clickable with its own date", () => {
  const week = emptyWeek();
  week.days[2].hasTraining = true;
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week,
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  const dayButtons = [...html.matchAll(/data-action="athlete-home-open-day" data-date="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(dayButtons, week.days.map((day) => day.date));
  assert.match(html, /athlete-home-day is-today[^"]*"[^>]*data-date="2026-08-10"/);
  assert.match(html, /athlete-home-day has-training[^"]*"[^>]*data-date="2026-08-12"/);
});

// hotfix/athlete-home-mobile-layout: the "Active specific programs" section
// was removed from Home entirely - an athlete already reaches every
// assigned program through the Specific programs quick action/tab. This is
// tested regardless of whether `data.programs` is empty, has a few rows, or
// more than 3 - the section (and its card markup, view-all link, and any
// program-open action) must never appear no matter what the backend sends.
for (const programs of [{ rows: [], total: 0 }, { rows: [{ id: "p1", name: "Program A", imageUrl: "" }], total: 1 }, { rows: [{ id: "p1", name: "Program A", imageUrl: "" }, { id: "p2", name: "Program B", imageUrl: "" }, { id: "p3", name: "Program C", imageUrl: "" }], total: 5 }]) {
  test(`Active specific programs never renders on Home (programs.total=${programs.total})`, () => {
    const data = {
      athlete: { name: "Test Athlete", imageUrl: "" },
      today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
      week: emptyWeek(),
      programs,
    };
    const html = renderAthleteHomeHtml({ data, error: "" });
    assert.ok(!html.includes("Active specific programs"));
    assert.ok(!html.includes("View all programs"));
    assert.ok(!html.includes(`data-action="athlete-home-open-program"`));
    assert.ok(!html.includes(`data-action="athlete-home-view-programs"`));
    assert.ok(!html.includes("%"), "no fabricated progress percentage anywhere on Home");
  });
}

test("exactly 4 quick actions: Calendar, Specific programs, Program Library, Settings, in that order - never a Home entry among them, never a duplicated large Coaches card", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  const targetTabs = [...html.matchAll(/data-action="athlete-home-quick-tab" data-target-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targetTabs, ["calendar", "programs", "athlete-library", "athlete-settings"]);
  assert.ok(!targetTabs.includes("athlete-home"), "Home must never be one of its own quick actions");
  assert.ok(!targetTabs.includes("coaches"), "Coaches must not be duplicated here - it's already a main nav item");
  assert.ok(html.includes(">Calendar<"), "the Calendar action must be labeled Calendar, not Weekly plan");
});

test("each quick action carries the real nav-menu icon markup (not a plain text-only button)", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  const iconCount = [...html.matchAll(/class="athlete-home-quick-action-icon"/g)].length;
  assert.equal(iconCount, 4, "every quick action must carry its own icon");
});

test("header shows the athlete's real name and today's date, with a brief unobtrusive greeting - never fabricated data", () => {
  const data = {
    athlete: { name: "Real Athlete Name", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes("Real Athlete Name"));
  assert.ok(html.includes("10.08.2026"));
});
