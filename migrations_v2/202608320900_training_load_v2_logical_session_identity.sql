-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v2: stable logical session identity
-- + snapshot immutability trigger. Purely additive, on top of
-- 202608310900_training_load_v1_session_feedback.sql (already applied to
-- local OPTIMOVE - its own checksum is NOT touched by this file).
--
-- ------------------------------------------------------------
-- Why plan_session_id alone was never a safe identity key
-- ------------------------------------------------------------
-- backend/src/routes/builder.js's applyEditDraft() - run every time a
-- coach re-opens an already-published Weekly plan and clicks "Save and
-- finish" again - deletes the live plan's entire session tree and
-- recreates it with brand-new plan_sessions.id values, even when nothing
-- about a given session "logically" changed. v1's unique (athlete_id,
-- plan_session_id) therefore let the SAME real training session collect a
-- second, genuinely duplicate RPE submission after every such edit cycle
-- (the athlete's Home would show it as "Not rated" again, a second submit
-- would succeed, and Results would count both the historical and the new
-- row - double-counting sRPE).
--
-- logical_session_id is the fix: a second, STABLE identity on
-- plans.plan_sessions, generated fresh for every genuinely new session but
-- deliberately CARRIED OVER by exactly two call sites in builder.js - the
-- live-plan -> edit-draft copy (POST /plans/:planId/edit) and the
-- edit-draft -> live-plan copy (applyEditDraft's own call to
-- copyWeeklyPlanTree) - because together those two are the one and only
-- "same session, round-tripped through an edit" cycle. Every OTHER copy
-- path (assign/duplicate a plan to a new athlete, sync a batch-assigned
-- plan's edits out to its sibling plans, day-to-day/cross-plan-block
-- paste) copies a session into a genuinely different logical training
-- session and must never inherit the source's logical_session_id - those
-- callers simply omit the column, so plans.plan_sessions' own
-- `default gen_random_uuid()` mints a fresh one automatically. See
-- copyWeeklyPlanTree/copyDaySessions' own `preserveLogicalId` parameter in
-- builder.js.
--
-- training_load.session_feedback.logical_session_id is a plain, immutable
-- snapshot column (never itself an FK - it only ever has to equal
-- whatever plans.plan_sessions.logical_session_id was at submission time),
-- and is now the deduplication key: unique (athlete_id, logical_session_id)
-- replaces v1's unique (athlete_id, plan_session_id). plan_session_id
-- itself is unchanged - still a nullable, best-effort backreference,
-- still `on delete set null`.
-- ============================================================

-- ------------------------------------------------------------
-- 1. plans.plan_sessions gets the stable identity column.
-- ------------------------------------------------------------
-- A NOT NULL column with a volatile DEFAULT (gen_random_uuid()) forces
-- Postgres to rewrite the table and evaluate the default once PER EXISTING
-- ROW - every already-existing session is backfilled with its own,
-- distinct logical_session_id by this single ALTER, no separate UPDATE
-- loop needed.
alter table plans.plan_sessions add column if not exists logical_session_id uuid not null default gen_random_uuid();

create index if not exists plan_sessions_logical_session_id_idx on plans.plan_sessions (logical_session_id);

-- ------------------------------------------------------------
-- 2. training_load.session_feedback gets the same identity, backfilled
--    from whatever its (possibly already-null) plan_session_id still
--    resolves to, or a fresh id for a row that predates this migration
--    and was already orphaned (nothing better to backfill from - such a
--    row was already historical/unreachable-by-session before this
--    migration, and stays exactly that after it).
-- ------------------------------------------------------------
alter table training_load.session_feedback add column if not exists logical_session_id uuid;

update training_load.session_feedback sf
set logical_session_id = coalesce(
  (select ps.logical_session_id from plans.plan_sessions ps where ps.id = sf.plan_session_id),
  gen_random_uuid()
)
where logical_session_id is null;

alter table training_load.session_feedback alter column logical_session_id set not null;

alter table training_load.session_feedback drop constraint session_feedback_athlete_id_plan_session_id_key;
alter table training_load.session_feedback add constraint session_feedback_athlete_id_logical_session_id_key unique (athlete_id, logical_session_id);

create index if not exists session_feedback_logical_session_id_idx on training_load.session_feedback (logical_session_id);

