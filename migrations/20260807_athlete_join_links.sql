-- Group athlete join links (feature/group-athlete-join-links): a SEPARATE
-- system from the single-athlete invite lifecycle in
-- 20260806_athlete_invites_context.sql/backend/src/inviteContext.js. An
-- invite always targets one already-existing athlete profile; a join link
-- targets a CONTEXT (private_coach/club/team) and is not tied to any
-- pre-existing athlete - many different people submit a request against the
-- same link, each request is reviewed and approved/rejected independently,
-- and only approval ever creates the athlete profile/login/membership.
--
-- Idempotent: safe to run against a database that already has these tables.
-- The raw join-link token and the raw application status token are NEVER
-- stored - only their sha256 hashes (token_hash / status_token_hash).

create table if not exists public.athlete_join_links (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  context_type varchar(20) not null,
  context_id uuid,
  created_by_user_id uuid references public.users(id) on delete set null,
  label text,
  expires_at timestamptz not null,
  max_uses integer,
  approved_uses integer not null default 0,
  is_active boolean not null default true,
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.athlete_join_links
  drop constraint if exists athlete_join_links_context_type_check;
alter table public.athlete_join_links
  add constraint athlete_join_links_context_type_check
  check (context_type in ('private_coach', 'club', 'team'));

-- private_coach is a 1:1 scope on the creator's own account (the creator IS
-- the context, exactly like athlete_invites' private_coach invites use
-- invited_by_user_id rather than a duplicated context_id) - club/team need an
-- explicit id since a creator may administer more than one.
alter table public.athlete_join_links
  drop constraint if exists athlete_join_links_context_shape_check;
alter table public.athlete_join_links
  add constraint athlete_join_links_context_shape_check
  check (
    (context_type = 'private_coach' and context_id is null)
    or (context_type in ('club', 'team') and context_id is not null)
  );

alter table public.athlete_join_links
  drop constraint if exists athlete_join_links_max_uses_check;
alter table public.athlete_join_links
  add constraint athlete_join_links_max_uses_check
  check (max_uses is null or max_uses > 0);

-- Defense in depth, not the primary enforcement point - the actual "never
-- exceed max_uses" guarantee comes from POST .../approve incrementing
-- approved_uses inside the same locked transaction (see
-- backend/src/joinLinkContext.js's lockJoinLinkActions) that re-checks this
-- exact condition immediately beforehand.
alter table public.athlete_join_links
  drop constraint if exists athlete_join_links_approved_uses_check;
alter table public.athlete_join_links
  add constraint athlete_join_links_approved_uses_check
  check (approved_uses >= 0 and (max_uses is null or approved_uses <= max_uses));

create index if not exists athlete_join_links_context_idx
  on public.athlete_join_links (context_type, context_id);

create index if not exists athlete_join_links_creator_idx
  on public.athlete_join_links (created_by_user_id);

create table if not exists public.athlete_join_applications (
  id uuid primary key default gen_random_uuid(),
  join_link_id uuid not null references public.athlete_join_links(id) on delete cascade,
  applicant_user_id uuid references public.users(id) on delete set null,
  email text not null,
  first_name text,
  last_name text,
  display_name text,
  password_hash text,
  status varchar(20) not null default 'pending',
  status_token_hash text not null unique,
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by_user_id uuid references public.users(id) on delete set null,
  rejection_reason text,
  resulting_user_id uuid references public.users(id) on delete set null,
  resulting_athlete_id uuid references public.athletes(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 'requires_login' (see backend/src/routes/auth.js POST .../approve and the
-- "email now exists" race in the phase spec) is a distinct terminal-ish
-- state from 'pending': the application is neither actively awaiting review
-- in the normal sense nor rejected/cancelled - it is blocked until the
-- applicant proves ownership of that email via login (POST
-- .../apply-existing), which naturally produces a fresh row rather than
-- resurrecting this one. This one is left as an audit trail.
alter table public.athlete_join_applications
  drop constraint if exists athlete_join_applications_status_check;
alter table public.athlete_join_applications
  add constraint athlete_join_applications_status_check
  check (status in ('pending', 'approved', 'rejected', 'cancelled', 'requires_login'));

-- An existing-account application (applicant_user_id set, via the
-- authenticated .../apply-existing) NEVER carries a password - the account
-- already has one, and this endpoint must never be able to influence it.
alter table public.athlete_join_applications
  drop constraint if exists athlete_join_applications_existing_account_no_password_check;
alter table public.athlete_join_applications
  add constraint athlete_join_applications_existing_account_no_password_check
  check (applicant_user_id is null or password_hash is null);

-- A brand-new-email application (applicant_user_id null) must carry a
-- password hash for as long as it is genuinely still pending - there is no
-- other way it could ever create a login on approval. Deliberately does NOT
-- extend this requirement to 'requires_login' - by the time a row reaches
-- that status the password hash has already been intentionally cleared (the
-- email turned out to belong to a real account in the meantime; see POST
-- .../approve's email race handling), and the terminal-state check below
-- forbids it from coming back.
alter table public.athlete_join_applications
  drop constraint if exists athlete_join_applications_new_email_password_required_check;
alter table public.athlete_join_applications
  add constraint athlete_join_applications_new_email_password_required_check
  check (applicant_user_id is not null or status <> 'pending' or password_hash is not null);

-- Once a decision is final (approved/rejected/cancelled) the password hash
-- must already be gone - approve/reject always null it out in the same
-- transaction as the status change, so a hash can never outlive the window
-- where it might still be needed.
alter table public.athlete_join_applications
  drop constraint if exists athlete_join_applications_terminal_no_password_check;
alter table public.athlete_join_applications
  add constraint athlete_join_applications_terminal_no_password_check
  check (status in ('pending', 'requires_login') or password_hash is null);

-- One pending (or requires_login - it still occupies the "slot" until
-- resolved) application per normalized email per join link, and separately
-- one per applicant_user_id per join link - both are partial unique indexes
-- rather than table-wide, since a DIFFERENT join link (a different
-- context) submitting the same email/account is a completely separate
-- request.
create unique index if not exists athlete_join_applications_one_pending_email_idx
  on public.athlete_join_applications (join_link_id, lower(email))
  where status in ('pending', 'requires_login');

create unique index if not exists athlete_join_applications_one_pending_user_idx
  on public.athlete_join_applications (join_link_id, applicant_user_id)
  where status in ('pending', 'requires_login') and applicant_user_id is not null;

create index if not exists athlete_join_applications_link_idx
  on public.athlete_join_applications (join_link_id, status);

create index if not exists athlete_join_applications_applicant_idx
  on public.athlete_join_applications (applicant_user_id);

-- Verification (read-only, for manual review after running this migration):
-- select column_name from information_schema.columns
-- where table_schema = 'public' and table_name in ('athlete_join_links', 'athlete_join_applications')
-- order by table_name, column_name;
