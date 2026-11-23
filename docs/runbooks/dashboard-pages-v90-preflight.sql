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
select to_regclass('training_load.dashboard_pages') is null as schema_absent,
not exists(select 1 from public.schema_migrations where migration_name >= 'migrations_v2/202611231000') as no_same_or_later_migration,
not exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and xact_start is not null) as quiet_moment;
select count(*)=1 and bool_and(checksum='eee3ebad9d414e2c6f614de3003dc8241e3fcbc3bacf5a751bbc0376800f8b5b') as required_file_matches from public.schema_migrations where migration_name='migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql';
select count(*)=1 and bool_and(checksum='b5eb2967e68218eadaf7ec2a27355320534f8466a37c50e83d3fc7fbe0b289a8') as required_file_matches from public.schema_migrations where migration_name='migrations_v2/202611191200_training_load_v79_calculated_ratio_difference.sql';
select count(*)=1 and bool_and(checksum='dfafb581c762d724d63a8356f93d9422ec96e27dfab75a344746e83b23df2e9c') as required_file_matches from public.schema_migrations where migration_name='migrations_v2/202611201300_roles_v84_permission_roles.sql';
select count(*)=1 and bool_and(checksum='11b31dcf34c557a3b9b292850384642570c074a39759d556f0111179e5ed41df') as required_file_matches from public.schema_migrations where migration_name='migrations_v2/202611201500_training_load_v85_session_types.sql';
select not exists(select 1 from public.schema_migrations where (migration_name='migrations_v2/202611221200_athletes_v87_positions.sql' and checksum is distinct from 'f0422b12dd159e8be27e39357f03bc252e8b16045570a61285d9e17ce19cca54') or (migration_name ~ '_v87_' and migration_name<>'migrations_v2/202611221200_athletes_v87_positions.sql')) as optional_file_matches;
select not exists(select 1 from public.schema_migrations where (migration_name='migrations_v2/202611221300_training_load_v88_manual_values.sql' and checksum is distinct from '20002940bf6243e4a5d0519600e7cb0941e21d6b56990333bc9b245808ddd8e8') or (migration_name ~ '_v88_' and migration_name<>'migrations_v2/202611221300_training_load_v88_manual_values.sql')) as optional_file_matches;
select not exists(select 1 from public.schema_migrations where (migration_name='migrations_v2/202611221400_training_load_v89_participant_session_types.sql' and checksum is distinct from '2a74ca824cb774d98546ece898c6eb359f5b1b023a750a142433bb0044f62540') or (migration_name ~ '_v89_' and migration_name<>'migrations_v2/202611221400_training_load_v89_participant_session_types.sql')) as optional_file_matches;
commit;
