-- Phase 6: athlete invite lifecycle. Extends the existing single-athlete
-- invite flow (public.athlete_invites, POST /api/organization/athlete-invites,
-- GET/accept/link in backend/src/routes/auth.js) with the CONTEXT it was
-- created from (private_coach/club/team/platform), so the same link can be
-- revoked, regenerated, and re-validated against that specific relationship
-- later - this is NOT a group/join-link system, every invite still targets
-- exactly one existing athlete profile.
--
-- Idempotent: safe to run against a database that already has these columns.
-- The raw token is NEVER stored - token_hash (already unique, already
-- existed) remains the only persisted form.

alter table public.athlete_invites
  add column if not exists context_type varchar(20),
  add column if not exists context_id uuid,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists revoke_reason text,
  add column if not exists updated_at timestamptz not null default now();

-- Backfill for any invite row that predates this migration (created before
-- context tracking existed). Classified as 'platform' - a conservative,
-- generic bucket for historical rows whose real originating context was
-- never recorded. Never rewrites any other column, and never touched again
-- once set (this UPDATE only ever matches rows where context_type is still
-- null, so re-running this migration is a no-op the second time).
update public.athlete_invites set context_type = 'platform' where context_type is null;

alter table public.athlete_invites
  alter column context_type set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'athlete_invites_context_type_check'
  ) then
    alter table public.athlete_invites
      add constraint athlete_invites_context_type_check
      check (context_type in ('platform', 'private_coach', 'club', 'team'));
  end if;
end $$;

-- club/team invites are meaningless without a specific club/team id.
-- platform and private_coach are single scopes for the inviter's own
-- account - private_coach deliberately never duplicates the inviter's user
-- id into context_id, since invited_by_user_id (already existed) already
-- identifies exactly which private-coach relationship this invite is for.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'athlete_invites_context_shape_check'
  ) then
    alter table public.athlete_invites
      add constraint athlete_invites_context_shape_check
      check (
        (context_type in ('club', 'team') and context_id is not null)
        or (context_type in ('platform', 'private_coach') and context_id is null)
      );
  end if;
end $$;

-- At most one still-open (not yet accepted, not yet revoked) invite per
-- (athlete, email, context). Regenerating always revokes whatever currently
-- open row exists for that (athlete, context) pair first, inside the same
-- transaction and under an advisory lock (see backend/src/inviteContext.js),
-- so this index should never actually reject a legitimate insert - it is
-- defense-in-depth against a bug or a call site that skips that flow.
--
-- context_id is coalesced to a fixed sentinel UUID because Postgres unique
-- indexes treat NULL as never equal to NULL - without this, two platform or
-- two private_coach invites (both context_id IS NULL) for the same
-- athlete+email would NOT collide and both could exist "open" at once,
-- silently defeating the "only one open invite" rule for exactly those two
-- context types.
create unique index if not exists athlete_invites_one_open_idx
  on public.athlete_invites (athlete_id, lower(email), context_type, coalesce(context_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where accepted_at is null and revoked_at is null;

create index if not exists athlete_invites_athlete_context_idx
  on public.athlete_invites (athlete_id, context_type, context_id);

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'athlete_invites'
-- order by column_name;
