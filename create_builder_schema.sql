-- OptiMove program builder hierarchy.
-- Imported records keep their legacy domain/category/section snapshot fields on plan_items.

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
