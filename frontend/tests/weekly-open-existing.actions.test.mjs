// "Open that draft" after a refused weekly create (weekly-open-existing.js and the weekly-create-plan handler in app.js):
// the plan's id comes from GET /api/builder/weekly-plans; the action is offered only when that read returns a plan of this
// athlete and week the caller may open, and opens exactly that plan.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFetchMock } from "./support/fetch-mock.mjs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true };

const { state } = await import("../state.js");
const mod = await import("../weekly-open-existing.js");

const UUID = "a0000000-0000-4000-8000-000000000001";
const WEEK = "2026-11-16";
const PLAN = "b0000000-0000-4000-8000-0000000000aa";

const answer = (athlete) => ({ status: 200, body: { weekStart: WEEK, athletes: [athlete] } });

beforeEach(() => {
  state.athletes = [{ athlete_id: "101", athlete_uuid: UUID, athlete: "Ana Example" }];
});

test("1. the read returns an editable draft: the plan is found, by the athlete's UUID and the week", async () => {
  const calls = installFetchMock((call) => answer({ athleteId: UUID, plannable: true, plan: { planId: PLAN, status: "draft", editable: true, mine: true, openDraftId: null } }));
  const found = await mod.findExistingWeeklyPlan("101", WEEK);
  assert.deepEqual(found, { planId: PLAN, openPlanId: "", status: "draft", weekStart: WEEK });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/builder/weekly-plans?weekStart=${WEEK}&athleteIds=${UUID}`);
  assert.equal(calls[0].method || "GET", "GET");
});

test("2. no plan, a plan the caller may not open, another athlete's row or a failed read: nothing is offered", async () => {
  for (const body of [
    { athleteId: UUID, plannable: true, plan: null },
    { athleteId: UUID, plannable: true, plan: { editable: false } },
    { athleteId: UUID, plannable: false },
    { athleteId: "a0000000-0000-4000-8000-0000000000ff", plannable: true, plan: { planId: PLAN, status: "draft", editable: true } },
  ]) {
    installFetchMock(() => answer(body));
    assert.equal(await mod.findExistingWeeklyPlan("101", WEEK), null);
  }
  installFetchMock(() => ({ status: 500, body: { error: "boom" } }));
  assert.equal(await mod.findExistingWeeklyPlan("101", WEEK), null);
  // An athlete the roster cannot name: no read at all.
  const calls = installFetchMock(() => answer({ athleteId: UUID, plannable: true, plan: null }));
  assert.equal(await mod.findExistingWeeklyPlan("999", WEEK), null);
  assert.equal(calls.length, 0);
});

test("3. opening: a draft is read by its id, a published plan gets its edit draft, an own open edit is read", async () => {
  let calls = installFetchMock(() => ({ status: 200, body: { plan: { id: PLAN } } }));
  await mod.openExistingWeeklyPlan({ planId: PLAN, openPlanId: "", status: "draft" });
  assert.equal(calls[0].url, `/api/builder/plans/${PLAN}`);
  assert.equal(calls[0].method || "GET", "GET");
  calls = installFetchMock(() => ({ status: 200, body: { plan: { id: "d1" } } }));
  await mod.openExistingWeeklyPlan({ planId: PLAN, openPlanId: "", status: "active" });
  assert.equal(calls[0].url, `/api/builder/plans/${PLAN}/edit`);
  assert.equal(calls[0].method, "POST");
  calls = installFetchMock(() => ({ status: 200, body: { plan: { id: "d1" } } }));
  await mod.openExistingWeeklyPlan({ planId: PLAN, openPlanId: "d1", status: "active" });
  assert.equal(calls[0].url, "/api/builder/plans/d1");
});

test("4. the message shows the button only with a found plan, escapes the server's sentence and shows no id", () => {
  const withButton = mod.renderWeeklyExistingHtml("Athlete <b>X</b> already has a weekly plan for that week.", { planId: PLAN, status: "draft" });
  assert.match(withButton, /data-action="weekly-open-existing"/);
  assert.match(withButton, />Open that draft</);
  assert.doesNotMatch(withButton, /<b>X<\/b>/);
  assert.equal((withButton.match(new RegExp(PLAN, "g")) || []).length, 1, "the id only in the data attribute");
  const published = mod.renderWeeklyExistingHtml("x", { planId: PLAN, status: "active" });
  assert.match(published, />Open that plan</);
  const alone = mod.renderWeeklyExistingHtml("Athlete X already has a weekly plan for that week.", null);
  assert.doesNotMatch(alone, /button/);
  assert.match(alone, /role="alert"/);
});

test("5. app.js wires it: a 409 re-reads, offers the action; the handler opens only the remembered plan", () => {
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(source, /error\?\.status === 409 && athleteId \? await findExistingWeeklyPlan\(athleteId, weekStart\)/);
  assert.match(source, /type === "weekly-open-existing"/);
  assert.match(source, /String\(action\.dataset\.planId\) !== existing\.planId/);
});
