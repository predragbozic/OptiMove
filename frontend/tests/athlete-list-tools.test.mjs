import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { athleteMatches, clearAthleteFilters, handleAthleteFilter, sortAthletes } from "../athlete-list-tools.js";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderBuilderAthletePicker, renderCopyPlanModal, renderBlockPickerModal } = await import("../builder-modals.js");
const { renderAthleteListHtml } = await import("../athlete-view.js");
const { renderCoachHomeAthleteRows } = await import("../coach-home.js");
const { state, emptyBuilderState, emptyBlockPicker } = await import("../state.js");
const { handleBuilderWorkspaceAction: handleBuilderAction } = await import("../builder-actions.js");
const { renderOrganizationBrowser } = await import("../organization-view.js");
const rows = [{ athlete: "Žarko", athlete_id: "3" }, { athlete: "Ana", athlete_id: "2" }, { athlete: "Đorđe", athlete_id: "1" }];
beforeEach(clearAthleteFilters);

test("Serbian alphabetical order is deterministic and does not mutate the roster", () => {
  const original = ["Žarko", "Ćira", "Ana", "Čedomir", "Đorđe", "Dušan", "Šime", "Zoran"].map((name) => ({ name }));
  assert.deepEqual(sortAthletes(original).map((r) => r.name), ["Ana", "Čedomir", "Ćira", "Dušan", "Đorđe", "Šime", "Zoran", "Žarko"]);
  assert.equal(original[0].name, "Žarko");
  assert.deepEqual(sortAthletes([{ name: "Ana", id: "10" }, { name: "ana", id: "2" }]).map((r) => r.id), ["2", "10"]);
});
test("search accepts case, accents, Serbian dj and both athlete ID formats", () => {
  assert.ok(athleteMatches(rows[0], " zark "));
  assert.ok(athleteMatches(rows[2], "DJORDJE"));
  assert.ok(athleteMatches({ athlete: "Ana", athleteId: "101" }, "101"));
  assert.equal(athleteMatches(rows[0], "Ana"), false);
});
test("menu, Home, Builder assignment, copy and import all render names alphabetically", () => {
  const builder = emptyBuilderState({ copyPlanId: "plan", blockPicker: emptyBlockPicker({ open: true, sourceType: "weekly" }) });
  for (const html of [renderAthleteListHtml(rows), renderCoachHomeAthleteRows(rows), renderBuilderAthletePicker({ athletes: rows, builder }), renderCopyPlanModal({ athletes: rows, builder }), renderBlockPickerModal({ athletes: rows, builder })]) {
    assert.ok(html.indexOf("Ana") < html.indexOf("Đorđe"));
    assert.ok(html.indexOf("Đorđe") < html.indexOf("Žarko"));
  }
});
test("filter keeps input focus and selections, persists through re-render, and clears empty state", () => {
  const builder = emptyBuilderState({ createAthleteIds: ["3"] });
  const dom = new JSDOM(renderBuilderAthletePicker({ athletes: rows, builder }));
  const input = dom.window.document.querySelector("[data-athlete-filter]");
  input.focus(); input.value = "ana"; handleAthleteFilter(input);
  assert.equal(dom.window.document.activeElement, input);
  assert.equal(dom.window.document.querySelectorAll("[data-athlete-filter-row]:not([hidden])").length, 1);
  assert.deepEqual(builder.createAthleteIds, ["3"]);
  const rerender = new JSDOM(renderBuilderAthletePicker({ athletes: rows, builder }));
  assert.equal(rerender.window.document.querySelector("input").value, "ana");
  assert.equal(rerender.window.document.querySelectorAll("[data-athlete-filter-row]:not([hidden])").length, 1);
  input.value = "missing"; handleAthleteFilter(input);
  assert.equal(dom.window.document.querySelector("[role=status]").hidden, false);
  assert.equal(dom.window.document.querySelector(".checkbox-toggle-all").disabled, true);
  input.value = ""; handleAthleteFilter(input);
  assert.equal(dom.window.document.querySelectorAll("[data-athlete-filter-row]:not([hidden])").length, 3);
  dom.window.close(); rerender.window.close();
});
test("select all affects only matches and preserves selections outside the filter", async () => {
  state.athletes = rows;
  state.builder = emptyBuilderState({ createAthleteIds: ["3"] });
  const dom = new JSDOM(renderBuilderAthletePicker(state));
  const input = dom.window.document.querySelector("input"); input.value = "ana"; handleAthleteFilter(input);
  const handlers = { renderBuilder() {} };
  await handleBuilderAction({ dataset: { action: "builder-toggle-select-all-athletes" } }, handlers);
  assert.deepEqual(state.builder.createAthleteIds, ["3", "2"]);
  await handleBuilderAction({ dataset: { action: "builder-toggle-select-all-athletes" } }, handlers);
  assert.deepEqual(state.builder.createAthleteIds, ["3"]);
  dom.window.close();
});
test("Settings roster is alphabetical and filters only authorized active rows", () => {
  state.organization.section = "athletes";
  state.organization.selectedTeamId = "";
  state.organization.selectedClubId = "";
  const athletes = rows.map((row) => ({ id: row.athlete_id, name: row.athlete, athlete_id: row.athlete_id, has_active_access: true }));
  const html = renderOrganizationBrowser({ athletes: [...athletes, { id: "hidden", name: "Hidden", has_active_access: false }], clubs: [], teams: [] });
  const dom = new JSDOM(html);
  const input = dom.window.document.querySelector("[data-athlete-filter]");
  const names = [...dom.window.document.querySelectorAll("[data-athlete-filter-row] strong")].map((el) => el.textContent);
  assert.deepEqual(names, ["Ana", "Đorđe", "Žarko"]);
  assert.ok(input);
  input.value = "djordje"; handleAthleteFilter(input);
  assert.equal(dom.window.document.querySelectorAll("[data-athlete-filter-row]:not([hidden])").length, 1);
  assert.equal(dom.window.document.querySelector('[data-athlete-filter-text^="Hidden"]'), null);
  dom.window.close();
});
