import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
globalThis.document = { querySelector: () => null, querySelectorAll: () => [] };
const { renderCoachHomeHtml, renderCoachHomeAthleteRows } = await import("../coach-home.js");
const { loadCoachHome } = await import("../coach-home-data.js");
const { state } = await import("../state.js");
const { localDateIso } = await import("../utils.js");
const rows = [{ athleteId: "17", athleteUuid: "uuid-17", athlete: "Ana Test", hasTrainingToday: true, sessionCount: 1 }, { athleteId: "18", athleteUuid: "uuid-18", athlete: "Marko Test", hasTrainingToday: false }];
beforeEach(() => { state.currentUser = { id: "coach", activeWorkspace: { type: "private_coach" } }; });

// Coach Home redesign (owner, 2026-10-22): Training plan and Training load
// are cards with every athlete in a strip under them (one tap opens that
// athlete there), the searchable list stays one Search away, and the old
// Today row became the day card with its calendar.
test("Home shows Training plan and Training load cards, each with every athlete in an alphabetical strip, and the day card", () => {
  const { doc, close } = parse(renderCoachHomeHtml({ rows: [rows[1], rows[0]], user: state.currentUser }));
  for (const [mode, title] of [["plan", "Training plan"], ["load", "Training load"]]) {
    const panel = doc.querySelector(`.coach-home-panel-${mode}`);
    assert.ok(panel, `${title} card`);
    assert.match(panel.querySelector("h3").textContent, new RegExp(title));
    const athletes = [...panel.querySelectorAll('[data-coach-home-track] [data-action="coach-home-open-athlete"]')];
    assert.deepEqual(athletes.map((button) => button.dataset.athleteId), ["17", "18"], "alphabetical, the search list's order");
    assert.ok(athletes.every((button) => button.dataset.mode === mode && button.tagName === "BUTTON"));
    assert.equal(athletes[0].getAttribute("aria-label"), `Ana Test, ${title}`);
    assert.equal(panel.querySelector('[data-action="coach-home-picker-open"]').dataset.mode, mode, "the searchable list stays available");
    const arrows = panel.querySelectorAll('[data-action="coach-home-scroll"]');
    assert.deepEqual([...arrows].map((arrow) => [arrow.dataset.track, arrow.dataset.direction]), [[mode, "-1"], [mode, "1"]]);
  }
  assert.match(doc.querySelector(".coach-home-day").textContent, /1 \/ 2 athletes training/);
  assert.equal(doc.querySelector("dialog"), null);
  close();
});
test("every Home card shows the same icon as its item in the main menu", () => {
  const shell = readFileSync(new URL("../index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const squash = (svg) => svg.replace(/>\s+</g, "><").trim();
  const menuIcon = (marker) => squash(shell.match(new RegExp(`${marker}[^>]*>[\\s\\S]*?<svg[^>]*>([\\s\\S]*?)<\\/svg>`))?.[1] || "");
  // The card icons exist once the roster holds an athlete (an empty roster
  // renders the empty state instead), so they are read from a Home with rows.
  const { doc, close } = parse(renderCoachHomeHtml({ rows, user: state.currentUser }));
  const cardIcon = (selector) => squash(doc.querySelector(`${selector} .coach-home-panel-icon`)?.innerHTML || "");
  const pairs = [
    ["the menu's Calendar (the weekly plan)", 'id="calendarToggle"', ".coach-home-panel-plan"],
    ["Training load", 'data-library-tab="training-load"', ".coach-home-panel-load"],
    ["Exercise Library", 'data-library-tab="exercises"', '[data-coach-home-section="exercises"]'],
    ["Program Library", 'data-library-tab="templates" data-template-scope="my_programs" title="Program Library"', '[data-coach-home-section="programs"]'],
  ];
  for (const [label, marker, card] of pairs) {
    const expected = menuIcon(marker);
    assert.ok(expected, `${label}: menu icon found`);
    assert.equal(cardIcon(card), expected, `${label}: the same paths`);
  }
  for (const icon of doc.querySelectorAll(".coach-home-panel-icon")) assert.equal(icon.getAttribute("aria-hidden"), "true");
  close();
});
test("the day card's list opens the same searchable dialog limited to that day's athletes", () => {
  const today = localDateIso();
  const html = renderCoachHomeHtml({ rows, user: state.currentUser, picker: { mode: "day", date: today } });
  assert.match(html, /id="coachHomePickerTitle">Today/);
  assert.match(html, new RegExp(`data-mode="day" data-date="${today}" data-athlete-id="17"`));
  const { doc, close } = parse(html);
  assert.doesNotMatch(doc.querySelector("dialog").textContent, /Marko Test/);
  close();
  assert.match(renderCoachHomeAthleteRows(rows, { mode: "day", date: today, query: "ana" }), /Ana Test/);
  assert.match(renderCoachHomeAthleteRows(rows, { mode: "day", date: today, query: "Marko" }), /No athletes match/);
  assert.match(renderCoachHomeAthleteRows([rows[1]], { mode: "day", date: today }), /No athletes have a session scheduled today/);
  assert.match(renderCoachHomeAthleteRows([], { mode: "day", date: today }), /No athletes have a session scheduled today/);
  assert.match(renderCoachHomeAthleteRows([], { mode: "day", date: "2026-01-05" }, today), /No athletes have a session scheduled on this day/);
});
test("admin Home shows only available workspaces, no combined roster", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [{ type: "private_coach" }, { type: "club", scopeId: "club-a", label: "My Club" }] };
  const html = renderCoachHomeHtml({ rows, user });
  assert.match(html, /data-workspace-type="private_coach"/);
  assert.match(html, /data-workspace-scope-id="club-a"/);
  assert.doesNotMatch(html, /Ana Test|Marko Test|coach-home-picker-open/);
});
test("admin Home nests available teams under their club and keeps other teams independent", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [
    { type: "platform" }, { type: "private_coach" },
    { type: "team", scopeId: "team-a", clubId: "club-a", label: "First Team" },
    { type: "club", scopeId: "club-a", label: "My Club" },
    { type: "team", scopeId: "solo", clubId: "unavailable-club", label: "Independent Team" },
  ] };
  const dom = new JSDOM(renderCoachHomeHtml({ user }));
  const doc = dom.window.document;
  const nested = doc.querySelector(".coach-home-workspace-teams");
  assert.equal(nested.getAttribute("aria-label"), "My Club teams");
  assert.equal(nested.querySelector("button").dataset.workspaceScopeId, "team-a");
  assert.equal(nested.parentElement.querySelector("button").dataset.workspaceScopeId, "club-a");
  assert.equal(doc.querySelectorAll('[data-workspace-scope-id="team-a"]').length, 1);
  assert.equal(doc.querySelector('[data-workspace-scope-id="solo"]').closest("ul").className, "coach-home-workspaces");
  for (const button of doc.querySelectorAll(".coach-home-workspace")) {
    assert.ok(button.querySelector('svg[aria-hidden="true"]'));
    assert.equal(button.dataset.action, "workspace-select");
  }
  assert.equal(doc.querySelectorAll('[data-workspace-type="platform"]').length, 0);
  dom.window.close();
});
test("admin Home avoids fetching all athletes", async () => {
  state.currentUser.activeWorkspace = { type: "platform" };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Must not load a combined roster");
  try {
    let rendered;
    await loadCoachHome({ renderCoachHome: (data) => { rendered = data; } });
    assert.deepEqual(rendered, { rows: [], error: "" });
  } finally { globalThis.fetch = originalFetch; }
});
test("picker searches names and IDs case-insensitively and uses the chosen destination", () => {
  const html = renderCoachHomeAthleteRows(rows, { mode: "load", query: " ANA " });
  assert.match(html, /Ana Test/);
  assert.doesNotMatch(html, /Marko Test/);
  assert.match(html, /data-mode="load".*data-athlete-uuid="uuid-17"/);
  assert.match(renderCoachHomeAthleteRows(rows, { query: "18" }), /Marko Test/);
  assert.match(renderCoachHomeAthleteRows(rows, { query: "missing" }), /No athletes match/);
});
test("picker has an accessible dialog and escapes athlete and workspace labels", () => {
  const html = renderCoachHomeHtml({ rows: [{ ...rows[0], athlete: "<script>bad</script>" }], picker: { mode: "plan" }, user: state.currentUser });
  assert.match(html, /<dialog.*aria-labelledby="coachHomePickerTitle"/);
  assert.match(html, /aria-label="Search athletes"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
});

// --- Empty, error and trigger states (coach Home) ---

function parse(html) {
  const dom = new JSDOM(html);
  return { doc: dom.window.document, close: () => dom.window.close() };
}

test("a roster that loaded with no athletes shows the empty state with Add athlete - no athlete or day card, no pickers", () => {
  const html = renderCoachHomeHtml({ rows: [], user: state.currentUser });
  const { doc, close } = parse(html);
  assert.match(html, /No athletes in this workspace yet/);
  const cta = doc.querySelector('.coach-home-state [data-action="home-add-athlete"]');
  assert.ok(cta, "the empty state carries the existing home-add-athlete action");
  assert.equal(cta.tagName, "BUTTON");
  assert.match(cta.textContent, /Add athlete/);
  assert.ok(doc.querySelector('.coach-home-header [data-action="home-add-athlete"]'), "the header's round Add athlete stays");
  assert.equal(doc.querySelectorAll('[data-action="coach-home-picker-open"]').length, 0);
  assert.equal(doc.querySelector(".coach-home-panel-plan, .coach-home-panel-load, .coach-home-day"), null, "no athlete card, no day card");
  assert.equal(doc.querySelector("dialog"), null);
  assert.doesNotMatch(html, /athletes training|Training Plan|Training Load|coach-home-retry/);
  close();
});

test("a failed load shows only the error and Try again - no pickers, no athlete or day card, no dialog even with a picker mode left over", () => {
  const html = renderCoachHomeHtml({ rows: [], error: "network down", user: state.currentUser, picker: { mode: "day", date: localDateIso() } });
  const { doc, close } = parse(html);
  const alert = doc.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /Your athletes could not be loaded/);
  assert.match(alert.textContent, /network down/);
  const retry = doc.querySelector('[data-action="coach-home-retry"]');
  assert.ok(retry, "the error state offers Try again");
  assert.equal(retry.tagName, "BUTTON");
  assert.match(retry.textContent, /Try again/);
  assert.equal(doc.querySelectorAll('[data-action="coach-home-picker-open"]').length, 0);
  assert.equal(doc.querySelector(".coach-home-panel-plan, .coach-home-panel-load, .coach-home-day"), null, "no athlete card, no day card");
  assert.equal(doc.querySelector("dialog"), null);
  assert.doesNotMatch(html, /athletes training|No athletes in this workspace/);
  close();
});

