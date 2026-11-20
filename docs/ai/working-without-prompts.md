# Working without prompts: rules for executor sessions

Every permission prompt stops an executor until the owner clicks. Most prompts come from HOW a
command is written, not from what it does. These rules keep the same work silent. None of them
weakens a protection: a push to `main`, a force push, a deletion, a production database or a
secret file still asks or is denied, whichever way it is written.

Where the numbers come from: all 1,252 Bash calls of one executor session (2026-11), replayed
through the safety hook and the allow list on `main`. Only 377 ran without a question. 325 of the
rest contained an inline `python3 - <<'EOF'` or `node - <<'EOF'` script, and 95 a `sed -i`. Other
sessions will have other proportions; the causes are the same.

## The rules

1. **Edit files with the Edit and Write tools, not with shell scripts.** No `python3 - <<'EOF' …
   s.replace(…)`, no `node - <<'EOF'`, no `sed -i`, no `cat > file <<'EOF'` into the repository.
   The hook cannot tell a script that writes from one that only reads, so every such line asks.
   The Edit and Write tools do the same change and need no shell at all.

2. **One command per call where you can.** A line runs without a question only when EVERY part of
   it is allowed (`a && b; c | d` is four parts). One unknown part — a `python3`, an `awk`, a
   `rm` — makes the whole line ask. Split long chains: the allowed parts then run silently and only
   the one that needs a confirmation asks.

3. **A script you need: write it to a NEW file in your scratchpad with the Write tool, then run
   `node <file>` or `python3 <file>` as its own call.** Do not inline it in a heredoc. Running a
   script still asks once (it can do anything), but as one short, readable question, and the rest
   of your work stays silent. Two built-in checks of Claude Code (not of our hook, and we cannot
   switch them off) stop a heredoc whose text contains `$$` or `fsp.rm(`; in a file they do not
   apply.

4. **Read with the read-only commands, as plain as possible.** `grep`, `rg`, `cat`, `head`, `tail`,
   `sed -n`, `sort`, `uniq`, `cut`, `wc`, `diff`, `find`, `ls`, `git status/diff/log/show`,
   `git rev-parse`, `git ls-tree`, `git fetch -q origin main` are on the allow list. Use their
   common options; an unusual or abbreviated long option (`--out`, `--forc`) is not on the list and
   asks. Write output you want to keep to a NEW file in your scratchpad (`> $S/out.txt` with
   `S=/tmp/…` set earlier in the same line); writing into the repository, or over a file that
   already exists, asks.

5. **Bring `main` into your branch as its own call, inside the worktree.** `git -C <worktree> merge
   --no-edit origin/main` (or `cd <worktree> && git merge --no-edit origin/main`) runs silently on
   a working branch once #666 is merged. Do not chain it with a checkout, a second `cd`, a variable
   path (`cd $W`) or a background `&`: those ask.

6. **Run tests the plain way.** `node scripts/test-runner.mjs …`, `node --test backend/tests/<file>`
   or `node --test frontend/tests/<file>` from the repository root. A `DATABASE_URL` pointing at
   `localhost`/`127.0.0.1` is fine; any other host asks. Running `node --test tests/<file>` from
   inside `backend/` is not on the list: run it from the root.

7. **Plain variables only.** `S=/tmp/claude-…/scratchpad` or `export S=…` at the start of a line,
   joined with `;` or `&&`, then `$S` later. A value with `$(…)`, a `read`, a `for` over the same
   name, `eval` or `source` makes every redirect in that line ask.

8. **Check that the session reads the project settings at all.** In an executor session run
   `/status` and look at "Setting sources": `.claude/settings.json` must be listed. In a cloud
   thread inside a claude.ai project, and in a session with several repositories, the repository's
   `.claude/settings.json` (allow list and hook) does NOT apply — every command then follows the
   default permission flow and these rules cannot help. Project allow rules also apply only after
   the folder is trusted.

## What always asks or is denied (by design)

A push to `main`/`master`, any force push (`-f`, `--force`, `--force-with-lease`, `+branch`, and
their abbreviations), `git reset --hard`, `git clean -f`, discarding changes with `git checkout --
<path>` or `git restore`, `git stash drop/clear/pop`, `git branch -D`, deleting a remote branch,
`git pull --rebase`, a merge other than `origin/main` into a working branch, a migration runner, a
deploy, SQL that writes to a database that is not a disposable test database, a database URL that
is not this machine, and any command that names a secret file (`.env`, pgpass, keys, credentials).

Details of every rule: `.claude/hooks/README.md`.
