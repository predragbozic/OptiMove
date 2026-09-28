# F3c2 — source authentication: discovery procedure, contract and test plan

Status: **discovery and contract only** (owner order 2026-09-28). No Connect / Reconnect / Test
route and no network adapter exist yet; they are written only after the owner-run procedure in
section 1 has confirmed the GPEXE authentication contract. Built on F3c1 (migration v27, PR #128,
merged `848aa94`): `training_load.source_host_catalog`, `source_credential_connections`,
`source_team_bindings`, `source_connection_audit`, `backend/src/sourceCredentialCrypto.js`,
`backend/src/sourceHosts.js`. Predecessor: `docs/ai/gpexe-f3c-auth-discovery.md` (the open
questions U1–U6 and U8 of its section 8b are what section 1 answers).

Nothing in this document, in the script it describes or in any test contains or asks for a
credential. The owner runs the script in their own terminal; the report it prints carries the
host key, masked paths, HTTP statuses, the auth scheme word, the team id asked for and field
NAMES — never a token, a username, a password, a cookie, a header value outside a fixed list, or
a body value.

---

## 1. Owner-run read-only discovery (answers 8b without a credential in chat)

Why owner-run: the six facts below can only be proven against the real server with the real
dedicated account. The main session never holds that credential, never sends a GPEXE request and
never uses the browser's JWT or cookie (they are the web app's own session, not a
server-to-server credential — discovery document, section 8a).

### 1.1 The script

`backend/scripts/gpexe-auth-discovery.mjs` (unit-tested with a fake server in
`backend/tests/gpexe-auth-discovery.test.mjs`; the tests send nothing). Guarantees, each one
tested:

- the host is an approved key of the code catalog (`e03`); `server3`, a URL or an unknown key is
  refused before any request (the script is stricter than the app: it cannot read the database
  catalog, so it never resolves a key the code does not know);
- every request goes to that host only; redirects are reported and never followed; every request
  has a 30 s timeout;
- a credential is read from the environment only in the mode that needs it, is sent only where
  that mode says (the `Authorization: Token` header, or the body of the one exchange POST), and is
  never printed: a last guard refuses to print a report that contains any environment value;
- the report holds statuses, the auth scheme word, `Allow` / `Content-Type` / `X-Total-Count` /
  `X-GPEXE-Version` values, other header NAMES, body shape, field NAMES, array lengths, the team
  count and whether the list contains the team asked for; no body value, no server sentence, no
  session or athlete id (paths are masked);
- no database is opened, nothing is written anywhere.

### 1.2 What to run (PowerShell, own terminal; nothing from these lines goes into chat)

Step A — no credential (which scheme the API demands; where the exchange endpoint is). This is
one low-volume probe of a third party's live server (under ten requests, three of them guesses at
the exchange path): run it once, by hand, never in a loop or a scheduler.

```powershell
node backend/scripts/gpexe-auth-discovery.mjs --mode anon --host e03 --team 980
```

Step B — the **dedicated API account's official token**, if GPEXE issues one (the preferred
`credential_kind = api_token`). The value is set only in this terminal and removed afterwards:

```powershell
$s = Read-Host "GPEXE API token" -AsSecureString   # masked; this terminal only, never in chat
$env:GPEXE_API_TOKEN = [System.Net.NetworkCredential]::new("", $s).Password; Remove-Variable s
node backend/scripts/gpexe-auth-discovery.mjs --mode token --host e03 --team 980
Remove-Item Env:GPEXE_API_TOKEN
```

Step C — only if GPEXE issues no official token, the **one-time exchange** with the dedicated
account (`credential_kind = exchanged_token`, the fallback). Use the exchange path step A found
(`api-token-auth/` unless step A says otherwise). If step B's token is also set, the report says
whether the exchanged token EQUALS it (true/false) — nothing more:

