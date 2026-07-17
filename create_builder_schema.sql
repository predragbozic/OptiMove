-- OptiMove program builder hierarchy.
-- Imported records keep their legacy domain/category/section snapshot fields on plan_items.

-- Builder-created plans have their own presentation and sharing defaults. Public
-- publishing is intentionally not enabled yet; every new draft starts private.
alter table plans.plans
  add column if not exists color varchar(32),
  add column if not exists is_active boolean not null default true,
  add column if not exists visibility varchar(32) not null default 'private'
    check (visibility in ('private', 'team', 'club', 'public'));

alter table plans.plans
  add column if not exists library_scope varchar(32) not null default 'my'
    check (library_scope in ('workspace', 'my', 'team', 'club', 'optimove', 'marketplace')),
  add column if not exists library_category varchar(80),
  add column if not exists cover_image_url text,
  add column if not exists is_free boolean not null default true,
  add column if not exists price_cents integer,
  add column if not exists available_until date,
  add column if not exists owner_type varchar(32) not null default 'coach'
    check (owner_type in ('coach', 'team', 'club', 'optimove', 'marketplace'));

do $$
declare
  constraint_to_drop text;
begin
  for constraint_to_drop in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'plans'
      and rel.relname = 'plans'
      and con.contype = 'c'
      and exists (
        select 1
        from pg_attribute att
        where att.attrelid = rel.oid
          and att.attname in ('visibility', 'library_scope', 'owner_type')
          and att.attnum = any(con.conkey)
      )
  loop
    execute format('alter table plans.plans drop constraint if exists %I', constraint_to_drop);
  end loop;
end $$;

alter table plans.plans
  add constraint plans_visibility_check
  check (visibility in ('private', 'team', 'club', 'public'));

alter table plans.plans
  drop constraint if exists plans_library_scope_check;

alter table plans.plans
  add constraint plans_library_scope_check
  check (library_scope in ('workspace', 'my', 'team', 'club', 'optimove', 'marketplace'));

alter table plans.plans
  drop constraint if exists plans_owner_type_check;

alter table plans.plans
  add constraint plans_owner_type_check
  check (owner_type in ('coach', 'team', 'club', 'optimove', 'marketplace'));

alter table plans.plans
  add column if not exists access_model varchar(32) not null default 'free_forever',
  add column if not exists access_duration_days integer,
  add column if not exists subscription_period varchar(16),
  add column if not exists can_copy boolean not null default true,
  add column if not exists can_edit_copy boolean not null default true,
  add column if not exists can_assign_to_athlete boolean not null default true,
  add column if not exists athlete_can_view_directly boolean not null default false,
  add column if not exists requires_approval boolean not null default false;

alter table plans.plans
  drop constraint if exists plans_access_model_check;

alter table plans.plans
  add constraint plans_access_model_check
  check (access_model in ('free_forever', 'one_time_forever', 'time_limited', 'subscription', 'assigned', 'trial'));

alter table plans.plans
  drop constraint if exists plans_subscription_period_check;

alter table plans.plans
  add constraint plans_subscription_period_check
  check (subscription_period is null or subscription_period in ('month', 'year'));

alter table plans.plans
  drop constraint if exists plans_access_duration_days_check;

alter table plans.plans
  add constraint plans_access_duration_days_check
  check (access_duration_days is null or access_duration_days > 0);

alter table plans.plans
  add column if not exists edit_source_plan_id uuid references plans.plans(id) on delete cascade,
  add column if not exists is_edit_draft boolean not null default false;

create index if not exists plans_edit_source_idx
  on plans.plans (edit_source_plan_id)
  where is_edit_draft = true;

create table if not exists plans.plan_nodes (
  id uuid primary key default gen_random_uuid(),
  plan_session_id uuid not null references plans.plan_sessions(id) on delete cascade,
  parent_id uuid references plans.plan_nodes(id) on delete cascade,
  node_type varchar(20) not null check (node_type in ('domain', 'category', 'section')),
  name varchar(255) not null,
  color varchar(32),
  icon_url text,
  short_note text,
  note text,
  node_order numeric not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table plans.plan_items
  add column if not exists plan_node_id uuid references plans.plan_nodes(id) on delete set null;

create index if not exists plan_nodes_session_order_idx
  on plans.plan_nodes (plan_session_id, parent_id, node_order);

create index if not exists plan_items_plan_node_order_idx
  on plans.plan_items (plan_node_id, item_order);

create table if not exists library.tags (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null unique,
  slug varchar(140) not null unique,
  owner_scope varchar(20) not null default 'user' check (owner_scope in ('system', 'user', 'club')),
  owner_user_id uuid references public.users(id) on delete cascade,
  created_by_user_id uuid references public.users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table library.tags
  add column if not exists slug varchar(140),
  add column if not exists owner_scope varchar(20) not null default 'user',
  add column if not exists owner_user_id uuid references public.users(id) on delete cascade,
  add column if not exists created_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists library.program_tag_definitions (
  id uuid primary key default gen_random_uuid(),
  name varchar(120) not null,
  slug varchar(140),
  owner_scope varchar(20) not null default 'user' check (owner_scope in ('system', 'user', 'club')),
  owner_user_id uuid references public.users(id) on delete cascade,
  created_by_user_id uuid references public.users(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table library.program_tag_definitions
  add column if not exists slug varchar(140),
  add column if not exists owner_scope varchar(20) not null default 'user',
  add column if not exists owner_user_id uuid references public.users(id) on delete cascade,
  add column if not exists created_by_user_id uuid references public.users(id) on delete set null,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists library.program_tags (
  plan_id uuid not null references plans.plans(id) on delete cascade,
  tag_id uuid not null references library.tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (plan_id, tag_id)
);

insert into library.program_tag_definitions (id, name, slug, owner_scope, owner_user_id, created_by_user_id, is_active, created_at, updated_at)
select distinct t.id, t.name, t.slug, t.owner_scope, t.owner_user_id, t.created_by_user_id, t.is_active, t.created_at, t.updated_at
from library.tags t
join library.program_tags pt on pt.tag_id = t.id
on conflict (id) do nothing;

alter table library.program_tags
  drop constraint if exists program_tags_tag_id_fkey;

alter table library.program_tags
  add constraint program_tags_tag_id_fkey
  foreign key (tag_id) references library.program_tag_definitions(id) on delete cascade;

create index if not exists program_tags_tag_idx
  on library.program_tags (tag_id);

create index if not exists program_tag_definitions_name_idx
  on library.program_tag_definitions (lower(name));
