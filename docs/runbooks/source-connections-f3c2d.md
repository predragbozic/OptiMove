# Source connections — Connect / Reconnect / Test (F3c2d) and the team binding (F3c2e)

Backend routes for a source credential connection: create it, attach a credential by a
one-time username/password exchange, test it with the stored token, replace the
credential. Contract: `docs/ai/source-connections-f3c2-contract.md` section 2 (and its
section 2.5, "F3c2d as built"). Schema: v27 (`source-connections-v27.md`), v28 (the
`server3` catalog row) and v29 (this step: two state/fact CHECKs and the per-user throttle
index; rollback `source-connections-v29-rollback.sql`).

Nothing here imports data, binds a team, lists a team to choose from, or touches
`gpexe_team_settings`. The first real profile is GPEXE on `server3` (`rest/v1`); there is
no fallback to `e03`, no typed URL and no generic proxy.

## Who

The **owning club's admin**, acting in that club's workspace, or an **active platform admin**
acting in the platform workspace or in the owning club's workspace (owner decision 2026-10-03).
Everyone else — another club's admin, an admin of two clubs acting in the other club's
workspace, a coach, an athlete, a revoked role —, every other workspace, an archived or
missing club or team, a foreign team, a malformed id and an unknown source answer the same
`404 {error: "notFound"}`. Without a session: `401`. The right and the club are checked again,
by basis, after every source call and before any write (`409 rights_changed`); every audit row
carries the basis (`club_admin` or `platform_admin`).

## Routes (mounted at `/api/training-load/sources`)

| Route | Body | What happens |
|---|---|---|
| `GET /:source/connections?clubId=` | — | the club's connections: state, facts, labels, bound teams; never a credential part, never a username |
| `GET /:source/connections/:id` | — | one connection, same fields |
| `POST /:source/connections` | `{ ownerScope: "club", ownerClubId, hostKey, accountLabel, credentialKind: "exchanged_token" }` | one `not_connected` row and an audit row `create`. The host must be approved in the catalog **and** resolvable in `sourceHosts.js` **and** have a confirmed exchange **and** speak a family with a read adapter — today only `server3` |
| `POST /:source/connections/:id/connect` | `{ username, password }` | state must be `not_connected`; one exchange POST, then the test reads with the issued token; the token is stored AES-256-GCM; the username and password are dropped |
| `POST /:source/connections/:id/reconnect` | `{ username, password, confirmation: { sourceSystem, ownerClubId, affectedTeamCount } }` | state must hold a credential; the confirmation must name the connection's source, owning club and current number of active bound teams exactly, or `409 confirmation_mismatch` (the answer carries `expected`) before anything is sent; otherwise as connect, with a new ciphertext and nonce |
| `POST /:source/connections/:id/test` | `{}` | the stored token on exactly the chosen host: the first page of the team list (each team as its canonical id and a sanitized name — `result.sourceTeams`, for the administrator to choose one from; nothing is preselected or bound) and then every active bound team's own read (`team/<id>/`) |
| `POST /:source/connections/:id/bindings` | `{ teamId, sourceTeamId }` | F3c2e: bind one OptiMove team of the owning club to the chosen source team — state must be `verified`; the chosen team is read again, alone (`GET team/<sourceTeamId>/`), before the row is written; `201` with the binding, `200` with `idempotent: true` for the same binding again; see "Binding a team" below |

Every write needs a JSON object body (`415` otherwise); a body with a field the route does
not take is `400 invalid_body` and is not an attempt.

## One attempt, in order

1. the per-user advisory lock (`source-auth-throttle:<user>`) — one user's attempts are
   serialized across all connections, waiting at most 20 s (`try_again` after that; that one
   statement runs under a 22 s `statement_timeout` so the lock bound decides); every other
   statement of the attempt has a 10 s `statement_timeout`, the transaction a bounded idle
   time, and the source calls a 90 s budget in total;
2. the connection row `FOR NO KEY UPDATE` under a 2 s `lock_timeout` → `409 try_again`
   when another attempt holds it (a refused attempt's audit row needs only KEY SHARE and
   never waits);
