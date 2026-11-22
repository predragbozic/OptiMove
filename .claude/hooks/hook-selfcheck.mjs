// SessionStart self-check for the PreToolUse safety hook (safety-guard.mjs).
//
// .claude/settings.json lets some commands through by name (rm, cp, mv, git add / commit /
// push, ...) and relies on safety-guard.mjs to ask or deny for everything outside the
// approved scope. So the guard must really run. Once per session start (startup, resume, clear,
// compact, fork; no matcher, so every source) this script checks that:
//   1. settings.json registers safety-guard.mjs for Bash, PowerShell and mcp__.* with
//      "onFailure": "block" (a guard that cannot start, crashes or times out then blocks the
//      tool call instead of leaving the decision to the allow list);
//   2. the guard, started the same way Claude Code starts it (a separate `node` process fed
//      the call on stdin), denies a probe it must deny and stays silent on a harmless one.
// The result goes to the user (systemMessage) only when something is wrong, and always to
// Claude's context (additionalContext). A SessionStart hook cannot block anything; if node
// itself is missing, this script does not start either, and the PreToolUse "onFailure":
// "block" is what keeps the session safe (every Bash / PowerShell / MCP call is blocked).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HOOK_DIR, "safety-guard.mjs");
const SETTINGS = path.join(HOOK_DIR, "..", "settings.json");
const MATCHERS = ["Bash", "PowerShell", "mcp__.*"];

// Each probe: the tool call, and the decision the guard must return ("none" = no output).
export const PROBES = [
  { tool: "Bash", command: "git push --force origin main", expect: "deny" },
  { tool: "PowerShell", command: "git reset --hard", expect: "deny" },
  { tool: "Bash", command: "ls -la", expect: "none" },
];

export function checkSettings(settingsText) {
  const problems = [];
  let settings;
  try {
    settings = JSON.parse(settingsText);
  } catch (error) {
    return [`.claude/settings.json is not valid JSON (${error.message})`];
  }
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return ["no PreToolUse hooks are registered in .claude/settings.json"];
  for (const matcher of MATCHERS) {
    const hooks = groups.filter((g) => g?.matcher === matcher).flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []));
    const guard = hooks.filter((h) => h?.type === "command" && [h.command, ...(h.args || [])].some((part) => typeof part === "string" && part.replace(/\\/g, "/").endsWith(".claude/hooks/safety-guard.mjs")));
    if (!guard.length) problems.push(`safety-guard.mjs is not registered for the ${matcher} matcher`);
    else if (!guard.every((h) => h.onFailure === "block")) problems.push(`the ${matcher} guard hook lacks "onFailure": "block" (a guard that fails would let the call through)`);
  }
  return problems;
}

export function runProbe(probe, { cwd, nodePath = process.execPath, guardPath = GUARD } = {}) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: probe.tool, tool_input: { command: probe.command }, cwd, session_id: "hook-selfcheck" });
  const r = spawnSync(nodePath, [guardPath], { input, encoding: "utf8", timeout: 15_000, windowsHide: true });
  if (r.error) return { problem: `the guard could not run for "${probe.command}" (${r.error.code || r.error.message})` };
  if (r.status !== 0) return { problem: `the guard exited ${r.status ?? r.signal} for "${probe.command}"` };
  const out = (r.stdout || "").trim();
  let decision = "none";
  if (out) {
    try {
      decision = JSON.parse(out)?.hookSpecificOutput?.permissionDecision || "unreadable";
    } catch {
      decision = "unreadable";
    }
  }
  if (decision !== probe.expect) return { problem: `the guard returned ${decision} for ${probe.tool} "${probe.command}" (expected ${probe.expect})` };
  return { problem: null };
}

export function selfCheck({ cwd = process.cwd(), settingsPath = SETTINGS, guardPath = GUARD, nodePath = process.execPath } = {}) {
  const problems = [];
  if (!fs.existsSync(guardPath)) problems.push(`${guardPath} is missing`);
  try {
    problems.push(...checkSettings(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    problems.push(`.claude/settings.json could not be read (${error.message})`);
  }
  if (fs.existsSync(guardPath)) {
    for (const probe of PROBES) {
      const { problem } = runProbe(probe, { cwd, nodePath, guardPath });
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

export function sessionStartOutput(problems) {
  if (!problems.length) {
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `Safety hook self-check passed: safety-guard.mjs is registered for Bash, PowerShell and mcp__.* with "onFailure": "block", and it denied and allowed its ${PROBES.length} probe calls as expected.`,
      },
    };
  }
  const text = `SAFETY HOOK SELF-CHECK FAILED - the PreToolUse guard (.claude/hooks/safety-guard.mjs) may not be protecting this session: ${problems.join("; ")}. Commands that settings.json allows by name (rm, cp, mv, git add / commit / push) could run without the guard's checks. Stop and fix this before running shell commands; see .claude/hooks/README.md "If the hook does not run".`;
  return {
    systemMessage: text,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const invoked = path.resolve(process.argv[1]);
  const thisFile = path.resolve(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? invoked.toLowerCase() === thisFile.toLowerCase() : invoked === thisFile;
}

if (isMainModule()) {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
    if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
  } catch {
    // no or unreadable input: probe from the current directory
  }
  let problems;
  try {
    problems = selfCheck({ cwd });
  } catch (error) {
    problems = [`the self-check itself failed (${error.message})`];
  }
  process.stdout.write(`${JSON.stringify(sessionStartOutput(problems))}\n`);
  process.exit(0);
}
