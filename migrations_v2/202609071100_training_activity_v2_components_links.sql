-- ============================================================
-- OPTIMOVE — Training Activity Identity Core v2: components and typed
-- link tables.
--
-- training.activity_components is the per-activity hierarchy snapshot
-- (block -> subblock -> exercise, etc.); training.activity_participant_
-- components records what a given athlete actually performed of it. The
-- 5 typed link tables below connect a training.activities/
-- activity_participants row to its real-world sources (a planned Weekly
-- session, an external RPE assignment, a Metrics Core event/participant/
-- segment) — deliberately 5 separate typed tables, never one polymorphic
-- (entity_type, entity_id) table, so each keeps its own real foreign key
-- and its own historical, relinkable, audited chain. A relink never
-- updates an existing link row in place: it inserts a new row and marks
-- the old one 'superseded', with both a forward (superseded_by_link_id)
-- and backward (supersedes_link_id) pointer kept reciprocally consistent
-- by a shared deferred constraint trigger.
-- ============================================================

create table training.activity_components (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  parent_component_id uuid,
  component_type_key text not null references training.component_types(key),
  exercise_id uuid references library.exercises(id),
  name_snapshot text not null,
  image_url_snapshot text,
  instructions_snapshot text,
  planned_prescription_snapshot jsonb,
  planned_prescription_snapshot_version smallint not null default 1,
  sort_order numeric not null default 1,
  planned_duration_seconds numeric,
  actual_duration_seconds numeric,
  origin varchar(20) not null check (origin in ('plan_snapshot', 'api_source', 'manual')),
  created_at timestamptz not null default now(),
  unique (id, activity_id),
  check (parent_component_id is null or parent_component_id <> id),
  constraint activity_components_parent_same_activity_fk
    foreign key (parent_component_id, activity_id) references training.activity_components (id, activity_id)
);
create index activity_components_activity_idx on training.activity_components (activity_id, sort_order);
create index activity_components_parent_idx on training.activity_components (parent_component_id);

-- No INDIRECT cycle in the hierarchy — the composite FK above only
-- guarantees "same activity", not acyclicity. Bounded ancestor walk;
-- practical hierarchies are a handful of levels deep, 100 is a generous
-- safety margin that still catches a genuine cycle deterministically.
create function training.check_component_parent_no_cycle() returns trigger as $$
declare
  v_current uuid := new.parent_component_id;
  v_hops int := 0;
begin
  while v_current is not null loop
    if v_current = new.id then
      raise exception 'training.activity_components (id=%): parent_component_id introduces a cycle', new.id;
    end if;
    v_hops := v_hops + 1;
    if v_hops > 100 then
      raise exception 'training.activity_components (id=%): component hierarchy exceeds 100 levels — refusing, likely a cycle', new.id;
    end if;
    select parent_component_id into v_current from training.activity_components where id = v_current;
  end loop;
  return new;
end;
$$ language plpgsql;
create trigger activity_components_check_no_cycle
  before insert or update of parent_component_id on training.activity_components
  for each row execute function training.check_component_parent_no_cycle();

-- Identity fields (everything that defines WHAT this component snapshot
-- IS) become immutable once the component is "used" — has recorded
-- participant performance, or is confirmedly linked to a metric segment.
-- sort_order and the duration fields stay mutable always (reordering/
-- actual-timing capture are not identity). activity_id and origin are
-- unconditionally immutable — a reparent (v4) always clones a NEW
-- component row under the target activity, it never repoints an existing
-- one.
create function training.protect_component_identity_once_used() returns trigger as $$
declare
  v_locked boolean;
