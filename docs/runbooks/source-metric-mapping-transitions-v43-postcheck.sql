-- v43 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 7b merge served /api/health with
-- ok: true (contract docs/ai/phase7b-mapping-transitions-contract.md,
-- section 7).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v43 recorded exactly once with the repository's
--    checksum, and it is the last migration; v42 still recorded once.
--    Expected: v43_rows = 1, v43_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql,
--    v42_rows = 1.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as v43_rows,
  (select bool_and(checksum = 'b88c1662b4dd2fd0e2ff79886fd49ebe28d9f38236044ecccd5739e6f86af363') from public.schema_migrations
    where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as v43_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_rows;

-- 2. The two v43 function bodies are the ones v43 wrote (the md5 of each body)
--    and carry v43's comment; v35's source_metric_actor_basis is unchanged (the
--    md5 of preflight block 3).
--    Expected: replacement_link_is_v43 = true, transition_facts_is_v43 = true,
--    comments_name_v43 = true, actor_basis_is_v35 = true.
select
  (select md5(p.prosrc) = 'bd038acd54bef4e61157da29486499c2'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_audit_replacement_link') as replacement_link_is_v43,
  (select md5(p.prosrc) = 'fb9d85f35c77c49ff03eeb823bf01891'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_audit_transition_facts') as transition_facts_is_v43,
  (coalesce(obj_description('training_load.source_metric_audit_replacement_link()'::regprocedure, 'pg_proc'), '') like 'v43 %'
   and coalesce(obj_description('training_load.source_metric_audit_transition_facts()'::regprocedure, 'pg_proc'), '') like 'v43 %') as comments_name_v43,
  (select md5(p.prosrc) = 'bff4852216ffda968b33b730cd05da47'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_actor_basis') as actor_basis_is_v35;

-- 3. Both v43 triggers on the audit table, enabled, of the kind v43 specifies:
--    the replacement link an AFTER INSERT ROW constraint trigger, deferrable
--    and initially deferred (tgtype 5); the transition facts a BEFORE INSERT
--    ROW trigger, not deferrable (tgtype 7).
--    Expected: two rows -
--    source_metric_audit_v43_replacement_link | 5 | true | true | O | true
--    source_metric_audit_v43_transition_facts | 7 | false | false | O | false
select t.tgname, t.tgtype, t.tgdeferrable, t.tginitdeferred, t.tgenabled, t.tgconstraint <> 0 as is_constraint_trigger
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname = 'source_metric_audit' and t.tgname like 'source_metric_audit_v43_%'
 order by t.tgname;

-- 4. The numbers of preflight block 5, unchanged (v43 writes no row; no
--    request reached the new routes between the two checks), and still no
--    active version and no activation.
--    Expected: each value equal to the preflight's block 5;
--    versions_active = 0, activations = 0.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'draft') as versions_draft,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'needs_review') as versions_needs_review,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'active') as versions_active,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'disabled') as versions_disabled,
  (select count(*) from training_load.source_metric_audit
    where action in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced')) as mapping_audit_rows,
  (select count(*) from training_load.source_metric_mapping_activations) as activations;

-- 5. No database- or role-level default for the actor setting, and every
--    trigger of T3, T4 and T8 enabled.
--    Expected: actor_defaults = 0, disabled_triggers = 0.
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 6. No lock left on T3, T4 or T8 by another session (the migration committed).
--    Expected: table_locks = 0 (a non-zero value that is gone a few seconds
--    later was an ordinary short write).
select count(*) as table_locks
  from pg_locks l
 where l.pid <> pg_backend_pid()
   and l.database = (select oid from pg_database where datname = current_database())
   and l.mode in ('RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
   and l.relation in ('training_load.source_metric_mappings'::regclass, 'training_load.source_metric_mapping_versions'::regclass,
                      'training_load.source_metric_audit'::regclass);
