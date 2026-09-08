-- ============================================================
-- OPTIMOVE — Training Activity Identity Core v4: participant reparent/
-- merge, shared-identity group materialization, and the canonical read
-- contract.
--
-- These are the only 4 multi-step "verb" functions in the Training
-- Activity model — everything else (single-participant fuzzy-match
-- materialization, candidate scoring, accepting a match suggestion) is
-- plain Node-orchestrated service code (see backend/src/
-- trainingActivityMaterialize.js), following the same convention already
-- used for Training Load metrics corrections. These 4 stay as real
-- functions because each one needs an atomic, DB-enforced "exactly one
-- outcome for this shared identity under concurrency" guarantee — a
-- shared external occurrence or metric event must resolve to exactly one
-- activity even under parallel concurrent calls, and reparent/merge must
-- serialize on the same participant-keyed advisory lock regardless of
-- which one a concurrent caller used — which is materially harder to get
-- right split across multiple round trips from Node. None of these
-- functions are exposed to any HTTP route directly; every caller goes
-- through the service layer, which resolves and checks workspace
-- authorization first.
-- ============================================================

-- ---------------------------------------------------------------------
-- reparent_activity_participant(): moves a participant row to a DIFFERENT
-- activity (e.g. merging two provisionally-separate solo activities into
-- one team activity). Never rewrites metric facts; only moves the
-- activity_participants row itself and appends an audit entry.
--
-- Concurrency: takes a PARTICIPANT-KEYED ADVISORY LOCK FIRST, before any
-- read at all. Every function in this file that can mutate
-- activity_participants.activity_id or .merge_status/
-- .superseded_by_participant_id (this one and merge_activity_participants
-- below) takes this SAME advisory lock, on the SAME participant id(s),
-- BEFORE doing anything else — so once held, a plain unlocked SELECT of
-- that participant's current state is provably stable (no other
-- conforming function can be mid-mutation of it). THEN, and only then,
-- activities are locked ascending by id, THEN the participant row itself,
-- THEN components, THEN links — the one global lock order every function
-- in this file follows.
--
-- Refuses to reparent INTO an already-superseded target (cycle/dead-end
-- prevention — combined with superseded_by_activity_id being write-once,
-- this makes an A->B->A supersede cycle structurally impossible).
--
-- A participant's own CONFIRMED metric-participant links depend on their
-- metric_event being confirmedly linked to the participant's OWN
-- activity — refuses the reparent outright if the target activity
-- doesn't (yet) have the same event confirmedly linked: "complete valid
-- relink, or refuse with a clear reason," never a silent orphan.
--
-- component_strategy: if the moved participant has ANY
-- activity_participant_components rows pointing at the SOURCE activity's
-- own components, the caller must pick:
--   'none'  (default) — refuse with an exception if such rows exist.
--   'clone' — clone each referenced source component (and, if it carries
--             one, its own CONFIRMED metric-segment link — see below)
--             under the TARGET activity, and repoint the participant's
--             performance rows at the clones.
--   'map'   — p_component_mapping is a jsonb object of
--             { "<old_component_id>": "<existing_target_component_id>" };
--             every referenced old component must have an entry, and the
--             mapped id must already belong to the target activity.
-- 'clone' additionally handles any cloned component that itself carries a
-- CONFIRMED activity_component_metric_segment_links row: since a
-- metric_event can only ever be confirmedly linked to ONE activity at a
-- time (the partial unique index is global, not per-activity), "the
-- target must already have it" can never hold — instead 'clone' RELINKS
-- the event itself from source to target, but ONLY when that event has NO
-- other confirmed descendant besides the segment link(s) being carried
-- over; otherwise (the event is shared with other data) the whole
-- reparent is refused, never a silent/wrong relink. The clone path uses
-- purely in-memory PL/pgSQL state (a jsonb array/object, a uuid[] set) —
-- deliberately never a session-scoped temp table, since a temp table
-- resolves into the CALLING SESSION's own pg_temp schema regardless of
-- who owns the function, which would let a caller pre-create
-- identically-named temp objects and have this function silently operate
-- on them instead of its own data.
-- ---------------------------------------------------------------------
create table training.activity_participant_reparent_log (
  id uuid primary key default gen_random_uuid(),
  activity_participant_id uuid not null references training.activity_participants(id),
  from_activity_id uuid not null references training.activities(id),
  to_activity_id uuid not null references training.activities(id),
  component_strategy varchar(20),
  reason text,
  performed_by_user_id uuid references public.users(id),
  performed_at timestamptz not null default now()
);

