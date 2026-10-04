# F3c2g — importer credential resolver and the controlled transition from `GPEXE_API_TOKEN` (discovery)

Written before the code, 2026-10-04 (owner order of the same day), from the checked-out
`origin/main` at the merge of PR #136. Sources read: `docs/ai/source-connections-f3c2-contract.md`
(sections 2.1–2.7, the test plan row 10), `docs/ai/gpexe-f3c-auth-discovery.md` (decisions D5, D8,
the F3c2 / F3c4 rows), `docs/ai/gpexe-rest-v1-compatibility.md`, `docs/ai/CURRENT_STATE.md`, the
F3c2c adapter (`backend/src/gpexeRestV1Adapter.js`, `backend/src/sourceAdapters.js`), the F3c2d /
F3c2e / F3c2f service (`backend/src/sourceConnectionService.js`), the importer
(`backend/src/gpexeImportService.js`, `backend/src/gpexeClient.js`, `backend/src/gpexeImportMapper.js`,
`backend/src/gpexeImportPreview.js`, `backend/src/gpexeImportWriter.js`,
`backend/src/routes/gpexeImport.js`) and migrations v22, v24, v27, v29, v30.

## 1. Every importer entry point and what it touches

| Entry point | Network | Where the credential is today |
|---|---|---|
| `POST /api/training-load/gpexe/teams/:teamId/checks` → `startCheck()` → background `runCheck()` | **the only one**: `listTeamSessions` (one paged list) and `fetchSessionBundle` per parent session | `createGpexeClient()` (`clientFactory`) reads `process.env.GPEXE_API_TOKEN` once, at `startCheck`, before any lock; the token lives in the client closure for the whole background run and goes only into the `Authorization: Token` header of the fixed host `https://e03.gpexe.com/api/` |
| `GET …/checks/:checkId`, `GET …/status`, `GET …/candidates`, `GET …/candidates/:id` | none | — |
| `POST …/candidates/:id/approve`, `POST …/imports` (`approveCandidate`, `approveCandidates`) | none — the import writes from the stored `raw_bundle` of the candidate | — |
| `GET …/source-athletes`, athlete links, approvers, `PUT …/settings`, retention | none | — |
| `backend/scripts/gpexe-api-probe.mjs`, `backend/scripts/gpexe-auth-discovery.mjs` | owner-run read-only tools, not the importer | the owner's shell only |

So the cut-over concerns exactly one code path: the check run. Approve and preview never talk to
the source; they read the candidate's stored snapshot.

### How the check chooses host, API family, Team ID and token today

- Host and family: fixed in `gpexeClient.js` (`GPEXE_API_BASE = https://e03.gpexe.com/api/`, the
  `api` family); no catalog, no profile.
- Team ID: `gpexe_team_settings.gpexe_team_id` of the OptiMove team, read a first time unlocked
  (to fail early) and again inside the short transaction that takes the team import lock
  (`lockTeamForImport`, the v24 lock key), then written on the check row (`gpexe_import_checks.gpexe_team_id`,
  final from creation by the v24 trigger). The lock is released before the first request.
- Token: `process.env.GPEXE_API_TOKEN`, via `clientFactory` (`setGpexeClientFactory` is the test
  seam). `token_missing` → `503 gpexe_token_missing` before the check row is written.
- The token is referenced by the client closure until the run ends; nothing clears it (strings
  cannot be zeroed in JavaScript; what is guaranteed is that no reference survives the run, since
  the client object is local to the job).

### Functions that still depend on the environment token directly

`createGpexeClient()` (`gpexeClient.js`) is the only reader; `startCheck()` is its only caller in
the application. No other service, route or script of the application reads the variable.

## 2. From an active binding to a closed importer context

What the schema already guarantees (v27, v29, v30):

- at most one **active** binding per (team, source) (`source_team_bindings_one_active_per_team_source`)
  and one active OptiMove team per source team (`…_one_active_per_source_team`);
- an active binding's team lies inside the connection's owning club (insert trigger
  `source_team_bindings_check_owner`), and the team cannot move to another club while bound;
- an active gpexe binding names exactly the approved pair of `gpexe_team_settings` (v30 trigger
  `source_team_bindings_check_pair` on INSERT, `gpexe_team_settings_bound_team_final` against a
  later change of the approved Team ID or team);
- every connection state but `not_connected` holds a credential (v29); `verified` holds
  `last_verified_at`; `needs_reconnect` holds `last_error_code`;
