# Current state

Last reviewed: 2026-10-09. Last `origin/main` commit checked: `33d4f45` (merge of PR #148,
`fix/gpexe-rest-v1-local-window-filter` → `main`; PR #147 `39176b8` before it).

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
the probe rules the owner settled (2026-09-30 / 2026-10-01): the date window is proven only when
every row is of team 980 and inside the window and the filtered count is smaller than the
unfiltered count of the same run. (The drill rules settled then — the REST `details/` read by
position, then by the drill's own id, with a same / mapped matrix — were withdrawn on 2026-10-01;
see the F3c2b paragraphs below.)

**F3c2b — the owner-run read-only capability probe — is merged and deployed** (PR #132, merge
commit `e70fbd7` on 2026-10-02 22:16 UTC, pinned to head `f2b2e01`; `/api/health` served
`e70fbd7` with `ok: true` three times; docs and probe only, so no route changed and no
unauthenticated smoke was needed; no GPEXE exchange, search, link or import at the deploy, the
Render environment and `GPEXE_IMPORT_APPLY_ENABLED` untouched). As it was built (branch
`feature/gpexe-rest-v1-capability-probe-f3c2b`, owner order 2026-10-01; the full mode externally
reviewed at `6c51be3` and run once by the owner — see the next paragraph — and the drill-only mode
in several forms after it):
`backend/scripts/gpexe-rest-v1-capability-probe.mjs` runs one exchange in the host's confirmed
form and then GET requests only for Team ID 980 (at most 14 requests, a timeout per request,
answers bounded at 5 MiB, redirects never followed, no retry, no database), derives every id —
session, athlete row, track; in the drill-only run the parent — from an answer it has already
received and checked, stops a
chain as soon as no safe next id exists, stops the whole run on a row of another team or of a
team in an unreadable shape, reads nothing of a session whose own read did not confirm team 980,
asks for the tag list for team 980 as well, applies
the date-window rule of the compatibility document (the full run reads no drill any more), and
prints statuses,
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
order.** For the drill, the probe gained a narrow **drill-only mode** (`--mode drill`). **Its first
form was run once by the owner (2026-10-01, after the external review of head `1bcb969`) and
stopped as built:** `stoppedBy: drill_id_mismatch`, 4 requests — the parent confirmed (own read
200, same id, team 980, `drills_count > 0`, no `drills` list), but `team_session/<first drills entry>/`
answered 200 with **an id other than the entry** (the report could not tell whether it was the
parent's own id or a third session's) and no `teamsession` field; nothing further was read. **So
an entry of a session's `drills` list is not a `team_session` id on `rest_v1`, or at least that
path answers a different session; the `e03` drill model is not confirmed there; owner decision: a
`drills` entry is never read as a `team_session` id again without new evidence.** The mode was corrected on the same PR twice (owner orders
2026-10-01). **The REST `?drill=` plan is withdrawn:** the owner's review of the legacy
integration's code (structural evidence, not an API answer; the file holds credentials and was
not opened by the main session) shows that on `server3` it reads a drill's results as
`api/team_session/<parent id>/details/?drill=<zero-based index>`, the whole session and
`drills_count` as `rest/v1/team_session/<parent id>/details/`, and never uses `drills` as
`team_session` ids. **The second form was run once by the owner (2026-10-01, after the external
review of head `9c702ff`):** `stoppedBy: null`, 5 requests; the parent confirmed by its REST read
and again by `api/team_session/<parent id>/` (same id, team 980); the legacy drill read at the
first position answered 200 with an object carrying `drills_count`, `players`, `team` and
`teamsession` at the top level, `players` a map of objects with numbers. **Row 8 is now observed
in the `api` family, never yet same**: one read confirms the endpoint and its shape only. The run
also reported `listRowMatchesFirstDrill: true` (another row of the real list page has the id the
parent's first `drills` entry names) — an observation that does not settle the `rest_v1` drill
model. **The drill-only run, third form** (owner order 2026-10-01, built, **not run**): one
exchange and at most six reads (cap 7) — the REST list gives a parent (team 980, a readable id and an
explicit `drills` list of at least two entries; `drills_count` alone never chooses one), its own
REST read confirms the same id, team 980 and `drills_count >= 2`, the same parent through
`api/team_session/<parent id>/` confirms the same id and team 980 again, then the legacy
drill reads the legacy integration sends in the control sequence `?drill=0` → `?drill=1` →
`?drill=0` (owner, 2026-10-01), each of which, the repeat included, must name team 980 and the
parent at its top level (`team`, `teamsession`) and carry a non-empty `players` before anything
else is read; only the three `players` contents are compared, in memory, never printed: the two
position-0 answers differ → `not_observed` with `source_changed_during_probe`; they are identical
and position 1 differs → `parameterApplied: true` and the capability may be same (only for the
`api` family: positions 0 and 1 produce different results for a stable, confirmed parent; no drill
name, and position 0 is not thereby proven to be the first drill); all three identical →
`not_observed` with `parameter_effect_not_distinguishable`. The whole-session `api/…/details/` without a parameter is
not used as a reference (not confirmed in the legacy integration). Any identity or team not
confirmed stops the chain without the next request (`parent_id_mismatch`, `parent_not_confirmed`,
`legacy_parent_id_mismatch`, `legacy_parent_not_confirmed`, `drill_parent_mismatch`,
`drill_answer_identity_unconfirmed`, `team_isolation_failed`, `team_unknown_shape`), and every exit
names the drill verdict; no `drills` entry is ever used as an id; the legacy family is used by the
probe only, for those read shapes on the same host, and is not added to the `server3` host profile
or the adapter; the full run no longer reads any drill. **Owner product decision (2026-10-01):**
the legacy way of reading drill results by parent id and `?drill=<index>` is the candidate to
confirm; its way of naming drills — linking tags through all tagged sessions of that day sorted by
time — is not reliable enough for OptiMove and is not copied; OptiMove keeps a drill as parent
session + zero-based drill index, links a name or tag only when the API gives an explicit, tested
link, uses the neutral name *Drill N* until then, and never guesses a tag
(`docs/ai/gpexe-rest-v1-compatibility.md` section 3). **The third form was run once by the owner
(2026-10-02, after the external review of head `3f466ed`):** `stoppedBy: team_unknown_shape`, 5
requests — the REST list, the REST parent and the legacy parent confirmed as before; the first
`?drill=0` answered 200 with the expected top-level fields, but its `team` was not a canonical id
as a number or a string, so the run stopped before `?drill=1` and the repeated `?drill=0`; nothing
was compared and there is no conclusion about the parameter; **row 8 stays observed, never yet
same.** On the same PR the probe gained **diagnostics of the `team` shape** in every drill
answer's report entry (owner order 2026-10-02): `teamValueKind` (`absent` / `null` / `number` /
`string` / `object` / `array` / `other`) and, for an object only, `teamObjectHasId`,
`teamObjectIdCanonical` and `teamObjectIdMatchesBoundTeam` — no value, key list, URL, name or id.
**The acceptance rule is unchanged:** any non-canonical shape still stops the run as
`team_unknown_shape`, even when the object's `id` matches the bound team, and nothing further is
read; accepting `team.id` is a separate owner decision after the next result. **The diagnostic run
(2026-10-02, head `1166cfa`) stopped the same way** (`team_unknown_shape`, 5 requests) and showed
that the drill answer's `team` is an object without an `id` (kept opaque: no key printed, no other
field looked for, never evidence of the team), and that the answer's `teamsession` is a canonical
id that is not the parent's (`namesParent: false`) — under the current rule a readable team would
still have stopped as `drill_parent_mismatch`. On the same PR the probe gained, as diagnostics
only (owner order 2026-10-02), four booleans per drill answer about its link to the list already
received: whether `teamsession` is canonical, whether it equals the parent's `drills[position]`
exactly, whether that entry is exactly one row of the list page, and whether that row names team
980 — no id, value, name, URL or key. **The rule is unchanged:** an answer naming anything but the
parent still stops as `drill_parent_mismatch` and nothing further is read. Only if the next result
confirms the chain parent `drills[position]` → one list row of team 980 → the answer's
`teamsession` equal to that entry will the owner decide, separately, whether that chain becomes
the identity rule of a drill answer. **The second diagnostic run (2026-10-02, head `79b2381`)
stopped the same way** (`team_unknown_shape`, 5 requests): `teamsessionCanonical: true`,
`teamsessionMatchesExpectedDrill: false`, `expectedDrillHasUniqueListRow: true`,
`expectedDrillListRowTeamIs980: true` — the list side holds (the parent's first `drills` entry is
exactly one row of the list page, uniqueness on that one page of 100 rows only, and that row names
team 980), but the answer's `teamsession` is neither the parent nor that entry: a third session.
**The fourth form, the final structural diagnostics (owner order 2026-10-02, built, not run):** for
every drill answer, the repeat included, the probe computes in memory whether its `teamsession` is
canonical, how many entries of the parent's `drills` it matches and at which index when exactly
one (`teamsessionMatchedDrillIndex`), whether it is exactly one row of the list page and whether
that row names team 980; all of that plus a non-empty `players` is the **probe-only diagnostic
link** (`diagnosticLinkConfirmed`) that alone lets the probe send the next read — otherwise
`drill_link_not_confirmed` and no further request. The answer's `team` is opaque and never
evidence of the team (a canonical id naming another team still stops the run); the repeated
position 0 must map to the same index as the first (`drill_repeat_index_changed`) and carry the
same canonical `players` (`source_changed_during_probe`); a completed sequence is reported as
**observed, not same**, with `repeatStable`, `parameterApplied` and the indexes for 0, 1 and the
repeated 0. **The diagnostic link is not an identity rule and no permission for the adapter; the
identity contract of a drill answer is decided by the owner after the result.** **The fourth form
was attempted twice by the owner (2026-10-02, after the external review of head `7c54a7d`) and
neither attempt reached a drill read:** the first — exchange 200, then the REST session list timed
out after 30 s, 2 requests, `session_list_unavailable`; the second — the exchange itself answered
400 with the single field `non_field_errors`, 1 request, `exchange_failed`. Both are operational
events without any conclusion about the drill model, the token or the account; by the owner's
decision there is no third attempt and no new diagnostic. **F3c2b is closed (owner, 2026-10-02,
aligned on 2026-10-03 on the official GPEXE REST handbook `gpexe-v.6-api-rest-handbook.pdf`,
pages 31–33 and the Team Session Brief page; written for GPEXE 6, the server reports 9.11.8; a
confirmation by GPEXE support is welcome, not a blocker):** the eight confirmed `rest_v1` reads
(date window, session read, whole-session details, athlete list, athlete row, `/more/`, track,
thresholds) stay confirmed; the drill endpoint is in practice **observed**, and its use is
settled by the handbook — `api/team_session/<confirmed parent id>/details/?drill=<index>` with a
zero-based index from `0` to `drills_count - 1`, no parameter meaning the whole session;
**drills stay in the future adapter and in the first planned production import**; the top-level
`team` of a details answer is the team's aggregated parameters, not a team id; `drills` entries
and the answer's `teamsession` are used neither to build a URL nor as an identity guard (safety
rests on the confirmed parent, a fixed URL builder and the bounded index); a drill's name comes
from an unambiguous `drillTags` mapping of the parent (`api/team_session/<confirmed parent
id>/brief/`, translated through the team's tag catalogue, only a tag confirmed for the bound
team), fallback `Drill N`, and never from all tagged sessions of a day; no more owner-run
diagnostic probes before that implementation, no further sign-in attempts, no probe rule change;
the owner's Google Sheet is neither checked nor changed. The two last operational events stay
recorded without any conclusion about drills, the token or the account. **The implementation is a
separate small adapter PR after PR #132 is merged, on the owner's explicit order:** B1 the
mandatory `listSessions()` drills-filter fix (characterisation tests first, both directions, an
ambiguous set refused with a stable code), B2 the eight confirmed reads through the `server3` /
`rest_v1` profile with the existing boundaries, B3 one narrow builder for exactly the drill path
on the approved `server3` host (no generic `api/` family, no fallback, GET only, index bounded by
`drills_count`, a drill answer accepted only as a 200 JSON object whose `players` is a non-empty
map keyed by canonical athlete ids — the "non-empty" condition was relaxed by the owner on
2026-10-03, see the as-built paragraph below —, one failed drill never a silently complete set), B4 names
through `drillTags` with provenance `drill_tags` or `index_fallback`, no new table or migration,
B5 the listed tests, B6 `code-reviewer` + `security-reviewer`. The PR #132 merge decision is the
owner's. No GPEXE request by the main session, no route, no database write, no credential
storage, no binding, no import.

