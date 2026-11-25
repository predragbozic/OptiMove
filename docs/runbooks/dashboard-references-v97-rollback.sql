begin;
set local lock_timeout='5s';
do $guard$ begin
 if exists(select 1 from public.schema_migrations where migration_name>'migrations_v2/202611291000_training_load_v97_references.sql') then raise exception 'v97 rollback refused: later migration' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.cleanup_dashboard_reference_requests(integer)')) is distinct from '77e80133356e6849701126d56fc062f5' then raise exception 'v97 body changed: %','training_load.cleanup_dashboard_reference_requests(integer)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_chart_shape_remap(jsonb,jsonb)')) is distinct from 'b6d4fb39b640111f59d740c3e2c3dbd7' then raise exception 'v97 body changed: %','training_load.dashboard_chart_shape_remap(jsonb,jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_assert_compatible(jsonb,text,text)')) is distinct from '8aed9e3acc0c1b2000d270b3901676d8' then raise exception 'v97 body changed: %','training_load.dashboard_presentation_assert_compatible(jsonb,text,text)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_presentation_valid(jsonb)')) is distinct from '70c92eae1e81f961e058d115c6ccc244' then raise exception 'v97 body changed: %','training_load.dashboard_presentation_valid(jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_assert_widget(uuid)')) is distinct from 'a606b609c6ee5c5a8efdb0a720359b7b' then raise exception 'v97 body changed: %','training_load.dashboard_reference_assert_widget(uuid)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_column_available(uuid,uuid,text,text,text)')) is distinct from '390a7d265ae9e06661f2a6276c19212d' then raise exception 'v97 body changed: %','training_load.dashboard_reference_column_available(uuid,uuid,text,text,text)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_config_valid(jsonb)')) is distinct from 'b176f2e543e616f19151dba97dfbdf66' then raise exception 'v97 body changed: %','training_load.dashboard_reference_config_valid(jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_deferred()')) is distinct from 'ab09e8eff67572adbd642b0b90ac66cf' then raise exception 'v97 body changed: %','training_load.dashboard_reference_deferred()' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_guard()')) is distinct from '452c37d00dc1f149fb918e4e7686fca2' then raise exception 'v97 body changed: %','training_load.dashboard_reference_guard()' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_compatible(jsonb,text,text)')) is distinct from '439d80f9e60bbf32479afdf58f102f4b' then raise exception 'v97 body changed: %','training_load.dashboard_reference_legacy_compatible(jsonb,text,text)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_remap(jsonb,jsonb)')) is distinct from 'ac6d865af34dcbfa510c66b0f1feb2da' then raise exception 'v97 body changed: %','training_load.dashboard_reference_legacy_remap(jsonb,jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_legacy_valid(jsonb)')) is distinct from '9ce11aa017244998674f357eac2d8c89' then raise exception 'v97 body changed: %','training_load.dashboard_reference_legacy_valid(jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_reference_no_truncate()')) is distinct from '9643b3cd89d443cba945182bc53f3bce' then raise exception 'v97 body changed: %','training_load.dashboard_reference_no_truncate()' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.mutate_dashboard_reference(uuid,uuid,uuid,text,uuid,integer,text,jsonb)')) is distinct from '4f1cf2472e9673a09a096e929ac8c4c2' then raise exception 'v97 body changed: %','training_load.mutate_dashboard_reference(uuid,uuid,uuid,text,uuid,integer,text,jsonb)' using errcode='23514'; end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_dashboard_reference_binding(uuid,uuid,uuid,uuid,text,uuid,uuid,integer,text,jsonb)')) is distinct from 'b3ee6804636124abeec6b683a06f2721' then raise exception 'v97 body changed: %','training_load.save_dashboard_reference_binding(uuid,uuid,uuid,uuid,text,uuid,uuid,integer,text,jsonb)' using errcode='23514'; end if;
end $guard$;
lock table training_load.dashboards in access exclusive mode;
lock table training_load.dashboard_pages in access exclusive mode;
lock table training_load.dashboard_widgets in access exclusive mode;
lock table training_load.dashboard_widget_series in access exclusive mode;
lock table training_load.dashboard_reference_cells in access exclusive mode;
lock table training_load.dashboard_reference_columns in access exclusive mode;
lock table training_load.dashboard_reference_requests in access exclusive mode;
lock table training_load.dashboard_reference_rows in access exclusive mode;
lock table training_load.dashboard_reference_tables in access exclusive mode;
lock table training_load.dashboard_reference_usage in access exclusive mode;
lock table training_load.dashboard_reference_value_kinds in access exclusive mode;
lock table training_load.dashboard_reference_versions in access exclusive mode;
lock table training_load.dashboard_reference_widget_usage in access exclusive mode;
do $use$ begin if exists(select 1 from training_load.dashboard_reference_tables) or exists(select 1 from training_load.dashboard_reference_requests) or exists(select 1 from training_load.dashboard_reference_widget_usage) or exists(select 1 from training_load.dashboard_widgets where presentation_config?'referenceConfig') then raise exception 'v97 rollback refused: real reference writes' using errcode='23514';end if;end $use$;
drop trigger dashboard_reference_widget_check on training_load.dashboard_widgets;
drop trigger dashboard_reference_series_check on training_load.dashboard_widget_series;
CREATE OR REPLACE FUNCTION training_load.dashboard_presentation_valid(p_config jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
begin
 if p_config is not null and p_config->'schemaVersion'='1'::jsonb and p_config?'chartShape' then
  return training_load.dashboard_chart_shape_valid(p_config->'chartShape')
    and not(p_config?'tableFormatting') and training_load.dashboard_chart_shape_legacy_valid(p_config-'chartShape');
 end if;
 return training_load.dashboard_chart_shape_legacy_valid(p_config);
end;
$function$
;
CREATE OR REPLACE FUNCTION training_load.dashboard_presentation_assert_compatible(p_config jsonb, p_widget_type text, p_group_by text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
 if not training_load.dashboard_presentation_valid(p_config) then raise exception 'invalidPresentation' using errcode='S2C02';end if;
 perform training_load.dashboard_chart_shape_legacy_compatible(p_config-'chartShape',p_widget_type,p_group_by);
 if p_config->'schemaVersion'='1'::jsonb and p_config?'chartShape' then
  if p_widget_type not in ('line_chart','bar_chart') or p_config#>>'{chartShape,kind}'='area' and p_widget_type<>'line_chart'
   or p_config#>>'{chartShape,kind}'='horizontal_bar' and p_widget_type<>'bar_chart'
   or p_config#>>'{chartShape,kind}' in ('heatmap','boxplot') and p_group_by not in ('day','week') then
   raise exception 'incompatiblePresentation' using errcode='S2C02';end if;
 end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION training_load.dashboard_chart_shape_remap(p_config jsonb, p_map jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare s jsonb;ids jsonb='[]';bindings jsonb='[]';v jsonb;target text;
begin
 if p_config is null or p_config->'schemaVersion' is distinct from '1'::jsonb or not(p_config?'chartShape') then return p_config;end if;
 s:=p_config->'chartShape';
 for v in select value from jsonb_array_elements(s->'seriesIds') loop
  target:=p_map->>lower(v#>>'{}');if target is null then raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
  ids:=ids||jsonb_build_array(target);
 end loop;
 s:=jsonb_set(s,'{seriesIds}',ids);
 if s?'bindings' then
  for v in select value from jsonb_array_elements(s->'bindings') loop
   target:=p_map->>lower(v->>'seriesId');if target is null then raise exception 'gallerySeriesRequired' using errcode='S2C02';end if;
   bindings:=bindings||jsonb_build_array(jsonb_set(v,'{seriesId}',to_jsonb(target)));
  end loop;
  s:=jsonb_set(s,'{bindings}',bindings);
 end if;
 return jsonb_set(p_config,'{chartShape}',s);
end;
$function$
;
drop table training_load.dashboard_reference_cells,training_load.dashboard_reference_columns,training_load.dashboard_reference_requests,training_load.dashboard_reference_rows,training_load.dashboard_reference_tables,training_load.dashboard_reference_usage,training_load.dashboard_reference_value_kinds,training_load.dashboard_reference_versions,training_load.dashboard_reference_widget_usage;
drop function training_load.cleanup_dashboard_reference_requests(integer);
drop function training_load.dashboard_reference_assert_widget(uuid);
drop function training_load.dashboard_reference_column_available(uuid,uuid,text,text,text);
drop function training_load.dashboard_reference_deferred();
drop function training_load.dashboard_reference_guard();
drop function training_load.dashboard_reference_legacy_compatible(jsonb,text,text);
drop function training_load.dashboard_reference_legacy_remap(jsonb,jsonb);
drop function training_load.dashboard_reference_legacy_valid(jsonb);
drop function training_load.dashboard_reference_no_truncate();
drop function training_load.mutate_dashboard_reference(uuid,uuid,uuid,text,uuid,integer,text,jsonb);
drop function training_load.save_dashboard_reference_binding(uuid,uuid,uuid,uuid,text,uuid,uuid,integer,text,jsonb);
drop function training_load.dashboard_reference_config_valid(jsonb);
do $restored$ begin
 if (select md5(prosrc) from pg_proc where oid='training_load.dashboard_presentation_valid(jsonb)'::regprocedure) is distinct from '9ce11aa017244998674f357eac2d8c89' then raise exception 'v97 restored body mismatch';end if;
 if (select md5(prosrc) from pg_proc where oid='training_load.dashboard_presentation_assert_compatible(jsonb,text,text)'::regprocedure) is distinct from '439d80f9e60bbf32479afdf58f102f4b' then raise exception 'v97 restored body mismatch';end if;
 if (select md5(prosrc) from pg_proc where oid='training_load.dashboard_chart_shape_remap(jsonb,jsonb)'::regprocedure) is distinct from 'ac6d865af34dcbfa510c66b0f1feb2da' then raise exception 'v97 restored body mismatch';end if;
end $restored$;
delete from public.schema_migrations where migration_name='migrations_v2/202611291000_training_load_v97_references.sql';
commit;