3. the bound teams (ascending), then the reconnect confirmation against them;
4. the catalog row `FOR SHARE` + `resolveApprovedSourceHost()` → `409 host_not_allowed`
   with zero requests when the key was retired meanwhile;
5. every bound team's import lock, try-lock style (`hold_gpexe_team_lock`) → `409
   try_again` (names the team) when a check, import or connection change runs;
6. the throttle: logical attempts that **really sent a request to the source** in the last 15
   minutes, per connection and per user, counted from the append-only audit as distinct
   `attempt_id`s (an attempt's committed row and a later `unknown` row count once); 5 or more
   → `429 source_auth_throttled` (`Retry-After: 900`). Refusals that never reached the source
   (throttled, `host_not_allowed`, `try_again`, `key_missing`, `network_budget_exhausted`,
   `attempt_not_sent`, state
   and confirmation refusals) are audited with `counted: false` and never extend the window;
7. the key ring (`SOURCE_CREDENTIAL_KEYS`) → `503 key_missing` with zero requests;
8. the network: the exchange (connect / reconnect) and the test reads; then the row, the
   audit row and the COMMIT.

## Outcomes and states

| Source answer | Code | After connect / reconnect | After test |
|---|---|---|---|
| exchange 400 / 401 / 403 | `source_auth_rejected` (`409`) | nothing stored, state unchanged; audit `refused`, counted | — |
| exchange 429 / 5xx / network / timeout | `source_unavailable` (`502`) | nothing stored; audit `failed`, counted | — |
| exchange redirect, oversized, not JSON, no token field | `source_answer_unexpected` (`502`) | nothing stored; audit `failed`, counted | — |
| test reads ok | — | `verified`, `last_verified_at` | `verified`, error facts cleared |
| test read 401 (or 403 on the team list count) | `source_auth_rejected` | credential stored, `needs_reconnect` | `needs_reconnect`, ciphertext kept |
| test read 5xx / timeout | `source_unavailable` | credential stored, `linked_untested` with facts | `source_unavailable` |
| bound team 403 / 404 (the account cannot read that team) | `source_team_not_visible` | credential stored, `linked_untested` | `source_unavailable` with that code |
| the source reached, then the row could not be written (database failure, a right revoked meanwhile) | `attempt_not_recorded` (`500`) / `rights_changed` (`409`) | nothing stored; audited `unknown` / `failed` **in the attempt's own transaction** (back to the savepoint taken after the locks, then the bounded COMMIT), so the user's next attempt, waiting on the per-user lock, already counts it; **counted**; a `try_again` at that point also discards the issued token, so the pair has to be entered again | same |
| other shape | `source_answer_unexpected` | credential stored, `linked_untested` | `source_unavailable` |

The answer of a successful attempt is `{ result: { outcome, state, code, boundTeamsChecked,
sourceTeamCount, exchangeStatusClass }, connection }`. A COMMIT whose answer was lost is
verified on a fresh connection inside the request (`commitConfirmation:
"verified_after_commit_error"`); when that cannot resolve it, `503 outcome_unknown` with
a second audit row `unknown` by the same admin — read the connection's state, do not
resend the credentials blindly.

## Audit

One row per attempt (`connect` / `reconnect` / `test`, outcome `ok` / `refused` / `failed`
/ `unknown`), `metadata` from a fixed allowlist only: `host_key`, `credential_kind`,
`status_class`, `attempt_no`, `bound_team_count`, `source_team_count`, `counted`. Never a
credential, a username, a header value or a source sentence; the v27 trigger refuses a
secret-named key as the backstop.

## Operational notes

- The server starts without `SOURCE_CREDENTIAL_KEYS`; every attempt then answers
  `key_missing` and sends nothing. A stored credential that no longer decrypts (key
  version gone, row context changed) answers `credential_unreadable` — reconnect.
- Disconnect, bindings through a route, `api_token` entry, club-admin management and any
  import are not part of this step.
- Every refusal (also a throttled one) appends an audit row; a platform admin's burst of
  refusals grows the append-only table, which is accepted (no leak, no lockout effect).
- Before v29 is applied to a persistent database that already holds connection rows (none
  exists today), a read-only check that no row violates the new CHECKs:
  `select count(*) from training_load.source_credential_connections where (state = 'linked_untested' and (last_error_code is null or last_error_at is null)) or (state <> 'not_connected' and credential_ciphertext is null)` — expected 0.
- v29 on a persistent database is applied only by the owner's explicit decision
  (`.claude/rules/database-safety.md`); its rollback refuses once a later migration is
  recorded.

## Binding a team (F3c2e)

**The allowlist (owner decision 2026-10-04).** A team's existing GPEXE Team ID in Settings →
Data sources (`gpexe_team_settings`, set by a platform admin with a reason and a history) is the
approved pair `OptiMove team ↔ GPEXE Team ID`. A binding can only bind that exact pair, whoever
asks; nobody adds a Team ID through the bind route. A club admin sees and may choose only the
GPEXE teams that match an approved pair of an active team of their club (`result.sourceTeams`
of Connect / Test is that intersection — `sourceTeamId`, `name`, `approvedTeamId`,
`approvedTeamName` — and `sourceTeamCount` its size; nothing of the other teams the shared
account sees leaves the server); a platform admin sees the bounded list with the approved pair
per row, for support and for setting the allowlist. `sourceTeamsTruncated` says whether the
source list was cut at one page. While a binding is active the approved Team ID cannot change:
the F3b `PUT …/settings` answers `409 gpexe_team_bound`; a raw UPDATE meets the v30 trigger. The
same value stays idempotent; without an active binding the change works as before.

The flow in Settings is Connect account → Test connection → Choose GPEXE team (from
`result.sourceTeams`) → Choose the approved OptiMove team → Review → Confirm binding. The route
does the last step; it never chooses a team itself and never binds any of the teams the account
sees automatically.

Order of one bind (one transaction, the same shape as an attempt): the body (`400
invalid_body` for anything but a team UUID and a canonical source team id) → the connection
and the team read unlocked (`404` unless the team exists, is active and is in the owning
club) → the per-user lock → the connection row (`409 try_again` when busy) → the same binding
again answers `200 idempotent` with no row, no request and no audit row, whatever the state →
`409 connection_not_verified` unless `verified` → this team already bound for this source → `409
team_already_bound` → the catalog row and the host gate (`409 host_not_allowed`) → every bound
team's and the target team's import try-lock, ascending (`409 try_again` while a Check now, an
import, a settings change, a team move or another binding runs for any of them) → the team's
approved pair: no setting → `409 team_setting_missing`; a different canonical Team ID → `409
team_setting_mismatch`; the same → the binding carries the provenance pointer; the setting and
its history are never written → the 5 / 15 min window
(`429 source_auth_throttled` when full) → the key ring and the credential (`503 key_missing` /
`credential_unreadable`) → one `GET team/<sourceTeamId>/` with the stored token → the right and
the club re-checked (`409 rights_changed`) → the team row, re-checked (archived or moved
meanwhile → `404`, nothing bound) → a source team already bound to another team → `409
source_team_already_bound` (answered only for a team the credential really sees) → the binding
row and its audit row `bind` → the bounded COMMIT.

| The chosen team's read | Answer | Connection state | Bound |
|---|---|---|---|
| `200` naming the team | `201`, the binding | unchanged | yes |
| `401` | `409 source_auth_rejected` | `needs_reconnect` | no |
| `403`, `404` | `409 source_team_not_visible` | unchanged | no |
| `429`, 5xx, network, timeout | `502 source_unavailable` | unchanged | no |
| redirect, oversized, not JSON, another id, not an object | `502 source_answer_unexpected` | unchanged | no |

Every outcome that reached the source is audited (`bind`, the team, `source_team_id` as a
fact; `counted: true` when it did not succeed, `counted: false` for a successful bind, which the
window never counts); a local refusal is audited with `counted: false`; a `404` answered
before anything was sent is not audited, while a team that stopped qualifying after the
source answered (archived or moved meanwhile) is the same 404 but audited and counted
(`failed`, `team_not_available`; a refused credential still turns the connection to
`needs_reconnect` first). A bind that reached the source without succeeding counts in the
5 / 15 min window like a credential attempt (a successful bind does not). A lost
COMMIT answer follows the attempt discipline (`commitConfirmation: verified_after_commit_error`,
or `503 outcome_unknown` with `teamId`, a second `unknown` audit row naming the team, and the
retry answering the existing binding without a second row). Unbind, Disconnect and replacing
a binding do not exist in this step. The database's own refusals surface as stable codes
(`team_already_bound` / `source_team_already_bound`, `try_again`, `binding_refused`), never as
SQL text; a lock wait that ran out or a deadlock chosen as victim is `try_again`.

### v30 (F3c2e): the approved pair is final while bound

`migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql` adds
`training_load.gpexe_team_id_canonical(text)`, the trigger
`gpexe_team_settings_bound_team_final` (BEFORE UPDATE: while a team has an active gpexe
`source_team_binding`, an UPDATE that changes the canonical GPEXE Team ID or the OptiMove team of
its settings row is refused — `23514`, that constraint name; the same canonical value passes),
the trigger `source_team_bindings_check_pair` (BEFORE INSERT: an active gpexe binding must point
at its own team's settings row, that row must exist, and the canonical ids must be equal —
`23514`, constraint `source_team_bindings_approved_pair`, or `…_approved_pair_missing` when the
team has no settings row; the service answers `binding_refused`
for it, having checked the pair itself first), and the unique index
`gpexe_team_settings_canonical_team_id_key` (one OptiMove team per canonical GPEXE team; the
service answers `gpexe_team_taken`). The migration refuses, changing nothing, when canonical
duplicates already exist (resolve them by hand through Settings, with a reason) or when an
active gpexe binding is not its team's approved pair (none can exist on any known database).
Because `npm start` runs the migrations before the server, a refusal would stop that deploy
from starting (fail-closed, nothing changed); the owner's read-only preflight before a deploy
that applies v30 is, on that database (the canonical function does not exist before v30):

```sql
select regexp_replace(gpexe_team_id, '^0+([0-9])', '\1') as canonical, count(*)
  from training_load.gpexe_team_settings group by 1 having count(*) > 1;
