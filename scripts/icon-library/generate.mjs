// Writes OptiMove's built-in icon library (Data configuration visual polish,
// PR-1; docs/ai/data-configuration-visual-proposal.md section 3.1) from a
// pinned copy of Tabler Icons. A manually run maintenance step, never part of
// a build or a test: the library is vendored as data, with no runtime
// dependency.
//
//   npm pack @tabler/icons@3.50.0          (in an empty folder outside the repo)
//   tar -xzf tabler-icons-3.50.0.tgz       (gives ./package)
//   node scripts/icon-library/generate.mjs --package <that folder>/package
//   node scripts/icon-library/generate.mjs --package <...>/package --check
//
// It reads only the package's package.json (the name and the version must be
// the manifest's) and tabler-nodes-outline.json (each icon as a list of
// [tag, attributes]). Only the icons named in manifest.json are taken, and of
// each only <path> elements with a `d` attribute of path-data characters: any
// other element, attribute or character stops the run, so no script, link,
// style or event attribute can come in with an icon. It writes:
//   frontend/icon-library.js   the icons (key, category, search words, paths);
//   backend/src/iconKeys.js    the same keys, for the server's check;
// --check writes nothing and fails when either file differs from what the
// package and the manifest give. The licence text is
// frontend/icon-library-LICENSE.txt (Tabler Icons, MIT).
//
// A key, once released, is never removed or renamed: stored values
// (`icon:<key>`) name it, and the server takes only a key of the current list.
// An icon may be redrawn, and new icons may be added.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MANIFEST = path.join(repoRoot, "scripts", "icon-library", "manifest.json");
const FRONTEND_OUT = path.join(repoRoot, "frontend", "icon-library.js");
const BACKEND_OUT = path.join(repoRoot, "backend", "src", "iconKeys.js");

const KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KEY_MAX = 40;
const CATEGORY_ID = /^[a-z]+$/;
const LABEL = /^[A-Za-z][A-Za-z ]{0,39}$/;
const WORD = /^[a-z0-9][a-z0-9 /-]{0,29}$/;
const SOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Path data: the commands, digits, signs, dots, commas and spaces only.
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\- ]+$/;
const PATH_MAX = 4000;

function fail(message) {
  console.error(`icon-library: ${message}`);
  process.exit(1);
}

