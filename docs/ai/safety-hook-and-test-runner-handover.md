# Safety hook and test runner — handover (2026-11-22)

A short record of the work done 2026-11-12 → 2026-11-22 on the PreToolUse safety hook
and the T1 test runner. The safety work is complete; per the owner, it is not widened
further without a new request from the owner.

## On main

| PR | What |
|---|---|
| #665, #666 | Guard: git allow list, indirect setters; worktree merge exemption, `git config` subcommands. |
| #692 | T1 test runner `scripts/test-runner.mjs`: per-kind steps, the "Not run" list and `--strict-not-run`, known-failure fingerprints, and the mock relaunch helper `backend/tests/support/relaunch-with-module-mocks.mjs`. |
| #698 | P3–P5 (owner-approved): an executor commits and pushes its own working branch, starts and stops its own test database, and changes files in its own scratchpad without a prompt. Files: `.claude/hooks/safety-guard.mjs`, `.claude/settings.json`, `.claude/rules/git-safety.md`, `docs/ai/working-without-prompts.md`. |
| #700 | The runner enforces the per-test limit itself (node ignores `--test-timeout` for a file started directly) and reports `test timeout: <name>`. After a file it ended, the runner drops that file's test databases (plain DROP, never forced) or names them as leftover. |
| #701 | `"onFailure": "block"` + `"timeout": 30` on the guard registrations (a guard that cannot start, crashes or times out blocks the call); the SessionStart self-check `.claude/hooks/hook-selfcheck.mjs`, which also has a manual mode for a session started before it existed; the guard's main-module check compares real paths (it was a silent no-op behind a symlinked project folder). |
| #704 | File tools (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) ask for any target in the live `.claude` folder, and for ambiguous paths (`~`, surrounding spaces, `..`, device paths, `/proc`); `"disableAllHooks": false` in project settings. |

How it works and what it does not cover: `.claude/hooks/README.md`, especially "The allow
list", "If the hook does not run" and "File tools on the .claude folder (ASK)". The session
rule for the self-check is in `CLAUDE.md`, "Startup gate".

## Tests

- Hooks: `node --test .claude/hooks/safety-guard.test.mjs .claude/hooks/hook-selfcheck.test.mjs`
  (254 at #704).
- Self-check by hand: `node .claude/hooks/hook-selfcheck.mjs`. It prints "Safety hook
  self-check passed" with exit 0, or "SAFETY HOOK SELF-CHECK FAILED" with exit 1.
- Runner self-test: `node scripts/test-runner.selftest.mjs` (51 checks on Node 22.23).
- Suites: `node scripts/test-runner.mjs --preset backend-fast` / `--preset frontend-fast`.
  Database kinds: `--kind disposable` with a local PostgreSQL and a loopback `DATABASE_URL`
  (see `docs/ai/test-infrastructure-discovery.md`).

The command corpus and the "effective decision" replay script (hook plus settings) used to
compare #698 with main lived only in the session's temporary folder and are **not** in the
repository. They can be rebuilt from the `[command, ASK|DENY|ALLOW]` tables in
`safety-guard.test.mjs`.

## Open

- **L3:** gaps in the guard's secret-file list (gh, docker, gcloud credentials). Known
  before this work, not started.
- **LOW (#704):** a relative file path with a `..` segment asks even when it points outside
  `.claude`. Accepted, because the file tools normally send absolute paths.
- **Not covered by design** (`.claude/hooks/README.md`):
  - a Bash redirect or `tee` into `.claude`, although a Bash write outside the scratchpad
    already asks;
  - hard links;
  - future or renamed file tools;
  - writes from an MCP filesystem server;
  - `~/.claude/settings.json`;
  - layers above project settings (`settings.local.json`, `--settings`, managed settings).
- **Failures on main under Node 22.23**, not caused by the runner (plain `node --test` shows
  the same): `exercise-editor-thumbnail` and `exercise-media-thumbnail` (frontend),
  `gpexe-client` and `gpexe-rest-v1-adapter-reads` (backend). Node cancels their tests with
  "Promise resolution is still pending but the event loop has already resolved".
- **#672** was closed without merge; its branch `fix/safety-guard-verified-allow` is kept as
  a reference.
