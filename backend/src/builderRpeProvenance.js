const gate = "builder-rpe-provenance-v106";

export async function beginBuilderRpeProvenance(client) {
  await client.query("select pg_advisory_xact_lock_shared(hashtextextended($1,0))", [gate]);
  const { rows: [schema] } = await client.query(
    "select to_regclass('training_load.builder_rpe_provenance_use') is not null as ready",
  );
  return schema.ready;
}

export async function recordBuilderRpeOpening(client, { planId, sourcePlanId = null, origin = sourcePlanId ? "edit" : "created", copies = new Map() }) {
  const { rowCount } = await client.query(
    `insert into training_load.builder_rpe_plan_baselines
       (plan_id,origin,source_plan_id,source_updated_at,owner_scope,owner_user_id,owner_club_id,owner_team_id,opening_tracking,opening_rpe)
     select p.id,$3,
            src.id,src.updated_at,o.owner_scope,o.owner_user_id,o.owner_club_id,o.owner_team_id,
            p.track_training_load_default,p.request_rpe_default
     from plans.plans p
     left join plans.plans src on src.id=$2
     left join training_load.plan_workspace_ownership o on o.plan_id=p.id
     where p.id=$1 and (
       ($3 = 'created' and $2::uuid is null and p.edit_source_plan_id is null)
       or ($3 = 'edit' and p.edit_source_plan_id=src.id)
       or ($3 = 'copy' and src.id is not null and p.edit_source_plan_id is null)
     )`,
    [planId, sourcePlanId, origin],
  );
  if (rowCount !== 1) throw new Error("Builder RPE opening plan was not recorded.");

  await recordBuilderRpeCopiedSessions(client, { planId, sourcePlanId, copies, retained: origin === "edit" });
  await recordBuilderRpeUse(client);
}

export async function recordBuilderRpeUse(client) {
  await client.query("insert into training_load.builder_rpe_provenance_use default values on conflict do nothing");
}

async function recordBuilderRpeCopiedSessions(client, { planId, sourcePlanId, sourcePlanIds = [sourcePlanId], copies, retained = false }) {
  if (!copies.size) return;
  const { rowCount: sessions } = await client.query(
    `insert into training_load.builder_rpe_session_baselines
       (plan_id,session_id,logical_session_id,source_plan_id,source_session_id,retained_from_opening,opening_tracking,opening_rpe)
     select $1,dst.id,dst.logical_session_id,sd.plan_id,src.id,$5,dst.training_load_enabled,dst.rpe_enabled
     from unnest($3::uuid[],$4::uuid[]) pair(source_id,target_id)
     join plans.plan_sessions src on src.id=pair.source_id
     join plans.plan_days sd on sd.id=src.plan_day_id and sd.plan_id=any($2::uuid[])
     join plans.plan_sessions dst on dst.id=pair.target_id
     join plans.plan_days dd on dd.id=dst.plan_day_id and dd.plan_id=$1
     join training_load.builder_rpe_plan_baselines opening on opening.plan_id=dd.plan_id
     where (dst.training_load_enabled,dst.rpe_enabled) = (src.training_load_enabled,src.rpe_enabled)`,
    [planId, sourcePlanIds, [...copies.keys()], [...copies.values()], retained],
  );
  if (sessions !== copies.size) throw new Error("Builder RPE session copy does not match its source.");
}

export async function recordBuilderRpeCopyIfTracked(client, copy) {
  if (!copy.copies.size) return;
  const opening = await client.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [copy.planId]);
  if (opening.rowCount) await recordBuilderRpeCopiedSessions(client, copy);
}

export async function recordBuilderRpeNewLogicalCopies(client, { planId, sourcePlanId, copies }) {
  if (!copies.size) return;
  const { rows } = await client.query(
    `select s.id
     from plans.plan_sessions s
     join training_load.builder_rpe_plan_baselines p on p.plan_id=$1
     where s.id=any($2::uuid[]) and not exists(
       select 1 from training_load.builder_rpe_session_baselines b
       where b.plan_id=p.plan_id and b.logical_session_id=s.logical_session_id
     )`, [planId,[...copies.values()]],
  );
  const missing = new Set(rows.map(row => row.id));
  await recordBuilderRpeCopiedSessions(client, {
    planId, sourcePlanId, copies: new Map([...copies].filter(([,targetId]) => missing.has(targetId))),
  });
}