create function training.reparent_activity_participant(
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

-- ---------------------------------------------------------------------
-- merge_activity_participants() — the audited, transactional PARTICIPANT
-- MERGE that reparent_activity_participant() cannot perform: when a
-- suggestion's candidate participant is the SAME athlete, moving the new
-- participant INTO the candidate's activity via reparent would hit
-- UNIQUE(activity_id, athlete_id) (the candidate is already that athlete
-- there). Instead, this declares one participant an ALIAS of the other —
-- neither row's activity_id moves; resolve_canonical_participant_id() (v1)
-- is how future lookups follow the alias.
--
-- Idempotent: calling merge(A,B) again after it already applied is a
-- no-op returning B. Opposite/cyclic merges are rejected structurally —
-- after A is merged into B, A.merge_status='superseded', so merge(B,A)
-- fails the "target must be canonical" check below (a "target" that is
-- itself an alias can never be merged into).
-- ---------------------------------------------------------------------
create table training.activity_participant_merge_log (
  id uuid primary key default gen_random_uuid(),
  source_participant_id uuid not null references training.activity_participants(id),
  target_participant_id uuid not null references training.activity_participants(id),
  source_activity_id uuid not null references training.activities(id),
  target_activity_id uuid not null references training.activities(id),
  reason text,
  performed_by_user_id uuid references public.users(id),
  performed_at timestamptz not null default now()
);

create function training.merge_activity_participants(
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

-- ---------------------------------------------------------------------
-- Group materialization — a reliable SHARED identity (an external
-- occurrence, or a metric_event) materializes to exactly ONE activity
-- automatically, no human confirmation required, even under parallel
-- concurrent calls. Both functions take an advisory transaction lock
-- keyed on the shared identity FIRST, so two concurrent callers for the
-- SAME occurrence/event genuinely serialize on "does a confirmed group
-- link already exist" rather than racing to both create one.
--
-- Owner scope is DERIVED from the source object's OWN canonical ownership
-- (the schedule that owns the occurrence / the event itself) — the
-- caller never supplies it. An unknown/nonexistent source object is
-- refused BEFORE any INSERT.
--
-- participation_status is 'planned', never 'participated' — an external
-- assignment or a metric-event participant row only proves the athlete
-- was TARGETED, not that they actually took part; the real status flips
-- forward once real RPE/GPS/manual confirmation arrives, a caller-layer
-- concern outside these two functions.
--
-- Per-assignment/per-participant link INSERTs never use a blanket
-- `ON CONFLICT DO NOTHING` — that would silently swallow a genuine
-- conflict (e.g. this participant already has some OTHER confirmed
-- session/metric link) as if it were just a harmless idempotent re-run.
-- Each insert is instead guarded by an explicit "does THIS exact link
-- already exist" check; anything else still raises a real, visible error
-- (surfaced via the partial unique indexes in v2).
-- ---------------------------------------------------------------------
create function training.materialize_activity_group_from_external_occurrence(
  p_occurrence_id uuid, p_activity_type_key text, p_name text, p_performed_by uuid
) returns uuid as $$
declare
  v_activity_id uuid;
  v_scheduled_date date;
  v_owner_scope varchar; v_owner_user_id uuid; v_owner_club_id uuid; v_owner_team_id uuid; v_timezone varchar;
  v_assignment_count int;
  v_rec record;
  v_participant_id uuid;
  v_already_linked boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('activity-group-occurrence:' || p_occurrence_id::text, 2));

  select eo.scheduled_date, es.owner_scope, es.owner_user_id, es.owner_club_id, es.owner_team_id, es.timezone
    into v_scheduled_date, v_owner_scope, v_owner_user_id, v_owner_club_id, v_owner_team_id, v_timezone
    from training_load.external_schedule_occurrences eo
    join training_load.external_schedules es on es.id = eo.schedule_id
    where eo.id = p_occurrence_id;
  if v_scheduled_date is null then
    raise exception 'materialize_activity_group_from_external_occurrence: unknown external occurrence %', p_occurrence_id;
  end if;

  select count(*) into v_assignment_count from training_load.external_assignments where occurrence_id = p_occurrence_id;
  if v_assignment_count = 0 then
    raise exception 'materialize_activity_group_from_external_occurrence: occurrence % has zero assignments yet — refusing to materialize an activity with no real target signal', p_occurrence_id;
  end if;

  -- Resolve through the canonical chain — a late assignment must land on
  -- the current canonical survivor, even if this occurrence's own
  -- confirmed link points at an activity later superseded via an
  -- unrelated participant-level merge.
  select training.resolve_canonical_activity_id(activity_id) into v_activity_id
    from training.activity_external_occurrence_links
    where external_occurrence_id = p_occurrence_id and link_status = 'confirmed';

  if v_activity_id is null then
    insert into training.activities (activity_type_key, name, occurred_local_date, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
      values (p_activity_type_key, p_name, v_scheduled_date, v_timezone, v_owner_scope, v_owner_user_id, v_owner_club_id, v_owner_team_id, 'external_assignment', 'confirmed', p_performed_by)
      returning id into v_activity_id;
    insert into training.activity_external_occurrence_links (activity_id, external_occurrence_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
      values (v_activity_id, p_occurrence_id, 'automatic', 'confirmed', p_performed_by, now(), p_performed_by);
  end if;

  for v_rec in select id as assignment_id, athlete_id, timezone, local_scheduled_date from training_load.external_assignments where occurrence_id = p_occurrence_id loop
    insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
      values (v_activity_id, v_rec.athlete_id, v_rec.local_scheduled_date, v_rec.timezone, 'planned')
      on conflict (activity_id, athlete_id) do nothing
      returning id into v_participant_id;
    if v_participant_id is null then
      select id into v_participant_id from training.activity_participants where activity_id = v_activity_id and athlete_id = v_rec.athlete_id;
    end if;
    -- Checked by external_assignment_id ALONE (its own partial unique
    -- index is global, not per-participant) — an earlier confirmed claim
    -- may already exist on a DIFFERENT (now-alias) participant row, e.g.
    -- after a merge moved this athlete's canonical identity elsewhere;
    -- that earlier claim is still correctly reachable via canonical/alias
    -- resolution, so a fresh insert here must be skipped, never
    -- attempted (which would just hit the unique index).
    select exists (
      select 1 from training.activity_participant_session_links
      where external_assignment_id = v_rec.assignment_id and link_status = 'confirmed'
    ) into v_already_linked;
    if not v_already_linked then
      insert into training.activity_participant_session_links (activity_participant_id, athlete_id, external_assignment_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
        values (v_participant_id, v_rec.athlete_id, v_rec.assignment_id, 'automatic', 'confirmed', p_performed_by, now(), p_performed_by);
    end if;
    v_participant_id := null;
  end loop;

  return v_activity_id;
end;
$$ language plpgsql;

create function training.materialize_activity_group_from_metric_event(
  p_event_id uuid, p_activity_type_key text, p_name text, p_performed_by uuid
) returns uuid as $$
declare
  v_activity_id uuid;
  v_occurred_date date;
  v_occurred_instant timestamptz;
  v_scope_level varchar;
  v_owner_scope varchar; v_owner_user_id uuid; v_owner_club_id uuid; v_owner_team_id uuid;
  v_timezone text;
  v_participant_count int;
  v_rec record;
  v_participant_id uuid;
  v_already_linked boolean;
  v_participant_local_date date;
begin
  perform pg_advisory_xact_lock(hashtextextended('activity-group-event:' || p_event_id::text, 3));

  select occurred_date, occurred_instant, scope_level, owner_scope, owner_user_id, owner_club_id, owner_team_id, event_timezone_snapshot
    into v_occurred_date, v_occurred_instant, v_scope_level, v_owner_scope, v_owner_user_id, v_owner_club_id, v_owner_team_id, v_timezone
    from training_load.metric_events where id = p_event_id;
  if v_occurred_date is null then
    raise exception 'materialize_activity_group_from_metric_event: unknown metric event %', p_event_id;
  end if;

  -- A metric_event with scope_level='day' is a DAY-LEVEL metric (sleep,
  -- recovery, resting HR, ...) — never a training. Only a 'session' event
  -- may become a training.activities row.
  if v_scope_level <> 'session' then
    raise exception 'materialize_activity_group_from_metric_event: event % has scope_level=''%'' — only session-level events may be materialized as a training activity', p_event_id, v_scope_level;
  end if;

  select count(*) into v_participant_count from training_load.metric_event_participants where event_id = p_event_id;
  if v_participant_count = 0 then
    raise exception 'materialize_activity_group_from_metric_event: event % has zero participants yet — refusing to materialize an activity with no real target signal', p_event_id;
  end if;

  -- metric_events carries no group-level timezone of its own beyond
  -- event_timezone_snapshot (v3) — that column is the ONLY source; a
  -- participant's personal athlete_timezone_snapshot is never used as a
  -- stand-in for the group event's own place/time context. If it is
  -- still unresolved, this function REFUSES to materialize at all (no
  -- silent UTC fallback, no silent first-participant fallback) rather
  -- than guessing.
  if v_timezone is null then
    raise exception 'materialize_activity_group_from_metric_event: event % has no event_timezone_snapshot set — refusing to guess (never falls back to a participant''s own timezone or a silent UTC default); set it explicitly first', p_event_id;
  end if;

  -- Resolve through the canonical chain — if this event's own confirmed
  -- group link points at an activity that was LATER superseded via an
  -- unrelated participant-level merge, a late participant must still
  -- land on the current canonical survivor, never on the dead row (the
  -- link itself is never repointed — only resolved at use-time).
  select training.resolve_canonical_activity_id(activity_id) into v_activity_id
    from training.activity_metric_event_links
    where metric_event_id = p_event_id and link_status = 'confirmed';

  -- occurred_instant is the SESSION's own START instant for a
  -- 'session'-scope event — carried straight onto activities.started_at.
  -- There is no real ended_instant/duration column on metric_events (a
  -- future provider-neutral addition, not introduced here) so
  -- activities.ended_at stays null via this path; a real implementation
  -- adding such a column should propagate it here the same way.
  if v_activity_id is null then
    insert into training.activities (activity_type_key, name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_user_id, owner_club_id, owner_team_id, origin, lifecycle_state, created_by_user_id)
      values (p_activity_type_key, p_name, v_occurred_date, v_occurred_instant, v_timezone, v_owner_scope, v_owner_user_id, v_owner_club_id, v_owner_team_id, 'source_import', 'confirmed', p_performed_by)
      returning id into v_activity_id;
    insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
      values (v_activity_id, p_event_id, 'automatic', 'confirmed', p_performed_by, now(), p_performed_by);
  end if;

  for v_rec in select id as metric_participant_id, athlete_id, athlete_timezone_snapshot from training_load.metric_event_participants where event_id = p_event_id loop
    -- Each PARTICIPANT's own local_date is computed from the real shared
    -- instant, converted into THEIR OWN athlete_timezone_snapshot — never
    -- the event-local date uniformly applied to everyone. Only when
    -- there is no instant at all (a pure date-only event) does the
    -- event-local date stand in, as an explicitly documented fallback —
    -- never a silent substitute for a real conversion. This is what lets
    -- an athlete on the other side of the world genuinely land on the
    -- FOLLOWING calendar day while remaining part of the exact same
    -- activity.
    if v_occurred_instant is not null then
      v_participant_local_date := (v_occurred_instant at time zone v_rec.athlete_timezone_snapshot)::date;
    else
      v_participant_local_date := v_occurred_date;
    end if;
    insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
      values (v_activity_id, v_rec.athlete_id, v_participant_local_date, v_rec.athlete_timezone_snapshot, 'planned')
      on conflict (activity_id, athlete_id) do nothing
      returning id into v_participant_id;
    if v_participant_id is null then
      select id into v_participant_id from training.activity_participants where activity_id = v_activity_id and athlete_id = v_rec.athlete_id;
    end if;
    -- Checked by metric_event_participant_id ALONE, same reasoning as the
    -- external-occurrence variant above.
    select exists (
      select 1 from training.activity_participant_metric_participant_links
      where metric_event_participant_id = v_rec.metric_participant_id and link_status = 'confirmed'
    ) into v_already_linked;
    if not v_already_linked then
      insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
        values (v_participant_id, v_rec.metric_participant_id, 'automatic', 'confirmed', p_performed_by, now(), p_performed_by);
    end if;
    v_participant_id := null;
  end loop;

  return v_activity_id;
end;
$$ language plpgsql;

-- =====================================================================
-- The canonical read contract. Given ANY activity id (canonical or a
-- superseded alias of it), returns every fact reachable through it: for
-- the canonical activity AND every activity superseded into it
-- (activity_alias_ids), every participant resolved to its own canonical
-- participant (resolve_canonical_participant_id) AND every alias of THAT
-- canonical participant (participant_alias_ids) — confirmed session
-- links / RPE, confirmed metric-participant links / occasions / values,
-- component performance, and activity-level confirmed metric-event links
-- and component-segment links. Each physical row is visited exactly once
-- (no duplication); everything is driven by a handful of single
-- recursive CTEs, never N+1 per-row recursion, so this stays efficient
-- for a periodic/results-style query.
-- =====================================================================
create function training.canonical_activity_results(p_activity_id uuid)
returns table (
  canonical_activity_id uuid,
  canonical_participant_id uuid,
  athlete_id uuid,
  fact_kind text,
  detail jsonb
) as $$
with resolved as (
  select training.resolve_canonical_activity_id(p_activity_id) as canonical_activity_id
),
alias_activities as (
  select r.canonical_activity_id, aa.activity_id
  from resolved r
  cross join lateral training.activity_alias_ids(r.canonical_activity_id) aa
),
raw_participants as (
  select aa.canonical_activity_id, ap.id as participant_id
  from alias_activities aa
  join training.activity_participants ap on ap.activity_id = aa.activity_id
),
canonical_participants as (
  select distinct rp.canonical_activity_id, training.resolve_canonical_participant_id(rp.participant_id) as canonical_participant_id
  from raw_participants rp
),
alias_participants as (
  select cp.canonical_activity_id, cp.canonical_participant_id, pa.participant_id as alias_participant_id, ap2.athlete_id
  from canonical_participants cp
  cross join lateral training.participant_alias_ids(cp.canonical_participant_id) pa
  join training.activity_participants ap2 on ap2.id = pa.participant_id
)
select ap.canonical_activity_id, ap.canonical_participant_id, ap.athlete_id, 'rpe'::text,
  jsonb_build_object('sessionFeedbackId', sf.id, 'rpe', sf.rpe, 'durationMinutes', sf.duration_minutes, 'srpe', sf.srpe, 'source', sf.source, 'aliasParticipantId', ap.alias_participant_id)
from alias_participants ap
join training.activity_participant_session_links l on l.activity_participant_id = ap.alias_participant_id and l.link_status = 'confirmed'
join training_load.session_feedback sf on sf.athlete_id = ap.athlete_id
  and ((l.logical_session_id is not null and sf.logical_session_id = l.logical_session_id) or (l.external_assignment_id is not null and sf.external_assignment_id = l.external_assignment_id))

union all

select ap.canonical_activity_id, ap.canonical_participant_id, ap.athlete_id, 'metric_value'::text,
  jsonb_build_object(
    'occasionId', o.id, 'sourceIdentityId', o.source_identity_id, 'entryMethod', o.entry_method,
    'metricDefinitionId', v.metric_definition_id, 'metricDefinitionVersionId', v.metric_definition_version_id,
    'valueNumeric', v.value_numeric, 'valueBoolean', v.value_boolean, 'valueText', v.value_text, 'unitAtCapture', v.unit_at_capture,
    'aggregationRole', v.aggregation_role, 'coverage', v.coverage, 'isDerived', v.is_derived, 'computedByRef', v.computed_by_ref,
    'segmentId', o.segment_id, 'aliasParticipantId', ap.alias_participant_id
  )
from alias_participants ap
join training.activity_participant_metric_participant_links mpl on mpl.activity_participant_id = ap.alias_participant_id and mpl.link_status = 'confirmed'
join training_load.metric_measurement_occasions o on o.event_participant_id = mpl.metric_event_participant_id
join training_load.metric_values v on v.occasion_id = o.id
-- The SAME "effective" contract Metrics Core itself uses: never a
-- superseded revision, never one flagged needs_review/
-- stale_resend_ignored/no_reliable_identifier, and — for an imported fact
-- — only when it is genuinely its own identity's CURRENT occasion.
where o.superseded_by_occasion_id is null
  and o.import_conflict_status is null
  and (o.source_identity_id is null or exists (
    select 1 from training_load.metric_source_identities si where si.id = o.source_identity_id and si.current_occasion_id = o.id
  ))

union all

select ap.canonical_activity_id, ap.canonical_participant_id, ap.athlete_id, 'component_performance'::text,
  jsonb_build_object(
    'componentId', c.id, 'name', c.name_snapshot, 'componentTypeKey', c.component_type_key, 'status', pc.status,
    'actualDurationSeconds', pc.actual_duration_seconds, 'note', pc.note, 'actualPrescriptionSnapshot', pc.actual_prescription_snapshot,
    'activityParticipantComponentId', pc.id, 'aliasParticipantId', ap.alias_participant_id
  )
from alias_participants ap
join training.activity_participant_components pc on pc.activity_participant_id = ap.alias_participant_id
join training.activity_components c on c.id = pc.activity_component_id

union all

select aa.canonical_activity_id, null::uuid, null::uuid, 'metric_event_link'::text,
  jsonb_build_object('metricEventId', mel.metric_event_id, 'linkStatus', mel.link_status, 'fromActivityId', mel.activity_id)
from alias_activities aa
join training.activity_metric_event_links mel on mel.activity_id = aa.activity_id and mel.link_status = 'confirmed'

union all

select aa.canonical_activity_id, null::uuid, null::uuid, 'component_metric_segment_link'::text,
  jsonb_build_object('componentId', csl.activity_component_id, 'metricEventSegmentId', csl.metric_event_segment_id, 'linkStatus', csl.link_status)
from alias_activities aa
join training.activity_components c on c.activity_id = aa.activity_id
join training.activity_component_metric_segment_links csl on csl.activity_component_id = c.id and csl.link_status = 'confirmed';
$$ language sql stable;
