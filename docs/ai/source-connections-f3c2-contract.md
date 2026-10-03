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
| 1. Which approved host issues the credential | the host on which the exchange and the reads succeed | As written on 2026-09-28: `e03` the only approved key, `server3` not probed. Superseded on 2026-09-29 (section 1.8): the account's API host is `server3`, verified by the owner and approved by v28. |
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

### 1.6 Step C result (owner-run, 2026-09-29, sanitized): exchange refused

**Owner decision 2026-09-29:** without waiting for GPEXE support, one controlled step C with the
owner's existing GPEXE account was allowed for the initial pilot on `e03`, under these rules:
username and password never stored, never in the repository, chat, PR, log, screenshot, URL or
PowerShell history; typed masked; used for one `POST /api-token-auth/` only; the issued token
used for the read-only team check and dropped; only the sanitized form returned; no session
search, link or import.

| Field | Result |
|---|---|
| runs | exactly one; nothing repeated |
| host key / exchange path / scheme / token field candidate | `e03` / `api-token-auth/` / `Token` / `token` |
| exchange status | `400` |
| response field names | `non_field_errors` (the only field) |
| token issued | no |
| second request (team list) | not sent |
| access to Team ID 980 | **not confirmed** |
| GPEXE version header | `9.11.8 [release/stable]` (was 9.11.7 at step A) |
| secrets | none shown; environment variables removed |

What it means. The endpoint accepted the request shape (both required fields were present, so no
per-field error) and refused the **pair** as a whole. That is one of: the identifier typed is not
what this endpoint calls `username` (the UI may sign in with an e-mail or through its own
`/ui/v2/` authentication, a different system from the REST token endpoint); REST token
authentication is not enabled for this account; the account is inactive for the API; or a typing
error behind the masked prompt. The status alone cannot tell these apart, and the script
deliberately does not print the server's sentence.

**No further exchange attempt is made until the cause is narrowed without a credential.** A
repeated refused login is the one step here that can harm: it may count toward a lockout of the
owner's own account. The pilot decisions that were conditional on step C confirming team 980
(personal account for the pilot only, exchange-and-discard Connect form, later switch to a
dedicated account, Reconnect asking for the credentials again) are **not in force**; they stay
proposals until a step B or C confirms access.

Next safe diagnostic steps, none of which sends a credential or asks for one:

1. **The account still works in the UI** — the owner signs in to `e03-ui` as usual, in their own
   browser, and reports yes / no (rules out a lockout caused by the refused attempt).
2. **Which identifier the UI asks for** — the label of the first field of the UI login form
   (`Username`, `E-mail`, …) and, from the profile page, whether the account has a separate
   username different from its e-mail: reported as words only (`same` / `different` / `no
   username shown`), never the value.
3. **Which endpoint and request field NAMES the UI login uses** — only if the owner chooses to:
   DevTools → Network on the login request, reporting the path and the names of the body fields
   (for example `email`, `password`), never the values, no screenshot, no HAR. If the names or the
   path differ from `/api-token-auth/` + `username`, the UI and the REST token endpoint are
   separate authentication systems and only GPEXE can enable REST access.
4. **GPEXE support** — add to the open request: "`POST /api-token-auth/` on `e03` answers 400
   `non_field_errors` for an account that signs in to `e03-ui`. Is REST token authentication
   enabled per account, and which identifier does it expect?"

