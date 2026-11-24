// React islands: the committed react-build/ (what dev, e2e and the tests load, and what the production build bundles)
// must be exactly a fresh build of react/*.jsx with vite.islands.config.js. Edit the .jsx, run
// `npm --prefix frontend run build:islands`, commit both - otherwise this fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { isAppModule } from "../vite.islands.config.js";

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committedDir = path.join(frontendDir, "react-build");

test("react-build/ is a fresh build of react/*.jsx, byte for byte", async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "optimove-islands-"));
  try {
    await build({ configFile: path.join(frontendDir, "vite.islands.config.js"), logLevel: "silent", build: { outDir, emptyOutDir: true } });
    const fresh = readdirSync(outDir).sort();
    assert.deepEqual(readdirSync(committedDir).sort(), fresh, "the same files");
    for (const name of fresh) {
      assert.ok(readFileSync(path.join(committedDir, name)).equals(readFileSync(path.join(outDir, name))), `react-build/${name} is out of date: run npm --prefix frontend run build:islands`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("react-build is byte-exact on every checkout: no line-ending conversion, no CR in it", () => {
  const repoRoot = path.resolve(frontendDir, "..");
  const out = execFileSync("git", ["check-attr", "text", "--", "frontend/react-build/react.js", "frontend/react-build/islands.js"], { cwd: repoRoot, encoding: "utf8" });
  assert.match(out, /react\.js: text: unset/);
  assert.match(out, /islands\.js: text: unset/);
  for (const name of ["react.js", "islands.js"]) assert.equal(readFileSync(path.join(committedDir, name), "utf8").includes("\r"), false, name);
});

test("the islands import the app's own modules (one state, one api, one session), never a bundled copy", () => {
  const islands = readFileSync(path.join(committedDir, "islands.js"), "utf8");
  assert.match(islands, /from"\.\.\/app-errors-capture\.js"/);
  assert.doesNotMatch(islands, /function reportHandlerError/);
  // React is bundled for the browser: production mode, no Node require or env left in it.
  const react = readFileSync(path.join(committedDir, "react.js"), "utf8");
  for (const file of [islands, react]) {
    assert.doesNotMatch(file, /process\.env/);
    assert.doesNotMatch(file, /\brequire\(/);
  }
});

test("only an island's own relative import outside react/ stays external; React's files and the island's own are bundled", () => {
  const island = path.join(frontendDir, "react", "bottom-nav.jsx");
  assert.equal(isAppModule("../api.js", island), true);
  assert.equal(isAppModule("../state.js", island), true);
  assert.equal(isAppModule("./mount.jsx", island), false);
  assert.equal(isAppModule("react", island), false);
  assert.equal(isAppModule("./cjs/react.production.js", path.join(frontendDir, "node_modules", "react", "index.js")), false);
});