export async function recordBuilderRpeSyncedCopy(client, { planId, sourcePlanId, copies, lineage }) {
  const inherited = new Map(copies);
  for (const { source_id, target_id } of lineage) {
    const inserted = inherited.get(source_id);
    if (!inserted) throw new Error("The exact Builder RPE sync destination is missing.");
    inherited.delete(source_id);
    const { rowCount } = await client.query(
      `insert into training_load.builder_rpe_session_baselines
         (plan_id,session_id,logical_session_id,source_plan_id,source_session_id,opening_tracking,opening_rpe)
       select $1,dst.id,dst.logical_session_id,$2,$3,old.opening_tracking,old.opening_rpe
       from training_load.builder_rpe_session_baselines old
       join plans.plan_sessions dst on dst.id=$5
       join plans.plan_days d on d.id=dst.plan_day_id and d.plan_id=old.plan_id
       where old.plan_id=$1 and old.session_id=$4`, [planId,sourcePlanId,source_id,target_id,inserted],
    );
    if (!rowCount) throw new Error("The exact Builder RPE sync opening is missing.");
    await client.query(
      `insert into training_load.builder_rpe_session_effects
         (plan_id,session_id,changed_tracking,changed_rpe,effective_tracking,effective_rpe)
       select $1,$5,pending.tracking,pending.rpe,dst.training_load_enabled,dst.rpe_enabled
       from training_load.builder_rpe_session_baselines b
       join plans.plan_sessions dst on dst.id=b.session_id
       left join training_load.builder_rpe_session_effects src on src.plan_id=$2 and src.session_id=$3
       left join training_load.builder_rpe_session_effects old on old.plan_id=$1 and old.session_id=$4
       cross join lateral (
         select dst.training_load_enabled<>b.opening_tracking and (coalesce(src.changed_tracking,false) or coalesce(old.changed_tracking,false)) as tracking,
                dst.rpe_enabled<>b.opening_rpe and (coalesce(src.changed_rpe,false) or coalesce(old.changed_rpe,false)) as rpe
       ) pending
       where b.plan_id=$1 and b.session_id=$5 and (pending.tracking or pending.rpe)`,
      [planId,sourcePlanId,source_id,target_id,inserted],
    );
  }
  await recordBuilderRpeCopyIfTracked(client, { planId, sourcePlanId, copies: inherited });
}

// Existing drafts without exact baselines stay unclassified while exposure is closed.
export async function recordBuilderRpeSessionEffect(client, planId, before, after) {
  const trackingChanged = before.training_load_enabled !== after.trackingEnabled;
  const rpeChanged = before.rpe_enabled !== after.rpeEnabled;
  if (!trackingChanged && !rpeChanged) return;
  await recordBuilderRpeUse(client);
  const { rows: [effect] } = await client.query(
    `select ($3 <> b.opening_tracking and ($5 or coalesce(e.changed_tracking,false))) as tracking,
            ($4 <> b.opening_rpe and ($6 or coalesce(e.changed_rpe,false))) as rpe
     from training_load.builder_rpe_session_baselines b
     left join training_load.builder_rpe_session_effects e using (plan_id,session_id)
     where b.plan_id=$1 and b.session_id=$2`,
    [planId,before.id,after.trackingEnabled,after.rpeEnabled,trackingChanged,rpeChanged],
  );
  if (!effect) return;
  if (!effect.tracking && !effect.rpe) {
    await client.query("delete from training_load.builder_rpe_session_effects where plan_id=$1 and session_id=$2", [planId,before.id]);
    return;
  }
  await client.query(
    `insert into training_load.builder_rpe_session_effects
       (plan_id,session_id,changed_tracking,changed_rpe,effective_tracking,effective_rpe)
     values ($1,$2,$3,$4,$5,$6)
     on conflict (plan_id,session_id) do update set
       changed_tracking=excluded.changed_tracking, changed_rpe=excluded.changed_rpe,
       effective_tracking=excluded.effective_tracking, effective_rpe=excluded.effective_rpe`,
    [planId,before.id,effect.tracking,effect.rpe,after.trackingEnabled,after.rpeEnabled],
  );
}

export async function recordBuilderRpePlanEffect(client, before, after) {
  const trackingChanged = before.track_training_load_default !== after.trackingEnabled;
  const rpeChanged = before.request_rpe_default !== after.rpeEnabled;
  if (!trackingChanged && !rpeChanged) return;
  await recordBuilderRpeUse(client);
  const { rows: [effect] } = await client.query(
    `select ($2 <> b.opening_tracking and ($4 or coalesce(e.changed_tracking,false))) as tracking,
            ($3 <> b.opening_rpe and ($5 or coalesce(e.changed_rpe,false))) as rpe
     from training_load.builder_rpe_plan_baselines b
     left join training_load.builder_rpe_plan_effects e using (plan_id)
     where b.plan_id=$1`,
    [before.id,after.trackingEnabled,after.rpeEnabled,trackingChanged,rpeChanged],
  );
  if (!effect) return;
  if (!effect.tracking && !effect.rpe) {
    await client.query("delete from training_load.builder_rpe_plan_effects where plan_id=$1", [before.id]);
    return;
  }
  await client.query(
    `insert into training_load.builder_rpe_plan_effects
       (plan_id,changed_tracking,changed_rpe,effective_tracking,effective_rpe)
     values ($1,$2,$3,$4,$5)
     on conflict (plan_id) do update set
       changed_tracking=excluded.changed_tracking, changed_rpe=excluded.changed_rpe,
       effective_tracking=excluded.effective_tracking, effective_rpe=excluded.effective_rpe`,
    [before.id,effect.tracking,effect.rpe,after.trackingEnabled,after.rpeEnabled],
  );
}

