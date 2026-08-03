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
-- context tracking existed) as 'legacy' - deliberately NOT 'platform'.
-- Production may hold a still-open (pending, unexpired) invite that a
-- non-platform-admin (a club admin, a team coach, a private coach) created
-- through the old, context-less flow. Backfilling it as 'platform' would
-- make backend/src/inviteContext.js's isInviteContextStillValid demand
-- platform_admin from that same inviter on the very next GET/accept/link -
-- silently invalidating a link that was perfectly usable a moment before
-- this migration ran, for an inviter who never needed platform authority to
-- create it in the first place. 'legacy' is its own distinct, permanent
-- context: it is never chosen by the current invite-creation endpoint (only
-- ever assigned here, once, to rows that already existed) and its validity
-- check (see inviteContext.js) accepts ANY real current active access to
-- the athlete - platform_admin, an active private-coach relationship, an
-- active club_admin role with the athlete's active membership in that same
-- club, or an active team_coach role with the athlete's active membership
-- in that same team - never role_hint, and never a guess at which one of
-- those was actually true when the row was created (context_id is not
-- retroactively guessed either - it stays null, matching every historical
-- row's actual data). Accepting the invite still only links the existing
-- athlete profile to a user account, exactly as before - it never creates
-- or reactivates any relationship. Never touched again once set (this
-- UPDATE only ever matches rows where context_type is still null, so
-- re-running this migration is a no-op the second time).
update public.athlete_invites set context_type = 'legacy' where context_type is null;

alter table public.athlete_invites
  alter column context_type set not null;

-- Dropped and recreated (rather than guarded with "if not exists") so an
-- earlier deploy of this same migration - back when 'legacy' wasn't part of
-- the allowed list yet - gets its constraint definition upgraded too, not
-- just newly-created databases.
alter table public.athlete_invites drop constraint if exists athlete_invites_context_type_check;
alter table public.athlete_invites
  add constraint athlete_invites_context_type_check
  check (context_type in ('platform', 'private_coach', 'club', 'team', 'legacy'));

-- club/team invites are meaningless without a specific club/team id.
-- platform, private_coach, and legacy are single scopes for the inviter's
-- own account/history - private_coach deliberately never duplicates the
-- inviter's user id into context_id, since invited_by_user_id (already
-- existed) already identifies exactly which private-coach relationship this
-- invite is for; legacy rows never have a context_id either, since no
-- historical row ever recorded one and none is retroactively guessed.
alter table public.athlete_invites drop constraint if exists athlete_invites_context_shape_check;
alter table public.athlete_invites
  add constraint athlete_invites_context_shape_check
  check (
    (context_type in ('club', 'team') and context_id is not null)
    or (context_type in ('platform', 'private_coach', 'legacy') and context_id is null)
  );

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

-- An invite can never be both accepted and revoked at once - accepting and
-- revoking are mutually exclusive terminal states (see the transactional
-- accept/link/revoke handlers, which each re-check this under a per-athlete
-- lock before mutating). Only added if no existing row already violates it -
-- checked explicitly rather than letting a bad add_constraint crash the
-- deploy, so conflicting data is surfaced (via a NOTICE, for someone to
-- investigate) instead of silently blocked or silently masked.
do $$
declare
  conflicting_count integer;
begin
  select count(*) into conflicting_count
  from public.athlete_invites
  where accepted_at is not null and revoked_at is not null;

  if conflicting_count > 0 then
    raise notice 'Skipping athlete_invites_not_both_accepted_and_revoked_check: % existing row(s) have both accepted_at and revoked_at set. Investigate before adding this constraint.', conflicting_count;
  elsif not exists (
    select 1 from pg_constraint where conname = 'athlete_invites_not_both_accepted_and_revoked_check'
  ) then
    alter table public.athlete_invites
      add constraint athlete_invites_not_both_accepted_and_revoked_check
      check (not (accepted_at is not null and revoked_at is not null));
  end if;
end $$;

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'athlete_invites'
-- order by column_name;
-- select count(*) from public.athlete_invites where accepted_at is not null and revoked_at is not null;
