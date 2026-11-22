// Tests for hook-selfcheck.mjs, the SessionStart check that the PreToolUse guard really runs.
// Run: node --test .claude/hooks/hook-selfcheck.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSettings, fileProbes, runProbe, selfCheck, sessionStartOutput, registeredGuardPath, nodeOptionsProblem, PROBES } from "./hook-selfcheck.mjs";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(HOOK_DIR, "..", "settings.json");
const GUARD = path.join(HOOK_DIR, "safety-guard.mjs");
const SELFCHECK = path.join(HOOK_DIR, "hook-selfcheck.mjs");

const guardHook = (extra = {}) => ({ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs"], timeout: 30, ...extra });
const settingsWith = (perMatcher, extra = { disableAllHooks: false }) => JSON.stringify({ ...extra, hooks: { PreToolUse: Object.entries(perMatcher).map(([matcher, hook]) => ({ matcher, hooks: [hook] })) } });

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-selfcheck-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("the repository's own settings and guard pass the self-check", () => {
  assert.deepEqual(selfCheck({ cwd: process.cwd() }), []);
});

test("settings: every guard registration carries onFailure block, and SessionStart runs the self-check", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  for (const matcher of ["Bash", "PowerShell", "mcp__.*"]) {
    const group = settings.hooks.PreToolUse.find((g) => g.matcher === matcher);
    assert.ok(group, matcher);
    for (const hook of group.hooks) {
      assert.equal(hook.onFailure, "block", `${matcher}: onFailure`);
      assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0 && hook.timeout <= 60, `${matcher}: timeout`);
    }
  }
  const start = settings.hooks.SessionStart.flatMap((g) => g.hooks);
  assert.ok(start.some((h) => h.command === "node" && h.args?.[0]?.endsWith("/.claude/hooks/hook-selfcheck.mjs")));
});

test("checkSettings names a matcher whose guard lacks onFailure block, or is missing, and invalid JSON", () => {
  const ok = guardHook({ onFailure: "block" });
  assert.deepEqual(checkSettings(settingsWith({ Bash: ok, PowerShell: ok, "Write|Edit|MultiEdit|NotebookEdit": ok, "mcp__.*": ok })), []);
  const noBlock = checkSettings(settingsWith({ Bash: guardHook(), PowerShell: ok, "Write|Edit|MultiEdit|NotebookEdit": ok, "mcp__.*": ok }));
  assert.equal(noBlock.length, 1);
  assert.match(noBlock[0], /Bash guard hook lacks "onFailure": "block"/);
  const missing = checkSettings(settingsWith({ Bash: ok, PowerShell: ok, "Write|Edit|MultiEdit|NotebookEdit": ok }));
  assert.deepEqual(missing, ["safety-guard.mjs is not registered for the mcp__.* matcher"]);
  assert.match(checkSettings("{ not json")[0], /not valid JSON/);
  assert.deepEqual(checkSettings("{}"), ["no PreToolUse hooks are registered in .claude/settings.json"]);
  const all = { Bash: ok, PowerShell: ok, "Write|Edit|MultiEdit|NotebookEdit": ok, "mcp__.*": ok };
  assert.deepEqual(checkSettings(settingsWith(all, {})), ['.claude/settings.json does not set "disableAllHooks": false']);
  assert.deepEqual(checkSettings(settingsWith(all, { disableAllHooks: true })), ['.claude/settings.json does not set "disableAllHooks": false']);
  const noFileTools = checkSettings(settingsWith({ Bash: ok, PowerShell: ok, "mcp__.*": ok }));
  assert.deepEqual(noFileTools, ["safety-guard.mjs is not registered for the Write|Edit|MultiEdit|NotebookEdit matcher"]);
});

