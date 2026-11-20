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
- `git merge`, `git rebase` over existing history, `git push --force`. The one exception: merging
  `origin/main` into one's own feature branch (`git merge [--no-edit] origin/main`, never while on
  `main`/`master`) needs no confirmation (the hook reads the branch as a full ref, so a tag named `main`
  cannot pass for a working branch); merges INTO `main` are done only by the Rukovodilac,
  through GitHub.
- Committing on `main`/`master`, or pushing anything other than one's own work branch:
  a push to `main`/`master`, a force push, another branch, a refspec (`a:b`), tags, a bare
  `git push` whose target is not visible. Merging into `main` is done only by the
  Rukovodilac, through GitHub.

## Without a question (owner's decision, 2026-11-20)

Executor sessions may, without asking each time:

- commit on their own work branch (files staged by name; `git add -u`, `-f`, globs,
  `git commit -a` and `git commit --amend` still ask) and push it with `git push [-u] origin <the branch checked out
  there>` — never `main`/`master`, never a force push;
- start and stop the local test database (`pg_ctlcluster 16 main start|stop|status`,
  `pg_ctl`, `initdb`);
- delete, move and change files in their own temporary folder (the session's scratchpad):
  `rm`, `rmdir`, `cp`, `mv`, `mkdir`, `ln -s`, `touch`, and writing over a file there. Not
  the folder itself, not a git worktree inside it, not a hard link, and not a path the hook
  cannot read on the command line.

Still asked every time: merging into `main`, production (deploys, migrations, persistent
databases), passwords and secret files, and deleting or changing anything outside the own
temporary folder. The safety hook (`.claude/hooks/safety-guard.mjs`) enforces these limits:
`.claude/settings.json` lets the commands through by name, and the hook asks for every form
outside the scope above.

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
