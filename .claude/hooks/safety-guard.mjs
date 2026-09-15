#!/usr/bin/env node
// Deterministic PreToolUse safety guard. No LLM/prompt classification anywhere in this
// file — every decision below is a plain regex/string check over the tool call's own
// command text, nothing else. See .claude/hooks/README.md for the exact contract.
//
// This file is a dependency-free Node ES module so it runs with nothing but `node`.
// It is directly importable for tests (every `export`ed function below is pure, no I/O)
// and also runnable standalone as the actual hook: `node safety-guard.mjs < input.json`.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// Splits a shell command into top-level segments on &&, ||, ;, | — but NOT inside a
// single- or double-quoted string. This is what lets `git commit -m "fix: git add . in
// docs"` be recognized as ONE segment (a git commit call) instead of accidentally
// exposing the quoted text "git add ." as if it were its own command. Not a full shell
// parser (doesn't handle nested subshells or backticks) — a deliberate, documented
// trade-off between precision and staying dependency-free (see README). Backslash-escaped
// double-quotes ARE handled (see the `quote === '"'` branch below) specifically because
// getting this wrong in the other direction — treating an escaped quote as a real closing
// quote — silently merges a following `&&`-chained dangerous command into a harmless-looking
// segment (e.g. `echo "\"" && git add .` would hide the `git add .` call entirely).
export function splitCommandSegments(cmd) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        // POSIX: inside double quotes, a run of backslashes immediately before a `"`
        // escapes that quote only if the run length is odd (each pair of backslashes is
        // itself an escaped literal backslash). Count the run rather than special-casing
        // just `\"`, so `\\"` (escaped backslash + real closing quote) isn't misread.
        let j = i;
        while (j < cmd.length && cmd[j] === "\\") j++;
        const runLength = j - i;
        const followedByQuote = cmd[j] === '"';
        if (followedByQuote && runLength % 2 === 1) {
          current += cmd.slice(i, j + 1);
          i = j;
          continue;
        }
        current += cmd.slice(i, j);
        i = j - 1;
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "&" && cmd[i + 1] === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && cmd[i + 1] === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === ";" || ch === "|") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

// Strips one or more leading `VAR=value ` environment-variable assignments (bare or
// quoted value) from a segment, e.g. `DATABASE_URL=postgres://... npm run migrate` ->
// `npm run migrate`. Applied once per segment before classification so every checker
// below sees the actual command regardless of an env-var prefix, instead of each one
// needing its own copy of this logic.
export function stripLeadingEnvAssignments(segment) {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, "");
}

function stripQuotes(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

// Global git options that take a separate following-token value (space-separated form).
// `--foo=value` (inline) forms don't need a table entry — they're single tokens, skipped
// by the generic "any dash-prefixed token" rule below. `--exec-path` is deliberately NOT
// listed here: real git's bare `--exec-path` (no `=`) takes no value at all (it just
// prints the configured path and exits) — only `--exec-path=<path>` does, which the
// inline-`=` branch below already handles. Listing it here would misread the *next*
// token (potentially the actual subcommand) as `--exec-path`'s value.
const GIT_GLOBAL_FLAGS_WITH_SEPARATE_VALUE = new Set([
  "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
]);

// Splits the text after `git` into whitespace tokens (quote-aware, reusing the same
// escaped-double-quote handling as splitCommandSegments) so a value like `-C "my repo"`
// stays one token.
function tokenizeWords(str) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (quote === '"' && ch === "\\" && str[i + 1] === '"') {
        current += ch + str[i + 1];
        i++;
        continue;
      }
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

// Matches a segment that starts with `git`, skips any number of git's own GLOBAL options
// (`-C <dir>`, `-c key=val`, `--no-pager`, `-p`, `--bare`, `--git-dir=...`, etc. — not
// just a single optional `-C <dir>`, which is all the previous version of this function
// recognized) and then the given subcommand. `subcommand` may be a plain word or a
// `word1|word2` alternation; it is always wrapped in a non-capturing group. Anchored to
// segment START (^) on purpose — see splitCommandSegments doc.
function extractGitSubcommandArgs(segment, subcommand) {
  const m = stripLeadingEnvAssignments(segment).match(/^git\b(.*)$/i);
  if (!m) return null;
  const tokens = tokenizeWords(m[1]);
  let dir = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith("-")) break; // first non-flag token is the subcommand
    // Case-SENSITIVE on purpose: `-C <dir>` ("run as if started in <dir>") and `-c
    // <key>=<value>` (a one-off config override) are two different git global options
    // that only differ by case — a case-insensitive match here would capture -c's
    // config-override value as if it were a `cwd` override for every later git call in
    // this function (getCurrentBranch/isValidGitRevision), silently corrupting branch
    // detection and defeating the push/commit-to-main ASK checks. `-c` is handled
    // correctly, without touching `dir`, by the GIT_GLOBAL_FLAGS_WITH_SEPARATE_VALUE
    // branch below.
    if (t === "-C" && tokens[i + 1] !== undefined) {
      dir = stripQuotes(tokens[i + 1]);
      i += 2;
      continue;
    }
    if (/^--[A-Za-z-]+=/.test(t)) { i += 1; continue; } // inline `--flag=value` form
    if (GIT_GLOBAL_FLAGS_WITH_SEPARATE_VALUE.has(t) && tokens[i + 1] !== undefined) { i += 2; continue; }
    i += 1; // any other global flag (--no-pager, -p, --bare, --literal-pathspecs, ...)
  }
  const subToken = tokens[i];
  if (!subToken) return null;
  if (!new RegExp(`^(?:${subcommand})$`, "i").test(subToken)) return null;
  return { dir, rest: tokens.slice(i + 1).join(" ") };
}

