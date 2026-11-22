// SessionStart self-check for the PreToolUse safety hook (safety-guard.mjs).
//
// .claude/settings.json lets some commands through by name (rm, cp, mv, git add / commit /
// push, ...) and relies on safety-guard.mjs to ask or deny for everything outside the
// approved scope. So the guard must really run. Once per session start (startup, resume, clear,
// compact, fork; no matcher, so every source) this script checks that:
//   1. settings.json sets "disableAllHooks": false and registers safety-guard.mjs for Bash,
//      PowerShell, the file tools (Write|Edit|MultiEdit|NotebookEdit) and mcp__.* with
//      "onFailure": "block" (a guard that cannot start, crashes or times out then blocks the
//      tool call instead of leaving the decision to the allow list);
//   2. the guard, started the same way Claude Code starts it (a separate `node` process fed
//      the call on stdin), denies or asks where it must and stays silent on harmless calls.
// The result goes to the user (systemMessage) only when something is wrong, and always to
// Claude's context (additionalContext). A SessionStart hook cannot block anything; if node
// itself is missing, this script does not start either, and the PreToolUse "onFailure":
// "block" is what keeps the session safe (every Bash / PowerShell / MCP call and every file
// edit is blocked).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HOOK_DIR, "safety-guard.mjs");
const SETTINGS = path.join(HOOK_DIR, "..", "settings.json");
const MATCHERS = ["Bash", "PowerShell", "Write|Edit|MultiEdit|NotebookEdit", "mcp__.*"];
// The one registration form that is accepted: exec form, `node` with the guard as its only
// argument. Anything else - another program with the same path, an extra flag, async - could
// run without ever deciding, which no probe of the file itself would notice.
const GUARD_ARG = "${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs";
// The only fields a guard registration may carry. Any other one (a condition such as "if", a
// "once") could limit when the guard runs while the probes, which start it directly, pass.
const ALLOWED_HOOK_FIELDS = new Set(["type", "command", "args", "timeout", "onFailure", "statusMessage"]);

// The guard path Claude Code runs: the registered argument with ${CLAUDE_PROJECT_DIR} expanded
// from the environment Claude Code gives its hooks (this file's own copy when it is not set,
// e.g. in a test). The probe runs exactly that path, symlinks and letter case included.
export function registeredGuardPath(env = process.env) {
  const dir = env.CLAUDE_PROJECT_DIR;
  // concatenated, not String.replace: a "$" in a folder name must not be read as a pattern
  return dir ? `${dir.replace(/[\\/]+$/, "")}/.claude/hooks/safety-guard.mjs` : GUARD;
}

// node options that load code into, or change how node resolves, every node process - the
// guard's too. Only the option names are reported, never their values.
const RISKY_NODE_OPTIONS = /(^|\s)(--require|-r|--import|--loader|--experimental-loader|--preserve-symlinks|--preserve-symlinks-main)(\s|=|$)/;
export function nodeOptionsProblem(env = process.env) {
  const value = env.NODE_OPTIONS || "";
  const found = [...value.matchAll(new RegExp(RISKY_NODE_OPTIONS.source, "g"))].map((m) => m[2]);
  return found.length ? `NODE_OPTIONS sets ${[...new Set(found)].join(", ")}, which also runs in the guard's node process; check that it cannot stop the guard` : null;
}

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
    return [".claude/settings.json is not valid JSON"];
  }
  const groups = settings?.hooks?.PreToolUse;
  if (!Array.isArray(groups)) return ["no PreToolUse hooks are registered in .claude/settings.json"];
  // false here overrides a true in the user's own settings (a command-line --settings layer
  // or managed settings still win; the self-check cannot see those)
  if (settings.disableAllHooks !== false) problems.push('.claude/settings.json does not set "disableAllHooks": false');
  for (const matcher of MATCHERS) {
    const hooks = groups.filter((g) => g?.matcher === matcher).flatMap((g) => (Array.isArray(g.hooks) ? g.hooks : []));
    const mentions = hooks.filter((h) => JSON.stringify(h ?? null).includes("safety-guard.mjs"));
    if (!mentions.length) {
      problems.push(`safety-guard.mjs is not registered for the ${matcher} matcher`);
      continue;
    }
    for (const h of mentions) {
      const execForm = h.type === "command" && h.command === "node" && Array.isArray(h.args) && h.args.length === 1 && h.args[0] === GUARD_ARG;
      if (!execForm) problems.push(`the ${matcher} guard registration is not the expected exec form (command "node", args ["${GUARD_ARG}"])`);
      const extra = Object.keys(h ?? {}).filter((k) => !ALLOWED_HOOK_FIELDS.has(k));
      if (extra.length) problems.push(`the ${matcher} guard registration has unexpected fields (${extra.join(", ")}) that could limit when it runs`);
      if (h.async || h.asyncRewake) problems.push(`the ${matcher} guard hook runs in the background (async), so it cannot decide`);
      if (h.onFailure !== "block") problems.push(`the ${matcher} guard hook lacks "onFailure": "block" (a guard that fails would let the call through)`);
      if (!(Number.isInteger(h.timeout) && h.timeout > 0 && h.timeout <= 60)) problems.push(`the ${matcher} guard hook has no timeout of at most 60 s (a hung guard would stall every call for the 600 s default)`);
    }
  }
  return problems;
}

