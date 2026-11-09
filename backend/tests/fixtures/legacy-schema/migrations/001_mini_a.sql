-- A miniature of migrations_v2 for the generator tests (not applied anywhere real).
create schema if not exists training_load;

create table training_load.items (
  id uuid primary key,
  team_id uuid not null
);
create index items_team_idx on training_load.items (team_id);
create trigger items_touch before update on training_load.items for each row execute function public.touch_updated_at();

create table public.app_audit (
  id uuid primary key,
  note text
);

alter table public.users add column if not exists content_language varchar(8) not null default 'en';
alter table public.users add constraint users_language_check check (content_language in ('en', 'sr'));
alter table public.users add constraint users_language_known check (content_language <> '');
create index users_language_idx on public.users (content_language);
