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

### 2.2 Routes (platform admin, or the owning club's admin in that club's workspace — owner decision 2026-10-03, see 2.6; D2 is thereby settled as "both")

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
  stays platform admin only). **Superseded by 2.6 (F3c2e):** the bindings route exists, the club
  admin manages the club's connection, and Connect / Test return the teams the credential sees.
- **Owner:** `ownerScope: "club"` only (D4); `owner_scope_unsupported` otherwise.
- **Credential kind:** `exchanged_token` only (`credential_kind_unsupported` otherwise): Connect
  and Reconnect take `{ username, password }` for that one HTTPS request, exchange them once on the
  host's confirmed exchange (`sourceExchange()`: `server3`, form-encoded, token field `token`) and
  drop them — the pair is copied out of the request body at validation, the body object loses the
  two fields at once, only that copy lives until the exchange, and it is dropped in every outcome; only the AES-256-GCM parts of the token are stored (F3c1 crypto, the row's own
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
  database's own clock (`now()` in SQL; a test may substitute one). **What is counted is one
  logical attempt that really invoked a request to the source:** every audit row of an attempt
  carries its `attempt_id` and the throttle counts distinct ids, so an attempt's committed row and
  a later `unknown` row of the same attempt count once; "reached the source" becomes true at the
  fetch invocation itself (the exchange and every adapter read go through one tracked fetch), so a
  Test whose network budget was already spent sends nothing and is a local refusal
  (`network_budget_exhausted`, `counted: false`, the state unchanged); any other read failure with
  zero requests sent is the local refusal `attempt_not_sent` (503), also uncounted. An attempt that reached the
  source and then could not be stored (a database failure, a right revoked or a club archived
  meanwhile) is audited as `unknown` (`attempt_not_recorded`) or `failed` (`rights_changed`) with
  `counted: true` **in the attempt's own transaction** — back to a savepoint taken after the locks,
  the row inserted, the bounded COMMIT — so every lock, the per-user lock included, is held until
  that row is committed and the next attempt of that user, waiting on that lock, already sees it;
  a fresh, bounded connection is the fallback only when that session is unusable (then the user
  lock is already gone — the documented residual).
  The answer never says the source was not reached. Every
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

### 2.6 F3c2e as built (owner order and amendment 2026-10-03; branch `feature/gpexe-team-binding-f3c2e`; not merged)

Discovery: `docs/ai/source-connections-f3c2e-discovery.md`. v27 already holds the binding table,
its two partial unique indexes, the owner / host / team-move triggers and the `bind` audit action
with a mandatory `team_id`; v29 the state facts. **Migration v30** (owner decision 2026-10-04,
after the security review of the first build) keeps the approved GPEXE Team ID of a bound team
final while its binding is active (discovery section 4).

- **The allowlist (owner decision 2026-10-04, security HIGH F-1 option (a)):** the existing
  `gpexe_team_settings` row of an OptiMove team is the platform-admin-approved pair `OptiMove team
  ↔ GPEXE Team ID`; the platform admin sets or changes it through the F3b Settings route (reason,
  history). A binding may only bind that exact pair, whoever calls (`team_setting_missing` /
  `team_setting_mismatch`, locally, zero requests); nobody adds a Team ID to the allowlist through
  the bind route; a club admin sees and may choose only the GPEXE teams that match an approved pair
  of an active team of their club (the server-side intersection of the visible teams, the club's
  active teams and their current settings — no name, id, count or other fact of the rest), a
  platform admin the bounded, annotated list; `sourceTeamsTruncated` is reported to both. While a
  binding is active the approved Team ID cannot change: `setTeamSettings()` answers `409
  gpexe_team_bound` (pre-check under the team lock; the v30 trigger `23514
  gpexe_team_settings_bound_team_final` mapped to the same code, never SQL text); the same value
  stays idempotent; without an active binding the F3b change works as before. **The database
  guarantees the pair in both directions (v30, after the owner's external review):** an active
  gpexe binding that is not its team's exact approved pair (pointer, setting present, canonical
  ids equal) is refused on INSERT (`source_team_bindings_approved_pair`), and one OptiMove team per
  canonical GPEXE team is a unique index (`gpexe_team_settings_canonical_team_id_key`; the
  service answers `gpexe_team_taken`; Connect / Test withhold the team list fail-closed as
  `sourceTeamsUnavailable: approved_pairs_ambiguous` should duplicates exist anyway — the check is
  global over every club's settings, not only the owning club's, and withholds the whole answer for
  every basis whenever such a duplicate names a team the source offers or a pair of the owning club;
  a duplicate between other clubs that names neither is not this connection's concern). A successful
  bind's audit row says `counted: false`; a source-reaching bind that did not succeed `counted:
  true`; a local refusal `counted: false`.

- **Who (replaces the F3c2d narrowing of D2):** one authorization path with two bases. An active
  platform admin in the platform workspace or in the owning club's workspace (`platform_admin`),
  or an active club admin in the club workspace of their own active club (`club_admin`). Another
  club's admin, an admin of two clubs acting in the other club's workspace, a coach, an athlete, a
  revoked role, an archived club or team, a foreign team, an unknown or malformed id: the same
  `404`. The right and the club are re-checked `FOR SHARE`, by basis, after every source call and
  before any write (`rights_changed` otherwise). The audit basis is the context's basis. Coaches
  get nothing from these routes.
- **The team list (condition 8 settled):** Connect and Test read the first page of `team/`
  (adapter `listVisibleTeams()`: canonical id and a sanitized name per row, the total; a row
  without a canonical id, a duplicate id or more rows than a page refuse the list) and then every
  active bound team's own read; the result carries `sourceTeams` (`sourceTeamId`, `name`) and
  `sourceTeamCount`. Nothing is preselected, stored or bound from it. The flow is Connect account →
  Test connection → Choose GPEXE team → Choose OptiMove team of the same club → Review → Confirm
  binding; the chosen team is read again, alone, by the bind.
- **`POST …/connections/:id/bindings` `{ teamId, sourceTeamId }`** (the only fields; a
  canonical source team id per source — gpexe: `^(0|[1-9][0-9]{0,11})$`): a branch of the same
  attempt as Connect / Reconnect / Test. Order: body (`400` before any lock) → unlocked read of the
  connection and the team (`404` unless the team exists, is active and is in the owning club) →
  per-user lock → connection row `FOR NO KEY UPDATE` → the same binding again is `200 idempotent`
  (no row, no request, no audit) BEFORE any state gate, so a retry after an unknown outcome gets
  its binding even when a Test moved the state meanwhile → state `verified` or `409
  connection_not_verified` → the caller's own team already bound for the source is `409
  team_already_bound` before
  any request → catalog row `FOR SHARE` + `resolveApprovedSourceHost()` → every active bound
  team AND the target team, ascending, once each, `hold_gpexe_team_lock(team, 'bind')` try-lock
  (`try_again`; the same rule as a credential attempt, because a refused credential during the
  bind changes the connection's state; a team move takes the same lock, so none can start
  meanwhile) → the team's `gpexe_team_settings` `FOR SHARE` — the approved pair: missing → `409
  team_setting_missing`; another canonical Team ID → `409 team_setting_mismatch`; the same → the
  provenance pointer; never written (D12) → the throttle count (below) → key ring, decrypt → one
  `GET team/<sourceTeamId>/` through the adapter bound to that id → rights and club re-checked →
  the team row `FOR SHARE` only now, re-qualified (archived or moved meanwhile → the same 404,
  nothing bound, but audited and counted as `failed` / `team_not_available` because the source was
  reached, a refused credential still turning the state to `needs_reconnect`; a rename or an
  archive never waits behind a slow source) → only after the chosen
  team's read succeeded: a source team bound to another team is `409 source_team_already_bound`
  (an id the credential cannot see is `source_team_not_visible` either way, so no other club's
  binding is confirmed to exist; the v27 unique index is the backstop, mapped by its exact name,
  any other unique violation `binding_refused`) → binding row + audit `bind`
  (`team_id`; metadata adds `source_team_id`, a non-secret key by the v27 predicate, tested against
  the SQL backstop) → bounded COMMIT
  (`verified_after_commit_error` / `503 outcome_unknown` with `teamId`; the second `unknown` row
  names the team; the retry is idempotent). Read outcomes: `401` → `409 source_auth_rejected`,
  state `needs_reconnect`; `403` / `404` → `409 source_team_not_visible`; `429` / 5xx / network /
  timeout → `502 source_unavailable`; redirect / oversized / non-JSON / another id / non-object →
  `502 source_answer_unexpected`; each audited with the team, nothing bound, the credential kept.
  A bind that reached the source and did not succeed (`failed`, `unknown`, or `refused` with
  `source_auth_rejected`) counts in the same 5 / 15 min window as a credential attempt — the
  stored token is sent either way —, and a bind is refused with `429 source_auth_throttled` when
  the window is full; a successful bind is exempt (its repeat is a local no-op). The per-user
  count of bind rows runs outside the v29 partial index (no migration for it; the window is
  small). `55P03` and `40P01` are both `try_again`. The insert's database refusals map to stable
  codes (`23505` → the two conflicts by exact index name, `P0001` → `try_again`, the v30 pair
  trigger's `23514` → `team_setting_missing` / `team_setting_mismatch` by constraint name, any other
  `23514` / `23503` → `binding_refused`).
  Out-of-transaction audit rows are written under the row `lock_timeout`.
- **Lock order proof (condition 3 kept):** the connection row is taken before the team's
  try-lock; the trigger's reverse order is a try-lock; a Connect / Reconnect / Test of the same
  connection is serialized by the row (`try_again` at once); a team move or archive is a row lock
  the bind waits for only within `lock_timeout`; a Check now / import holding the team lock makes
  the bind `try_again` with zero requests.
- **Not in this step:** Unbind, Disconnect, Delete, replacing a binding, binding any of the eight
  visible teams automatically, the importer credential resolver and the cut-over (a later step), F3c3 UI.

### 2.7 F3c2f as built (owner order 2026-10-04; branch `feature/gpexe-unbind-f3c2f`; not merged)

Discovery: `docs/ai/source-connections-f3c2e-discovery.md` section 7. No migration.

- **Route:** `POST /api/training-load/sources/:source/connections/:id/bindings/:bindingId/unbind`
  `{ requestKey, reason, expected: { teamId, sourceTeamId } }` — nothing else (`400 invalid_body`
  for an unknown field, a missing / empty / multi-line / over-long reason, a non-UUID
  `requestKey`, a malformed `expected`). The same authorization path as F3c2e (an active platform
  admin in the platform or the owning club's workspace, or the owning club's active admin in that
  club's workspace); a coach, another club's admin, a wrong workspace, an archived club, a binding
  of another connection or club, an unknown or malformed id: the same `404`; without a session
  `401`. The right and the club are re-checked `FOR SHARE` right before the write.
- **Local only:** no request to the source, no exchange, no credential change (the connection
  need not be `verified`), nothing deleted; the binding row goes `active` → `ended` with
  `ended_at`, `ended_by_user_id`, `end_reason`; the settings row and the provenance pointer stay;
  GET lists active bindings only and the ended row stays readable history.
- **Lock order:** per-user lock → connection row `FOR NO KEY UPDATE` → the request record (a
  replay is answered here, before any team lock, so a retry of a lost answer never meets a busy
  team) → the TARGET team's import try-lock only (an Unbind changes neither the credential nor the
  connection's state, so condition 3's "every bound team" — the rule for credential attempts —
  does not apply; an import of a sibling team never blocks the remedy) → the binding row
  `FOR UPDATE` → checks → rights → UPDATE (`where state = 'active'`; the v27 immutability trigger
  allows exactly this change and re-takes the held try-lock) → audit `unbind` → bounded COMMIT.
  `55P03` and `40P01` are `try_again`; nothing waits without a bound. An import, a Check now, a
  Settings change, a bind or a team move of THAT team holding its lock makes the Unbind answer
  `try_again`; an Unbind in flight makes them answer at once (`try_again` / `gpexe_change_busy` /
  the trigger's `P0001`). `ended_at` is the real moment (`clock_timestamp()`), not the
  transaction's start.
- **Outcomes:** the active binding ended → `200` `{ result: { action: "unbind", outcome: "ok",
  replayed: false, binding: { bindingId, teamId, teamName, sourceTeamId, state: "ended", boundAt,
  endedAt, endedByUserId, endReason }, auditId, sourceContacted: false }, connection }`; the same
  `requestKey` again (same user, same body) → `200` with `replayed: true`, the same `auditId` and
  facts, no second UPDATE and no second audit row; the same key with another body or for another
  binding of the connection → `409 request_key_reused` (the record names the binding it ended,
  `binding_id` in its metadata; the answer's `current` describes THAT binding, so its `bindingId`
  may differ from the path's — a client compares `current.bindingId` before showing it as the
  requested binding's state); a new key on an already ended binding → `409 binding_already_ended` with
  `current { bindingId, teamId, sourceTeamId, state, endedAt }`; an `expected` pair that is not the
  binding's → `409 binding_mismatch` with `current`; a COMMIT whose answer was lost →
  `commitConfirmation: verified_after_commit_error`; an unverifiable COMMIT → `503 outcome_unknown`
  naming the team, a second `unknown` audit row with the team, and the retry with the same key
  replays. Another user's identical key is another request (the record is per user).
- **What `requestKey` means:** the key becomes permanently bound to its body once an Unbind was
  saved: the same key with the same body then replays the saved success; the same key with
  another body or binding after a saved success is `409 request_key_reused`. A refusal audit row
  is NOT a request record: the same key may repeat a transient or correctable refusal
  (`try_again`, `binding_mismatch`, `rights_changed`, …) and, once the cause is gone, succeed; the
  refusal dedupe only prevents a duplicate audit row for the same user / key / refusal; a fresh
  `requestKey` is a new attempt and may add a new refusal row.
- **Audit:** one row `unbind` per attempt that reached the checks: `team_id`, basis, the `reason`
  column, metadata `host_key`, `credential_kind`, `source_team_id`, `binding_id`,
  `bound_team_count` (after), `counted: false`, `source_contacted: false`, `attempt_id`,
  `request_id`, `request_hash`; refusals `refused` with their code (uncounted; the same user
  repeating the same `requestKey` into the same refusal adds no row — the dedupe runs in its own
  bounded transaction under a transaction-scoped advisory lock on the identity connection / user /
  action / outcome / code / team / `requestKey`, so two identical refusals in flight write one
  row); a `404` is not audited. A
  binding of an archived club cannot be ended through the route (the same 404 as every other
  read of an archived club): restore the club first. Nothing of an Unbind enters the
  5 / 15 min authentication window.
- **After an Unbind:** the v30 settings trigger no longer blocks a change of the team's approved
  GPEXE Team ID; the team can take a new valid binding; the freed source team can be bound to
  another approved pair under every v30 rule; the v30 rollback refuses only while an active
  binding exists.

### 2.8 F3c2g as built (owner order 2026-10-04; branch `feature/gpexe-importer-resolver-f3c2g`; not merged)

The importer's credential resolver and the strict transition rule. Discovery, entry-point map and
the decisions: `docs/ai/source-connections-f3c2g-discovery.md` (Q1 → migration v31, Q2 kept, Q3 → no
legacy downgrade after an Unbind). Migration v31 (see the round-4 bullet); one route change —
the importer router's error-detail allowlist gains `reason` (a new field on `source_connection_unavailable`,
shown to administrators only); no UI, no GPEXE request; `GPEXE_API_TOKEN` stays in the configuration and
on Render untouched.

- **The resolver** (`backend/src/sourceImportCredentialResolver.js`), for exactly one OptiMove team
  and one source system — it takes no URL, host, source team id or credential from its caller:
  - phase 1, inside the caller's short transaction under the team import lock
    (`resolveImportSourceFacts`): the team (active, its club), at most one active binding
    (`binding_ambiguous` otherwise), the approved pair of `gpexe_team_settings` equal to the
    binding's source team (`team_setting_missing` / `team_setting_mismatch`), the connection of
    the binding owned by the team's club and the club active (`connection_foreign_club`), the
    connection `verified` (`connection_not_usable` for every other state — an import never
    performs a Test), the host approved in the catalog AND resolvable in code
    (`host_not_allowed`); it returns `{ path: "legacy_env" }` for a team without a binding or the
    closed facts of the binding path (ids, host key, API family, the encrypted parts with their
    AAD context) — never a URL;
  - phase 2, after COMMIT and right before the first request (`openImportSource`): the key ring
    (`key_missing`), the decrypt with the row's own context (`credential_unreadable`), the adapter
    of `createSourceAdapter()` bound to the binding's source team on the approved host
    (`adapter_not_available` for a family without one — `e03` therefore cannot be an import
    connection); the plaintext reference and the encrypted parts are dropped in `finally`; the
    adapter closure is the only holder of the plaintext for the run;
  - phase 3, during the run, before every source operation and without a lock
    (`assertImportSourceStillUsable`): the same facts against the identity the run started with
    — an ended or replaced binding is `binding_ended`, a connection that left `verified` is
    `connection_not_usable`, a retired host `host_not_allowed`, a changed pair or club the codes
    above; the run stops before its next request and nothing already recorded is undone;
  - a refused credential during a read (a 401, `source_auth_rejected`; a 403 —
    `source_access_refused` — fails the check with its own code and keeps the state):
    `autoInvalidateImportSource` moves the connection `verified → needs_reconnect` with exactly
    one `auto_invalidate` audit row (basis `system`, no user, metadata `binding_id`,
    `source_team_id`, `trigger: import_read`; idempotent and conditional on the credential the run
    held — a connection already out of `verified`, or reconnected meanwhile, gets no row) in its
    own transaction bounded server- and client-side, after the check's own outcome was written;
    the check fails with the code; **no fallback**.
- **The transition rule** (D8 made strict): a team with an active binding reads only through it —
  the legacy client factory is not called and the environment variable is not read, whatever
  happens later; a binding that is not usable answers `409` (or `503` for `key_missing`)
  `source_connection_unavailable` with the precise code as `reason` at `startCheck` (no check
  row; the reason for an administrator only), or the precise code on the check row when it is
  found after the row exists (`credential_unreadable` — the decrypt happens once, after COMMIT —
  or anything that moves mid-run; on the API that code is for administrators only, a coach sees
  `source_connection_unavailable` — round 5); a
  team without a binding — and that never had one for the source — keeps the legacy path, labelled
  `legacy_env` (the existing `GPEXE_API_TOKEN` / `e03` client, `503 gpexe_token_missing` without the
  variable); a team with ended binding history answers `source_connection_unavailable` /
  `binding_ended` until it is bound again. The path is
  decided once per check under the team lock: an unlocked pre-read (which alone decides whether
  the legacy client is built, and proves the key ring and the key version (no decrypt) before any row
  exists) and the locked read must agree, otherwise `409 gpexe_change_busy` (retry).
- **The importer** (`startCheck` / `runCheck` in `backend/src/gpexeImportService.js`): the binding
  path's reads go through `importClientFor(source)` — the adapter's `listSessionsByDay` and
  `fetchSessionBundle`, each preceded by the re-validation, the bound team enforced
  (`source_team_mismatch` for any other), GET only; `drillsStatus.complete !== true` stops the
  run with `drill_set_incomplete` before the session is recorded (the mapper would otherwise
  skip the missing drill's metrics and the candidate would look complete); an empty,
  successfully read `players` is a valid empty drill and is recorded; `drillsStatus` and
  `drillLabels` are stripped so the stored snapshot keeps the F1 bundle contract (drill-label
  storage stays open). The path is written to the server log by code only (`legacy_env` /
  `source_connection` with the connection and binding ids); no API field carries it and no audit
  row records it (discovery Q1: a v31 column on the check row is the recommended closure, a
  separate decision).
- **Round-2 hardening (internal `security-reviewer` / `code-reviewer` / `db-reviewer`, 2026-10-04):**
  the run's identity carries a **fingerprint of the stored credential** (sha256 of its random nonce,
  never the credential): a Reconnect during a run stops it with `connection_credential_changed`,
  and the auto-invalidation is conditional on that fingerprint, so a stale 401 can never move a
  freshly reconnected connection; the **legacy path is re-validated the same way** before every
  operation (`legacyImportClientFor`: a binding that appears mid-run stops the run with
  `binding_started`); the re-validation window is **one bundle** (before and after the adapter's
  dependent reads of one session, so a bundle read across the end of its binding is dropped before
  it is recorded; a single bundle can be many requests, each with its own timeout); the binding
  path reports **progress per request** (every adapter response pings the check's heartbeat, as the
  legacy client does, so a slow source never makes a live check look abandoned); **only a 401
  (`source_auth_rejected`) auto-invalidates** — a 403 (`source_access_refused`) fails the check and
  keeps the state, the F3c2e bind rule for a team the credential cannot see; the invalidation runs
  only after the check's own outcome is written, in its own transaction bounded on the client side
  too (`AUTO_INVALIDATE_BOUND_MS`, the client destroyed on an unanswered COMMIT), and can never
  change that outcome; the **check-start COMMIT is bounded** (15 s): once sent, its loss is never
  "nothing was written" — the row is looked for on a fresh connection and the check runs when it
  is found, otherwise `503 check_outcome_unknown` and the next start is free; the lock transaction
  pins READ COMMITTED; the approved pair is compared **canonically** (the v30 / bind / Settings
  rule, so a stored `0981` imports as `981`); the pre-read proves the key ring **without a decrypt**
  (the plaintext is materialised once, after COMMIT); the facts and the opened source are
  **branded** (a caller cannot hand the resolver a host, catalog row, source team or encrypted
  parts of its own: `context_not_issued`); the precise `reason` of a refusal is returned to an
  **administrator** (platform, or the team's club) only — a coach gets the stable code and the
  sentence to contact an administrator. An auto-invalidation that meets the connection row held by
  a Test / Reconnect in flight times out after 2 s and is skipped (logged by code only): the
  attempt's own outcome sets the state, and the next refused check re-applies it. During a run the
  preview dry-run of each session still takes the team import lock briefly (pre-existing F1
  design; no network inside it).
- **Round 4 (owner's external review of `6ad4b49`, 2026-10-04 — all five items closed in this PR):**
  (1) both paths re-validate **after** a list too, empty or not — a binding ended, a credential
  replaced or a binding created while the list was in flight ends the run before any session
  (`binding_ended` / `connection_credential_changed` / `binding_started`), nothing recorded, no
  fallback; (2) **no legacy downgrade after an Unbind**: the legacy path is open only to a team
  that never had a binding for the source — a team with ended binding history and no active one
  answers `409 source_connection_unavailable` / `binding_ended` and never reads `GPEXE_API_TOKEN`;
  a new binding opens the source-connection path again (decision Q3 taken); (3) both paths **pin
  the team's club**: the run keeps the club it started in and checks, before and after every list
  and bundle, that the team is still active, still in that club, and the club active
  (`team_club_changed` / `team_not_available`) — a bound team cannot move at all (the v27 move
  guard, proven by a refused raw UPDATE in the tests), a legacy team that moves stops its run;
  (4) **migration v31** (`migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql`,
  decision Q1 taken): `gpexe_import_checks` gains `source_path` (`legacy_env` / `source_connection`,
  NOT NULL, DEFAULT `legacy_env` — every row from before v31 was written before the resolver
  existed, so the default is the documented backfill, no rewrite), `source_connection_id` and
  `source_binding_id` (FKs, RESTRICT), `source_team_id` (canonical) and `source_host_key`; a CHECK
  binds the four to the path (all null on the legacy path, all present on the connection path); a
  BEFORE INSERT trigger makes the database itself refuse a connection-path row whose binding is not
  active, not the team's, not the connection's, not that source team, or whose host key is not the
  connection's; a BEFORE UPDATE trigger keeps the five columns final from creation; the check's
  INSERT writes them in the same locked statement; never a credential, token or URL; rollback
  `docs/runbooks/gpexe-import-checks-v31-rollback.sql` (NOWAIT, refuses under a later migration and
  while any row says `source_connection` — evidence v30 cannot represent), rehearsed apply → guards
  → rollback → identical v30 catalog → failed-last-statement atomicity → reapply → refusals on a
  disposable database; **v31 is applied to no persistent database** (the local OPTIMOVE stays v21;
  the deployed database gets it only through a merge and deploy the owner decides); (5) decision Q2
  kept: only a `verified` connection is read, an import never promotes a state.
- **Round 5 (owner's external review of `d7657c8`, 2026-10-04 — closed in this PR):** (1) **the
  v31 trigger protects the legacy path**: after the team's import try-lock it refuses a `legacy_env`
  row for a team that has any gpexe binding, active or ended (`23514`,
  `gpexe_import_checks_legacy_path_never_bound`; the application maps it to `409 gpexe_change_busy`,
  a backstop it cannot reach on its own locked path); a team that never had a binding writes
  `legacy_env`; rows from before a team's first binding stay as history; the `source_connection`
  checks are unchanged; proven with a bind and a legacy INSERT serialized by the one team lock in
  both orders, after an Unbind, and with the rollback → identical v30 catalog → reapply sequence
  still green; **decision for F3c4 recorded**: the migration that retires the environment path drops
  the `DEFAULT 'legacy_env'`, new code writes no legacy check, historical legacy rows are not
  rewritten; (2) **the asynchronous connection codes are masked for a coach**: the precise code stays
  on the check row; on `GET …/status`, `GET …/checks/:checkId` and the answer of a start that fails
  right after its COMMIT a platform admin and an active admin of the team's club see the precise
  resolver / connection code, a coach sees `source_connection_unavailable` and the sentence to
  contact an administrator for every code of the connection-configuration set (the binding, the
  connection's state, club, host, key, adapter and credential codes, a refused credential and a
  resource it may not read included); general source answers and team facts are shown as they are
  (the three viewers of the same failed row are tested); (3) the PR title names migration v31.
- **Serialization** with every other writer through the v24 team lock key: `startCheck` waits at
  most `SETTINGS_LOCK_TIMEOUT_MS` for the team import lock (`409 gpexe_change_busy`), while a
  Test / Reconnect / bind holds that team's try-lock for its whole attempt, an Unbind for its
  write and a Settings change for its write; after COMMIT the run holds no transaction or lock
  across a network call (the preview dry-run of each recorded session takes the team lock
  briefly, as F1 always did, with no network inside it).
- Tests: `backend/tests/gpexe-import-credential-resolver.test.mjs` (a disposable database through
  v30, a fake source serving the exchange, the team reads and the rest_v1 session reads derived
  from the shared bundle fixture; the legacy path through a fake e03-style client; the legacy
  factory as a trap on the binding path; the resolver's own contract with a fake executor).

### 2.9 F3c3 as built — the administrator's Source connections screen (owner order 2026-10-05; branch `feature/gpexe-source-connections-ui-f3c3`; PR A of the combined F3c3 / F3c4 package; not merged)

Frontend and docs only, on the merged F3c2d–F3c2g routes; no backend contract change. One new
Settings sub-tab, **Source connections** (`frontend/source-connections-{view,data,actions}.js`,
state slice `state.sourceConnections`), beside the F3b **Data sources** tab (the approved pair
OptiMove team ↔ GPEXE Team ID stays there, platform admin only, unchanged).

- **Who is offered the tab (`sourceConnectionsAdminContext()`, from `/me` and `/api/organization`):**
  a platform admin in the platform workspace (a club picker from the clubs Settings loaded; the
  list route is called with that `clubId`) or inside a club workspace (that club), and an active
  club admin inside their own club's workspace (`manageableClubIds` contains the workspace club).
  A coach, a club admin in a team workspace or in another club's workspace, and an account without
  those facts never see the tab, and a section they cannot see falls back to Overview. The server
  decides again on every request: everything else is the same 404, and the screen renders a 404 as
  "No source connections are available in this workspace" — never whether a connection exists.
- **Create** (`POST …/connections` with `ownerScope: "club"`, the club, the host key of the one
  approved profile the form offers — `server3`, a constant list in the client, the server refuses
  anything else —, an account label of 1–120 characters and `credentialKind: "exchanged_token"`):
  the Connect form opens on the new row at once.
- **Connect account / Reconnect** (`POST …/connect` / `…/reconnect`): one form, username and
  password typed once (`autocomplete="off"` on the form and the username, `current-password` on the
  password — see below), sent in that one request body and retained
  by OptiMove in no place — not in state, a dataset, a URL, storage, a log or a notice; the form is rebuilt empty
  after the request and submits natively as POST only (`method="post"`), never as a GET with the
  pair in the URL; a double click sends one request (the busy flag is set before the first
  await). **The autocomplete choice (owner's external review of PR #138):** `current-password`
  names what the field is — the existing password of a third-party account — so a browser treats
  it as a sign-in field and does not offer to generate a new password (the offer `new-password`
  invites); the username field keeps `autocomplete="off"` to discourage a stored OptiMove login
  being offered as the pair, and because a browser may fill both fields anyway the form asks the
  administrator, before Connect / Reconnect, to check that both fields hold the GPEXE pair and to
  clear both if the browser filled either; the password-manager hints (`data-1p-ignore`, `data-lpignore`,
  `data-bwignore`) stay. None of this is a guarantee: a browser or a password manager may still
  offer to fill or to save, and the UI says exactly that — the sentence on the form is "OptiMove
  does not retain the username or password after this request. Your browser or password manager
  may handle them according to its own settings." (a doc-lint test pins the sentence and the
  attribute). Every request is bounded on the
  client at 150 s (beyond the server's own worst case for an attempt); an abort, no answer at all, a
  `503 outcome_unknown` and any 5xx the service did not write itself (a proxy, a restart) are
  **lost answers** — *Result not confirmed*, never "nothing was changed"; a write that settled but
  whose post-write read failed is shown as settled with a "facts may be out of date" note.
  Reconnect first names the source, the owning club, the account label and host, and the
  number of bound teams, and sends that as the `confirmation` the route requires; the old
  credential is never shown. **A lost Connect, Reconnect, Test or create is never confirmed by a
  read** (owner's external review of PR #138): *Result not confirmed* offers **Read current
  state**, which reads the connection (`GET …/:id`) or the club's list again and refreshes what is
  shown but keeps the marker — a read cannot tell whether the lost attempt landed (a Reconnect on
  a verified connection looks the same before and after; the server may still be finishing the
  request; a list does not say which row an attempt created), and the backend returns no attempt
  revision to compare, so nothing is invented. While the marker stands every other write control
  stays locked. Only the explicit **Acknowledge uncertainty and continue** (a confirmation that says
  the server may still be finishing the previous request and that a new Connect or Reconnect can
  change the credential) clears the marker — locally, sending nothing; for a lost create it also
  says that creating again can make a second connection this screen cannot remove (the create
  route has no idempotency key and v27 no per-club uniqueness for connections). A read that fails
  says so and replaces an older read's sentence; a create's read reads the club's list directly and
  never resets the club. The pair is never sent a
  second time. A bind and an Unbind keep **Check result**: the same pair / the same `requestKey`
  again, which the server answers idempotently; a repeat refused as `try_again` decides nothing and
  keeps the marker. After a workspace switch a marker of the previous club is shown as one sentence
  only, and neither a read, a repeat nor the acknowledgement runs from another club's context.
- **Test connection** (`POST …/test`, an empty JSON object): the state badge (`Verified`,
  `Connected, not tested`, `Needs reconnect`, `Source unavailable`, `Not connected`), the last
  verified time, the last recorded problem as a sentence, and the result sentence (succeeded with
  N bound teams read / refused by the source → reconnect / did not succeed with the stable code's
  sentence). After a verified Connect or Test the server's `sourceTeams` are listed exactly as
  presented — a club admin only the approved intersection the server returned, a platform admin
  the bounded annotated list — with the count, the `sourceTeamsTruncated` note and the
  `sourceTeamsUnavailable` sentence; never a token, never the source's own answer, never a team the
  server did not present.
- **Approve and bind:** a row with an approved OptiMove team offers **Bind**; a row without one
  shows "No approved OptiMove team yet" and, to a platform admin only, **Set the pair in Data
  sources** (a switch to the existing F3b tab, where the pair is set through the F3b Settings
  route — the club admin cannot approve a pair). The review names the source, the host, the club,
  the OptiMove team and the GPEXE team (id and the presented name) and says the environment token
  is never used for that team again, not even after an Unbind; **Confirm binding** sends
  `{ teamId, sourceTeamId }` once; the server's idempotent answer reads "was already bound …
  nothing changed"; a lost answer offers Check result, which repeats the same pair (the route
  answers it idempotently).
- **Unbind** (`POST …/bindings/:bindingId/unbind`): the confirmation names both teams, warns that
  the team does not fall back to the environment token, and requires a reason (1–500 characters);
  the body carries a fresh `requestKey` per attempt and the `expected` pair; a lost answer keeps
  that key and Check result repeats the same request; the ended binding is shown as history
  ("Ended just now") and the bound list no longer offers it.
- **Every stable code of the source routes** reads as a sentence (`connectionMessage()`), the
  server's own sentence and the code only inside "Technical details"; `429 source_auth_throttled`
  says to wait about 15 minutes.
- **States and guards:** loading, empty (no connection yet), forbidden-as-not-found, a failed read
  with Try again, a lost answer, an archived bound team ("(archived)"); a write in flight or an
  unconfirmed outcome disables every other write control, asks before a Settings section switch
  (`confirmLeaveSourceConnections`) and before a reload / close (`beforeunload`).
- **The coach's Imports screen** no longer says "Try again in a moment" for a check refused or
  failed through the team's source connection (`source_connection_unavailable`): it shows the
  server's sentence to contact an administrator.
- **Owner-run pilot after the merge and deploy of PR A:** `docs/runbooks/gpexe-owner-pilot-f3c3.md`
  — the main session prepares it and never runs it.

### 2.10 GPEXE athlete identity as built (owner order 2026-10-06; branch `feature/gpexe-athlete-identity`; not merged)

Discovery: `docs/ai/gpexe-athlete-identity-discovery.md`. Source and field rules:
`docs/ai/gpexe-rest-v1-compatibility.md` section 4b. Migration v32
(`migrations_v2/202610061000_training_load_v32_gpexe_athlete_identities.sql`); rollback
`docs/runbooks/gpexe-athlete-identities-v32-rollback.sql`.

**Routes** (GPEXE import router, `requireAuth`). Every answer, a 404 included, carries
`Cache-Control: no-store`. The GET reads the right and the data in one bounded transaction. Connection,
binding, team, role and user rows and the club are locked `FOR SHARE` in the write path's order before
any identity row is read, and held until the answer is assembled. That makes it fail-closed against a
revocation, an archive or an Unbind that commits after the route's own check (external review of PR
#144, HIGH).
- `GET /api/training-load/gpexe/teams/:teamId/athlete-identities` reads the stored, unexpired
  identities of the team's active binding. It also returns:
  - `pendingCount`: eligible athletes without a valid identity;
  - `maxPerLoad: 50` and `retentionDays: 14`;
  - `birthDateConflicts`: the pairs whose known dates of birth differ, limited to the pairs the screen
    can stage. That is a GPEXE athlete without an active link and an active OptiMove athlete of the team
    without one. OptiMove's own date is never returned.
- `POST …/athlete-identities/loads` takes `{ requestKey }` and nothing else.
- **Who:** an identity admin only (`identityAdminBasis()`): a platform admin in the platform or the
  team's club workspace, or the team's club admin in that club's workspace. The right is read live on
  every request and `FOR SHARE` before the write. Everyone else gets the router's `404 {error:"notFound"}`:
  - a coach, a team workspace, another club;
  - a revoked or inactive role;
  - an archived team or club;
  - a team without an active binding, or one whose binding ended.

  The team status adds `viewer.identityAdmin: true` for an identity admin only. A coach's status is
  unchanged.

**The load** (`backend/src/gpexeAthleteIdentityService.js`):
- **Replay:** the same user's same key returns the saved counts, after the right is re-checked. The
  same key on another team, or after an Unbind under another binding, is `409 request_key_reused`.
- **Claim** (one short transaction):
  - the F3c2g facts and the key ring, without a decrypt;
  - the right;
  - closing stale running loads (`abandoned` after 180 s);
  - the eligible athletes: available candidates first or last seen by a **succeeded**
    `source_connection` check of **this** binding, canonical preview ids, newest session first, without
    a valid identity, at most 50;
  - one `running` request row. A partial unique index allows one per team; a second load meanwhile gets
    `409 identity_load_running`.
- **Network,** with no database connection held:
  - `openImportSource` with a 15 s request timeout and a 45 s budget signal;
  - `identityReaderFor`, which refuses any id it was not given;
  - at most 3 workers; the facts re-validated before every read and after the last;
  - the adapter's `readAthleteIdentity` (GET `athlete/<id>/` through `sourceApiUrl`, `redirect:
    manual`, one attempt), which projects five keys into the sanitized identity. An answer for another
    id is `source_identity_mismatch`.
- **What a source answer does:**
  - 404 is counted as not found and is never an identity. A 24-hour retry suppression (binding, team,
    id, `observed_at`, `retry_after`) leaves the athlete out of the next loads' choice, is never extended,
    and is deleted by the identity delete paths and its own purge. The list answers `retryLaterCount`
    (a count only). There is no automatic retry (owner decision 2026-10-07);
  - 401 marks the load failed first, then auto-invalidates the connection (trigger `identity_read`);
  - 403, an id mismatch, or a binding, connection, credential or team change saves nothing;
  - 429, 5xx, a timeout or a malformed answer stops the load and keeps what was confirmed (`partial`).
- **Write:** locks the connection, the binding and the team `FOR SHARE`, then the right and the club
  `FOR SHARE`, then the request row `FOR UPDATE`. That order matches a bind or Unbind (connection
  first). It then re-validates the facts, deletes expired rows of the same athletes, inserts the new
  rows (`ON CONFLICT DO NOTHING`), completes the request with counts, and runs the bounded COMMIT:
  `verified_after_commit_error`, or `503 outcome_unknown` with the requestKey.
- **Answer:** counts only (`loaded`, `notFound`, `notRead`, `stopCode`, `unrecognisedBirthDates`). The
  last is in this answer only and `null` on a replay.

**The database (v32):**
- **`gpexe_athlete_identities`:**
  - holds the provenance (team, binding, connection, source team), the canonical id, `display_name`
    or NULL, `birth_date` or NULL, `observed_at`, and `expires_at` = `observed_at` + 336 hours (CHECK,
    independent of the session time zone);
  - an INSERT guard requires the active binding of this team, connection and source team, an active
    team and club, the reading time, and a date of birth that is not in the future;
  - every UPDATE is refused;
  - delete triggers act on a binding that ends, a team archive and a club archive.
- **`gpexe_athlete_identity_requests`:** counts and a stable code only. An INSERT needs the active
  binding; a finished request is final.
- **Purge:** `purge_expired_gpexe_athlete_identities()`, called by `runRetention()` (first, on its
  own), on every read of the list and before every load.
- **Personal columns are plaintext.** There is no index on either.

**The UI** (`frontend/gpexe-import-{data,view,actions}.js`, Link athletes):
- **Panel:** for an identity admin only. It reads the stored identities when the screen opens; *Load
  names and dates of birth* opens the confirmation (at most 50, read-only, deleted after 14 days,
  backups noted); its button of the same name sends one POST, so a double click sends one request. A
  fresh load refused because another load runs is a refusal, not an unconfirmed result.
- **Lost answer:** *Result not confirmed* · *Check result*, the same key, never by itself.
- **Locks:** the load and the link writes lock each other.
- **Rows:** a row with an identity shows the name ("Name not provided") and "Born DD.MM.YYYY" ("Date
  of birth not provided"). A row without an identity reads "Name not loaded". With the identity view
  the id is only under Technical details: rows, aria-labels, confirmation, results, error sentences and
  the unlink question (external review of PR #144).
- **Warnings:**
  - a duplicate name;
  - a date-of-birth conflict for the chosen OptiMove athlete, on the row and in the confirmation.
- **Linking:** a link is still made only by the final *Link N athletes*, through the existing route
  and its guards.
- **Storage:** in memory only; dropped on Close, a team switch, a workspace switch or sign-out.
- **Not in this step:** the single-athlete link from a session's review shows no identity.

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
    and the env token present, the env fallback (D8) is used. *As built in F3c2g (section 2.8):
    the path is logged by code only — the v27 audit CHECK gives `system` only to
    `auto_invalidate`, so "audited as system" is not met without a schema change (discovery Q1).*

External review triggers 2 and 4 are active for the whole of F3c2: the PR is never declared
merge-ready by the main session.

---

## 4. Stop line for this PR

Delivered here: the discovery script and its tests, this contract, the CURRENT_STATE update.
Not delivered, by order: any route, any adapter, any network call, any credential, any change of
the Render environment, any row in the v27 tables, F3c3, 5a3c.
