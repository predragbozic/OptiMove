import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync } from "node:fs";

import {
  classifyToolCall,
  classifyShellCommand,
  classifyMcpToolCall,
  splitCommandSegments,
  stripLeadingEnvAssignments,
  unwrapInterpreterCommand,
  isGitCheckoutDiscardingWork,
  isGitRestoreDiscardingWork,
  isGitStashDestructive,
  runCli,
} from "./safety-guard.mjs";

// ------------------------------------------------------------------
// Table-driven core coverage — feeds JSON tool-call objects directly into
// classifyToolCall(), exactly what the hook's stdin JSON deserializes to. No
// contained command is ever actually executed here.
// ------------------------------------------------------------------

function bash(command, cwd) {
  return { tool_name: "Bash", tool_input: { command }, cwd };
}
function pwsh(command, cwd) {
  return { tool_name: "PowerShell", tool_input: { command }, cwd };
}

const DENY = "deny";
const ASK = "ask";
const ALLOW = null; // no decision at all — the hook stays silent

const CASES = [
  // ---- DENY: broad git add ----
  ["git add . (bash)", bash("git add ."), DENY],
  ["git add -A", bash("git add -A"), DENY],
  ["git add --all", bash("git add --all"), DENY],
  ["git -C <path> add .", bash('git -C /repo add .'), DENY],
  ["GIT ADD . (uppercase)", bash("GIT ADD ."), DENY],
  ["git add . with extra whitespace", bash("git   add    ."), DENY],
  ["git add . followed by explicit file (bare dot still present)", bash("git add . src/foo.js"), DENY],
  ["git add \".\" quoted", bash('git add "."'), DENY],

  // ---- ALLOW: explicit git add ----
  ["git add explicit single file", bash("git add file.js"), ALLOW],
  ["git add explicit multiple files", bash("git add src/foo.js src/bar.js"), ALLOW],
  ["git add dotfile that merely starts with a dot", bash("git add .env.example"), ALLOW],
  ["git add ./explicit/relative/file.js", bash("git add ./explicit/relative/file.js"), ALLOW],

  // ---- DENY: git reset --hard ----
  ["git reset --hard (bare)", bash("git reset --hard"), DENY],
  ["git reset --hard HEAD~3", bash("git reset --hard HEAD~3"), DENY],
  ["git reset --hard origin/main", bash("git reset --hard origin/main"), DENY],

  // ---- ALLOW: git reset --soft/--mixed ----
  ["git reset --soft HEAD~1", bash("git reset --soft HEAD~1"), ALLOW],
  ["git reset (bare, mixed default)", bash("git reset"), ALLOW],

  // ---- DENY: git clean force, no dry-run ----
  ["git clean -fd", bash("git clean -fd"), DENY],
  ["git clean -fdx", bash("git clean -fdx"), DENY],
  ["git clean --force", bash("git clean --force"), DENY],

  // ---- ALLOW: git clean dry-run (even combined with force) ----
  ["git clean -n dry-run", bash("git clean -n"), ALLOW],
  ["git clean --dry-run", bash("git clean --dry-run"), ALLOW],
  ["git clean -ndf (dry-run wins over combined force)", bash("git clean -ndf"), ALLOW],

  // ---- DENY: git push --force ----
  ["git push --force", bash("git push --force"), DENY],
  ["git push --force-with-lease", bash("git push --force-with-lease"), DENY],
  ["git push -f origin main", bash("git push -f origin main"), DENY], // force wins even though target is also main

  // ---- ALLOW: normal feature push ----
  ["git push origin feature/foo", bash("git push origin feature/foo"), ALLOW],

  // ---- DENY: recursive root delete (Unix) ----
  ["rm -rf /", bash("rm -rf /"), DENY],
  ["rm -rf ~", bash("rm -rf ~"), DENY],
  ["rm -rf .", bash("rm -rf ."), DENY],
  ["rm -rf $HOME", bash("rm -rf $HOME"), DENY],
  ["rm -fr . (flags reversed)", bash("rm -fr ."), DENY],

  // ---- ALLOW: scoped delete ----
  ["rm -rf node_modules", bash("rm -rf node_modules"), ALLOW],
  ["rm -rf ./dist/subdir", bash("rm -rf ./dist/subdir"), ALLOW],

  // ---- DENY: recursive root delete (PowerShell) ----
  ["Remove-Item -Recurse -Force C:\\", pwsh("Remove-Item -Recurse -Force C:\\"), DENY],
  ["remove-item -recurse -force . (lowercase)", pwsh("remove-item -recurse -force ."), DENY],
  ["Remove-Item -Recurse -Force (no path, defaults to cwd)", pwsh("Remove-Item -Recurse -Force"), DENY],
  ["Remove-Item -Recu -Fo C:\\ (unambiguous PowerShell abbreviation)", pwsh("Remove-Item -Recu -Fo C:\\"), DENY],

  // ---- ALLOW: scoped PowerShell delete ----
  ["Remove-Item -Recurse -Force .\\dist", pwsh("Remove-Item -Recurse -Force .\\dist"), ALLOW],
  // -Filter contains the letters 'r'/'f' but is NOT an abbreviation of -Recurse/-Force —
  // must not be misread as recursive just because of stray letters in an unrelated flag.
  ["Remove-Item -Filter *.tmp -Force C:\\ (unrelated flag must not imply -Recurse)", pwsh("Remove-Item -Filter *.tmp -Force C:\\"), ALLOW],

  // ---- DENY: destructive checkout/restore (discards uncommitted work) ----
  ["git checkout -- . (discard all)", bash("git checkout -- ."), DENY],
  ["git checkout . (bare dot, discard)", bash("git checkout ."), DENY],
  ["git checkout -- src/foo.js (discard one file)", bash("git checkout -- src/foo.js"), DENY],
  ["git checkout HEAD -- . (discard to a ref)", bash("git checkout HEAD -- ."), DENY],
  ["git checkout --force . (force flag, still a discard)", bash("git checkout --force ."), DENY],
  ["git restore . (discard working tree)", bash("git restore ."), DENY],
  ["git restore src/foo.js (discard one file)", bash("git restore src/foo.js"), DENY],
  ["git restore --worktree . (explicit worktree restore)", bash("git restore --worktree ."), DENY],
  ["psql -f <file> (SQL content not visible on the command line)", bash('psql $DATABASE_URL -f fix_prod_rows.sql'), ASK],

  // Branch-switch checkout tests (`git checkout main`/`<existing-branch>`) need a real,
  // controlled git repo to verify the token against — see the branch-aware section below
  // rather than this cwd-independent table (this process's own cwd is *a* real repo, but
  // asserting behavior against branches that happen to exist there is fragile/coincidental).

  // ---- ALLOW: normal checkout/restore (create branch, unstage-only) ----
  ["git checkout -b new-branch (create branch)", bash("git checkout -b new-branch"), ALLOW],
  ["git restore --staged . (unstage only, worktree untouched)", bash("git restore --staged ."), ALLOW],
  ["git restore --staged src/foo.js (unstage only)", bash("git restore --staged src/foo.js"), ALLOW],
  ["git restore -S file.js (short form of --staged)", bash("git restore -S file.js"), ALLOW],

  // ---- DENY: destructive stash (irreversibly deletes stash entries) ----
  ["git stash drop", bash("git stash drop"), DENY],
  ["git stash clear", bash("git stash clear"), DENY],
  ["git stash drop stash@{0}", bash("git stash drop stash@{0}"), DENY],

  // ---- ALLOW: reversible stash operations ----
  ["git stash (bare, reversible)", bash("git stash"), ALLOW],
  ["git stash push", bash("git stash push"), ALLOW],
  ["git stash pop", bash("git stash pop"), ALLOW],
  ["git stash apply", bash("git stash apply"), ALLOW],
  ["git stash list", bash("git stash list"), ALLOW],

  // ---- ASK: merge/rebase/pr-merge ----
  ["git merge feature/x", bash("git merge feature/x"), ASK],
  ["git rebase main", bash("git rebase main"), ASK],
  ["gh pr merge 78", bash("gh pr merge 78"), ASK],

  // ---- ASK: explicit push to main ----
  ["git push origin main", bash("git push origin main"), ASK],
  ["git push origin HEAD:main", bash("git push origin HEAD:main"), ASK],

  // ---- ASK: deploy commands ----
  ["vercel --prod", bash("vercel --prod"), ASK],
  ["vercel deploy", bash("vercel deploy"), ASK],
  ["wrangler deploy", bash("wrangler deploy"), ASK],
  ["wrangler pages deploy", bash("wrangler pages deploy"), ASK],
  ["supabase db push", bash("supabase db push"), ASK],
  ["npx supabase functions deploy", bash("npx supabase functions deploy"), ASK],
  ["render deploy", bash("render deploy"), ASK],

  // ---- ASK: migration runner ----
  ["node backend/src/migrate.js", bash("node backend/src/migrate.js"), ASK],
  ["npm run migrate", bash("npm run migrate"), ASK],
  ["npm --prefix backend run migrate", bash("npm --prefix backend run migrate"), ASK],
  ["npm start (chains migrate.js in this repo)", bash("npm start"), ASK],

  // ---- ALLOW: dev/build/test, NOT migration ----
  ["npm run dev (no migrate step)", bash("npm run dev"), ALLOW],
  ["npm test", bash("npm test"), ALLOW],
  ["vite build", bash("vite build"), ALLOW],

  // ---- ASK: explicit SQL write ----
  ["psql INSERT", bash('psql $DATABASE_URL -c "INSERT INTO foo VALUES (1)"'), ASK],
  ["psql DROP TABLE", bash('psql -c "DROP TABLE foo"'), ASK],
  ["psql UPDATE", bash('psql -c "UPDATE foo SET x = 1"'), ASK],
  ["psql TRUNCATE", bash('psql -c "TRUNCATE foo"'), ASK],

  // ---- ALLOW: read-only SQL ----
  ["psql SELECT", bash('psql $DATABASE_URL -c "SELECT * FROM foo"'), ALLOW],
  ["psql EXPLAIN", bash('psql -c "EXPLAIN SELECT 1"'), ALLOW],

  // ---- DENY/ASK still fire with an arbitrary git GLOBAL option before the subcommand ----
  // Previously only a single, specific `-C <dir>` was tolerated between `git` and the
  // subcommand — any other global flag (a very ordinary habit, e.g. `--no-pager` to
  // avoid an interactive pager in a scripted/agent context) made every check below miss
  // entirely. These prove the fix, not just the already-covered plain forms.
  ["git --no-pager reset --hard (global flag before subcommand)", bash("git --no-pager reset --hard"), DENY],
  ["git -p reset --hard (bare global flag, no value)", bash("git -p reset --hard"), DENY],
  ["git -c a=1 -c b=2 push --force (multiple -c globals)", bash("git -c a=1 -c b=2 push --force"), DENY],
  ["git --no-pager stash drop (global flag before subcommand)", bash("git --no-pager stash drop"), DENY],
  ["git --git-dir=/repo/.git push --force (inline = global flag)", bash("git --git-dir=/repo/.git push --force"), DENY],
  ["git --no-pager merge feature/x (global flag before ask-worthy subcommand)", bash("git --no-pager merge feature/x"), ASK],
  ["git -C /repo --no-pager status (global flags before a safe command)", bash("git -C /repo --no-pager status"), ALLOW],
  // Bare `--exec-path` (no `=`) takes NO following value in real git (unlike -C/-c/
  // --git-dir/...) — must not swallow the next token (which could be the subcommand).
  ["git --exec-path=/usr/lib/git reset --hard (inline = form, still denies)", bash("git --exec-path=/usr/lib/git reset --hard"), DENY],
  ["git --exec-path reset --hard (bare form takes no value, must still deny)", bash("git --exec-path reset --hard"), DENY],

  // ---- DENY/ASK still fire when the risky command is wrapped in another interpreter ----
  // `bash -c "..."`/`powershell -Command "..."`/`cmd /c "..."` are ordinary habits (e.g.
  // working around a shell's own quoting rules), not adversarial tricks — a segment
  // starting with the wrapper interpreter's name, not `git`/`rm`, must not silently skip
  // every check below.
  ["bash -c \"git reset --hard\" (interpreter-wrapped deny)", bash('bash -c "git reset --hard"'), DENY],
  ["sh -c 'git add .' (interpreter-wrapped deny, single-quoted)", bash("sh -c 'git add .'"), DENY],
  ["cmd /c \"git push --force\" (interpreter-wrapped deny)", bash('cmd /c "git push --force"'), DENY],
  ["powershell -Command \"git merge feature/x\" (interpreter-wrapped ask)", bash('powershell -Command "git merge feature/x"'), ASK],
  ["bash -c \"npm test\" (interpreter-wrapped safe command)", bash('bash -c "npm test"'), ALLOW],

  // ---- ASK still fires with a leading env-var assignment before a governed command ----
  ["DATABASE_URL=... npm run migrate (env-prefixed migration)", bash("DATABASE_URL=postgres://x npm run migrate"), ASK],
  ["GIT_PAGER=cat git reset --hard (env-prefixed git deny)", bash("GIT_PAGER=cat git reset --hard"), DENY],

  // ---- ALLOW: git read-only / normal workflow ----
  ["git status", bash("git status"), ALLOW],
  ["git status --short", bash("git status --short"), ALLOW],
  ["git diff", bash("git diff"), ALLOW],
  ["git log --oneline", bash("git log --oneline"), ALLOW],
  ["git branch --show-current", bash("git branch --show-current"), ALLOW],
  ["git show HEAD", bash("git show HEAD"), ALLOW],

  // ---- ALLOW: quoted content that merely mentions a risky phrase ----
  ["commit message mentioning 'git add .' in quotes", bash('git commit -m "fix: git add . in docs"'), ALLOW],
  ["commit message mentioning 'rm -rf /' in quotes", bash('git commit -m "note: never run rm -rf / in prod"'), ALLOW],

  // ---- Chaining: &&, ; still catch the risky segment ----
  ["cd repo && git add . (&& chain)", bash("cd repo && git add ."), DENY],
  ["cd repo; git add . (; chain)", bash("cd repo; git add ."), DENY],
  ["npm test && git push origin main (chain reaches ask-worthy segment)", bash("npm test && git push origin main"), ASK],

  // ---- Non-shell tools: never touched by this guard ----
  ["Read tool untouched", { tool_name: "Read", tool_input: { file_path: "foo.js" } }, ALLOW],
  ["Grep tool untouched", { tool_name: "Grep", tool_input: { pattern: "git add ." } }, ALLOW],

  // ---- MCP Supabase tool-name-suffix matching ----
  ["mcp apply_migration", { tool_name: "mcp__abc123__apply_migration", tool_input: {} }, ASK],
  ["mcp deploy_edge_function", { tool_name: "mcp__abc123__deploy_edge_function", tool_input: {} }, ASK],
  ["mcp merge_branch", { tool_name: "mcp__abc123__merge_branch", tool_input: {} }, ASK],
  ["mcp reset_branch", { tool_name: "mcp__abc123__reset_branch", tool_input: {} }, ASK],
  ["mcp delete_branch", { tool_name: "mcp__abc123__delete_branch", tool_input: {} }, ASK],
  ["mcp execute_sql SELECT", { tool_name: "mcp__abc123__execute_sql", tool_input: { query: "select * from t" } }, ALLOW],
  ["mcp execute_sql INSERT", { tool_name: "mcp__abc123__execute_sql", tool_input: { query: "insert into t values (1)" } }, ASK],
  ["mcp execute_sql unrecognized field (fail-safe)", { tool_name: "mcp__abc123__execute_sql", tool_input: { unrelated: "x" } }, ASK],
  ["mcp create_branch left alone (disposable-by-nature)", { tool_name: "mcp__abc123__create_branch", tool_input: {} }, ALLOW],
];

