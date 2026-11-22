// Tests for hook-selfcheck.mjs, the SessionStart check that the PreToolUse guard really runs.
// Run: node --test .claude/hooks/hook-selfcheck.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSettings, runProbe, selfCheck, sessionStartOutput, PROBES } from "./hook-selfcheck.mjs";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS = path.join(HOOK_DIR, "..", "settings.json");
const GUARD = path.join(HOOK_DIR, "safety-guard.mjs");
const SELFCHECK = path.join(HOOK_DIR, "hook-selfcheck.mjs");

const guardHook = (extra = {}) => ({ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs"], ...extra });
const settingsWith = (perMatcher) => JSON.stringify({ hooks: { PreToolUse: Object.entries(perMatcher).map(([matcher, hook]) => ({ matcher, hooks: [hook] })) } });

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
    for (const hook of group.hooks) assert.equal(hook.onFailure, "block", `${matcher}: onFailure`);
  }
  const start = settings.hooks.SessionStart.flatMap((g) => g.hooks);
  assert.ok(start.some((h) => h.command === "node" && h.args?.[0]?.endsWith("/.claude/hooks/hook-selfcheck.mjs")));
});

test("checkSettings names a matcher whose guard lacks onFailure block, or is missing, and invalid JSON", () => {
  const ok = guardHook({ onFailure: "block" });
  assert.deepEqual(checkSettings(settingsWith({ Bash: ok, PowerShell: ok, "mcp__.*": ok })), []);
  const noBlock = checkSettings(settingsWith({ Bash: guardHook(), PowerShell: ok, "mcp__.*": ok }));
  assert.equal(noBlock.length, 1);
  assert.match(noBlock[0], /Bash guard hook lacks "onFailure": "block"/);
  const missing = checkSettings(settingsWith({ Bash: ok, PowerShell: ok }));
  assert.deepEqual(missing, ["safety-guard.mjs is not registered for the mcp__.* matcher"]);
  assert.match(checkSettings("{ not json")[0], /not valid JSON/);
  assert.deepEqual(checkSettings("{}"), ["no PreToolUse hooks are registered in .claude/settings.json"]);
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
    assert.ok(problems.some((p) => p.endsWith("gone.mjs is missing")));
    assert.ok(problems.some((p) => /settings.json could not be read/.test(p)));
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

test("run as a hook with no input at all still answers", () => {
  const r = spawnSync(process.execPath, [SELFCHECK], { input: "", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("the guard file the self-check probes is the real one", () => {
  assert.ok(fs.existsSync(GUARD));
});
