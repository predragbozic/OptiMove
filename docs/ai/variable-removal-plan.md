# Remove a variable that was never used (plan)

Status: **Proposed** (the *Rukovodilac*'s order of 2026-11-19, from the owner's need). Plan only: no code, no migration.
Verified against `main` `912d669c` and a disposable database migrated through v78 (the last training-load migration on
`main`; v79 is PR #629, not merged).

## 0. The need

On 2026-11-18 the owner created system variables with a condition:
- Explosive distance >=60 W/kg;
- Accelerations;
- Decelerations;
- High Metabolic Load Distance >=25 W/kg;
- Sprint Distance.

That was before we knew a conditioned variable cannot receive a field. They have no values and nothing is mapped to them.

The owner now wants HMLD and Explosive distance as calculated sums of zone variables. A variable is measured or calculated
from version 1 and cannot be deleted, so the old ones would stay forever under the names he wants. He asked for a database
delete. That was refused: production, no backups, and raw SQL outside the contract.

The owner's goal: the name and the key become free, and the list is clean.

## 1. When a variable may be removed: every reference, from the real schema

The rule is checked inside one sanctioned database function, under the variable's row lock (section 3), not only in the
service.

Foreign keys into `metric_definitions` and `metric_definition_versions` (read from `pg_constraint`):

| Table (columns) | On delete | Removal |
|---|---|---|
| `metric_values` (definition; definition + version) | restrict | **Blocks**: any value of any version, current or superseded, of any level. Estimates (`metric_value_estimates`) hang on values, so they block through them. |
| `source_metric_mappings` (definition) | restrict | **Blocks**: any mapping identity, whatever its versions' status. A mapping version is never deleted (v34/v74 guard), so a draft blocks too. |
| `source_metric_mapping_versions` (definition + version) | restrict | **Blocks**, any status (`draft`, `needs_review`, `active`, `disabled`). Activations (T5) and a replacement hang on versions, so they block through them. |
| `dashboard_widget_series` (definition) | restrict | **Blocks**: a series on any dashboard, a template's included. |
| `metric_definition_copies` (system definition; system version; club definition) | restrict | **Blocks**: a club copy made from it (v53), or it being a club's copy of a system variable. |
| `metric_definition_club_hides` (definition) | restrict | Removed with it, counted in the log. A club's hide of the variable has no meaning without it. |
| `metric_definition_hidden` (definition) | cascade | Removed with it (a user's "hide from my list"). |
| `metric_structure_links` (definition) | cascade | Removed with it: its place in categories and domains, counted in the log. |
| `metric_classification_changes` (definition) | restrict | Removed with it: the history of its own placements. The log keeps the count and the last placement. |
| `metric_variable_requests` (definition; definition + version) | restrict | Removed with it: its own create, rename, archive and restore requests. The log keeps a copy (who, when, operation) of each. |
| `metric_variable_changes` (definition) | restrict | Removed with it: its own change record (renames, icons). Copied into the log as above. |
| `metric_definition_scope_capabilities` (definition) | no action | Removed with it: its levels. |
| `metric_definition_versions` (definition) | restrict | Removed with it: all its versions. |
| `metric_definitions.current_version_id` (to its own version) | no action | Its own pointer; cleared in the same statement order. |

References held in jsonb or as text, with no foreign key:

| Where | Removal |
|---|---|
| `metric_definition_versions.calculation -> 'inputs'` of any other variable, any version (current or superseded) | **Blocks**. A superseded version still names it, and v77–v79 hold an input's unit while it is used. |
| `metric_values.computed_by_ref` (`formulaVersionId`, `inputValueIds`) | Covered: it names values and the calculated variable's own versions, and values block. |
| `gpexe_import_candidates.preview` / `gpexe_import_check_observations.preview` (a mapped or calculated entry's `metricDefinitionId`) | Covered: an entry exists only for a mapped or calculated variable, and mappings and inputs block. |
| `dashboard_widget_series.template_resolution_candidates` (ids of an ambiguous template match) | **Blocks** while any unresolved series names it (checked in the function). |
| `dashboard_widget_series.template_metric_key_hints` (keys, not ids) | Not a reference. Once the key is free, a later variable with that key matches the hint, which is the hints' purpose. |
| `dashboard_simple_requests.compiled_series` (v71 request records) | Stays. A request record keeps its saved answer, and a replay never resolves the id again. |
| `source_connection_audit.metadata`, the calendar's jsonb, roster results | Checked: none names a canonical variable. |

The function refuses whatever blocks with the first reason found, in this order: values, mapping, calculation input,
dashboard, club copy. It writes nothing on a refusal.

## 2. Delete, or archive and free the key?

**(a) Hard delete plus an append-only removal log, in one transaction** (the v19 `delete_dashboard` and v21/v57
deletion-log pattern).

The log row holds:
- who, when and on which basis;
- the request key and its hash;
- the variable's id, key, label, short label, owner scope and owner;
- its versions (number, unit, value type, day rule, condition, calculation);
- its levels;
- the counts of every row removed with it;
- copies of its own request and change rows.

The name and the key are free at once, and the list is clean. Nothing that ever used the variable can be lost, because
anything that used it blocks.

**(b) Archive and free the key.**
- The key would be rewritten (for example `<key>__removed_<8>`). v38 freezes a key, so this needs a sanctioned exception
  of its own.
- The row stays visible under the Archived and All filters, so the list is not clean.
- Every reader that assumes a key never changes (template hints, the copy's key) would need checking.

**Recommendation: (a).** It meets the owner's goal, it touches only what never mattered, and its audit is as complete as
v57's. (b) costs a key-freeze exception and still leaves the row in the list.

## 3. Who, idempotency, and locks

**Who may remove**
- A system variable: an active platform admin, in the platform workspace.
- A club variable: that club's active admin, in the club's own workspace (or a platform admin there).
- Coaches and athletes may not. Older user- and team-owned definitions are out of scope.
- Everyone else, including a club workspace looking at a system variable, gets the identical 404 a missing id gets
  (ADR-006).

**The request**
- `POST /api/training-load/sources/metrics/variables/:variableId/remove` with `{ requestKey, reason, expected: { key, label } }`.
- `reason` is mandatory.
- `expected` is compared under the lock, so a stale screen cannot remove a renamed variable.

**Request record and idempotency**
- The removal log is the request record. `metric_variable_requests` cannot be used, because its foreign key would
  remove the record with the variable.
- The same key with the same body answers the saved result from the log; with another body it answers
  `request_key_reused`.
- A new key on a variable already removed gets the identical 404.

**Actor guard (the v35 pattern)**
- The service sets `optimove.source_metric_actor` for the transaction.
- The log's BEFORE INSERT trigger requires that actor to hold the right on the removed owner scope, with the basis the
  database derives (`42501`).
- Only the sanctioned function may delete, under the transaction-local marker `optimove.variable_removal_tx` (the v57
  pattern). The triggers that refuse DELETE today get one exception each, for that marker only:
  - `forbid_update_delete` on versions (a wrapper, so other tables keep the shared function unchanged);
  - the three scope-capability guards;
  - the append-only guards of requests, changes and classification changes.

**Locks**
1. The rights rows, users first (LO-1).
2. The variable's row `FOR UPDATE`.
3. Nothing else is locked.

`FOR UPDATE` conflicts with every lock a writer takes before naming the variable:
- the `FOR KEY SHARE` of every foreign-key check (a value, a mapping, a series, a copy, a link);
- the `FOR SHARE` of the v77–v79 version guard on its inputs (a sum created at the same moment that names it);
- the `FOR SHARE` of the v79 series trigger;
- the dashboard simple save's `FOR SHARE`.

So such a writer either commits first, and the removal then sees the reference and refuses, or it waits, and after the
removal commits it finds no row (`calculation_input_unavailable`, the FK error, `notFound`).

All the reference checks run after the lock. Bounds: `lock_timeout` 5 s, `statement_timeout` 10 s, a bounded COMMIT with
the F2 outcome check (`verified_after_commit_error` / `503 outcome_unknown`). A deadlock or timeout answers `try_again`,
nothing written.

## 4. Migration

**Yes**, ★★ (triggers 1 and 2). It adds:
- the function `training_load.remove_unused_variable(...)`;
- the table `training_load.metric_variable_removal_log` (append-only; no foreign key to the variable; its actor guard);
- the marker exceptions above, with md5 preconditions on every body it replaces.

Number: **v82, if the calendar has not taken it.** v79 is #629, v80 is reserved, and v81 is the calendar's
(`202611191000_calendar_v81_athlete_questions.sql` is on `main`). Please confirm.

The rollback refuses:
- once any removal log row exists (a removed variable cannot be brought back);
- when a body in force is not v82's;
- when a later migration is recorded.

It restores the bodies verbatim.

## 5. The screen

In a variable's detail (Variables tab), beside Archive, for those who may: **Remove this variable**, a quiet button.

When it can be removed, a confirmation:

> **Remove "High Metabolic Load Distance"?** It has never been used: no values, no mapping, no dashboard. It is removed
> for good, with its name and key, and this cannot be undone. Reason (required).

The buttons are **Remove** and **Keep it**. Afterwards: "Removed. Its name and key are free."

When it cannot be removed, the button is replaced by one plain sentence of the first reason. The server reads the
reasons for the detail, so the button is never offered in vain:
- "It has values from 12 sessions. Archive it instead."
- "Power zone distance is mapped to it for First team." (or "for 2 teams", or "in a draft mapping")
- "HMLD adds it up." / "HMLD per minute divides by it."
- "It is on the dashboard Weekly load."
- "A club made its own copy of it."

A refusal at the button (someone used it meanwhile) shows the same sentence, with "Nothing was removed."

## 6. The advice given meanwhile

"Create the calculated ones under another name (HMLD)" is right, with three points:
- **The key is final once created** (v38). The calculated variable keeps the key it is created with, even after the old
  one is removed. If the owner wants `high_metabolic_load_distance` as its key, he should wait for the removal. If any
  key will do, create it now; the **name** can be renamed to the wanted one later (rename, R2).
- **Archive the old conditioned ones now.** They drop out of the pickers, archiving is reversible, and an archived
  variable can still be removed (archiving is not a use).
- **Do not put the old ones on a dashboard or in a category** meanwhile. A dashboard blocks removal. A category placement
  is removed with the variable, but it is still work wasted.

## 7. Today, without this change

- **Can the UI archive a variable?** Yes. The Variables view has Archive and Restore (R2, phase 2c, with a reason) for a
  platform admin's system variables and a club admin's club variables. A team coach may archive a club variable too.
  Archive is refused while an active mapping version pins the variable, or while an active calculated variable uses it.
- **Are an archived variable's name and key reusable?**
  - The **name**: yes. Labels are not unique, so a new variable may carry the same name. The archived one then shows only
    under the Archived and All filters.
  - The **key**: no. It is unique per owner across every state (`metric_definitions_owner_scope_owner_user_id_owner_club_id__key`).
    The key suggestion says it is taken, and the owner must type another key.

## 8. Next, on GO

1. One pull request, ★★: v82 (the function, the log, the guard exceptions), the service and the route, the reasons in
   the variable's read, the screen, tests (every row of section 1 as a block or a removal, the race with a sum created
   at the same moment, the actor guard, idempotency, info-hiding), the runbook with preflight, post-check and rollback.
2. Before the first real removal: the preflight lists the five variables with their values, mappings, series, copies and
   inputs (expected: none). The owner removes them in the app, one by one.
