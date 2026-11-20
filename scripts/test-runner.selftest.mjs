#!/usr/bin/env node
// Self-test of scripts/test-runner.mjs: builds a throwaway project with one
// test file per outcome the runner must tell apart, runs the runner on it
// with a short time limit, and checks every verdict, that a stuck file's
// grandchild process is gone afterwards, that the kept logs exist, and that
// an unsafe DATABASE_URL is refused before anything runs. No database is
// opened. Runs in a few seconds:
//
//   node scripts/test-runner.selftest.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "test-runner.mjs");
const REPO_ROOT = path.resolve(HERE, "..");
const DOTENV_CONFIG_URL = pathToFileURL(path.join(REPO_ROOT, "backend", "node_modules", "dotenv", "config.js")).href;
const CANARY_DB_URL = "postgresql://nobody:canary-password-7f3a@db.example.com:5432/production";
const CANARY_TOKEN = "canary-token-must-not-leak-9c1d";

const FILES = {
  "a-pass.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("one passes", () => { assert.equal(1, 1); });
test("two passes", async () => { await new Promise((r) => setTimeout(r, 20)); });
`,
  "b-fail.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("ok one", () => {});
test("broken one", () => { assert.equal(1, 2); });
test("broken two (known)", () => { assert.equal(2, 3); });
`,
  "c-known-fail.test.mjs": `import { test, describe } from "node:test";
import assert from "node:assert/strict";
test("fine", () => {});
describe("group", () => {
  test("nested known failure", () => { assert.equal(1, 0); });
});
`,
  "d-noexit.test.mjs": `import { test } from "node:test";
test("passes then leaves a timer", () => {});
setInterval(() => {}, 1000);
`,
  "e-stuck.test.mjs": `import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
test("never finishes and keeps a grandchild alive", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.SELFTEST_GRANDCHILD_PID_FILE, String(child.pid));
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`,
  "f-crash.test.mjs": `import { test } from "node:test";
import "./does-not-exist.mjs";
test("never runs", () => {});
`,
  "g-unexpected-pass.test.mjs": `import { test } from "node:test";
test("listed as a known failure but passes", () => {});
`,
  "h-noexit-known.test.mjs": `import { test } from "node:test";
test("passes then leaves a timer, listed as known", () => {});
setInterval(() => {}, 1000);
`,
  "i-slow-after-hook.test.mjs": `import { test, after } from "node:test";
test("passes quickly", () => {});
after(async () => { await new Promise((r) => setTimeout(r, 2500)); });
`,
  "k-hang-known.test.mjs": `import { test, after } from "node:test";
import fs from "node:fs";
after(() => { fs.writeFileSync(process.env.SELFTEST_AFTER_MARK_FILE, "after() ran"); });
test("fine before the hang", () => {});
test("hangs forever (known, ended by the runner's per-test limit)", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
test("never runs: the runner ended the file", () => {});
`,
  "s-hang-file-limit.test.mjs": `import { test } from "node:test";
test("hangs past the file limit", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`,
  "l-partial-xpass.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("listed and now passes", () => {});
test("listed and still fails", () => { assert.equal(1, 2); });
`,
  "m-burst-then-fail.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("prints a large burst then fails as the last thing the process does", () => {
  process.stdout.write("x".repeat(4 * 1024 * 1024) + "\\n");
  assert.fail("late");
});
`,
  "o-fp-match.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("fails with the expected cause", () => { assert.equal(1, 2); });
`,
  "p-fp-type.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("fails with another failure type than listed", () => { assert.equal(1, 2); });
`,
  "q-fp-message.test.mjs": `import { test } from "node:test";
test("fails with another message than listed", () => { throw new Error("a different reason"); });
`,
  "r-fp-timeout-now-assert.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("a known timeout that now fails an assertion", () => { assert.fail("now an assertion"); });
`,
  "j-no-env.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
test("a unit file never sees a database target or a credential", () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GPEXE_API_TOKEN, undefined);
  assert.equal(process.env.SOURCE_CREDENTIAL_KEYS, undefined);
  assert.equal(process.env.GITHUB_TOKEN, undefined, "anything named like a secret is scrubbed");
  assert.equal(process.env.MY_SERVICE_API_KEY, undefined);
  assert.equal(process.env.OPTIMOVE_TEST_RUNNER, "1");
  assert.equal(process.env.OPTIMOVE_TEST_KIND, "unit");
});
`,
  "n-dotenv.test.mjs": `import { test } from "node:test";
import assert from "node:assert/strict";
import ${JSON.stringify(DOTENV_CONFIG_URL)};
test("a .env next to the test file never reaches the process: dotenv is pointed at the runner's empty file", () => {
  assert.equal(process.env.DATABASE_URL, undefined);
  assert.equal(process.env.GPEXE_API_TOKEN, undefined);
  assert.equal(process.env.PLANTED_IN_DOTENV, undefined);
});
`,
};
const DOTENV_CANARY = `DATABASE_URL=${CANARY_DB_URL}\nGPEXE_API_TOKEN=${CANARY_TOKEN}\nPLANTED_IN_DOTENV=yes\n`;

