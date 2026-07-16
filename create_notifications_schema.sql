create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.users(id) on delete cascade,
  actor_user_id uuid references public.users(id) on delete set null,
  type varchar(80) not null,
  title text not null,
  body text,
  entity_type varchar(80),
  entity_id uuid,
  href text,
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.app_notifications
  add column if not exists recipient_user_id uuid references public.users(id) on delete cascade,
  add column if not exists actor_user_id uuid references public.users(id) on delete set null,
  add column if not exists type varchar(80),
  add column if not exists title text,
  add column if not exists body text,
  add column if not exists entity_type varchar(80),
  add column if not exists entity_id uuid,
  add column if not exists href text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists read_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

create index if not exists app_notifications_recipient_idx
  on public.app_notifications (recipient_user_id, read_at, created_at desc);

create index if not exists app_notifications_type_idx
  on public.app_notifications (type, created_at desc);
