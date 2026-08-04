-- Fixes a race in the auto-generated athlete_id/source_external_id: the old
-- mechanism (backend/src/routes/organization.js's nextAthleteId(), before
-- this migration) read `MAX(...) + 1` with a plain, non-transactional
-- SELECT. Two concurrent callers - e.g. two POST /organization/athletes
-- requests, or two feature/group-athlete-join-links approvals for two
-- different new applicants - could both read the same MAX and both compute
-- the same "next" id, with only the athletes_source_external_id_unique
-- index catching the collision on whichever insert lost the race (as a raw,
-- unhandled 500).
--
-- A real Postgres sequence's nextval() is atomic across every session/
-- transaction regardless of who calls it or whether their transaction later
-- commits or rolls back (a rolled-back call just leaves a harmless gap,
-- exactly like a normal serial column) - so two concurrent callers can never
-- receive the same value. No advisory lock is needed for this: sequence
-- allocation has always been concurrency-safe by design.
--
-- Idempotent: safe to run against a database that already has this
-- sequence - the DO block below only ever advances it forward (to at least
-- the current real MAX across existing rows), never backward, so re-running
-- this migration after real inserts have already advanced the sequence
-- further than the current MAX is a no-op.
create sequence if not exists public.athlete_generated_id_seq;

do $$
declare
  current_max bigint;
  seq_last_value bigint;
begin
  select coalesce(max(nullif(regexp_replace(coalesce(source_external_id, athlete_id), '\D', '', 'g'), '')::bigint), 999)
    into current_max
  from public.athletes;

  select last_value into seq_last_value from public.athlete_generated_id_seq;

  if current_max >= seq_last_value then
    perform setval('public.athlete_generated_id_seq', current_max);
  end if;
end $$;

-- Verification (read-only, for manual review after running this migration):
-- select last_value from public.athlete_generated_id_seq;
-- select coalesce(max(nullif(regexp_replace(coalesce(source_external_id, athlete_id), '\D', '', 'g'), '')::bigint), 999) from public.athletes;
