begin;
set local lock_timeout = '5s';

do $guard$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v64 rollback refused: the migrator is running';
  end if;
end
$guard$;

lock table training_load.dashboard_widgets, training_load.dashboard_widget_series,
  training_load.dashboard_simple_requests in access exclusive mode;

do $guard$
begin
  if not exists (select 1 from public.schema_migrations
      where migration_name = 'migrations_v2/202611131000_training_load_v66_dashboard_simple_atomic_save.sql')
    or exists (select 1 from public.schema_migrations
      where migration_name like 'migrations_v2/%'
        and migration_name > 'migrations_v2/202611131000_training_load_v66_dashboard_simple_atomic_save.sql') then
    raise exception 'v64 rollback refused: v64 is not the last applied v2 migration';
  end if;
  if (select md5(prosrc) from pg_proc where oid =
      to_regprocedure('training_load.dashboard_widgets_bump_revision()')) is distinct from 'a845d879d38d8a6dccf443736a34fe8f' then
    raise exception 'v64 rollback refused: unexpected revision function';
  end if;
  if exists (select 1 from training_load.dashboard_simple_requests)
    or exists (select 1 from training_load.dashboard_widgets where presentation_config is not null) then
    raise exception 'v64 rollback refused: dashboard presentation or save receipts exist';
  end if;
end
$guard$;

drop trigger dashboard_widgets_guard_presentation on training_load.dashboard_widgets;
drop trigger dashboard_widget_series_guard_presentation on training_load.dashboard_widget_series;
alter table training_load.dashboard_widgets drop constraint dashboard_widgets_presentation_shape;
alter table training_load.dashboard_widgets drop column presentation_config;

create or replace function training_load.dashboard_widgets_bump_revision() returns trigger as $$
declare
  v_layout_changed boolean;
  v_content_changed boolean;
begin
  v_layout_changed := (
    new.x is distinct from old.x or new.y is distinct from old.y
    or new.width is distinct from old.width or new.height is distinct from old.height
    or new.mobile_order is distinct from old.mobile_order
  );
  v_content_changed := (
    new.widget_type is distinct from old.widget_type
    or new.title is distinct from old.title
    or new.widget_order is distinct from old.widget_order
    or new.group_by is distinct from old.group_by
    or new.state is distinct from old.state
    or new.display_config is distinct from old.display_config
    or new.local_filter_override is distinct from old.local_filter_override
  );
  if v_layout_changed or v_content_changed then
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;
  -- Deadlock-safety note: calling bump_dashboard_revision from THIS
  -- before-row trigger does NOT, by itself, achieve dashboard-before-
  -- widget lock ordering for a raw ad-hoc UPDATE — Postgres already
  -- acquires THIS row's own lock before any before-row trigger body
  -- runs, so by the time this trigger tries to lock the dashboard, the
  -- WIDGET row is already locked — the reverse of dashboard-then-widget.
  -- This is still functionally correct (dashboard.revision DOES end up
  -- bumped) but is NOT proven deadlock-safe against a concurrent
  -- replace_dashboard_layout()/update_widget_layout() call, which lock
  -- dashboard-then-widget. Kept anyway as defense-in-depth correctness
  -- for any writer that bypasses the two sanctioned functions (v17) — the
  -- application layer must never rely on this trigger alone for a
  -- concurrent layout write.
  if v_layout_changed then
    perform training_load.bump_dashboard_revision(new.dashboard_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop function training_load.cleanup_dashboard_simple_requests;
drop function training_load.save_simple_widget;
drop function training_load.update_widget_content_with_presentation;
drop function training_load.create_widget_with_presentation;
drop function training_load.dashboard_widget_series_guard_presentation;
drop function training_load.dashboard_widgets_guard_presentation;
drop function training_load.dashboard_presentation_assert_series;
drop function training_load.dashboard_presentation_assert_compatible;
drop function training_load.dashboard_presentation_opaque;
drop function training_load.dashboard_presentation_valid;
drop function training_load.dashboard_simple_object;

drop table training_load.dashboard_simple_requests;
delete from public.schema_migrations
where migration_name = 'migrations_v2/202611131000_training_load_v66_dashboard_simple_atomic_save.sql';
commit;
