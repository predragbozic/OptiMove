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

test("no active programs: shows the explicit empty state, no fabricated progress, no 'View all' link", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes("No specific programs are assigned yet."));
  assert.ok(!html.includes("View all programs"));
});

test("active programs (<=3): each has an Open program button with its real id, never a progress percentage", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: {
      rows: [
        { id: "p1", name: "Program A", imageUrl: "" },
        { id: "p2", name: "Program B", imageUrl: "" },
      ],
      total: 2,
    },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes(`data-action="athlete-home-open-program" data-program-id="p1"`));
  assert.ok(html.includes(`data-action="athlete-home-open-program" data-program-id="p2"`));
  assert.ok(!html.includes("%"), "no fabricated progress percentage anywhere in the programs section");
  assert.ok(!html.includes("View all programs"), "no View all link when every program is already shown");
});

test("more than 3 active programs: shows the 'View all programs' action, backend already caps rows at 3", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: {
      rows: [
        { id: "p1", name: "Program A", imageUrl: "" },
        { id: "p2", name: "Program B", imageUrl: "" },
        { id: "p3", name: "Program C", imageUrl: "" },
      ],
      total: 5,
    },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes(`data-action="athlete-home-view-programs"`));
  assert.ok(html.includes("View all programs"));
});

test("quick actions cover Weekly plan, Specific programs, Program Library, Settings - and never a duplicated large Coaches card", () => {
  const data = {
    athlete: { name: "Test Athlete", imageUrl: "" },
    today: { date: "2026-08-10", hasTraining: false, planId: null, planName: "", sessionCount: 0, itemCount: 0 },
    week: emptyWeek(),
    programs: { rows: [], total: 0 },
  };
  const html = renderAthleteHomeHtml({ data, error: "" });
  assert.ok(html.includes(`data-action="athlete-home-quick-tab" data-target-tab="calendar"`));
  assert.ok(html.includes(`data-action="athlete-home-quick-tab" data-target-tab="programs"`));
  assert.ok(html.includes(`data-action="athlete-home-quick-tab" data-target-tab="athlete-library"`));
  assert.ok(html.includes(`data-action="athlete-home-quick-tab" data-target-tab="athlete-settings"`));
  assert.ok(!html.includes(`data-target-tab="coaches"`), "Coaches must not be duplicated here - it's already a main nav item");
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
