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
  { "matcher": "Bash",       "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs"] }] },
  { "matcher": "PowerShell", "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs"] }] },
  { "matcher": "mcp__.*",    "hooks": [{ "type": "command", "command": "node", "args": ["${CLAUDE_PROJECT_DIR}/.claude/hooks/safety-guard.mjs"] }] }
] } }
```

This is **exec form** — a bare executable name in `command` plus an explicit `args`
array — not shell form (a single string handed to a shell to interpret). That distinction
is the reason this hook works identically for both the `Bash` and `PowerShell` tools on
Windows: a shell-form string like `"node \"$CLAUDE_PROJECT_DIR/.claude/hooks/
safety-guard.mjs\""` has to be interpolated *by whatever shell runs it*, and a bare
`$CLAUDE_PROJECT_DIR` is POSIX/bash syntax — PowerShell doesn't expand it that way at
all, so the PowerShell-tool-triggered invocation of that shell-form string would
silently fail to resolve the path and the hook would never actually run for a
PowerShell-tool call. Exec form has no shell in the loop at all: Claude Code substitutes
the `${CLAUDE_PROJECT_DIR}` placeholder itself (braced, not bare — the brace is what
marks it as a placeholder Claude Code resolves directly, rather than shell syntax) and
spawns `node` with the resolved path as a literal argument, so there is no
interpolation step left for either shell's own rules to get wrong.

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
- (`git checkout --detach <ref>`, `--orphan <name>`, `-t`/`--track <branch>`, `-b`/`-B <name>`
  take a commit or a branch, never a path, and are never read as a discard, even when the ref
  cannot be verified from the hook — for example in a worktree that does not exist yet.)
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

- **Every long git option is read as a possible prefix.** git accepts any unique prefix of a long
  option (`--forc`, `--for`, even `--f` are `--force` to `git checkout`; `--har` is `--hard`;
  `--force-w` is `--force-with-lease`), so every rule compares through `longOptionIs`, and an
  ambiguous prefix git would refuse counts as the dangerous option too. `git checkout` and
  `git switch` go further: a long option not on their list of known options asks. `git push origin
  +branch` (a forced refspec) and `-uf` clusters are a force push; `git worktree remove --force`
  asks.
- `git merge` / `git rebase` — except a plain `git merge [--no-edit|--no-ff|--no-commit|-q] origin/main`
  (or `origin/master`) while the current branch is known and is not `main`/`master` (read as a full
  ref, see below), alone or after read-only commands (`git status/fetch/rev-parse/log/diff/show/
  merge-base` without `--output`, `--ext-diff` or `--textconv`, `wc/head/tail`, the same with
  `git -C <path>`) in the same line; every other segment of that line is still judged and the
  strictest verdict wins. A line with ANY part that makes a work tree (`git init`, `git clone`,
  `git worktree add`) or moves HEAD or a branch (`git checkout`, `git switch`), before or after
  the merge, gets no exemption: the hook checks the branch before the line runs. In a worktree
  the merge may be written `git -C <path> merge …` or follow ONE `cd <path> &&` in the same
  line: the hook resolves that folder itself (relative to its `cwd`), requires it to be exactly
  the top of an existing work tree (`git -C <path> rev-parse --show-toplevel` equals its real
  path, so a linked worktree with a `.git` file and a symlink to a top pass, a subfolder or a
  plain folder does not), and checks the branch THERE. A path with `~`, `$`, a glob or quotes,
  a second `cd`, `cd -`, or a folder whose branch is main/master or whose HEAD is detached:
  asks as before.
- `git worktree add` except with `--detach` or `-b <new branch>` (not `main`/`master`), exact
  spellings, no `-B`/`--force`/`--orphan`. Without them git checks out an EXISTING branch: the
  one named as an operand, or the one named like the folder (`git worktree add ../w3` checks
  out branch `w3` when it exists), as the tests prove with real git.
- `git config set|unset|edit|rename-section|remove-section|replace-all|add` (the subcommand
  syntax of git 2.46 and later) writes; only `get` and `list` read.
- `gh pr merge`.
- A push that targets `main` explicitly, or a bare `git push`/`git push origin` while the
  hook can determine (via a fast, read-only `git symbolic-ref -q HEAD` in the command's own
  `cwd`, compared as the FULL ref `refs/heads/main`, case-insensitively) that the current
  branch *is* `main`. Not `git rev-parse --abbrev-ref HEAD`: with a tag or a `refs/remotes/`
  ref also named `main` (a tag can arrive with an ordinary `git fetch`) it prints `heads/main`
  and no check on the short name recognises the branch.
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
(`git stash`, `push`, `apply`, `list`, `show` — `pop` asks, see below), and any tool this
hook doesn't govern at all (`Read`, `Write`, `Grep`, ...).

### ASK added with the hardening (Bash + PowerShell)

- P3-P5 (owner, in the executor's session, 2026-11-20). `.claude/settings.json` lets `git add`,
  `git commit`, `git push -u origin …`/`git push origin …`, `rm`, `rmdir`, `cp`, `mv`, `mkdir`,
  `ln` and `touch` through by name (stopping a database is decided by the hook alone, below);
  the hook asks for every form
  outside the approved scope:
  - `git add -u`/`--update`/`-f`/`--force`, a glob or magic pathspec (`*.js`, `:/`), a pathspec
    file; `git commit -a`/`--all` (and in clusters, `-am`), `git commit --amend` (it rewrites a
    commit that may already be pushed); a commit on `main` or `master`; a `git add` operand
    that is a folder, `.`/`..`, absolute or an expansion; any pathspec on the commit line
    (`git commit -m x .` commits everything under it); a commit or push in a line with a `cd`,
    `pushd`, `popd` or checkout (they move where it runs);
  - every push except `git push [-u|--set-upstream] [-q] origin <B>` where `<B>` is the branch
    checked out where the push runs (read from git, as a full ref) and not `main`/`master`: a bare
    `git push`, another remote or branch, a refspec, tags, `--no-verify`, any other option; and
    a push that git configuration could send elsewhere (`remote.origin.push`,
    `remote.origin.pushurl`, or `push.default` upstream/tracking with an upstream of another name);
  - `rm`, `rmdir`, `cp`, `mv`, `mkdir`, `ln`, `touch` unless every path they change is inside the
    session's own temporary folder (never the folder itself), outside every git work tree (a
    recursive delete or move of a folder that holds one asks too), absolute, without `..`,
    named literally or by a plain variable of the same line; a glob only in the last part of a
    non-recursive `rm`. `cp` reads its sources and `ln -s` writes only a link's text, so those
    may be anywhere; `mv` deletes its sources, so they must be inside. A hard link (`ln` without
    `-s`, `cp -l`) always asks, and so does overwriting a hard-linked or symlinked file. Without a
    `session_id` in the hook input there is no own folder, and all of these ask.
    Found by the internal review and closed: a plain variable is put in only by its WHOLE name
    (`$Db` and `$PWD` are other variables; this also fixes the older redirect check); a trailing
    `/` or `/.` follows a link (`rm -rf $S/link/` deletes the link's target); a destination that
    is a link asks, and into an existing folder the entry that would be written is judged (a link
    already in the folder would be written through); `ln -s` only to a target inside the own
    folder; `cp -a/-P/-d` (they copy links) ask; operands added by `xargs`/`find` ask;
    `rmdir -p` asks (it climbs past the folder). In a line where another part makes links or work
    trees (`ln`, `mv`, `cp -r`, `git init/clone/worktree add`), every scratch exemption of the
    other parts is off: the hook reads the file system before the line runs.
    Closed after the Nezavisni's #698 HIGH-1 (a real deletion outside the folder): the line's
    variables are kept by the POSITION of a part, not by its text (two identical `rm -rf $S`
    with S reassigned between them shared the first one's value); a name assigned more than once
    anywhere in the line (or by `for`, `read`, `select`…) is never put in; and a fail-closed
    backstop counts `rm`/`rmdir`/`cp`/`mv`/`mkdir`/`ln`/`touch`/`pg_ctl` at every command
    position of the raw line (after `;`, `&&`, `|`, `(`, `)`, `{`, `}`, `!`, a keyword, a case
    branch, `coproc`, common prefixes; quotes not read): if there are more than the parts the
    rules judged, the line asks. A `cp` source that is a link or a `/proc`, `/dev` path asks.
  - the local test database: `pg_ctl … stop|restart|kill|promote|reload` asks unless `-D` (or
    `--pgdata`) names, literally or by a plain variable of the line, a data folder inside the
    session's own temporary folder (realpath, not a git work tree); `pg_ctl` without `-D`
    (PGDATA from the environment) asks; `pg_ctl kill` always asks (it signals a PID, whatever
    `-D` says); every `pg_ctlcluster … stop|restart|reload` asks. Starting is left alone. More
    than one data folder (pg_ctl takes the last) or an abbreviation of `--pgdata` asks; a stop
    is silent only when the PID in `postmaster.pid` is a process running in that data folder
    (`/proc/<pid>/cwd`), or when there is no `postmaster.pid` (nothing is signalled).
    `su` and `runuser` always ask (their command is a string not read here); `sudo` is read
    through. In a cloud container (root, a root-only temporary folder) a cluster cannot live in
    the temporary folder, so stopping 16/main asks there — a deliberate choice (Rukovodilac,
    2026-11-20): stopping is rare and the container is temporary. Possible extensions, not
    built: a marker file `OPTIMOVE_TEST_CLUSTER` in a cluster's data folder (created once, with a
    question) that makes stopping that cluster silent; and the environment's setup script
    creating that marker at container start. Known limit
    (TOCTOU): the hook reads the file system before the command runs; a link swapped in by
    another process between that check and the command is not seen.

- `git stash pop`; `git branch -D` (and `-d -f`, `--delete --force`); a push that deletes a
  remote branch (`--delete`, `-d`, `origin :branch`, `--prune`, `--mirror`); `git pull
  --rebase` / `-r` / `--rebase=<anything but false>`. They were silent before, which
  contradicted `.claude/rules/git-safety.md`. Measured cost: in one executor session's 1,252
  Bash calls (2026-11), one real `git branch -D` and nothing else.
- A shell that reads commands this hook cannot see: `... | bash`, `... | sh -s`, `eval "$X"`,
  `bash -c "$X"`.
- A database URL or `PGHOST`/`PGHOSTADDR`/`PGSERVICE` set for a command (prefix, `env`,
  `export`) that is not this machine, or cannot be read (`$VAR`, backticks).
- A command that names a file holding secrets: `.env` and every copy or variant of it
  (`.env.local`, `.env.bak`, `.env~`, `.env.save`, `backend/.env/`), `.envrc`,
  `/proc/<pid>/environ`,
  `pgpass.conf`, `.pgpass`, `*.pem`, `*.key`, `*.p12`, `id_rsa`/`id_ed25519` (not `.pub`),
  `.netrc`, `.npmrc`, `.git-credentials`, `credentials`, `.credentials.json`. Not
  `.env.example`/`.sample`/`.template`.
- An allowed read command used in a form that writes, deletes or runs something else (next
  section).
- **Every git subcommand that is not on the hook's list.** The list (`GIT_POLICY` in
  `safety-guard.mjs`) names each subcommand git work needs, with the options known for it:
  the read commands (`status`, `diff`, `log`, `show`, `fetch`, `rev-parse`, `merge-base`,
  `ls-remote`, `ls-tree`, `merge-tree`, `rev-list`, `shortlog`, `ls-files`, `blame`, `grep`,
  `describe`, `cat-file`, `show-ref`, `for-each-ref`, `check-ignore`, `name-rev`, `version`),
  the read forms of `symbolic-ref`, `reflog`, `tag`, `remote` and `config`, and the working
  commands (`add`, `commit`, `push`, `pull`, `merge`, `rebase`, `branch`, `checkout`, `switch`,
  `restore`, `reset`, `rm`, `clean`, `stash`, `worktree`, `init`, `clone`), which the rules
  above judge further. Anything else asks: plumbing (`checkout-index`, `read-tree`,
  `update-ref`, `update-index`, `reflog expire/delete`, `gc`, `prune`, `filter-branch`,
  `replace`), a subcommand git adds later, a forced or renaming branch (`branch -f`, `-M`,
  `-C`), `checkout -B`, `switch -C`, `rm -f`, a push with a refspec (`a:b`, `+b`), a writing
  `config`/`tag`/`remote`, and any global option other than `-C`, `-c`, `--config-env`,
  `--no-pager`, `-P`, `--no-optional-locks`, `--literal-pathspecs`, `--no-replace-objects`.
  Each loss above was proven with real git in the tests. Measured cost: none of the 1,252
  replayed Bash calls that ran silently before asks now.
- `git restore --pathspec-from-file=<file>` (and every prefix of the option, `--pathspec-f=`)
  names its targets in a file: it is judged like `git restore <path>`.

### How the hook reads a command line

Each part of a line is judged on its own and the strictest verdict wins. Before judging,
the hook also reads:
- every line of a multi-line command (newline and CR separate commands; a backslash before a
  newline joins lines), and a single `&` (background) as a separator;
- the command behind `env`, `sudo`/`doas`, `command`, `exec`, `nohup`, `nice`, `time`,
  `timeout`, `stdbuf`, `xargs`, a leading backslash, an absolute or relative path to a known
  command, shell keywords (`then`, `do`, `if`, ...) and `( )` / `{ }` groups;
- what runs inside `$( )`, `<( )`, `>( )` and backticks (not inside single quotes);
- the code of `bash/sh/zsh/dash/ksh -c` (any flag cluster with `c`, e.g. `-lc`), `eval`,
  PowerShell `-Command` and `cmd /c`;
- a shell as the first word inside `<( )` or `>( )` that reads what it is fed (`cat >(sh)`)
  asks; a substitution is one operand for the option check (`cat <(sort -r x)` is `cat` with
  one operand);
- the body of a heredoc that a shell reads (`bash <<'E'`), and a here-string to a shell. The
  body of any other heredoc is data (a commit message, a file being written, a Python
  script) and is not read as shell; a heredoc without its closing word is read as commands;
- a variable as the command word (`$GIT push -f`) is read as git;
- every word as the program receives it: `'git'`, `"git"`, `g\it`, `re""set`, `$'reset'`,
  `$'\x72eset'`, `$'\u0072eset'`, `$'\U00000072eset'` are all plain words, and a backslash-newline inside a word joins it
  (`--ha\⏎rd` is `--hard`);
- a line with a background job (a single `&`) gets no merge exemption.
What still cannot be seen: what a script file, a Python or Node program, or a git
configuration runs; a command assembled at run time from several variables.

### The allow list (`.claude/settings.json` `permissions.allow`) and what the hook adds

Claude Code already runs its own read-only set (`ls`, `cat`, `head`, `tail`, `grep`, `find`,
`wc`, `diff`, read-only git, ...) without a question; the entries below make that explicit and
add `sed -n`, `rg`, `sort`, `uniq`, `cut`, three git read commands and the two test folders. An
allow rule is a text pattern (`Bash(sort:*)` also matches `sort --out=file`), and a compound
command runs without a question only when every part is allowed. A hook "ask" still asks when an
allow rule matches.

**The rule for every allowed command: the hook is silent only when every option is on that
command's explicit list of known-safe options** (`spec(...)` tables in `safety-guard.mjs`). Any
other option asks — including an abbreviated long option: git and the GNU tools accept
`--upload` for `--upload-pack`, `--out` for `--output`, `--in-pl` for `--in-place`, and none of
these abbreviations is on a list. Options are read as the program receives them (quotes and
backslashes removed), redirection words are not options.

| Entry | On its list (examples) | Never on it (asks) |
|---|---|---|
| `Bash(sed -n:*)` | `-n -E -r -s -u -z -e --expression --sandbox` | `-i`, `--in-place`, `-f`; a script with `w`/`W`/`e`/`r`/`R`, `s///w`, `s///e`, or one that cannot be read (`$X`) |
| `Bash(grep:*)` | the matching, context, include/exclude and output-format options | anything else |
| `Bash(rg:*)` | the matching, glob/type, context, `--files`, `--json`, `--hidden`, `--no-ignore` options | `--pre`, `--pre-glob`, `-z`/`--search-zip` (run programs) |
| `Bash(cat:*)`, `head`, `tail`, `wc`, `cut`, `ls`, `diff` | their reading and formatting options | `wc --files0-from`, `diff -l` (runs `pr`), anything else |
| `Bash(find:*)` | `-name -iname -path -type -maxdepth -mindepth -newer -mtime -size -empty -print -prune` and the operators | `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, `-fprint*`, `-fls`, `-files0-from`, anything else |
| `Bash(sort:*)` | the ordering, key and field options | `-o`, `--output`, `-T`, `--compress-program`, `--files0-from` |
| `Bash(uniq:*)` | its counting and comparing options | a second file name (the output file) |
| `git status/diff/log/show/fetch/rev-parse/merge-base/ls-remote/ls-tree/merge-tree`, `git worktree list` | per subcommand: the reading, formatting, revision-range and pickaxe options; `fetch` and `ls-remote` with a remote NAME (`origin`) and branch names or ref patterns — a URL or a path asks (a request to any host) | `--output`, `--ext-diff`, `--textconv`, `--upload-pack`, `--exec`, `--show-signature` (runs gpg), a fetch refspec with `:` (it writes local refs); git global options other than `-C`, `--no-pager`, `--no-optional-locks`, `--literal-pathspecs` |
| `Bash(node --test backend/tests/*)`, `…frontend/tests/*` | test files under the two folders (no `..`, no absolute path); `--test-name-pattern`, `--test-skip-pattern`, `--test-concurrency`, `--test-timeout`, `--test-only`, `--test-shard`, `--test-reporter=spec/tap/dot/junit/lcov`, `--test-reporter-destination=stdout/stderr`, `--experimental-test-isolation=none/process` | `--import`, `--require`, `-r`, `--loader`, `-e`, a reporter module or a destination file, anything else |

**Writing to a file.** An allowed command with an output redirection (`>`, `>>`, `>|`, `&>`,
`N>`) asks, unless the target is `/dev/null`, `/dev/stdout`, `/dev/stderr`, a descriptor
(`2>&1`, `>&2`), or a plain absolute path that, with every symbolic link followed, lies inside
the system's temporary directory (`os.tmpdir()`, `/tmp`) AND does not exist yet AND is not inside a
git work tree (no parent folder holds a `.git` file or folder: executors' and reviewers'
worktrees live under the temporary directory too; the search for a `.git` goes up to the root
of the file system, so a TMPDIR inside a repository counts too) and no part of its path, existing
or not yet, is `.git`. A line that creates a work tree (`git init`, `git clone`,
`git worktree add`) gets no temporary-directory exemption at all: the folder it creates is not a
work tree yet when the hook looks. If `git worktree move`, `git submodule add`, `cp -r`, `tar x` or any
other command that can create or move a work tree is ever added to the allow list, it must be
added to `createsGitWorkTree` too. A redirect may use a variable only when its value is certain: the
line consists only of plain assignments `NAME=value` (no `$`, backtick, quotes or substitution in
the value; `export NAME=value` too) and plain commands, joined by `;` or a newline (or by `&&`
while everything before is a plain assignment), with no `||`, pipe or background job; the
assignment comes before the redirect; and the name is not set or mentioned in any other way
before it (`read S`, `for S in`, `S+=`, `${S:=x}`, `unset S`, `S=$(...)`, `S=x cmd`, a second
assignment, `eval`, `source`, `declare`, a loop, a function ...). Otherwise the variable is
unknown and the redirect asks. A setter word (`read`, `printf`, `declare`, `mapfile`, `let`,
...) at the command position of ANY part, after peeling `!`, `time [-p]`, `command`,
`builtin`, `nohup`, `exec`, `env [options] [NAME=value]...` and leading `NAME=value` (again and
again), or any indirection (`${!x}`, an assignment inside `$(( ))` or `(( ))`, which also covers
`$(( $T = 5 ))`), makes EVERY variable of the line unknown: `T=S; time read $T` sets `S`
without naming it, as the tests prove with real bash. **An existing
file asks**, whatever it is (rewriting or appending to it may change something that runs later — a
script, a `package.json`, a SQL file for psql -f, a patch, a `postgresql.conf`), with one exception
since 2026-11-20 (owner): a plain file inside this session's OWN temporary folder (its scratchpad,
`<tmp>/claude-<uid>/<project>/<session id>/scratchpad`, known from the hook input's `session_id`),
outside every git work tree, and not a hard link (another name of the file could be in a
repository); a symbolic link there still asks. A target with `..`, `~`, a glob, or a
variable whose value is not a plain assignment earlier in the same line (`S=/tmp/x; ... > $S/out`)
asks. Commands that are not on the allow list (`echo x > file`) are left to Claude Code's own
redirection check.

**In front of an allowed command** (or exported anywhere in the line), an environment variable
that changes what a program runs or loads asks: `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`,
`PATH`, `PAGER`, `EDITOR`, `BASH_ENV`, `GIT_*`, `RIPGREP_CONFIG_PATH` and similar; so does a
database URL or `PGHOST` that is not this machine, cannot be read, or names several hosts.

**Also asks:** an `alias` definition (`alias g=git; g reset --hard`); `git -c` / `--config-env`
with any key other than `user.name`, `user.email`, `color.ui`, `core.quotepath`,
`init.defaultBranch` and a few display settings (`git -c alias.x='reset --hard' x`,
`git -c core.pager=...`); `git reset --merge` / `--keep`; `git switch -f` / `--discard-changes`
and `git checkout -f` (a `checkout` that discards files stays denied). A function definition's
body is read as commands (`f(){ git reset --hard; }` is denied).

**Measured** (all 1,252 Bash calls of one executor session, 2026-11, replayed through main's
hook and settings and through these, with a model of Claude Code's own decision: its
documented read-only set plus the allow rules as text patterns, redirections assumed allowed
by Claude Code): without any question 62 → 380 calls; 321 calls stop asking; 3 start asking
(all three write into repository files: `cat > docs/...`, `git diff > ../x.patch`).

Not allowed: `rm`, `mv`, `cp`, `tee`, `awk`, `xargs`, `curl`, `wget`, `psql`/`pg_*`, a shell,
`python`, git `add/commit/reset/clean/stash/rebase/checkout/restore/switch/pull/merge`, any MCP
write tool, anything under `.claude/`. Claude Code's own "sensitive file" prompt for
`.claude/` settings and hooks stays and is outside this hook.

Secret files for the `Read` tool (and the file commands Claude Code recognises in Bash, such
as `cat`, `head`, `tail`, `sed`): `permissions.deny` has `Read(**/.pgpass)`,
`Read(**/pgpass.conf)`, `Read(**/*.pem)`, `Read(**/*.key)`, `Read(**/id_rsa)`,
`Read(**/id_ed25519)`, `Read(**/.git-credentials)`, `Read(**/.credentials.json)`;
`permissions.ask` has `Read(**/.env)`, `Read(**/.env.local)`, `Read(**/.env.production)`. The
`**/` form is gitignore syntax but not shown in Claude Code's documentation: check it once
with `/permissions` in a new session. **What still reads a secret silently:** a command that
reads files without naming them — `grep -r x .`, `rg -uu x` / `rg --no-ignore --hidden x`,
`cat *` in a folder that holds a `.env`, a Node or Python script. `rg` without `-uu` skips files
that `.gitignore` lists; `grep -r` does not. The hook asks only for a NAMED secret file,
including through quotes (`backend/'.env'`, `.\env`) and globs or braces whose literal part can
reach one (`.e*`, `.en{v,}`, `.[e]nv`, `pgpass*`, `id_*`, `*.pem`); a bare `*` is not treated
as aimed at a secret.

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

- **The merge exemption trusts git's configuration of the repository.** The hook checks the
  branch once, before the whole command line runs. Git itself can run configured programs
  during the read-only commands allowed before the merge (`core.fsmonitor`, a pager, hooks of
  other tools), and such a program could change the branch before the merge runs. The options
  that ask git for an external program explicitly (`--ext-diff`, `--textconv`, `--output`)
  take the exemption away; the repository's own configuration is outside what this hook can
  see. Built-in git commands cannot be aliased, so `git status` is always git's own.
- **The branch is checked in the `cwd` the hook receives.** That is the `cwd` field of the
  hook's input JSON. A `cd` earlier in the SAME command line is handled (it takes the merge
  exemption away). Whether `cwd` follows a `cd` that persisted from an EARLIER Bash call is
  set out below in "Which directory the hook sees".

## Which directory the hook sees

Every branch check runs `git` in the `cwd` field of the hook's input JSON (or in the
directory of a `git -C <dir>`), never in the hook process's own directory. The `cwd` field
falls back to `process.cwd()` only when the input has none.

What the Claude Code hooks reference (https://code.claude.com/docs/en/hooks.md) says, as
read on 2026-11-19: `cwd` is the "Current working directory when the hook is invoked", and
"`cwd` follows Claude: the `cwd` field in the hook's input JSON is the worktree root after
Claude enters a worktree, and the new directory after Claude runs `cd`." So a `cd` that
persisted from an earlier Bash call should be what the hook checks. This is **documented but
not verified in a live session** here. If it ever turns out not to hold, a merge would be
checked against the branch of the directory the session started in.

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
