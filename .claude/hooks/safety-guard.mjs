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
import fs from "node:fs";
import os from "node:os";

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
    // A backslash before a newline joins the two lines (line continuation); any other
    // backslash outside quotes escapes the next character, which therefore never splits.
    if (ch === "\\") {
      if (cmd[i + 1] === "\n") { i++; continue; }
      if (cmd[i + 1] === "\r" && cmd[i + 2] === "\n") { i += 2; continue; }
      if (i + 1 < cmd.length) { current += ch + cmd[i + 1]; i++; continue; }
    }
    if (ch === "&" && cmd[i + 1] === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && cmd[i + 1] === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && cmd[i + 1] === "&") { segments.push(current); current = ""; i++; continue; } // |& pipes stderr too
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") { segments.push(current); current = ""; continue; }
    // A single & runs the command before it in the background: a separator. Not when it is
    // part of a redirection (2>&1, >&2, <&0, &>file).
    if (ch === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && cmd[i + 1] !== ">") { segments.push(current); current = ""; continue; }
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
  const m = stripLeadingEnvAssignments(segment).match(/^git\b([\s\S]*)$/i);
  if (!m) return null;
  // The words as git receives them: `re""set`, `$'reset'`, `"--hard"` are reset and --hard.
  const tokens = tokenizeWords(m[1]).map(shellWord);
  let dir = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith("-")) break; // first non-flag token is the subcommand
    // Case-SENSITIVE on purpose: `-C <dir>` ("run as if started in <dir>") and `-c
    // <key>=<value>` (a one-off config override) are two different git global options
    // that only differ by case — a case-insensitive match here would capture -c's
    // config-override value as if it were a `cwd` override for every later git call in
    // this function (getCurrentBranchRef/isValidGitRevision), silently corrupting branch
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

// The current branch as its FULL ref (`refs/heads/main`), or null when it cannot be known.
// `git symbolic-ref -q HEAD` and not `git rev-parse --abbrev-ref HEAD`: the abbreviated name
// is ambiguous — with a branch `main` and also a tag (or refs/remotes/) `main`, rev-parse
// prints `heads/main`, which no "=== main" check recognises, and a tag can arrive with an
// ordinary `git fetch`. A detached HEAD, git missing, not a repository, a timeout: all null.
// "ako hook bezbedno može utvrditi aktivnu granu" — when it can't, callers must treat null
// as "unknown", never as "not main".
function getCurrentBranchRef(dir) {
  try {
    const out = execFileSync("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: dir,
      timeout: GIT_READ_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ref = out.toString().trim();
    return ref.startsWith("refs/heads/") ? ref : null;
  } catch {
    return null;
  }
}

// Case-insensitive on purpose: on a case-insensitive file system (Windows, macOS) `Main`
// and `main` are the same branch.
function isRefOneOf(ref, names) {
  if (typeof ref !== "string") return false;
  const lower = ref.toLowerCase();
  return names.some((name) => lower === `refs/heads/${name}`);
}

// True only if `token` resolves to an existing commit in `dir` — used to tell a real
// `git checkout <branch-or-ref>` (safe: git itself refuses to clobber conflicting
// uncommitted changes when switching to a real ref) apart from `git checkout <path>`
// (discards that path's uncommitted changes, no protection). Deliberately fails closed:
// "not a repo" / git missing / timeout / not a valid revision are all indistinguishable
// here and all return false, so the caller treats the ambiguous case as a discard risk
// rather than assuming it's a safe branch name the way earlier code did.
// Generous: a cold disk cache on Windows can make the first git call of a session slow, and a
// timeout here only ever leads to a question, never to silence.
const GIT_READ_TIMEOUT_MS = 5000;

function isValidGitRevision(token, dir) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${token}^{commit}`], {
      cwd: dir,
      timeout: GIT_READ_TIMEOUT_MS,
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

// git (like the GNU tools) accepts any unique prefix of a long option: `--forc`, `--for` and
// even `--f` are `--force` to `git checkout`; `--har` is `--hard`. A rule that compares long
// options by exact name is blind to that, so every comparison below goes through this: true
// when the word (before any "=") is `--` plus at least one letter and is a prefix of `name`.
// An ambiguous prefix git itself would refuse counts too: the stricter verdict wins.
export function longOptionIs(word, name) {
  const t = String(word).split("=")[0];
  return t.length >= 3 && t.startsWith("--") && name.startsWith(t);
}

// For commands whose long options are judged by an explicit list: "safe" when the word is a
// prefix only of safe names, "danger" when it is a prefix of a dangerous name, else "unknown".
function classifyLongOption(word, safeNames, dangerousNames) {
  const t = String(word).split("=")[0];
  if (dangerousNames.some((n) => longOptionIs(t, n))) return "danger";
  if (safeNames.some((n) => n === t || longOptionIs(t, n))) return "safe";
  return "unknown";
}

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
  return parsed.rest.split(/\s+/).some((t) => longOptionIs(t, "--hard"));
}

export function isGitCleanDestructive(segment) {
  const parsed = extractGitSubcommandArgs(segment, "clean");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  let dryRun = false;
  let force = false;
  for (const t of tokens) {
    if (longOptionIs(t, "--dry-run")) dryRun = true;
    else if (longOptionIs(t, "--force")) force = true;
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
  return tokens.some((t) => (/^-[a-zA-Z]+$/.test(t) && t.includes("f")) // -f, -uf, -fu
    || longOptionIs(t, "--force") || longOptionIs(t, "--force-with-lease")
    || /^\+[^:+\s]/.test(stripQuotes(t))); // `git push origin +branch`: a forced refspec
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
  // These forms take a commit or a branch, never a path: they cannot discard a file's changes,
  // even when the ref cannot be verified from here (the worktree does not exist yet).
  if (tokens.some((t) => /^(--detach|--orphan|--track|-t)$/.test(t) || /^--track=/.test(t))) return false;
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
  const isStaged = (t) => t === "-S" || longOptionIs(t, "--staged") || (/^-[a-zA-Z]+$/.test(t) && t.includes("S"));
  const isWorktree = (t) => t === "-W" || longOptionIs(t, "--worktree") || (/^-[a-zA-Z]+$/.test(t) && t.includes("W"));
  const hasStagedOnly = tokens.some(isStaged) && !tokens.some(isWorktree);
  if (hasStagedOnly) return false;
  // a pathspec file names targets too: `--pathspec-from-file=list` (and every prefix of it)
  const hasTarget = tokens.some((t) => t === "--" || !t.startsWith("-") || longOptionIs(t, "--pathspec-from-file"));
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

// ---------------------------------------------------------------------------
// The one merge that does not ask: bringing the remote default branch INTO one's own
// working branch (`git merge --no-edit origin/main`), the routine step before a review.
// Everything about it is fail-closed: the segment must be EXACTLY that command and
// nothing else, the current branch must be known and must not be main/master, and
// nothing that ran earlier in the same command line may have been able to change the
// directory, the branch or what `origin/main` points at.
// ---------------------------------------------------------------------------

const SAFE_MERGE_FLAGS = new Set(["--no-edit", "--no-ff", "--no-commit", "-q"]);
const SAFE_MERGE_SOURCES = new Set(["origin/main", "origin/master"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// Only plain words separated by single spaces or tabs: no quotes, no `$`, no backticks,
// no parentheses or braces, no redirections, no `&`, no newline, no `=`, no `:`.
// Anything else is not "exactly that command", whatever it would turn out to do.
const PLAIN_WORDS_RE = /^[A-Za-z0-9_.\/@^~-]+(?:[ \t]+[A-Za-z0-9_.\/@^~-]+)*$/;

function plainTokens(segment) {
  if (typeof segment !== "string" || !PLAIN_WORDS_RE.test(segment)) return null;
  return segment.split(/[ \t]+/);
}

// `git merge [--no-edit|--no-ff|--no-commit|-q]... origin/main` (or origin/master), the
// flags before or after the source — and nothing else: no env prefix, no git global
// option (`-C`, `-c`, `--git-dir`...), no second source, no other flag, no `--abort`.
export function isPlainMergeOfRemoteDefault(segment) {
  const tokens = plainTokens(segment);
  if (!tokens || tokens.length < 3 || tokens[0] !== "git" || tokens[1] !== "merge") return false;
  let sources = 0;
  for (const token of tokens.slice(2)) {
    if (SAFE_MERGE_FLAGS.has(token)) continue;
    if (SAFE_MERGE_SOURCES.has(token)) { sources++; continue; }
    return false;
  }
  return sources === 1;
}

const READ_ONLY_GIT_SUBCOMMANDS = new Set(["status", "rev-parse", "log", "diff", "show", "merge-base"]);
const PLAIN_FETCH_FLAGS = new Set(["-q", "--quiet", "--prune"]);
const PLAIN_FILTERS = new Set(["wc", "head", "tail"]);

// What may run BEFORE the merge in the same command line without taking the exemption
// away: commands that only read, written as plain words. A `cd`, a `git checkout`, a
// `git -C`, an `echo ... > .git/HEAD`, a fetch with a refspec that redirects origin/main,
// a `bash -c "..."` wrapper — none of them is on this list, so after any of them the
// merge asks exactly as before.
export function isHarmlessBeforeMerge(segment) {
  const tokens = plainTokens(segment);
  if (!tokens) return false;
  if (PLAIN_FILTERS.has(tokens[0])) {
    // `wc -l`, `head -5`, `tail -n 3`: reading a pipe only, never a file argument.
    return tokens.slice(1).every((t) => /^-[A-Za-z0-9]+$/.test(t) || /^[0-9]+$/.test(t));
  }
  if (tokens[0] !== "git" || tokens.length < 2) return false;
  const sub = tokens[1];
  const rest = tokens.slice(2);
  if (sub === "fetch") {
    // `git fetch [-q|--quiet|--prune] [origin [main|master]]`: no refspec, no other remote.
    const words = rest.filter((t) => !PLAIN_FETCH_FLAGS.has(t));
    if (words.some((t) => t.startsWith("-"))) return false;
    if (words.length === 0) return true;
    if (words[0] !== "origin") return false;
    return words.length === 1 || (words.length === 2 && PROTECTED_BRANCHES.has(words[1]));
  }
  if (sub === "branch") return rest.length === 1 && rest[0] === "--show-current";
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return false;
  // A read command that writes a file is not a read (`git diff --output ...`), and one that
  // runs a configured external program (`--ext-diff`, `--textconv`) could do anything,
  // including change the branch after the hook has checked it.
  return !rest.some((t) => /^--output/i.test(t) || t === "-o" || /^--(ext-diff|textconv)\b/i.test(t));
}

// Fail-closed: only a FULL ref that is known and is not refs/heads/main or refs/heads/master
// passes. null (detached HEAD, error, not a repository) is "unknown", never "not main".
function isKnownWorkingBranch(ref) {
  if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || ref === "refs/heads/") return false;
  return !isRefOneOf(ref, ["main", "master"]);
}

export function isMergeOfRemoteDefaultIntoWorkingBranch(segment, earlierSegments, cwd, currentBranchRefOf = getCurrentBranchRef) {
  if (!isPlainMergeOfRemoteDefault(segment)) return false;
  if (!earlierSegments.every(isHarmlessBeforeMerge)) return false;
  return isKnownWorkingBranch(currentBranchRefOf(cwd));
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
    return isRefOneOf(getCurrentBranchRef(parsed.dir || cwd), ["main"]);
  }
  return false;
}

export function isCommitOnMain(segment, cwd) {
  const parsed = extractGitSubcommandArgs(segment, "commit");
  if (!parsed) return false;
  return isRefOneOf(getCurrentBranchRef(parsed.dir || cwd), ["main"]);
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
// Reading what hides: wrappers, substitutions, groups, heredocs. The rule is "a dangerous
// command is caught wherever it can be read"; only what truly cannot be read asks.
// ---------------------------------------------------------------------------

// Every git subcommand name, porcelain and plumbing: a `$VAR` command word followed by one of
// these is read as git; followed by anything else it is not.
const KNOWN_GIT_SUBCOMMANDS = new Set(["add", "am", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr",
  "check-ignore", "checkout", "checkout-index", "cherry", "cherry-pick", "clean", "clone", "commit", "commit-tree", "config", "count-objects",
  "describe", "diff", "diff-files", "diff-index", "diff-tree", "difftool", "fast-import", "fetch", "filter-branch", "for-each-ref", "format-patch",
  "fsck", "gc", "grep", "hash-object", "init", "log", "ls-files", "ls-remote", "ls-tree", "maintenance", "merge", "merge-base", "merge-file",
  "merge-tree", "mergetool", "mktag", "mktree", "mv", "name-rev", "notes", "prune", "pull", "push", "range-diff", "read-tree", "rebase",
  "reflog", "remote", "repack", "replace", "reset", "restore", "rev-list", "rev-parse", "revert", "rm", "send-email", "shortlog", "show",
  "show-ref", "sparse-checkout", "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref",
  "update-server-info", "var", "verify-commit", "version", "whatchanged", "worktree", "write-tree"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "pwsh", "powershell"]);
const KNOWN_COMMANDS_BY_PATH = new Set([
  "git", "gh", "rm", "rmdir", "del", "psql", "node", "npm", "npx", "env", "sudo", "doas",
  "bash", "sh", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd", "sed", "sort", "uniq",
  "rg", "find", "xargs", "timeout", "nohup", "nice", "time", "stdbuf", "exec", "command",
]);
const SHELL_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "time", "{", "(", "(("]);

function basenameOfCommand(word) {
  const base = word.split(/[\\/]/).pop().replace(/\.exe$/i, "");
  return base.toLowerCase();
}

// Drops the wrappers that run the command after them unchanged: env (and its assignments),
// sudo/doas, command, exec, nohup, nice, time, timeout, stdbuf, xargs, a leading backslash,
// an absolute or relative path to a known command, shell keywords, and opening/closing
// parentheses or braces of a group. Returns the command underneath, or the segment itself.
export function normalizeSegment(segment) {
  let current = typeof segment === "string" ? segment.trim() : "";
  for (let round = 0; round < 12; round++) {
    const before = current;
    // `(` `{` opening a group, `)` closing a subshell; a `}` closes a group only as a word of
    // its own (`.en{v,}` is a brace expansion, not a group).
    current = current.replace(/^[({]+\s*/, "").replace(/\s*\)+\s*;?\s*$/, "").replace(/(^|[\s;])\}+\s*;?\s*$/, "$1").trim();
    // The body of a function definition runs when the function is called: read it as a command.
    current = current.replace(/^(?:function\s+[\w.:-]+(?:\s*\(\s*\))?|[\w.:-]+\s*\(\s*\))\s*[{(]?\s*/, "").trim();
    current = stripLeadingEnvAssignments(current).trim();
    let tokens = tokenizeWords(current);
    if (tokens.length === 0) return "";
    // The command word as the shell finds it: 'git', "git", g\it and $'git' are all git.
    const unquotedFirst = shellWord(tokens[0]);
    if (unquotedFirst && !/\s/.test(unquotedFirst)) tokens[0] = unquotedFirst;
    let first = tokens[0];
    if ((first.includes("/") || first.includes("\\")) && KNOWN_COMMANDS_BY_PATH.has(basenameOfCommand(first))) {
      tokens[0] = basenameOfCommand(first);
      first = tokens[0];
    }
    const name = first.toLowerCase();
    let skip = 0;
    if (SHELL_KEYWORDS.has(name)) skip = 1;
    else if (name === "env") {
      skip = 1;
      while (skip < tokens.length) {
        const t = tokens[skip];
        if (/^-[uCS]$/.test(t) || /^--(unset|chdir|split-string)$/.test(t)) { skip += 2; continue; }
        if (/^-/.test(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { skip += 1; continue; }
        break;
      }
    } else if (name === "sudo" || name === "doas") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) {
        skip += /^-[ugCDhprtUT]$/.test(tokens[skip]) ? 2 : 1;
      }
    } else if (name === "command") {
      if (tokens.slice(1).some((t) => /^-[a-zA-Z]*[vV]/.test(t))) return current; // only looks the name up
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) skip += 1;
    } else if (name === "exec") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) skip += tokens[skip] === "-a" ? 2 : 1;
    } else if (name === "nohup" || name === "setsid") {
      skip = 1;
    } else if (name === "nice") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) skip += tokens[skip] === "-n" ? 2 : 1;
    } else if (name === "timeout") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) skip += /^-[sk]$/.test(tokens[skip]) ? 2 : 1;
      skip += 1; // the duration
    } else if (name === "stdbuf") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) skip += /^-[ioe]$/.test(tokens[skip]) ? 2 : 1;
    } else if (name === "xargs") {
      skip = 1;
      while (skip < tokens.length && tokens[skip].startsWith("-")) {
        skip += /^-[nIPLdEsa]$/.test(tokens[skip]) ? 2 : 1;
      }
    }
    if (skip > 0) tokens = tokens.slice(skip);
    current = tokens.join(" ").trim();
    if (current === before) break;
  }
  return current;
}

// The command texts inside $( ), <( ), >( ) and backticks of a segment, outermost first.
// Single-quoted text is literal and skipped; double-quoted text is scanned, as the shell
// does. An unclosed one runs to the end of the segment.
export function extractSubstitutions(segment) {
  return scanSubstitutions(segment).map((s) => s.text);
}

// The command texts inside <( ) and >( ) only (a process substitution).
export function processSubstitutions(segment) {
  return scanSubstitutions(segment).filter((s) => s.kind !== "$" && s.kind !== "`").map((s) => s.text);
}

