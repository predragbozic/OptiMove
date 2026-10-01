# Current state

Last reviewed: 2026-10-01. Last `origin/main` commit checked: `47bf301` (merge of PR #131,
`feature/gpexe-rest-v1-adapter-f3c2a` → `main`; PR #130 `6f083a7` before it).

## Active phase

The **Training Load Dashboards UX redesign (H-slices)** is complete: H1 (PR #89), H2
(PR #93), H3 (PR #95) and H4 (PR #97) are merged, no further slice is scheduled, and the
small follow-up found during H4 is recorded under Separate tasks.

Alongside it, the **GPEXE import groundwork** is merged:
- the pilot importer (PR #99);
- database uniqueness and threshold bindings (v20, PR #101);
- a rehearsed undo of one imported session (PR #102);
- session and drill display in Activities (PR #103);
- undo authorization with a database deletion log (v21) and a backup proven by a trial
  restore (PR #104).

On top of it, the **in-app GPEXE import** phases F1 (check, candidates, preview; PR #106)
and F2 (approve and import; PR #107) are merged, and so are the coach screens F3a
(PR #110), the documentation consolidation (PR #112) and the settings change guard with
migration v24 (PR #113).

**The minimal F3b is merged** (PR #114, `f32e262`): a platform-admin-only `Settings →
Data sources` sub-tab — choose a team, see and set its GPEXE connection (first connect
without a reason, a change only with one, the same value idempotent, every v24 refusal in
plain administrator language), grant or revoke a coach's right to approve an import with
a reason and a confirmation naming the coach and the team. Deliberately out of it:
Disconnect, retention UI, the import switch, any real import.

**What the GPEXE connection is today (owner, 2026-09-27).** The stored GPEXE Team ID (980)
is only a team binding: it says which GPEXE team a team's imports read, nothing more. The
production Render service has no `GPEXE_API_TOKEN` configured, and production GPEXE has never
been read. The status shown as *Connected* therefore proves no live connection and is to be
renamed **Team linked**. No GPEXE username or password is stored anywhere, and none will be.
**F3c — source authentication and connection** is scheduled after 5a3b and before 5a3c:
discovery of the right API host (`server3` against `e03`), a safe way to obtain the token and
its encrypted storage, and Connect / Reconnect / Test connection in Settings → Data sources.
F3c has not started.

**The active phase is the source-neutral Imports track** (owner's mission, 2026-09-22;
blueprint v3.1 accepted as the direction on 2026-09-23). GPEXE is the first data source,
not the name of the feature; future sources (Garmin, Catapult, Polar, Kinexon, …) are
further Source cards on the same screen, never a new top-level screen. Phase 2 (the
Imports shell, PR #115), Phase 2b (candidate list reasons, PR #116), Phase 3a (the
read-only source-athletes endpoint, PR #117) and the guard PR before Phase 3b (one
canonical GPEXE athlete id, archived teams answer 404; PR #118) and Phase 3b (the
whole-team *Link athletes* screen, PR #119) are merged and deployed (see below).

**Phase 4a (server-side batch approval, PR #120) and Phase 4b (the batch import screen and
the sessions calendar, PR #121) are merged and deployed** (see below).

**Phase 5a1 (the session roster foundation) is merged and deployed** (PR #122, `cc4b0cc`; see
Last completed). The contract is `docs/ai/phase5a-discovery-and-contract.md`, approved by the
owner on 2026-09-25 (O1 (a) "Participated · no device data"; O2 team coach + club admin +
platform admin, recorded as the path of the ACTIVE workspace; the downgrade triggers moved to
5a2).

**Phase 5a3a, the read-only Activity roster shell, is merged and deployed** (PR #124,
`a643ffd`; see Last completed). The UX contract for the whole 5a3 roster UI is
`docs/ai/phase5a3-roster-ux-draft.md`.

**Phase 5a3b, individual and bulk roster decisions, as it was built** (since merged, see below; branch
`feature/activity-roster-decisions-ui-5a3b`; frontend and docs only, on the 5a2 commands as
merged in PR #123 — no backend, migration or rights change). It adds to the Roster tab:
- a state per row: *Participated · no device data* saved at once; *Did not participate*
  through the reason list of the roster answer with an optional note (an athlete with a
  source record is asked first); *Change* unfolds the other state, a new reason and *Remove
  this state* (with the consequence named); *Use measured values* (the only action once
  measured values arrived after a decision; an inline confirmation says the coach decision is
  removed — no "Keep this decision", contract Q1);
- *Two states* after a merge: both states with the coach who set each, no checkbox, one
  confirmed choice replaces both;
- a group decision: a checkbox only on rows without a saved state, *Select the N that need a
  state*, a selection kept across the chip filter with the hidden count named, a confirmation
  naming every athlete (hidden ones marked), athletes with a source record left out of a bulk
  absence and named, at most 60; a `bulk_conflict` names each refused athlete with the current
  state, unticks it and offers *Apply to the other N*;
- the three outcomes of every write (contract section 7): *Saved* (the roster is read again;
  a row with a fresh outcome stays visible under any filter until the filter changes), *Nothing
  was saved* only on a coded refusal (400/403/404/409, `roster_busy`, `internal_error`; the
  roster is read again and rows that changed under the coach are marked), and *Result not
  confirmed · Check result* for `outcome_unknown`, an uncoded 5xx, a lost answer or the 45 s
  client timeout — *Check result* repeats the same command with the same `requestKey`, so it
  can never write twice; a refused key is never reused. 403/404/`activity_superseded` lock
  every write control and offer *Back to activities* / *Open the current session*. A write in
  flight or an unconfirmed result is protected on session change, on leaving Training Load and
  on `beforeunload` (the Imports pattern). One command at a time: while a write is in flight or a
  result is not confirmed, every write control is off (Check result stays live), so a second
  command can never settle after the first and replace or clear its outcome;
- phones: one sticky action by priority (unconfirmed → selection → athletes need a state);
  *Set state…* opens one bottom sheet (both states and the reason list in the same sheet,
  never two), the page behind it does not scroll; 44 px targets, 16 px textarea.

Known API limit accepted for 5a3b: on `activity_superseded` the 409 body carries only the
canonical activity id, so the merged-session message is the generic one plus *Open the
current session* (the contract rows naming the athlete's state in the resulting session would
need a second read).

**Phase 5a3b is merged and deployed**: PR #125, merge commit `7e4d92d` (2026-09-27 12:12 UTC,
pinned to head `85cd489`); `/api/health` reported `7e4d92d` with `ok: true` three times, and
without a login `GET …/roster`, `PUT …/roster/:athleteId/decision` and `POST …/roster/decisions`
answered 401 (zero UUIDs, nothing written). No GPEXE action, Render environment and the import
switch untouched.

**The F3c discovery** (done) was accepted by the owner on 2026-09-27 as the basis for
F3c (source authentication and connection): `docs/ai/gpexe-f3c-auth-discovery.md` — confirmed
facts and unknowns (U1–U8 open), the `e03` vs `server3` endpoint map, the
`source_credential_connections` / `source_team_bindings` / audit model with the lock scope for
club-owned connections, the security contract, the five-state status model, the split
F3c1–F3c4, the owner decisions and the owner's guidelines (section 7a). **The owner-run
read-only capture of `e03-ui` is done (2026-09-27, section 8a, sanitized):** the UI calls
`e03.gpexe.com` through `POST /ui/v2/` (health `GET /ping/`) with a JWT scheme plus a
cookie/session mechanism, credentialed CORS limited to the `e03-ui` origin, GPEXE version 9.11.7,
Team ID 980, no request to `server3`, no rate-limit headers; token lifetime, the number of teams
the account sees, the `server3`/`e03` account relation and cross-host token validity stay
unknown (the last intentionally untested). The UI's JWT and session cookie are the web app's own
authentication and are never copied, stored or replayed by OptiMove; the importer's
`Authorization: Token` REST access and the old `server3` `/api-token-auth/` flow are not proven
compatible; a dedicated GPEXE API account with an official server-to-server token remains the
goal. U7 resolved, U8 partly, U1–U6 open for F3c2 discovery (section 8b). PR #126
(`bd98b5b`, the discovery document) and PR #127 (`4949b79`, the sanitized capture results and
the GO) are merged and deployed (`/api/health` served `4949b79`).

**F3c1 — source-neutral schema, encryption foundation and audit — is merged and deployed**
(PR #128, merge commit `848aa94` on 2026-09-28 12:04 UTC, pinned to head `6daf537` after two
external review rounds by the owner; `/api/health` served `848aa94` with `ok: true` four times).
**v27 on the deployed database is inferred** from that successful start (`npm start` runs
`node src/migrate.js &&` the server); the deployed database was not queried, so there is no
direct SQL proof. If it ran as inferred, it created only the four tables and the one catalog seed
row (`gpexe` / `e03`); no connection, binding or audit row can exist yet, because no merged code
writes to those tables, and no code touches `gpexe_team_settings`; no credential, no Render
change, no GPEXE request. It adds migration v27
(`migrations_v2/202609271000_training_load_v27_source_credential_connections.sql`): four
tables in `training_load` **beside** `gpexe_team_settings` — `source_host_catalog` (the approved
server keys per source, `gpexe`/`e03` seeded; GPEXE may run a different server per organisation,
so a new confirmed shard is one catalog row plus one exact-host entry in `sourceHosts.js`, never a
structure change and never a typed URL; at the time of v27 `server3` was left out until an
account and Team ID 980 were confirmed there (confirmed on 2026-09-29, approved by v28, see
below); a retired key takes no new connection and no new team
binding in the database; the backend's `resolveApprovedSourceHost()` answers `host_not_allowed`
unless the catalog row is approved AND the code resolves the key, with no fallback — calling it
before every request is a mandatory F3c2 gate, F3c1 has no network caller), `source_credential_connections` (club- or
team-owned, `host_key` an approved catalog key, a display label, a mandatory open `credential_kind`, the four credential parts null-together or complete,
the five states bound to their facts, identity immutable once bound),
`source_team_bindings` (one active binding per team and source, one active OptiMove team per
source team across every connection, team inside the connection's owner — and a team cannot be
moved to another club while bound through its club's connection, serialized with binding inserts
by the team lock —, rows end but never disappear, an optional
provenance pointer to the legacy GPEXE settings row that is never changed) and
`source_connection_audit` (append-only; who, when, action, outcome, reason, error code and a
flat sanitized object whose keys may never name a secret in any spelling — camelCase, hyphens
and case are normalised first); the rollback refuses once any connection, binding or audit row
exists, once the host catalog differs from the v27 seed, or once a later migration is recorded
(forward-only after that); `source_connection_bound_team_ids()`
gives the ascending lock order F3c2 will use, and creating or ending a binding takes that team's
import lock inside the trigger (try-lock style, v24 `hold_gpexe_team_lock`). **Narrowed by the
owner's order of 2026-09-27 against the discovery document's F3c1 row:** the sweep over all bound
teams of a connection, its two concurrency tests and the start-up key check move to F3c2 (which
must lock the connection row before reading the bound-team order). `backend/src/sourceCredentialCrypto.js` is
AES-256-GCM with a random nonce, an auth tag, a key version and AAD binding the ciphertext to
its row; the key ring `SOURCE_CREDENTIAL_KEYS` is read only when a credential is encrypted or
decrypted, so the server starts without it. `backend/src/sourceHosts.js` holds the allowlist
and the two credential kinds (owner decision 2026-09-27: `api_token` entered by the
administrator is preferred, `exchanged_token` from a one-time exchange is the fallback with the
password never stored or logged; F3c1 supports both and chooses neither). Runbook:
`docs/runbooks/source-connections-v27.md`; rollback rehearsed on a disposable database. **No
route, no UI, no GPEXE call, no cut-over, no row for team 980, no Render change; the local
OPTIMOVE database was not migrated (still v21).**

**F3c2 — source authentication — started with discovery.** The discovery PR #129
(merge commit `f26120f`, 2026-09-28 13:18 UTC, pinned to head `e0a58ca` after the owner's external
review; `/api/health` served `f26120f` with `ok: true` three times; nothing observable changed in
production — no route, adapter, migration or GPEXE request) delivered the procedure. Before any
Connect / Reconnect / Test route or network adapter is written, the GPEXE server-to-server
contract must be proven with the dedicated API account by the owner alone:
`docs/ai/source-connections-f3c2-contract.md` section 1 is the owner-run read-only procedure
(`backend/scripts/gpexe-auth-discovery.mjs`, unit-tested against a fake server, never sends a
request in tests, refuses every host without a profile (at that time every host but `e03`), never prints an environment
value; the owner returns only host key, masked paths, statuses, the scheme word, Team ID and
field names). It answers: which approved host issues the credential, official API token or
one-time username/password exchange, the exact endpoint / header scheme / lifetime / rotation,
whether the account sees Team ID 980, whether a read-only team-list endpoint exists, the minimal
scope. Section 2 is the source-neutral F3c2 contract with the eight mandatory conditions
(`resolveApprovedSourceHost()` before every call; connection row locked before the bound-team
order; all bound teams locked ascending; 5 attempts / 15 minutes counted from the append-only
audit; every attempt audited without secrets; stable codes without source text; Connect / Test on
the chosen host only, no fallback; no binding before a successful Test / Connect) and section 3
the test plan. **The adapter and the routes are not written until the owner's GO on the
discovery result.** As of PR #129 `server3` was not probed and not approved (superseded on
2026-09-29, see below); the browser JWT / cookie is never used.

**Step A is done (owner-run, 2026-09-28; contract document section 1.5):** on `e03.gpexe.com` the
API demands the `Token` scheme (401 without a credential on the team list), the only exchange
endpoint is `POST /api-token-auth/` (400 with an empty body, request fields `username` and
`password`; `/api/api-token-auth/` and `/api/token/` answer 404), GPEXE version 9.11.7. Not yet
confirmed: whether GPEXE issues a persistent read-only API token, the token field of a
successful exchange answer, lifetime and rotation, access to Team ID 980, the minimal role. The
owner's personal GPEXE account is not used for steps B or C without a new explicit decision; a
support request for a dedicated read-only credential limited to team 980 has been sent. **Next is
step B (persistent token) or step C (dedicated username/password through `/api-token-auth/`),
decided by GPEXE's answer; no adapter, route or PR until the credential kind is confirmed and the
1.3 form returned.**

**Step C was run once and refused (owner-run, 2026-09-29; contract document section 1.6).** By an
explicit owner decision one controlled exchange with the owner's existing GPEXE account was
allowed for the pilot. `POST /api-token-auth/` on `e03` answered `400` with the single field
`non_field_errors`; no token was issued, the team-list request was not sent, nothing was
repeated, no secret was shown and the environment variables were removed; the GPEXE version
header now reads 9.11.8. **Access to Team ID 980 is still not confirmed, and the credential kind
is still unknown.** The refusal concerns the username/password pair as a whole; its cause (the
identifier the endpoint expects, REST token authentication not enabled for the account, an
inactive API account, or a typing error) cannot be told from the status. No further exchange
attempt is made until the cause is narrowed without a credential (section 1.6: the account still
signs in to the UI; which identifier the UI asks for; the UI login's path and field names;
GPEXE support). The pilot decisions that depended on a confirmed team 980 are not in force. No
adapter, route or PR.

**Credential-free checks done (owner, 2026-09-29; contract document section 1.7), field names
only:** the existing signed-in `e03-ui` session works; the UI login form's fields are labelled
`email` and `password`, with no separate `username` field, while the REST exchange endpoint asks
for `username` and `password`. Whether REST token authentication is not enabled for the account
or the UI and the REST API keep separate account records is **not determined**. Step C is not
repeated. **The discovery stands at NO-GO for the adapter: no adapter and no Connect route may
claim that this account will work until a token has really been issued and Team ID 980 read.**
The question is with GPEXE support.

**Owner confirmation (2026-09-29; contract document section 1.8):** the owner's existing Apps
Script integration still works with the same account through `server3.gpexe.com`: exchange
`POST /api-token-auth/`, answer field `token`, header `Authorization: Token`, data under
`/rest/v1/`. For this account: UI host `e03-ui`, API host `server3`, API family `rest/v1`,
credential kind `exchanged_token`. **Every further authentication attempt on `e03` is stopped.**
That statement alone was not yet permission to add `server3` to production: until the
verification below succeeded it was in neither `backend/src/sourceHosts.js` nor the database
catalog (superseded on 2026-09-29 by the host profile PR). A host key never implies paths — host key,
exact base URL, API family (`api` against `rest_v1`) and auth scheme / exchange path are four
separate parts of a host profile, and `server3` + `rest/v1` is its own adapter profile; the
importer's client and mapper were verified against `e03`'s `api` family only. For the
verification the discovery script first carried its own `server3` profile (superseded on
2026-09-29: it now takes both hosts from the application's catalog). The plan then was: the owner
runs the one sanitized verification on `server3` (exchange → team list / team 980 → one session
page, four requests, no import, link or write) and returns the printed JSON; after a success a
small PR that adds `server3` to the code allowlist and, by a data-only v28, to the
host catalog — no credential, no binding for team 980, no route, no adapter.

**The `server3` verification was run once and refused (owner-run, 2026-09-29 19:27 UTC):**
`POST /api-token-auth/` on `server3` answered `400` `non_field_errors`, no token, the three reads
were not sent, the environment variables were removed. Two refused exchanges have now been sent
with this account (one per host). **Access to Team ID 980 is not confirmed; NO-GO for the
adapter and for the `server3` allowlist PR.** A structural comparison with the working Apps
Script (counts and booleans only, no value read out) shows the same field names and token field
and one wire difference: the script sends the body form-encoded, the discovery run sent JSON. Most likely the typed pair is not the pair
the script holds; the owner checks that privately (yes / no). The discovery script has
`--body-encoding form` for an exact reproduction. No further exchange without a new explicit
owner decision. (The legacy file `gpexe-code-check.js`, which held plain credentials in the
repository folder, has since been moved out and ignored.)

**The second `server3` verification succeeded (owner-run, 2026-09-29 19:39 UTC; contract document
section 1.8):** with the pair the working integration holds (the club's existing account) and a
form-encoded body, `POST /api-token-auth/` answered 200 with the single field `token`; with
`Authorization: Token` the team list (8 teams, contains 980), team 980 itself and one session
page (`X-Total-Count` 308, header paging) all answered 200. **Confirmed for this account: API
host `server3`, API family `rest/v1`, credential kind `exchanged_token`, scheme `Token`, token
field `token`, a read-only team list exists, Team ID 980 is readable.** Still unknown: token
lifetime and rotation, and whether a new exchange invalidates the token the existing Apps Script
uses. Not minimal: the account sees 8 teams and the endpoints advertise write methods; OptiMove
sends GET only and a binding must name team 980. The temporary owner decisions for the pilot are
in force (existing account for the pilot only; later switch to a dedicated account without a
schema change; Connect form with username and password exchanged at once and dropped; only the
AES-256-GCM encrypted token stored; Reconnect asks again; the password never returned or shown
as stored). **GO for the small PR that adds `server3` to the code allowlist (with `apiFamily` and
`exchangePath` per entry) and, by a data-only v28, to the host catalog.**

**The `server3` host profile is merged and deployed** (PR #130, merge commit `6f083a7`,
2026-09-29 21:05 UTC, pinned to head `f88b97b` after the owner's external review;
`/api/health` served `6f083a7` with `ok: true` three times; without a login the GPEXE `status`,
`candidates` and `source-athletes` routes, the roster read and `POST …/imports` answered 401,
zero UUIDs). **v28 on the deployed database is inferred** from the server starting after the
migration step (`npm start` runs `node src/migrate.js &&` the server); the deployed database was
not queried. `backend/src/sourceHosts.js` now holds a
complete profile per host — exact base URL, API family with its one path prefix (`api` → `api/`
on `e03`, `rest_v1` → `rest/v1/` on `server3`), auth scheme `Token`, and the exchange
(`api-token-auth/`, form-encoded, token field `token` on `server3`; none on `e03`, where no
exchange was ever confirmed). `sourceApiUrl()` is the only way to build a data URL and cannot
leave the host's own prefix; nothing takes a URL, falls back to another host, family or
encoding. Migration v28
(`migrations_v2/202609291000_training_load_v28_source_host_server3.sql`) is data only: one
approved catalog row `gpexe` / `server3`, no structure change; its rollback
(`docs/runbooks/source-hosts-v28-rollback.sql`) refuses once any connection uses the host, once
the row was changed, or once a later migration is recorded. **The account sees 8 GPEXE teams; a
binding and every request must be limited to Team ID 980** (the adapter reads from the bound
source team id only and checks the `team` of every answer). The legacy credential file was moved
out of the repository folder and is in `.gitignore`; it was never tracked. **No credential, no
connection, no binding for team 980, no Connect / Test route, no GPEXE request by the main
session.**

**F3c2a — the read-only adapter profile for `server3` / `rest_v1` — is merged and deployed**
(PR #131, merge commit `47bf301`, 2026-10-01 12:03 UTC, pinned to head `7765b3a` after the
owner's external review and two docs-only corrections; `/api/health` served `47bf301` with
`ok: true` three times; without a login the GPEXE `status`, `candidates` and `source-athletes`
routes, the roster read and `POST …/imports` answered 401; nothing observable changed in
production — no route uses the adapter, no migration). It adds
`backend/src/sourceAdapters.js` (an adapter is selected by `(source_system, apiFamily)`; a family
without one answers `adapter_not_available`; `gpexe` / `api` has none there, the `e03` importer
keeps its own client, unchanged) and `backend/src/gpexeRestV1Adapter.js`: every URL comes from
`sourceApiUrl()` with the approved catalog row; GET only, one closure talks to the network and no
generic request helper exists; the bound source team id is fixed when the adapter is created, no
operation accepts a team and an option that names one is refused; a returned team, session or
next-page link of another team is refused (`source_team_mismatch`), a team in an unknown shape
too; stable codes, never the source's text. Fake-fetch contract tests only. The compatibility
table is `docs/ai/gpexe-rest-v1-compatibility.md`.
**None of the importer's nine request kinds is proven on `rest_v1` yet.** Proven by the
owner-run verification of 2026-09-29 and implemented are three reads: the team list (count and a
boolean only), the read of the bound team, and the session list by team and page size with header
paging (the whole list or a refusal, drills left out) — the importer's own list always carries a
date window, which is not proven. **Remaining capability gaps — each answers
`source_capability_unavailable` until an owner-run read-only probe has seen its answer:**
sessions in a date window (`session_list_by_date`, legacy-attested parameter names), one session
(`session_read`, legacy-attested path), whole-session details (`session_details`,
legacy-attested path), drill details (`session_drill_details`), athlete rows
(`athlete_session_list`, `athlete_session_read`, `athlete_session_more`), tracks (`track_read`),
thresholds (`team_thresholds`), units (`units`) and session tags (`session_tags`,
legacy-attested path). So the importer cannot run on `server3` yet: a session bundle needs the
unproven reads. Also unverified: that `rest_v1` values mean what the mapper assumes for `e03`
(UTC timestamps, SI numbers, the drill model). **No route, no database write, no credential
storage, no binding, no import, no GPEXE request.** The compatibility document's section 4 holds
the probe rules the owner settled (2026-09-30 / 2026-10-01): the drill is read by position
(`details/?drill=0`) only after the parent is confirmed and then by its real id, with the
classification matrix (same / mapped / `not_observed`, never missing); the date window is proven
only when every row is of team 980 and inside the window and the filtered count is smaller than
the unfiltered count of the same run.

**The active step is F3c2b — the owner-run read-only capability probe** (branch
`feature/gpexe-rest-v1-capability-probe-f3c2b`, owner order 2026-10-01; the full mode was
externally reviewed at `6c51be3` and run once by the owner — see the next paragraph — and the
drill-only mode is now in review):
`backend/scripts/gpexe-rest-v1-capability-probe.mjs` runs one exchange in the host's confirmed
form and then GET requests only for Team ID 980 (at most 14 requests, a timeout per request,
answers bounded at 5 MiB, redirects never followed, no retry, no database), derives every id —
session, drill, athlete row, track — from an answer it has already received and checked, stops a
chain as soon as no safe next id exists, stops the whole run on a row of another team or of a
team in an unreadable shape, reads nothing of a session whose own read did not confirm team 980,
asks for the tag list for team 980 as well, applies
the drill matrix and the date-window rule of the compatibility document, and prints statuses,
shapes, field names, counts and booleans only. Fake-fetch contract tests
(`backend/tests/gpexe-rest-v1-capability-probe.test.mjs`). **The adapter, the routes, the
database, the UI, bindings and imports are untouched; the PowerShell commands for the run are
handed over only after the external review of the tool.**

**The full probe was run once by the owner (2026-10-01, after the external review of head
`6c51be3`) and succeeded:** `stoppedBy: null`, 11 requests (one exchange, ten reads), the report
sanitized by the owner; only its verdicts are recorded (`docs/ai/gpexe-rest-v1-compatibility.md`
sections 1–4), no id, date, value or field list. **Eight of the importer's nine reads are proven
`same` on `server3` / `rest_v1`** — the date window, the session read, the whole-session details,
the athlete list, the athlete row, its `/more/`, the track and the thresholds; the tag list was
observed for team 980; units stay unverified. **The drill read is `not_observed`:** the list rows
carry a `drills` list, but the parent session's own read carries `drills_count > 0` without a
`drills` list, so the probe's precondition for the two drill reads was not met and neither was
sent. **The adapter is unchanged: every one of the eight proven reads still answers
`source_capability_unavailable` until it is implemented with its own tests, on the owner's
order.** For the drill, the probe gained a narrow **drill-only mode** (`--mode drill`, owner order
2026-10-01, built, **not run**): one exchange and at most six reads, the parent confirmed from the
list row's `drills` plus its own read's `id`, `team` 980 and `drills_count > 0` (no `drills` list
required), the drill session confirmed by its own read (`id`, `team` 980), then the whole-session
details, the drill by position and the drill by id, classified by the existing matrix; any
identity or team not confirmed stops the chain without the next request (`parent_id_mismatch`,
`drill_id_mismatch`, `drill_parent_mismatch`, `team_isolation_failed`, `team_unknown_shape`, …);
the drill session's own read is reported as observed, never as an importer read; nothing of the
full run is repeated. Its PowerShell commands are handed over only after the owner's external review. No
GPEXE request by the main session, no route, no database write, no credential storage, no
binding, no import.

Review record of 5a3b: `code-reviewer`, `ux-design-reviewer` and `mobile-qa` (static), each with narrow
re-reviews after the fixes (see the PR). Browser QA by the main session on a static harness that
runs the branch's real modules against an in-page fake of the 5a2 API, at 1280 px and
360/375/390 px. **Integration QA passed on 2026-09-27** (main session, before the merge
decision): the branch's real backend and frontend ran against a disposable database
(`optimove_tests_gpexe_iqa5a3b_*`, migrated through v26, dropped afterwards) with the real 5a2
routes and a seeded coach, team, eight athletes and two sessions — single decision with author,
absence with a real reason and note surviving a full reload, Change and Remove matching the
database and the GET, a bulk of seven athletes all hidden by the filter changing only the named
seven, a stale `expectedDecisionId` refused as `decision_changed` with nothing written, a bulk
conflict writing nothing and *Apply to the other N* writing only the rest, a lost answer replayed
with the same `requestKey` (one request row, one decision), a double click and a second action
during a write producing one request, and a session change with a write in flight or a result
not confirmed asking first and never attributing the result to the other session. Not
production, no GPEXE call, no persistent database.

The remaining UI is split into 5a3c (Complete and Needs review) and 5a3d (mobile polish and
cross-navigation), with **F3c (source authentication and connection) placed between 5a3b and
5a3c** (owner, 2026-09-27; see the GPEXE connection note above). Manual values and estimates
remain 5b; later-measurement confirmation remains 5c.

Every later phase (5a2, 5a3, 5b, 5c, then 6) waits for the owner's go after each merge.

**Production-readiness checks recorded by the owner (2026-09-24), not gates for
development:** before the first real use of athlete linking and before
`GPEXE_IMPORT_APPLY_ENABLED` is turned on, the deployed `gpexe_athlete_links` must be
checked read-only for a non-canonical id (`select count(*) from
training_load.gpexe_athlete_links where gpexe_athlete_id !~ '^(0|[1-9][0-9]{0,11})$'`,
expected 0 — it could not be run from the development workstation, which has no path to
the deployed database); and a "Check now" already running when its team is archived still
completes and writes candidates (the background job does not re-resolve access) — to be
fixed before regular production imports (see condition 5 under Separate tasks).

All of it is code only. **`GPEXE_IMPORT_APPLY_ENABLED` is off in every environment and no
GPEXE data has been imported into the local OPTIMOVE or the deployed database**, so
nothing imported is visible in the app.

## Last completed, merged phases

- **Phase 5a3a: read-only Activity roster shell** — PR #124 (`a643ffd`, code at `e27d993`,
  merged and deployed 2026-09-27; `/api/health` reported `a643ffd` with `ok: true` three times
  and the roster route answered 401 without a login), frontend + docs only: the Roster tab of
  a team session (after Overview, only once the read confirms it; opens by itself when someone
  needs a state and never over a tab the coach picked), the header, the Needs a state / Needs
  review / Done / All filters, grouped read-only rows with source-neutral metric columns from
  the answer's measured values, the folded "Recorded, but not on this session's roster" group,
  the loading / retry / empty / 404 / merged states, and the phone cards at 760 px. Reviewed by
  `code-reviewer`, `ux-design-reviewer` and `mobile-qa`; browser QA by the owner on a static
  harness (2026-09-26). The 60-athlete scalability check stays under Separate tasks.
- **Phase 5a2: roster decisions and completion** — PR #123 (`8aa0de8`, reviewed head
  `048b78e`), backend + migration v26 + docs: five idempotent roster write routes,
  optimistic concurrency and the contract lock order; automatic `complete → needs_review`
  on every roster input; bounded COMMIT-answer and outcome-check waits; and an archived club
  that waits for an in-flight decision before later reads/writes become the same 404. Deploy
  was healthy on `8aa0de8`; v26 on the deployed database is inferred from the server starting
  after the migration step, not from direct SQL. External review by the owner.
- **Phase 5a1: session roster foundation** — PR #122 (`cc4b0cc`), backend + migration v25 +
  docs: membership history (`public.athlete_membership_periods`), `training.activity_roster()`,
  the reason catalog, the decision / request / completion / completion-log / observation
  tables with their integrity and append-only rules, `training.lock_activity_decider`, the
  read-only `GET /api/training-activity/:activityId/roster`, `record_unusable` observations
  from the GPEXE approval, and the undo's `roster_decisions_exist` rule. Runbook:
  `docs/runbooks/activity-roster-v25.md`. External review by the owner.
- **Imports Phase 4b: batch import screen and sessions calendar** — PR #121 (`73f181b`,
  reviewed head `8ac1172`), frontend only:
  - Only a clean Ready session with a valid `previewHash` from the list can be chosen (at most
    10); the selection keeps each session's hash as an opaque token, is pruned after every
    load, and a session reviewed before a link change is a Needs-attention item of its own
    while fresh Ready sessions stay importable (owner decision 2026-09-25; a stale
    `no_changes` session also goes to Needs attention).
  - One confirmation, one `POST …/imports`, one result line per session until Done; a lost
    answer is "Result not confirmed" with *Check again*, never resent by itself.
  - A source-neutral sessions calendar local to Imports, built from the candidates list alone
    (markers with a dot and a count, spoken labels, the verbatim "Markers show sessions
    already found by OptiMove. Other dates may not have been searched yet.", a local day
    filter with *Show all dates*, local-date day keys); folded by default at ≤760 px with a
    "Sessions calendar · <Month> · N sessions on M days" summary.
  - A `beforeunload` guard (the browser's own dialog) while a batch is being sent or an
    outcome is unconfirmed; deliberate app navigations (sign-out, athlete-mode switch) are
    not blocked. Closing the tab despite the warning can still lose the local view of the
    outcome; the server never imports twice.
  - Reviewed by `code-reviewer`, `ux-design-reviewer` and `mobile-qa`; browser QA at
    360/375 px on a disposable schema clone; external review by the owner.
- **Imports Phase 4a: server-side batch approve** — PR #120 (`655b56f`, reviewed head
  `5e881aa`), backend + tests + docs, no migration: `POST
  /api/training-load/gpexe/teams/:teamId/imports` `{ candidateIds, previewHashes }`
  approves up to 10 clean Ready candidates one after another, each through the existing
  `approveCandidate` (its own transaction, locks, recomputed preview and COMMIT check) —
  several atomic approvals, not all-or-nothing; the candidate list gained `previewHash`.
  Owner decision at the merge: `previewHashes` stays required, an optimistic-concurrency
  token binding the batch to the preview the coach received. Reviewed by `code-reviewer`,
  `security-reviewer` and `db-reviewer`; external review by the owner. Runbook:
  "Approving several candidates at once".
- **Imports Phase 3b: the whole-team *Link athletes* screen** — PR #119 (`b8214ef`,
  reviewed head `d690b79`), frontend only: opened from the Imports page, it lists every
  GPEXE athlete of the team once (`GET …/source-athletes`) with the last session's helper
  values (Time, Distance, Top speed, Drills — "—" where the source gave none), grouped
  *Not linked / Linked to an athlete no longer in the team / Linked*. The coach chooses a
  team athlete per GPEXE athlete (active members not yet linked; same-name athletes
  cannot be chosen; nothing preselected; choices staged in state), *Review N links* shows
  every pair with the consequences, *Link N athletes* sends them one by one through the
  existing link route with one result per pair (linked / not linked with the reason / not
  confirmed when the answer was lost), then reads the links and the list again once;
  *Unlink* is right there. The source-athletes read is a helper read: its failure alone
  never takes the inbox down (*Link athletes* off with a reason and *Try again*); a failed
  re-read after a link or unlink marks the last list as possibly out of date and turns
  every new link/unlink/review/send off until *Try again* succeeds. Reviewed by
  `code-reviewer`, `ux-design-reviewer` and `mobile-qa`; external review by the owner
  (three rounds).
- **GPEXE guards before Phase 3b** — PR #118 (`ca6d48f`, reviewed head `19c7866`),
  backend only: one canonical GPEXE athlete id wherever it enters (`"0"` or digits without
  a leading zero, at most 12; `GPEXE_ATHLETE_ID_PATTERN` in `gpexeImportMapper.js`) — the
  link route answers `400 invalid_gpexe_athlete_id` before any lock or write, the mapper
  refuses a snapshot row with a non-canonical id (`invalid_athlete_id`, inconsistent
  source data), the source-athletes list takes only canonical ids from previews and raw
  rows (bound as a parameter); a link row written before the rule is listed as stored. An
  archived team resolves to the same 404 as a missing one on every GPEXE route, for its
  coach, its club admin and a platform admin (Settings → Data sources therefore shows an
  archived team as not available). No migration: the v22 check stays the wider
  `^[0-9]{1,12}$`. Reviewed by `code-reviewer` and `security-reviewer`; external review by
  the owner.
- **Imports Phase 3a: read-only source-athletes endpoint** — PR #117 (`8d2841b`, reviewed
  head `2731ed2`): `GET /api/training-load/gpexe/teams/:teamId/source-athletes` lists the
  team's GPEXE athletes once each — every athlete seen in a snapshot that is still
  available (not purged, not expired) plus every athlete with an active link — with
  `status` (`linked` / `unlinked` / `linked_inactive`), the link (the OptiMove name only
  from it; no GPEXE name, it is never stored), a deterministic `lastSeen` (newest session
  date; same date: current before replaced, then the later sighting, then the larger id;
  `evidence` `preview` or `raw_snapshot`; the session's own `sessionDrillsCount`) and the
  athlete's `values` (`duration`, `distance`, `maxSpeed`; missing = `null`). A refused
  session's raw snapshot is a fallback only: it adds an athlete no available preview
  names, never replacing a preview sighting (owner decision (b)); the array guard sits
  inside the `jsonb_array_elements` argument. One SQL statement whatever the number of
  candidates or athletes (contract test); same readers and 404 as the candidates; security
  and isolation tests. Reviewed by `code-reviewer` and `security-reviewer`; external
  review by the owner (three rounds).
- **Imports Phase 2b: candidate list reasons** — PR #116 (`12d57ff`, reviewed head
  `a94f01b`): every candidate summary additionally carries `blockedCode` (source-neutral),
  `blockedSourceCode` (the adapter's own code, for Technical details), `sessionType` and
  `reasons` (one `{ code, count }` per kind), derived in memory from the stored preview
  the list query already reads (`backend/src/gpexeImportReasons.js`); no new SQL, and a
  contract test proves the list runs the same number of statements for one candidate as
  for four. The Imports inbox sorts every row from the list alone; the per-blocked-session
  detail read is gone. Reviewed by `code-reviewer`.
- **Imports Phase 2: the Imports shell** — PR #115 (`10d035a`, reviewed head `20c4273`),
  frontend only: the coach's tab is *Imports*; one Source card per source (GPEXE) with
  the connection state, "Sessions found …", one *Find new sessions* button and the dates
  folded away (opened and pre-filled, clipped to 31 days, only when a session needs
  other dates); the sessions sorted into *Needs attention / Ready to import / Stays out /
  Imported* from the fields the list returns (a session with an unlinked recorded
  athlete, or in which nobody is linked yet, is never "ready" or "up to date"); the Ready
  header and the next step say "review only" while the switch is off or the viewer may
  not approve; Ready locked after a link change until the sessions are found again; a
  workspace with no team shows one sentence plus the existing workspace menu (button
  only when the menu has another team or club to offer). Ids, statuses and server
  sentences only under Technical details. Reviewed by `code-reviewer`,
  `ux-design-reviewer` and `mobile-qa`; browser QA on a disposable schema clone.
- **In-app GPEXE import F3a: coach screens** — PR #110 (`ed49031`, reviewed head
  `4d36781`), frontend only: a "GPEXE imports" sub-tab in Training Load → Data &
  Analysis (`frontend/gpexe-import-{data,view,actions}.js`) on the F1/F2 routes.
  - Sessions are grouped by what the coach has to do (needs a decision, can't be imported
    yet, stays out, up to date, imported). A blocked session's reason and step come from
    its own detail.
  - The review shows participation and GPS apart, coach metric names (GPEXE's names only
    in Technical details), each left-out value with level, metric and reason, and every
    change to an already-imported result behind an accept checkbox.
  - Outcomes: imported, not imported (only an explicit refusal), and unknown. An unknown
    outcome is never shown as "not imported", stays marked in the list, and after three
    checks the coach is sent to a platform admin.
  - **Linking a GPEXE athlete** (owner decision (b), 2026-09-19): the session's values
    only help to find the athlete in GPEXE; no athlete is preselected; a confirmation
    shows both sides and says the link applies to this session and every GPEXE session
    imported later; a name shared by two team athletes can't be confirmed. After a link
    change a session's review is not approvable until a check that started after the
    change has seen that session (the server's preview hash check stays the real guard).
  - Reviewed by `code-reviewer`, `mobile-qa` and the `ux-design-reviewer` agent. That
    agent was added to `main` by PR #111, which is merged; this stacked docs branch predates it.

- **A team's GPEXE connection is only changeable while nothing depends on it** — PR #113
  (`4a60fa7`, reviewed head `238de27`), migration v24
  (`migrations_v2/202609211000_training_load_v24_gpexe_settings_change_guard.sql`).
  - `PUT /settings` allows the first connection, an idempotent repeat of the same value,
    and a change only while the team has no check, candidate, athlete link, approval or
    imported GPEXE data. Otherwise: 409 `gpexe_team_change_blocked`. The guard and the
    write are one transaction under the team import lock.
  - `change_reason` (v24): a first connection may carry one, a change requires one
    (trimmed, non-empty, at most 500 characters), a repeat of the same value writes no
    history row and never overwrites the reason. The history stays append-only and
    admin-only; rows from before v24 keep a NULL reason.
  - The database refuses the rest whoever writes it, psql included: the settings row is
    never moved to another team, never deleted or truncated; a first connection over
    leftover GPEXE data is refused (409 `gpexe_orphan_data`); an athlete link needs the
    connection; a check row carries the team's current GPEXE team and that identity is
    final from the row's creation (a row from before v24 stays empty forever); a check
    row is never deleted.
  - `startCheck` takes the team lock in one short transaction, writes the check row with
    the locked GPEXE identity, commits, and only then calls GPEXE.
  - No Disconnect, nothing deleted or re-pointed, the import switch untouched.
  - External review by the owner: three rounds; `db-reviewer` and `code-reviewer` READY.
- **Documentation consolidation** — PR #112 (`a18b9cb`), docs only: it replaced the
  stacked documentation PRs #98, #100, #105 and #109, which were closed as superseded.
- **Reviewer rule for transactions with an external effect** — PR #108 (`636fdf3`),
  `.claude/agents/code-reviewer.md` and `db-reviewer.md` only. For a change to a
  transaction that writes important data (import, deletion, approval), the reviewers
  check five things before READY:
  - an error before, during and after a successful COMMIT;
  - success, an explicit error, and an answer that never comes;
  - that the answer tells apart "not written", "written" and "outcome unknown";
  - the connection, the locks and a retried request in each outcome;
  - one targeted test through the real route.

  Owner decision: it stays in the two agent files, not in a shared rules file.
- **In-app GPEXE import F2: approving imports** — PR #107 (`cb3399a`, reviewed head
  `d1d92db`), migration v23
  (`migrations_v2/202609201000_training_load_v23_gpexe_import_approval.sql`).
  - `POST /api/training-load/gpexe/teams/:teamId/candidates/:candidateId/approve
    {previewHash, acceptChanges}` imports the **whole candidate** exactly as its preview
    showed it. Refused with nothing written when:
    - the switch is off;
    - the caller has no right;
    - the candidate is not pending, or its snapshot expired;
    - the preview is not the one reviewed;
    - changes to already imported results were not accepted.
  - **One transaction:** approver rights (`lock_gpexe_import_approver`, role, grant and
    user rows `FOR SHARE`) → candidate `FOR UPDATE` → team import lock → the import and
    the preview recomputed from it → hash compare → approval row → candidate `imported`.
    A different hash rolls everything back, including what the import wrote, and answers
    409 `preview_changed` with `reviewAgain`.
  - **Preview v2 `changesToImported`** lists every already imported result the import
    writes to (`corrected`, `supplemented`, `needs_review`, `stale_resend_ignored`). The
    approval needs `acceptChanges` for them.
  - **v23:** `training_load.gpexe_import_approvals`, one per candidate. It is append-only
    and cannot be truncated. Its trigger re-checks:
    - the right and its basis;
    - the candidate's state, content hash and preview hash;
    - the number of changes.

    A candidate becomes `imported` only from `pending` with its approval, and is never
    inserted as `imported`.
  - **The COMMIT's outcome** (two external review rounds):
    - once the COMMIT is sent, the answer never says "nothing was imported";
    - the answer to the COMMIT is awaited at most 15 s. After an error or that time, the
      connection is closed, and the approval is looked for on another connection (at most
      5 s);
    - the answer is then `200` with `verified_after_commit_error`, or `503
      import_outcome_unknown` with `verify` links;
    - `GET .../approvals/:approvalId` exists, and an imported candidate names its
      approval;
    - a failed candidate read after the commit still answers `200` with
      `candidateReadError`.
  - External review by the owner: three rounds, READY on `d1d92db`.
- **In-app GPEXE import F1: check, candidates, preview** — PR #106 (`96d876d`, reviewed
  head `b070a54`), migration v22 (`migrations_v2/202609191000_training_load_v22_gpexe_in_app_import.sql`).
  - **"Check now"** runs in the background and reads GPEXE through a fixed-host,
    GET-only client (`backend/src/gpexeClient.js`). Header paging is read to the end or
    refused.
  - **Candidates:** one per (team, session, content). New content supersedes older
    candidates that were never imported.
  - **The preview** is a rolled-back run of the real import under the team lock. It
    shows participation and GPS separately and gives a reason for every left-out value.
    An athlete imported earlier and now left out blocks the session, with the step that
    lifts it.
  - **Approver grants** (platform admin only), athlete links, raw-snapshot retention
    (30 days unapproved, 90 days after import), and a purge that does not depend on one
    process.
  - The real GPEXE API was checked read-only by the owner's probe
    (`backend/scripts/gpexe-api-probe.mjs`).
  - Runbook: `docs/runbooks/gpexe-in-app-import.md`, which also covers F2.
- **GPEXE undo authorization, deletion log and verified backup** — PR #104 (`6c5b3a6`),
  migration v21 (`migrations_v2/202609181000_training_load_v21_import_deletion_log.sql`).
  - **Who may run the undo** (`backend/scripts/gpexe-undo-imported-session.mjs`): only an
    **active platform admin** (active `user_global_roles` role and `users.is_active`),
    always with a reason.
    - The script checks this before taking any lock, and the v21 insert trigger checks it
      again (SQLSTATE 42501).
    - `--reason` and `--performed-by-user-id` are required on every run, dry run included.
    - The script still refuses any database that is not a disposable
      `optimove_tests_gpexe_*` one.
  - **`training_load.import_deletion_log`**:
    - one row per removed event, written in the **same transaction** as the removal;
    - records the session, team, day, admin, reason, threshold set, and rows removed per
      table and in total;
    - append-only against UPDATE, DELETE and TRUNCATE;
    - a row can only name an active platform admin and an event that no longer exists;
    - lock order: `user_global_roles` (FOR SHARE) → `metric_events` → `activities`.
  - **Verified backup** (`backend/scripts/gpexe-backup-verify.mjs`,
    `docs/runbooks/gpexe-backup-verify.md`):
    - `pg_dump` runs on an exported snapshot;
    - the dump is restored into a new `optimove_tests_gpexe_restore_*` database, which is
      always dropped afterwards;
    - the copy is compared table by table (row count plus a digest of every row) and per
      catalog object, including whether each trigger is enabled;
    - an unverified dump is deleted, and a verified one gets `<dump>.verify.json` with its
      sha256;
    - local sources only; `pg_dump`/`pg_restore` inherit no `PG*` variable and get
      explicit connection arguments.
  - **Known limit, stated in the runbook**: the CLI cannot authenticate its operator. It
    checks that the given user id is an active platform admin, not that the person running
    it is that admin. The runbook lists what must be in place before any persistent-database
    unlock.
- **GPEXE session and drills in Activities** — PR #103 (`37dadb1`), frontend only.
  - The Activities drawer shows the whole session and each drill separately, with readable
    metric names, and marks real conflicts.
  - Dashboards series are named from the metric catalog.
  - The Dashboards "Bucket" column still shows raw ids (see Separate tasks).
- **GPEXE undo procedure** — PR #102 (`df3cc6b`): `backend/scripts/gpexe-undo-imported-session.mjs`
  and `docs/runbooks/gpexe-undo-imported-session.md`.
  - Undoes one imported session in a fixed order.
  - The v13/v20 immutability triggers are disabled only inside that one transaction, and
    the commit is refused unless they are enabled again.
  - A JSON log is written before the commit (`pending`, then `committed`).
  - It refuses rather than guesses when it finds:
    - a manual correction;
    - an activity shared with, or linked to, another event;
    - a merged or reparented activity;
    - two events for one GPEXE session.
  - Disposable databases only.
- **GPEXE uniqueness and threshold provenance** — PR #101 (`c066b3b`), migration v20
  (`migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql`).
  - One active GPEXE connection per team.
  - A trigger refuses a second event for the same GPEXE connection and `team_session:<id>`,
    and freezes the source identity of a bound event.
  - `training_load.metric_event_source_bindings` records, per event, the GPEXE threshold
    set the values were imported under:
    - the hash covers the set id and the payload;
    - the hash version has its own column;
    - rows cannot be changed.
  - The writer stops with `binding_missing`, `source_reference_set_changed` or
    `reference_hash_version_outdated` instead of mixing threshold sets.
- **GPEXE pilot import (code only)** — PR #99 (`41e9555`), backend only:
  `backend/src/gpexeImportMapper.js` (pure plan builder) + `backend/src/gpexeImportWriter.js`
  (one transaction under a team advisory lock) + `backend/scripts/gpexe-import-pilot.mjs`
  (CLI) + `backend/scripts/gpexe-pilot-disposable-run.mjs` + `backend/tests/gpexe-import.test.mjs`.
  One GPEXE team session becomes a `training_load.metric_events` row with participants,
  drill segments, occasions and values, plus the activity the existing
  `training.materialize_activity_group_from_metric_event` materializes with one
  `activity_components` row of type `drill` per segment.
  - **Only GPEXE's own values are stored**: TIME (min), TotDist (m), SPEEDmax (km/h),
    acceleration/deceleration events, burst/brake events (definition unconfirmed),
    "Sprint distanca ≥25,2 km/h" (m) from the GPEXE 7 m/s speed zone, and each GPEXE power
    zone separately (25–60, 60–75, ≥75 W/kg). Owner decision 2026-09-17: `m/min`,
    `Acc+Dec`, `Burst&brakes`, `HMLD ≥25 W/kg` and `EXPDist ≥60 W/kg` are **not**
    imported — they wait for a derived-metrics feature with a formula and a formula
    version, so an OptiMove-computed sum is never stored as a value GPEXE delivered.
  - **Identity and idempotency**: separate source identities
    `athlete_session:<id>:full` and `athlete_session:<id>:drill:<n>`; the occasion content
    hash covers unit, level, `aggregation_role`, `coverage` and the GPEXE source context;
    values fetched later (drill burst/brake) become current through a `supplemented`
    supersede path that only adds metrics while every existing value stays identical, while
    changed, dropped or older data stays `needs_review` and a manual correction is never
    replaced.
  - **Verified on a disposable database only** (`optimove_tests_gpexe_*`, created and
    dropped in the same run, with real responses for team 980 / session 186942): first
    import 19 results, then 15 drill results supplemented with burst/brake, a repeat import
    writing nothing, and two concurrent imports ending in the same state as one.
    `backend/tests/gpexe-import.test.mjs` covers mapper, writer, concurrency, deadlock, the
    dashboard source filter and the CLI guard.
  - **Nothing was written to the local OPTIMOVE or the Supabase database**, and the CLI
    refuses to: `--apply` requires a local `optimove_tests_gpexe_*` database carrying the
    marker table written by `backend/tests/_gpexe-disposable-db.mjs`, and `--dry-run` (the
    default) opens no connection at all. **No imported GPEXE data is therefore visible
    anywhere in the app today.**
  - Also fixed: `fetchOccasionContexts` in `backend/src/trainingLoadDashboardQuery.js` did
    not read `entry_method`, so the dashboard source policy (manual / api_import /
    csv_import) could never match imported values.
  - The read-only fetch script that collects the GPEXE responses stays **outside the
    repository** (owner decision 2026-09-17); the token never leaves the owner's own shell.

- **Dashboards UX H4** — PR #97 (`70eabaf`), frontend only.
  - **Readable labels in Advanced settings**, named after what the query engine does with
    each stored value (`resolveFactsToRows` / `shiftDateRange` in
    `backend/src/trainingLoadDashboardQuery.js`, value meanings in the v3 Metrics-Core and
    v16 dashboard migrations); stored values and request bodies are unchanged. Source =
    how a catalog metric's value was recorded (All sources, Manual entry only, API import
    only, CSV import only, Calculated values only, One connected source); Values included
    (`aggregation_role_policy`) = direct values / source totals / calculated totals; Total
    coverage (`coverage_policy`) = complete / partial / unknown-coverage totals, direct
    values pass every choice. A help text explains the terms and conflicts. For built-in
    metrics the three filters are disabled with a note, because
    `queryBuiltInSeriesFromContext` never applies them. Owner decision 2026-09-17 at the
    H3 merge: meanings verified before naming.
  - **Remaining leave-guard exits**: notification rows that open another screen and a
    workspace switch now ask before any request (`confirmLeaveTrainingLoad(_, { discard:
    false })`). Declined changes nothing; the draft is discarded only after the request
    succeeded (a notification's mark-read, then `discardTrainingLoadLeaveDrafts`; a
    workspace switch resets Training Load itself), so a failed request loses nothing.
    Covers both an unsaved layout and an unsaved Advanced settings change. The
    **messages panel** exit was **not reproduced** live (open, conversation, send, close,
    outside click, Escape, phone Back all kept both drafts) and was left unchanged.

- **Dashboards UX H3** — PR #95 (`d2189fa`), frontend only: the advanced widget editor
  ("Advanced settings") edits a local draft; nothing is sent before "Save changes", and
  Cancel, Escape, section switch and the H2 leave guard ask "Discard your unsaved widget
  changes?". Save sends only the difference through the existing widget/series endpoints,
  in an order the v16/v17 triggers accept (add-first below the type's series cap,
  delete-first with exact restore at the cap and on line/bar charts; the widget type
  change before or after the series changes depending on direction). After a failure the
  dashboard reloads when something may have been written (a completed step, a lost
  response, or a 409/404), and the draft is rebased 3-way (base / draft / server): a series
  whose response was lost is adopted, not posted again, and a retry after a stale
  revision keeps other users' changes. Checks before any request: series cap, a
  built-in's fixed data level, text-metric aggregation, catalog data levels, one unit per
  chart axis, comparison only on KPI. Also fixed in the H1 guided panel: "Session count" /
  "Last session date" now use data level `day`, and a metric change on a line/bar chart
  deletes first. External review (trigger #4) done by the owner on `7aea7cc`.

- **Dashboard permanent delete + deletion log** — PR #91 (`0de6afb`). Migration v19
  (`migrations_v2/202609170900_training_load_v19_dashboard_delete.sql`):
  `training_load.delete_dashboard(id, expected_revision, deleted_by_user_id,
  authorized_via)` and the append-only `training_load.dashboard_deletion_log`.
  `DELETE /api/training-load/dashboards/:id` uses the same manage rule as Rename/Archive
  (`canManageDashboardRow`); system templates are never deletable (409
  `systemTemplateProtected`); a dashboard that was cloned from cannot be deleted (409
  `dashboardHasClones`, archive instead). Owner decision (c): a platform admin keeps the
  right to delete any non-system dashboard, and every delete made through
  `delete_dashboard()` writes one log row (who, basis `owner`/`club_admin`/`team_coach`/
  `platform_admin`, what, when) in the same transaction. Only deletes through that
  function are logged; a raw SQL delete on `dashboards` is out of contract (ADR-003).
  Archive stays available.
  - **v19 on the local OPTIMOVE database**: applied 2026-09-17 with the standard runner
    (`npm --prefix backend run migrate`) after a verified `pg_dump` backup, then checked
    with a disposable probe dashboard whose rows were removed afterwards.
  - **v19 on the deployed database**: application is **inferred** from the successful
    server start of the deploy of `0de6afb` (`npm start` runs `node src/migrate.js`
    before the server, and `/api/health` reported commit `0de6afb` on 2026-09-17). The
    deployed database itself was **not** queried directly.
- **Dashboards UX H2** — PR #93 (`0a5936c`), frontend only: widget "⋯" menu (Settings,
  Advanced settings, Edit layout, Delete widget) on every widget of an editable dashboard;
  layout mode with one layout bar (Cancel / Save layout or Done; sticky on desktop, pinned
  to the bottom on phones) and layout-only per-widget tools (no-op moves disabled; phones
  get Move up/down only). An unsaved layout is never dropped silently inside Training
  Load, through the main sidebar/rail, or through browser Back: `releaseAnalysisLayoutDraft`
  / `confirmLeaveTrainingLoad` ask "Discard your unsaved layout changes?" first (a declined
  Back restores the consumed history entry). The remaining exits (notifications, workspace
  switch) were closed in H4 (PR #97).
- **Dashboards UX H1** — PR #89 (`3ef6033`), frontend only: dashboard picker (search,
  groups, badges), "New dashboard"/"Rename" dialog replacing `window.prompt`, dashboard
  "⋯" and period-preset menus, guided "Add metric" panel (changes staged client-side,
  nothing sent before Save; Save chains the existing widget/series endpoints; partial-
  failure handling for new widget, add-first, KPI delete-first and lost responses).
  `/query` evaluates only saved widgets, so there is no live preview of an unsaved widget
  (static configuration preview instead).
- **Dashboard list visibility fix** — PR #90 (`00a6d9b`): the list no longer reveals other
  users' private dashboards (`dashboardVisibilitySql` data-workspace clause guarded with
  `owner_scope <> 'user'`); see the residual drift under Open risks.
- **Training Load IA/UX redesign, Phases A–G** — PRs #82–#88, all merged: A IA shell
  (Schedule · Data & Analysis), B shared Monday-anchored week across Data & Analysis, C
  Activities identity + first Carbon-referenced visual pass, D Athletes consolidation, E
  Overview, F Dashboards hand-off + shell Filter shown unavailable on Dashboards, G cleanup
  (PR #88, removed the unreachable manual RPE reminder UI — see Separate tasks). Carbon is
  a design reference only, never a runtime dependency.
- **Training Load dashboard backend (3B2)** — schema (`migrations_v2` v15–v18: catalog,
  dashboards, widgets/series, sanctioned functions, catalog seed) + routes
  (`backend/src/routes/trainingLoadDashboard.js`) + Access/Query/Catalog/Widgets service
  split. See ADR-001 through ADR-004, ADR-006.
- **Training Load Analysis frontend (3B3)** — PR #77 (`111134d`): Analysis tab, batch
  query, KPI/Table widgets, widget/series configuration, desktop 12-column layout editing
  with real pointer drag/resize, atomic Save/Cancel/reload persistence, Calendar →
  Analysis activity picker hand-off, mobile (360/375/390px) with Move up/down instead of
  drag/resize.
- This `CLAUDE.md`/`.claude/agents/` reviewer workflow (`code-reviewer`, `db-reviewer`,
  `mobile-qa`, `security-reviewer`) — merged as part of the PR #77 history.

**Implemented ≠ deployed.** The deploy and database facts checked for this file:
- PR #122 (`cc4b0cc`) is deployed (owner, 2026-09-25). **v25 on the deployed database is
  inferred** from the successful server start of that deploy (`npm start` runs
  `node src/migrate.js &&` the server); the deployed database was not queried.
- **The local OPTIMOVE database is still at v21** (owner, 2026-09-25): v22–v26 are not applied
  there, and the 5a2 work neither migrated it nor wrote to it (every 5a2 test runs on disposable
  `optimove_tests_gpexe_*` databases).
  It was last re-checked read-only on 2026-09-25 before PR #122 (the last recorded migration
  is v21).
- `/api/health` reported commit `73f181b` (PR #121) after that merge on 2026-09-25; the
  smoke was unauthenticated only (no search, link, unlink or import in production).
- `/api/health` reported commit `655b56f` (PR #120) with `ok: true` on 2026-09-24; the new
  batch route answered 401 without a login (POST with an empty body and a non-existent
  team id). No batch, search, link or import was run in production.
- `/api/health` reported commit `b8214ef` (PR #119) with `ok: true` on 2026-09-24; the
  served bundle contained the *Link athletes* screen (with *Try again* and the
  out-of-date warning), and the GPEXE `status`, `candidates`, `athlete-links` and
  `source-athletes` routes answered 401 without a login. No search, link, unlink or import
  was run in production.
- `/api/health` reported commit `ca6d48f` (PR #118) with `ok: true` on 2026-09-24 (three
  consecutive checks); the GPEXE routes answered 401 without a login. No search or import
  was run in production.
- `/api/health` reported commit `8d2841b` (PR #117) with `ok: true` on 2026-09-24 (three
  consecutive checks); the new source-athletes route answered 401 without a login. No
  search or import was run in production.
- `/api/health` reported commit `12d57ff` (PR #116) with `ok: true` on 2026-09-23; the
  served bundle carried the new row sentences and none of the removed detail-read code,
  and a GPEXE route answered 401 without a login. No search or import was run in
  production.
- `/api/health` reported commit `10d035a` (PR #115) with `ok: true` on 2026-09-23; the
  served bundle contained the Imports screen (the "Find new sessions" button, the four
  bucket headings, the no-team sentence; the old "Check GPEXE" text gone) and a GPEXE
  route answered 401 without a login. No search or import was run in production.
- `/api/health` reported commit `f32e262` (PR #114) with `ok: true` on 2026-09-22; the
  served bundle contained the Data sources screen and the new
  `GET …/settings/history` route answered 401 without a login. The owner accepted that
  unauthenticated smoke as sufficient (admin/coach visibility is covered by tests and the
  disposable-database browser QA). No Check, Connect, grant, revoke or import was run in
  production.
- `/api/health` reported commit `a18b9cb` (PR #112) with `ok: true` on 2026-09-21, and
  `4a60fa7` (PR #113) with `ok: true` on 2026-09-21 after that merge.
- **v24 on the deployed database is inferred** from the successful start of the deploy of
  `4a60fa7` (`npm start` runs `node src/migrate.js &&` the server). The deployed database
  itself was **not** queried.
- **v22, v23 and v24 are not applied to the local OPTIMOVE database**, which is at v21.
  Applying them is a separate decision.
- `/api/health` reported commit `0de6afb` on 2026-09-17.
- `/api/health` reported commit `6c5b3a6` on 2026-09-18.
- `/api/health` reported commit `96d876d` (F1) and later `cb3399a` (F2) on 2026-09-18.
  The new GPEXE routes answered 401 when called without a login on the deployed app
  (checked on 2026-09-18), as expected from `requireAuth` on the whole router.
- `/api/health` reported commit `ed49031` (F3a) with `ok: true` on 2026-09-19. The
  served frontend contains the GPEXE imports screens, and a GPEXE route answered 401
  without a login. The tab itself was not opened on the deployed app (no signed-in
  session there).
- **v22 and v23 on the deployed database are inferred** from the successful start of
  those deploys (`npm start` runs `node src/migrate.js &&` the server). The deployed
  database itself was **not** queried.
- `GPEXE_IMPORT_APPLY_ENABLED` is off in both environments. No real import has been run.
- v20 and v21 on the deployed database are **inferred** from the successful start of
  the deploy of `6c5b3a6` (`npm start` runs `node src/migrate.js &&` the server). The
  deployed database itself was **not** queried.
- **v20 and v21 on the local OPTIMOVE database**: applied 2026-09-18 with the standard
  runner (owner-approved). The steps were:
  - a fresh backup taken immediately before, verified by a trial restore with
    `backend/scripts/gpexe-backup-verify.mjs` and kept outside the repo;
  - the migration run itself;
  - a direct check afterwards:
    - both new tables exist and are empty, and the three deletion-log triggers are
      enabled;
    - every table that existed before has the same row count and content digest, apart
      from the two new `schema_migrations` rows;
    - the catalog only gained objects; nothing existing changed or disappeared.
  - No GPEXE data was imported.

Re-check the hosting target and the database before asserting a deploy state later.

## Known baseline/environment test issues

Reproduce against a clean detached `origin/main` worktree before calling a failure
pre-existing; pass/fail counts don't belong in this file
(`.claude/rules/memory-maintenance.md`).

- `frontend/tests/tests-schedule-management.actions.test.mjs` — the Tests-module calendar
  click/drag day-selection tests (`startTestsCalendarDrag`/`extendTestsCalendarDrag`/
  `endTestsCalendarDrag` in `frontend/tests-actions.js`) fail; confirmed on clean
  `origin/main` before the 3B3 work. Not re-reproduced in this update.
- `backend/tests/tests-athlete-device-timezone.test.mjs` — test "13. the worker's
  occurrence-generation phase catches an ahead athlete's occurrence in its very next
  cycle…" fails; reproduced identically on a clean detached `origin/main` worktree
  (`3ef6033`) on 2026-09-17.
- `frontend/tests/training-load.actions.test.mjs` — the process never exits after the
  suite runs. It was reproduced on clean `main` on 2026-09-18, but the baseline commit
  was not recorded. Not fixed.
- `backend/tests/activity-roster-5a2.test.mjs` — test "56. migration v26: applied by the runner
  on v25, the rollback returns the schema to v25 exactly…" fails on the digest of
  `training.lock_activity_decider`; reproduced identically on a clean detached `origin/main`
  worktree (`f26120f`) on 2026-09-29. The cause is not established (the checked-out SQL files
  carry CRLF line endings on this workstation, which is a candidate, unverified). Not fixed.
- `backend/tests/training-load-metrics-builder-edit-draft.test.mjs` — refuses to start
  unless `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` is set (deliberate guard, no database
  operation attempted), so a plain full backend run reports it as failed; same on
  `3ef6033`.

## Separate tasks (recorded, waiting for the owner to schedule them)

- **Roster scalability check with 60 athletes** (owner, 2026-09-26, after PR #124's browser
  QA): the 25-athlete roster used in QA was only a test scenario, not a product limit. The
  roster must support every athlete of a team; check the roster with 60 athletes (layout,
  filters, reading speed) as a future scalability test. Not a merge blocker for 5a3a.

- **In-app GPEXE import — conditions before the switch is turned on** (owner, 2026-09-18).
  F1, F2, F3a and F3b are merged (see above); F4 is the first real local import. `GPEXE_IMPORT_APPLY_ENABLED` stays off in an
  environment until conditions 1–3 hold there; condition 4 is required before regular
  production imports:
  1. **A fresh, restore-verified backup of that environment.** This is an operational
     gate: `docs/runbooks/gpexe-in-app-import.md` has a record table (backup path or
     identifier, `.verify.json`, when it was verified, who confirmed it). The local
     OPTIMOVE and Supabase are separate decisions. The app never claims a backup was
     checked. Before regular self-service imports, a mechanism that reliably checks
     backup freshness is to be proposed, instead of a switch left on.
  2. **A bound on the lock waits before the COMMIT** of an approval: the approver's role
     and grant rows, the candidate, and the team import lock. For example `lock_timeout`
     and `idle_in_transaction_session_timeout` with a stable refusal code, and the
     deployed request timeout confirmed. Today another approval of the same team, or a
     transaction abandoned on a real network stall, can make an approval wait with no
     limit.
  3. **The undo script takes the team import lock** (`lockTeamForImport`) before it is
     ever used on a persistent database. Today it runs only on disposable databases.
  4. **Mandatory before regular production imports** (owner, 2026-09-19): a safe,
     verified production procedure for results imported under a wrongly linked GPEXE
     athlete. Unlinking only ends the link and never changes imported results; the app
     tells the coach those results "can't be changed here — contact a platform
     administrator". Today the only path is the controlled admin undo
     (`docs/runbooks/gpexe-undo-imported-session.md`), rehearsed on disposable databases
     only. The procedure must be defined and verified.
  5. **Mandatory before regular production imports** (owner, 2026-09-24): a "Check now"
     that is already running when its team is archived still completes and writes its
     candidates — the background job does not re-resolve access (PR #118 closed the routes
     only). Not a blocker for the guard PR or Phase 3b; must be fixed before regular
     production imports are switched on.
  - Planned shape (as built in F1–F2):
    - "Check now" fetches from GPEXE;
    - a list of import candidates;
    - a review of what would change;
    - an explicit approve button.
  - Periodic checks and notifications can later feed the same candidate queue.
  - **One athlete** whose session data needs review stays **flagged for review**. The
    identity and details are only in the report kept outside the repo. That athlete's
    data must **not block** importing the other athletes.
  - Before any real import, take a **new verified backup** of the state at that moment.
    The 2026-09-18 backup (`...-r2.dump`, kept outside the repo) does not replace it.
  - Not approved yet: any write of GPEXE data to the local OPTIMOVE or the deployed
    database.
  - Owner decisions for the plan, 2026-09-18. F1 was approved to start.
    - **Phases:**
      - F1: fetch, candidates and preview;
      - F2: approval and the actual import;
      - F3: screens;
      - F4: the first real local import, after a fresh verified backup.
    - **Credentials:** the GPEXE token lives only in the server environment
      (`GPEXE_API_TOKEN`).
    - **Who may approve:** an active platform admin, or a coach who holds an explicit
      approver grant for that team. Only a platform admin grants and revokes those
      grants. The server checks the right on every request and records who approved.
      Coaches without the grant can review candidates but not approve them.
    - **`GPEXE_IMPORT_APPLY_ENABLED`:** it blocks writing results and activities. "Check
      now" still writes candidates and the check record. When it may be turned on: see
      the three conditions above.
    - **Raw GPEXE JSON retention:**
      - kept for 90 days after import;
      - kept for 30 days for a candidate that was never approved;
      - the hash, source mapping, decision, approver and write report are kept.
      - Deletion must not depend only on the server process running every day.
      - A candidate whose raw snapshot has expired can no longer be approved; it has to
        be checked again.
    - **The review shows participation and the GPS measurement separately.** A missing
      value is not a zero. "GPS was not worn" is shown only when the data confirms it or
      a coach enters it.
- **Tighten the v22 database check on `gpexe_athlete_links.gpexe_athlete_id`** to the
  canonical pattern (`^(0|[1-9][0-9]{0,11})$`) — a migration, separate decision; the
  application rule is enforced by the guard PR. Whether the deployed database holds any
  leading-zero id could not be checked from this workstation (the local OPTIMOVE database
  is at v21 and has no GPEXE tables); the ids the app stores come from GPEXE numbers and
  from preview entries, so none is expected.
- **Link athletes progress** (ux-design-reviewer on Phase 3b, 2026-09-24, optional, not a
  blocker): while a long batch is sent one pair at a time the button only says
  "Linking..."; a counter ("Linking 3 of 20...") would help on big teams.
- **Small Imports follow-ups** (found in PR #115, not scheduled): a hand-typed date in
  the source card's *Choose dates* is lost on a repaint (pre-existing); the review modal's
  badges still use the old vocabulary ("Waiting for approval"), to be aligned with the
  buckets; `errorInfo`/`fmtDateTime` are duplicated between the coach
  (`gpexe-import-*.js`) and admin (`data-sources-*.js`) screens.
- **Athletes who trained without a GPS record** — decided (owner, 2026-09-23 and
  2026-09-25) and planned as Phase 5: "Participated · no device data" (5a), manual values and
  estimates stored as estimates with mandatory provenance (5b). See
  `docs/ai/phase5a-discovery-and-contract.md`.
- **GPEXE session table readability** (owner, 2026-09-18, for later). The goal is that the
  Activities "Recorded metrics" table reads like GPEXE's own session table:
  - short column labels; `metric_definitions.short_label` and `icon_url` already exist
    (v10) but the table does not use them;
  - the unit shown once in the header, not in every cell;
  - duration as mm:ss;
  - no empty RPE columns;
  - a drill switch in the table.
  - Also: the "Choose metrics" picker is unusable at about 515 px width.
  - Importing GPEXE speed zones and max acceleration would change the import scope, so it
    needs its own decision.
- **Dashboards "Bucket" column shows raw ids** (found in PR #103). Fixing it needs readable
  labels from the backend and a security review.
- **Read the GPEXE import deletion log in the app.** Same shape as the dashboard deletion
  log task below: today `training_load.import_deletion_log` is readable only in the
  database.

- **Small Dashboards UX follow-up** (owner, 2026-09-17, found during H4): the guided
  "Add metric" panel (H1, `renderMetricPanelHtml`) closes without asking even when it
  holds staged changes, and its search field is 42px tall on phones (below the 44px
  touch-target rule).

- **Fix the known failing tests above** so a full suite run can be green again and a new
  regression can't hide among known failures: the backend worker timing test, a way to run
  or skip the edit-draft suite without `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL`, and the
  Tests-module drag-selection tests.
- **Re-home the manual RPE reminder for external ("OUTSIDE PLAN") sessions.** Its only
  entry point was the old Today tab's grouped OUTSIDE-PLAN row → per-athlete reminder
  panel, unreachable since Phase A and removed in Phase G (decision (a), 2026-09-16:
  `renderTrainingLoadTodayHtml`, the group/reminder actions and state,
  `sendExternalScheduleReminder`). The backend route
  `POST /api/training-load/external-schedules/:id/remind` and its tests are untouched.
  Proposal: per-athlete status + reminder UI in Schedule's external-schedule detail
  (`renderExternalScheduleDetailHtml`), reusing the Tests module's `reminderSelection`
  fingerprint pattern.
- **Read the dashboard deletion log in the app** (owner, 2026-09-17: kept out of PR #91 as
  a separate task; e.g. an admin-only view). Today
  `training_load.dashboard_deletion_log` is readable only in the database; no endpoint or
  UI reads it.
- **Dashboards and the shell Club/Team/Athletes filter** — see Open risks.

## Open risks

- **Dashboards ignores the shell Club/Team/Athletes filter** (Phase F, decision (b),
  2026-09-16). `POST /api/training-load/dashboards/:id/query` only receives the runtime
  activity/component filter (`analysisRuntimeFilterPayload`,
  `frontend/training-load-analysis-data.js`); `runtimeFilter.athleteIds` is never
  populated and the backend accepts `athleteIds` only, not club/team. The shell Filter is
  therefore rendered disabled on Dashboards with a visible note, while the coach's
  selection stays in `state.trainingLoad.filter` for Overview/Activities/Athletes.
  Proposed separate task: let `/query` accept `clubIds`/`teamIds` and expand them to
  member athletes server-side (same `athleteExtraFilterSql` union semantics `/weekly` and
  `/calendar` use), then feed `state.trainingLoad.filter` into
  `analysisRuntimeFilterPayload()` and `queryContextKey()` and re-enable the control.
- **Dashboard LIST visibility vs. `canViewDashboardRow` (residual drift, no leak today)**
  (PR #90, 2026-09-16). The list SQL's club owner clause admits ANY `req.authz.clubRoles`
  entry while `canManageClub` requires `role = 'club_admin'`; the team clause has the same
  shape (`teamRoles` ∪ `managedTeamIds`). Unreachable today — every current writer of
  `public.user_club_roles` inserts `club_admin` only and only club admins can activate a
  club workspace. security-reviewer (MEDIUM, out of scope): for such a non-admin member
  active in a DIFFERENT workspace the list would show the club/team-owned board while the
  single GET 404s — a list/GET split, not a private-data leak. If a non-admin club/team
  role is ever introduced, decide the contract first (list = only what GET allows is the
  ADR-006-consistent choice), filter those clauses with the shared role predicates in
  `backend/src/authz.js` (`holdsClubAdminRole`, `holdsTeamCoachRole`,
  `managesTeamThroughClub`, extracted in PR #91) and add a list+GET test for the new role.
- **Not exercised in a live browser yet** (unit-tested only): "Use template"/clone and
  the Calendar → Analysis "Choose activity" round trip. Dashboard create and the guided
  "Add metric" panel (`renderMetricPanelHtml`) were live-checked in PR #89's browser QA,
  the advanced editor with its series metric picker (`renderMetricPickerHtml`) in PR
  #95's, and the notification / workspace-switch leave guard in PR #97's.
- **Leaving the app with unsaved Dashboards changes** (found during H4, not scheduled):
  signing out, reloading the page or closing the tab still leaves without asking about an
  unsaved layout or Advanced settings change (no `beforeunload` guard).
- **A team move can wait without a limit on a stalled binding transaction** (F3c1 review, 2026-09-27,
  recorded, not fixed): moving a team to another club waits on the team row while a binding
  insert holds it `FOR SHARE`; the advisory try-lock cannot bound that tuple wait. No route moves a
  team today; the route that one day does must set `lock_timeout` (same class as the next entry).
- **An approval can wait without a limit before its COMMIT** (PR #107 reviews, not fixed).
  It waits on the role and grant rows, the candidate row, and the team import lock. It
  also waits when a transaction abandoned on a network stall keeps those locks until TCP
  keepalive notices. This is condition 2 in Separate tasks.
- **The GPEXE undo CLI cannot authenticate its operator** (PR #104). It is limited to
  disposable databases. The runbook lists what a persistent-database unlock would need
  first: a real authenticated identity, a narrow break-glass credential, and a second
  person's approval.
- **Rosters of sessions from before athletes were added in OptiMove** (Phase 5a1). A
  membership period starts at `starts_at`, the moment the athlete was added in OptiMove, not
  a sporting join date. A GPEXE session older than that lists its measured athletes under
  *Recorded, but not on this session's roster* and leaves the roster short. Importing older
  sessions therefore needs either correct membership start dates or a decision on how a
  roster before the first membership should read.
- **A membership archived and restored before v25 lost its gap** (Settings revives the same
  row); the athlete appears on rosters inside that gap. Over-inclusion only; the coach can
  answer *Did not participate* · Other.
- `migrations/` (legacy, no `_v2` suffix) still exists alongside `migrations_v2/` — treat
  it as historical/reference only; new migrations go in `migrations_v2/`.

## Most likely next step

The owner's external review of the drill-only probe mode on the F3c2b PR; then, on the owner's
order, the owner-run drill-only read (the last unproven importer read); then the merge
decision on the F3c2b PR; then the adapter implements the reads the probe proved
(`docs/ai/gpexe-rest-v1-compatibility.md` section 2, rows 1b–7 and 9, and row 8 if the drill-only
run proves it), and, on the owner's order, the F3c2
routes, built against the contract in `docs/ai/source-connections-f3c2-contract.md` section 2,
then F3c3–F3c4, then **Phase 5a3c** (Complete and Needs review).
Conditions 1–3 under Separate tasks still come before the first real local import, and
conditions 4–5 before regular production imports.

The other Separate tasks wait until the owner schedules them.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Separate tasks"/"Most likely next step" from the
actual current state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
