# Current state

Last reviewed: 2026-10-19, for the **Exercise media (R2)** track only — last `origin/main` commit checked:
`7806450` (merge of PR #194). The Training Load / GPEXE / metrics sections below were last reviewed on
2026-10-15 at `60aadb9` (merge of PR #163, M3-0, the canonical-variable admin API and migration v36;
PR #162 `9e4dfb5`, the GPEXE check timing line, before it) and were not re-derived in this update; the
Exercise Library work of 2026-10-17/18 (blocks, the cover slideshow, bulk move, user grants) is not
recorded here yet. The entries for PR #214 and #215 (the GPEXE check) were added on 2026-10-24 at
`306abd7` (merge of PR #215); nothing else in the Training Load / GPEXE / metrics record was re-derived then.
The Metrics Core entries (M2b PR #164, C98 PR #219, the plan PR #221, M3a PR #218) were brought up to date on
2026-10-26 at `6c7dfa4` (merge of PR #218), as phase 3 of `docs/ai/metrics-core-plan.md`; nothing else was
re-derived then. The phase 2b (R2) entries were added on 2026-10-27 at `e8e2b0a` (merge of PR #224), by the R2
implementation pull request, and brought up to date the same day at `e556d08` (merge of PR #227, that pull request)
after its merge, its deploy and the owner's read-only post-check; nothing else was re-derived then.

## Active phase

**Exercise media on Cloudflare R2 (the Exercise Library and the Builder) — merged, deployed and piloted
(2026-10-19).** A coach with a storage quota uploads a video or a picture of an exercise straight to R2
through a presigned PUT, the server verifies and binds it on Save, and every screen plays it through
short-lived signed addresses. The track, all on `main` and deployed on `OptiMove-eu`: BE-1 the storage
foundation (PR #184), FE-1 the player and the thumbnail resolver (PR #185), FE-2 the upload UI and
transport behind two build-time guards (PR #186), BE-2 the upload lifecycle (PR #187), a fix for missing
exercise images in the Builder and plans (PR #188), BE-3 the binding and the private playback contexts
`exercise` / `plan_item` / `upload` (PR #189), the Settings → Storage
administration of quotas (PR #190), the automatic thumbnail and the frame picker (PR #191), the quota
gate — a 0 B account sees today's editor byte for byte (PR #193), the activation that sets both guards
on with the quota as the only gate (PR #192, merge `66862a7`), and the pilot's one fix, the per-context
access cache forgotten after a confirmed Save (PR #194, merge `7806450`). The runbook is
`docs/runbooks/exercise-media-r2-activation.md`: what is live, the switches, the phases A–E with the
owner's approvals, the phase C, negative and H.264 + AAC-LC results, the E-2 activation and **the E-2 pilot
result**. The backend contracts are `docs/backend/r2-upload-api-v1.md` and the BE-3 binding contract.

Where it stands after the pilot (owner-run orders, main session in the pilot account's browser):
- E1 partial (the 0 B coach's editor not opened — another coach account), E2, E3 PASS; E4 library and
  Builder PASS, **the athlete-side playback NOT TESTED** (no athlete on the pilot account, no test athlete by
  the owner's decision; the stated blocker for the wider activation); E5 STOP on `66862a7` (the library card
  kept the previous thumbnail until a reload) → fix PR #194 → E5 PASS on `7806450`; E6, E7, E8 PASS; E9
  PASS (the 20:01 UTC cron run printed `{"cleaned":0,"failed":0}` — both cancels had completed
  synchronously, so nothing was left to sweep; the account read the same before and after: used 839,481 B,
  reserved 0).
- The owner waived the runbook's STOP lever (1) for the E5 stop (display only, the pilot quota stayed 1 GB).
- Every coach stays at the default 0 B and sees nothing new; the pilot accounts (two user accounts with
  1 GB) have the complete flow. The wider activation is a quota decision on a separate owner order, with the
  rollback levers of the runbook (the limit back to 0 per account; `MEDIA_STORAGE_ENABLED=false` at
  runtime; a PR setting both defaults back).
- Open before the wider activation: the athlete-side playback check, the 0 B editor check, the product
  decision that a Builder item keeps the media snapshot of the moment the exercise was added (BE-3, by
  design today), the reference-aware GC (a replaced or removed asset stays charged; a cancelled upload is
  released at once), the quota policy, and the optional bucket CORS additions (`HEAD`, `Content-Range`,
  `Accept-Ranges`). Known limits: no 202 "verifying" window has occurred in production, so the cancel
  during the verification poll is unexercised there; the hourly cleanup cron stays at 60 minutes.
- Test data left on the pilot account for the owner to delete: the exercises
  `cb99c1d2-f902-4a17-8a20-3d9becf9ddcd` and `8cac8fca-7cd4-4fb9-8514-30ff2d7d18fe` and the unassigned
  draft "R2 pilot test program" `430ea51d-e39a-4743-aafa-0fe23f929895`.

The Training Load / GPEXE record follows as last reviewed on 2026-10-15.

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
  superseded one by each retention run (every check, the server's 6-hour schedule, the CLI), each under
  its row lock - so the pending 05.10 candidate is projected by the first retention
  run after the deploy, whether or not the next check succeeds. The retention projection step is bounded
  in time (owner's external reviews of `5bd4ee0` and `8a7cee0` and the narrow reviews after them): every
  row its own short transaction (one snapshot read with `FOR UPDATE SKIP LOCKED`, at most one row lock
  held) and every id page its own short read-only transaction, each with `SET LOCAL statement_timeout`
  2 s, `lock_timeout` 1 s and `idle_in_transaction_session_timeout` 5 s; ids from a cursor kept across
  runs; the 10 s budget checked only before a new page or row starts (a spent budget is a clean stop
  that records no error), a started operation under its own bounds (4 s for its statements, COMMIT 5 s,
  ROLLBACK 2 s, the connection closed on no answer) reporting its real outcome; a failed row is not
  retried in the same run, the cursor moves past it and the run goes on, at most 3 failed rows per run,
  the failed row eligible again in a later run with its retention dates untouched - at most about 19 s
  per run; failures carry a stable code only and keep the purge count and an earlier step's error. The only copy is
  `gpexe_import_candidates.raw_bundle`, no route returns it, the preview holds only the mapper's values, a
  superseded candidate cannot be approved, and an imported candidate is never touched (none exists on the
  deployed database); the row's identity, content hash and preview hash stay - `bundle_hash` is the
  permanent fingerprint of the answer as it was read, no longer equal to the hash of a later projected
  `raw_bundle`, and nothing compares the two. A database backup keeps what
  it held for its own retention; a restored copy runs the retention before use. The legacy e03 path does
  not project on read (covered by the retention run; F3c4 retires it). The full validator
  `validatePlayersAnswer` (and its whole-answer description) is removed: no read path called it after both
  projections, and a test refuses its return.

- **PR #149 is merged and deployed.**
  - Reviewed head `44d7130` (the owner's external review READY WITH FINAL NARROW RE-REVIEW; the narrow
    database re-review READY, the code re-review READY WITH NON-BLOCKING NOTES, no code change asked), merge
    commit `b618ae9` on 2026-10-09 at 20:32:08 UTC, merged exactly from that head (`--match-head-commit`).
  - `/api/health` first served `b618ae9` with `ok: true` at 20:33:06 UTC, then three times in a row
    (20:33:16, 20:33:26 and 20:33:36 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE and source-connection routes
    answered 401. No migration; the switch untouched.
- **The check of 05.10.2026 - 06.10.2026 after PR #149 (2026-10-10, run once on the owner's order):** the
  preconditions held (`b618ae9` served; the connection *Verified* on server3; one active binding of the team
  to GPEXE Team ID 980; the import switch off). The check ended `failed` with **`drill_set_incomplete`**
  after about 4 min 18 s, having recorded one session of the window as unchanged before it. The stored
  message carried no reason: the code then kept a drill's reason only for a metric-shape refusal, so the
  failed position, the counts and the reason were lost before the check row was written. **No conclusion
  about the cause.** The owner's own view of GPEXE for the window (no value recorded) shows three parent
  sessions, one of which has drills.
- **A drill-set diagnostic** (owner order 2026-10-10; branch `fix/gpexe-drill-set-diagnostic` from
  `b618ae9`; not merged; backend adapter, resolver, check service, tests and docs; no change to acceptance,
  requests, timeouts, the projection, the list, the mapper, Link, Import or the switch, and no retry): every
  incomplete drill set now keeps its reason for an administrator - the adapter gives each failed drill a
  closed reason (`drillFailureReason()`, from the error's code and fixed facts only), the drills read before
  it and, for a consumed field's shape, the field's short name and the kind of its value; the resolver writes
  one line of a closed grammar after " Diagnostic: " (`op=drill_set; session_position=N; expected=N;
  completed=N; failed_index=N; code=<closed reason>`, plus `consumed_field` / `value_kind` for a shape
  refusal; an unknown reason is `drill_unknown`); `session_position` is the session's 1-based place in the
  check's own list of the window, never an id; a final guard (`drillDiagnosticAccepted()`) drops the line,
  never the refusal, if anything else would come out; a coach sees the sentence only. The runbook lists the
  reasons.
- **PR #150 is merged and deployed.**
  - Reviewed head `d2e4824` (the owner's external review READY), merge commit `ce759b6` on 2026-10-10 at
    21:20:07 UTC, merged exactly from that head (`--match-head-commit`).
  - `/api/health` first served `ce759b6` with `ok: true` at 21:21:10 UTC, then three times in a row (21:21:20,
    21:21:31 and 21:21:41 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE and source-connection routes
    answered 401. No migration; the switch untouched.
- **The check of 05.10.2026 - 06.10.2026 after PR #150 (2026-10-10, run once on the owner's order):** the
  preconditions held (`ce759b6` served; the connection *Verified* on server3; one active binding to GPEXE Team
  ID 980; the switch off). It ended `drill_set_incomplete` with the administrator's line `op=drill_set;
  session_position=2; expected=5; completed=0; failed_index=0; code=drills_count_disagrees.` - the first drill
  answer of the second session in the check's list gave a drill count that is not exactly the confirmed 5
  (absent and null are accepted, so it was another value). What it gave is not recorded by that code. **No
  conclusion about the cause.**
- **A drill-count diagnostic** (owner order 2026-10-10; branch `fix/gpexe-drill-count-diagnostic` from
  `5be4ae9`; not merged; backend adapter, resolver, tests and docs; the acceptance rule, requests, retry, the
  list, the mapper, the projection, Link, Import and the switch unchanged): for `code=drills_count_disagrees`
  the administrator's line also carries `answer_count_kind` (closed set), `answer_count_canonical`,
  `answer_count_matches_expected` and `answer_count=N` only for a canonical whole number 0 - 30
  (`describeAnswerCount()` in the adapter, rebuilt from closed words and a bounded integer in the resolver,
  the final guard extended); a coach sees the sentence only. (Its answer-count part was removed again by the
  next fix, see below; the evidence it produced stays recorded.)
- **PR #151 is merged and deployed.**
  - Reviewed head `e4aa26e` (the owner's external review READY), merge commit `d6fd559` on 2026-10-10 at
    22:27:39 UTC, merged exactly from that head (`--match-head-commit`).
  - `/api/health` first served `d6fd559` with `ok: true` at 22:28:42 UTC, then three times in a row (22:28:52,
    22:29:03 and 22:29:13 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE and source-connection routes
    answered 401. No migration; the switch untouched.
- **The check of 05.10.2026 - 06.10.2026 after PR #151 (2026-10-10, run once on the owner's order):** the
  preconditions held. It ended `drill_set_incomplete` with `op=drill_set; session_position=2; expected=5;
  completed=0; failed_index=0; code=drills_count_disagrees; answer_count_kind=number;
  answer_count_canonical=true; answer_count_matches_expected=false; answer_count=0.` - the drill answer's own
  `drills_count` field is 0 for a parent confirmed with 5 drills: it is not the parent's drill count. **Owner
  decision (2026-10-10):** a drill answer's `drills_count` is no longer used for acceptance or identity; the
  only drill count is the confirmed parent's.
- **A drill answer's drills_count ignored** (owner order 2026-10-10; branch
  `fix/gpexe-drill-response-count-ignored` from `d6fd559`; not merged; backend adapter, resolver, tests and
  docs): the drill reads no longer compare a drill answer's `drills_count` with the parent's, never return it,
  and the stored snapshot keeps a drill's players only; the loop stays bounded by the confirmed parent count
  (0 - 30), each index read once in order, the first real failure still ends the set (`complete: false`, the
  failed index, a closed reason; no skip, no retry, no partial candidate); `drills_count_disagrees` left the
  drill reasons and the answer-count diagnostic of PR #151 is removed; the whole-session comparison, the list,
  the parent confirmation, the drill URL, zero-based indexes, the mapper, Link, Import and the switch are
  unchanged. Existing pending snapshots lose a drill's stored `drills_count` at the next retention run (the
  mapper never read it).
- **PR #152 is merged and deployed.**
  - Reviewed head `be7d212` (the owner's external review READY), merge commit `c3d31d4` on 2026-10-10 at
    23:15:23 UTC, merged exactly from that head (`--match-head-commit`).
  - `/api/health` first served `c3d31d4` with `ok: true` at 23:16:26 UTC, then three times in a row (23:16:36,
    23:16:46 and 23:16:57 UTC).
  - Read-only smoke without a login, zero UUID, GET only: nine protected GPEXE and source-connection routes
    answered 401. No migration; the switch untouched.
  - **Owner (2026-10-10, recorded at the merge):** the effect of the zero-based `?drill=<index>` parameter on
    server3 is not independently confirmed; a successful answer for indexes 0 - 4 does not by itself prove
    that the source did not return the same drill more than once. Before the import is switched on, a
    fail-closed proof / guard against a non-distinguishing parameter is required, without relying on a drill
    answer's `drills_count` (switch condition 7 below).
- **The check of 05.10.2026 - 06.10.2026 after PR #152 (run once on the owner's order, about 2026-10-11 00:12
  UTC):** the preconditions held. It **succeeded**: sessions 3, new 1, changed 0, unchanged 2; the session with
  five drills was read in full. Nothing was linked, approved or imported; the import switch stays off.
- **The pre-import safety package (switch conditions 6 and 7)** (owner order 2026-10-11; branch
  `fix/gpexe-pre-import-safety` from `c3d31d4`; **merged and deployed as PR #153, see below**; migration v33,
  backend, tests and docs; runbook section "When a check's results become actionable (v33)"):
  - **Condition 6 and the publication of a check.** While a check runs it writes no candidate row: its
    observations are staged per check and session in `training_load.gpexe_import_check_observations`
    (insert-only, running check of the same team only, read by no route), so the published candidates stay
    byte for byte as the last successful check left them (owner's external review of `ab58e5e`, HIGH: a
    running, failed or unknown check must never change the actionable state of a candidate confirmed by an
    earlier successful check). A candidate is actionable only when its `last_seen_check_id` is a `succeeded`
    check of its team - in `approveCandidate` (409 `candidate_not_actionable`), the list, the batch and the
    database (the v33 approval trigger) - and `last_seen_check_id` is written only by the finalization, in
    the COMMIT that marks that check succeeded, so it always names the last successfully finalized check.
    One finalization transaction applies the staging (refreshes same content, restores a superseded row
    seen again, inserts new content), supersedes older content by candidate, withdraws (binding path only)
    every pending / blocked candidate of the team whose session day lies in the exact `[from, to]` and whose
    last sighting `IS DISTINCT FROM` the check (`superseded_by_check_id`), projects what it superseded,
    deletes the staging, marks the check succeeded and sends one bounded COMMIT; busy / failed / unknown
    publishes nothing, changes nothing, supersedes nothing and never repeats a sent COMMIT (verified on a
    new connection); the staging of a check that did not succeed is discarded by the run and by the
    retention sweep. Exactly one `superseded_by` on a superseded row
    (`gpexe_import_candidates_superseded_by_exactly_one`); a finished check's status and `finished_at` are
    final in the database (`gpexe_import_checks_status_final`); the finalization re-validates the run's
    binding facts under the team lock and is bounded (statement, idle-in-transaction and client-side
    bounds). The rollback refuses while a row is superseded by a check or a check is running; after it
    conditions 6 and 7 are open again.
  - **Condition 7 (the drill-parameter guard).** The adapter fingerprints each non-empty drill answer's full
    players map in memory (canonical SHA-256, dropped at once); two equal non-empty answers fail the check as
    `drill_parameter_effect_not_distinguishable` (no candidate; administrator-only code); fewer than two
    non-empty answers store `not_observed`, never actionable; only `not_required` / `confirmed` /
    `not_observed` is stored (`drill_parameter_effect`), never a fingerprint or a value. Same rule for the
    legacy bundle.
  - Frontend unchanged in PR #153: the new refusal `candidate_not_actionable` and the list blocker
    `not_confirmed_for_import` read as the existing generic sentences ("It can't be approved right now.",
    "the server refused it") until the frontend support below (branch `fix/gpexe-imports-v33-frontend`).
  - Candidates from before v33 carry no drill effect and are not actionable until a successful check sees
    them again.
- **PR #153 is merged and deployed.**
  - The owner's external review of head `ab58e5e` found a HIGH (a running, failed or outcome-unknown check
    must never change the actionable state of a candidate confirmed by an earlier successful check); fixed in
    head `8a223fd` by the per-check staging (above). Reviewed head `8a223fd` READY; merge commit
    `884945c` (parents `c3d31d4` and `8a223fd`) on 2026-10-11 at 09:50:54 UTC,
    merged exactly from that head (`--match-head-commit`).
  - `/api/health` first served `884945c` with `ok: true` at 09:51:46 UTC, then three times in a row (09:52:03,
    09:52:13 and 09:52:24 UTC). **v33 on the deployed database is inferred** from the server starting after the
    migration step (`npm start` runs `node src/migrate.js &&` the server); no direct SQL post-check.
  - Read-only smoke without a login, zero UUID, GET only: the team status, one check, the candidates, one
    candidate, the source athletes, the athlete links, the athlete identities, the source-connection list and
    one connection answered 401. No Check, Connect, Bind, Load identities, Link, Unlink, Approve or Import at
    the deploy; Render and the switch untouched.
- **The first production check on v33 (2026-10-11, run once on the owner's order, First team,
  05.10.2026 - 06.10.2026):** the preconditions held (health `884945c` ok; the server3 connection *Verified*;
  First team actively bound to GPEXE Team ID 980; the switch off; no running check). It **succeeded** at
  10:05:14 UTC: `3 sessions in GPEXE: 0 not seen by OptiMove before, 0 changed, 3 unchanged`. **Recorded by
  the owner as: the v33 staging / finalization and the drill-parameter guard confirmed on production** - the
  check ran end to end through the v33 path on the real server and succeeded, and no session (the five-drill
  session included) failed as `drill_parameter_effect_not_distinguishable`. What this record does not hold:
  the deployed database was not queried, so the three candidates' stored drill effect and their actionable
  state after the check were not read, and the Imports screen after the check was not recorded (the deployed
  frontend of that moment showed the blocker only as a generic sentence); that the three sessions of the check
  of 2026-10-11 ~00:12 UTC were staged, re-sighted and republished is inferred from the code, not observed.
  Whether the five-drill session's drill effect is `confirmed` is therefore not known from this record;
  opening the Imports screen once the frontend support below is deployed shows the stored blocker (the list
  already carries it, no new check is needed), though the screen cannot tell `confirmed` from `not_required`
  (a *Ready to import* row means either). **No Link, Approve or Import was run; the switch stays off.**
- **Frontend support for v33** (owner order 2026-10-11; branch `fix/gpexe-imports-v33-frontend` from
  `884945c`; frontend and docs only, no backend or contract change; merged and deployed as PR #154, see
  below): a candidate the last
  successful search did not confirm (`approvalBlockers` `not_confirmed_for_import` - the server's one word,
  the same for a coach and an administrator) is never *Ready to import* and never "up to date": it is a
  *Needs attention* row with the badge *Not confirmed for import*, no checkbox and no *Approve import*; the
  row names the action alone for everyone ("Find new sessions again (with dates that include 06.10.2026),
  then review it."); the review's note gives the coach the one step ("Not confirmed for import yet. Find new
  sessions again (…), then review it.") and an administrator (the status's `identityAdmin`) the two possible
  causes in plain words ("no successful search has confirmed this session yet, or GPEXE returned drill data
  for fewer than two of its drills, so OptiMove could not confirm its drill results", then the action and
  "If it stays like this, check in GPEXE that the session's drills are set up and have data.") - neither a
  code, a proof or a fingerprint; the refusal `candidate_not_actionable` (single and batch) reads as one
  sentence; a
  candidate withdrawn by a check (`supersededByCheckId`, no newer candidate) is a *No longer found* version
  under "Replaced or no longer found versions" (hidden by default, never counted by the calendar) that says
  the last successful search no longer found it in GPEXE, with no approval and never "newer data"; a
  replaced version stays as before (the toggle under Technical details is now "Show / Hide replaced or no
  longer found versions"). While the versions are folded away the server lists no superseded row at all
  (`listCandidates`, `includeSuperseded`), so a withdrawn session is seen only through that toggle; a trace of
  it in the default view would need a server-side count or an always-on read of the superseded rows - a
  contract decision, recorded under Separate tasks, not made here. Every "find new sessions again" sentence
  names the dates the session needs, and a not-confirmed session pre-fills the dates like an expired one, so
  the default 14-day search can never loop on it (the pre-filled dates pin the next search to those days until
  the coach changes them - the hint says so; the same trade-off as for an expired session); the
  administrator's second cause is the server's `not_observed` (data
  for fewer than two drills), never "drills not told apart" (two equal drills fail the whole search and never
  become a row). A search that fails changes nothing of what is shown (the server keeps the published rows;
  the screen re-reads them, GET only, and keeps the selection of rows that are still there); a search whose
  answer is lost re-reads nothing and shows the rows as they were. A label-less session is titled "GPEXE
  session" (no id). The approve handler never sends an approval for a not-confirmed or withdrawn review.
  Tests:
  `frontend/tests/gpexe-imports-v33.actions.test.mjs`. No production check, GPEXE request, Render change or
  switch change.
- **PR #154 is merged and deployed** — the frontend half of switch condition 6.
  - Merge commit `241765e` (head `2ff4b3b`, which also merged `origin/main` `46c4f82`, the Home / workspace
    navigation) on 2026-10-11 at 15:15 UTC, on the owner's order.
  - `/api/health` first served `241765e` with `ok: true` at 16:19:43 UTC (the deploy took longer than the
    earlier ones), then three times in a row after it; the served bundle carries the v33 texts (*Not
    confirmed for import*, *No longer found*); without a login nine protected GPEXE and source-connection
    routes answered 401. No migration; the switch untouched.
- **The owner's check after PR #154 (2026-10-11, run once on the owner's order, First team,
  05.10.2026 - 06.10.2026; sanitized, as reported by the owner):** it **succeeded** — sessions 3, new 0,
  changed 0, unchanged 3; every athlete recorded in those three sessions is linked; the Imports screen
  shows *Ready to import* 2 and *Needs attention* 1 (more than one track for one athlete — a GPEXE data
  matter, not a link problem); no row carries `not_confirmed_for_import`. `GPEXE_IMPORT_APPLY_ENABLED`
  stays off; nothing was approved or imported.
- **T1 — the test-infrastructure foundation — is merged and deployed as PR #155** (owner order
  2026-10-11; branch `feature/test-infrastructure-t1`; discovery `docs/ai/test-infrastructure-discovery.md`):
  `scripts/test-runner.mjs` runs every test file in its own process with a time limit and a clear verdict
  (kinds `unit`, `disposable`, `shared`, `schema-clone`; presets `backend-fast`, `frontend-fast`, `gpexe`,
  `pr`; `--file` / `--filter` / `--list`), refuses fail-closed any database that is not a disposable
  `optimove_tests_*` one on a loopback-only server (Unix socket, `127/8`, `::1`, an IPv4-mapped loopback),
  audits leftover databases, and keeps known failures by whole fingerprint (file, title, failure type,
  message pattern) in `backend/tests/support/test-manifest.json` — a secret-scan test can never be a known
  failure; two shared support patterns (`backend/tests/support/disposable-db.mjs`,
  `frontend/tests/support/fetch-mock.mjs`, `dom.mjs`); npm commands `test:runner`, `test:list`,
  `test:backend:fast`, `test:backend:db`, `test:backend:shared`, `test:frontend:fast`, `test:gpexe`,
  `test:pr`. No production behaviour change (no route, no migration). T2 (GitHub Actions, the
  legacy-schema bootstrap, a server sentinel) and T3 (Playwright) are recorded there, not started.
  - The owner's external review of `0a9d10f` was NOT READY (known failures identified by file and title
    only; the secret-scan test listed as a known failure; private address ranges accepted); fixed in
    `a61f399`, reviewed READY. Merge commit `af11338` (parents `241765e` and `a61f399`) on 2026-10-11 at
    19:49:17 UTC, merged exactly from that head (`--match-head-commit`).
  - `/api/health` served `af11338` with `ok: true` three times in a row (19:50:15, 19:50:25 and 19:50:35
    UTC); read-only smoke without a login: `GET /api/auth/me` answered 200 with no user and the GPEXE team
    status (zero UUID) answered 401. No test was run against production; no Check, Link, Approve or Import;
    Render, credentials and the switch untouched; the eight leftover `optimove_tests_gpexe_f3c2g_*`
    databases on the development workstation were left in place, as ordered.
- **GPEXE metric / variable mapping discovery (2026-10-11, accepted; PR #156; M1 merged as PR #159, the first M2 PR merged as PR #160, v35 merged as PR #161, M3-0 merged as PR #163, M2b merged as PR #164, the older catalog's guard C98 as PR #219, M3a as PR #218, see below).** The authoritative
  document is `docs/ai/gpexe-metric-variable-mapping-discovery.md` (rule:
  `.claude/rules/metrics-core-mapping.md`; ADR-007 records only the three decisions the code already
  proves — Metrics Core as the canonical registry, no automatic merge of several sources, no
  reinterpretation of a historical fact — while the mapping design stays accepted future design in the
  document). Its findings, verified against
  `af11338`: **Metrics Core (`training_load.metric_definitions`, `metric_definition_versions`, scope
  capabilities, domains, categories, structure links, occasions, values, provenance) is the existing
  canonical registry of OptiMove variables** — creatable and versionable through
  `backend/src/routes/trainingLoadMetrics.js`, read by the dashboards and the Activities drawer, with no
  write UI yet; what is missing is a source metric catalog, an explicit versioned source-to-canonical
  mapping, an activation per team binding and a fact-provenance layer. Today the mapping is the hard-coded
  `GPEXE_METRIC_SPECS` and the importer creates team-owned `gpexe_*` definitions under the GPEXE name; no
  such definition and no imported GPEXE fact exists on any persistent database (inferred: the switch has
  been off everywhere and no approval was ever run; no SQL post-check). **The owner accepted
  direction B and the final contract** (sections C and D of the document): Metrics Core stays the only
  registry, no parallel registry; a source never creates a canonical definition; several sources may fill
  one canonical variable without merging; source metric identity plus revisioned proven contracts (model
  A), mapping identity plus immutable versions, activation per team binding and exact version, a
  separate append-only fact-provenance table, a write-once source-instance identity on the Metrics Core
  connection, `unit_conversions` as the database-checkable gate, required / optional per activation,
  every unit / shape / threshold mismatch and a missing required value blocking the whole candidate,
  multiple tracks fail-closed until M5. The server3 units of time, distance and max speed and the meaning
  of burst / brake stay unproven; the seed records them as `observed` with no unit. The discovery was
  merged and deployed as **PR #156** (see "Implemented ≠ deployed").
- **The agent-efficiency rule (E1)** — `.claude/rules/agent-efficiency.md` plus its line in the
  `CLAUDE.md` rules index, merged and deployed as **PR #158** (docs / rules only): when a subagent is
  justified, review only on a frozen HEAD with the mandatory domains, delta re-reviews, at most one full
  round and one narrow re-review per domain, T1 test tiers, short reports. It removes no review trigger,
  external review or test, and an owner order wins.
- **M1 — the schema foundation of the source-to-canonical metric mapping** (owner order 2026-10-12;
  branch `feature/metrics-mapping-m1-schema` from `0293b39`; **merged and deployed as PR #159, see
  below; v34 directly confirmed on the production database**). Migration v34
  (`migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`) builds sections D1–D10
  and the D12 seed of the discovery document with the owner's M1 SQL decisions C40–C58 (2026-10-12):
  `source_host_catalog.api_family`; the source metric identities and their revisioned contracts (T2a,
  T2b); the mapping identities with a generated, never-NULL owner key (T3); `unit_conversions`; the
  immutable mapping versions with the database-computed parameter fingerprint and the per-owner active
  target (T4); the activations per team binding with their anchor `unique (id, team_id)` on
  `source_team_bindings` (T5); the append-only value provenance (T6, never through an ended activation);
  the write-once source instance on `metric_source_connections` (T7); the append-only audit with one
  shape per action (T8); the guards on `metric_definitions` (decision 9) and on removing a scope level
  under an active version; `42501` for a refused actor and `23514` with fixed messages for every other
  trigger refusal. The seed: nine `observed` gpexe / rest_v1 source fields with revision 1 and **no
  unit**, and the four unit conversions of D5 — no canonical definition, mapping, version, activation,
  provenance or audit row. Rollback `docs/runbooks/source-metric-mapping-v34-rollback.sql` (refuses on
  any business row, a changed seed, a source instance, a foreign key into M1, or a later migration;
  rehearsed: apply → rollback → identical v33 catalog → re-apply). The disposable undo script removes a
  value's provenance first (C47). Tests: `backend/tests/source-metric-mapping-m1.test.mjs` (disposable,
  T1 runner) with mutation evidence. **No route, service, frontend, importer, mapper, preview or writer
  change; the GPEXE importer still creates its team-owned `gpexe_*` definitions until M4 (temporary
  compatibility, C46); no GPEXE unit or meaning is confirmed.** The internal reviews (database,
  security, code) found no BLOCKER or HIGH; their corrections are in the same pull request, and the five
  points they raised for the owner are decided (C51–C55, 2026-10-12) and built in v34: a mapped canonical
  definition keeps its owner; an activation locks and re-checks its unit conversions; free text refuses a
  fixed list of invisible and bidi characters; scales are positive; a new T6 fact needs an active binding
  and Metrics Core connection of one chain, a value of the binding's team and a level the activation
  covers (the import switch is not read). At the owner's external review of the next head (2026-10-12)
  the C55 reading was confirmed (the Metrics Core connection `active`; the v27 credential connection in
  the chain, its *Verified* / *Needs reconnect* state no condition) and three more were decided: a
  canonical unit must be a unit token to be a mapping target (C56), the M4 writer's lock contract (C57,
  future), and an Unbind's bounded wait on a fact in flight (C58, documented and tested, Unbind code
  unchanged).
- **PR #159 is merged and deployed (M1, migration v34).**
  - The owner's external review of head `5ec30a4` was READY. Before the merge the owner ran a read-only
    production preflight in pgAdmin (2026-10-13): PostgreSQL 17.6 (`server_version_num` 170006); the
    `source_host_catalog` held exactly `gpexe/e03` and `gpexe/server3`; the last applied migration was
    v33 with every recorded checksum equal to the repository's; no running check, staged check row,
    running identity load, lock on a training table, advisory lock or idle transaction.
  - Merge commit `15efd7a` (parents `0293b39` and `5ec30a4`) on 2026-10-13 at 09:54:43 UTC, merged
    exactly from that head (`--match-head-commit`) on the owner's order.
  - `/api/health` first served `15efd7a` with `ok: true` at 09:55:36 UTC, then three times in a row
    (09:55:46, 09:55:57 and 09:56:07 UTC); without a login `GET /api/auth/me` answered 200 with
    `{"user":null}`, and the GPEXE team status, the candidates, the source-connection list and one
    connection (zero UUID, GET only) answered 401.
  - **The owner's read-only production post-check (pgAdmin, 2026-10-13) confirmed v34 directly:** the
    v34 record exactly once with the repository's checksum, v34 the last migration, nothing later,
    missing or changed; 8 tables, 25 triggers (all enabled), 32 functions, the three added columns, the
    binding anchor `unique (id, team_id)`, `api_family` `e03 = api` and `server3 = rest_v1`; the seed
    exactly (9 source fields, 9 revisions, 4 unit conversions) and no mapping, version, activation,
    provenance, audit row or source instance.
  - No Check, Link, Approve, Import or GPEXE request; Render and `GPEXE_IMPORT_APPLY_ENABLED` untouched.
- **M2, first PR — the administrator API of the mapping** (owner order 2026-10-13; branch
  `feature/metrics-mapping-m2-api` from `15efd7a`; **merged and deployed as PR #160, see below; no
  production mapping, version or audit row exists**). The HTTP contract the owner approved on 2026-10-13 is
  section J1 of the discovery document, with the decisions C59–C66: under
  `/api/training-load/sources/metrics` the reads of the source fields and revisions, the canonical
  targets of the workspace's owner scope, the active unit conversions and the mappings with their
  versions; `POST /mappings` (a T3 identity), `POST /mappings/:id/versions` (a T4 draft with every
  conversion, parameter and fingerprint value derived by the server) and `POST …/submit` (`draft →
  needs_review`). The owner comes from the active workspace only (platform: system; a club workspace:
  that club); the canonical target has the same owner scope (v34 / D4); every write takes a
  `requestKey` whose T8 row is the request record, a replay answers the current state; bounded
  transactions and COMMIT; only allowlisted database refusals become a 4xx. Not in it: T2b unit and
  meaning confirmation, activation, disabling, T5, conversion maintenance, the preview, the frontend,
  any importer change, any migration. Code: `backend/src/routes/sourceMetrics.js`,
  `backend/src/sourceMetricMappingService.js`; tests `backend/tests/source-metric-mapping-m2.test.mjs`.
  The internal reviews (code, database, security) answered READY WITH NON-BLOCKING NOTES; their
  corrections are in the same pull request. **The owner's external review of head `26a0748`
  (2026-10-13) was NOT READY** — a HIGH (the answer after an uncertain COMMIT did not check the right
  again) and three MEDIUM (unbounded reads, read caps that a growing list makes permanent, T2b facts used
  before their lock) and a LOW (the 42501 allowlist by prefix); all five are fixed in the same pull
  request as decisions C67–C72 of the discovery document (the `POST /mappings` summary approved; keyset
  pages with an opaque cursor for the mappings and a mapping's versions, no write quota; the right
  checked again before any answer after a COMMIT; every read bounded; the facts compared again under
  lock; the exact 42501 texts). **Decided as a gate (C73):** a database actor check on the T3 / T4
  inserts and the T8 request records is a mandatory, separate hardening PR (v35) before any T5
  activation and before the API's real administrative use.
- **PR #160 is merged and deployed (M2, first part).**
  - The owner's external re-review of head `fd8af5e` was READY WITH NON-BLOCKING NOTES; the owner
    accepted the summary answer of `POST /mappings`, the C68 pages, the bounded reads, the right checked
    again after both the directly confirmed and the verified COMMIT (to be kept), the `summarize` note and
    the app-wide note on the session and workspace reads.
  - Merge commit `1164041` (parents `15efd7a` and `fd8af5e`) on 2026-10-13 at 13:25:07 UTC, merged
    exactly from that head (`--match-head-commit`) on the owner's order; no migration in it.
  - `/api/health` first served `1164041` with `ok: true` at 13:26:15 UTC, then three times in a row
    (13:26:25, 13:26:36 and 13:26:46 UTC). Unauthenticated GET smoke: `/api/auth/me` 200 with
    `{"user":null}`; `/fields`, `/targets`, `/conversions` and `/mappings` of the M2 API 401.
  - No authenticated M2 request, no mapping, version or audit row, no GPEXE action; Render and
    `GPEXE_IMPORT_APPLY_ENABLED` untouched.
- **v35 — the database actor guards of the mapping writes** (owner order and decisions 2026-10-13;
  branch `feature/metrics-mapping-v35-actor-guards` from `1164041`; **merged and deployed as PR #161,
  see below; confirmed on production by the owner's read-only post-check**). Contract: decisions
  C74–C79 and section J2 of the discovery document. Migration v35
  (`migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql`) adds functions,
  triggers and two partial indexes for the guards' audit lookups (no table, column or data):
  - the M2 service sets, before the first protected write of each write transaction, the
    transaction-local `optimove.source_metric_actor` = `<user uuid>:<id of the transaction>` from the
    authenticated session; a replay and a GET set none; missing, empty, not canonical or of another
    transaction (a session-level SET) is `42501`;
  - a mapping (T3), a version (T4) and its `submitted_by` / `activated_by` / `disabled_by` transitions,
    and an audit row (T8) must name that user, an owner scope the user may write (an active platform
    admin; for a club mapping also the active admin of that active club) and the basis the database
    derives (`42501`); an audit row must follow its own operation in the same transaction, once
    (`23514`); at COMMIT, deferred constraint triggers refuse a mapping, a version or a status transition
    without its audit row and roll the whole transaction back (`23514`); a write inside a savepoint is
    refused (fail closed); fixed messages only;
  - through M2 a v35 guard is a sanitized `500 internal_error`; a COMMIT is a definite failure only when
    PostgreSQL itself refused it with an ordinary ERROR, every other COMMIT error is verified by the
    request key (never taken for "nothing written"); the expected loss of a right stays M2's `404`; a club
    admin granted the platform admin role mid-request answers `409 try_again` when the grant lands before
    the request's rights check (after it: a sanitized `500`, nothing written); no HTTP contract change.
  - **Limit, stated by the owner:** this keeps an accidental or unintended write that bypasses M2 out;
    the guards prove that row, actor and right agree, not that the code which set the actor was entitled
    to. It is no defence against whoever controls the database credentials the application and the
    migrations share, nor against code that runs SQL through the application's pool (both can set the
    setting or disable a trigger) - separate migration and runtime roles are a later infrastructure task
    (Separate tasks). Read-only production preflight: `docs/runbooks/source-metric-mapping-v35-preflight.sql`.
  - Rollback `docs/runbooks/source-metric-mapping-v35-rollback.sql` (refuses without v35, under a later
    migration, or with a v35 trigger or index missing or a trigger disabled), rehearsed: apply -> rollback -> identical v34
    catalog -> re-apply. Tests: `backend/tests/source-metric-mapping-v35.test.mjs` (disposable, T1
    runner) with mutation evidence; the M2 suite runs unchanged under v35 (its one raw mapping fixture
    now carries the actor and the audit rows).
- **PR #161 is merged and deployed (v35).**
  - The owner's external review of head `9473aaa` was READY WITH NON-BLOCKING NOTE (a later test-hardening
    task, see Separate tasks; the head unchanged for it). Before the merge the owner ran the read-only
    preflight `docs/runbooks/source-metric-mapping-v35-preflight.sql` in the Supabase SQL Editor: all eight
    blocks as expected (PostgreSQL `170006`; v34 the last migration with its checksum, v35 absent; no v35
    object; T3 / T4 / T8 empty; the eight v34 triggers enabled; the role `postgres` owns the three tables
    and may create in the schema; no actor default; a quiet moment).
  - Merge commit `ed13f8a` (parents `1164041` and `9473aaa`) on 2026-10-14 at 07:16:19 UTC, merged
    exactly from that head (`--match-head-commit`) on the owner's order.
  - `/api/health` served the old `1164041` until 07:16:43 UTC and first served `ed13f8a` with
    `ok: true` at 07:17:15 UTC, then three times in a row (07:17:25, 07:17:35 and 07:17:45 UTC).
    Unauthenticated GET smoke: `/api/auth/me` 200 with `{"user":null}`; `/fields`, `/targets`,
    `/conversions` and `/mappings` of the M2 API 401.
  - **The owner's read-only production post-check** (`docs/runbooks/source-metric-mapping-v35-postcheck.sql`,
    Supabase SQL Editor, 2026-10-14) passed all eight blocks: v35 recorded once with its checksum and the
    last migration; the eight functions; the six triggers enabled, three of them deferred; both indexes
    valid; the eight v34 triggers enabled (14 in all); T3 / T4 / T8 still empty; no actor default and no
    session actor; no lock, M2 session or idle transaction. **v35 is closed.**
  - No authenticated M2 request, no mapping, version or audit row, no GPEXE action; Render and
    `GPEXE_IMPORT_APPLY_ENABLED` untouched.
- **M3-0 — the canonical-variable admin API and its request record v36** (owner order and decisions
  2026-10-14, after the M3a discovery; branch `feature/metrics-variables-admin-api-m3-0` from `ed13f8a`;
  **merged and deployed as PR #163, see below; v36 directly confirmed on production by the owner's
  read-only post-check**). Contract: decisions C80–C88 and section J3 of the discovery document.
  - **Navigation decided for the later M3 frontend (C80):** Training Load → **Data configuration** →
    **Variables & mappings** (tabs Variables, Source fields, Mappings), only for an active platform admin
    (platform or club workspace) and the active club admin in its own club; never coaches or athletes;
    the analyses' and dashboards' metric pickers unchanged. M3-0 has no frontend.
  - Routes under `/api/training-load/sources/metrics`: `GET /variables` (the workspace's own, or in a club
    workspace the system reference; `state=active|archived|all`; pages of 100), `GET
    /variables/key-suggestion`, `GET /variables/:id` (with its versions), `POST /variables` (definition,
    version 1 and levels in one transaction) and `POST /variables/:id/versions` (a new immutable version;
    `expectedCurrentVersionId` a precondition). The owner always from the active workspace; the body never
    names an owner, an actor or a basis; numeric only; a unit token; levels `session` / `drill`; a zone or
    event-threshold condition in closed shapes; exact decimals; the key suggested from the name by a
    deterministic rule (`400 key_required` when none can be made); `409 key_taken`,
    `current_version_changed`, `variable_not_active`, `variable_pinned`, `version_unchanged`.
  - **Migration v36** (`migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql`): the
    durable request record `training_load.metric_variable_requests` (one row per admin write, in its own
    transaction; replay, `request_key_reused` and the lost-COMMIT check read it), its BEFORE INSERT guard
    (the v35 actor setting and basis, the same-transaction proof) and append-only triggers; rollback
    `docs/runbooks/metric-variable-requests-v36-rollback.sql` (refuses with a request row or a later
    migration), rehearsed; read-only production preflight `docs/runbooks/metric-variable-requests-v36-preflight.sql`.
    **Limit, stated (C82):** the older `/api/training-load/metrics` API and the GPEXE team-owned writer keep
    writing definitions without a request row or an actor; the strict contract is the new API's.
  - **B3:** the M2 reads now carry the canonical target's bounded `key` and `label` and the source field's
    `label`.
  - **Numbering:** M2b (the T2b confirmations and their actor guards) is **v37** and comes before the M3
    write UI of draft mappings.
  - Tests: `backend/tests/metric-variables-m3-0.test.mjs` (disposable, T1 runner) with mutation evidence;
    the M2 suite updated for B3.
- **PR #163 is merged and deployed (M3-0, migration v36).**
  - The owner's external review of head `f533dc3` was READY WITH NON-BLOCKING NOTES. The owner then decided:
    no deferred completeness trigger in v36 (the point-in-time guard, the request row as the last write and
    the targeted tests accepted; the limit of C82 stays documented); no indexes on every foreign-key column;
    the flaky resolver test and the fuller protection of free text through `source_metric_text_ok` stay
    follow-ups; no general rule against `value in object` (the regression test is enough).
  - On the owner's order before the merge, `origin/main` `9e4dfb5` (PR #162) was integrated by a plain
    merge commit `a9a6d5e` (parents `f533dc3`, `9e4dfb5`; one documentation conflict, both sides kept).
    The PR's code diff was byte-identical before and after. The narrow code / database / security
    re-review of the integration delta found nothing in it.
  - `test:backend:shared` was run once against the local OPTIMOVE database on the owner's explicit approval,
    after an identity check from an open connection (loopback `::1:5432`, database `OPTIMOVE`).
    - 44 files: 41 pass, one manifest known failure, two environment failures (see Separate tasks).
    - A read-only before / after snapshot showed one pre-existing `user_club_roles` row re-touched by the
      legacy backfill that `migration-backfill.test.mjs` runs over the whole database, and
      `athlete_generated_id_seq` moved from 26163 to 26180.
    - Nothing was cleaned up (owner's order; the local row is left as it is).
  - The owner's read-only production preflight (`docs/runbooks/metric-variable-requests-v36-preflight.sql`,
    Supabase SQL Editor, 2026-10-14) passed all nine blocks: PostgreSQL `170006`; v35 the last migration
    with its checksum; T3 / T4 / T8 empty; the two constraint names the service maps present.
  - Merge commit `60aadb9` (parents `9e4dfb5` and `a9a6d5e`) on 2026-10-14 at 15:01:41 UTC, merged
    exactly from head `a9a6d5e` (`--match-head-commit`) on the owner's order.
  - `/api/health` served `9e4dfb5` until 15:02:08 UTC and first served `60aadb9` with `ok: true` at
    15:02:41 UTC, then at 15:02:51 and 15:03:02 UTC.
  - Unauthenticated GET smoke: `/api/auth/me` answered 200 with `{"user":null}`. These answered 401: the
    four `/variables` routes, the four M2 reads (`/fields`, `/targets`, `/conversions`, `/mappings`), and
    `/api/training-load/metrics/definitions` and `/domains`.
  - **The owner's read-only production post-check** (`docs/runbooks/metric-variable-requests-v36-postcheck.sql`,
    2026-10-14) passed all eight blocks. **v36 is directly confirmed on production:** recorded once with its
    checksum as the last migration; the table, its constraints, index, functions and triggers; no request
    row; no actor setting.
  - No authenticated request, no variable, version or request row, no GPEXE action; Render and
    `GPEXE_IMPORT_APPLY_ENABLED` untouched.
- **M2b — the source-field evidence confirmation and its database guards v37** (owner order and decisions
  2026-10-15, after the M2b delta discovery; branch `feature/metrics-mapping-m2b-v37` from `60aadb9`;
  **merged as PR #164**, merge commit `66c50d6` on 2026-10-15 at 09:23:42 UTC; its own deploy and smoke are not
  recorded here. **v37 on the deployed database is inferred, not queried:** every later deploy started the
  server after the migration step (`npm start` runs `node src/migrate.js &&` the server), the last one serving
  `6c7dfa4` on 2026-10-26. The owner's read-only post-check
  (`docs/runbooks/source-metric-revision-guards-v37-postcheck.sql`) is not recorded. **No production field is
  confirmed.**). Contract: decisions C89–C97 and section J4 of the discovery document.
  - Routes under `/api/training-load/sources/metrics`:
    - `GET /fields/:fieldId`: a field with its revisions and the history of its acts, for the audience of
      `/fields`;
    - two acts on an existing revision, for an active platform admin in the platform workspace only:
      `POST /fields/:fieldId/revisions/:revisionId/unit-verification` (the unit; for a zone or an event
      threshold with its bound unit) and `…/meaning-verification` (the meaning reference; for an event
      threshold with its operator).
    - Each act is done once, written once on the revision and audited by its T8 row (the request record).
      `evidence_status` is derived by the server. A correction is a new revision, which is not in M2b.
  - **Zones (C89):** a zone's unit may be confirmed. Its meaning answers `409 verification_model_unresolved`,
    and the database refuses it, until the owner decides how closed and open zones share one bound operator.
    An event threshold's operator is one-sided (`>=`, `>`, `<=`, `<`; `between` is refused, since no mapping
    version could ever use it).
  - **Migration v37** (`migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql`):
    - the acting user on every act (the v35 setting, an active platform admin, the user the act names);
    - every other T2b write and every T8 action without a built chain refused (C90);
    - the act's audit row checked, and required at COMMIT;
    - rollback `docs/runbooks/source-metric-revision-guards-v37-rollback.sql` (refuses once any confirmation
      exists, C96), rehearsed; read-only production preflight and post-check beside it.
  - **Before the first real production confirmation (C91, C97):**
    - the revision lifecycle (R+1, activation, retirement, replacement) is built;
    - the owner-run evidence is merged as a document with an anchor: two sessions, 2–3 athletes each, the raw
      server3 answer against the GPEXE UI, the exact factor, sanitized; the meaning and operator from
      official documentation or written GPEXE support.

    J4 lists what each of the nine seeded fields still needs.
  - Tests: `backend/tests/source-field-verification-m2b.test.mjs` (disposable, T1 runner) with mutation
    evidence. The M2 and M3-0 suites write their revision fixtures with v37's T2b triggers off (the future
    lifecycle PR's writes), and the M2 architecture test names the new writer.
- **The GPEXE check timing line (P0)** (owner order 2026-10-13, after a read-only performance discovery
  the same day; branch `claude/upbeat-heisenberg-a3pbq9` from `1164041`; **merged as PR #162**, merge commit
  `9e4dfb5` on 2026-10-14 at 13:40:12 UTC; deployed - `/api/health` served `9e4dfb5` before the M3-0 deploy, last seen 2026-10-14 15:02:08 UTC; an owner-run check with its line is not recorded here). The discovery (code and a local fake-source measurement only, no production or
  GPEXE request): a check is strictly serial; for three sessions (one with five drills) and twenty
  athletes it sends 206 GPEXE requests, about 87 % of them the three reads per athlete row (detail,
  `/more/`, track) and 5 drill reads; every answer is followed by one heartbeat write, and each session's
  dry-run preview runs about 15-16 statements per result. The server3 latency and the Render-Supabase
  round trip are not known. P0 adds one closed-grammar log line per check
  (`backend/src/gpexeCheckTiming.js`; runbook section "How long a check takes: the timing line (P0)"):
  requests and network time per kind, heartbeat, re-validation, retention, preview, staging and
  finalization times, session / athlete / track / drill counts - never an id, date, name, URL, credential,
  value or error text. No change of requests, order, heartbeat frequency, results, database, route or UI.
  Any optimization (fewer heartbeat writes, pipelining, concurrency) waits for one owner-run check and its
  line.
- **GPEXE's rate limit (429) during a check** (owner order 2026-10-22; PR #209, branch
  `fix/gpexe-check-rate-limit` from `12beb86`; backend, tests and docs, no migration, no frontend change).
  - **Merged and deployed** on the owner's order (2026-10-24), together with the two read-only probe tools and the
    request reduction; each was deployed before the next was merged:

    | PR | Merge commit | Merged (UTC) | `/api/health` first served it with `ok: true` (UTC) |
    |---|---|---|---|
    | #209, the 429 repeat | `12b0f2e` | 00:39:19 | 00:44:41 |
    | #210, the athlete-list probe | `38c2431` | 00:44:55 | 00:46:35 |
    | #211, the details-coverage probe | `8e20da1` | 00:47:07 | 00:48:31 |
    | #212, the request reduction | `e8c5eb9` | 11:24:16 | 11:26:45 |

    - Each commit was then served three times in a row.
    - Without a login, `GET /api/auth/me` answered 200 with no user, and the GPEXE team status (zero UUID) and the
      source-connection list answered 401.
    - Render did not deploy by itself; the owner started each deploy.
    - No migration was run, and no check or GPEXE request was sent at the merges; the probe sittings and the
      check below were owner-run, each on its own order.
  - **Production, 2026-10-22 (as reported by the owner, sanitized):** two checks of First team failed with
    `source_unavailable` "The source server asked to slow down." (HTTP 429): the default 14 days at 10:03,
    and 18.10.2026 - 19.10.2026 at 17:11 after one session. Nothing was published; the switch stays off.
  - **As built:** an import check (only; Connect, Test, Bind and the identity load are unchanged) repeats a
    rate-limited request **at most once per check**, only after a whole-seconds `Retry-After` of at most
    60 s; it waits in ticks of at most 10 s with a heartbeat after each, and before the repeat requires the
    run still running and the binding facts unchanged. Any other 429 stops the check at once with nothing
    more sent; the administrator reads a closed-grammar line after " Diagnostic: " (`op=rate_limit; ...`).
    Runbook section "When GPEXE asks to slow down (429)"; `backend/src/gpexeCheckRateLimit.js`; tests
    `gpexe-rest-v1-rate-limit.test.mjs` (unit) and `gpexe-check-rate-limit.test.mjs` (disposable), with
    mutation evidence. External review (trigger 4, retry) before any merge.
  - **After the one repeat (owner's targeted check, 2026-10-23):**
    - a 5xx or no answer to the repeat fails that read as itself, with no third request and no second wait;
    - the repeat stays spent, so a later 429 stops the check (`retry_already_used`);
    - nothing is sent after a stop.

    Covered by tests RL17-RL20 (unit) and 10-11 (disposable), test-only.
  - **The 17:11 check's timing line (owner, sanitized):** 455 requests in 4 min 51 s, the 429 on the last;
    193 athlete rows for 22 athletes - server3 lists one row per athlete for the session and one per drill.
  - **Request count:** about 200 - 330 requests per production session, mostly the row and `/more/` reads
    (`docs/ai/gpexe-check-request-count-analysis.md`, section 5).
  - **The reduction** (PR #212, branch `feature/gpexe-check-request-reduction`; merged and deployed, see the table
    above; backend, tests and docs, no migration):
    - a check reads no drill brief or tag list, and reads the thresholds once per day;
    - it takes each athlete row from the list, with `max_v` from the details it reads anyway, and reads one
      canary row per session on its own;
    - a row the details do not cover, or a session whose canary differs, is read row by row as before.

    That is 146 instead of 206 requests on the fake-source check, with the same stored bundles.
  - **The first production check on `e8c5eb9`** (2026-10-24, 11:30:20 - 11:39:35 UTC, owner-run once, First team,
    the default 14 days 11.10.2026 - 24.10.2026; sanitized, from the Imports screen and the check's timing line):
    - **Confirmed (measured):**
      - `succeeded`, with no HTTP 429 (no `op=rate_limit` line);
      - 12 sessions found and done: 10 new, 0 changed, 2 unchanged;
      - 201 athletes (201 tracks), 507 athlete rows, 17 drills;
      - **792 GPEXE requests** in **9 min 14 s** (`total_ms=554367`). By kind: session list 8, parents 12,
        athlete lists 13, row reads 12, `/more/` 507, tracks 201, whole details 12, drills 17, thresholds 10,
        brief / tags 0;
      - the row reads were exactly the 12 canaries, one per session. Every canary matched, and none of the 507
        rows needed a fallback read on its own;
      - the 2 unchanged sessions were stored before by the old path, which read every row. They have the same
        content fingerprint now, so the stored data is the same.
    - **Estimated, not measured:** the old path would have sent about 1,300 requests for the same scope (507 row
      reads instead of 12, 12 thresholds instead of 10, plus a brief per session with drills), so about 39% more.
      The largest remaining times are the database preview (163 s), the session list (141 s), `/more/` (97 s), and
      the details with the drills (85 s).
  - **The request reduction (PR #212) is complete,** confirmed by this production check.
  - **The window's session list through the server's date filter** (owner order 2026-10-24; branch
    `feature/gpexe-check-window-filter` from `9f7291c`; **merged and deployed as PR #214**, see below; adapter,
    tests and docs, no migration, no change to the import, Metrics Core, storage or the UI):
    - **The owner-run window-filter probe** (2026-10-24, 12:04 UTC, run once; 9 requests, no 429; sanitized) ran
      against the whole list of 374 sessions, for 11.10 - 24.10 and 05.10 - 06.10, each with a margin of two days
      and without:
      - **0 missing window parents, 0 missing look-back parents and 0 missing drills** in all four answers, and
        the same window parents from the filtered rows alone;
      - **rows in excess only:** the margin days, and after the end. The counts fit a server that does not
        apply the upper bound at all: the 2-day window's answer held every session up to the day of the run.
      - **Durations:** the whole list took 75.1 s for 4 pages; one filtered page took 7.2 - 11.3 s.
      - Record: `docs/ai/gpexe-rest-v1-compatibility.md` section 4d.
    - **What changes:** `listSessionsByDay` asks for the look-back day and the window widened by
      `WINDOW_FILTER_MARGIN_DAYS` (2) on both sides. The rest is unchanged:
      - every page of the answer is read, and every next link must keep the same bounds;
      - the list is read twice and both reads must agree;
      - parents and drills are classified on the list, and the window is picked out locally;
      - rows outside the window are left out, never refused.
    - **Expected for a 14-day check ending today:** 2 list requests instead of 8, about 18 s instead of about
      141 s, so about 7 min 10 s instead of 9 min 14 s. This is an estimate from the probe's durations, not yet
      measured in a check.
    - **An older window costs more**, because every later session comes with it, but never more than the
      whole list from the window's start. The first answer longer than 100 rows will be the first to page a
      filtered next link in production.
    - **PR #214 is merged and deployed.** Head `b545af4`, merge commit `bb6072b` on 2026-10-24 at about
      12:49 UTC, merged exactly from that head on the owner's order. Render did not deploy by itself; the owner
      started the deploy. `/api/health` served `bb6072b` with `ok: true` three times in a row (12:54:13, 12:54:24
      and 12:54:34 UTC). Without a login `GET /api/auth/me` answered 200 with no user, and five protected GPEXE
      and source-connection GET routes (zero UUID) answered 401. No check or GPEXE request at the merge.
    - **The check on `bb6072b`** (2026-10-24, ended at about 13:02 UTC, owner-run once, First team, 11.10.2026 -
      24.10.2026; sanitized, from the Imports screen and the timing line): `succeeded`, no 429; 12 sessions,
      0 new, 0 changed, 12 unchanged; 201 athletes, 507 rows, 17 drills. **2 list requests in 16.0 s instead of
      8 in 140.6 s**, 786 GPEXE requests instead of 792, the whole check **7 min 32 s** instead of 9 min 14 s
      (`total_ms=451826`; the estimate was about 7 min 10 s - the other reads were about 21 s slower this time,
      at the same request counts). The same sessions and drills as the check on `e8c5eb9`, every one unchanged.
  - **One INSERT per result for the values (option A of the preview analysis)** (owner order 2026-10-24, after a
    read-only analysis of the preview phase; PR #215, branch `feature/gpexe-preview-values-batch` from `bb6072b`;
    backend writer and tests, no migration):
    - **Where the time went (analysis):** with the switch off nothing was ever imported, so every check's preview
      runs the first import of every session in a rolled-back transaction. Locally that was 358 statements for a
      17-athlete session without drills and 1573 with 5 drills (1122 of them, 71 %, one INSERT per metric
      value); SQL itself took under 1 ms per statement, so the 163 s in production were almost all round trips.
      The heartbeat measured about 25 ms per statement; the local counts scaled to the 12 sessions give about
      8,600 preview statements, so about 19 ms each (an estimate).
    - **As built:** `insertOccasionWithValues` (`backend/src/gpexeImportWriter.js`) sends one multi-row INSERT
      per result (`metricValuesInsert`) with the same rows, columns, parameters and order; nothing else of the
      import, the preview transaction, locks, rollback or identity rules changed. The same code serves the
      preview and the real import at approval. Locally 358 -> 188 and 1573 -> 553 statements per preview. A
      session already imported with the same values (the preview writes nothing: 79 / 264 statements) is not
      affected; with the switch off no session has been imported, so every check's previews benefit, whether
      the candidate is new or unchanged.
    - **Proof:** `backend/tests/gpexe-import-values-batch.test.mjs` runs every step with the new code and with
      the old per-value statements replayed, from the same state: the same preview, previewHash, stored rows and
      rollback, and the same refusal for six bad-value cases (apart from the accepted `where`, below); `gpexe-in-app-import.test.mjs` adds a value refused
      by the database in the middle of the statement through the real approve route (500 `internal_error`,
      nothing written, the candidate still pending, the retry imports). Mutation evidence. Not tested on
      PostgreSQL 17 (production runs 17.6).
    - **Accepted limitations (owner, 2026-10-24):** three differences in SQL errors that the writer cannot
      produce (its values are finite numbers, a definition and its version come from the same row), each pinned
      by a test: a 22P02's `where` names the parameter by its position in the statement (`$10` instead of `$4`);
      with two refused values in one result, the refusal reported can differ (an FK fault before a null value:
      23503 -> P0001; a null value before a non-number: P0001 -> 22P02). Accepted on the condition, checked in the
      code, that none affects user behaviour, audit, error handling or data integrity: no code reads `where`, and
      the check, the approval and the batch answer every database error on this path with the same
      `internal_error` (only 42501 is told apart at approval).
    - **Review:** `code-reviewer` and `db-reviewer` (the refusal-order differences and a wrong comment found and
      fixed, the approval route test added); the external review the owner designated (an independent process
      outside the internal reviewers): **READY**, with its own old-vs-new comparison through the real service,
      including the deploy transition (a preview computed by the old code and approved by the new one).
    - **PR #215 is merged and deployed.** Reviewed head `4210f20`, merge commit `306abd7` on 2026-10-24 at
      14:27 UTC, merged exactly from that head on the owner's order. Render did not deploy by itself; the owner
      started the deploy. `/api/health` first served `306abd7` with `ok: true` at 14:29:12 UTC, then three times
      in a row (14:29:26, 14:29:36 and 14:29:47 UTC). Without a login `GET /api/auth/me` answered 200 with no
      user, and six protected GPEXE, source-connection and metrics GET routes (zero UUID) answered 401. No check
      or GPEXE request at the merge.
    - **The check on `306abd7`** (2026-10-24, ended at about 14:36 UTC, owner-run once, First team, 11.10.2026 -
      24.10.2026; sanitized): `succeeded`, no 429; 12 sessions, 0 new, 0 changed, 12 unchanged; 201 athletes, 507
      rows, 17 drills; the same 786 GPEXE requests. **The preview took 66.4 s instead of 163.3 s** (-59 %), the
      whole check **5 min 59 s** instead of 7 min 32 s (`total_ms=358844`); the GPEXE reads were 4.3 s slower
      this time at the same counts. The number of database statements is not logged; it is estimated at about
      3,500 instead of about 8,600 for the 12 previews (the local counts give about 5,000 fewer value
      statements, and 66.4 s at about 19 ms per statement is about 3,500).
  - **The result of the check optimization:** over PR #214 and #215 the same 14-day check went from 9 min 14 s
    (the check on `e8c5eb9`, already after PR #212) to 5 min 59 s (-35 %), with the same sessions, drills and
    stored data. PR #212 itself cut the requests to 792 from an estimated 1,300; its time saving was not
    measured.
  - **The owner-run read-only sitting** (2026-10-24, 08:55 UTC, run once; 23 requests, no 429; sanitized reports
    as returned by the owner):
    - **A, athlete list:** `differs`. Eight of the nine row fields are equal, but `max_v` is absent from the list,
      so each row's own read stays.
    - **B, grouped details:** `differs`. Events, the mapping and the drill level are `same`. The power zones
      differ (4 zones against 5), and the speed zones are `insufficient`. So `/more/` stays for every row.
    - **C, `max_values_speed` against each row's `max_v`** (10:57 UTC, 16 requests, no 429): 9 of 9 pairs were
      the same number, and the details covered all 39 valid rows. The details' unit word is `speed`, so the tool
      printed `insufficient`, but the number is the very `max_v`. This is what lets a check drop the per-row read.
    - `/more/` stays for every row (B).
- **The Metrics Core plan (2026-10-26).** The owner adopted a plan for the rest of the Metrics Core work:
  `docs/ai/metrics-core-plan.md` (phases 0–10, R1 and R2), with the phase 10 decisions in
  `docs/ai/phase10-estimates-decisions.md`. Its roles, reviewers and rules of work are in that file only;
  this file records what was merged and deployed.
  - **Phase 0, PR #221** (docs only): merge commit `16ef080` (parents `7a9e59d` and `5ef3334`) on 2026-10-26 at
    22:59:53 UTC, made by the *Rukovodilac*; how it was authorized is recorded in PR #222 (not merged when this
    was written). `/api/health` served `16ef080` with `ok: true` three times in a row (23:01:37, 23:01:47 and
    23:01:58 UTC).
  - **Phase 1, PR #219: the older catalog's guard on the canonical variables (C98, no migration).** The older
    API `/api/training-load/metrics` no longer creates or changes a `system` or `club` definition: it answers
    `409 canonical_variable_read_only` and writes nothing. A definition the caller may not manage answers the
    byte-identical `404` (ADR-006). Details are in section A6 of the discovery document.
    - Read-only preflight: the owner counted 0 `system` / `club` definitions in production.
    - Merge commit `7a9e59d` (parents `deb2aa1` and `a36d3c0`) on 2026-10-26 at 22:07:59 UTC, made by the
      *Rukovodilac* on the owner's order (phase 1 of the plan records it), after the GO of the *Rukovodilac* and
      of the third reviewer on `a36d3c0`.
    - `/api/health` served `7a9e59d` with `ok: true` three times in a row from 22:09:09 UTC. Without a login the
      older API's write routes answered 401. No production write.
  - **Phase 2, PR #218: M3a, the Variables view (Training Load → Data configuration).** Frontend over the M3-0
    admin API: the list, a variable's versions, create and a new version, one write at a time, and *Result not
    confirmed* · *Check result* with the same request key after a lost answer. A club sees the system variables
    as a read-only reference. Details are in section H of the discovery document.
    - Integration QA against the real API on disposable databases migrated through v37, by the executor and,
      separately, by the *Rukovodilac*, passed on `6436461`; the only differences are the client's intended
      normalisation of whitespace and of "-0". The record is in PR #218.
    - Merge commit `6c7dfa4` (parents `16ef080` and `6436461`) on 2026-10-26 at 23:31:43 UTC, made by the
      executor after the *Rukovodilac*'s GO on `6436461`; how it was authorized is recorded in PR #218's
      description.
    - `/api/health` served `6c7dfa4` with `ok: true` three times in a row (23:33:01, 23:33:11 and 23:33:22 UTC).
      Without a login the variables list, one variable and the key suggestion (GET) and the create and new
      version (POST, `{}`) answered 401.
    - Not checked on a physical device (iOS `datalist`, WebKit `select`). Neither the executor nor the
      *Rukovodilac* created a variable in production; the production database was not queried.
  - **Phase 2b, R2: renaming, archiving and restoring a canonical variable, with a team coach for club
    variables.** The owner's decision is C99 and the contract J3b of the discovery document.
    - **The contract, PR #224** (docs only): merge commit `e8e2b0a` (parents `9001af5` and `0e4e373`) on
      2026-10-27 at 07:16:18 UTC. `/api/health` served `e8e2b0a` with `ok: true` three times in a row (07:17:23,
      07:17:33 and 07:17:43 UTC). Without a login the variable routes answered 401.
    - **The implementation, PR #227** (migration v38, the three routes, the team-workspace reads; section J3b.8
      of the discovery document):
      - Reviews: `db-reviewer`, `security-reviewer` and `code-reviewer` on `8f999b5`; their notes applied at
        `ae92c2e`. GO on `ae92c2e` from the *Rukovodilac* and from the *Nezavisni revizor*; no BLOCKER, HIGH or
        MEDIUM. How the merge was authorized is recorded in PR #227's description.
      - The owner's read-only preflight `docs/runbooks/metric-variable-changes-v38-preflight.sql` (Supabase SQL
        Editor, 2026-10-27 about 08:50 UTC) gave the expected value in all nine blocks: PostgreSQL `170006`,
        v35–v37 recorded with their checksums, v38 absent, the last migration
        `202610191300_media_upload_lifecycle.sql`, one existing request row that passes the checks v38 adds.
      - The owner also checked that the Supabase Data API is switched off ("No schemas can be queried"; the role
        `authenticator` carries no `pgrst.db_schemas`), so `training_load` is not exposed through it. The v36 and
        v38 tables have no row-level security.
      - Merge commit `e556d08` (parents `e8e2b0a` and `ae92c2e`) on 2026-10-27 at 09:51:13 UTC, made by the executor
        from exactly `ae92c2e`.
      - `/api/health` served `e8e2b0a` until 09:52:08 UTC and first served `e556d08` with `ok: true` at 09:52:18
        UTC, then at 09:52:29 and 09:52:39 UTC. Without a login, the variables list, one variable and the key
        suggestion (GET) and the create, new version, rename, archive and restore (POST, `{}`) answered 401;
        `/api/auth/me` answered `{"user":null}`.
      - **v38 on the deployed database is confirmed by the owner's read-only post-check**
        (`docs/runbooks/metric-variable-changes-v38-postcheck.sql`, eight blocks, Supabase SQL Editor). The owner
        reported every block as confirmed („sve potvrdjeno na post tetiranju”, 2026-10-27 11:39:15 UTC, in the
        *Rukovodilac*'s chat). The owner did not paste the values of the blocks, so they are not recorded here.
      - No variable was renamed, archived or restored in production by the executor or a reviewer.

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
- PR #158 (merge commit `0293b39`, merged 2026-10-12 16:12:25 UTC exactly from head `77ae78f`; the
  agent-efficiency rule, docs / rules only) is deployed: `/api/health` first served `0293b39` with
  `ok: true` at 16:13:15 UTC, then three times in a row (16:13:26, 16:13:36 and 16:13:46 UTC); without a
  login `GET /api/auth/me` answered 200 with `{"user":null}` and the GPEXE team status (zero UUID)
  answered 401. No migration, no production write, no Render change, no GPEXE action.
- PR #156 (merge commit `e6bc885`, merged 2026-10-12 15:51:33 UTC exactly from head `f519549`; the
  metric / variable mapping discovery, ADR-007 and the rule `metrics-core-mapping.md`, docs only) is
  deployed: `/api/health` first served `e6bc885` with `ok: true` at 15:52:39 UTC, then three times in a
  row (15:52:50, 15:53:00 and 15:53:11 UTC); without a login `GET /api/auth/me` answered 200 with
  `{"user":null}` and the GPEXE team status (zero UUID) answered 401. No migration, no production write,
  no Render change, no GPEXE action.
- PR #159 (merge commit `15efd7a`, merged 2026-10-13 09:54:43 UTC exactly from head `5ec30a4`; M1,
  migration v34) is deployed: `/api/health` first served `15efd7a` with `ok: true` at 09:55:36 UTC, then
  three times in a row (09:55:46–09:56:07 UTC); without a login `/api/auth/me` answered 200 with no user
  and four protected GPEXE / source-connection GET routes 401. **v34 on the deployed database is
  directly confirmed** by the owner's read-only post-check (the record, its checksum, every object and
  the exact seed; see the active phase), not only inferred from the start-up. The local OPTIMOVE
  database is not migrated.
- PR #160 (merge commit `1164041`, merged 2026-10-13 13:25:07 UTC exactly from head `fd8af5e`; the
  first M2 PR, the mapping administration API, no migration) is deployed: `/api/health` first served
  `1164041` with `ok: true` at 13:26:15 UTC, then three times in a row (13:26:25–13:26:46 UTC); without a
  login `/api/auth/me` answered 200 with no user and the four M2 GET routes 401. No authenticated M2
  request was made: no mapping, version or audit row exists in production.
- PR #161 (merge commit `ed13f8a`, merged 2026-10-14 07:16:19 UTC exactly from head `9473aaa`; v35) is
  deployed: `/api/health` first served `ed13f8a` with `ok: true` at 07:17:15 UTC, then three times in a row
  (07:17:25–07:17:45 UTC); without a login `/api/auth/me` answered 200 with no user and the four M2 GET
  routes 401. **v35 on the deployed database is directly confirmed** by the owner's read-only post-check
  (all eight blocks), not only inferred from the start-up.
- PR #163 (merge commit `60aadb9`, merged 2026-10-14 15:01:41 UTC exactly from head `a9a6d5e`; M3-0,
  migration v36) is deployed: `/api/health` first served `60aadb9` with `ok: true` at 15:02:41 UTC, then at
  15:02:51 and 15:03:02 UTC; without a login `/api/auth/me` answered 200 with no user and every new and
  existing metrics GET route tried 401. **v36 on the deployed database is directly confirmed** by the
  owner's read-only post-check (all eight blocks). PR #162 (`9e4dfb5`, the GPEXE check timing line) was
  deployed before it: `/api/health` served `9e4dfb5` until 15:02:08 UTC.
- PR #218 (merge commit `6c7dfa4`, 2026-10-26 23:31:43 UTC exactly from head `6436461`; M3a, frontend and
  docs, no migration) is deployed: `/api/health` served `6c7dfa4` with `ok: true` three times in a row
  (23:33:01–23:33:22 UTC); without a login the five `/api/training-load/sources/metrics/variables` routes tried
  answered 401.
- PR #221 (merge commit `16ef080`, 2026-10-26 22:59:53 UTC exactly from head `5ef3334`; the plan, docs only) is
  deployed: `/api/health` served `16ef080` with `ok: true` three times in a row (23:01:37–23:01:58 UTC).
- PR #219 (merge commit `7a9e59d`, 2026-10-26 22:07:59 UTC exactly from head `a36d3c0`; C98, no migration) is
  deployed: `/api/health` served `7a9e59d` with `ok: true` three times in a row from 22:09:09 UTC; without a
  login the older API's write routes answered 401.
- M2b (PR #164, merge commit `66c50d6`, 2026-10-15 09:23:42 UTC; migration v37) is merged. Its own deploy is
  not recorded; **v37 on the deployed database is inferred** from every later deploy starting the server after
  the migration step, the last one serving `6c7dfa4`. It was not queried; the owner's read-only post-check is
  not recorded.
- PR #157 (merge commit `0098638`, merged 2026-10-12 11:52:30 UTC exactly from head `ce571d3`; Coach
  Home empty and error states, frontend only) is deployed: `/api/health` first served `0098638` with
  `ok: true` at 12:25:26 UTC, then three times in a row (12:25:47, 12:25:58 and 12:26:09 UTC); the
  served `/assets/app-CM0hIOhv.js` carries the new empty / error states and `coach-home-retry`, and
  `/assets/app-_Sry8COF.css` the new Coach Home rules; without a login `GET /api/auth/me` answered
  200 with `{"user":null}` and `GET /api/athletes/today` answered 401. No sign-in, production write,
  Render change, GPEXE action or migration.
- `95f2fd1` (on `main` before PR #157, 2026-10-12; a merge of `af11338` into the branch
  `codex/home-workspace-navigation`, no pull request found for it) brought commit `72567b7`
  (athlete lists sorted alphabetically, visible roster filters; frontend and its tests only). It
  widened the code slice of the `builder-create-form-fixes.test.mjs` test "handleContentInput
  mirrors every keystroke…" from 700 to 1000 characters; that test, a known baseline failure since
  2026-10-11, passes on `0098638` (T1 runner, 2026-10-12), so its entry is removed from "Known
  baseline/environment test issues" and from `frontend/tests/support/test-manifest.json`.
- PR #155 (`af11338`, merged 2026-10-11 19:49:17 UTC exactly from head `a61f399`) is deployed:
  `/api/health` served `af11338` with `ok: true` three times in a row (19:50:15–19:50:35 UTC); without a
  login `GET /api/auth/me` answered 200 with no user and the GPEXE team status (zero UUID) answered 401.
  Test infrastructure only: no migration, no route change. No check or GPEXE request at the merge.
- PR #154 (`241765e`, merged 2026-10-11 15:15 UTC from head `2ff4b3b`) is deployed: `/api/health` first
  served `241765e` with `ok: true` at 16:19:43 UTC, then three times in a row; the served bundle carries the
  v33 texts; without a login nine protected GPEXE and source-connection routes answered 401. No migration.
  The owner's check followed on a separate order (succeeded, 3 unchanged; see the active phase).
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
- Reproduced identically on a clean detached `origin/main` worktree (`e8e2b0a`) on 2026-10-27, with
  `node scripts/test-runner.mjs --project backend --kind disposable --file …` in the Claude Code cloud container (not fixed):
  - `backend/tests/gpexe-backup-verify.test.mjs` — fails on one catalog difference after `pg_dump` /
    `pg_restore` with PostgreSQL 16 (the container's): v32's CHECK `gpexe_athlete_identities_display_name` reads
    back with its nested `AND`s flattened. Whether a dump of the production server (PostgreSQL 17) reads it back
    differently too is not verified. If it does, the verifier reports a difference on every database that
    carries v32, and the fix is to write that CHECK so a restore reads it back the same (a migration).
  - `backend/tests/builder-copy-performance.test.mjs` — `column "video_source" of relation "plan_items" does not
    exist` in the disposable schema.
  - `backend/tests/media-storage-be1.test.mjs`, `media-upload-be2.test.mjs` — they need `MEDIA_TEST_DATABASE_URL`
    and stop at once without it.
- `backend/tests/training-load-metrics-builder-edit-draft.test.mjs` — refuses to start
  unless `LOCAL_OPTIMOVE_SCHEMA_SOURCE_URL` is set (deliberate guard, no database
  operation attempted), so a plain full backend run reports it as failed; same on
  `3ef6033`.

## Separate tasks (recorded, waiting for the owner to schedule them)

- **A test for a team moved to another club in the middle of an R2 write** (the *Rukovodilac*'s LOW finding on
  PR #227, 2026-10-27; a test only, no code change). Its mutation S13 removes the `club_id = $2` condition from
  the team read of `coachRightsStillHold()` in `backend/src/sourceMetricMappingService.js`, and the R2 suite does
  not catch it. That path is reachable only if a team moves to another club during a request, and no route moves a
  team today; the database then refuses the write through `metric_variable_change_basis()` (a sanitized 500,
  nothing written). The test moves the team (`update public.teams set club_id`) in the rights-hold seam of
  `canonical-variables-r2.test.mjs` and expects the 404.
- **v32's CHECK `gpexe_athlete_identities_display_name` does not read back the same after a dump and restore**
  (found 2026-10-27 in the R2 work; a migration, not scheduled). With PostgreSQL 16, `pg_dump` / `pg_restore`
  flattens its nested `AND`s, so `gpexe-backup-verify` reports a catalog difference on every database that
  carries v32 (see "Known baseline/environment test issues"). Whether a dump of the production server
  (PostgreSQL 17) behaves the same is not verified. The fix rewrites that CHECK so a restore reads it back the
  same, as v38 did for its trigger `WHEN` clause (J3b.8). The trial restore of condition 1 under Separate tasks
  depends on that verifier.
- **The Imports screen stops following a running check after one failed status poll** (found 2026-10-22,
  frontend only, small; not scheduled). `pollGpexeCheck` (`frontend/gpexe-import-data.js`) polls every 2 s with no
  time limit, but one failed poll (a 503 `database_busy`, a 502 while Render restarts, a lost answer) sets
  `checkError`, drops the check from view and re-enables *Find new sessions*; the screen then reads "Finding new
  sessions could not start. Try again in a moment." although the check started and may still run, and a second
  press answers `check_already_running`. Reproduced on the real frontend modules with a fake API (2026-10-22). Fix:
  a failed poll keeps the check as running, says the status could not be read, retries the poll (bounded backoff),
  and never says "could not start"; with a frontend test.
- **A cooldown per GPEXE connection after a rate-limit stop** (owner, 2026-10-22, at the review of the 429 PR; plan
  first, not built): after a check stops on a 429, a new check of any team bound to the same connection could be
  refused for the valid `Retry-After`, or 15 minutes when there is none. The plan, its impact on the 429 PR and the
  matrix of which operations call GPEXE (and so would be refused) against local ones:
  `docs/ai/gpexe-connection-cooldown-plan.md` (in Draft PR #209). For the owner to approve before any code or
  migration; no decision of the plan is taken yet.
- **A read-only check of the nine athlete-row fields in server3's athlete list** (owner, 2026-10-22; plan first,
  no GPEXE request until the owner approves): whether `rest/v1/athlete_session/?teamsession=` rows carry the nine
  projected fields with the same values as the per-row read - the precondition of the largest request saving in
  `docs/ai/gpexe-check-request-count-analysis.md`. Plan: `docs/ai/gpexe-athlete-list-nine-fields-plan.md` (in Draft
  PR #209).
  - **The probe mode** (`--mode athlete-list`): implemented and tested against a fake server only, merged and
    deployed as PR #210 (`38c2431`). The details-coverage tool (question B) is PR #211 (`8e20da1`).
  - **The real GPEXE read** ran once on 2026-10-24: `differs`, because `max_v` is not in the list (see the 429
    entry under the active phase).
  - **Merged in that order on 2026-10-24:** #209, then #210, then #211.

- **Separate migration and runtime database roles** (owner, 2026-10-13, at the v35 decisions; an
  infrastructure hardening task, not blocking v35): today the migrations and the server use the same
  `DATABASE_URL` role, which owns the tables - it can set v35's actor setting and disable any trigger.
  A runtime role without ownership or DDL (and the migrations under an owner role) would make the v35
  guards hold against the application's own credentials too. Needs Supabase roles, the Render
  environment and `backend/src/migrate.js` to use the owner role.
- **Database actor guards for the other M2 writers** (owner, 2026-10-13, C76): v35 covers T3, T4 and
  T8 only. Every future route that writes T2a, T2b, `unit_conversions` or T5 gets its own database
  actor guard (the v35 pattern) before it is released. The T2b confirmations and their guards are M2b,
  migration v37 (merged as PR #164; v37 also refuses every other T2b write and every T8 action without a
  built chain, C90).
- **v35 / v36 test hardening: one SQL statement never writes two audit rows** (owner, 2026-10-14, the
  non-blocking note of the external review of PR #161; not scheduled): a regression test that a
  multi-row `VALUES`, an `INSERT … SELECT`, data-modifying CTEs and a CTE with a main `INSERT` cannot
  write two audit rows for one operation. A one-off probe on a disposable database refused all four with
  `23514` for `mapping_create` (the BEFORE guard's check sees the rows the same outer statement already
  wrote, its functions being VOLATILE); the version and status rows were not probed.
- **A flaky leak assertion in `gpexe-import-credential-resolver.test.mjs` test 38** (found 2026-10-14 in the
  `gpexe` preset of the M3-0 branch; not scheduled): its first case asserts that no log line contains an
  athlete id of the fixture (`101`, `102`, `103`) by plain substring, while the importer's log line
  `[gpexe] check … reads through source_connection (connection <uuid>, binding <uuid>, source team <n>)`
  carries random UUIDs, one of which contains such a three-digit run about 1.5% of the time. It failed once
  in the preset and passed 40/40 on the immediate re-run; neither the test file nor the code it exercises
  was changed. Fix: match a planted, distinctive id (or whole tokens) instead of a three-digit substring.
- **The admin APIs' invisible-character list has gaps** (security review of M3-0, 2026-10-14, LOW; not
  scheduled): `TEXT_FORBIDDEN` in `backend/src/sourceMetricMappingService.js` (the shared rule C53, used by M2 and
  M3-0 for labels and reasons) misses U+3164, U+115F, U+1160, U+FFA0, U+2800, U+034F, the variation selectors
  U+FE00-FE0F, the tag characters U+E0000-E007F and U+FFF9-FFFB, so a label made only of such a character passes.
  Metrics Core labels have no database-side text check. Fix in its own PR: extend the list or check
  `\p{Default_Ignorable_Code_Point}` plus at least one visible character, together with its database twin `training_load.source_metric_text_ok` (v34; a migration).
- **The revision lifecycle of a source field** (owner, 2026-10-15, C91; the next backend contract after
  M2b): a new revision R+1, its activation, the retirement of R and the replacement of the mapping versions
  pinned to it, each with its own database actor guard (C76). It must be finished before the first real
  production confirmation through M2b. v37 refuses every new revision and state change, so that pull
  request (and any later seeding migration) replaces v37's T2b guard or adds its own exception.
- **The owner-run evidence for the nine seeded `rest_v1` fields** (C97; M6, gate 2): what each field still
  needs is listed in section J4 of the discovery document. The main session prepares the procedure only and
  never sends a GPEXE request.
- **The zone verification model** (C89): an owner decision on how closed and open zones are modelled
  (separate fields or revisions, or a schema change) before any zone's meaning is confirmed.
- **`migration-backfill.test.mjs` isolation** (owner, 2026-10-14; a test-infrastructure task): it runs the
  legacy `migrations/20260730_backfill_club_admin_scope.sql` over the whole shared database, re-asserting
  `is_active` and `updated_at` on every matching real club-admin row. Fix: run its SQL inside
  `begin … rollback` or on a disposable database, and let the shared-run snapshot keep full rows of the role
  tables.
- **`test:backend:shared` in a fresh worktree** (2026-10-14): `account-email-change.test.mjs` test 34 and
  `password-reset.test.mjs` test 36 start the server in production mode, which `server.js:222` refuses
  without a built `frontend/dist`. A fresh worktree has none, so the two fail as an environment matter:
  build the frontend first, or run them from a checkout that has it.

- **GPEXE identity follow-up (not scheduled):** the single-athlete link from a session's review names the
  athlete by its GPEXE name or label since PR #145, but it shows no date of birth or date-of-birth conflict
  warning (only Link athletes does).

- **A trace of withdrawn sessions in the default Imports view** (code and security reviews of the v33
  frontend branch, 2026-10-11; not scheduled): a candidate withdrawn by a complete successful search
  (`superseded_by_check_id`) is a superseded row, and the default candidates read lists no superseded row, so
  it vanishes from the inbox until someone opens Technical details > Show replaced or no longer found
  versions. A one-line trace in the default view ("N sessions found earlier are no longer found in GPEXE")
  needs either a server-side withdrawn count on the list or status answer, or an always-on
  `includeSuperseded=true` read filtered on the client (which changes the 200-row cap's meaning) - an owner
  contract decision. A frontend-only version was built and removed on the branch because it could never
  render against the real server.

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
- **The duration and progress of a check (UX / performance; owner, 2026-10-10, not scheduled):** the check
  of 05.10 - 06.10.2026 ran about 4 min 18 s (two complete reads of the whole list, then every session and
  drill of the window) while the Imports screen showed only that it was running, and a failure ends with a
  generic sentence. A separate task: a progress display (phase, sessions done) and a clearer failed-check
  message; any change to the number of requests is its own decision. Measurement first: the P0 timing line
  (see the active phase).
- **Bound the staging insert of `recordCandidate`** (code review of PR #149, 2026-10-09, reshaped by the
  pre-import safety package, v33): since v33 a check's run writes no candidate row and has no transaction
  of its own - each session is one auto-commit insert into the staging table, and nothing of it can be
  committed as a candidate. What is left of the original finding: that insert's answer is awaited without
  a client-side bound, and a lost answer fails the check as `internal_error` (one staged row at most,
  removed by the discard or the retention sweep). Fix: a bounded insert with a stable code.
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
  environment until conditions 1–3, 6 and 7 hold there; condition 4 is required before regular
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
     tests. **Built in the pre-import safety package (PR #153, v33; merged and deployed 2026-10-11); the
     check of 05.10 - 06.10.2026 ran through it once on production and withdrew nothing (0 changed, 3
     unchanged), so the withdrawal itself has not been seen on production; the frontend half is merged and
     deployed as PR #154 (`241765e`, 2026-10-11), and the owner's check after it succeeded with 3 unchanged
     sessions and no `not_confirmed_for_import` row.**
  7. **Mandatory before the import switch is turned on in any environment** (owner, 2026-10-10, at the merge
     of PR #152): a fail-closed guard against a `?drill=<index>` parameter that does not distinguish the
     drills, without relying on a drill answer's `drills_count`. **Built in the same package (the
     drill-parameter guard; PR #153, merged and deployed 2026-10-11); its first production run passed (no
     session refused); the stored drill effect of the candidates was not read.**
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
the identity implementation (PR #144, v32), the id masking (PR #145), the hardening (PR #146), the
window diagnostic (PR #147), the whole-list window (PR #148), the drill projection (PR #149), the drill-set diagnostic (PR #150), the drill-count diagnostic (PR #151), the fix that ignores a drill answer's drills_count (PR #152), the pre-import safety package (PR #153, v33), its frontend half (PR #154), the T1 test infrastructure (PR #155), the mapping discovery (PR #156), the agent-efficiency rule (PR #158), M1, the mapping schema (PR #159, v34), the first M2 PR, the mapping administration API (PR #160), v35, the database actor guards (PR #161), M3-0, the canonical-variable admin API (PR #163, v36), the older catalog's guard C98 (PR #219), the Metrics Core plan (PR #221), M3a, the Variables view (PR #218), the R2 contract (PR #224) and R2, renaming, archiving and restoring a canonical variable (PR #227, v38) are merged and deployed; M2b (PR #164, v37) is merged and its deploy is inferred. PR #142 is closed as superseded. Next steps, in order:
1. **The Metrics Core plan** (`docs/ai/metrics-core-plan.md`) sets the order of the Metrics Core work. Its
   phases 0, 1, 2, 3 and 2b are done. Next by the plan:
   - phase 2c, R2 in the Variables tab (frontend); the Q10 pull request (the invisible characters, C99) is
     separate;
   - phase P, the owner only: the read-only v37 post-check, and the evidence for the nine `rest_v1` fields
     (C97);
   - phase 4, the revision lifecycle (C91), after the v37 post-check;
   - phases 5–10 and R1, as the plan orders them.

   No production field is confirmed through M2b before the revision lifecycle (C91) and the owner-run evidence
   (C97) exist. The import switch stays off throughout.
2. The owner states the state of the production-use gate and of the two gates before a link (an identity
   load and one link were run after PR #146; the owner's check after PR #154 reports every athlete of the
   three sessions of 05.10–06.10.2026 linked; when the remaining links were made and whether those gates
   were confirmed is not recorded here — the gates stay open until the owner states it).
3. The separate resend timing task (see Separate tasks), when the owner schedules it.
4. PR B, the F3c4 cut-over (see the active step).
5. The second owner-run procedure for one controlled real import (after M6).
6. **Phase 5a3c** (Complete and Needs review).

For the **Exercise media (R2)** track (see the top of Active phase), in the owner's order: the owner's
check of the 0 B coach's editor, the athlete-side playback with an isolated test athlete (the owner
decides when and how), the product decision on the Builder's media snapshot, the reference-aware GC and
the quota policy, and only then the wider activation by quota.

Conditions 1–3, 6 and 7 under Separate tasks come before the first real local import (and before the
switch is turned on in any environment), and conditions 4–5 before regular production imports.

The other Separate tasks wait until the owner schedules them.

## How to refresh this file

After a merged milestone or a change in active phase: update the "last reviewed"
line/commit at the top, move the newly-completed phase into "Last completed, merged
phases," and re-derive "Open risks"/"Separate tasks"/"Most likely next step" from the
actual current state — don't carry stale entries forward unexamined. See
`.claude/rules/memory-maintenance.md`.