function scanSubstitutions(segment) {
  const found = [];
  if (typeof segment !== "string") return found;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" && quote === null) { quote = "'"; continue; }
    if (ch === '"') { quote = quote === '"' ? null : '"'; continue; }
    if ((ch === "$" || ch === "<" || ch === ">") && segment[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < segment.length && depth > 0; j++) {
        if (segment[j] === "(") depth++;
        else if (segment[j] === ")") depth--;
      }
      found.push({ kind: ch, text: segment.slice(i + 2, depth === 0 ? j - 1 : j) });
      i = (depth === 0 ? j - 1 : j);
      continue;
    }
    if (ch === "`") {
      const end = segment.indexOf("`", i + 1);
      found.push({ kind: "`", text: segment.slice(i + 1, end === -1 ? segment.length : end) });
      i = end === -1 ? segment.length : end;
    }
  }
  return found.map((t) => ({ kind: t.kind, text: t.text.trim() })).filter((t) => t.text);
}

// Heredocs. The body of a heredoc that a shell reads (`bash <<EOF`, `sh -s <<'E'`) is
// commands and is checked like any other line; the body of any other heredoc is data
// (a commit message, a file being written, a Python script) and is not read as shell.
// A here-string to a shell (`bash <<< "..."`) is commands too. Returns the command text
// without the data bodies, the shell bodies, and the bodies that ran to the end without
// their closing word (read as commands: something is off).
export function extractHeredocs(cmd) {
  const result = { text: "", shellBodies: [] };
  if (typeof cmd !== "string") return result;
  const lines = cmd.split(/\r?\n/);
  const out = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    out.push(line);
    const pending = [];
    const re = /(^|[^<])<<(-?)\s*(?:'([A-Za-z_][\w.-]*)'|"([A-Za-z_][\w.-]*)"|\\?([A-Za-z_][\w.-]*))/g;
    // Single-quoted text is literal: a `<<` inside it is not a heredoc. The quotes of the
    // delimiter itself (`<<'E'`) are part of the operator, so they are kept.
    const unquoted = line.replace(/(<<-?\s*)?'[^']*'/g, (m, op) => (op ? m : " ".repeat(m.length)));
    let m;
    while ((m = re.exec(unquoted)) !== null) {
      const at = m.index + m[1].length;
      const owner = unquoted.slice(0, at).split(/&&|\|\||;|\|/).pop();
      pending.push({ word: m[3] || m[4] || m[5], tabs: m[2] === "-", shell: SHELLS.has(basenameOfCommand(normalizeSegment(owner).split(/\s+/)[0] || "")) });
    }
    const here = /(^|[^<])<<<\s*(.+)$/.exec(unquoted);
    if (here) {
      const owner = unquoted.slice(0, here.index + here[1].length).split(/&&|\|\||;|\|/).pop();
      if (SHELLS.has(basenameOfCommand(normalizeSegment(owner).split(/\s+/)[0] || ""))) {
        result.shellBodies.push(stripQuotes(line.slice(here.index + here[1].length + 3).trim()));
      }
    }
    for (const doc of pending) {
      const body = [];
      let closed = false;
      while (li + 1 < lines.length) {
        li++;
        const candidate = doc.tabs ? lines[li].replace(/^\t+/, "") : lines[li];
        if (candidate === doc.word) { closed = true; break; }
        body.push(lines[li]);
      }
      if (doc.shell || !closed) result.shellBodies.push(body.join("\n"));
    }
  }
  result.text = out.join("\n");
  return result;
}

// What cannot be read at all: a shell that reads its commands from a pipe or from stdin
// (`... | bash`, `curl ... | sh`), and eval / sh -c whose whole code is a variable.
export function isUnreadableShellInput(segment, isPartOfLargerLine) {
  const normalized = normalizeSegment(segment);
  const tokens = tokenizeWords(normalized);
  if (tokens.length === 0) return false;
  const name = basenameOfCommand(tokens[0]);
  if (SHELLS.has(name) && isPartOfLargerLine) {
    const rest = tokens.slice(1);
    const readsStdin = rest.every((t) => t.startsWith("-") && !/c/.test(t.replace(/^--?/, "").slice(0, 1) === "c" ? "c" : "")) || rest.includes("-s") || rest.includes("-");
    if (readsStdin && !rest.some((t) => /^-[A-Za-z]*c[A-Za-z]*$/.test(t) || /^-(Command|c|File)$/i.test(t))) return true;
  }
  if (/^eval$/i.test(tokens[0]) && tokens.length >= 2 && /^["']?\$/.test(tokens[1])) return true;
  const inner = unwrapInterpreterCommand(normalized);
  if (inner !== null && /^\$[{A-Za-z_(]/.test(inner.trim())) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The allow list's companion: for every command `.claude/settings.json` lets through
// without a question, this hook stays silent ONLY when every option is on an explicit list
// of options known to be safe for that command. An unknown option asks — and so does an
// abbreviated long option (git and the GNU tools accept `--upload` for `--upload-pack`,
// `--out` for `--output`, `--in-pl` for `--in-place`): it is simply not on the list.
// Words are judged as the shell passes them (quotes and backslashes removed).
// ---------------------------------------------------------------------------

// The word the shell passes to the program: quotes removed, backslash escapes resolved,
// $'...' (ANSI-C) decoded. `'git'`, `g\it`, `re""set`, `$'reset'` are all plain words.
export function shellWord(raw) {
  if (typeof raw !== "string") return "";
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end < 0) { out += raw.slice(i + 1); break; }
      out += raw.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === "$" && raw[i + 1] === "'") {
      let j = i + 2;
      while (j < raw.length && raw[j] !== "'") {
        if (raw[j] === "\\" && j + 1 < raw.length) {
          const e = raw[j + 1];
          if (e === "x" && /^[0-9a-fA-F]{1,2}/.test(raw.slice(j + 2))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(j + 2))[0];
            out += String.fromCharCode(parseInt(hex, 16));
            j += 2 + hex.length;
            continue;
          }
          if ((e === "u" || e === "U") && /^[0-9a-fA-F]/.test(raw.slice(j + 2))) {
            const hex = new RegExp(`^[0-9a-fA-F]{1,${e === "u" ? 4 : 8}}`).exec(raw.slice(j + 2))[0];
            const code = parseInt(hex, 16);
            out += code <= 0x10ffff ? String.fromCodePoint(code) : "";
            j += 2 + hex.length;
            continue;
          }
          if (e === "c" && j + 2 < raw.length) { out += String.fromCharCode(raw.charCodeAt(j + 2) & 0x1f); j += 3; continue; }
          if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(raw.slice(j + 1))[0];
            out += String.fromCharCode(parseInt(oct, 8));
            j += 1 + oct.length;
            continue;
          }
          out += { n: "\n", t: "\t", r: "\r", a: "\x07", e: "\x1b", "\\": "\\", "'": "'", '"': '"' }[e] ?? e;
          j += 2;
          continue;
        }
        out += raw[j];
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === "\\" && /["\\$`]/.test(raw[j + 1] ?? "")) { out += raw[j + 1]; j += 2; continue; }
        out += raw[j];
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < raw.length) { out += raw[i + 1]; i += 2; continue; }
    out += ch;
    i++;
  }
  return out;
}

// The command's words as the program receives them, after the wrappers (env, sudo, ...).
// Redirection words (`2>&1`, `> file`, `2>/dev/null`, `<<'EOF'`) are not arguments of the
// program; output targets are judged on their own (outputRedirectTargets).
function withoutRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const m = /^(\d*|&)(>>?|>\||>&|<<<|<<-?|<&|<)(.*)$/.exec(t);
    if (m && !/^[<>]\(/.test(t.slice(m[1].length))) {
      if (m[3] === "" && i + 1 < tokens.length) i++; // the target is the next word
      continue;
    }
    out.push(t);
  }
  return out;
}

// A substitution is one word to the program (its output, or /dev/fd/N); its own words are
// judged separately (extractSubstitutions). Masked here so `cat <(sort -r x)` is cat with one
// operand, not cat with the option -r.
export function maskSubstitutions(segment) {
  if (typeof segment !== "string") return "";
  let out = "";
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === "'") { out += ch; if (ch === "'") quote = null; continue; }
    if (ch === "\\") { out += ch + (segment[i + 1] ?? ""); i++; continue; }
    if (ch === "'" && quote === null) { quote = "'"; out += ch; continue; }
    if (ch === '"') { quote = quote === '"' ? null : '"'; out += ch; continue; }
    if ((ch === "$" || ch === "<" || ch === ">") && segment[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < segment.length && depth > 0; j++) {
        if (segment[j] === "(") depth++;
        else if (segment[j] === ")") depth--;
      }
      out += ch === "$" ? "SUBSTITUTED" : "/dev/fd/63";
      i = j - 1;
      continue;
    }
    if (ch === "`") {
      const end = segment.indexOf("`", i + 1);
      out += "SUBSTITUTED";
      i = end === -1 ? segment.length : end;
      continue;
    }
    out += ch;
  }
  return out;
}