const STRICT_EQUAL = "^Expected values to be strictly equal:";
const TIMEOUT = "^test timed out after \\d+ms$";
const MANIFEST = {
  kindOverrides: {},
  knownFailures: [
    { file: "b-fail.test.mjs", test: "broken two (known)", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "c-known-fail.test.mjs", test: "nested known failure", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "g-unexpected-pass.test.mjs", test: "listed as a known failure but passes", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "k-hang-known.test.mjs", test: "hangs forever (known, ended by the runner's per-test limit)", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
    { file: "l-partial-xpass.test.mjs", test: "listed and now passes", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "l-partial-xpass.test.mjs", test: "listed and still fails", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "o-fp-match.test.mjs", test: "fails with the expected cause", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "p-fp-type.test.mjs", test: "fails with another failure type than listed", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
    { file: "q-fp-message.test.mjs", test: "fails with another message than listed", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "r-fp-timeout-now-assert.test.mjs", test: "a known timeout that now fails an assertion", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
  ],
  fileOptions: { "k-hang-known.test.mjs": { testTimeoutMs: 1500, note: "self-test" }, "e-stuck.test.mjs": { testTimeoutMs: 1500, note: "self-test" } },
  knownNoExit: [{ file: "h-noexit-known.test.mjs", idleMs: 1500, note: "self-test" }],
};

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-"));
  const tests = path.join(root, "tests", "support");
  fs.mkdirSync(tests, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, "tests", name), content);
  fs.writeFileSync(path.join(tests, "test-manifest.json"), JSON.stringify(MANIFEST, null, 2));
  // The project dir is each test process's cwd: a .env there is what
  // `import "dotenv/config"` would load if the runner did not redirect it.
  fs.writeFileSync(path.join(root, ".env"), DOTENV_CANARY);
  return root;
}

function runRunner(args, env = {}) {
  // The shell's own database settings never reach the checks below, so a
  // workstation's exported DATABASE_URL (or a stale OPTIMOVE_TEST_SHARED_DB,
  // which the runner no longer honours) cannot make a refusal check fail for
  // an environment reason.
  const base = { ...process.env };
  for (const key of ["DATABASE_URL", "OPTIMOVE_TEST_SHARED_DB", "LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL", "TEST_DATABASE_ADMIN_URL"]) delete base[key];
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: REPO_ROOT, encoding: "utf8", env: { ...base, ...env }, maxBuffer: 16 * 1024 * 1024 });
}

