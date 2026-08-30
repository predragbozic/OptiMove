-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v5: unify planned + external results
-- in the SAME training_load.session_feedback table. Runs AFTER v4 (needs
-- training_load.external_assignments to exist for the FK below). Purely
-- additive - does not touch the two already-deployed training_load
-- migrations' own statements; widens the same table exactly the way
-- 202608320900 itself already did on top of 202608310900.
--
-- ------------------------------------------------------------
-- Why one physical table, not a UNION view or a second results table
-- ------------------------------------------------------------
-- Both a planned (Weekly-plan) RPE result and a new "scheduled outside the
-- plan" RPE result are the exact same three scalars (rpe, duration
-- minutes, an optional note) plus the exact same DB-derived sRPE. Every
-- existing reader that already joins/filters/aggregates over
-- session_feedback (GET /weekly, GET /athlete/today, Results) gets
-- external rows "for free" once its WHERE clause is widened to include the
-- new source - no duplication, no second aggregate pipeline to keep in
-- sync.
--
-- `source` is the discriminator; `logical_session_id` (existing) and
-- `external_assignment_id` (new) are each other's mirror image, enforced
-- by a DB-level XOR CHECK - a 'planned' row has a plan/logical-session
-- identity and NO external-assignment identity; a 'scheduled_external' row
-- has an external-assignment identity and NO plan-session identity. This
-- is a correctness guarantee, not just an app-level convention - it can
-- never be bypassed by a bug in the insert code.
--
-- Results stay insert-only/immutable on BOTH sources (the already-shipped
-- planned semantics - ON CONFLICT DO NOTHING, no edit path, snapshot-
-- immutability trigger - are explicitly NOT changed here; WELLNESS's own
-- "supersede a completed answer" pattern is deliberately NOT mirrored,
-- since a training RPE rating was never meant to be correctable after
-- submission on either source).
-- ============================================================

-- 1. plan_name and logical_session_id were NOT NULL (every row was
--    'planned' until now); a 'scheduled_external' row has neither. Every
--    OTHER plan-specific column (session_name/session_time/session_am_pm/
--    session_bta/plan_week_start) was already nullable.
alter table training_load.session_feedback alter column plan_name drop not null;
alter table training_load.session_feedback alter column logical_session_id drop not null;

-- 2. source discriminator. Constant default -> metadata-only ALTER in
--    PG11+ (same trick rpe_enabled's own v3 migration used) - every
--    existing row (the only source that has ever existed) backfills to
--    'planned' with no UPDATE loop needed.
alter table training_load.session_feedback
  add column source varchar(20) not null default 'planned' check (source in ('planned','scheduled_external'));

-- 3. External-side identity + display columns. Nullable - populated only
--    for source='scheduled_external', enforced by the XOR check below.
--    on delete restrict (not cascade/set null): an external_assignments
--    row that already has a submitted result must never be silently
--    deletable out from under it - matches plan_session_id's own nullable
--    on-delete-set-null EXCEPT this identity is never allowed to go null
--    once set (see the extended immutability trigger below), so
--    "restrict" is the only safe action.
alter table training_load.session_feedback
  add column external_assignment_id uuid references training_load.external_assignments(id) on delete restrict;
alter table training_load.session_feedback
  add column event_name text;

-- 4. THE XOR constraint. Also checks plan_session_id (existing column) -
--    without it, a scheduled_external row could carry a non-null
--    plan_session_id alongside its external_assignment_id, which is not
--    the promised XOR identity even though the two "primary" identity
--    columns still looked mutually exclusive. event_name is required for
--    a scheduled_external row (it has no plan/session name to fall back
--    to display-wise) - never required for planned, which already has
--    session_name/plan_name for that.
alter table training_load.session_feedback add constraint session_feedback_source_identity_xor check (
  (source = 'planned' and logical_session_id is not null and external_assignment_id is null) or
  (source = 'scheduled_external' and external_assignment_id is not null and logical_session_id is null
     and plan_session_id is null and event_name is not null)
);

-- 5. "One assignment -> at most one result." A plain UNIQUE never treats
--    two NULLs as equal, so this coexists cleanly with the existing
--    unique(athlete_id, logical_session_id) - a planned row always has
--    external_assignment_id = null (never collides here) and a
--    scheduled_external row always has logical_session_id = null (never
--    collides there).
alter table training_load.session_feedback add constraint session_feedback_external_assignment_id_key unique (external_assignment_id);

create index session_feedback_source_idx on training_load.session_feedback (source);

-- 6. session_date's meaning is WIDENED, not changed, for existing rows: it
--    already meant "the calendar date, in this athlete's own frame of
--    reference, this result belongs to" (a Weekly plan is per-athlete, so
--    plan_days.date was already athlete-local in practice). For a
--    scheduled_external row it is populated from that assignment's own
--    immutable local_scheduled_date - the same WELLNESS lesson (group by
--    the recipient's own snapshotted local date, never a shared occurrence
--    date, never completed_at) applied uniformly across both sources. No
--    column rename, no reinterpretation of any already-submitted planned
--    row's value.

-- 7. Extend (never weaken) the snapshot-immutability trigger to also
--    protect the three new columns. CREATE OR REPLACE swaps the function
--    body the already-deployed trigger (created in 202608320900) already
--    fires - no new `create trigger` statement needed. srpe stays
--    deliberately excluded from the diff for the exact already-documented
--    reason (a GENERATED ALWAYS AS STORED column reads as NULL inside a
--    BEFORE trigger, since Postgres doesn't recompute it until AFTER
--    BEFORE ROW triggers run).
create or replace function training_load.protect_session_feedback_snapshot()
returns trigger language plpgsql as $$
begin
  if NEW.athlete_id is distinct from OLD.athlete_id
     or NEW.logical_session_id is distinct from OLD.logical_session_id
     or NEW.source is distinct from OLD.source
     or NEW.external_assignment_id is distinct from OLD.external_assignment_id
     or NEW.event_name is distinct from OLD.event_name
     or NEW.session_date is distinct from OLD.session_date
     or NEW.plan_name is distinct from OLD.plan_name
     or NEW.plan_week_start is distinct from OLD.plan_week_start
     or NEW.session_name is distinct from OLD.session_name
     or NEW.session_time is distinct from OLD.session_time
     or NEW.session_am_pm is distinct from OLD.session_am_pm
     or NEW.session_bta is distinct from OLD.session_bta
     or NEW.rpe is distinct from OLD.rpe
     or NEW.duration_minutes is distinct from OLD.duration_minutes
     or NEW.athlete_note is distinct from OLD.athlete_note
     or NEW.submitted_at is distinct from OLD.submitted_at
     or NEW.created_at is distinct from OLD.created_at
  then
    raise exception 'training_load.session_feedback.% is an immutable snapshot once created - only plan_session_id (the nullable best-effort backreference) may ever change', OLD.id;
  end if;
  return NEW;
end $$;