- the host of a connection is a catalog key whose row may be `approved` or `retired`; the code
  allowlist `backend/src/sourceHosts.js` holds the profile (`baseUrl`, `apiFamily`, exchange);
  `resolveApprovedSourceHost()` answers `host_not_allowed` unless both agree.

The translation the resolver performs, for exactly one OptiMove team and one source system:

1. the team row (exists, active, its `club_id`);
2. the one active binding of the team for the source (`team_id`, `source_system`, `state = 'active'`)
   — zero → **no new binding**; two → `binding_ambiguous` (fail-closed even though the index makes it
   impossible);
3. the approved pair: `gpexe_team_settings.gpexe_team_id` of the team, canonical, equal to the
   binding's `source_team_id` — missing → `team_setting_missing`; different → `team_setting_mismatch`;
4. the connection row by the binding's `connection_id`: `owner_scope = 'club'`,
   `owner_club_id = team.club_id`, the club active — otherwise `connection_foreign_club`;
   `source_system` equal to the binding's; state `verified` — otherwise `connection_not_usable`
   (with the state as a fact; `needs_reconnect`, `source_unavailable`, `linked_untested` and
   `not_connected` are all unusable for an import read: the import never performs a Test);
5. the host: catalog row `approved` and resolvable in code (`resolveApprovedSourceHost`) —
   otherwise `host_not_allowed`; the adapter family of the host must exist
   (`createSourceAdapter` → `adapter_not_available` otherwise);
6. only after COMMIT of the short lock transaction, right before the first request: the key ring
   (`key_missing`), the decrypt with the row's own AAD context (`credential_unreadable`), the adapter
   created by `createSourceAdapter({ sourceSystem, hostKey, catalogRow, credential, boundSourceTeamId })`
   — bound to the binding's source team id, GET only, no URL from the caller — and the plaintext
   reference dropped (`token = null`) in `finally`. The adapter closure is the only holder of the
   plaintext for the length of the run, exactly as the legacy client closure is today.

What the resolver returns to the importer: `{ path: "source_connection", connectionId, bindingId,
hostKey, apiFamily, sourceTeamId, adapter }` or `{ path: "legacy_env" }`. It never returns a token,
a username, a password, a URL or a catalog row to a route, a log, an error or audit metadata. It
takes no URL, host, source team id or credential from the caller: only `teamId` and `sourceSystem`.

### When the facts change during an import

The run holds no database transaction and no team lock while it reads the source (the existing
F1 design: a check and a Settings change exclude each other only in the short lock transaction
that writes the check row). The resolver therefore re-validates the same facts (binding still
active and the same row, connection the same and `verified`, club the same and active, host still
approved, approved pair unchanged) with one indexed query **before the session list and before
every session bundle**, and the run stops with the precise code when anything moved:

