create table if not exists public.message_conversations (
  id uuid primary key default gen_random_uuid(),
  conversation_type varchar(32) not null default 'direct'
    check (conversation_type in ('direct', 'coach_contact', 'group')),
  status varchar(32) not null default 'active'
    check (status in ('active', 'archived')),
  title text,
  created_by_user_id uuid references public.users(id) on delete set null,
  source_type varchar(80),
  source_id uuid,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.message_participants (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.message_conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  participant_role varchar(32) not null default 'member'
    check (participant_role in ('member', 'owner')),
  last_read_at timestamptz,
  blocked_at timestamptz,
  blocked_by_user_id uuid references public.users(id) on delete set null,
  joined_at timestamptz not null default now(),
  unique (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.message_conversations(id) on delete cascade,
  sender_user_id uuid references public.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.coach_contact_requests
  add column if not exists conversation_id uuid references public.message_conversations(id) on delete set null;

alter table public.coach_contact_requests
  drop constraint if exists coach_contact_requests_status_check;

alter table public.coach_contact_requests
  add constraint coach_contact_requests_status_check
  check (status in ('new', 'read', 'replied', 'accepted', 'archived'));

create index if not exists message_conversations_last_idx
  on public.message_conversations (last_message_at desc nulls last, updated_at desc);

create index if not exists message_conversations_source_idx
  on public.message_conversations (source_type, source_id);

create index if not exists message_participants_user_idx
  on public.message_participants (user_id, conversation_id);

create index if not exists messages_conversation_idx
  on public.messages (conversation_id, created_at);
