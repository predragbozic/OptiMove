// Design: the athlete list in the rail (empty states, quiet zero counts, 44 px search on a phone).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderAthleteListHtml } = await import("../athlete-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = (markup) => { const host = document.createElement("div"); host.innerHTML = markup; return host; };
const row = (over) => ({ athlete_id: "1", athlete: "Ana Example", weekly_plan_count: 0, program_count: 0, ...over });

test("an empty list says why: a search with no match, or a workspace with no athletes", () => {
  const none = html(renderAthleteListHtml([], null));
  assert.equal(none.querySelector(".om-empty.athlete-list-empty")?.getAttribute("role"), "status");
  assert.match(none.textContent, /No athletes here/);
  assert.match(none.textContent, /Switch to a club or team workspace, or add athletes in Settings\./);
  const searched = html(renderAthleteListHtml([], null, { searching: true }));
  assert.match(searched.textContent, /No athlete matches/);
  assert.doesNotMatch(searched.textContent, /No athletes here/);
});

test("until a roster is read (first load, a switch, a failed read) the list stays blank, never the empty state", () => {
  assert.equal(renderAthleteListHtml([], null, { pending: true }), "");
  assert.notEqual(renderAthleteListHtml([row()], null, { pending: true }), "", "rows are drawn as soon as they exist");
  assert.match(app, /athleteRosterPending = true;\n  renderAthleteList\(\);/);
  // The flag starts pending (declared with the module state, before init() runs) and is cleared
  // only right after a roster was read: the first load and a switch's answer. A failed read leaves
  // it pending, so the list stays blank and the error says why.
  assert.ok(app.indexOf("let athleteRosterPending = true;") > 0 && app.indexOf("let athleteRosterPending = true;") < app.indexOf("\ninit();"), "declared before init() runs");
  const clears = [...app.matchAll(/^ +athleteRosterPending = false;/gm)].map((m) => app.slice(Math.max(0, m.index - 120), m.index));
  assert.equal(clears.length, 2, "cleared on the two successful reads only");
  assert.ok(clears.every((before) => /state\.athletes = (data|roster)\.adminRows \|\| \[\];\n\s*$/.test(before)), "each right after a roster was read");
  assert.match(app, /renderAthleteListHtml\(athletes, state\.selectedAthleteId, \{ searching: Boolean\(search\), pending: athleteRosterPending \}\)/);
});

test("a zero count is quieter than a real count", () => {
  const host = html(renderAthleteListHtml([row({ weekly_plan_count: 2, program_count: 0 })], "1"));
  const [weekly, specific] = host.querySelectorAll(".athlete-counts span");
  assert.equal(weekly.textContent, "2 weekly");
  assert.equal(weekly.className, "");
  assert.equal(specific.textContent, "0 specific");
  assert.equal(specific.className, "is-zero");
  assert.ok(host.querySelector('.athlete-button.is-active[data-athlete-id="1"]'));
});

test("the list block: quiet zero counts and a 44 px, 16 px search on a phone", () => {
  const from = css.indexOf("Design: the athlete list in the rail.");
  const end = css.indexOf("\n/* =====", from + 10);
  const block = css.slice(from, end > 0 ? end : undefined);
  assert.ok(from > 0);
  assert.match(block, /\.athlete-counts span\.is-zero \{[^}]*border-color: transparent;[^}]*background: transparent;/);
  assert.doesNotMatch(block, /opacity/, "no opacity on small muted text (contrast)");
  assert.match(block.slice(block.indexOf("@media (max-width: 760px)")), /#athleteSearch \{\n\s+min-height: var\(--om-tap-target\);\n\s+font-size: 16px;/);
});
