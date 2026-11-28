export async function recordVariableManageUse(client) {
  const result = await client.query(
    "update training_load.variables_manage_v113_use set first_checked_write_at=clock_timestamp()"
    + " where singleton and first_checked_write_at is null",
  );
  if (!result.rowCount && !(await client.query(
    "select 1 from training_load.variables_manage_v113_use where singleton and first_checked_write_at is not null",
  )).rowCount) throw new Error("Variables Manage first-use record is missing.");
}
