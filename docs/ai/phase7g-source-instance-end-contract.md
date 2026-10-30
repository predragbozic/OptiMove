# J13 — phase 7g: ending a held source instance (D9) (proposed ★★ contract)

This is the contract of phase 7g of `docs/ai/metrics-core-plan.md` (phase 7: "7g: ending a held instance (D9 of the
discovery document)"). It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*):
D9 (lines 1589–1622), the T8 action `source_instance_end` (D10, line 1673), C36 (lines 398–402), C55, C57 (lines
550–556), C76, the M2 row of the plan table (line 1976: "the platform-admin operation that ends a held source
instance (D9)") and the K item of line 3861 ("the shape of the platform-admin operation that ends a held source
instance (D9)").

It is reviewed together with the 7e contract (`docs/ai/phase7e-aggregate-preview-contract.md`, J11) and the 7f
contract (`docs/ai/phase7f-extractor-registry-contract.md`, J12) in one ★★ round. The implementation is its own pull
request, 7g-B, with a migration that replaces a function body of v48 (7d-B), so **7g-B comes after 7d-B**.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (queued at 18:31:50 UTC). |
| Verified against commit | `6a94ce29` (merge of PR #294) for `main`; v48 as on the 7d-B branch (PR #295, head `578717af`). Every file and line reference below is to `6a94ce29` unless it names another. |
| Migration | **Yes**: the next free number after v48 (**v49** if none comes between), proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_v49_source_instance_end.sql` (section 6). |
| **Pending owner** | **P4**, the shape of the operation (section K, line 3861). The *Rukovodilac* put it to the owner on 2026-10-30 with this recommendation, which the contract is written with, marked **pending owner**: only an active platform admin in the platform workspace, a mandatory reason, refused while an open activation exists on that source's bindings. |
| Decides | The *Rukovodilac*: R1–R5 (section 9). The owner: P4. |

---

## 0. In short

- **What a held instance is:** a Metrics Core source connection (`training_load.metric_source_connections`, v11) whose
  write-once source instance (T7: `source_host_key`, `source_instance_key` = the GPEXE Team ID) is `active`. The
  partial unique of T7 allows one active instance per GPEXE team (v34 `:1458-1461`), so if the same GPEXE team is ever
  bound to another OptiMove team, that team's first M4 import is refused with `source_instance_held` until the old
  instance is ended.
- **The operation:** an active platform admin in the platform workspace ends one instance with a reason (P4). The row
  turns `inactive`; nothing is deleted or moved, and every historical fact keeps pointing to it (C36). An ended
  instance stays ended.
- **Refused while it is still in use** (P4): an open activation on the old team's bindings of that GPEXE team, or an
  active binding of the old team to that GPEXE team (R2).
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
  (`backend/src/gpexeImportWriter.js:137-158`): it finds the team's `active` GPEXE row or inserts one; it never sets the
  T7 keys and never updates a row. No code sets `inactive`. Readers of `state`: the writer (`:140`), the import preview
  (`backend/src/gpexeImportPreview.js:86-96, 228-233`), the settings blockers (`backend/src/gpexeImportService.js:185-187`,
  v24), the dashboards (v16 `:844-861`), the T6 guard (v34 `:1552-1556`).
- **T8's shape for `source_instance_end`** (`source_metric_audit_row_ok`, v34 `:1670-1671`; byte-identical in v48 on the
  7d-B branch): only `metric_source_connection_id`, `team_id` optional; `from_status = 'active'`, `to_status =
  'inactive'`; `reason` required; `basis = 'platform_admin'`. Today every such insert ends at the revision guard's
  `23514` "source_metric_audit: no writer of this action exists yet" (v47 `:244-246`; v48 keeps it, its header `:41-53`).
- **The link to a binding** is only the T6 guard (v34 `:1547-1556, 1601-1605`): the instance's `source_system` = the
  binding's, `source_host_key` = its credential connection's `host_key`, `source_instance_key` = the binding's
  `source_team_id`; the binding and the instance `active`. No foreign key either way.
- **Can a held instance arise for GPEXE?** Not today (no T7 keys are written), and after M4 only after an Unbind and a
  re-bind of the same GPEXE team to another OptiMove team, which v30 (`refuse_unapproved_gpexe_binding`,
  `migrations_v2/202610041000_training_load_v30_gpexe_team_settings_bound_final.sql:111-141`; `gpexe_team_settings_canonical_team_id_key`, `:175-176`)
  and v24 (`refuse_gpexe_team_repoint`, `:96-161`) make unreachable for GPEXE. D9 calls the rule defence in depth; 7g
  is that defence's release valve for a future source.
- **The pre-M4 risk** (inference from the code): if a pre-M4 GPEXE connection were set `inactive`, the team's next
  import would insert a fresh connection and the per-connection event dedup (v20 `:74-83`) would let the same session
  in twice. 7g must therefore never touch a connection without T7 keys (R1).
- **The platform-admin gates** to copy: `mayMaintainConversions` (`backend/src/unitConversionService.js:59`),
  `mayVerify` (`backend/src/sourceFieldVerificationService.js:87`): a platform admin in the platform workspace; the
  write kit `runWrite` (`backend/src/sourceMetricMappingService.js:726-800`) and 7c's `retireConversion` pattern
  (`unitConversionService.js:237-281`).

## 2. Who (P4, pending owner)

An active platform admin **in the platform workspace** only (the gate of `mayMaintainConversions`). Everyone else,
including a platform admin in a club workspace and every club admin, gets the identical 404 before the body is read.
The instance is a fact of the whole platform (one GPEXE team across every club), so no club scope applies.

## 3. The routes

### 3.1 `GET /api/training-load/sources/metrics/source-instances[?state=active|inactive|all][&sourceSystem=gpexe]`

Pages of 100 by an opaque cursor (the last row's id), only connections **with** T7 keys (an instance); `state`
defaults to `active`. Each row:

```
{ "id", "sourceSystem", "sourceHostKey", "sourceInstanceKey", "state", "createdAt",
  "ownerTeamId", "ownerTeamName", "held": true | false, "endedAt": <from its audit row> | null }
```

`held` is true when an `active` binding of another OptiMove team names the same `source_system`, host and source
team, so the instance is what blocks that team (the cheap read the admin needs to find what to end). The answer never
carries a credential column (no join to `source_credential_connections` beyond its `host_key`).

### 3.2 `POST /api/training-load/sources/metrics/source-instances/:connectionId/end`

Body (exactly these keys): `{ "requestKey": "<uuid>", "reason": "<text>", "expected": { "sourceSystem",
"sourceHostKey", "sourceInstanceKey" } }`. `reason` follows the shared text rule of the M2 writes (C53, the database
text check).

Answers:

1. **401**; then **the identical 404**: not the gate; a malformed id; a connection that does not exist.
2. **415 / 400** for a body that is not a JSON object or has another shape.
3. **409** (after the locks of section 5), in this order, each with the current facts in `current`:
   1. `instance_not_held`: the connection has no T7 keys (every pre-M4 connection, R1);
   2. `instance_mismatch`: `expected` differs from the row (a stale screen);
   3. `instance_already_ended`: `state` is `inactive`;
   4. `instance_binding_active` (R2): the owner team has an `active` binding naming the same source system, host and
      source team; ending would only make its next import create a second instance;
   5. `instance_in_use` (P4): an open T5 activation exists on any binding of the owner team naming the same source
      system, host and source team (an ended binding's open activation included, C58): end it first (S2);
   6. `try_again`: a lock not granted within the bound.
4. **200** `{ "instance": <the row as in 3.1, state inactive> }`, with the usual replay (`replayed: true`),
   `request_key_reused`, `verified_after_commit_error` and `503 outcome_unknown` of `runWrite`.

## 4. The write

One operation in `runWrite`'s transaction (the per-user lock, the request record, the acting user `optimove.source_metric_actor`, the bounded COMMIT):

1. the v11 row `FOR NO KEY UPDATE` (it waits for an import in flight that holds it `FOR SHARE` or `FOR UPDATE`, C55 and
   C57; bounded by the row lock timeout → `try_again`);
2. the owner team's bindings of that source system and source team `FOR SHARE`, in ascending id (so a bind or an
   Unbind lands first or waits);
3. `rightsStillHold` (the platform admin's role and user rows `FOR SHARE`);
4. the checks of section 3.2, step 3;
5. `update metric_source_connections set state = 'inactive' where id = $1`;
6. the T8 row `source_instance_end`: `metric_source_connection_id`, `team_id` = the owner team (NULL when the owner is
   not a team), `from_status 'active'`, `to_status 'inactive'`, `reason`, `basis 'platform_admin'`, the operation id,
   the request key and hash (the keyed row is the only row).

Nothing else changes: no event, identity, occasion, value, provenance or binding row; no history moves (C36).

## 5. Lock order and concurrency

- **Against M4's writer** (C57): the writer locks the v11 row `FOR UPDATE` for every event and identity insert and
  `FOR SHARE` for every T6 insert, inside one importing transaction. 7g's `FOR NO KEY UPDATE` conflicts with both, so
  an end waits for an import in flight (or answers `try_again`), and an import that starts after the end sees the
  instance `inactive` and is refused by the T6 guard (C55) and M4's own checks.
- **Against a bind or an Unbind** of the owner team for that source team: both take the binding row; 7g reads the
  bindings `FOR SHARE` after the v11 row, so a concurrent bind lands first (then `instance_binding_active`) or waits.
- **Against S1** on the owner team's binding: S1 needs an `active` binding; with step 4 of section 3.2 refusing an
  active binding, an S1 that lands after the end meets an ended binding (`binding_not_active`).
- No path takes the v11 row after a binding or a T5 row, so no cycle arises.

## 6. The migration (v49, proposed)

1. **The v11 state guard** (`BEFORE UPDATE OF state` on `metric_source_connections`):
   - `active → inactive` only when the row has T7 keys, the acting user (v35's setting) is an active platform admin;
     otherwise `42501` "metric source connection: the acting user may not end this source instance" or `23514`
     "metric_source_connections: only a source instance is ended";
   - `inactive → active` is always refused: `23514` "metric_source_connections: an ended source instance is final";
   - an INSERT (the importer's) is untouched.
2. **A deferred constraint trigger** on that UPDATE: at COMMIT, the transaction holds the connection's
   `source_instance_end` audit row (`23514` "metric_source_connections: a source instance is ended with its audit
   row").
3. **T8:** the revision guard's body (v48's, replaced in full) gains the `source_instance_end` branch: the named
   connection was changed to `inactive` in this transaction (its `xmin` is the current transaction), `team_id` is the
   owner team or NULL when the owner is not a team, the reason is non-empty, and the row is the connection's only one.
   v35's actor guard already admits an active platform admin with `basis = 'platform_admin'` for this action
   (v35 `:227-233`), so it is unchanged. A unique partial index makes "once" physical:
   `source_metric_audit_v49_instance_end_once (metric_source_connection_id) where action = 'source_instance_end'`.
4. **Locks:** `metric_source_connections` and `source_metric_audit` in the order of their writers.
5. **Rollback, read-only preflight, post-check, runbook** (as v47 and v48): the rollback refuses once any
   `source_instance_end` row exists or any connection with T7 keys is `inactive`; the preflight shows v48 as the last
   migration and the guard body v49 replaces as the one in force (md5), and counts connections with T7 keys and
   inactive ones (both expected 0 before M4).

Existing tests that flip `state` raw (`backend/tests/source-metric-mapping-m1.test.mjs:1058-1062`,
`backend/tests/gpexe-undo-guards.test.mjs:201`) write with the guard switched off in their own disposable database
or through the guarded path; no production code changes `state`.

## 7. Security and privacy

- The only audience is a platform admin in the platform workspace; the identical 404 for everyone else.
- The answer carries a GPEXE Team ID (not personal data; a platform admin already sees it in Settings → Data
  sources), a team id and name, and no credential column, reason, acting user or database text.
- The reason is written to the audit row only.
- The guard holds against a raw writer that sets the actor (C74's stated limit: not against the migration role).

## 8. Tests (7g-B)

- **The migration:** applied by the runner on v48 with no deadlock against a reader of v11; the guard's refusals in
  direct SQL (no actor, a club admin, a connection without keys, `inactive → active`, an end without its audit row at
  COMMIT, a second audit row, an audit row naming a connection not ended in this transaction, a savepoint); the
  rehearsed rollback back to v48's catalog exactly, and v49 again.
- **The routes:** 401; the identical 404 for a club admin, a platform admin in a club workspace, a coach, an unknown
  id; 415 / 400; each 409 of section 3.2 in its order; the 200 and its replay, `request_key_reused`, the lost COMMIT
  (`verified_after_commit_error`, `outcome_unknown`) through the real route.
- **The list:** only connections with keys; `held` true and false; pages of 100.
- **Concurrency:** an end against an importing transaction holding the row `FOR SHARE` (waits, then succeeds or
  `try_again`); against a bind of the owner team (both orders); against S1 on the owner team's binding.
- **Nothing else changes:** events, identities, values and provenance rows of the instance are byte-identical before
  and after.
- **Mutations** of every guard branch, the order of the 409s and the state checks.

## 9. Decisions for the *Rukovodilac*

- **R1 — only a connection with T7 keys is an instance** (`instance_not_held` otherwise), so 7g can never reopen the
  pre-M4 double-import risk. Recommended.
- **R2 — `instance_binding_active`:** refuse while the owner team still has an active binding to the same GPEXE team.
  Recommended: D9's purpose is the release after a re-bind; an instance in use is not "held".
- **R3 — the list route** (3.1), with `held`. Recommended: the admin needs to find what to end.
- **R4 — an ended instance is final in the database** (`inactive → active` refused). Recommended: C36 says the old
  instance is ended and the new team's writer creates its own.
- **R5 — 7g-B may be built before M4** and stays dormant (every GPEXE connection answers `instance_not_held`) until M4
  writes T7 keys. Recommended: the plan orders 7g before phase 9; the guard also closes today's unchecked `state`
  UPDATE.

## 10. Not in this contract

M4 (writing T7 keys, `source_instance_held`, `session_imported_under_another_instance`), any frontend, any production
write, a re-activation, a move of history between teams, a delete.
