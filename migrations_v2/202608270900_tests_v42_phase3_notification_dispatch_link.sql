-- Phase 3A (Tests module): links a notification dispatch row to the actual
-- public.app_notifications row it produced.
--
-- Why this is needed: tests.test_schedule_notification_rules and
-- tests.test_schedule_notification_dispatches were already created in
-- migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql,
-- explicitly as future-worker input (see that file's own Section 4 comment).
-- That dispatch table already gives the worker everything it needs to decide
-- WHETHER a notification for a given (occurrence, kind, recipient) has
-- already been sent (its `dedupe_key`/`(occurrence_id, notification_kind,
-- recipient_user_id)` unique constraints), but nothing to tell it WHICH row
-- in public.app_notifications that send produced. That distinction only
-- matters for one thing this phase needs and Phase 1 didn't anticipate:
-- coach_digest is not a one-shot send - the SAME notification has to be
-- recomputed and updated in place on every worker cycle while an occurrence
-- is open ("Ta notifikacija se ažurira na istom redu... ne pravi novu
-- notifikaciju posle svakog worker ciklusa"). Without a stored reference to
-- the exact app_notifications row a dispatch produced, the worker would have
-- no reliable way to find "the row to UPDATE" versus "no row exists yet,
-- INSERT one" - re-deriving it from title/body text would be fragile, and
-- public.app_notifications itself has no unique/dedupe constraint of its own
-- to upsert against (confirmed: no migration ever added one).
--
-- This is deliberately the ONLY schema change in this phase - it is purely
-- additive (one nullable column + FK + index) on a table this feature
-- already owns end-to-end, and touches neither the deployed Phase 1
-- migration nor public.app_notifications' own shape (which stays shared,
-- unmodified, and insert-only for every other notification type in the
-- app - contact requests, program access, messages, etc.).

alter table tests.test_schedule_notification_dispatches
  add column app_notification_id uuid references public.app_notifications(id) on delete set null;

create index test_schedule_notification_dispatches_app_notification_id_idx
  on tests.test_schedule_notification_dispatches (app_notification_id);
