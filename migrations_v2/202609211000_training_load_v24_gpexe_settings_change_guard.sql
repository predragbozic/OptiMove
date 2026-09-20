-- Training Load v24 — GPEXE import: why a team's GPEXE connection was set,
-- and which GPEXE team a check read from.
--
-- Owner decisions, 2026-09-19/20 (phase F3b groundwork):
--   * A team's GPEXE connection may be changed only while nothing depends on
--     it. The application refuses such a change in one transaction under the
--     team import lock, with the reason the coach and the admin read (409
--     gpexe_team_change_blocked), and the triggers below refuse it again -
--     whoever writes it, including psql or a future script (the v20/v21/v23
--     contract: the database is the backstop, not the only guard). They cover
--     both an UPDATE of the GPEXE team and a DELETE of the row, so a delete
--     and a fresh insert cannot re-point a team either.
--   * The reason for a change is recorded. The first connection needs no
--     reason; changing one does.
--   * Disconnecting is NOT part of this work, and nothing here deletes or
--     re-points existing data.
--
-- Semantics of the two reason columns, on purpose:
--   * gpexe_team_settings.change_reason says why the CURRENT value was set.
--   * every gpexe_team_settings_history row is a copy of a value at the
--     moment it was set (the v22 trigger copies NEW, not OLD), so its
--     change_reason says why THAT value was set then. It never says why that
--     value was later replaced - the next row does that.
--
-- Lock order for anything that writes these tables (extends v22/v23): the
-- team import lock (pg_advisory_xact_lock on 'gpexe-import-team:<team>',
-- gpexeImportWriter.lockTeamForImport) is taken FIRST and alone by the
-- connection change (setTeamSettings), by the check row write (startCheck)
-- and by an athlete link write; an approval keeps its v23 order and takes the
-- same lock last. The application holds that lock, never a GPEXE request.
--
-- Why a GPEXE athlete id or session id cannot simply carry over to another
-- GPEXE team: athlete links are keyed (owner_team_id, gpexe_athlete_id) and
-- candidates (owner_team_id, gpexe_team_session_id, bundle_hash), both
-- without the GPEXE team, and one active gpexe source connection exists per
-- OptiMove team. Reusing them across GPEXE teams would silently import one
-- athlete's GPS data as another athlete's.

-- 1. Why the current connection was set. A reason is either absent or real
--    text; the length bound keeps an audit note from becoming a document.
alter table training_load.gpexe_team_settings
  add column change_reason text
  -- A reason has at least one non-whitespace character: btrim() alone would
  -- let a tab or a newline through.
  check (change_reason is null or (change_reason ~ '[^[:space:]]' and length(change_reason) <= 500));

comment on column training_load.gpexe_team_settings.change_reason is
  'Why the current GPEXE team of this OptiMove team was set. Null for a first connection made before v24 or without a reason. Never a token, password or other credential.';

-- 2. The same fact, kept per historical value.
alter table training_load.gpexe_team_settings_history
  add column change_reason text;

comment on column training_load.gpexe_team_settings_history.change_reason is
  'Why the value in THIS row was set (the row is a copy of the setting at that moment). Not why it was later replaced.';

-- 3. The trigger carries the reason of the value being written. Existing rows
--    keep change_reason null: nothing is invented for connections made before
--    this migration.
create or replace function training_load.record_gpexe_team_setting() returns trigger as $$
begin
  insert into training_load.gpexe_team_settings_history (owner_team_id, gpexe_team_id, configured_by_user_id, configured_at, change_reason)
  values (new.owner_team_id, new.gpexe_team_id, new.configured_by_user_id, new.configured_at, new.change_reason);
  return new;
end;
$$ language plpgsql;

-- 4. Which GPEXE team a check actually read from. The check decides that once,
--    under the team import lock, and keeps reading that team even if the
--    connection is changed later - so the run stays readable afterwards.
--    Null on checks that ran before this migration.
alter table training_load.gpexe_import_checks
  add column gpexe_team_id text
  check (gpexe_team_id is null or gpexe_team_id ~ '^[0-9]{1,12}$');

comment on column training_load.gpexe_import_checks.gpexe_team_id is
  'The GPEXE team this check read from, taken from the team settings under the team import lock when the check row was written. Null for checks from before v24.';

