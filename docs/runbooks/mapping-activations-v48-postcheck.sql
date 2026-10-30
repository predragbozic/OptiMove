-- v48 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor after the deploy of the phase 7d pull request, before any
-- activation is started or ended
-- (migrations_v2/202610301900_training_load_v48_mapping_activations.sql;
-- contract docs/ai/phase7d-mapping-activations-contract.md, section 6.4).
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, change nothing, report the block,
-- the column and the value.

-- 1. v48 recorded once, with the repository's checksum, as the last
--    migrations_v2 migration.
--    Expected: v48_rows = 1, v48_checksum_ok = true, later_migrations = 0.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_rows,
  (select bool_and(checksum = '71e57c43c0820315926c9535c31b5efcd634908bfb4c7947a75fe8990193abe0') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as later_migrations;

-- 2. The nine function bodies are v48's: the six it replaced and the three it
--    added.
--    Expected: bodies_v48 = 9.
select count(*) filter (where md5(p.prosrc) = want.digest) as bodies_v48
  from (values
          ('source_metric_activations_insert_guard', 'e47f75d4a7a6c63659a19491db97d678'),
          ('source_metric_activations_update_guard', 'f4ce8781c0f1797663064cd4e5c63929'),
          ('source_metric_audit_row_ok', '764f4ad70de273a443be84bc9bebd87a'),
          ('source_metric_audit_insert_guard', '157c1ba1be40aaaa6cf5884542919c11'),
          ('source_metric_audit_actor_guard', '3622725a1b0d454767704b2021db731c'),
          ('source_metric_audit_revision_guard', '921db06f6f2833eb57c062fb61e82e25'),
          ('source_metric_binding_club', '19af0456676d9ce2549d754523ed97b9'),
          ('source_metric_activations_start_link', '73639204a88d04d06fff671c49576ed4'),
          ('source_metric_activations_end_link', '41b4a4ed570f641112a4ce360b64e79b')) as want(name, digest)
  join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 3. T5's two basis CHECKs admit club_admin and are validated.
--    Expected: basis_checks_v48 = 2.
select count(*) as basis_checks_v48
  from pg_constraint c
 where c.conrelid = 'training_load.source_metric_mapping_activations'::regclass and c.convalidated
   and ((c.conname = 'source_metric_activations_activated_basis_check'
         and pg_get_constraintdef(c.oid) = 'CHECK ((activated_basis = ANY (ARRAY[''platform_admin''::text, ''club_admin''::text])))')
     or (c.conname = 'source_metric_activations_ended_basis_check'
         and pg_get_constraintdef(c.oid) = 'CHECK (((ended_basis IS NULL) OR (ended_basis = ANY (ARRAY[''platform_admin''::text, ''club_admin''::text]))))'));

-- 4. The two deferred audit links: enabled, deferrable and initially deferred,
--    AFTER INSERT (tgtype 5) and AFTER UPDATE (tgtype 17), each calling its v48
--    function; T5's two guards still enabled.
--    Expected: links_ok = 2, guards_enabled = 2.
select
  (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass and t.tgenabled = 'O'
      and t.tgdeferrable and t.tginitdeferred
      and ((t.tgname = 'source_metric_activations_v48_audit_link_start' and t.tgtype = 5 and p.proname = 'source_metric_activations_start_link')
        or (t.tgname = 'source_metric_activations_v48_audit_link_end' and t.tgtype = 17 and p.proname = 'source_metric_activations_end_link'))) as links_ok,
  (select count(*) from pg_trigger t
    where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass and t.tgenabled = 'O'
      and t.tgname in ('source_metric_activations_insert_guard', 'source_metric_activations_update_guard')) as guards_enabled;

-- 5. The once-index is valid and ready.
--    Expected: index_ok = true.
select coalesce((select i.indisvalid and i.indisready and i.indisunique from pg_index i
                  where i.indexrelid = to_regclass('training_load.source_metric_audit_v48_activation_once')), false) as index_ok;

-- 6. No activation yet (this post-check runs before the first one).
--    Expected: activations = 0, activation_audit_rows = 0.
select
  (select count(*) from training_load.source_metric_mapping_activations) as activations,
  (select count(*) from training_load.source_metric_audit where action in ('activation_start', 'activation_end')) as activation_audit_rows;
