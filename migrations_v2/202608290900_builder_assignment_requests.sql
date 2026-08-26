-- Client-supplied idempotency key for POST /plans/:planId/duplicate with
-- intent="assign" (Assign to athlete). The dedupe_key on app_notifications
-- (see 202608280900_app_notifications_dedupe_key.sql) only protects the
-- NOTIFICATION once a plan already exists - it does nothing to stop a
-- retried/parallel Assign request from creating a SECOND set of plan rows
-- in the first place, since each request builds its own new plan id.
--
-- One row per client-generated assignmentRequestId (a UUID minted once per
-- Assign attempt and reused across retries - see frontend/builder-actions.js).
-- The owning request (the one that wins the INSERT below) does the real
-- work and stores its outcome in `result`; every other request carrying the
-- same id blocks on this row via `select ... for update` (a plain row lock,
-- not a new locking primitive) until the owner's transaction commits or
-- rolls back, then either replays the stored result (same user, same
-- payload_key) or is rejected with 409 (different user or payload).
--
-- `payload_key` is a canonical JSON string of the target-defining fields
-- (source plan, target athlete ids, target week) - it is what lets the
-- backend tell "a legitimate retry of the exact same assign" apart from "a
-- new/different request that happens to reuse an id".
create table public.builder_assignment_requests (
  id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  source_plan_id uuid not null references plans.plans(id) on delete cascade,
  payload_key text not null,
  status varchar(20) not null default 'pending' check (status in ('pending', 'completed')),
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
