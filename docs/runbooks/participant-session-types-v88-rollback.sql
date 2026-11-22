-- Rollback of migration v88 (a session type per athlete, ST-3; migrations_v2/202611221300_training_load_v88_participant_session_types.sql).
--
-- Not a migration and never run automatically. Rehearsed on a disposable database (backend/tests/session-types-st3-migration.test.mjs:
-- apply -> rollback -> the catalog identical to before -> apply again), on PostgreSQL 16. Before it is run anywhere real: the deployed
-- commit no longer contains the v88 file (otherwise the migrator applies v88 again at the next start) and no longer calls
-- training.effective_activity_type or the v88 tables, and the database is named in its own approval (.claude/rules/database-safety.md).
--
-- It restores v4's bodies of training.merge_activity_participants and training.reparent_activity_participant verbatim (checked by
-- md5 before and after), puts the correction log's foreign key back to v1's (no cascade) and drops its delete guard, drops
-- training.effective_activity_type, training.session_type_team_decider, the two v88 tables with their triggers and functions, and
-- deletes the v88 record. It changes no other row. It refuses (23514, fixed message), changing nothing, once any of these holds -
-- from then on v88 is forward-only:
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v88 is not recorded, or any migration was applied after it (by applied_at, not by prefix);
--   * an exception row or a request row exists (a type was changed after an import, or an athlete got a type of their own);
--   * the two function bodies in force are not v88's.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f participant-session-types-v88-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
declare
  expected constant text[][] := array[
    ['merge_activity_participants', 'f6fa45c13fcd11765b9d2eac5b2cd80e'],
    ['reparent_activity_participant', '0b3f25f34d823af811c8cb824861e4bf']];
  i int;
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v88 rollback refused: the migrator is running' using errcode = '23514';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql') then
    raise exception 'v88 rollback refused: v88 is not recorded on this database' using errcode = '23514';
  end if;
  if exists (select 1 from public.schema_migrations m where m.migration_name <> 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql'
              and m.applied_at >= (select applied_at from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql')) then
    raise exception 'v88 rollback refused: later migrations are applied' using errcode = '23514';
  end if;
  if exists (select 1 from training.participant_activity_types) or exists (select 1 from training.activity_type_requests) then
    raise exception 'v88 rollback refused: a session type was changed in the app' using errcode = '23514';
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v88 rollback refused: the body in force of training.% is not v88''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end $$;

-- v4's bodies, verbatim.
create or replace function training.merge_activity_participants(
  p_source_participant_id uuid, p_target_participant_id uuid, p_performed_by uuid, p_reason text
) returns uuid as $$
declare
  v_lo_p uuid; v_hi_p uuid;
  v_lo_a uuid; v_hi_a uuid;
  v_source record; v_target record;
  v_source_owner record; v_target_owner record;
  v_remaining int;
begin
  if p_source_participant_id = p_target_participant_id then
    raise exception 'merge_activity_participants: source and target are the same participant';
  end if;

  -- Advisory-lock BOTH participant identities, sorted — the SAME lock
  -- namespace (salt 4) reparent_activity_participant uses, so a reparent
  -- and a merge racing over the SAME participant genuinely serialize
  -- against each other, not just merge-vs-merge.
  if p_source_participant_id < p_target_participant_id then v_lo_p := p_source_participant_id; v_hi_p := p_target_participant_id;
  else v_lo_p := p_target_participant_id; v_hi_p := p_source_participant_id; end if;
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || v_lo_p::text, 4));
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || v_hi_p::text, 4));

  -- Now reliably read source/target (no other conforming function can be
  -- mid-mutation of either while we hold both advisory locks).
  select * into v_source from training.activity_participants where id = p_source_participant_id;
  select * into v_target from training.activity_participants where id = p_target_participant_id;

  -- Idempotent replay: this exact merge already applied.
  if v_source.merge_status = 'superseded' and v_source.superseded_by_participant_id = p_target_participant_id then
    return p_target_participant_id;
  end if;

  if v_source.merge_status <> 'canonical' then
    raise exception 'merge_activity_participants: source participant % is already merged into a DIFFERENT participant — resolve to its canonical id first', p_source_participant_id;
  end if;
  if v_target.merge_status <> 'canonical' then
    raise exception 'merge_activity_participants: target participant % is itself an alias — merge into its canonical id instead', p_target_participant_id;
  end if;
  if v_source.athlete_id is distinct from v_target.athlete_id then
    raise exception 'merge_activity_participants: source and target represent DIFFERENT athletes — refusing';
  end if;

  -- Lock BOTH activities ascending by id (may be the same row — locking
  -- it once is harmless/idempotent within one transaction).
  if v_source.activity_id < v_target.activity_id then v_lo_a := v_source.activity_id; v_hi_a := v_target.activity_id;
  else v_lo_a := v_target.activity_id; v_hi_a := v_source.activity_id; end if;
  perform 1 from training.activities where id = v_lo_a for update;
  if v_hi_a <> v_lo_a then
    perform 1 from training.activities where id = v_hi_a for update;
  end if;

  -- Lock BOTH participant rows, sorted by id (redundant with the advisory
  -- lock for OTHER conforming callers, but keeps FOR UPDATE/FOR SHARE
  -- readers consistent too).
  perform 1 from training.activity_participants where id = v_lo_p for update;
  perform 1 from training.activity_participants where id = v_hi_p for update;

  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_source_owner from training.activities where id = v_source.activity_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_target_owner from training.activities where id = v_target.activity_id;
  if v_source_owner.owner_scope is distinct from v_target_owner.owner_scope or v_source_owner.owner_user_id is distinct from v_target_owner.owner_user_id
     or v_source_owner.owner_club_id is distinct from v_target_owner.owner_club_id or v_source_owner.owner_team_id is distinct from v_target_owner.owner_team_id then
    raise exception 'merge_activity_participants: source and target belong to activities in DIFFERENT owner scopes — refusing';
  end if;

  perform set_config('training.allow_participant_merge_write', 'on', true);
  update training.activity_participants
    set merge_status = 'superseded', superseded_by_participant_id = p_target_participant_id, updated_at = now()
    where id = p_source_participant_id;
  perform set_config('training.allow_participant_merge_write', 'off', true);

  insert into training.activity_participant_merge_log (source_participant_id, target_participant_id, source_activity_id, target_activity_id, reason, performed_by_user_id)
    values (p_source_participant_id, p_target_participant_id, v_source.activity_id, v_target.activity_id, p_reason, p_performed_by);

  -- If the source activity now has zero remaining CANONICAL participants,
  -- it is vestigial — supersede it too, pointing at the target's activity
  -- (same write-once/no-cycle guarantees as reparent's own version of
  -- this; both activities are already locked above, sorted, so no extra
  -- lock acquisition is needed here).
  if v_source.activity_id <> v_target.activity_id then
    select count(*) into v_remaining from training.activity_participants where activity_id = v_source.activity_id and merge_status = 'canonical';
    if v_remaining = 0 then
      perform set_config('training.allow_supersede_write', 'on', true);
      update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = v_target.activity_id, updated_at = now()
        where id = v_source.activity_id and lifecycle_state <> 'superseded';
      perform set_config('training.allow_supersede_write', 'off', true);
    end if;
  end if;

  return p_target_participant_id;
