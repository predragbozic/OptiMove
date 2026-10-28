// The built-in icon library (Data configuration visual polish, PR-1;
// docs/ai/data-configuration-visual-proposal.md section 3.1): the server's
// key list (backend/src/iconKeys.js) and the frontend library
// (frontend/icon-library.js) are written by one generator from one manifest,
// and these checks prove the committed files still agree with each other and
// with the manifest, hold geometry only, and keep the licence beside them. No
// database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ICON_KEYS, isIconKey } from "../src/iconKeys.js";
import { ICON_ALIASES, ICON_CATEGORIES, ICON_LIBRARY, ICONS } from "../../frontend/icon-library.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts", "icon-library", "manifest.json"), "utf8"));
const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\- ]+$/;

test("1. the server's keys are exactly the frontend library's keys, in the same order", () => {
  assert.deepEqual([...ICON_KEYS], ICONS.map((icon) => icon.key));
  assert.ok(ICON_KEYS.length >= 100, "about a hundred icons");
  assert.ok(Object.isFrozen(ICON_KEYS) && Object.isFrozen(ICONS));
});

test("2. both files match the manifest: keys, categories, words, aliases and the pinned source", () => {
  assert.deepEqual(ICONS.map((icon) => [icon.key, icon.category, [...icon.words]]), manifest.icons.map((icon) => [icon.key, icon.category, icon.words]));
  assert.deepEqual(ICON_CATEGORIES.map((c) => ({ ...c })), manifest.categories);
  assert.deepEqual({ ...ICON_ALIASES }, manifest.aliases);
  assert.deepEqual({ ...ICON_LIBRARY }, manifest.source);
  assert.equal(ICON_LIBRARY.package, "@tabler/icons");
  assert.equal(ICON_LIBRARY.version, "3.50.0");
  assert.equal(ICON_LIBRARY.license, "MIT");
});

test("3. keys are unique, well formed, and an alias is never a key but names one", () => {
  assert.equal(new Set(ICON_KEYS).size, ICON_KEYS.length);
  for (const key of ICON_KEYS) assert.match(key, KEY);
  for (const [alias, target] of Object.entries(ICON_ALIASES)) {
    assert.equal(ICON_KEYS.includes(alias), false, alias);
    assert.ok(ICON_KEYS.includes(target), target);
  }
});

test("4. every icon is geometry only: a key, a known category, words and path data", () => {
  const categories = new Set(ICON_CATEGORIES.map((c) => c.id));
  for (const icon of ICONS) {
    assert.deepEqual(Object.keys(icon).sort(), ["category", "key", "paths", "words"], icon.key);
    assert.ok(categories.has(icon.category), icon.key);
    assert.ok(icon.paths.length >= 1, icon.key);
    for (const d of icon.paths) {
      assert.equal(typeof d, "string");
      assert.match(d, PATH_DATA, icon.key);
      assert.ok(d.length <= 4000, icon.key);
    }
  }
  // Nothing in the generated file but the data: no markup, URL or script text.
  const text = readFileSync(path.join(root, "frontend", "icon-library.js"), "utf8");
  for (const forbidden of ["<", "http:", "https:", "javascript:", "on" + "load", "xlink", "href", "style="]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test("5. the Builder's former glyph codes are icons of the library (dumbbell through its alias)", () => {
  for (const key of ["target", "bolt", "calendar", "heart"]) assert.ok(isIconKey(key), key);
  assert.equal(ICON_ALIASES.dumbbell, "barbell");
});

test("6. isIconKey takes only a key: never an alias, a stored value, a prototype name or another type", () => {
  assert.equal(isIconKey("run"), true);
  for (const value of ["dumbbell", "icon:run", "RUN", " run", "run ", "constructor", "__proto__", "toString", "", null, undefined, 1, ["run"], { key: "run" }]) {
    assert.equal(isIconKey(value), false, String(value));
  }
});

test("7. the licence text sits beside the library", () => {
  const licence = readFileSync(path.join(root, "frontend", "icon-library-LICENSE.txt"), "utf8");
  assert.match(licence, /^MIT License/);
  assert.match(licence, /Copyright \(c\) 2020-2026 Paweł Kuna/);
});
