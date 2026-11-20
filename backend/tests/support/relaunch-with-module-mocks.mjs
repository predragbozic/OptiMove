// A test file that needs node:test's module mocks runs itself again in a child process with
// `--experimental-test-module-mocks` and test isolation off. This helper is that child run, in
// one place:
// - the isolation flag is the one THIS node accepts (`--test-isolation=none` on newer Node,
//   `--experimental-test-isolation=none` on Node 22, which rejects the other with exit 9);
// - a child that never reaches a test result (a bad option, a missing export at import time)
//   FAILS the wrapper test, with the child's output; it can never count as a pass;
// - the first line of a failure names the inner tests that failed, so a known failure can be
//   listed by its real title in tests/support/test-manifest.json.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const MODULE_MOCKS_FLAG = "--experimental-test-module-mocks";

// true in the parent run (no module mocks yet): the file should call relaunchWithModuleMocks
export function needsModuleMocksRelaunch() {
  return !process.execArgv.includes(MODULE_MOCKS_FLAG);
}

let isolationFlag = null;
export function testIsolationNoneFlag() {
  if (isolationFlag) return isolationFlag;
  for (const flag of ["--test-isolation=none", "--experimental-test-isolation=none"]) {
    const probe = spawnSync(process.execPath, [flag, "-e", "0"], { stdio: "ignore", windowsHide: true });
    if (probe.status === 0) return (isolationFlag = flag);
  }
  throw new Error(`node ${process.version} accepts neither --test-isolation=none nor --experimental-test-isolation=none`);
}

// Node's TAP reporter escapes a name: `\` -> `\\`, `#` -> `\#`, and \n \t \r \b \f \v. A Windows
// path therefore arrives with doubled backslashes; names are compared only after unescaping.
export function tapUnescape(s) {
  return s.replace(/\\(.)/g, (m, c) => ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" })[c] ?? c);
}

// Every result line of TAP output: its indent, ok / not ok, the unescaped name, and the directive
// (`# SKIP`, `# TODO`), which starts at the first ` #` that is not escaped.
export function parseTapResults(tap) {
  const out = [];
  for (const line of String(tap ?? "").split(/\r?\n/)) {
    const m = /^(\s*)(not ok|ok) \d+(?: - (.*))?$/.exec(line);
    if (!m) continue;
    const rest = m[3] ?? "";
    const d = /^((?:[^\\#]|\\.)*?)\s+#\s*(.*)$/.exec(rest);
    out.push({ indent: m[1].length, ok: m[2] === "ok", name: tapUnescape((d ? d[1] : rest).trim()), directive: (d ? d[2] : "").trim() });
  }
  // a parent (a suite, or a test with subtests) is printed after its children, one level deeper
  for (let i = 0; i < out.length; i++) {
    out[i].leaf = !(i > 0 && out[i - 1].indent > out[i].indent);
  }
  return out;
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const skipped = (r) => /^(SKIP|TODO)\b/i.test(r.directive);

// The tests that really ran: leaf results, not skipped or todo, and not the one placeholder
// result node adds, named by the file's own path, when isolation is off and the file defines no test.
export function countRanTests(tap, file) {
  return parseTapResults(tap).filter((r) => r.leaf && !skipped(r) && !samePath(r.name, file)).length;
}

// The titles of the failing inner tests: leaf failures only (a suite whose subtests failed is not
// repeated), a todo is not a failure.
export function failedInnerTests(tap) {
  const failed = [];
  for (const r of parseTapResults(tap)) {
    if (!r.ok && r.leaf && !/^TODO\b/i.test(r.directive) && !failed.includes(r.name)) failed.push(r.name);
  }
  return failed;
}

// Runs the file at `importMetaUrl` again with module mocks and asserts that its inner suite ran
// at least one test and every test passed.
export function relaunchWithModuleMocks(importMetaUrl, { env = process.env, timeoutMs = 240_000 } = {}) {
  const file = fileURLToPath(importMetaUrl);
  // Inside a `node --test` run the parent sets NODE_TEST_CONTEXT; a child that inherits it
  // reports over node's internal binary channel instead of TAP, and its results could not be
  // read here. The child is a test run of its own.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  // the child's own per-test limit ends a hung test before this call gives up, so the failure
  // names it (this parent is blocked in spawnSync and its own limits cannot fire)
  const perTest = Math.max(1000, timeoutMs - 10_000);
  const child = spawnSync(process.execPath, [MODULE_MOCKS_FLAG, "--test", testIsolationNoneFlag(), "--test-reporter=tap", `--test-timeout=${perTest}`, file], {
    encoding: "utf8", env: childEnv, timeout: timeoutMs, windowsHide: true,
  });
  const stdout = child.stdout ?? "";
  const output = `${stdout}${child.stderr ?? ""}`;
  if (child.error) {
    const failed = failedInnerTests(stdout);
    assert.fail(`inner suite did not finish (${child.error.code ?? child.error.message}): ${failed.length ? failed.join(" | ") : "no test named"}\n${output}`);
  }
  if (countRanTests(stdout, file) === 0) {
    const all = parseTapResults(stdout).filter((r) => r.leaf && !samePath(r.name, file));
    const cause = all.length && all.every(skipped) ? "every test is skipped or todo" : (child.stderr ?? "").trim().split(/\r?\n/).find(Boolean) ?? "the file defined no test";
    assert.fail(`inner suite ran no test (exit ${child.status ?? child.signal}): ${cause}\n${output}`);
  }
  if (child.status !== 0) {
    const failed = failedInnerTests(stdout);
    assert.fail(`inner suite failed (exit ${child.status ?? child.signal}): ${failed.length ? failed.join(" | ") : "no failing test named"}\n${output}`);
  }
}
