import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// perf/frontend-production-build: proves the Vite production build (see
// frontend/vite.config.js) actually succeeds and produces what
// backend/src/server.js expects to serve in production - without relying on
// a build having already been run by hand before this suite executes.
// Deliberately does NOT import vite.config.js or app.js - importing app.js
// runs its own init()/DOM wiring at import time (see other test files'
// comments on this) and is unrelated to what's under test here, which is
// the on-disk shape of the build OUTPUT.

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(frontendDir, "dist");
const distAssetsDir = path.join(distDir, "assets");

before(() => {
  // npm resolves to a .cmd shim on Windows, which node:child_process can
  // only execute through a shell - passing the whole invocation as one
  // fixed, argument-free string (rather than shell:true + a separate args
  // array) sidesteps Node's "unescaped args with shell:true" deprecation
  // warning, since there is nothing here to escape (no interpolated input).
  const result = spawnSync("npm run build", { cwd: frontendDir, shell: true, encoding: "utf8" });
  assert.equal(result.status, 0, `npm run build must exit 0 - stderr:\n${result.stderr}`);
});

test("1. production build succeeds and produces a dist directory", () => {
  assert.ok(existsSync(distDir), "frontend/dist must exist after npm run build");
  assert.ok(existsSync(distAssetsDir), "frontend/dist/assets must exist after npm run build");
});

test("2. every expected HTML entry point exists in dist", () => {
  // index.html covers /, /app, /invite, /join, /verify-email,
  // /forgot-password, /reset-password (see backend/src/server.js's route
  // table); athlete.html covers /athlete. Not "assume a single index.html" -
  // both real entries are checked.
  assert.ok(existsSync(path.join(distDir, "index.html")), "dist/index.html must exist");
  assert.ok(existsSync(path.join(distDir, "athlete.html")), "dist/athlete.html must exist");
});

function assetReferencesIn(html) {
  const refs = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) refs.add(m[1]);
  return [...refs];
}

test("3. index.html and athlete.html only reference hashed assets that actually exist on disk", () => {
  for (const entry of ["index.html", "athlete.html"]) {
    const html = readFileSync(path.join(distDir, entry), "utf8");
    const refs = assetReferencesIn(html);
    assert.ok(refs.length > 0, `${entry} must reference at least one built asset`);
    for (const ref of refs) {
      // A hashed Vite output filename always looks like name-<8char-hash>.ext -
      // a plain, unhashed filename here would mean the build silently fell
      // back to copying a source file verbatim instead of bundling it.
      assert.match(path.basename(ref), /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/, `${entry} asset reference must be hashed: ${ref}`);
      const onDisk = path.join(distDir, ref.replace(/^\//, ""));
      assert.ok(existsSync(onDisk), `${entry} references ${ref}, which must exist on disk at ${onDisk}`);
    }
  }
});

test("4. dist never references an un-hashed source .js module by its bare source filename", () => {
  // Every *.js file directly in frontend/ (excluding dist/ and tests/) is a
  // source module the bundler is supposed to have absorbed into the hashed
  // app-*.js chunk - if any of their bare filenames still show up literally
  // inside the built output, something escaped bundling (e.g. a stray
  // absolute path or a dynamic import the bundler couldn't resolve).
  const sourceJsNames = readdirSync(frontendDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("_ux-audit") && name !== "vite.config.js");

  const distFiles = [
    path.join(distDir, "index.html"),
    path.join(distDir, "athlete.html"),
    ...readdirSync(distAssetsDir).map((name) => path.join(distAssetsDir, name)),
  ];

  for (const distFile of distFiles) {
    const content = readFileSync(distFile, "utf8");
    for (const sourceName of sourceJsNames) {
      // A hashed chunk is allowed to contain the un-hashed name only as
      // part of ITS OWN hashed filename derivation (Vite names chunks after
      // their source, e.g. app-CB0IK9wT.js from app.js) - what must never
      // appear is the bare, standalone reference "./app.js" or "/app.js"
      // that a browser could actually try to fetch and 404 on.
      const bareReferencePattern = new RegExp(`["'(]\\.?/?${sourceName.replace(".", "\\.")}["')]`);
      assert.doesNotMatch(
        content,
        bareReferencePattern,
        `${path.basename(distFile)} must not reference un-hashed source file "${sourceName}" directly`,
      );
    }
  }
});

test("5. the built bundle contains no fixture secrets, API keys, or backend env var names", () => {
  const distFiles = [
    path.join(distDir, "index.html"),
    path.join(distDir, "athlete.html"),
    ...readdirSync(distAssetsDir).map((name) => path.join(distAssetsDir, name)),
  ];
  // Exact backend env var identifiers (backend/.env.example) - none of
  // these have any legitimate reason to appear in frontend output, since
  // api.js talks to the API via a same-origin relative path and no VITE_*
  // variable is defined anywhere in this repo.
  const secretNamePatterns = [
    /\bDATABASE_URL\b/,
    /\bGMAIL_APP_PASSWORD\b/,
    /\bGMAIL_USER\b/,
    /\bBREVO_API_KEY\b/,
    /\bRESEND_API_KEY\b/,
    /\bprocess\.env\b/,
    /\bimport\.meta\.env\b/,
    /postgresql:\/\//,
    // Known secret-shaped value formats (Brevo, OpenAI/Anthropic-style,
    // Google API keys) - a literal leaked value would match one of these
    // even if the variable name itself were renamed or minified away.
    /sk-[A-Za-z0-9]{20,}/,
    /xkeysib-[A-Za-z0-9]+/,
    /AIza[A-Za-z0-9_-]{20,}/,
  ];
  for (const distFile of distFiles) {
    const content = readFileSync(distFile, "utf8");
    for (const pattern of secretNamePatterns) {
      assert.doesNotMatch(content, pattern, `${path.basename(distFile)} must not contain ${pattern}`);
    }
  }
});

test("6. no source map is emitted in the production build", () => {
  const distFiles = [distDir, distAssetsDir].flatMap((dir) => readdirSync(dir));
  assert.ok(!distFiles.some((name) => name.endsWith(".map")), "no .map file may exist in dist - production source maps are disabled in vite.config.js");
});

test("7. JS and CSS assets are minified (no large blocks of readable indentation/comments)", () => {
  const jsFile = readdirSync(distAssetsDir).find((name) => name.endsWith(".js"));
  const cssFile = readdirSync(distAssetsDir).find((name) => name.endsWith(".css"));
  assert.ok(jsFile, "a built JS asset must exist");
  assert.ok(cssFile, "a built CSS asset must exist");
  const js = readFileSync(path.join(distAssetsDir, jsFile), "utf8");
  const css = readFileSync(path.join(distAssetsDir, cssFile), "utf8");
  // Minifiers collapse output onto very few, very long lines; unminified
  // source in this repo (see frontend/app.js, frontend/styles.css) always
  // wraps at human-readable widths - no source line in this repo is
  // anywhere near this long. Longest-line, not average, is the robust
  // signal: a minified bundle's few long statement/rule lines dominate,
  // while many short closing-brace lines would otherwise pull an average
  // down without saying anything about whether the CONTENT is minified.
  const jsMaxLineLength = Math.max(...js.split("\n").map((line) => line.length));
  const cssMaxLineLength = Math.max(...css.split("\n").map((line) => line.length));
  assert.ok(jsMaxLineLength > 5000, `built JS should be minified (very long dense lines), got max line length ${jsMaxLineLength}`);
  assert.ok(cssMaxLineLength > 5000, `built CSS should be minified (very long dense lines), got max line length ${cssMaxLineLength}`);
});
