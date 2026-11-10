import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B3 (owner's Builder plan): the program bar. Exit, Save and Discard as 44 px buttons with their words on a computer
// (icons on a phone), the plan's state as a chip, and the outline's two "i" buttons saying what they open. No data-*
// or name changed. The browser proof is e2e/tests/builder-program-bar.test.mjs.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const view = read("builder-view.js");
const css = read("styles.css");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Builder's program bar (B3)"));
const end = css.indexOf("\n/* =====", start + 10);
const block = css.slice(start, end < 0 ? undefined : end);
const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");

test("the bar's buttons keep their actions and names and gain their word; the state is a chip", () => {
  const bar = view.slice(view.indexOf('class="builder-program-actions"'), view.indexOf("</header>", view.indexOf('class="builder-program-actions"')));
  assert.match(bar, /data-action="builder-cancel" aria-label="Exit"[^>]*>\$\{ICON_DOOR_EXIT\}<span class="builder-bar-label">Exit<\/span><\/button>/);
  assert.match(bar, /data-action="builder-submit-plan" aria-label="\$\{saveLabel\}"[^>]*>\$\{ICON_CHECK\}<span class="builder-bar-label">\$\{saveLabel\}<\/span><\/button>/);
  assert.match(bar, /data-action="builder-discard-current-draft" aria-label="Discard changes"[^>]*>\$\{ICON_X\}<span class="builder-bar-label">Discard<\/span><\/button>/);
  assert.match(bar, /<span class="item-badge builder-status-chip\$\{/);
});

test("the outline's two example buttons say what they open", () => {
  assert.match(view, /data-info="program" aria-label="Program example"><span class="button-icon" aria-hidden="true">i<\/span><span class="builder-info-label">Program example<\/span><\/button>/);
  assert.match(view, /data-info="session" aria-label="Session example"><span class="button-icon" aria-hidden="true">i<\/span><span class="builder-info-label">Session example<\/span><\/button>/);
});

test("every button that shows a word has that word in its accessible name (label in name)", () => {
  const labelled = [...view.matchAll(/aria-label="([^"]+)"[^>]*>(?:(?!<\/button>).)*?<span class="(?:builder-bar-label|builder-info-label)">([^<]+)<\/span><\/button>/g)];
  assert.ok(labelled.length >= 5, labelled.length);
  for (const [, name, word] of labelled) {
    const shown = word === "${saveLabel}" ? "Save" : word;
    const accessible = name === "${saveLabel}" ? "Save" : name;
    assert.ok(accessible.toLowerCase().includes(shown.toLowerCase()), `"${accessible}" contains "${shown}"`);
  }
});

test("the chip's dot marks a draft only", () => {
  assert.match(view, /builder-status-chip\$\{isEditDraft \|\| \(draft\.plan\.status \|\| "draft"\) === "draft" \? " is-draft" : ""\}/);
  assert.match(rules, /\.builder-status-chip\.is-draft::before \{/);
  assert.ok(!/text-transform: capitalize/.test(rules), "the state keeps its own case");
});

test("every rule is the coach's Builder bar or outline heading", () => {
  const selectors = [...rules.matchAll(/([^{};]+)\{/g)].map((m) => m[1].trim()).filter((s) => !s.startsWith("@")).flatMap((s) => s.split(",")).map((s) => s.trim());
  assert.ok(selectors.length >= 12, selectors.length);
  for (const selector of selectors) {
    assert.ok(selector.startsWith("body:not(.athlete-mode):not(.login-mode) "), selector);
    assert.ok(/builder-program-actions|builder-bar-label|builder-status-chip|builder-outline-info-buttons|builder-outline > \.section-heading/.test(selector), selector);
  }
});

test("44 px on every width; on a phone the bar's words are hidden (still the names) and the examples share a row", () => {
  assert.match(rules, /\.builder-program-actions \.icon-button\.danger-action \{\s*display: inline-flex;[\s\S]*?height: var\(--om-tap-target\);\s*min-height: var\(--om-tap-target\);/);
  assert.match(rules, /\.builder-outline-info-buttons \.builder-info-button \{\s*display: inline-flex;[\s\S]*?min-height: var\(--om-tap-target\);/);
  const phone = rules.slice(rules.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.builder-bar-label \{\s*position: absolute;\s*width: 1px;\s*height: 1px;\s*overflow: hidden;\s*clip: rect\(0 0 0 0\);/);
  assert.match(phone, /\.builder-outline-info-buttons \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\);/);
});
