select exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611261000_training_load_v94_chart_shapes.sql' and checksum='2c018c784ace8edc1cb0c9b729d5e0143166d813477899f678060d6c6ac304cb') v94_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_valid(jsonb)'))='9ce11aa017244998674f357eac2d8c89' dashboard_presentation_valid_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_assert_compatible(jsonb,text,text)'))='439d80f9e60bbf32479afdf58f102f4b' dashboard_presentation_assert_compatible_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)'))='ac6d865af34dcbfa510c66b0f1feb2da' dashboard_chart_shape_remap_exact;
select not exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611291000_training_load_v97_references.sql') v97_absent;
select (select count(*) from training_load.dashboards) dashboards,(select count(*) from training_load.dashboard_widgets) widgets,(select count(*) from training_load.dashboard_widget_series) series;
