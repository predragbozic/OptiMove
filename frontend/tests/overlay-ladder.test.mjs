import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The overlay ladder (styles.css, the comment above .media-modal): every
// layer clears what it is opened from. A Specific Program draws its sections
// inside its own overlay (1200), so the exercise detail opened from a section
// (at 900 it opened behind it, the program inert and frozen on top: "ne iskače
// ispred ulaz u vežbu", 2026-10-30) and the editor opened from the detail must
// clear it; Escape and phone Back close only the topmost of them.

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const css = read("../styles.css");
const appJs = read("../app.js");
const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(",").map((selector) => ({ selector: selector.trim().replace(/\s+/g, " "), body: match[2] })));

// Bottom to top, as the ladder lists them.
const LADDER = [
  [".program-preview-overlay"],
  [".program-info-overlay"],
  [".exercise-detail-overlay"],
  [".exercise-editor-overlay", ".exercise-tag-overlay"],
  [".builder-modal-overlay"],
  [".media-modal"],
];

// Every z-index a selector has, in any rule or media query.
function zValues(selector) {
  return rules
    .filter((rule) => rule.selector === selector)
    .flatMap((rule) => [...rule.body.matchAll(/(?:^|;)\s*z-index\s*:\s*(\d+)/g)].map((match) => Number(match[1])));
}

test("1. styles.css: the overlay ladder, bottom to top - Specific Program 1200 < its info 1250 < exercise detail < editor and tags < Builder modals 1300 < media viewer 1400 - one value per layer, as the comment above .media-modal documents it", () => {
  const levels = LADDER.map((step) => step.map((selector) => {
    const values = zValues(selector);
    assert.equal(values.length, 1, `${selector} has exactly one z-index, in no media query or state again (found ${values.join(", ") || "none"})`);
    return values[0];
  }));
  for (const [index, step] of levels.entries()) {
    assert.equal(new Set(step).size, 1, `${LADDER[index].join(" and ")} share one level`);
    if (index) assert.ok(step[0] > levels[index - 1][0], `${LADDER[index][0]} (${step[0]}) is above ${LADDER[index - 1][0]} (${levels[index - 1][0]})`);
  }
  assert.deepEqual(levels.map((step) => step[0]), [1200, 1250, 1260, 1270, 1300, 1400]);

  // The documented ladder names the same number for every layer.
  const start = css.indexOf("/* The overlay ladder");
  const comment = css.slice(start, css.indexOf("*/", start));
  assert.ok(start >= 0 && css.indexOf(".media-modal {", start) - css.indexOf("*/", start) < 10, "the ladder comment sits right above .media-modal");
  const documented = new Map();
  for (const entry of comment.split(/\n\s+(?=\d{3,4}\s)/).slice(1)) {
    const level = Number(entry.match(/^\d+/)[0]);
    for (const name of entry.match(/\.(?:[\w-]+-overlay|media-modal)\b/g) || []) if (!documented.has(name)) documented.set(name, level);
  }
  for (const [index, step] of LADDER.entries()) {
    for (const selector of step) assert.equal(documented.get(selector), levels[index][0], `the ladder comment gives ${selector} its real z-index`);
  }
});

