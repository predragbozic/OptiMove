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

**Carry step A into steps B and C.** The scheme word step A reported (`findings.apiDemandsScheme`)
is passed as `--auth-scheme`; the script sends exactly that one scheme and never tries another
(a wrong word is a 401 finding, not a retry). Step A's empty POST reveals only the **request**
fields the exchange endpoint requires (`username`, `password`); it cannot reveal the field a
successful answer carries the token in. **`--token-field` therefore comes from the official GPEXE
documentation or GPEXE support**; when neither says, the first step C run uses the documented
legacy candidate `token` (the pilot's observation on `e03`). Only that one field is read. Pass the
scheme word explicitly even when it equals the default, so the form and the run agree.

Step B — the **dedicated API account's official token**, if GPEXE issues one (the preferred
`credential_kind = api_token`). The value is set only in this terminal and removed afterwards:

```powershell
$s = Read-Host "GPEXE API token" -AsSecureString   # masked; this terminal only, never in chat
$env:GPEXE_API_TOKEN = [System.Net.NetworkCredential]::new("", $s).Password; Remove-Variable s
node backend/scripts/gpexe-auth-discovery.mjs --mode token --host e03 --team 980 --auth-scheme Token
Remove-Item Env:GPEXE_API_TOKEN
```

(After step A: `--auth-scheme Token` is confirmed for `e03`; the lines above are exact.)

Step C — only if GPEXE issues no official token, the **one-time exchange** with the dedicated
account (`credential_kind = exchanged_token`, the fallback). Use the exchange path step A found
(`api-token-auth/` unless step A says otherwise). If step B's token is also set, the report says
whether the exchanged token EQUALS it (true/false) — nothing more.

If the exchange answers 2xx but `exchangeReturnsTokenField` is `false`
(`successWithoutNamedField: true`), the script has already dropped that answer unread beyond its
field names: it prints `successResponseFieldNames` (names only), sends no GET and guesses nothing.
The owner then confirms the right field from those names against the documentation and may
repeat step C **at most once** with the confirmed `--token-field`. Be aware that this means
**two exchange POSTs** were sent with the account's password (each one may have issued a token on
the GPEXE side); record both runs in the form. Never a third run, never a loop.

```powershell
$u = Read-Host "GPEXE API account username" -AsSecureString   # masked; this terminal only
$env:GPEXE_USERNAME = [System.Net.NetworkCredential]::new("", $u).Password; Remove-Variable u
$p = Read-Host "GPEXE API account password" -AsSecureString
$env:GPEXE_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password; Remove-Variable p
node backend/scripts/gpexe-auth-discovery.mjs --mode exchange --host e03 --team 980 --exchange-path api-token-auth/ --auth-scheme Token --token-field token
Remove-Item Env:GPEXE_USERNAME, Env:GPEXE_PASSWORD
```

(After step A: `--exchange-path api-token-auth/` and `--auth-scheme Token` are confirmed for
`e03`; `--token-field token` is the legacy candidate until GPEXE confirms the field name — replace
it with the confirmed name when GPEXE answers.)

Step D — lifetime and rotation. **Documentation first, never a login experiment on a credential
in use.** A new UI login with the same account may rotate or revoke the token GPEXE issued, so a
login is not a read-only step.
1. Read the GPEXE documentation, the API-token page of the UI (if one exists: generate / revoke /
   expiry / "one token per user") or ask GPEXE support: does the token expire, and does a new
   login invalidate it? Note yes/no and the rule in words. If this answers the question, step D
   is done.
2. Run step B again after at least 24 h (read-only; proves the token survives a day).
3. A **controlled login test** only when all of these hold: GPEXE documentation or support has
   confirmed that a UI login does not affect an API token (or the owner explicitly accepts that
   it may); the account is the dedicated API account and is **not yet used by production** (no
   verified connection in OptiMove points at it); and the owner notes before the login that the
   token may become invalid and a new one may have to be issued. Then: log in to the UI once, run
   step B again, record alive yes/no. Never with the account of a live connection.

### 1.3 What to return (form; only these fields)

```
host key:                       e03
step A  scheme word:            ______        (findings.apiDemandsScheme, expected "Token")
        unauthenticated status: ___           (findings.unauthenticatedStatusOnTeamList, expected 401)
        exchange endpoint:      path ______ status ___ exchange request field names [______]   (per candidate path)
        scheme passed to B/C:   ______        (--auth-scheme, equals step A)
step B  token accepted:         yes / no      (findings.tokenAccepted)
        team-list endpoint:     exists / absent / status ___
        team count:             ___
        sees Team ID 980:       yes / no
        allowed methods:        team [______]  team_session [______]  athlete_session [______]
                                (what the endpoint supports, not what this account may do)
        team field names:       [______]      (requests[path = api/team/<team>/].fieldNames)
step C  token field chosen:     ______        (--token-field; source: documentation / support / legacy candidate "token")
        exchange status:        ___           (only if run)
        successful response field names: [______]   (findings.successResponseFieldNames, names only)
        returns the chosen field: yes / no    (findings.exchangeReturnsTokenField)
        2xx without the chosen field: yes / no (findings.successWithoutNamedField; answer dropped)
        repeated once with confirmed field: no / yes -> field ______, two exchange POSTs sent
        works with that scheme: yes / no      (findings.exchangedTokenWorksAsScheme)
        equals step-B token:    yes / no / not compared
step D  documented rule (expiry / rotation on login), source: ______
        token alive after 24 h: yes / no
        controlled login test:  not run / run (conditions of step D.3 met) -> alive yes / no
        UI has an API-token page: yes / no
```

