-- v53 production post-check - READ ONLY. For the *Rukovodilac*, after the
-- owner's deploy of the phase 7i-B1 pull request (step 6 of the standing order
-- for migration PRs, docs/ai/metrics-core-plan.md, section 2), before any club
-- copies or hides a system variable: each numbered block verbatim through the
-- connector, in its own read-only transaction that is rolled back (section 2,
-- step 5). The owner may run the same blocks in the Supabase SQL Editor.
-- Migration: migrations_v2/202611041000_training_load_v53_system_variables_club.sql;
-- contract docs/ai/phase7i-system-variables-club-contract.md (J15), section 7.
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, change nothing, report the block,
-- the column and the value.

-- 1. v53 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v53_rows = 1, v53_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql') as v53_rows,
  (select bool_and(checksum = 'f6231766fe9a5f79dddf777892261e6204beba716164812ff2a178242547641c') from public.schema_migrations
    where migration_name = 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql') as v53_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql') as later_migrations;

-- 2. The two bodies v53 replaced are v53's, and its eight new functions are
--    there with v53's bodies (the rollback refuses unless the two are).
--    Expected: replaced_bodies_v53 = 2, new_bodies_v53 = 8.
select
  count(*) filter (where md5(p.prosrc) = want.digest and want.name in ('metric_variable_requests_insert_guard', 'source_metric_activations_insert_guard')) as replaced_bodies_v53,
  count(*) filter (where md5(p.prosrc) = want.digest and want.name not in ('metric_variable_requests_insert_guard', 'source_metric_activations_insert_guard')) as new_bodies_v53
  from (values
          ('club_variable_rows_append_only', 'd1f13d76d67caf1d51c87177302f3b7b'),
          ('metric_definition_club_hides_insert_guard', '47602ccaeb7e61497522b1c2c58fbf0b'),
          ('metric_definition_club_hides_update_guard', 'ab3b601db07452bcc885d1b86ce488dc'),
          ('metric_definition_club_hides_xact_link', 'df199e289140b44276447e9710af3640'),
          ('metric_definition_copies_insert_guard', '6c0815ec05e7b6431a93b21f4374197e'),
          ('metric_definition_copies_request_link', '81c946b878577ceb33f95234b3e21b0b'),
          ('metric_variable_requests_insert_guard', 'dfec05ae802bfbb810c5c46337616970'),
          ('source_metric_activations_insert_guard', 'e4f9a4e632d00c090d2c646def16374d'),
          ('source_metric_mapping_version_copies_audit_link', 'b32e8a9dfab3308ce2025b9e08348086'),
          ('source_metric_mapping_version_copies_insert_guard', 'fe5e6637516952d4309e8cb2c7eb1f73')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 3. The request table as v53 left it: the operation CHECK with variable_copy,
--    version_iff, operation_id_iff, the one-create index and the insert
--    trigger's WHEN.
--    Expected: every column = true.
select
  coalesce((select pg_get_constraintdef(oid) = 'CHECK ((operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text, ''variable_rename''::text, ''variable_archive''::text, ''variable_restore''::text, ''variable_icon''::text, ''variable_copy''::text])))'
              from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass
               and conname = 'metric_variable_requests_operation_check'), false) as operation_check_v53,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((metric_definition_version_id IS NOT NULL) = (operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text, ''variable_copy''::text]))))'
              from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass
               and conname = 'metric_variable_requests_version_iff'), false) as version_iff_v53,
  coalesce((select pg_get_constraintdef(oid) = 'CHECK (((operation_id IS NOT NULL) = (operation = ''variable_copy''::text)))'
              from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass
               and conname = 'metric_variable_requests_operation_id_iff'), false) as operation_id_iff_v53,
  coalesce((select indexdef = 'CREATE UNIQUE INDEX metric_variable_requests_one_create_per_definition ON training_load.metric_variable_requests USING btree (metric_definition_id) WHERE (operation = ANY (ARRAY[''variable_create''::text, ''variable_copy''::text]))'
              from pg_indexes where schemaname = 'training_load' and indexname = 'metric_variable_requests_one_create_per_definition'), false) as index_v53,
  coalesce((select pg_get_triggerdef(t.oid) = 'CREATE TRIGGER metric_variable_requests_insert_guard BEFORE INSERT ON training_load.metric_variable_requests FOR EACH ROW WHEN ((new.operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text, ''variable_copy''::text]))) EXECUTE FUNCTION training_load.metric_variable_requests_insert_guard()'
              from pg_trigger t where t.tgrelid = 'training_load.metric_variable_requests'::regclass
               and t.tgname = 'metric_variable_requests_insert_guard'), false) as trigger_v53;

-- 4. The three new tables with their triggers (13, three of them deferred
--    constraint triggers) and their unique indexes, every trigger enabled.
--    Expected: new_tables = 3, new_triggers = 13, deferred_triggers = 3,
--    disabled_triggers = 0, new_indexes = 8.
select
  (select count(*) from pg_class c where c.relnamespace = 'training_load'::regnamespace and c.relkind = 'r'
     and c.relname in ('metric_definition_copies', 'source_metric_mapping_version_copies', 'metric_definition_club_hides')) as new_tables,
  (select count(*) from pg_trigger t where not t.tgisinternal
     and t.tgrelid in ('training_load.metric_definition_copies'::regclass, 'training_load.source_metric_mapping_version_copies'::regclass, 'training_load.metric_definition_club_hides'::regclass)) as new_triggers,
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgdeferrable and t.tginitdeferred
     and t.tgrelid in ('training_load.metric_definition_copies'::regclass, 'training_load.source_metric_mapping_version_copies'::regclass, 'training_load.metric_definition_club_hides'::regclass)) as deferred_triggers,
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgenabled <> 'O'
     and t.tgrelid in ('training_load.metric_definition_copies'::regclass, 'training_load.source_metric_mapping_version_copies'::regclass, 'training_load.metric_definition_club_hides'::regclass,
                       'training_load.metric_variable_requests'::regclass, 'training_load.source_metric_mapping_activations'::regclass)) as disabled_triggers,
  (select count(*) from pg_indexes where schemaname = 'training_load'
     and tablename in ('metric_definition_copies', 'source_metric_mapping_version_copies', 'metric_definition_club_hides')) as new_indexes;

-- 5. Nothing was copied or hidden yet (the code that writes these rows ships
--    with v53; B2's screen comes later): the rollback stays possible until
--    the first copy, hide or variable_copy request.
--    Expected: copies = 0, links = 0, hides = 0, copy_requests = 0.
select
  (select count(*) from training_load.metric_definition_copies) as copies,
  (select count(*) from training_load.source_metric_mapping_version_copies) as links,
  (select count(*) from training_load.metric_definition_club_hides) as hides,
  (select count(*) from training_load.metric_variable_requests where operation = 'variable_copy') as copy_requests;

-- 6. No default for the actor setting, and none set in this session.
--    Expected: actor_defaults = 0, session_actor = '' (empty).
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  coalesce(current_setting('optimove.source_metric_actor', true), '') as session_actor;

-- 7. Quiet: no session is idle in a transaction and no lock waits on the
--    request table, T5 or the new tables.
--    Expected: idle_in_transaction = 0, waiting = 0.
select
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l
    where not l.granted and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.metric_variable_requests'::regclass, 'training_load.source_metric_mapping_activations'::regclass,
                         'training_load.metric_definition_copies'::regclass, 'training_load.source_metric_mapping_version_copies'::regclass, 'training_load.metric_definition_club_hides'::regclass)) as waiting;