```powershell
$u = Read-Host "GPEXE API account username" -AsSecureString   # masked; this terminal only
$env:GPEXE_USERNAME = [System.Net.NetworkCredential]::new("", $u).Password; Remove-Variable u
$p = Read-Host "GPEXE API account password" -AsSecureString
$env:GPEXE_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password; Remove-Variable p
node backend/scripts/gpexe-auth-discovery.mjs --mode exchange --host e03 --team 980 --exchange-path api-token-auth/
Remove-Item Env:GPEXE_USERNAME, Env:GPEXE_PASSWORD
```

Step D — lifetime and rotation (no script can prove these in one run): run step B again after
at least 24 h and again after a new login to the GPEXE UI with the same account; if step B still
answers 200 the token survived (rotation on login: no). Also read, in the GPEXE UI or its
documentation, whether an API token page exists (generate / revoke / expiry) and note only
yes/no and the expiry rule in words.

### 1.3 What to return (form; only these fields)

```
host key:                       e03
step A  scheme word:            ______        (findings.apiDemandsScheme, expected "Token")
        unauthenticated status: ___           (findings.unauthenticatedStatusOnTeamList, expected 401)
        exchange endpoint:      path ______ status ___ field names [______]   (per candidate path)
step B  token accepted:         yes / no      (findings.tokenAccepted)
        team-list endpoint:     exists / absent / status ___
        team count:             ___
        sees Team ID 980:       yes / no
        allowed methods:        team [______]  team_session [______]  athlete_session [______]
        team field names:       [______]      (requests[path = api/team/<team>/].fieldNames)
step C  exchange status:        ___           (only if run)
        returns a token field:  yes / no
        works as Token scheme:  yes / no
        equals step-B token:    yes / no / not compared
step D  token alive after 24 h: yes / no;  after a new UI login: yes / no
        UI has an API-token page: yes / no;  expiry rule in words: ______
```

Never returned, never asked for: any token, username, password, cookie, `Authorization` value,
login body, screenshot, HAR, or the raw JSON file if it were to contain more than the above (it
does not by construction; sending the whole printed JSON is fine).

### 1.4 How the answers decide the contract

| Question (owner, 2026-09-28) | Answered by | Consequence |
|---|---|---|
| 1. Which approved host issues the credential | steps A–C succeed on `e03` | `e03` stays the only approved key. `server3` is not probed by this procedure at all; it stays unapproved (U1/U2 are answered by GPEXE support or documentation, not by a request from OptiMove). |
| 2. Official token or exchanged token | B accepted → `api_token`; only C works → `exchanged_token` | `credential_kind` per connection; the Connect route accepts the kind the discovery proved, the other stays disabled for `gpexe` (both kinds remain storable, F3c1). |
| 3. Endpoint, header scheme, lifetime, rotation | A (scheme, path), C (exchange), D (lifetime) | The adapter's `scheme` and `exchangePath` constants; the decay period of `verified` (D7); whether Reconnect must be offered proactively. If D shows rotation on login, the runbook forbids UI logins with the API account. |
| 4. Dedicated account sees Team ID 980 | B or C `seesTeam` | A binding for team 980 is only created after a Test on this connection succeeds (section 3.8). |
| 5. Read-only team-list endpoint | B `teamListEndpoint` | If it exists, Test connection reads `team/` (one request, no team needed) and Connect offers the list to choose a source team from; if absent, Test reads the bound team's thresholds. |
| 6. Minimal scope | B `allowedMethods`; GPEXE account roles (owner, in the UI, words only) | The runbook states the smallest GPEXE role that answers GET on `team`, `team_session`, `athlete_session`, `track`; if `Allow` lists write methods, the account must be a read-only role or GPEXE support is asked for one. |

**GO for the adapter** = steps A and B (or A and C) returned, scheme word known, `seesTeam` yes,
and question 6 answered in words. Anything else = NO-GO, the adapter is not written, the owner
decides.

---