-- ------------------------------------------------------------
-- 3. Fixup: correlate every PRE-EXISTING edit-draft's sessions with their
--    live plan's sessions. Step 1's backfill gave every already-existing
--    row - a live plan's sessions AND its already-open edit-draft's own
--    copies of the "same" sessions - its own, independently random
--    logical_session_id, because that ALTER has no way to know a draft
--    and its live plan are supposed to share identity per session; only
--    builder.js's copyDaySessions/copyWeeklyPlanTree (via their
--    preserveLogicalId option) know how to carry logical_session_id
--    across a live<->draft round trip, and that logic never ran for a
--    draft that was already open before this migration - it was
--    created by an OLDER version of the live->draft copy, back when
--    logical_session_id didn't exist yet to preserve.
--
--    Left uncorrected: an athlete rates the live session (fine, using
--    the live session's own logical_session_id); the coach later saves
--    the pre-existing draft; applyEditDraft() deletes the live tree and
--    recreates it, this time carrying over the DRAFT's (different,
--    independently-backfilled) logical_session_id - so the recreated
--    live session no longer matches the already-submitted result's
--    logical_session_id at all. The result becomes orphaned/historical,
--    the recreated session looks "Not rated", and a second submit would
--    succeed - a real duplicate.
--
--    Fix: for every currently-open edit-draft (is_edit_draft = true,
--    edit_source_plan_id pointing at its live source plan - both
--    real, populated columns; see plans.plans), match each draft
--    session to its live counterpart by same calendar date
--    (plans.plan_days.date - plan_days_plan_date_unique already
--    guarantees at most one day per date per plan) plus the exact slot
--    key plan_sessions_day_slot_unique already enforces per plan_day -
--    (am_pm, bta, session_order), nulls folded to '' / -1 exactly like
--    that index does - and overwrite the draft session's own backfilled
--    logical_session_id with the live session's. A draft session with NO
--    live-side match (e.g. a day or slot only ever added while editing,
--    never yet published) is intentionally left with its own fresh id -
--    that IS a genuinely new, not-yet-live session, and correctly gets
--    its own identity rather than being force-linked to something it
--    isn't.
-- ------------------------------------------------------------
with draft_plans as (
  select p.id as draft_plan_id, p.edit_source_plan_id as live_plan_id
  from plans.plans p
  where coalesce(p.is_edit_draft, false) and p.edit_source_plan_id is not null
),
matched_sessions as (
  select ds.id as draft_session_id, ls.logical_session_id as live_logical_session_id
  from draft_plans dp
  join plans.plan_days dd on dd.plan_id = dp.draft_plan_id and dd.date is not null
  join plans.plan_days ld on ld.plan_id = dp.live_plan_id and ld.date = dd.date
  join plans.plan_sessions ds on ds.plan_day_id = dd.id
  join plans.plan_sessions ls on ls.plan_day_id = ld.id
    and coalesce(ls.am_pm, '') = coalesce(ds.am_pm, '')
    and coalesce(ls.bta, '') = coalesce(ds.bta, '')
    and coalesce(ls.session_order, -1) = coalesce(ds.session_order, -1)
)
update plans.plan_sessions target
set logical_session_id = matched_sessions.live_logical_session_id
from matched_sessions
where target.id = matched_sessions.draft_session_id
  and target.logical_session_id <> matched_sessions.live_logical_session_id;

-- ------------------------------------------------------------
-- 4. Snapshot immutability trigger. INSERT is completely unaffected (this
--    only ever fires BEFORE UPDATE). The one column allowed to change is
--    plan_session_id - required so Postgres's own `on delete set null` FK
--    action (itself implemented as an UPDATE under the hood, which DOES
--    fire row-level BEFORE UPDATE triggers) is never blocked by this same
--    trigger.
--
--    srpe is deliberately NOT compared here, even though it's meant to be
--    just as immutable as everything else: srpe is a GENERATED ALWAYS AS
--    ... STORED column, and Postgres does not recompute a generated
--    column's value until AFTER row-level BEFORE triggers have already
--    run - inside this trigger, NEW.srpe is always NULL, regardless of
--    what it's about to become. A `NEW.srpe is distinct from OLD.srpe`
--    check would therefore compare a real stored value against NULL on
--    EVERY update (including the legitimate plan_session_id-only one from
--    the FK action above) and reject it unconditionally - a real bug this
--    migration's own tests caught. srpe needs no explicit guard anyway:
--    it can never be the target of a direct UPDATE SET at all (Postgres
--    rejects assigning to a generated column at parse time), and it is
--    only ever derived from rpe/duration_minutes, which already are
--    guarded below.
-- ------------------------------------------------------------
create function training_load.protect_session_feedback_snapshot()
returns trigger language plpgsql as $$
begin
  if NEW.athlete_id is distinct from OLD.athlete_id
     or NEW.logical_session_id is distinct from OLD.logical_session_id
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

create trigger protect_session_feedback_snapshot
  before update on training_load.session_feedback
  for each row execute function training_load.protect_session_feedback_snapshot();
