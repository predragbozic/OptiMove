-- Owner read-only evidence. Run on the CURRENT production database in a read-only
-- transaction; no temporary table, lock or user/session/athlete data is selected.
begin transaction read only;
select version(),current_database(),current_user,inet_server_addr(),inet_server_port();
select migration_name,checksum from public.schema_migrations order by migration_name;
select d.id as dashboard_id,
 md5((to_jsonb(d))::text) as dashboard_digest,
 (select count(*) from training_load.dashboard_widgets w where w.dashboard_id=d.id) as widgets,
 (select md5(coalesce(string_agg(to_jsonb(w)::text,E'\n' order by w.id),'')) from training_load.dashboard_widgets w where w.dashboard_id=d.id) as widget_digest,
 (select count(*) from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=d.id) as series,
 (select md5(coalesce(string_agg(to_jsonb(s)::text,E'\n' order by s.id),'')) from training_load.dashboard_widget_series s join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=d.id) as series_digest
from training_load.dashboards d order by d.id;
select t.tgname,p.oid::regprocedure::text as signature,md5(p.prosrc) as body_md5,
 pg_get_triggerdef(t.oid) as definition,t.tgenabled
from pg_trigger t join pg_proc p on p.oid=t.tgfoid
where t.tgrelid='training_load.dashboard_widgets'::regclass and not t.tgisinternal order by t.tgname;
select p.oid::regprocedure::text as signature,md5(p.prosrc) as body_md5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='training_load' and (p.proname like '%dashboard%' or p.proname in
 ('create_widget','update_widget_layout','update_widget_content','delete_widget','add_series','update_series',
 'delete_series','reorder_series','resolve_series_binding','save_simple_widget','create_widget_with_presentation',
 'update_widget_content_with_presentation','bump_widget_revision')) order by 1;
select pid,state,xact_start,wait_event_type,wait_event
from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null order by xact_start;
commit;
