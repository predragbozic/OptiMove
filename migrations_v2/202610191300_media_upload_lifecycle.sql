-- BE-2: durable verification claim and append-only upload lifecycle audit.
-- Required for crash recovery and completion/cancel fencing across both services.
alter table media.uploads
  add column verification_token uuid,
  add column verification_until timestamptz,
  add column error_code text;
create table media.upload_events (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid references media.uploads(id),
  performed_by_user_id uuid not null references public.users(id),
  event text not null check (event in ('requested','issued','renewed','verifying','completed','cancelling','cancelled','failed')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index upload_events_actor_time on media.upload_events(performed_by_user_id,created_at);
create index upload_events_upload_time on media.upload_events(upload_id,created_at);
alter table media.upload_events enable row level security;
revoke all on media.upload_events from public;
create trigger upload_events_immutable before update or delete or truncate on media.upload_events
  for each statement execute function media.reject_audit_mutation();
do $$
declare role_name text;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=role_name) and role_name<>current_user then
      execute format('revoke all on media.upload_events from %I',role_name);
    end if;
  end loop;
end;
$$;