Only after 1–3 (or GPEXE's answer) name a concrete, different input — a confirmed identifier
kind, or a dedicated account — is one more step C allowed, by a new explicit owner decision.

### 1.7 Credential-free checks 1 and 2 (owner, 2026-09-29): field names only

Checked by the owner without any new login request. No screenshot is used or kept (it would show
an e-mail address); only field NAMES are recorded, never a value.

| Check | Result |
|---|---|
| the account's existing signed-in `e03-ui` session | works (no lockout observed) |
| first field of the `e03-ui` login form | labelled `email` |
| second field | labelled `password` |
| a separate `username` field on the login form | none |
| REST exchange endpoint's request fields (step A) | `username`, `password` |

**The UI identifies the account by `email`; the REST token endpoint asks for `username`.** The
two names differ, and that is all that is proven. It is **not** determined whether REST token
authentication is simply not enabled for this account, or whether the UI and the REST API keep
separate account records; both fit the one refused exchange (section 1.6), and nothing available
without a credential or GPEXE's answer can separate them.

Consequences, binding until a token is actually issued:
- **Step C is not repeated.** Its result stands: `POST /api-token-auth/` refused the pair with
  `400` `non_field_errors`.
- **No adapter and no Connect route may claim or assume that this account will work.** Nothing is
  built on an `e-mail + password → token` exchange: it has never succeeded. The adapter is written
  only after a step B or a step C has really returned a token and read Team ID 980.
- The Connect form's field for the exchange kind is not named here; whether it is a username or
  an e-mail is part of what a successful exchange (or GPEXE) has to establish.
- The open question goes to GPEXE support (section 1.6, item 4), extended by one sentence: "The
  UI signs in with an e-mail; does `/api-token-auth/` expect a separate username, and is REST
  access enabled per account?"

**State of the discovery: NO-GO for the adapter.** Known: host `e03`, scheme `Token`, exchange
endpoint `POST /api-token-auth/` with `username` and `password`. Unknown: the credential kind
that exists for OptiMove, the token field of a successful answer, lifetime and rotation, access
to Team ID 980, the minimal role.

### 1.8 Owner confirmation (2026-09-29): this account's API host is `server3`, family `rest/v1`

The owner confirmed that their existing Google Apps Script integration still works today with
the same account, and how (no credential involved in the statement):

| Item | Value for this account |
|---|---|
| UI host | `e03-ui.gpexe.com` |
| API host | `server3.gpexe.com` |
| API family | `rest/v1` (data read from `https://server3.gpexe.com/rest/v1/...`) |
| exchange | `POST https://server3.gpexe.com/api-token-auth/` |
| token field of the successful answer | `token` |
| header | `Authorization: Token <token>` |
| credential kind | `exchanged_token` |

Consequences:
- **Every further authentication attempt on `e03` is stopped**; the script's exchange mode
  refuses that host. Section 1.6's refusal is plausibly explained by the account's REST access
  living on another server; that is an inference, not a proof — why `e03` answered
  `non_field_errors` stays undetermined.
- **This is not yet permission to add `server3` to production.** `server3` stays out of
  `backend/src/sourceHosts.js` and out of `training_load.source_host_catalog` until the one
  sanitized verification below has succeeded and the owner has accepted the follow-up PR.
- **A host key never implies paths.** The architecture distinguishes four things per server,
  and `server3` + `rest/v1` is its own adapter profile, not "e03 with another host name":

  | Part | `e03` | `server3` |
  |---|---|---|
  | `host_key` | `e03` | `server3` |
  | exact base URL | `https://e03.gpexe.com/` | `https://server3.gpexe.com/` |
  | API family (path prefix) | `api` (`api/`) | `rest_v1` (`rest/v1/`) |
  | auth scheme / exchange path | `Token` / `api-token-auth/` | `Token` / `api-token-auth/` |

  The importer's current client (`backend/src/gpexeClient.js`) and mapper were written and
  verified against the `api` family of `e03`. Nothing proves that `rest/v1` returns the same
  resources, field names, paging or units; that comparison is part of the adapter work, after
  the verification, never assumed.

#### The one sanitized read-only verification on `server3`

For this verification `backend/scripts/gpexe-auth-discovery.mjs` carried its own profile for
`server3`, with the exact URL fixed in the script, while the application's allowlist did not know
the key yet (superseded on 2026-09-29: the script now takes both hosts from the application's
catalog and holds no URL of its own). `--api-family` is refused when it does not match the
host's profile. One run sends exactly four requests, all to `https://server3.gpexe.com/`. The
command block below is the historical first run; today the script takes the exchange path, the
`form` encoding, the token field and the scheme from the host's confirmed profile and refuses a
flag that says otherwise:

1. `POST /api-token-auth/` — the one exchange (username and password in the body, once);
2. `GET /rest/v1/team/` — the team list (a 404 here is a finding, not a failure);
3. `GET /rest/v1/team/980/` — the team itself;
4. `GET /rest/v1/team_session/?team=980&limit=1` — one small session page.

No session search over dates, no athlete read, no link, no import, no write; the token is
dropped when the process ends. Own PowerShell window, one command after the other:

```powershell
cd C:\Users\user\Downloads\ProgramAPp; Set-PSReadLineOption -HistorySaveStyle SaveNothing; Test-Path Env:GPEXE_API_TOKEN
```

```powershell
$u = Read-Host "GPEXE username" -AsSecureString; $env:GPEXE_USERNAME = [System.Net.NetworkCredential]::new("", $u).Password; Remove-Variable u
```

```powershell
$p = Read-Host "GPEXE password" -AsSecureString; $env:GPEXE_PASSWORD = [System.Net.NetworkCredential]::new("", $p).Password; Remove-Variable p
```

```powershell
try { node backend/scripts/gpexe-auth-discovery.mjs --mode exchange --host server3 --api-family rest_v1 --team 980 --exchange-path api-token-auth/ --auth-scheme Token --token-field token } finally { Remove-Item Env:GPEXE_USERNAME, Env:GPEXE_PASSWORD -ErrorAction SilentlyContinue }
```

```powershell
Test-Path Env:GPEXE_USERNAME; Test-Path Env:GPEXE_PASSWORD; Test-Path Env:GPEXE_API_TOKEN
```

Returned to chat: only the JSON the script printed (or these fields from it): `hostKey`,
`apiFamily`, `discoveryOnlyHost`, `findings.exchangeStatus`, `successResponseFieldNames`,
`exchangeReturnsTokenField`, `exchangedTokenWorksAsScheme`, `teamListEndpoint`, `teamCount`,
`teamStatus`, `sessionPageStatus`, `sessionPageHasRows`, `seesTeam`, and per request the masked path, status, field
names and counts. Run once; a refusal or an error is the finding, never a reason to repeat.

**Success** = `exchangeStatus` 200, `exchangeReturnsTokenField` true, `seesTeam` true (which
needs the team list to name team 980 or `teamStatus` 200 — the team's own read) and
`sessionPageStatus` 200. The session page is supporting evidence only: a 200 page may be empty,
or the server may ignore the team filter, so it never sets `seesTeam` by itself
(`sessionPageHasRows` is reported separately). If `rest/v1` has neither a team list nor a team
read, `seesTeam` is `null` (unknown): that is a NO-GO to be discussed, not a success.

#### Result of the verification run (owner-run, 2026-09-29 19:27 UTC, sanitized): refused

| Field | Result |
|---|---|
| runs | one |
| host key / family / scheme / token field | `server3` / `rest_v1` / `Token` / `token` |
| request | `POST api-token-auth/`, body encoding `json` |
| exchange status | `400` |
| response field names | `non_field_errors` |
| `Allow` of the endpoint | `POST, OPTIONS` |
| token issued | no; the three GETs were not sent |
| access to Team ID 980 | **not confirmed** |
| GPEXE version header | `9.11.8 [release/stable]` |
| environment variables afterwards | removed (three `False`) |

`server3` refused the pair exactly as `e03` did. Two refused exchanges have now been sent with
this account (one per host). **No further exchange is sent without a new explicit owner
decision**, and not before the difference to the working integration is narrowed.

#### Structural comparison with the working Apps Script (no value read out)

The main session ran a check over the untracked legacy file `gpexe-code-check.js` that prints
only counts, keywords and booleans — never a line of the file or any part of a value:

| Property | Legacy script | Discovery run |
|---|---|---|
| exchange body field names | `username`, `password` | `username`, `password` |
| body encoding | a plain `payload` object, no `contentType` → `application/x-www-form-urlencoded` | `application/json` |
| token read from | field `token` | field `token` |

What this leaves, in the order of likelihood:
1. **The typed pair is not the pair the script holds.** The script works today, so its stored
   pair is valid for REST. If the UI password was ever changed, or the REST record is separate
   from the UI record (section 1.7), the UI password the owner types is not the REST password.
   Only the owner can check this, privately: is the e-mail in the script the one typed, and is
   the script's password the one typed? Answer yes / no per item, never the values.
2. **The body encoding.** The server did read the JSON fields (an empty JSON body names both
   fields as required, a filled one answers `non_field_errors`), so JSON is parsed; a form-only
   credential check is unlikely but not excluded. The script now has `--body-encoding form` to
   reproduce the working integration's wire format exactly; one encoding per run, never both.
3. A typing error behind the masked prompt.

**Security note (owner action).** `gpexe-code-check.js` holds the account's identifier and
password as plain literals, in the repository folder, untracked and **not ignored**. One careless
`git add` would publish them. Move the file out of the repository folder (or at least add it to
`.gitignore`), and consider changing that password once OptiMove's connection exists.

#### Second verification run (owner-run, 2026-09-29 19:39 UTC, sanitized): SUCCESS

By an explicit owner decision one more exchange was sent, this time with exactly the pair the
working integration holds (the club's existing GPEXE account, not the owner's personal UI
login) and with the body form-encoded. Both inputs changed at once, so the run does not tell
which of the two made the difference; the adapter therefore sends the exchange form-encoded, the
one format proven to work.

| Field | Result |
|---|---|
| host key / API family / prefix | `server3` / `rest_v1` / `rest/v1/` |
| exchange | `POST api-token-auth/`, body `form`, status `200` |
| successful response field names | `token` (the only field) |
| header scheme | `Token` — accepted on all three reads |
| `GET rest/v1/team/` | `200`, array, `X-Total-Count` 8, **contains team 980** |
| `GET rest/v1/team/980/` | `200` |
| `GET rest/v1/team_session/?team=980&limit=1` | `200`, array of 1, `X-Total-Count` 308, a `Link` header (header paging, as on `e03`) |
| `seesTeam` | **true** (from the list and from the team's own read) |
| GPEXE version | `9.11.8 [release/stable]` |
| secrets | none in the output; environment variables removed |

Field names seen (names only). Team: `club`, `controller_ip`, `default_teamsession_category`,
`end_date`, `id`, `licence`, `locked`, `name`, `preferred_ground`, `rpe_format`, `season`,
`sport`, `start_date`. Team session: `category`, `category_name`, `created_on`, `drillTags`,
`drill_enabled`, `drills`, `drills_count`, `end_timestamp`, `id`, `is_stats_valid`, `maxStop`,
`minStart`, `n_tracks`, `name`, `notes`, `start_timestamp`, `submitted_by`, `tags`, `team`,
`total_time`, `union_duration`, `updated_on`.

**What is now confirmed for this account**

| Question of section 1.4 | Answer |
|---|---|
| 1. Host that issues the credential | `server3.gpexe.com` (not `e03`) |
| 2. Credential kind | `exchanged_token`: username + password → token, through `POST /api-token-auth/`, form-encoded |
| 3. Endpoint / scheme / token field | `/api-token-auth/` / `Token` / `token`. Lifetime and rotation: **still unknown** |
| 4. Sees Team ID 980 | yes |
| 5. Read-only team-list endpoint | exists: `GET rest/v1/team/` |
| 6. Minimal scope | **not minimal.** The account sees 8 teams, and the endpoints advertise write methods (`POST` on the lists, `PUT` / `PATCH` on the team). `Allow` describes the endpoint, not the account's rights, so whether this account may write is unknown; OptiMove sends `GET` only (and the one exchange `POST`). |

**Risks recorded with the success**
- The account is broader than the pilot needs (8 teams). A binding must name team 980
  explicitly, and the adapter must refuse every source team id that is not the bound one.
- The account is the club's shared account and is also used by the existing Apps Script; if the
  token is one-per-user and a new exchange rotates it, OptiMove's Connect could break that
  integration or the reverse. Unknown until lifetime / rotation is answered (section 1.2 step D,
  documentation first). To be answered before the first Connect in production.
- `rest/v1` on `server3` is not the `api` family on `e03` the importer was verified against.
  The session field names look alike, but resources, drill and athlete-session details, units and
  paging must be compared request by request in the adapter work; nothing is assumed.

**Temporary owner decisions, now in force for the initial pilot** (owner, 2026-09-29):
- the existing account is allowed for the initial pilot only;
- the production design keeps supporting a later switch to a dedicated API account without a
  schema change (a new credential on the same connection, or a new connection);
- the application may have a Connect form with username and password, but the backend exchanges
  them for a token at once and drops them;
- only the token is stored, AES-256-GCM encrypted as v27 defines;
- Reconnect asks for username and password again;
- the password is never returned to the client and never shown as stored.

**GO** for the small allowlist PR below (ordered by the owner on 2026-09-29). The adapter and
the routes still wait for the owner's order.

#### The `server3` profile PR (owner order 2026-09-29; as built)

Branch `feature/source-hosts-server3-profile`. No credential, no connection, no binding for
team 980, no route, no adapter for real data, no GPEXE request. External review required
(migration, host allowlist, network boundary); never declared merge-ready by the main session.

- **`backend/src/sourceHosts.js`: every host is a complete profile.**

  | Part | `e03` | `server3` |
  |---|---|---|
  | exact base URL | `https://e03.gpexe.com/` | `https://server3.gpexe.com/` |
  | API family → prefix | `api` → `api/` | `rest_v1` → `rest/v1/` |
  | auth scheme | `Token` | `Token` |
  | exchange | none (never confirmed there) | `api-token-auth/`, encoding `form`, token field `token` |

  `sourceApiUrl(source, hostKey, catalogRow, resourcePath)` is the one way to build a data URL:
  the host's base URL, the host's own family prefix, then a relative resource path that cannot
  leave that prefix (no leading slash, no dot, no colon, no empty segment, a plain query only).
  `sourceExchange(source, hostKey, catalogRow)` answers for that host only and is
  `exchange_not_supported` on `e03`. Both go through the gate themselves: without the key's own
  approved catalog row there is no URL. Every host must lie under its source's domain
  (`.gpexe.com`), checked when the module loads.
  Known duplication, recorded: the importer's client (`backend/src/gpexeClient.js`) still has its
  own constant for the `e03` root and does not go through the catalog; a test ties the two values
  together, and the adapter work replaces the constant. No function takes a URL, iterates over hosts, or tries a second host, family or
  encoding; an unknown key, family or encoding is refused (profiles are validated when the
  module loads, and everything is frozen).
- **Migration v28** (`migrations_v2/202609291000_training_load_v28_source_host_server3.sql`):
  one `insert` of the approved row `gpexe` / `server3`. Data only — the structure of v27 is
  unchanged (the test compares the whole catalog of functions, triggers, indexes, columns and
  constraints before and after).
- **Rollback** (`docs/runbooks/source-hosts-v28-rollback.sql`): removes that one row and the v28
  record, and refuses, changing nothing, once any connection uses `server3`, once the row is not
  what v28 inserted, or once a later migration is recorded. The v27 rollback refuses while v28
  is recorded.
- **The discovery script** takes both hosts' URL and family from the application's catalog; it
  holds no URL of its own any more.
- **The legacy credential file** was moved out of the repository folder by the owner's order and
  is listed in `.gitignore`; it was never tracked, committed or stashed.

#### One account, eight teams: the binding rule for the adapter (not yet enforced in code)

The verified account sees 8 GPEXE teams. OptiMove needs one. A binding and every request must be
limited to Team ID 980. **Nothing in the code enforces that today**, because no adapter exists:
`sourceApiUrl()` scopes the host and the API family only and would build a URL for any team id.
The rule below binds the adapter work (F3c2), where it gets a team-scoped builder and its own
tests (team 981 refused, a duplicate `team` key refused):
- a binding names exactly one source team id (`980` for the pilot team), and v27 already allows
  one active OptiMove team per source team across every connection;
- the adapter builds every data request from the **bound** source team id only; a source team
  id from a request body, a query string or a source answer is never used to read;
- the team list (`team/`) is read to verify that the bound team is visible, never to import or
  to offer the other seven to a coach;
- a session whose `team` field is not the bound id is refused as inconsistent source data
  (the `team` filter may be ignored by the server; the answer is checked, not trusted);
- OptiMove sends `GET` only (plus the one exchange `POST`), whatever the endpoints advertise.

---

## 2. Source-neutral shape of F3c2 (what is built after GO)

Names below are the contract; the code may only narrow them. GPEXE is the first adapter, not the
name of anything.

### 2.1 Adapter interface (per `source_system`)

```
sourceAdapter(sourceSystem, hostProfile) → {              // hostProfile = { hostKey, baseUrl, apiFamily, exchangePath, authScheme }
  // one adapter PROFILE per (source, apiFamily): gpexe/api and gpexe/rest_v1 are two profiles;
  // a host key selects its profile, it never rewrites another profile's paths
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
`linked_untested` row. F3c2 either adds a small migration (the next free number; v28 is the
`server3` catalog row)
(`check (state <> 'linked_untested' or last_error_code is not null)`) or, at least, a route test
that every write of `linked_untested` carries both facts; the choice is recorded in the F3c2 PR.

A credential is encrypted with `encryptCredential(plaintext, context, keyring)` where the context
is the row's own seven fields; the plaintext exists only in the request handler's scope and is
overwritten with nothing kept once encrypted; the exchange password is used for the one POST and
dropped.

---

### 2.5 F3c2d as built (owner order 2026-10-03; branch `feature/gpexe-connect-routes-f3c2d`; not merged)

`backend/src/routes/sourceConnections.js` (mounted at `/api/training-load/sources`) and
`backend/src/sourceConnectionService.js`; runbook `docs/runbooks/source-connections-f3c2d.md`.
Where this narrows or settles the table above:

- **Routes delivered:** `GET …/connections?clubId=`, `GET …/connections/:id`, `POST
  …/connections` (create), `…/connect`, `…/reconnect`, `…/test`. **Not in this step:** `POST
  …/bindings` (teams are bound separately; no route binds, and no route derives a binding from
  the account's visible teams), Disconnect (D5), `api_token` entry, club-admin management (D2
  stays platform admin only).
- **Owner:** `ownerScope: "club"` only (D4); `owner_scope_unsupported` otherwise.
- **Credential kind:** `exchanged_token` only (`credential_kind_unsupported` otherwise): Connect
  and Reconnect take `{ username, password }` for that one HTTPS request, exchange them once on the
  host's confirmed exchange (`sourceExchange()`: `server3`, form-encoded, token field `token`) and
  drop them; only the AES-256-GCM parts of the token are stored (F3c1 crypto, the row's own
  context as AAD). The username, the password and the token are never returned, logged, audited
  as values or named in an error.
- **Host:** at create and before every network call the key must be approved in the catalog
  (row read `FOR SHARE` in the transaction) **and** resolve in `sourceHosts.js` **and** have a
  confirmed exchange **and** speak a family with a read adapter — today exactly `server3` /
  `rest_v1`; `e03` answers `exchange_not_supported`; no fallback (conditions 1 and 7).
- **Test connection:** the F3c2c adapter, one instance per bound team limited to that team
  (`verifyBoundTeam()`, the team's own read); while no team is bound, the team list **count** only
  (`countVisibleTeams()` with a placeholder the adapter never sends as a team) — the eight visible
  teams are counted, never listed back, never chosen, never bound. An archived bound team is
  skipped (`boundTeamsChecked` says how many were read).
- **Lock order (conditions 2–4):** per-user advisory lock (one user's attempts are serialized;
  the wait is bounded at 20 s, then `try_again`; every statement of the attempt has a 10 s
  `statement_timeout` except that one lock statement, which runs under `lock_timeout` 20 s and a
  `statement_timeout` of 22 s so the lock bound decides; the transaction's idle time and the
  source calls a 90 s budget) →
  connection row `FOR NO KEY UPDATE` under `lock_timeout` 2 s (`try_again`; the audit
  row of a refused attempt needs KEY SHARE only, so it never waits on a running attempt) → bound
  team ids (`source_connection_bound_team_ids`) → reconnect confirmation → catalog row `FOR
  SHARE` + host gate → every bound team's `hold_gpexe_team_lock` ascending (try-lock, `try_again`)
  → throttle count → key ring → network. The locks are held through the source call.
- **Throttle (condition 4, D10):** attempts that reached the source (`ok` / `failed` / `unknown`,
  plus `refused` with `source_auth_rejected`) in 15 minutes, per connection **and** per user, from
  the append-only audit; 5 or more → `429 source_auth_throttled`, `Retry-After: 900`. Every other
  refusal is audited with `counted: false` and never counted, so a retry after 429 cannot extend
  the lockout; a Test does not reset the count. The window and every fact timestamp come from the
  database's own clock (`now()` in SQL; a test may substitute one). An attempt that reached the
  source and then could not be stored (a database failure, a right revoked or a club archived
  meanwhile) is still audited on a fresh connection as `unknown` (`attempt_not_recorded`) or
  `failed` (`rights_changed`) with `counted: true` — both outcomes the throttle counts — and the
  answer never says the source was not reached; that row lands on a fresh pool connection after
  the user's lock was released, so a further attempt of that user may start before it counts (the
  lock is not held across that insert; an attempt that reaches the source holds it through the
  source call). Every
  checked-out database client carries an error listener while it is out of the pool, so a
  session ended by the server during the source call (idle timeout, pooler reset) fails the next
  statement instead of crashing the process.
- **Reconnect confirmation (D11):** `confirmation: { sourceSystem, ownerClubId, affectedTeamCount }`
  must equal the row's source, owning club and current number of active bound teams, checked under
  the row lock before any request; `409 confirmation_mismatch` carries `expected`.
- **States (2.4):** connect / reconnect + test ok → `verified`; test read 401 (or 403 on the team
  list count) → `needs_reconnect` (new ciphertext stored); a bound team's read answering 403 / 404
  is `source_team_not_visible` (the account cannot read that team); any other failed test read after a stored credential
  → `linked_untested` with `last_error_code` / `last_error_at` (v29 enforces both facts); a Test
  on an existing credential: ok → `verified` and the error facts cleared, 401/403 →
  `needs_reconnect`, anything else (`source_unavailable`, `source_answer_unexpected`,
  `source_team_not_visible`) → `source_unavailable` with that code. A refused or failed exchange
  stores nothing and leaves the state as it was (a reconnect keeps the old credential; nothing
  then says whether it still works).
- **Audit (condition 5):** one row per attempt in the attempt's transaction; a refusal before the
  network in its own short transaction; metadata keys only `host_key`, `credential_kind`,
  `status_class`, `attempt_no`, `bound_team_count`, `source_team_count`, `counted`.
- **COMMIT outcome:** the F2 discipline — answer awaited 15 s, then the audit row looked for on a
  fresh connection (5 s): found → `commitConfirmation: verified_after_commit_error`; not found →
  `503 outcome_unknown` and a second audit row `unknown` by the same admin and basis.
- **Codes added to the table of 2.3 (6):** `already_connected`, `not_connected`,
  `confirmation_mismatch`, `owner_scope_unsupported`, `exchange_not_supported`,
  `adapter_not_available`, `credential_unreadable`, `invalid_body`, `attempt_not_recorded`,
  `rights_changed`; `outcome_unknown` as above. A read the route makes after a confirmed COMMIT
  never changes the answer: it fails as `connectionReadError: true` beside the result.
- **Fact gap closed by migration v29** (`202610031000_training_load_v29_source_connection_state_facts.sql`):
  `linked_untested` carries both facts; every state but `not_connected` holds a credential; a
  partial index for the per-user window. Rollback `docs/runbooks/source-connections-v29-rollback.sql`,
  rehearsed on a disposable database in `backend/tests/source-connections-f3c2d.test.mjs`.
- **Recorded for the integration PR, not built here:** an incomplete drill set is never shown
  as complete; an empty but successfully read `players` drill answer is a valid empty drill and
  stays distinct from a failed read; tag names are HTML-escaped in the future UI; the raw-snapshot
  decision (projection or redacted body) stays open; `GPEXE_IMPORT_APPLY_ENABLED` stays off and
  the importer is not wired to a connection (D8's env fallback unchanged).

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