test("the error message is escaped like every other value", () => {
  const html = renderCoachHomeHtml({ rows: [], error: "<img src=x onerror=alert(1)>", user: state.currentUser });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test("Try again re-runs loadCoachHome with forceRefresh in app.js - never a page reload", () => {
  // app.js touches document at module scope through its import chain, so the
  // handler is checked over the source text (the same source-pattern guard
  // every other app.js-adjacent test in this suite uses); the real click is
  // exercised in the browser QA of the change.
  const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const start = source.indexOf('type === "coach-home-retry"');
  assert.ok(start >= 0, "app.js must handle coach-home-retry");
  const block = source.slice(start, source.indexOf("return;", start));
  assert.match(block, /await loadCoachHome\(\{\s*forceRefresh:\s*true\s*\}\)/);
  assert.doesNotMatch(block, /location\.(reload|assign|replace)|fetch\(/);
});

test("platform administration Home is untouched by the empty and error states", () => {
  const user = { activeWorkspace: { type: "platform" }, availableWorkspaces: [{ type: "private_coach" }, { type: "club", scopeId: "club-a", label: "My Club" }] };
  const html = renderCoachHomeHtml({ rows: [], user });
  assert.match(html, /class="coach-home-workspaces"/);
  assert.doesNotMatch(html, /coach-home-state|No athletes in this workspace yet|coach-home-retry|home-add-athlete/);
  const errored = renderCoachHomeHtml({ rows: [], error: "x", user });
  assert.match(errored, /<p class="builder-error" role="alert">x<\/p>/);
  assert.match(errored, /class="coach-home-workspaces"/);
  assert.doesNotMatch(errored, /coach-home-state|coach-home-retry/);
  const none = renderCoachHomeHtml({ rows: [], user: { activeWorkspace: { type: "platform" }, availableWorkspaces: [] } });
  assert.match(none, /No coaching workspaces available/);
  assert.doesNotMatch(none, /coach-home-state/);
});

const busyDay = Array.from({ length: 8 }, (_, index) => ({ athleteId: String(100 + index), athleteUuid: `uuid-${100 + index}`, athlete: `Athlete ${String.fromCharCode(72 - index)}`, hasTrainingToday: true, sessionCount: 1 }));

test("every athlete-list trigger declares aria-haspopup=dialog; the day card lists six athletes and offers Show all for the rest", () => {
  const few = parse(renderCoachHomeHtml({ rows, user: state.currentUser }));
  const triggers = few.doc.querySelectorAll('[data-action="coach-home-picker-open"]');
  assert.deepEqual([...triggers].map((trigger) => trigger.dataset.mode), ["plan", "load"], "the two Search buttons; no Show all for one athlete");
  for (const trigger of triggers) {
    assert.equal(trigger.tagName, "BUTTON");
    assert.equal(trigger.getAttribute("aria-haspopup"), "dialog");
  }
  const inline = few.doc.querySelectorAll('.coach-home-day-list [data-action="coach-home-open-athlete"]');
  assert.deepEqual([...inline].map((row) => [row.dataset.athleteId, row.dataset.mode, row.dataset.date]), [["17", "day", localDateIso()]]);
  few.close();

  const many = parse(renderCoachHomeHtml({ rows: [...busyDay, rows[1]], user: state.currentUser }));
  // Every athlete of the day is in the day's strip (a phone pages through
  // them); a computer lists the first six (the rest carry is-beyond-list,
  // hidden there by styles.css) and offers Show all.
  const listed = many.doc.querySelectorAll('.coach-home-day-list [data-coach-home-track="day"] [data-action="coach-home-open-athlete"]');
  assert.equal(listed.length, 8);
  assert.equal(listed[0].textContent.includes("Athlete A"), true, "alphabetical");
  assert.deepEqual([...listed].map((button) => button.closest("li").classList.contains("is-beyond-list")), [false, false, false, false, false, false, true, true]);
  const showAll = many.doc.querySelector('.coach-home-day [data-action="coach-home-picker-open"]');
  assert.ok(showAll.classList.contains("coach-home-day-show-all"));
  assert.equal(showAll.dataset.mode, "day");
  assert.equal(showAll.dataset.date, localDateIso());
  assert.equal(showAll.getAttribute("aria-haspopup"), "dialog");
  assert.match(showAll.textContent, /Show all 8 athletes/);
  assert.match(many.doc.querySelector(".coach-home-day").textContent, /8 \/ 9 athletes training/);
  many.close();
});

test("Show all opens the dialog limited to the day's athletes, with the trigger kept behind it", () => {
  const { doc, close } = parse(renderCoachHomeHtml({ rows: [...busyDay, rows[1]], user: state.currentUser, picker: { mode: "day", date: localDateIso() } }));
  const dialog = doc.querySelector("dialog.coach-home-picker");
  assert.ok(dialog);
  assert.equal(dialog.getAttribute("aria-labelledby"), "coachHomePickerTitle");
  assert.equal(doc.querySelector("#coachHomePickerTitle").textContent, "Today");
  assert.ok(dialog.querySelector('[data-action="coach-home-picker-close"]'));
  assert.ok(dialog.querySelector("input[data-coach-home-search]"));
  const athleteRows = dialog.querySelectorAll('[data-action="coach-home-open-athlete"]');
  assert.equal(athleteRows.length, 8);
  assert.ok([...athleteRows].every((row) => row.dataset.mode === "day" && row.dataset.date === localDateIso()));
  assert.doesNotMatch(dialog.textContent, /Marko Test/);
  assert.ok(doc.querySelector('.coach-home-day [data-action="coach-home-picker-open"][data-mode="day"]'));
  close();
});

test("the dead card, list, summary, workflow and Today-row Home selectors stay out of styles.css while the avatar rules stay in", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.coach-home-(card|cards|list|summary|actions|today)\b/);
  assert.match(css, /\.coach-home-avatar\b/);
  assert.match(css, /\.coach-home-avatar-fallback\b/);
});
