import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { query, pool } from "../src/db.js";

// Runs the ACTUAL migration file against the dev database, so this proves
// what the real SQL does - not a reimplementation of it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../migrations/20260730_backfill_club_admin_scope.sql");

const cleanupUserIds = new Set();
const cleanupClubIds = new Set();

after(async () => {
  if (cleanupClubIds.size) await query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]]);
  if (cleanupUserIds.size) await query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]]);
  await pool.end();
});

async function makeUser(email, roleHint) {
  const result = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'Test', 'User', 'x', 'Test User', 'Test User', $2, true) returning id`,
    [email, roleHint],
  );
  cleanupUserIds.add(result.rows[0].id);
  return result.rows[0].id;
}

async function makeClub(name, createdByUserId) {
  const result = await query(
    `insert into public.clubs (name, created_by_user_id, is_active) values ($1, $2, true) returning id`,
    [name, createdByUserId],
  );
  cleanupClubIds.add(result.rows[0].id);
  return result.rows[0].id;
}

test("backfill migration only grants club_admin to a creator whose EXISTING role_hint already says club_admin", async () => {
  const adminCreator = await makeUser(`migration-admin-${Date.now()}@test.local`, "club_admin");
  const coachCreator = await makeUser(`migration-coach-${Date.now()}@test.local`, "coach");
  const genericCreator = await makeUser(`migration-generic-${Date.now()}@test.local`, "user");

  const adminClub = await makeClub(`Migration Admin Club ${Date.now()}`, adminCreator);
  const coachClub = await makeClub(`Migration Coach Club ${Date.now()}`, coachCreator);
  const genericClub = await makeClub(`Migration Generic Club ${Date.now()}`, genericCreator);

  const sql = await readFile(migrationPath, "utf8");
  await pool.query(sql);

  const adminRole = await query(
    `select 1 from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin' and is_active = true`,
    [adminCreator, adminClub],
  );
  assert.equal(adminRole.rowCount, 1, "the club_admin-role creator should get a user_club_roles row for the club they created");

  const coachRole = await query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2`, [coachCreator, coachClub]);
  assert.equal(coachRole.rowCount, 0, "a plain coach who created a club must NOT be granted club_admin");

  const genericRole = await query(`select 1 from public.user_club_roles where user_id = $1 and club_id = $2`, [genericCreator, genericClub]);
  assert.equal(genericRole.rowCount, 0, "a generic 'user' who created a club must NOT be granted club_admin");

  // Idempotency: running the exact same migration file again must not error
  // or create a duplicate row.
  await pool.query(sql);
  const adminRoleAfterRerun = await query(
    `select count(*)::int as c from public.user_club_roles where user_id = $1 and club_id = $2`,
    [adminCreator, adminClub],
  );
  assert.equal(adminRoleAfterRerun.rows[0].c, 1, "re-running the migration must not duplicate the row");
});
