# Test infrastructure — discovery and the T1 foundation

Written 2026-10-11 on `origin/main` `241765e` (the merge of PR #154), in a worktree at
exactly that commit. T1 changes no production code, no backend or frontend contract, no
migration, and sends nothing to GPEXE, Render or any remote service. Everything measured
below was measured by running the suites once on this workstation (Windows 10, Node
24.12.0, PostgreSQL 17.5 on `localhost:5432`); durations are wall-clock, one file at a
time, and only approximate.

## 1. The test map as found

### 1.1 Files and what the existing commands run

| Package | Test files | Existing command | What it runs |
|---|---|---|---|
| backend | 100 `backend/tests/*.test.mjs` | `npm --prefix backend test` → `node --test --test-concurrency=1 tests/**/*.test.mjs` | every file, one process per file, serially, with `backend/.env` loaded by each file's own `import "dotenv/config"` |
| frontend | 102 `frontend/tests/*.test.mjs` | `npm --prefix frontend test` → `node --test tests/**/*.test.mjs` | every file, one process per file, in parallel |
| backend | — | `npm --prefix backend run test:verify-isolation` | `scripts/verify-test-suite-isolation.mjs`: `npm test` three times against the development database with a before/after snapshot (manual maintenance check) |

Neither command has a time limit per file, tells a known failure from a new one, or
notices a file whose process never exits (`node --test` simply waits).

### 1.2 Backend files by what they need

The runner's static classification (`npm run test:list`), confirmed by the measured run
(section 1.4):

| Kind | Files | Meaning |
|---|---|---|
| `unit` | 13 | no database at all; fake fetch or pure functions (`gpexe-client`, `gpexe-rest-v1-adapter*`, `gpexe-rest-v1-capability-probe`, `gpexe-auth-discovery`, `source-credential-crypto`, `email-service`, `builder-tree-batch`, `builder-timing`, `training-package-tools`, `gpexe-import-reasons`, `test-cleanup-helper`, `production-static-serving`¹) |
| `disposable` | 42 | the file creates its own uniquely named database(s) on the server behind `DATABASE_URL`, applies a scaffold plus `migrations_v2` through the real runner, and drops them; 17 through `_gpexe-disposable-db.mjs`, 18 through a private `makeTempDb`/`dropTempDb` pair, the rest with inline SQL |
| `shared` | 44 | the file writes fixtures into the database `DATABASE_URL` names (the local `OPTIMOVE` development database, which carries the legacy schema the migrations do not create), and cleans them up in `after()` — 36 of them through `_test-cleanup.mjs` |
| `schema-clone` | 1 | `training-load-metrics-builder-edit-draft.test.mjs`: `pg_dump` of the schema named by `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` into a disposable database; refuses to start without that variable (deliberate) |

¹ `production-static-serving.test.mjs` imports no database module but spawns the real
`src/server.js` in production mode, whose `/api/health` runs `select now()`; it needs a
reachable local server and nothing else, so the manifest maps it to `disposable` (it
gets the maintenance database `postgres` as its target and creates nothing).

Of the 100 backend files, 70 start an in-process `http.createServer(app)`, 9 spawn a
child process (`src/server.js`, the migrator, or `pg_dump`/`pg_restore`), and 14 install
a fake `fetch` for a fake GPEXE or email provider (`gpexe-athlete-identity`,
`gpexe-check-finalization`, `gpexe-import-credential-resolver`,
`source-connections-f3c2d/e/f`, `tests-notification-worker`, `email-verification`,
`password-reset`, the four adapter / probe / discovery unit files, `email-service`).

All 102 frontend files are `unit`: 4 use jsdom, 61 install a hand-written
`globalThis.document` stub, 37 need no DOM at all.

### 1.3 Existing shared helpers and fixtures

| File | Used by | What it holds |
|---|---|---|
| `backend/tests/_test-cleanup.mjs` | 36 shared-kind files | `runCleanupSteps`: every cleanup step runs even when one fails, then the file's `after()` fails loudly |
| `backend/tests/_gpexe-disposable-db.mjs` | 18 files (the GPEXE / source-connections family, `activity-roster-5a1`, `activity-roster-5a2`, `pool-checkout-timeout`) + `scripts/gpexe-pilot-disposable-run.mjs` | `createGpexeDisposableDb` (`optimove_tests_gpexe_*`, legacy scaffold, 33 curated `migrations_v2` files, the marker table the pilot CLI demands), `applyGpexeTestMigrations`, `createGpexePilotOrg`, `GPEXE_TEST_MIGRATIONS`, `DISPOSABLE_DB_NAME_PATTERN` |
| `backend/tests/_gpexe-fixtures.mjs` | 12 files | `makeBundle` (a GPEXE session bundle), `defaultThresholds`, `standardAthletes`, `TZ` |
| `backend/tests/fixtures/gpexe-team-thresholds-1473.json` | 1 file | a real thresholds answer |
| `backend/scripts/verify-test-suite-isolation.mjs` | manual | the development-database snapshot check |
| frontend | — | none: every file carries its own doubles |

The GPEXE / source-connections suites share the disposable database and the bundle
fixtures only; each of the six `fakeSource` servers (`f3c2d`, `f3c2e`, `f3c2f`,
`gpexe-athlete-identity`, `gpexe-check-finalization`, `gpexe-import-credential-resolver`)
and the five `fakeGpexe` servers (`gpexe-in-app-import`, `gpexe-batch-approve`,
`gpexe-settings-change-guard`, `activity-roster-5a1`, `gpexe-auth-discovery`) is written
for its own phase and differs from the others.

### 1.4 Measured run (one file at a time, this workstation)

Every file was run once through the runner on 2026-10-11 (the discovery run; the shared
kind against the local `OPTIMOVE` development database, which is what `npm test` does
today, with the same before/after snapshot `verify-test-suite-isolation.mjs` takes).

| Kind | Files | Sum of file times | Outcome |
|---|---|---|---|
| frontend `unit` | 102 | about 38 s, plus the 5-minute limit spent on the one file that never exits (before the manifest named it) | 97 pass; 4 files fail (8 tests, all baseline — section 1.5); 1 file never exits |
| backend `unit` | 13 | 24 s | 12 pass; `production-static-serving` failed only because a unit file gets no `DATABASE_URL` and it spawns the real server — hence its kind override (9/0 under the disposable rules) |
| backend `disposable` | 42 | 715 s (about 12 min) | 38 pass; 4 files fail (1 test each, all baseline); no timeout, every process exited |
| backend `shared` | 44 | 190 s | 43 pass; 1 file fails (1 test, baseline); the development database snapshot (platform admins, `@test.local` users, users, athletes, clubs, teams, sessions, plans) was identical before and after |
| backend `schema-clone` | 1 | not run | needs `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` and `pg_dump` on `PATH`; neither is set on this workstation |

The slowest files, for planning: `gpexe-import-credential-resolver` 117 s,
`training-load-external-scheduling-routes` 48 s, `activity-roster-5a2` 35 s,
`gpexe-check-finalization` 34 s, `tests-module-schedule-management` 31 s,
`password-reset` 29 s, `gpexe-in-app-import` 28 s, `training-load-dashboard` 26 s,
`source-connections-f3c2e` 25 s, `tests-athlete-device-timezone` 23 s,
`pankov-program-migration` 23 s, `source-connections-f3c2d` 21 s, `training-activity`
20 s; frontend `builder-scroll-preservation` 13 s (jsdom), `builder-mobile-section-workflow`
4 s, `production-build` 2 s; every other frontend file is under 2 s. A disposable file
spends 5–10 s of its time creating its database and applying the 33 migrations.

### 1.5 Files whose process does not exit, and files that fail on `origin/main`

**The "process never exits" file is a test that never finishes.**
`frontend/tests/training-load.actions.test.mjs` has been recorded since 2026-09-18 as a
file whose process never exits. The runner's start events show what actually happens:
115 tests pass, then test **X5a** ("cross-section race, A resolves BEFORE B …") starts
and never settles its promise, so `node --test` waits forever; once X5a is cancelled,
its sibling **X5b** ("B resolves BEFORE A …") hangs the same way, and nothing after it
does. They are hanging tests, not a leaked handle: the frontend manifest gives the file a
per-test limit of 15 s (`fileOptions.testTimeoutMs`), node cancels each with
`testTimeoutFailure`, the remaining tests run, the process exits, and both are listed as
known failures (the file then reports 115 pass / 2 fail in about 30 s). The cause is not
established and is not touched by T1. No backend file left its process alive, no file
hit its time limit, and no file in either package leaks a handle after its tests
(the `knownNoExit` lists are empty).

**Failing on `origin/main` `241765e`** — every title below is in the package's
`test-manifest.json`, so the runner reports the file as `XFAIL` and will warn the day
one of them passes. The four already recorded in `docs/ai/CURRENT_STATE.md` are marked
"recorded"; the other four were found by this discovery and each was reproduced with
the standard `node --test <file>` command (with `backend/.env`, i.e. exactly what
`npm test` does) in the clean worktree on 2026-10-11:

| File | Test(s) | What is known |
|---|---|---|
| frontend `training-load.actions` | X5a and X5b (the two cross-section race tests) | new reading of a recorded hang: the tests never finish (see above); cancelled by the per-test limit |
| frontend `builder-create-form-fixes` | "handleContentInput mirrors every keystroke in the create form's name input into state.builder.createName, no network call" | new: a source-shape assertion on `app.js` (`state.builder.createName = createNameInput.value;`) that the Home / workspace-navigation merge (`46c4f82`, in PR #154) no longer satisfies |
| frontend `builder-mobile-section-workflow` | 16c (reorder arrows stay vertical) | recorded |
| frontend `organization-panel-cache` | 6 (signOut clears the view cache) | recorded |
| frontend `tests-schedule-management.actions` | the five calendar click / drag day-selection tests | recorded |
| backend `activity-roster-5a2` | 56 (v26 rollback digest) | recorded; CRLF line endings of the checked-out SQL are the unverified candidate cause |
| backend `tests-athlete-device-timezone` | 13 (the worker catches an ahead athlete's occurrence) | recorded; timing-dependent |
| backend `gpexe-check-finalization` | 1 (v33 on v32, the rollback returns the identical v32 catalog) | new: the catalog after the rollback differs from v32 by digest — the same class as test 56 above |
| backend `source-hosts-server3` | 12 (no credential, account address or token in any file of this change) | new: the secret scan refuses `docs/ai/CURRENT_STATE.md` because line 1486 carries one full 40-hex commit SHA (`884945c4…`), which the test treats as the shape of a REST token; the fix is to shorten that SHA in the next docs PR and remove the manifest entry. **Until then this guard is inert:** the test stops at its first failing file, so the files after `CURRENT_STATE.md` in its list (`.gitignore`, `_gpexe-disposable-db.mjs`, `source-connections-f3c1`, `source-credential-crypto`, `gpexe-f3c-auth-discovery.md`) and its final check that the legacy credential file stays git-ignored do not run, and the runner reports the file as known-fail. The next docs PR should shorten the SHA first. |
| backend `role-hint-decoupling-pr2a` (shared kind) | 7 (a platform_admin granted purely through `user_global_roles` sees an athlete they have no relationship with) | new: fails against the local development database; cause not established (possibly data-dependent); not part of `test:pr` |

`training-load-metrics-builder-edit-draft.test.mjs` is not a failure: it refuses to
start without `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` by design and is its own kind.

### 1.6 Leftover disposable databases on the local server

Before T1 ran anything, the local server already held **8** leftover databases named
`optimove_tests_gpexe_f3c2g_*` (about 15 MB each): earlier runs of
`gpexe-import-credential-resolver.test.mjs` whose `after()` never reached its drop. T1
does not drop them (they were not created in this session); `node
backend/tests/support/disposable-db-audit.mjs` lists them and `--drop` removes exactly the
names matching the disposable pattern, on an explicit decision. The runner now reports
what a disposable-kind step leaves behind (section 3.4), so this cannot grow unnoticed.

## 2. Duplicated setup patterns (counted on `241765e`)

Counted by extracting each helper's body and comparing them after whitespace
normalisation.

| Pattern | Copies | Distinct bodies | Where |
|---|---|---|---|
| backend `api(path, {method, body, cookie})` (JSON request against the in-process server) | 61 | 11 | one body in 34 files, a second in 12 |
| backend `cookieFor(token)` → `optimove_session=<token>` | 43 | 2 | 36 with a token, 7 (GPEXE) creating the session first |
| backend `dropTempDb({ name })` (terminate sessions, drop) | 18 | **1** (byte-identical) | the 18 self-made disposable files |
| backend `makeTempDb(label)` (admin on `postgres`, `create database`) | 18 | 18 (only the name prefix differs) | the same 18 files, plus the GPEXE helper's own copy |
| backend `refuseForbidden` / `dbUrlFor` / `ADMIN_URL` (name and URL guards) | 18 | 9 | the same 18 files |
| backend legacy scaffold SQL (`LEGACY_FIXTURE_SQL`, the tables the migrations assume) | 19 | 12 | 5 identical in the training-activity / training-load family; every other copy drifted with its suite |
| backend `getFreePort` / `waitForHealth` / `killChild` | 3 each | 1 each | `account-email-change`, `password-reset`, `production-static-serving` |
| backend raw fixture `INSERT`s: users 101 (73 files), clubs 67 (52), teams 59 (32), global roles 63 (52), club roles 53 (43), team roles 38 (29), athletes 66 (53), memberships 79 (31) | — | per file | the user / club / team / roles setup is the largest duplicated pattern, but as inline SQL with per-suite variations, not as a function |
| backend GPEXE rows: `gpexe_team_settings` 16 (8 files), `source_credential_connections` 22 (7), `source_team_bindings` 37 (6), `gpexe_import_checks` 25 (5), `gpexe_import_candidates` 6 (4), `gpexe_athlete_links` 3 (2) | — | per file | the connection / binding / settings and candidate / check / link setups are each written inline in a handful of files |
| frontend `installFetchMock` | 32 | 9 | 14 share one responder-style body, 5 a second, two groups of 4 a queue style |
| frontend `fakeAction(dataset)` | 34 | 12 | three shapes: `{dataset}`, `{dataset, value}`, `{dataset, disabled, closest}` |
| frontend `fakeElement()` | 16 | 6 | 9 identical |
| frontend `resetState()` | 35 | 27 | domain-specific state resets; not a shared pattern |
| frontend `mockFetchOnce` | 6 | 6 | the view-cache suites, each different |

## 3. The shared library: structure chosen, and why

The repository is two npm packages (`backend/`, `frontend/`) with a root `package.json`
that only delegates. A root `tests/support/` would be imported across package
boundaries and would sit outside both packages' `node_modules`; the existing helpers
(`backend/tests/_*.mjs`) show the convention is per package. T1 therefore uses:

```
scripts/test-runner.mjs                 the runner (root: it drives both packages)
scripts/test-runner-reporter.mjs        the node:test reporter it attaches to every file
scripts/test-runner.selftest.mjs        the runner's own check, `npm run test:runner`
backend/tests/support/disposable-db.mjs       create / drop / audit disposable databases
backend/tests/support/disposable-db-audit.mjs  the audit CLI (list, --json, --drop)
backend/tests/support/test-manifest.json       known failures, known no-exit, kind overrides
backend/tests/_gpexe-disposable-db.mjs        unchanged API, delegates create/drop to support
frontend/tests/support/fetch-mock.mjs         installFetchMock (responder or queue), restoreFetch
frontend/tests/support/dom.mjs                fakeAction, fakeElement
frontend/tests/support/test-manifest.json
```

Files under `tests/support/` do not end in `.test.mjs`, so neither the existing
`npm test` globs nor the runner treat them as suites. The helpers that already exist
stay where they are (`_test-cleanup.mjs`, `_gpexe-fixtures.mjs`); moving them is churn
without a behaviour change and belongs to a later step, if at all.

### 3.1 What T1 extracted (two patterns, as proof of the structure)

1. **Backend: the disposable database.** `backend/tests/support/disposable-db.mjs` holds
   the create / drop procedure the 18 private `makeTempDb` / `dropTempDb` pairs and the
   GPEXE helper carried: a loopback-only server rule, the `optimove_tests_<prefix>_<label>_<hex>`
   name rule, administration on `postgres` with a landing check, termination of other
   sessions before the drop, and an audit listing. Migrated as proof:
   `_gpexe-disposable-db.mjs` (its API, name pattern and marker table unchanged; it now
   delegates create and drop) and `exercises-upsert.test.mjs` (its private pair replaced).
   Both were run before and after the change through the runner with the same results
   (section 5).
2. **Frontend: the fake fetch and the action element.** `frontend/tests/support/fetch-mock.mjs`
   accepts both shapes in use (a responder function, or a queue of responses) and returns
   the recorded calls; `frontend/tests/support/dom.mjs` gives the union shape of the three
   `fakeAction` variants. Migrated as proof: `notifications-tests-module.test.mjs` and
   `tests-wellness-form.actions.test.mjs`, each with the same tests and the same results
   before and after (10/0 and 5/0).

Everything else in section 2 stays as it is in T1 and is listed in section 8 for T2.

### 3.2 The runner

`scripts/test-runner.mjs` runs each test file as its own `node` process (the file is
executed directly, with the runner's reporter attached), serially, with:

- two limits per file: node's own per-test limit (`--test-timeout`, 4 min for unit files
  and 14 min for the database kinds by default, or `fileOptions.testTimeoutMs` from the
  manifest) cancels a test that never finishes, reports it as a failure naming the test,
  and lets the file's remaining tests and its `after()` run, so a hung test does not skip
  the drop of a database; and a file limit (`--timeout-ms`; 5 min for unit, 15 min for
  the database kinds) as the backstop, on whose expiry the whole process tree is ended
  (`taskkill /T` on Windows, the process group elsewhere) and the file is reported
  `TIMEOUT` naming the test that was running. A test that never yields to the event
  loop (a synchronous infinite loop) cannot be named: its start event never leaves the
  process, so such a file is reported `TIMEOUT` before any test reported, or
  `NOEXIT` after the tests that did report;
- a verdict per file: `PASS`, `XFAIL` (only failures listed in the manifest), `FAIL`
  (naming the failing tests), `TIMEOUT`, `NOEXIT` (every test finished but the process
  stayed alive; ended by the runner, not ok unless the manifest lists the file),
  `CRASH` (the file could not even load), `XPASS` (a listed failure did not happen —
  a warning telling you to remove the entry), `SKIP` (a kind whose prerequisite is not
  set);
- one line per file and a short summary; the full output of every file is kept under
  `<tmp>/optimove-test-runner/<run id>/` (`--log-dir` to choose) and `--json` writes a
  machine-readable report;
- a fail-closed database rule: `DATABASE_URL` (the shell's, else `backend/.env`'s) must
  be a `postgres://` URL on a loopback host, must not mention `supabase`, `render.com`,
  `onrender`, `pooler` or `monitoring2`, and may carry no query parameter but `sslmode`
  and `application_name` (pg lets `host`, `port`, `user` and `password` in the query
  override the URL); otherwise the runner refuses (exit 2) before the step runs, and the
  message never contains the credential. Before the first database-kind file the audit
  (next point) connects through the support module, which also refuses a server that
  carries the administration role of a managed service (`supabase_admin`,
  `rds_superuser`, `azure_pg_admin`, `cloudsqladmin`) or that listens on a public
  address — so a loopback tunnel to such a server is caught at connection time, not
  only by the string check (a private-range address, as a CI service container has,
  is accepted);
- a kind-specific target: `unit` files get no `DATABASE_URL` at all; `disposable` files
  get the server's maintenance database `postgres` (so the configured development
  database is never opened by that step, whatever the file does); `shared` files run only
  with `--shared-db <name>` on that run's command line, equal to the database the URL
  names and starting with `optimove` (no environment variable is an opt-in);
  `schema-clone` runs only with `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL`;
- a scrubbed environment: no test process inherits `DATABASE_URL`, `EMAIL_PROVIDER`,
  `NODE_ENV`, any `GMAIL_*`, `BREVO_*`, `RESEND_*`, `GPEXE_*`, `SOURCE_CREDENTIAL_*`,
  `RENDER*`, `SUPABASE*`, `DOTENV_*` or libpq `PG*` variable, nor anything whose name ends
  in `_TOKEN`, `_SECRET`, `_API_KEY`, `_PASSWORD` or `_PRIVATE_KEY` (so a shell's
  `GITHUB_TOKEN` stays out too); `backend/.env` is not read by a test process:
  `DOTENV_CONFIG_PATH` points at an empty file in a private per-run directory, so
  `import "dotenv/config"` loads nothing — the runner is the only source of the database
  target. A file that needs a credential sets a fake one itself, as every current file
  already does. This is a denylist by name; a new credential variable with a name
  outside these patterns would be inherited (T2 item: an allowlist or a contract test
  over `backend/src`'s `process.env` reads);
- a cleanup audit around every `disposable` and `schema-clone` step: every database on
  the server (except the templates and `postgres`) and the number of user objects
  inside `postgres` are listed before and after; a database that appeared during the
  step and is still there fails the step (named as droppable when it matches the strict
  disposable pattern, otherwise as a manual decision), a change inside `postgres` fails
  it (a file wrote into its target instead of its own database), and an audit that
  cannot run fails the step before any file (fail closed). A run in another checkout at
  the same time shows in the diff as well — the message says so.

Known limits: files run serially (no `--concurrency`; the shared-kind files could not
run in parallel anyway, and the frontend takes under a minute); the static
classification reads imports and spawn arguments, so a file that reaches a database in
a way the scan cannot see is caught only by the run itself (a `unit` file sees no
`DATABASE_URL` and fails loudly; a `disposable` file that needs the development schema
fails on the maintenance database) — the manifest's `kindOverrides` fixes a wrong
verdict explicitly; there is no network egress guard — "no real external service" holds
because no credential reaches a test process, not because the network is closed (two
existing files, `account-email-change` and `password-reset`, already send to the real
Gmail / Brevo hosts with fake keys and get refused; a T2 item is a `--import` guard that
refuses non-loopback connections unless the manifest allows them for a file); the
existing `npm --prefix backend test` and `npm --prefix frontend test` are unchanged and
bypass every rule above (they read `backend/.env` directly, as they always did).

### 3.3 The commands (root `package.json`)

| Command | Runs | Database |
|---|---|---|
| `npm run test:runner` | the runner's own self-test (a throwaway project with one file per verdict, the grandchild check, the refusals) | none |
| `npm run test:frontend:fast` | every frontend file | none |
| `npm run test:backend:fast` | the 12 backend `unit` files | none |
| `npm run test:backend:db` | the 44 backend `disposable` files (the 42 found, `production-static-serving` by its override, and the support self-test) | local server, maintenance database as target, each file's own `optimove_tests_*` databases |
| `npm run test:gpexe` | the GPEXE / source-connections family (`gpexe-*`, `source-*`): its `unit` files then its `disposable` files | as above |
| `npm run test:pr` | the self-test, then frontend, backend `unit`, backend `disposable` — everything safe by construction | as above; **never** the development database |
| `npm run test:backend:shared -- --shared-db OPTIMOVE` | the 44 `shared` files against the named local development database | the development database, named explicitly on every run (a write to the persistent development database, which `.claude/rules/database-safety.md` makes a per-session decision — the flag is the technical gate, not the decision) |
| `npm run test:list` | the classification of every file, no run | none |

The existing `npm --prefix backend test` and `npm --prefix frontend test` are unchanged.
`test:pr` deliberately leaves the shared kind out: those files need the legacy schema
that only the development database has (there is no bootstrap for it yet — T2, section
8), and writing to a persistent database is never part of a default command. A change
to auth, organization, builder, the Tests module or non-GPEXE Training Load therefore
still needs `test:backend:shared` on a local development database before a PR, as today's
`npm test` does.

### 3.4 The manifest (`tests/support/test-manifest.json` in each package)

- `knownFailures`: `{ file, test, since, note }` — the exact title of a test that fails
  on `origin/main` today. The runner reports a file whose only failures are listed as
  `XFAIL` (ok) and warns with `XPASS` when a listed test passes, so the list cannot rot
  silently. A fix must remove the entry in the same PR.
- `fileOptions`: `{ "<file>": { testTimeoutMs, note } }` — node's per-test limit for one
  file, used today only for the file with the hanging tests X5a and X5b (15 s instead of
  the 4-minute default, so the file costs about 30 s, not minutes).
- `knownNoExit`: `{ file, idleMs, note }` — a file whose process stays alive after its
  tests; the runner ends it after `idleMs` of silence with no test running and reports
  `PASS*`. Any other file is given its whole time limit (ending early could cut an
  `after()` that drops a database) and reported `NOEXIT`. Both lists are empty today.
- `kindOverrides`: `{ "<file>": "<kind>" }` when the static classification is wrong
  (today: `production-static-serving.test.mjs` → `disposable`, with the reason in
  `kindOverrideNotes`).

## 4. Target architecture and the unit / integration / end-to-end split

| Level | What it proves | Where it lives | Database | Runs in |
|---|---|---|---|---|
| **unit** | one module's logic: mappers, adapters against a fake source, crypto, rendering of a state into HTML, action handlers against a fake fetch and a minimal DOM | `backend/tests/*.test.mjs` (`unit` kind), every `frontend/tests/*.test.mjs` | none | `test:backend:fast`, `test:frontend:fast`, `test:pr`, T2 CI |
| **integration** | a route group against the real Express app, the real SQL, the real migrations and triggers, on a database nobody else uses | `backend/tests/*.test.mjs` (`disposable` kind) | a disposable database per file (scaffold + `migrations_v2`) | `test:backend:db`, `test:gpexe`, `test:pr`, T2 CI (Postgres service) |
| **integration on the legacy schema** | the same, for modules whose tables come from the pre-`migrations_v2` schema | `backend/tests/*.test.mjs` (`shared` kind) | the local development database, named explicitly | `test:backend:shared` locally; T2 CI once a schema bootstrap exists |
| **end-to-end** | a coach or administrator flow in a real browser against a real server and a disposable database, with a fake GPEXE source | none yet — T3 (Playwright) | disposable | T3 |

The direction for a new backend test: a `disposable` file whenever the tables it needs
are created by the scaffold plus `migrations_v2` (every Training Load, Training Activity,
GPEXE, source-connection and roster table), a `shared` file only when it needs legacy
tables the scaffold does not have (and then with `_test-cleanup.mjs`). The shared kind
shrinks as the scaffold grows (T2).

## 5. Verification of T1

All on 2026-10-11, this workstation, worktree at `241765e` plus the T1 changes.

| What | Command | Result |
|---|---|---|
| the runner itself | `npm run test:runner` | 30 of 30 checks: one throwaway file per verdict (pass, fail, known-fail incl. a nested describe, did-not-exit, a stuck test with a grandchild, crash at import, unexpected pass — also title by title inside a file with another listed failure —, known did-not-exit ended after its idle period, a slow `after()` never cut, a hung test cancelled by the per-test limit with the file running on, a file that prints a 4 MiB burst and fails as its last act still reported with its summary), the grandchild process gone afterwards, a kept log per file, a project without a manifest, no `DATABASE_URL` / `GPEXE_API_TOKEN` / `SOURCE_CREDENTIAL_KEYS` / `GITHUB_TOKEN` / `*_API_KEY` visible to a unit file, a `.env` in the test's cwd not loaded, no canary credential in the output / report / logs, the runner's rules equal to the support module's, and the refusals (a remote host, a Supabase pooler, `monitoring2`, a libpq `host=` / `port=` / `user=` override, a shared step without `--shared-db`, naming the wrong database, naming a non-OptiMove database, an ambient variable as opt-in) — each refused with exit 2 before any file ran and without the credential in the message |
| frontend support | `support-helpers.test.mjs` through the runner | 9/0 |
| backend support | `support-disposable-db.test.mjs` (disposable kind, and under plain `node --test`) | 5/0: name and server rules (incl. the query-parameter rule), create → landing check → the audit lists it as droppable with its open session → drop ends that session → gone, the object count in `postgres` unchanged; the server-address table (loopback, private, link-local, Unix socket local; public and CGNAT remote); `--drop` refusals |
| migrated frontend files, before → after | `notifications-tests-module.test.mjs`, `tests-wellness-form.actions.test.mjs` | 10/0 → 10/0 and 5/0 → 5/0, the same tests |
| migrated backend file, before → after | `exercises-upsert.test.mjs` | 6/0 → 6/0 |
| every consumer of `_gpexe-disposable-db.mjs`, before → after | the 15 `disposable` files of the GPEXE / source-connections family, then `activity-roster-5a1`, `activity-roster-5a2` and `pool-checkout-timeout`, through the runner | identical per-file counts (the family: 367 passed; the two baseline failures `gpexe-check-finalization` 1 and `source-hosts-server3` 12, one test each, before and after; the three others: see the row below); cleanup audit: no database left behind |
| the three consumers outside the `gpexe` group, before → after | `activity-roster-5a1`, `activity-roster-5a2`, `pool-checkout-timeout` | 36/0 → 36/0, 72/1 → 72/1 (test 56, known), 12/0 → 12/0; cleanup audit: no database left behind, nothing written into `postgres` |
| the new support test under the existing command | `cd backend && node --test tests/support-disposable-db.test.mjs` with no `DATABASE_URL` in the shell (the file loads `backend/.env` like every other database test) | 4/0 — the legacy `npm --prefix backend test` gains no failing file |
| the audit CLI | `node tests/support/disposable-db-audit.mjs` (from `backend/`) and `--drop` without `--yes` | lists 11 databases (3 kept: `OPTIMOVE`, `monitoring2`, `monitoring_app`; the 8 leftover `optimove_tests_gpexe_f3c2g_*` as droppable) and 30 user objects in `postgres`; `--drop` alone is refused. The 30 objects were attributed read-only: all are `pgagent.*` tables, indexes and sequences of the pgAgent extension (pgAdmin's job scheduler), none a test scaffold — no test file ever wrote into `postgres` |
| the six disposable files that create databases under their own names | `builder-copy-performance`, `migration-runner-v2`, `pankov-program-migration`, `weekly-plan-empty-structures`, `weekly-plan-hierarchy-order`, `weekly-plan-submit-empty-guard` through the runner with the full-server audit | 4/0, 14/0, 8/0, 7/0, 10/0, 5/0; "no database was left behind by this step" and "nothing was written into the maintenance database" — the audit now sees their `optimove_<module>_*` names too (it would report one left behind as a manual decision, since only the strict `optimove_tests_*` pattern is droppable) |
| representative set | frontend `gpexe-import.actions` 68/0; backend unit `gpexe-client` 19/0, `gpexe-rest-v1-adapter` 20/0; backend disposable `gpexe-undo-session` 8/0, `source-connections-f3c1` 19/0; `production-static-serving` under its override 9/0 | all pass |
| the hanging file under its manifest entries | `training-load.actions.test.mjs` | known-fail: 115 pass, X5a and X5b cancelled after 15 s each, the process exits (about 30 s instead of forever) |
| the whole repository, once | the discovery run of section 1.4 (every file, every kind) | the measured map; the shared kind left the development database identical by snapshot |
| static checks | `node --check` on every changed file; `git diff --check` | clean |

Not run after the scope was narrowed: a second full `test:pr`, `test:gpexe` or
`test:backend:shared`; the discovery run is the one full pass. `test:backend:fast` and
`test:frontend:fast` were run once each through their npm commands (12/12 files and
103 files respectively) before the hanging file's manifest entry was corrected.

## 6. Rules for adding a test

1. **Pick the level first** (section 4), then the kind: a backend file is `unit` when it
   needs no database, `disposable` when the scaffold and `migrations_v2` give it its
   tables, `shared` only for legacy tables. Run `npm run test:list` and check the kind
   the runner assigns; if it is wrong, say why in `kindOverrides`.
2. **Use the support modules** instead of a new private copy: `createDisposableDatabase`
   for a database, `installFetchMock` / `fakeAction` / `fakeElement` in the frontend. A
   new helper that two files need goes to `tests/support/` of that package with its own
   `support-*.test.mjs`; a helper one file needs stays in that file.
3. **One file is one process**: it creates what it needs in `before()`, drops it in
   `after()` (through `runCleanupSteps` when there are several steps), ends every server,
   pool and client it opened, and clears every timer. A file that leaves the process
   alive is a defect, not a manifest entry; `knownNoExit` is for baseline files only.
4. **Never a persistent database, a credential, or a real external service.** A file
   gets its database target from the runner; a credential it needs is a fake value it
   sets itself; a source it talks to is a fake `fetch` or an in-process `http.createServer`.
5. **Titles are stable sentences** (they are what the manifest and the summary show), one
   behaviour per test, numbered where the file is long.
6. **Failures are explicit**: a test that cannot run without an operator-provided
   prerequisite (today only `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL`) refuses with a clear
   message and is its own kind; it never silently passes.
7. **A fix of a baseline failure removes its manifest entry in the same PR**; a new
   baseline failure is never added to the manifest without the reproduction on clean
   `origin/main` that `.claude/rules/testing-evidence.md` requires.

### 6.1 New test, or extend an existing one?

Extend an existing file when the behaviour belongs to the same route group or module
and the file's `before()` already builds the fixtures it needs — a new test in it costs
one `test()` and nothing else. Start a new file when any of these holds: a different
kind (a `unit` test never goes into a `disposable` file and the reverse); a different
fixture world (a new org shape, a new source server); the existing file is already the
slowest of its kind or past about 1 500 lines; the behaviour is a cross-module flow that
no single existing file owns. Two files for the same module are fine when each has one
clear subject (rendering against actions, a phase against its hardening); two files that
set up the same world to assert overlapping things are consolidation candidates (section
8.3), not a reason to add a third.

## 7. T2 — GitHub Actions (plan only; no workflow in T1)

Goal: every pull request runs `npm run test:pr` on a clean runner, with the manifest as
the baseline, so a new failure is visible before review.

- **Workflow** `.github/workflows/tests.yml`, on `pull_request` and `push` to `main`;
  one job `pr-tests` on `ubuntu-latest`, Node 24 (`actions/setup-node` with npm cache),
  a `postgres:17` service with `POSTGRES_PASSWORD` from a job-level value (not a
  repository secret: it is a throwaway service), health-checked before the job starts.
- **Steps**: `npm --prefix backend ci`, `npm --prefix frontend ci --include=dev`,
  `npm --prefix frontend run build` (`production-static-serving` and
  `production-build.test.mjs` need `frontend/dist`), then
  `npm run test:pr` with `DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/postgres`.
  The runner's rules already fit: a loopback host, the maintenance database as the
  disposable target, no secret in the environment.
- **What runs there**: the self-test, every frontend file, the 12 backend `unit` files
  and the 44 `disposable` files (about 13 minutes on this workstation;
  Linux CI is usually faster). The 44 `shared` files cannot run in CI until a bootstrap
  of the legacy schema exists on a fresh server — that is the first T2 engineering task:
  either a checked-in schema dump of the development database (`pg_dump --schema-only`,
  reviewed, no data) applied before `migrations_v2`, or the extension of the scaffold
  until those files can become `disposable`. Until then CI covers what `test:pr` covers
  and the shared kind stays a local pre-PR step, stated in the PR template.
- **Artifacts**: the runner's log directory (`--log-dir`) and `--json` report uploaded
  on failure (`actions/upload-artifact`, 7 days).
- **Policy**: a red check blocks merge only once the first week of runs shows it stable;
  `XPASS` warnings are read at review time; the time limit per file stays the runner's
  default; no secret of any environment is ever added to the workflow — a test that
  would need one is wrong.
- **Not in T2**: Playwright, the shared kind, Render, any deploy step.

## 8. What T1 leaves for T2 and T3

### 8.1 T2 (test-infrastructure, after the CI workflow)

1. The legacy-schema bootstrap (section 7) and the migration of the 44 `shared` files to
   `disposable`, family by family, starting with the Training Load files that already
   carry their own scaffold copy.
2. The remaining 17 private `makeTempDb` / `dropTempDb` pairs onto
   `createDisposableDatabase`, and one canonical legacy scaffold instead of 12 variants
   (the 5-file identical copy of the training-activity family is the candidate base).
3. `backend/tests/support/http.mjs`: the `api()` / `cookieFor()` pair (61 and 43 copies)
   and `getFreePort` / `waitForHealth` / `killChild` (3 identical copies).
4. `backend/tests/support/org.mjs`: user / club / team / roles / athlete / membership
   fixtures (the inline `INSERT`s in 73 files), designed from the two dominant shapes.
5. `backend/tests/support/gpexe.mjs`: connection / binding / settings rows and a
   candidate / check / link set, plus one fake source server with per-phase answer
   tables instead of six; `_gpexe-fixtures.mjs` moves there unchanged.
6. The remaining 30 frontend `installFetchMock` and 32 `fakeAction` copies onto the
   support modules (mechanical; one PR per family), and a shared minimal `document`
   factory for the 61 stub files.
7. The baseline failures (section 1.5): fix or retire each one, removing its manifest
   entry; establish why tests X5a and X5b of `training-load.actions.test.mjs` never settle.
8. Bound the `after()` cleanup of `gpexe-import-credential-resolver.test.mjs` (the 8
   leftover databases) and decide what to do with those 8.
9. The six disposable files that create databases under their own names
   (`builder-copy-performance` → `optimove_builder_copy_perf_test_*`,
   `migration-runner-v2` → `optimove_migration_runner_test_*`, `pankov-program-migration`
   → `optimove_pankov_migration_*`, `weekly-plan-empty-structures`,
   `weekly-plan-hierarchy-order`, `weekly-plan-submit-empty-guard` →
   `optimove_weekly_*`) onto `createDisposableDatabase`, so the audit can drop what they
   leave behind (today it reports those names for a manual decision), and
   `exercises-upsert`'s `after()` onto `runCleanupSteps` (a failed `before()` skips its
   drop; the audit now shows that, the file does not fix it).
10. A network egress guard for every test process (section 3.2, known limits), an
    allowlist or contract test for the environment scrub, and a static refusal of a
    `unit` or `disposable` file that reads `.env` itself
    (`multi-athlete-program-migration.test.mjs` does, as a `shared` file).

### 8.2 T3 — Playwright (plan only; nothing installed in T1)

- **Scope**: the flows unit tests cannot prove — sign-in and workspace switch; the coach's
  Imports screen read-only (find sessions against a fake GPEXE, Link athletes, the review,
  nothing approved); the administrator's Source connections screen (Connect / Test / Bind
  / Unbind against the fake source); roster decisions on a team session; one Builder
  flow on a phone width. Each at 1280 px and at 360 / 375 / 390 px.
- **Harness**: `e2e/` at the root with its own `package.json` (Playwright is never a
  dependency of `backend/` or `frontend/`); a disposable database per run through
  `backend/tests/support/disposable-db.mjs` (scaffold + `migrations_v2`, until the T2
  bootstrap covers the legacy tables the sign-in needs — the first T3 task is to measure
  that gap); the real server started by the harness on a free port with `DATABASE_URL`
  of that database and a fake GPEXE `http.createServer` as the approved host (an
  `e2e`-only catalog row, never a change to `sourceHosts.js`); seeded users with
  throwaway credentials written by the harness, never a real account.
- **Runner integration**: a fifth kind `e2e` in the runner (same time limit, same tree
  kill, same log directory), `npm run test:e2e`, and a separate CI job that runs only on
  `main` and on a label until it is stable.
- **Rules**: no real GPEXE, no Render, no production data, no screenshot of a real
  person; a flow asserts on text and state, not on pixels.

### 8.3 Candidates for later consolidation (not removed in T1)

Files that set up the same world and assert overlapping behaviours. Each is kept in T1;
consolidation is a T2 decision per pair, with the union of their assertions preserved:

- frontend `training-load-dashboards.actions`, `-dashboards-ux.actions`,
  `-dashboards-editor.actions`, `-dashboards-h4.actions` (four files on the same module,
  one per UX slice);
- frontend `builder-day-copy-paste` and `builder-day-copy-paste-actions`;
  `notifications-tests-module` and `notifications-training-load` (the same harness);
  `mobile-messages.avatars` / `.render` / `.search`;
- backend `training-load-external-scheduling` and `-external-scheduling-routes`;
  `gpexe-undo-guards` and `gpexe-undo-session`; `global-roles`,
  `global-role-management-pr2b`, `scoped-role-management` and `role-authorization`;
  `training-load-builder-edit-draft` and `training-load-metrics-builder-edit-draft` (the
  latter is the schema-clone file).

No regression test was deleted or weakened in T1.
