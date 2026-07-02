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
    check (library_scope in ('my', 'club', 'optimove', 'marketplace')),
  add column if not exists library_category varchar(80),
  add column if not exists cover_image_url text,
  add column if not exists is_free boolean not null default true,
  add column if not exists price_cents integer,
  add column if not exists available_until date,
  add column if not exists owner_type varchar(32) not null default 'coach'
    check (owner_type in ('coach', 'club', 'optimove', 'marketplace'));

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
