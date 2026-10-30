# J9 — phase 7c: maintaining the unit conversions (proposed ★★ contract)

This is the contract of phase 7c of `docs/ai/metrics-core-plan.md` (section 5, phase 7: "7c: `unit_conversions`
maintenance"). It extends `docs/ai/gpexe-metric-variable-mapping-discovery.md` (the *discovery document*): sections
D3, D5, D10, D12, C52, C76 and J1. It follows the pattern of the phase 7b contract
(`docs/ai/phase7b-mapping-transitions-contract.md`):
- the contract goes to the *Rukovodilac* and the *Nezavisni revizor*;
- no code is written before both of them give GO on it;
- then pull request 7c-B builds it, with migration v47, and merges only on the owner's order naming the pull request,
  the migration file and its sha256, with the production preflight the same day.

| | |
|---|---|
| Status | Proposed by the executor on 2026-10-30, on the *Rukovodilac*'s order of that day (its message queued at 15:36:31 UTC), after the owner's word „daj mu zadatke 7c” (owner turn `77b204df`, 2026-10-30 15:33:57 UTC, in the *Rukovodilac*'s chat; the executor checked it in the transcript). |
| Verified against commit | `70e9e2b` (merge of PR #287). Every file and line reference below is to that commit. The base of this pull request, `3d4cd12` (merge of PR #290), changed only documents, so the references hold there too. |
| Decides | The *Rukovodilac*: Q1–Q3 (section 9.1), decided in the order; R1–R6 (section 9.2), proposed here. The owner: nothing new is asked (section 9.3). |
| Migration | **v47**, proposed as `migrations_v2/<YYYYMMDDHHMM>_training_load_v47_unit_conversion_guards.sql`, named by the day it is written. No file carries the label v47 at `70e9e2b` (v46 is the last). |

---

## 0. In short

- **Two writes**, for an active platform admin in the platform workspace only:
  - `POST /api/training-load/sources/metrics/conversions` creates an active conversion;
  - `POST /api/training-load/sources/metrics/conversions/:conversionId/retire` retires one.
- **No edit:** a correction is a retirement followed by a new conversion. A row is immutable, as v34 already enforces.
- **Every other caller gets the identical 404**, before the body is looked at.
- Each write is one bounded transaction of M2's `runWrite`. Its T8 row (`unit_conversion_create` /
  `unit_conversion_retire`) is the request record: a replay answers the current state, and another body on the same key
  is `request_key_reused`.
- **v47** gives the two writes their database actor guard (C76):
  - the acting user of the transaction, an active platform admin, named on the row;
  - the T8 row follows its own write in the same transaction, once;
  - at COMMIT, a deferred check that every write has its T8 row;
  - the unit-token rule on both units.
- **A retirement changes no mapping version.** An active version keeps its own factors (D5, C34). A draft or a submitted
  version with the retired factors can no longer be activated (`409 conversion_unavailable`), unless an active
  conversion with exactly the same factors exists again.
- **No frontend** (Q3). The conversions screen comes with phase 8.

---

## 1. What exists (verified at `70e9e2b`)

### 1.1 The table (v34, `migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql`)

- **`training_load.unit_conversions`** (lines 672–710):
  - the units `from_unit` / `to_unit`: `source_metric_text_ok(…, 30)` (v40 replaced the function, not the check), and
    `unit_conversions_units_differ`;
  - the factors: `scale`, `scale_divisor` and `"offset"` are `numeric`. They must be finite
    (`unit_conversions_factors_finite`), `scale > 0` and `scale_divisor > 0` (C54), and in normal form,
    `scale = 1 or scale_divisor = 1` (`unit_conversions_factors_normal`);
  - `state` is `active` or `retired`; `retired_by_user_id`, `retired_at` and `retired_reason` are all set exactly for
    a retired row (`unit_conversions_retired_facts`); `retired_reason` follows the text rule, up to 500 characters;
  - `evidence_ref` is required and has the D3 shape (`source_metric_evidence_ref_ok`, at most 300 characters,
    `docs/…#anchor`);
  - exactly one of `created_by_user_id` and `seed_migration` (`unit_conversions_actor_or_seed`).
- **`unit_conversions_one_active_pair`** (line 712): a partial unique index on `(from_unit, to_unit) where state =
  'active'`. **At most one active row per ordered pair is already guaranteed; v47 adds nothing for it.**
- **`unit_conversions_guard()`** (lines 718–748, BEFORE INSERT OR UPDATE OR DELETE):
  - a DELETE is refused;
  - an INSERT must be `active`. A row with an actor needs an active platform admin
    (`source_metric_require_platform_admin`, which locks the role and user rows FOR SHARE). A seed row needs the seed
    window (`source_metric_require_seed_window`, true only inside v34's own transaction);
  - an UPDATE may only change `state` from `active` to `retired` with the retirement facts; every other column is
    immutable.

  **It does not check that the creator or the retirer is the acting user of the transaction, and it does not check
  that the retirer is a platform admin.**
- `unit_conversions_no_truncate` (line 749).
- **The seed** (lines 1819–1828): four rows with the marker of v34: `s → min (1, 60, 0)`, `m/s → km/h (3.6, 1, 0)`,
  `m → km (0.001, 1, 0)` and `km/h → m/s (1, 3.6, 0)`. The reverse pair is already a row of its own.

### 1.2 The readers

- **The T4 rules:**
  - `source_metric_check_conversion()` (v34 lines 924–945): equal units take the identity `(1, 1, 0)`; otherwise the
    version's factors must equal the single active row of the pair. It runs at the T4 INSERT (a plain read) and again
    at activation;
  - `source_metric_lock_conversions()` (lines 952–960, C52): the activation's first lock, FOR SHARE in ascending id,
    on the active rows of the value pair and the bound pair (line 1171).
- **The services** (`backend/src/sourceMetricMappingService.js`):
  - `listConversions` (lines 562–574): `GET /conversions` lists the active rows only, in byte order of the units,
    bounded at `LIST_CAPS.conversions` = 100 (line 74). Its audience is M2's (`adminContext`, routes line 109): a
    platform admin in the platform or a club workspace, and a club admin in its own club;
  - `createVersion`: it reads the active row plainly (`activeConversion`, lines 983–991) and answers
    `409 conversion_unavailable` / `bound_conversion_unavailable` (lines 1053, 1069). Then, in the lock order, it takes
    the rows FOR SHARE and compares them again (lines 1084–1091);
  - the 7b activation (`conversionsHold`, lines 1281–1294): under the conversion locks taken first, it requires
    exactly one active row with the version's own factors. If none holds, it answers `409 conversion_unavailable` /
    `bound_conversion_unavailable`. The v34 trigger's refusal text maps to the same codes (lines 313–314);
  - the helpers `canonicalDecimal` (lines 221–233) and `isNormalFormPair` (lines 239–251): the D5 normal form and
    the text `trim_scale()` prints;
  - `unitTokenOk` (`backend/src/metricTextRules.js` line 39) and `evidenceRefOk`
    (`backend/src/sourceFieldVerificationService.js` lines 62–63): the twins of v40's
    `source_metric_unit_token_ok` and of v34's `source_metric_evidence_ref_ok`.
- **No writer exists.** Nothing in `backend/src` inserts into or updates `unit_conversions`.

### 1.3 T8 and its guards today

- **The row shapes** (v34 `source_metric_audit_row_ok`, lines 1666–1669):
  - `unit_conversion_create`: only `unit_conversion_id` set, `from` null, `to` `active`, evidence required, basis
    `platform_admin`;
  - `unit_conversion_retire`: only `unit_conversion_id` set, `active` → `retired`, a reason required, basis
    `platform_admin`.

  The column `unit_conversion_id` (line 1689) references the conversion with `on delete restrict`.
- **The request record** (lines 1748–1751): one row per `(performed_by_user_id, request_key)` and one keyed row per
  `operation_id`.
- **v35's T8 actor guard** (`migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql` lines
  216–293): every action is written by the acting user. An action other than the four mapping actions needs only the
  `platform_admin` basis (lines 227–234); "its chain comes with the PR that writes it".
- **v39's `source_metric_audit_revision_guard()`**
  (`migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql` lines 166–239, the body in
  force; trigger `source_metric_audit_v37_revision_guard`): every action that is neither a mapping action, a revision
  lifecycle action nor a verification is refused with *'source_metric_audit: no writer of this action exists yet'*
  (line 211, C90). **So today no `unit_conversion_*` T8 row can be written, and no conversion can be created or
  retired with its audit row.**

---

## 2. Routes (HTTP contract)

Both under `/api/training-load/sources/metrics`, in `backend/src/routes/sourceMetrics.js`.

### 2.1 The order of the answer (the 7b pattern)

1. 401 without a session (the router's `requireAuth`).
2. **`adminContext`, then `mayMaintainConversions(ctx)`**: `ctx.basis === "platform_admin" && ctx.owner.scope ===
   "system"`, the same predicate as M2b's `mayVerify`. Everyone else gets the identical `404` with `no-store`, before
   the body is read:
   - a platform admin in a club workspace;
   - a club admin;
   - a team coach;
   - an athlete;
   - a revoked role;
   - an inactive user.
3. 415 for a body that is not JSON, then 400 for a body that is not an object.
4. A malformed `:conversionId` gets the identical 404.
5. The body's shape: 400 `invalid_body`, or the specific 400 codes of section 2.4.
6. The write (section 3).

### 2.2 `POST /conversions` — create

Body (no other key; every key required):

```json
{ "requestKey": "<uuid>", "fromUnit": "m/s", "toUnit": "km/h",
  "scale": "3.6", "scaleDivisor": "1", "offset": "0",
  "evidenceRef": "docs/ai/<file>.md#<anchor>" }
```

- **201 `{ conversion, replayed: false }` for a new write; 200 `{ conversion, replayed: true }` for a replay** (as
  `POST /mappings`).
- `conversion`: `{ id, fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef, state, createdAt, retiredAt }`. The
  numbers are exact decimal text (`trim_scale`). No acting user, no retirement reason (C63's rule) and no seed marker
  (it is shown as `seeded: true` only).
- The row is `active`, with `created_by_user_id` set to the acting user and `seed_migration` null.

### 2.3 `POST /conversions/:conversionId/retire` — retire

Body (no other key; every key required):

```json
{ "requestKey": "<uuid>", "expectedState": "active", "reason": "<1–500 characters, one line>" }
```

- **200 `{ conversion, replayed }`**, with the row now `retired`.
- `retired_by_user_id` is the acting user, `retired_at` is `now()` (the transaction's time), and `retired_reason` is
  the reason. The reason is written and audited, never returned (C63).
- A seed row can be retired like any other (it keeps its seed marker).

### 2.4 The numbers and the units: what is accepted

- **The numbers are strings, never JSON numbers** (no binary float ever reaches the service):
  - the grammar is `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`: no exponent, no `+`, no leading zeros, no `NaN` or `Infinity`;
  - at most 40 characters each (R1);
  - `scale` and `scaleDivisor` greater than zero. `offset` may be negative or zero.

  Anything else is `400 invalid_body`, with a sentence naming the field.
- **The normal form** (D5): the pair must be `(f, 1)` for every terminating `f`, or `(1, d)` where `1/d` does not
  terminate (`isNormalFormPair`). Otherwise the answer is **`400 conversion_not_normal_form`**: "A factor is stored as
  (decimal, 1), or as (1, d) only when 1/d is not a terminating decimal; write 3.6 as (3.6, 1) and 1/60 as (1, 60)."
  Numeric equality makes `3.60` and `3.6` the same value: the stored and returned text is `trim_scale`'s.
- **The units:**
  - each must pass the unit-token rule, `unitTokenOk` (D3; at most 30 characters, none of v40's forbidden
    characters). Otherwise **`400 unit_not_a_token`**;
  - the two must differ (otherwise `400 invalid_body`). Identity needs no row: equal units take `(1, 1, 0)`.
- **`evidenceRef`:** `evidenceRefOk`, the D3 shape. Otherwise `400 invalid_body`. As everywhere, it is checked by its
  form only, never against a file (C95).
- **`reason`:** the bounded text rule, 1–500 characters (`boundedText`). Otherwise `400 invalid_body`.
- **`expectedState`:** exactly `"active"`. Otherwise `400 invalid_body`.

### 2.5 The refusals

| Code | Status | When | Body extras |
|---|---|---|---|
| `invalid_body` | 400 | the shape, a number, a unit equality, `evidenceRef`, `reason`, `expectedState`, an unknown key | — |
| `conversion_not_normal_form` | 400 | the factor pair is not in D5's normal form | — |
| `unit_not_a_token` | 400 | a unit fails the unit-token rule | — |
| (identical 404) | 404 | a caller outside 2.1 step 2; a malformed or unknown `:conversionId` | `no-store` |
| `conversion_exists` | 409 | create: an active row of the same ordered pair exists (pre-read, or the unique index `unit_conversions_one_active_pair`'s `23505`) | `current` (the active row) |
| `conversion_not_active` | 409 | retire: the row is already retired | `current` (the row) |
| `request_key_reused` | 409 | the same key with another body or another operation | — |
| `try_again` | 409 | `55P03`, `40P01`, `57014` (a lock or statement bound) | — |
| `outcome_unknown` | 503 | the COMMIT's answer was lost and the request record could not be confirmed | `requestKey` |
| `internal_error` | 500 | anything else (an unmapped database refusal included) | — |

- **No `conversion_changed`.** A row has exactly one possible change, its retirement, so `expectedState: "active"`
  and `conversion_not_active` cover every concurrent write. A distinct code would never be reachable (R2).
- **A `current` row is returned only after the right is checked again** (the 7b rule): a caller who lost the right
  meanwhile sees the identical 404.

---

## 3. The writes, step by step

Each is one transaction of M2's `runWrite` (`sourceMetricMappingService.js` line 738) with its bounds:
`STATEMENT_TIMEOUT_MS`, `ROW_LOCK_TIMEOUT_MS`, the user lock's wait, the bounded COMMIT and the bounded answer read.

### 3.1 Create

1. The per-user advisory lock, then the request record by `(userId, requestKey)`. On a hit: the same hash means a
   replay, which answers the current row after `rightsStillHold`; another hash is `request_key_reused`.
2. The actor setting (`ACTOR_CONTEXT_SQL`), as every M2 write sets it.
3. A plain pre-read of an active row of the pair. If one exists: `409 conversion_exists` with `current`, after the
   right is checked again.
4. `rightsStillHold(client, ctx)`: the acting user's role and user rows FOR SHARE. If lost: the identical 404.
5. The INSERT: the active row with the actor as creator. v34's guard and v47's guard (section 6.2) run on it. A
   concurrent create of the same pair meets the unique index: the second waits for the first, then gets `23505` and
   answers `409 conversion_exists`.
6. The T8 row `unit_conversion_create`, with the evidence, the key and the hash. It is the request record, and the last
   write.
7. The bounded COMMIT. v47's deferred link (section 6.3) checks the T8 row.

### 3.2 Retire

1. The user lock and the request record, as in 3.1.
2. The actor setting.
3. **The row, FOR NO KEY UPDATE** (it conflicts with the activation's FOR SHARE). Not found: the identical 404.
4. `rightsStillHold`. If lost: the identical 404.
5. `state = 'retired'` already: `409 conversion_not_active` with `current`.
6. The UPDATE (`state`, `retired_by_user_id`, `retired_at`, `retired_reason`). v34's and v47's guards run on it.
7. The T8 row `unit_conversion_retire` (`from_status 'active'`, `to_status 'retired'`, the reason, the key and the
   hash); the last write.
8. The bounded COMMIT and the deferred link.

### 3.3 The request hash (`request_hash`, sha256 of the canonical JSON)

- **create:** `{ op: "unit_conversion_create", fromUnit, toUnit, scale, scaleDivisor, offset, evidenceRef }`, with the
  three numbers in their canonical text (`canonicalDecimal`), so `"3.60"` and `"3.6"` hash alike;
- **retire:** `{ op: "unit_conversion_retire", conversionId, expectedState, reason }`.

### 3.4 After the COMMIT

As every M2 write:
- the right is checked again before the answer;
- the answer is read on a new bounded connection;
- a lost COMMIT answer is verified by the request key, giving `verified_after_commit_error`, or
  `503 outcome_unknown` with `requestKey`;
- a COMMIT that PostgreSQL itself refused (v47's deferred link included) is a definite refusal: nothing was written.

---

## 4. Lock order and concurrency

The order of a 7c write is:
1. the per-user advisory lock;
2. the request record (a plain read);
3. **one** `unit_conversions` row (retire: FOR NO KEY UPDATE; create: the index entry of its INSERT);
4. the acting user's role and user rows FOR SHARE (`rightsStillHold`, v34's `source_metric_require_platform_admin`,
   v35's `source_metric_actor_basis`);
5. the T8 INSERT.

This is a prefix of D's order (v34 header, lines 38–44): `unit_conversions` first, the acting user's rows last.

**No cycle with any other writer:**
- **An activation (7b, C52)** locks the active conversion rows of its value and bound pairs FOR SHARE, in ascending
  id, before anything else, and takes the user's rows last. A retirement holds one conversion row and then only wants
  user rows FOR SHARE, which the activation's FOR SHARE does not block.
  - **Retire first:** the activation waits on the row. Under READ COMMITTED it finds the row retired and excluded,
    and answers `409 conversion_unavailable` (7b's `conversionsHold`). v34's trigger would refuse it the same way.
  - **Activation first:** the retirement waits until the activation commits, then retires. The version activated
    meanwhile keeps its own factors (D5).
- **A T4 draft (`createVersion`)** takes the active rows FOR SHARE in the lock order (lines 1084–1091), with the same
  outcome: it waits for a retirement, then answers `409 conversion_unavailable`.
- **Two creates of one pair** serialize on the unique index entry: the second gets `23505`, which is
  `409 conversion_exists`.
- **A create and a retirement of the old row of the same pair:** the INSERT waits for the retiring transaction's index
  entry. If the retirement commits, the create succeeds. If it rolls back, the create gets `conversion_exists`.
- **A role revocation** (an UPDATE of `user_global_roles`) touches no conversion row; the writes meet it only at their
  last FOR SHARE.
- **Two writes of one user** serialize on the user's advisory lock first.

**Deadlock:** a single-row writer and ascending multi-row FOR SHARE readers cannot form a cycle on `unit_conversions`.
`40P01` is still mapped to `try_again`.

**A correction is not atomic (R3):** between the retirement and the new create, the pair has no active row, and an
activation or a draft of that pair answers `409 conversion_unavailable`. That is the safe direction: nothing is ever
activated against a factor that is being replaced. An atomic "replace" is not proposed (section 9.2, R3).

---

## 5. What a retirement does and does not do

- **An active mapping version keeps its own factors** (D5, C34, decision 12), and so does its activation (T5, 7d), and
  imports (M4) when they come: they read the version's copy, never `unit_conversions`. **Retiring a conversion changes
  no active version and no stored value.**
- **A new draft of that pair (`createVersion`)** answers `409 conversion_unavailable` (or `bound_conversion_unavailable`
  for a bound pair) while no active row exists (lines 1053, 1069, 1089–1090).
- **A draft or `needs_review` version made with the retired factors:**
  - the submission (`draft → needs_review`) does not read conversions, so it still works;
  - the **activation** answers `409 conversion_unavailable` / `bound_conversion_unavailable` (7b's `conversionsHold`,
    lines 1281–1294; v34's trigger maps to the same code, lines 313–314). It works again only if an active row with
    **exactly** the same factors exists (a re-creation of the same factors);
  - after a correction with other factors, the version can never be activated: it is disabled (A2) and a new version is
    made, which takes the new factors.
- **The pinned step of the revision lifecycle** (v39, 7b) does not read conversions and is unaffected.
- **The reverse pair is not touched** (Q2): retiring `m/s → km/h` leaves `km/h → m/s` active. Keeping the two
  consistent is the administrator's task; section 9.2 R4 proposes how the phase 8 screen helps.

---

## 6. Migration v47 (specification; the file is written in 7c-B)

`migrations_v2/<YYYYMMDDHHMM>_training_load_v47_unit_conversion_guards.sql`. Functions, triggers, one index and one
CHECK; no table, column or data change.

### 6.1 The locks

`lock table training_load.source_metric_audit, training_load.unit_conversions in share row exclusive mode`, in the
order a write takes them. The T8 request record is read first, the conversion row then. A plain read meeting the
migration waits up to the runner's 30 s lock timeout; a quiet moment is the runbook's step, as for v45 and v46.

### 6.2 Before the write (BEFORE INSERT OR UPDATE on `unit_conversions`; a new trigger `unit_conversions_v47_actor_guard`)

- **INSERT with `created_by_user_id`:** it must equal `source_metric_context_actor()` (the v35 setting, bound to this
  transaction; missing or foreign is `42501`), and the actor's basis must be `platform_admin`
  (`source_metric_actor_basis(actor, null)`, which locks FOR SHARE). Otherwise:
  `42501 'unit conversion: the acting user may not write this conversion'`.
- **INSERT with `seed_migration`:** unchanged. v34's seed window already refuses it outside the seeding migration.
- **UPDATE (a retirement):** `retired_by_user_id` must equal the acting user, who must be an active platform admin
  (`42501`, the same message). v34's guard still refuses every other change.
- **A write inside a savepoint** fails the T8 chain of 6.3: the row's xmin is the subtransaction's, not the
  transaction's, so the T8 row cannot follow it (`23514`), as v35, v37 and v39 fail closed.

### 6.3 The T8 chain (replacing `source_metric_audit_revision_guard()`, v39's body with one new branch)

- The new branch, before the final refusal, handles `unit_conversion_create` and `unit_conversion_retire`:
  - the actor and the basis, as for the revision actions (`42501`);
  - the conversion row, read by id with its xmin, must be written in this transaction (`23514 'source_metric_audit:
    the audit row must follow its own conversion change in the same transaction'`);
  - **create:** the row is active, its creator is the actor, and the T8 evidence equals the row's;
  - **retire:** the row is retired, its retirer is the actor, the T8 reason equals `retired_reason`, and `from_status`
    is `active`;
  - once per conversion and action: `23514 'source_metric_audit: the conversion change already has its audit row'`.
    A unique partial index `source_metric_audit_v47_conversion_once (unit_conversion_id, action) where action in
    ('unit_conversion_create', 'unit_conversion_retire')` makes "once" physical as well.
- Every other line of the v39 body is kept byte for byte (mapping, revision lifecycle and verification branches, and
  the final *'no writer of this action exists yet'* for the activation and source-instance actions).

### 6.4 At COMMIT (deferred constraint triggers, the v39 / v43 pattern)

- `unit_conversions_v47_audit_link_insert` (AFTER INSERT, `deferrable initially deferred`, only for a row with a
  creator): its `unit_conversion_create` T8 row must exist. Otherwise:
  `23514 'unit_conversions: a conversion is written with its unit_conversion_create audit row'`.
- `unit_conversions_v47_audit_link_retire` (AFTER UPDATE `when (old.state = 'active' and new.state = 'retired')`):
  its `unit_conversion_retire` T8 row must exist. Otherwise:
  `23514 'unit_conversions: a retirement is written with its unit_conversion_retire audit row'`.

### 6.5 The unit-token rule (R5)

`alter table … add constraint unit_conversions_units_are_tokens check (training_load.source_metric_unit_token_ok(from_unit)
and training_load.source_metric_unit_token_ok(to_unit))`. The four seed rows pass. A conversion whose units are not
tokens could never serve a mapping version, whose units must be tokens (C56, v40). The migration refuses, without
change, if an existing row fails (the v40 pattern).

### 6.6 The messages

Fixed texts only: no id, no unit, no value, no SQL. The service maps:
- each `42501` to `internal_error` (a guard of a writer that should never fail);
- the deferred links to a definite COMMIT refusal, `internal_error`;
- `23505` on `unit_conversions_one_active_pair` to `409 conversion_exists`;
- the unit-token CHECK's `23514` (an API twin refuses first) to `400 unit_not_a_token`.

### 6.7 The rollback (`docs/runbooks/unit-conversion-guards-v47-rollback.sql`)

**It refuses, changing nothing:**
- while the migrator's advisory lock `822026` is held;
- without v47 recorded, or under a later migration;
- once any row has a `created_by_user_id` (a conversion created through the API) or any row is retired;
- once any `unit_conversion_*` T8 row exists;
- while a v47 object is missing or a v47 trigger is disabled.

**Otherwise it:**
- takes v47's locks in v47's order;
- drops the four v47 objects (two link triggers, the actor guard trigger and its functions, the index and the CHECK);
- restores v39's body of `source_metric_audit_revision_guard()` byte for byte;
- deletes v47's record.

It is rehearsed: apply, rollback, the v46 catalog exactly, re-apply identically, and atomicity (a failing last
statement leaves nothing). The `.gitattributes` line `docs/runbooks/unit-conversion-guards-v47*.sql text eol=lf` comes
with the files, since the rollback restores a body whose md5 the preflight and the post-check compare.

### 6.8 Read-only preflight and post-check

- **The preflight (about 8 blocks):**
  - PostgreSQL 15 or later;
  - v46 the last migration, with its checksum, and v39 recorded with its checksum;
  - the md5 of v39's `source_metric_audit_revision_guard()` body;
  - no v47 object;
  - every existing row passes the token rule and is a seed row, or a count of the rows that are not;
  - no `unit_conversion_*` T8 row;
  - the migrator role owns both tables;
  - a quiet moment.
- **The post-check (about 6 blocks):**
  - v47 recorded once with its sha256, and the last migration;
  - the new function md5s;
  - the triggers enabled, and the two links deferred;
  - the index valid and the CHECK validated;
  - the rows and T8 rows as in the preflight.

---

## 7. Information hiding and the audience

- The write routes are the platform admin's in the platform workspace only (Q1). The 404 is the router's identical one
  (`no-store`), before the body; the 7b and M2b tests show the shape.
- `GET /conversions` keeps its audience and its answer: the active rows, with no acting user and no reason. A
  conversion is not a club's secret (D5: no owner), so a club admin keeps reading what a mapping of the club may use.
- An answer never carries `created_by_user_id`, `retired_by_user_id`, `retired_reason` or the seed marker's file name.

---

## 8. Tests (7c-B; `backend/tests/unit-conversions-7c.test.mjs`, disposable, T1 runner)

1. **The migration:** v47 through the real runner; the post-check's values; the rollback's refusals, one by one; the
   rollback to the v46 catalog exactly; re-apply identically; atomicity.
2. **Audience:**
   - the identical 404, before the body, for every caller outside 2.1 step 2;
   - 401 without a session;
   - 415 and 400 after the gate;
   - a malformed and an unknown id each get the 404.
3. **Create:**
   - the row, the T8 row and the answer;
   - every 400 of section 2.4, with JSON numbers, `NaN`, `1e3`, `-0`, a leading `+`, `01`, 41 characters and a non-normal
     pair such as `(36, 10)`, `(2, 120)` or `(1, 4)`;
   - the units: equal, and not a token;
   - `conversion_exists` from the pre-read, and from the unique index through a seam that skips the pre-read.
4. **Retire:**
   - the row and the T8 row;
   - `conversion_not_active`, and the reason never returned;
   - a seed row retired.
5. **Replay and keys:**
   - the same key and body replays (create and retire);
   - another body, and another operation on the same key, are `request_key_reused`;
   - `"3.60"` and `"3.6"` hash alike.
6. **COMMIT:**
   - a lost answer verified (`verified_after_commit_error`);
   - not verified (`503 outcome_unknown`);
   - a definite refusal through a T8 fault seam (nothing written).
7. **Rights:**
   - a right lost during the write gives the identical 404, with nothing written and the key free;
   - a right lost before a replay gives the 404.
8. **Direct SQL against v47** (no API):
   - an INSERT or an UPDATE without the actor setting gives `42501`;
   - with another user named gives `42501`;
   - with a club admin as actor gives `42501`;
   - without the T8 row gives `23514` at COMMIT;
   - a second T8 row gives `23514`;
   - T8 inside a savepoint gives `23514`;
   - a non-token unit gives `23514`;
   - v34's immutability and DELETE refusal still hold.
9. **Concurrency** (two connections, deterministic seams):
   - retire while an activation of that pair holds its FOR SHARE: the retirement waits, then succeeds, and the active
     version is unchanged;
   - an activation while a retirement holds the row: the activation answers `409 conversion_unavailable`, and v34's
     trigger agrees;
   - two creates of one pair: one 201, one `409 conversion_exists`;
   - a create while a retirement of the old row is in flight;
   - no `40P01` in any case.
10. **Consequences:**
    - an active version keeps its factors after a retirement;
    - a draft of the pair gives `conversion_unavailable`;
    - a re-created identical conversion lets the old draft activate again;
    - a different correction does not.
11. **Mutations** (each file restored byte for byte):
    - the normal-form check;
    - the token check (API and CHECK);
    - the actor comparison on INSERT and on UPDATE;
    - the platform-admin basis;
    - the T8 branch (create and retire);
    - the once-index;
    - each deferred link;
    - `expectedState`;
    - the hash's canonical numbers;
    - `mayMaintainConversions`;
    - the rollback's refusals.
12. **Regression:**
    - M1, M2, v35, M2b, v39, v42, 7b and the 7c suite;
    - `--preset gpexe` against its baseline;
    - the secret scan.

---

## 9. Decisions

### 9.1 The *Rukovodilac*'s decisions in the order (2026-10-30, recorded as his)

- **Q1 — who:** conversions are global (D5 has no owner column), so the writer is an active platform admin in the
  **platform** workspace, through the M2 resolver (`sourceMetricAccess`). Everyone else, a club admin included, gets
  the identical 404 before the body.
- **Q2 — the reverse pair:** a row of its own; no automatic inversion.
- **Q3 — no frontend in 7c:** the conversions screen comes with phase 8, as the third step of the guided flow ("confirm
  the unit or the conversion"). Discovery found no reason to build a minimal admin screen now: every write has an API
  and a test, and no conversion beyond the four seeded ones is needed before the C97 evidence confirms a unit.

### 9.2 Proposed for the *Rukovodilac* (inside the plan)

- **R1:** each number at most 40 characters of text. The representable range of D5 stays as it is (K: `7/3` and
  `°F → °C` remain refused).
- **R2:** no `conversion_changed` code; `conversion_not_active` covers the only concurrent change.
- **R3:** no atomic "replace" in 7c. A correction is a retirement and then a create; in between, activations of the
  pair refuse safely. If phase 8 needs it, a replace is a later addition (two T8 rows under one `operation_id`, as 7b's
  replacement does).
- **R4:** no rule that a pair and its reverse agree. The phase 8 screen shows the reverse pair beside a conversion and
  names a mismatch.
- **R5:** v47 adds the unit-token CHECK, so no conversion can exist that no mapping could use.
- **R6:** `GET /conversions` stays as it is (active rows only). A history read (retired rows, with when, not who) comes
  with phase 8 if its screen needs it.

### 9.3 For the owner

Nothing new: the contract adds no product rule. It builds the two operations the accepted design (D5, D10) already
names, under the existing audience and evidence rules.

---

## 10. Not in 7c

- **The frontend** (Q3; phase 8).
- **Widening D5's representable range** (K).
- **T5 activations** (7d), **the preview** (7e), **the extractor registry** (7f) and **ending a held instance** (7g).
- **The importer** (M4) and **the import switch**.
- **A conversion of a club or a person** (D5 is global).
