// Design: the coach's Account page (coach-account.js), scoped so the athlete's own settings,
// which share these forms, are not touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.window = dom.window;
const { renderCoachAccountHtml } = await import("../coach-account.js");
const { renderAthleteSettingsHtml } = await import("../athlete-view.js");

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const from = css.indexOf("Design: the coach's Account page");
const end = css.indexOf("\n/* =====", from + 10);
const block = css.slice(css.lastIndexOf("/*", from), end > 0 ? end : undefined);
const rules = (text) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((x) => x.trim()), body: m[2] }));
const html = (markup) => { const host = document.createElement("div"); host.innerHTML = markup; return host; };

test("the coach's Account page carries its own class; the athlete's settings do not", () => {
  const coach = html(renderCoachAccountHtml({ name: "Coach Example", email: "coach@example.invalid" }, null));
  const view = coach.querySelector(".coach-account-view");
  assert.ok(view, "the coach page is scoped");
  const cards = [...view.querySelectorAll(":scope > .athlete-settings-card")];
  assert.ok(cards.length >= 3, "the identity card and the form cards");
  assert.ok(cards[0].querySelector(".eyebrow"), "the first card keeps its eyebrow");
  assert.ok(cards.slice(1).some((c) => c.querySelector(".eyebrow")), "a form card's eyebrow exists in the markup (hidden by CSS)");
  assert.ok(view.querySelectorAll('.organization-form button[type="submit"]').length >= 2, "the forms' actions are reached by the selector");
  const athlete = html(renderAthleteSettingsHtml({ id: "a1", name: "Ana Example" }, { name: "Ana Example", email: "ana@example.invalid" }, null, null));
  assert.equal(athlete.querySelector(".coach-account-view"), null, "the athlete's settings are not scoped, so not changed");
});

test("every rule of the block is scoped to the coach's Account page", () => {
  assert.ok(from > 0);
  const all = rules(block);
  assert.ok(all.length >= 6);
  for (const rule of all) for (const sel of rule.selectors) {
    if (sel.startsWith("@media")) continue;
    assert.match(sel, /^\.coach-account-view /, sel);
  }
});

test("form actions are primary; a phone gets 44 px fields and buttons; only the first card's eyebrow shows", () => {
  const all = rules(block);
  const of = (sel) => all.find((r) => r.selectors.includes(sel))?.body || "";
  assert.match(of('.coach-account-view .organization-form button[type="submit"]'), /background: var\(--accent\);[\s\S]*color: #fff;/);
  assert.match(of(".coach-account-view > .athlete-settings-card:not(:first-child) .eyebrow"), /display: none;/);
  const phone = block.slice(block.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.coach-account-view input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\),\n\s+\.coach-account-view select,\n\s+\.coach-account-view button \{\n\s+min-height: var\(--om-tap-target\);/);
});
