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
// Every rule of the block, the ones inside an @media included (its header and closing brace are
// removed first, so their selectors are checked too).
const rules = (text) => {
  let flat = text.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of [...flat.matchAll(/@media[^{]+\{/g)].reverse()) {
    let depth = 1; let i = m.index + m[0].length;
    for (; i < flat.length && depth; i += 1) { if (flat[i] === "{") depth += 1; else if (flat[i] === "}") depth -= 1; }
    flat = flat.slice(0, m.index) + flat.slice(m.index + m[0].length, i - 1) + flat.slice(i);
  }
  return [...flat.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: m[1].split(",").map((x) => x.trim()), body: m[2] }));
};
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
  for (const rule of all) for (const sel of rule.selectors) assert.match(sel, /^\.coach-account-view /, sel);
});

test("form actions are primary; a phone gets 44 px fields and buttons; only the first card's eyebrow shows", () => {
  const all = rules(block);
  const of = (sel) => all.find((r) => r.selectors.includes(sel))?.body || "";
  assert.match(of('.coach-account-view .organization-form button[type="submit"]'), /background: var\(--accent\);[\s\S]*color: #fff;/);
  assert.match(of(".coach-account-view > .athlete-settings-card:not(:first-child) .eyebrow"), /display: none;/);
  const phone = rules(block.slice(block.indexOf("@media (max-width: 760px)")));
  const field = '.coach-account-view input:not([type="checkbox"]):not([type="radio"])';
  assert.ok(phone.some((r) => r.selectors.includes(field) && r.selectors.includes(".coach-account-view button") && /min-height: var\(--om-tap-target\);/.test(r.body)), "44 px fields and buttons");
  assert.ok(phone.some((r) => r.selectors.includes(field) && r.selectors.includes(".coach-account-view select") && /font-size: 16px;/.test(r.body)), "16 px fields");
  // Off, but legible: the .plain-button:disabled opacity is reset.
  assert.match(of('.coach-account-view .organization-form button[type="submit"]:disabled'), /opacity: 1;/);
  // A hover only where there is a hover (no sticky colour after a tap).
  assert.ok(block.indexOf(":hover") > block.indexOf("@media (hover: hover)") && block.indexOf("@media (hover: hover)") > 0);
});