test("the file-tool probes: an edit of the guard's own .claude/settings.json must ask, a write elsewhere gets no decision", () => {
  const probes = fileProbes(GUARD);
  assert.deepEqual(probes.map((p) => [p.tool, p.expect]), [["Edit", "ask"], ["Write", "none"]]);
  for (const p of probes) assert.equal(runProbe(p, { cwd: process.cwd() }).problem, null, p.label);
  withTempDir((dir) => {
    const silent = path.join(dir, "silent.mjs");
    fs.writeFileSync(silent, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    assert.match(runProbe(probes[0], { cwd: dir, guardPath: silent }).problem, /returned none for Edit "\.claude\/settings\.json" \(expected ask\)/);
  });
});

test("checkSettings refuses a registration that names the guard but would not run it as the guard", () => {
  const ok = guardHook({ onFailure: "block" });
  const variants = {
    "another program": guardHook({ onFailure: "block", command: "true" }),
    "async": guardHook({ onFailure: "block", async: true }),
    "another path": guardHook({ onFailure: "block", args: ["/tmp/x/.claude/hooks/safety-guard.mjs"] }),
    "an extra argument": guardHook({ onFailure: "block", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs", "--off"] }),
    "shell form": { type: "command", command: "node ${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs", timeout: 30, onFailure: "block" },
    "no timeout": guardHook({ onFailure: "block", timeout: undefined }),
    "a condition field": guardHook({ onFailure: "block", if: "Bash(ls *)" }),
  };
  for (const [label, hook] of Object.entries(variants)) {
    const problems = checkSettings(settingsWith({ Bash: hook, PowerShell: ok, "Write|Edit|MultiEdit|NotebookEdit": ok, "mcp__.*": ok }));
    assert.ok(problems.length >= 1, label);
    assert.ok(problems.every((p) => p.includes("Bash")), label);
  }
});

test("a guard that hangs, prints something unreadable, or asks where it must deny fails the probe", () => {
  withTempDir((dir) => {
    const write = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; };
    const hang = write("hang.mjs", "setInterval(() => {}, 1000);\n");
    const garbage = write("garbage.mjs", "process.stdout.write('not json');\n");
    const asks = write("asks.mjs", "process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } }));\n");
    const deny = PROBES.find((p) => p.expect === "deny");
    const started = Date.now();
    assert.match(runProbe(deny, { cwd: dir, guardPath: hang, timeoutMs: 300 }).problem, /could not run .*ETIMEDOUT/);
    assert.ok(Date.now() - started < 5_000, "the hung guard was ended by the probe's limit");
    assert.match(runProbe(deny, { cwd: dir, guardPath: garbage }).problem, /returned unreadable/);
    assert.match(runProbe(deny, { cwd: dir, guardPath: asks }).problem, /returned ask .*\(expected deny\)/);
  });
});

test("the probes cover a deny on Bash and PowerShell and a harmless line", () => {
  assert.ok(PROBES.some((p) => p.tool === "Bash" && p.expect === "deny"));
  assert.ok(PROBES.some((p) => p.tool === "PowerShell" && p.expect === "deny"));
  assert.ok(PROBES.some((p) => p.expect === "none"));
});

test("a guard that is silent on everything, that crashes, or that cannot start fails the probes", () => {
  withTempDir((dir) => {
    const silent = path.join(dir, "silent.mjs");
    fs.writeFileSync(silent, "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    const crashing = path.join(dir, "crashing.mjs");
    fs.writeFileSync(crashing, "throw new Error('boom');\n");
    const deny = PROBES.find((p) => p.expect === "deny");
    assert.match(runProbe(deny, { cwd: dir, guardPath: silent }).problem, /returned none .* \(expected deny\)/);
    assert.match(runProbe(deny, { cwd: dir, guardPath: crashing }).problem, /exited 1/);
    assert.match(runProbe(deny, { cwd: dir, nodePath: path.join(dir, "no-such-node") }).problem, /could not run/);
  });
});

test("a missing guard file and an unreadable settings file are reported", () => {
  withTempDir((dir) => {
    const problems = selfCheck({ cwd: dir, guardPath: path.join(dir, "gone.mjs"), settingsPath: path.join(dir, "gone.json") });
    assert.ok(problems.some((p) => p === ".claude/hooks/safety-guard.mjs is missing at the registered path"));
    assert.ok(problems.some((p) => p === ".claude/settings.json could not be read (ENOENT)"));
    assert.ok(problems.every((p) => !p.includes(dir)), "no absolute path in a message");
  });
});

test("output: silent to the user when all is well, a visible warning otherwise", () => {
  const good = sessionStartOutput([]);
  assert.equal(good.systemMessage, undefined);
  assert.match(good.hookSpecificOutput.additionalContext, /self-check passed/);
  const bad = sessionStartOutput(["x is broken"]);
  assert.match(bad.systemMessage, /^SAFETY HOOK SELF-CHECK FAILED.*x is broken/);
  assert.equal(bad.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(bad.hookSpecificOutput.additionalContext, bad.systemMessage);
});

test("run as a hook: reads the SessionStart input, prints one JSON object and exits 0", () => {
  const r = spawnSync(process.execPath, [SELFCHECK], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: process.cwd() }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.systemMessage, undefined, out.systemMessage);
});

test("run by hand (no hook input) it answers too: exit 0 with the passed line", () => {
  const r = spawnSync(process.execPath, [SELFCHECK], { input: "", encoding: "utf8", cwd: path.resolve(HOOK_DIR, "..", "..") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /^Safety hook self-check passed/);
});

test("a failure exits 1 when run by hand and 0 as the SessionStart hook (where a non-zero exit would drop the warning)", () => {
  withTempDir((dir) => {
    // a copy of the project's hook folder whose guard decides nothing
    const hooks = path.join(dir, ".claude", "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.copyFileSync(SELFCHECK, path.join(hooks, "hook-selfcheck.mjs"));
    fs.copyFileSync(SETTINGS, path.join(dir, ".claude", "settings.json"));
    fs.writeFileSync(path.join(hooks, "safety-guard.mjs"), "process.stdin.resume(); process.stdin.on('end', () => process.exit(0));\n");
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const manual = spawnSync(process.execPath, [path.join(hooks, "hook-selfcheck.mjs")], { input: "", encoding: "utf8", env, cwd: dir });
    assert.equal(manual.status, 1);
    assert.match(JSON.parse(manual.stdout).systemMessage, /^SAFETY HOOK SELF-CHECK FAILED/);
    const hook = spawnSync(process.execPath, [path.join(hooks, "hook-selfcheck.mjs")], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: dir }), encoding: "utf8", env, cwd: dir });
    assert.equal(hook.status, 0);
    assert.match(JSON.parse(hook.stdout).systemMessage, /^SAFETY HOOK SELF-CHECK FAILED/);
  });
});

test("behind a symlinked project folder the guard still decides and the self-check still runs (regression: both were silent no-ops)", () => {
  withTempDir((dir) => {
    const projectDir = path.resolve(HOOK_DIR, "..", "..");
    const link = path.join(dir, "linked-project");
    fs.symlinkSync(projectDir, link, "dir");
    const linkedGuard = path.join(link, ".claude", "hooks", "safety-guard.mjs");
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" }, cwd: dir, session_id: "hook-selfcheck" });
    const guard = spawnSync(process.execPath, [linkedGuard], { input, encoding: "utf8" });
    assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(registeredGuardPath({ CLAUDE_PROJECT_DIR: link }), linkedGuard);
    assert.equal(registeredGuardPath({ CLAUDE_PROJECT_DIR: "/p/a$'b$&/" }), "/p/a$'b$&/.claude/hooks/safety-guard.mjs");
    assert.deepEqual(selfCheck({ cwd: dir, guardPath: linkedGuard, env: {} }), []);
    const hook = spawnSync(process.execPath, [path.join(link, ".claude", "hooks", "hook-selfcheck.mjs")], { input: "{}", encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: link } });
    assert.equal(hook.status, 0, hook.stderr);
    assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /self-check passed/);
  });
});

test("node options that load code or change resolution in every node process are reported by name, never by value", () => {
  assert.equal(nodeOptionsProblem({}), null);
  assert.equal(nodeOptionsProblem({ NODE_OPTIONS: "--max-old-space-size=4096" }), null);
  const p = nodeOptionsProblem({ NODE_OPTIONS: "--max-old-space-size=4096 --require /secret/place/preload.js --import=x" });
  assert.match(p, /NODE_OPTIONS sets --require, --import/);
  assert.ok(!p.includes("/secret/place"), "the value is not echoed");
  assert.ok(selfCheck({ cwd: process.cwd(), env: { NODE_OPTIONS: "--preserve-symlinks-main" } }).some((x) => /--preserve-symlinks-main/.test(x)));
});

test("the guard file the self-check probes is the real one", () => {
  assert.ok(fs.existsSync(GUARD));
});
