-- Phase 2 authorization hardening: club/team management now reads from
-- public.user_club_roles / public.user_team_roles instead of trusting
-- users.role_hint alone. In production, the one legitimate club_admin
-- account created its club directly (clubs.created_by_user_id) but has
-- never had a corresponding user_club_roles row - without this backfill,
-- the new scope-based checks would lock that account out of a club it
-- legitimately administers today.
--
-- Deliberately narrow and evidence-based, NOT a blanket "whoever created a
-- club" rule (an earlier draft of this migration did that and was rejected
-- in review as an unintended privilege-escalation risk). This only touches
-- users whose EXISTING role_hint already says they are a club administrator
-- (role_hint in ('club_admin', 'club_manager') - the same set access.js's
-- CLUB_ROLES recognizes), AND who created that specific club. A coach or
-- generic user who happens to have created a club (e.g. via legacy import)
-- gets nothing here - that would be inferring a brand-new privilege from an
-- incidental foreign-key value, not confirming a privilege that already
-- exists.
--
-- Idempotent: safe to run more than once. Never deletes or overwrites an
-- existing row's role - only ever inserts, or re-activates a row that
-- already matches this exact (user_id, club_id, role).
insert into public.user_club_roles (user_id, club_id, role, is_active)
select u.id, c.id, 'club_admin', true
from public.clubs c
join public.users u on u.id = c.created_by_user_id
where u.role_hint in ('club_admin', 'club_manager')
on conflict (user_id, club_id, role) do update set is_active = true, updated_at = now();

-- Verification (read-only - run this separately, before or after applying
-- the insert above, to see exactly which (user, club) pairs it targets):
--
-- select u.id as user_id, u.email, u.role_hint, c.id as club_id, c.name as club_name
-- from public.clubs c
-- join public.users u on u.id = c.created_by_user_id
-- where u.role_hint in ('club_admin', 'club_manager');
--
-- This same query is exercised as an automated test in
-- backend/tests/migration-backfill.test.mjs, which also proves a club
-- created by a plain "coach" or "user" role_hint account gets no row.