-- 5. The lock this subsystem serializes on, as a function the triggers share.
--    It never waits: the application takes the lock first and the row second,
--    so a waiting trigger would deadlock against it. A session that already
--    holds the lock (the application's own write) gets it again at once.
create function training_load.hold_gpexe_team_lock(owner_team uuid, what text) returns void as $$
begin
  if not pg_try_advisory_xact_lock(hashtextextended('gpexe-import-team:' || owner_team::text, 21)) then
    raise exception 'gpexe: a GPEXE check, import or connection change is running for team % (%); try again when it has finished', owner_team, what;
  end if;
end;
$$ language plpgsql;

-- 6. The database's own refusal. The application answers first, with a
--    readable reason; this is what a raw UPDATE meets. It refuses a change of
--    the GPEXE team while anything of that team's still describes the old one,
--    and a change without a reason. Setting the same value again, and the
--    first connection, pass untouched.
create function training_load.refuse_gpexe_team_repoint() returns trigger as $$
declare
  depends_on text;
begin
  -- The row belongs to one OptiMove team for good: moving it would carry a
  -- GPEXE team, its links and its imported data to another team's name.
  if new.owner_team_id is distinct from old.owner_team_id then
    raise exception 'gpexe_team_settings: the OptiMove team of a GPEXE connection is final (% -> %)',
      old.owner_team_id, new.owner_team_id;
  end if;
  if new.gpexe_team_id is not distinct from old.gpexe_team_id then
    -- Same GPEXE team: the only accepted write is one that changes nothing.
    -- Returning null cancels it, so the history trigger never fires and no
    -- row is appended for a write that said nothing new.
    if new.change_reason is not distinct from old.change_reason
       and new.configured_by_user_id is not distinct from old.configured_by_user_id
       and new.configured_at is not distinct from old.configured_at then
      return null;
    end if;
    raise exception 'gpexe_team_settings: for team %, the reason, the author and the time can only change together with the GPEXE team',
      old.owner_team_id;
  end if;
  -- The rows below are only evidence if nothing may be writing them right
  -- now, so this refusal holds the team import lock the application takes
  -- (gpexeImportWriter.lockTeamForImport, seed 21). A session that already
  -- holds it - the application's own change - gets it again at once; a raw
  -- UPDATE racing a check, a link or an import does not, and is refused
  -- instead of waiting: waiting here would deadlock against the application,
  -- which takes this lock first and the row second.
  perform training_load.hold_gpexe_team_lock(old.owner_team_id, 'connection change');
  if new.change_reason is null then
    raise exception 'gpexe_team_settings: changing the GPEXE team of % needs a reason', old.owner_team_id
      using errcode = 'check_violation';
  end if;
  select what into depends_on from (
    select 'a session found by a check' as what
      where exists (select 1 from training_load.gpexe_import_candidates where owner_team_id = old.owner_team_id)
    union all
    select 'a check'
      where exists (select 1 from training_load.gpexe_import_checks where owner_team_id = old.owner_team_id)
    union all
    select 'a GPEXE athlete linked to an OptiMove athlete'
      where exists (select 1 from training_load.gpexe_athlete_links where owner_team_id = old.owner_team_id)
    union all
    select 'an approved import'
      where exists (select 1 from training_load.gpexe_import_approvals where owner_team_id = old.owner_team_id)
    union all
    select 'imported GPEXE data'
      where exists (
        select 1 from training_load.metric_source_connections c
        where c.source_system = 'gpexe' and c.owner_scope = 'team' and c.owner_team_id = old.owner_team_id
          and (c.state = 'active' or exists (select 1 from training_load.metric_events e where e.source_connection_id = c.id))
      )
  ) blockers limit 1;
  if depends_on is not null then
    -- Default SQLSTATE P0001, like the other guards in this subsystem.
    raise exception 'gpexe_team_settings: team % already has % from GPEXE team %; the connection can no longer be changed',
      old.owner_team_id, depends_on, old.gpexe_team_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_refuse_repoint
  before update on training_load.gpexe_team_settings
  for each row execute function training_load.refuse_gpexe_team_repoint();

-- 7. Both the application's guard and the trigger above ask "does this team
--    have ANY link", unlinked ones included (an unlinked number still meant
--    someone under the old GPEXE team). v22's two indexes are partial
--    (`where unlinked_at is null`), so neither covers that question and it
--    would scan the whole table as unlinked rows pile up (db-reviewer).
create index gpexe_athlete_links_owner_team_idx
  on training_load.gpexe_athlete_links (owner_team_id);