Never returned, never asked for: any token, username, password, cookie, `Authorization` value,
login body, screenshot, HAR, or the raw JSON file if it were to contain more than the above (it
does not by construction; sending the whole printed JSON is fine).

### 1.4 How the answers decide the contract

| Question (owner, 2026-09-28) | Answered by | Consequence |
|---|---|---|
| 1. Which approved host issues the credential | steps A–C succeed on `e03` | `e03` stays the only approved key. `server3` is not probed by this procedure at all; it stays unapproved (U1/U2 are answered by GPEXE support or documentation, not by a request from OptiMove). |
| 2. Official token or exchanged token | B accepted → `api_token`; only C works → `exchanged_token` | `credential_kind` per connection; the Connect route accepts the kind the discovery proved, the other stays disabled for `gpexe` (both kinds remain storable, F3c1). |
| 3. Endpoint, header scheme, lifetime, rotation | A (scheme, path, exchange request field names), C (exchange with the reported scheme and the documented token field; the successful answer's field names), D (documented rule first; login test only under D.3) | The adapter's `scheme` and `exchangePath` constants; the decay period of `verified` (D7); whether Reconnect must be offered proactively. If D shows rotation on login, the runbook forbids UI logins with the API account. |
| 4. Dedicated account sees Team ID 980 | B or C `seesTeam` | A binding for team 980 is only created after a Test on this connection succeeds (section 3.8). |
| 5. Read-only team-list endpoint | B `teamListEndpoint` | If it exists, Test connection reads `team/` (one request, no team needed) and Connect offers the list to choose a source team from; if absent, Test reads the bound team's thresholds. |
| 6. Minimal scope | B's real GET results (200 on `team`, the team, thresholds, sessions) and the account's GPEXE role (owner, in the UI, words only). `OPTIONS Allow` describes what the **endpoint** supports; it is not by itself proof of what **this account** may do, and it says nothing about write rights the account may or may not hold. | The runbook states the smallest GPEXE role that answers GET on `team`, `team_session`, `athlete_session`, `track`; if the endpoints allow write methods, the account must be a read-only role or GPEXE support is asked for one. |

**GO for the adapter** = steps A and B (or A and C) returned, scheme word known, `seesTeam` yes,
and question 6 answered in words. Anything else = NO-GO, the adapter is not written, the owner
decides.

### 1.5 Step A result (owner-run, 2026-09-28, sanitized)

Run once by the owner in their own terminal, no credential involved; the owner returned only the
fields below.

| Field | Result |
|---|---|
| host key / API host | `e03` / `e03.gpexe.com` |
| auth scheme word (`WWW-Authenticate`) | `Token` |
| unauthenticated team-list status | `401` |
| exchange endpoint | `/api-token-auth/` (root, not under `/api/`) |
| exchange endpoint status with an empty body | `400` |
| exchange **request** field names | `username`, `password` |
| `/api/api-token-auth/`, `/api/token/` | `404`, `404` |
| GPEXE version header | `9.11.7 [release/stable]` |
| Team ID | `980` — access by any credential **not yet confirmed** |
| token field of a successful exchange answer | **not confirmed** (step A cannot see it) |

What this settles: the adapter's header scheme for `e03` is `Token <credential>`, and the only
exchange endpoint is `POST /api-token-auth/` with `username` and `password`. What it does not
settle: whether GPEXE issues a persistent read-only API token at all (step B), the token field
name of the exchange answer, token lifetime and rotation, whether the dedicated account sees
team 980, and the minimal role. U1/U2 (`server3`) stay unanswered by design.

**Owner decision 2026-09-28:** the owner's personal GPEXE account is **not** used for steps B or
C; a new explicit decision would be needed. The next step is one of two, decided by GPEXE's answer
to the support request below:

- **Case 1 — GPEXE issues a persistent read-only API token** for a dedicated account limited to
  team 980 → step B with `--auth-scheme Token` (section 1.2). `credential_kind = api_token`.
- **Case 2 — no such token; GPEXE gives a dedicated API username/password** → step C on the
  confirmed `/api-token-auth/` with `--auth-scheme Token`, `--exchange-path api-token-auth/` and
  `--token-field` from GPEXE's answer (or the legacy candidate `token` when it did not say; a 2xx
  without that field is dropped, one confirmed repeat at most — section 1.2).
  `credential_kind = exchanged_token`.

Support request sent by the owner (no secret in it):

> We need a dedicated read-only API credential for `e03.gpexe.com`, limited to Team ID `980`. Do
> you provide a persistent API token, or should a dedicated API username/password be exchanged
> through `/api-token-auth/`? Please also confirm the token lifetime/rotation policy and the
> successful response field containing the token. We do not need write permissions.

Until GPEXE answers and step B or C has been run and its form returned: no adapter, no route,
no PR for them.

#### Secret hygiene for steps B and C (own terminal only)

- The credential is typed through `Read-Host -AsSecureString` (masked), lives in a process
  environment variable for the one `node` call and is removed right after (`Remove-Item Env:…`);
  it is never a command-line argument, so it is never in the shell's command history.
- Before the run, keep the session's history out of the file:
  `Set-PSReadLineOption -HistorySaveStyle SaveNothing` (this PowerShell window only).
- Do not run inside `Start-Transcript`; do not redirect the script's output to a file inside the
  repository; the report contains no secret by construction, but the form in 1.3 is all that is
  returned to chat.
- Close the window afterwards; a new window has none of the variables.

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