begin
  if new.activity_id is distinct from old.activity_id then
    raise exception 'training.activity_components (id=%): activity_id is unconditionally immutable — a reparent clones a NEW component row, it never repoints an existing one', old.id;
  end if;
  if new.origin is distinct from old.origin then
    raise exception 'training.activity_components (id=%): origin is unconditionally immutable', old.id;
  end if;

  if new.parent_component_id is not distinct from old.parent_component_id
     and new.component_type_key is not distinct from old.component_type_key
     and new.exercise_id is not distinct from old.exercise_id
     and new.name_snapshot is not distinct from old.name_snapshot
     and new.image_url_snapshot is not distinct from old.image_url_snapshot
     and new.instructions_snapshot is not distinct from old.instructions_snapshot
     and new.planned_prescription_snapshot is not distinct from old.planned_prescription_snapshot
     and new.planned_prescription_snapshot_version is not distinct from old.planned_prescription_snapshot_version
     and new.sort_order is not distinct from old.sort_order
     and new.planned_duration_seconds is not distinct from old.planned_duration_seconds then
    return new;
  end if;
  select
    exists (select 1 from training.activity_participant_components where activity_component_id = old.id)
    or exists (select 1 from training.activity_component_metric_segment_links where activity_component_id = old.id and link_status = 'confirmed')
    into v_locked;
  if v_locked then
    -- actual_duration_seconds (the "what really happened" capture field)
    -- is deliberately NOT in the guarded list above — it legitimately
    -- keeps being filled in after the component is already in use.
    raise exception 'training.activity_components (id=%): identity/snapshot/planned-order fields are immutable once used or confirmed', old.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_components_protect_identity
  before update on training.activity_components
  for each row execute function training.protect_component_identity_once_used();

-- ---------------------------------------------------------------------
-- training.activity_participant_components — actual per-athlete
-- performance of one component. activity_id is denormalized so BOTH
-- halves get a real composite FK back to their shared activity —
-- structurally impossible to link a participant and a component from
-- different activities. Actual metric VALUES never become columns here —
-- they live in Metrics Core, linked via
-- activity_component_metric_segment_links.
-- ---------------------------------------------------------------------
create table training.activity_participant_components (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null,
  activity_participant_id uuid not null,
  activity_component_id uuid not null,
  status varchar(20) not null default 'performed' check (status in ('performed', 'skipped', 'modified', 'stopped')),
  actual_duration_seconds numeric,
  actual_prescription_snapshot jsonb,
  actual_prescription_snapshot_version smallint not null default 1,
  note text,
  created_at timestamptz not null default now(),
  unique (activity_participant_id, activity_component_id),
  -- DEFERRABLE INITIALLY DEFERRED (unlike every other FK in this schema):
  -- a reparent with component data needs to swap BOTH the participant's
  -- own activity_id AND this junction row's activity_id to the SAME new
  -- value, and there is no single-statement order that satisfies an
  -- IMMEDIATE composite FK on both sides of that swap at every
  -- intermediate step — only at the END of the transaction is consistency
  -- actually required. reparent_activity_participant() (v4) is always
  -- called as either a single top-level statement or inside an explicit
  -- caller-managed transaction, so deferring to COMMIT is safe and never
  -- masks a genuinely inconsistent final state.
  constraint activity_participant_components_participant_same_activity_fk
    foreign key (activity_participant_id, activity_id) references training.activity_participants (id, activity_id)
    deferrable initially deferred,
  constraint activity_participant_components_component_same_activity_fk
    foreign key (activity_component_id, activity_id) references training.activity_components (id, activity_id)
    deferrable initially deferred
);

-- The junction row's own linkage (which participant, which component,
-- which activity) may only be repointed by the sanctioned reparent
-- function's 'clone'/'map' component strategy (v4, via the same GUC it
-- already sets around its component-repointing statements); the
-- actually-performed prescription snapshot is a historical record, once
-- written — never revised afterward. status/actual_duration_seconds/note
-- stay freely editable (real post-hoc lifecycle fields).
create function training.protect_participant_component_fields() returns trigger as $$
begin
  if (new.activity_participant_id is distinct from old.activity_participant_id
      or new.activity_component_id is distinct from old.activity_component_id
      or new.activity_id is distinct from old.activity_id)
     and current_setting('training.allow_component_repoint', true) is distinct from 'on' then
    raise exception 'training.activity_participant_components (id=%): participant/component/activity linkage may only be repointed by reparent_activity_participant()''s sanctioned component strategy', old.id;
  end if;
  if new.actual_prescription_snapshot is distinct from old.actual_prescription_snapshot
     or new.actual_prescription_snapshot_version is distinct from old.actual_prescription_snapshot_version then
    raise exception 'training.activity_participant_components (id=%): actual_prescription_snapshot is immutable once recorded', old.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_participant_components_protect_fields
  before update on training.activity_participant_components
  for each row execute function training.protect_participant_component_fields();