end;
$$ language plpgsql;

create or replace function training.reparent_activity_participant(
  p_participant_id uuid, p_to_activity_id uuid, p_performed_by uuid, p_reason text,
  p_component_strategy varchar default 'none', p_component_mapping jsonb default null
) returns void as $$
declare
  v_from_activity_id uuid;
  v_lo uuid; v_hi uuid;
  v_from_owner_scope varchar; v_from_owner_user uuid; v_from_owner_club uuid; v_from_owner_team uuid;
  v_to_owner_scope varchar; v_to_owner_user uuid; v_to_owner_club uuid; v_to_owner_team uuid;
  v_to_lifecycle varchar;
  v_remaining int;
  v_has_component_rows boolean;
  v_rec record;
  v_seg_rec record;
  v_mapped_id uuid;
  v_clone_id uuid;
  v_target_event_linked boolean;
  v_old_event_link_id uuid;
  v_new_event_link_id uuid;
  v_progress boolean;
  v_merge_status varchar;
  -- In-memory-only working state for the 'clone' strategy — see this
  -- function's own header comment for why these replace temp tables.
  v_seg_carryover jsonb;
  v_components_to_clone uuid[];
  v_new_parents uuid[];
  v_id_map jsonb;
  v_item jsonb;
begin
  -- Step 1: advisory-lock the participant identity FIRST. This alone is
  -- what makes every read below reliable without a peek/retry loop.
  perform pg_advisory_xact_lock(hashtextextended('activity-participant:' || p_participant_id::text, 4));

  select activity_id, merge_status into v_from_activity_id, v_merge_status from training.activity_participants where id = p_participant_id;
  if v_from_activity_id is null then
    raise exception 'activity_participant % not found', p_participant_id;
  end if;
  -- Round 4 fix: a SUPERSEDED (alias) participant must never be physically
  -- moved — its whole reason for existing is to resolve, via
  -- resolve_canonical_participant_id, to its canonical target; reparenting
  -- it directly would let the canonical result wrongly link the WRONG
  -- activities together (the alias would carry the move, but every
  -- lookup following the alias chain still lands on the canonical row,
  -- which never moved). Checked before ANY write below — zero partial
  -- writes on refusal.
  if v_merge_status <> 'canonical' then
    raise exception 'reparent_activity_participant: participant % is not canonical (merge_status=%) — resolve to its canonical id first, then reparent that', p_participant_id, v_merge_status;
  end if;
  if v_from_activity_id = p_to_activity_id then
    return; -- no-op, already there
  end if;

  -- Step 2: lock BOTH activities ascending by id.
  if v_from_activity_id < p_to_activity_id then v_lo := v_from_activity_id; v_hi := p_to_activity_id;
  else v_lo := p_to_activity_id; v_hi := v_from_activity_id; end if;
  perform 1 from training.activities where id = v_lo for update;
  perform 1 from training.activities where id = v_hi for update;

  -- Step 3: lock the participant row itself.
  perform 1 from training.activity_participants where id = p_participant_id for update;

  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_from_owner_scope, v_from_owner_user, v_from_owner_club, v_from_owner_team
    from training.activities where id = v_from_activity_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id, lifecycle_state into v_to_owner_scope, v_to_owner_user, v_to_owner_club, v_to_owner_team, v_to_lifecycle
    from training.activities where id = p_to_activity_id;

  if v_to_lifecycle = 'superseded' then
    raise exception 'reparent_activity_participant: refusing to reparent into activity % — it is already superseded', p_to_activity_id;
  end if;
  if v_from_owner_scope is distinct from v_to_owner_scope or v_from_owner_user is distinct from v_to_owner_user
     or v_from_owner_club is distinct from v_to_owner_club or v_from_owner_team is distinct from v_to_owner_team then
    raise exception 'refusing to reparent activity_participant % across DIFFERENT owner scopes (from=%/%/%/% to=%/%/%/%)',
      p_participant_id, v_from_owner_scope, v_from_owner_club, v_from_owner_team, v_from_owner_user,
      v_to_owner_scope, v_to_owner_club, v_to_owner_team, v_to_owner_user;
  end if;

  -- Any of this participant's OWN confirmed metric-participant links must
  -- remain valid post-reparent — their event must ALREADY be confirmedly
  -- linked to the TARGET activity, or the whole operation is refused
  -- (never a silent orphan).
  for v_rec in
    select mep.event_id from training.activity_participant_metric_participant_links mpl
    join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
    where mpl.activity_participant_id = p_participant_id and mpl.link_status = 'confirmed'
  loop
    select exists (
      select 1 from training.activity_metric_event_links
      where activity_id = p_to_activity_id and metric_event_id = v_rec.event_id and link_status = 'confirmed'
    ) into v_target_event_linked;
    if not v_target_event_linked then
      raise exception 'reparent_activity_participant: participant % has a CONFIRMED metric-participant link whose event (%) is not linked to the target activity — relink the event first', p_participant_id, v_rec.event_id;
    end if;
  end loop;

  select exists (select 1 from training.activity_participant_components where activity_participant_id = p_participant_id) into v_has_component_rows;
  if v_has_component_rows and p_component_strategy = 'none' then
    raise exception 'reparent_activity_participant: participant % has component performance data — pass component_strategy ''clone'' or ''map''', p_participant_id;
  end if;

  -- Pre-flight for 'clone': a metric_event can only ever be confirmedly
  -- linked to ONE activity at a time (the partial unique index on
  -- metric_event_id is global, not per-activity) — so "the target must
  -- ALREADY have the event linked" can never hold in practice; the event
  -- is always still linked to the SOURCE at this point. The correct
  -- operation is for the clone to RELINK the event itself, from source to
  -- target, as PART of carrying the segment link over — but ONLY when
  -- doing so is unambiguous: the event must have NO confirmed descendant
  -- (component-segment or participant-metric) OTHER than the exact
  -- segment link(s) this clone is about to carry over. If the event is
  -- shared with anything else, the whole reparent is refused — never a
  -- silent, semantically-wrong event relink.
  if v_has_component_rows and p_component_strategy = 'clone' then
    for v_seg_rec in
      select distinct mes.event_id
      from training.activity_participant_components pc
      join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
      join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
      where pc.activity_participant_id = p_participant_id
    loop
      declare
        v_own_segment_count int;
        v_total_segment_descendants int;
        v_total_participant_descendants int;
      begin
        select count(*) into v_own_segment_count
          from training.activity_participant_components pc
          join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
          join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
          where pc.activity_participant_id = p_participant_id and mes.event_id = v_seg_rec.event_id;
        select count(*) into v_total_segment_descendants
          from training.activity_component_metric_segment_links csl
          join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
          where mes.event_id = v_seg_rec.event_id and csl.link_status = 'confirmed';
        select count(*) into v_total_participant_descendants
          from training.activity_participant_metric_participant_links mpl
          join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
          where mep.event_id = v_seg_rec.event_id and mpl.link_status = 'confirmed';
        if v_total_segment_descendants <> v_own_segment_count or v_total_participant_descendants <> 0 then
          raise exception 'reparent_activity_participant: metric event % has OTHER confirmed data depending on it besides this participant''s own component(s) — refusing to relink it automatically; use component_strategy ''map'' and relink manually', v_seg_rec.event_id;
        end if;
      end;
    end loop;
  end if;

  -- The participant row itself moves FIRST — activity_participant_components'
  -- own composite FK to (activity_participants.id, activity_id) requires a
  -- matching participant row at the TARGET activity to already exist before
  -- any junction row can be repointed at it below.
  perform set_config('training.allow_reparent_write', 'on', true);
  update training.activity_participants set activity_id = p_to_activity_id, updated_at = now() where id = p_participant_id;
  perform set_config('training.allow_reparent_write', 'off', true);

  if v_has_component_rows then
    perform set_config('training.allow_component_repoint', 'on', true);
    if p_component_strategy = 'clone' then
      v_seg_carryover := '[]'::jsonb;
      select coalesce(array_agg(distinct activity_component_id), '{}') into v_components_to_clone
        from training.activity_participant_components where activity_participant_id = p_participant_id;
      v_id_map := '{}'::jsonb;

      for v_rec in
        select pc.activity_component_id as old_component_id, csl.id as old_link_id, csl.metric_event_segment_id as segment_id
        from training.activity_participant_components pc
        join training.activity_component_metric_segment_links csl on csl.activity_component_id = pc.activity_component_id and csl.link_status = 'confirmed'
        where pc.activity_participant_id = p_participant_id
      loop
        v_seg_carryover := v_seg_carryover || jsonb_build_object('old_component_id', v_rec.old_component_id, 'old_link_id', v_rec.old_link_id, 'segment_id', v_rec.segment_id);
      end loop;

      -- Supersede EXACTLY the captured links (bulk, by id — never a
      -- fragile status-based re-query) — this is what unblocks the event
      -- relink below (the "no orphan descendants" trigger fires
      -- immediately, not deferred, and sees zero confirmed descendants
      -- once these are gone).
      if jsonb_array_length(v_seg_carryover) > 0 then
        update training.activity_component_metric_segment_links set link_status = 'superseded'
          where id in (select (elem ->> 'old_link_id')::uuid from jsonb_array_elements(v_seg_carryover) elem);
      end if;

      for v_seg_rec in
        select distinct mes.event_id
        from jsonb_array_elements(v_seg_carryover) elem
        join training_load.metric_event_segments mes on mes.id = (elem ->> 'segment_id')::uuid
      loop
        update training.activity_metric_event_links set link_status = 'superseded'
          where activity_id = v_from_activity_id and metric_event_id = v_seg_rec.event_id and link_status = 'confirmed'
          returning id into v_old_event_link_id;
        insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, supersedes_link_id, reason, created_by_user_id)
          values (p_to_activity_id, v_seg_rec.event_id, 'automatic', 'confirmed', p_performed_by, now(), v_old_event_link_id, 'relinked as part of reparent clone strategy', p_performed_by)
          returning id into v_new_event_link_id;
        update training.activity_metric_event_links set superseded_by_link_id = v_new_event_link_id where id = v_old_event_link_id;
      end loop;

      -- Full component set to clone: every LEAF the participant directly
      -- performed, plus every ancestor of each, walked to the root — a
      -- plain PL/pgSQL array used as a set (dedup via NOT ... = ANY(...)).
      loop
        select array_agg(distinct ac.parent_component_id) into v_new_parents
          from training.activity_components ac
          where ac.id = any(v_components_to_clone)
            and ac.parent_component_id is not null
            and not (ac.parent_component_id = any(v_components_to_clone));
        exit when v_new_parents is null;
        v_components_to_clone := v_components_to_clone || v_new_parents;
      end loop;

      -- Clone ancestor-first: a component is processed only once its own
      -- parent is already in the map (or has none) — a real topological
      -- pass, not a flat one, so parent_component_id on each clone points
      -- at the CORRESPONDING new clone, never NULL.
      loop
        v_progress := false;
        for v_rec in
          select ac.id, ac.parent_component_id, ac.component_type_key, ac.exercise_id, ac.name_snapshot, ac.image_url_snapshot, ac.instructions_snapshot,
                 ac.planned_prescription_snapshot, ac.planned_prescription_snapshot_version, ac.sort_order, ac.planned_duration_seconds, ac.origin
          from training.activity_components ac
          where ac.id = any(v_components_to_clone)
            and not (v_id_map ? ac.id::text)
            and (ac.parent_component_id is null or v_id_map ? ac.parent_component_id::text)
        loop
          insert into training.activity_components (activity_id, parent_component_id, component_type_key, exercise_id, name_snapshot, image_url_snapshot, instructions_snapshot, planned_prescription_snapshot, planned_prescription_snapshot_version, sort_order, planned_duration_seconds, origin)
            values (
              p_to_activity_id,
              case when v_rec.parent_component_id is null then null else (v_id_map ->> v_rec.parent_component_id::text)::uuid end,
              v_rec.component_type_key, v_rec.exercise_id, v_rec.name_snapshot, v_rec.image_url_snapshot, v_rec.instructions_snapshot,
              v_rec.planned_prescription_snapshot, v_rec.planned_prescription_snapshot_version, v_rec.sort_order, v_rec.planned_duration_seconds, v_rec.origin
            )
            returning id into v_clone_id;
          v_id_map := v_id_map || jsonb_build_object(v_rec.id::text, v_clone_id::text);
          v_progress := true;
        end loop;
        exit when not v_progress;
      end loop;

      -- Repoint the participant's own junction rows at the LEAF clones.
      for v_rec in select id, activity_component_id from training.activity_participant_components where activity_participant_id = p_participant_id loop
        update training.activity_participant_components
          set activity_component_id = (v_id_map ->> v_rec.activity_component_id::text)::uuid, activity_id = p_to_activity_id
          where id = v_rec.id;
      end loop;

      -- New confirmed segment links, driven by the EXACT captured tuples
      -- (never a re-derived query) — each pointing at its leaf's own clone.
      for v_item in select * from jsonb_array_elements(v_seg_carryover) loop
        insert into training.activity_component_metric_segment_links (activity_component_id, metric_event_segment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, supersedes_link_id, reason, created_by_user_id)
          values ((v_id_map ->> (v_item ->> 'old_component_id'))::uuid, (v_item ->> 'segment_id')::uuid, 'automatic', 'confirmed', p_performed_by, now(), (v_item ->> 'old_link_id')::uuid, 'carried over by reparent clone strategy', p_performed_by)
          returning id into v_mapped_id;
        update training.activity_component_metric_segment_links set superseded_by_link_id = v_mapped_id where id = (v_item ->> 'old_link_id')::uuid;
      end loop;
    elsif p_component_strategy = 'map' then
      for v_rec in select id, activity_component_id from training.activity_participant_components where activity_participant_id = p_participant_id loop
        -- Round 4 fix: the service layer (trainingActivityMaterialize.js's
        -- reparentActivityParticipant) now validates component_mapping's
        -- shape (plain object, every key/value a real UUID string) BEFORE
        -- this function is ever called — this cast is a second, defensive
        -- line of DB-level protection for any future/raw caller that
        -- bypasses the service layer, so a malformed value here raises a
        -- clear, named exception instead of a bare, confusing Postgres
        -- 22P02 (invalid_text_representation).
        begin
          v_mapped_id := (p_component_mapping ->> v_rec.activity_component_id::text)::uuid;
        exception when invalid_text_representation then
          raise exception 'reparent_activity_participant: component_mapping entry for source component % is not a valid UUID', v_rec.activity_component_id;
        end;
        if v_mapped_id is null then
          raise exception 'reparent_activity_participant: component_mapping has no entry for source component %', v_rec.activity_component_id;
        end if;
        perform 1 from training.activity_components where id = v_mapped_id and activity_id = p_to_activity_id;
        if not found then
          raise exception 'reparent_activity_participant: mapped component % does not belong to target activity %', v_mapped_id, p_to_activity_id;
        end if;
        update training.activity_participant_components set activity_component_id = v_mapped_id, activity_id = p_to_activity_id where id = v_rec.id;
      end loop;
    else
      perform set_config('training.allow_component_repoint', 'off', true);
      raise exception 'reparent_activity_participant: unknown component_strategy %', p_component_strategy;
    end if;
    perform set_config('training.allow_component_repoint', 'off', true);
  end if;

  insert into training.activity_participant_reparent_log (activity_participant_id, from_activity_id, to_activity_id, component_strategy, reason, performed_by_user_id)
    values (p_participant_id, v_from_activity_id, p_to_activity_id, p_component_strategy, p_reason, p_performed_by);

  select count(*) into v_remaining from training.activity_participants where activity_id = v_from_activity_id and merge_status = 'canonical';
  if v_remaining = 0 then
    perform set_config('training.allow_supersede_write', 'on', true);
    update training.activities set lifecycle_state = 'superseded', superseded_by_activity_id = p_to_activity_id, updated_at = now()
      where id = v_from_activity_id;
    perform set_config('training.allow_supersede_write', 'off', true);
  end if;