function args(argv) {
  const out = { package: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--package") out.package = argv[++i];
    else if (argv[i] === "--check") out.check = true;
    else fail(`unknown argument ${argv[i]}`);
  }
  if (!out.package) fail("--package <folder of the unpacked @tabler/icons package> is required");
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function checkManifest(manifest) {
  const categories = manifest.categories;
  if (!Array.isArray(categories) || !categories.length) fail("manifest: no categories");
  const categoryIds = new Set();
  for (const c of categories) {
    if (!CATEGORY_ID.test(c.id) || !LABEL.test(c.label) || categoryIds.has(c.id)) fail(`manifest: bad category ${JSON.stringify(c)}`);
    categoryIds.add(c.id);
  }
  const keys = new Set();
  for (const icon of manifest.icons) {
    if (!KEY.test(icon.key) || icon.key.length > KEY_MAX) fail(`manifest: bad key ${JSON.stringify(icon.key)}`);
    if (keys.has(icon.key)) fail(`manifest: key ${icon.key} twice`);
    keys.add(icon.key);
    if (!SOURCE_NAME.test(icon.source)) fail(`manifest: bad source name for ${icon.key}`);
    if (!categoryIds.has(icon.category)) fail(`manifest: unknown category for ${icon.key}`);
    if (!Array.isArray(icon.words) || !icon.words.length || icon.words.length > 6 || !icon.words.every((w) => WORD.test(w))) {
      fail(`manifest: bad search words for ${icon.key}`);
    }
  }
  for (const [alias, target] of Object.entries(manifest.aliases || {})) {
    if (!KEY.test(alias) || alias.length > KEY_MAX || keys.has(alias)) fail(`manifest: bad alias ${alias}`);
    if (!keys.has(target)) fail(`manifest: alias ${alias} names no icon`);
  }
  return keys;
}

function pathsOf(nodes, name) {
  if (!Array.isArray(nodes) || !nodes.length) fail(`package: no icon ${name}`);
  return nodes.map((node) => {
    if (!Array.isArray(node) || node.length !== 2 || node[0] !== "path") fail(`package: ${name} has an element other than <path>`);
    const attrs = node[1];
    const names = Object.keys(attrs || {});
    if (names.length !== 1 || names[0] !== "d") fail(`package: ${name} has an attribute other than d`);
    const d = attrs.d;
    if (typeof d !== "string" || !d.length || d.length > PATH_MAX || !PATH_DATA.test(d)) fail(`package: ${name} has path data outside the allowed characters`);
    return d;
  });
}

const HEADER = (source) => `// GENERATED by scripts/icon-library/generate.mjs from ${source.package} ${source.version}
// (${source.license}; the licence text is frontend/icon-library-LICENSE.txt). Do not edit by hand:
// change scripts/icon-library/manifest.json and run the generator again.`;

function frontendText(manifest, icons) {
  const lines = [
    HEADER(manifest.source),
    `// Each icon is a key, a category, its search words and the \`d\` of its paths`,
    `// (24 x 24, drawn as strokes). The renderer is frontend/icon-render.js.`,
    `export const ICON_LIBRARY = Object.freeze(${JSON.stringify({ package: manifest.source.package, version: manifest.source.version, license: manifest.source.license })});`,
    `export const ICON_CATEGORIES = Object.freeze([`,
    ...manifest.categories.map((c) => `  Object.freeze(${JSON.stringify({ id: c.id, label: c.label })}),`),
    `]);`,
    `export const ICONS = Object.freeze([`,
    ...icons.map((icon) => `  Object.freeze({ key: ${JSON.stringify(icon.key)}, category: ${JSON.stringify(icon.category)}, words: Object.freeze(${JSON.stringify(icon.words)}), paths: Object.freeze(${JSON.stringify(icon.paths)}) }),`),
    `]);`,
    `// Older stored names that draw an icon of the library (the Builder's former glyph codes).`,
    `export const ICON_ALIASES = Object.freeze(${JSON.stringify(manifest.aliases || {})});`,
    ``,
  ];
  return lines.join("\n");
}

function backendText(manifest, icons) {
  const lines = [
    HEADER(manifest.source),
    `// The keys of frontend/icon-library.js, for the server's check of an icon a`,
    `// request names (a test proves the two lists agree). An alias is never taken`,
    `// from a request: a stored icon is always one of these keys.`,
    `export const ICON_KEYS = Object.freeze([`,
    ...icons.map((icon) => `  ${JSON.stringify(icon.key)},`),
    `]);`,
    `const KEYS = new Set(ICON_KEYS);`,
    `export const isIconKey = (value) => typeof value === "string" && KEYS.has(value);`,
    ``,
  ];
  return lines.join("\n");
}

const options = args(process.argv.slice(2));
const manifest = readJson(MANIFEST);
checkManifest(manifest);
const pkg = readJson(path.join(options.package, "package.json"));
if (pkg.name !== manifest.source.package || pkg.version !== manifest.source.version) {
  fail(`package is ${pkg.name}@${pkg.version}, the manifest pins ${manifest.source.package}@${manifest.source.version}`);
}
const nodes = readJson(path.join(options.package, "tabler-nodes-outline.json"));
const icons = manifest.icons.map((icon) => ({
  key: icon.key,
  category: icon.category,
  words: icon.words,
  paths: pathsOf(Object.prototype.hasOwnProperty.call(nodes, icon.source) ? nodes[icon.source] : null, icon.source),
}));
const outputs = [[FRONTEND_OUT, frontendText(manifest, icons)], [BACKEND_OUT, backendText(manifest, icons)]];
if (options.check) {
  const stale = outputs.filter(([file, text]) => {
    try {
      return readFileSync(file, "utf8") !== text;
    } catch {
      return true;
    }
  });
  if (stale.length) fail(`out of date: ${stale.map(([file]) => path.relative(repoRoot, file)).join(", ")}`);
  console.log(`icon-library: ${icons.length} icons, both files up to date`);
} else {
  for (const [file, text] of outputs) writeFileSync(file, text, "utf8");
  console.log(`icon-library: wrote ${icons.length} icons to ${outputs.map(([file]) => path.relative(repoRoot, file)).join(" and ")}`);
}