-- =====================================================================
-- Typed link tables — never a polymorphic UUID column. Each is its own
-- historical, relinkable, audited chain: a relink NEVER updates an
-- existing row in place, it inserts a new one and marks the old
-- 'superseded'. At most one row per (participant|component|event|
-- occurrence) may be link_status='confirmed' at a time — enforced by a
-- partial unique index below each table.
--
-- Every typed link table carries supersedes_link_id (backward pointer)
-- alongside superseded_by_link_id (forward pointer), kept in step by a
-- fixed 3-step ordering wherever a relink is performed: (1) flip the OLD
-- row off 'confirmed' with no pointers yet; (2) insert the NEW row with
-- supersedes_link_id already pointing at the old row's (already-existing)
-- id; (3) only now point the OLD row's superseded_by_link_id at the NEW
-- row. Both directions stay consistent because step 2 can set the
-- backward pointer immediately (the old row already exists) while the
-- forward pointer must wait for the new row to exist — no deferred FK
-- needed for that half; a deferred constraint trigger below verifies the
-- whole thing holds at commit time.
-- =====================================================================

-- Planned-session / external-assignment link for a participant.
-- logical_session_id is deliberately a bare uuid with NO fk — a Builder
-- edit-draft/publish round trip recreates plans.plan_sessions rows with a
-- brand new physical id but preserves this value verbatim, so a real FK
-- here would break across that round trip. external_assignment_id IS a
-- real FK — training_load.external_assignments rows are append-only.
-- athlete_id/owner_* are a write-time snapshot of the participant's own
-- identity, needed because a partial unique index cannot join to another
-- table — see the two indexes below.
create table training.activity_participant_session_links (
  id uuid primary key default gen_random_uuid(),
  activity_participant_id uuid not null references training.activity_participants(id),
  athlete_id uuid not null references public.athletes(id),
  logical_session_id uuid,
  external_assignment_id uuid references training_load.external_assignments(id),
  link_method varchar(20) not null check (link_method in ('automatic', 'manual')),
  link_status varchar(20) not null check (link_status in ('suggested', 'confirmed', 'rejected', 'superseded')),
  confidence numeric,
  reason text,
  confirmed_by_user_id uuid references public.users(id),
  confirmed_at timestamptz,
  superseded_by_link_id uuid references training.activity_participant_session_links(id),
  supersedes_link_id uuid references training.activity_participant_session_links(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now(),
  check (
    (logical_session_id is not null and external_assignment_id is null) or
    (logical_session_id is null and external_assignment_id is not null)
  )
);
create index activity_participant_session_links_participant_idx on training.activity_participant_session_links (activity_participant_id);
create unique index activity_participant_session_links_one_confirmed_idx
  on training.activity_participant_session_links (activity_participant_id)
  where link_status = 'confirmed';
-- One active canonical claimant per external_assignment_id / per
-- (athlete_id, logical_session_id) — the reverse direction of "one
-- confirmed link per participant" above.
create unique index activity_participant_session_links_one_confirmed_external_idx
  on training.activity_participant_session_links (external_assignment_id)
  where link_status = 'confirmed' and external_assignment_id is not null;
create unique index activity_participant_session_links_one_confirmed_logical_idx
  on training.activity_participant_session_links (athlete_id, logical_session_id)
  where link_status = 'confirmed' and logical_session_id is not null;

-- Referential integrity for this link table: external_assignment_id must
-- belong to the SAME athlete as the participant, and the assignment's own
-- schedule owner scope must match the activity's; logical_session_id,
-- when confirmed, must resolve through a REAL, currently live, PUBLISHED
-- (never edit-draft, never a non-Weekly plan type) Weekly plan session
-- owned by the same workspace. Both checks only apply to
-- link_status='confirmed' — a 'suggested' row is allowed to reference
-- something not yet fully validated, since it hasn't settled.
create function training.check_session_link_integrity() returns trigger as $$
declare
  v_participant_athlete uuid;
  v_activity_id uuid;
  v_owner_scope varchar; v_owner_user uuid; v_owner_club uuid; v_owner_team uuid;
  v_assignment_athlete uuid;
  v_sched_owner_scope varchar; v_sched_owner_user uuid; v_sched_owner_club uuid; v_sched_owner_team uuid;
  v_live_ok boolean;
begin
  select ap.athlete_id, ap.activity_id, a.owner_scope, a.owner_user_id, a.owner_club_id, a.owner_team_id
    into v_participant_athlete, v_activity_id, v_owner_scope, v_owner_user, v_owner_club, v_owner_team
    from training.activity_participants ap join training.activities a on a.id = ap.activity_id
    where ap.id = new.activity_participant_id;

  if new.athlete_id is distinct from v_participant_athlete then
    raise exception 'activity_participant_session_links: athlete_id must match the participant''s own athlete_id';
  end if;

  if new.link_status <> 'confirmed' then
    return new;
  end if;

  if new.external_assignment_id is not null then
    select ea.athlete_id, es.owner_scope, es.owner_user_id, es.owner_club_id, es.owner_team_id
      into v_assignment_athlete, v_sched_owner_scope, v_sched_owner_user, v_sched_owner_club, v_sched_owner_team
      from training_load.external_assignments ea
      join training_load.external_schedule_occurrences eo on eo.id = ea.occurrence_id
      join training_load.external_schedules es on es.id = eo.schedule_id
      where ea.id = new.external_assignment_id;
    if v_assignment_athlete is distinct from v_participant_athlete then
      raise exception 'activity_participant_session_links (id=%): external_assignment athlete does not match the participant', new.id;
    end if;
    if v_sched_owner_scope is distinct from v_owner_scope or v_sched_owner_user is distinct from v_owner_user
       or v_sched_owner_club is distinct from v_owner_club or v_sched_owner_team is distinct from v_owner_team then
      raise exception 'activity_participant_session_links (id=%): external schedule owner scope does not match the activity''s owner scope', new.id;
    end if;
  end if;

  if new.logical_session_id is not null then
    select exists (
      select 1
      from plans.plan_sessions ps
      join plans.plan_days pd on pd.id = ps.plan_day_id
      join plans.plans p on p.id = pd.plan_id
      left join training_load.plan_workspace_ownership pwo on pwo.plan_id = p.id
      where ps.logical_session_id = new.logical_session_id
        and p.is_active = true and p.is_edit_draft = false
        and p.plan_type = 'weekly' and p.status = 'active'
        and coalesce(pwo.owner_scope, 'unresolved') = v_owner_scope
        and pwo.owner_user_id is not distinct from v_owner_user
        and pwo.owner_club_id is not distinct from v_owner_club
        and pwo.owner_team_id is not distinct from v_owner_team
    ) into v_live_ok;
    if not v_live_ok then
      raise exception 'activity_participant_session_links (id=%): logical_session_id does not resolve to a REAL, live, PUBLISHED, same-workspace Weekly plan session', new.id;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;
create trigger activity_participant_session_links_check_integrity
  before insert or update on training.activity_participant_session_links
  for each row execute function training.check_session_link_integrity();

-- Group-level link for an external occurrence — mirrors
-- activity_metric_event_links: declares "this occurrence AS A WHOLE
-- materializes to THIS activity", needed by
-- materialize_activity_group_from_external_occurrence() (v4) since the
-- per-assignment activity_participant_session_links rows alone cannot
-- express that group-level fact.
create table training.activity_external_occurrence_links (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  external_occurrence_id uuid not null references training_load.external_schedule_occurrences(id),
  link_method varchar(20) not null check (link_method in ('automatic', 'manual')),
  link_status varchar(20) not null check (link_status in ('suggested', 'confirmed', 'rejected', 'superseded')),
  confidence numeric,
  reason text,
  confirmed_by_user_id uuid references public.users(id),
  confirmed_at timestamptz,
  superseded_by_link_id uuid references training.activity_external_occurrence_links(id),
  supersedes_link_id uuid references training.activity_external_occurrence_links(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);
-- One activity per confirmed external occurrence.
create unique index activity_external_occurrence_links_one_confirmed_idx
  on training.activity_external_occurrence_links (external_occurrence_id)
  where link_status = 'confirmed';

-- Metrics Core links — three separate typed tables, one per level.
create table training.activity_metric_event_links (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  metric_event_id uuid not null references training_load.metric_events(id),
  link_method varchar(20) not null check (link_method in ('automatic', 'manual')),
  link_status varchar(20) not null check (link_status in ('suggested', 'confirmed', 'rejected', 'superseded')),
  confidence numeric,
  reason text,
  confirmed_by_user_id uuid references public.users(id),
  confirmed_at timestamptz,
  superseded_by_link_id uuid references training.activity_metric_event_links(id),
  supersedes_link_id uuid references training.activity_metric_event_links(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);
create unique index activity_metric_event_links_one_confirmed_idx
  on training.activity_metric_event_links (metric_event_id)
  where link_status = 'confirmed';

-- Source event/connection and activity must share a compatible (here:
-- identical) owner scope once the link is confirmed.
create function training.check_metric_event_link_owner_compat() returns trigger as $$
declare
  v_a_scope varchar; v_a_user uuid; v_a_club uuid; v_a_team uuid;
  v_e_scope varchar; v_e_user uuid; v_e_club uuid; v_e_team uuid;
begin
  if new.link_status <> 'confirmed' then
    return new;
  end if;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_a_scope, v_a_user, v_a_club, v_a_team
    from training.activities where id = new.activity_id;
  select owner_scope, owner_user_id, owner_club_id, owner_team_id into v_e_scope, v_e_user, v_e_club, v_e_team
    from training_load.metric_events where id = new.metric_event_id;
  if v_a_scope is distinct from v_e_scope or v_a_user is distinct from v_e_user
     or v_a_club is distinct from v_e_club or v_a_team is distinct from v_e_team then
    raise exception 'activity_metric_event_links (id=%): metric_event owner scope does not match the activity''s owner scope', new.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_metric_event_links_check_owner
  before insert or update on training.activity_metric_event_links
  for each row execute function training.check_metric_event_link_owner_compat();

create table training.activity_participant_metric_participant_links (
  id uuid primary key default gen_random_uuid(),
  activity_participant_id uuid not null references training.activity_participants(id),
  metric_event_participant_id uuid not null references training_load.metric_event_participants(id),
  link_method varchar(20) not null check (link_method in ('automatic', 'manual')),
  link_status varchar(20) not null check (link_status in ('suggested', 'confirmed', 'rejected', 'superseded')),
  confidence numeric,
  reason text,
  confirmed_by_user_id uuid references public.users(id),
  confirmed_at timestamptz,
  superseded_by_link_id uuid references training.activity_participant_metric_participant_links(id),
  supersedes_link_id uuid references training.activity_participant_metric_participant_links(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);
create unique index activity_participant_metric_links_one_confirmed_idx
  on training.activity_participant_metric_participant_links (metric_event_participant_id)
  where link_status = 'confirmed';

-- The metric participant must represent the SAME athlete as the activity
-- participant, and — once confirmed — its own metric_event must already
-- be confirmedly linked to the SAME activity (never a segment floating in
-- from an unrelated/unlinked event).
create function training.check_participant_metric_link_integrity() returns trigger as $$
declare
  v_participant_athlete uuid; v_activity_id uuid;
  v_metric_athlete uuid; v_metric_event_id uuid;
  v_event_linked boolean;
begin
  select athlete_id, activity_id into v_participant_athlete, v_activity_id
    from training.activity_participants where id = new.activity_participant_id;
  select athlete_id, event_id into v_metric_athlete, v_metric_event_id
    from training_load.metric_event_participants where id = new.metric_event_participant_id;
  if v_metric_athlete is distinct from v_participant_athlete then
    raise exception 'activity_participant_metric_participant_links (id=%): metric participant athlete does not match the activity participant', new.id;
  end if;
  if new.link_status = 'confirmed' then
    select exists (
      select 1 from training.activity_metric_event_links
      where activity_id = v_activity_id and metric_event_id = v_metric_event_id and link_status = 'confirmed'
    ) into v_event_linked;
    if not v_event_linked then
      raise exception 'activity_participant_metric_participant_links (id=%): the metric event is not confirmedly linked to the SAME activity', new.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_participant_metric_participant_links_check_integrity
  before insert or update on training.activity_participant_metric_participant_links
  for each row execute function training.check_participant_metric_link_integrity();

create table training.activity_component_metric_segment_links (
  id uuid primary key default gen_random_uuid(),
  activity_component_id uuid not null references training.activity_components(id),
  metric_event_segment_id uuid not null references training_load.metric_event_segments(id),
  link_method varchar(20) not null check (link_method in ('automatic', 'manual')),
  link_status varchar(20) not null check (link_status in ('suggested', 'confirmed', 'rejected', 'superseded')),
  confidence numeric,
  reason text,
  confirmed_by_user_id uuid references public.users(id),
  confirmed_at timestamptz,
  superseded_by_link_id uuid references training.activity_component_metric_segment_links(id),
  supersedes_link_id uuid references training.activity_component_metric_segment_links(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now()
);
create unique index activity_component_metric_links_one_confirmed_idx
  on training.activity_component_metric_segment_links (metric_event_segment_id)
  where link_status = 'confirmed';

-- A metric segment must belong to an event that — once this link is
-- confirmed — is itself confirmedly linked to the component's OWN
-- activity.
create function training.check_component_metric_segment_link_integrity() returns trigger as $$
declare
  v_activity_id uuid;
  v_segment_event_id uuid;
  v_event_linked boolean;
begin
  if new.link_status <> 'confirmed' then
    return new;
  end if;
  select activity_id into v_activity_id from training.activity_components where id = new.activity_component_id;
  select event_id into v_segment_event_id from training_load.metric_event_segments where id = new.metric_event_segment_id;
  select exists (
    select 1 from training.activity_metric_event_links
    where activity_id = v_activity_id and metric_event_id = v_segment_event_id and link_status = 'confirmed'
  ) into v_event_linked;
  if not v_event_linked then
    raise exception 'activity_component_metric_segment_links (id=%): the segment''s event is not confirmedly linked to the component''s own activity', new.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_component_metric_segment_links_check_integrity
  before insert or update on training.activity_component_metric_segment_links
  for each row execute function training.check_component_metric_segment_link_integrity();

-- =====================================================================
-- Shared link-chain integrity, applied identically to all 5 typed link
-- tables above:
--   1. protect_link_chain_write_once — superseded_by_link_id/
--      supersedes_link_id are write-once (an existing chain can never be
--      altered), plus a no-self-reference CHECK per table.
--   2. protect_link_identity_fields — diffs to_jsonb(OLD)/to_jsonb(NEW)
--      with every legitimately mutable column removed first; anything
--      left over means an identity/target field changed, which is
--      rejected. This is what makes ONE function work across 5
--      differently-shaped tables without hardcoding column names per
--      table. activity_participant_id is the one exception, and only on
--      activity_participant_session_links: it is that table's own
--      CORRECTABLE linkage (which canonical participant a real external
--      fact currently resolves to), never its stable anchor — see
--      check_link_chain_reciprocal below for why the anchor for that
--      table is a normalized logical/external source identity instead.
--      Every other table (including activity_participant_metric_
--      participant_links, which happens to share this exact column name)
--      keeps it fully immutable.
--   3. protect_link_status_transitions — only suggested->{confirmed,
--      rejected} and confirmed->superseded are legal edges.
--   4. check_link_chain_reciprocal — a DEFERRABLE INITIALLY DEFERRED
--      constraint trigger (the standard 3-step relink ordering —
--      superseded-then-inserted-then-pointed — is internally inconsistent
--      at every intermediate step by design, so this can only run at
--      commit time). Verifies: a 'superseded' row carries a non-null
--      superseded_by_link_id; a 'suggested'/'rejected' row carries no
--      chain pointers at all; both pointers are mutually reciprocal; and
--      a successor's own "anchor" (the stable external fact being linked
--      — plain foreign column for 4 of the 5 tables, a normalized
--      `logical:<id>`/`external:<id>` source-identity expression for
--      activity_participant_session_links) matches its predecessor's,
--      so an insert can never claim to supersede an unrelated old row
--      from a different lineage, or mix a logical and an external
--      identity within one chain. Dynamic SQL (format()/EXECUTE) keyed on
--      TG_TABLE_SCHEMA/TG_TABLE_NAME lets one function work across all 5
--      tables.
-- Plus one UNIQUE index per table on non-null supersedes_link_id — no two
-- rows may claim to supersede the same old row (no branching).
-- =====================================================================
create function training.protect_link_chain_write_once() returns trigger as $$
begin
  if old.superseded_by_link_id is not null and new.superseded_by_link_id is distinct from old.superseded_by_link_id then
    raise exception '%: superseded_by_link_id is write-once — an existing link chain can never be altered', tg_table_name;
  end if;
  if old.supersedes_link_id is not null and new.supersedes_link_id is distinct from old.supersedes_link_id then
    raise exception '%: supersedes_link_id is write-once', tg_table_name;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_participant_session_links_protect_chain
  before update on training.activity_participant_session_links
  for each row execute function training.protect_link_chain_write_once();
create trigger activity_external_occurrence_links_protect_chain
  before update on training.activity_external_occurrence_links
  for each row execute function training.protect_link_chain_write_once();
create trigger activity_metric_event_links_protect_chain
  before update on training.activity_metric_event_links
  for each row execute function training.protect_link_chain_write_once();
create trigger activity_participant_metric_participant_links_protect_chain
  before update on training.activity_participant_metric_participant_links
  for each row execute function training.protect_link_chain_write_once();
create trigger activity_component_metric_segment_links_protect_chain
  before update on training.activity_component_metric_segment_links
  for each row execute function training.protect_link_chain_write_once();

alter table training.activity_participant_session_links
  add constraint activity_participant_session_links_no_self_chain
  check ((superseded_by_link_id is null or superseded_by_link_id <> id) and (supersedes_link_id is null or supersedes_link_id <> id));
alter table training.activity_external_occurrence_links
  add constraint activity_external_occurrence_links_no_self_chain
  check ((superseded_by_link_id is null or superseded_by_link_id <> id) and (supersedes_link_id is null or supersedes_link_id <> id));
alter table training.activity_metric_event_links
  add constraint activity_metric_event_links_no_self_chain
  check ((superseded_by_link_id is null or superseded_by_link_id <> id) and (supersedes_link_id is null or supersedes_link_id <> id));
alter table training.activity_participant_metric_participant_links
  add constraint activity_participant_metric_participant_links_no_self_chain
  check ((superseded_by_link_id is null or superseded_by_link_id <> id) and (supersedes_link_id is null or supersedes_link_id <> id));
alter table training.activity_component_metric_segment_links
  add constraint activity_component_metric_segment_links_no_self_chain
  check ((superseded_by_link_id is null or superseded_by_link_id <> id) and (supersedes_link_id is null or supersedes_link_id <> id));

create function training.protect_link_identity_fields() returns trigger as $$
declare
  v_mutable_keys text[] := array['link_status', 'confidence', 'reason', 'confirmed_by_user_id', 'confirmed_at', 'superseded_by_link_id', 'supersedes_link_id'];
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  k text;
begin
  if tg_table_name = 'activity_participant_session_links' then
    v_mutable_keys := v_mutable_keys || array['activity_participant_id'];
  end if;
  foreach k in array v_mutable_keys loop
    v_old := v_old - k;
    v_new := v_new - k;
  end loop;
  if v_old is distinct from v_new then
    raise exception '%: identity/target fields are immutable after insert — a relink must insert a NEW row, never repoint an existing one', tg_table_name;
  end if;
  return new;
end;
$$ language plpgsql;

create function training.protect_link_status_transitions() returns trigger as $$
begin
  if new.link_status = old.link_status then
    return new;
  end if;
  if not (
    (old.link_status = 'suggested' and new.link_status in ('confirmed', 'rejected')) or
    (old.link_status = 'confirmed' and new.link_status = 'superseded')
  ) then
    raise exception '%: illegal link_status transition % -> %', tg_table_name, old.link_status, new.link_status;
  end if;
  return new;
end;
$$ language plpgsql;

create function training.check_link_chain_reciprocal() returns trigger as $$
declare
  v_status varchar;
  v_superseded_by uuid;
  v_supersedes uuid;
  v_other_supersedes uuid;
  v_other_superseded_by uuid;
  v_anchor_expr text;
  v_old_anchor text;
  v_new_anchor text;
begin
  -- IMPORTANT: this is a DEFERRED constraint trigger — NEW is the
  -- point-in-time row image from whichever statement fired it, captured
  -- BEFORE later statements in the same transaction (e.g. the 3-step
  -- relink's own final "point the old row at the new one" step) have run.
  -- Checking new.* directly would spuriously reject a fully legitimate,
  -- by-now-complete relink using its OWN stale mid-sequence snapshot —
  -- every check below therefore re-reads the row's CURRENT, live state
  -- (as of when this deferred trigger actually fires, at commit) by id,
  -- exactly like the reciprocal cross-row lookups already have to.
  execute format('select link_status, superseded_by_link_id, supersedes_link_id from %I.%I where id = $1', tg_table_schema, tg_table_name)
    into v_status, v_superseded_by, v_supersedes using new.id;

  if v_status = 'superseded' and v_superseded_by is null then
    raise exception '%.%: a superseded row must (by commit time) carry a non-null superseded_by_link_id (row %)', tg_table_schema, tg_table_name, new.id;
  end if;
  if v_status in ('suggested', 'rejected') and (v_superseded_by is not null or v_supersedes is not null) then
    raise exception '%.%: a % row must carry NO chain pointers (row %)', tg_table_schema, tg_table_name, v_status, new.id;
  end if;

  if v_superseded_by is not null then
    execute format('select supersedes_link_id from %I.%I where id = $1', tg_table_schema, tg_table_name)
      into v_other_supersedes using v_superseded_by;
    if v_other_supersedes is distinct from new.id then
      raise exception '%.%: reciprocal chain violation — row % has superseded_by_link_id=% but that row''s own supersedes_link_id is % (expected %)',
        tg_table_schema, tg_table_name, new.id, v_superseded_by, v_other_supersedes, new.id;
    end if;
  end if;
  if v_supersedes is not null then
    execute format('select superseded_by_link_id from %I.%I where id = $1', tg_table_schema, tg_table_name)
      into v_other_superseded_by using v_supersedes;
    if v_other_superseded_by is distinct from new.id then
      raise exception '%.%: reciprocal chain violation — row % has supersedes_link_id=% but that row''s own superseded_by_link_id is % (expected %)',
        tg_table_schema, tg_table_name, new.id, v_supersedes, v_other_superseded_by, new.id;
    end if;

    -- The stable anchor for activity_participant_session_links is a
    -- NORMALIZED source identity string, `logical:<id>` or
    -- `external:<id>` — never activity_participant_id, which a
    -- legitimate relink is specifically allowed to change (moving the
    -- link onto a different, e.g. canonical, participant row). For the
    -- other 4 tables the plain foreign column already IS the stable
    -- external fact, unchanged.
    v_anchor_expr := case tg_table_name
      when 'activity_participant_session_links' then $sql$coalesce('logical:' || logical_session_id::text, 'external:' || external_assignment_id::text)$sql$
      when 'activity_external_occurrence_links' then 'external_occurrence_id::text'
      when 'activity_metric_event_links' then 'metric_event_id::text'
      when 'activity_participant_metric_participant_links' then 'metric_event_participant_id::text'
      when 'activity_component_metric_segment_links' then 'metric_event_segment_id::text'
    end;
    execute format('select %s from %I.%I where id = $1', v_anchor_expr, tg_table_schema, tg_table_name)
      into v_old_anchor using v_supersedes;
    execute format('select %s from %I.%I where id = $1', v_anchor_expr, tg_table_schema, tg_table_name)
      into v_new_anchor using new.id;
    if v_old_anchor is distinct from v_new_anchor then
      raise exception '%.%: a successor (row %) must share the SAME source identity as its predecessor (%) — got % vs %, refusing to chain two unrelated lineages together (or mix a logical and an external identity)',
        tg_table_schema, tg_table_name, new.id, v_supersedes, v_new_anchor, v_old_anchor;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  foreach t in array array[
    'activity_participant_session_links', 'activity_external_occurrence_links', 'activity_metric_event_links',
    'activity_participant_metric_participant_links', 'activity_component_metric_segment_links'
  ] loop
    execute format('create trigger %I_lid before update on training.%I for each row execute function training.protect_link_identity_fields()', t, t);
    execute format('create trigger %I_lst before update on training.%I for each row execute function training.protect_link_status_transitions()', t, t);
    execute format('create constraint trigger %I_lrc after insert or update on training.%I deferrable initially deferred for each row execute function training.check_link_chain_reciprocal()', t, t);
    execute format('create unique index %I_sup_uq on training.%I (supersedes_link_id) where supersedes_link_id is not null', t, t);
  end loop;
end $$;

-- Superseding an activity_metric_event_links row while CONFIRMED
-- descendant links (participant-metric or component-segment) still depend
-- on this exact (activity, event) pair would silently orphan them —
-- refused instead, with a clear reason, matching every other "complete
-- relink or refuse" rule in this module.
create function training.check_metric_event_link_no_orphan_descendants() returns trigger as $$
declare
  v_has_descendants boolean;
begin
  if old.link_status = 'confirmed' and new.link_status = 'superseded' then
    select
      exists (
        select 1 from training.activity_participant_metric_participant_links mpl
        join training_load.metric_event_participants mep on mep.id = mpl.metric_event_participant_id
        where mep.event_id = old.metric_event_id and mpl.link_status = 'confirmed'
      )
      or exists (
        select 1 from training.activity_component_metric_segment_links csl
        join training_load.metric_event_segments mes on mes.id = csl.metric_event_segment_id
        where mes.event_id = old.metric_event_id and csl.link_status = 'confirmed'
      )
      into v_has_descendants;
    if v_has_descendants then
      raise exception 'activity_metric_event_links (id=%): cannot supersede — CONFIRMED participant/segment links still depend on this activity/event pair; relink them first', old.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_metric_event_links_check_no_orphans
  before update on training.activity_metric_event_links
  for each row execute function training.check_metric_event_link_no_orphan_descendants();
