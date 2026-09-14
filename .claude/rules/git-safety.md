# Git safety

Applies to every session, regardless of task type.

## Startup gate

Before the first edit in a session, run and read:

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff            # if there are unstaged changes
git diff --staged   # if there are staged changes
```

- Dirty/untracked files you did not create this session: record them, don't touch them.
- If they don't overlap the current task, proceed — their mere presence isn't a blocker.
- Ask the user only when: (a) they genuinely overlap files the task changes, (b) your
  action risks losing someone's uncommitted work, or (c) the task can't be safely isolated
  from that state.
- Unexpected current branch (e.g. `main` when a feature branch was expected, or vice
  versa): stop and ask before editing.

## Hard prohibitions (without explicit user permission in that specific session)

- `git add .` or any equivalent that stages everything — stage explicitly, file by file,
  so unrelated dirty/untracked files never get swept in.
- `git clean`, `git reset --hard`, anything that discards uncommitted work.
- `git merge`, `git rebase` over existing history, `git push --force`.
- Commit and push without the user's explicit confirmation for that specific set of
  changes — even when the work is done, stop and ask before committing/pushing, never
  assume standing consent.

## Feature branches

- New work branches from `origin/main` (or the relevant base), not from a stale local
  branch that may be behind.
- Before opening a PR: confirm the branch is pushed, HEAD matches `origin/<branch>`, and
  `git diff --name-status origin/main...HEAD` contains only the intended files.

## Baseline regression worktree

Run this only when a test actually fails and you need to know whether the failure is
pre-existing or introduced by the current change:

- Create an isolated, uniquely-named, **detached** worktree from the exact base ref:
  `git worktree add --detach <unique-temp-path> origin/main`. Never a fixed/hardcoded
  path that could collide with a parallel session.
- Never use `git stash`, `git reset`, or `git checkout` over the user's existing,
  uncommitted work to "get out of the way" for this check — the worktree exists
  specifically so that's never necessary.
- Always remove the worktree in a `finally`/cleanup step (`git worktree remove`),
  regardless of whether the baseline test passed, failed, or the check itself errored.

## Merge / deploy / migrations

Never merge, force-push to `main`, deploy, or run a migration against a persistent
database without the user's explicit, current-session authorization for that specific
action — a prior approval for a similar action does not carry over. See
`database-safety.md` and `migrations.md` for the database-specific rules.