export function commandWords(segment) {
  return withoutRedirections(tokenizeWords(normalizeSegment(maskSubstitutions(segment)))).map(shellWord);
}

// Option lists. short: letters without a value; shortArg: letters that take a value (the
// rest of the cluster or the next word); long: --names without a value; longArg: --names
// that take a value (`--x=v` or `--x v`); longOpt: --names whose value is optional and only
// given as `--x=v`. numeric: `-5` counts as a short option.
function spec(s) {
  return {
    short: s.short ?? "",
    shortArg: s.shortArg ?? "",
    long: new Set(s.long ?? []),
    longArg: new Set(s.longArg ?? []),
    longOpt: new Set(s.longOpt ?? []),
    numeric: Boolean(s.numeric),
    operands: s.operands ?? null,
    value: s.value ?? null, // (name, value) => boolean, for options whose value matters
  };
}

// True when every option of `args` is on the list (and the operands pass, if checked).
export function optionsAreKnown(args, sp) {
  const operands = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === "--") { operands.push(...args.slice(i + 1)); break; }
    if (w === "-" || !w.startsWith("-")) { operands.push(w); continue; }
    if (w.startsWith("--")) {
      const eq = w.indexOf("=");
      const name = eq < 0 ? w : w.slice(0, eq);
      let value = eq < 0 ? null : w.slice(eq + 1);
      if (sp.long.has(name) && eq < 0) continue;
      if (sp.longOpt.has(name)) { if (sp.value && value !== null && !sp.value(name, value)) return false; continue; }
      if (sp.longArg.has(name)) {
        if (eq < 0) { if (i + 1 >= args.length) return false; value = args[++i]; }
        if (sp.value && !sp.value(name, value)) return false;
        continue;
      }
      return false;
    }
    if (sp.numeric && /^-\d+$/.test(w)) continue;
    const letters = w.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const c = letters[k];
      if (sp.shortArg.includes(c)) {
        let value = letters.slice(k + 1);
        if (value === "") { if (i + 1 >= args.length) return false; value = args[++i]; }
        if (sp.value && !sp.value(`-${c}`, value)) return false;
        break;
      }
      if (sp.short.includes(c)) continue;
      return false;
    }
  }
  return sp.operands ? sp.operands(operands) : true;
}

const GREP = spec({
  short: "EFGPiyvwxcLlmoqsbHhnTZzrRUaIs",
  shortArg: "efABCmdD",
  long: ["--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--ignore-case", "--no-ignore-case", "--invert-match",
    "--word-regexp", "--line-regexp", "--count", "--files-with-matches", "--files-without-match", "--only-matching", "--quiet", "--silent",
    "--no-messages", "--byte-offset", "--with-filename", "--no-filename", "--line-number", "--initial-tab", "--null", "--null-data",
    "--recursive", "--dereference-recursive", "--text", "--line-buffered", "--binary"],
  longArg: ["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude",
    "--exclude-dir", "--exclude-from", "--label", "--binary-files", "--devices", "--directories"],
  longOpt: ["--color", "--colour"],
  numeric: true,
});
const RG = spec({
  short: "inSswxFlcoUuvHIL0qNpPa",
  shortArg: "ABCegtTmjMfrd",
  long: ["--files", "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--hidden", "--no-ignore", "--no-ignore-vcs",
    "--json", "--line-number", "--no-line-number", "--no-heading", "--heading", "--fixed-strings", "--ignore-case", "--smart-case",
    "--case-sensitive", "--word-regexp", "--line-regexp", "--multiline", "--multiline-dotall", "--vimgrep", "--follow", "--only-matching",
    "--trim", "--stats", "--null", "--no-filename", "--with-filename", "--invert-match", "--unrestricted", "--type-list", "--quiet",
    "--pcre2", "--no-messages", "--column", "--no-column", "--byte-offset", "--crlf", "--text", "--no-config", "--sort-files", "--debug"],
  longArg: ["--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--context", "--after-context", "--before-context",
    "--regexp", "--file", "--replace", "--threads", "--max-columns", "--sort", "--sortr", "--color", "--colors", "--encoding", "--max-filesize",
    "--context-separator", "--field-match-separator", "--path-separator"],
});
const CAT = spec({ short: "nbsAETvet", long: ["--number", "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends", "--show-tabs", "--show-nonprinting"] });
const HEAD_TAIL = spec({
  short: "qvzfF",
  shortArg: "ncs",
  long: ["--quiet", "--silent", "--verbose", "--zero-terminated", "--follow", "--retry"],
  longArg: ["--lines", "--bytes", "--sleep-interval", "--pid", "--max-unchanged-stats"],
  numeric: true,
});
const LS = spec({
  short: "laAhRtrSdF1iGogsCxmpLHcuUXvQNbqkn",
  shortArg: "IwT",
  long: ["--all", "--almost-all", "--human-readable", "--si", "--recursive", "--reverse", "--directory", "--classify", "--full-time",
    "--group-directories-first", "--no-group", "--numeric-uid-gid", "--size", "--inode", "--dereference", "--literal", "--escape",
    "--quote-name", "--author", "--file-type"],
  longArg: ["--ignore", "--hide", "--width", "--tabsize", "--block-size"],
  longOpt: ["--color", "--colour", "--time-style", "--sort", "--time", "--format", "--indicator-style", "--quoting-style", "--hyperlink"],
});
const WC = spec({ short: "lwcmL", long: ["--lines", "--words", "--bytes", "--chars", "--max-line-length"] });
const CUT = spec({
  short: "snz",
  shortArg: "dfcb",
  long: ["--complement", "--only-delimited", "--zero-terminated"],
  longArg: ["--delimiter", "--fields", "--characters", "--bytes", "--output-delimiter"],
});
const DIFF = spec({
  short: "uqrNwbBiayspdtTEZcnHe",
  shortArg: "UCWxXIFS",
  long: ["--brief", "--recursive", "--new-file", "--unidirectional-new-file", "--ignore-all-space", "--ignore-space-change",
    "--ignore-blank-lines", "--ignore-case", "--ignore-tab-expansion", "--ignore-trailing-space", "--text", "--side-by-side",
    "--report-identical-files", "--show-c-function", "--strip-trailing-cr", "--suppress-common-lines", "--left-column", "--minimal",
    "--speed-large-files", "--no-dereference", "--normal", "--expand-tabs", "--initial-tab", "--suppress-blank-empty", "--ed", "--rcs"],
  longArg: ["--unified", "--context", "--width", "--label", "--exclude", "--exclude-from", "--ignore-matching-lines", "--show-function-line",
    "--starting-file", "--from-file", "--to-file", "--tabsize", "--horizon-lines"],
  longOpt: ["--color"],
});
const SORT = spec({
  short: "nrufbdghiMVRszcCm",
  shortArg: "ktS",
  long: ["--numeric-sort", "--reverse", "--unique", "--ignore-case", "--ignore-leading-blanks", "--dictionary-order", "--general-numeric-sort",
    "--human-numeric-sort", "--ignore-nonprinting", "--month-sort", "--version-sort", "--random-sort", "--stable", "--zero-terminated",
    "--check", "--merge"],
  longArg: ["--key", "--field-separator", "--buffer-size", "--parallel"],
  longOpt: ["--sort"],
});
const UNIQ = spec({
  short: "cduiDz",
  shortArg: "fsw",
  long: ["--count", "--repeated", "--unique", "--ignore-case", "--zero-terminated"],
  longArg: ["--skip-fields", "--skip-chars", "--check-chars"],
  longOpt: ["--all-repeated", "--group"],
  operands: (ops) => ops.length <= 1, // uniq INPUT OUTPUT writes OUTPUT
});
const SED_N = spec({
  short: "nErsuz",
  shortArg: "el",
  long: ["--quiet", "--silent", "--regexp-extended", "--separate", "--unbuffered", "--null-data", "--sandbox", "--posix", "--debug"],
  longArg: ["--expression", "--line-length"],
});

const FIND_NO_ARG = new Set(["-print", "-print0", "-prune", "-not", "-o", "-or", "-a", "-and", "-empty", "-true", "-false", "-readable",
  "-writable", "-executable", "-depth", "-mount", "-xdev", "-noleaf", "-ignore_readdir_race", "-daystart", "-follow", "-ls", "-quit",
  "-nouser", "-nogroup", "-L", "-P", "-H", "(", ")", "!", ","]);
const FIND_WITH_ARG = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type", "-xtype",
  "-maxdepth", "-mindepth", "-newer", "-anewer", "-cnewer", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-perm",
  "-user", "-group", "-uid", "-gid", "-links", "-inum", "-samefile", "-lname", "-ilname", "-regextype", "-printf", "-used", "-fstype"]);

function findIsKnown(args) {
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (FIND_NO_ARG.has(w)) continue;
    if (FIND_WITH_ARG.has(w)) { if (i + 1 >= args.length) return false; i++; continue; }
    if (/^-(newer[aBcmt]{2})$/.test(w)) { i++; continue; }
    if (/^-O[0-3]$/.test(w) || /^-D$/.test(w)) { if (w === "-D") i++; continue; }
    if (w.startsWith("-")) return false; // -exec, -execdir, -ok, -okdir, -delete, -fprint*, -fls, -files0-from, anything else
  }
  return true;
}