// nodePath "node": the program the registration names, found on PATH as Claude Code finds it.
// File-tool probes, built for the guard being probed: an edit of its own .claude/settings.json
// must ask, a write outside it must get no decision. `label` keeps paths out of messages.
export function fileProbes(guardPath) {
  return [
    { tool: "Edit", filePath: path.resolve(path.dirname(guardPath), "..", "settings.json"), label: ".claude/settings.json", expect: "ask" },
    { tool: "Write", filePath: path.join(os.tmpdir(), "hook-selfcheck-probe.txt"), label: "a file outside .claude", expect: "none" },
  ];
}

export function runProbe(probe, { cwd, nodePath = "node", guardPath = GUARD, timeoutMs = 15_000 } = {}) {
  const toolInput = probe.filePath ? { file_path: probe.filePath } : { command: probe.command };
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: probe.tool, tool_input: toolInput, cwd, session_id: "hook-selfcheck" });
  probe = { ...probe, command: probe.label ?? probe.command };
  const r = spawnSync(nodePath, [guardPath], { input, encoding: "utf8", timeout: timeoutMs, windowsHide: true });
  if (r.error) return { problem: `the guard could not run for "${probe.command}" (${r.error.code || "error"})` };
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

export function selfCheck({ cwd = process.cwd(), settingsPath = SETTINGS, guardPath = registeredGuardPath(), nodePath = "node", env = process.env } = {}) {
  const problems = [];
  if (!fs.existsSync(guardPath)) problems.push(".claude/hooks/safety-guard.mjs is missing at the registered path");
  try {
    problems.push(...checkSettings(fs.readFileSync(settingsPath, "utf8")));
  } catch (error) {
    problems.push(`.claude/settings.json could not be read (${error.code || "error"})`);
  }
  const nodeOptions = nodeOptionsProblem(env);
  if (nodeOptions) problems.push(nodeOptions);
  if (fs.existsSync(guardPath)) {
    for (const probe of [...PROBES, ...fileProbes(guardPath)]) {
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
        additionalContext: `Safety hook self-check passed: safety-guard.mjs is registered for Bash, PowerShell, the file tools and mcp__.* with "onFailure": "block", hooks are not disabled in the project settings, and, run at its registered path, the guard decided its ${PROBES.length + 2} probe calls as expected. (A session start without this line or a SAFETY HOOK SELF-CHECK FAILED warning means the check did not run: treat it as failed.)`,
      },
    };
  }
  const text = `SAFETY HOOK SELF-CHECK FAILED - the PreToolUse guard (.claude/hooks/safety-guard.mjs) may not be protecting this session: ${problems.join("; ")}. Commands that settings.json allows by name (rm, cp, mv, git add / commit / push) could run without the guard's checks. Stop and fix this before running shell commands; see .claude/hooks/README.md "If the hook does not run".`;
  return {
    systemMessage: text,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  };
}

// Real paths on both sides, as in safety-guard.mjs: node resolves symlinks in import.meta.url
// but not in argv[1], and a plain comparison made this check silent behind a symlink.
function isMainModule() {
  if (!process.argv[1]) return false;
  // native first (it also returns the on-disk letter case), then the JS version (it still
  // follows symlinks where the native call fails), and only then the plain path
  const real = (p) => {
    for (const resolve of [fs.realpathSync.native, fs.realpathSync]) {
      try {
        return resolve(p);
      } catch {
        // try the next
      }
    }
    return path.resolve(p);
  };
  const invoked = real(path.resolve(process.argv[1]));
  const thisFile = real(fileURLToPath(import.meta.url));
  return process.platform === "win32" ? invoked.toLowerCase() === thisFile.toLowerCase() : invoked === thisFile;
}

// Two ways to run it: as the SessionStart hook (Claude Code sends the event on stdin; always
// exit 0, a non-zero exit would drop the warning), or by hand from the project root
// (`node .claude/hooks/hook-selfcheck.mjs`, e.g. in a session that started before this check
// existed): no stdin is read from a terminal, and a failure exits 1.
if (isMainModule()) {
  let cwd = process.cwd();
  let asHook = false;
  if (!process.stdin.isTTY) {
    try {
      const input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
      asHook = input?.hook_event_name === "SessionStart";
      if (typeof input.cwd === "string" && input.cwd) cwd = input.cwd;
    } catch {
      // no or unreadable input: a manual run, probing from the current directory
    }
  }
  let problems;
  try {
    problems = selfCheck({ cwd });
  } catch (error) {
    problems = [`the self-check itself failed (${error?.code || error?.name || "error"})`];
  }
  process.stdout.write(`${JSON.stringify(sessionStartOutput(problems))}\n`);
  process.exit(asHook || !problems.length ? 0 : 1);
}
