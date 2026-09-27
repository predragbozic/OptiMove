# F3c — GPEXE source authentication and connection: discovery

Status: **discovery accepted as the basis for F3c** (owner, 2026-09-27; security and database
review folded in, see section 10; the owner's guidelines are in section 7a). The owner-run
read-only capture is done (section 8a): U7 resolved, U8 partly, U1–U6 open for F3c2 discovery
(section 8b). **F3c1: GO within the boundaries of section 8c**; it has not started. No
token, cookie, password or authorization value may ever be copied into this document, a log,
a chat or a screenshot. No implementation, migration, branch or PR. Nothing
here was run against production GPEXE, and no credential, token, cookie or Authorization
header was read, copied or shown while writing it.

Preconditions checked: `origin/main` = `7e4d92d564c3852dbafc16cb66c5911f23c3117f` (merge of
PR #125, Phase 5a3b), deployed (`/api/health` reports `7e4d92d`). **`docs/ai/CURRENT_STATE.md`
still describes PR #125 as open; the first F3c PR must record its merge and deploy.**

Scope of F3c: how OptiMove obtains, stores, uses, verifies and retires a GPEXE credential, and
what a team's link to a GPEXE team means. Not in F3c: the import switch, any real import, 5a3c.

---

## 1. Confirmed facts and unknowns

Sources: `backend/src/gpexeClient.js`, `backend/src/gpexeImportService.js`,
`backend/src/gpexeImportWriter.js`, `backend/src/routes/gpexeImport.js`, migrations v11, v20,
v22, v24, `docs/runbooks/gpexe-in-app-import.md`, the untracked legacy Apps Script
`gpexe-code-check.js` (endpoint strings only), the pilot notes of 2026-09-17, and the owner's
statements of 2026-09-27.

| # | Statement | Status | Evidence |
|---|---|---|---|
| F1 | The production OptiMove team is bound to GPEXE Team ID `980`. | Confirmed (owner) | `training_load.gpexe_team_settings.gpexe_team_id`; pilot notes (team 980, FK BORAC 2026/27). |
| F2 | "Connected" in Settings → Data sources means only that a `gpexe_team_settings` row exists. | Confirmed (code) | `frontend/data-sources-view.js`: `connected = Boolean(settings)`; `GET …/teams/:teamId/status` returns `settings` from `getTeamSettings`, no probe of GPEXE. |
| F3 | The production Render service has no `GPEXE_API_TOKEN`. | Confirmed (owner) | Runbook: without it "Check now" answers `503 gpexe_token_missing`. |
| F4 | Production GPEXE has never been read by OptiMove. | Confirmed (owner) | CURRENT_STATE (no search, link or import in production). |
| F5 | The current client uses one fixed host, `https://e03.gpexe.com/api/`, GET only, `Authorization: Token <env>`, redirects refused, paths only (no URLs), a personal-field drop list, 90 s timeout, 3 attempts. | Confirmed (code) | `gpexeClient.js` (`GPEXE_API_BASE`, `request()`). |
| F6 | The token is expected to exist already; nothing in OptiMove obtains one. | Confirmed (code) | `createGpexeClient({ token = process.env.GPEXE_API_TOKEN })` → `token_missing`. |
| F7 | A token can be obtained with `POST /api-token-auth/` (`username`, `password`) and used as `Authorization: Token …`. | Confirmed for `server3` (legacy script, owner); observed once for `e03` in the pilot (2026-09-17: `WWW-Authenticate: Token`, token from `/api-token-auth/`), **not re-verified** | `gpexe-code-check.js` lines with `api-token-auth`; pilot memory. |
| F8 | The legacy script reads `https://server3.gpexe.com/rest/v1/…` and also has functions against `https://server3.gpexe.com/api/…`. | Confirmed (legacy script) | Both base URLs appear in `gpexe-code-check.js`. |
| F9 | The legacy script uses a **Bearer** header for one PDF export URL. | Confirmed (legacy script) | One `Authorization: Bearer` occurrence (export), not the REST token scheme. |
| F10 | The owner signs in to the UI at `https://e03-ui.gpexe.com/`; it is a static SPA that calls `https://e03.gpexe.com/api/`. | Confirmed (owner; pilot notes) | Pilot memory 2026-09-17. |
| F11 | The legacy Apps Script is **not** a valid reference for import semantics (owner, 2026-09-17). | Confirmed | Pilot memory. Used here only as an inventory of hosts/paths. |
| F12 | `metric_source_connections` (v11) already carries `source_system`, `owner_scope` (`system`/`club`/`team`/`user`), `state`; one active GPEXE connection per team (v20 partial unique index); the writer creates a `team`-owned row on first import. | Confirmed (code) | v11, v20; `gpexeImportWriter.js:139-147`. |
| F13 | `gpexe_team_settings` is one row per OptiMove team (unique `gpexe_team_id`), append-only history with an admin reason (v24), changeable only while nothing depends on it. | Confirmed (code) | v22, v24. |
| U1 | Do `server3` and `e03` see the same account and Team ID 980? | **Open** | Not determined by the 2026-09-27 capture (no `server3` request seen; no cross-host test). Section 8, step 0. |
| U2 | Is `server3` legacy, an alias, or a separate environment (separate database)? | **Open** | The UI never called `server3` (2026-09-27 capture); whether it is legacy, alias or separate stays unknown. |
| U3 | Does the token expire, and is it revoked by a new login (one token per user, "rotate on login")? | **Open** | Capture: token lifetime/rotation not determinable without a secret. Unknown. |
| U4 | Does one GPEXE account see several clubs/teams? | **Open** | Capture: the number of teams the account sees was not determined. |
| U5 | Is there an endpoint listing the account's permitted teams (`team/`)? | **Open** | Not seen in the capture; the UI's data goes through one `POST /ui/v2/` endpoint, so a REST team-list route was not exercised. |
| U6 | Does a token from one host work on the other? | **Open, intentionally not tested** | Never tested; must not be tested with a browser credential. |
| U7 | Which routes the logged-in `e03-ui` uses (hosts, paths, methods, auth type). | **Resolved (sanitized)** | See section 8a: `e03.gpexe.com`, `POST /ui/v2/`, `GET /ping/`, JWT scheme plus a cookie/session mechanism, credentialed CORS limited to the `e03-ui` origin, GPEXE version header 9.11.7, Team ID 980, no `server3` request. |
| U8 | Rate limits, token scope (read-only vs write), and whether a "service"/API-only account exists. | **Partly resolved** | No rate-limit headers were observed (2026-09-27); token scope and the existence of an API-only account remain unknown. |

---

## 2. Endpoint inventory: what the importer uses today, `server3` vs `e03`

All OptiMove calls are GET, relative to `https://e03.gpexe.com/api/`.

| Purpose | OptiMove today (`e03/api`) | Legacy script (`server3`) | Note |
|---|---|---|---|
| Authentication | none — env token | `POST /api-token-auth/` (`username`, `password`) → `Authorization: Token …` | e03 answered `WWW-Authenticate: Token` in the pilot; `api-token-auth` on e03 observed once, to re-verify (F7). |
| Teams (list) | not used | not used | U5. |
| Team thresholds | `team/{team}/thresholds/?valid_on=YYYY-MM-DD` | not used | Threshold set per session date (v20 bindings). |
| Team sessions (list) | `team_session/?team={team}&start_timestamp_gte=…&start_timestamp_lte=…&limit=100` (header paging: `X-Total-Count`, `Link rel=next`; DRF `{count,next,results}` accepted) | `rest/v1/team_session/?…` | Same resource name on both hosts, different prefix. |
| Team session (one) | `team_session/{id}/` | `rest/v1/team_session/{id}/` | |
| Session details / drills | `team_session/{id}/details/`, `team_session/{id}/details/?drill={n}` | `rest/v1/team_session/{id}/details/`, `…/details/?header=true` | Drills are separate `team_session` rows; parent lists `drills:[ids]`. |
| Athlete sessions | `athlete_session/?teamsession={id}&limit=100`, `athlete_session/{id}/`, `athlete_session/{id}/more/` | (per-session detail in the script) | |
| Tracks | `track/{id}/` | not used | Timezone and device restarts. |
| Tags | not used | `rest/v1/team_session_tag/?limit=5000` | Not needed by the import; not relevant for F3c. |
| Exports | not used | PDF export with `Bearer` (F9) | Out of scope. |

Shape observed on e03 (pilot): a plain array body with header paging for lists; DRF style also
accepted by the client. Whether `server3/rest/v1` pages the same way is unknown.

---

## 3. Proposed model: source connection and team binding (source-neutral)

Today the credential is a process-wide environment variable and the "connection" is a team
setting holding a GPEXE team id. F3c separates three things:

All three tables live in the `training_load` schema. The credential table is named
`source_credential_connections` so that it is never confused with the v11 provenance table
`metric_source_connections` (whose `state` means active/inactive, a different thing).

```
source_credential_connections  (who may read a source, with what credential)
  id, source_system ('gpexe' | 'catapult' | 'polar' | …)
  owner_scope 'club' | 'team'  + owner_club_id / owner_team_id   (never 'user'; 'system' only for future platform-level sources)
  host_key            ('e03' | 'server3' | …)  — a key into the server-side allowlist, never a URL
  account_label       (a display label the admin types, e.g. "FK Borac GPEXE"; never the username)
  credential_ciphertext, credential_key_id, credential_nonce  (section 4)
  state               'not_connected' | 'linked_untested' | 'verified' | 'needs_reconnect' | 'source_unavailable'  (section 6; derived + stored)
  last_verified_at, last_error_code, last_error_at
  created_by, created_at, updated_by, updated_at

source_team_bindings          (which source team an OptiMove team reads)
  team_id (OptiMove)  — unique: one binding per OptiMove team per source_system
  connection_id       → source_credential_connections
  source_team_id      (text; GPEXE: ^(0|[1-9][0-9]{0,11})$)
  unique (connection_id, source_team_id)  — one source team feeds one OptiMove team
  history table (append-only, reason), as v22/v24 do today

source_connection_audit       (append-only)
  connection_id, action 'connect' | 'reconnect' | 'test' | 'disconnect' | 'auto_invalidate', outcome, error_code,
  performed_by_user_id, basis, at, detail jsonb (never a secret)
```

Integrity the database enforces (not only the code), in the style of v20/v22/v24:
- `credential_ciphertext`, `credential_key_id`, `credential_nonce` are null together or set
  together (one CHECK, as v20's "reference complete"); no plaintext column ever exists.
- `state` is stored (it depends on the outcome of external calls and cannot be derived); the
  "last verified <when>" decay is derived at read time. CHECKs bind the state to its facts:
  `needs_reconnect` ⇒ `last_error_code` set; `source_unavailable` ⇒ `last_error_at` set;
  `verified` ⇒ `last_verified_at` set.
- A connection's ownership (`owner_scope`, `owner_club_id`, `owner_team_id`) is immutable once a
  binding or a provenance row depends on it — the same mechanism as v11's
  `protect_connection_ownership_once_used`; a binding's team and source team are immutable once
  a check, candidate, link, approval or event depends on them (v22/v24's orphan/repoint rules
  carried over).
- The audit table and the binding history get the project's append-only trigger pair
  (no UPDATE/DELETE, no TRUNCATE), as `gpexe_team_settings_history` has today.

**Lock scope (decided here, before any trigger is written).** A club-owned connection may serve
several OptiMove teams, so Connect, Reconnect and Disconnect on a connection take
`hold_gpexe_team_lock()` for **every** team currently bound through `source_team_bindings`, in
ascending `team_id` order, before any check or write — `pg_try` style as today (v24: a check,
link or settings change takes the team lock first, an approval takes it last, never a blocking
variant); any failed `pg_try` answers a stable "try again" code. Binding a team to a connection
takes that team's lock the same way. A running import check therefore never overlaps a credential
change on any of its teams, and two Reconnects on connections with overlapping teams cannot
deadlock. F3c1's tests prove it with two overlapping Reconnects and a Reconnect against a check
in flight on one bound team.

Rules:
- **Ownership.** A connection belongs to a **club** by default (one GPEXE account usually serves
  the whole organisation) and may be team-owned when a team has its own account. Managing a
  connection needs the club admin of that club (or a platform admin); today's GPEXE settings are
  platform-admin only, and F3c may keep that until the club-admin path is decided (D2).
- **Sharing.** Several OptiMove teams may use one connection **only when the source lets that
  account see those teams** (U4/U5). The server proves it at binding time (the source's team
  list, or a successful read of that team's thresholds) and records the proof in the audit.
- **One binding per team, one source team per binding.** Same guarantees as v22/v24 today
  (immutable once data depends on it, reason on change, refused over orphan data). The
  existing `gpexe_team_settings` stays in place in F3c1 (D6: **add beside**); the cut-over to
  `source_team_bindings` is a later, separate migration once D1/D2/D4 are fixed and the existing
  GPEXE test suite proves the new shape. Today's production row (team 980) has no club and no
  credential: the cut-over creates a **team-owned** connection in `linked_untested` with empty
  ciphertext for it — a documented exception to the D4 default, not an error.
- **`metric_source_connections` (v11)** stays what it is — the provenance identity of imported
  events, created by the writer. Whether it gains a nullable link to the credential connection
  or the two are merged is its own decision (D12). Provenance rows are never deleted when a
  credential is retired.
- **Future adapters** implement: `obtainCredential(hostKey, exchange)` (or "paste token" for
  sources without a password exchange), `testConnection(credential)`, `listTeams(credential)`,
  and the existing read functions. GPEXE is the first.

---

## 4. Security contract (proposed)

1. **Username and password are exchanged once, server-side, and never stored.** The Connect
   request carries them over TLS to OptiMove, which POSTs `api-token-auth` on the allowlisted
   host and discards them (no log, no audit `detail`, no error text, no request body kept).
   Express must not log the body; the fields are named so that no generic request logger
   captures them, and the route disables body logging explicitly.
2. **The token is stored encrypted** (AEAD, e.g. AES-256-GCM, per-row nonce, key id column) in
   `source_credential_connections`. **The key is not in the database**: `SOURCE_CREDENTIAL_KEY` (or a
   key set) lives in the server environment (Render) and `backend/.env`, with a documented
   rotation procedure (re-encrypt under a new key id). Without the key the server starts but
   every connection reads as `needs_reconnect` with a stable code, never a crash and never a
   plaintext fallback.
3. **The token is never returned to a browser, a log or an error.** Status routes return state,
   timestamps and error codes only. The client keeps today's rule: messages name paths, never
   headers; `redactGpexe` stays.
4. **Allowlisted hosts only.** `host_key` maps to a fixed base URL table in code
   (`e03` → `https://e03.gpexe.com/`, and `server3` only if D1 keeps it). No admin-typed URL,
   no redirect following (already refused), no `next` page outside the base (already refused).
5. **Every Connect, Reconnect, Test connection and Disconnect writes one audit row** (who, basis,
   when, outcome, error code, host key, account label). Disconnect does not delete provenance;
   it retires the credential (ciphertext wiped, state `not_connected`) and is refused while an
   import check is running.
6. **When the token stops working** (`401`/`403` from the source on any read): the connection
   becomes `needs_reconnect` with `auto_invalidate` in the audit; "Check now" and imports for
   every bound team answer `409 source_needs_reconnect`; nothing retries with the old token;
   the admin reconnects (new exchange). A `5xx`/timeout streak is `source_unavailable`, not a
   credential problem, and clears on the next success.
7. **Least privilege.** Connect/Reconnect/Disconnect: platform admin (today) or the owning
   club's admin (D2). Test connection: the same set plus, optionally, the team coach with an
   import approver grant (D3), since it writes nothing. Coaches never see host, label or audit.
8. **No credential in tests or fixtures.** Tests use a fake source server; the disposable-DB
   rule applies unchanged.
9. **The exchange route is throttled and fully audited.** Connect and Reconnect are limited per
   connection and per performing user (attempts per rolling window, then a stable `429`
   code with backoff; D10), and every attempt, success or failure, writes an audit row. The
   route must not become a password-guessing proxy against the source, nor a way to lock the
   source account out.
10. **Cross-site submission and replay.** The session cookie is `HttpOnly; SameSite=Lax`
    (`backend/src/auth.js`), which already stops a cross-site POST from carrying the session.
    F3c2 keeps every Connect / Reconnect / Disconnect a same-origin JSON POST (no form
    encoding, JSON body required) and decides whether the action needs a step-up confirmation
    of the admin's own OptiMove password (D11). Connect and Reconnect take the connection
    row's lock before calling the source, so a double submit or a client retry never runs two
    exchanges or interleaves audit rows, and a slow first answer never overwrites a newer
    verified state (the COMMIT-outcome discipline of the GPEXE approval applies).
11. **Two independent checks, as everywhere (ADR-002).** `owner_scope` says who may manage a
    connection or binding; the status and list queries additionally read only what the
    once-resolved active workspace may see (`data_workspace`). F3c2 implements them as separate
    access and query helpers, never one equality check.
12. **Body logging.** The app uses `express.json()` with no request logger today; F3c2 adds a
    test that the Connect route's body never reaches a log, and the route rejects any body
    larger than the two fields need.

### Threat model (what this defends against)

| Threat | Mitigation |
|---|---|
| Credential theft from the database dump or backup | Ciphertext only; key outside the database; key id enables rotation. |
| Credential theft from logs, error texts, API answers | Rules 1, 3; the existing client never puts the header in a message; audit `detail` is a fixed schema. |
| Token exfiltration by a crafted host or redirect | Allowlist by key, `redirect: "manual"`, paged `next` must stay under the base. |
| A platform admin (or a coach) reading another club's account | Ownership + basis on every route; status answers only state and label; info-hiding 404 as elsewhere (ADR-006). |
| Misuse of an old credential after Disconnect or a failed exchange | Ciphertext wiped on Disconnect; a source `401`/`403` moves the row to `needs_reconnect` and stops reads; no retry with the old token. |

The threat model is deliberately short: it lists the properties the design must keep, so the
`security-reviewer` can check each one against the code in F3c1/F3c2.

---

## 5. Status model (proposed)

| State | Meaning | Set by | Shown as |
|---|---|---|---|
| `not_connected` | No credential for this club/team, or Disconnect done. | default; Disconnect | **Not connected** |
| `linked_untested` | A team binding (source team id) exists but no successful read with a stored credential yet. This is today's production state for Team ID 980. | binding saved; migration of today's rows | **Team linked, connection not tested** |
| `verified` | Last Test connection or last real read succeeded. | Test connection; any successful "Check now" | **Connected · last verified <when>** |
| `needs_reconnect` | The source refused the credential (`401`/`403`), the key is missing, or the ciphertext cannot be decrypted. | client; startup key check | **Needs reconnect** (+ Reconnect) |
| `source_unavailable` | The source could not be reached or answered `5xx` on the last attempt(s); the credential is not known to be bad. | client | **Source unavailable · last tried <when>** |

A status or binding request for a team, club or connection outside the requester's access
answers the identical 404 used for a non-existent id (ADR-006), never `not_connected` or any
other state: a real id is never distinguishable from a fake one.

`verified` decays: after a configurable period without a successful read (D7) the screen shows
"last verified <when>" in a warning tone but the state does not change by itself — no background
job talks to GPEXE in F3c.

The label **Connected** today is renamed **Team linked** in F3c3 (a wording change on the
existing screen, before any credential exists).

---

## 6. Split into deliverables

| Slice | Content | Reviewers | Gate |
|---|---|---|---|
| **F3c1 — schema, encryption, audit** | Migration adding `source_credential_connections`, `source_team_bindings` and `source_connection_audit` **beside** `gpexe_team_settings` (no row moved, no view, v22/v24 triggers untouched), with the CHECKs, immutability and append-only rules of section 3 and the multi-team lock helper; encryption helper with key id and rotation; server startup check that a missing key degrades to `needs_reconnect`. Recovery from a bad F3c1 is a new forward migration, never an edit (ADR-005): it never materialises a decrypted credential anywhere (no "backup before drop" copy), never deletes or truncates audit or history rows, and if it removes objects it restores the previous triggers exactly. Tests on disposable databases only: the whole existing GPEXE suite unchanged; the two lock-scope concurrency tests; a missing or wrong `SOURCE_CREDENTIAL_KEY` degrades without a crash and without plaintext; a fake source with a marker token proves no log, audit row, answer or error carries any part of it. | `db-reviewer`, `security-reviewer`, `code-reviewer`; external review (trigger 1, 2, 4) | Owner decisions D1–D6, D12 |
| **F3c2 — backend Connect / Reconnect / Test connection** | Routes under Settings → Data sources: exchange on the allowlisted host, store, test (one cheap read: the team's thresholds or the account's team list), auto-invalidate on `401`/`403`, audit rows; throttling of the exchange (rule 9), same-origin JSON only, connection-row lock around the exchange (rule 10), separate access/query helpers (rule 11), body-log test (rule 12); the import client reads the stored credential per bound team instead of `GPEXE_API_TOKEN` (env token removed or kept as a fallback only until F3c4 — D8); tests with a fake source server. | `code-reviewer`, `security-reviewer`; external review (trigger 2, 4) | F3c1 merged |
| **F3c3 — Settings UI and statuses** | The five states, Connect (username/password fields with autocomplete off, sent once), Reconnect, Test connection, Disconnect (if D5 allows), audit list for platform admins, the rename Connected → Team linked, coach-facing sentences under Imports when a source needs reconnect. | `code-reviewer`, `ux-design-reviewer`, `mobile-qa` | F3c2 merged |
| **F3c4 — read-only production verification, import switch off** | On production, with `GPEXE_IMPORT_APPLY_ENABLED` off: Connect with the club's account (owner types the credentials in the browser, never in chat), Test connection, one "Check now" that only writes candidates and the check row, verify audit rows and that no token appears in logs; then decide on the env token. | owner + main session smoke; no code | F3c3 deployed |

Each slice is its own PR; none starts before the owner's go.

---

## 7. Decisions the owner must take before code

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Which hosts are allowlisted. | (a) `e03` only; (b) `e03` + `server3`; (c) per-connection host key from a fixed list | (a) until U1/U2 are answered by the probe in section 8; the table is trivial to extend. |
| D2 | Who manages a connection. | platform admin only (as today); club admin of the owning club; both | Both, with the club admin path added in F3c2 only after ADR-002 review; F3c1 can store `owner_scope` either way. |
| D3 | Who may press Test connection. | managers only; also coaches with an approver grant | Managers only in F3c; coaches see the state. |
| D4 | Connection ownership default. | club; team | Club, with team allowed. |
| D5 | Disconnect in F3c or later. | in F3c3; separate | In F3c3 as "retire credential" only (bindings and provenance untouched); the orphan-data question stays separate. |
| D6 | Migration of today's `gpexe_team_settings`. | add the new tables beside it, cut over later; move rows now and keep a compatibility view | **Add beside** in F3c1. A move would rewrite five v22/v24 trigger functions, invent a `connection_id` for rows that have no credential, and a joined view would not be automatically updatable; the cut-over is its own migration after the existing GPEXE suite passes unchanged on the new shape. |
| D7 | Decay period for "last verified". | 7 / 14 / 30 days | 14 days. |
| D8 | Fate of `GPEXE_API_TOKEN`. | removed in F3c2; fallback until F3c4 | Fallback until F3c4 passes, then removed and documented. |
| D9 | Token exchange host and credential type for the club account. | the owner's own GPEXE user; a dedicated API user | A dedicated user if GPEXE allows it (U8); otherwise the owner's, with Reconnect expected after any password change or when that person leaves — the audit keeps who connected, the connection itself carries only the label. |
| D10 | Throttle for Connect/Reconnect. | e.g. 5 attempts per 15 minutes per connection and per user; stricter | 5 per 15 minutes, with every attempt audited. |
| D11 | Step-up confirmation for Connect/Reconnect/Disconnect. | none beyond the session cookie; re-enter the admin's OptiMove password | Re-enter the password for Disconnect and Reconnect; Connect is already typing a credential. |
| D12 | `metric_source_connections` (v11 provenance) and the credential connection. | nullable link column from provenance to credential; merge the two tables | Link, not merge: provenance identity must outlive a retired credential. |

---

## 7a. Owner guidelines (2026-09-27)

Taken as decisions for F3c; the table above keeps the alternatives for the record.

| ID | Decision |
|---|---|
| D1 | A fixed host allowlist in code; no user-typed URL, ever. |
| D2, D3 | Only a platform admin manages a connection and tests it. Coaches see the state only. |
| D4 | A credential connection belongs to the club/organisation; teams are bound to it separately (`source_team_bindings`). |
| D5 | Disconnect stays outside F3c until its consequences (orphan data, running checks, bound teams) are defined. |
| D6 | Add beside, then a controlled cut-over as its own migration. |
| D7 | 14 days before "last verified" is shown in a warning tone. |
| D8 | `GPEXE_API_TOKEN` stays a temporary fallback and is never mixed automatically with the new connection: a team reads either through its bound credential connection or, while it has none, through the env token — never one after the other in the same check, and the audit says which. |
| D9 | A dedicated GPEXE API account, not a person's login. |
| D10 | 5 attempts per 15 minutes per connection and per user, every attempt audited. |
| D11 | Reconnect requires an explicit confirmation naming the source, the owning club and every affected (bound) team before the exchange runs. |
| D12 | Existing team settings are linked to the new connection with provenance kept: `gpexe_team_settings` and its history are never rewritten; the link is a new row that points at them. |

Status after the owner-run capture (2026-09-27, section 8a): U7 resolved, U8 partly, U1–U6 open;
U6 is intentionally not tested. What remains is F3c2 discovery (section 8b), not a blocker for
F3c1 (section 8c).

---

## 8. What only the owner can verify (read-only, no code)

Nothing below is to be done by Claude against production. Each step reads, never writes.

0. **Host probe (U1, U2, U6):** in the owner's own shell, one `GET team/` (or
   `team/980/thresholds/?valid_on=<today>`) on `e03` and on `server3` with the respective
   token, comparing only the ids returned — never pasting a token into chat. Result to record:
   same account and team on both, or not.
1. **e03-ui capture (U7):** with Claude in Chrome connected and signed in to `e03-ui`, a
   read-only listing of network requests on the sessions page — hosts, paths, methods and the
   auth scheme keyword only (the tool shows auth values as REDACTED; if a raw value ever
   appears, the owner strips it before anything is shared in chat or a file); no form
   submission, no response bodies with athlete data.
2. **Token lifetime (U3):** in the GPEXE UI or docs, whether a token expires or is rotated on
   login; if unknown, F3c2 assumes "may stop at any time" (state machine covers it).
3. **Account scope (U4, U5):** whether the account sees more than team 980.

Until these are answered, F3c1 can proceed on assumptions (a) of D1 and the state machine of
section 5; F3c2 needs at least step 0.

---

## 8a. Result of the owner-run read-only capture (2026-09-27, sanitized)

Only the facts below were transferred; no screenshot, header value, cookie, token or request
body was kept, and the original capture material is not part of this repository.

| Fact | Value |
|---|---|
| UI | `https://e03-ui.gpexe.com/` |
| API host the UI calls | `e03.gpexe.com` |
| Main UI endpoint | `POST /ui/v2/` |
| Health endpoint | `GET /ping/` |
| Authorization scheme (name only) | `JWT` |
| Session mechanism | the UI also uses a cookie/session mechanism; no value was kept |
| CORS | credentialed CORS is limited to the `e03-ui` origin |
| Version header | a GPEXE version header exists; observed version 9.11.7 |
| Team | the open session uses GPEXE Team ID 980 |
| `server3.gpexe.com` | no request observed during the check |
| Rate-limit headers | none observed |
| Token lifetime / rotation | unknown |
| Number of teams the account sees | not determined |
| Same account and Team ID 980 on `server3` and `e03` | unknown |
| Cross-host token validity | unknown, intentionally not tested |

**Security interpretation (binding for F3c):**
1. The JWT and the session cookie of `e03-ui` are the web application's own authentication.
   OptiMove must never copy, store or replay them.
2. The UI's JWT is not assumed to be the server-to-server API token the existing importer uses.
3. The existing importer still uses the REST API with `Authorization: Token`, while the old
   Sheets flow obtained its token from `server3` `/api-token-auth/`. Their compatibility is not
   proven.
4. A dedicated GPEXE API account and an official server-to-server token remain the goal of F3c;
   a personal browser session is not a credential source.

## 8b. What stays for F3c2 discovery (auth questions)

Before the Connect route is designed in detail (F3c2), and without any browser credential:
- U1/U2/U6 — which host issues the server-to-server token for the account OptiMove will use,
  and whether `e03` exposes `api-token-auth` for that account (the pilot's one observation is
  not enough); done by the owner in their own shell against the dedicated API account, ids only.
- U3 — token lifetime and rotation for that token type (documentation or GPEXE support).
- U4/U5 — whether the account sees more than team 980 and whether a REST team-list route
  exists (`team/`), read with the API token, ids only.
- U8 — the token's scope (read-only or not) and confirmation that a dedicated API account can
  be created.
Until answered, F3c2 assumes a token that may stop at any time, one host (`e03`), one team.

## 8c. GO / NO-GO for F3c1 (schema, encryption, audit)

*As built (owner order 2026-09-27, PR "F3c1"):* the F3c1 row of section 6 was narrowed. Delivered:
the three tables, the integrity rules of section 3, the ascending bound-team order function, the
per-team lock taken by the binding triggers, the crypto module, the rollback and the tests. Moved
to F3c2: the sweep over all bound teams of a connection (Connect / Reconnect / Disconnect), the
two overlapping-Reconnect concurrency tests, the fake-source marker-token test and the start-up
key check (the key is read only on use). F3c2 must lock the connection row before reading
`source_connection_bound_team_ids()`.

**GO, with the boundaries below.** F3c1 is source-neutral and does not depend on the open auth
questions: it adds the tables beside `gpexe_team_settings` (D6), the encryption helper with key
id and rotation, the audit table, the lock helper and the integrity rules of section 3, and no
route that talks to GPEXE. What F3c1 must **not** assume: the token type (it stores an opaque
ciphertext and a `credential_kind` column, e.g. `api_token`, so a different scheme later needs
no schema change), the host (only `host_key` against the allowlist, `e03` alone for now), a
team list (bindings are created one at a time by an admin), or a lifetime (the state machine
covers expiry). No row of the new tables is created for team 980 in F3c1 beyond what the
cut-over design later decides. F3c1 ships with the disposable-database tests listed in section
6 and stays unreachable from the UI until F3c2.

---

## 9. Out of scope, unchanged

The import switch, any import, the 60-athlete roster check, 5a3c, and the coach-facing Imports
flows. The legacy Apps Script remains a non-reference for import semantics (owner, 2026-09-17).

---

## 10. Review record

- `security-reviewer` (document only, 2026-09-27): READY WITH NON-BLOCKING NOTES for the owner
  decisions and F3c1; NOT READY for F3c2 as first written — two HIGH (no throttle on the
  exchange route; no cross-site/replay statement), three MEDIUM (owner_scope vs data_workspace
  not stated; info hiding not restated with the state model; no idempotency for Connect), two
  LOW. All folded in: rules 9–12, the 404 line in section 5, D9 amended, D10 and D11 added,
  section 8 step 1 tightened. Not assessable without code: whether a future request logger is
  added; `authz.js` conventions (to be followed in F3c2).
- `db-reviewer` (document only, 2026-09-27): NOT READY as a basis for SQL as first written —
  one BLOCKER (lock scope of a club-owned connection serving several teams undefined), three
  HIGH (D6 "move + view" underestimated; no recovery rule; no immutable-ownership rule for the
  new connection table), three MEDIUM (name clash and schema unstated; state CHECKs; credential
  columns null-together), one LOW (append-only triggers only implied). All folded in: the lock
  scope paragraph and integrity list in section 3, the table renamed
  `source_credential_connections` in `training_load`, D6 changed to "add beside", D12 added,
  F3c1's content, tests and gate rewritten. Not assessable without SQL: exact CHECK and trigger
  text, indexes for "all bindings of a connection", and the cut-over view's updatability (moot
  while F3c1 adds beside).
