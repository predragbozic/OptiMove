-- P1 B rollback: no Page use, no receipts, no later migration. Explicit owner order only.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $guard$ begin
 if not pg_try_advisory_xact_lock(822026) then raise exception 'v91 rollback refused: migrator active' using errcode='23514';end if;
 if (select checksum from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql') is distinct from '1da5706c418c0f3262d6a88689e8d1355247a97d7d31bad4a82a59d396c52247' then raise exception 'v91 rollback refused: migration checksum mismatch' using errcode='23514';end if;
 if not exists(select 1 from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql') then raise exception 'v91 rollback refused: not recorded' using errcode='23514';end if;
 if exists(select 1 from public.schema_migrations where migration_name<>'migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql' and applied_at>=(select applied_at from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql')) then raise exception 'v91 rollback refused: later migration' using errcode='23514';end if;
end $guard$;
lock table training_load.dashboards in access exclusive mode;
lock table training_load.dashboard_widgets in access exclusive mode;
lock table training_load.dashboard_widget_series in access exclusive mode;
lock table training_load.dashboard_pages in access exclusive mode;
lock table training_load.dashboard_page_requests in access exclusive mode;
do $current_b$
begin
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.assert_dashboard_writable(uuid)')) is distinct from 'f87c11a22a39517c37fbf1e4f117a69b' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.current_dashboard_page(uuid)')) is distinct from '5deeaf70aefbc0655f262cc94f3c9dc8' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_required()')) is distinct from 'a0f385cf24691b3389e2397d23ae4c07' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_home_sync_defaults()')) is distinct from '70f38353a470245079231daf2ee93478' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_context_matches(uuid)')) is distinct from '79ae2ff5f31f2cd8dffff2c40402147e' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_page_period_valid(jsonb)')) is distinct from 'de37086fc382ec8b50173412cd8b1924' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_assign_home()')) is distinct from '673f26f5b9949bb1241b0d5d884b2458' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widget_bump_page_revision()')) is distinct from 'b3ab8b1d33176e95fa5f9352ea0ddea7' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.dashboard_widgets_check_no_overlap()')) is distinct from '96b0f3fed42ce4eca49a13468d44b838' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.delete_dashboard(uuid,integer,uuid,character varying)')) is distinct from '19453ff4134447c03da1a2db1147dd27' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.ensure_dashboard_home()')) is distinct from 'f5666f32e7fd0a2dfcf2fc8e1faf4c25' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_page_identity()')) is distinct from '60599a027271957e8aa6d1c23a74c030' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_widget_page_protocol()')) is distinct from '4915decb92f583bf2b75d8dd30d478d0' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_widget(uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb)')) is distinct from '33c8f87b3104a723f4c4d140d8922b43' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.cleanup_dashboard_page_requests(integer)')) is distinct from '6e53ea86ca99784b9e6e503be7f48a67' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.copy_dashboard_page_widget(uuid,uuid,jsonb,uuid,text,uuid,uuid,integer,uuid,integer,timestamp with time zone)')) is distinct from '75953d6b01271f1707c1f28c1a7c0632' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.guard_dashboard_page_requests()')) is distinct from 'cf603f632f6bb7ebb30e7fe932097e63' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.mutate_dashboard_page(uuid,uuid,jsonb,uuid,text,integer,text,uuid,jsonb,timestamp with time zone)')) is distinct from 'e5df8b526678889d07fb1082addbfa43' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.save_simple_page_widget(uuid,integer,uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb,jsonb)')) is distinct from '545aa60b5d53f0df2d6a9f4c39d5150b' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
 if (select md5(prosrc) from pg_proc where oid=to_regprocedure('training_load.write_dashboard_page_widget(uuid,uuid,integer,text,uuid,uuid,uuid,jsonb)')) is distinct from '7c5843d26519f22947a421441452e691' then raise exception 'v91 rollback refused: function body changed' using errcode='23514';end if;
end
$current_b$;
do $guard$ begin
 if exists(select 1 from training_load.dashboard_pages_activation where enabled) or exists(select 1 from training_load.dashboard_pages where not is_home) or exists(select 1 from training_load.dashboard_page_requests) or exists(select 1 from training_load.dashboard_simple_requests where receipt?'pageId') then raise exception 'v91 rollback refused: Page use or receipts' using errcode='23514';end if;
end $guard$;
drop table training_load.dashboard_page_requests;
drop function training_load.cleanup_dashboard_page_requests(integer);
drop function training_load.copy_dashboard_page_widget(uuid,uuid,jsonb,uuid,text,uuid,uuid,integer,uuid,integer,timestamp with time zone);
drop function training_load.guard_dashboard_page_requests();
drop function training_load.mutate_dashboard_page(uuid,uuid,jsonb,uuid,text,integer,text,uuid,jsonb,timestamp with time zone);
drop function training_load.save_simple_page_widget(uuid,integer,uuid,uuid,text,timestamp with time zone,uuid,uuid,integer,jsonb,jsonb,jsonb,jsonb);
drop function training_load.write_dashboard_page_widget(uuid,uuid,integer,text,uuid,uuid,uuid,jsonb);
delete from public.schema_migrations where migration_name='migrations_v2/202611231100_training_load_v91_dashboard_page_writers.sql';
commit;