## 2. Source-neutral shape of F3c2 (what is built after GO)

Names below are the contract; the code may only narrow them. GPEXE is the first adapter, not the
name of anything.

### 2.1 Adapter interface (per `source_system`)

```
sourceAdapter(sourceSystem) → {
  kinds: ['api_token'] | ['exchanged_token'] | both       // what the discovery proved for this source
  testConnection({ baseUrl, credential, sourceTeamId? })  // ONE read; → { ok, code, sourceTeamIds? }
  exchange?({ baseUrl, username, password })              // only for kinds incl. exchanged_token; → { credential } and nothing else kept
  listTeams?({ baseUrl, credential })                     // only if question 5 = exists; ids and labels only
}
```

`baseUrl` is always the return value of `resolveApprovedSourceHost(sourceSystem, hostKey,
catalogRow)` from `backend/src/sourceHosts.js`, with `catalogRow` read from
`training_load.source_host_catalog` in the same transaction. An adapter never receives a URL from
anywhere else and never builds one; a path is always relative to `baseUrl`; redirects are
refused; GET (and the one exchange POST) only.

### 2.2 Routes (platform admin; club admin of the owning club only after the ADR-002 review, D2)

All under the existing Settings → Data sources router (`requireAuth`, JSON body required, same
origin). Info-hiding: a connection, club or team the caller may not manage answers the same 404
as a non-existent id (ADR-006).

| Route | Purpose | Writes |
|---|---|---|
| `POST /api/training-load/sources/:source/connections` | create a connection: `ownerScope`, `ownerClubId` / `ownerTeamId`, `hostKey` (must be approved in the catalog AND resolvable), `accountLabel`, `credentialKind` | one `not_connected` row + audit `create` |
| `POST …/connections/:id/connect` | attach a credential: `{ token }` (api_token) or `{ username, password }` (exchanged_token; both used once, never stored, never logged); then Test | ciphertext + state + audit `connect` |
| `POST …/connections/:id/test` | one read on the chosen host | state + audit `test` |
| `POST …/connections/:id/reconnect` | replace the credential (same as connect, on an existing one) | ciphertext + state + audit `reconnect` |
| `POST …/connections/:id/bindings` | bind an OptiMove team to a source team (`teamId`, `sourceTeamId`) | binding row + audit `bind` |
| `GET …/connections?clubId=…` / `GET …/connections/:id` | state, `lastVerifiedAt`, `lastErrorCode`, bound teams, host key and label; never a credential part, never a username | — |

Disconnect stays outside F3c2 (D5). The env `GPEXE_API_TOKEN` fallback stays until F3c4 (D8).

### 2.3 The mandatory conditions (owner, 2026-09-28) and where each is enforced

