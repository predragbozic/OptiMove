-- Read-only, compare the returned checksum with the release packet.
select migration_name, checksum from public.schema_migrations where migration_name='migrations_v2/202612011000_training_load_v99_schedule_manage_bridge.sql';
select active as calendar_v98_activation_unchanged from calendar.m1_activation where singleton;
select first_checked_write_at from training_load.external_schedule_m2_use where singleton;
select layer,count(*) as seeded from training_load.external_schedule_m2_seed group by layer order by layer;
select md5(prosrc) = '83d0186d6ab02ea435ad5303bea5da0f' as v99_permission_body_matches,
       public.permission_word_honoured('load.schedule.manage') as word_storable
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');