test("table-driven classification scenarios", async (t) => {
  for (const [name, input, expected] of CASES) {
    await t.test(name, () => {
      const result = classifyToolCall(input);
      const actual = result ? result.decision : null;
      assert.equal(actual, expected, `expected ${expected ?? "allow(no-decision)"}, got ${actual ?? "allow(no-decision)"}${result ? ` (reason: ${result.reason})` : ""}`);
    });
  }
});

test(`table has at least 30 scenarios (has ${CASES.length})`, () => {
  assert.ok(CASES.length >= 30, `expected >= 30 scenarios, found ${CASES.length}`);
});

test("scenario mix includes DENY, ASK, and ALLOW cases", () => {
  const counts = { deny: 0, ask: 0, allow: 0 };
  for (const [, , expected] of CASES) {
    if (expected === DENY) counts.deny += 1;
    else if (expected === ASK) counts.ask += 1;
    else counts.allow += 1;
  }
  assert.ok(counts.deny >= 5, `expected >= 5 deny cases, found ${counts.deny}`);
  assert.ok(counts.ask >= 5, `expected >= 5 ask cases, found ${counts.ask}`);
  assert.ok(counts.allow >= 5, `expected >= 5 allow cases, found ${counts.allow}`);
});

// ------------------------------------------------------------------
// Branch-aware cases (push/commit to main) — these need a real git repo,
// since "can the hook safely determine the active branch" is the whole point.
// ------------------------------------------------------------------

