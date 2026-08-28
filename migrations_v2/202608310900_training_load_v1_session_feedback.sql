-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v1, first complete phase.
--
-- Purely additive: a brand-new `training_load` schema with one table. No
-- deployed migration is touched. Applied through the same Strategy B
-- runner (backend/src/migrate.js) as every other migrations_v2 file - no
-- transaction-control statements here, the runner owns BEGIN/COMMIT.
--
-- ------------------------------------------------------------
-- Business model (see the feature request for the full spec)
-- ------------------------------------------------------------
-- One RPE/sRPE submission belongs to exactly one plans.plan_sessions row
-- (a single real training session inside an athlete's active Weekly plan -
-- never a bare WELLNESS-style schedule). sRPE = RPE x actual duration
-- minutes, always computed by Postgres itself (GENERATED ALWAYS AS
-- STORED), never accepted as a value from the client.
--
-- ------------------------------------------------------------
-- Why every session-identifying column here is a SNAPSHOT, not a live join
-- ------------------------------------------------------------
-- plans.plan_sessions rows are not durable identity the way they look:
-- backend/src/routes/builder.js's applyEditDraft() (run every time a coach
-- re-opens an already-published/finished plan in the Builder and clicks
-- "Save and finish" again) DELETES the live plan's entire day/session/
-- node/item tree and recreates it with brand-new ids, copied over from the
-- coach's edit-draft copy - even when nothing about that specific session
-- "logically" changed from the coach's point of view. A plan can also be
-- renamed, or deleted outright. None of that may ever invalidate, corrupt,
-- or silently reinterpret a result an athlete already submitted - once
-- submitted, this row's own snapshot columns (session_date/plan_name/
-- session_name/session_time/session_am_pm/session_bta) are the permanent
-- record of what was rated, independent of whatever plans.* looks like
-- afterward. plan_session_id itself is kept as a best-effort, nullable
-- backreference only (on delete set null) - useful for "open the session
-- this came from" while it still resolves, never required for display.
--
-- ------------------------------------------------------------
-- Idempotency / conflict semantics (enforced by the plain UNIQUE
-- constraint below, not by a status/soft-delete state machine)
-- ------------------------------------------------------------
-- unique (athlete_id, plan_session_id) is the single source of truth for
-- "one result per athlete/session pair". Because it is a PLAIN (not
-- partial) unique constraint, and plan_session_id only ever transitions
-- from a real value to NULL (never the reverse - the FK relationship is
-- one-directional and irreversible), the only way to ever violate it is a
-- second POST against the SAME still-live session by the same athlete -
-- exactly the case that must be rejected/deduplicated. Once a row's
-- plan_session_id has been nulled out by the original session's deletion,
-- it can never collide with anything again (the session it pointed to no
-- longer exists to be POSTed against). The route layer (backend/src/
-- routes/trainingLoad.js) turns a unique_violation on insert into either a
-- 200 idempotent no-op (an exact retry of the same rpe/duration/note) or a
-- 409 Conflict (a genuinely different second submission) - see that file's
-- own header comment for the exact rule. This is deliberately NOT a
-- status/superseded/void state machine: nothing in this first phase edits
-- or retracts an already-submitted result, so there is nothing for such a
-- state machine to track yet - if a later phase adds athlete-initiated
-- edits, that is the point to introduce one, not before.
-- ============================================================

create schema if not exists training_load;

create table training_load.session_feedback (
  id uuid primary key default gen_random_uuid(),

  athlete_id uuid not null references public.athletes(id) on delete restrict,
  plan_session_id uuid references plans.plan_sessions(id) on delete set null,

  -- Immutable snapshot, taken once at submission - see header comment
  -- above for why none of this is ever re-derived from a live join later.
  session_date date not null,
  plan_name text not null,
  plan_week_start date,
  session_name text,
  session_time time,
  session_am_pm varchar(10),
  session_bta varchar(10),

  rpe smallint not null,
  duration_minutes smallint not null,
  -- Server/DB-derived, never client-accepted - see header comment above.
  srpe integer generated always as (rpe * duration_minutes) stored,
  athlete_note text,

  created_at timestamptz not null default now(),
  submitted_at timestamptz not null default now(),

  check (rpe between 0 and 10),
  check (duration_minutes between 1 and 600),
  check (athlete_note is null or char_length(athlete_note) <= 500),

  -- One result per athlete/session pair - see header comment above for why
  -- this plain (non-partial) unique constraint is sufficient on its own.
  unique (athlete_id, plan_session_id)
);

-- Coach weekly/results queries filter and group by session_date across
-- many athletes at once (GET /api/training-load/weekly) - date-first so a
-- single week's range scan doesn't have to touch every athlete's full
-- history. athlete_id-first would only help an athlete-scoped query, which
-- is comparatively rare (one athlete, already narrow) and still served
-- fine by this same index in the reverse column order via a bitmap scan.
create index session_feedback_date_athlete_idx on training_load.session_feedback (session_date, athlete_id);

-- Best-effort backreference lookups ("does this still-live session already
-- have a result") - plan_session_id is not the leading column of the
-- unique constraint's own index (that's (athlete_id, plan_session_id)), so
-- a bare "given a session id" lookup needs its own index.
create index session_feedback_plan_session_idx on training_load.session_feedback (plan_session_id) where plan_session_id is not null;
