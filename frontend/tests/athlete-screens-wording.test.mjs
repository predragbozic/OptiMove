// Athlete screens: wording and targets (manager, 2026-11-16). The training-load sheet names the week it shows; an athlete's
// Programs shows only what she can use, with one plain sentence when empty; one name per place; Account in plain words; a
// hidden count stays hidden in the open phone menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.document = { querySelector: () => null, querySelectorAll: () => [], body: { classList: { contains: () => false } } };
globalThis.window = { confirm: () => true, matchMedia: () => ({ matches: false }) };

const { renderTrainingLoadAthleteWeeklyHtml } = await import("../training-load-view.js");
const { state } = await import("../state.js");
const { renderTemplateFiltersHtml, renderTemplateLibraryResultsHtml } = await import("../program-library.js");
const { CONTENT_LANGUAGE_SCOPE_ATHLETE, renderContentLanguageSectionHtml } = await import("../account-language.js");
const { templateScopeMeta } = await import("../navigation.js");
const { athleteLibraryFilters } = await import("../program-library-view.js");
const { applyTemplateClientFilters } = await import("../program-library.js");

function week(offsetDays) {
  const start = new Date(); start.setDate(start.getDate() + offsetDays - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, sessions: [] }; });
  return { weekStart: days[0].date, weekEnd: days[6].date, days };
}

test("1. the training-load sheet says 'This week's' only while it shows the week that holds today", () => {
  for (const [offset, title] of [[0, "This week&#039;s training load"], [-7, "Training load"], [7, "Training load"]]) {
    const data = week(offset);
    state.trainingLoad.athleteWeekly = { weekStart: data.weekStart, selectedDate: data.weekStart, data, loading: false, error: "" };
    const html = renderTrainingLoadAthleteWeeklyHtml();
    const h3 = (html.match(/<h3>([^<]*)<\/h3>/) || [])[1];
    assert.ok(h3 === title || h3 === title.replace("&#039;", "'"), `${offset}: ${h3}`);
    assert.match(html, new RegExp(`aria-label="${title.replace("&#039;", "(?:'|&#039;)")}"`));
  }
});

const filters = (athlete, activeScope = "my_programs") => renderTemplateFiltersHtml({
  filters: { pricing: "all" }, options: {}, showAdminFilters: false, scopes: [activeScope], activeScope, scopeLabel: (s) => s,
  visibleTags: [], visibleCategories: [], creatorOptions: [], visibleCreators: [], clubOptions: [], visibleClubs: [], athlete,
});

test("2. an athlete's Programs offers only search and group: no status, tag or price filter (Free only stays on Marketplace)", () => {
  const a = filters(true);
  assert.match(a, /data-template-filter="search"/);
  assert.match(a, /data-template-filter="category"/);
  for (const f of ["lifecycle", "tag", "freeOnly"]) assert.doesNotMatch(a, new RegExp(`data-template-filter="${f}"`), f);
  assert.doesNotMatch(a, /Draft|Published private|Team shared|Club shared|Archived/);
  assert.match(filters(true, "marketplace"), /data-template-filter="freeOnly"/, "Free only where prices exist");
  const coach = filters(false);
  for (const f of ["lifecycle", "tag", "freeOnly"]) assert.match(coach, new RegExp(`data-template-filter="${f}"`), `coach keeps ${f}`);
});

test("3. an empty list says one plain sentence to an athlete; a coach keeps the filter sentence", () => {
  assert.match(renderTemplateLibraryResultsHtml([], null, null, { athlete: true, searching: false }), />No programs have been shared with you yet\.</);
  assert.match(renderTemplateLibraryResultsHtml([], null, null, { athlete: true, searching: true }), />No programs match your search\.</);
  assert.match(renderTemplateLibraryResultsHtml([], null, null), />No programs match these filters\.</);
});

test("4. one name per place: Programs (Home and menu), the athlete's tab 'Shared with you', 'Weekly plan'; a coach keeps 'My Programs'", () => {
  assert.equal(templateScopeMeta("my_programs", { accessScope: "athlete" }).label, "Shared with you");
  assert.equal(templateScopeMeta("my_programs", { accessScope: "coach" }).label, "My Programs");
  const home = readFileSync(new URL("../athlete-home.js", import.meta.url), "utf8");
  assert.match(home, /\["athlete-library", "Programs", ICON_PROGRAM_LIBRARY\]/);
  assert.doesNotMatch(home, /"Program Library"/);
  const menu = readFileSync(new URL("../athlete.html", import.meta.url), "utf8");
  assert.match(menu, /data-athlete-tab="athlete-library"[\s\S]*?<span>Programs<\/span>/);
});

test("5. Account: the athlete's language help names no coach screen; the header says Account", () => {
  assert.doesNotMatch(CONTENT_LANGUAGE_SCOPE_ATHLETE, /Builder|Exercise Library|Home/);
  assert.match(renderContentLanguageSectionHtml({}, { athlete: true }), new RegExp(CONTENT_LANGUAGE_SCOPE_ATHLETE.replace(/[.]/g, "\\.")));
  assert.match(renderContentLanguageSectionHtml({}), /the Builder(?:'|&#039;)s exercise list/, "the coach's sentence stays");
});

test("6. a hidden count stays hidden in the open phone menu, and the measured athlete targets are 44 px", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("/* Athlete screens (manager, 2026-11-16)"), css.indexOf("/* End of athlete screens. */"));
  assert.match(block, /body\.mobile-nav-open:not\(\.login-mode\) \.rail-button span\[hidden\] \{\s*display: none !important;/);
  // It must come after the rule that shows every rail span in the open menu, or it would lose.
  assert.ok(css.indexOf("body.mobile-nav-open:not(.login-mode) .rail-button span[hidden]") > css.indexOf("body.mobile-nav-open:not(.login-mode) .rail-button span {"));
  // Item 2 (owner, 2026-11-16): the old "This week's training load" link is gone; its successor in Home's "This week" row
  // carries its own 44 px.
  assert.match(css, /\.training-load-week-button \{[^}]*min-height: 44px;/);
  for (const sel of [".training-load-athlete-weekly-panel .icon-button", ".tests-section-tabs .tab", ".athlete-simple-view button", '[data-action="notifications-read-all"]', ".brand-mark"]) {
    assert.ok(block.includes(sel), sel);
  }
});

test("7 (code review): a filter an athlete can't see never narrows her list - Free only from Marketplace, a tag, a status", () => {
  const programs = [{ plan_id: "p1", plan_name: "Paid", is_free: false, lifecycle: "assigned", tags: [] }, { plan_id: "p2", plan_name: "Free", is_free: true, tags: [] }];
  const set = { search: "", category: "", tag: "speed", lifecycle: "draft", pricing: "free" };
  for (const scope of ["my_programs", "optimove"]) {
    const shown = applyTemplateClientFilters(programs, athleteLibraryFilters(set, scope)).map((p) => p.plan_id);
    assert.deepEqual(shown, ["p1", "p2"], scope);
  }
  // On Marketplace, where she sees it, Free only applies.
  assert.deepEqual(applyTemplateClientFilters(programs, athleteLibraryFilters({ ...set, tag: "", lifecycle: "all" }, "marketplace")).map((p) => p.plan_id), ["p2"]);
});