let repoDir;

before(() => {
  repoDir = mkdtempSync(path.join(tmpdir(), "safety-guard-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: repoDir });
});

after(() => {
  if (repoDir) rmSync(repoDir, { recursive: true, force: true });
});

test("git commit while on main asks for confirmation", () => {
  const result = classifyToolCall(bash("git commit -m wip", repoDir));
  assert.equal(result?.decision, "ask");
});

test("bare 'git push' while on main asks for confirmation", () => {
  const result = classifyToolCall(bash("git push", repoDir));
  assert.equal(result?.decision, "ask");
});

test("'git -c key=value commit' while on main still asks (lowercase -c must not be misread as -C <dir>)", () => {
  // Regression test: -C (a directory override) and -c (a one-off config override) are
  // two different git global options distinguished only by case. A case-insensitive
  // match on -C previously captured -c's config value as if it were a cwd override,
  // corrupting getCurrentBranch's cwd (ENOENT) and silently defeating this exact check.
  const result = classifyToolCall(bash("git -c user.name=x commit -m wip", repoDir));
  assert.equal(result?.decision, "ask");
});

test("bare 'git -c key=value push' while on main still asks (same -C/-c regression)", () => {
  const result = classifyToolCall(bash("git -c user.name=x push", repoDir));
  assert.equal(result?.decision, "ask");
});

test("git commit on a feature branch is allowed", () => {
  execFileSync("git", ["checkout", "-q", "-b", "feature/x"], { cwd: repoDir });
  const result = classifyToolCall(bash("git commit -m wip", repoDir));
  assert.equal(result, null);
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repoDir });
});

