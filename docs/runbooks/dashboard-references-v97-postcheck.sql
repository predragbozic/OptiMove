select count(*)=1 and bool_and(checksum='2855f8f49b342456b28dea79b7298dd88e42dceb0f867873ce71eb8bd9c9eb22') v97_exact from public.schema_migrations where migration_name='migrations_v2/202611291000_training_load_v97_references.sql';
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.cleanup_dashboard_reference_requests(integer)'))='77e80133356e6849701126d56fc062f5' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)'))='b6d4fb39b640111f59d740c3e2c3dbd7' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_assert_compatible(jsonb,text,text)'))='8aed9e3acc0c1b2000d270b3901676d8' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_valid(jsonb)'))='70c92eae1e81f961e058d115c6ccc244' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_assert_widget(uuid)'))='a606b609c6ee5c5a8efdb0a720359b7b' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_column_available(uuid,uuid,text,text,text)'))='390a7d265ae9e06661f2a6276c19212d' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_config_valid(jsonb)'))='b176f2e543e616f19151dba97dfbdf66' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_deferred()'))='ab09e8eff67572adbd642b0b90ac66cf' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_guard()'))='452c37d00dc1f149fb918e4e7686fca2' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_compatible(jsonb,text,text)'))='439d80f9e60bbf32479afdf58f102f4b' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_remap(jsonb,jsonb)'))='ac6d865af34dcbfa510c66b0f1feb2da' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_valid(jsonb)'))='9ce11aa017244998674f357eac2d8c89' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_no_truncate()'))='9643b3cd89d443cba945182bc53f3bce' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.mutate_dashboard_reference(uuid,uuid,uuid,text,uuid,integer,text,jsonb)'))='4f1cf2472e9673a09a096e929ac8c4c2' body_exact;
select (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_dashboard_reference_binding(uuid,uuid,uuid,uuid,text,uuid,uuid,integer,text,jsonb)'))='b3ee6804636124abeec6b683a06f2721' body_exact;
select not exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='training_load' and (c.relname like 'dashboard_reference_%' or t.tgname like 'dashboard_reference_%') and not t.tgisinternal and t.tgenabled<>'O') triggers_enabled;
select d.id as dashboard_id,md5(to_jsonb(d)::text) dashboard_digest,
 (select count(*) from training_load.dashboard_pages p where p.dashboard_id=d.id) pages,
 (select md5(coalesce(string_agg(to_jsonb(p)::text,E'\n' order by p.id),'')) from training_load.dashboard_pages p where p.dashboard_id=d.id) page_digest,
 (select count(*) from training_load.dashboard_widgets w where w.dashboard_id=d.id) widgets,
 (select md5(coalesce(string_agg(to_jsonb(w)::text,E'\n' order by w.id),'')) from training_load.dashboard_widgets w where w.dashboard_id=d.id) widget_digest,
 (select count(*) from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=d.id) series,
 (select md5(coalesce(string_agg(to_jsonb(s)::text,E'\n' order by s.id),'')) from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=d.id) series_digest
from training_load.dashboards d order by d.id;
