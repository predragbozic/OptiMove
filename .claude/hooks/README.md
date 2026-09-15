# Claude safety hooks

A small, deterministic `PreToolUse` hook that mechanically enforces the highest-risk
rules already written down in `CLAUDE.md`/`.claude/rules/` (git safety, database safety,
migrations, deploys) — so they hold even if a session forgets, misreads, or is pressured
to skip them. This is the "hard enforcement" layer those docs describe as not yet
existing.

## How it's wired

`.claude/settings.json` registers `safety-guard.mjs` as a `PreToolUse` hook for the
`Bash` and `PowerShell` tools, **and** for MCP tool calls (matched by the regex
`mcp__.*`, since an MCP tool's name carries an instance-specific server-id prefix that
can't be hardcoded — see "Verifying it's actually registered" below for why this third
matcher matters as much as the other two). Before a matching tool actually runs, Claude
Code pipes a JSON description of the call to the hook's stdin and reads a JSON decision
back from its stdout.

```
{ "hooks": { "PreToolUse": [
  { "matcher": "Bash",       "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/safety-guard.mjs\"" }] },
  { "matcher": "PowerShell", "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/safety-guard.mjs\"" }] },
  { "matcher": "mcp__.*",    "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/safety-guard.mjs\"" }] }
] } }
```

`$CLAUDE_PROJECT_DIR` is set by Claude Code to the project root, so the hook resolves
correctly regardless of the shell's current working directory.

**This is a project-level hook** (`.claude/settings.json`, checked into git — everyone
on the branch gets it). It is intentionally separate from `.claude/settings.local.json`,
which holds one user's own local permission choices and is never touched by this change.

## Verifying it's actually registered