end;
$$ language plpgsql;

do $$
declare
  expected constant text[][] := array[
    ['merge_activity_participants', 'c3c16b64fe37f1511e42a7db50d68063'],
    ['reparent_activity_participant', 'be3b50ce3e52750fb80e09e31b9bc4e8']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v88 rollback refused: the restored body of training.% is not v4''s', expected[i][1] using errcode = '23514';
    end if;
  end loop;
end $$;

drop trigger activity_field_correction_log_no_truncate on training.activity_field_correction_log;
drop trigger activity_field_correction_log_no_delete on training.activity_field_correction_log;
drop function training.activity_field_correction_log_no_delete();
alter table training.activity_field_correction_log
  drop constraint activity_field_correction_log_activity_id_fkey,
  add constraint activity_field_correction_log_activity_id_fkey
    foreign key (activity_id) references training.activities(id);

drop trigger activity_type_requests_no_truncate on training.activity_type_requests;
drop trigger activity_type_requests_before_write on training.activity_type_requests;
drop table training.activity_type_requests;
drop function training.activity_type_requests_before_write();

drop function training.effective_activity_type(uuid);
drop trigger participant_activity_types_no_truncate on training.participant_activity_types;
drop trigger participant_activity_types_before_write on training.participant_activity_types;
drop table training.participant_activity_types;
drop function training.participant_activity_types_no_truncate();
drop function training.participant_activity_types_before_write();
drop function training.session_type_team_decider(uuid, uuid);

delete from public.schema_migrations where migration_name = 'migrations_v2/202611221300_training_load_v88_participant_session_types.sql';
commit;