| # | Condition | Enforcement | Proof |
|---|---|---|---|
| 1 | `resolveApprovedSourceHost()` before every network call | the adapter is constructed only with its return value; the catalog row is read `FOR SHARE` inside the route's transaction | test 2.x: retired row, key absent from code, key absent from catalog → `host_not_allowed`, zero requests (fake server counts) |
| 2 | connection row locked before reading the bound-team order | `select … from source_credential_connections where id = $1 for update` first, then `select training_load.source_connection_bound_team_ids($1)` | test: a binding inserted concurrently after the lock is seen or refused, never half |
| 3 | all bound teams locked in ascending order | `hold_gpexe_team_lock(team, 'connect')` for each id in the order the function returns. **Invariant:** the binding trigger takes the order the other way round (team try-lock, then the connection `FOR SHARE`); that is deadlock-free only because the team lock is a try-lock that never waits. No route, trigger or future migration may add a blocking wait on a team lock while holding a connection lock, or the reverse. | test: two overlapping Reconnects, one wins, the other answers `try again` at once; no deadlock; a Reconnect during a "Check now" of one bound team is refused; a bind concurrent with a Reconnect on the same connection: one of the two answers `try again`, never a wait |
| 4 | throttling 5 attempts / 15 minutes | counted from the append-only audit, under two locks taken before counting: the connection row `FOR UPDATE` (per-connection window) **and** `pg_advisory_xact_lock(hashtextextended('source-auth-throttle:' \|\| performing_user_id::text, 21))` (per-user window across all connections — the connection row alone would let two concurrent attempts on two connections each see 4 and both pass). The window counts **attempts that reached the source** (rows with action `connect` / `reconnect` / `test` and outcome `ok`, `failed` or `unknown`, plus `refused` with `source_auth_rejected`) in the last 15 min; ≥ 5 → `429 source_auth_throttled`. Refusals that never reached the source (`source_auth_throttled`, `host_not_allowed`, `try_again`, `key_missing`) are audited but **not counted**, so a client retrying on 429 cannot extend its own lockout forever (owner default; D10). The admin cannot reset the count (audit is append-only). | tests: the 6th attempt in the window refused with zero requests; the window slides; per-user limit across two connections **with two truly concurrent requests** (both started before either commits) — exactly one passes; a throttled refusal is audited and does not count; a Test does not reset the count |
| 5 | audit of every attempt without secret values | one audit row per attempt in the same transaction as the state change; `metadata` only from a fixed allowlist of keys (`host_key`, `credential_kind`, `status_class`, `attempt_no`, `source_team_count`); the v27 trigger refuses any secret-named key | tests: connect/test/reconnect ok, refused, failed and unknown each leave exactly one row; `jsonb_names_a_secret` refuses a mistaken key; a body-log test proves neither the request body nor the credential reaches any logger |
| 6 | stable error codes, no source-server text | the adapter maps every outcome to one of: `source_auth_rejected` (401/403), `source_unavailable` (network, 5xx, timeout), `source_answer_unexpected` (2xx of another shape), `host_not_allowed`, `source_team_not_visible`, `source_auth_throttled`, `credential_kind_unsupported`, `key_missing`, `try_again` (lock), `outcome_unknown`; the response carries the code and OptiMove's own sentence; the server's body never leaves the adapter | test: a fake server answering with a sentence in its body → the sentence appears in no response, log or audit row |
| 7 | Connect / Test only on the chosen host, no fallback | one `baseUrl` per connection per request; no retry on another key; a retired key mid-flight fails the request | test: retiring the key between two Tests turns the second into `host_not_allowed` with zero requests |
| 8 | no binding before a successful Test / Connect | `POST …/bindings` requires `state = 'verified'` (checked under the connection lock) and, when the adapter can list teams, that `sourceTeamId` is in the list; otherwise Test on that team's thresholds succeeds first | test: binding on `linked_untested` / `needs_reconnect` refused; binding after a verified Test accepted; team 980 gets its row only that way |

### 2.4 State transitions (v27 states and facts)

| From | Event | To | Facts written |
|---|---|---|---|
| `not_connected` | connect + test ok | `verified` | ciphertext parts, `last_verified_at`, `last_error_code = null` |
| `not_connected` | connect ok, test `source_unavailable` | `linked_untested` | ciphertext parts, `last_error_code`, `last_error_at` |
| any with credential | test / read `source_auth_rejected` | `needs_reconnect` | `last_error_code`, `last_error_at`; ciphertext kept (history) until reconnect |
| any with credential | test / read `source_unavailable` | `source_unavailable` | `last_error_at`, `last_error_code` |
| `verified` / `needs_reconnect` / `source_unavailable` | reconnect + test ok | `verified` | new ciphertext parts (new nonce), `last_verified_at` |
| any | connect / reconnect with `host_not_allowed`, throttled, `try_again` | unchanged | audit row only |
| any | COMMIT answer lost after the source call succeeded | unchanged in the answer (`outcome_unknown`), row as committed | the original transaction's audit row (`ok`/`failed`) exists only if it committed; the handler then verifies on a fresh connection inside the **same request** (the F2 approval discipline, at most 5 s) and answers what it finds; only if that verify cannot resolve the outcome does it append a second row `outcome = 'unknown'` with the same `performed_by_user_id` and `basis` (never `basis = 'system'`: the v27 actor CHECK allows `system` only with `auto_invalidate`); the client re-reads state instead of resending |

