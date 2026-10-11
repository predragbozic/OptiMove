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
  "k-hang-known.test.mjs": `import { test } from "node:test";
test("fine before the hang", () => {});
test("hangs forever (known, cancelled by the per-test limit)", async () => { await new Promise(() => {}); });
test("runs after the hang was cancelled", () => {});
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
    { file: "k-hang-known.test.mjs", test: "hangs forever (known, cancelled by the per-test limit)", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
    { file: "l-partial-xpass.test.mjs", test: "listed and now passes", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "l-partial-xpass.test.mjs", test: "listed and still fails", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "o-fp-match.test.mjs", test: "fails with the expected cause", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "p-fp-type.test.mjs", test: "fails with another failure type than listed", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
    { file: "q-fp-message.test.mjs", test: "fails with another message than listed", failureType: "testCodeFailure", messagePattern: STRICT_EQUAL, since: "2026-10-11", note: "self-test" },
    { file: "r-fp-timeout-now-assert.test.mjs", test: "a known timeout that now fails an assertion", failureType: "testTimeoutFailure", messagePattern: TIMEOUT, since: "2026-10-11", note: "self-test" },
  ],
  fileOptions: { "k-hang-known.test.mjs": { testTimeoutMs: 1500, note: "self-test" } },
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
const reportPath = path.join(project, "report.json");
const logDir = path.join(project, "logs");
try {
  const started = Date.now();
  const run = runRunner(
    ["--project", "frontend", "--project-dir", project, "--timeout-ms", "5000", "--json", reportPath, "--log-dir", logDir, "--quiet"],
    { SELFTEST_GRANDCHILD_PID_FILE: pidFile, DATABASE_URL: CANARY_DB_URL, GPEXE_API_TOKEN: CANARY_TOKEN, SOURCE_CREDENTIAL_KEYS: `1:${CANARY_TOKEN}`, GITHUB_TOKEN: CANARY_TOKEN, MY_SERVICE_API_KEY: CANARY_TOKEN },
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
  check("a test that never finishes is cancelled by node's per-test limit, reported as a failure, and the file still runs on and exits", () => {
    expect("k-hang-known.test.mjs", { status: "xfail", ok: true, noExit: false, timedOut: false, pass: 2, fail: 1, knownFailuresSeen: ["hangs forever (known, cancelled by the per-test limit)"] });
    assert.equal(byFile["k-hang-known.test.mjs"].failureDetails[0].failureType, "testTimeoutFailure");
    assert.ok(byFile["k-hang-known.test.mjs"].durationMs < 4500, "ended well before the file limit");
  });
  check("a file whose stuck test keeps a grandchild alive is a failure (the per-test limit cancelled it) and the process is ended at the file limit", () => expect("e-stuck.test.mjs", { status: "fail", ok: false, timedOut: true, noExit: true, running: [], unknownFailures: ["never finishes and keeps a grandchild alive"] }));
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