test("git checkout main (existing branch, verified via git) is allowed", () => {
  const result = classifyToolCall(bash("git checkout main", repoDir));
  assert.equal(result, null);
});

test("git checkout feature/x (existing branch created in setup, verified via git) is allowed", () => {
  const result = classifyToolCall(bash("git checkout feature/x", repoDir));
  assert.equal(result, null);
});

test("git checkout <unrecognized token> (not a real branch/ref) is denied, not assumed safe", () => {
  const result = classifyToolCall(bash("git checkout totally-unknown-branch-xyz", repoDir));
  assert.equal(result?.decision, "deny");
});

test("git checkout <tracked file path> without -- is denied (real discard risk, not a branch switch)", () => {
  writeFileSync(path.join(repoDir, "tracked.js"), "// initial\n");
  execFileSync("git", ["add", "tracked.js"], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "add tracked.js"], { cwd: repoDir });
  const result = classifyToolCall(bash("git checkout tracked.js", repoDir));
  assert.equal(result?.decision, "deny", "a tracked file path, not a valid revision, must not be silently treated as a safe branch switch");
});

test("commit/push-to-main checks degrade to 'unknown, don't ask' outside any git repo", () => {
  const nonRepoDir = mkdtempSync(path.join(tmpdir(), "safety-guard-non-repo-"));
  try {
    const commitResult = classifyToolCall(bash("git commit -m wip", nonRepoDir));
    const pushResult = classifyToolCall(bash("git push", nonRepoDir));
    assert.equal(commitResult, null);
    assert.equal(pushResult, null);
  } finally {
    rmSync(nonRepoDir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------
// CLI wiring: JSON in via string (as if from stdin), JSON out via captured stdout
// ------------------------------------------------------------------

function captureStdout(fn) {
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
    out += chunk;
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return out;
}

test("runCli emits a deny decision for a deny-worthy command", () => {
  const out = captureStdout(() => runCli(JSON.stringify(bash("git reset --hard"))));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("runCli tolerates a leading UTF-8 BOM on stdin (observed in practice via a .NET/PowerShell-spawned child process on Windows)", () => {
  const withBom = "﻿" + JSON.stringify(bash("git reset --hard"));
  const out = captureStdout(() => runCli(withBom));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny", "a BOM before the JSON must not make this fail closed to 'ask' on every single call");
});

test("runCli emits nothing for a safe command", () => {
  const out = captureStdout(() => runCli(JSON.stringify(bash("npm test"))));
  assert.equal(out, "");
});

test("runCli fails closed (ask) on malformed JSON, without echoing the raw input", () => {
  const out = captureStdout(() => runCli("{this is not json"));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
  assert.ok(!parsed.hookSpecificOutput.permissionDecisionReason.includes("{this is not json"));
});

test("runCli fails closed (ask) on empty stdin", () => {
  const out = captureStdout(() => runCli(""));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
});

test("runCli fails closed (ask) on a JSON object truncated mid-object (incomplete, not just malformed)", () => {
  const out = captureStdout(() => runCli('{"tool_name": "Bash", "tool_input": {"command": "git reset'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
});

test("a Bash/PowerShell call with a missing 'command' field asks, not silently allows", () => {
  const result = classifyToolCall({ tool_name: "Bash", tool_input: {} });
  assert.equal(result?.decision, "ask", "no recognizable command field must not be treated as an empty, harmless command");
});

test("a Bash call with a non-string 'command' field (e.g. a number) asks, not silently allows", () => {
  const result = classifyToolCall({ tool_name: "Bash", tool_input: { command: 12345 } });
  assert.equal(result?.decision, "ask");
});

test("a Bash call with a genuinely empty string command is silently allowed (nothing to run, nothing to ask about)", () => {
  const result = classifyToolCall({ tool_name: "Bash", tool_input: { command: "   " } });
  assert.equal(result, null);
});

// ------------------------------------------------------------------
// Secret-safety: a deny/ask reason must never contain the raw command text (which
// could itself contain a password/token typed inline, e.g. inside a connection string).
// ------------------------------------------------------------------

test("deny/ask reasons never echo the raw command (potential secret leakage)", () => {
  const secretish = 'psql "postgresql://user:sUp3rSecr3t@host/db" -c "DROP TABLE foo"';
  const result = classifyShellCommand(secretish, process.cwd());
  assert.equal(result?.decision, "ask");
  assert.ok(!result.reason.includes("sUp3rSecr3t"));
  assert.ok(!result.reason.includes(secretish));
});

test("mcp reasons never echo raw tool_input", () => {
  const result = classifyMcpToolCall("mcp__abc__execute_sql", { query: "INSERT INTO secrets VALUES ('sUp3rSecr3t')" });
  assert.equal(result?.decision, "ask");
  assert.ok(!result.reason.includes("sUp3rSecr3t"));
});

// ------------------------------------------------------------------
// splitCommandSegments: the quote-aware chaining splitter itself
// ------------------------------------------------------------------

test("splitCommandSegments respects quoted && / ; inside strings", () => {
  const segments = splitCommandSegments('git commit -m "a && b; c" && git push');
  assert.deepEqual(segments, ['git commit -m "a && b; c"', "git push"]);
});

test("splitCommandSegments splits on bare &&, ;, ||, |", () => {
  assert.deepEqual(splitCommandSegments("a && b; c || d | e"), ["a", "b", "c", "d", "e"]);
});

test("splitCommandSegments does not let a backslash-escaped quote hide a chained dangerous command", () => {
  // Inside double quotes, `\"` is POSIX-escaped (stays part of the string, doesn't close
  // it) — the string `"\""` closes at its own real trailing `"`, and the `&& git add .`
  // after it is a real, separate command. A naive quote-toggle that treats `\"` as a real
  // closing quote would merge everything after it into one `echo`-led segment and hide
  // `git add .` from every DENY check.
  const segments = splitCommandSegments('echo "\\"" && git add .');
  assert.ok(
    segments.some((s) => /^git\s+add\b/i.test(s)),
    `expected a separate 'git add .' segment, got: ${JSON.stringify(segments)}`,
  );
  assert.deepEqual(segments, ['echo "\\""', "git add ."]);
});

test("splitCommandSegments handles an escaped backslash immediately before a real closing quote", () => {
  // `"C:\\\\"` (escaped backslash + real closing quote) must close the string at the real
  // quote, not misread the preceding backslash run as escaping it away.
  const segments = splitCommandSegments('echo "C:\\\\" && git push --force');
  assert.ok(
    segments.some((s) => /^git\s+push\b/i.test(s)),
    `expected a separate 'git push --force' segment, got: ${JSON.stringify(segments)}`,
  );
});

test("stripLeadingEnvAssignments strips one or more leading VAR=value assignments", () => {
  assert.equal(stripLeadingEnvAssignments("DATABASE_URL=postgres://x npm run migrate"), "npm run migrate");
  assert.equal(stripLeadingEnvAssignments("A=1 B=2 git reset --hard"), "git reset --hard");
  assert.equal(stripLeadingEnvAssignments("git status"), "git status");
});

// ------------------------------------------------------------------
// Direct edge-case coverage for the destructive checkout/restore/stash helpers — beyond
// what the table above exercises via full classifyToolCall(), these confirm the
// "no target / no-op" paths return false rather than throwing or false-DENYing.
// ------------------------------------------------------------------

test("isGitCheckoutDiscardingWork: bare '--' with nothing after it is not a discard", () => {
  assert.equal(isGitCheckoutDiscardingWork("git checkout --"), false);
});

test("isGitRestoreDiscardingWork: no pathspec at all is not a discard", () => {
  assert.equal(isGitRestoreDiscardingWork("git restore"), false);
});

test("isGitStashDestructive: unrelated 'git status' segment does not match", () => {
  assert.equal(isGitStashDestructive("git status"), false);
});

test("unwrapInterpreterCommand: extracts the inner command from bash/sh/powershell/cmd wrappers", () => {
  assert.equal(unwrapInterpreterCommand('bash -c "git reset --hard"'), "git reset --hard");
  assert.equal(unwrapInterpreterCommand("sh -c 'git add .'"), "git add .");
  assert.equal(unwrapInterpreterCommand('powershell -Command "Remove-Item -Recurse -Force C:\\"'), "Remove-Item -Recurse -Force C:\\");
  assert.equal(unwrapInterpreterCommand('cmd /c "git push --force"'), "git push --force");
});

test("unwrapInterpreterCommand: an ordinary command that isn't an interpreter wrapper returns null", () => {
  assert.equal(unwrapInterpreterCommand("git status"), null);
  assert.equal(unwrapInterpreterCommand("npm test"), null);
});

// ------------------------------------------------------------------
// Criterion: recognition of Windows/POSIX command forms must not depend on any
// case-sensitive environment-variable name. This hook classifies purely from
// tool_name/tool_input JSON fields and process.platform — never process.env — so
// polluting process.env with unrelated/conflicting-case variables must have zero effect
// on classification. Proven directly here rather than just asserted by code review.
// ------------------------------------------------------------------

test("classification is unaffected by conflicting-case environment variables (no env-var-name dependency)", () => {
  const saved = { OS: process.env.OS, os: process.env.os, Path: process.env.Path, PATH: process.env.PATH };
  try {
    process.env.OS = "not-windows-nt-at-all";
    process.env.os = "totally different value";
    process.env.Path = "";
    delete process.env.PATH;

    const denyResult = classifyToolCall(pwsh("Remove-Item -Recurse -Force C:\\"));
    assert.equal(denyResult?.decision, "deny", "Windows-shaped PowerShell command must still classify correctly");

    const askResult = classifyToolCall(bash("git merge feature/x"));
    assert.equal(askResult?.decision, "ask", "POSIX bash command must still classify correctly");

    const allowResult = classifyToolCall(bash("npm test"));
    assert.equal(allowResult, null, "safe command must still be allowed (no decision)");
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// ------------------------------------------------------------------
// settings.json's exec-form registration contract — a shell-form command string
// (`"command": "node \"$CLAUDE_PROJECT_DIR/...\""`) is unreliable on Windows because
// PowerShell doesn't interpolate a bare `$CLAUDE_PROJECT_DIR` the way POSIX bash does.
// Exec form (`"command": "node", "args": [...]`) bypasses the shell entirely — Claude
// Code substitutes `${CLAUDE_PROJECT_DIR}` itself and spawns the executable directly, so
// there is no shell-interpolation step to differ between Bash and PowerShell tool
// invocations. This test proves the actual on-disk contract, not just the intent.
// ------------------------------------------------------------------

test("settings.json uses the exact exec-form contract: 3 matchers, command:'node', identical single-arg args, no shell-form, no bare $CLAUDE_PROJECT_DIR", () => {
  const settingsPath = fileURLToPath(new URL("./settings.json", new URL("../", import.meta.url)));
  const raw = readFileSync(settingsPath, "utf8");
  const settings = JSON.parse(raw);

  // A bare, unbraced $CLAUDE_PROJECT_DIR only ever meant anything in the old shell-form
  // string (where a shell would interpolate it) — exec form only recognizes the braced
  // ${CLAUDE_PROJECT_DIR} placeholder, so any surviving bare occurrence is dead shell-form
  // wreckage, not something Claude Code will ever substitute.
  assert.ok(!/\$CLAUDE_PROJECT_DIR(?!\})/.test(raw), `no bare (unbraced) $CLAUDE_PROJECT_DIR may remain in settings.json, found in: ${raw}`);
  assert.ok(!/"command"\s*:\s*"node /.test(raw), "no old shell-form 'command': 'node ...' single-string entry may remain");

  const expectedMatchers = ["Bash", "PowerShell", "mcp__.*"];
  assert.equal(
    settings.hooks.PreToolUse.length,
    expectedMatchers.length,
    `expected exactly ${expectedMatchers.length} PreToolUse entries, got ${settings.hooks.PreToolUse.length}: ${JSON.stringify(settings.hooks.PreToolUse.map((h) => h.matcher))}`,
  );

  let previousArgs = null;
  for (const matcher of expectedMatchers) {
    const entry = settings.hooks.PreToolUse.find((h) => h.matcher === matcher);
    assert.ok(entry, `expected a PreToolUse entry with matcher "${matcher}"`);
    assert.equal(entry.hooks.length, 1, `matcher "${matcher}" must register exactly one hook`);
    const hook = entry.hooks[0];
    assert.equal(hook.type, "command");
    assert.equal(hook.command, "node", `matcher "${matcher}" must use exec-form command "node" (a bare executable name), not a shell-command string`);
    assert.ok(Array.isArray(hook.args), `matcher "${matcher}" must have an args array (exec form)`);
    assert.equal(hook.args.length, 1, `matcher "${matcher}" must have exactly one argument, got: ${JSON.stringify(hook.args)}`);
    assert.equal(hook.args[0], "${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs");
    if (previousArgs !== null) {
      assert.deepEqual(hook.args, previousArgs, `matcher "${matcher}"'s args must be identical to the other matchers' args (no duplicated/diverging implementations)`);
    }
    previousArgs = hook.args;
  }
});

test("subprocess: the exact exec-form command+args registered in .claude/settings.json runs and emits a valid decision", () => {
  const settingsPath = fileURLToPath(new URL("./settings.json", new URL("../", import.meta.url)));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const bashHook = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash").hooks[0];
  assert.equal(bashHook.type, "command");
  assert.equal(bashHook.command, "node");

  const projectDir = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
  const resolvedArgs = bashHook.args.map((a) => a.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, projectDir));

  // execFileSync with an array of args (no shell: true) is the same no-shell invocation
  // shape exec form uses — this is a faithful reproduction, not a reconstruction.
  const out = execFileSync(bashHook.command, resolvedArgs, {
    input: JSON.stringify(bash("git reset --hard")),
    encoding: "utf8",
    timeout: 5000,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("settings.json registers a PreToolUse matcher that actually fires for mcp__* tool calls", () => {
  // classifyMcpToolCall() being correct is worthless if Claude Code never invokes this
  // hook for an MCP tool call in the first place — PreToolUse only runs for a tool name
  // that matches one of settings.json's own `matcher` entries. Without a matcher covering
  // `mcp__*`, every Supabase apply_migration/reset_branch/delete_branch/execute_sql-write
  // classification in this file is correct logic that Claude Code never actually calls.
  const settingsPath = fileURLToPath(new URL("./settings.json", new URL("../", import.meta.url)));
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const mcpHook = settings.hooks.PreToolUse.find((h) => {
    try {
      return new RegExp(h.matcher).test("mcp__4ed6a170-3ffe-4d06-8edf-2479542e8b09__apply_migration");
    } catch {
      return h.matcher === "mcp__4ed6a170-3ffe-4d06-8edf-2479542e8b09__apply_migration";
    }
  });
  assert.ok(mcpHook, `expected a PreToolUse matcher covering mcp__* tool names, got matchers: ${JSON.stringify(settings.hooks.PreToolUse.map((h) => h.matcher))}`);
  const bashEntry = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash").hooks[0];
  assert.equal(mcpHook.hooks[0].command, bashEntry.command, "the MCP matcher should run the same node executable as Bash/PowerShell");
  assert.deepEqual(mcpHook.hooks[0].args, bashEntry.args, "the MCP matcher should run the same safety-guard.mjs args as Bash/PowerShell");
});

// ------------------------------------------------------------------
// Real subprocess invocation — spawns `node safety-guard.mjs` the same no-shell way
// settings.json's exec-form hook does (`command: "node"`, `args: ["${CLAUDE_PROJECT_DIR}/
// .claude/hooks/safety-guard.mjs"]`), piping JSON in via real stdin and reading real
// stdout back. This is the only thing that actually exercises isMainModule() and the
// top-level stdin-read path — every other test above imports the module's pure functions
// directly and never touches that code at all.
// ------------------------------------------------------------------

const hookPath = fileURLToPath(new URL("./safety-guard.mjs", import.meta.url));

function runHookSubprocess(inputJson) {
  return execFileSync("node", [hookPath], {
    input: inputJson,
    encoding: "utf8",
    timeout: 5000,
  });
}

test("subprocess: real `node safety-guard.mjs` invocation emits a deny decision for a deny-worthy command", () => {
  const out = runHookSubprocess(JSON.stringify(bash("git reset --hard")));
  assert.ok(out.trim().length > 0, "expected JSON output on stdout, got nothing - isMainModule() likely failed to fire");
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("subprocess: real invocation emits nothing on stdout for a safe command", () => {
  const out = runHookSubprocess(JSON.stringify(bash("npm test")));
  assert.equal(out, "");
});

test("subprocess: real invocation fails closed (ask) on malformed JSON", () => {
  const out = runHookSubprocess("{not valid json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
});