Claude Code reads `.claude/settings.json` at session start. A hook added or changed in
this file **requires a new session** to take effect — the running session that adds the
file will not have it wired into its own permission flow yet. Check the `/hooks` menu
(or your client's equivalent) in a *fresh* session to confirm `safety-guard.mjs` is
listed under `PreToolUse` for `Bash`/`PowerShell`/`mcp__.*`. `safety-guard.test.mjs` has
an automated check that the `mcp__.*` matcher entry actually exists in `settings.json`
and points at this same hook command (a real, previously-missing matcher entry earlier
in this project's history meant `classifyMcpToolCall()`'s logic was fully correct but
never once actually invoked in a real session) — but that test can only confirm the
*file* is well-formed, not that a live session has picked it up; the `/hooks` menu check
is still the only way to confirm actual registration.

## What it decides

The hook reads `tool_name`/`tool_input`/`cwd` from the JSON on stdin, classifies the
command with plain string/regex checks (see `safety-guard.mjs` — every rule is a small,
named, exported function), and writes one of three outcomes:

- **`permissionDecision: "deny"`** — never auto-run, no matter who asks. The tool call is
  blocked outright.
- **`permissionDecision: "ask"`** — the user can approve this specific call, but it's
  never silent.
- **No output at all** — the hook stays out of the way entirely; Claude Code's normal
  permission flow (including anything already allowed in `settings.local.json`) decides,
  same as if this hook didn't exist.

There is no fourth option — this hook never emits `"allow"` itself. Forcing an explicit
allow would let it silently override a user's own `settings.local.json` rules, which is
the opposite of what a safety layer should do.

### DENY (Bash + PowerShell)

- Broad `git add` — a bare `.`/`./`, `-A`, or `--all` (staging everything, not a
  reviewed, explicit file list).
- `git reset --hard`.
- `git clean` with a force flag and no dry-run (`-n`/`--dry-run` anywhere in the flags
  always wins and is treated as safe, matching git's own actual behavior).
- `git push --force` / `--force-with-lease`.
- A recursive, forced delete (`rm -rf`, `Remove-Item -Recurse -Force`, and a few common
  aliases) targeting the repo root, a home directory, or a drive root — not a scoped
  subdirectory like `node_modules` or `./dist`. An unambiguous PowerShell parameter
  abbreviation (`-Recu`, `-Fo`, ...) is recognized as a real prefix of `-Recurse`/
  `-Force`; an unrelated parameter that merely *contains* the letter r/f (`-Filter`,
  `-ErrorAction`, `-Confirm`, ...) is not — that distinction is checked only for the
  PowerShell-named-parameter forms (`Remove-Item`/`ri`), not the Unix commands, where a
  combined short cluster like `-rf`/`-fr` genuinely does mean "each letter is its own
  flag" and is matched by letter-containment on purpose.
- `git checkout -- <path>` / `git checkout .` / `git checkout ./` — the *discard* meaning
  of `checkout` (restoring a path to its committed state, losing uncommitted changes to
  it). `git checkout <branch>` (switching branches) is a different, safe meaning and is
  left alone — but telling the two apart when there's no `--` separator (`git checkout
  <single-token>`) is genuinely ambiguous in real git itself: the token could be a real
  branch/ref (safe — git refuses to clobber conflicting uncommitted changes on a ref
  switch) or an existing file path (silently discards it, no protection at all). Rather
  than assume "branch" the way a plain regex would have to, the hook asks git (`git
  rev-parse --verify --quiet <token>^{commit}`, read-only, in the command's own `cwd`)
  whether the token actually resolves to a commit; if it can't confirm that (not a real
  revision, not a repo, git unavailable, timeout), it treats the ambiguous case as a
  discard risk and denies rather than silently allowing it. `git checkout -b
  <new-branch>` is always left alone regardless (creates a new branch, never discards).
- `git restore <path>` without `--staged`/`-S` (or with `--staged`/`-S` combined with
  `--worktree`/`-W`) — discards uncommitted working-tree changes. `git restore
  --staged`/`-S <path>` alone only unstages (working tree untouched) and is left alone.
- `git stash drop` / `git stash clear` — irreversibly deletes stashed work. Every other
  stash subcommand (`stash`, `push`, `pop`, `apply`, `list`, `show`) is reversible/additive
  and left alone.

### ASK (Bash + PowerShell)

- `git merge` / `git rebase`.
- `gh pr merge`.
- A push that targets `main` explicitly, or a bare `git push`/`git push origin` while the
  hook can determine (via a fast, read-only `git rev-parse --abbrev-ref HEAD` in the
  command's own `cwd`) that the current branch *is* `main`.
- A `git commit` while the current branch is `main` (same branch-detection mechanism).
- A Render/Vercel/Cloudflare(Wrangler)/Supabase deploy-shaped command.
- Something that runs this repo's migration runner (`backend/src/migrate.js`, directly or
  via `npm run migrate`) — including `npm start`, because this repo's own `backend`
  `start` script chains `migrate.js` before the server (`node src/migrate.js && node
  src/server.js`). `npm run dev` does **not** trigger this (`node --watch src/server.js`,
  no migrate step).
- An explicit SQL write (`INSERT`/`UPDATE`/`DELETE`/`ALTER`/`DROP`/`TRUNCATE`/`CREATE`/
  `GRANT`/`REVOKE`) via `psql`, unless the command itself names an obviously disposable
  target (`test_disposable`, `_disposable_db`, `:memory:`). `psql ... -f <file>.sql` (or
  a `<` redirect) runs SQL whose actual content isn't visible on the command line at
  all — rather than scan for a write keyword that isn't there and default to allow, this
  always asks, the same "can't see it, so don't guess" principle the MCP `execute_sql`
  fallback below already uses.

Every git-based check above (all of the DENY rules too) recognizes the actual subcommand
regardless of git's own GLOBAL options placed before it — `git --no-pager reset --hard`,
`git -c core.pager=cat push --force`, `git --git-dir=/x push --force`, any number of
them combined — not just the one specific `git -C <dir>` form. And every check above
(git-based and not) also fires when the risky command is wrapped in another
interpreter's `-c`/`-Command`/`/c` invocation (`bash -c "git reset --hard"`, `sh -c 'git
add .'`, `powershell -Command "..."`, `cmd /c "..."`) or prefixed with one or more
`VAR=value` environment-variable assignments (`DATABASE_URL=... npm run migrate`,
`GIT_PAGER=cat git reset --hard`) — both are unwrapped/stripped before classification
rather than only matching the bare, unwrapped, unprefixed form.

### ASK (Supabase MCP tools, matched by tool-name suffix)

The Supabase MCP server's tool names carry an instance-specific prefix
(`mcp__<id>__toolname`) — matched by **suffix**, not the full name, so this keeps working
across projects/instances:

- `..._apply_migration`, `..._deploy_edge_function`, `..._merge_branch`,
  `..._reset_branch`, `..._delete_branch` — always ask.
- `..._execute_sql` — inspects the call's `query`/`sql`/`statement` field: a write
  keyword asks, a recognizable read-only query (`SELECT`/`EXPLAIN`/`SHOW`) passes
  through, and anything the hook can't confidently classify **asks** rather than
  guessing — see Safety contract below.
- `..._create_branch` is deliberately left alone (creating a new, disposable Supabase
  branch is additive, not destructive — same spirit as the "disposable test database"
  allowance elsewhere in this project's rules).

### ALLOW (no decision — everything else)

`git status`/`diff`/`log`/`show`/`branch`, staging explicitly named files, commit/push on
a feature branch, tests and builds (`npm test`, `vite build`, `npm run dev`), read-only
SQL, `git clean -n`, switching branches (`git checkout <branch>`), unstaging without
touching the working tree (`git restore --staged <path>`), reversible stash operations
(`git stash`, `push`, `pop`, `apply`, `list`, `show`), and any tool this hook doesn't
govern at all (`Read`, `Write`, `Grep`, ...).

## Safety contract

- **Deterministic only.** Every decision is a plain string/regex check over the command
  text — there is no LLM/prompt call anywhere in this file, and there never should be:
  a classifier that can be talked out of a decision isn't a safety layer.
- **Never echoes the command or tool input in a reason.** A `deny`/`ask` reason is always
  a static, category-level sentence (e.g. "this looks like a SQL write") — never an
  interpolation of the actual command, which could itself contain a password or token
  (a connection string, an inline secret). Tested explicitly in
  `safety-guard.test.mjs`.
- **Fails closed on a parse error.** Malformed or incomplete JSON on stdin, an unreadable
  stdin stream, a `Bash`/`PowerShell` call whose `tool_input.command` field is missing or
  not a string (as opposed to a genuinely empty command, which is harmless and silently
  allowed), or an internal error while classifying a `Bash`/`PowerShell`/`mcp__*` call —
  all produce `ask` with a generic reason, never a silent pass-through, and never a crash
  that would block the tool call in an unrecoverable way. An error while inspecting a tool this hook
  doesn't govern (e.g. `Read`) never blocks that tool. A leading UTF-8 BOM on stdin
  (observed in practice on Windows depending on exactly how the parent process delivers
  stdin) is stripped before parsing rather than being treated as a parse error — this
  matters specifically because "fails closed" done naively here would otherwise make
  every single real call `ask` instead of actually being classified, which defeats the
  point of the classification existing at all.
- **No inferred consent.** The hook never looks at conversation history or tries to
  guess "the user probably already agreed to this" — an approvable operation is always
  `ask`, every time, regardless of what was said earlier in the session.
- **Tuned against blocking ordinary work.** The regexes are anchored to the *start* of a
  shell "segment" (split on unquoted `&&`/`;`/`||`/`|`) rather than scanning the whole
  command string, specifically so a command like
  `git commit -m "fix: git add . in docs"` is read as one `git commit` call, not
  mistaken for a `git add .` because the phrase appears inside a quoted commit message.
  See `safety-guard.test.mjs` for this and other explicit false-positive regression
  tests.

## Known limitations / false-positive & false-negative risk

- **Only governs commands that go through Claude Code's own `Bash`/`PowerShell`/`mcp__*`
  tool calls.** This is a `PreToolUse` hook — it runs exactly once, inside Claude Code,
  immediately before one of those specific tool calls executes. It has no effect at all
  on: a command the user types directly into their own terminal; a command run by any
  process outside a Claude Code session; a subprocess spawned by application code the
  session runs (e.g. a Node script that itself shells out); or a different AI tool/agent
  not going through this same hook plumbing. This is a known, deliberate scope limit, not
  a gap to fix — the text/hook layer only ever sees what Claude Code's controlled tool
  invocation shows it, and a user or process acting outside that path bypasses it
  entirely, the same way any other Claude Code permission setting would be bypassed by
  acting outside the session.
- **Not a real shell parser.** `splitCommandSegments()` is quote-aware, correctly handles
  a backslash-escaped double-quote (`\"`) and an escaped-backslash-before-a-real-quote
  (`\\"`) inside a double-quoted string, and interpreter-wrapper (`bash -c`/`powershell
  -Command`/`cmd /c`) unwrapping is handled explicitly (see ASK section above) — but it
  still doesn't handle nested subshells or command substitution (`` $(...) ``/backticks).
  A sufficiently unusual command using one of those could still evade a DENY/ASK rule
  (false negative).
- **SQL detection requires a literal `psql` invocation.** A write executed through a
  different client (a Node script calling `pg.Pool.query` directly, a different CLI,
  `dbclient`, etc.) is not detected. This is a deliberate scope limit to keep the false
  positive rate low, not a claim of complete coverage — see `.claude/rules/database-safety.md`
  for the standing rule this hook only partially automates.
- **"Disposable database" detection is a light heuristic** (a few known name fragments)
  — a real disposable DB invocation with a different naming convention will still ask,
  which is an inconvenience, not a safety gap; the reverse (a persistent DB slipping past
  as "disposable") is the risk actually worth watching for if this list is ever expanded.
- **Branch-aware checks (`push`/`commit` to `main`) shell out to `git rev-parse`** in the
  call's own `cwd`, with a 2-second timeout. Outside a git repo, if `git` isn't on
  `PATH`, or on timeout, the branch is "unknown" and these two specific checks silently
  do **not** ask — they degrade to "can't tell," not to "assume main." Every other rule
  in this file is unaffected by this. The ambiguous-`git checkout <token>` revision check
  (see DENY section above) deliberately makes the **opposite** choice under the same kind
  of uncertainty (not a repo / git unavailable / timeout all count as "can't confirm this
  is a safe ref") — it denies rather than allows, because the risk there is losing
  uncommitted work outright, not just skipping one confirmation prompt.
- **`rm -rf` with no target at all** is treated the same as targeting the current
  directory (risky) even though bare `rm -rf` actually just errors out in real bash
  ("missing operand") — a deliberate over-caution, not a bug; worst case is one
  unnecessary `deny` on a command that would have failed harmlessly anyway.
- **Deploy/migration command lists are enumerated, not inferred** — a deploy tool or
  script not already listed in `safety-guard.mjs` won't be caught. Extend the pattern
  lists there (and their tests) as new tooling gets adopted.
- **This governs `Bash`/`PowerShell` tool calls and Supabase MCP tool calls matched by
  the `mcp__.*` `settings.json` matcher** (classification is by tool-name *suffix* within
  `classifyMcpToolCall`, so it keeps working across different server instance ids — see
  "How it's wired" above). Any other MCP server (or any other execution path entirely) is
  not covered by this file and needs its own equivalent guard if it can run comparable
  risky operations.
- **Environment-variable-prefix stripping (`stripLeadingEnvAssignments`) only recognizes
  the literal `VAR=value cmd` shell syntax directly in front of the command**, not `export
  VAR=value` on its own line/segment, a `.env` file being sourced, or Windows `cmd.exe`'s
  `set VAR=value &&`. A command relying on one of those to set `DATABASE_URL` (or
  anything else this file keys off of) before an otherwise-bare governed command is not
  specially unwrapped — though `set VAR=value && <cmd>` is still just an ordinary `&&`
  chain, so the governed command's own segment is still classified normally once
  `&&`-split.
- **Not tamper-resistant against its own governed tools.** `isDestructiveRootDelete()`
  only fires on a *recursive, forced* delete of a root-like target — a plain, ordinary
  `rm .claude/hooks/safety-guard.mjs`, `del .claude\settings.json`, or overwriting either
  file's content in place matches no rule here and is silently allowed. The `Write`/
  `Edit` tools aren't governed by this hook at all, so either file can also be rewritten
  directly through them with no hook involvement whatsoever. This hook raises the bar
  for the specific commands it lists; it cannot, by itself, prevent a session from
  disabling or editing itself.

## Extending this hook

1. Add a new small, named, exported function to `safety-guard.mjs` (one rule per
   function, matching the existing style — anchor regexes to segment start, never embed
   the raw command in the reason text).
2. Wire it into `classifyShellCommand`/`classifyMcpToolCall`'s dispatch list, DENY before
   ASK.
3. Add at least one positive and one negative test case to
   `safety-guard.test.mjs`'s `CASES` table.
4. Run `node --test .claude/hooks/safety-guard.test.mjs` and `node --check
   .claude/hooks/safety-guard.mjs`.
