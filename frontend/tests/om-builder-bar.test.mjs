import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// B3 (owner's Builder plan; the owner's decision of 2026-11-10): the program bar. Exit, Save and Discard stay icons,
// 44 px, named by a short aria-label, and show their description (the aria-description, no title) in a styled
// tooltip: on hover and keyboard focus on a computer, after a long press on a touch screen, which does not run it. The plan's state is a chip and the outline's two "i"
// buttons say what they open. No data-* or name changed. Browser proof: e2e/tests/builder-program-bar.test.mjs.
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const view = read("builder-view.js");
const css = read("styles.css");
const start = css.lastIndexOf("/* =====", css.indexOf("Design: the Builder's program bar (B3)"));
const end = css.indexOf("\n/* =====", start + 10);
const block = css.slice(start, end < 0 ? undefined : end);
const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");

test("the bar's buttons stay icon-only with their actions and names; the state is a chip", () => {
  const bar = view.slice(view.indexOf('class="builder-program-actions"'), view.indexOf("</header>", view.indexOf('class="builder-program-actions"')));
  assert.match(bar, /data-action="builder-cancel" aria-label="Exit"[^>]*>\$\{ICON_DOOR_EXIT\}<\/button>/);
  assert.match(bar, /data-action="builder-submit-plan" aria-label="\$\{saveLabel\}"[^>]*>\$\{ICON_CHECK\}<\/button>/);
  assert.match(bar, /data-action="builder-discard-current-draft" aria-label="Discard changes"[^>]*>\$\{ICON_X\}<\/button>/);
  assert.ok(!view.includes("builder-bar-label"), "no visible word in the bar");
  assert.doesNotMatch(bar, / title="/, "no title: the browser's own tooltip would show as well");
  assert.match(bar, /aria-label="Exit" aria-description="Exit and keep this draft for later\."/);
  assert.match(bar, /aria-label="\$\{saveLabel\}" aria-description="\$\{isEditDraft \? "Apply changes to the original plan\." : "Save and finish — marks this plan as active\."\}"/);
  assert.match(bar, /aria-label="Discard changes" aria-description="Discard all changes in this draft\."/);
  assert.match(bar, /<span class="item-badge builder-status-chip\$\{/);
});

test("the outline's two example buttons say what they open", () => {
  assert.match(view, /data-info="program" aria-label="Program example"><span class="button-icon" aria-hidden="true">i<\/span><span class="builder-info-label">Program example<\/span><\/button>/);
  assert.match(view, /data-info="session" aria-label="Session example"><span class="button-icon" aria-hidden="true">i<\/span><span class="builder-info-label">Session example<\/span><\/button>/);
});

test("every example button that shows a word has that word in its accessible name (label in name)", () => {
  const labelled = [...view.matchAll(/aria-label="([^"]+)"[^>]*>(?:(?!<\/button>).)*?<span class="builder-info-label">([^<]+)<\/span><\/button>/g)];
  assert.equal(labelled.length, 2);
  for (const [, name, word] of labelled) assert.ok(name.toLowerCase().includes(word.toLowerCase()), `"${name}" contains "${word}"`);
});

test("the tooltip is the button's description, shown on hover with a mouse, on keyboard focus and after a long press", () => {
  assert.match(rules, /\.builder-exit-button::after,[\s\S]*?\.icon-button\.danger-action::after \{\s*content: attr\(aria-description\);/);
  assert.match(rules, /\.icon-button\.danger-action::after \{[^}]*opacity: 0;[^}]*visibility: hidden;/);
  assert.match(rules, /@media \(hover: hover\) and \(pointer: fine\) \{[^@]*:hover::after[^{]*\{\s*opacity: 1;\s*visibility: visible;/);
  // Each of the three by its own class: Discard's hiding rule (.icon-button.danger-action::after) is more specific
  // than a bare .is-tooltip-open::after would be.
  assert.match(rules, /\.builder-exit-button:focus-visible::after,[\s\S]*?\.builder-exit-button\.is-tooltip-open::after,\s*[^{]*\.builder-finish-button\.is-tooltip-open::after,\s*[^{]*\.icon-button\.danger-action\.is-tooltip-open::after \{\s*opacity: 1;\s*visibility: visible;/);
  assert.match(rules, /-webkit-touch-callout: none;/);
  assert.match(rules, /content: attr\(aria-description\);[^}]*box-sizing: border-box;[^}]*width: max-content;/, "the padding counts inside the maximum");
  assert.match(rules, /\.icon-button\.danger-action\.is-tooltip-dismissed::after \{\s*opacity: 0;\s*visibility: hidden;/, "Escape closes it");
  assert.ok(rules.indexOf(".is-tooltip-dismissed::after") > rules.indexOf(":focus-visible::after"), "the dismissal comes after the rules that show it");
  assert.match(read("app.js"), /installBuilderBarTooltip\(\);/);
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
    assert.ok(/builder-program-actions|builder-status-chip|builder-outline-info-buttons|builder-outline > \.section-heading/.test(selector), selector);
  }
});

test("44 px on every width; on a phone the tooltip hangs under the bar and the examples share a row", () => {
  assert.match(rules, /\.builder-program-actions \.icon-button\.danger-action \{\s*display: inline-flex;[\s\S]*?height: var\(--om-tap-target\);\s*min-height: var\(--om-tap-target\);/);
  assert.match(rules, /\.builder-outline-info-buttons \.builder-info-button \{\s*display: inline-flex;[\s\S]*?min-height: var\(--om-tap-target\);/);
  const phone = rules.slice(rules.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.builder-program-actions \{\s*position: relative;/);
  assert.match(phone, /\.builder-exit-button::after,\s*[^{]*\.builder-finish-button::after,\s*[^{]*\.icon-button\.danger-action::after \{\s*right: auto;\s*left: 0;\s*max-width: 100%;/);
  assert.match(phone, /\.builder-outline-info-buttons \{\s*display: grid;\s*grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\);/);
});
