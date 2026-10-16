export const exerciseCollectionAccessSql = `(
    exists (select 1 from public.user_global_roles exercise_admin
      where exercise_admin.user_id = $1 and exercise_admin.role = 'platform_admin' and exercise_admin.is_active = true)
    or not exists (select 1 from library.exercise_collection_items restricted_item
      where restricted_item.exercise_id = coalesce(e.source_exercise_id, e.id))
    or exists (select 1 from library.exercise_collection_items granted_item
      join library.exercise_collection_users exercise_grant on exercise_grant.collection_id = granted_item.collection_id
      where granted_item.exercise_id = coalesce(e.source_exercise_id, e.id) and exercise_grant.user_id = $1)
  )`;

export const exerciseReuseScopeSql = `e.is_active = true
  and (e.source_exercise_id is null or exists (
    select 1 from library.exercises exercise_source
    where exercise_source.id = e.source_exercise_id and exercise_source.owner_scope = 'system'
      and exercise_source.source_exercise_id is null and exercise_source.is_active = true
  ))
  and ${exerciseCollectionAccessSql}`;

export const exerciseReadScopeSql = `(${exerciseReuseScopeSql})
  and (e.owner_scope = 'system' or (e.owner_scope = 'user' and e.owner_user_id = $1))`;

export async function lockExerciseReuse(client, guard = null) {
  if (guard?.active === true) return;
  const isolation = await client.query("select current_setting('transaction_isolation') as isolation");
  if (isolation.rows[0].isolation !== "read committed") {
    const error = new Error("Exercise reuse requires READ COMMITTED.");
    error.status = 409;
    throw error;
  }
  await client.query("set local lock_timeout = '2s'");
  await client.query("select pg_advisory_xact_lock_shared(hashtextextended('exercise_collections', 0))");
}

export async function assertExerciseReuseAllowed(client, userId, {
  planIds = [], dayIds = [], sessionIds = [], nodeIds = [], retainedItems = [], guard = null,
  excludeItemIds = [], excludeNodeIds = [], excludeSessionIds = [], excludeDayIds = [],
}) {
  await lockExerciseReuse(client, guard);
  const restricted = await client.query(`
    with recursive selected_nodes as (
      select id from plans.plan_nodes where id = any($5::uuid[])
      union
      select child.id from plans.plan_nodes child join selected_nodes parent on child.parent_id = parent.id
    ), excluded_nodes as (
      select id from plans.plan_nodes where id = any($7::uuid[])
      union
      select child.id from plans.plan_nodes child join excluded_nodes parent on child.parent_id = parent.id
    )
    select e.id, count(*)::integer as uses
    from plans.plan_items item
    join plans.plan_sessions session on session.id = item.plan_session_id
    join plans.plan_days day on day.id = session.plan_day_id
    join library.exercises e on e.id = item.exercise_id
    where (day.plan_id = any($2::uuid[]) or day.id = any($3::uuid[])
      or session.id = any($4::uuid[]) or item.plan_node_id in (select id from selected_nodes))
      and not (item.id = any($6::uuid[])
        or (item.plan_node_id is not null and item.plan_node_id in (select id from excluded_nodes))
        or session.id = any($8::uuid[]) or day.id = any($9::uuid[]))
      and not coalesce((${exerciseReuseScopeSql}), false)
    group by e.id`, [userId, planIds, dayIds, sessionIds, nodeIds, excludeItemIds, excludeNodeIds, excludeSessionIds, excludeDayIds]);
  const retained = new Map(retainedItems.map((item) => [item.exercise_id, Number(item.uses)]));
  if (restricted.rows.some((item) => item.uses > (retained.get(item.id) || 0))) {
    const error = new Error("exerciseAccessRevoked");
    error.status = 409;
    throw error;
  }
}

export async function withExerciseReuseTransaction(pool, userId, planIds, work, { shouldCheck = () => true } = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockExerciseReuse(client);
    await client.query("select id from plans.plans where id = any($1::uuid[]) order by id for update", [planIds]);
    const runQuery = client.query.bind(client);
    if (await shouldCheck(runQuery)) await assertExerciseReuseAllowed(client, userId, { planIds });
    const result = await work(runQuery, client);
    await client.query("commit");
    return result;
  } catch (error) {
    try { await client.query("rollback"); } catch {}
    throw error;
  } finally { client.release(); }
}
