// The fake GPEXE source reaches the server only through the e2e harness: `node --import e2e/lib/fake-source-preload.mjs`
// set in NODE_OPTIONS of the child process that e2e/lib/world.mjs spawns, and only when a test asks for a fake source.
// Nothing in the application, its start scripts or its configuration can load it. This file is the proof (a static
// read of every tracked file; no database is opened).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const text = (f) => { try { return fs.readFileSync(path.join(root, f), "utf8"); } catch { return ""; } };
const outsideE2e = tracked.filter((f) => !f.startsWith("e2e/") && !f.startsWith(".git"));
const code = outsideE2e.filter((f) => /\.(mjs|cjs|js|json|ya?ml|toml|sh|env|example)$/.test(f) || /(^|\/)Dockerfile$/.test(f));

test("1. no tracked file outside e2e/ names the preload or its environment key (only docs may describe it)", () => {
  for (const f of code) {
    const t = text(f);
    assert.ok(!/fake-source-preload|E2E_FAKE_VISIBLE_TEAMS|createFakeSource\(\)\.fetchImpl.*globalThis\.fetch/.test(t), `${f} must not reference the e2e preload`);
  }
});

test("2. the production start scripts load no preload: no --import, --require, NODE_OPTIONS or e2e in `start` or `dev`", () => {
  for (const file of ["package.json", "backend/package.json"]) {
    const scripts = JSON.parse(text(file)).scripts || {};
    for (const name of ["start", "dev", "build"]) {
      const cmd = scripts[name] || "";
      assert.ok(!/--import|--require|-r\s|NODE_OPTIONS|e2e/.test(cmd), `${file} script "${name}" must not load a preload (${cmd})`);
    }
  }
});

test("3. the application's own code never reads NODE_OPTIONS or imports a module named by an environment variable", () => {
  for (const f of code.filter((x) => /^backend\/src\//.test(x))) {
    const t = text(f);
    assert.ok(!/process\.env\.NODE_OPTIONS|process\.env\.E2E_/.test(t), `${f} must not read NODE_OPTIONS or an E2E_ key`);
    assert.ok(!/import\(\s*process\.env/.test(t), `${f} must not import a path from the environment`);
  }
});

test("4. inside e2e/, only world.mjs references the preload, and only behind the `fakeSource` option", () => {
  const holders = tracked.filter((f) => f.startsWith("e2e/") && f !== "e2e/tests/preload-isolation.test.mjs" && /fake-source-preload/.test(text(f)));
  assert.deepEqual(holders.sort(), ["e2e/lib/world.mjs"]);
  const world = text("e2e/lib/world.mjs");
  assert.match(world, /if \(fakeSource\) \{[\s\S]*?fake-source-preload\.mjs/, "the --import is set only when a test asks for a fake source");
  assert.match(world, /spawn\(process\.execPath, \["src\/server\.js"\]/, "the server is started as a child process of the harness");
});

test("5. the preload answers one approved host only; every other request goes where it would have gone", () => {
  const preload = text("e2e/lib/fake-source-preload.mjs");
  assert.match(preload, /startsWith\("https:\/\/server3\.gpexe\.com\/"\) \? fake\.fetchImpl\(url, init\) : realFetch\(url, init\)/);
});
