# Phase 5a — discovery and contract (session roster and completion)

Status: **approved by the owner on 2026-09-25** (contract v2.1 plus the decisions below). Discovery was read from `main` at `73f181b` (merge of PR #121). The contract went through one read-only pass by `db-reviewer`, `code-reviewer` and `ux-design-reviewer` (all NOT READY on v1; every finding applied — section 9) and a narrow second pass (READY WITH NON-BLOCKING NOTES from all three, folded in as v2.1).

**Owner decisions of 2026-09-25** (they override the proposal text wherever the two differ):
- **O1 = (a).** The internal kind stays `participated_no_values`. Its label everywhere is **"Participated · no device data"** (never "Trained · no values"): the state has to hold for a match and for future sources that are not GPS.
- **O2 = team coach + club admin + platform admin.** `decided_by_basis` records the authorization path actually used in the ACTIVE workspace: team workspace as team coach → `team_coach`; club workspace as club admin → `club_admin`; platform workspace as platform admin → `platform_admin`. It is never `platform_admin` just because the user also holds that global role.
- **The completion downgrade triggers of 3.4 move from 5a1 to 5a2.** 5a1 has no write command that can set `complete`, so the largest and riskiest trigger set ships together with the complete/reopen commands. 5a1 keeps the tables, their integrity and append-only rules, and the fingerprint on read.

**Implemented in 5a1** (PR from `feature/activity-roster-foundation-5a1`): migration v25 (`migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql`), `GET /api/training-activity/:activityId/roster` (`backend/src/activityRoster.js`), the GPEXE approval's observations (`backend/src/activitySourceObservations.js`), the undo rule (3.9). Where 5a1 differs in detail from the text below, section 10 says so.

Goal of Phase 5a: after a measured GPS session is imported, the coach sees the team's roster **on the session date** and brings every athlete to a final data state; the session is then marked complete, with who and when.

---

## 0. Findings that shape the design

1. **`activity_participants` must not carry the coach's decision.** It is the identity anchor for links, merges and reparents, and it already means "took part": the Activities list counts canonical participants (`backend/src/routes/trainingLoad.js` ~1581, and the athlete filters ~1517/1541/1587–1607) and the Dashboards athlete filter selects activities through `exists (… activity_participants …)` (`backend/src/trainingLoadDashboardQuery.js` 73/157). A "Did not participate" row there would make that athlete a participant. It is also updated in place (no audit), and a reparent moves the row to another activity. → a separate, append-only decision model.
2. **`participation_status` is not a reliable signal today.** The GPEXE path creates participants through `training.materialize_activity_group_from_metric_event()`, which writes **`'planned'`** (v4 ~578/693); the JS link paths write **`'participated'`** (`trainingActivityMaterialize.js` 413/435/881, `trainingActivityMetricsLink.js` 108/201/314). The v4 header says the status "flips forward once real RPE/GPS/manual confirmation arrives, a caller-layer concern" (v4 518–522) — intended, never built. A measured GPEXE athlete therefore reads `planned`. **Measured is derived from occasions only.** Phases 5a–5c do not write `participation_status` either (it stays a source-side fact).
3. **A team's history on a date cannot be read from `athlete_memberships` today.** `starts_at` is the row's creation time (default `now()`), `ends_at` is never written, and a restore **revives the archived row and clears `archived_at`** (`organization.js` 2211–2216, 2306–2311, `ensureActiveMembership` 3532–3537) — a deliberate choice documented at 3509–3516 (a fresh row per restore once collided with the one-active-row index and made concurrent restores unsafe; the Settings list and its *Show archived* view also read every row). `paused` is allowed by the check but never written. → history is recorded **beside** the membership row, without changing Settings (section 3.1).
4. **"No usable device record" has no durable, source-neutral evidence.** The only evidence is the GPEXE candidate preview (`notImported` / `gps.status`), GPEXE-specific and set to `null` by the retention purge (`raw_bundle = null, preview = null`, v22 ~350). The GPEXE writer creates metric participants **only for imported athletes** (`gpexeImportWriter.js` 359–370). → a small source-neutral observation table written by the adapter at import time.
5. **`entry_method` has no `'estimated'`** (v13 check `manual | api_import | csv_import`), the Dashboards `source_policy` check has no estimated option (v16 365–366; the default `all_with_conflicts` would include estimates silently), and the Activities drawer falls back to **`manual`** when the method is missing (`frontend/training-load-calendar-view.js` 345/610). → all three change in the PR that first writes an estimate (5b).
6. `canonical_activity_results()` (ADR-001) returns every **effective** measured value per canonical participant with its `entryMethod`, following the activity and participant alias chains, and deliberately excludes `needs_review` occasions. The read model reuses it for *Measured*, and every new table follows the same canonical rule (section 3.0).
7. `training.activity_metric_event_links` allows **several confirmed events per activity** (unique only on `metric_event_id`). Manual and estimated values can therefore live in a coach-owned event linked to the same activity, leaving the source's event untouched (5b).
8. **Existing deletions touch these rows.** The admin undo (`backend/scripts/gpexe-undo-imported-session.mjs` 263–280) deletes an imported session's activity and occasions; any new table that references them needs a stated rule (section 3.9).

---

## 1. Existing / extend / new

| Need | Existing object | Verdict | Why |
|---|---|---|---|
| Historical roster | `public.athlete_memberships` (`starts_at`, `ends_at`, `archived_at`, `status`) | **New** `public.athlete_membership_periods`, written by a trigger on `athlete_memberships`; Settings code unchanged | The membership row keeps its documented reuse-on-restore; each active ↔ archived change opens or closes a period, so the history is kept from now on. |
| Participation (source side) | `training.activity_participants.participation_status` | **Keep as is, do not extend** | Findings 1–2. |
| Coach decision per athlete | — | **New** `training.activity_athlete_decisions` | Append-only with a current pointer; the audit is the table. |
| Request idempotency | pattern: `metric_write_requests`, `activity_write_requests` | **New** `training.activity_roster_requests` | One key per request, however many rows it writes. |
| Reason for not participating | — (`note` exists on participants) | **New** catalog `training.participation_reasons` | Stable keys, visible labels, never numbers. |
| Manual values | occasions `entry_method = 'manual'`, `recorded_by_user_id`, `created_at`; H4 Source filter `manual` | **Existing** (used in 5b) | Values stay in Metrics Core; a decision points at the occasion. |
| Source / imported values | occasions `api_import` / `csv_import`, `metric_source_identities.current_occasion_id`, `import_conflict_status` | **Existing** | *Measured* and *change waiting* are derived from them. |
| Estimated values | — | **Extend** `entry_method` with `'estimated'` + **new** `training_load.metric_estimations` (5b) | Owner decision: estimates are measurements of their own kind with mandatory provenance. |
| Superseded values | `supersedes_*` / `superseded_by_*`, `metric_values` append-only | **Existing** | Nothing new for values. |
| Audit who/when | occasions `recorded_by_user_id`; `activity_field_correction_log`; append-only logs (dashboard / import deletion, approvals) | **Pattern reused** | Decisions and completion get their own append-only rows. |
| Unusable source record | GPEXE candidate preview only (purged) | **New** `training.activity_source_observations` | Durable, source-neutral, written by the adapter. |
| Session completion | — | **New** `training.activity_completions` + `training.activity_completion_log` | One row per canonical activity; history in the log; `training.activities` stays untouched (strict identity/lifecycle triggers). |
| Who may decide | `canManageTeamById` (`authz.js` 136), GPEXE `resolveGpexeTeamAccess` (archived team → 404), `lock_gpexe_import_approver` (v23) | **Reuse the shape**, source-neutral name | The import grant stays separate. |

---

## 2. States (derived, one per roster athlete)

Derived in this order; the first rule that matches wins.

| # | State (UI: glyph + word) | Derived from | Group |
|---|---|---|---|
| a | ✕ **Did not participate** · reason | current decision `did_not_participate` | done |
| b | ▢ **Participated · no device data** (O1 (a)) | current decision `participated_no_values` | done |
| c | ✎ **Manual values** | current decision `manual_values` → a `manual` occasion (5b) | done |
| d | ◇ **Estimated** · method | current decision `estimated` → an `estimated` occasion + provenance (5b) | done |
| e | ● **Measured · change waiting** | an effective measured value **and** (a `needs_review` occasion for the participant **or** an open `change_pending` observation) | needs review (does not block) |
| f | ● **Measured** | an effective `api_import` / `csv_import` value in `canonical_activity_results()` | done |
| g | ◐ **No usable device record** · source reason | an open `record_unusable` observation and no decision | **needs a state** (blocks) |
| h | ○ **Unknown** | none of the above | **needs a state** (blocks) |

Flags (shown next to the state, never replacing it):
- **Measured values arrived after the decision** — a current decision a–d **and** an effective measured value. A decision is refused while a measured value exists. Against a GPEXE import this is guaranteed by the shared team lock (3.6); other writers (late links in `trainingActivityMetricsLink.js`, non-GPEXE measurement paths) do not take that lock, so a value committed at the same moment can also end up here. The flag and the *Needs review* group are the same either way, and nothing is hidden. No timestamps are compared. Group: needs review. Offers `Use the measured values` (clears the decision) / `Keep this decision`.
- **Left the team DD Mon** — the membership period ended after the session; the athlete stays on that roster and still needs a state (owner decision 3).
- **Decisions disagree after a merge** — two alias activities hold different current decisions for the athlete (3.0). Group: needs a state. Row: `Two states after a merge: Did not participate · Illness (Goran Babić) / Participated · no device data (Mira Lukić). (Keep one)`; a choice supersedes both, and the API accepts either current id as `expectedDecisionId`.
- *Recorded, but joined the team after this date* — a measured athlete whose period does not cover the session: listed in a folded group, never blocks.

Two labels, used everywhere: **Needs a state** (blocks *Complete*, counted in the header) and **Needs review** (does not block). Empty is never zero.

---

## 3. Schema proposal

Source-neutral names (`training.*`, `training_load.*`, one `public.*` history table); nothing is `gpexe_*`. Migration numbers follow the current v24; 5a1 is v25.

### 3.0 Canonical activity rule (applies to every table below)

Activities can be superseded later (`merge_activity_participants`, `reparent_activity_participant`, v4; team→team is legal). So, as in `canonical_activity_results()`:
- **Writes** resolve `training.resolve_canonical_activity_id(:id)` first and store that id; a write to a non-canonical id answers `409 activity_superseded` with the canonical id.
- **Reads** of decisions, completion and observations use `training.activity_alias_ids(canonical)` — the union over the alias set.
- **One current decision per athlete across the alias set**: the partial unique index guards one activity; the write path supersedes every current decision of the athlete in the whole alias set (under the lock of 3.6); the read model shows *Decisions disagree after a merge* if a merge brought two current decisions together, until the coach decides once.
- **Completion follows the survivor**: a supersede downgrades the survivor's completion (`roster_changed`) and the superseded activity's own completion row stays as history.

### 3.1 Membership periods (5a1)

```
public.athlete_membership_periods          -- append-only except closing valid_to once
  id              uuid pk default gen_random_uuid()
  membership_id   uuid not null references public.athlete_memberships(id) on delete cascade
  athlete_id      uuid not null
  club_id         uuid not null
  team_id         uuid
  membership_type varchar(20) not null check (membership_type in ('club', 'team'))
  valid_from      timestamptz not null
  valid_to        timestamptz
  created_at      timestamptz not null default now()
  check (valid_to is null or valid_to >= valid_from)
unique index … on (membership_id) where valid_to is null            -- one open period per membership
index … on (team_id, valid_from) where membership_type = 'team'
```
Trigger `athlete_memberships_record_period` (after insert or update of `status`), with every legal pair listed in the migration: insert `active`/`paused` → open a period at `starts_at`; insert `archived` → a closed period from `starts_at` to `coalesce(archived_at, now())`; `active` ↔ `paused` → no change (still a member); `active`/`paused` → `archived` → close the open period at `coalesce(new.archived_at, now())`; `archived` → `active`/`paused` → open a new period at `now()`. A second small guard refuses an UPDATE of `athlete_id`, `club_id`, `team_id` or `membership_type` (the period copies them; the app never changes them). The membership row itself is unchanged, so Settings (restore, *Show archived*, concurrency) behaves exactly as today and the existing tests that write `status = 'archived'` directly still pass. `on delete cascade` follows the membership (a deleted athlete/team is gone everywhere).

Backfill (in v25): one period per existing row — `valid_from = starts_at`, `valid_to = archived_at` for archived rows, `null` for active/paused; an archived row with `archived_at is null` (possible from raw test/admin writes) closes at `updated_at` — the migration reports the count before and after.

Roster rule — `training.activity_roster(p_canonical_activity_id)`, team-owned activities only, **distinct per athlete**:
- when `started_at` is known: periods of `owner_team_id` with `valid_from <= started_at < coalesce(valid_to, 'infinity')`;
- else: periods overlapping the activity's local day `[occurred_local_date 00:00, +1 day)` in `timezone_snapshot`.

Known limitation: a membership archived **and restored before v25** lost its gap — such an athlete appears on rosters inside that gap (over-inclusion, never omission); the coach resolves it with *Did not participate* · `other`. `valid_from` is the moment the athlete was added in OptiMove, not a sporting join date.

### 3.2 Reason catalog (5a1)

```
training.participation_reasons
  key         text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$')
  label       text not null
  sort_order  smallint not null
  is_active   boolean not null default true
  created_at  timestamptz not null default now()
```
Seed: `non_contact_injury`, `contact_injury`, `illness`, `load_management`, `other_team`, `other`. A trigger refuses DELETE and a key change (deactivate instead). Club-specific entries are a later extension.

### 3.3 Requests and decisions (5a1 tables, 5a2 writes)

```
training.activity_roster_requests          -- append-only; idempotency per request, not per row
  id                   uuid pk
  activity_id          uuid not null references training.activities(id)      -- canonical at write time
  request_key          uuid not null
  request_hash         text not null check (request_hash ~ '^[0-9a-f]{64}$') -- sha256 of the canonical body
  operation            varchar(20) not null check (operation in ('decide', 'decide_bulk', 'clear', 'complete', 'reopen'))
  performed_by_user_id uuid not null references public.users(id)
  result               jsonb not null
  created_at           timestamptz not null default now()
  unique (activity_id, request_key)

training.activity_athlete_decisions
  id                        uuid pk
  activity_id               uuid not null references training.activities(id)   -- canonical at write time
  athlete_id                uuid not null references public.athletes(id)
  owner_team_id             uuid not null references public.teams(id)          -- = activity.owner_team_id
  request_id                uuid not null references training.activity_roster_requests(id)
  decision_kind             varchar(30) not null check (decision_kind in
                              ('did_not_participate', 'participated_no_values', 'manual_values', 'estimated', 'cleared'))
  reason_key                text references training.participation_reasons(key)
  note                      text check (note is null or length(note) <= 500)
  occasion_id               uuid references training_load.metric_measurement_occasions(id)
  decided_by_user_id        uuid not null references public.users(id)
  decided_by_basis          varchar(20) not null check (decided_by_basis in ('team_coach', 'club_admin', 'platform_admin'))
  decided_at                timestamptz not null default now()
  superseded_by_decision_id uuid references training.activity_athlete_decisions(id)
  superseded_at             timestamptz
  check ((decision_kind = 'did_not_participate') = (reason_key is not null))
  check ((decision_kind in ('manual_values', 'estimated')) = (occasion_id is not null))
  check ((superseded_by_decision_id is null) = (superseded_at is null))
  unique (request_id, athlete_id)
unique index activity_athlete_decisions_one_current on (activity_id, athlete_id) where superseded_by_decision_id is null
```
- `cleared` returns the athlete to his derived state (Unknown, No usable device record, or Measured) while keeping history.
- `participated_no_values` is O1 (a), shown as *Participated · no device data*; the value kinds are listed now but refused until 5b (in 5a1 by the decision trigger; the 5a2 API answers `kind_not_available`).
- Triggers: (1) append-only — UPDATE only sets `superseded_*` once; DELETE / TRUNCATE refused; (2) **integrity** — activity is canonical and `owner_scope = 'team'`, `owner_team_id` equals the activity's (on insert; immutable after), the athlete is on `training.activity_roster()`; (3) **value kinds** — `manual_values` needs an occasion with `entry_method = 'manual'`, `estimated` needs `'estimated'` (and, in 5b, its provenance); the occasion belongs to this athlete in this activity's alias set; (4) **measured is never overridden** — every kind except `cleared` is refused while the athlete has an effective `api_import` / `csv_import` value in the alias set (→ `409 measured_record_exists`); (5) the decider's right is re-checked in the transaction (3.6).

### 3.4 Completion (5a1 tables and fingerprint on read, 5a2 writes and downgrade triggers)

```
training.activity_completions
  activity_id            uuid primary key references training.activities(id)   -- canonical
  owner_team_id          uuid not null references public.teams(id)
  status                 varchar(20) not null check (status in ('not_complete', 'complete', 'needs_review'))
  revision               integer not null default 0 check (revision >= 0)
  completed_by_user_id   uuid references public.users(id)
  completed_by_basis     varchar(20) check (completed_by_basis in ('team_coach', 'club_admin', 'platform_admin'))
  completed_at           timestamptz
  input_fingerprint      text                -- sha256 over the sorted (athlete_id, state, decision id, effective occasion ids) at completion
  needs_review_causes    text[] not null default '{}'
  updated_at             timestamptz not null default now()
  check ((status = 'complete') = (completed_by_user_id is not null and completed_at is not null and input_fingerprint is not null))
  check ((status = 'needs_review') = (cardinality(needs_review_causes) > 0))

training.activity_completion_log     -- append-only (UPDATE/DELETE/TRUNCATE refused)
  id uuid pk, activity_id uuid not null references training.activities(id), request_id uuid references training.activity_roster_requests(id),
  revision integer not null, from_status varchar(20), to_status varchar(20) not null,
  cause varchar(30) not null check (cause in ('completed', 'reopened', 'decision_changed', 'roster_changed', 'measurement_changed',
                                              'link_changed', 'activity_merged', 'change_pending', 'record_unusable', 'input_changed')),
  performed_by_user_id uuid references public.users(id),     -- null for a system cause
  detail jsonb not null default '{}', created_at timestamptz not null default now()
```
- The row is created on the **first write** (decision or complete), never on a read; absence = `not_complete`, revision 0.
- A trigger checks `owner_team_id` against the activity on insert and forbids changing it.
- **`revision` is bumped by every write that touches the roster**: every decision row (any kind, any status), complete, reopen, and every system downgrade. It is the roster's single optimistic token.
- **Setting `complete`** is done by the command under the lock (3.6): it recomputes the derived roster and its fingerprint there, refuses with `roster_incomplete` if any athlete needs a state, and otherwise stores the new fingerprint.
- **`complete` never stays true** — two layers:
  1. *Downgrade triggers* (**5a2**, with the complete/reopen commands — owner decision 2026-09-25; same transaction, only ever `complete → needs_review`, never blocking the writer): a decision insert; an occasion insert that is effective and measured, or an occasion UPDATE of `import_conflict_status` / `superseded_by_occasion_id` (effective → not effective); a `metric_source_identities.current_occasion_id` change; an `activity_participant_metric_participant_links` insert or `link_status` change; an `activity_participants.activity_id` change (reparent — source and target activity); `activities.superseded_by_activity_id` set; an `activity_metric_event_links` confirmed insert; an observation insert or resolve; a membership period opened or closed with an interval that covers a completed activity of its team. Each resolves the canonical activity, appends a cause, bumps `revision`, writes a log row. **Fan-out locks completion rows in ascending `activity_id` order** (the v4 reparent/merge convention), before updating.
  2. *Fingerprint on read*: `GET …/roster` recomputes the fingerprint; if it differs from the stored one while `status = 'complete'`, the answer says `needs_review` (cause `input_changed`) even if a trigger was missed. A write then persists that downgrade (cause `input_changed`). Other surfaces (the Activities agenda tag) read the stored status and rely on the triggers until the roster is opened; 5a2 carries a test per reachable cause to prove the trigger list is complete.
- `reopen` (API only in 5a): `complete | needs_review → not_complete`, logged.

### 3.5 Source observations (5a1)

```
training.activity_source_observations
  id                    uuid pk
  activity_id           uuid not null references training.activities(id)   -- canonical at write time
  athlete_id            uuid not null references public.athletes(id)
  source_connection_id  uuid not null references training_load.metric_source_connections(id)
  kind                  varchar(20) not null check (kind in ('record_unusable', 'change_pending'))
  reason_code           varchar(40) not null check (reason_code ~ '^[a-z][a-z0-9_]{1,39}$')   -- neutral: needs_manual_review, marked_invalid_by_source, …
  observed_at           timestamptz not null default now()
  resolved_at           timestamptz
  adapter_ref           jsonb not null default '{}'       -- ids only (e.g. approvalId); Technical details
unique index … on (activity_id, athlete_id, source_connection_id, kind) where resolved_at is null
```
Append-only except one `resolved_at` write. The GPEXE approval writes `record_unusable` for every **linked team athlete** the plan refused, in its own transaction; a later approval that imports him resolves it. `change_pending` is written when a newer version of an imported session is found, resolved when imported or dismissed (5c). Neutral reason codes map from adapter codes as `gpexeImportReasons.js` does for the list; the UI uses the same reason texts as Imports.

### 3.6 Right to decide and lock order (5a1 function, every write)

`training.lock_activity_decider(p_user_id, p_team_id, p_basis) returns varchar` (owner decision O2) — checks exactly the path named by `p_basis`, the one the caller uses in the active workspace: `team_coach` (an active `user_team_roles` row for the team), `club_admin` (an active `user_club_roles` row for the team's club, the club active) or `platform_admin` (an active `user_global_roles` row). The team row (active) and the role and user rows (active) are held `FOR SHARE`; it returns the basis or raises `42501` (an unknown basis: `22023`). There is no priority order: a stronger role held elsewhere never replaces the active path. The decision and completion triggers call it with the recorded basis, so a row can never claim a path its author does not hold. The import grant plays no role.

**Lock order for every decide / bulk / clear / complete / reopen request** (one transaction):
1. `lock_activity_decider` (team, role and user rows `FOR SHARE`);
2. `lockTeamForImport(owner_team_id)` — the same team advisory lock the import approval holds, so a decision and an import of the same team never interleave (the "measured is never overridden" check cannot miss an uncommitted import);
3. completion rows `FOR UPDATE` for the canonical activity (and, on a merged set, every alias in ascending id);
4. request-key lookup, checks, inserts.

The import approval already takes roles → candidate → team lock; its downgrade triggers then take completion rows in ascending id — the same relative order, so no cycle. Membership changes take the membership row, then completion rows in ascending id; the decision path never locks membership rows, so no cycle either. The known unbounded pre-COMMIT waits of the approval (Separate tasks, condition 2) extend to these locks; the future `lock_timeout` must cover them too.

### 3.7 Estimates (5b — for completeness)

- `metric_measurement_occasions.entry_method` gains `'estimated'`, with `entry_method <> 'estimated' or (source_identity_id is null and import_batch_id is null)`.
- `training_load.metric_estimations` (append-only, 1:1 with an `estimated` occasion): `occasion_id` unique, `method_key`, `method_version`, `reference` jsonb (athlete ids, activity ids, occasion ids, display-name snapshot), `threshold_binding_hash`, `minutes_occasion_id` (the manual Time occasion), `metrics_produced` / `metrics_refused` jsonb, `confirmed_by_user_id`, `confirmed_at`. Both directions are checked by **deferred constraint triggers**: an `estimated` occasion without its row, and a row whose occasion is not `estimated`, both fail at commit. No formula is part of this.
- Values for athletes without a source record live in one coach-owned metric event per activity (owner team, no source connection), linked to the same activity; the source's event is never edited.
- Same PR: Dashboards `source_policy` gains `estimated` and a series says when estimates are included; Activities stop falling back to `manual`.

### 3.8 Database invariants — how each one is enforced

| Invariant | Mechanism |
|---|---|
| At most one active final state per activity + athlete | partial unique index per activity; write path supersedes across the alias set under the lock; read model flags a merge conflict (3.0) |
| A measured record cannot be marked manual / estimated | `entry_method` immutable (existing trigger); decision trigger (4) under the shared team lock; estimated occasions carry no source identity (5b) |
| No estimate without provenance | deferred constraint triggers, both directions (5b) |
| A change of decision leaves an audit trail | append-only decisions with `superseded_*` and `cleared`; request rows; completion log |
| Completion never stays true after a roster or state change | downgrade triggers on every input (3.4, **5a2**) + fingerprint on read (5a1) |
| Team and athlete match the activity and the roster on the session date | decision trigger (2) with `activity_roster()`; `owner_team_id` checked and immutable on decisions and completions |

### 3.9 Interaction with the admin undo

The undo (`backend/scripts/gpexe-undo-imported-session.mjs`, disposable databases only today) deletes an imported session's activity and occasions. Rule: observations are import by-products — the undo deletes them and counts them in `import_deletion_log`; **decisions, requests and completion rows are coach work** — the undo refuses with a stable reason (`roster_decisions_exist`) while any exist for the activity or its aliases. In 5a1 the observations' append-only trigger joins the undo's protected-trigger list (`PROTECTED_TRIGGERS`) and its re-enable check. The admin step that clears coach rows (a sanctioned, logged function) is defined before condition 4 (the wrong-link procedure required before regular production imports) is closed; 5a itself does not need it.

---

## 4. API contract (not implemented)

Under the existing `/api/training-activity` router (`server.js` 102), `requireAuth`. Only **team-owned** activities have a roster; the UI hides the Roster section for others, and the API answers `409 roster_not_applicable`.

**Access.** Read: the canonical activity's `owner_team_id` is managed by the caller (`canManageTeamById`) **in a workspace that contains the team** (team workspace; club workspace of its club for a club admin; platform workspace for a platform admin) and the team is active — else `404 notFound`, identical for a missing activity (ADR-006); the workspace is resolved once per request. Write: the same, then the lock order of 3.6 (`42501 → 403 not_a_team_coach`).

**Idempotency (every write).** `requestKey` (uuid) is looked up **first**, under the lock, across the whole alias set of the addressed activity (a retry after a merge still finds its first result, before any `activity_superseded` check): the same key and the same body hash → authorization is checked again, then the stored result is returned (a retry after a lost answer never gets a false conflict); the same key with a different body → `409 request_key_reused`. Only a new key goes on to the concurrency checks.

| Endpoint | Body | Concurrency | Success | Stable errors |
|---|---|---|---|---|
| `GET /api/training-activity/:activityId/roster` | — | returns `revision` | `200 { activity, canonicalActivityId, completion: {status, revision, completedBy, completedAt, needsReviewCauses}, athletes: [{athleteId, name, membership: {from, to, leftAfterSession}, state, group, decision: {id, kind, reasonKey, note, decidedBy, decidedAt} \| null, flags, sourceReason, values}], joinedAfterSession: [...], reasons: [{key, label}], counts: {total, needsState, needsReview}, canComplete }` | `404 notFound`, `409 roster_not_applicable` |
| `PUT …/roster/:athleteId/decision` | `{ kind, reasonKey?, note?, expectedDecisionId (uuid\|null), requestKey }` | `expectedDecisionId` = the athlete's current decision (across the alias set) | `200 { decision, athlete, completion }` | `400 invalid_kind` / `reason_required` / `reason_not_allowed` / `unknown_reason` / `note_too_long` / `invalid_request_key`; `404 notFound`; `409 decision_changed {current}` / `not_on_roster` / `measured_record_exists` / `kind_not_available` / `request_key_reused` / `activity_superseded {canonicalActivityId}` / `roster_not_applicable`; `403 not_a_team_coach` |
| `DELETE …/roster/:athleteId/decision` | `{ expectedDecisionId, requestKey }` | as above; writes a `cleared` row | `200` | as above |
| `POST …/roster/decisions` (bulk) | `{ kind, reasonKey?, note?, athletes: [{athleteId, expectedDecisionId}], requestKey }` — 1–60 distinct athletes, one kind/reason for all | **all or nothing**, one transaction, one request row | `200 { decisions, completion }` | as the PUT, plus `400 too_many_athletes` / `duplicate_athlete`; a `409` lists each failed athlete with its current state |
| `POST …/completion/complete` | `{ expectedRevision, requestKey }` | `expectedRevision` = current revision | `200 { completion }` | `409 revision_changed {revision}` / `roster_incomplete {needsStateAthleteIds}` / `request_key_reused`; `403`; `404` |
| `POST …/completion/reopen` | `{ expectedRevision, note?, requestKey }` | as above | `200 { completion }` | `409 revision_changed` / `not_complete` |

Stable codes only; database text never reaches the client (explicit `internal_error` mapping, as in the batch route).

---

## 5. UX flow (coach)

1. **Way in.** A *Roster* section in the Activities drawer of a team session; after an import, the Imports result row offers *Open roster*. Header (two lines on a phone): `Full training · 18 Sep, 17:00` / `16 on the roster · 3 need a state · 1 needs review`. Under it: `Each state is saved as soon as you choose it.`
2. **Roster.** Desktop: a table, **Needs a state** rows first, then **Needs review**, then done. Phone (360–390 px): cards, chip filters *Needs a state* (default) · *Needs review* · *All*; a card stays after a choice, marked `Saved`, until the filter changes; an empty filter says `All 16 athletes have a state.` next to *Complete*. Each row: name, **glyph + word** state, key values (`—` for missing, never 0), who/when for a decision. Legend in display order: ○ ◐, then ✕ ▢ ✎ ◇, then ●. Measured rows have no controls. `Left the team 20 Sep` next to the normal state. Folded group `Recorded, but joined the team after this date (2)`.
3. **Set a state (5a).** ○ and ◐ rows show `Set state ▾` and a checkbox.
   - ○ Unknown: *Did not participate* (reason required, note optional, counter 0/500) and *Participated · no device data*.
   - ◐ No usable device record: the row says the source's reason (`GPEXE flagged this record for a manual check — fix it in GPEXE, then find new sessions`; the word *review* is kept for the *Needs review* group); *Participated · no device data* first; *Did not participate* asks first: `GPEXE has a record for this athlete. Mark him as not participating anyway?`
   - *Manual values* and *Estimate* appear in 5b.
   - On a phone, reasons open as a sheet of rows at least 44 px high; the sticky bottom bar shows the selection actions while selecting and *Complete* otherwise.
4. **Bulk.** `Select all that need a state`, then `Did not participate ▾` → one reason → `Apply to 4 athletes`. ◐ rows are left out of a bulk absence and named in the confirmation. On a conflict: `Nothing was saved. 1 athlete changed: Ivan Marković (now Measured). (Apply to the other 3)` — the selection stays, minus the changed row.
5. **Change.** Every decided row keeps `(Change)`: another state, or `Remove this state`. On a complete session it asks first: `This session is complete. Changing this state marks it for review.` A separate `History` disclosure shows who/when/what; ids stay in Technical details.
6. **Flags.** *Measured values arrived after the decision by Goran Babić, 18 Sep*: `Use the measured values` (clears the decision) / `Keep this decision`; refused kinds are not offered on such a row. *Measured · change waiting*: `(Review the changes)` opens the session in Imports.
7. **Complete session.** Enabled when nothing needs a state; otherwise `3 athletes need a state` with a jump to the first. Confirm: `Mark this session complete? All 16 athletes have a state. A coach of this team can change it later.` (+ `1 athlete has a change waiting from GPEXE.` when so). After: `Complete — Mira Lukić, 18 Sep 19:20`. No Reopen button in 5a (a Change or a later change already covers it).
8. **When something changes later.** The header names athletes and causes (`Changed after completion — Ivan Marković: measured values arrived; the roster changed`) and offers *Complete* again (without an athlete: `An athlete link changed` · `This session was merged with another` · `Something in this session changed after completion — check the rows and complete again.`). Outside the roster: `Needs review` is always shown on the Activities agenda row and drawer; `Not complete` only where completion was started or the session has imported values (older, planned and RPE-only sessions get no tag); the Imports result says `This session was complete — it now needs review · (Open roster)`.
9. **Errors, in the coach's words.** `decision_changed`: `Goran Babić changed this athlete a moment ago (now: Did not participate · Illness). Your choice was not saved.` · `revision_changed` / `roster_incomplete`: `The roster changed since you opened it — check the highlighted athletes and complete again.` · `measured_record_exists`: `GPEXE values for Ivan Marković just arrived; he is now Measured.` · `not_on_roster`: `… is no longer on this session's roster.` · `activity_superseded`: `This session was merged into another — (Open the current session).` · `403`: `You are no longer a coach of this team.` · `404`: `This session is not available any more.` · a lost answer / `internal_error`: `Not sure it was saved. (Try again) — it will not be saved twice.`

---

## 6. PR plan

| PR | Scope | Reviewers |
|---|---|---|
| **5a1** schema + read model | v25: membership periods (trigger + backfill); reason catalog + seed; requests, decisions, completions, completion log, observations (tables, integrity and append-only triggers, `activity_roster()`, `lock_activity_decider()`); GPEXE approval writes `record_unusable`; undo rule of 3.9; `GET …/roster` with the fingerprint | db, code, security; external (1, 2, 3, 4) |
| **5a2** decisions + completion commands | PUT / DELETE / bulk decisions, complete, reopen — lock order, request idempotency, all stable errors; **the completion downgrade triggers of 3.4** (occasions, links, membership, merges, observations; moved here from 5a1 by the owner, 2026-09-25) with a test per reachable cause; concurrency tests (decision vs import, two coaches, bulk + retry + reuse, reparent/merge after completion, team-lock contention) | code, db, security; external (1, 2, 3, 4) |
| **5a3** roster UI | roster table and cards, Set state, bulk, Change, flags, Complete, status on Activities and Imports | code, ux, mobile |
| **5b** manual + estimates | `'estimated'`, `metric_estimations`, coach-owned event, manual / estimate entry, Dashboards source policy + Activities labels | db, code, security, ux, mobile; external (1, 3) |
| **5c** later measurement | `change_pending` from the adapter; per-session confirmation (owner decision 1) | code, db, ux; external (1, 3, 4) |

The membership change no longer touches Settings, so no separate 5a0 is needed. The downgrade triggers moved to 5a2 (owner decision 2026-09-25): 5a1 ships the tables and the read model only, with no way to write a decision or a completion yet.

---

## 7. Discrepancies between the blueprint v3.1 / CURRENT_STATE and the code

1. Blueprint §12: *participation_status "written only by import / materialization, always participated"* — the GPEXE path writes `planned`; the JS paths write `participated`; the forward flip described in v4 was never built.
2. Blueprint §10.1 state 7 (*Unknown = no row or still `planned`*) would label measured GPEXE athletes Unknown; measured comes from occasions.
3. Blueprint §10.4 / §11: *extend `activity_participants` with reason and set-by* — rejected (finding 1).
4. Blueprint §10.1 state 6: *evidence = the session's last check* — GPEXE-specific and purged; replaced by `activity_source_observations`.
5. Blueprint §11: *verify membership dates; add `valid_from`/`valid_to` only if missing* — the columns exist but the history is overwritten on restore by design; history goes to `athlete_membership_periods`.
6. Blueprint §11 puts completion columns on `training.activities` — a separate table (identity/lifecycle triggers; own log and revision).
7. Blueprint §7 (5a) includes session context and one `POST /completion` with all decisions; the owner's current order excludes context and asks for per-athlete, bulk and complete/reopen endpoints.
8. Blueprint §10.1 has *Participated, no GPS*; the owner's seven states do not — O1.
9. Blueprint §11: *completion checked in the command, not by a trigger* — kept for **setting** complete; **downgrading** is by trigger (the owner requires that completion never stays true after a change).
10. Blueprint §10–11 key everything to "the session"; the code allows merged and reparented activities — the canonical rule of 3.0 is new.
11. CURRENT_STATE on `main` (`73f181b`): header still `655b56f`, *Phase 4b in progress*, *Most likely next step: Phase 4b* — to be updated with the next PR (owner's instruction).
12. CURRENT_STATE Separate tasks: *Athletes who trained without a GPS record — options, none decided* — superseded by the owner's decisions of 2026-09-23 and this phase.
13. CURRENT_STATE: *v22–v24 not applied to the local OPTIMOVE (at v21)* — not re-verified here (no database was read).

---

## 8. Decisions that were open (both decided 2026-09-25)

- **O1 — a participant with no values** (was "Trained · no values"). The seven states have no final state for an athlete who trained but has no values the coach wants to enter or estimate (a forgotten vest; an unusable record accepted as such).
  - (a) Add `participated_no_values`, shown as *Participated · no device data*: resolves the athlete, adds nothing to totals. Cost: an eighth state; the athlete is still not an `activity_participants` row, so the Activities *Athletes N* count leaves him out until that count reads decisions too.
  - (b) Require *Manual values* (at least Time, which the coach usually knows) or *Estimated*. Cost: only from 5b — until then such a session cannot be completed except by marking the athlete absent.
  - (c) Keep seven states and accept that sessions with such athletes are completed after 5b.
  - **Decided 2026-09-25: (a)**, labelled *Participated · no device data*.
- **O2 — Who may decide.** The rule says *every active coach of the team*; club admins of the team's club and platform admins can manage the team today (`canManageTeamById`). **Decided 2026-09-25: all three, and the basis is the path of the active workspace** (see the status block).

(O3 of v1 — changing membership restore — is gone: history is recorded beside the membership row.)

---

## 9. Review of v1 and what changed

| Reviewer · severity | Finding | v2 |
|---|---|---|
| code · HIGH | Restore-as-new-row reverses a documented decision (concurrent restores, *Show archived*, tests) | 3.1: periods table by trigger; Settings unchanged; O3 removed |
| code · HIGH, db · HIGH | Decisions/completion keyed at write time, blind to merge/reparent/supersede and late links | 3.0 canonical rule; 3.4 downgrade triggers on links, reparent, supersede, event links; fingerprint on read |
| db · HIGH | Downgrade on occasions only on insert, not when an effective occasion stops being effective | 3.4: occasion UPDATE and current-occasion change added |
| db · HIGH | No deterministic lock order in the membership fan-out | 3.4 / 3.6: completion rows in ascending id |
| code · HIGH | Check-then-act race between a decision and an import; "after the decision" by timestamps | 3.6: shared team import lock and full order; 2: coexistence rule, no timestamps |
| code · HIGH | One `requestKey` per bulk vs a unique key per decision row; retry semantics | 3.3 `activity_roster_requests`; 4: key first, hash, re-authorization, `request_key_reused` |
| ux · HIGH | A ◐ row in 5a could only end as a false absence, also in bulk | 5.3–5.4: confirm on ◐, ◐ excluded from bulk, *Participated · no device data* first; O1 reframed |
| code · MEDIUM | Undo vs new tables | 3.9 |
| db · MEDIUM | Roster distinct; `owner_team_id` protection; revision semantics | 3.1 distinct; 3.4 trigger; revision bumped by every write |
| ux · MEDIUM (8) | Needs a state vs Needs review; flags' actions; change waiting link; surfacing needs-review outside the roster; save model; error texts; bulk conflict; reason texts | 2 and 5 |
| code · LOW | Same-day over-inclusion; legacy archived rows; v4 intent | 3.1 instant rule and backfill; finding 2 |
| db · LOW | Basis priority; 5b deferred-trigger direction; approval wait risk extends | 3.6; 3.7; 3.6 |
| ux · LOW | History disclosure, Complete wording, no Reopen button, "Remove this state", left-the-team tag, folded group, mobile | 5 |

**Second pass on v2** — db, code, ux: READY WITH NON-BLOCKING NOTES. Folded in as v2.1: the coexistence guarantee scoped to GPEXE imports (2); merge-conflict row text and either-id concurrency (2); every legal membership status pair and an identity guard (3.1); the `input_changed` cause and `complete` recomputing the fingerprint under the lock (3.4); a test per reachable downgrade cause (3.4); idempotency lookup across the alias set (4); the undo protected-trigger list and the admin clearing step before condition 4 (3.9); `Not complete` tag scope, cause wording without an athlete, the ◐ wording, the mobile sticky bar and reason sheet, the O1(b)/(c) row note (5). Left for 5a2 as announced: a contention test for the team lock on decision writes.

---

## 10. As built in 5a1 (differences in detail from the text above)

- **The downgrade triggers are not in v25** (owner decision). Until 5a2 nothing in the application writes `activity_completions`, `activity_athlete_decisions` or `activity_roster_requests`; the roster read already compares the fingerprint of a `complete` row and reports `needs_review` / `input_changed` without writing.
- **Deferred checks.** `activity_athlete_decisions.request_id` and `superseded_by_decision_id` (and `activity_completion_log.request_id`) are checked at commit: a write inserts its decisions, then the one request row carrying the answer, and points the previous decision at the new one before the new one exists (the one-current index allows one current row at a time). A deferred constraint trigger checks that the request belongs to the decision's activity and that a superseding decision is about the same athlete of the same team in the same alias set.
- **Value kinds.** `manual_values` and `estimated` are refused by the decision trigger until 5b; `cleared` is the only kind allowed next to a measured record.
- **Membership periods.** Written only by the membership trigger (a transaction-local setting, `optimove.membership_period_write`, keeps a raw write out, the same pattern as `training.allow_supersede_write`); removed only with their membership (`ON DELETE CASCADE`). A restore opens the new period no earlier than the end of the previous one: `now()` is a transaction's start, and a restore that waited on the row lock behind an archive could otherwise start before that archive's end (found by the concurrency test).
- **Write order 5a2 must keep.** The one-current index is a partial unique index and cannot be deferred: a new decision is written by first pointing the current one at the new id (`superseded_by_decision_id`, deferred), then inserting the new row, then the request row. The reverse order is a unique violation; 5a2 carries a regression test for it.
- **Decider locks.** `lock_activity_decider` holds the team row, the role row and the user row `FOR SHARE`, and for `club_admin` also the club row, so archiving the team or club, removing the role or deactivating the user waits for the decision (test 24b).
- **Response fields beyond section 4:** per athlete `stateLabel`, `membership.leftAt`, `decision.label`, `decision.activityId` (the alias the decision was written on), `sourceReason.label` and `sourceReason.sourceSystem`; `counts.joinedAfterSession`; `viewer.basis`. When several current decisions agree (the same decision on two aliases before a merge), `decision` is the latest of them.
- **Roster read.** One read-only `REPEATABLE READ` transaction. A missing activity, a malformed id, an archived team and every caller outside the active-workspace path get the identical `404 {"error":"notFound"}`; a club- or user-owned activity gets `409 roster_not_applicable` only for a caller who may manage it in the active workspace. The answer adds `viewer.basis` (the path the viewer would decide with) and two flags beyond section 2: `manual_values_recorded` (a manual value without a decision; the state stays Unknown) and `left_team`. A merge conflict carries `conflictingDecisions`.
- **Observations from the GPEXE approval.** Written in the approval's transaction after the team import lock, from the recomputed preview: `record_unusable` for a linked GPEXE athlete whose record GPEXE itself marks unusable (two tracks or several whole-session rows → `needs_manual_review`; statistics not valid → `marked_invalid_by_source`) and who is on the session's roster on that date; `adapter_ref` holds `approvalId`, `candidateId` and the adapter's reason code, never a name. An athlete the import writes resolves his open observation. An unlinked source athlete, an athlete not on that date's roster (also one who leaves it between the writer's check and its insert: a savepoint skips him), or a session merged into another team's activity is skipped, never a failed import.
- **Undo.** Observations are removed and counted (`activity_source_observations` in the removed counts and in `import_deletion_log`); any decision, request, completion or completion-log row on the activity or its alias set stops the undo with `roster_decisions_exist`; the observations' append-only trigger is in `PROTECTED_TRIGGERS` and in the re-enable check.
- **Known consequence of `valid_from = starts_at`.** An athlete counts from the moment he was added in OptiMove. A GPEXE session from before a team's athletes were added lists its measured athletes under *Recorded, but joined the team after this date* and leaves the roster short; this matters for importing older sessions (see CURRENT_STATE).
