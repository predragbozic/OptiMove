-- Read-only, compare the returned checksum with the release packet.
select migration_name, checksum from public.schema_migrations where migration_name='migrations_v2/202612031000_training_load_v101_roster_manage_bridge.sql';
select active as calendar_v98_activation_unchanged from calendar.m1_activation where singleton;
select first_checked_write_at from training_load.activity_roster_m3a_use where singleton;
select layer,count(*) as seeded from training_load.activity_roster_m3a_seed group by layer order by layer;
select md5(prosrc) = 'a4a7ad447a22d5161bcaa22cc7c25c68' as v101_permission_body_matches,
       public.permission_word_honoured('load.roster.decide') as word_storable
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');
