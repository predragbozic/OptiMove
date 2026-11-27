-- Read-only, compare the returned checksum with the release packet.
select migration_name, checksum from public.schema_migrations where migration_name='migrations_v2/202612041000_training_load_v102_estimates_manage_bridge.sql';
select active as calendar_v98_activation_unchanged from calendar.m1_activation where singleton;
select first_checked_write_at from training_load.metric_estimate_m3b_use where singleton;
select layer,count(*) as seeded from training_load.metric_estimate_m3b_seed group by layer order by layer;
select md5(prosrc) = 'bf0ab02eb4dd495ee00b0f19f282820f' as v102_permission_body_matches,
       public.permission_word_honoured('load.estimates.manage') as word_storable
from pg_proc where oid=to_regprocedure('public.permission_word_honoured(text)');