select count(*) from training_load.source_team_bindings b
  left join training_load.gpexe_team_settings s on s.owner_team_id = b.team_id
 where b.source_system = 'gpexe' and b.state = 'active'
   and (b.legacy_gpexe_settings_team_id is distinct from b.team_id or s.owner_team_id is null
        or regexp_replace(s.gpexe_team_id, '^0+([0-9])', '\1') <> b.source_team_id);
```

Both must return no row / 0. The guarantee is scoped to `gpexe`; a future source needs its own
approved-pair rule before it gets a bind route. DELETE /
TRUNCATE / repoint stay refused by v24 for every row. No data change. **Not applied to
any persistent database by this step** (the local OPTIMOVE stays v21; the deployed database gets
it only through a merge and deploy the owner decides). Rollback:
`docs/runbooks/source-connections-v30-rollback.sql` — refuses under a later migration and while
an active gpexe binding of a team with a settings row relies on the protection; rehearsed on a
disposable database (apply on v29 → invariants → rollback → identical v29 catalog → apply again →
refusals; a file failing at its last statement applies nothing).

### Recorded limits of F3c2e (non-blocking, for the owner)

- No Unbind / end-binding route exists yet: a bound pair is permanent in practice, the approved
  Team ID cannot change while it is bound (`409 gpexe_team_bound`), and the v30 rollback refuses
  while such a binding exists. A wrongly approved pair that was bound has no supported correction
  until the unbind step; schedule it before the first real bind.
- The approved pair is guaranteed by the database in both directions since the second form of
  v30 (the INSERT trigger and the canonical unique index); the application checks it first and
  answers the readable codes. Rows from before v30 are refused by the migration itself when they
  are canonical duplicates; none exist on any known database.
- `sourceTeamsTruncated` is reported to a club admin too (owner order 2026-10-04: the filtering
  must not hide a truncated source list); it tells only that the account's list was cut at one
  page, never a count.
- The F3b Settings screen has no sentence for `gpexe_team_bound` yet (frontend follow-up).
- `team_setting_missing` / `team_setting_mismatch` name "Settings → Data sources" for any source;
  a second source will need its own allowlist wording.