test("2. an exercise opened from a Specific Program's section is drawn on top of it: the detail and the editor go into #content with the program overlay, above it, and no ancestor of #content makes a stacking context of its own", () => {
  const [program] = zValues(".program-preview-overlay");
  const [info] = zValues(".program-info-overlay");
  const [detail] = zValues(".exercise-detail-overlay");
  const [editor] = zValues(".exercise-editor-overlay");
  assert.ok(detail > program && detail > info, `the detail (${detail}) is above the Specific Program (${program}) and its info (${info})`);
  assert.ok(editor > detail, `the editor (${editor}) is above the detail it is opened from (${detail})`);

  // The same parent, so the numbers compare directly.
  const body = (name) => appJs.slice(appJs.indexOf(`function ${name}(`), appJs.indexOf("\n}\n", appJs.indexOf(`function ${name}(`)));
  assert.match(body("renderNode"), /els\.content\.innerHTML = renderProgramNodeOverlayHtml\(/, "a section of a Specific Program is drawn inside its overlay, in #content");
  assert.match(body("renderExerciseDetail"), /els\.content\.insertAdjacentHTML\("beforeend", markup\)/, "the detail goes into #content");
  assert.match(body("renderExerciseEditorOverlay"), /els\.content\.insertAdjacentHTML\("beforeend", renderExerciseEditorHtml\(/, "the editor goes into #content");

  // section#content < main.workspace < div.app-shell < body, in both shells.
  for (const page of ["../index.html", "../athlete.html"]) {
    const html = read(page);
    const shell = html.indexOf('<div class="app-shell">');
    const main = html.indexOf('<main class="workspace">', shell);
    const content = html.indexOf('<section class="content" id="content">', main);
    assert.ok(shell >= 0 && main > shell && content > main, `${page}: #content sits in main.workspace in div.app-shell`);
  }
  const stacking = /(?:^|;)\s*(transform|filter|backdrop-filter|-webkit-backdrop-filter|perspective|contain|isolation|will-change|mix-blend-mode|clip-path|mask|mask-image|container-type|z-index|opacity)\s*:/;
  // The elements themselves, not a ::before / ::after drawn inside them.
  const ancestors = rules.filter((rule) => {
    const element = rule.selector.split(/[\s>+~]+/).pop();
    return /^(\.app-shell|\.workspace|\.content|#content|body|html)(?![\w-])/.test(element) && !/::?(before|after)\b/.test(element);
  });
  assert.ok(ancestors.length > 10, "the rules of the ancestors are found");
  for (const rule of ancestors) assert.doesNotMatch(rule.body, stacking, `${rule.selector} makes no stacking context`);
});

// The real Escape handler, handleAppBack() and closeTopExerciseLayer() from
// app.js, run against fakes: every name they call that the test does not
// provide is recorded, so what was closed - and what was not - is visible.
function loadHandlers(state, { editorCloses = true } = {}) {
  const calls = [];
  const sourceOf = (start, end) => {
    const from = appJs.indexOf(start);
    assert.ok(from >= 0, start);
    return appJs.slice(from, appJs.indexOf(end, from) + end.length);
  };
  const escape = sourceOf("(event) => {\n    if (event.key !== \"Escape\") return;", "\n  }");
  const closeTop = sourceOf("function closeTopExerciseLayer() {", "\n}");
  const appBack = sourceOf("function handleAppBack() {", "\n}");
  const detail = { present: state.detailOpen };
  const scope = {
    state,
    BACK_STAYED: "stayed",
    els: {
      mediaModal: { hidden: !state.mediaOpen },
      content: { querySelector: (selector) => (selector === ".exercise-detail" && detail.present ? {} : null) },
    },
    closeExerciseEditor: () => { calls.push("closeExerciseEditor"); if (editorCloses) state.exerciseEditor.open = false; return editorCloses; },
    returnToNodeParent: () => { calls.push("returnToNodeParent"); detail.present = false; },
    closeSpecificProgramOverlay: () => { calls.push("closeSpecificProgramOverlay"); return true; },
  };
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === "string" && (key in target || !(key in globalThis)),
    get: (target, key) => (key in target ? target[key] : typeof key === "string" ? (...args) => { calls.push(key); return undefined; } : undefined),
  });
  // eslint-disable-next-line no-new-func
  const handlers = new Function("scope", `with (scope) { ${closeTop}\n${appBack}\nreturn { escape: ${escape}, handleAppBack }; }`)(proxy);
  return { ...handlers, calls };
}

const baseState = (overrides = {}) => ({
  exerciseEditor: { open: false }, detailOpen: false, mediaOpen: false,
  athleteExitConfirmOpen: false, mobileNavOpen: false, navStack: [{ type: "section" }],
  organizationUserManage: { open: false }, organizationInvite: { open: false }, athleteAccountManage: { open: false },
  workspaceSwitcher: { open: false }, iconPicker: null, activeTab: "programs", trainingLoad: { section: "" },
  ...overrides,
});

test("3. Escape closes only the topmost layer: the exercise detail opened over a Specific Program closes alone and the program stays open; the editor over the detail closes alone; the viewer stays first; with no exercise layer the program closes as before", () => {
  let run = loadHandlers(baseState({ detailOpen: true }));
  run.escape({ key: "Escape" });
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["returnToNodeParent"], "only the detail closes; the Specific Program stays");

  run = loadHandlers(baseState({ detailOpen: true, exerciseEditor: { open: true } }));
  run.escape({ key: "Escape" });
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["closeExerciseEditor"], "only the editor closes; the detail and the program stay");

  // An upload in flight: the editor asks, the coach keeps it - nothing else closes.
  run = loadHandlers(baseState({ detailOpen: true, exerciseEditor: { open: true } }), { editorCloses: false });
  run.escape({ key: "Escape" });
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["closeExerciseEditor"]);

  run = loadHandlers(baseState({ detailOpen: true, mediaOpen: true }));
  run.escape({ key: "Escape" });
  assert.deepEqual(run.calls, ["closeMedia"], "the viewer over the detail closes alone");

  run = loadHandlers(baseState());
  run.escape({ key: "Escape" });
  assert.ok(run.calls.includes("closeSpecificProgramOverlay"), "with no exercise layer open, Escape still closes the Specific Program");
  assert.ok(!run.calls.includes("returnToNodeParent") && !run.calls.includes("closeExerciseEditor"));

  run = loadHandlers(baseState({ detailOpen: true }));
  run.escape({ key: "Enter" });
  assert.deepEqual(run.calls, [], "another key does nothing");
});

test("4. phone Back closes only the topmost layer too: the editor, then the detail, before the section steps up or the Specific Program closes; an editor that stays open puts the consumed history entry back", () => {
  let state = baseState({ detailOpen: true, exerciseEditor: { open: true } });
  let run = loadHandlers(state);
  assert.equal(run.handleAppBack(), true);
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["closeExerciseEditor"]);
  assert.equal(state.navStack.length, 1, "the section stays where it was");

  assert.equal(run.handleAppBack(), true);
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["closeExerciseEditor", "returnToNodeParent"], "the next Back closes the detail");
  assert.equal(state.navStack.length, 1);

  state = baseState({ detailOpen: true, exerciseEditor: { open: true } });
  run = loadHandlers(state, { editorCloses: false });
  assert.equal(run.handleAppBack(), "stayed", "BACK_STAYED: the browser's entry is put back");
  assert.deepEqual(run.calls.filter((name) => name !== "handleMessagesBack"), ["closeExerciseEditor"]);

  state = baseState();
  run = loadHandlers(state);
  assert.equal(run.handleAppBack(), true);
  assert.equal(state.navStack.length, 0, "with no exercise layer, Back steps up from the section as before");
  assert.ok(!run.calls.includes("closeSpecificProgramOverlay") && !run.calls.includes("returnToNodeParent"));
});
