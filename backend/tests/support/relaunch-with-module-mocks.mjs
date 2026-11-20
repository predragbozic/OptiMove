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

// The titles of the failing inner tests, from the child's TAP output (leaf failures only: a
// suite whose subtests failed is not repeated).
export function failedInnerTests(tapOutput) {
  const failed = [];
  for (const line of tapOutput.split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.+?)\s*(#.*)?$/.exec(line);
    if (m && !failed.includes(m[1])) failed.push(m[1]);
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
  const child = spawnSync(process.execPath, [MODULE_MOCKS_FLAG, "--test", testIsolationNoneFlag(), "--test-reporter=tap", file], {
    encoding: "utf8", env: childEnv, timeout: timeoutMs, windowsHide: true,
  });
  assert.ifError(child.error);
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  // With isolation off, a file that defines no test (or never gets to define one) is reported
  // as ONE result named by the file's own path; that is not a test of the suite.
  const topLevel = [...(child.stdout ?? "").matchAll(/^(?:not )?ok \d+ - (.+?)\s*(?:#.*)?$/gm)].map((m) => m[1]);
  const ran = topLevel.filter((name) => name !== file).length;
  if (ran === 0) {
    const cause = (child.stderr ?? "").trim().split(/\r?\n/).find(Boolean) ?? "the file defined no test";
    assert.fail(`inner suite ran no test (exit ${child.status ?? child.signal}): ${cause}\n${output}`);
  }
  if (child.status !== 0) {
    const failed = failedInnerTests(child.stdout ?? "");
    assert.fail(`inner suite failed (exit ${child.status ?? child.signal}): ${failed.length ? failed.join(" | ") : "no failing test named"}\n${output}`);
  }
}
