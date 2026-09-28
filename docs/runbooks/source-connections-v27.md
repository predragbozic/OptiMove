# Migration v27 — source credential connections, team bindings and audit (F3c1)

Migration: `migrations_v2/202609271000_training_load_v27_source_credential_connections.sql`.
Contract: `docs/ai/gpexe-f3c-auth-discovery.md` (sections 3, 4, 5, 6 F3c1, 7a, 8c).
Rollback: `docs/runbooks/source-connections-v27-rollback.sql`.
Tests: `backend/tests/source-connections-f3c1.test.mjs`, `backend/tests/source-credential-crypto.test.mjs`.

## What it adds

Four tables in `training_load`, added **beside** the existing GPEXE settings (D6). Nothing
existing is changed and no connection, binding or audit row is created: after v27 those three
tables are empty, also on a database that already carries the GPEXE team setting for team 980.
The only seeded data is one host catalog row.

| Table | Holds | Never holds |
|---|---|---|
| `source_host_catalog` | the approved server keys per source (`gpexe` / `e03` seeded, state `approved`), a label and a note; rows are never deleted or renamed, only retired | a URL, a credential; `server3` (not approved until a dedicated API account and Team ID 980 are confirmed there) |
| `source_credential_connections` | a club- or team-owned account for one source (`source_system`, `host_key` = an **approved** catalog key, a display `account_label`, the mandatory `credential_kind`), the encrypted credential (ciphertext, nonce, auth tag, key version — all four or none), the stored state and its facts | a plaintext credential, a username, a URL, a key |
| `source_team_bindings` | which source team an OptiMove team reads through which connection; one active binding per team and source; one active OptiMove team per source team across every connection of every club (v22's global rule carried over); rows end, never disappear; an optional provenance pointer to the legacy `gpexe_team_settings` row | a change to `gpexe_team_settings` or its history |
| `source_connection_audit` | who, when, which action, outcome, reason, error code and a flat JSON object of sanitized facts | any value under a secret-like key in any spelling — camelCase, hyphens, dots and case are normalised first (`training_load.normalize_key_name`, `key_name_is_secret`), so `signingKey`, `private-key`, `deviceKey` and `auth` are refused while `monkey`, `host_key` and `credential_kind` pass; an update, delete or truncate |

Also `training_load.source_connection_bound_team_ids(connection)`: the active bound team ids of a
connection in ascending order, the order a later credential change (F3c2) locks them in with
`hold_gpexe_team_lock`, try-lock style. Its index is `source_team_bindings_connection_team_idx`.

**Locks the database takes itself.** Creating or ending a binding takes the team's import lock
(`training_load.hold_gpexe_team_lock`, the v24 key shared with every GPEXE check, link, settings
change and approval) inside the trigger, try-lock style: a binding never lands next to a running
check or credential change of that team, and a busy lock answers "try again" at once. The sweep
over **all** bound teams of a connection (Connect / Reconnect / Disconnect) is F3c2's route work,
in ascending `team_id` order; F3c1 provides the order and the backstop, not the sweep. The trigger takes
the team lock before its row locks while the sweep will lock the connection row first: that
asymmetry is safe only because every side uses the try-lock (a loser fails at once and releases its
row locks, so no wait cycle can form). F3c2 must not turn the try-lock into a blocking lock. The two
overlapping-Reconnect concurrency tests named in the discovery document's section 6 therefore
belong to F3c2, where Reconnect exists; test 17 here proves the per-team backstop.

`credential_kind`, the owner, the source and the host are frozen while a credential is stored
(they are the data the ciphertext is bound to); wipe or re-encrypt the credential in the same
statement to change them. This is a single-statement guard: the database cannot check the AEAD,
so restoring old ciphertext bytes after a context change still fails at decryption. Writers and
rotation scripts re-encrypt; they never restore bytes.

### Several GPEXE servers: the host catalog

GPEXE may run a different server for different organisations. A connection names its server by
a **stable key only**; no URL is ever stored, typed or accepted. Two separate layers, and both
must agree before anything reaches a server:
- **the database catalog decides whether a key is approved now.** A new connection must name an
  `approved` row of `training_load.source_host_catalog` for the same source (foreign key plus the
  `check_host` trigger), and a **new team binding is refused when its connection's key is
  retired** (the binding trigger reads the catalog row `FOR SHARE`). Enforced by v27, tested.
- **the code allowlist decides where a key points.** `backend/src/sourceHosts.js` maps a key to
  its **exact HTTPS host** (`https://<host>/`, checked at import). `sourceHost()` alone does not
  know whether a key was retired.
- **the gate before any network call is `resolveApprovedSourceHost()`**: the connection's catalog
  row, read from the database in the same request, must be the same source and key and
  `approved`, and the key must resolve in the code; otherwise `host_not_allowed`. No default, no
  fallback to another host. F3c1 provides and tests this function; **F3c1 has no network caller,
  so using it before every request is a mandatory F3c2 gate** (discovery document, section 8b).

**Adding a confirmed shard (no structure change, no admin-typed URL):**
1. Confirm, outside OptiMove, that the dedicated API account and the team's source id work on
   that server. Nothing assumes an account, a token or a team id is valid on more than one server.
2. One code entry in `SOURCE_HOSTS` (the exact host) in a reviewed PR.
3. One data-only migration: `insert into training_load.source_host_catalog (source_system,
   host_key, label, note) values (…)`; the table's shape does not change.
4. The platform admin then only **chooses** the approved key in Settings (F3c3); the choice list
   is the intersection of the approved catalog rows and the keys the backend can resolve.
5. F3c2's Connect and Test connection run against **exactly the chosen host** and succeed there
   before any team binding is allowed on that connection.

Retiring a key: `update … set state = 'retired'`; no new connection may name it and no new team
binding may use a connection on it (both enforced by v27). Existing connections and bindings stay
as history; that F3c2 then answers `host_not_allowed` for them instead of calling the server is
the F3c2 gate above, not something F3c1 enforces.
A connection's host is frozen while a credential is stored (the AAD rule) and once it is bound.

### A team cannot leave the club it is bound through

Moving a team to another club (`public.teams.club_id`) takes the team's import lock, try-lock
style, and is refused while the team has an active binding to a club-owned connection of its
current club. End the binding first. A team-owned connection does not pin the club. The two
concurrent orders are serialized and tested: a move that starts while a binding insert is in
flight waits on the team row (the binding trigger holds it FOR SHARE) and is refused once the
binding commits; a binding insert that starts while a move is in flight fails at once with
"try again" (its trigger takes the try-lock first).

### The credential kinds (owner decision 2026-09-27)

`credential_kind` is mandatory and its format is open. Two kinds are defined in
`backend/src/sourceHosts.js`:
- `api_token` — an official API token entered by the administrator; OptiMove never sees a
  password. **Preferred.**
- `exchanged_token` — a token obtained once from a username/password exchange, allowed only
  when the source has no official token generation; the password serves that one exchange and
  is never stored or logged.

F3c1 supports both and chooses neither; there is no form and no route yet.

### Who acts (owner guideline 2026-09-27)

Only a platform admin manages and tests a connection (D2, D3). The audit `basis` therefore
allows `platform_admin`, `club_admin` (the contract's later option) and `system`
(`auto_invalidate`); there is no coach basis. If D3 is ever reopened, adding one is a migration.
Free-text columns (`account_label`, the reasons) are plain text: an administrator must never
type a token or password into them; F3c2's form says so next to the field.

### The state model (section 5 of the discovery)

`not_connected` (no credential) · `linked_untested` · `verified` (needs `last_verified_at` and a
credential) · `needs_reconnect` (needs `last_error_code`) · `source_unavailable` (needs
`last_error_at`). CHECK constraints enforce these facts; the "last verified <when>" decay is a
read-time display, not a state.

## The encryption key

`backend/src/sourceCredentialCrypto.js`: AES-256-GCM, a random 12-byte nonce per encryption, a
16-byte tag, and additional authenticated data that binds the ciphertext to the row (connection
id, owner scope and id, source system, host key, credential kind). A ciphertext moved to another
row, owner or host cannot be decrypted.

- The key ring is `SOURCE_CREDENTIAL_KEYS` = `<version>:<base64 32 bytes>;<version>:<…>`, the
  active version `SOURCE_CREDENTIAL_ACTIVE_KEY_VERSION` (default: the highest). It lives only in
  the server environment (Render, `backend/.env`); never in the database, a migration, the
  repository, an audit row or a log.
- **The server starts without it.** The variable is read only when a credential is encrypted or
  decrypted; without it those calls fail with the stable code `key_missing`. F3c1 deploys with
  no key set; setting one is part of F3c2's rollout, after this runbook's rotation section is
  agreed.
- Generate a key outside the repository:

```bash
node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
```

### Rotation (procedure for later, no code path in F3c1)

1. Add the new version to `SOURCE_CREDENTIAL_KEYS` and make it active; deploy. New credentials
   use it; old rows still decrypt with their own version.
2. Re-encrypt every row under the active version (a maintenance script of a later slice: decrypt
   with the old version, encrypt with the new, one row per transaction, an audit row
   `rotate_key` per connection, never the plaintext outside process memory).
3. When no row carries the old version, remove it from the ring; deploy.

## Applying it

Like every migration: `npm start` runs `node src/migrate.js` before the server, so the deploy
applies it. Never by hand on a persistent database without the owner's explicit approval for that
database (`.claude/rules/database-safety.md`). It needs no data backfill and creates no row.

Before it is applied anywhere real:
- a fresh, restore-verified backup of that database;
- confirmation that the deploy carries the F3c1 code (the migration alone is inert);
- no `SOURCE_CREDENTIAL_KEYS` is required for this step.

## Rolling it back

`docs/runbooks/source-connections-v27-rollback.sql`, one transaction, drops only what v27 created
and removes its `schema_migrations` row, and **refuses, dropping nothing, when any of these holds**
(after that only a forward migration is allowed):
- any connection, binding or audit row exists (the audit is append-only; history must not vanish);
- the host catalog is not exactly the v27 seed (`gpexe` / `e03`, its label, `approved`, its note):
  a later data-only migration approved another server, or a row was changed;
- any `migrations_v2` migration newer than v27 is recorded in `schema_migrations` (dropping v27
  under it would leave that migration recorded as applied on objects that no longer exist).

It never copies, exports or decrypts a credential and makes no "backup before drop" table. Every
older table keeps every row. Rehearsed by test 1 on disposable databases: apply → rollback on the
untouched seed (identical v26 catalog, older rows kept) → apply again (identical v27 catalog) →
a changed catalog row, a later migration recorded, and a real data-only migration approving a
test server are each refused with the catalog and both `schema_migrations` rows kept → first use
refused as well; on a fresh database a v27 broken at its last statement leaves nothing.

Prefer a forward migration to fix a problem found after v27 is applied anywhere real; the same
three rules bind it: never a decrypted credential in any copy, never a deleted or truncated audit
or binding row, and exact restoration of any trigger it replaces.

## What F3c1 does not do

No Connect / Reconnect / Test / Disconnect route, no Settings UI, no team-list discovery, no
GPEXE request, no cut-over of the importer (`GPEXE_API_TOKEN` and `gpexe_team_settings` work as
before), no row or binding for team 980, and nothing that reads or stores a UI JWT or session
cookie — those are the web application's own authentication and are never a server-to-server
credential.
