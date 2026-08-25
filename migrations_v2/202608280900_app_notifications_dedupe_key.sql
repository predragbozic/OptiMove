-- Builder plan-assignment notifications (weekly plan draft->active, program
-- draft->active, "Assign to athlete" from a template) need to be safe
-- against a retried Submit/Assign request, a double click, two parallel
-- requests, or a batch response being re-read - none of which should ever
-- produce a second notification for the same event.
--
-- public.app_notifications (create_notifications_schema.sql, a legacy
-- baseline migration - never re-run per Strategy B, see migrations_v2/
-- README.md) has no unique/dedupe mechanism of any kind: every existing
-- writer (backend/src/notifications.js's createNotification()) is a plain
-- INSERT. That's fine for user-initiated actions (a contact request, a
-- program-access decision) where a duplicate would require the same user to
-- take the same action twice on purpose - it is not fine for a
-- system-triggered event that can legitimately be attempted more than once
-- for the exact same underlying database row (a retried HTTP request is not
-- a new event).
--
-- This is deliberately a bare column + a single partial unique index on the
-- ALREADY-SHARED app_notifications table, not a second dispatch/audit table
-- like the Tests Phase 3A worker's own tests.test_schedule_notification_
-- dispatches (migrations_v2/202608240900_..., linked further by
-- 202608270900_...). That heavier pattern exists there because a coach live
-- digest has to be recomputed and UPDATED IN PLACE - it needs a stored
-- reference to "which row to update". Every notification this feature
-- writes is one-shot (created once, never updated again), so a plain
-- `insert ... on conflict (dedupe_key) do nothing` is sufficient and is the
-- smaller of the two patterns already established in this codebase.
--
-- Nullable and partially-indexed on purpose: every OTHER existing
-- notification writer (coach contact requests, program access decisions,
-- messages) is completely unaffected - they simply never set dedupe_key,
-- and NULL values are never compared equal by a unique index, so this adds
-- zero new constraints to any existing insert.

alter table public.app_notifications
  add column dedupe_key varchar(300);

create unique index app_notifications_dedupe_key_idx
  on public.app_notifications (dedupe_key)
  where dedupe_key is not null;