| Change during the run | What happens |
|---|---|
| the binding is ended (Unbind) | `binding_ended`: the run stops before its next request (the facts are checked before AND after every list — empty or not — and every bundle, so a list or bundle read across the end is dropped before anything of it is recorded); nothing already recorded is undone |
| the team moves to another club, or the team or its club is archived | `team_club_changed` / `team_not_available`: both paths pin the club the run started in (a bound team cannot move at all — the v27 move guard; a legacy team can, and its run stops); the team gate answers first, so an archived club of a bound team is `team_not_available` (the connection's club differing from the team's is unreachable for an active binding) |
| the binding ended and a new one (same team, maybe another source team or connection) was created | still `binding_ended` for the running check (it is tied to its binding id); the next check resolves the new binding |
| the connection moved to `needs_reconnect` / `source_unavailable` (an admin's Test or the auto-invalidation below) | `connection_not_usable` |
| the host was retired in the catalog | `host_not_allowed` |
| the approved Team ID changed | cannot happen while bound (v30); checked anyway → `team_setting_mismatch` |
| the source answers 401 to a read | `source_auth_rejected`: the connection becomes `needs_reconnect` with one `auto_invalidate` audit row (basis `system`, no user — the one actor the v27 CHECK allows for that action; conditional on the fingerprint of the credential the run held, written after the check's own outcome, bounded), the check fails, **no fallback** |
| the source answers 403 to a read | `source_access_refused`: the check fails with that code and the connection keeps its state (one resource the credential may not read is not a refused credential — the F3c2e bind rule), **no fallback** |
| the source is unavailable or answers unexpectedly | `source_unavailable` / `source_answer_unexpected`: the check fails, no fallback, nothing recorded for that session |

Serialization with the other writers (all through the same v24 team lock key
`gpexe-import-team:<team>`): `startCheck` waits for the lock at most `SETTINGS_LOCK_TIMEOUT_MS`
(then `409 gpexe_change_busy`); a Test / Reconnect / bind holds that team's try-lock for its whole
attempt, an Unbind for its write, a Settings change for its write — so a check cannot resolve while
any of them runs, and none of them can start while the check's short transaction is open. After
COMMIT the check holds no transaction or lock across a network call (the preview dry-run of each
recorded session takes the team lock briefly, as F1 always did, with no network inside it); the
re-validation window is one bundle, and the run's identity carries a fingerprint of the stored
credential, so a Reconnect mid-run stops the run instead of letting a stale 401 invalidate the
fresh credential (round-2 hardening, contract 2.8).

## 3. The transition rule (D8 made strict, owner order 2026-10-04)

- A team with an **active new binding** reads **only** through that binding's connection. The
  legacy client factory is not called, the environment variable is not read, whatever happens
  later (a refused credential, a lost answer, an unusable connection): the check fails with a
  stable code. Never a fallback inside one check.
- A team with a binding that is **not usable** gets `409 source_connection_unavailable` (or `503`
  for `key_missing`) with the precise code as `reason` at `startCheck` — no check row, the reason
  for an administrator of the platform or of the team's club only — for everything the locked
  facts and the key-ring preflight can tell (`binding_ambiguous`, `team_setting_*`,
  `connection_foreign_club`, `connection_not_usable`, `host_not_allowed`, `key_missing`), or the
  precise code on the check row for what is only found after COMMIT (`credential_unreadable` and
  `adapter_not_available` from the one decrypt and adapter creation right before the first
  request, zero requests sent) or mid-run. No fallback.
- A team **without** a new binding — and that **never had one** for the source — keeps the legacy
  path, explicitly labelled `legacy_env`: the
  existing `clientFactory` / `GPEXE_API_TOKEN` / `e03` client, unchanged (`503 gpexe_token_missing`
  when the variable is absent, as today). This is temporary (D8: until F3c4), and the variable is
  neither removed from the configuration nor touched on Render in this step.
- The two paths are decided once per check, under the team lock, and never mixed: the decision is
  made in the same short transaction that writes the check row, after an unlocked pre-read; a
  pre-read and a locked read that disagree answer `409 gpexe_change_busy` (retry), so a binding
  created or ended in between never produces a check that half-used either path.

The contract (D8 and test-plan row 10) determines the fallback precisely enough to implement; one
part of D8 — "the audit says which" — cannot be met without a schema change (section 5), so it is
recorded as an open decision rather than silently approximated.

## 4. Where the resolver enters the importer, and why not the whole cut-over

The resolver is wired into `startCheck()` / `runCheck()` directly, behind the existing
`clientFactory` seam, because a resolver nothing calls proves nothing and the production effect of
wiring it is nil today: no connection row, binding or credential exists on the deployed database,
so every team takes the `legacy_env` path exactly as before (and production has no
`GPEXE_API_TOKEN` either, so a check there still answers `gpexe_token_missing`). The "cut-over" in
the sense of removing the environment token stays F3c4. `GPEXE_IMPORT_APPLY_ENABLED` is untouched.

Through the binding path the importer receives the adapter's bundle in the e03 bundle shape plus
`drillsStatus` and `drillLabels`:

- `drillsStatus.complete === false` → the run stops with `drill_set_incomplete` **before** the
  session is recorded (the mapper tolerates a missing drill entry by skipping its metrics, which
  would have made an incomplete set look complete); nothing of that session is written;
- an empty, successfully read `players` is a valid empty drill (adapter rule, owner 2026-10-03):
  the session is recorded with `details.drills[i].players = {}`;
- `drillsStatus` and `drillLabels` are stripped before the candidate is stored, so the stored
  snapshot keeps the F1 contract and its hash semantics; the storage of drill labels stays the
  open decision it was (F3c2c as-built);
- the adapter sends GET only, every URL from `sourceApiUrl()` on the approved row, bound to the
  binding's source team id; a row of another team ends the operation.

## 5. Open decisions for the owner (none blocks this step)

- **Q1 — the durable record of which path a check used — DECIDED (owner, 2026-10-04, round 4):**
  migration v31 adds `source_path` (`legacy_env` / `source_connection`), `source_connection_id`,
  `source_binding_id`, `source_team_id` and `source_host_key` to `gpexe_import_checks`, written in
  the same locked INSERT that starts the check and final from creation (a BEFORE UPDATE trigger);
  a BEFORE INSERT trigger makes the database refuse a connection-path row the data does not
  support; rows from before v31 are `legacy_env` by the column default (the resolver did not exist,
  the environment token was the only path) — documented backfill, no rewrite. The audit table is
  untouched (its `system` basis stays reserved for `auto_invalidate`). Rollback:
  `docs/runbooks/gpexe-import-checks-v31-rollback.sql`, forward-safe. **Round 5 (owner's external
  review of `d7657c8`):** the same BEFORE INSERT trigger refuses a `legacy_env` row for a team that
  has or had a gpexe binding — it takes the team's import try-lock first, then looks for any
  `source_team_bindings` row of the team, active or ended — with SQLSTATE `23514` and the constraint
  name `gpexe_import_checks_legacy_path_never_bound` (the application maps it to `409
  gpexe_change_busy`, "try again" — it can only meet it when its own locked decision and the
  database disagree, and the next attempt resolves the real path; a backstop no route test can
  reach). A team that never had a binding writes `legacy_env`; rows
  written before a team's first binding stay as history. **Decision for F3c4 (owner, 2026-10-04):**
  the migration that retires the environment path drops the `DEFAULT 'legacy_env'`; from then on new
  code writes no legacy check, and the historical legacy rows are not rewritten.
- **Q2 — which states are usable for an import read — KEPT (owner, round 4):** `verified` only; an
  import never promotes a state. A connection that a failed Test moved to `source_unavailable`
  needs a successful Test (an administrator's action) before the next check.
- **Q3 — the legacy path after an Unbind — DECIDED (owner, round 4): no downgrade.** The legacy
  path is open only to a team that never had a binding for the source; a team whose binding ended
  answers `source_connection_unavailable` / `binding_ended` until it is bound again and never reads
  `GPEXE_API_TOKEN` again, whatever the environment holds.

## 5a. Round-4 rules (owner's external review of the first PR head, 2026-10-04)

- The facts are re-validated **after** every source operation as well as before it — a list,
  empty or not, and a bundle — on both paths; a list or bundle read across a change is dropped
  before anything of it is recorded.
- Both paths pin the club the run started in: the team must still be active, in that club, and the
  club active, before and after every operation (`team_club_changed`, `team_not_available`). A bound
  team cannot move (the v27 move guard, proven by a refused raw UPDATE in the tests); a legacy team
  can, and its run stops.
- The legacy path is open only to a team that never had a binding for the source (section 5, Q3).

## 5b. Round-5 rules (owner's external review of `d7657c8`, 2026-10-04)

- The database itself refuses the legacy path to a team with any gpexe binding, active or ended
  (the v31 trigger, under the team's import try-lock; `23514`,
  `gpexe_import_checks_legacy_path_never_bound`), whoever writes the row. Serialized with a bind by
  the one team lock in both orders: a legacy INSERT held open makes a bind `try_again`, and after
  its COMMIT the bind succeeds with the earlier legacy row kept as history; a binding INSERT held
  open makes a raw legacy INSERT try-lock-refused, and after its COMMIT the same INSERT meets the
  guard. The F3c4 decision above (no `DEFAULT`, no new legacy row, no rewrite of history).
- **The precise code of a failed check stays in the database; on the API it is for administrators
  only.** `GET …/status` (`lastCheck.error`), `GET …/checks/:checkId` and the answer of a check
  start that fails right after its COMMIT show a code of the connection-configuration set
  (`CONNECTION_CONFIGURATION_CODES` in the resolver: the binding, the connection's state, club, host,
  key, adapter and credential codes, `source_auth_rejected` and `source_access_refused` included)
  with its own sentence to a platform admin and to an active admin of the team's club; a coach sees
  `source_connection_unavailable` and the sentence to contact an administrator. A general source
  answer (`source_unavailable`, `source_answer_unexpected`, `source_list_ambiguous`,
  `drill_set_incomplete`, …) and a team fact (`team_club_changed`, `team_not_available`) are shown to
  everyone as they are. The same rule the 409 of a check start already follows.

## 6. Out of scope here, recorded

The pool hardening task (`backend/src/db.js` has no `connectionTimeoutMillis`, so `pool.connect()`
can wait without a bound — owner's note on PR #136) is not touched in this step.
