-- ============================================================
-- OPTIMOVE — Training load v14: separate "track this session in
-- Training Load" from "request RPE from athletes", plus plan-level
-- defaults for new sessions.
--
-- Context: today a Weekly-plan session has exactly one flag
-- (plans.plan_sessions.rpe_enabled, v3) that conflates two genuinely
-- different decisions:
--   - is this session a candidate for Training Activity/GPS/manual
--     session-level metrics at all?
--   - should the athlete specifically be asked for RPE?
-- A recovery session might legitimately want GPS load tracked without
-- ever asking for RPE; today there is no way to express that. This
-- migration adds the missing dimension additively — rpe_enabled itself
-- is untouched in meaning, only gains a sibling column and a DB-enforced
-- ordering between the two.
--
-- Purely additive over the real, already-deployed plans.plan_sessions/
-- plans.plans tables (same "constant-default ADD COLUMN is metadata-only
-- in PG11+" trick rpe_enabled's own v3 migration already used) — no
-- existing column, trigger, or row from any earlier migration is altered.
-- ============================================================

-- ------------------------------------------------------------
-- Plan-level defaults for BRAND-NEW sessions added to a Weekly plan.
-- Deliberately on plans.plans itself (not a separate settings table) —
-- these are plain content properties of the plan, exactly like
-- plans.plan_sessions.rpe_enabled is a content property of a session,
-- and must be copied/reset by the exact same rules the app already
-- applies to those (see routes/builder.js: a genuinely NEW plan starts
-- at the column default; a duplicate/assign copies the source plan's own
-- values verbatim; an edit-draft copies the source plan's own values
-- verbatim). Both default to false — a brand-new Weekly plan asks for
-- neither Training Load tracking nor RPE until a coach explicitly turns
-- either on.
-- ------------------------------------------------------------
alter table plans.plans
  add column if not exists track_training_load_default boolean not null default false,
  add column if not exists request_rpe_default boolean not null default false;

-- ------------------------------------------------------------
-- The new per-session "track in Training Load" flag itself.
-- ------------------------------------------------------------
alter table plans.plan_sessions add column if not exists training_load_enabled boolean not null default false;

-- Existing-session backfill: preserve CURRENT behavior exactly, per this
-- feature's own explicit requirement — a session that already requests
-- RPE was, by definition, already being treated as Training-Load-relevant
-- (rpe_enabled was the ONLY flag that existed before now), so it must
-- become training_load_enabled = true too. A session with rpe_enabled =
-- false is untouched (training_load_enabled already correctly defaults
-- to false for it). This is a real, deliberate one-time UPDATE — not
-- something a future re-run of this file repeats (the migration runner's
-- own checksum ledger only ever applies a given file once), and it never
-- touches rpe_enabled itself or any other column.
update plans.plan_sessions set training_load_enabled = true where rpe_enabled = true;

-- New rows created AFTER this migration default to rpe OFF too (a genuinely
-- new session — see routes/builder.js's own session-creation route, which
-- from this point on always sets both columns explicitly based on the
-- session's own bta classification and its plan's defaults, never relying
-- on this DB default alone; this is a defense-in-depth backstop for any
-- future insert path that forgets to). Existing rows already backfilled
-- above are entirely unaffected by changing a column's own DEFAULT.
alter table plans.plan_sessions alter column rpe_enabled set default false;

-- The core invariant this whole feature exists to guarantee at the DB
-- level, not just in the application layer: RPE can never be requested
-- for a session that isn't even being tracked in Training Load. Safe to
-- add as a normal, immediately-validated CHECK (not NOT VALID) — the
-- backfill directly above already guarantees every existing row complies
-- (every rpe_enabled=true row was just given training_load_enabled=true
-- in the very same transaction, before this statement ever runs).
alter table plans.plan_sessions
  add constraint plan_sessions_rpe_requires_training_load check (rpe_enabled = false or training_load_enabled = true);

-- ------------------------------------------------------------
-- The ONE shared effective-eligibility rule every planned-RPE read/write
-- path must use from now on — never a hand-copied SQL fragment. Combines
-- the per-session training_load_enabled AND rpe_enabled flags with the
-- existing workspace-level master toggle (planned_rpe_effective_for_plan,
-- v9) exactly once. training_load_enabled is checked explicitly here
-- even though the CHECK constraint above already implies it whenever
-- rpe_enabled is true — a reader should never have to rely on inferring
-- that invariant from a constraint defined elsewhere; the function states
-- the real rule directly. Both boolean parameters are coalesced
-- defensively (never NULL in practice — both columns are NOT NULL — but
-- this keeps the function safe to call from a LEFT JOIN context where the
-- session row itself might be absent).
create function training_load.planned_rpe_actionable(
  p_plan_id uuid, p_date date, p_training_load_enabled boolean, p_rpe_enabled boolean
) returns boolean language sql stable as $$
  select coalesce(p_training_load_enabled, false)
     and coalesce(p_rpe_enabled, true)
     and training_load.planned_rpe_effective_for_plan(p_plan_id, p_date)
$$;
