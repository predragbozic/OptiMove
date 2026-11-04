// U2 (v56): a team's import switch in a disposable test database. Absence of a
// switch row means OFF, so every suite that approves an import turns the team
// on first. This writes the row the way only the sanctioned function may (the
// transaction-local marker the guard compares), skipping the function's
// conditions: a suite that is not about the conditions must not depend on a
// backup date. The conditions have their own suite.
export async function enableTeamImportSwitch(db, teamId, userId = null, { mode = "pilot", enabled = true, reason = "test fixture" } = {}) {
  // db: a pg Client (one connection; begin and commit run on it) - the suites' `admin`.
  const client = db;
  if (!userId) userId = (await client.query(`select id from public.users order by id limit 1`)).rows[0].id;
  try {
    await client.query("begin");
    await client.query("select set_config('optimove.team_import_tx', txid_current()::text, true)");
    await client.query(
      `insert into training_load.gpexe_team_import_switch (owner_team_id, enabled, mode, changed_by_user_id, change_reason)
       values ($1, $2, $3, $4, $5)
       on conflict (owner_team_id) do update set enabled = excluded.enabled, mode = excluded.mode, changed_by_user_id = excluded.changed_by_user_id, change_reason = excluded.change_reason, changed_at = now()`,
      [teamId, enabled, mode, userId, reason],
    );
    await client.query(
      `insert into training_load.gpexe_team_import_switch_history (owner_team_id, enabled, mode, changed_by_user_id, basis, change_reason)
       values ($1, $2, $3, $4, 'platform_admin', $5)`,
      [teamId, enabled, mode, userId, reason],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}