-- 8. The same backstop for DELETE: without it, a delete and a fresh insert
--    would re-point a team past the trigger above, and the history would read
--    as a first connection (code-reviewer). Disconnecting is not designed
--    yet; when it is, it decides what happens to the rows below and replaces
--    this refusal.
-- Every delete is refused, not only one with dependent rows: a delete and a
-- fresh insert would re-point a team past the refusal above, and the history
-- would then read as a first connection with no reason. Disconnecting is not
-- designed yet; the migration that designs it decides what happens to the
-- candidates, links, approvals and imported events, and replaces this
-- refusal with that procedure.
create function training_load.refuse_gpexe_settings_delete() returns trigger as $$
begin
  raise exception 'gpexe_team_settings: a GPEXE connection is never deleted (team %, GPEXE team %); disconnecting is not supported yet',
    old.owner_team_id, old.gpexe_team_id;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_refuse_delete
  before delete on training_load.gpexe_team_settings
  for each row execute function training_load.refuse_gpexe_settings_delete();

-- TRUNCATE fires no row trigger (the v19/v21/v22 lesson), so it gets its own.
create trigger gpexe_team_settings_no_truncate
  before truncate on training_load.gpexe_team_settings
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 9. The GPEXE team a check read is what makes that run readable afterwards,
--    so it is written once and never edited (the v20 lesson: a source
--    identity that can move stops agreeing with the data it describes).
create function training_load.freeze_gpexe_check_team() returns trigger as $$
declare
  connected text;
begin
  -- Which team ran the check is part of what the row says: moving it would
  -- give another team a run it never made, and take a blocker off this one.
  if new.owner_team_id is distinct from old.owner_team_id then
    raise exception 'gpexe_import_checks: the OptiMove team of check % is final', old.id;
  end if;
  if new.gpexe_team_id is not distinct from old.gpexe_team_id then
    return new;
  end if;
  if old.gpexe_team_id is not null then
    raise exception 'gpexe_import_checks: the GPEXE team of check % is final', old.id;
  end if;
  -- A row from before v24 may still be given the team it read, but only the
  -- one its own team is connected to, and only under the same lock the
  -- connection change takes. If that cannot be proven, it stays empty: an
  -- invented origin is worse than a missing one.
  perform training_load.hold_gpexe_team_lock(new.owner_team_id, 'check');
  -- The value that was in force when this check ran, not the one in force
  -- now: a team connected to another GPEXE team since then would otherwise
  -- get an origin its old run never had. The history keeps every value with
  -- the time it was set (v22); the current row is the fallback for a check
  -- older than the first recorded value.
  select h.gpexe_team_id into connected
    from training_load.gpexe_team_settings_history h
   where h.owner_team_id = new.owner_team_id and h.configured_at <= old.started_at
   order by h.configured_at desc limit 1;
  if connected is null then
    select gpexe_team_id into connected from training_load.gpexe_team_settings where owner_team_id = new.owner_team_id;
  end if;
  if connected is null or new.gpexe_team_id is distinct from connected then
    raise exception 'gpexe_import_checks: check % can only record the GPEXE team its own team read then (%)',
      old.id, coalesce(connected, 'none');
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_checks_freeze_team
  before update on training_load.gpexe_import_checks
  for each row execute function training_load.freeze_gpexe_check_team();

-- 10. A first connection is only safe when nothing of that team already
--     describes a GPEXE team nobody recorded. Such rows can only come from
--     a deleted-and-restored setting or from direct SQL, and the number in
--     them means something only inside the GPEXE team they came from.
create function training_load.refuse_gpexe_settings_orphans() returns trigger as $$
declare
  orphan text;