**F3c2c — the `server3` read adapter: the `listSessions()` fix, the eight proven reads, the
narrow drill read and the drill names — is merged and deployed** (PR #133, merge commit
`379d2fa` on 2026-10-03 10:37 UTC, pinned to head `10a71af` after the owner's external review in
three rounds; `/api/health` served `379d2fa` with `ok: true` three times; no route uses the
adapter, so no unauthenticated smoke of a new route; no GPEXE exchange, search, link or import,
no migration, the Render environment and `GPEXE_IMPORT_APPLY_ENABLED` untouched; **not run against
the real server** — fake fetch only). As built (branch `feature/gpexe-server3-adapter-f3c2c` from
`e70fbd7`, owner order 2026-10-03; backend adapter, tests and documentation only):
`backend/src/gpexeRestV1Adapter.js` tells the session list apart into parents and drills by the
confirmed list structure only and refuses an ambiguous page with `source_list_ambiguous` instead
of thinning it (a real parent named in another row's `drills` is no longer dropped; a named row
with drills of its own, an entry named twice, a self-reference or a `drills` / `drills_count`
disagreement is refused; an entry naming no listed row is only counted); implements the eight
proven `rest_v1` reads through the existing profile — the date window (`listSessionsByDay`, at
most 31 days, read from exactly one day earlier so a drill's parent of the evening before is seen
and a drill row is never listed as a session, the proved `%20` / `%3A` encoding, which is the one widening of the host path rule
in `sourceHosts.js`: exactly those two percent sequences in a query value), the session read
that confirms a parent, the whole-session details, the athlete rows, one row, its `/more/`, its
track and the thresholds, each dependent read only under a session this adapter instance
confirmed; adds one narrow builder, `legacyDrillDetailsUrl()`, for exactly
`https://server3.gpexe.com/api/team_session/<confirmed parent id>/details/?drill=<index>` with an
integer index from 0 to `drills_count - 1` (and `legacyBriefUrl()` for `…/brief/`) on the approved
`server3` row only — no generic `api/` family, no fallback, GET only; accepts a drill answer only
as a 200 JSON object whose `players` is a map of canonical athlete ids to metric values (an empty
map is valid — a drill not yet computed, owner decision 2026-10-03 — while a missing, null, array
or other shape fails; the top-level `team`, an aggregate, and `teamsession` are neither identity
nor returned); sends no retry by default (one attempt per read, at most three on request); reads a
session only when a session list of this instance classified it as a parent (so a drill row is
never read, confirmed or bundled as a session) and an athlete row only when the confirmed session's
own list named it; returns from every read only the fields the mapper and the candidate service read
(explicit projections, `BUNDLE_FIELDS`); withdraws, on a refresh of a session or of its athlete list,
every row and track confirmed under it and discards a concurrent stale answer (`session_refreshed`);
treats a brief of another session, an unknown brief shape or a non-canonical tag id as an error
and falls back to `Drill N` only for a missing or unreachable brief (owner's external review of
PR #133, 2026-10-03; after its narrow re-reviews also: a projected value must be a scalar or a
number list — `field_shape_unknown` otherwise —, an older list answer never overrides a newer
classification, a dependent read that lands after a refresh is discarded, and a row once seen as a
drill cannot return as a parent through a later list); ends
a drill set at the first drill that cannot be read (`complete: false`, the failed index and code,
never another index, host or form; a refused credential or a foreign team ends the operation);
names drills from an unambiguous `drillTags` mapping of the parent's brief translated through the
bound team's tag catalogue, otherwise `Drill N`, with `labelEvidence` `drill_tags` or
`index_fallback`, never from the day's other sessions; and composes `fetchSessionBundle` in the
e03 bundle shape plus `drillsStatus` and `drillLabels`. The `e03` importer, the host allowlist,
the routes, the database, migrations and the frontend are untouched; no credential, binding,
Connect / Test route, UI or import. Contract tests with a fake fetch only
(`backend/tests/gpexe-rest-v1-adapter-reads.test.mjs`, `…-adapter.test.mjs`,
`source-hosts-server3.test.mjs`), with mutation evidence for the key guards. Open compatibility
note: the handbook is GPEXE 6, the server reports 9.11.8 (a GPEXE support confirmation is welcome,
not a blocker). The import policy for an incomplete drill set and the storage of drill labels are
decided in the later integration PR.

**F3c2d — the GPEXE Connect / Reconnect / Test backend routes and migration v29 — is merged and
deployed** (PR #134, merge commit `cb54b85` on 2026-10-03, after the owner's external review in
three rounds — round 3 at head `eb1076c`: a stable `attempt_id` per logical attempt with the
throttle counting distinct ids, "reached the source" set by the fetch invocation itself, a spent
network budget or any read failure with zero requests a local uncounted refusal
(`network_budget_exhausted` / `attempt_not_sent`), the compensating audit of a failed
source-reaching attempt written in the attempt's own transaction through a savepoint, and the
username / password removed from the request body object right after validation; `/api/health`
served `cb54b85` with `ok: true` (owner); **v29 on the deployed database is inferred** from the
server starting after the migration step (`npm start` runs `node src/migrate.js &&` the server),
the deployed database was not queried; **not run against the real server, no credential used, no
connection row, no binding, no GPEXE request; `GPEXE_IMPORT_APPLY_ENABLED` and the Render
environment untouched; the local OPTIMOVE database stays v21**). As built (branch
`feature/gpexe-connect-routes-f3c2d` from `379d2fa`, owner order 2026-10-03) — `backend/src/routes/sourceConnections.js` at
`/api/training-load/sources` and `backend/src/sourceConnectionService.js`, contract section 2.5
of `docs/ai/source-connections-f3c2-contract.md`, runbook
`docs/runbooks/source-connections-f3c2d.md`: a platform admin only (platform workspace or the
owning club's workspace), everyone and everything else the same 404; a connection is club-owned
and teams are bound separately (no binding route in this step, no binding derived from the
account's visible teams); the first real profile is `server3` / `rest_v1` — the host must be
approved in the catalog and resolvable in code and have a confirmed exchange and a read adapter,
no typed URL, no fallback to `e03`, no generic proxy, GET only plus the one exchange POST,
redirects refused; Connect / Reconnect take a username and password for that one HTTPS request,
exchange them once on the confirmed endpoint (form-encoded, token field `token`), keep only the
AES-256-GCM parts of the token (F3c1 crypto) and drop the pair; the pair and the token are never
returned, logged, audited as values or named in an error; the UI JWT / cookie is never a
credential; Test uses the stored token for every active bound team's own read (one adapter
instance per bound source team) or, while nothing is bound, the team list count only; the
concurrency and security conditions of the contract: per-user advisory lock (bounded at 20 s, then
`try_again`; a 10 s statement timeout and a 90 s network budget per attempt), the connection row
`FOR NO KEY UPDATE` under a 2 s `lock_timeout` (`try_again`), bound teams locked ascending
try-lock style, the throttle of 5 attempts that reached the source in 15 minutes per connection
and per user counted from the append-only audit (refusals audited with `counted: false` and never
counted, so a retry after 429 never extends the lockout), secret-free audit with a fixed metadata
allowlist, Reconnect only with a confirmation naming the source, the owning club and the number
of bound teams, the F2 COMMIT-outcome discipline (`verified_after_commit_error` /
`outcome_unknown` with a second `unknown` audit row by the same admin; an attempt that reached
the source and then could not be stored is audited and counted as `attempt_not_recorded` /
`rights_changed`; a read after a confirmed COMMIT never turns the answer into a failure), the
global error handler no longer logs or echoes a request body the JSON parser refused, Disconnect
not implemented. **Migration v29**
(`migrations_v2/202610031000_training_load_v29_source_connection_state_facts.sql`) closes the
v27 fact gap the contract named — `linked_untested` carries both facts, every state but
`not_connected` holds a credential — and adds the partial index of the per-user throttle window;
rollback `docs/runbooks/source-connections-v29-rollback.sql`, rehearsed on a disposable
database; **v29 is not applied to any persistent database** (the local OPTIMOVE stays v21; the
deployed database gets it only through a merge and deploy the owner decides). Tests
(`backend/tests/source-connections-f3c2d.test.mjs`, disposable database and fake fetch): the
migration and its rollback, route contract and info hiding, create, connect with and without
bound teams (the eight-team account reads only the bound team 980 and the other binding, never
the list), every exchange answer class, test states, reconnect, the retired host, the throttle in
both orders and across two connections concurrently, overlapping attempts and a held team lock,
a missing key and an unreadable credential, the COMMIT outcome, and the secret scan of every
response, audit row, database column and console line of the suite. Recorded for the integration
PR, not built: an incomplete drill set is never shown as complete; an empty, successfully read
`players` drill answer is a valid empty drill distinct from a failed read; tag names are
HTML-escaped in the future UI; the raw-snapshot decision stays open; the importer is not wired to
a connection and `GPEXE_IMPORT_APPLY_ENABLED` stays off.

**F3c2e — the verified team binding, the club-admin path and the approved-pair allowlist — is
merged and deployed** (PR #135, merge commit `440ad83` on 2026-10-04, merged exactly from head `3352ad1` (the full 40-character
SHAs are in PR #135's merge record; this file keeps the short forms) after the owner's
external review in three rounds; Render showed the deploy Live for `440ad83` and `/api/health`
returned `ok: true` with commit `440ad83` three times; without a login every new and existing
source route — the list, the single GET, create, connect, reconnect, test and the new bindings
route — and `PUT …/gpexe/teams/:teamId/settings` answered 401 (zero UUIDs, no data). **v30 on the
deployed database is an indirect conclusion only**, from the server starting after the migration
step (`npm start` runs `node src/migrate.js &&` the server); the deployed database was not queried
with SQL. No Connect, no binding, no credential and no GPEXE request were made at the merge or
the deploy; the local OPTIMOVE database stays v21. **The first real production binding stays
forbidden until F3c2f (Unbind) is merged, deployed and smoke-checked.** As built (branch
`feature/gpexe-team-binding-f3c2e` from `cb54b85`, owner order 2026-10-03, its amendment of the
same day and the allowlist decision of 2026-10-04; backend service, router, adapter, migration
v30, tests and docs; not run against the real server, no credential used, no binding of the real
team 980).

Discovery result: `docs/ai/source-connections-f3c2e-discovery.md` (the v27
binding table's columns, the guards the database already has, the derived lock order, and why the
first "no v30" conclusion was superseded). As built:
- **The allowlist (owner decision 2026-10-04, after the security review's HIGH F-1 — a club admin
  could bind any team the shared account sees; option (a)):** the existing `gpexe_team_settings`
  row of an OptiMove team is the platform-admin-approved pair `OptiMove team ↔ GPEXE Team ID`,
  still set and changed only through the F3b Settings route (reason, history). A binding may only
  bind that exact pair, whoever calls (`409 team_setting_missing` / `team_setting_mismatch`,
  locally, zero requests); a club admin sees and may choose only the GPEXE teams matching an
  approved pair of an active team of their club (server-side intersection; no name, id, count or
  other fact of the rest leaves the server), a platform admin the bounded, annotated list;
  `sourceTeamsTruncated` is reported to both. **Migration v30**
  (`migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql`) keeps the
  approved Team ID (and the team) of a bound team's settings row final while its gpexe binding is
  active (trigger `gpexe_team_settings_bound_team_final`, `23514`; the same canonical value
  passes; DELETE / TRUNCATE / repoint already refused by v24; no data change) and, after the
  owner's external review of PR #135, guarantees the pair on INSERT as well (trigger
  `source_team_bindings_check_pair`: pointer to the own setting, setting present, canonical ids
  equal — `source_team_bindings_approved_pair`) plus one OptiMove team per canonical GPEXE team
  (unique index `gpexe_team_settings_canonical_team_id_key`; the migration refuses existing
  duplicates without changing them; Connect / Test withhold the list fail-closed should they
  exist anyway); the F3b
  `setTeamSettings()` answers `409 gpexe_team_bound` for the same case (pre-check under the team
  lock; the trigger mapped to the same code, never SQL text), the same value stays idempotent,
  and without an active binding the change works as before. Rollback
  `docs/runbooks/source-connections-v30-rollback.sql` (refuses under a later migration and while
  an active binding relies on it), rehearsed on a disposable database with the apply → invariants
  → rollback → identical catalog → reapply → failed-last-statement atomicity sequence.
- **Owner product decision (2026-10-03, replacing "platform admin only" and the typed Team ID):**
  the GPEXE connection and its team bindings are managed by the **owning club's admin** in that
  club's workspace, and by a platform admin (platform workspace or the club's workspace) for
  support; one authorization path with two bases (`resolveConnectionAdmin()`: `platform_admin` or
  `club_admin`), everyone and everything else the same 404 (another club's admin, an admin of two
  clubs in the other club's workspace, a coach, an athlete, a revoked role, an archived club or
  team, a foreign team); the right and the club are re-checked `FOR SHARE` after every source call
  by basis (`rightsStillHold()`), and the audit basis is the context's basis. Coaches get nothing
  here (their connection state stays the Imports status route; the sentence to contact an
  administrator is F3c3 UI).