**Fact gap in v27 to close with the routes:** v27 has no fact CHECK for `linked_untested` (the other
four states have one), so nothing in the database forces `last_error_code` / `last_error_at` onto a
`linked_untested` row. F3c2 either adds a data-only migration v28
(`check (state <> 'linked_untested' or last_error_code is not null)`) or, at least, a route test
that every write of `linked_untested` carries both facts; the choice is recorded in the F3c2 PR.

A credential is encrypted with `encryptCredential(plaintext, context, keyring)` where the context
is the row's own seven fields; the plaintext exists only in the request handler's scope and is
overwritten with nothing kept once encrypted; the exchange password is used for the one POST and
dropped.

---

## 3. Test plan (written with the adapter; all on disposable `optimove_tests_gpexe_*` databases)

Fake source server (in-process `http` server, as `gpexe-in-app-import.test.mjs` does): answers
the discovered scheme, a team list, thresholds, a session page, 401 for a wrong token, 5xx and
hang on demand, and records every request (method, path, header NAMES, whether an
`Authorization` header was present and whether its value equals the expected marker).

1. Route contract: create / connect / test / reconnect / bind per 2.2; info-hiding 404 for a
   foreign club admin, a team coach and a signed-out caller; JSON body required (form body 415).
2. Host gate (condition 1 and 7): approved → one request to exactly the fake host; retired,
   code-absent, catalog-absent → `host_not_allowed`, zero requests; retire between two Tests.
3. Locks (conditions 2, 3): overlapping Reconnects; Reconnect during a Check; the row lock
   taken before `source_connection_bound_team_ids()` (a concurrent bind commits or is refused
   whole); the lock order equals the ascending team ids (`pg_locks` snapshot in the test).
4. Throttle (condition 4): 5 allowed, 6th `429`; window slides; per user across two connections
   with two concurrent requests started before either commits (exactly one passes; proves the
   per-user advisory lock); throttled refusals audited and not counted; a Test does not reset the
   count.
5. Audit (condition 5): one row per attempt with outcome ok / refused / failed / unknown; the
   marker credential and the fake username never appear in any audit row, response, log line
   (a capturing logger on `console` and on `express` for the whole test) or database column.
6. Codes (condition 6): each fake answer class → the stable code; the fake body sentence appears
   nowhere.
7. Binding (condition 8): refused before verified; accepted after; team 980 only through this
   path; v27's own refusals (retired key, foreign club, second active binding) surface as their
   stable codes.
8. Crypto in the route: the stored parts decrypt with the same context and fail with a changed
   one; `SOURCE_CREDENTIAL_KEYS` missing → `key_missing`, no request, state unchanged.
9. COMMIT outcome: an answer lost after the source call → the in-request verify on a fresh
   connection answers the committed outcome; when the verify itself cannot resolve it →
   `outcome_unknown` and a second audit row `unknown` with the caller's own user and basis (a
   `system` basis on that row is refused by the v27 CHECK, tested); state as committed; the
   client's re-read shows it.
10. Import client: a bound team's read uses the stored credential of its connection; with none
    and the env token present, the env fallback (D8) is used and audited as `system`.

External review triggers 2 and 4 are active for the whole of F3c2: the PR is never declared
merge-ready by the main session.

---

## 4. Stop line for this PR

Delivered here: the discovery script and its tests, this contract, the CURRENT_STATE update.
Not delivered, by order: any route, any adapter, any network call, any credential, any change of
the Render environment, any row in the v27 tables, F3c3, 5a3c.