begin
  perform training_load.hold_gpexe_team_lock(new.owner_team_id, 'first connection');
  select what into orphan from (
    select 'a session found by a check' as what
      where exists (select 1 from training_load.gpexe_import_candidates where owner_team_id = new.owner_team_id)
    union all
    select 'a check'
      where exists (select 1 from training_load.gpexe_import_checks where owner_team_id = new.owner_team_id)
    union all
    select 'a GPEXE athlete linked to an OptiMove athlete'
      where exists (select 1 from training_load.gpexe_athlete_links where owner_team_id = new.owner_team_id)
    union all
    select 'an approved import'
      where exists (select 1 from training_load.gpexe_import_approvals where owner_team_id = new.owner_team_id)
    union all
    select 'imported GPEXE data'
      where exists (
        select 1 from training_load.metric_source_connections c
        where c.source_system = 'gpexe' and c.owner_scope = 'team' and c.owner_team_id = new.owner_team_id
          and (c.state = 'active' or exists (select 1 from training_load.metric_events e where e.source_connection_id = c.id))
      )
  ) orphans limit 1;
  if orphan is not null then
    raise exception 'gpexe_team_settings: team % already has % from a GPEXE team that is not recorded; connecting it needs a platform admin to resolve that first',
      new.owner_team_id, orphan;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_refuse_orphans
  before insert on training_load.gpexe_team_settings
  for each row execute function training_load.refuse_gpexe_settings_orphans();

-- 11. A GPEXE athlete number belongs to a GPEXE team, so a link may only be
--     written once the team's connection is recorded - and under the same
--     lock, so a link can never appear inside a connection change's own
--     decision.
create function training_load.require_gpexe_connection_for_link() returns trigger as $$
declare
  -- The owning team never changes (v22's own link guard refuses that), and
  -- this trigger also runs on INSERT, where OLD has no tuple at all: NEW is
  -- the one row both operations always have.
  team uuid := new.owner_team_id;
begin
  perform training_load.hold_gpexe_team_lock(team, 'athlete link');
  if tg_op = 'INSERT' and not exists (select 1 from training_load.gpexe_team_settings where owner_team_id = team) then
    raise exception 'gpexe_athlete_links: team % has no GPEXE team yet, so a GPEXE athlete number means nothing for it', team;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_athlete_links_require_connection
  before insert or update on training_load.gpexe_athlete_links
  for each row execute function training_load.require_gpexe_connection_for_link();

-- 12. A check records the GPEXE team it read. After v24 that is never absent
--     and never something other than the team's own connection at the moment
--     the row is written, under the same lock.
create function training_load.require_gpexe_check_team() returns trigger as $$
declare
  connected text;
begin
  perform training_load.hold_gpexe_team_lock(new.owner_team_id, 'check');
  select gpexe_team_id into connected from training_load.gpexe_team_settings where owner_team_id = new.owner_team_id;
  if connected is null then
    raise exception 'gpexe_import_checks: team % has no GPEXE team yet', new.owner_team_id;
  end if;
  if new.gpexe_team_id is null then
    raise exception 'gpexe_import_checks: a check records the GPEXE team it reads (team %)', new.owner_team_id;
  end if;
  if new.gpexe_team_id is distinct from connected then
    raise exception 'gpexe_import_checks: check of team % says GPEXE team % while the team is connected to %',
      new.owner_team_id, new.gpexe_team_id, connected;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_checks_require_team
  before insert on training_load.gpexe_import_checks
  for each row execute function training_load.require_gpexe_check_team();

-- 13. The checks table keeps the GPEXE team each run read, so it is not
--     emptied either (TRUNCATE fires no row trigger).
create trigger gpexe_import_checks_no_truncate
  before truncate on training_load.gpexe_import_checks
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 14. Both the connection change and a first connection ask whether any
--     GPEXE event of the team exists; without this index that question
--     scans metric_events for every source connection that is not active
--     (db-reviewer).
create index metric_events_source_connection_idx
  on training_load.metric_events (source_connection_id) where source_connection_id is not null;

-- 15. A check is also the record that stops its team's connection from being
--     changed, so it is not deleted either. Without this, a raw delete of a
--     team's checks would take that blocker away and let the connection move
--     (code-reviewer). The Disconnect work decides what happens to these rows.
create function training_load.refuse_gpexe_check_delete() returns trigger as $$
begin
  raise exception 'gpexe_import_checks: a check of team % is never deleted (it records which GPEXE team was read)', old.owner_team_id;
end;
$$ language plpgsql;

create trigger gpexe_import_checks_refuse_delete
  before delete on training_load.gpexe_import_checks
  for each row execute function training_load.refuse_gpexe_check_delete();