// node --test: test files under backend/tests or frontend/tests (no "..", no absolute path),
// and only these flags. --import/--require/--loader would load a module from anywhere.
const NODE_TEST_FILE_RE = /^(?:\.\/)?(?:backend|frontend)\/tests\/[A-Za-z0-9_.*?/@{},-]*$/;
const NODE_TEST = spec({
  long: ["--test-only", "--test-force-exit", "--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-test-coverage",
    "--test-update-snapshots-never"],
  longArg: ["--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout", "--test-shard", "--experimental-test-isolation",
    "--test-isolation", "--test-reporter", "--test-reporter-destination"],
  value: (name, value) => {
    if (name === "--test-reporter") return ["spec", "tap", "dot", "junit", "lcov"].includes(value);
    if (name === "--test-reporter-destination") return value === "stdout" || value === "stderr";
    if (name === "--experimental-test-isolation" || name === "--test-isolation") return value === "none" || value === "process";
    return true;
  },
  operands: (ops) => ops.length > 0 && ops.every((p) => NODE_TEST_FILE_RE.test(p) && !/(^|\/)\.\.(\/|$)/.test(p)),
});

// git: the subcommands the allow list lets through, each with its own option list. Global
// options before the subcommand: only -C <dir>, --no-pager/-P, --no-optional-locks,
// --literal-pathspecs (a -c config override is judged separately: it asks).
const GIT_LOG_FAMILY = {
  short: "pusbwrtzaRWMCnBqLSGXDl", // -S/-G/-L/-n/-X take a value (shortArg below wins)
  shortArg: "nSGLUMCBlXO",
  long: ["--patch", "--no-patch", "--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--raw", "--cached",
    "--staged", "--check", "--no-color", "--ignore-all-space", "--ignore-space-change", "--ignore-blank-lines", "--ignore-space-at-eol",
    "--ignore-cr-at-eol", "--pickaxe-all", "--all", "--graph", "--no-decorate", "--first-parent", "--merges", "--no-merges", "--reverse",
    "--abbrev-commit", "--no-abbrev-commit", "--relative-date", "--follow", "--left-right", "--cherry-pick", "--cherry-mark", "--cherry",
    "--boundary", "--topo-order", "--date-order", "--author-date-order", "--full-history", "--simplify-by-decoration", "--ancestry-path",
    "--exit-code", "--quiet", "--merge-base", "--no-index", "--full-index", "--binary", "--no-prefix", "--no-renames", "--histogram",
    "--patience", "--minimal", "--function-context", "--text", "--compact-summary", "--no-ext-diff", "--no-textconv", "--oneline",
    "--no-walk", "--do-walk", "--log-size", "--source", "--use-mailmap", "--no-use-mailmap", "--remove-empty", "--show-pulls",
    "--sparse", "--dense", "--children", "--parents", "--not", "--ignore-submodules", "--irreversible-delete", "--no-stat", "--keep-base",
    "--root", "--no-merges", "--expand-tabs", "--no-expand-tabs", "--no-notes", "--regexp-ignore-case", "--extended-regexp",
    "--fixed-strings", "--perl-regexp", "--basic-regexp", "--invert-grep", "--all-match", "--date-order", "--minimal", "--indent-heuristic",
    "--no-indent-heuristic", "--default-prefix", "--stdin", "--diff-merges", "--combined-all-paths", "--cc", "--remerge-diff", "--no-diff-merges"],
  longArg: ["--max-count", "--skip", "--since", "--after", "--until", "--before", "--author", "--committer", "--grep", "--diff-filter",
    "--src-prefix", "--dst-prefix", "--anchored", "--diff-algorithm", "--stat-width", "--stat-name-width", "--stat-count", "--stat-graph-width",
    "--inter-hunk-context", "--encoding", "--output-indicator-new", "--output-indicator-old", "--output-indicator-context", "--max-age",
    "--min-age", "--min-parents", "--max-parents", "--exclude", "--word-diff-regex", "--color-moved-ws", "--submodule", "--find-object",
    "--ws-error-highlight", "--abbrev"],
  longOpt: ["--stat", "--dirstat", "--format", "--pretty", "--color", "--word-diff", "--color-words", "--find-renames", "--find-copies",
    "--break-rewrites", "--relative", "--decorate", "--decorate-refs", "--decorate-refs-exclude", "--date", "--branches", "--tags",
    "--remotes", "--glob", "--unified", "--color-moved", "--abbrev", "--ignore-submodules", "--submodule", "--notes", "--expand-tabs",
    "--diff-merges", "--show-linear-break", "--no-walk", "--cc"],
  numeric: true,
};
const REMOTE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const GIT_SUBCOMMANDS = {
  status: spec({
    short: "sbvzu",
    shortArg: "",
    long: ["--short", "--branch", "--long", "--verbose", "--null", "--ahead-behind", "--no-ahead-behind", "--renames", "--no-renames",
      "--show-stash", "--no-column"],
    longOpt: ["--porcelain", "--untracked-files", "--ignored", "--ignore-submodules", "--find-renames", "--column"],
  }),
  diff: spec(GIT_LOG_FAMILY),
  log: spec(GIT_LOG_FAMILY),
  show: spec(GIT_LOG_FAMILY),
  fetch: spec({
    short: "qvpPnt",
    shortArg: "j",
    long: ["--quiet", "--verbose", "--prune", "--prune-tags", "--tags", "--no-tags", "--dry-run", "--unshallow", "--progress",
      "--no-progress", "--porcelain", "--no-recurse-submodules", "--all", "--no-write-fetch-head", "--write-fetch-head", "--atomic"],
    longArg: ["--depth", "--deepen", "--shallow-since", "--shallow-exclude", "--jobs"],
    // a remote name or URL, and branch names; never a refspec with ":" (it writes local refs)
    // a remote NAME (origin), then branch names; never a URL or a path (a request to any host),
    // never a refspec with ":" (it writes local refs)
    operands: (ops) => ops.every((o, idx) => (idx === 0 ? REMOTE_NAME_RE.test(o) : /^[A-Za-z0-9_./@-]+$/.test(o) && !o.includes(":"))),
  }),
  "rev-parse": spec({
    short: "q",
    long: ["--verify", "--quiet", "--abbrev-ref", "--symbolic", "--symbolic-full-name", "--show-toplevel", "--git-dir", "--git-common-dir",
      "--absolute-git-dir", "--is-inside-work-tree", "--is-inside-git-dir", "--is-bare-repository", "--is-shallow-repository",
      "--show-prefix", "--show-cdup", "--all", "--sq", "--not", "--revs-only", "--no-revs", "--flags", "--no-flags", "--local-env-vars",
      "--show-object-format", "--show-superproject-working-tree", "--sq-quote"],
    longArg: ["--default", "--prefix"],
    longOpt: ["--short", "--branches", "--tags", "--remotes", "--glob", "--abbrev-ref", "--disambiguate", "--path-format"],
  }),
  "merge-base": spec({ short: "a", long: ["--is-ancestor", "--all", "--octopus", "--independent", "--fork-point"] }),
  "ls-remote": spec({
    short: "htq",
    long: ["--heads", "--tags", "--branches", "--refs", "--quiet", "--exit-code", "--symref", "--get-url"],
    longArg: ["--sort"],
    operands: (ops) => ops.every((o, idx) => (idx === 0 ? REMOTE_NAME_RE.test(o) : /^[A-Za-z0-9_./*@-]+$/.test(o) && !o.includes(":"))),
  }),
  "ls-tree": spec({
    short: "rtdlz",
    long: ["--long", "--name-only", "--name-status", "--object-only", "--full-name", "--full-tree"],
    longArg: ["--format"],
    longOpt: ["--abbrev"],
  }),
  "merge-tree": spec({
    short: "z",
    shortArg: "X",
    long: ["--write-tree", "--name-only", "--no-messages", "--messages", "--allow-unrelated-histories", "--trivial-merge"],
    longArg: ["--merge-base", "--strategy-option"],
  }),
};
const GIT_WORKTREE_LIST = spec({ short: "vz", long: ["--porcelain", "--verbose"], longArg: ["--expire"] });

// The commands the allow list lets through, with what this hook accepts for each.
// Returns null when the command is not one of them (its question is Claude Code's).
export function allowedCommandOptionsAreKnown(words) {
  if (!words.length) return null;
  const name = words[0];
  const args = words.slice(1);
  if (name === "grep") return optionsAreKnown(args, GREP);
  if (name === "rg") return optionsAreKnown(args, RG);
  if (name === "cat") return optionsAreKnown(args, CAT);
  if (name === "head" || name === "tail") return optionsAreKnown(args, HEAD_TAIL);
  if (name === "ls") return optionsAreKnown(args, LS);
  if (name === "wc") return optionsAreKnown(args, WC);
  if (name === "cut") return optionsAreKnown(args, CUT);
  if (name === "diff") return optionsAreKnown(args, DIFF);
  if (name === "sort") return optionsAreKnown(args, SORT);
  if (name === "uniq") return optionsAreKnown(args, UNIQ);
  if (name === "find") return findIsKnown(args);
  if (name === "sed" && args[0] === "-n") return optionsAreKnown(args, SED_N); // the script: sedRawScriptsAreReadOnly
  if (name === "node" && args[0] === "--test") return optionsAreKnown(args.slice(1), NODE_TEST);
  if (name === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) {
      if (args[i] === "-C") { i += 2; continue; }
      if (["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"].includes(args[i])) { i += 1; continue; }
      return Object.prototype.hasOwnProperty.call(GIT_SUBCOMMANDS, args.find((a) => !a.startsWith("-")) ?? "") ? false : null;
    }
    const sub = args[i];
    if (sub === "worktree" && args[i + 1] === "list") return optionsAreKnown(args.slice(i + 2), GIT_WORKTREE_LIST);
    if (!Object.prototype.hasOwnProperty.call(GIT_SUBCOMMANDS, sub)) return null;
    return optionsAreKnown(args.slice(i + 1), GIT_SUBCOMMANDS[sub]);
  }
  return null;
}

const SED_SIMPLE_COMMANDS = new Set(["p", "P", "=", "q", "Q", "l", "n", "N", "d", "D", "g", "G", "h", "H", "x", "z", "{", "}"]);

// A sed script that only selects and prints: addresses, and the commands above, `s///`
// and `y///` without the e or w flags, `a`/`i`/`c` text, labels and branches. Anything
// else (w, W, e, r, R, s///w, s///e, an unparseable script) is not read-only.
export function isReadOnlySedScript(script) {
  if (typeof script !== "string") return false;
  let i = 0;
  const n = script.length;
  const skipRegex = (start, delim) => {
    let j = start;
    while (j < n && script[j] !== delim) { if (script[j] === "\\") j++; j++; }
    return j < n ? j + 1 : -1;
  };
  const skipAddress = () => {
    if (/[0-9]/.test(script[i] || "")) { while (/[0-9~]/.test(script[i] || "")) i++; return true; }
    if (script[i] === "$") { i++; return true; }
    if (script[i] === "/") { const j = skipRegex(i + 1, "/"); if (j < 0) return null; i = j; while (/[IM]/.test(script[i] || "")) i++; return true; }
    if (script[i] === "\\" && i + 1 < n) { const d = script[i + 1]; const j = skipRegex(i + 2, d); if (j < 0) return null; i = j; while (/[IM]/.test(script[i] || "")) i++; return true; }
    return false;
  };
  while (i < n) {
    while (i < n && /[\s;]/.test(script[i])) i++;
    if (i >= n) break;
    if (script[i] === "#") { while (i < n && script[i] !== "\n") i++; continue; }
    const a1 = skipAddress();
    if (a1 === null) return false;
    if (a1 && script[i] === ",") { i++; if (script[i] === "+" || script[i] === "~") { i++; while (/[0-9]/.test(script[i] || "")) i++; } else if (skipAddress() !== true) return false; }
    while (i < n && /\s/.test(script[i])) i++;
    if (script[i] === "!") { i++; while (i < n && /\s/.test(script[i])) i++; }
    const c = script[i];
    if (c === undefined) return !a1 ? true : false;
    if (SED_SIMPLE_COMMANDS.has(c)) { i++; continue; }
    if (c === ":" || c === "b" || c === "t" || c === "T") { while (i < n && script[i] !== ";" && script[i] !== "\n" && script[i] !== "}") i++; continue; }
    if (c === "a" || c === "i" || c === "c") { while (i < n && script[i] !== "\n") i++; continue; }
    if (c === "s" || c === "y") {
      const d = script[i + 1];
      if (!d || /[\s\\\n]/.test(d)) return false;
      let j = skipRegex(i + 2, d); if (j < 0) return false;
      j = skipRegex(j, d); if (j < 0) return false;
      i = j;
      if (c === "s") {
        while (i < n && /[gpiImM0-9]/.test(script[i])) i++;
        if (/[ewEW]/.test(script[i] || "")) return false;
      }
      continue;
    }
    return false; // w W e r R F v and anything unknown
  }
  return true;
}

// The raw-text side of sed: inside a double-quoted or unquoted script the shell expands
// $n and $((n+1)) before sed sees them; in practice these are line numbers. The words the
// shell passes are judged above; here, a script whose RAW text holds such expansions is
// read with each expansion as the number 1, so "$n,\$p" is the read-only "1,$p".
export function sedRawScriptsAreReadOnly(segment) {
  const tokens = tokenizeWords(normalizeSegment(segment));
  if (shellWord(tokens[0] ?? "") !== "sed" || shellWord(tokens[1] ?? "") !== "-n") return true;
  const expand = (raw) => raw.startsWith("'") ? shellWord(raw) : shellWord(raw
    .replace(/\\\$/g, "\u0000")
    .replace(/\$\(\([^)]*\)\)/g, "1")
    .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "1"))
    .replace(/\u0000/g, "$");
  const rest = tokens.slice(1);
  if (rest.some((t) => shellWord(t) === "--sandbox")) return true; // sed itself refuses w, e and r then
  const scripts = [];
  let first = true;
  for (let k = 0; k < rest.length; k++) {
    const word = shellWord(rest[k]);
    if (word === "-e" || word === "--expression") { scripts.push(rest[k + 1] ?? ""); k++; first = false; continue; }
    if (word.startsWith("--expression=")) { scripts.push(rest[k].replace(/^--expression=/, "")); first = false; continue; }
    if (word.startsWith("-")) continue;
    if (first) { scripts.push(rest[k]); first = false; }
  }
  return scripts.every((raw) => isReadOnlySedScript(expand(raw)));
}

// Environment variables that change what an allowed command runs or loads. Set in front
// of a command (or with env, or exported anywhere in the line), they ask.
const DANGEROUS_ENV_RE = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+|BASH_ENV|ENV|PATH|PAGER|MANPAGER|LESSOPEN|LESSCLOSE|EDITOR|VISUAL|SHELLOPTS|BASHOPTS|PS4|PROMPT_COMMAND|GIT_[A-Z_]+|RIPGREP_CONFIG_PATH|GREP_OPTIONS|IFS)$/;

export function setsDangerousEnvironment(segment) {
  let text = typeof segment === "string" ? segment.trim() : "";
  const exported = /^(?:export|declare\s+-x|typeset\s+-x)\s+/.test(text);
  text = text.replace(/^(?:export|declare\s+-x|typeset\s+-x)\s+/, "");
  let tokens = tokenizeWords(text);
  if (tokens[0] === "env") tokens = tokens.slice(1).filter((t) => !t.startsWith("-"));
  for (const t of tokens) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t);
    if (!m) break;
    if (DANGEROUS_ENV_RE.test(m[1])) return true;
  }
  return exported && tokens.some((t) => DANGEROUS_ENV_RE.test(t)); // `export PAGER` after PAGER=... earlier
}

// Output redirections of a raw segment: the targets of >, >>, >|, &>, &>>, N>, N>>.
// Duplications (>&2, 2>&1, >&-) are not files.
export function outputRedirectTargets(segment) {
  const targets = [];
  if (typeof segment !== "string") return targets;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch !== ">") continue;
    if (segment[i + 1] === "(") continue; // >( ) process substitution
    let j = i + 1;
    if (segment[j] === ">" || segment[j] === "|") j++;
    if (segment[j] === "&") { // >&2, >&-  (a duplication), unless &> form handled below
      continue;
    }
    while (segment[j] === " " || segment[j] === "\t") j++;
    let k = j;
    let q = null;
    for (; k < segment.length; k++) {
      const c = segment[k];
      if (q) { if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; continue; }
      if (c === "\\") { k++; continue; }
      if (/[\s;&|<>()]/.test(c)) break;
    }
    targets.push(segment.slice(j, k));
    i = k - 1;
  }
  return targets;
}

const DEVICE_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

// Where a redirect may write without a question: only a NEW file in the system's temporary
// directory, not inside a git work tree (an executor's or reviewer's worktree lives under the
// temporary directory too) and not inside or named `.git`. Every symbolic link is followed
// (the target's, or its nearest existing parent's). An EXISTING file always asks: whatever it
// is, rewriting it may change something that runs later (a script, package.json, a SQL file
// for psql -f, a patch for git apply, a list for xargs, a postgresql.conf).

function tempRoots() {
  const roots = new Set();
  for (const t of [os.tmpdir(), "/tmp"]) {
    try { roots.add(fs.realpathSync(t)); } catch { /* missing on this system */ }
  }
  return roots;
}

// The walk goes up to the root of the file system, not only to the temporary directory: a
// TMPDIR that itself lies inside a repository is a work tree too.
function insideGitWorkTreeOrGitDir(realPath) {
  if (realPath.split(/[\\/]/).some((part) => part.toLowerCase() === ".git")) return true;
  let dir = realPath;
  for (let n = 0; n < 256; n++) {
    try { if (fs.existsSync(path.join(dir, ".git"))) return true; } catch { return true; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export function isWritableTempTarget(target) {
  // An existing file, link or folder always asks; so does a dangling link.
  try { fs.lstatSync(target); return false; } catch { /* does not exist yet: go on */ }
  // the real place of the new file: its nearest existing parent, every link followed
  // The parts of the path that do not exist yet are kept: /tmp/x/.git/hooks/f with only /tmp/x
  // existing is still a path through a .git.
  let probe = path.dirname(target);
  const missing = [path.basename(target)];
  let real = null;
  for (let n = 0; n < 64 && real === null; n++) {
    try { real = fs.realpathSync(probe); } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      missing.unshift(path.basename(probe));
      probe = parent;
    }
  }
  if (real === null) return false;
  const root = [...tempRoots()].find((r) => real === r || real.startsWith(r + path.sep));
  if (!root) return false;
  return !insideGitWorkTreeOrGitDir(path.join(real, ...missing));
}

// A redirect target is harmless when it is a device, or a plain absolute path that
// isWritableTempTarget accepts.
export function isHarmlessRedirectTarget(rawTarget, variables = new Map()) {
  let raw = rawTarget;
  for (const [name, value] of variables) {
    raw = raw.split("${" + name + "}").join(value).split("$" + name).join(value);
  }
  if (/[$`*?[\]{}~]/.test(raw)) return false; // cannot be read here
  const target = shellWord(raw);
  if (DEVICE_TARGETS.has(target) || /^\/dev\/fd\/\d+$/.test(target)) return true;
  if (!path.isAbsolute(target)) return false;
  if (target.split(/[\\/]/).includes("..")) return false;
  return isWritableTempTarget(target);
}

// Plain assignments in a command line (`S=/tmp/x`, `export S=/tmp/x`): their values are
// known, so `> $S/out.txt` can be judged. A name assigned twice, or a value with an
// expansion in it, is not used.
// The separators between the top-level parts of a line, in order (";", "\n", "&&", "||", "|",
// "|&", "&"), read with the same quoting rules as splitCommandSegments.
export function lineSeparators(cmd) {
  const found = [];
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "|&") { found.push(two); i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "\r") { found.push(ch === "\r" ? "\n" : ch); continue; }
    if (ch === "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && cmd[i + 1] !== ">") found.push("&");
  }
  return found;
}

const PLAIN_ASSIGNMENT_RE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=([^\s$`'"\\();|&<>{}]*)$/;
// Commands that can set a variable some other way than NAME=value (or run code that does).
const VARIABLE_SETTERS = new Set(["eval", "source", ".", "read", "mapfile", "readarray", "declare", "typeset", "local", "readonly",
  "unset", "let", "getopts", "printf", "export", "alias", "select", "trap", "builtin", "command", "exec", "set", "shift", "for",
  "while", "until", "if", "case", "function", "coproc", "then", "do", "else", "elif"]);

// The variables a redirect may use: only in a line made of plain assignments `NAME=value`
// (no $, backtick, quotes or substitution in the value; `export NAME=value` too) and plain
// commands, joined by ";" or a newline — or by "&&" before the first assignment only — with no
// "||", pipe or background job anywhere. A variable mentioned in any other form before the
// redirect (`read S`, `for S in`, `S+=`, `${S:=x}`, `unset S`, `S=$(...)`, a prefix
// `S=x cmd`, ...) is unknown, and so is every variable when a part could set one another way
// (eval, source, read, declare, a loop, a function, ...). Returns one Map per top-level part:
// the certain values of the parts before it. Anything unknown means the redirect asks.
// The command word of a part once the prefixes that run a command unchanged are peeled:
// `!`, `time [-p]`, `command`, `builtin`, `nohup`, `exec`, `env [options] [NAME=value]...`, and
// leading NAME=value prefixes. `time read $T` is a read.
function commandWordAfterPrefixes(part) {
  let words = tokenizeWords(part).map(shellWord);
  for (let n = 0; n < 12 && words.length; n++) {
    const w = words[0];
    if (w === "!") { words = words.slice(1); continue; }
    if (w === "time") { words = words.slice(1); while (words[0] === "-p" || words[0] === "--") words = words.slice(1); continue; }
    if (w === "command" || w === "builtin" || w === "nohup" || w === "exec") { words = words.slice(1); while (words[0]?.startsWith("-")) words = words.slice(1); continue; }
    if (w === "env") { words = words.slice(1); while (words[0] && (words[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words = words.slice(1); continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && words.length > 1) { words = words.slice(1); continue; }
    break;
  }
  return words[0] ?? "";
}

// Whether a line could set a variable in a way the plain-assignment reading does not see: a
// setter at a command position of any part or substitution (after the prefixes above), an
// indirect name (${!x}), or an assignment inside arithmetic ($(( T = 5 ))).
function lineMaySetVariablesIndirectly(text, parts, depth = 0) {
  if (/\$\{!/.test(text)) return true;
  if (/\$\(\([^)]*[^=!<>]=[^=]/.test(text) || /\(\([^)]*[^=!<>]=[^=]/.test(text)) return true;
  for (const part of parts) {
    const peeled = part.trim().replace(/^[({]\s*/, "");
    if (PLAIN_ASSIGNMENT_RE.test(peeled)) continue;
    if (VARIABLE_SETTERS.has(commandWordAfterPrefixes(peeled))) return true;
    if (depth < 4) {
      for (const inner of extractSubstitutions(part)) {
        if (lineMaySetVariablesIndirectly(inner, splitCommandSegments(inner), depth + 1)) return true;
      }
    }
  }
  return false;
}

export function redirectVariables(text, topLevel) {
  const empty = topLevel.map(() => new Map());
  if (lineMaySetVariablesIndirectly(text, topLevel)) return empty;
  const separators = lineSeparators(text);
  if (separators.some((sep) => sep === "||" || sep === "|" || sep === "|&" || sep === "&")) return empty;
  if (separators.length !== Math.max(0, topLevel.length - 1)) return empty; // could not line them up: unknown
  const result = [];
  const values = new Map();
  const poisoned = new Set();
  for (let i = 0; i < topLevel.length; i++) {
    result.push(new Map([...values].filter(([name]) => !poisoned.has(name))));
    const part = topLevel[i].trim();
    const assignment = PLAIN_ASSIGNMENT_RE.exec(part);
    const before = i === 0 ? null : separators[i - 1];
    if (assignment) {
      // after "&&" an assignment may be skipped (false && S=/tmp/x): only once nothing else has been assigned
      if (before === "&&" && i > 0 && !topLevel.slice(0, i).every((p) => PLAIN_ASSIGNMENT_RE.test(p.trim()))) { poisoned.add(assignment[1]); continue; }
      if (values.has(assignment[1]) || poisoned.has(assignment[1])) { poisoned.add(assignment[1]); continue; }
      values.set(assignment[1], shellWord(assignment[2]));
      continue;
    }
    const first = tokenizeWords(part)[0] ?? "";
    if (VARIABLE_SETTERS.has(shellWord(first)) || /^[({]/.test(part) || /^[\w.:-]+\s*\(\s*\)/.test(part)) return result.concat(topLevel.slice(i + 1).map(() => new Map())).map(() => new Map());
    // any other mention of a known name than $NAME / ${NAME} poisons it
    for (const name of new Set([...values.keys(), ...(part.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])])) {
      const bare = new RegExp(`(^|[^$\\w{])${name}(?![\\w])`).test(part);
      const operator = new RegExp(`\\$\\{${name}[^}\\w]`).test(part);
      if ((bare || operator) && values.has(name)) poisoned.add(name);
    }
  }
  return result;
}

export function plainAssignments(segments) {
  const values = new Map();
  const seen = new Set();
  for (const segment of segments) {
    const text = segment.trim().replace(/^export\s+/, "");
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)$/.exec(text);
    if (!m) continue;
    if (seen.has(m[1])) { values.delete(m[1]); continue; }
    seen.add(m[1]);
    const value = shellWord(m[2]);
    if (!/[$`]/.test(m[2])) values.set(m[1], value);
  }
  return values;
}

// The judgement for one segment: an allowed command with an unknown option, or writing
// to a file outside the temporary directory, asks.
// A line that creates a git work tree (git init, git clone, git worktree add) gets no
// temporary-directory exemption for its redirects: the folder it creates is checked by the
// hook before the line runs, when it is not a work tree yet.
export function createsGitWorkTree(segment) {
  const words = commandWords(segment);
  if (words[0] !== "git") return false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(words[i]) ? 2 : 1;
  const sub = words[i];
  return sub === "init" || sub === "clone" || (sub === "worktree" && words[i + 1] === "add");
}

export function allowedCommandNeedsQuestion(segment, variables = new Map(), { noTempExemption = false } = {}) {
  const words = commandWords(segment);
  const known = allowedCommandOptionsAreKnown(words);
  if (known === null) return false;
  if (!known) return true;
  if (!sedRawScriptsAreReadOnly(segment)) return true;
  return outputRedirectTargets(segment).some((t) => {
    if (noTempExemption && !/^(\/dev\/(null|stdout|stderr|tty|fd\/\d+))$/.test(shellWord(t))) return true;
    return !isHarmlessRedirectTarget(t, variables);
  });
}

// A database URL (or PGHOST) set for this command that is not this machine. The test
// runners are allowed without a question; pointed at a real database they would create
// and drop databases there.
const DATABASE_VARIABLE_RE = /^((?:[A-Za-z0-9_]*_)?DATABASE_URL|PGHOST|PGHOSTADDR|PGSERVICE|PGSERVICEFILE)=(.*)$/;
const LOOPBACK_HOST_RE = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)$/i;

function isLoopbackDatabaseValue(name, rawValue) {
  const value = shellWord(rawValue);
  if (value === "") return true;
  if (/[$`]/.test(rawValue.replace(/^'[^']*'$/, ""))) return false; // cannot be read
  if (/^PGSERVICE/.test(name)) return false;
  if (/^PGHOST/.test(name)) return value.split(",").every((h) => LOOPBACK_HOST_RE.test(h.trim()) || h.trim().startsWith("/"));
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#]*)/i.exec(value);
  if (!m) return false;
  if (/[?&](host|hostaddr|service)=/i.test(value)) return false;
  const authority = m[1];
  if (authority.includes(",")) return false; // several hosts (libpq): each would have to be checked
  const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.replace(/:\d*$/, "");
  return host === "" || LOOPBACK_HOST_RE.test(host);
}

export function setsNonLocalDatabase(segment) {
  let text = typeof segment === "string" ? segment.trim() : "";
  text = text.replace(/^(?:export|declare\s+-x|set)\s+/, "");
  const tokens = tokenizeWords(text);
  for (const t of tokens) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) break; // the assignments in front of the command
    const m = DATABASE_VARIABLE_RE.exec(t);
    if (m && !isLoopbackDatabaseValue(m[1], m[2])) return true;
  }
  const env = tokens[0] === "env" ? tokens.slice(1) : [];
  for (const t of env) {
    const m = DATABASE_VARIABLE_RE.exec(t);
    if (m && !isLoopbackDatabaseValue(m[1], m[2])) return true;
  }
  return false;
}

// Files that hold secrets. Their examples (.env.example, .env.sample, .env.template) do not.
const SECRET_PATH_PATTERNS = [
  /(^|[\\/])\.env([.~_-][^\\/]*)?[\\/]?$/i, // .env and every copy or variant: .env.local, .env.bak, .env~, backend/.env/
  /(^|[\\/])\.envrc$/i,
  /^\/proc\/[^/]+\/environ$/, // another process's environment
  /(^|[\\/])\.?pgpass(\.conf)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|[\\/])\.(netrc|npmrc|git-credentials)$/i,
  /(^|[\\/])\.?credentials(\.json)?$/i,
];
// Names a glob could reach: a glob whose literal part can match one of them asks.
const SECRET_SAMPLE_NAMES = [".env", ".env.local", ".env.bak", ".envrc", ".env.production", ".pgpass", "pgpass.conf", "server.pem", "server.key", "id_rsa",
  "id_ed25519", ".netrc", ".npmrc", ".git-credentials", "credentials", ".credentials.json", "cert.p12"];

function expandBraces(word, limit = 64) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) return [word];
  const out = [];
  for (const part of m[1].split(",")) {
    out.push(...expandBraces(word.slice(0, m.index) + part + word.slice(m.index + m[0].length), limit));
    if (out.length > limit) break;
  }
  return out;
}

function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) { re += "\\["; continue; }
      re += "[" + glob.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(re + "$");
}

function isSecretPath(value) {
  if (/\.(example|sample|template)$/i.test(value)) return false;
  if (SECRET_PATH_PATTERNS.some((re) => re.test(value))) return true;
  if (!/[*?[{]/.test(value)) return false;
  for (const candidate of expandBraces(value)) {
    if (SECRET_PATH_PATTERNS.some((re) => re.test(candidate)) && !/\.(example|sample|template)$/i.test(candidate)) return true;
    const base = candidate.split(/[\\/]/).pop();
    if (!/[*?[]/.test(base)) continue;
    const literalPrefix = base.split(/[*?[]/)[0];
    const pattern = globToRegex(base);
    if (/^\*\.[A-Za-z0-9]+$/.test(base) && SECRET_PATH_PATTERNS.some((re) => re.test(base.slice(1)))) return true; // *.pem
    if (literalPrefix === "") continue; // `*`, `*.mjs`: no literal part aimed at a secret
    if (SECRET_SAMPLE_NAMES.some((name) => pattern.test(name))) return true;
  }
  return false;
}

export function mentionsSecretFile(segment) {
  const tokens = tokenizeWords(normalizeSegment(typeof segment === "string" ? segment : ""));
  return tokens.slice(1).some((raw) => {
    for (const t of [stripQuotes(raw), shellWord(raw)]) {
      const value = t.startsWith("-") && t.includes("=") ? t.slice(t.indexOf("=") + 1) : t;
      if (isSecretPath(value)) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// ASK checks added with the hardening: forms that lose work or history and were silent.
// ---------------------------------------------------------------------------

export function definesAlias(segment) {
  const words = commandWords(segment);
  return words[0] === "alias" && words.length > 1;
}

const SAFE_GIT_CONFIG_KEYS = new Set(["user.name", "user.email", "color.ui", "core.quotepath", "init.defaultbranch", "advice.detachedhead",
  "commit.gpgsign", "tag.gpgsign", "gc.auto", "column.ui"]);

export function isGitConfigOverride(segment) {
  const words = commandWords(segment);
  if (words[0] !== "git") return false;
  for (let i = 1; i < words.length && words[i].startsWith("-"); i++) {
    const w = words[i];
    if (w === "-C" || w === "--git-dir" || w === "--work-tree" || w === "--namespace") { i++; continue; }
    let pair = null;
    if (w === "-c" || w === "--config-env") pair = words[++i] ?? "";
    else if (w.startsWith("-c") && w.length > 2) pair = w.slice(2);
    else if (w.startsWith("--config-env=")) pair = w.slice(13);
    if (pair === null) continue;
    const key = pair.split("=")[0].toLowerCase();
    if (w.startsWith("--config-env") || !SAFE_GIT_CONFIG_KEYS.has(key)) return true;
  }
  return false;
}

export function isGitResetMergeOrKeep(segment) {
  const parsed = extractGitSubcommandArgs(segment, "reset");
  return parsed !== null && parsed.rest.split(/\s+/).some((t) => longOptionIs(t, "--merge") || longOptionIs(t, "--keep"));
}

// checkout and switch: their long options are judged by a list of known options. A prefix of a
// forcing option (--force, --discard-changes) or any option not on the list asks.
const CHECKOUT_SAFE_LONG = ["--quiet", "--progress", "--no-progress", "--detach", "--orphan", "--track", "--no-track", "--guess",
  "--no-guess", "--merge", "--conflict", "--recurse-submodules", "--no-recurse-submodules", "--overlay", "--no-overlay",
  "--ignore-other-worktrees", "--ignore-skip-worktree-bits"];
const SWITCH_SAFE_LONG = ["--create", "--force-create", "--quiet", "--progress", "--no-progress", "--detach", "--orphan", "--track",
  "--no-track", "--guess", "--no-guess", "--merge", "--conflict", "--recurse-submodules", "--no-recurse-submodules",
  "--ignore-other-worktrees"];

// ---------------------------------------------------------------------------
// git: an allow list of subcommands (review of #665). A git subcommand that is not on this
// list asks — plumbing such as update-ref, read-tree, checkout-index, reflog expire, gc,
// filter-branch, replace, symbolic-ref with a write, and every porcelain command that is not
// named here (cherry-pick, revert, apply, am, bisect, notes, ...). Within a listed subcommand
// the options come from a list too; an unknown or abbreviated-to-something-else option asks.
// The rules above (deny for reset --hard, push --force, ...; ask for merge, rebase, branch -D,
// ...) still come first and keep their own reasons.
// ---------------------------------------------------------------------------

const LOG_FAMILY = spec(GIT_LOG_FAMILY);
const REMOTE_OR_BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./@-]*$/;
const atMostOperands = (n) => (ops) => ops.length <= n;

const GIT_POLICY = {
  // reading
  status: (a) => optionsAreKnown(a, GIT_SUBCOMMANDS.status),
  diff: (a) => optionsAreKnown(a, GIT_SUBCOMMANDS.diff),
  log: (a) => optionsAreKnown(a, GIT_SUBCOMMANDS.log),
  show: (a) => optionsAreKnown(a, GIT_SUBCOMMANDS.show),
  fetch: (a) => optionsAreKnown(a, GIT_SUBCOMMANDS.fetch),
  "rev-parse": (a) => optionsAreKnown(a, GIT_SUBCOMMANDS["rev-parse"]),
  "merge-base": (a) => optionsAreKnown(a, GIT_SUBCOMMANDS["merge-base"]),
  "ls-remote": (a) => optionsAreKnown(a, GIT_SUBCOMMANDS["ls-remote"]),
  "ls-tree": (a) => optionsAreKnown(a, GIT_SUBCOMMANDS["ls-tree"]),
  "merge-tree": (a) => optionsAreKnown(a, GIT_SUBCOMMANDS["merge-tree"]),
  "rev-list": (a) => optionsAreKnown(a, spec({ ...GIT_LOG_FAMILY, long: [...GIT_LOG_FAMILY.long, "--count", "--objects", "--objects-edge", "--no-object-names", "--timestamp", "--header", "--bisect"] })),
  shortlog: (a) => optionsAreKnown(a, spec({ ...GIT_LOG_FAMILY, short: GIT_LOG_FAMILY.short + "nse", long: [...GIT_LOG_FAMILY.long, "--numbered", "--summary", "--email", "--committer"], longArg: [...GIT_LOG_FAMILY.longArg, "--group"] })),
  "ls-files": (a) => optionsAreKnown(a, spec({ short: "cdmoiuskztvf", shortArg: "xX", long: ["--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged", "--killed", "--directory", "--no-empty-directory", "--full-name", "--error-unmatch", "--exclude-standard", "--eol", "--deduplicate", "--sparse", "--recurse-submodules", "--debug"], longArg: ["--exclude", "--exclude-from", "--exclude-per-directory", "--with-tree", "--format"], longOpt: ["--abbrev"] })),
  blame: (a) => optionsAreKnown(a, spec({ short: "lstnfpecwb", shortArg: "L", long: ["--porcelain", "--line-porcelain", "--show-name", "--show-number", "--show-stats", "--root", "--incremental", "--show-email", "--minimal", "--reverse", "--first-parent"], longArg: ["--date", "--ignore-rev", "--contents", "--since"], longOpt: ["--abbrev", "--color-lines", "--color-by-age"], numeric: false })),
  grep: (a) => optionsAreKnown(a, spec({ short: "inwvlLcHhIEFPoqzaW", shortArg: "efABCm", long: ["--cached", "--untracked", "--no-index", "--ignore-case", "--word-regexp", "--invert-match", "--files-with-matches", "--name-only", "--files-without-match", "--count", "--line-number", "--column", "--heading", "--break", "--full-name", "--extended-regexp", "--fixed-strings", "--perl-regexp", "--basic-regexp", "--all-match", "--and", "--or", "--not", "--recurse-submodules", "--text", "--no-color", "--quiet", "--null", "--only-matching", "--show-function", "--function-context", "--exclude-standard", "--no-exclude-standard"], longArg: ["--max-depth", "--threads", "--max-count", "--context", "--after-context", "--before-context", "--regexp", "--file"], longOpt: ["--color"], numeric: true })),
  describe: (a) => optionsAreKnown(a, spec({ long: ["--tags", "--all", "--always", "--long", "--exact-match", "--first-parent", "--contains", "--debug"], longArg: ["--match", "--exclude", "--candidates"], longOpt: ["--abbrev", "--dirty", "--broken"] })),
  "cat-file": (a) => optionsAreKnown(a, spec({ short: "tpse", long: ["--batch-all-objects", "--unordered", "--buffer", "--follow-symlinks", "--allow-unknown-type", "--use-mailmap", "--no-use-mailmap"], longOpt: ["--batch", "--batch-check", "--batch-command"] })),
  "show-ref": (a) => optionsAreKnown(a, spec({ short: "sqd", long: ["--head", "--heads", "--tags", "--branches", "--verify", "--quiet", "--dereference", "--exists"], longOpt: ["--hash", "--abbrev"] })),
  "for-each-ref": (a) => optionsAreKnown(a, spec({ long: ["--shell", "--perl", "--python", "--tcl", "--ignore-case", "--omit-empty"], longArg: ["--count", "--sort", "--format", "--points-at", "--merged", "--no-merged", "--contains", "--no-contains", "--exclude"] })),
  "check-ignore": (a) => optionsAreKnown(a, spec({ short: "qvnz", long: ["--quiet", "--verbose", "--non-matching", "--stdin", "--no-index"] })),
  "name-rev": (a) => optionsAreKnown(a, spec({ long: ["--tags", "--all", "--name-only", "--no-undefined", "--always", "--annotate-stdin"], longArg: ["--refs", "--exclude"] })),
  version: (a) => a.every((w) => w === "--build-options"),
  // reading forms of commands that can also write
  "symbolic-ref": (a) => optionsAreKnown(a, spec({ short: "q", long: ["--quiet", "--short", "--no-recurse"], operands: (ops) => ops.length === 1 })),
  reflog: (a) => {
    if (a[0] === "expire" || a[0] === "delete" || a[0] === "drop") return false;
    const rest = a[0] === "show" || a[0] === "list" || a[0] === "exists" ? a.slice(1) : a;
    return optionsAreKnown(rest, LOG_FAMILY);
  },
  tag: (a) => optionsAreKnown(a, spec({ short: "l", shortArg: "n", long: ["--list", "--column", "--no-column", "--ignore-case", "--omit-empty"], longArg: ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"], operands: (ops) => a.some((w) => w === "-l" || w === "--list") || ops.length === 0 })),
  remote: (a) => {
    if (a.length === 0 || (a.length === 1 && (a[0] === "-v" || a[0] === "--verbose"))) return true;
    if (a[0] === "show") return optionsAreKnown(a.slice(1), spec({ short: "n", operands: (ops) => ops.every((o) => REMOTE_OR_BRANCH_RE.test(o)) }));
    if (a[0] === "get-url") return optionsAreKnown(a.slice(1), spec({ long: ["--push", "--all"], operands: (ops) => ops.length === 1 }));
    return false;
  },
  config: (a) => {
    const reading = a.some((w) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--get-urlmatch", "get", "list"].includes(w));
    const ok = optionsAreKnown(a, spec({ short: "lz", long: ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope", "--name-only", "--null", "--global", "--local", "--system", "--worktree", "--includes", "--no-includes", "--get-urlmatch", "--bool", "--int", "--path"], longArg: ["--file", "--blob", "--type", "--default"] }));
    if (!ok) return false;
    const operands = a.filter((w) => !w.startsWith("-"));
    return reading || operands.length === 1; // `git config user.name` reads; two operands write
  },
  // the working-branch flow (the deny/ask rules above still apply first)
  add: (a) => optionsAreKnown(a, spec({ short: "vnuNfq", long: ["--verbose", "--dry-run", "--update", "--intent-to-add", "--force", "--ignore-errors", "--ignore-missing", "--renormalize", "--quiet", "--sparse"], longArg: ["--chmod", "--pathspec-from-file"], longOpt: ["--pathspec-file-nul"] })),
  commit: (a) => optionsAreKnown(a, spec({ short: "qvas", shortArg: "mFCc", long: ["--quiet", "--verbose", "--all", "--amend", "--no-edit", "--signoff", "--no-signoff", "--allow-empty", "--allow-empty-message", "--reset-author", "--only", "--include", "--status", "--no-status", "--dry-run", "--short", "--porcelain", "--null", "--no-post-rewrite"], longArg: ["--message", "--file", "--reuse-message", "--reedit-message", "--author", "--date", "--cleanup", "--trailer", "--fixup", "--squash"] })),
  push: (a) => optionsAreKnown(a, spec({ short: "uqvn", long: ["--set-upstream", "--quiet", "--verbose", "--dry-run", "--porcelain", "--progress", "--no-progress", "--atomic"], operands: (ops) => ops.every((o, k) => (k === 0 ? REMOTE_NAME_RE.test(o) : REMOTE_OR_BRANCH_RE.test(o))) })),
  pull: (a) => optionsAreKnown(a, spec({ short: "qv", long: ["--quiet", "--verbose", "--ff-only", "--ff", "--no-ff", "--no-rebase", "--no-edit", "--commit", "--no-commit", "--prune", "--no-tags", "--progress", "--no-progress"], longOpt: ["--rebase"], value: (name, value) => name !== "--rebase" || /^(false|no|off|0)$/i.test(value), operands: (ops) => ops.every((o, k) => (k === 0 ? REMOTE_NAME_RE.test(o) : REMOTE_OR_BRANCH_RE.test(o))) })),
  merge: () => true, // judged by the merge rule above: it asks unless it is the exempt merge of origin/main
  rebase: () => true, // asks by the rule above
  branch: (a) => optionsAreKnown(a, spec({ short: "arvlqdmct", shortArg: "u", long: ["--all", "--remotes", "--verbose", "--list", "--quiet", "--delete", "--move", "--copy", "--show-current", "--unset-upstream", "--no-track", "--ignore-case", "--omit-empty", "--no-column", "--no-color"], longArg: ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--set-upstream-to"], longOpt: ["--color", "--column", "--track", "--abbrev"] })),
  checkout: (a) => optionsAreKnown(a, spec({ short: "qtm", shortArg: "b", long: CHECKOUT_SAFE_LONG.filter((n) => !["--orphan", "--conflict"].includes(n)), longArg: ["--orphan", "--conflict"], longOpt: ["--track", "--recurse-submodules"] })),
  switch: (a) => optionsAreKnown(a, spec({ short: "qtmd", shortArg: "c", long: SWITCH_SAFE_LONG.filter((n) => !["--create", "--orphan", "--conflict", "--force-create"].includes(n)), longArg: ["--create", "--orphan", "--conflict"], longOpt: ["--track", "--recurse-submodules"] })),
  restore: (a) => optionsAreKnown(a, spec({ short: "qWS", shortArg: "s", long: ["--staged", "--worktree", "--quiet", "--overlay", "--no-overlay", "--progress", "--no-progress", "--ignore-unmerged", "--merge", "--ours", "--theirs"], longArg: ["--source", "--conflict"] })),
  reset: (a) => optionsAreKnown(a, spec({ short: "qN", long: ["--soft", "--mixed", "--quiet", "--no-refresh", "--refresh", "--hard", "--merge", "--keep"], longArg: ["--pathspec-from-file"] })),
  rm: (a) => optionsAreKnown(a, spec({ short: "rqn", long: ["--cached", "--quiet", "--dry-run", "--ignore-unmatch", "--sparse"], longArg: ["--pathspec-from-file"] })),
  clean: (a) => optionsAreKnown(a, spec({ short: "ndxXqf", shortArg: "e", long: ["--dry-run", "--quiet", "--force"], longArg: ["--exclude"] })),
  stash: (a) => {
    const sub = a[0] && !a[0].startsWith("-") ? a[0] : "push";
    const rest = a[0] && !a[0].startsWith("-") ? a.slice(1) : a;
    if (sub === "list" || sub === "show") return optionsAreKnown(rest, LOG_FAMILY);
    if (sub === "push" || sub === "save") return optionsAreKnown(rest, spec({ short: "ukqaS", shortArg: "m", long: ["--include-untracked", "--keep-index", "--no-keep-index", "--quiet", "--all", "--staged"], longArg: ["--message", "--pathspec-from-file"] }));
    if (sub === "apply") return optionsAreKnown(rest, spec({ short: "q", long: ["--index", "--quiet"] }));
    if (sub === "pop" || sub === "drop" || sub === "clear") return true; // judged by the rules above (ask / deny)
    return false; // stash branch, store, create, ...
  },
  worktree: (a) => {
    const sub = a[0];
    const rest = a.slice(1);
    if (sub === "list") return optionsAreKnown(rest, GIT_WORKTREE_LIST);
    if (sub === "add") return optionsAreKnown(rest, spec({ short: "q", shortArg: "b", long: ["--detach", "--quiet", "--checkout", "--no-checkout", "--lock", "--no-track", "--guess-remote", "--no-guess-remote"], longArg: ["--reason"], longOpt: ["--track"] }));
    if (sub === "remove") return optionsAreKnown(rest, spec({ long: [] })) || true; // --force asks by the rule above; plain remove refuses a dirty tree
    if (sub === "prune") return optionsAreKnown(rest, spec({ short: "nv", long: ["--dry-run", "--verbose"], longArg: ["--expire"] }));
    if (sub === "lock" || sub === "unlock") return optionsAreKnown(rest, spec({ longArg: ["--reason"] }));
    return false; // move, repair
  },
  init: (a) => optionsAreKnown(a, spec({ short: "q", shortArg: "b", long: ["--quiet", "--bare"], longArg: ["--initial-branch", "--object-format"] })),
  clone: (a) => optionsAreKnown(a, spec({ short: "qn", shortArg: "bo", long: ["--quiet", "--no-checkout", "--single-branch", "--no-single-branch", "--no-tags", "--shallow-submodules", "--progress"], longArg: ["--branch", "--depth", "--filter", "--origin", "--shallow-since"] })),
};

const GLOBAL_GIT_FLAGS = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--no-replace-objects"]);

// True when the git command must ask: a subcommand that is not on GIT_POLICY, an option that is
// not on its list, or a global option other than -C, -c (judged by isGitConfigOverride) and the
// harmless display flags.
export function gitCommandNeedsQuestion(segment) {
  const words = commandWords(segment);
  if (words[0] !== "git") return false;
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-C" || w === "-c" || w === "--config-env") { i += 2; continue; }
    if (/^-c./.test(w) || w.startsWith("--config-env=")) { i += 1; continue; }
    if (GLOBAL_GIT_FLAGS.has(w)) { i += 1; continue; }
    if (w === "--version" || w === "--help") return false;
    return true;
  }
  const sub = words[i];
  if (sub === undefined) return false;
  const rule = Object.prototype.hasOwnProperty.call(GIT_POLICY, sub) ? GIT_POLICY[sub] : null;
  if (!rule) return true;
  return !rule(words.slice(i + 1));
}

export function isForcedSwitch(segment) {
  for (const [sub, safe, dangerous] of [["switch", SWITCH_SAFE_LONG, ["--force", "--discard-changes"]], ["checkout", CHECKOUT_SAFE_LONG, ["--force"]]]) {
    const parsed = extractGitSubcommandArgs(segment, sub);
    if (!parsed) continue;
    const tokens = parsed.rest.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (t === "--") break;
      if (/^-[a-zA-Z]+$/.test(t) && t.includes("f")) return true;
      if (t.startsWith("--") && classifyLongOption(t, safe, dangerous) !== "safe") return true;
    }
  }
  return false;
}

// `git worktree remove --force` deletes a work tree with uncommitted changes in it.
export function isGitWorktreeForceRemove(segment) {
  const parsed = extractGitSubcommandArgs(segment, "worktree");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "remove") return false;
  return tokens.slice(1).some((t) => (/^-[a-zA-Z]+$/.test(t) && t.includes("f")) || longOptionIs(t, "--force"));
}

export function isGitStashPop(segment) {
  const parsed = extractGitSubcommandArgs(segment, "stash");
  return parsed !== null && /^pop\b/i.test(parsed.rest);
}

export function isGitBranchForceDelete(segment) {
  const parsed = extractGitSubcommandArgs(segment, "branch");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  let del = false;
  let force = false;
  for (const t of tokens) {
    if (/^-[a-zA-Z]+$/.test(t)) {
      if (t.includes("D")) return true;
      if (t.includes("d")) del = true;
      if (t.includes("f")) force = true;
    } else if (longOptionIs(t, "--delete")) del = true;
    else if (longOptionIs(t, "--force")) force = true;
  }
  return del && force;
}

export function isGitPushDelete(segment) {
  const parsed = extractGitSubcommandArgs(segment, "push");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean).map(stripQuotes);
  return tokens.some((t) => longOptionIs(t, "--delete") || longOptionIs(t, "--prune") || longOptionIs(t, "--mirror") || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(t) || /^\+?:[^\s]/.test(t));
}

export function isGitPullRebase(segment) {
  const parsed = extractGitSubcommandArgs(segment, "pull");
  if (!parsed) return false;
  const tokens = parsed.rest.split(/\s+/).filter(Boolean);
  return tokens.some((t) => (longOptionIs(t, "--rebase") && !/=(false|no|off|0)$/i.test(t)) || /^-[a-zA-Z]*r[a-zA-Z]*$/.test(t));
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
    "'git merge'/'git rebase' rewrites branch history or state — needs your explicit confirmation. (Only a plain 'git merge origin/main' into a working branch that is not main/master goes without one.)",
  ghPrMerge: "'gh pr merge' merges a pull request — needs your explicit confirmation.",
  pushMain: "This push targets 'main' — needs your explicit confirmation.",
  commitMain: "This commit would land directly on 'main' — needs your explicit confirmation.",
  deploy: "This looks like a deploy command (Render/Vercel/Cloudflare/Supabase) — needs your explicit confirmation.",
  migration: "This looks like it runs the database migration runner — needs your explicit confirmation.",
  gitNotOnList: "This git command is not on the hook's list of known git commands, or one of its options is not on that command's list (plumbing such as update-ref, read-tree, checkout-index, reflog expire; checkout -B, switch -C, branch -f/-M, rm -f, ...) — needs your explicit confirmation.",
  worktreeForceRemove: "'git worktree remove --force' deletes a work tree even with uncommitted changes in it — needs your explicit confirmation.",
  stashPop: "'git stash pop' can leave conflicts and drops the stash entry once applied — needs your explicit confirmation.",
  branchForceDelete: "'git branch -D' deletes a branch even when its work is merged nowhere — needs your explicit confirmation.",
  pushDelete: "This push deletes a branch on the remote (--delete, -d, :branch, --prune, --mirror) — needs your explicit confirmation.",
  pullRebase: "'git pull --rebase' rewrites your local commits on top of the remote — needs your explicit confirmation.",
  unreadable: "A shell here reads commands this guard cannot see (from a pipe, or from a variable) — needs your explicit confirmation.",
  readCommandWrites:
    "This command is on the allow list, but here it has an option that is not on its list of known-safe options (or an abbreviated one), a writing sed script, a test file outside backend/tests or frontend/tests, or it writes to a file outside the temporary folder — needs your explicit confirmation.",
  dangerousEnv: "This command sets an environment variable that changes what a program runs or loads (NODE_OPTIONS, PATH, PAGER, GIT_*, LD_PRELOAD, ...) — needs your explicit confirmation.",
  gitConfigOverride: "'git -c' / '--config-env' overrides git configuration for this command (an alias, a pager, an external program) — needs your explicit confirmation.",
  resetMergeKeep: "'git reset --merge' / '--keep' moves the branch and rewrites the working tree — needs your explicit confirmation.",
  forcedSwitch: "A forced 'git switch' / 'git checkout' (-f, --force, --discard-changes) throws away local changes — needs your explicit confirmation.",
  nonLocalDatabase: "This command sets a database URL (or PGHOST) that is not this machine, or one that cannot be read — needs your explicit confirmation.",
  secretFile: "This command names a file that holds secrets (.env, pgpass, a key or credentials file) — needs your explicit confirmation.",
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
  /^(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z]+\s+|--[a-z-]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+(.+)$/,
  /^eval\s+(.+)$/,
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
  if (depth > 6) return segments;
  const expanded = [];
  for (const segment of segments) {
    expanded.push(segment);
    const normalized = normalizeSegment(segment);
    if (normalized && normalized !== segment.trim().replace(/\s+/g, " ")) expanded.push(...expandSegments([normalized], depth + 1));
    const inner = unwrapInterpreterCommand(normalized || segment);
    if (inner) expanded.push(...expandSegments(splitCommandSegments(inner), depth + 1));
    for (const sub of extractSubstitutions(segment)) expanded.push(...expandSegments(splitCommandSegments(sub), depth + 1));
    // A variable as the command word (`$GIT push -f`) is read as git, the only command
    // whose subcommands these rules know; for anything else it changes nothing.
    const variableCommand = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s+(.+)$/.exec(normalized || "");
    if (variableCommand && KNOWN_GIT_SUBCOMMANDS.has(variableCommand[1].split(/\s+/)[0])) expanded.push(`git ${variableCommand[1]}`);
  }
  return expanded;
}

// Whether a command line starts a background job (a single `&` outside quotes that is not
// part of `&&`, `|&`, `2>&1`, `&>`). A merge in such a line gets no exemption: it would run
// alongside whatever follows, after the hook has checked the branch.
export function hasBackgroundJob(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (quote === '"' && ch === "\\") { i++; continue; } if (ch === quote) quote = null; continue; }
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch !== "&") continue;
    if (text[i + 1] === "&") { i++; continue; }
    if (text[i - 1] === ">" || text[i - 1] === "<" || text[i - 1] === "|" || text[i + 1] === ">") continue;
    return true;
  }
  return false;
}

export function classifyShellCommand(cmd, cwd) {
  const { text, shellBodies } = extractHeredocs(cmd);
  const topLevel = splitCommandSegments(text);
  const segments = expandSegments(topLevel);
  // A redirect may use a variable only when its value is certain. See redirectVariables.
  const variablesBefore = new Map();
  const known = shellBodies.length ? topLevel.map(() => new Map()) : redirectVariables(text, topLevel);
  for (let i = 0; i < topLevel.length; i++) {
    for (const piece of expandSegments([topLevel[i]])) if (!variablesBefore.has(piece)) variablesBefore.set(piece, known[i]);
  }
  const background = hasBackgroundJob(text);
  const createsWorkTree = segments.some(createsGitWorkTree);
  for (const body of shellBodies) segments.push(...expandSegments(splitCommandSegments(body)));

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

  // Every segment is judged on its own and the strictest verdict wins: any deny above
  // already ended the call, and here the first segment that needs a confirmation ends it,
  // wherever in the chain it stands. The one merge that does not ask only removes ITS OWN
  // question; every other segment of the same command line is still checked.
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (isGitMergeOrRebase(segment) && (background || !isMergeOfRemoteDefaultIntoWorkingBranch(segment, segments.slice(0, index), cwd))) {
      return { decision: "ask", reason: ASK_REASONS.mergeRebase };
    }
    if (isGhPrMerge(segment)) return { decision: "ask", reason: ASK_REASONS.ghPrMerge };
    if (isGitStashPop(segment)) return { decision: "ask", reason: ASK_REASONS.stashPop };
    if (isGitWorktreeForceRemove(segment)) return { decision: "ask", reason: ASK_REASONS.worktreeForceRemove };
    if (isGitBranchForceDelete(segment)) return { decision: "ask", reason: ASK_REASONS.branchForceDelete };
    if (isGitPushDelete(segment)) return { decision: "ask", reason: ASK_REASONS.pushDelete };
    if (isGitPullRebase(segment)) return { decision: "ask", reason: ASK_REASONS.pullRebase };
    if (isUnreadableShellInput(segment, topLevel.length > 1)) return { decision: "ask", reason: ASK_REASONS.unreadable };
    // `cat >(sh)`, `x <(bash)`: a shell inside a process substitution reads what it is fed
    if (processSubstitutions(segment).some((inner) => isUnreadableShellInput(inner, true))) return { decision: "ask", reason: ASK_REASONS.unreadable };
    if (allowedCommandNeedsQuestion(segment, variablesBefore.get(segment) ?? new Map(), { noTempExemption: createsWorkTree })) return { decision: "ask", reason: ASK_REASONS.readCommandWrites };
    if (setsDangerousEnvironment(segment)) return { decision: "ask", reason: ASK_REASONS.dangerousEnv };
    if (definesAlias(segment)) return { decision: "ask", reason: ASK_REASONS.unreadable };
    if (isGitConfigOverride(segment)) return { decision: "ask", reason: ASK_REASONS.gitConfigOverride };
    if (isGitResetMergeOrKeep(segment)) return { decision: "ask", reason: ASK_REASONS.resetMergeKeep };
    if (isForcedSwitch(segment)) return { decision: "ask", reason: ASK_REASONS.forcedSwitch };
    if (gitCommandNeedsQuestion(segment)) return { decision: "ask", reason: ASK_REASONS.gitNotOnList };
    if (setsNonLocalDatabase(segment)) return { decision: "ask", reason: ASK_REASONS.nonLocalDatabase };
    if (mentionsSecretFile(segment)) return { decision: "ask", reason: ASK_REASONS.secretFile };
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
