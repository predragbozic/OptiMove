-- Verified account login-email change (security/verified-email-change): a
-- dedicated table for pending "change my login email" requests, both
-- self-service (POST /api/auth/account/email-change/request) and
-- platform-admin-initiated (POST /api/organization/users/:userId/email-
-- change/request). public.users.email is the account's login identity - it
-- must never change until the NEW address has proven it can actually
-- receive mail there, via the token this table backs.
--
-- Deliberately a separate table from public.password_reset_tokens and
-- public.email_verification_tokens (see those migrations' own header
-- comments for the same reasoning) - this flow's new_email column and dual
-- self/platform_admin request_source have nothing to do with either of
-- those, and overloading either table would weaken its own invariants for
-- no benefit.
--
-- Idempotent: safe to run against a database that already has this table.

create table if not exists public.account_email_change_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  new_email text not null,
  token_hash text not null unique,
  -- Who initiated this request - the account owner themselves (self) or a
  -- platform admin acting on the account's behalf (platform_admin). Kept
  -- even if that admin's own account is later removed (set null, never
  -- cascade-deleted) - this row is an audit trail of who requested the
  -- change, not a live reference that needs to disappear with its actor.
  requested_by_user_id uuid references public.users(id) on delete set null,
  request_source text not null default 'self',
  expires_at timestamptz not null,
  sent_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_email_change_tokens
  drop constraint if exists account_email_change_tokens_request_source_check;
alter table public.account_email_change_tokens
  add constraint account_email_change_tokens_request_source_check
  check (request_source in ('self', 'platform_admin'));

-- new_email is always compared/looked-up case-insensitively elsewhere in
-- this codebase (lower(email)) - storing it pre-lowercased here means every
-- read site can compare it directly without repeating lower() everywhere,
-- and this constraint is what actually guarantees issueAccountEmailChangeToken
-- (backend/src/accountEmailChange.js) can never insert a mixed-case value by
-- mistake.
alter table public.account_email_change_tokens
  drop constraint if exists account_email_change_tokens_new_email_lower_check;
alter table public.account_email_change_tokens
  add constraint account_email_change_tokens_new_email_lower_check
  check (new_email = lower(new_email));

-- A token can never be both consumed and revoked at once - the same
-- mutually-exclusive-terminal-states invariant password_reset_tokens,
-- email_verification_tokens, and athlete_invites already enforce for their
-- own tokens.
alter table public.account_email_change_tokens
  drop constraint if exists account_email_change_tokens_not_both_consumed_and_revoked_check;
alter table public.account_email_change_tokens
  add constraint account_email_change_tokens_not_both_consumed_and_revoked_check
  check (not (consumed_at is not null and revoked_at is not null));

-- At most one still-active (not consumed, not revoked) token per user -
-- issuing a new one always revokes whatever was active first (see
-- issueAccountEmailChangeToken in backend/src/accountEmailChange.js), so
-- this is defense-in-depth against a bug or a call site that skips that
-- helper, matching password_reset_tokens_one_active_per_user_idx's own
-- shape.
create unique index if not exists account_email_change_tokens_one_active_per_user_idx
  on public.account_email_change_tokens (user_id)
  where consumed_at is null and revoked_at is null;

create index if not exists account_email_change_tokens_user_idx
  on public.account_email_change_tokens (user_id);

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'account_email_change_tokens'
-- order by column_name;
