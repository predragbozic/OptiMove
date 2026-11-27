-- Read-only. Require the reviewed release sequence, not a local predecessor guess.
select exists (
  select 1 from public.schema_migrations
  where migration_name = 'migrations_v2/202612071000_training_load_v105_dashboards_manage_bridge.sql'
    and checksum = '4de3a21ecdb76ce67c34610460c087b4b3df6a9a0635bee3a7eb708a5184284d'
) as provisional_v105_exact,
not exists (
  select 1 from public.schema_migrations where migration_name like 'migrations_v2/202612081000_%'
) as v106_prefix_unused,
to_regclass('training_load.builder_rpe_provenance_use') is null as marker_absent,
to_regclass('training_load.plan_workspace_ownership') is not null as ownership_present;