- **The team list after a successful Connect / Test:** both now read the first page of `team/`
  through the adapter's new `listVisibleTeams()` — each row reduced to its canonical id and a
  sanitized display name (control and format characters removed; nothing else leaves the adapter;
  a row without a canonical id, a duplicate or more rows than a page refuse the list) — and then
  verify every active bound team's own read as before; every visible team is matched against the
  owning club's approved pairs and the result carries `sourceTeams` (`sourceTeamId`, `name`,
  `approvedTeamId`, `approvedTeamName`; a club admin: the intersection only), `sourceTeamCount`
  and `sourceTeamsTruncated`. Nothing is preselected, stored or bound from it; the chosen team is
  verified again, alone, by the bind.
- **`POST /api/training-load/sources/:source/connections/:id/bindings` `{ teamId, sourceTeamId }`**
  (a branch of the same `attempt()` as Connect / Reconnect / Test, so one lock, audit, COMMIT and
  compensation path): body checked before any lock (`400`); the connection and the team read
  unlocked (`404` unless the team exists, is active and is in the owning club); the per-user lock;
  the connection row `FOR NO KEY UPDATE` (state must be `verified` → `409 connection_not_verified`);
  the same binding again is the same final answer (`200`, `idempotent: true`, no row, no request,
  no audit) — answered BEFORE the `verified` gate, so a retry after an unknown outcome gets its
  binding even when a Test moved the state meanwhile; the caller's own team already bound for
  the source is a `409 team_already_bound` before any request; the catalog row `FOR SHARE` and
  the host gate; every active bound team's and the target team's try-lock, ascending, once each
  (`try_again` while a check, import, settings change, team move or binding runs for any of them
  — the credential-attempt rule, because a refused credential during the bind changes the
  connection's state); the team's approved pair in `gpexe_team_settings` `FOR SHARE` — missing
  → `409 team_setting_missing`, another canonical GPEXE Team ID → `409 team_setting_mismatch`,
  the same → the binding carries the provenance pointer; the settings row and its history are
  never written (D12, digest-tested); the 5 / 15 min window
  (a bind that reached the source without succeeding counts like a credential attempt, a
  successful one does not; `429` when full); key ring and decrypt; the one `GET
  team/<sourceTeamId>/` through the adapter bound to exactly that id; rights and club re-checked;
  the team row `FOR SHARE` only now and re-qualified (archived or moved meanwhile → the same 404,
  nothing bound, but audited and counted because the source was reached; a rename or an archive
  never waits behind a slow source); only after the chosen
  team's read succeeded a source team bound to another team is `409 source_team_already_bound`
  (an id the credential cannot see is `source_team_not_visible` either way — no other club's
  binding is confirmed to exist; the v27 partial unique indexes are the backstop, mapped by their
  exact names, tested through an insert-fault seam; `55P03` and `40P01` are both `try_again`); the binding
  row and its audit (`bind`, `team_id`, `source_team_id` as a metadata fact — a non-secret key by
  the v27 predicate) in the same transaction; the F2
  bounded COMMIT (`verified_after_commit_error` / `503 outcome_unknown` naming the team, the second
  `unknown` row with the team, the retry idempotent). Answer classes of the chosen team's read:
  `401` → `409 source_auth_rejected` and the connection becomes `needs_reconnect`; `403` / `404` →
  `409 source_team_not_visible`; `429` / 5xx / network / timeout → `502 source_unavailable`;
  redirect / oversized / non-JSON / another team's id / non-object → `502 source_answer_unexpected`
  — each audited with the team, nothing bound, the credential kept. Out-of-transaction audit rows (a refusal, the
  second row of an unknown outcome) are written under the row `lock_timeout` so a team row held by
  a running move or archive never holds the request. **No Unbind, Disconnect, Delete or automatic
  replacement; no automatic binding of any of the eight visible teams; no assumption that a Team
  ID is valid on another host.**
- **GET** `…/connections/:id` and the list show per binding `bindingId`, `teamId`, `teamName`
  (from OptiMove), `sourceTeamId`, `state`, `teamActive`, `boundAt`; never the source's own team
  name, a credential part, a username or an account fact. No new read route.
- Tests: `backend/tests/source-connections-f3c2e.test.mjs` (disposable database through v29,
  fake source; the 24 ordered cases, the club-admin cross-club / wrong-workspace / revoked-role /
  archived-club-mid-call cases, concurrency against Test / Reconnect, a team move, a team or club
  archive and a held team lock, both COMMIT outcomes, the field allowlists, the secret scan);
  `gpexe-rest-v1-adapter.test.mjs` gained the `listVisibleTeams()` contract; the F3c2d suite was
  adapted (club admin sees the connection; the list is read before the bound teams).

**F3c2f — a safe Unbind — is merged and deployed** (PR #136, merge commit `d285296` on 2026-10-04
15:17 UTC, merged exactly from head `ea1674d` after the owner's external review in two rounds —
round 2 closed the refusal-audit dedupe (its own bounded transaction under a transaction-scoped
advisory lock) and the `requestKey` semantics; `/api/health` served `d285296` with `ok: true` three
times in a row and once more at the smoke; without a login `POST …/connections/<zero
uuid>/bindings/<zero uuid>/unbind` answered 401 with and without a body and the connection GET
401; **no migration** in it, so v30 stays the last migration inferred on the deployed database; no
Connect, binding, Unbind, credential or GPEXE request at the merge or the deploy; the Render
environment and `GPEXE_IMPORT_APPLY_ENABLED` untouched). **After this deploy the first production
binding is no longer blocked by a missing Unbind path, but it is not made without a separate,
explicit owner order.** As built (branch `feature/gpexe-unbind-f3c2f` from `440ad83`, owner order
2026-10-04; backend route, service, tests and docs). Discovery: `docs/ai/source-connections-f3c2e-discovery.md` section 7 (v27
already holds the end state with its facts and the immutability rule, the audit action `unbind`
with a mandatory `team_id` and the `reason` column; no request table fits, so the audit row of the
successful Unbind is the request record; no v31). As built — contract section 2.7, runbook
"Ending a binding (Unbind)": `POST …/connections/:id/bindings/:bindingId/unbind` `{ requestKey,
reason, expected: { teamId, sourceTeamId } }`, the same two authorization bases as F3c2e and the
same 404 for everyone else; a local operation only (no source request, no exchange, no credential
change, nothing deleted; the connection need not be `verified`); lock order: per-user lock →
connection row → the request record (a replay answered before any team lock) → the target team's
try-lock only (an Unbind changes neither credential nor state, so the credential-attempt rule
"every bound team" does not apply; a sibling team's import never blocks the remedy) → the binding
row → checks → rights → UPDATE `active → ended` with when / who / why (`clock_timestamp()`) →
audit `unbind` → bounded COMMIT; `55P03` / `40P01` → `try_again`; idempotent by
`requestKey` (the same key replays the saved answer without a second UPDATE or audit row, the same
key with another body is `request_key_reused`, a new key on an ended binding is
`binding_already_ended` with the current state, a stale `expected` pair is `binding_mismatch`; the
key binds to its body only once an Unbind was saved — a refusal is not a request record, the same
key may repeat a transient or correctable refusal, a fresh key is a new attempt); the
F2 COMMIT discipline; audit `unbind` with the team, the reason, `counted: false`,
`source_contacted: false`, `request_id` / `request_hash` (never in the authentication window); a
refusal is audited once per user / key / refusal, serialized in its own bounded transaction by a
transaction-scoped advisory lock (owner's external review of PR #136).
After an Unbind the approved Team ID can change again, the team and the freed source team can be
bound again under every v30 rule, the ended row stays as history, and the v30 rollback is no longer
refused by it. Tests: `backend/tests/source-connections-f3c2f.test.mjs` (disposable database, fake
source that is never called).

**The active step is the combined F3c3 / F3c4 completion package** (owner order 2026-10-05; no new
F3c2 letter, F3c2h does not exist): **PR A — F3c3**, the administrator's Source connections screen in
Settings (Connect account → Test connection → Approve and bind → Reconnect → Unbind; platform admin
and the owning club's admin; a coach gets only the stable sentence to contact an administrator;
another club, the wrong workspace, an archived club or a revoked role never learn that a connection
exists), on branch `feature/gpexe-source-connections-ui-f3c3` from `6382d25`, frontend and docs on
the merged F3c2d–F3c2g routes, no backend contract change planned; then **the owner-run read-only
pilot** through the deployed UI (Connect with the club's account, Test, choose the approved pair
OptiMove team ↔ GPEXE Team ID 980, Review and Bind, one read-only Check for a small date window,
read the source path / check result / sessions / athletes / drills; `GPEXE_IMPORT_APPLY_ENABLED`
unchanged, no candidate approved; the credential never through chat, terminal, screenshot or log —
the main session only prepares the procedure, never runs it); then **PR B — F3c4**, the final
cut-over (a migration drops the `legacy_env` DEFAULT and forbids new legacy check rows in the
database, historical legacy rows untouched; the importer no longer reads `GPEXE_API_TOKEN`; the
legacy factory removed only once tests prove no production entry point depends on it; the Render
variable removal reported, never done automatically; durable proof that every new check reads
through `source_connection`; the `pool.connect()` timeout resolved or explicitly split out before
F3c is declared complete; a full end-to-end test with the fake source on disposable databases),
followed by a second owner-run procedure for one controlled real import (the apply switch and any
approval only on a separate owner order). F3c counts as complete when the UI Connect / Test / Bind /
Reconnect / Unbind works, one owner read-only pilot passes, the importer uses only the stored
connection, the legacy path is retired and a controlled first import is ready.

**PR A (F3c3) as built** (branch `feature/gpexe-source-connections-ui-f3c3`, first commit the
record above; frontend and docs only, no backend change; merged and deployed as PR #138, see
below): a new Settings sub-tab
**Source connections** (`frontend/source-connections-{view,data,actions}.js`, state slice
`state.sourceConnections`; contract section 2.9, runbook section "Source connections (F3c3)") for
a platform admin (platform workspace with a club picker, or a club workspace) and for the owning
club's admin in that club's workspace — the tab is offered from the `/me` and `/api/organization`
facts, the server decides again on every request, and a 404 reads as "No source connections are
available in this workspace"; a coach never sees it. Create (the one approved profile `server3`,
an account label) → Connect account (username and password typed once, sent once, not retained
by OptiMove; the form says that the browser or a password manager may handle them according to
its own settings, `autocomplete="current-password"` on the password field as a hint, never a
guarantee; a double click sends one request; **a lost Connect / Reconnect / Test / create is never
confirmed by a read** — *Read current state* refreshes the display and keeps the marker, every
other write stays locked until the explicit *Acknowledge uncertainty and continue*, a local step
that sends nothing; the pair is never resent) → Test connection (the
five states as badges, the last verified time and problem, the server's `sourceTeams` exactly as
presented — the club admin's approved intersection or the platform admin's annotated list, the
truncated / unavailable notes) → Approve and bind (Bind only where a pair is approved; a platform
admin is sent to Data sources to set one; the review names source, host, club, OptiMove team and
GPEXE team; one confirmation, one binding; the idempotent answer named) → Reconnect (a
confirmation naming the source, the owning club and the bound-team count travels with the new
pair; the old credential never shown) → Unbind (a mandatory reason, both teams named, the "no
fallback to the environment token" warning, a fresh `requestKey` per attempt reused by Check
result after a lost answer, the ended binding as history). Every stable code of the routes reads
as a sentence; a write in flight or an unconfirmed outcome disables the other controls and asks
before a section switch or a reload. The coach's Imports screen now tells the coach to contact an
administrator for `source_connection_unavailable` instead of "try again"; an administrator with a
precise connection code on a failed check is pointed to Settings > Source connections. Every
answer is classified honestly: no answer, an abort of the 150 s client bound, `503 outcome_unknown`
and any 5xx the service did not write itself are *Result not confirmed* (never "nothing was
changed"); a write that settled but whose post-write read failed is shown as settled with an
out-of-date note; a lost outcome of a previous club stays marked until that club's workspace is
opened again. Internal review rounds before the PR: `code-reviewer` (NOT READY → fixes → READY WITH
NON-BLOCKING NOTES twice, all notes applied), `security-reviewer` (READY WITH NON-BLOCKING NOTES,
two MEDIUM applied — the lost-answer classification and `method="post"` on the credential form —,
re-check READY), `ux-design-reviewer` (NOT READY → all sentences and primaries corrected → READY),
`mobile-qa` (READY WITH NON-BLOCKING NOTES, the long-unbroken-word clipping fixed; the iOS
strong-password offer recorded as a physical check in the pilot procedure). Tests:
`frontend/tests/source-connections.actions.test.mjs` (through the real handlers with a
fake fetch: tab visibility per basis and workspace type, the neutral 404, create and its lost
answer, the one-request credential submit with the password in no state / HTML / URL — also while
in flight —, the team list bounded to the server's rows, Test outcomes and the state-dependent
sentences, bind review and body, a bind refused by the source, reconnect confirmation body, unbind
body and history, lost answers with the same key / pair / a read only, uncoded 5xx and aborts as
lost answers, the settled-but-stale note, the workspace switch, re-entry, the leave guards, every
code's sentence, the coach and administrator sentences; mutations of the key guards
killed). **The owner's external review of `9726773` (NOT READY) was closed on the same branch:** a
lost Connect / Reconnect / Test / create is never confirmed by a read (*Read current state* keeps
the marker, every other write stays locked until *Acknowledge uncertainty and continue*, a local
step behind a confirmation that names the consequence — for a create, a possible second connection,
since the route has no idempotency key and a connection cannot be removed); none of these steps
runs from another club's context; a repeated bind or Unbind refused as `try_again` keeps its
marker; the form says "OptiMove does not retain the username or password after this request. Your
browser or password manager may handle them according to its own settings." and asks the
administrator to check that both fields hold the GPEXE pair, not the OptiMove sign-in. **The
owner's external review of `1602238` (2026-10-05): READY WITH NON-BLOCKING FOLLOW-UP.** Owner
decisions: `autocomplete="current-password"` stays (`off` guarantees nothing either); the
possible duplicate connection after a lost Create does not block the merge and is a separate
backend hardening task (see Separate tasks); the owner pilot procedure stops on a lost Create
(never *Acknowledge uncertainty and continue*, never a new connection, report). Browser QA by the main session on a static harness running the
branch's real modules against an in-page fake of the routes (desktop 1280 px and 360 / 375 / 390
px: no horizontal overflow, every control 44 px, every field 16 px). The owner-run pilot
procedure: `docs/runbooks/gpexe-owner-pilot-f3c3.md`. **No real connection, binding, check or GPEXE
request; no credential anywhere.**

**PR A (F3c3) is merged and deployed** (PR #138, merge commit `0788452` on 2026-10-05 13:47:15 UTC,
merged exactly from head `4527470` after the owner's final external review READY; `/api/health`
served `0788452` with `ok: true` three times in a row (13:48:41, 13:48:52, 13:49:02 UTC); without a
login the list, the single GET, create, connect, test, bindings and unbind routes answered 401 (zero
UUIDs, `{}` bodies, nothing else sent). No migration in it: v31 stays the last migration inferred on
the deployed database. No GPEXE request by the main session; the Render environment,
`GPEXE_API_TOKEN` and `GPEXE_IMPORT_APPLY_ENABLED` untouched.

**The owner-run read-only pilot (2026-10-05, on `0788452`; sanitized, as reported by the owner):**
Connect succeeded and the connection is *Verified*; the OptiMove team approved for GPEXE Team ID 980
was bound to it; Training Load → Imports showed the team *Connected*; one *Find new sessions*
without dates searched the default 14 days (22.09.2026 – 05.10.2026) and **the check ended
`failed`** (not `outcome_unknown`). The owner stopped there, as the procedure says: no repeat, no
further GPEXE request. `GPEXE_IMPORT_APPLY_ENABLED` stays off; nothing was imported, approved or
linked. **What the failure is not:** the sentence "Import writing is switched off in this
environment…" read under the source card's *Technical details* is the import switch's state, which
that card printed under the label "Server message" whatever the check's outcome — a check never
consults the switch (only approving one candidate or a batch does). **The check's own code is not
recorded yet:** it is on the check row, shown to an administrator in the red "The last search … did
not finish" box (*Technical details → Code*) and returned by `GET …/gpexe/teams/<team>/checks/<check
id>`; reading it sends nothing to GPEXE. **Production state after the pilot (as far as known):** one
club connection on `server3`, *Verified* at the Connect and at the Bind as the owner saw it — **its
state after the failed check is not read yet** (a `source_auth_rejected` failure would have moved it
to *Needs reconnect*); one active binding (the team ↔ 980); one failed check row whose
`source_path` is `source_connection` by the v31 rule (inferred, not read). From now on that team
reads only through its binding (the v31 rule: no return to the environment token). The fix PR on branch
`fix/gpexe-imports-failed-check-details` names that line *Import switch*, shows a failed check's own
code and message beside its status, says the last search did not finish instead of "Nothing found
yet", and pins the boundary with a regression test (a connection-backed check succeeds with the
switch off and writes nothing of an import; approving stays refused; a failed source read stays
failed with its own code).

**That fix is merged and deployed** (PR #139, merge commit `673848e` on 2026-10-05 16:09:52 UTC,
merged exactly from head `8b51999` after the owner-ordered final review found no BLOCKER / HIGH;
`/api/health` served `673848e` with `ok: true` three times in a row (16:10:50, 16:11:01, 16:11:12
UTC); the served bundle carries the new labels; without a login the team status, the check detail
and the candidates answered 401; GET only, no check started, no GPEXE request).

**The failed pilot check's own code, read by the owner on the deployed screen (2026-10-05,
sanitized; no new check, no GPEXE request):** `source_answer_unexpected` — "The source answer to the
whole-session details carries a metric value in an unknown shape." The GPEXE connection works and
the team stays bound to Team ID 980; nothing was imported, approved or linked; the switch stays off.
**Where it comes from:** the server3 adapter's whole-session read (`getSessionDetails`,
`rest/v1/team_session/<confirmed parent>/details/`, the `rest_v1` family) refuses the whole answer in
`validatePlayersAnswer()` when ANY metric of ANY athlete is not a finite number, null, a boolean, a
short unit-like text or a flat object of those (at most 32 keys) — or has a name outside
`[A-Za-z_][A-Za-z0-9_]{0,63}` / a prototype key; the refusal happens before anything of the session
is recorded. **What the importer consumes:** only `tot_burst_events` and `tot_brake_events` per
athlete (the mapper's `detailsNumber`: `{ unit: "number", value: <finite number> }`, the shape of the
real e03 responses kept in the test fixtures). **What the repository proves about server3:** the
probe's `session_details` verdict "same" meant HTTP 200 only, and the drill answer was described by
booleans only ("rows are objects with numbers and nested values", where nested includes lists); no
value shape of a server3 details answer — not even of the two consumed fields — is documented, and
the owner's legacy integration is not opened by the main session (it holds credentials). **So the
real shape is not proven, and the parser is not widened.** Instead (owner order 2026-10-05, option B)
branch `fix/gpexe-session-details-metric-shape` keeps the acceptance rule exactly as it is and adds a
bounded, sanitized description to that one refusal (the check row's message after
" Diagnostic: "): the operation; count buckets of athletes, metrics and failing metrics; whether a
consumed field is among the failing ones; booleans for a bad metric name; the kinds, depth, length
and child-kind buckets of the failing values and whether a failing object has `unit` / `value` keys;
for the two consumed fields only, their presence, kinds and whether they match the documented
`{ unit: "number", value: <finite> }`. It never carries an athlete id, any other metric name, a value,
a text, a date or raw JSON; it sends nothing; an administrator reads it, a coach gets the sentence
without it. A drill answer refused the same way keeps its description through the drill set, so a
`drill_set_incomplete` check carries `drill_index`, `drill_code` and the same description too.
**Another owner-run check (one known date) waits for the external review of that branch** and
returns only the "Diagnostic:" line.

**That diagnostics branch is merged and deployed** (PR #140, merge commit `e13d251` on 2026-10-05
17:12:04 UTC, merged exactly from head `dfd452a` after the owner-ordered final review found no
BLOCKER / HIGH; `/api/health` served `e13d251` with `ok: true` three times in a row (17:13:04,
17:13:15, 17:13:25 UTC); without a login the team status, check detail, candidates and both
source-connection reads answered 401; GET only, no check started, no GPEXE request).

**The owner's single re-test returned the diagnostic (sanitized, as reported by the owner; one
check of one known date, nothing repeated):** code `source_answer_unexpected`, `op=session_details`,
`consumed_failing=no`; `tot_burst_events` and `tot_brake_events` present for every athlete, all
objects with `unit = "number"`, a finite `value` and only the keys `unit` / `value`; athletes
17–64, metrics 65+, **exactly one failing metric** (its name not emitted), kind object, depth 1,
5–16 keys, children null / number / short text / other-character text, neither a `unit` nor a
`value` key. No candidate, preview, activity, result or import was written; the switch stays off;
no Link athletes. **So the two consumed fields are proven in the documented shape on server3, and
the refused metric is one the importer never reads.** Code search proves the only whole-session
consumer is the mapper's `detailsNumber` (`tot_burst_events` / `tot_brake_events`, keys
`unit` / `value`); the SQL readers of the stored snapshot read `teamSession` and
`athleteSessions` only. **Fix (branch `fix/gpexe-session-details-projection`, owner order
2026-10-06):** `getSessionDetails` now uses `projectSessionDetails()` — the container, athlete ids,
per-athlete bounds and the metric-name guard (dangerous keys included) exactly as before; of the
values only the two consumed fields are read, validated by the same rule and copied into fresh
objects (an object keeps only its own `unit` / `value`); the projection never reads, copies,
describes, stores or returns any other metric (the generic JSON parse still walks the whole body in
memory, within the 5 MiB read cap, and keeps nothing of it); a missing field stays missing and an
athlete without both keeps `{}`, so the mapper's skips are unchanged; a malformed consumed field still
fails (the sentence stays generic, the field and its kind follow the " Diagnostic: " mark for an
administrator), and a refused metric name says only which kind of name. The stored snapshot and its
content hash now cover the projected answer only; no candidate read through a bound connection
existed before (both real checks failed with nothing written), so none is re-seen as changed. The drill answers keep the full check (their consumers need their own
evidence). An architecture test runs the real mapper on a bundle whose whole-session details record
every key access and fails on any metric but the two.

**That projection is merged and deployed** (PR #141, merge commit `3790782` on 2026-10-06 00:18:51 UTC,
merged exactly from head `8fb925f` on the owner's order).
- `/api/health` served `3790782` with `ok: true` three times in a row (00:19:55, 00:20:06, 00:20:17 UTC).
- Without a login, these answered 401: the team status, one check, the candidates, one candidate, the
  source athletes and the athlete links.
- GET only; no check started, no GPEXE request. (Carried over from the open docs PR #142.)

**The owner's re-test succeeded (2026-10-06, sanitized, as reported by the owner).** One check for
05.10.2026 – 05.10.2026 ended `succeeded`.
- It found 1 GPEXE session: 1 not seen by OptiMove before, 0 changed, 0 unchanged. GPEXE Team ID 980.
- The switch stayed off. There was no Link athletes and no Import, and the check was not repeated.
- This is the first successful check through the bound connection.
- *Inferred from the counts and the code, not read from the deployed database:* one candidate of that
  session is stored for the team, with its preview and its projected snapshot. The Imports screen lists it
  under *Needs attention*.

**F3c2g — the importer's credential resolver, the strict transition from `GPEXE_API_TOKEN` and
migration v31 — is merged and deployed** (PR #137, merge commit `6382d25` on 2026-10-04 21:58:03 UTC,
merged exactly from head `30c9600` after the owner's external review in five rounds — round 5 READY
WITH NON-BLOCKING NOTES, no BLOCKER / HIGH / MEDIUM; `/api/health` served `6382d25` with `ok: true`
three times in a row (21:59:06, 21:59:26, 21:59:47 UTC) and once more at 22:01:47 UTC; without a login
`POST …/gpexe/teams/<zero uuid>/checks` (no body and `{}`), `GET …/status` and
`GET …/checks/<zero uuid>` answered 401; no check, Connect, Bind, Unbind or import was run, no
credential used, no GPEXE request sent; the Render environment, `GPEXE_API_TOKEN` and
`GPEXE_IMPORT_APPLY_ENABLED` untouched). **v31 on the deployed database is an indirect conclusion
only**, from the server starting after the migration step (`npm start` runs `node src/migrate.js &&`
the server); the deployed database was not queried with SQL. **F3c2 is finished with it; there is no
F3c2h.** The three non-blocking notes of the owner's closing review are recorded as standing rules:
(1) raw database writers must use the agreed `READ COMMITTED` isolation and the runbook — the v31
legacy-path guard reads with the writer's snapshot, so a raw writer in `REPEATABLE READ` or
`SERIALIZABLE` whose snapshot predates a bind's COMMIT is outside the guarantee (the application pins
`READ COMMITTED`); (2) F3c4 removes the `DEFAULT 'legacy_env'`, forbids new legacy rows and does not
rewrite the historical ones; (3) a bounded `pool.connect()` (`connectionTimeoutMillis`) stays a
separate hardening task, to be resolved or explicitly split out before F3c is declared complete. As
built (branch `feature/gpexe-importer-resolver-f3c2g` from `d285296`, owner order 2026-10-04;
backend service, resolver module, migration v31, tests and docs; one route change — the importer
router's error detail `reason` and a failed check's precise code are for administrators only; no UI):
Discovery: `docs/ai/source-connections-f3c2g-discovery.md` (the check run is the importer's only
network entry point; approve and preview read the stored snapshot; `createGpexeClient()` is the only
reader of the variable and `startCheck()` its only caller). As built — contract section 2.8, runbook
`docs/runbooks/gpexe-in-app-import.md` ("Which credential a check uses"):
`backend/src/sourceImportCredentialResolver.js` turns one OptiMove team into a closed read context in
three phases — the facts under the team import lock (one active binding, the approved pair, the
connection of the same club and `verified`, the host approved in the catalog and in code; no URL,
host, source team or credential from the caller), the decrypt and the adapter after COMMIT right
before the first request with the plaintext reference dropped in `finally`, and the same facts
re-validated before and after every source operation of the run, a fingerprint of the stored
credential included (an ended or replaced binding, a connection that left `verified`, a Reconnect, a
retired host stop the run with `binding_ended` / `connection_not_usable` /
`connection_credential_changed` / `host_not_allowed`; a legacy run stops with `binding_started` when
a binding appears); a refused credential (401) moves the connection to `needs_reconnect` with one
`auto_invalidate` audit row (basis `system`, written after the check's own outcome, conditional on
the credential the run held, bounded) and fails the check, while a 403 fails the check and keeps the
state; the binding path reports progress per source request; the check-start COMMIT is bounded and
its loss is never "nothing was written" (`503 check_outcome_unknown` or the run when the row is
found); the approved pair is compared canonically; the pre-read proves the key ring without a
decrypt; the resolver's facts are branded. **The transition rule (D8 made
strict):** a team with an active binding reads only through it — the legacy factory is not called,
the variable is not read, and an unusable binding answers `409` / `503 source_connection_unavailable`
with the precise `reason` (no check row) or the precise code on the check row — never a fallback; a
team without a binding — and that never had one — keeps the legacy path, labelled `legacy_env`; a
team whose binding ended answers `source_connection_unavailable` / `binding_ended` until it is bound
again and never reads the variable again (owner's round-4 decision, Q3); the path is decided once per
check under the team lock (an unlocked pre-read and the locked read must agree, else `409
gpexe_change_busy`); the facts are re-validated before AND after every list (empty or not) and every
bundle, both paths pin the club the run started in (`team_club_changed` / `team_not_available`). The binding path's reads are the F3c2c adapter's (`listSessionsByDay`,
`fetchSessionBundle`, GET only, bound to the approved source team); an incomplete drill set stops
the run with `drill_set_incomplete` before the session is recorded, an empty successfully read
`players` is a valid empty drill, and `drillsStatus` / `drillLabels` are stripped so the stored
snapshot keeps the F1 contract. The resolver is wired into `startCheck` / `runCheck` directly: on
the deployed database no connection or binding exists, so every team still takes the legacy path
and nothing observable changes; removing the variable stays F3c4. **Status of the legacy env
fallback:** in force only for a team that never had a binding, labelled, and recorded on every check
row by **migration v31** (`migrations_v2/202610041200_training_load_v31_gpexe_import_checks_source_path.sql`:
`source_path` `legacy_env` / `source_connection` with `source_connection_id`, `source_binding_id`,
`source_team_id`, `source_host_key`, written in the locked INSERT, final from creation, a BEFORE
INSERT trigger refusing a path the data does not support; rows from before v31 are `legacy_env` by
default — the documented backfill; rollback `docs/runbooks/gpexe-import-checks-v31-rollback.sql`,
forward-safe: it refuses while any row says `source_connection`; rehearsed on a disposable database) —
the owner's round-4 decisions: Q1 v31, Q2 `verified` only, Q3 no legacy downgrade after an Unbind.
**Round 5 (owner's external review of `d7657c8`, 2026-10-04):** the v31 trigger also refuses a
`legacy_env` row for a team that has or had a gpexe binding (under the team's import try-lock;
`23514`, `gpexe_import_checks_legacy_path_never_bound`), whoever writes it — a never-bound team
writes `legacy_env`, rows from before a team's first binding stay as history, serialized with a bind
by the one team lock in both orders; the precise code of a failed check stays on the row, and on
the status, the check detail and a start that fails after its COMMIT a coach sees
`source_connection_unavailable` plus the sentence to contact an administrator for every
connection-configuration code (a platform admin and the club's own admin see the precise one;
general source answers and team facts are shown as they are); **decision for F3c4 recorded:** the
migration that retires the environment path drops the `legacy_env` DEFAULT, new code writes no
legacy check, historical legacy rows are not rewritten.
Tests: `backend/tests/gpexe-import-credential-resolver.test.mjs` (disposable database, a fake source
serving the exchange, the team reads and the rest_v1 session reads; the legacy factory as a trap on
the binding path; the resolver's contract with a fake executor), with mutation evidence for the key
guards.

**GPEXE athlete identity for *Link athletes*** (owner order 2026-10-06). The owner asked that *Link
athletes* identify a GPEXE athlete by its GPEXE name and date of birth, with the internal id moved to
Technical details.
- **The probe is merged and deployed:** PR #143 (`--mode identity` in the capability probe, branch
  `feature/gpexe-identity-field-probe`).
  - Merge commit `2458ac5` on 2026-10-06 at 13:22:52 UTC, pinned to head `9ec076f` on the owner's
    order.
  - The owner's external review was NOT READY at `517bdda` (a key that could be a person) and READY
    at `1cf2430`.
  - `/api/health` served `2458ac5` with `ok: true` from 13:24:10 UTC, then three times in a row
    (13:24:15, 13:24:26 and 13:24:36 UTC).
  - Docs and probe only: no route, no migration. The identity run was not repeated, and no GPEXE
    request was sent.
- **The owner ran the probe once (2026-10-06, sanitized):**
  - `rest/v1/athlete/<id>/` is confirmed, with `first_name`, `last_name`, `name`, `short_name` and
    `birthdate`;
  - `birthdate` was null for the one athlete read, so the date's format is not proven;
  - the record has no team field.

  The source, the name rule (`first_name` + `last_name`, fallback `name`) and the date rule (a valid
  `YYYY-MM-DD` or the first ten characters of a valid ISO date-time) are the owner's decisions. They
  are recorded in `docs/ai/gpexe-rest-v1-compatibility.md` section 4b. There is no further probe.
- **The implementation, as built** (branch `feature/gpexe-athlete-identity` from `2458ac5`, not merged;
  migration v32, backend, frontend, tests and docs). Discovery:
  `docs/ai/gpexe-athlete-identity-discovery.md`; contract section 2.10 of
  `docs/ai/source-connections-f3c2-contract.md`; runbook section "GPEXE names and dates of birth" of
  `docs/runbooks/gpexe-in-app-import.md`.
  - **Who:** a platform admin (platform or the team's club workspace) and the active admin of the
    team's club (that club's workspace). Everyone else gets the router's identical 404, no-store:
    - a coach, another club, a team workspace;
    - a revoked role;
    - an archived team or club;
    - a team without an active binding.

    A coach's screen and status carry no trace of the feature.
  - **Network:**
    - only the explicit *Load names and dates of birth*, never during a check;
    - the server derives the athletes from the stored candidates that a succeeded check read through
      the team's current binding;
    - at most 50 per load and 3 at once; no retry, no redirect, no environment token;
    - a 15 s timeout per request and a 45 s budget, below the client's 90 s bound;
    - every answer must name the id asked for;
    - the binding facts (binding, connection state and club, host, credential fingerprint) are
      re-validated before every read and under `FOR SHARE` locks before the write;
    - a 401 moves the connection to *Needs reconnect* through the existing auto-invalidate path, and
      a 403 changes nothing.
  - **Idempotency:** a requestKey per load; one running load per team (a partial unique index); a
    lost answer is *Result not confirmed* · *Check result*, the same key, never sent by itself; the
    bounded COMMIT with `verified_after_commit_error` / `503 outcome_unknown`.
  - **Snapshot (v32):**
    - only the provenance, the canonical id, a sanitized display name or NULL, a normalized date or
      NULL, `observed_at`, and `expires_at` = `observed_at` + 336 hours (CHECK);
    - never updated or extended; GPEXE's "no such athlete" is never an identity: only a 24-hour retry
      suppression (binding, team, id, `observed_at`, `retry_after`) leaves it out of the next loads'
      choice, so 404s cannot starve the others; it is never extended, is deleted with the identities,
      and is followed by no automatic retry;
    - an expired row is never shown and is deleted by the purge (every check, the server's schedule,
      the CLI, and before every load);
    - an Unbind, a team archive and a club archive delete the rows in the same transaction (database
      triggers);
    - the personal columns are plaintext, with no index (see the security review).
  - **UI:**
    - the name and "Born DD.MM.YYYY" ("Name not provided" / "Date of birth not provided"), "Name not
      loaded" for any other athlete; the id only in Technical details (rows, aria-labels,
      confirmation, results, errors, the unlink question);
    - the stored list is read in one transaction holding the `FOR SHARE` locks of the connection,
      binding, team, role, user and club until the answer is assembled (fail-closed against a
      revocation after the route's check);
    - a warning for a duplicate name and for a date-of-birth conflict with the chosen OptiMove
      athlete (the server returns the pair only, never OptiMove's date);
    - no automatic link, no preselection;
    - in memory only, dropped on Close or a team or workspace change.
  - **Not changed:** the importer, the metric mapping, the import switch, F3c4.
  - **Supersedes** the sentence "GPEXE names are never stored" of PR #142's discovery note, for this
    administrator-only snapshot. The coach's lists still carry no GPEXE name.
  - **No GPEXE request, credential, Render change or persistent-database migration was made**; v32
    is applied nowhere persistent.
  - **Owner's external review of `5642a1d` (2026-10-07): NOT READY.**
    - Findings: HIGH, the authorization race on the read; MEDIUM, the id outside Technical details;
      MEDIUM, the 404 cached for 14 days; LOW, ISO offsets up to ±23:59.
    - All four were fixed in a follow-up commit on the same branch, each with a test and a mutation that
      the test kills.
    - **Accepted by the owner:**
      - plaintext columns within the existing database trust boundary;
      - the date-of-birth mismatch boolean for the two administrator roles;
      - a strict 14-day TTL in the live table, while a backup follows its own policy with the purge
        required before a restored copy is used.
  - **Production-use gate:** before the first real identity load, the owner confirms the legal basis
    and the notice for processing names and dates of birth, minors included.
  - **Owner's external review of `94ec914` (2026-10-07):** the four earlier findings are closed. One new
    MEDIUM: repeated 404s could permanently starve the other pending athletes.
    - The owner decided on a 24-hour retry suppression of a GPEXE 404, with no identity, never extended,
      deleted with the identities, and no automatic retry. It is built in v32 (still unapplied) with a
      deterministic test of more than 50 athletes and four killed mutations.
    - `pool.connect()` stays the existing hardening task.
  - **Owner's external review of `407c8c1` (2026-10-07): READY**, with no BLOCKER, HIGH or MEDIUM.
- **PR #144 is merged and deployed.**
  - Reviewed head `407c8c1`, merge commit `bb3cfdd` (parents `2458ac5` and `407c8c1`) on 2026-10-07 at
    07:52:33 UTC, merged exactly from that head on the owner's order.
  - `/api/health` first served `bb3cfdd` with `ok: true` at 07:53:33 UTC, then three times in a row
    (07:53:43, 07:53:54 and 07:54:05 UTC).
  - Without a login, with the zero UUID and no real data, these answered 401: `GET …/athlete-identities`,
    and `POST …/athlete-identities/loads` both with `{}` and without a body.
  - **v32 on the deployed database is inferred** from the server starting after the migration step. It was
    not queried with SQL.
  - **No identity load and no GPEXE request was made**, at the merge, the deploy or since. Render and the
    import switch were not touched.
- **Production-use gate (recorded as closed; whether it was confirmed before the owner's load after PR #146
  is not recorded, see below):** the first real identity load is forbidden until the owner separately
  confirms the legal basis and the notice for processing names and dates of birth, minors included. The UI
  may be deployed, but *Load names and dates of birth* is not used until then.
- **The GPEXE id on every administrator Imports screen** (owner order 2026-10-07; PR #145, frontend and
  docs only; merged and deployed, see below).
  - **Rule:** outside Technical details, an administrator sees a GPEXE name (with "(GPEXE athlete N)" when
    two GPEXE athletes share it), "Name not provided (GPEXE athlete N)", "Name not loaded (GPEXE athlete N)",
    or "GPEXE athlete N" when the team has no stored identity. N is the place in the team's GPEXE athlete
    list as the server orders it, not the id; an athlete that list does not hold yet gets the next free
    number, in memory only. Numbers need not be consecutive inside one group; nothing of it is stored.
  - **Where:** on the Imports page, Link athletes, the session review, the last-link notice,
    confirmations, results, errors, aria-labels and the unlink question. The 13 places are listed in
    `docs/ai/gpexe-imports-id-masking-discovery.md`.
  - **Loading:** the administrator's Imports view reads the stored identities with the team (no GPEXE
    request). They are dropped on leaving Imports or Training Load, a team or workspace switch, a status
    without the identity right, or signing out; an identity answer still in flight never brings them back.
    Only the state of a name load (in flight, its key, a result not confirmed) outlives a clear, so a lost
    answer keeps its key for *Check result*.
  - **Coach:** a coach's screens are unchanged and get no sign of a snapshot.
  - **Unchanged:** backend, v32 and Link / Unlink.
- **PR #145 is merged and deployed.**
  - Reviewed head `782903e` (the owner's external review READY, no BLOCKER, HIGH or MEDIUM), merge commit
    `0271acb` (parents `bb3cfdd` and `782903e`) on 2026-10-07 at 09:54:28 UTC, merged exactly from that head
    on the owner's order.
  - `/api/health` first served `0271acb` with `ok: true` at 09:55:23 UTC, then three times in a row (09:55:34,
    09:55:44 and 09:55:54 UTC). The served bundle carries the neutral labels and both notes that "GPEXE
    athlete N" is not the GPEXE id.
  - Read-only smoke without a login, zero UUID, GET only: the team status, the candidates, the source
    athletes, the athlete links, the athlete identities, one check and one candidate answered 401.
  - **No Load identities, Check, Connect, Bind, Link, Unlink or Import was run** and no GPEXE request was
    sent; Render, credentials and the import switch were not touched.
  - **PR #142 is closed as superseded** (on the owner's order, after the deploy): not merged, its branch
    `docs/gpexe-pilot-retest-and-link-discovery` kept, a comment says that its still-true facts were carried
    into PR #145 and that its own CURRENT_STATE is no longer accurate.
- **Production-use gate (recorded as closed; see "After PR #146" below - a load was run by the owner, and
  whether this gate was confirmed is not recorded):** no real *Load names and dates of birth* until the owner separately
  confirms the legal basis and the notice, minors included.
- **Hardening after PR #145** (owner order 2026-10-07; PR #146, branch
  `fix/pool-checkout-timeout-and-identity-key` from `0271acb`; backend, frontend and docs, no migration;
  merged and deployed, see below):
  - **A bounded pool checkout.** The global pool in `backend/src/db.js` sets `connectionTimeoutMillis` =
    5 s (`PG_POOL_CHECKOUT_TIMEOUT_MS` only for tests); every timed-out checkout - `pool.connect()` in both
    forms and `pool.query()` - carries the stable code `pool_checkout_timeout`. pg-pool removes a waiter that
    timed out, releases a client that arrives for it later and ends a new connection that could not open in
    time. Express 4 drops a rejected async handler, so 21 routes that check out before their own `try`
    would have ended the process: `backend/src/expressAsyncErrors.js` hands such a rejection to the error
    handler. Answers: the global handler 503 `database_busy` (Retry-After, nothing of the request logged); the
    source-connection routes (Unbind included), the importer and the identity routes their `try_again`
    (every uncaught checkout there is the first step of the requested operation, before any of it is written
    or sent); an identity load whose finalize checkout times out closes its request row as failed and answers
    `try_again`, or `outcome_unknown` when even that cannot run; the roster command `roster_busy`. Login, forgot
    password and the verification resend each take one checkout before any decision and run the lookup and
    any transaction on it, with their usual answer on a timeout, so a busy pool never tells accounts,
    pending applications or passwords apart by status, body or wait (security review; owner's external
    review of PR #146). A *Check result* of an
    identity load refused for any reason but the original load's saved outcome stays not confirmed. No
    lock, COMMIT boundary, statement or lock timeout changed. Why 5 s fits the HTTP budgets: see the runbook
    section "Database pool checkout bound" in `docs/runbooks/gpexe-in-app-import.md`.
  - **An unconfirmed identity load keeps its key across a team or workspace change.** In memory only,
    indexed by sign-in and OptiMove team: the request key and the Check result count, never a name, a date
    of birth or a GPEXE id. Back on the same team *Check result* repeats the same key; another team never
    shows or sends it; nothing is sent by itself; a settled load (an answer, a stated refusal, the 404)
    removes it; sign-out clears all.
  - **A long name in the session review** (a 55+ character unbroken word included) wraps inside the
    athlete row instead of being clipped; checked at 360, 375 and 390 px.
  - **Owner's external review of `6c8bbcd`: NOT READY** (MEDIUM: forgot password and the verification resend
    took a second checkout only for an existing account / pending application, a timing oracle under a
    saturated pool). Fixed in `c2b2c37`: each route takes ONE checkout before anything about the email is
    known and runs the lookup and any transaction on it; the client is released before the timing floor and
    the email. **Owner's external review of `cafe502`: READY.**
- **PR #146 is merged and deployed.**
  - Reviewed head `cafe502`, merge commit `5436c6d` (parents `0271acb` and `cafe502`) on 2026-10-07 at
    13:06:18 UTC, merged exactly from that head on the owner's order.
  - `/api/health` first served `5436c6d` with `ok: true` at 13:08:18 UTC, then three times in a row
    (13:08:28, 13:08:38 and 13:08:49 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE, source-connection, roster and
    organization routes answered 401 (`/auth/me`, a public route, answered 200 with no user).
  - No Load identities, Check, Connect, Bind, Link or Import at the merge or the deploy; Render and the import
    switch untouched. No answer showed `database_busy` or `pool_checkout_timeout`; the Render logs were not
    read from this workstation.
- **After PR #146 (owner-run, 2026-10-07; sanitized, as reported by the owner):**
  - one identity load succeeded and one athlete link was made. No name, date of birth or id is recorded
    here. **This record does not say whether the owner confirmed the production-use gate (legal basis and
    notice, minors included) or the two gates before a link (under Separate tasks); their state is the
    owner's to state, and they are kept below as written until then;**
  - one check for 05.10.2026 – 06.10.2026 ended **`source_filter_ignored`** ("The source server returned
    sessions outside the asked window; the window cannot be trusted."): the failed check row with that code
    is stored; no candidate, preview, import, activity or result row was written and nothing was imported.
    **No conclusion about its cause.** The code review (main session, no GPEXE request) found that the
    window guard runs over every returned row before the parent / drill classification, reads a row's day as
    the first ten characters of `start_timestamp` (no zone), accepts the look-back day, and reports a row
    outside the window and an unreadable start under the same code; the same request form passed for
    05.10 – 05.10 and in the probe.
- **A sanitized diagnostic for `source_filter_ignored`** (owner order 2026-10-07; PR #147, branch
  `fix/gpexe-source-filter-ignored-diagnostic` from `5436c6d`; merged and deployed, see below; superseded
  by option (c), which removed the refusal and its description):
  the refusal is unchanged (the same code, no candidate, preview, import, activity or result row, nothing
  imported, no retry, no extra request; the failed check row is stored as before); the check row's stored
  message gains after " Diagnostic: " only counts and fixed words -
  `op=session_list_by_date; rows=N; before_lookback=N; after_end=N; unreadable=N; outside_named_drill=N;
  distance=under_3h:N,3h_to_24h:N,over_24h:N,unknown:N; tz=Z:N,offset:N,none:N,other:N.` - checked by a
  final fixed-grammar guard (anything else drops the description, never the refusal); a start that is not a
  real calendar date and time (checked strictly, never normalised) counts as unreadable. The description is
  stored on the check row and in no log. A platform admin and
  the team's club admin read it; a coach gets the stable sentence. The filtering rule, the period, the
  timezone rule, the classification and the fail-closed behaviour are unchanged; the options (a) a drill
  row past midnight, (b) a zone rule, (c) the whole list filtered locally wait for the diagnostic's result.
- **PR #147 is merged and deployed.**
  - Reviewed head `13b3938` (the owner's external review READY after round 2 - a strict start reading and
    the stored-check-row wording), merge commit `39176b8` (parents `5436c6d` and `13b3938`) on 2026-10-08
    at 09:28:28 UTC, merged exactly from that head on the owner's order (`--match-head-commit`).
  - `/api/health` first served `39176b8` with `ok: true` at 09:29:21 UTC, then three times in a row
    (09:29:31, 09:29:41 and 09:29:52 UTC).
  - Read-only smoke without a login, zero UUID, GET only: the GPEXE team status, one check, the candidates,
    one candidate, the source athletes, the athlete links, the athlete identities, the source-connection
    list and one connection answered 401. No migration; no check or GPEXE request at the merge.
- **The owner's controlled check of the same window (2026-10-08, run once, sanitized, as reported by the
  owner):** `op=session_list_by_date; rows=13; before_lookback=0; after_end=5; unreadable=0;
  outside_named_drill=0; distance=under_3h:0,3h_to_24h:5,over_24h:0,unknown:0;
  tz=Z:0,offset:0,none:13,other:0.` - five rows of the server's date-filtered answer start 3 to 24 hours
  after the asked period, none named as a drill, every start readable and without a zone suffix. **Owner
  decision: option (c)**: the importer no longer trusts the server-side date filter for completeness.
- **Option (c) - the whole list, filtered locally** (owner order 2026-10-08; PR #148, branch
  `fix/gpexe-rest-v1-local-window-filter` from `39176b8`; merged and deployed, see below; backend adapter,
  tests and docs):
  `listSessionsByDay` reads the whole session list of the bound team (`team_session/?team=&limit=100`,
  the proven row-1a read) - every page with the same `X-Total-Count`, every next link on the same host,
  family, resource and team with only `limit=100` and an `offset` equal to the rows read so far, at most
  2000 rows (20 pages; a longer list refused at its first page as `source_list_too_large`) - classifies
  parents and drills on the whole list, refuses a start that is not a real date and time anywhere in it
  (`source_session_start_unreadable`), and only then returns the parents of the window by their naive
  day (the look-back day's parents and every other day's left out; only the window's parents become
  readable). Any refusal fails the check with its own code (the failed check row stored; no candidate,
  preview, import, activity or result row; no bundle read; no retry). No server-side date filter, no
  fallback to it, no other host, no environment token; Link, Import, drill and metric rules unchanged.
  The `source_filter_ignored` refusal and its sanitized description are gone with the filter. Runbook
  section "How a check finds the sessions of its window". **Fail-closed consequences:** the whole
  history is checked - a list longer than 2000 sessions, one session with an unreadable start or one
  ambiguous parent / drill pair anywhere fails every check of the team until it is corrected in GPEXE.
  **Not yet observed on server3:** the form of a next link (only `limit` / `offset` is accepted) and the
  classification of team 980's whole history (308 rows on 2026-09-29, so at least four pages); the first
  real check after the merge is the first proof of both. **Two complete reads (owner decision
  2026-10-09, after the internal review found the offset-paging blind spot):** the whole list is read
  twice, snapshot A then snapshot B, each with every check above; they must agree on the total, the ids
  in the same order and, per id, `team`, `drills` (order), `drills_count`, `start_timestamp`,
  `category_name`, `end_timestamp`, `updated_on` and `is_stats_valid`, otherwise `source_list_changed`
  (no partial result, no session left readable; B is not sent after a failed A; only B is used and
  recorded; the importer re-checks the binding, connection and credential between A and B, so B is
  never sent after an Unbind or a Reconnect during A). About eight list GETs per check for 308 - 350 rows (four pages, twice), at most 40 at the
  cap. This closes the known delete + insert blind spot; it is **not a transactional snapshot** - a
  change that lands identically in both reads stays a residual risk.
- **PR #148 is merged and deployed.**
  - Reviewed head `f34291d` (the owner's external review READY), merge commit `33d4f45` (parents `39176b8`
    and `f34291d`) on 2026-10-09 at 07:55:17 UTC, merged exactly from that head on the owner's order
    (`--match-head-commit`).
  - `/api/health` first served `33d4f45` with `ok: true` at 07:56:20 UTC, then three times in a row
    (07:56:30, 07:56:40 and 07:56:51 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE and source-connection routes
    answered 401. No migration; the switch untouched.
- **The first whole-list check (2026-10-09, run once on the owner's order, 05.10.2026 - 06.10.2026):**
  the preconditions held (`33d4f45` served; the connection *Verified* on server3; one active binding of
  the team to GPEXE Team ID 980; the import switch off). The check passed the list stage (two complete
  reads, the window picked out) and read one session, then ended **`drill_set_incomplete`** with the
  administrator's description `drill_index=0; drill_code=source_answer_unexpected;
  op=session_drill_details; consumed_failing=no;` - `tot_burst_events` and `tot_brake_events` present for
  every athlete in the documented shape, exactly one failing metric, an object of 5 - 16 keys with no
  `unit` / `value` key (the same shape the whole-session read met on 2026-10-05). Nothing was recorded;
  the check was not repeated.
- **Drill answers projected to the consumed fields** (owner request 2026-10-09; branch
  `fix/gpexe-drill-details-projection` from `33d4f45`; not merged; backend adapter, tests and docs): the
  drill read (`getSessionDrillDetails`, `getSessionDrills`) now uses the same `projectSessionDetails()` as
  the whole-session read (PR #141) with `op=session_drill_details` - container, athlete ids, per-athlete
  bounds and the metric-name guard unchanged, an empty `players` map still valid, of the values only
  `tot_burst_events` / `tot_brake_events` validated and copied; an unconsumed metric of any shape is
  dropped, a consumed field in an unknown shape or a bad metric name still ends the drill set with
  `drill_set_incomplete` and a description of fixed words only (`field=<consumed field>; kind=<kind>` or
  `names=<kind of name>`). The mapper is the only consumer of drill details and reads only those two
  fields (B7.7b proxy guard, B7.8 static guard). No change to the list, Link, Import or the switch.
  **Effect on what is already stored:** the stored bundle and its hash now carry projected drill answers,
  so a session recorded before this change with drills (the 05.10.2026 session of the 2026-10-06 check)
  is expected to come back from the next check as **changed** - because of the projection, not a change
  in GPEXE - and its older pending candidate becomes `superseded`. **Every stored snapshot that was never
  imported is projected to the two consumed fields too** (owner's external review of `8087b81`,
  2026-10-09): a superseded one in the transaction that supersedes it, and every pending / blocked /
  superseded one by each retention run (every check, the server's 6-hour schedule, the CLI), with a write
  conditional on the snapshot it read - so the pending 05.10 candidate is projected by the first retention
  run after the deploy, whether or not the next check succeeds. The only copy is
  `gpexe_import_candidates.raw_bundle`, no route returns it, the preview holds only the mapper's values, a
  superseded candidate cannot be approved, and an imported candidate is never touched (none exists on the
  deployed database); the row's identity, content hash and preview hash stay. A database backup keeps what
  it held for its own retention; a restored copy runs the retention before use. The legacy e03 path does
  not project on read (covered by the retention run; F3c4 retires it). The full validator
  `validatePlayersAnswer` (and its whole-answer description) is removed: no read path called it after both
  projections, and a test refuses its return.

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
  from it; no GPEXE name, it is never stored - at the time; since v32 an administrator-only 14-day identity snapshot exists, see the active phase), a deterministic `lastSeen` (newest session
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
- PR #148 (`33d4f45`, merged 2026-10-09 07:55:17 UTC exactly from head `f34291d`) is deployed:
  `/api/health` served `33d4f45` with `ok: true` three times in a row (07:56:30–07:56:51 UTC); without a
  login nine protected routes answered 401. No migration. The owner's first whole-list check followed on a
  separate order (`drill_set_incomplete`, see the active phase).
- PR #147 (`39176b8`, merged 2026-10-08 09:28:28 UTC exactly from head `13b3938`) is deployed:
  `/api/health` served `39176b8` with `ok: true` three times in a row (09:29:31–09:29:52 UTC); without a
  login nine protected GPEXE and source-connection GET routes answered 401. No migration. No check or GPEXE
  request at the merge; the owner's controlled check followed on a separate order.
- PR #146 (`5436c6d`, merged 2026-10-07 13:06:18 UTC exactly from head `cafe502`) is deployed:
  `/api/health` served `5436c6d` with `ok: true` three times in a row (13:08:28–13:08:49 UTC); without a
  login nine protected routes answered 401. No migration. No identity load or GPEXE request at the merge.
- PR #145 (`0271acb`, merged 2026-10-07 09:54:28 UTC exactly from head `782903e`) is deployed:
  `/api/health` served `0271acb` with `ok: true` three times in a row (09:55:34–09:55:54 UTC); the served
  bundle carries the new labels; without a login seven Imports and identity GET routes answered 401. No
  migration, no route change. No identity load, no GPEXE request.
- PR #144 (`bb3cfdd`, merged 2026-10-07 07:52:33 UTC exactly from head `407c8c1`) is deployed:
  `/api/health` served `bb3cfdd` with `ok: true` three times in a row (07:53:43–07:54:05 UTC); without a
  login the identity GET and POST answered 401. **v32 on the deployed database is inferred** from the
  migrator's successful start, not SQL proof. No identity load, no GPEXE request.
- PR #141 (`3790782`, merged 2026-10-06 00:18:51 UTC exactly from head `8fb925f`) is deployed:
  `/api/health` served `3790782` with `ok: true` three times in a row (00:19:55–00:20:17 UTC); without a
  login the team status, one check, the candidates, one candidate, the source athletes and the athlete
  links answered 401. No migration, no route change. The owner's one-date re-test then succeeded (one
  session found; nothing linked or imported). (Carried over from PR #142.)
- PR #143 (`2458ac5`, merged 2026-10-06 13:22:52 UTC exactly from head `9ec076f`) is deployed:
  `/api/health` served `2458ac5` with `ok: true` three times in a row (13:24:15–13:24:36 UTC). Docs and
  probe only: no migration, no route change; v31 stays the last migration inferred on the deployed
  database.
- PR #140 (`e13d251`, merged 2026-10-05 17:12:04 UTC exactly from head `dfd452a`) is deployed:
  `/api/health` served `e13d251` with `ok: true` three times in a row (17:13:04–17:13:25 UTC); without
  a login the team status, check detail, candidates and both source-connection reads answered 401. No
  migration, no route change.
- PR #139 (`673848e`, merged 2026-10-05 16:09:52 UTC exactly from head `8b51999`) is deployed:
  `/api/health` served `673848e` with `ok: true` three times in a row (16:10:50–16:11:12 UTC); the
  served bundle carries the new Technical-details labels; without a login the team status, check
  detail and candidates answered 401. No migration, no route change.
- PR #138 (`0788452`, merged 2026-10-05 13:47:15 UTC exactly from head `4527470`) is deployed:
  `/api/health` served `0788452` with `ok: true` three times in a row (13:48:41–13:49:02 UTC); without
  a login every source-connection route answered 401. No migration in it. After the deploy the owner
  ran the read-only pilot (see the active phase): one connection, one binding, one failed check; no
  import.
- PR #137 (`6382d25`, merged 2026-10-04 21:58 UTC exactly from head `30c9600` after five external
  review rounds) is deployed: `/api/health` served `6382d25` with `ok: true` three times in a row and
  once more two minutes later; without a login the check start (zero UUID, with and without a body),
  the status and the check detail answered 401. **v31 on the deployed database is inferred** from the
  server starting after the migration step — an indirect conclusion, not SQL proof. No check,
  connection, binding, credential or GPEXE request at the merge or the deploy; the local OPTIMOVE
  database stays v21.
- PR #136 (`d285296`, merged 2026-10-04 15:17 UTC exactly from head `ea1674d` after two external
  review rounds) is deployed: `/api/health` served `d285296` with `ok: true` three times in a row
  (15:18 UTC) and once more at the smoke; without a login the Unbind route (zero UUIDs, with and
  without a body) and the connection GET answered 401. No migration in it: v30 stays the last
  migration inferred on the deployed database. No connection row, binding, Unbind, credential or
  GPEXE request at the merge or the deploy.
- PR #135 (`440ad83`, merged 2026-10-04 exactly from head `3352ad1` after three external review
  rounds) is deployed: Render Live for `440ad83` (owner); `/api/health` served `440ad83` with
  `ok: true` three times; without a login the list, single GET, create, connect, reconnect, test
  and the new bindings route, and `PUT …/gpexe/teams/:teamId/settings`, answered 401 (zero UUIDs,
  no data). **v30 on the deployed database is inferred** from the server starting after the
  migration step — an indirect conclusion, not SQL proof. No connection row, binding or audit row
  was created: no credential was entered and no GPEXE request was made.
- PR #134 (`cb54b85`, merged 2026-10-03, head `eb1076c` after three external review rounds) is
  deployed: `/api/health` served `cb54b85` with `ok: true` (owner). **v29 on the deployed database
  is inferred** from the server starting after the migration step; the deployed database was not
  queried. No connection row, binding or audit row can exist there yet: no credential was ever
  entered and no GPEXE request was made.
- PR #133 (`379d2fa`, merged 2026-10-03 10:37 UTC pinned to head `10a71af`) is deployed:
  `/api/health` served `379d2fa` with `ok: true` three times on 2026-10-03. Adapter, tests and
  docs only: no migration, no route; v28 stays the last migration inferred on the deployed
  database. No GPEXE request at the deploy.
- PR #132 (`e70fbd7`, merged 2026-10-02 22:16 UTC pinned to head `f2b2e01`) is deployed:
  `/api/health` served `e70fbd7` with `ok: true` three times on 2026-10-02. Docs and probe only:
  no migration, no route change; v28 stays the last migration inferred on the deployed database.
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
- `frontend/tests/builder-mobile-section-workflow.test.mjs` — test "16c. regression guard: the
  reorder arrows stay vertical (up/down) at every width…" fails; reproduced identically on a clean
  detached `origin/main` worktree (`6382d25`) on 2026-10-05 during the F3c3 work. Not fixed.
- `frontend/tests/organization-panel-cache.test.mjs` — test "6. signOut clears the entire view
  cache before/alongside its hard reload" fails; reproduced identically on a clean detached
  `origin/main` worktree (`6382d25`) on 2026-10-05. Not fixed.
- `backend/tests/training-load-metrics-builder-edit-draft.test.mjs` — refuses to start
  unless `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` is set (deliberate guard, no database
  operation attempted), so a plain full backend run reports it as failed; same on
  `3ef6033`.

## Separate tasks (recorded, waiting for the owner to schedule them)

- **GPEXE identity follow-up (not scheduled):** the single-athlete link from a session's review names the
  athlete by its GPEXE name or label since PR #145, but it shows no date of birth or date-of-birth conflict
  warning (only Link athletes does).

- **Imports screen follow-ups found at the first successful check** (code review, 2026-10-06; frontend
  only, not scheduled; carried over from the open docs PR #142):
  1. After a check ends, also re-read the source-athletes list. `pollGpexeCheck` reloads only the status
     and the candidates, so the *Next step* line and *Link athletes (N)* miss the unlinked athletes
     without a page reload. The Link athletes screen can then show "Find new sessions first" for a
     session that was just found.
  2. A session kept in *Needs attention* by an open reason (`no_linked_athlete`) should not show the
     badge *Up to date* and "Nothing new to import - no action needed." in its review.

  Each needs a frontend test.
- **Gates before any athlete link is written** (carried over from PR #142; owner-run, read-only, on a
  separate order):
  - **(1)** the production-readiness count of 2026-09-24 on the deployed `gpexe_athlete_links`:
    non-canonical ids, expected 0. The owner reports only the number.
  - **(2)** the helper values (Time, Distance, Top speed) match GPEXE's own view of the same session for
    two or three athletes. That the `rest_v1` numbers have the units the mapper assumes for e03 is not
    verified. If they do not match, a code fix of the units comes first.

- **Backend hardening: an idempotent Create of a source connection** (owner, 2026-10-05, at the
  external review of PR #138). `POST /api/training-load/sources/:source/connections` has no
  idempotency key, so after a lost answer a second Create can leave a duplicate connection that no
  screen can remove (no Disconnect / Delete). The recommended fix is a `requestKey` with an
  idempotent POST Create (the same key replays the saved answer), **not** a unique rule "one
  connection per club" — a club may later legitimately hold several source accounts or servers.
  Until then the UI names the risk in the acknowledgement, and the owner pilot stops on a lost
  Create (`docs/runbooks/gpexe-owner-pilot-f3c3.md`, step 2).

- **The bounded `pool.connect()`** (owner's external review of PR #136, 2026-10-04; note 3 of the closing
  review of PR #137): **done**, PR #146 merged and deployed (see the active phase).
- **Bound the COMMIT of `recordCandidate`** (code review of PR #149, 2026-10-09; pre-existing): a check's
  candidate transaction sends COMMIT without a bound or an outcome check, so a lost COMMIT answer marks the
  check `failed` / `internal_error` although the candidate (and, since PR #149, a superseded snapshot's
  projection) may be committed. No duplicate can follow (the unique key and the idempotent projection), but
  "written" and "unknown" are not told apart. Fix in the `approveCandidate` style: on a COMMIT error look
  the row up on another connection and continue, or fail with an `outcome_unknown`-class code.
- **Security follow-up, accepted by the owner (2026-10-07, at the review of PR #146): the verification
  resend's timing channel.** `POST /api/auth/email-verifications/resend` has no timing floor and, when a
  pending application exists, answers only after its transaction and the awaited email provider call,
  while an unknown email answers at once - a timing difference that predates PR #146 and does not depend
  on the pool. Not fixed; a separate task. See the runbook section "Database pool checkout bound".
- **Standing rule for raw database writers (note 1 of the closing review of PR #137, 2026-10-04):**
  a raw write to `training_load.gpexe_import_checks` (and to the source-connection tables) uses the
  agreed `READ COMMITTED` isolation and follows the runbook; the v31 legacy-path guard reads with the
  writer's snapshot, so a writer in `REPEATABLE READ` / `SERIALIZABLE` whose snapshot predates a bind's
  COMMIT is outside its guarantee. The application pins `READ COMMITTED`.
- **F3c4 (note 2 of the closing review of PR #137):** the migration that retires the environment
  path drops the `DEFAULT 'legacy_env'` of `gpexe_import_checks.source_path`, makes the database
  refuse every new legacy row, and leaves the historical legacy rows untouched — part of PR B.

- **Mandatory before the F3c2 routes or any import: fix the drills filter of the `rest_v1`
  adapter's `listSessions()`** (owner, 2026-10-01, after the review of PR #132). **Done in the
  F3c2c adapter PR (#133, merged `379d2fa`): the classification refuses an ambiguous page instead
  of thinning it, the date window reads one day back for a drill's parent, and a session is read
  only when a list classified it as a parent; see the F3c2c paragraph above.** As built in F3c2a, like the `e03` importer, `backend/src/gpexeRestV1Adapter.js` left out
  every session whose id another session named in its `drills`. On `rest_v1` a `drills` entry is not a `team_session` id, or at
  least that path answers a different session (first drill-only run, 2026-10-01), so that filter
  may leave out real sessions and may keep drill rows as sessions (duplicate data in an import);
  the fix must cover both directions. A separate, small PR,
  not part of PR #132; the rule for telling a drill row from a session on `rest_v1` must come from
  an observed answer, not from the `e03` model.

- **Roster scalability check with 60 athletes** (owner, 2026-09-26, after PR #124's browser
  QA): the 25-athlete roster used in QA was only a test scenario, not a product limit. The
  roster must support every athlete of a team; check the roster with 60 athletes (layout,
  filters, reading speed) as a future scalability test. Not a merge blocker for 5a3a.

- **In-app GPEXE import — conditions before the switch is turned on** (owner, 2026-09-18).
  F1, F2, F3a and F3b are merged (see above); F4 is the first real local import. `GPEXE_IMPORT_APPLY_ENABLED` stays off in an
  environment until conditions 1–3 and 6 hold there; condition 4 is required before regular
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
  6. **Mandatory before the import switch is turned on in any environment** (owner, 2026-10-09, at the
     review of option (c)): a later successful check must withdraw or supersede the earlier unapproved
     candidates of the same team and period that it no longer confirms as parent sessions. Today a
     candidate stays pending when a later check of the same window does not list it (for example a drill
     row recorded as a session of its own by a check whose list missed its parent), and approving it
     would import a drill's values a second time. Not built in option (c); a separate PR with its own
     tests.
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

- **Backups can outlive the 14-day identity snapshot** (identity implementation, 2026-10-06). The v32
  rows are deleted from the live database after 14 days or on an Unbind or archive, but a database
  backup taken meanwhile keeps them for the backup's own retention. Owner decision (2026-10-07): the
  live table keeps its strict 14 days and a backup may follow its own policy, but the runbook requires
  the purge before a restored copy is put to use; plaintext columns are accepted inside the existing
  database trust boundary.

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

PR A (F3c3), PR #139, PR #140, the whole-session projection (PR #141), the identity probe (PR #143),
the identity implementation (PR #144, v32), the id masking (PR #145), the hardening (PR #146) and the
window diagnostic (PR #147) and the whole-list window (PR #148) are merged and deployed; PR #142 is closed as superseded. Next steps, in order:
1. The owner's external review of the drill projection, branch `fix/gpexe-drill-details-projection`.
2. After its merge and deploy, on a separate owner order, one check of the same window (05.10 - 06.10.2026);
   the 05.10 session is expected as "changed" (the projection, not GPEXE data - see the active phase); its
   older candidate's snapshot is projected by the retention run that starts the check, and again when it
   is superseded.
3. Condition 6 under the switch conditions (withdraw candidates a later check no longer confirms) - a
   separate PR, before the switch is ever turned on.
4. The owner states the state of the production-use gate and of the two gates before a link (an identity
   load and one link were run after PR #146; whether those gates were confirmed is not recorded here).
5. The separate resend timing task (see Separate tasks), when the owner schedules it.
6. PR B, the F3c4 cut-over (see the active step).
7. The second owner-run procedure for one controlled real import.
8. **Phase 5a3c** (Complete and Needs review).

Conditions 1–3 and 6 under Separate tasks come before the first real local import (and before the
switch is turned on in any environment), and conditions 4–5 before regular production imports.

The other Separate tasks wait until the owner schedules them.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Separate tasks"/"Most likely next step" from the
actual current state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
