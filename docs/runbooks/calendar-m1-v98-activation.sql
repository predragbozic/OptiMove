-- Apply only after the owner orders activation and every legacy instance is drained.
begin;
set local lock_timeout='5s';
select pg_advisory_xact_lock(11816506,1);
update calendar.m1_activation set active=true where singleton and not active;
commit;
select active from calendar.m1_activation where singleton;