// Record exact inserted rows only under a known immutable plan baseline.
export async function recordBuilderRpeSessionOpening(client, planId, sessionId, source = null) {
  await client.query(
    `insert into training_load.builder_rpe_session_baselines
       (plan_id,session_id,logical_session_id,source_plan_id,source_session_id,opening_tracking,opening_rpe)
     select $1,s.id,s.logical_session_id,$3,$4,s.training_load_enabled,s.rpe_enabled
     from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id and d.plan_id=$1
     join training_load.builder_rpe_plan_baselines b on b.plan_id=d.plan_id
     where s.id=$2`,
    [planId,sessionId,source?.plan.id ?? null,source?.id ?? null],
  );
}

// Compare only server-recorded explicit changes. Older drafts stay on the
// staged compatibility path until every writer supplies complete provenance.
export async function inspectBuilderRpeSubmitEffects(client, sourcePlanId, draftId) {
  const { rows } = await client.query(
    `select effect.changed_tracking,effect.changed_rpe,
            current_draft.training_load_enabled as draft_tracking,
            current_draft.rpe_enabled as draft_rpe,
            lineage.retained_from_opening, source_session.id as current_source_id,
            source_session.training_load_enabled as source_tracking, source_session.rpe_enabled as source_rpe
       from training_load.builder_rpe_session_effects effect
       join training_load.builder_rpe_session_baselines lineage using (plan_id,session_id)
       join training_load.builder_rpe_plan_baselines opening on opening.plan_id=effect.plan_id and opening.source_plan_id=$1
       join (
         select s.* from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id where d.plan_id=$2
       ) current_draft on current_draft.id=effect.session_id
       left join lateral (
         select s.* from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id
         where lineage.retained_from_opening and s.id=lineage.source_session_id and d.plan_id=$1 and lineage.source_plan_id=$1
       ) source_session on true
       where effect.plan_id=$2 order by lineage.source_session_id,effect.session_id`,
    [sourcePlanId,draftId],
  );
  if (rows.some(row => row.retained_from_opening && !row.current_source_id)) return { sourceChanged: true };
  const changed = rows.some(row => !row.retained_from_opening ||
    (row.changed_tracking && row.draft_tracking !== row.source_tracking) ||
    (row.changed_rpe && row.draft_rpe !== row.source_rpe));
  return { changed };
}

export async function listBuilderRpeExplicitSessions(client, planId) {
  const { rows } = await client.query(
    `select e.session_id
     from training_load.builder_rpe_session_effects e
     join plans.plan_sessions s on s.id=e.session_id
     join plans.plan_days d on d.id=s.plan_day_id and d.plan_id=e.plan_id
     where e.plan_id=$1`, [planId],
  );
  return new Set(rows.map(row => row.session_id));
}

export async function listBuilderRpeSiblingLineage(client, sourcePlanId, targetPlanId, sourceIds, targetIds) {
  const { rows } = await client.query(
    `with recursive current_sessions as (
       select d.plan_id,s.id,s.logical_session_id
       from plans.plan_sessions s join plans.plan_days d on d.id=s.plan_day_id
       where d.plan_id in ($1,$2)
     ), anchors as (
       select s.plan_id,s.id,s.plan_id as ancestor_plan_id,s.id as ancestor_id
       from current_sessions s
       where not exists(
         select 1 from training_load.builder_rpe_session_baselines recorded
         where recorded.plan_id=s.plan_id and recorded.session_id=s.id
           and recorded.logical_session_id is distinct from s.logical_session_id
       )
       union
       select s.plan_id,s.id,b.plan_id,b.session_id
       from current_sessions s join training_load.builder_rpe_session_baselines b
         on b.plan_id=s.plan_id and b.logical_session_id=s.logical_session_id
     ), lineage(plan_id,id,ancestor_plan_id,ancestor_id) as (
       select plan_id,id,ancestor_plan_id,ancestor_id from anchors
       union
       select l.plan_id,l.id,b.source_plan_id,b.source_session_id
       from lineage l join training_load.builder_rpe_session_baselines b
         on b.plan_id=l.ancestor_plan_id and b.session_id=l.ancestor_id
       where b.source_plan_id is not null
     )
     select distinct a.id as source_id,b.id as target_id
     from lineage a join lineage b using(ancestor_plan_id,ancestor_id)
     where a.plan_id=$1 and b.plan_id=$2 and (a.id=any($3::uuid[]) or b.id=any($4::uuid[]))`, [sourcePlanId,targetPlanId,sourceIds,targetIds],
  );
  return rows;
}

export async function hasBuilderRpeSiblingLineage(client, source, target) {
  const matches = await listBuilderRpeSiblingLineage(client, source.planId, target.planId, [source.sessionId], []);
  return matches.length === 1 && matches[0].target_id === target.sessionId;
}
