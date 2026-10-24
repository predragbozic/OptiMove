# Plan: a pause per GPEXE connection after a rate-limit stop

Status: **plan only.** No code, no migration and no GPEXE request. Owner order 2026-10-22 ("plan first, with
its impact on the 429 PR"). The final operation matrix follows the owner's order of 2026-10-23. The plan was
checked by the internal `code-reviewer`, `db-reviewer` and `security-reviewer` on 2026-10-23, and their
corrections are in this text. The final code and security reviews of the pushed commit found it accurate against
`adaa0eb`. No decision of section 3 is taken yet, and nothing of the pause is built.

Last verified against commit: `adaa0eb` (the 429 PR, `fix/gpexe-check-rate-limit`, on `origin/main` `12beb86`).
Paths below are under `backend/src/`.

## 1. Why

The 429 PR (Draft PR #209) bounds **one check**: at most one repeat after a whole-seconds `Retry-After` of
at most 60 s; any other 429 stops it with no further request. Nothing stops the **next** request through the same
GPEXE account (the security review's L2):
- a new *Find new sessions* right after the stop starts a full check again;
- a check of another team bound through the same connection does the same;
- so does *Load names and dates of birth*.

GPEXE's limit is most likely per account (token), and every team bound through one connection uses that
connection's token. So the pause belongs to the **connection** (`training_load.source_credential_connections.id`),
not to a team.

## 2. Operation matrix (from the code at the commit above)

What actually sends a request to GPEXE, and what stays local. The application has four network entry points:
`createGpexeClient()` (`gpexeClient.js`, the legacy environment token), `openImportSource()`
(`sourceImportCredentialResolver.js`), and `exchangeCredential()` and `testReads()` (both in
`sourceConnectionService.js`). Every other route reads or writes the database only. The code and security reviews
confirmed the matrix against the routes in `routes/gpexeImport.js` and `routes/sourceConnections.js`; the database
review confirmed the four entry points.

### 2a. Operations that call GPEXE through a source connection: a pause blocks them

| Operation | Route | Entry point | GPEXE requests | During a pause |
|---|---|---|---|---|
| Check (*Find new sessions*) | `POST /api/training-load/gpexe/teams/:teamId/checks` | `startCheck` → `openImportSource(…, { rateLimitRetry: true })` (`gpexeImportService.js`) | the whole session list twice (`2 × ceil(N/100)` pages), then about 200–330 reads per session (`docs/ai/gpexe-check-request-count-analysis.md`) | refused at start, before the check row; a running check stops before its next request (section 5) |
| Load names and dates of birth | `POST …/gpexe/teams/:teamId/athlete-identities/loads` | `openImportSource(…)` without `rateLimitRetry` (`gpexeAthleteIdentityService.js`) | at most 50 (`IDENTITY_MAX_PER_LOAD`), 3 at once (`IDENTITY_CONCURRENCY`) | refused at start, before the request row; a running load stops before its next read; a saved load's *Check result* replay is still answered |
| Connect | `POST /api/training-load/sources/:source/connections/:id/connect` | `attempt("connect")`: `exchangeCredential()`, then `testReads()` | 1 exchange (POST), then the team list (1 page) and one read per active bound team | refused before the exchange; the pair is never sent |
| Reconnect | `POST …/connections/:id/reconnect` | `attempt("reconnect")`: the same as Connect | the same as Connect | owner decision 3b: refused, or allowed as the remedy |
| Test connection | `POST …/connections/:id/test` | `attempt("testConnection")`: `testReads()` with the stored token | the team list (1 page) and one read per active bound team | refused |
| Bind a team | `POST …/connections/:id/bindings` | `attempt("bindTeam")`: `testReads()` with the chosen team only | 1 read of the chosen team; an idempotent repeat sends nothing | refused before the read; the idempotent repeat (no request) is still answered |

### 2b. Local operations: never blocked by a pause

| Operation | Route / process |
|---|---|
| Create a connection (no credential yet) | `POST …/sources/:source/connections` |
| Unbind | `POST …/connections/:id/bindings/:bindingId/unbind` (a local operation by contract) |
| Read connections | `GET …/sources/:source/connections`, `GET …/connections/:id` |
| Team status, one check, candidates, one candidate, an approval | `GET …/gpexe/teams/:teamId/status`, `/checks/:checkId`, `/candidates`, `/candidates/:candidateId`, `/approvals/:approvalId` |
| Approve one candidate, approve a batch | `POST …/candidates/:candidateId/approve`, `POST …/imports`: they import the stored snapshot, no GPEXE read |
| Source athletes, stored identities, athlete links, link, unlink | `GET …/source-athletes`, `GET …/athlete-identities`, `GET`/`POST …/athlete-links`, `POST …/athlete-links/:linkId/unlink` |
| Approver grants and revokes | `GET`/`POST …/approvers`, `POST …/approvers/:grantId/revoke` |
| The team's GPEXE Team ID (Data sources) | `PUT …/settings`, `GET …/settings/history` |
| Retention and purges | `GET …/retention`; the run at every check start, the server's 6-hour interval (`gpexeImportService.js`), the CLI; the stale-check sweep; the identity purge |
| Metrics mapping and variables (M2, M3-0, M2b) | `/api/training-load/sources/metrics/…` |

### 2c. Outside a per-connection pause

- **The legacy environment path.** A team that never had a binding reads through `GPEXE_API_TOKEN` with
  `createGpexeClient()`. It has no connection, so no pause can be keyed to it. CURRENT_STATE recorded on
  2026-09-27 that the production Render service has no `GPEXE_API_TOKEN`; this was not re-read for this plan. In
  any environment where the variable is set, that path bypasses a pause. F3c4 retires it.
- **Owner-run scripts:** `backend/scripts/gpexe-rest-v1-capability-probe.mjs`,
  `backend/scripts/gpexe-auth-discovery.mjs` and `backend/scripts/gpexe-api-probe.mjs`. They use the same GPEXE
  account from the owner's own terminal, and the application cannot see them. The owner's Apps Script
  integration is another consumer of the same account.
  - Runbook rule (proposed): no owner-run script while a pause is active, nor within 60 minutes of a 429.

## 3. Rules (each an owner decision)

| Question | Proposal |
|---|---|
| What starts a pause | A 429 that **ends** an operation on the connection: a check's rate-limit stop (`second_429`, `retry_already_used`, `no_retry_after`, `retry_after_date`, `retry_after_invalid`, `retry_after_over_max`), a 429 in an identity load, and a 429 answer to Connect, Reconnect, Test or Bind. A 429 whose one repeat succeeded starts none. A check whose wait ended for another reason (`stopped_before_retry`: an Unbind, a Reconnect, a check closed elsewhere) also starts none, because its own stop is that other reason (decision 3a). |
| Duration | A whole-seconds `Retry-After`, clamped to the bounds below; absent or any other form: **15 minutes**. |
| Lower bound | At least **1 s** always (a `Retry-After: 0` must still record a pause). Proposed: at least **60 s** after `second_429` and `retry_already_used` only, because a check that already waited and met a second 429 should not be retried at once. A path that never repeats (the identity load, the exchange, `testReads`) gets its own outcome word, `not_repeated`, never `retry_after_over_max`. |
| Upper bound | Proposed **1 hour** in the first step, not 24 hours, because the pause has no manual remedy yet (3b). |
| An HTTP-date `Retry-After` | Treated as absent, so 15 minutes, as conservative as PR #209. The alternative is to read the date when it lies in the future and within the upper bound. |
| Clock | Both timestamps come from one `clock_timestamp()` read inside the insert (one CTE), never `now()` and never a column `DEFAULT clock_timestamp()` (a second read): an attempt transaction can be about 90 s old at insert time, and two different clock reads could break the upper-bound CHECK. The query that asks whether a pause is active also compares with `clock_timestamp()`. The duration is clamped and floored in SQL and bound as an integer parameter (`make_interval(secs => $n)`), never interpolated, because it comes from a GPEXE header. |
| Scope key | **Per connection.** It is not per account: a second connection to the same GPEXE account (for example a duplicate left by a lost Create, see CURRENT_STATE) does not share the pause. That gap is accepted, or closed by the idempotent Create task. A wider scope (per club and host, or per host) would put one club's pause on another club; it is allowed only if an unrelated club's user then gets a generic refusal with no time, no operation and no detail. |

**3a. `stopped_before_retry`.** Proposal: no pause. The wait ended because of the operation's own state, and no
second 429 was seen. The other choice is to record the first 429's pause anyway.

**3b. Remedy for a wrong or long pause.** The table is append-only, so a pause cannot be edited or removed. As
written, a large `Retry-After` from one coach's check would block every team, the administrator's Test and Bind,
and (if Reconnect is blocked) the change of credential, for the whole pause. The owner chooses one or more:
- a **low upper bound** (1 hour, above);
- an append-only **lift** row: a platform admin only, audited, with a reason. The pause query then reads the
  latest event per connection;
- **Reconnect allowed during a pause**, as the remedy (one exchange plus the reads of Connect, still under the
  5-per-15-minutes throttle);
- the pause **tied to the credential fingerprint**. The fingerprint is a hash of the stored credential's nonce,
  which is new on every encryption, so in practice **any successful Reconnect lifts the pause**, whether or not
  GPEXE issued a different token. The 1-hour bound limits what that can cost;
- at least an owner-run **break-glass SQL** in the runbook.

Recommendation: the 1-hour bound, Reconnect allowed, and the fingerprint tie (so a successful Reconnect is the
administrator's way to end a pause). If that is not intended, prefer the audited lift row. Test and Bind stay
blocked.

## 4. Where the pause is stored

| Option | For | Against | Recommendation |
|---|---|---|---|
| **A. A new append-only table** `training_load.source_rate_limit_pauses` (connection, recorded at, `paused_until`, the operation from a closed list, the `Retry-After` kind and seconds, the credential fingerprint, an optional check id) | A typed end with CHECK constraints. The insert takes only `FOR KEY SHARE` on the connection row, which never waits behind Connect, Test or Bind holding `FOR NO KEY UPDATE` for up to 90 s: the row is taken `for no key update of c`, and it has no unique index besides its primary key. The history is evidence of GPEXE's limit. No personal data. | A migration with rollback, preflight and post-check. | **yes** |
| B. A new action in `source_connection_audit` | Existing append-only record; the throttle is already counted from it. | The end would sit in the metadata allowlist, not typed. Changes the v27 `action` CHECK. The audit records administrators' acts; this is a system event. | no |
| C. A column on `source_credential_connections` | One read. | Its UPDATE waits on the row lock held by Connect or Test (up to 90 s). It touches the table with the strict v27 / v29 state triggers. | no |
| D. Derived from `gpexe_import_checks` (parse the diagnostic of `error_message`) | No migration. | Parses text. Misses identity loads and Connect / Test. Ties the pause to the message format. | no |
| E. In the process's memory | Simplest. | Lost on every restart and deploy; not shared between processes. | no |

The lock claim holds only while the migration follows two rules:
- no insert trigger reads the connection row `FOR SHARE` (v27's `source_team_binding_check_owner` does, and it
  would wait behind `NO KEY UPDATE`); a guard uses plain reads or `KEY SHARE`;
- the optional check-id FK takes `KEY SHARE` on the check row, while `finalizeCheck` takes it `FOR UPDATE`. That
  is safe only because one check's failure path and its finalization never run at the same time.

## 5. Flow (option A)

**The signal the pause needs (a change beyond PR #209).**
- At `adaa0eb`, `withRateLimitDiagnostic` (`sourceImportCredentialResolver.js`) rethrows a rate-limit stop with
  only `{ status: 429, reason: "rate_limited" }` and the text line. The structured facts are dropped.
- The pause PR, or a small change to PR #209 before its merge, carries a closed `{ retryAfter, retryAfterS,
  outcome }` onto the rethrown error. It never parses the message.
- The identity load uses the same adapter without the `rateLimit` option, so its 429 refusal carries no
  `Retry-After`; the adapter attaches the closed facts to a 429 refusal in that case too.
- `exchangeCredential()` and `testReads()` do not surface `Retry-After` today; they need to.

**Recording a pause.**
- **Check.** In the run's failure path, **after** the check's own outcome is written, as the existing discipline
  for side effects says ("only after the check's own outcome is written, and never changing it",
  `gpexeImportService.js`):
  - one autocommit insert under `boundImportSideEffect` with a client-side bound of about 5 s, and server-side
    statement and lock timeouts;
  - a lost or failed insert is logged by a stable code only, and is **fail-open by design**: no pause, the
    check's code and sentence unchanged, the one-repeat rule unchanged;
  - the check row is never held in `running` by the insert.
- **Identity load.** A load that ends on a 429 records a pause the same way, after its own outcome is written.
- **Connect, Reconnect, Test, Bind (second step).**
  - The insert gets its own savepoint inside the attempt transaction, so a refused insert never turns the attempt
    into `attempt_not_recorded`.
  - The 429 facts are kept outside the `try`, so that the compensation path (`rollback to savepoint
    attempt_locked`) can insert the pause again after its rollback.
  - The pause travels in the audit row's transaction. After an unknown COMMIT, the verification reads the audit
    row: if it is found, the pause committed with it; if not, neither did.

**Honouring a pause: only before a request.**
- A new `assertSourceNotPaused(source, executor)` is called only where a request is about to leave:
  - before each list and each session bundle of a check;
  - before the PR #209 repeat (`beforeRetry`);
  - before the second complete list read;
  - before each identity read;
  - at the start of a check, an identity load, Connect, Reconnect (3b), Test and Bind.
- It is **not** added to `assertImportSourceStillUsable`, which also runs after the last request, inside
  `finalizeCheck` and in the identity load's finalization. A pause recorded meanwhile by another team must never
  throw away a completed read that sends nothing more.
- At check start the read sits in the existing transaction under the team lock, after `resolveImportSourceFacts`
  and before the INSERT of the check row: an active pause refuses with no row and no request.

**Order against authorization (info-hiding).**
- `source_paused` is produced only after the existing access, rights and 404 decision, inside the authorized
  context: never before `resolveConnectionAdmin`, the club and team checks or `rightsStillHold`.
- A replay or an idempotent answer comes first:
  - the idempotent repeat of a Bind;
  - the identity load's saved request, so that *Check result* is never turned into a refusal.
- For Connect, Reconnect, Test and Bind, a pause refusal is audited with `counted: false`, never in the
  5-per-15-minutes window.

**Concurrency.** No new lock: reading the pause is a plain SELECT inside transactions that already exist, and the
insert waits behind none of the locks on the connection row. Two windows are accepted:
- A check that starts just before a pause is recorded stops before its next request, or on its own 429.
- During a PR #209 wait (up to 60 s), other operations of the same connection keep sending, because the pause is
  recorded only when the waiting check stops. The other choice is to record a pause at the first 429. The waiting
  check's own `beforeRetry` would then have to ignore its own pause, through the check id. Decision 5a.
- A running check honours another operation's pause at its next list, bundle or repeat, not at every request: a
  bundle is hundreds of requests (section 2a). It also stops at its own next 429. The alternative is a hook on
  every request in the adapter.

## 6. Answer and display

- **`409 source_paused`** (name to decide), with `details: { pausedUntil }` and an HTTP `Retry-After`; nothing
  written, nothing sent. Not `429`, which would mix it with the connection-attempt throttle
  (`source_auth_throttled`).
- **A coach** sees the time only: never another team, never the operation that started the pause. For example:
  "GPEXE asked OptiMove to slow down. You can search again after 17:26."
  - The exact end time tells a coach, to the second, when another team's check or an administrator's attempt met
    a 429: a small timing channel between teams of one club. It is accepted, or the screen shows a coarse "in
    about N minutes" (decision 6a).
- **An administrator** sees the same, and under *Technical details* the operation and the `Retry-After` kind.
- **No answer** to anyone carries the stored check id or team of the pause.
- **Frontend.** At least one sentence for the new code. Better, the status route returns `sourcePausedUntil`, and
  *Find new sessions* is disabled with that time (`ux-design-reviewer` and `mobile-qa` when the button changes).

## 7. Impact on PR #209

- **PR #209 itself does not need to change.** The pause is its own later PR, branched from PR #209 or after its
  merge. Its repeat rules, the heartbeat, fail-closed and the diagnostic stay as they are.
- **What the pause PR changes in PR #209's files:**
  - `withRateLimitDiagnostic` carries the closed facts onto the rethrown error (section 5). The owner may instead
    have that one change made in PR #209 before its merge.
  - The adapter's `beforeRetry` path calls `assertSourceNotPaused`, so another team's pause stops a check before
    its repeat (`source_paused` instead of the repeat).
- **What changes in behaviour once the pause exists:** after a stop, a new check of the same connection is refused
  until the pause ends. That is the point of L2.
- **Tests of PR #209 to adapt:** only test 8 of `gpexe-check-rate-limit.test.mjs`. Its second check on the same
  team (and connection) needs a clock seam or a pause that has already ended. Test 3 builds a new connection in
  each loop and is not affected.
- **PR #209 alone in production:** the next click after a stop sends a new full check, as today, with one repeat
  added. The pause does not block PR #209's merge.

## 8. Size and proof of the pause PR (estimate)

**The migration.**
- Its number and timestamp: after the latest file (`202610191300…`); the Training Load number may collide with
  the revision-lifecycle PR (C91), which is decided at that time.
- **The table:**
  - FKs `on delete restrict`;
  - CHECK constraints:
    - `paused_until > recorded_at`;
    - at most the upper bound after `recorded_at`;
    - the operation from a closed list;
    - the `Retry-After` kind and its seconds coupled (seconds present exactly for `seconds`);
  - triggers for append-only (UPDATE, DELETE and TRUNCATE refused);
  - an index `(connection_id, paused_until desc)`;
  - an index on the check-id FK, or the stated reason not to have one (checks are never deleted, v24);
  - a reference to the identity load's request, so that its pause can be traced.
- **Rollback.** It refuses with any row and under a later migration, so the migration is forward-only after the
  first recorded pause.
- **Read-only checks.** A preflight and a post-check, and a rehearsal on a disposable database.
- **Retention.** An owner decision. The volume is tiny, but an append-only trigger would also block a later purge
  unless the purge is designed in.

**Services.**
- `gpexeImportService.js`: recording after the outcome, and the start check.
- `sourceImportCredentialResolver.js`: `assertSourceNotPaused` and the closed facts on the rethrown error.
- `gpexeRestV1Adapter.js`: no change to the repeat rules; the closed `Retry-After` facts on a 429 refusal without
  the `rateLimit` option (the identity load).
- `gpexeAthleteIdentityService.js`.
- Second step: `sourceConnectionService.js` (`exchangeCredential` and `testReads` surfacing `Retry-After`).

**Frontend.** The sentence, optionally the disabled button with the time.

**Tests (disposable database, fake source, through the real routes).**
- **Recording and refusing:**
  - a pause recorded after a stop, with the 1 s floor and the upper bound;
  - `409 source_paused` from `POST …/checks` for the same team and for another team of the connection, with no
    row and no request;
  - the pause ending;
  - 15 minutes without `Retry-After`.
- **Concurrency and failure:**
  - the race of two teams (the test observer fires only after the pause insert, or test 8's second check races
    it);
  - a pause recorded during another check that has finished its requests does not discard that check;
  - a stalled or failed insert that leaves the check's outcome unchanged.
- **Info-hiding:**
  - a coach never sees another team;
  - a foreign club's admin, a revoked role and an archived team get identical answers with and without an active
    pause;
  - a replay answered during a pause.
- **Second step:** a 429 with a failing pause insert, a 429 with `rights_changed`, and a 429 with an unknown
  COMMIT.
- **Mutations** for each guard.

**Reviews.** The external review triggers are 1 (migration), 2 (info-hiding between teams) and 4 (concurrency).
The internal reviewers are `db-reviewer`, `security-reviewer` and `code-reviewer`, plus `ux-design-reviewer` and
`mobile-qa` if the screen changes.

**Precondition:** the owner's decisions 3 (with 3a and 3b), 5a and 6a, and the storage option of section 4.
