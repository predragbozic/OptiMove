# Source connections — Connect / Reconnect / Test (F3c2d)

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

An **active platform admin** only, acting in the platform workspace or in the owning
club's workspace (when that admin is also that club's admin). Everyone else, every other
workspace, an archived or missing club, a malformed id and an unknown source answer the
same `404 {error: "notFound"}`. Without a session: `401`.

## Routes (mounted at `/api/training-load/sources`)

| Route | Body | What happens |
|---|---|---|
| `GET /:source/connections?clubId=` | — | the club's connections: state, facts, labels, bound teams; never a credential part, never a username |
| `GET /:source/connections/:id` | — | one connection, same fields |
| `POST /:source/connections` | `{ ownerScope: "club", ownerClubId, hostKey, accountLabel, credentialKind: "exchanged_token" }` | one `not_connected` row and an audit row `create`. The host must be approved in the catalog **and** resolvable in `sourceHosts.js` **and** have a confirmed exchange **and** speak a family with a read adapter — today only `server3` |
| `POST /:source/connections/:id/connect` | `{ username, password }` | state must be `not_connected`; one exchange POST, then the test reads with the issued token; the token is stored AES-256-GCM; the username and password are dropped |
| `POST /:source/connections/:id/reconnect` | `{ username, password, confirmation: { sourceSystem, ownerClubId, affectedTeamCount } }` | state must hold a credential; the confirmation must name the connection's source, owning club and current number of active bound teams exactly, or `409 confirmation_mismatch` (the answer carries `expected`) before anything is sent; otherwise as connect, with a new ciphertext and nonce |
| `POST /:source/connections/:id/test` | `{}` | the stored token on exactly the chosen host: every active bound team's own read (`team/<id>/`), or, while no team is bound, the team list count; nothing is chosen or bound from that list |

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
