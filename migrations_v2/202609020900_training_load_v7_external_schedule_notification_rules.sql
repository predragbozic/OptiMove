-- ============================================================
-- OPTIMOVE — Training load v7: per-schedule notification configuration
-- for an external (outside-plan) RPE schedule.
--
-- Hardening correction: the "New RPE session" form always told the coach
-- "Athletes are notified when it opens, and reminded automatically" as a
-- static, unconditional fact, while trainingLoadNotificationWorker.js was
-- hardcoded to always invite, always remind at a fixed 60-minute offset,
-- and always send the final digest - no way for a coach to actually turn
-- any of that off, or change the reminder timing, despite the form
-- implying it was already configurable. This migration adds the real
-- backing config; a later change wires the worker to read it instead of
-- the hardcoded constants, and the form to expose it.
--
-- One row per (schedule, kind) - kind is one of the three notification
-- moments training_load actually has (no coach "live digest" phase - see
-- the original design's own note on that deliberate cut, still true).
-- Absence of a row for a given kind means "not yet configured", read by
-- the worker as enabled=true (the CURRENT, pre-this-migration behavior),
-- so any schedule/fixture created without going through the real create
-- route (a disposable-DB test building a row directly, for instance)
-- keeps behaving exactly as before - purely additive, never a silent
-- behavior change for anything that doesn't opt in.
-- ============================================================

create table training_load.external_schedule_notification_rules (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references training_load.external_schedules(id) on delete cascade,
  kind varchar(30) not null check (kind in ('athlete_invitation', 'athlete_reminder', 'final_digest')),
  enabled boolean not null default true,
  -- Only meaningful for kind='athlete_reminder' - null for the other two
  -- kinds (enforced below), read by the worker as coalesce(..., 60), the
  -- same default REMINDER_OFFSET_MINUTES already used today.
  reminder_offset_minutes int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (kind = 'athlete_reminder' or reminder_offset_minutes is null),
  check (reminder_offset_minutes is null or reminder_offset_minutes > 0),

  unique (schedule_id, kind)
);

create index external_schedule_notification_rules_schedule_idx on training_load.external_schedule_notification_rules (schedule_id);
