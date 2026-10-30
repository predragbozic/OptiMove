// Test fixtures for unit conversions (D5) on a disposable database carrying
// v47 (docs/ai/phase7c-unit-conversions-contract.md, section 6): every write
// goes through the database path the phase 7c service uses, with every guard on
// - the acting user set the way the services set it (the v35
// transaction-local setting), each write followed by its own audit row (T8).
// No trigger is switched off. The acting user must be an active platform admin.
import crypto from "node:crypto";

const ACTOR_SQL = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const EVIDENCE = "docs/ai/gpexe-metric-variable-mapping-discovery.md#d5-unit_conversions";

// SAFETY: these fixtures write only on a disposable optimove_tests_* database.
async function assertDisposable(client) {
  const name = (await client.query("select current_database() as d")).rows[0].d;
  if (!/^optimove_tests_[a-z0-9_]+$/.test(name)) throw new Error("unit-conversion fixtures run on a disposable optimove_tests_* database only");
}

async function inTransaction(client, work) {
  await assertDisposable(client);
  await client.query("begin");
  try {
    const value = await work();
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

// Inside an open transaction: the acting user, the active row and its
// unit_conversion_create audit row. Returns the conversion's id.
export async function createConversionStatements(client, { from, to, scale, divisor = "1", offset = "0", evidenceRef = EVIDENCE, by }) {
  await client.query(ACTOR_SQL, [String(by).toLowerCase()]);
  const id = (await client.query(
    `insert into training_load.unit_conversions (from_unit, to_unit, scale, scale_divisor, "offset", evidence_ref, created_by_user_id)
     values ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6, $7) returning id`,
    [from, to, String(scale), String(divisor), String(offset), evidenceRef, by],
  )).rows[0].id;
  await client.query(
    `insert into training_load.source_metric_audit (action, unit_conversion_id, to_status, evidence_ref, performed_by_user_id, basis, operation_id)
     values ('unit_conversion_create', $1, 'active', $2, $3, 'platform_admin', $4)`,
    [id, evidenceRef, by, crypto.randomUUID()],
  );
  return id;
}

// Inside an open transaction: the acting user, the retirement (at the
// transaction's time, now()) and its unit_conversion_retire audit row. The
// UPDATE waits for any lock another transaction holds on the row.
export async function retireConversionStatements(client, { id, by, reason = "Test retirement" }) {
  await client.query(ACTOR_SQL, [String(by).toLowerCase()]);
  await client.query(
    `update training_load.unit_conversions set state = 'retired', retired_by_user_id = $2, retired_at = now(), retired_reason = $3 where id = $1`,
    [id, by, reason],
  );
  await client.query(
    `insert into training_load.source_metric_audit (action, unit_conversion_id, from_status, to_status, reason, performed_by_user_id, basis, operation_id)
     values ('unit_conversion_retire', $1, 'active', 'retired', $2, $3, 'platform_admin', $4)`,
    [id, reason, by, crypto.randomUUID()],
  );
}

// One transaction each.
export function createConversion(client, spec) {
  return inTransaction(client, () => createConversionStatements(client, spec));
}
export function retireConversion(client, spec) {
  return inTransaction(client, () => retireConversionStatements(client, spec));
}
// A retirement whose transaction the caller ends: it opens the transaction
// and runs the statements; the caller then commits or rolls back on `client`.
export async function retireConversionHeld(client, spec) {
  await assertDisposable(client);
  await client.query("begin");
  await retireConversionStatements(client, spec);
}
