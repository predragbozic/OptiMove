-- Forgot/reset password (security/password-recovery): a dedicated table,
-- deliberately separate from public.email_verification_tokens - that table's
-- athlete_join_application_id FK and its 'athlete_join_application'-only
-- purpose check exist specifically for the join-application email-ownership
-- flow (see backend/src/emailVerification.js's header comment) and a
-- password-reset token has nothing to do with a join application. Extending
-- that table's purpose enum or making its application FK nullable-for-a-
-- different-reason would weaken both flows' own invariants for no benefit -
-- a fresh table with only the columns this flow actually needs is simpler
-- and safer than overloading an unrelated one.
--
-- Idempotent: safe to run against a database that already has this table.

create table if not exists public.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  sent_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A token can never be both consumed and revoked at once - the exact same
-- mutually-exclusive-terminal-states invariant email_verification_tokens and
-- athlete_invites already enforce for their own tokens.
alter table public.password_reset_tokens
  drop constraint if exists password_reset_tokens_not_both_consumed_and_revoked_check;
alter table public.password_reset_tokens
  add constraint password_reset_tokens_not_both_consumed_and_revoked_check
  check (not (consumed_at is not null and revoked_at is not null));

-- At most one still-active (not consumed, not revoked) token per user -
-- issuing a new one always revokes whatever was active first (see
-- issuePasswordResetToken in backend/src/passwordReset.js), so this is
-- defense-in-depth against a bug or a call site that skips that helper,
-- matching email_verification_tokens_one_active_per_application_idx's own
-- shape.
create unique index if not exists password_reset_tokens_one_active_per_user_idx
  on public.password_reset_tokens (user_id)
  where consumed_at is null and revoked_at is null;

create index if not exists password_reset_tokens_user_idx
  on public.password_reset_tokens (user_id);

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'password_reset_tokens'
-- order by column_name;
