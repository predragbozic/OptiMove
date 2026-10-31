# J13 — phase 7g: ending a held source instance (D9) (proposed ★★ contract)

This is the contract of phase 7g of `docs/ai/metrics-core-plan.md` (phase 7: "7g: ending a held instance (D9 of the
discovery document)"). It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*):
D9 (lines 1589–1622), the T8 action `source_instance_end` (D10, line 1673), C36 (lines 398–402), C55, C57 (lines
550–556), C76, the M2 row of the plan table (line 1976: "the platform-admin operation that ends a held source
instance (D9)") and the K item of line 3861 ("the shape of the platform-admin operation that ends a held source
instance (D9)").

It is reviewed together with the 7e contract (`docs/ai/phase7e-aggregate-preview-contract.md`, J11) and the 7f
contract (`docs/ai/phase7f-extractor-registry-contract.md`, J12) in one ★★ round. The implementation is its own pull
request, 7g-B, with a migration that replaces a function body of v48 (7d-B): **7g-B's migration is written only
after v48 is merged and deployed**, against v48's body as merged (section 6.3).

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (queued at 18:31:50 UTC); revised after the internal reviews (section 11). |
| Verified against commit | `6a94ce29` (merge of PR #294) for `main`; v48 as on the 7d-B branch (PR #295, head `578717af`). Every file and line reference below is to `6a94ce29` unless it names another. |
| Migration | **Yes**: the next free number after v48 (**v49** if none comes between), proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_v49_source_instance_end.sql` (section 6). |
| **Owner decisions** | The owner's decisions of phases 7e–7g are numbered OD1–OD7 in all three contracts (J11 section 0.1). This contract needs **OD5**, the shape of the operation, **decided on 2026-10-30 as recommended, with the narrower reading** (the *Rukovodilac*'s reading of the owner's „5. to smo vec rekli dole”, turn `396e7078`): only an active platform admin in the platform workspace, a mandatory reason, refused while the owner team has an active binding of that source team (R2) or an open activation on the owner team's bindings of it (section 3.2). OD6 leaves D9 the platform admin's. |
| Decides | The *Rukovodilac*: R1–R6 (section 9). The owner: OD5 (decided). |

---

## 0. In short

- **What a held instance is:** a Metrics Core source connection (`training_load.metric_source_connections`, v11) owned
  by a team, whose write-once source instance (T7: `source_host_key`, `source_instance_key` = the GPEXE Team ID) is
  `active`. The partial unique of T7 allows one active instance per GPEXE team (v34 `:1458-1461`), so if the same GPEXE
  team is ever bound to another OptiMove team, that team's first M4 import is refused with `source_instance_held`
  until the old instance is ended.
- **The operation** (OD5, decided): an active platform admin in the platform workspace ends one instance with a
  reason. The row turns `inactive`; nothing is deleted or moved, and every historical fact keeps pointing to it (C36).
  An ended instance stays ended.
- **Refused while it is still in use:** an active binding of the owner team to that GPEXE team (R2), or an open
  activation on the owner team's bindings of that GPEXE team (OD5). Both are checked by the route **and by the
  database guard**, under the owner team's import lock.
- **Today nothing can be ended:** no code sets the T7 keys before M4, so every GPEXE connection answers
  `instance_not_held`. 7g-B is built and tested on fixtures, dormant until M4 writes its first instance.
- **The database guard** (C76): a v11 `state` change only as this operation's write, by the acting platform admin,
  with its `source_instance_end` audit row, once; an ended instance never returns to `active`.

## 1. What exists (verified)

- **`metric_source_connections`** (`migrations_v2/202609041500_training_load_v11_metrics_provenance.sql:30-45`): `id`,
  `source_system`, `owner_scope` (`system | club | team | user`) with its owner columns, `state` (`active` default,
  `inactive`), `created_at`. No `ended_at`, `ended_by` or `end_reason` column.
  - **T7** (v34 `:1448-1478`): `source_host_key`, `source_instance_key`, both NULL or both set; written once (NULL →
    value only), `23514` "metric_source_connections: the source instance of a connection is written once".
  - **Uniques:** one active instance per `(source_system, source_host_key, source_instance_key)` (v34 `:1458-1461`);
    one active GPEXE connection per team (`migrations_v2/202609171800_training_load_v20_gpexe_source_bindings.sql:140-144`).
  - **No trigger on `state`**: today `active → inactive` and back are unchecked UPDATEs, limited only by the two
    uniques. Only tests flip it.
  - **Referenced** (all RESTRICT or NO ACTION, nothing deletes): source identities (v11 `:124`), events (v12 `:47`),
    dashboard series (v16 `:367`), event bindings (v20 `:112`), the deletion log (v21 `:42`), roster observations
    (v25 `:647`), T6 provenance (v34 `:1492-1494`), T8 (v34 `:1690`, not indexed).
- **Writers and readers:** the only writer is the GPEXE import writer's `ensureSourceConnection`
  (`backend/src/gpexeImportWriter.js:137-158`): it finds the team's `active` GPEXE row without a lock or inserts one; it
  never sets the T7 keys and never updates a row. No code sets `inactive`. Readers of `state`: the writer (`:140`), the
  import preview (`backend/src/gpexeImportPreview.js:86-96, 228-233`), the settings blockers
  (`backend/src/gpexeImportService.js:185-187`, v24), the dashboards (v16 `:835-861`, a gate for a **new** series
  binding only, not retroactive: existing series keep working after an end), the T6 guard (v34 `:1547-1556`).
- **The documented lock order of every writer** (v34 `:38-49`): … → T5 → the team binding → the Metrics Core connection
  (`FOR SHARE`, only a new fact) → the acting user's rows. The T6 guard takes the binding and then the connection
  `FOR SHARE` (v34 `:1547-1553`); v16's series triggers take the connection `FOR SHARE` (v16 `:780, 851`).
- **The team import lock**, `training_load.hold_gpexe_team_lock(team, what)`
  (`migrations_v2/202609211000_training_load_v24_gpexe_settings_change_guard.sql:82-89`): a transaction-level try-lock
  that never waits. A bind takes it in the binding trigger (`migrations_v2/202609271000_training_load_v27_source_credential_connections.sql:323`),
  an Unbind too (`:374`), and so do a check, an import and a settings change (C57: the team lock first). It is the one
  point that serializes the **insert** of a new binding. "Never waits" holds for the try-lock only: the import writer
  takes the same key with the **blocking** `pg_advisory_xact_lock` (`lockTeamForImport`,
  `backend/src/gpexeImportWriter.js:599-602`), so a writer waits while 7g holds it. No cycle follows, because the
  writer takes the team lock first, before any row lock (C57), and 7g takes it before any row lock too (section 4).
- **T8's shape for `source_instance_end`** (`source_metric_audit_row_ok`, v34 `:1670-1671`; byte-identical in v48 on
  the 7d-B branch): only `metric_source_connection_id`, `team_id` optional; `from_status = 'active'`, `to_status =
  'inactive'`; `reason` required; `basis = 'platform_admin'`. Today every such insert ends at the revision guard's
  `23514` "source_metric_audit: no writer of this action exists yet" (v47 `:244-246`; v48 keeps it).
- **The link to a binding** is only the T6 guard (v34 `:1547-1556, 1601-1605`): the instance's `source_system` = the
  binding's, `source_host_key` = its credential connection's `host_key`, `source_instance_key` = the binding's
  `source_team_id`; the binding and the instance `active`. No foreign key either way.
- **Can a held instance arise for GPEXE?** Not today (no T7 keys are written), and after M4 only after an Unbind and a
  re-bind of the same GPEXE team to another OptiMove team, which v30 (`refuse_unapproved_gpexe_binding`,
  `migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql:111-141`;
  `gpexe_team_settings_canonical_team_id_key`, `:175-176`) and v24 (`refuse_gpexe_team_repoint`, `:96-161`) make
  unreachable for GPEXE. D9 calls the rule defence in depth; 7g is that defence's release valve for a future source.
- **The pre-M4 risk** (inference from the code): if a pre-M4 GPEXE connection were set `inactive`, the team's next
  import would insert a fresh connection and the per-connection event dedup (v20 `:74-83`) would let the same session
  in twice. 7g must therefore never touch a connection without T7 keys (R1).
- **The platform-admin gates** to copy: `mayMaintainConversions` (`backend/src/unitConversionService.js:59`),
  `mayVerify` (`backend/src/sourceFieldVerificationService.js:87`): a platform admin in the platform workspace; the
  write kit `runWrite` (`backend/src/sourceMetricMappingService.js:726-800`) and 7c's `retireConversion` pattern
  (`unitConversionService.js:237-281`).

## 2. Who (OD5, decided)

An active platform admin **in the platform workspace** only (the gate of `mayMaintainConversions`). Everyone else,
including a platform admin in a club workspace and every club admin, gets the identical 404 before the body or the
query is read. The instance is a fact of the whole platform (one GPEXE team across every club), so no club scope
applies.

## 3. The routes

### 3.1 `GET /api/training-load/sources/metrics/source-instances[?state=active|inactive|all][&sourceSystem=gpexe][&cursor=…]`

The gate first (the identical 404), then the query (`400 invalid_query` for an unknown or repeated parameter, a bad
`state` or a bad cursor). Pages of 100 by an opaque cursor (the last row's id); only **team-owned** connections
**with** T7 keys (an instance); `state` defaults to `active`. Each row carries **exactly** these keys:

```
{ "id", "sourceSystem", "sourceHostKey", "sourceInstanceKey", "state", "createdAt",
  "ownerTeamId", "ownerTeamName", "held", "endedAt" }
```

- `held` is `true` when an `active` binding of **another** OptiMove team names the same source system, host and source
  team, so the instance is what blocks that team. It is computed from `source_team_bindings` joined to its credential
  connection's `host_key` only (an explicit column list; no other column of `source_credential_connections` is ever
  selected).
- `endedAt` is the `performed_at` of the connection's `source_instance_end` audit row, or `null`.

### 3.2 `POST /api/training-load/sources/metrics/source-instances/:connectionId/end`

Body (exactly these keys): `{ "requestKey": "<uuid>", "reason": "<text>", "expected": { "sourceSystem",
"sourceHostKey", "sourceInstanceKey" } }`. `reason` follows the shared text rule of the M2 writes (C53, the database
text check).

Answers:

1. **401**; then **the identical 404**: not the gate; a malformed id; a connection that does not exist.
2. **415 / 400** for a body that is not a JSON object or has another shape.
3. **409** (after the locks of section 4), in this order, each with `current` carrying **exactly** the keys listed:
   1. `instance_not_held` (`current: { id }`): the connection has no T7 keys, or its owner is not a team (R1);
   2. `instance_mismatch` (`current`: the row of 3.1): `expected` differs from the row (a stale screen);
   3. `instance_already_ended` (`current`: the row of 3.1): `state` is `inactive`;
   4. `instance_binding_active` (`current: { bindingId, teamId }`, R2): the owner team has an `active` binding naming
      the same source system, host and source team; ending would only make its next import create a second instance;
   5. `instance_in_use` (`current: { activationId, bindingId }`, OD5): an open T5 activation exists on a binding of
      the owner team naming the same source system, host and source team (an ended binding's open activation
      included, C58): end it first (S2). *Decided with OD5 (the narrower reading):* "that source's bindings" are the
      owner team's bindings of that source team; the new team's activations are its own and do not block the end.
   6. `try_again`: the team import lock is held (a check, import, bind, Unbind or settings change runs for the owner
      team), or a row lock is not granted within the bound. The service learns the first from its own try-lock's
      boolean (section 4, step 2), never from a database text: `hold_gpexe_team_lock`'s `P0001` carries the team's id
      and is never mapped (C72).
4. **200** `{ "instance": <the row as in 3.1, state inactive> }`, with the usual replay (`replayed: true`),
   `request_key_reused`, `verified_after_commit_error` and `503 outcome_unknown` of `runWrite`.

## 4. The write, in the documented lock order

One operation in `runWrite`'s transaction (the per-user lock, the request record, the acting user, the bounded COMMIT):

1. the connection **read without a lock** (its owner team and T7 keys; the keys never change once set, v34's
   write-once trigger; the owner may still change on a connection no event or identity uses, v11 `protect_ownership`
   `:52-70`, so step 6 compares it again);
2. **the owner team's import lock**, taken by the service itself:
   `select pg_try_advisory_xact_lock(hashtextextended('gpexe-import-team:' || $1::uuid::text, 21))`, the key in
   canonical lower case, the same key as `hold_gpexe_team_lock` and `lockTeamForImport`. On `false` the answer is
   `try_again`; no database text is mapped (C72). It is the lock a bind, an Unbind, a check and an import take first,
   so no binding of the owner team can be inserted or ended while the end runs. The guard's own
   `hold_gpexe_team_lock` (section 6, item 1) is then re-entrant and always succeeds; it serves only a raw writer,
   which gets the lock there or is refused while another transaction holds it;
3. the owner team's bindings naming that source system and source team `FOR SHARE`, in ascending id (never stronger
   than `FOR SHARE`, R5), then their open T5 rows (a plain read: no S1 can start on them, section 5);
4. the v11 row `FOR NO KEY UPDATE` (after the bindings, as D's order: binding → Metrics Core connection; it waits for an
   import in flight that holds it `FOR SHARE` or `FOR UPDATE`, C55 and C57, bounded → `try_again`);
5. `rightsStillHold` (the platform admin's role and user rows `FOR SHARE`);
6. the locked row's `owner_team_id` compared with step 1's (`try_again` on a difference), then the checks of section
   3.2, step 3, on the locked and re-read row;
7. `update metric_source_connections set state = 'inactive' where id = $1`;
8. the T8 row `source_instance_end`: `metric_source_connection_id`, `team_id` = the owner team, `from_status 'active'`,
   `to_status 'inactive'`, `reason`, `basis 'platform_admin'`, the operation id, the request key and hash (the keyed
   row is the only row).

Nothing else changes: no event, identity, occasion, value, provenance, binding or dashboard row; no history moves
(C36).

## 5. Concurrency

- **Against a bind of the owner team** (an INSERT of a new binding): both take the owner team's import lock first; the
  second gets `try_again`. A bind that committed before the end makes the end answer `instance_binding_active`; a bind
  after the end's COMMIT meets an `inactive` instance, and M4 then creates the team's own new instance (C36).
- **Against an Unbind** of the owner team: the same team lock.
- **Against M4's writer** (C57: the team lock first, then the connection `FOR UPDATE` for events and identities and
  `FOR SHARE` for T6): the team lock serializes them. The writer's lock is blocking (`gpexeImportWriter.js:601`): a
  writer that starts while 7g holds the lock waits for 7g's COMMIT and then meets an `inactive` instance; 7g that
  starts while a writer holds it gets `try_again`. A writer that holds the connection without the team lock (none
  today) would be waited for at step 4. The M4 writer must read `state` under its own `FOR UPDATE` and refuse an
  `inactive` connection (a prerequisite recorded for M4; today's `ensureSourceConnection` reads it unlocked).
- **Against a T6 insert** (binding `FOR SHARE` → connection `FOR SHARE`): 7g takes the binding `FOR SHARE` before the
  connection, the same order, so no cycle; and only `FOR SHARE` on the binding (R5).
- **Against S1** on the owner team's binding: S1 needs an `active` binding; with step 3.2.4 refusing one, an S1 that
  lands after the end meets an ended binding (`binding_not_active`).
- **Against S2** ending one of the open activations: S2 takes T5 `FOR NO KEY UPDATE`; 7g only reads T5 (an end that
  commits first lets the 7g check pass; one that commits after it leaves nothing open).

## 6. The migration (v49, proposed)

1. **The v11 state guard** (`BEFORE UPDATE OF state` on `metric_source_connections`, `WHEN (old.state is distinct
   from new.state)`, so `set state = state` passes):
   - `inactive → active` is always refused: `23514` "metric_source_connections: an ended source instance is final";
   - `active → inactive` only when the row has T7 keys and `owner_scope = 'team'` (`23514`
     "metric_source_connections: only a team's source instance is ended"); the acting user from
     `source_metric_context_actor()` (v35's transaction-bound setting) with `source_metric_actor_basis(actor, null) =
     'platform_admin'` (`42501` "metric source connection: the acting user may not end this source instance");
   - the guard itself takes `hold_gpexe_team_lock(old.owner_team_id, 'ending a source instance')` (a re-entrant
     try-lock: the route already holds it; a raw writer that sets the actor gets it here or a refusal), so the checks
     below are authoritative for every writer, not only for the route;
   - **the in-use checks again, as plain reads under that lock:** no `active` binding of the owner team
     naming the same source system, host and source team (`23514` "…: the owner team still holds an active binding of
     this source team"), and no open T5 activation on the owner team's bindings of it (`23514` "…: an activation of
     this source team is still open"); the indexes exist (`source_team_bindings_team_idx`, v27 `:293`;
     `source_metric_activations_binding_idx`, v34 `:1348`);
   - an INSERT (the importer's) is untouched.
2. **A deferred constraint trigger** on that UPDATE (`WHEN (old.state is distinct from new.state)`): at COMMIT, the
   transaction holds the connection's `source_instance_end` audit row (`23514` "metric_source_connections: a source
   instance is ended with its audit row").
3. **T8:** the revision guard's body — **v48's body as merged**, replaced in full, with the new branch inserted
   before the final "no writer of this action exists yet" refusal. The migration first asserts in a `DO` block that
   `md5(prosrc)` of the body in force equals v48's (refused otherwise, before any change). The branch: the named
   connection is `inactive`, has T7 keys and `owner_scope = 'team'`; its row's `xmin` is the current transaction
   (`source_metric_current_xmin()`); `team_id` equals its `owner_team_id`; the reason is non-empty; the row is the
   connection's only one. v35's actor guard already admits an active platform admin with `basis = 'platform_admin'`
   for this action (v35 `:227-233`), so it is unchanged. A unique partial index makes "once" physical and also covers
   T8's unindexed foreign key: `source_metric_audit_v49_instance_end_once (metric_source_connection_id) where action =
   'source_instance_end'`.
4. **Locks**, at the top, in this order (the v47 pattern): `lock table training_load.metric_source_connections in
   share row exclusive mode; lock table training_load.source_metric_audit in share row exclusive mode;` — the 7g
   writer takes the connection, then the audit table, and other audit writers touch the connection only through this
   action's foreign key.
5. **Rollback, read-only preflight, post-check, runbook** (as v47 and v48):
   - the rollback refuses under a later migration, once any `source_instance_end` row exists or any keyed connection is
     `inactive`, and restores v48's body verbatim;
   - the preflight shows v48 as the last migration, the md5 of the guard body v49 replaces, and counts connections
     with T7 keys and inactive keyed ones (both expected 0 before M4);
   - the post-check shows the recorded checksum, the guard's md5, the two triggers enabled (the deferred one
     deferrable and initially deferred), the index valid;
   - `.gitattributes` gains `docs/runbooks/source-instance-end-v49*.sql text eol=lf`, as v42–v48 did, so the md5 of
     v48's body restored by the rollback stays stable across checkouts.

**Existing tests that change `state` raw** must switch the guard off in their own disposable database, since the
guarded path can never go `inactive → active` and never touches a keyless connection:
`backend/tests/source-metric-mapping-m1.test.mjs:1058, 1061, 1062, 1103, 1416` and
`backend/tests/gpexe-undo-guards.test.mjs:201`. The switch-off covers only the fixture blocks that change `state`
directly and is undone right after them, as 7c does for v47 (the *Rukovodilac*'s note (ii) at 7c's GO). No production
code changes `state`.

## 7. Security and privacy

- The only audience is a platform admin in the platform workspace; the identical 404 for everyone else, before the
  body or the query is validated.
- Every answer carries only the keys listed in section 3 (a GPEXE Team ID, not personal data, which a platform admin
  already sees in Settings → Data sources; a team id and name); never a credential column, a reason, an acting user or
  a database text.
- The reason is written to the audit row only.
- The guard holds against a raw writer that sets the actor (C74's stated limit: not against the migration role).

## 8. Tests (7g-B)

- **The migration:** applied by the runner on v48 with no deadlock against a reader of v11; the `DO` assertion refuses
  a body that is not v48's; the guard's refusals in direct SQL (no actor, a club admin, a connection without keys, a
  club-owned connection, `inactive → active`, `set state = state` passing, an end with an active binding of the owner
  team, an end with an open activation, an end without its audit row at COMMIT, a second audit row, an audit row
  naming a connection not ended in this transaction, a savepoint); the rehearsed rollback back to v48's catalog
  exactly, and v49 again.
- **The routes:** 401; the identical 404 for a club admin, a platform admin in a club workspace, a coach, an unknown id
  (the GET list also with a bad query, still 404); 415 / 400; each 409 of section 3.2 in its order; the 200 and its
  replay, `request_key_reused`, the lost COMMIT (`verified_after_commit_error`, `outcome_unknown`) through the real
  route.
- **The keys:** the exact key set of a list row, of the 200 and of each 409's `current`; a secret scan of every answer
  for credential ciphertext, key version and account label.
- **The list:** only team-owned connections with keys; `held` true and false; pages of 100.
- **Concurrency:** an end against a bind of the owner team to the same source team, both orders (the second gets
  `try_again`, or the end answers `instance_binding_active`); against an Unbind; against an importing transaction
  holding the connection `FOR SHARE`; against a T6 insert in D's order (no `40P01`), and a mutation that takes the
  binding `FOR UPDATE` must then fail the test; against S1 on the owner team's binding.
- **Nothing else changes:** events, identities, values, provenance and dashboard rows of the instance are
  byte-identical before and after.
- **The raw-flip fixtures:** the guard is switched off only around the fixture blocks of section 6 and switched on
  again right after them; an architecture test asserts that no module of `backend/src` runs `disable trigger` (7c's
  test 13).
- **The team lock:** a held lock answers `try_again` from the try-lock's boolean, and no answer carries a database
  text; a raw writer that sets the actor while another transaction holds the lock meets the guard's
  `hold_gpexe_team_lock` refusal.
- **Mutations** of every guard branch, the order of the 409s and the state checks.

## 9. Decisions for the *Rukovodilac*

- **R1 — only a team-owned connection with T7 keys is an instance** (`instance_not_held` otherwise), so 7g can never
  reopen the pre-M4 double-import risk and never meets an owner without a team. Recommended.
- **R2 — `instance_binding_active`:** refuse while the owner team still has an active binding to the same GPEXE team.
  Recommended: D9's purpose is the release after a re-bind; an instance in use is not "held".
- **R3 — the list route** (3.1), with `held`. Recommended: the admin needs to find what to end.
- **R4 — an ended instance is final in the database** (`inactive → active` refused). Recommended: C36 says the old
  instance is ended and the new team's writer creates its own.
- **R5 — the documented lock order** (section 4: the team lock, the bindings `FOR SHARE`, then the connection), never
  more than `FOR SHARE` on a binding. Recommended.
- **R6 — 7g-B may be built before M4** and stays dormant (every GPEXE connection answers `instance_not_held`) until M4
  writes T7 keys; its migration is written after v48 is merged and deployed. Recommended.

## 10. Not in this contract

M4 (writing T7 keys, `source_instance_held`, `session_imported_under_another_instance`, reading `state` under its own
lock), any frontend, any production write, a re-activation, a move of history between teams, a delete.

## 11. Review record

- **Internal round 1 (head `e8060485`):** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, no BLOCKER or HIGH. Applied in this revision: a bind is an INSERT, so the owner team's import lock
  serializes it (code and db MEDIUM); the documented lock order, bindings before the connection, and the false "no path"
  sentence removed (code and db MEDIUM); R1 includes `owner_scope = 'team'` and the in-use checks are repeated in the
  database guard (db MEDIUM); v49 is written against v48's merged body with an md5 assertion (db MEDIUM); OD5's
  narrowing marked as an interpretation (code LOW); the exact key sets and a secret scan, the gate before the query, the
  guard's `WHEN` clause and v35's actor functions (security LOW); the lock modes, the post-check and the full list of
  raw-flip tests (db LOW).
- **Narrow re-reviews of `e8060485..f8768e3a`:** `code-reviewer`, `db-reviewer`, `security-reviewer`, each READY WITH
  NON-BLOCKING NOTES, every earlier finding closed. Their LOW notes applied without a further review: the preview's size
  bound measures the uncompressed text (J11 R7); the 7g guard takes the owner team's lock itself and step 6 re-compares
  the owner (J13); `.gitattributes` for v49's runbook SQL (J13); the C97 blocks drop the read-only wrapper (the editor
  may show only the last statement), cast safely, count every whole-session row per athlete, and say they approximate
  the mapper's gates.
- **External round (head `fedabc65`):** the *Nezavisni revizor* and the *Rukovodilac*, both GO with non-blocking
  notes. Applied by the *Rukovodilac*'s decision, one new head with a narrow re-review: the service takes the team
  lock itself and answers `try_again` from its boolean, never from `P0001` text (C72); "never waits" limited to the
  try-lock, with the import writer's blocking lock; the guard's switch-off only around the raw-flip fixture blocks,
  with the architecture test against `disable trigger`. Both narrow re-GOs on `d85160e0`.
- **The owner's decisions (the next head):** OD5 written as decided, with the narrower reading; a narrow re-review of
  the delta by both.
