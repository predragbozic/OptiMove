-- Email verification foundation (feature/email-verification-foundation):
-- a brand-new-email athlete_join_applications row (applicant_user_id null)
-- must prove ownership of its email before it can ever be approved. An
-- authenticated apply-existing application (applicant_user_id set) never
-- needs this - proving control of an existing session already IS proof of
-- email ownership (see backend/src/emailVerification.js's header comment).
--
-- Idempotent: safe to run against a database that already has this table/
-- column.

create table if not exists public.email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose varchar(40) not null,
  athlete_join_application_id uuid references public.athlete_join_applications(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one purpose exists in this phase - deliberately a small, explicit
-- enum (not a free-text column) so a future purpose (e.g. a password-reset
-- flow) has to be added here deliberately, not accidentally accepted.
alter table public.email_verification_tokens
  drop constraint if exists email_verification_tokens_purpose_check;
alter table public.email_verification_tokens
  add constraint email_verification_tokens_purpose_check
  check (purpose in ('athlete_join_application'));

-- The athlete_join_application purpose is meaningless without the FK it
-- verifies email for - never left null for this purpose.
alter table public.email_verification_tokens
  drop constraint if exists email_verification_tokens_join_application_required_check;
alter table public.email_verification_tokens
  add constraint email_verification_tokens_join_application_required_check
  check (purpose <> 'athlete_join_application' or athlete_join_application_id is not null);

-- A token can never be both consumed and revoked at once - mutually
-- exclusive terminal states, exactly like athlete_invites'
-- accepted_at/revoked_at invariant.
alter table public.email_verification_tokens
  drop constraint if exists email_verification_tokens_not_both_consumed_and_revoked_check;
alter table public.email_verification_tokens
  add constraint email_verification_tokens_not_both_consumed_and_revoked_check
  check (not (consumed_at is not null and revoked_at is not null));

-- Stored lower-cased at write time (see issueEmailVerificationToken) -
-- enforced here too so no call site can silently drift from that.
alter table public.email_verification_tokens
  drop constraint if exists email_verification_tokens_email_lowercase_check;
alter table public.email_verification_tokens
  add constraint email_verification_tokens_email_lowercase_check
  check (email = lower(email));

-- At most one still-active (not consumed, not revoked) token per
-- application - issuing a new one always revokes whatever was active first
-- (see issueEmailVerificationToken), so this is defense-in-depth against a
-- bug or a call site that skips that helper, matching the same pattern
-- athlete_invites/athlete_join_links already use for their own "one open
-- token" invariants.
create unique index if not exists email_verification_tokens_one_active_per_application_idx
  on public.email_verification_tokens (athlete_join_application_id)
  where purpose = 'athlete_join_application' and consumed_at is null and revoked_at is null;

create index if not exists email_verification_tokens_application_idx
  on public.email_verification_tokens (athlete_join_application_id);

alter table public.athlete_join_applications
  add column if not exists email_verified_at timestamptz;

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name = 'email_verification_tokens'
-- order by column_name;
-- select count(*) from public.athlete_join_applications where email_verified_at is not null;
