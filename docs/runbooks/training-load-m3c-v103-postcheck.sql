-- Read-only, compare the returned checksum with the release packet.
select migration_name, checksum from public.schema_migrations where migration_name='migrations_v2/202612051000_training_load_v103_activity_identity_manage_bridge.sql';
select active as calendar_v98_activation_unchanged from calendar.m1_activation where singleton;
select first_checked_write_at from training_load.activity_identity_m3c_use where singleton;
select layer,count(*) as seeded from training_load.activity_identity_m3c_seed group by layer order by layer;
select md5(prosrc) = 'de24c9ae7db6abf6d1db7f0e6b891b5e' as v103_permission_body_matches,
       public.permission_word_honoured('load.activities.manage') as word_storable
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');
