-- Empty-by-design compatibility release. v106 writers omit the proof.
set local lock_timeout = '5s';

do $$
begin
  if not exists (
    select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612081000_training_load_v106_builder_rpe_provenance.sql'
      and checksum = 'f75a6eb6cc162c39f3e52968424138334fd84b3a9b38aef2407e4de2b8edd808'
  ) then
    raise exception 'v107 requires the exact v106 Builder RPE bridge';
  end if;
end
$$;

alter table training_load.builder_rpe_plan_baselines
  add column opening_verified boolean not null default false,
  add constraint builder_rpe_plan_copy_proof_check check (
    not opening_verified or (source_plan_id is not null and opening_tracking)
  );

alter table training_load.builder_rpe_session_baselines
  add column opening_verified boolean not null default false,
  add constraint builder_rpe_session_copy_proof_check check (
    not opening_verified or opening_tracking
  );

create table training_load.builder_rpe_copy_attestation_use (
  singleton boolean primary key default true check (singleton)
);

alter table training_load.builder_rpe_copy_attestation_use enable row level security;
revoke all on training_load.builder_rpe_copy_attestation_use from public;

create function training_load.guard_builder_rpe_copy_attestation()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if tg_op = 'UPDATE' then
    if old.opening_verified or new.opening_verified then
      raise exception 'Builder RPE copy attestation is immutable';
    end if;
    return new;
  end if;

  if new.opening_verified then
    insert into training_load.builder_rpe_copy_attestation_use default values on conflict do nothing;
  end if;
  return new;
end
$$;

revoke all on function training_load.guard_builder_rpe_copy_attestation() from public;

create trigger builder_rpe_plan_copy_attestation_guard
before insert or update on training_load.builder_rpe_plan_baselines
for each row execute function training_load.guard_builder_rpe_copy_attestation();

create trigger builder_rpe_session_copy_attestation_guard
before insert or update on training_load.builder_rpe_session_baselines
for each row execute function training_load.guard_builder_rpe_copy_attestation();

create function training_load.guard_builder_rpe_copy_attestation_use()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception 'Builder RPE copy attestation use is append-only';
end
$$;

revoke all on function training_load.guard_builder_rpe_copy_attestation_use() from public;

create trigger builder_rpe_copy_attestation_use_append_only
before update or delete or truncate on training_load.builder_rpe_copy_attestation_use
for each statement execute function training_load.guard_builder_rpe_copy_attestation_use();

do $$
declare api_role text;
begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists (select 1 from pg_roles where rolname=api_role) then
      execute format('revoke all on training_load.builder_rpe_copy_attestation_use from %I',api_role);
      execute format('revoke all on function training_load.guard_builder_rpe_copy_attestation() from %I',api_role);
      execute format('revoke all on function training_load.guard_builder_rpe_copy_attestation_use() from %I',api_role);
    end if;
  end loop;
end
$$;