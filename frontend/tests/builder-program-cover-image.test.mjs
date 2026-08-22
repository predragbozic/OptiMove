import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Phase 4 of the Builder additions: a cover image URL field on the Builder's
// own "Create program" form. builder-view.js's own import chain touches
// `document` at module scope (same reasoning as other app.js-adjacent files
// in this suite - see athlete-mobile-navigation.test.mjs's header comment),
// so this is checked via source-pattern-guard over the raw file text.
function readSource(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const builderViewSource = readSource("../builder-view.js");

function sliceFunction(source, name, windowSize = 5500) {
  const marker = source.includes(`function ${name}(`) ? `function ${name}(` : `export function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must exist`);
  return source.slice(start, start + windowSize);
}

test("the create form's Cover image URL field is present, named coverImageUrl (auto-included by the existing FormData-based submit, no submit-path change needed)", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderInner");
  assert.match(body, /<input name="coverImageUrl" type="url" placeholder="https:\/\/\.\.\."/);
});

test("the cover image field only shows for program/template mode, not weekly - it's gated the same way as the rest of the isWeekly branch", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderInner");
  const fieldIndex = body.indexOf('name="coverImageUrl"');
  assert.ok(fieldIndex >= 0);
  const precedingLine = body.slice(Math.max(0, fieldIndex - 200), fieldIndex);
  assert.match(precedingLine, /\$\{isWeekly \? "" : `/, "must be wrapped in the same isWeekly ? \"\" : ... ternary the rest of the program-only fields use");
});

test("the field lives in the SAME create form (data-builder-form=\"create\") as name/color/icon - not a second form needing its own submit wiring", () => {
  const body = sliceFunction(builderViewSource, "renderBuilderInner");
  const formStart = body.indexOf('data-builder-form="create"');
  const fieldIndex = body.indexOf('name="coverImageUrl"');
  const formEnd = body.indexOf("</form>", formStart);
  assert.ok(formStart >= 0 && fieldIndex > formStart && fieldIndex < formEnd, "coverImageUrl must be inside the same <form> element as the rest of the create fields");
});