function processAlive(pid) {
  if (process.platform === "win32") {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout || "";
    return new RegExp(`\\b${pid}\\b`).test(out);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Imported (not run) for the rule cross-check below; importing the runner
// does not start it.
const runnerModule = await import(pathToFileURL(RUNNER).href);
const supportModule = await import(pathToFileURL(path.join(REPO_ROOT, "backend", "tests", "support", "disposable-db.mjs")).href);

// Does this node apply --test-timeout to a file started directly (the way the runner starts
// one)? node 22.23 does not: the runner's own per-test limit then ends the file. A node that
// does cancels the test itself first and the file runs on. The hang checks assert the branch
// that matches the node they run on.
function nodeAppliesTestTimeout() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-probe-"));
  try {
    const file = path.join(dir, "probe.test.mjs");
    fs.writeFileSync(file, 'import { test } from "node:test";\ntest("probe", async () => { const t = setInterval(() => {}, 1000); await new Promise(() => {}); });\n');
    const r = spawnSync(process.execPath, ["--test-timeout=300", file], { encoding: "utf8", timeout: 5_000 });
    return !r.error && /test timed out after 300ms/.test(`${r.stdout}${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const NODE_APPLIES_TEST_TIMEOUT = nodeAppliesTestTimeout();

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}

const project = makeProject();
const pidFile = path.join(project, "grandchild.pid");
const afterMarkFile = path.join(project, "after-ran.mark");
const reportPath = path.join(project, "report.json");
const logDir = path.join(project, "logs");
try {
  const started = Date.now();
  const run = runRunner(
    ["--project", "frontend", "--project-dir", project, "--timeout-ms", "5000", "--json", reportPath, "--log-dir", logDir, "--quiet"],
    { SELFTEST_GRANDCHILD_PID_FILE: pidFile, SELFTEST_AFTER_MARK_FILE: afterMarkFile, DATABASE_URL: CANARY_DB_URL, GPEXE_API_TOKEN: CANARY_TOKEN, SOURCE_CREDENTIAL_KEYS: `1:${CANARY_TOKEN}`, GITHUB_TOKEN: CANARY_TOKEN, MY_SERVICE_API_KEY: CANARY_TOKEN },
  );
  const elapsed = Date.now() - started;
  check("the runner reports a failed run (exit 1) for a project with failing files", () => assert.equal(run.status, 1, run.stderr));
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const byFile = Object.fromEntries(report.steps.flatMap((s) => s.results).map((r) => [r.file, r]));
  const expect = (file, fields) => {
    const r = byFile[file];
    assert.ok(r, `${file} missing from the report`);
    for (const [k, v] of Object.entries(fields)) assert.deepEqual(r[k], v, `${file}.${k}`);
  };
  check("a passing file is pass / ok with exact counts", () => expect("a-pass.test.mjs", { status: "pass", ok: true, tests: 2, pass: 2, fail: 0, noExit: false }));
  check("a file with an unlisted failure is fail / not ok and names the failing test only", () => expect("b-fail.test.mjs", { status: "fail", ok: false, unknownFailures: ["broken one"], knownFailuresSeen: ["broken two (known)"] }));
  check("a file whose only failures are listed is known-fail / ok, nested describe included", () => expect("c-known-fail.test.mjs", { status: "xfail", ok: true, unknownFailures: [] }));
  check("a file that finished its tests but never exited is did-not-exit / not ok", () => expect("d-noexit.test.mjs", { status: "pass", ok: false, noExit: true, noExitKnown: false, pass: 1 }));
  if (!NODE_APPLIES_TEST_TIMEOUT) {
    check("[node ignores --test-timeout for a direct file] a test that really hangs (a live timer) is ended by the runner's own per-test limit and named; the file is a timeout, never ok, even when the test is listed", () => {
      const name = "hangs forever (known, ended by the runner's per-test limit)";
      expect("k-hang-known.test.mjs", { status: "timeout", ok: false, noExit: false, timedOut: false, pass: 1, running: [name] });
      const r = byFile["k-hang-known.test.mjs"];
      assert.equal(r.testTimeout?.name, name);
      assert.equal(r.testTimeout.afterMs, 2250, "per-test limit 1500 ms plus half of it");
      assert.ok(r.durationMs < 4500, `ended well before the file limit (${r.durationMs} ms)`);
    });
    check("[node ignores --test-timeout for a direct file] the tests and the after() hook behind a hang the runner ended do not run, and the report says so", () => {
      assert.equal(fs.existsSync(afterMarkFile), false, "after() ran although the process was ended");
      assert.match(run.stdout + run.stderr, /test timeout: hangs forever \(known, ended by the runner's per-test limit\).*the tests after it did not run/);
    });
    check("[node ignores --test-timeout for a direct file] a stuck test that keeps a grandchild alive is ended by the per-test limit, named, and the whole tree goes", () => {
      expect("e-stuck.test.mjs", { status: "timeout", ok: false, timedOut: false, running: ["never finishes and keeps a grandchild alive"] });
      assert.equal(byFile["e-stuck.test.mjs"].testTimeout?.name, "never finishes and keeps a grandchild alive");
    });
    check("[node ignores --test-timeout for a direct file] a hang longer than the file limit (the per-test limit not reached) is still ended at the file limit and named", () => {
      expect("s-hang-file-limit.test.mjs", { status: "timeout", ok: false, timedOut: true, testTimeout: null, running: ["hangs past the file limit"] });
    });
  } else {
    // Not run on node 22.23 (the node this was written on); the expectations follow node's
    // documented behaviour: node cancels the test with testTimeoutFailure and the file goes on.
    check("[node applies --test-timeout] node cancels the hung test first, the runner's limit does not fire, the file runs on and its after() runs", () => {
      expect("k-hang-known.test.mjs", { status: "xfail", ok: true, timedOut: false, testTimeout: null, knownFailuresSeen: ["hangs forever (known, ended by the runner's per-test limit)"] });
      assert.equal(byFile["k-hang-known.test.mjs"].failureDetails[0].failureType, "testTimeoutFailure");
      assert.equal(fs.existsSync(afterMarkFile), true, "after() did not run");
    });
    check("[node applies --test-timeout] a cancelled stuck test whose timer and grandchild stay alive is a failure, ended at the file limit", () => {
      expect("e-stuck.test.mjs", { status: "fail", ok: false, timedOut: true, testTimeout: null, unknownFailures: ["never finishes and keeps a grandchild alive"] });
    });
    check("[node applies --test-timeout] a hang whose timer stays alive after node cancelled it is ended at the file limit", () => {
      expect("s-hang-file-limit.test.mjs", { ok: false, timedOut: true, testTimeout: null });
    });
  }
  check("a file that cannot even load is crash / not ok", () => expect("f-crash.test.mjs", { status: "crash", ok: false }));
  check("a listed failure that passes is reported as an unexpected pass (ok, with a warning)", () => expect("g-unexpected-pass.test.mjs", { status: "pass", ok: true, unexpectedPass: true, unexpectedPasses: ["listed as a known failure but passes"] }));
  check("a listed failure that passes is reported title by title even while another listed failure in the same file still fails", () => expect("l-partial-xpass.test.mjs", { status: "xfail", ok: true, unexpectedPass: true, unexpectedPasses: ["listed and now passes"], knownFailuresSeen: ["listed and still fails"] }));
  check("fingerprint: the same title with the expected failureType and message is known-fail", () => expect("o-fp-match.test.mjs", { status: "xfail", ok: true, unknownFailures: [], knownFailuresSeen: ["fails with the expected cause"] }));
  check("fingerprint: the same title with another failureType is a new failure", () => {
    expect("p-fp-type.test.mjs", { status: "fail", ok: false, unknownFailures: ["fails with another failure type than listed"], knownFailuresSeen: [] });
    assert.deepEqual(byFile["p-fp-type.test.mjs"].failureDetails[0].listedButDifferent, [`testTimeoutFailure /${TIMEOUT}/`]);
  });
  check("fingerprint: the same title with another message is a new failure", () => expect("q-fp-message.test.mjs", { status: "fail", ok: false, unknownFailures: ["fails with another message than listed"], knownFailuresSeen: [] }));
  check("fingerprint: a known timeout that turns into an assertion failure is a new failure", () => {
    expect("r-fp-timeout-now-assert.test.mjs", { status: "fail", ok: false, unknownFailures: ["a known timeout that now fails an assertion"], knownFailuresSeen: [] });
    assert.equal(byFile["r-fp-timeout-now-assert.test.mjs"].failureDetails[0].failureType, "testCodeFailure");
  });
  check("a file that prints a large burst and fails as its last act is still reported as fail with its summary seen", () => expect("m-burst-then-fail.test.mjs", { status: "fail", ok: false, unknownFailures: ["prints a large burst then fails as the last thing the process does"], summarySeen: true, pipeHeldOpen: false }));
  check("a known did-not-exit file is ended after its idle period and counts as ok", () => {
    expect("h-noexit-known.test.mjs", { status: "pass", ok: true, noExit: true, noExitKnown: true });
    assert.ok(byFile["h-noexit-known.test.mjs"].durationMs < 4500, "ended before the full time limit");
  });
  check("a slow after() hook is never cut short", () => expect("i-slow-after-hook.test.mjs", { status: "pass", ok: true, noExit: false }));
  check("a unit file sees no database target and no credential from the shell", () => expect("j-no-env.test.mjs", { status: "pass", ok: true, fail: 0 }));
  check("a .env in the test process's cwd is not loaded by dotenv under the runner", () => expect("n-dotenv.test.mjs", { status: "pass", ok: true, fail: 0 }));
  check("no canary credential appears in the runner's output, its report or any kept log", () => {
    const texts = [run.stdout, run.stderr, fs.readFileSync(reportPath, "utf8")];
    for (const file of Object.keys(FILES)) texts.push(fs.readFileSync(path.join(logDir, "frontend", "unit", `${file}.log`), "utf8"));
    for (const t of texts) {
      assert.ok(!t.includes("canary-password-7f3a"), "the database password leaked");
      assert.ok(!t.includes(CANARY_TOKEN), "a token leaked");
    }
  });
  check("the stuck file's grandchild process is gone", () => {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(pid > 0, "grandchild pid recorded");
    assert.equal(processAlive(pid), false, `pid ${pid} is still alive`);
  });
  check("every file has a kept log", () => {
    for (const file of Object.keys(FILES)) assert.ok(fs.existsSync(path.join(logDir, "frontend", "unit", `${file}.log`)), `${file}.log`);
  });
  check("a manifest entry without a fingerprint, with an unknown failureType, or for a secret / credential scan test is refused before any file runs", () => {
    const cases = [
      [{ file: "a-pass.test.mjs", test: "one passes" }, /must carry "failureType"/],
      [{ file: "a-pass.test.mjs", test: "one passes", failureType: "testCodeFailure" }, /must carry "messagePattern"/],
      [{ file: "a-pass.test.mjs", test: "one passes", failureType: "somethingElse", messagePattern: "^x" }, /unknown failureType/],
      [{ file: "a-pass.test.mjs", test: "one passes", failureType: "testCodeFailure", messagePattern: "(" }, /not a valid regular expression/],
      [{ file: "a-pass.test.mjs", test: "one passes", failureType: "testCodeFailure", messagePattern: "^.*" }, /too unspecific to be a fingerprint/],
      [{ file: "source-hosts-server3.test.mjs", test: "12. anything", failureType: "testCodeFailure", messagePattern: "^a long enough literal" }, /secret \/ credential scan test is refused/],
      [{ file: "moved/source-hosts-server3.test.mjs", test: "12. anything", failureType: "testCodeFailure", messagePattern: "^a long enough literal" }, /secret \/ credential scan test is refused/],
      [{ file: "other.test.mjs", test: "no credential or token is in any file of this change", failureType: "testCodeFailure", messagePattern: "^a long enough literal" }, /secret \/ credential scan test is refused/],
    ];
    for (const [entry, expected] of cases) {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-manifest-"));
      try {
        fs.mkdirSync(path.join(bare, "tests", "support"), { recursive: true });
        fs.writeFileSync(path.join(bare, "tests", "a-pass.test.mjs"), FILES["a-pass.test.mjs"]);
        fs.writeFileSync(path.join(bare, "tests", "support", "test-manifest.json"), JSON.stringify({ knownFailures: [entry] }));
        const r = runRunner(["--project", "frontend", "--project-dir", bare, "--timeout-ms", "5000", "--quiet", "--log-dir", path.join(bare, "logs")]);
        assert.equal(r.status, 2, `${JSON.stringify(entry)}: exit ${r.status}\n${r.stderr}`);
        assert.match(r.stderr, expected, JSON.stringify(entry));
        assert.ok(!r.stdout.includes("PASS"), "no file ran");
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    }
  });
  check("a project without a test-manifest.json runs with every list empty", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-bare-"));
    try {
      fs.mkdirSync(path.join(bare, "tests"), { recursive: true });
      fs.writeFileSync(path.join(bare, "tests", "only.test.mjs"), FILES["a-pass.test.mjs"]);
      const r = runRunner(["--project", "frontend", "--project-dir", bare, "--timeout-ms", "5000", "--quiet", "--log-dir", path.join(bare, "logs")]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Files: 1 — pass 1/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
  check("the whole self-test project ran within the time limits", () => assert.ok(elapsed < 60_000, `took ${elapsed} ms`));

  // The cleanup after a file the runner ended (database kinds), with a fake audit and drop.
  {
    const db = (name, extra = {}) => ({ name, disposable: /^optimove_tests_[a-z0-9_]+_[0-9a-f]{12}$/.test(name), sessions: 0, ...extra });
    const OWN = "optimove_tests_a_b_0123456789ab";
    const EARLIER = "optimove_tests_c_d_0123456789ac";
    const run = (before, nows, dropResult = (names) => ({ dropped: names, refused: [] })) => {
      const calls = { drop: [], sleeps: 0 };
      let i = 0;
      const p = runnerModule.cleanUpEndedFile({
        before: { databases: before },
        audit: () => nows[Math.min(i++, nows.length - 1)],
        drop: (names) => { calls.drop.push(names); return dropResult(names); },
        sleep: async () => { calls.sleeps++; },
      });
      return p.then((result) => ({ result, calls }));
    };
    const pending = [];
    const checkAsync = (name, fn) => pending.push([name, fn]);
    checkAsync("cleanup: the ended file's own droppable database is dropped, by name only", async () => {
      const { result, calls } = await run([db("postgres_like_kept")], [{ databases: [db("postgres_like_kept"), db(OWN)] }]);
      assert.deepEqual(result, { dropped: [OWN], leftover: [] });
      assert.deepEqual(calls.drop, [[OWN]]);
    });
    checkAsync("cleanup: a database that was there before the file (an earlier file's leftover) is never touched or blamed", async () => {
      const { result, calls } = await run([db(EARLIER)], [{ databases: [db(EARLIER), db(OWN)] }]);
      assert.deepEqual(result.dropped, [OWN]);
      assert.ok(!calls.drop.flat().includes(EARLIER));
      assert.ok(!result.leftover.includes(EARLIER));
    });
    checkAsync("cleanup: a database with a session open is looked at again after a wait and, still busy, left as leftover, never dropped", async () => {
      const { result, calls } = await run([], [{ databases: [db(OWN, { sessions: 1 })] }, { databases: [db(OWN, { sessions: 1 })] }]);
      assert.deepEqual(result, { dropped: [], leftover: [OWN] });
      assert.equal(calls.sleeps, 1);
      assert.deepEqual(calls.drop, []);
    });
    checkAsync("cleanup: a session that closes during the wait lets the database be dropped", async () => {
      const { result } = await run([], [{ databases: [db(OWN, { sessions: 1 })] }, { databases: [db(OWN)] }]);
      assert.deepEqual(result, { dropped: [OWN], leftover: [] });
    });
    checkAsync("cleanup: another name is leftover (a manual decision); a drop the audit refused is leftover; an audit error is an error", async () => {
      const a = await run([], [{ databases: [db("some_manual_name")] }]);
      assert.deepEqual(a.result, { dropped: [], leftover: ["some_manual_name"] });
      const b = await run([], [{ databases: [db(OWN)] }], (names) => ({ dropped: [], refused: names.map((name) => ({ name, reason: "x" })) }));
      assert.deepEqual(b.result, { dropped: [], leftover: [OWN] });
      const c = await run([], [{ error: "connection refused" }]);
      assert.equal(c.result.error, "connection refused");
      const d = await runnerModule.cleanUpEndedFile({ before: { error: "no server" }, audit: () => ({ databases: [] }), drop: () => ({}) });
      assert.match(d.error, /no snapshot before the file/);
    });
    checkAsync("cleanup: the drop never passes --force and names each database with --only", async () => {
      assert.deepEqual(runnerModule.auditArgs([]), ["--json"]);
      assert.deepEqual(runnerModule.auditArgs([OWN]), ["--json", "--drop", "--yes", `--only=${OWN}`]);
    });
    for (const [name, fn] of pending) {
      try {
        await fn();
        check(name, () => {});
      } catch (error) {
        check(name, () => { throw error; });
      }
    }
  }

  // A file that replaces db.js with mock.module is unit; the same file without the mock, or
  // with its own pg import, still needs a database.
  check("classification: a db.js replaced by mock.module does not make a file need a database", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-classify-"));
    try {
      fs.mkdirSync(path.join(proj, "src"), { recursive: true });
      fs.mkdirSync(path.join(proj, "tests"), { recursive: true });
      fs.writeFileSync(path.join(proj, "src", "db.js"), 'import pg from "pg";\nexport const query = () => {};\n');
      fs.writeFileSync(path.join(proj, "src", "service.js"), 'import { query } from "./db.js";\nexport const run = () => query();\n');
      fs.writeFileSync(path.join(proj, "src", "other.js"), 'import { query } from "./db.js";\nexport const other = () => query();\n');
      const wrapper = (body) => `import { test, mock } from "node:test";\n${body}\nconst { run } = await import("../src/service.js");\ntest("x", () => {});\n`;
      fs.writeFileSync(path.join(proj, "tests", "mocked.test.mjs"), wrapper('mock.module("../src/db.js", { namedExports: { query: () => {} } });'));
      fs.writeFileSync(path.join(proj, "tests", "plain.test.mjs"), wrapper(""));
      fs.writeFileSync(path.join(proj, "tests", "mocked-but-pg.test.mjs"), wrapper('import pg from "pg";\nmock.module("../src/db.js", { namedExports: { query: () => {} } });'));
      fs.writeFileSync(path.join(proj, "tests", "mocks-other.test.mjs"), wrapper('mock.module("../src/other.js", { namedExports: { other: () => {} } });'));
      const testsDirAbs = path.join(proj, "tests");
      const kindOf = (file) => runnerModule.classifyFile({ project: "backend", file, testsDirAbs, cache: new Map(), manifest: {} }).kind;
      assert.equal(kindOf("mocked.test.mjs"), "unit");
      assert.equal(kindOf("plain.test.mjs"), "shared");
      assert.equal(kindOf("mocked-but-pg.test.mjs"), "shared");
      assert.equal(kindOf("mocks-other.test.mjs"), "shared");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  // The relaunch helper of backend/tests/support: a child that ran no test, or failed, fails
  // the wrapper; the old hand-written wrapper with --test-isolation=none is never a pass on a
  // node that rejects the flag.
  check("relaunch: a file that cannot run its inner suite is FAIL, never a pass; a good one passes", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-relaunch-"));
    const helper = pathToFileURL(path.join(REPO_ROOT, "backend", "tests", "support", "relaunch-with-module-mocks.mjs")).href;
    const relaunching = (inner) => `import { test, mock } from "node:test";\nimport assert from "node:assert/strict";\nimport { needsModuleMocksRelaunch, relaunchWithModuleMocks } from ${JSON.stringify(helper)};\nif (needsModuleMocksRelaunch()) {\n  test("wrapper", () => { relaunchWithModuleMocks(import.meta.url); });\n} else {\n${inner}\n}\n`;
    try {
      fs.mkdirSync(path.join(proj, "tests"), { recursive: true });
      fs.writeFileSync(path.join(proj, "tests", "r-good.test.mjs"), relaunching('  test("inner passes", () => { assert.equal(typeof mock.module, "function"); });'));
      fs.writeFileSync(path.join(proj, "tests", "r-inner-fails.test.mjs"), relaunching('  test("inner passes", () => {});\n  test("inner breaks", () => { assert.equal(1, 2); });'));
      fs.writeFileSync(path.join(proj, "tests", "r-no-tests.test.mjs"), relaunching("  // no test at all"));
      fs.writeFileSync(path.join(proj, "tests", "r-import-crash.test.mjs"), relaunching('  await import("./does-not-exist.mjs");\n  test("never reached", () => {});'));
      fs.writeFileSync(path.join(proj, "tests", "r-all-skipped.test.mjs"), relaunching('  test.skip("s1", () => {});\n  test.todo("t1");'));
      // a hung inner test: the child's own per-test limit ends it and the failure names it
      fs.writeFileSync(path.join(proj, "tests", "r-hang.test.mjs"), relaunching("  test(\"stuck forever\", () => new Promise(() => { setInterval(() => {}, 1000); }));").replace("relaunchWithModuleMocks(import.meta.url)", "relaunchWithModuleMocks(import.meta.url, { timeoutMs: 4000 })"));
      const rejectsNewFlag = spawnSync(process.execPath, ["--test-isolation=none", "-e", "0"], { stdio: "ignore" }).status !== 0;
      if (rejectsNewFlag) {
        fs.writeFileSync(path.join(proj, "tests", "r-old-wrapper.test.mjs"), `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { spawnSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\nif (!process.execArgv.includes("--experimental-test-module-mocks")) {\n  test("old wrapper", () => {\n    const r = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--test", "--test-isolation=none", fileURLToPath(import.meta.url)], { encoding: "utf8" });\n    assert.equal(r.status, 0, r.stdout + r.stderr);\n  });\n} else {\n  test("inner", () => {});\n}\n`);
      }
      const report = path.join(proj, "report.json");
      const r = runRunner(["--project", "frontend", "--project-dir", proj, "--timeout-ms", "60000", "--json", report, "--quiet", "--log-dir", path.join(proj, "logs")]);
      assert.equal(r.status, 1, r.stderr);
      const byFile = Object.fromEntries(JSON.parse(fs.readFileSync(report, "utf8")).steps.flatMap((s) => s.results).map((x) => [x.file, x]));
      assert.equal(byFile["r-good.test.mjs"].status, "pass");
      for (const bad of ["r-inner-fails.test.mjs", "r-no-tests.test.mjs", "r-import-crash.test.mjs", "r-all-skipped.test.mjs", "r-hang.test.mjs", ...(rejectsNewFlag ? ["r-old-wrapper.test.mjs"] : [])]) {
        assert.equal(byFile[bad].ok, false, `${bad} must not be ok`);
        assert.ok(["fail", "crash"].includes(byFile[bad].status), `${bad}: ${byFile[bad].status}`);
      }
      assert.match(byFile["r-inner-fails.test.mjs"].failureDetails[0].message, /^inner suite failed \(exit 1\): inner breaks/);
      assert.match(byFile["r-no-tests.test.mjs"].failureDetails[0].message, /^inner suite ran no test/);
      assert.match(byFile["r-all-skipped.test.mjs"].failureDetails[0].message, /^inner suite ran no test \(exit 0\): every test is skipped or todo/);
      // a live timer keeps the child running after its test was cancelled: it ends at the call's
      // limit, and the failure still names the hung test
      assert.match(byFile["r-hang.test.mjs"].failureDetails[0].message, /^inner suite (failed \(exit 1\)|did not finish \(ETIMEDOUT\)): stuck forever$/);
      // the same files under a plain `node --test` (the parent sets NODE_TEST_CONTEXT there)
      const direct = (name) => spawnSync(process.execPath, ["--test", path.join(proj, "tests", name)], { encoding: "utf8", timeout: 60000 }).status;
      assert.equal(direct("r-good.test.mjs"), 0, "a good relaunching file passes under plain node --test");
      assert.notEqual(direct("r-inner-fails.test.mjs"), 0, "a failing inner suite fails under plain node --test");
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  // The helper's TAP reading: node escapes `\` and `#` in names (a Windows path arrives doubled),
  // a parent is printed after its children, and skip / todo results are not tests that ran.
  {
    const helperModule = await import(pathToFileURL(path.join(REPO_ROOT, "backend", "tests", "support", "relaunch-with-module-mocks.mjs")).href);
    check("relaunch: TAP results are read unescaped, leaf by leaf, skip and todo not counted", () => {
      const win = "C:\\Users\\coach\\x.test.mjs";
      assert.equal(helperModule.countRanTests("ok 1 - C:\\\\Users\\\\coach\\\\x.test.mjs\n", win), 0, "the escaped Windows placeholder is not a test");
      assert.equal(helperModule.countRanTests("ok 1 - real test\nok 2 - C:\\\\Users\\\\coach\\\\x.test.mjs\n", win), 1);
      const nested = "    not ok 1 - leaf x\n    ok 2 - leaf ok\nnot ok 1 - Suite S\nok 2 - skipped # SKIP\nnot ok 3 - todo # TODO\nok 4 - back\\\\slash \\# hash\n";
      assert.deepEqual(helperModule.failedInnerTests(nested), ["leaf x"]);
      assert.equal(helperModule.countRanTests(nested, "/nowhere"), 3);
      assert.deepEqual(helperModule.parseTapResults(nested).at(-1).name, "back\\slash # hash");
      assert.equal(helperModule.countRanTests("ok 1 - a # SKIP\nok 2 - b # TODO\n", "/nowhere"), 0);
    });
  }

  // Not run: every file of the run's scope that no step ran is named; --strict-not-run fails.
  check("not run: files left out by kind are listed in the summary and the report; --strict-not-run makes the run fail", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "optimove-test-runner-selftest-notrun-"));
    try {
      fs.mkdirSync(path.join(proj, "tests"), { recursive: true });
      fs.writeFileSync(path.join(proj, "tests", "u-unit.test.mjs"), FILES["a-pass.test.mjs"]);
      fs.writeFileSync(path.join(proj, "tests", "s-needs-db.test.mjs"), `import pg from "pg";\n${FILES["a-pass.test.mjs"]}`);
      const report = path.join(proj, "report.json");
      const base = ["--project", "backend", "--kind", "unit", "--project-dir", proj, "--timeout-ms", "5000", "--quiet", "--log-dir", path.join(proj, "logs")];
      const lenient = runRunner([...base, "--json", report]);
      assert.equal(lenient.status, 0, lenient.stdout + lenient.stderr);
      assert.match(lenient.stdout, /not run 1/);
      assert.match(lenient.stdout, /Not run \(1\):\n {2}backend \/ kind shared: this step runs --kind unit only \(1\): s-needs-db\.test\.mjs/);
      const parsed = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.deepEqual(parsed.notRun.map((n) => [n.file, n.kind]), [["s-needs-db.test.mjs", "shared"]]);
      assert.equal(parsed.totals.notRun, 1);
      const strict = runRunner([...base, "--strict-not-run"]);
      assert.equal(strict.status, 1, strict.stdout);
      assert.match(strict.stdout, /RESULT: FAILED \(--strict-not-run: 1 file\(s\) not run\)/);
      // nothing left out: --strict-not-run changes nothing
      fs.rmSync(path.join(proj, "tests", "s-needs-db.test.mjs"));
      const clean = runRunner([...base, "--strict-not-run"]);
      assert.equal(clean.status, 0, clean.stdout);
      assert.match(clean.stdout, /not run 0/);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  check("not run: a file another step of the same run ran (or skipped) is not listed", () => {
    const steps = [
      { project: "backend", results: [{ file: "a.test.mjs" }], notRun: [{ project: "backend", file: "b.test.mjs", kind: "disposable", reason: "r1" }, { project: "backend", file: "c.test.mjs", kind: "shared", reason: "r1" }] },
      { project: "backend", results: [{ file: "b.test.mjs", status: "skipped" }], notRun: [{ project: "backend", file: "a.test.mjs", kind: "unit", reason: "r2" }, { project: "backend", file: "c.test.mjs", kind: "shared", reason: "r2" }] },
      { project: "frontend", results: [], notRun: [{ project: "frontend", file: "c.test.mjs", kind: "unit", reason: "r3" }] },
    ];
    assert.deepEqual(runnerModule.mergeNotRun(steps).map((n) => `${n.project}/${n.file}/${n.reason}`), ["backend/c.test.mjs/r1", "frontend/c.test.mjs/r3"]);
  });

  // Refusals: an unsafe DATABASE_URL never lets a database-kind step start.
  for (const [label, url] of [
    ["a remote host", "postgresql://user:pw@db.example.com:5432/optimove"],
    ["a Supabase pooler", "postgresql://user:pw@localhost:6543/postgres?x=supabase"],
    ["monitoring2", "postgresql://user:pw@localhost:5432/monitoring2"],
    ["a libpq host override", "postgresql://user:pw@localhost:5432/postgres?host=db.example.com"],
    ["a port override in the query string", "postgresql://user:pw@localhost:5432/postgres?port=6543"],
    ["a user override in the query string", "postgresql://user:pw@localhost:5432/postgres?user=postgres"],
  ]) {
    check(`a disposable step refuses ${label} before running anything`, () => {
      const r = runRunner(["--project", "backend", "--kind", "disposable", "--project-dir", project], { DATABASE_URL: url });
      assert.equal(r.status, 2, `exit ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /test-runner refused: DATABASE_URL/);
      assert.ok(!r.stderr.includes("pw@"), "the refusal never prints the credential");
      assert.ok(!r.stdout.includes("PASS"), "no file ran");
    });
  }
  check("a shared step refuses to run without the database being named", () => {
    const r = runRunner(["--project", "backend", "--kind", "shared", "--project-dir", project], { DATABASE_URL: "postgresql://user:pw@localhost:5432/OPTIMOVE" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--shared-db/);
  });
  check("a shared step refuses a name that is not the one DATABASE_URL points at", () => {
    const r = runRunner(["--project", "backend", "--kind", "shared", "--project-dir", project, "--shared-db", "OTHER"], { DATABASE_URL: "postgresql://user:pw@localhost:5432/OPTIMOVE" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /names "OTHER" but DATABASE_URL points at "OPTIMOVE"/);
  });
  check("a shared step refuses a database that is not an OptiMove development database, and an ambient variable is not an opt-in", () => {
    const r = runRunner(["--project", "backend", "--kind", "shared", "--project-dir", project, "--shared-db", "monitoring_app"], { DATABASE_URL: "postgresql://user:pw@localhost:5432/monitoring_app" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must start with "optimove"/);
    const ambient = runRunner(["--project", "backend", "--kind", "shared", "--project-dir", project], { DATABASE_URL: "postgresql://user:pw@localhost:5432/OPTIMOVE", OPTIMOVE_TEST_SHARED_DB: "OPTIMOVE" });
    assert.equal(ambient.status, 2, "the variable alone must not name the database");
  });
  check("the runner's loopback and forbidden-marker rules are the same as the backend support module's", () => {
    assert.deepEqual(runnerModule.LOOPBACK_HOSTS, supportModule.LOOPBACK_HOSTS);
    assert.deepEqual(runnerModule.FORBIDDEN_URL_MARKERS, supportModule.FORBIDDEN_URL_MARKERS);
  });
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}

let failed = 0;
for (const c of checks) {
  process.stdout.write(`${c.ok ? "ok    " : "FAILED"} ${c.name}${c.ok ? "" : `\n       ${c.error}`}\n`);
  if (!c.ok) failed++;
}
process.stdout.write(`\ntest-runner self-test: ${checks.length - failed} of ${checks.length} checks passed\n`);
process.exitCode = failed ? 1 : 0;
