-- Phase 2 authorization hardening: club/team management now reads from
-- public.user_club_roles / public.user_team_roles instead of trusting
-- users.role_hint alone. In production, the one real club_admin account
-- created its club directly (clubs.created_by_user_id) but has never had a
-- corresponding user_club_roles row - without this backfill, the new
-- scope-based checks would lock that account out of a club it legitimately
-- administers today.
--
-- Deliberately narrow: clubs.created_by_user_id is strong, first-party
-- evidence (they created the club). This does NOT attempt to infer
-- user_team_roles for any "coach" role_hint account from naming patterns
-- (e.g. an email that happens to match a team name) - that would be a guess,
-- not evidence, and the user confirmed those specific accounts are test data
-- expected to be deleted before real launch.
--
-- Idempotent: safe to run more than once, and does not delete or overwrite
-- any existing row.
insert into public.user_club_roles (user_id, club_id, role, is_active)
select c.created_by_user_id, c.id, 'club_admin', true
from public.clubs c
where c.created_by_user_id is not null
on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now();