function getCurrentBranch(dir) {
  try {
    const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dir,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.toString().trim();
  } catch {
    // Not a git repo, git not on PATH, timed out, detached HEAD in a weird state, etc.
    // "ako hook bezbedno može utvrditi aktivnu granu" — it can't here, so callers must
    // treat null as "unknown", never as "not main".
    return null;
  }
}

// True only if `token` resolves to an existing commit in `dir` — used to tell a real
// `git checkout <branch-or-ref>` (safe: git itself refuses to clobber conflicting
// uncommitted changes when switching to a real ref) apart from `git checkout <path>`
// (discards that path's uncommitted changes, no protection). Deliberately fails closed:
// "not a repo" / git missing / timeout / not a valid revision are all indistinguishable
// here and all return false, so the caller treats the ambiguous case as a discard risk
// rather than assuming it's a safe branch name the way earlier code did.
function isValidGitRevision(token, dir) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${token}^{commit}`], {
      cwd: dir,
      timeout: 2000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

const ROOT_LIKE_TARGETS = [
  /^\/$/, // "/"
  /^~\/?$/, // "~" or "~/"
  /^\$HOME\/?$/i,
  /^\$\{HOME\}\/?$/i,
  /^\.$/, // "."
  /^\.\/$/, // "./"
  /^[A-Za-z]:\\?$/, // "C:" or "C:\"
  /^[A-Za-z]:\/$/, // "C:/"
];

const SQL_WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/i;
const SQL_READ_ONLY_HINT = /\b(SELECT|EXPLAIN|SHOW)\b/i;

// ---------------------------------------------------------------------------
// DENY checks — never auto-execute these, no matter who asks
// ---------------------------------------------------------------------------

export function isGitAddBroad(segment) {
  const parsed = extractGitSubcommandArgs(segment, "add");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  return tokens.some((t) => {
    const clean = stripQuotes(t);
    return clean === "." || clean === "./" || clean === "-A" || clean === "--all";
  });
}

export function isGitResetHard(segment) {
  const parsed = extractGitSubcommandArgs(segment, "reset");
  if (!parsed) return false;
  return /--hard\b/i.test(parsed.rest);
}

export function isGitCleanDestructive(segment) {
  const parsed = extractGitSubcommandArgs(segment, "clean");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  let dryRun = false;
  let force = false;
  for (const t of tokens) {
    if (/^--dry-run$/i.test(t)) dryRun = true;
    else if (/^--force$/i.test(t)) force = true;
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (/n/i.test(t)) dryRun = true;
      if (/f/i.test(t)) force = true;
    }
  }
  // git itself treats -n as winning over -f (no deletion happens) regardless of order —
  // mirror that here rather than flagging a command that would actually be a no-op.
  if (dryRun) return false;
  return force;
}

export function isGitPushForce(segment) {
  const parsed = extractGitSubcommandArgs(segment, "push");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  return tokens.some((t) => /^(-f|--force|--force-with-lease(=.*)?)$/i.test(t));
}

// `git checkout <branch>` (switching branches) is normal workflow and left alone. What
// this catches is the *other* meaning of `git checkout` — discarding uncommitted changes
// in the working tree, via `-- <path>`/`.` or a bare `git checkout .` — which git-safety.md's
// "anything that discards uncommitted work" catch-all covers alongside reset --hard/clean.
//
// Without a `--` separator, a single non-flag argument is genuinely ambiguous in real git:
// `git checkout <token>` switches to <token> if it's a real branch/ref (safe — git itself
// refuses to clobber conflicting uncommitted changes for a ref switch), but silently
// discards that path's uncommitted changes if <token> is instead an existing tracked file
// path, with zero protection. Rather than assume "branch" the way a plain regex would, this
// asks git in the command's own `cwd` whether the token actually resolves to a commit; if
// it can't be confirmed (not a real revision, not a repo, git unavailable, timeout), that
// counts as a discard risk, not a safe branch switch.
export function isGitCheckoutDiscardingWork(segment, cwd) {
  const parsed = extractGitSubcommandArgs(segment, "checkout");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const dashDashIdx = tokens.findIndex((t) => t === "--");
  if (dashDashIdx !== -1) return tokens.length > dashDashIdx + 1; // `-- <path...>` present
  if (tokens.some((t) => /^-[bB]$/.test(t))) return false; // creates a new branch, not a discard
  const nonFlag = tokens.filter((t) => !t.startsWith("-"));
  if (nonFlag.length === 0) return false;
  if (nonFlag.length > 1) return true; // ambiguous multi-arg form without `--`, treat as risky
  const single = stripQuotes(nonFlag[0]);
  if (single === "." || single === "./") return true;
  return !isValidGitRevision(single, parsed.dir || cwd);
}

// `git restore <path>` (no --staged) discards working-tree changes — destructive, same
// class as checkout's discard form. `git restore --staged <path>` only *unstages*, leaving
// the working tree untouched, so that form is left alone (reversible, not data loss).
export function isGitRestoreDiscardingWork(segment) {
  const parsed = extractGitSubcommandArgs(segment, "restore");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const isStaged = (t) => /^(--staged|-S)$/i.test(t);
  const isWorktree = (t) => /^(--worktree|-W)$/i.test(t);
  const hasStagedOnly = tokens.some(isStaged) && !tokens.some(isWorktree);
  if (hasStagedOnly) return false;
  const hasTarget = tokens.some((t) => t === "--" || !t.startsWith("-"));
  return hasTarget;
}

// `git stash drop`/`git stash clear` irreversibly delete stash entries. Every other stash
// subcommand (bare `stash`, `push`, `pop`, `apply`, `list`, `show`) is reversible/additive
// and left alone — see README "ALLOW" section.
export function isGitStashDestructive(segment) {
  const parsed = extractGitSubcommandArgs(segment, "stash");
  if (!parsed) return false;
  return /^(drop|clear)\b/i.test(parsed.rest);
}

const DELETE_COMMAND_RE = /^(rm|del|erase|rd|rmdir|ri|Remove-Item)\b/i;
const POWERSHELL_DELETE_COMMAND_RE = /^(ri|Remove-Item)$/i;

export function isDestructiveRootDelete(rawSegment) {
  const segment = stripLeadingEnvAssignments(rawSegment);
  const m = segment.match(DELETE_COMMAND_RE);
  if (!m) return false;
  const isPowerShellForm = POWERSHELL_DELETE_COMMAND_RE.test(m[0]);
  const rest = segment.slice(m[0].length);
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  let recursive = false;
  let force = false;
  const targets = [];
  for (const t of tokens) {
    if (/^(-r|--recursive|-Recurse)$/i.test(t)) recursive = true;
    else if (/^(-f|--force|-Force)$/i.test(t)) force = true;
    else if (/^-(Path|LiteralPath)$/i.test(t)) continue; // next token is the path; picked up below as a positional
    else if (/^-[a-zA-Z]+$/.test(t)) {
      if (isPowerShellForm) {
        // PowerShell allows an unambiguous abbreviation of a named parameter (-Recu,
        // -Fo, ...). Match only an actual PREFIX of "Recurse"/"Force" — NOT "contains
        // the letter r/f anywhere", which would also misfire on unrelated parameters
        // like -Filter, -ErrorAction, or -Confirm (all contain 'r' or 'f') and falsely
        // deny an ordinary scoped delete.
        const body = t.slice(1).toLowerCase();
        if (body.length >= 2 && "recurse".startsWith(body)) recursive = true;
        if (body.length >= 2 && "force".startsWith(body)) force = true;
      } else {
        // A combined short Unix cluster, e.g. -rf / -fr / -fdx — here "contains r/f" is
        // the correct check, since each letter is its own bundled single-char flag.
        if (/r/i.test(t)) recursive = true;
        if (/f/i.test(t)) force = true;
      }
    } else if (!t.startsWith("-")) {
      targets.push(stripQuotes(t));
    }
  }
  if (!(recursive && force)) return false;
  // No explicit target: `rm -rf` alone errors in bash (missing operand) but
  // `Remove-Item -Recurse -Force` with no -Path defaults to the current directory —
  // treat "no target" as "defaults to cwd", which is exactly the risky case we exist to
  // catch. Slightly over-cautious for the bash no-op case; documented in the README.
  if (targets.length === 0) return true;
  return targets.some((t) => ROOT_LIKE_TARGETS.some((re) => re.test(t)));
}

// ---------------------------------------------------------------------------
// ASK checks — a human can approve these individually, just not silently
// ---------------------------------------------------------------------------

export function isGitMergeOrRebase(segment) {
  return extractGitSubcommandArgs(segment, "merge|rebase") !== null;
}

export function isGhPrMerge(segment) {
  return /^gh\s+pr\s+merge\b/i.test(segment);
}

function refspecTargetsMain(token) {
  const c = stripQuotes(token);
  return (
    c === "main" ||
    c === "origin/main" ||
    c === "refs/heads/main" ||
    c.endsWith(":main") ||
    c.endsWith(":refs/heads/main")
  );
}

export function isPushToMain(segment, cwd) {
  const parsed = extractGitSubcommandArgs(segment, "push");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  const nonFlag = tokens.filter((t) => !t.startsWith("-"));
  if (nonFlag.some(refspecTargetsMain)) return true;
  // Bare `git push` or `git push origin` (no explicit branch/refspec) pushes whatever
  // the current branch's upstream is — only knowable by actually asking git.
  if (nonFlag.length <= 1) {
    const branch = getCurrentBranch(parsed.dir || cwd);
    return branch === "main";
  }
  return false;
}

export function isCommitOnMain(segment, cwd) {
  const parsed = extractGitSubcommandArgs(segment, "commit");
  if (!parsed) return false;
  const branch = getCurrentBranch(parsed.dir || cwd);
  return branch === "main";
}

const DEPLOY_PATTERNS = [
  /^render\s+deploy\b/i,
  /^(npx\s+)?vercel\s+(deploy\b|--prod\b|prod\b)/i,
  /^(npx\s+)?wrangler\s+(deploy\b|publish\b|pages\s+deploy\b)/i,
  /^(npx\s+)?supabase\s+(functions\s+deploy\b|deploy\b|db\s+push\b)/i,
];

export function isDeployCommand(segment) {
  const normalized = stripLeadingEnvAssignments(segment);
  return DEPLOY_PATTERNS.some((re) => re.test(normalized));
}

const MIGRATION_PATTERNS = [
  /^node\s+.*migrate\.js\b/i,
  /^npm\s+--prefix\s+backend\s+run\s+migrate\b/i,
  /^npm\s+(run\s+)?migrate\b/i,
  /^npm\s+--prefix\s+backend\s+(run\s+)?start\b(?!:)/i,
  /^npm\s+(run\s+)?start\b(?!:)/i, // backend's own "start" script chains migrate.js before the server
];

export function isMigrationRunner(segment) {
  const normalized = stripLeadingEnvAssignments(segment);
  return MIGRATION_PATTERNS.some((re) => re.test(normalized));
}

export function isPersistentSqlWrite(segment) {
  const m = stripLeadingEnvAssignments(segment).match(/^psql\b(.*)$/i);
  if (!m) return false;
  if (/\b(test_disposable|_disposable_db|:memory:)\b/i.test(segment)) return false;
  const args = m[1] || "";
  // `-f`/`--file` (or a `<` shell redirect) runs SQL from a file whose actual content
  // isn't visible on this command line at all — a write keyword could be sitting in that
  // file with nothing here to scan. Rather than default to "no write keyword found, so
  // allow", treat "can't see the SQL" as ask-worthy, same principle as
  // classifyMcpToolCall's execute_sql fallback for an unrecognized query shape.
  if (/(^|\s)(-f\b|--file\b|<)/i.test(args)) return true;
  return SQL_WRITE_KEYWORDS.test(args);
}

// ---------------------------------------------------------------------------
// Shell command dispatcher (Bash + PowerShell share this — both tools use the same
// `command` string input field)
// ---------------------------------------------------------------------------

const DENY_REASONS = {
  gitAddBroad:
    "Broad 'git add' (a bare '.', '-A', or '--all') stages the entire working tree, including files unrelated to this change. Stage explicit filenames instead.",
  gitResetHard:
    "'git reset --hard' discards uncommitted work irreversibly.",
  gitCleanDestructive:
    "'git clean' with a force flag and no dry-run permanently deletes untracked files.",
  gitPushForce:
    "'git push --force'/'--force-with-lease' can overwrite remote history, possibly discarding someone else's work.",
  rootDelete:
    "This recursive, forced delete targets the repo root, a home directory, or a drive root — refusing to run it automatically.",
  gitCheckoutDiscard:
    "'git checkout -- <path>'/'git checkout .' discards uncommitted changes in the working tree irreversibly.",
  gitRestoreDiscard:
    "'git restore <path>' (without --staged) discards uncommitted working-tree changes irreversibly.",
  gitStashDestructive:
    "'git stash drop'/'git stash clear' irreversibly deletes stashed work.",
};

const ASK_REASONS = {
  mergeRebase:
    "'git merge'/'git rebase' rewrites branch history or state — needs your explicit confirmation.",
  ghPrMerge: "'gh pr merge' merges a pull request — needs your explicit confirmation.",
  pushMain: "This push targets 'main' — needs your explicit confirmation.",
  commitMain: "This commit would land directly on 'main' — needs your explicit confirmation.",
  deploy: "This looks like a deploy command (Render/Vercel/Cloudflare/Supabase) — needs your explicit confirmation.",
  migration: "This looks like it runs the database migration runner — needs your explicit confirmation.",
  sqlWrite:
    "This looks like a SQL write (INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE/CREATE/GRANT/REVOKE) against a database — needs your explicit confirmation unless you know this specific target is a disposable test database.",
};

// Matches a segment that is itself just another interpreter invoked on an inline command
// string — `bash -c "..."`, `sh -c '...'`, `powershell -Command "..."`, `cmd /c "..."` —
// and returns the unquoted inner command, or null if the segment isn't shaped like one of
// these. This exists because every check above is anchored to the START of a segment
// (`^git`, `^rm`, ...); without unwrapping, `bash -c "git reset --hard"` starts with
// "bash", not "git", and would otherwise slip past every rule undetected even though it's
// not adversarial — wrapping a command in `bash -c` is an ordinary habit (e.g. to dodge
// quoting differences between shells), not a deliberate evasion technique.
const INTERPRETER_WRAPPER_PATTERNS = [
  /^(?:bash|sh|zsh|dash)\s+-c\s+(.+)$/i,
  /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-NoProfile\s+)?(?:-Command|-c)\s+(.+)$/i,
  /^cmd(?:\.exe)?\s+\/c\s+(.+)$/i,
];

export function unwrapInterpreterCommand(segment) {
  const normalized = stripLeadingEnvAssignments(segment);
  for (const re of INTERPRETER_WRAPPER_PATTERNS) {
    const m = normalized.match(re);
    if (m) return stripQuotes(m[1].trim());
  }
  return null;
}

// Expands each top-level segment plus, recursively (bounded depth against something like
// `bash -c "bash -c ..."`), the inner command of any interpreter-wrapper segment — so a
// wrapped dangerous command is checked exactly like an unwrapped one.
function expandSegments(segments, depth = 0) {
  if (depth > 4) return segments;
  const expanded = [];
  for (const segment of segments) {
    expanded.push(segment);
    const inner = unwrapInterpreterCommand(segment);
    if (inner) expanded.push(...expandSegments(splitCommandSegments(inner), depth + 1));
  }
  return expanded;
}

export function classifyShellCommand(cmd, cwd) {
  const segments = expandSegments(splitCommandSegments(cmd));

  for (const segment of segments) {
    if (isGitAddBroad(segment)) return { decision: "deny", reason: DENY_REASONS.gitAddBroad };
    if (isGitResetHard(segment)) return { decision: "deny", reason: DENY_REASONS.gitResetHard };
    if (isGitCleanDestructive(segment)) return { decision: "deny", reason: DENY_REASONS.gitCleanDestructive };
    if (isGitPushForce(segment)) return { decision: "deny", reason: DENY_REASONS.gitPushForce };
    if (isDestructiveRootDelete(segment)) return { decision: "deny", reason: DENY_REASONS.rootDelete };
    if (isGitCheckoutDiscardingWork(segment, cwd)) return { decision: "deny", reason: DENY_REASONS.gitCheckoutDiscard };
    if (isGitRestoreDiscardingWork(segment)) return { decision: "deny", reason: DENY_REASONS.gitRestoreDiscard };
    if (isGitStashDestructive(segment)) return { decision: "deny", reason: DENY_REASONS.gitStashDestructive };
  }

  for (const segment of segments) {
    if (isGitMergeOrRebase(segment)) return { decision: "ask", reason: ASK_REASONS.mergeRebase };
    if (isGhPrMerge(segment)) return { decision: "ask", reason: ASK_REASONS.ghPrMerge };
    if (isPushToMain(segment, cwd)) return { decision: "ask", reason: ASK_REASONS.pushMain };
    if (isCommitOnMain(segment, cwd)) return { decision: "ask", reason: ASK_REASONS.commitMain };
    if (isDeployCommand(segment)) return { decision: "ask", reason: ASK_REASONS.deploy };
    if (isMigrationRunner(segment)) return { decision: "ask", reason: ASK_REASONS.migration };
    if (isPersistentSqlWrite(segment)) return { decision: "ask", reason: ASK_REASONS.sqlWrite };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Supabase MCP tool dispatcher — matched by tool-name SUFFIX (the prefix is an
// instance-specific server id we must not hardcode) rather than exact name.
// ---------------------------------------------------------------------------

const MCP_ALWAYS_ASK_SUFFIXES = [
  "__apply_migration",
  "__deploy_edge_function",
  "__merge_branch",
  "__reset_branch",
  "__delete_branch",
];

export function classifyMcpToolCall(toolName, toolInput) {
  for (const suffix of MCP_ALWAYS_ASK_SUFFIXES) {
    if (toolName.endsWith(suffix)) {
      return {
        decision: "ask",
        reason: `Supabase MCP operation "${suffix.slice(2)}" mutates a project/branch/function — needs your explicit confirmation.`,
      };
    }
  }
  if (toolName.endsWith("__execute_sql")) {
    const query = toolInput && (toolInput.query ?? toolInput.sql ?? toolInput.statement);
    if (typeof query === "string" && query.trim()) {
      if (SQL_WRITE_KEYWORDS.test(query)) {
        return {
          decision: "ask",
          reason: "This Supabase execute_sql call looks like a write against a Supabase-managed database — needs your explicit confirmation.",
        };
      }
      if (SQL_READ_ONLY_HINT.test(query)) return null; // looks read-only, pass through
      // Doesn't obviously match either list (e.g. just "WITH ... SELECT" edge phrasing,
      // or something this guard doesn't recognize) — fail safe, don't guess.
      return {
        decision: "ask",
        reason: "Could not confidently classify this Supabase SQL call as read-only — failing to a confirmation prompt.",
      };
    }
    return {
      decision: "ask",
      reason: "Could not find a recognizable query field on this Supabase execute_sql call — failing to a confirmation prompt.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export function classifyToolCall(input) {
  const toolName = input && typeof input.tool_name === "string" ? input.tool_name : null;
  const toolInput = (input && input.tool_input) || {};
  const cwd = (input && typeof input.cwd === "string" && input.cwd) || process.cwd();

  if (!toolName) return null;

  if (toolName === "Bash" || toolName === "PowerShell") {
    if (typeof toolInput.command !== "string") {
      // A governed tool call with no recognizable command field at all (missing, null,
      // not a string) is not the same as "an empty, harmless command" — it means this
      // guard cannot tell what's about to run. Ask rather than silently allowing it.
      return { decision: "ask", reason: "Could not find a recognizable 'command' field on this tool call; failing to a confirmation prompt rather than allowing it silently." };
    }
    if (!toolInput.command.trim()) return null; // genuinely empty command: nothing to run, nothing to ask about
    return classifyShellCommand(toolInput.command, cwd);
  }

  if (toolName.startsWith("mcp__")) {
    return classifyMcpToolCall(toolName, toolInput);
  }

  return null;
}

// ---------------------------------------------------------------------------
// CLI entry point — reads Claude's PreToolUse JSON from stdin, writes a decision (or
// nothing) to stdout. Never touches stderr with anything command-derived.
// ---------------------------------------------------------------------------

function emitDecision(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
}

export function runCli(rawStdin) {
  let input;
  try {
    // Strip a leading UTF-8 BOM if present - observed in practice on Windows depending
    // on exactly how the parent process writes to this process's stdin, and would
    // otherwise make JSON.parse fail (and this hook ask) on every single call rather
    // than actually classifying anything.
    input = JSON.parse(rawStdin.replace(/^﻿/, ""));
  } catch {
    // Malformed input: we cannot tell what tool this even was. Fail closed rather than
    // silently letting an unparseable call through — see README "Safety contract".
    emitDecision("ask", "Could not parse the tool-call input as JSON; failing to a confirmation prompt rather than allowing it silently.");
    return;
  }
  let result;
  try {
    result = classifyToolCall(input);
  } catch {
    // Only fail closed here for the tool families this guard actually governs — an
    // internal error while inspecting an unrelated tool (Read, Grep, ...) must never
    // block it.
    const toolName = input && typeof input.tool_name === "string" ? input.tool_name : "";
    if (toolName === "Bash" || toolName === "PowerShell" || toolName.startsWith("mcp__")) {
      emitDecision("ask", "An internal error occurred while safety-checking this command; failing to a confirmation prompt.");
    }
    return;
  }
  if (result && (result.decision === "deny" || result.decision === "ask")) {
    emitDecision(result.decision, result.reason);
  }
  // Safe operations: no output at all — Claude Code's normal permission flow decides.
}

// Windows paths are case-insensitive at the filesystem level, but plain string equality
// isn't - $CLAUDE_PROJECT_DIR (settings.json's own hook command) and import.meta.url's
// resolved casing aren't guaranteed to agree byte-for-byte. A case-sensitive mismatch
// here would make this whole file a silent no-op (never reads stdin, never emits a
// decision) with zero signal that anything is wrong - the worst possible failure mode
// for a safety hook. Compare case-insensitively on win32.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const invoked = path.resolve(process.argv[1]);
    const thisFile = path.resolve(fileURLToPath(import.meta.url));
    if (process.platform === "win32") return invoked.toLowerCase() === thisFile.toLowerCase();
    return invoked === thisFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  let raw = "";
  try {
    const fs = await import("node:fs");
    raw = fs.readFileSync(0, "utf8");
  } catch {
    // Could not read stdin at all. Fail closed like every other error path in this file
    // (see runCli) rather than exiting silently - an unreadable stdin is exactly the
    // kind of "can't tell what this is" situation the safety contract says must ask,
    // not pass through.
    emitDecision("ask", "Could not read the tool-call input from stdin; failing to a confirmation prompt rather than allowing it silently.");
    process.exit(0);
  }
  runCli(raw);
  process.exit(0);
}
